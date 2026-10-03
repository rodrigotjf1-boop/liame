import { type Db, uuidv7, withTenant } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { ClienteConector, ErroConector, type TipoErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { lerConversas, VERSAO_CONTRATO_REGEMCAST } from '../connectors/regemcast/conector-regemcast.js';
import type { ConversaAnuncio } from '../connectors/regemcast/contrato-regemcast.js';
import { normalizarTelefone } from '../orders/telefone.js';
import type { VaultService } from '../vault/vault.service.js';
import { atribuirPedidos, pedidosDosToques } from './motor.js';
import { gravarToques, type ToqueLido } from './toque-store.js';

// Leitura das conversas abertas por anúncio de uma conta do RegemCast (A2.5, F7; contrato v2,
// docs/integracoes/regemcast.md). Chamadas externas fora de transação; cada página gravada numa transação
// curta da empresa, com o cursor junto (a página gravada não é relida, a não gravada é). Carga inicial de 90
// dias e depois o cursor a cada 15 minutos. Sem reconciliação: a linha do RegemCast não muda depois de
// entrar (`versao` 1), e o cursor só entrega o que entrou há pelo menos 5 segundos (contrato §4).
//
// O telefone vira índice cego (chave da empresa, no cofre) na chegada e não é guardado (ADR-019 item 8). A
// conversa entra como toque `conversa` da Meta: com o anúncio quando a origem é um anúncio, sem ele quando é
// uma publicação. A atribuição dos pedidos do mesmo cliente é refeita na mesma transação.

/** Uma leitura a cada 15 minutos (o RegemCast não manda aviso: contrato §6). */
export const INTERVALO_CONVERSAS_MIN = 15;
export const CARGA_INICIAL_CONVERSAS_DIAS = 90;
export const DATASET_CONVERSAS = 'conversas_anuncio';
const ESCOPO = 'conversas.anuncio.ler';
/** Teto de páginas numa execução: conta grande termina na próxima, sem prender o worker. */
const PAGINAS_POR_EXECUCAO = 20;
const DIA_MS = 86_400_000;

type TipoFalha = TipoErroConector | 'interno';

type CursorConversas = {
  cursor?: string | null;
  carga_inicial_em?: string;
  /** Quando a conta volta para a fila (a reserva é por esta linha). */
  proxima?: string;
  falhas_seguidas?: number;
  /** Depois de uma falha, a conta só é lida de novo a partir daqui. */
  espera_ate?: string;
  falha?: TipoFalha;
};

type LinhaConta = {
  id: string;
  tenant_id: string;
  brand_id: string;
  external_id: string;
  status: string;
  status_reason: string | null;
  credential_secret_id: string | null;
};

export type ResultadoConversas = {
  status: 'ok' | 'falhou' | 'sem_permissao' | 'adiada' | 'ignorada';
  /** Conversas lidas (novas ou repetidas) e toques que mudaram. */
  conversas?: number;
  toques?: number;
  atribuidos?: number;
  erro?: string;
};

/** A conversa como ponto de contato. O telefone já chega como índice cego (ou nulo, se não deu para normalizar). */
export function toqueDaConversa(c: ConversaAnuncio, indiceTelefone: string | null): ToqueLido {
  return {
    externalId: `conversa:${c.id}`,
    kind: 'conversa',
    occurredAt: c.aberta_em,
    customerPhoneIndex: indiceTelefone,
    // O referral do WhatsApp é sempre da Meta (anúncio ou publicação de Facebook e Instagram).
    provider: 'meta_ads',
    adExternalId: c.tipo_origem === 'ad' ? c.anuncio_id : null,
    ctwaClid: c.ctwa_clid,
    origem: 'regemcast',
  };
}

/** O cursor depois de uma leitura boa: sem a espera nem o tipo da falha anterior. */
function semFalha(c: CursorConversas): CursorConversas {
  const { espera_ate: _espera, falha: _falha, ...resto } = c;
  return resto;
}

/** Sem permissão, um dia; erro definitivo ou nosso, 6 h no mínimo; o resto, 30 min dobrando até 12 h (como as vendas). */
function esperaDaFalha(e: ErroConector | null, falhas: number): number {
  if (e?.tipo === 'permissao') return DIA_MS;
  const base = e?.esperarMs && e.esperarMs > 0 ? e.esperarMs : Math.min(30 * 60_000 * 2 ** (falhas - 1), 12 * 3_600_000);
  return !e || e.tipo === 'definitivo' ? Math.max(base, 6 * 3_600_000) : base;
}

export class SincronizadorConversas {
  private readonly logger = new Logger('conversas');

  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly config: AppConfig,
  ) {}

  async sincronizar(contaId: string, tenantId: string, agora: Date = new Date()): Promise<ResultadoConversas> {
    const lida = await withTenant(this.db, tenantId, async (tx) => {
      const r = await tx.execute<LinhaConta & { cursor: CursorConversas | null }>(sql`
        select a.id, a.tenant_id, a.brand_id, a.external_id, a.status, a.status_reason, a.credential_secret_id,
               (select s.cursor from liame.sync_state s where s.connected_account_id = a.id and s.dataset = ${DATASET_CONVERSAS}) as cursor
          from liame.connected_account a
         where a.id = ${contaId} and a.provider = 'regemcast' and a.disconnected_at is null`);
      const conta = r.rows[0];
      if (!conta) return null;
      const segredo = conta.credential_secret_id ? await this.vault.readSecret(tx, conta.credential_secret_id) : null;
      return { conta, segredo, cursor: conta.cursor ?? {} };
    });
    if (!lida) return { status: 'ignorada' };
    const { conta } = lida;
    const cursor: CursorConversas = lida.cursor;

    const credencial = lida.segredo ? (JSON.parse(lida.segredo) as CredencialGuardada) : null;
    const entrada = credencial?.tipo === 'regemcast' ? credencial.lojas.find((l) => l.loja_id === conta.external_id) : undefined;
    if (!entrada) return this.desconectar(conta, cursor, new ErroConector('autenticacao', 'regemcast', 'autorização revogada ou sem o token desta conta'), agora);

    const apiUrl = this.config.produtos.regemcastApiUrl;
    if (!apiUrl) {
      // Sem o endereço da distribuição (REGEMCAST_API_URL), nada é lido: a conta é vista de novo no dia seguinte.
      await this.marcarEstado(conta, 'sem_endereco: REGEMCAST_API_URL não definida', { ...cursor, proxima: this.depois(agora, 24 * 60) });
      return { status: 'ignorada', erro: 'REGEMCAST_API_URL não definida' };
    }
    if (!entrada.escopos.includes(ESCOPO)) {
      await this.marcarEstado(conta, 'sem_permissao: o token não liberou as conversas abertas por anúncio', { ...semFalha(cursor), proxima: this.depois(agora, 24 * 60) });
      await this.atualizarSituacao(conta, null);
      return { status: 'sem_permissao' };
    }
    const espera = cursor.espera_ate ? Date.parse(cursor.espera_ate) : Number.NaN;
    if (espera > agora.getTime()) {
      // Esperando a vez depois de uma falha: a reserva só a trouxe porque a `proxima` venceu antes.
      await this.marcarEstado(conta, null, { ...cursor, proxima: new Date(espera).toISOString() }, false);
      return { status: 'adiada' };
    }

    const cliente = new ClienteConector(this.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos) });
    const ctx = { cliente, apiUrl };
    const inicial = semFalha(cursor);
    const cargaInicial = !inicial.carga_inicial_em;
    const runId = await this.abrirExecucao(conta, cargaInicial ? 'carga_inicial' : 'incremental');
    const resultado: ResultadoConversas = { status: 'ok', conversas: 0, toques: 0, atribuidos: 0 };
    let estado: CursorConversas = inicial;
    try {
      let posicao = inicial.cursor ?? null;
      const desde = cargaInicial ? new Date(agora.getTime() - CARGA_INICIAL_CONVERSAS_DIAS * DIA_MS).toISOString() : null;
      for (let pagina = 0; pagina < PAGINAS_POR_EXECUCAO; pagina++) {
        const pg = await lerConversas(ctx, { token: entrada.token, contaChave: conta.external_id, cursor: posicao, desde });
        const g = await this.gravarPagina(conta, pg.itens);
        resultado.conversas! += pg.itens.length;
        resultado.toques! += g.toques;
        resultado.atribuidos! += g.atribuidos;
        posicao = pg.proximoCursor ?? posicao;
        const terminou = !pg.temMais;
        estado = {
          ...inicial,
          cursor: posicao,
          carga_inicial_em: inicial.carga_inicial_em ?? (terminou ? agora.toISOString() : undefined),
          proxima: this.depois(agora, terminou ? INTERVALO_CONVERSAS_MIN : 1),
          falhas_seguidas: 0,
        };
        await this.marcarEstado(conta, null, estado);
        if (terminou) break;
      }
    } catch (err) {
      const e = err instanceof ErroConector ? err : null;
      // Token recusado: a conta para até conectar de novo.
      if (e?.tipo === 'autenticacao') {
        await this.fecharExecucao(conta, runId, 'falhou', cliente.chamadas, resultado, `${e.tipo}: ${e.message}`);
        return this.desconectar(conta, estado, e, agora);
      }
      const texto = e ? `${e.tipo}: ${e.message}`.slice(0, 500) : 'erro interno';
      if (!e) this.logger.error(`conta ${conta.id}: ${err instanceof Error ? err.message : String(err)}`);
      else this.logger.warn(`conta ${conta.id}: ${texto}`);
      const tipo: TipoFalha = e?.tipo ?? 'interno';
      const falhas = (estado.falhas_seguidas ?? 0) + 1;
      const quando = new Date(agora.getTime() + esperaDaFalha(e, falhas)).toISOString();
      await this.marcarEstado(conta, texto, { ...estado, proxima: quando, espera_ate: quando, falha: tipo, falhas_seguidas: falhas });
      await this.fecharExecucao(conta, runId, 'falhou', cliente.chamadas, resultado, texto);
      await this.atualizarSituacao(conta, tipo === 'definitivo' || tipo === 'interno' ? tipo : null);
      return { ...resultado, status: tipo === 'permissao' ? 'sem_permissao' : 'falhou', erro: texto };
    }
    await this.fecharExecucao(conta, runId, 'ok', cliente.chamadas, resultado, null);
    await this.atualizarSituacao(conta, null);
    return resultado;
  }

  /** Uma página: telefone → índice cego, toques, e a atribuição dos pedidos que esses toques alcançam. */
  private async gravarPagina(conta: LinhaConta, itens: ConversaAnuncio[]): Promise<{ toques: number; atribuidos: number }> {
    if (!itens.length) return { toques: 0, atribuidos: 0 };
    return withTenant(this.db, conta.tenant_id, async (tx) => {
      const indices = new Map<string, string>();
      for (const c of itens) {
        const telefone = normalizarTelefone(c.telefone);
        if (telefone && !indices.has(telefone)) indices.set(telefone, await this.vault.blindIndexFor(tx, conta.tenant_id, telefone));
      }
      const toques = itens.map((c) => {
        const telefone = normalizarTelefone(c.telefone);
        return toqueDaConversa(c, telefone ? indices.get(telefone)! : null);
      });
      const t = await gravarToques(tx, { tenantId: conta.tenant_id, brandId: conta.brand_id, connectedAccountId: conta.id }, toques);
      const afetados = await pedidosDosToques(tx, conta.tenant_id, t.alterados);
      const a = afetados.length ? await atribuirPedidos(tx, { tenantId: conta.tenant_id, orderIds: afetados, gatilho: 'toques' }) : { atribuidos: 0 };
      return { toques: t.alterados.length, atribuidos: a.atribuidos };
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
        values (${id}, ${conta.tenant_id}, ${conta.id}, ${DATASET_CONVERSAS}, ${tipo}, ${VERSAO_CONTRATO_REGEMCAST})`),
    );
    return id;
  }

  private async fecharExecucao(conta: LinhaConta, id: string, status: 'ok' | 'falhou', chamadas: number, r: ResultadoConversas, erro: string | null) {
    await withTenant(this.db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        update liame.sync_run set status = ${status}, calls = ${chamadas}, entities_written = ${r.toques ?? 0}, error = ${erro?.slice(0, 500) ?? null}, finished_at = now()
         where id = ${id}`),
    );
  }

  /** Estado da leitura (frescor e reserva): sucesso limpa o erro e grava o cursor; falha guarda o motivo. */
  private async marcarEstado(conta: LinhaConta, erro: string | null, cursor: CursorConversas, tentativa = true) {
    const sucesso = erro === null && tentativa;
    await withTenant(this.db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at, last_attempt_at, last_error, cursor)
        values (${conta.id}, ${DATASET_CONVERSAS}, ${conta.tenant_id}, ${INTERVALO_CONVERSAS_MIN}, ${sucesso ? sql`now()` : sql`null`}, now(), ${erro}, ${JSON.stringify(cursor)}::jsonb)
        on conflict (connected_account_id, dataset) do update
           set expected_every_minutes = excluded.expected_every_minutes,
               last_success_at = case when ${sucesso}::boolean then now() else liame.sync_state.last_success_at end,
               last_attempt_at = case when ${tentativa}::boolean then now() else liame.sync_state.last_attempt_at end,
               last_error = case when ${tentativa}::boolean then excluded.last_error else liame.sync_state.last_error end,
               cursor = excluded.cursor,
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

  /** A conta mostra "erro" enquanto a falha não passa sozinha; sem falha assim, "ativa". */
  private async atualizarSituacao(conta: LinhaConta, falha: 'definitivo' | 'interno' | null) {
    if (!falha) {
      if (conta.status !== 'ativa') await this.situacaoDaConta(conta, 'ativa', null);
      return;
    }
    const motivo = 'A leitura das conversas abertas por anúncio falhou; tentamos de novo mais tarde.';
    if (conta.status !== 'erro' || conta.status_reason !== motivo) await this.situacaoDaConta(conta, 'erro', motivo);
  }

  /** Token recusado: a leitura para até conectar de novo; a conta espera 30 min dobrando (até 12 h). */
  private async desconectar(conta: LinhaConta, cursor: CursorConversas, err: ErroConector, agora: Date): Promise<ResultadoConversas> {
    const texto = `${err.tipo}: ${err.message}`.slice(0, 500);
    this.logger.warn(`conta ${conta.id}: ${texto}`);
    const falhas = (cursor.falhas_seguidas ?? 0) + 1;
    const quando = new Date(agora.getTime() + esperaDaFalha(err, falhas)).toISOString();
    await this.situacaoDaConta(conta, 'desconectada', 'O RegemCast recusou a autorização desta conta: conecte de novo.');
    await this.marcarEstado(conta, texto, { ...semFalha(cursor), proxima: quando, falhas_seguidas: falhas });
    return { status: 'falhou', erro: texto };
  }
}
