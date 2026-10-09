import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { CupomRegem } from '../connectors/regem/contrato-regem.js';
import { VERSAO_CONTRATO_REGEM } from '../connectors/regem/conector-regem.js';
import { campanhaDoVinculo, ligarCupom, travarCupom } from '../coupons/vinculo.js';
import { AppProblem } from '../errors/problems.js';
import { gravarCupons } from '../orders/regem-leitura.js';
import type { ApplyOptions, ApplyResult, Connector, ReadResult, ResourceRef } from './connectors.js';
import type { ResourceState } from './tools.js';

// Escrita no Regem pelo Action Service (A2.5, F6 parte 2; ADR-019 item 6): criar o cupom de campanha na
// loja, depois da aprovação e com a flag `regem_write` ligada. O recurso é o CÓDIGO do cupom na loja
// (`resource_id` = `cupom:CODIGO`, `account_id` = a conta conectada da loja).
//
// O Regem nunca atualiza cupom existente pelo código (409) e exige `Idempotency-Key`: a chave sai do
// pedido (loja + código + regra), então repetir a execução devolve o mesmo cupom, sem criar outro.
// O token da loja sai do cofre só na hora de chamar e nunca vai para log, estado ou auditoria.

const PREFIXO = 'cupom:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O que a criação precisa do resto do app; ligado na subida (API e worker). Sem isso, só a leitura funciona. */
export type DependenciasDaEscritaRegem = {
  lerSegredo: (tx: Tx, secretId: string) => Promise<string | null>;
  cliente: () => ClienteConector;
  apiUrl: string;
  sha256: (texto: string) => string;
};

/** A regra do cupom como o contrato de cupons pede no corpo de `POST {base}/cupons` (§3.3). */
export type RegraDoCupom = {
  codigo: string;
  nome: string;
  tipo: 'percentual' | 'valor' | 'frete_gratis';
  percentual?: string;
  valor_centavos?: number;
  teto_desconto_centavos?: number;
  pedido_minimo_centavos?: number;
  valido_de: string;
  valido_ate: string;
  max_usos?: number;
  condicoes?: { max_por_cliente?: number };
};

type Conta = { id: string; tenant_id: string; brand_id: string; external_id: string; credential_secret_id: string | null; pode_criar: boolean };

export function codigoDoRecurso(resourceId: string): string | null {
  if (!resourceId.startsWith(PREFIXO)) return null;
  const codigo = resourceId.slice(PREFIXO.length);
  return /^[A-Z0-9]{4,20}$/.test(codigo) ? codigo : null;
}

const MENSAGEM: Record<string, string> = {
  'codigo-em-uso': 'Já existe um cupom com este código no Regem. Escolha outro código.',
  'regra-invalida': 'O Regem não aceitou a regra do cupom.',
  'conta-bloqueada': 'A conta da empresa no Regem está bloqueada: o Regem não cria cupom agora.',
  'escopo-insuficiente': 'A loja não liberou "criar cupom de campanha" no Regem. Autorize de novo em Contas conectadas.',
  'token-invalido': 'O Regem recusou o acesso desta loja (a autorização foi revogada). Conecte de novo em Contas conectadas.',
};

const SEM_ESCRITA = 'A escrita no Regem não está disponível neste ambiente.';

/** A recusa do Regem em palavras de gente: pelo tipo do problema (`…/problemas/<tipo>`, lido pelo cliente HTTP). */
function recusaDoRegem(erro: ErroConector): string {
  const tipo = erro.codigoProvider;
  // A regra inválida vem com o campo e o motivo no detalhe do Regem (sem dado da loja): ajuda a corrigir o pedido.
  if (tipo === 'regra-invalida' && erro.message) return `${MENSAGEM['regra-invalida']} ${erro.message}`;
  if (tipo && MENSAGEM[tipo]) return MENSAGEM[tipo]!;
  if (erro.tipo === 'autenticacao') return MENSAGEM['token-invalido']!;
  if (erro.tipo === 'permissao') return MENSAGEM['escopo-insuficiente']!;
  return 'O Regem recusou a criação do cupom.';
}

export class RegemCupomConnector implements Connector {
  readonly provider = 'regem';
  readonly writeFlag = 'regem_write';
  // O cupom não mexe em verba de mídia: o desconto sai do caixa da loja.
  readonly requiresSpendLimits = false;
  private deps: DependenciasDaEscritaRegem | null = null;

  ligar(deps: DependenciasDaEscritaRegem): void {
    this.deps = deps;
  }

  private async conta(tx: Tx, ref: ResourceRef): Promise<Conta | null> {
    if (!UUID.test(ref.accountId)) return null;
    const r = await tx.execute<Conta>(sql`
      select a.id, a.tenant_id, a.brand_id, a.external_id, a.credential_secret_id,
             coalesce(a.provider_attributes -> 'escopos' @> '["cupons.criar"]'::jsonb, false) as pode_criar
        from liame.connected_account a
       where a.id = ${ref.accountId} and a.tenant_id = ${ref.tenantId} and a.provider = 'regem' and a.disconnected_at is null`);
    return r.rows[0] ?? null;
  }

  /**
   * O estado do "recurso": existe um cupom com este código na loja? Versão 0 = não existe (é o que a criação
   * espera encontrar na hora de executar); a de um cupom que existe é a versão dele na origem.
   */
  async read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    const codigo = codigoDoRecurso(ref.resourceId);
    const conta = codigo ? await this.conta(tx, ref) : null;
    if (!codigo || !conta) return null;
    const r = await tx.execute<{ id: string; active: boolean; source_version: string | null }>(sql`
      select id, active, source_version::text from liame.coupon
       where connected_account_id = ${conta.id} and code = ${codigo} and removed_at is null
       order by first_seen_at desc limit 1`);
    const cupom = r.rows[0];
    if (!cupom) return { state: { codigo, existe: false, pode_criar: conta.pode_criar }, version: 0 };
    return { state: { codigo, existe: true, cupom_id: cupom.id, ativo: cupom.active, pode_criar: conta.pode_criar }, version: Math.max(1, Number(cupom.source_version ?? 1)) };
  }

  async apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options: ApplyOptions = {}): Promise<ApplyResult> {
    const atual = await this.read(tx, ref);
    const conta = atual ? await this.conta(tx, ref) : null;
    if (!atual || !conta) return { ok: false, reason: 'recusado', mensagem: 'A loja foi desconectada do Regem depois do pedido. Conecte de novo em Contas conectadas e peça o cupom outra vez.' };
    // A criação é sempre planejada sobre "o cupom não existe" (versão 0).
    if (expectedVersion !== 0) return { ok: false, reason: 'estado-mudou', current: atual };
    if (!conta.pode_criar) return { ok: false, reason: 'recusado', mensagem: MENSAGEM['escopo-insuficiente']! };

    const regra = desired.regra as RegraDoCupom;
    const vinculo = desired.campanha as { id: string; exclusivo: boolean };
    // A campanha é conferida ANTES de criar: se ela foi encerrada entre o pedido e a aprovação, o cupom não nasce órfão.
    try {
      await campanhaDoVinculo(tx, vinculo.id, conta.brand_id);
    } catch (err) {
      if (err instanceof AppProblem) return { ok: false, reason: 'recusado', mensagem: `${err.detail} O cupom não foi criado: peça de novo com outra campanha.` };
      throw err;
    }
    // Um cupom com o código já na lista do Liame não barra aqui: pode ser o desta mesma ação, criado numa
    // tentativa que caiu no meio e trazido pela leitura. Quem decide é o Regem: a mesma chave de idempotência
    // devolve o mesmo cupom; qualquer outro caso é 409 (ele nunca sobrescreve cupom pelo código).
    if (options.validateOnly) return { ok: true, state: desired, version: atual.version };

    const nascido = await this.criarNoRegem(tx, conta, regra);
    if (!nascido.ok) return { ok: false, reason: 'recusado', mensagem: nascido.mensagem };
    const { criado, cupomId } = nascido;
    const estado: ResourceState = { codigo: criado.codigo, existe: true, cupom_id: cupomId, external_id: criado.id, ativo: criado.ativo, pode_criar: conta.pode_criar };
    if (!cupomId) return { ok: true, state: { ...estado, vinculo: 'pendente', vinculo_motivo: 'o cupom criado ainda não entrou na lista do Liame' }, version: Number(criado.versao) };

    // Liga à campanha escolhida no pedido. Se a campanha deixou de valer entre o pedido e a execução, o cupom
    // fica criado e sem vínculo (a pessoa liga a outra na aba Cupons) — a criação não é desfeita por isso.
    try {
      const cupom = await travarCupom(tx, cupomId);
      const feito = await ligarCupom(tx, { userId: options.requestedBy ?? null, cupom, body: { campaign_id: vinculo.id, exclusive: vinculo.exclusivo }, agora: new Date() });
      return { ok: true, state: { ...estado, vinculo: 'feito', campanha_id: vinculo.id, exclusivo: vinculo.exclusivo, ligacao_id: feito.ligacaoId }, version: Number(criado.versao) };
    } catch (err) {
      if (err instanceof AppProblem) {
        return { ok: true, state: { ...estado, vinculo: 'pendente', vinculo_motivo: err.detail }, version: Number(criado.versao) };
      }
      throw err;
    }
  }

  /**
   * A criação no Regem (contrato de cupons §3.3) e a gravação do cupom na lista do Liame. É a mesma para o cupom de
   * campanha e para o cupom de uma mensagem. A chave de idempotência sai da loja e da regra: a mesma criação repetida
   * (o worker que caiu no meio) devolve o mesmo cupom. O que é passageiro (rede, 5xx, limite) sobe para quem chama.
   */
  private async criarNoRegem(tx: Tx, conta: Conta, regra: RegraDoCupom): Promise<{ ok: true; criado: CupomRegem; cupomId: string | null } | { ok: false; mensagem: string }> {
    const deps = this.deps;
    if (!deps) return { ok: false, mensagem: SEM_ESCRITA };
    const guardada = conta.credential_secret_id ? await deps.lerSegredo(tx, conta.credential_secret_id) : null;
    const lojas = guardada ? ((JSON.parse(guardada) as { lojas?: { loja_id: string; token: string }[] }).lojas ?? []) : [];
    const token = lojas.find((l) => l.loja_id === conta.external_id)?.token;
    if (!token) return { ok: false, mensagem: MENSAGEM['token-invalido']! };

    let criado: CupomRegem;
    try {
      const r = await deps.cliente().requisitar({
        provider: 'regem',
        conta: conta.external_id,
        url: `${deps.apiUrl}/cupons`,
        metodo: 'POST',
        corpo: regra,
        cabecalhos: {
          authorization: `Bearer ${token}`,
          // Loja + regra: a mesma criação repetida (worker que caiu no meio) devolve o mesmo cupom.
          'idempotency-key': `liame-${deps.sha256(JSON.stringify([conta.id, regra])).slice(0, 48)}`,
        },
        endpoint: 'cupons.criar',
        apiVersion: VERSAO_CONTRATO_REGEM,
      });
      const lido = CupomRegem.safeParse(r.corpo);
      if (!lido.success) return { ok: false, mensagem: 'O Regem criou o cupom, mas a resposta veio fora do contrato. Confira o cupom no Regem.' };
      criado = lido.data;
    } catch (err) {
      // Recusa definitiva do Regem (código em uso, regra inválida, sem permissão): não adianta repetir.
      // O que é passageiro (rede, 5xx, limite) sobe: a ação volta para a fila e repete com a mesma chave.
      if (err instanceof ErroConector && (err.tipo === 'definitivo' || err.tipo === 'autenticacao' || err.tipo === 'permissao')) {
        return { ok: false, mensagem: recusaDoRegem(err) };
      }
      throw err;
    }

    await gravarCupons(tx, { tenantId: conta.tenant_id, brandId: conta.brand_id, connectedAccountId: conta.id }, [criado]);
    const gravado = await tx.execute<{ id: string }>(sql`
      select id from liame.coupon where connected_account_id = ${conta.id} and external_id = ${criado.id}`);
    const cupomId = gravado.rows[0]?.id ?? null;
    return { ok: true, criado, cupomId };
  }

  /**
   * O cupom de uma mensagem de WhatsApp (A5, Y5; D-A5-16) pode nascer agora? Sem criar nada: a loja ainda está
   * conectada e liberou "criar cupom de campanha". Devolve o motivo, ou nulo. Se o código já existe, quem diz é o Regem,
   * na criação.
   */
  async conferirCupomDaMensagem(tx: Tx, alvo: { tenantId: string; lojaId: string }): Promise<string | null> {
    const conta = await this.conta(tx, { tenantId: alvo.tenantId, accountId: alvo.lojaId, resourceId: '' });
    if (!conta) return 'A loja do cupom foi desconectada do Regem.';
    if (!conta.pode_criar) return MENSAGEM['escopo-insuficiente']!;
    if (!this.deps) return SEM_ESCRITA;
    return null;
  }

  /**
   * Cria o cupom de uma mensagem na loja do Regem. Ele não nasce ligado a campanha de anúncio: o que o liga à
   * mensagem é o pedido dela (`message_request`). Devolve o cupom na lista do Liame (nulo se ele ainda não entrou).
   */
  async criarCupomDaMensagem(tx: Tx, alvo: { tenantId: string; lojaId: string; regra: RegraDoCupom }): Promise<{ ok: true; cupomId: string | null } | { ok: false; mensagem: string }> {
    const conta = await this.conta(tx, { tenantId: alvo.tenantId, accountId: alvo.lojaId, resourceId: '' });
    if (!conta) return { ok: false, mensagem: 'A loja do cupom foi desconectada do Regem.' };
    if (!conta.pode_criar) return { ok: false, mensagem: MENSAGEM['escopo-insuficiente']! };
    const feito = await this.criarNoRegem(tx, conta, alvo.regra);
    return feito.ok ? { ok: true, cupomId: feito.cupomId } : feito;
  }
}

export const regemCupomConnector = new RegemCupomConnector();
