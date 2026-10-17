import { createHash } from 'node:crypto';
import { type Database, type Db, uuidv7, withSystem, withTenant } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { writeAudit } from '../audit/audit.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { contaConectada } from '../connections/conectada.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { clienteDoDmsId, recursoDoRegemcast } from '../connectors/dms/dms-id.js';
import { type ClienteDmsId, ErroDmsId } from '../connectors/dms/integracao-dms.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { type DesfechoDaComparacao, diferencas, FERRAMENTAS_COMPARADAS, type FerramentaComparada, normalizar, PERMISSOES_DA_COMPARACAO } from '../connectors/regemcast/comparacao.js';
import {
  detalharCampanhaDeMensagens,
  estimarPublico,
  lerCampanhasDeMensagens,
  lerContaDeMensagens,
  lerConversas,
  lerModelos,
  lerOrcamentoDeMensagens,
  lerPublicos,
  lerSituacao,
  planejarDisparo,
  trocarPorLigacao,
} from '../connectors/regemcast/conector-regemcast.js';
import type { CampanhasRegemcast, LigacaoRegemcast } from '../connectors/regemcast/contrato-regemcast.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { VaultService } from '../vault/vault.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// A comparação das duas credenciais do RegemCast (Hub DMS, F2, A3; decisões F2-3 e F2-7). Para cada conta do RegemCast
// conectada, de empresa com a flag `comparacao_dms_id` ligada, uma vez por hora: as 10 ferramentas de leitura pela
// credencial de hoje (`rct_it_`) e pela nova (o token do DMS ID do aplicativo do Liame e o segredo da ligação), uma logo
// depois da outra, comparadas campo a campo; a que difere é repetida uma vez antes de contar como diferença (dado que
// mudou entre as duas leituras não é diferença de credencial). Fica guardado só como terminou e o caminho do que
// difere, nunca o valor (`credential_comparison`, 90 dias).
//
// Nada aqui mexe na conta: uma recusa da via nova nunca a deixa "desconectada" (isso é da leitura de verdade). A cota e
// o disjuntor ficam à parte da produção (`comparacao:` e `comparacao-dms:`), e o limite do RegemCast é dividido com ela
// (a ligação herda o id do token): por isso uma vez por hora, uma conta por vez. Fica no worker porque reserva em escopo
// de sistema (V53); o resto roda na empresa.

/** A flag, por empresa (desligada para todos; quem liga é a distribuição). */
export const FLAG_COMPARACAO = 'comparacao_dms_id';
/** Uma comparação por conta a cada hora: 24 por dia, 336 em 14 dias por ferramenta (F2-7 pede 50). */
export const INTERVALO_COMPARACAO_MIN = 60;
/** Reserva da conta: se o worker cair no meio, ela volta para a fila depois disto. */
const RESERVA_MIN = 30;
/** Empresa com a flag desligada, ou conta sem o que comparar: vista de novo no dia seguinte (V106). */
const DEPOIS_DE_UM_DIA_MIN = 24 * 60;
/** O que identifica o segredo da ligação no cofre. */
export const PROPOSITO_DA_LIGACAO = 'ligacao_regemcast';

type ContaDaComparacao = {
  id: string;
  tenant_id: string;
  brand_id: string;
  external_id: string;
  conectada: boolean;
  ligacao_secret_id: string | null;
};

/** O segredo da ligação no cofre, com o resumo do `rct_it_` de onde ela veio. */
type LigacaoGuardada = { tipo: 'ligacao_regemcast'; ligacao: string; origem: string; obtida_em: string };

type Linha = { tool: FerramentaComparada; outcome: DesfechoDaComparacao; differences: string[]; retried: boolean; failure: string | null; duration_ms: number | null };

export type ResultadoDaComparacao =
  | { status: 'comparada'; iguais: number; diferentes: number; outros: number }
  | { status: 'desligada' | 'ignorada' }
  | { status: 'falhou'; erro: string };

type Acesso = { token: string; contaChave: string; ligacao?: string };
type Contexto = { cliente: ClienteConector; apiUrl: string };
/** O que as ferramentas que pedem um id usam: a campanha mais nova e o rascunho mais novo, lidos pela via de hoje. */
type Base = { campanhaId: string | null; rascunhoId: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O que cada ferramenta que pede um id precisa ter na conta; sem ele, a comparação dela fica "sem dado". */
const PRECISA: Partial<Record<FerramentaComparada, (base: Base) => boolean>> = {
  campanha_detalhar: (b) => b.campanhaId !== null,
  campanha_disparo_planejar: (b) => b.rascunhoId !== null,
};

/** Como cada ferramenta é chamada (as que pedem id só são chamadas com ele: ver `PRECISA`). */
const LEITORES: Record<FerramentaComparada, (ctx: Contexto, a: Acesso, base: Base) => Promise<unknown>> = {
  integracao_situacao: (ctx, a) => lerSituacao(ctx, a.token, a.contaChave, a.ligacao),
  conversas_anuncio_listar: (ctx, a) => lerConversas(ctx, { ...a, cursor: null, limite: 20 }),
  conta_situacao: (ctx, a) => lerContaDeMensagens(ctx, a),
  campanhas_listar: (ctx, a) => lerCampanhasDeMensagens(ctx, { ...a, limite: 20 }),
  campanha_detalhar: (ctx, a, b) => detalharCampanhaDeMensagens(ctx, { ...a, id: b.campanhaId ?? '' }),
  publicos_listar: (ctx, a) => lerPublicos(ctx, a),
  modelos_listar: (ctx, a) => lerModelos(ctx, a),
  orcamento_ler: (ctx, a) => lerOrcamentoDeMensagens(ctx, a),
  publico_estimar: (ctx, a) => estimarPublico(ctx, { ...a, publico: { origem: 'base' }, categoria: 'marketing' }),
  campanha_disparo_planejar: (ctx, a, b) => planejarDisparo(ctx, { ...a, id: b.rascunhoId ?? '' }),
};

/** O token do DMS ID foi recusado pelo RegemCast (vencido, trocado): pedir outro uma vez resolve. */
const tokenRecusado = (erro: unknown): boolean => erro instanceof ErroConector && erro.tipo === 'autenticacao' && erro.codigoProvider === 'token-invalido';

const resumo = (texto: string): string => createHash('sha256').update(texto, 'utf8').digest('hex');

/** O motivo de uma falha em palavras do Liame: o tipo e o nome do problema, nunca o corpo da resposta. */
function motivo(err: unknown): string {
  if (err instanceof ErroConector) return `${err.tipo}${err.codigoProvider ? `:${err.codigoProvider}` : ''}`.slice(0, 200);
  if (err instanceof ErroDmsId) return `dms_id:${err.status}${err.codigo ? `:${err.codigo}` : ''}`.slice(0, 200);
  return 'erro interno';
}

type Tentativa = { ok: true; dado: unknown; ms: number } | { ok: false; erro: unknown; ms: number };

async function tentar(f: () => Promise<unknown>): Promise<Tentativa> {
  const inicio = Date.now();
  try {
    return { ok: true, dado: await f(), ms: Date.now() - inicio };
  } catch (erro) {
    return { ok: false, erro, ms: Date.now() - inicio };
  }
}

@Injectable()
export class ComparacaoDmsIdLoop {
  private readonly logger = new Logger('comparacao-dms-id');
  private cliente: ClienteDmsId | null = null;

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
    private readonly flags: FlagService,
  ) {}

  /** O cliente do DMS ID, um por processo: guarda o token e junta os pedidos ao mesmo tempo num só. */
  private dmsId(): ClienteDmsId {
    if (!this.cliente) this.cliente = clienteDoDmsId(this.config.dmsId!);
    return this.cliente;
  }

  async executarLote(limite = 2, scope: JobScope = {}, agora: Date = new Date()): Promise<ResultadoDaComparacao[]> {
    // Sem o aplicativo do Liame no DMS ID ou sem o endereço do RegemCast, não há o que comparar.
    if (!this.database || !this.config.dmsId || !this.config.produtos.regemcastApiUrl) return [];
    const db = this.database.db;
    const referencia = sql`${agora.toISOString()}::timestamptz`;
    const elegivel = sql`a.provider = 'regemcast' and ${contaConectada('a')} and a.credential_secret_id is not null`;
    const reservadas = await withSystem(db, async (tx) => {
      // A conta conectada ganha a linha dela, devida desde já.
      await tx.execute(sql`
        insert into liame.credential_comparison_state (connected_account_id, tenant_id, next_at)
        select a.id, a.tenant_id, ${referencia}
          from liame.connected_account a
         where ${elegivel} ${tenantFilter(scope, sql`a.tenant_id`)}
           and not exists (select 1 from liame.credential_comparison_state c where c.connected_account_id = a.id)
        on conflict (connected_account_id) do nothing`);
      const r = await tx.execute<{ id: string; tenant_id: string }>(sql`
        with devidas as materialized (
          select c.connected_account_id
            from liame.credential_comparison_state c
            join liame.connected_account a on a.id = c.connected_account_id
           where ${elegivel} and c.next_at <= ${referencia} ${tenantFilter(scope, sql`a.tenant_id`)}
           order by c.next_at, c.connected_account_id
           limit ${limite}
           for update of c skip locked
        )
        update liame.credential_comparison_state c
           set next_at = ${referencia} + make_interval(mins => ${RESERVA_MIN}), updated_at = ${referencia}
          from devidas d
         where c.connected_account_id = d.connected_account_id
        returning c.connected_account_id as id, c.tenant_id`);
      return r.rows;
    });
    const resultados: ResultadoDaComparacao[] = [];
    for (const c of reservadas) {
      try {
        resultados.push(await this.compararConta(db, c.id, c.tenant_id, agora));
      } catch (err) {
        // Falha fora do previsto (banco): a reserva vence e a conta volta para a fila (LIC-001).
        this.logger.error(`conta ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
        resultados.push({ status: 'falhou', erro: 'erro interno' });
      }
    }
    return resultados;
  }

  /** Compara as 10 leituras de uma conta pelas duas credenciais e guarda como terminou cada uma. */
  async compararConta(db: Db, contaId: string, tenantId: string, agora: Date): Promise<ResultadoDaComparacao> {
    const lida = await withTenant(db, tenantId, async (tx) => {
      const r = await tx.execute<ContaDaComparacao & { credential_secret_id: string | null }>(sql`
        select a.id, a.tenant_id, a.brand_id, a.external_id, a.credential_secret_id, a.ligacao_secret_id, ${contaConectada('a')} as conectada
          from liame.connected_account a
         where a.id = ${contaId} and a.provider = 'regemcast'`);
      const conta = r.rows[0];
      if (!conta) return null;
      // Desligada ou recusada pela plataforma depois da reserva: o critério é um só (F2-5), e o cofre não é lido.
      if (!conta.conectada) return { conta, credencial: null, ligacao: null };
      const credencial = conta.credential_secret_id ? await this.vault.readSecret(tx, conta.credential_secret_id) : null;
      const ligacao = conta.ligacao_secret_id ? await this.vault.readSecret(tx, conta.ligacao_secret_id) : null;
      return { conta, credencial, ligacao };
    });
    if (!lida || !lida.conta.conectada) {
      if (lida) await this.marcar(db, lida.conta, agora, DEPOIS_DE_UM_DIA_MIN, 'a conta não está conectada');
      return { status: 'ignorada' };
    }
    const { conta } = lida;
    if (!(await this.flags.isEnabled(FLAG_COMPARACAO, this.flags.context({ tenantId, brandId: conta.brand_id, accountId: conta.id })))) {
      await this.marcar(db, conta, agora, DEPOIS_DE_UM_DIA_MIN, null);
      return { status: 'desligada' };
    }
    const guardada = lida.credencial ? (JSON.parse(lida.credencial) as CredencialGuardada) : null;
    const rctIt = guardada?.tipo === 'regemcast' ? guardada.lojas.find((l) => l.loja_id === conta.external_id)?.token : undefined;
    if (!rctIt) {
      await this.marcar(db, conta, agora, DEPOIS_DE_UM_DIA_MIN, 'sem o token de integração da conta no cofre');
      return { status: 'ignorada' };
    }

    const apiUrl = this.config.produtos.regemcastApiUrl!;
    const ctx: Contexto = {
      cliente: new ClienteConector(db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 2, tempoLimiteMs: 20_000 }),
      apiUrl,
    };
    const recurso = recursoDoRegemcast(apiUrl);
    const contaChaveAtual = `comparacao:${conta.external_id}`;
    const contaChaveNova = `comparacao-dms:${conta.external_id}`;

    let tokenDmsId: string;
    try {
      tokenDmsId = await this.dmsId().token(recurso, PERMISSOES_DA_COMPARACAO);
    } catch (err) {
      await this.marcar(db, conta, agora, INTERVALO_COMPARACAO_MIN, motivo(err));
      return { status: 'falhou', erro: motivo(err) };
    }

    // A ligação da conta: a guardada, se veio deste mesmo `rct_it_`; senão, a troca (a conta reconectou com outro token,
    // ou é a primeira vez).
    const origem = resumo(rctIt);
    const doCofre = lida.ligacao ? (JSON.parse(lida.ligacao) as LigacaoGuardada) : null;
    let ligacao = doCofre?.origem === origem ? doCofre.ligacao : null;
    if (!ligacao) {
      try {
        ligacao = await this.trocar(db, ctx, conta, rctIt, origem, contaChaveNova, recurso, tokenDmsId);
      } catch (err) {
        await this.marcar(db, conta, agora, INTERVALO_COMPARACAO_MIN, `troca: ${motivo(err)}`);
        return { status: 'falhou', erro: `troca: ${motivo(err)}` };
      }
    }

    const atual: Acesso = { token: rctIt, contaChave: contaChaveAtual };
    let nova: Acesso = { token: tokenDmsId, contaChave: contaChaveNova, ligacao };
    let ligacaoRecusada = false;
    const base: Base = { campanhaId: null, rascunhoId: null };
    const linhas: Linha[] = [];

    /** A chamada pela via nova; com o token do DMS ID recusado, pede outro e tenta uma vez mais. */
    const pelaNova = async (ferramenta: FerramentaComparada): Promise<{ t: Tentativa; repetiu: boolean }> => {
      const t = await tentar(() => LEITORES[ferramenta](ctx, nova, base));
      if (t.ok || !tokenRecusado(t.erro)) return { t, repetiu: false };
      this.dmsId().esquecer(recurso, PERMISSOES_DA_COMPARACAO);
      const outro = await tentar(() => this.dmsId().token(recurso, PERMISSOES_DA_COMPARACAO));
      if (!outro.ok) return { t: outro, repetiu: true };
      nova = { ...nova, token: outro.dado as string };
      return { t: await tentar(() => LEITORES[ferramenta](ctx, nova, base)), repetiu: true };
    };

    for (const ferramenta of FERRAMENTAS_COMPARADAS) {
      const precisa = PRECISA[ferramenta];
      if (precisa && !precisa(base)) {
        linhas.push({ tool: ferramenta, outcome: 'sem_dado', differences: [], retried: false, failure: null, duration_ms: null });
        continue;
      }
      let a = await tentar(() => LEITORES[ferramenta](ctx, atual, base));
      let { t: b, repetiu } = await pelaNova(ferramenta);
      if (a.ok && ferramenta === 'campanhas_listar') {
        const campanhas = (a.dado as CampanhasRegemcast).campanhas;
        base.campanhaId = campanhas[0]?.id ?? null;
        base.rascunhoId = campanhas.find((c) => c.situacao === 'rascunho' && UUID.test(c.id))?.id ?? null;
      }
      // As duas leram e deram diferente: lê as duas de novo, uma vez (o dado pode ter mudado entre as duas leituras).
      if (a.ok && b.ok && diferencas(normalizar(ferramenta, a.dado), normalizar(ferramenta, b.dado)).length) {
        a = await tentar(() => LEITORES[ferramenta](ctx, atual, base));
        ({ t: b } = await pelaNova(ferramenta));
        repetiu = true;
      }
      linhas.push(this.desfecho(ferramenta, a, b, repetiu));
      if (!b.ok && b.erro instanceof ErroConector && b.erro.codigoProvider === 'ligacao-invalida') ligacaoRecusada = true;
    }

    await withTenant(db, tenantId, async (tx) => {
      const registros = linhas.map((l) => ({ id: uuidv7(), ...l, differences: l.differences }));
      await tx.execute(sql`
        insert into liame.credential_comparison (id, tenant_id, connected_account_id, tool, outcome, differences, retried, failure, duration_ms, compared_at)
        select x.id, ${tenantId}, ${conta.id}, x.tool, x.outcome, x.differences, x.retried, x.failure, x.duration_ms, ${agora.toISOString()}::timestamptz
          from jsonb_to_recordset(${JSON.stringify(registros)}::jsonb)
               as x (id uuid, tool text, outcome text, differences jsonb, retried boolean, failure text, duration_ms integer)`);
      // A ligação que o RegemCast recusou sai do cofre: a próxima vez troca de novo.
      if (ligacaoRecusada && conta.ligacao_secret_id) {
        await this.vault.revokeSecret(tx, conta.ligacao_secret_id);
      }
    });
    const iguais = linhas.filter((l) => l.outcome === 'igual').length;
    const diferentes = linhas.filter((l) => l.outcome === 'diferente' || l.outcome === 'nova_falhou').length;
    if (diferentes) {
      const quais = linhas.filter((l) => l.outcome === 'diferente' || l.outcome === 'nova_falhou').map((l) => `${l.tool} (${l.outcome}${l.failure ? `: ${l.failure}` : ''})`);
      this.logger.warn(`conta ${conta.id}: ${diferentes} de ${linhas.length} leituras diferentes pela credencial nova: ${quais.join(', ')}`);
    }
    await this.marcar(db, conta, agora, INTERVALO_COMPARACAO_MIN, ligacaoRecusada ? 'a ligação foi recusada pelo RegemCast: troca de novo na próxima vez' : null);
    return { status: 'comparada', iguais, diferentes, outros: linhas.length - iguais - diferentes };
  }

  /** Como terminou a comparação de uma ferramenta. */
  private desfecho(tool: FerramentaComparada, a: Tentativa, b: Tentativa, retried: boolean): Linha {
    const duration_ms = b.ms;
    if (a.ok && b.ok) {
      const caminhos = diferencas(normalizar(tool, a.dado), normalizar(tool, b.dado));
      return { tool, outcome: caminhos.length ? 'diferente' : 'igual', differences: caminhos, retried, failure: null, duration_ms };
    }
    if (a.ok) return { tool, outcome: 'nova_falhou', differences: [], retried, failure: motivo(!b.ok ? b.erro : null), duration_ms };
    if (b.ok) return { tool, outcome: 'atual_falhou', differences: [], retried, failure: motivo(a.erro), duration_ms };
    // As duas recusaram: do mesmo tipo é o mesmo comportamento (a conta suspensa, a ferramenta que recusa o argumento).
    const [ma, mb] = [motivo(a.erro), motivo(b.erro)];
    const mesmoTipo = a.erro instanceof ErroConector && b.erro instanceof ErroConector && a.erro.tipo === b.erro.tipo;
    return {
      tool,
      outcome: mesmoTipo ? 'igual' : 'diferente',
      differences: mesmoTipo ? [] : ['(erro)'],
      retried,
      failure: `as duas falharam (de hoje ${ma}; nova ${mb})`.slice(0, 200),
      duration_ms,
    };
  }

  /**
   * A troca automática (F2-3): o RegemCast devolve o segredo da ligação desta conta em troca do `rct_it_` dela. O
   * segredo vai direto para o cofre, com o resumo do `rct_it_` de onde veio; o anterior é revogado.
   */
  private async trocar(db: Db, ctx: Contexto, conta: ContaDaComparacao, rctIt: string, origem: string, contaChave: string, recurso: string, tokenDmsId: string): Promise<string> {
    let token = tokenDmsId;
    let resposta: LigacaoRegemcast;
    try {
      resposta = await trocarPorLigacao(ctx, { tokenDmsId: token, tokenIntegracao: rctIt, contaChave });
    } catch (err) {
      if (!tokenRecusado(err)) throw err;
      this.dmsId().esquecer(recurso, PERMISSOES_DA_COMPARACAO);
      token = await this.dmsId().token(recurso, PERMISSOES_DA_COMPARACAO);
      resposta = await trocarPorLigacao(ctx, { tokenDmsId: token, tokenIntegracao: rctIt, contaChave });
    }
    // A ligação é da conta que o `rct_it_` abre: outra conta aqui é defeito de alguém, e o segredo não é guardado.
    if (resposta.conta_id !== conta.external_id) throw new ErroConector('definitivo', 'regemcast', 'a ligação veio de outra conta');
    const guardar: LigacaoGuardada = { tipo: 'ligacao_regemcast', ligacao: resposta.ligacao, origem, obtida_em: resposta.segredo_em };
    await withTenant(db, conta.tenant_id, async (tx) => {
      const id = await this.vault.putSecret(tx, { tenantId: conta.tenant_id, purpose: PROPOSITO_DA_LIGACAO, plaintext: JSON.stringify(guardar) });
      if (conta.ligacao_secret_id) await this.vault.revokeSecret(tx, conta.ligacao_secret_id);
      await tx.execute(sql`update liame.connected_account set ligacao_secret_id = ${id}, updated_at = now() where id = ${conta.id}`);
      await writeAudit(tx, {
        tenantId: conta.tenant_id,
        actorType: 'system',
        actorId: null,
        actorLabel: 'Liame (Hub DMS: comparação das credenciais do RegemCast)',
        action: 'conexao.ligacao_dms_id',
        resourceType: 'connected_account',
        resourceId: conta.id,
        before: null,
        after: { ligacao: resposta.prefixo, permissoes: resposta.permissoes, segredo_em: resposta.segredo_em },
        origin: 'worker',
      });
      conta.ligacao_secret_id = id;
    });
    return resposta.ligacao;
  }

  /** A próxima vez da conta e o último erro (texto do Liame, sem dado da plataforma). */
  private async marcar(db: Db, conta: { id: string; tenant_id: string }, agora: Date, depoisMin: number, erro: string | null): Promise<void> {
    await withTenant(db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        update liame.credential_comparison_state
           set next_at = ${agora.toISOString()}::timestamptz + make_interval(mins => ${depoisMin}), last_at = ${agora.toISOString()}::timestamptz,
               last_error = ${erro === null ? null : erro.slice(0, 300)}, updated_at = now()
         where connected_account_id = ${conta.id}`),
    );
  }
}
