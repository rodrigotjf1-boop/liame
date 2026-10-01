import { type Db, uuidv7, withTenant } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { atribuirPedidos, pedidosDosCupons, pedidosDosToques } from '../attribution/motor.js';
import { gravarToques, type ToqueLido } from '../attribution/toque-store.js';
import { writeAudit } from '../audit/audit.js';
import type { AppConfig } from '../config.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { ClienteConector, ErroConector, type TipoErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { lerLoja, lerPagina, registrarAvisoNoRegem, VERSAO_CONTRATO_REGEM } from '../connectors/regem/conector-regem.js';
import { ClienteAnonimizado, CupomRegem, type LojaRegem, PedidoRegem } from '../connectors/regem/contrato-regem.js';
import { newWebhookSecret } from '../events/standard-webhooks.js';
import type { VaultService } from '../vault/vault.service.js';
import { gravarPedidos, type PedidoLido } from './order-store.js';
import { gravarCupons, pedidoDoRegem, toqueDoPedido } from './regem-leitura.js';
import { normalizarTelefone } from './telefone.js';

// Leitura das vendas de uma loja do Regem (A2.5, F4; ADR-019, D-A2.5-5). Chamadas externas fora de
// transação; cada página gravada numa transação curta da empresa, com o cursor junto (a página gravada
// não é relida, a não gravada é). Carga inicial de 90 dias; depois, o cursor a cada 15 minutos e uma
// reconciliação diária dos últimos 3 dias, que devolve o que um evento perdido ou um cursor apressado
// deixou para trás (a versão do recurso descarta o que não mudou) e relê a loja (o endereço do cardápio).
//
// Os conjuntos (cupons, pedidos, clientes anonimizados) são independentes. Token recusado vale para a loja
// inteira e para tudo; qualquer outro erro fica no estado do conjunto dele, com o motivo e a espera própria,
// e a execução segue para os outros. A loja volta para a fila na próxima leitura mais cedo entre eles.

/** Uma leitura a cada 15 minutos (o webhook do Regem, quando existir, antecipa). */
export const INTERVALO_VENDAS_MIN = 15;
export const CARGA_INICIAL_VENDAS_DIAS = 90;
const RECONCILIACAO_DIAS = 3;
/** Teto de páginas por conjunto numa execução: loja grande termina na próxima, sem prender o worker. */
const PAGINAS_POR_EXECUCAO = 20;
const DIA_MS = 86_400_000;
const HORA_MS = 3_600_000;

export type DatasetVendas = 'pedidos' | 'cupons' | 'clientes_anonimizados';

/** Cupons antes dos pedidos: o pedido pode citar cupom novo (e o cupom que chegar depois religa a atribuição). */
const ORDEM: readonly DatasetVendas[] = ['cupons', 'pedidos', 'clientes_anonimizados'];

/** Escopo do token que libera cada conjunto (docs/integracoes/regem.md §1). */
const ESCOPO: Record<DatasetVendas, string> = {
  pedidos: 'pedidos.ler',
  cupons: 'cupons.ler',
  clientes_anonimizados: 'clientes.anonimizacao.ler',
};

/** Como cada conjunto aparece no motivo da conta com erro. */
const NOME: Record<DatasetVendas, string> = {
  cupons: 'dos cupons',
  pedidos: 'dos pedidos',
  clientes_anonimizados: 'dos avisos de cliente anonimizado',
};

/** Tipo da falha que um conjunto espera passar: a do conector, ou erro nosso (`interno`). */
type TipoFalha = TipoErroConector | 'interno';

type CursorVendas = {
  cursor?: string | null;
  carga_inicial_em?: string;
  reconciliacao_em?: string;
  /** Pedidos: quando a loja volta para a fila (a reserva é por esta linha). Os outros: a próxima leitura prevista. */
  proxima?: string;
  falhas_seguidas?: number;
  /** Depois de uma falha, o conjunto só é lido de novo a partir daqui, sem segurar os outros. */
  espera_ate?: string;
  /** O tipo da falha que o conjunto espera passar (a situação da conta sai daqui). */
  falha?: TipoFalha;
  /** Pedidos: a última vez que o aviso (webhook) desta loja foi registrado no Regem, e se deu certo. */
  aviso?: { em: string; ok: boolean };
  /** Pedidos: quando chegou o último aviso do Regem (gravado por quem recebe; a execução nunca o sobrescreve). */
  evento_em?: string;
};

/** Um conjunto durante a execução: o último cursor gravado (a falha parte dele, não do início da execução). */
type EstadoConjunto = { cursor: CursorVendas };

type Contexto = { cliente: ClienteConector; apiUrl: string };

type LinhaConta = {
  id: string;
  tenant_id: string;
  brand_id: string;
  unit_id: string | null;
  external_id: string;
  status: string;
  status_reason: string | null;
  credential_secret_id: string | null;
  connection_id: string | null;
};

export type ResultadoVendas = {
  /**
   * `parcial`: um conjunto ou mais falhou e outro foi lido (quais falharam, em `falhas`); `falhou`: token recusado
   * (a loja inteira para) ou nenhum conjunto lido.
   */
  status: 'ok' | 'parcial' | 'falhou' | 'ignorada';
  pedidos?: { novos: number; atualizados: number; ignorados: number };
  cupons?: number;
  /** Cupons que o banco recusaria: ficaram de fora, com o motivo no log. */
  cuponsIgnorados?: number;
  anonimizados?: number;
  atribuidos?: number;
  semPermissao?: DatasetVendas[];
  /** Conjuntos que falharam nesta execução, com o motivo (os outros seguiram). */
  falhas?: Partial<Record<DatasetVendas, string>>;
  /** Conjuntos que ficaram para depois: esperam a vez deles depois de uma falha. */
  adiados?: DatasetVendas[];
  erro?: string;
};

/**
 * Apaga os clientes pseudonimizados que a origem anonimizou. Apagar é só do escopo de sistema ("só o
 * expurgo apaga"), que o worker concede (regra `liame-escopo-sistema` do Semgrep): quem cria o
 * sincronizador passa esta função (`worker/vendas-loop.ts`).
 */
export type ApagarAnonimizados = (alvo: { tenantId: string; connectedAccountId: string; externalCustomerIds: string[] }) => Promise<number>;

/** O cursor depois de uma leitura boa: sem a espera nem o tipo da falha anterior. */
function semFalha(c: CursorVendas): CursorVendas {
  const { espera_ate: _espera, falha: _falha, ...resto } = c;
  return resto;
}

/** Falha que não passa sozinha (pedido errado, resposta fora do contrato, erro nosso): a conta mostra "erro". */
const naoPassaSozinha = (tipo: TipoFalha | undefined): boolean => tipo === 'definitivo' || tipo === 'interno';

/**
 * Quanto um conjunto espera depois de uma falha: o que o Regem pediu; sem permissão, um dia; erro definitivo
 * ou nosso, 6 h no mínimo; o resto (e o token recusado), 30 min dobrando até 12 h.
 */
function esperaDaFalha(e: ErroConector | null, falhas: number): number {
  if (e?.tipo === 'permissao') return DIA_MS;
  const base = e?.esperarMs && e.esperarMs > 0 ? e.esperarMs : Math.min(30 * 60_000 * 2 ** (falhas - 1), 12 * 3_600_000);
  return !e || e.tipo === 'definitivo' ? Math.max(base, 6 * 3_600_000) : base;
}

/** "dos cupons", "dos cupons e dos pedidos", "dos cupons, dos pedidos e dos avisos…". */
function juntar(partes: string[]): string {
  return partes.length > 1 ? `${partes.slice(0, -1).join(', ')} e ${partes.at(-1)}` : (partes[0] ?? '');
}

export class SincronizadorVendas {
  private readonly logger = new Logger('vendas');

  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly config: AppConfig,
    private readonly apagarAnonimizados: ApagarAnonimizados,
  ) {}

  async sincronizar(contaId: string, tenantId: string, agora: Date = new Date()): Promise<ResultadoVendas> {
    const lida = await withTenant(this.db, tenantId, async (tx) => {
      // `inicio`: o relógio do BANCO no começo da leitura (o mesmo que carimba o aviso recebido).
      const r = await tx.execute<LinhaConta & { cursores: Record<string, CursorVendas> | null; inicio: string }>(sql`
        select a.id, a.tenant_id, a.brand_id, a.unit_id, a.external_id, a.status, a.status_reason, a.credential_secret_id, a.connection_id,
               now()::text as inicio,
               (select jsonb_object_agg(s.dataset, s.cursor) from liame.sync_state s where s.connected_account_id = a.id) as cursores
          from liame.connected_account a
         where a.id = ${contaId} and a.provider = 'regem' and a.disconnected_at is null`);
      const conta = r.rows[0];
      if (!conta) return null;
      const segredo = conta.credential_secret_id ? await this.vault.readSecret(tx, conta.credential_secret_id) : null;
      return { conta, segredo, cursores: conta.cursores ?? {} };
    });
    if (!lida) return { status: 'ignorada' };
    const { conta, cursores } = lida;

    const credencial = lida.segredo ? (JSON.parse(lida.segredo) as CredencialGuardada) : null;
    const loja = credencial?.tipo === 'regem' ? credencial.lojas.find((l) => l.loja_id === conta.external_id) : undefined;
    if (!loja) return this.falhou(conta, 'pedidos', cursores.pedidos ?? {}, new ErroConector('autenticacao', 'regem', 'autorização revogada ou sem o token desta loja'), agora);

    const cliente = new ClienteConector(this.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos) });
    const ctx: Contexto = { cliente, apiUrl: this.config.produtos.regemApiUrl };
    const resultado: ResultadoVendas = { status: 'ok', atribuidos: 0, semPermissao: [], falhas: {}, adiados: [] };
    const runId = await this.abrirExecucao(conta, cursores.pedidos?.carga_inicial_em ? 'incremental' : 'carga_inicial');
    /** Quando cada conjunto deve ser lido de novo: a loja volta para a fila no mais cedo. */
    const proximas: number[] = [];
    /** Conjuntos com falha que não passa sozinha: desta execução ou ainda esperando a vez. */
    const comErro: DatasetVendas[] = [];
    let lidos = 0;

    for (const dataset of ORDEM) {
      const estado: EstadoConjunto = { cursor: cursores[dataset] ?? {} };
      if (!loja.escopos.includes(ESCOPO[dataset])) {
        resultado.semPermissao!.push(dataset);
        await this.marcarEstado(conta, dataset, 'sem_permissao: a loja não liberou este escopo', { ...estado.cursor, proxima: this.depois(agora, 24 * 60) });
        continue;
      }
      // Esperando a vez depois de uma falha: fica para depois, sem segurar os outros conjuntos.
      const espera = estado.cursor.espera_ate ? Date.parse(estado.cursor.espera_ate) : Number.NaN;
      if (espera > agora.getTime()) {
        resultado.adiados!.push(dataset);
        proximas.push(espera);
        if (naoPassaSozinha(estado.cursor.falha)) comErro.push(dataset);
        continue;
      }
      try {
        proximas.push(await this.lerConjunto(dataset, ctx, conta, loja.token, estado, agora, resultado));
        lidos++;
      } catch (err) {
        // Token recusado vale para a loja inteira: para tudo e pede para conectar de novo.
        if (err instanceof ErroConector && err.tipo === 'autenticacao') {
          await this.fecharExecucao(conta, runId, 'falhou', cliente.chamadas, resultado, `${dataset}: ${err.tipo}: ${err.message}`);
          return this.falhou(conta, dataset, estado.cursor, err, agora);
        }
        // Qualquer outro erro é só deste conjunto: o estado dele guarda o motivo e a espera, e a execução segue.
        const f = await this.falhaDoConjunto(conta, dataset, estado.cursor, err, agora);
        proximas.push(f.esperaAte);
        if (f.tipo === 'permissao') resultado.semPermissao!.push(dataset);
        else resultado.falhas![dataset] = f.texto;
        if (naoPassaSozinha(f.tipo)) comErro.push(dataset);
      }
    }

    const falharam = ORDEM.filter((d) => resultado.falhas![d] !== undefined);
    const status = !falharam.length ? 'ok' : lidos > 0 ? 'parcial' : 'falhou';
    resultado.status = status;
    if (falharam.length) resultado.erro = falharam.map((d) => `${d}: ${resultado.falhas![d]}`).join('; ').slice(0, 500);
    await this.fecharExecucao(conta, runId, status, cliente.chamadas, resultado, resultado.erro ?? null);
    await this.conferirAviso(ctx, conta, loja.token, cursores.pedidos ?? {}, agora);
    // Sem nenhum conjunto liberado pelo token, a loja é vista de novo no dia seguinte.
    await this.agendarLoja(conta, proximas.length ? Math.min(...proximas) : agora.getTime() + DIA_MS, conta.inicio);
    await this.atualizarSituacao(conta, comErro);
    return resultado;
  }

  /** Lê um conjunto, põe o que leu no resultado e devolve quando ele deve ser lido de novo. */
  private async lerConjunto(
    dataset: DatasetVendas,
    ctx: Contexto,
    conta: LinhaConta,
    token: string,
    estado: EstadoConjunto,
    agora: Date,
    resultado: ResultadoVendas,
  ): Promise<number> {
    if (dataset === 'cupons') {
      const r = await this.lerCupons(ctx, conta, token, estado, agora);
      resultado.cupons = r.alterados;
      resultado.cuponsIgnorados = r.ignorados;
      resultado.atribuidos = (resultado.atribuidos ?? 0) + r.atribuidos;
      return r.proxima;
    }
    if (dataset === 'pedidos') {
      const r = await this.lerPedidos(ctx, conta, token, estado, agora);
      resultado.pedidos = r.pedidos;
      resultado.atribuidos = (resultado.atribuidos ?? 0) + r.atribuidos;
      return r.proxima;
    }
    const r = await this.lerAnonimizados(ctx, conta, token, estado, agora);
    resultado.anonimizados = r.apagados;
    return r.proxima;
  }

  /** Pedidos: cada página vira pedidos, cliques e a atribuição dos que mudaram, numa transação só. */
  private async lerPedidos(ctx: Contexto, conta: LinhaConta, token: string, estado: EstadoConjunto, agora: Date) {
    const inicial = semFalha(estado.cursor);
    const total = { novos: 0, atualizados: 0, ignorados: 0 };
    let atribuidos = 0;
    const cargaInicial = !inicial.carga_inicial_em;
    let posicao = inicial.cursor ?? null;
    let terminou = false;
    let proxima = agora.getTime() + INTERVALO_VENDAS_MIN * 60_000;
    for (let pagina = 0; pagina < PAGINAS_POR_EXECUCAO; pagina++) {
      const extra: Record<string, string> = cargaInicial && !posicao ? { confirmados_desde: new Date(agora.getTime() - CARGA_INICIAL_VENDAS_DIAS * DIA_MS).toISOString() } : {};
      const pg = await lerPagina(ctx, { token, lojaChave: conta.external_id, rota: 'pedidos', item: PedidoRegem, cursor: posicao, extra });
      const r = await this.gravarPaginaPedidos(conta, pg.itens);
      total.novos += r.novos;
      total.atualizados += r.atualizados;
      total.ignorados += r.ignorados;
      atribuidos += r.atribuidos;
      posicao = pg.proximoCursor ?? posicao;
      terminou = !pg.temMais;
      proxima = agora.getTime() + (terminou ? INTERVALO_VENDAS_MIN : 1) * 60_000;
      estado.cursor = {
        ...inicial,
        cursor: posicao,
        carga_inicial_em: inicial.carga_inicial_em ?? (terminou ? agora.toISOString() : undefined),
        proxima: new Date(proxima).toISOString(),
        falhas_seguidas: 0,
      };
      await this.marcarEstado(conta, 'pedidos', null, estado.cursor);
      if (terminou) break;
    }

    // Reconciliação diária: relê os pedidos confirmados nos últimos 3 dias, sem mexer no cursor principal, e a loja.
    const ultima = inicial.reconciliacao_em ? new Date(inicial.reconciliacao_em).getTime() : 0;
    if (terminou && !cargaInicial && agora.getTime() - ultima >= DIA_MS) {
      let pos: string | null = null;
      const desde = new Date(agora.getTime() - RECONCILIACAO_DIAS * DIA_MS).toISOString();
      for (let pagina = 0; pagina < PAGINAS_POR_EXECUCAO; pagina++) {
        const pg: { itens: PedidoRegem[]; proximoCursor: string | null; temMais: boolean } = await lerPagina(ctx, {
          token,
          lojaChave: conta.external_id,
          rota: 'pedidos',
          item: PedidoRegem,
          cursor: pos,
          extra: pos ? {} : { confirmados_desde: desde },
        });
        const r = await this.gravarPaginaPedidos(conta, pg.itens);
        total.atualizados += r.atualizados;
        total.novos += r.novos;
        atribuidos += r.atribuidos;
        pos = pg.proximoCursor;
        if (!pg.temMais || !pos) break;
      }
      await this.conferirCardapio(ctx, conta, token);
      estado.cursor = { ...estado.cursor, reconciliacao_em: agora.toISOString() };
      await this.marcarEstado(conta, 'pedidos', null, estado.cursor);
    }
    return { pedidos: total, atribuidos, proxima };
  }

  private async gravarPaginaPedidos(conta: LinhaConta, itens: PedidoRegem[]) {
    if (!itens.length) return { novos: 0, atualizados: 0, ignorados: 0, atribuidos: 0 };
    return withTenant(this.db, conta.tenant_id, async (tx) => {
      // Telefone → E.164 → índice cego, na chegada; o telefone não sai desta função (A2.5-7).
      const indices = new Map<string, string>();
      for (const p of itens) {
        const telefone = p.grupo_canal === 'marketplace' ? null : normalizarTelefone(p.cliente?.telefone);
        if (telefone && !indices.has(telefone)) indices.set(telefone, await this.vault.blindIndexFor(tx, conta.tenant_id, telefone));
      }
      const pedidos: PedidoLido[] = itens.map((p) => {
        const telefone = p.grupo_canal === 'marketplace' ? null : normalizarTelefone(p.cliente?.telefone);
        return pedidoDoRegem(p, telefone ? indices.get(telefone)! : null);
      });
      const toques = itens.map(toqueDoPedido).filter((t): t is ToqueLido => t !== null);
      const g = await gravarPedidos(tx, { tenantId: conta.tenant_id, brandId: conta.brand_id, unitId: conta.unit_id, connectedAccountId: conta.id, provider: 'regem' }, pedidos);
      const t = toques.length ? await gravarToques(tx, { tenantId: conta.tenant_id, brandId: conta.brand_id, connectedAccountId: conta.id }, toques) : { alterados: [] };
      const afetados = new Set([...g.alterados.map((a) => a.id), ...(await pedidosDosToques(tx, conta.tenant_id, t.alterados))]);
      const a = await atribuirPedidos(tx, { tenantId: conta.tenant_id, orderIds: [...afetados], gatilho: 'pedidos' });
      return { novos: g.novos, atualizados: g.atualizados, ignorados: g.ignorados, atribuidos: a.atribuidos };
    });
  }

  /**
   * Cupons: espelho da loja. O cupom que o banco recusaria fica de fora (contado e com o motivo no log), e o
   * cupom novo ou alterado refaz a atribuição por cupom dos pedidos que o citam — inclusive os que chegaram antes
   * dele (leitura dos cupons que falhou, código trocado na origem).
   */
  private async lerCupons(ctx: Contexto, conta: LinhaConta, token: string, estado: EstadoConjunto, agora: Date) {
    const inicial = semFalha(estado.cursor);
    let posicao = inicial.cursor ?? null;
    let alterados = 0;
    let ignorados = 0;
    let atribuidos = 0;
    let proxima = agora.getTime() + INTERVALO_VENDAS_MIN * 60_000;
    for (let pagina = 0; pagina < PAGINAS_POR_EXECUCAO; pagina++) {
      const pg = await lerPagina(ctx, { token, lojaChave: conta.external_id, rota: 'cupons', item: CupomRegem, cursor: posicao });
      const g = await withTenant(this.db, conta.tenant_id, async (tx) => {
        const gravados = await gravarCupons(tx, { tenantId: conta.tenant_id, brandId: conta.brand_id, connectedAccountId: conta.id }, pg.itens);
        const pedidos = await pedidosDosCupons(tx, conta.tenant_id, gravados.ids);
        const a = await atribuirPedidos(tx, { tenantId: conta.tenant_id, orderIds: pedidos, gatilho: 'cupons' });
        return { ...gravados, atribuidos: a.atribuidos };
      });
      alterados += g.alterados;
      atribuidos += g.atribuidos;
      if (g.recusados.length) {
        ignorados += g.recusados.length;
        // Só o id na origem e o motivo: o código e o nome do cupom podem ter nome de gente.
        const quais = g.recusados.slice(0, 10).map((c) => `${JSON.stringify(c.id).slice(0, 110)} (${c.motivo})`);
        this.logger.warn(`loja ${conta.id}: ${g.recusados.length} cupom(ns) que o banco recusaria ficaram de fora: ${quais.join('; ')}`);
      }
      posicao = pg.proximoCursor ?? posicao;
      proxima = agora.getTime() + (pg.temMais ? 1 : INTERVALO_VENDAS_MIN) * 60_000;
      estado.cursor = { ...inicial, cursor: posicao, proxima: new Date(proxima).toISOString(), falhas_seguidas: 0 };
      await this.marcarEstado(conta, 'cupons', null, estado.cursor);
      if (!pg.temMais) break;
    }
    return { alterados, ignorados, atribuidos, proxima };
  }

  /** Cliente anonimizado no Regem: o cliente pseudonimizado some do Liame (A2.5-7). Apagar é do escopo de sistema. */
  private async lerAnonimizados(ctx: Contexto, conta: LinhaConta, token: string, estado: EstadoConjunto, agora: Date) {
    const inicial = semFalha(estado.cursor);
    let posicao = inicial.cursor ?? null;
    let apagados = 0;
    let proxima = agora.getTime() + INTERVALO_VENDAS_MIN * 60_000;
    for (let pagina = 0; pagina < PAGINAS_POR_EXECUCAO; pagina++) {
      const pg = await lerPagina(ctx, { token, lojaChave: conta.external_id, rota: 'clientes/anonimizados', item: ClienteAnonimizado, cursor: posicao });
      if (pg.itens.length) {
        apagados += await this.apagarAnonimizados({ tenantId: conta.tenant_id, connectedAccountId: conta.id, externalCustomerIds: pg.itens.map((c) => c.id) });
      }
      posicao = pg.proximoCursor ?? posicao;
      proxima = agora.getTime() + (pg.temMais ? 1 : INTERVALO_VENDAS_MIN) * 60_000;
      estado.cursor = { ...inicial, cursor: posicao, proxima: new Date(proxima).toISOString(), falhas_seguidas: 0 };
      await this.marcarEstado(conta, 'clientes_anonimizados', null, estado.cursor);
      if (!pg.temMais) break;
    }
    return { apagados, proxima };
  }

  /**
   * O endereço do cardápio (destino dos links, F5) muda no Regem sem reconectar: relido uma vez por dia, na
   * reconciliação. Falha aqui não segura os pedidos (tenta de novo no dia seguinte); token recusado para tudo.
   */
  private async conferirCardapio(ctx: Contexto, conta: LinhaConta, token: string): Promise<void> {
    let loja: LojaRegem;
    try {
      loja = await lerLoja(ctx, token, conta.external_id);
    } catch (err) {
      if (err instanceof ErroConector && err.tipo === 'autenticacao') throw err;
      this.logger.warn(`loja ${conta.id}: cardápio não conferido hoje (${err instanceof ErroConector ? `${err.tipo}: ${err.message}` : 'erro interno'})`);
      return;
    }
    // Resposta de outra loja não mexe nesta; campo ausente mantém o que está gravado (LIC-007).
    if (loja.loja_id !== conta.external_id || loja.cardapio_url === undefined) return;
    const novo = loja.cardapio_url;
    await withTenant(this.db, conta.tenant_id, async (tx) => {
      const r = await tx.execute<{ antes: string | null }>(sql`
        with atual as (
          select id, provider_attributes->>'cardapio_url' as url from liame.connected_account
           where id = ${conta.id} and disconnected_at is null
           for update
        )
        update liame.connected_account a
           set provider_attributes = a.provider_attributes || jsonb_build_object('cardapio_url', ${novo}::text), updated_at = now()
          from atual
         where a.id = atual.id and atual.url is distinct from ${novo}::text
        returning atual.url as antes`);
      const mudou = r.rows[0];
      if (!mudou) return;
      // O cardápio decide para onde um link pode levar (V33): a troca fica na auditoria.
      await writeAudit(tx, {
        tenantId: conta.tenant_id,
        actorType: 'system',
        actorId: null,
        actorLabel: 'Liame (leitura do Regem)',
        action: 'conexao.atualizar_cardapio',
        resourceType: 'connected_account',
        resourceId: conta.id,
        before: { cardapio_url: mudou.antes },
        after: { cardapio_url: novo },
        origin: 'worker',
      });
      this.logger.log(`loja ${conta.id}: endereço do cardápio atualizado pelo Regem`);
    });
  }

  /**
   * O aviso do Regem (contrato §3): o Liame diz ao Regem para onde avisar quando algo muda nesta loja — o
   * inbox da conexão dela, com o segredo da conexão. É só um atalho: sem ele, a leitura de 15 em 15 minutos
   * segue igual, por isso nada aqui falha a execução. Depois da carga inicial (a primeira leitura já é
   * pesada), uma vez por dia (repetir religa o que o Regem tiver pausado); se falhou, de hora em hora.
   */
  private async conferirAviso(ctx: Contexto, conta: LinhaConta, token: string, cursor: CursorVendas, agora: Date): Promise<void> {
    if (!conta.connection_id || !cursor.carga_inicial_em) return;
    const ultimo = cursor.aviso?.em ? Date.parse(cursor.aviso.em) : Number.NaN;
    if (agora.getTime() - ultimo < (cursor.aviso?.ok ? DIA_MS : HORA_MS)) return;
    let ok = false;
    try {
      const segredo = await this.segredoDoAviso(conta);
      // Conexão revogada no meio do caminho: não há para onde avisar.
      if (!segredo) return;
      await registrarAvisoNoRegem(ctx, token, conta.external_id, { url: `${this.config.apiUrl}/v1/inbox/regem/${conta.connection_id}`, segredo });
      ok = true;
    } catch (err) {
      // Só o tipo e o texto do erro do conector (o segredo e o token nunca entram na mensagem).
      this.logger.warn(`loja ${conta.id}: aviso do Regem não registrado (${err instanceof ErroConector ? `${err.tipo}: ${err.message}` : 'erro interno'}); nova tentativa em uma hora`);
    }
    try {
      await withTenant(this.db, conta.tenant_id, (tx) =>
        tx.execute(sql`
          update liame.sync_state
             set cursor = cursor || jsonb_build_object('aviso', jsonb_build_object('em', ${agora.toISOString()}::text, 'ok', ${ok}::boolean)), updated_at = now()
           where connected_account_id = ${conta.id} and dataset = 'pedidos'`),
      );
    } catch (err) {
      this.logger.warn(`loja ${conta.id}: situação do aviso não gravada (${err instanceof Error ? err.name : 'erro'}); o registro é repetido na próxima leitura`);
    }
  }

  /** O segredo da assinatura dos avisos desta conexão (um por conexão, no cofre); criado na primeira vez. */
  private segredoDoAviso(conta: LinhaConta): Promise<string | null> {
    return withTenant(this.db, conta.tenant_id, async (tx) => {
      const r = await tx.execute<{ inbox_secret_id: string | null }>(sql`
        select inbox_secret_id from liame.oauth_connection
         where id = ${conta.connection_id} and provider = 'regem' and status in ('aguardando_escolha', 'ativa')
         for update`);
      const conexao = r.rows[0];
      if (!conexao) return null;
      const guardado = conexao.inbox_secret_id ? await this.vault.readSecret(tx, conexao.inbox_secret_id) : null;
      if (guardado) return guardado;
      const novo = newWebhookSecret();
      const id = await this.vault.putSecret(tx, { tenantId: conta.tenant_id, purpose: 'inbox_regem', plaintext: novo });
      await tx.execute(sql`update liame.oauth_connection set inbox_secret_id = ${id}, updated_at = now() where id = ${conta.connection_id}`);
      await writeAudit(tx, {
        tenantId: conta.tenant_id,
        actorType: 'system',
        actorId: null,
        actorLabel: 'Liame (leitura do Regem)',
        action: 'conexao.ativar_aviso',
        resourceType: 'oauth_connection',
        resourceId: conta.connection_id!,
        before: null,
        after: { aviso: 'segredo criado para os avisos do Regem' },
        origin: 'worker',
      });
      return novo;
    });
  }

  private depois(agora: Date, minutos: number): string {
    return new Date(agora.getTime() + minutos * 60_000).toISOString();
  }

  private async abrirExecucao(conta: LinhaConta, tipo: 'carga_inicial' | 'incremental'): Promise<string> {
    const id = uuidv7();
    await withTenant(this.db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        insert into liame.sync_run (id, tenant_id, connected_account_id, dataset, kind, api_version)
        values (${id}, ${conta.tenant_id}, ${conta.id}, 'pedidos', ${tipo}, ${VERSAO_CONTRATO_REGEM})`),
    );
    return id;
  }

  /** Fecha a execução da loja: `parcial` quando um conjunto falhou e os outros seguiram (o erro diz quais). */
  private async fecharExecucao(conta: LinhaConta, id: string, status: 'ok' | 'parcial' | 'falhou', chamadas: number, r: ResultadoVendas, erro: string | null) {
    const escritos = (r.pedidos?.novos ?? 0) + (r.pedidos?.atualizados ?? 0) + (r.cupons ?? 0) + (r.anonimizados ?? 0);
    await withTenant(this.db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        update liame.sync_run set status = ${status}, calls = ${chamadas}, entities_written = ${escritos}, error = ${erro?.slice(0, 500) ?? null}, finished_at = now()
         where id = ${id}`),
    );
  }

  /**
   * Estado por conjunto (frescor): sucesso limpa o erro e grava o cursor; falha guarda o motivo. O instante
   * do último aviso (`evento_em`) é de quem recebe o aviso, não desta execução: fica sempre o do banco.
   */
  private async marcarEstado(conta: LinhaConta, dataset: DatasetVendas, erro: string | null, cursor: CursorVendas) {
    const sucesso = erro === null;
    await withTenant(this.db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at, last_attempt_at, last_error, cursor)
        values (${conta.id}, ${dataset}, ${conta.tenant_id}, ${INTERVALO_VENDAS_MIN}, ${sucesso ? sql`now()` : sql`null`}, now(), ${erro}, ${JSON.stringify(cursor)}::jsonb)
        on conflict (connected_account_id, dataset) do update
           set expected_every_minutes = excluded.expected_every_minutes,
               last_success_at = case when ${sucesso}::boolean then now() else liame.sync_state.last_success_at end,
               last_attempt_at = now(), last_error = excluded.last_error,
               cursor = excluded.cursor
                        || case when (liame.sync_state.cursor->'evento_em') is not null
                                then jsonb_build_object('evento_em', liame.sync_state.cursor->'evento_em') else '{}'::jsonb end,
               updated_at = now()`),
    );
  }

  /**
   * Quando a loja volta para a fila. A reserva é pela linha de `pedidos` (ERR-029): só a `proxima` dela muda.
   * Aviso do Regem que chegou DURANTE esta leitura (depois de `inicio`, pelo relógio do banco) pede outra
   * leitura agora: a página pode ter sido lida antes de a mudança aparecer, e sem isto ela esperaria 15 minutos.
   */
  private async agendarLoja(conta: LinhaConta, quando: number, inicio: string | null = null) {
    const proxima = new Date(quando).toISOString();
    await withTenant(this.db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        insert into liame.sync_state as s (connected_account_id, dataset, tenant_id, expected_every_minutes, cursor)
        values (${conta.id}, 'pedidos', ${conta.tenant_id}, ${INTERVALO_VENDAS_MIN}, jsonb_build_object('proxima', ${proxima}::text))
        on conflict (connected_account_id, dataset) do update
           set cursor = s.cursor || jsonb_build_object('proxima',
                 case when ${inicio}::timestamptz is not null and (s.cursor->>'evento_em')::timestamptz > ${inicio}::timestamptz
                      then to_jsonb(least(${proxima}::timestamptz, now()))
                      else to_jsonb(${proxima}::text) end),
               updated_at = now()`),
    );
  }

  private async situacaoDaConta(conta: LinhaConta, status: 'ativa' | 'desconectada' | 'erro', motivo: string | null) {
    await withTenant(this.db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        update liame.connected_account set status = ${status}, status_reason = ${motivo}, updated_at = now()
         where id = ${conta.id} and disconnected_at is null`),
    );
  }

  /** A conta mostra "erro" enquanto algum conjunto espera uma falha que não passa sozinha; sem nenhum, "ativa". */
  private async atualizarSituacao(conta: LinhaConta, comErro: DatasetVendas[]) {
    if (!comErro.length) {
      if (conta.status !== 'ativa') await this.situacaoDaConta(conta, 'ativa', null);
      return;
    }
    const motivo = `A leitura ${juntar(comErro.map((d) => NOME[d]))} falhou; tentamos de novo mais tarde.`;
    if (conta.status !== 'erro' || conta.status_reason !== motivo) await this.situacaoDaConta(conta, 'erro', motivo);
  }

  /**
   * Falha de um conjunto só (token recusado é da loja inteira, em `falhou`): o estado dele guarda o motivo, a
   * espera e o tipo da falha, a partir do último cursor gravado nesta execução.
   */
  private async falhaDoConjunto(
    conta: LinhaConta,
    dataset: DatasetVendas,
    cursor: CursorVendas,
    err: unknown,
    agora: Date,
  ): Promise<{ texto: string; tipo: TipoFalha; esperaAte: number }> {
    const e = err instanceof ErroConector ? err : null;
    // Texto seguro: a mensagem do ErroConector é nossa (sem corpo da resposta, telefone nem token).
    const texto = e ? `${e.tipo}: ${e.message}`.slice(0, 500) : 'erro interno';
    if (!e) this.logger.error(`loja ${conta.id} (${dataset}): ${err instanceof Error ? err.message : String(err)}`);
    else this.logger.warn(`loja ${conta.id} (${dataset}): ${texto}`);
    const tipo: TipoFalha = e?.tipo ?? 'interno';
    const falhas = (cursor.falhas_seguidas ?? 0) + 1;
    const esperaAte = agora.getTime() + esperaDaFalha(e, falhas);
    const quando = new Date(esperaAte).toISOString();
    await this.marcarEstado(conta, dataset, texto, { ...cursor, proxima: quando, espera_ate: quando, falha: tipo, falhas_seguidas: falhas });
    return { texto, tipo, esperaAte };
  }

  /** Token recusado: a leitura da loja inteira para até conectar de novo; a loja espera 30 min dobrando (até 12 h). */
  private async falhou(conta: LinhaConta, dataset: DatasetVendas, cursor: CursorVendas, err: ErroConector, agora: Date): Promise<ResultadoVendas> {
    const texto = `${err.tipo}: ${err.message}`.slice(0, 500);
    this.logger.warn(`loja ${conta.id} (${dataset}): ${texto}`);
    const falhas = (cursor.falhas_seguidas ?? 0) + 1;
    const quando = agora.getTime() + esperaDaFalha(err, falhas);
    await this.situacaoDaConta(conta, 'desconectada', 'O Regem recusou a autorização desta loja: conecte de novo.');
    await this.marcarEstado(conta, dataset, texto, { ...semFalha(cursor), proxima: new Date(quando).toISOString(), falhas_seguidas: falhas });
    // A reserva da loja é pela linha de pedidos: ela também espera.
    if (dataset !== 'pedidos') await this.agendarLoja(conta, quando);
    return { status: 'falhou', erro: texto };
  }
}
