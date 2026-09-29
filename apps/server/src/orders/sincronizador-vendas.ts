import { type Db, uuidv7, withTenant } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { atribuirPedidos, pedidosDosToques } from '../attribution/motor.js';
import { gravarToques, type ToqueLido } from '../attribution/toque-store.js';
import type { AppConfig } from '../config.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { lerPagina, VERSAO_CONTRATO_REGEM } from '../connectors/regem/conector-regem.js';
import { ClienteAnonimizado, CupomRegem, PedidoRegem } from '../connectors/regem/contrato-regem.js';
import type { VaultService } from '../vault/vault.service.js';
import { gravarPedidos, type PedidoLido } from './order-store.js';
import { gravarCupons, pedidoDoRegem, toqueDoPedido } from './regem-leitura.js';
import { normalizarTelefone } from './telefone.js';

// Leitura das vendas de uma loja do Regem (A2.5, F4; ADR-019, D-A2.5-5). Chamadas externas fora de
// transação; cada página gravada numa transação curta da empresa, com o cursor junto (a página gravada
// não é relida, a não gravada é). Carga inicial de 90 dias; depois, o cursor a cada 15 minutos e uma
// reconciliação diária dos últimos 3 dias, que devolve o que um evento perdido ou um cursor apressado
// deixou para trás (a versão do recurso descarta o que não mudou).

/** Uma leitura a cada 15 minutos (o webhook do Regem, quando existir, antecipa). */
export const INTERVALO_VENDAS_MIN = 15;
export const CARGA_INICIAL_VENDAS_DIAS = 90;
const RECONCILIACAO_DIAS = 3;
/** Teto de páginas por conjunto numa execução: loja grande termina na próxima, sem prender o worker. */
const PAGINAS_POR_EXECUCAO = 20;
const DIA_MS = 86_400_000;

export type DatasetVendas = 'pedidos' | 'cupons' | 'clientes_anonimizados';

/** Escopo do token que libera cada conjunto (docs/integracoes/regem.md §1). */
const ESCOPO: Record<DatasetVendas, string> = {
  pedidos: 'pedidos.ler',
  cupons: 'cupons.ler',
  clientes_anonimizados: 'clientes.anonimizacao.ler',
};

type CursorVendas = {
  cursor?: string | null;
  carga_inicial_em?: string;
  reconciliacao_em?: string;
  proxima?: string;
  falhas_seguidas?: number;
};

type LinhaConta = {
  id: string;
  tenant_id: string;
  brand_id: string;
  unit_id: string | null;
  external_id: string;
  status: string;
  credential_secret_id: string | null;
};

export type ResultadoVendas = {
  status: 'ok' | 'falhou' | 'ignorada';
  pedidos?: { novos: number; atualizados: number; ignorados: number };
  cupons?: number;
  anonimizados?: number;
  atribuidos?: number;
  semPermissao?: DatasetVendas[];
  erro?: string;
};

/**
 * Apaga os clientes pseudonimizados que a origem anonimizou. Apagar é só do escopo de sistema ("só o
 * expurgo apaga"), que o worker concede (regra `liame-escopo-sistema` do Semgrep): quem cria o
 * sincronizador passa esta função (`worker/vendas-loop.ts`).
 */
export type ApagarAnonimizados = (alvo: { tenantId: string; connectedAccountId: string; externalCustomerIds: string[] }) => Promise<number>;

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
      const r = await tx.execute<LinhaConta & { cursores: Record<string, CursorVendas> | null }>(sql`
        select a.id, a.tenant_id, a.brand_id, a.unit_id, a.external_id, a.status, a.credential_secret_id,
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
    const ctx = { cliente, apiUrl: this.config.produtos.regemApiUrl };
    const resultado: ResultadoVendas = { status: 'ok', semPermissao: [] };
    const runId = await this.abrirExecucao(conta, cursores.pedidos?.carga_inicial_em ? 'incremental' : 'carga_inicial');

    // Ordem: cupons (o pedido pode citar cupom novo), pedidos, avisos de cliente anonimizado.
    for (const dataset of ['cupons', 'pedidos', 'clientes_anonimizados'] as const) {
      const cursor = cursores[dataset] ?? {};
      if (!loja.escopos.includes(ESCOPO[dataset])) {
        resultado.semPermissao!.push(dataset);
        await this.marcarEstado(conta, dataset, 'sem_permissao: a loja não liberou este escopo', { ...cursor, proxima: this.depois(agora, 24 * 60) });
        continue;
      }
      try {
        if (dataset === 'cupons') resultado.cupons = await this.lerCupons(ctx, conta, loja.token, cursor, agora);
        else if (dataset === 'pedidos') {
          const r = await this.lerPedidos(ctx, conta, loja.token, cursor, agora);
          resultado.pedidos = r.pedidos;
          resultado.atribuidos = r.atribuidos;
        } else resultado.anonimizados = await this.lerAnonimizados(ctx, conta, loja.token, cursor, agora);
      } catch (err) {
        const e = err instanceof ErroConector ? err : null;
        // Token recusado vale para a loja inteira: para tudo e pede para conectar de novo.
        if (e?.tipo === 'autenticacao') {
          await this.fecharExecucao(conta, runId, 'falhou', cliente.chamadas, resultado, `${e.tipo}: ${e.message}`);
          return this.falhou(conta, dataset, cursor, err, agora);
        }
        if (e?.tipo === 'permissao') {
          resultado.semPermissao!.push(dataset);
          await this.marcarEstado(conta, dataset, `permissao: ${e.message}`.slice(0, 500), { ...cursor, proxima: this.depois(agora, 24 * 60) });
          continue;
        }
        await this.fecharExecucao(conta, runId, 'falhou', cliente.chamadas, resultado, e ? `${e.tipo}: ${e.message}` : 'erro interno');
        return this.falhou(conta, dataset, cursor, err, agora);
      }
    }
    await this.fecharExecucao(conta, runId, 'ok', cliente.chamadas, resultado, null);
    if (conta.status !== 'ativa') await this.situacaoDaConta(conta, 'ativa', null);
    return resultado;
  }

  /** Pedidos: cada página vira pedidos, cliques e a atribuição dos que mudaram, numa transação só. */
  private async lerPedidos(ctx: { cliente: ClienteConector; apiUrl: string }, conta: LinhaConta, token: string, cursor: CursorVendas, agora: Date) {
    const total = { novos: 0, atualizados: 0, ignorados: 0 };
    let atribuidos = 0;
    const cargaInicial = !cursor.carga_inicial_em;
    let posicao = cursor.cursor ?? null;
    let terminou = false;
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
      await this.marcarEstado(conta, 'pedidos', null, {
        ...cursor,
        cursor: posicao,
        carga_inicial_em: cursor.carga_inicial_em ?? (terminou ? agora.toISOString() : undefined),
        proxima: this.depois(agora, terminou ? INTERVALO_VENDAS_MIN : 1),
        falhas_seguidas: 0,
      });
      if (terminou) break;
    }

    // Reconciliação diária: relê os pedidos confirmados nos últimos 3 dias, sem mexer no cursor principal.
    const ultima = cursor.reconciliacao_em ? new Date(cursor.reconciliacao_em).getTime() : 0;
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
      await this.marcarEstado(conta, 'pedidos', null, {
        ...cursor,
        cursor: posicao,
        carga_inicial_em: cursor.carga_inicial_em,
        reconciliacao_em: agora.toISOString(),
        proxima: this.depois(agora, INTERVALO_VENDAS_MIN),
        falhas_seguidas: 0,
      });
    }
    return { pedidos: total, atribuidos };
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

  private async lerCupons(ctx: { cliente: ClienteConector; apiUrl: string }, conta: LinhaConta, token: string, cursor: CursorVendas, agora: Date): Promise<number> {
    let posicao = cursor.cursor ?? null;
    let alterados = 0;
    for (let pagina = 0; pagina < PAGINAS_POR_EXECUCAO; pagina++) {
      const pg = await lerPagina(ctx, { token, lojaChave: conta.external_id, rota: 'cupons', item: CupomRegem, cursor: posicao });
      alterados += (await withTenant(this.db, conta.tenant_id, (tx) => gravarCupons(tx, { tenantId: conta.tenant_id, brandId: conta.brand_id, connectedAccountId: conta.id }, pg.itens))).alterados;
      posicao = pg.proximoCursor ?? posicao;
      await this.marcarEstado(conta, 'cupons', null, { ...cursor, cursor: posicao, proxima: this.depois(agora, INTERVALO_VENDAS_MIN), falhas_seguidas: 0 });
      if (!pg.temMais) break;
    }
    return alterados;
  }

  /** Cliente anonimizado no Regem: o cliente pseudonimizado some do Liame (A2.5-7). Apagar é do escopo de sistema. */
  private async lerAnonimizados(ctx: { cliente: ClienteConector; apiUrl: string }, conta: LinhaConta, token: string, cursor: CursorVendas, agora: Date): Promise<number> {
    let posicao = cursor.cursor ?? null;
    let apagados = 0;
    for (let pagina = 0; pagina < PAGINAS_POR_EXECUCAO; pagina++) {
      const pg = await lerPagina(ctx, { token, lojaChave: conta.external_id, rota: 'clientes/anonimizados', item: ClienteAnonimizado, cursor: posicao });
      if (pg.itens.length) {
        apagados += await this.apagarAnonimizados({ tenantId: conta.tenant_id, connectedAccountId: conta.id, externalCustomerIds: pg.itens.map((c) => c.id) });
      }
      posicao = pg.proximoCursor ?? posicao;
      await this.marcarEstado(conta, 'clientes_anonimizados', null, { ...cursor, cursor: posicao, proxima: this.depois(agora, INTERVALO_VENDAS_MIN), falhas_seguidas: 0 });
      if (!pg.temMais) break;
    }
    return apagados;
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

  private async fecharExecucao(conta: LinhaConta, id: string, status: 'ok' | 'falhou', chamadas: number, r: ResultadoVendas, erro: string | null) {
    const escritos = (r.pedidos?.novos ?? 0) + (r.pedidos?.atualizados ?? 0) + (r.cupons ?? 0) + (r.anonimizados ?? 0);
    await withTenant(this.db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        update liame.sync_run set status = ${status}, calls = ${chamadas}, entities_written = ${escritos}, error = ${erro?.slice(0, 500) ?? null}, finished_at = now()
         where id = ${id}`),
    );
  }

  /** Estado por conjunto (frescor): sucesso limpa o erro e grava o cursor; falha guarda o motivo. */
  private async marcarEstado(conta: LinhaConta, dataset: DatasetVendas, erro: string | null, cursor: CursorVendas) {
    const sucesso = erro === null;
    await withTenant(this.db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at, last_attempt_at, last_error, cursor)
        values (${conta.id}, ${dataset}, ${conta.tenant_id}, ${INTERVALO_VENDAS_MIN}, ${sucesso ? sql`now()` : sql`null`}, now(), ${erro}, ${JSON.stringify(cursor)}::jsonb)
        on conflict (connected_account_id, dataset) do update
           set expected_every_minutes = excluded.expected_every_minutes,
               last_success_at = case when ${sucesso}::boolean then now() else liame.sync_state.last_success_at end,
               last_attempt_at = now(), last_error = excluded.last_error, cursor = excluded.cursor, updated_at = now()`),
    );
  }

  private async situacaoDaConta(conta: LinhaConta, status: 'ativa' | 'desconectada' | 'erro', motivo: string | null) {
    await withTenant(this.db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        update liame.connected_account set status = ${status}, status_reason = ${motivo}, updated_at = now()
         where id = ${conta.id} and disconnected_at is null`),
    );
  }

  /** Token recusado desliga a leitura até conectar de novo; o resto espera 30 min dobrando (até 12 h). */
  private async falhou(conta: LinhaConta, dataset: DatasetVendas, cursor: CursorVendas, err: unknown, agora: Date): Promise<ResultadoVendas> {
    const e = err instanceof ErroConector ? err : null;
    const texto = e ? `${e.tipo}: ${e.message}`.slice(0, 500) : 'erro interno';
    if (!e) this.logger.error(`loja ${conta.id}: ${err instanceof Error ? err.message : String(err)}`);
    else this.logger.warn(`loja ${conta.id} (${dataset}): ${texto}`);
    const falhas = (cursor.falhas_seguidas ?? 0) + 1;
    let espera = e?.esperarMs && e.esperarMs > 0 ? e.esperarMs : Math.min(30 * 60_000 * 2 ** (falhas - 1), 12 * 3_600_000);
    if (e?.tipo === 'autenticacao') await this.situacaoDaConta(conta, 'desconectada', 'O Regem recusou a autorização desta loja: conecte de novo.');
    else if (e?.tipo === 'definitivo' || !e) {
      await this.situacaoDaConta(conta, 'erro', 'A leitura das vendas falhou; tentamos de novo mais tarde.');
      espera = Math.max(espera, 6 * 3_600_000);
    }
    await this.marcarEstado(conta, dataset, texto, { ...cursor, proxima: new Date(agora.getTime() + espera).toISOString(), falhas_seguidas: falhas });
    // A reserva da loja é pela linha de pedidos: ela também espera.
    if (dataset !== 'pedidos') {
      await withTenant(this.db, conta.tenant_id, (tx) =>
        tx.execute(sql`
          update liame.sync_state set cursor = cursor || jsonb_build_object('proxima', ${new Date(agora.getTime() + espera).toISOString()}::text), updated_at = now()
           where connected_account_id = ${conta.id} and dataset = 'pedidos'`),
      );
    }
    return { status: 'falhou', erro: texto };
  }
}
