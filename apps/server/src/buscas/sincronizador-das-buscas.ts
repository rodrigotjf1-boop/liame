import { type Db, uuidv7, withTenant } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import { acessoGoogle, type CredencialGuardada } from '../connections/oauth.js';
import { ClienteConector, ErroConector, type TipoErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { BALDE_DO_SEARCH_CONSOLE, criarConectorSearchConsole } from '../connectors/search-console/conector-search-console.js';
import { FLAG_SEARCH_CONSOLE, PROVEDOR_SEARCH_CONSOLE } from '../connectors/search-console/search-console.js';
import type { FlagService } from '../flags/flag.service.js';
import { diaNoFuso } from '../results/fora-do-normal.js';
import type { VaultService } from '../vault/vault.service.js';
import { type ContaDoSite, gravarDias, gravarSemana } from './buscas-store.js';

// Leitura de um site do Search Console (A6, Z3; base de conhecimento §3.3). Dois conjuntos, cada um com o frescor e a
// fila dele em `sync_state`, os dois uma vez por dia:
//   - `buscas_dias`: os números do site por dia (o total, com as buscas raras). A primeira leitura traz 90 dias; as
//     seguintes releem os últimos 10 (o Google fecha os dias com 2 a 3 dias de atraso), ou desde o último lido, se a
//     leitura ficou parada mais que isso (até 90 dias).
//   - `buscas_semanas`: as buscas que mais trouxeram cliques em cada semana fechada (de segunda a domingo), até 100. A
//     primeira leitura traz 12 semanas; as seguintes releem as 2 últimas, ou desde a última lida (até 12).
// As datas são as do Search Console, no fuso do Pacífico, e só dia fechado é pedido. As chamadas ao Google ficam fora
// de transação; o que foi lido é gravado numa transação curta da empresa, junto com o cursor. Só lê para a empresa
// com a função `search_console` ligada. A cota é por site: no limite, a leitura para, guarda quando tentar de novo e
// não insiste. O limite não é defeito do site.

export const DATASET_DIAS = 'buscas_dias';
export const DATASET_SEMANAS = 'buscas_semanas';
export const DATASETS_DAS_BUSCAS = [DATASET_DIAS, DATASET_SEMANAS] as const;
export type DatasetDasBuscas = (typeof DATASETS_DAS_BUSCAS)[number];

/** De quanto em quanto tempo cada conjunto é lido, em minutos (uma vez por dia: o dado do Google é diário). */
export const INTERVALO_DAS_BUSCAS_MIN: Record<DatasetDasBuscas, number> = { buscas_dias: 1440, buscas_semanas: 1440 };
/** O fuso em que o Search Console conta os dias (base §3.3). */
export const FUSO_DO_SEARCH_CONSOLE = 'America/Los_Angeles';
export const DIAS_DA_PRIMEIRA_LEITURA = 90;
export const DIAS_RELIDOS = 10;
export const SEMANAS_DA_PRIMEIRA_LEITURA = 12;
export const SEMANAS_RELIDAS = 2;

const MIN_MS = 60_000;
const DIA_MS = 86_400_000;

type TipoFalha = TipoErroConector | 'interno';

export type CursorDasBuscas = {
  /** Quando o site volta para a fila (a reserva é por esta linha). */
  proxima?: string;
  /** Quando a primeira leitura terminou. */
  primeira_em?: string;
  /** Dias: o último dia pedido na leitura boa. Semanas: a segunda-feira da última semana lida. */
  lido_ate?: string;
  falhas_seguidas?: number;
  /** Depois de uma falha, o site só é lido de novo a partir daqui. */
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

export type ResultadoDasBuscas = {
  dataset: DatasetDasBuscas;
  status: 'ok' | 'falhou' | 'sem_permissao' | 'adiada' | 'ignorada' | 'desligada';
  /** Dias gravados, ou buscas gravadas (somadas as semanas). */
  gravados?: number;
  semanas?: number;
  erro?: string;
};

/** "2026-10-09" mais `n` dias (pode ser negativo), em data do calendário. */
export function somarDias(dia: string, n: number): string {
  return new Date(Date.parse(`${dia}T00:00:00Z`) + n * DIA_MS).toISOString().slice(0, 10);
}

/** Ontem e a segunda-feira desta semana, no fuso do Search Console. */
function referencias(agora: Date): { ontem: string; segunda: string } {
  const hoje = diaNoFuso(agora, FUSO_DO_SEARCH_CONSOLE);
  const diaDaSemana = new Date(`${hoje}T00:00:00Z`).getUTCDay(); // 0 = domingo
  return { ontem: somarDias(hoje, -1), segunda: somarDias(hoje, -((diaDaSemana + 6) % 7)) };
}

const ehData = (v: string | undefined): v is string => typeof v === 'string' && v.length === 10 && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

/**
 * A janela dos números por dia: até ontem, no fuso do Search Console. 90 dias na primeira leitura; depois, os últimos
 * 10, ou desde dois dias antes do último lido, se a leitura ficou parada mais que isso (nunca mais que 90 dias).
 */
export function janelaDosDias(cursor: CursorDasBuscas, agora: Date): { inicio: string; fim: string } {
  const { ontem } = referencias(agora);
  const maisAntigo = somarDias(ontem, -(DIAS_DA_PRIMEIRA_LEITURA - 1));
  if (!cursor.primeira_em || !ehData(cursor.lido_ate)) return { inicio: maisAntigo, fim: ontem };
  const desdeOUltimo = somarDias(cursor.lido_ate, -2);
  const releitura = somarDias(ontem, -(DIAS_RELIDOS - 1));
  const inicio = [desdeOUltimo < releitura ? desdeOUltimo : releitura, maisAntigo].sort()[1]!;
  return { inicio, fim: ontem };
}

/**
 * As semanas fechadas a ler (a segunda-feira de cada uma), da mais antiga à mais nova: 12 na primeira leitura; depois,
 * as 2 últimas, ou desde a semana antes da última lida, se a leitura ficou parada mais que isso (nunca mais que 12).
 */
export function semanasParaLer(cursor: CursorDasBuscas, agora: Date): string[] {
  const { segunda } = referencias(agora);
  const ultimaFechada = somarDias(segunda, -7);
  const maisAntiga = somarDias(segunda, -7 * SEMANAS_DA_PRIMEIRA_LEITURA);
  let inicio = maisAntiga;
  if (cursor.primeira_em && ehData(cursor.lido_ate)) {
    const desdeAUltima = somarDias(cursor.lido_ate, -7);
    const releitura = somarDias(segunda, -7 * SEMANAS_RELIDAS);
    inicio = [desdeAUltima < releitura ? desdeAUltima : releitura, maisAntiga].sort()[1]!;
  }
  const semanas: string[] = [];
  for (let s = inicio; s <= ultimaFechada; s = somarDias(s, 7)) semanas.push(s);
  return semanas;
}

/**
 * Quanto esperar depois de uma falha. Sem permissão, um dia. No limite, o que o Google pedir (no mínimo 15 minutos, a
 * janela da cota de carga, dobrando até 6 h). Erro definitivo ou nosso, 6 h no mínimo. O resto, 30 min dobrando até 12 h.
 */
export function esperaDaFalhaDasBuscas(e: { tipo: TipoFalha; esperarMs: number | null }, falhas: number): number {
  if (e.tipo === 'permissao') return DIA_MS;
  const vezes = 2 ** Math.max(0, falhas - 1);
  if (e.tipo === 'limite') return Math.max(e.esperarMs ?? 0, Math.min(15 * MIN_MS * vezes, 6 * 60 * MIN_MS));
  const dobrando = Math.min(30 * MIN_MS * vezes, 12 * 60 * MIN_MS);
  const base = e.esperarMs && e.esperarMs > 0 ? e.esperarMs : dobrando;
  return e.tipo === 'definitivo' || e.tipo === 'interno' ? Math.max(base, 6 * 60 * MIN_MS) : base;
}

/** O cursor depois de uma leitura boa: sem a espera nem o tipo da falha anterior. */
function semFalha(c: CursorDasBuscas): CursorDasBuscas {
  const { espera_ate: _espera, falha: _falha, ...resto } = c;
  return resto;
}

const MOTIVO_SEM_PERMISSAO = 'O Google recusou a leitura deste site no Search Console. Confira no Search Console se a conta que autorizou tem acesso ao site, e autorize o Google de novo.';
const MOTIVO_RECUSADA = 'O Google recusou a autorização deste site: conecte de novo.';
const MOTIVO_ERRO = 'A leitura do Search Console falhou; tentamos de novo mais tarde.';

export class SincronizadorDasBuscas {
  private readonly logger = new Logger('search-console');

  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly config: AppConfig,
    private readonly flags: FlagService,
  ) {}

  async sincronizar(contaId: string, tenantId: string, dataset: DatasetDasBuscas, agora: Date = new Date()): Promise<ResultadoDasBuscas> {
    const lida = await withTenant(this.db, tenantId, async (tx) => {
      const r = await tx.execute<LinhaConta & { cursor: CursorDasBuscas | null }>(sql`
        select a.id, a.tenant_id, a.brand_id, a.external_id, a.status, a.status_reason, a.credential_secret_id,
               (select s.cursor from liame.sync_state s where s.connected_account_id = a.id and s.dataset = ${dataset}) as cursor
          from liame.connected_account a
         where a.id = ${contaId} and a.provider = ${PROVEDOR_SEARCH_CONSOLE} and a.disconnected_at is null`);
      const conta = r.rows[0];
      if (!conta) return null;
      const segredo = conta.credential_secret_id ? await this.vault.readSecret(tx, conta.credential_secret_id) : null;
      return { conta, segredo, cursor: conta.cursor ?? {} };
    });
    if (!lida) return { dataset, status: 'ignorada' };
    const { conta } = lida;
    const cursor: CursorDasBuscas = lida.cursor;
    const depois = (minutos: number) => new Date(agora.getTime() + minutos * MIN_MS).toISOString();

    // A função desligada para a empresa: nada é lido. O site é olhado de novo no dia seguinte (a flag pode ser ligada).
    if (!(await this.flags.isEnabled(FLAG_SEARCH_CONSOLE, this.flags.context({ tenantId, brandId: conta.brand_id })))) {
      await this.marcarEstado(conta, dataset, agora, null, { ...cursor, proxima: depois(24 * 60) }, false);
      return { dataset, status: 'desligada' };
    }
    const credencial = lida.segredo ? (JSON.parse(lida.segredo) as CredencialGuardada) : null;
    if (credencial?.tipo !== 'google') {
      return this.desconectar(conta, dataset, cursor, new ErroConector('autenticacao', PROVEDOR_SEARCH_CONSOLE, 'autorização revogada ou ausente'), agora);
    }
    const espera = cursor.espera_ate ? Date.parse(cursor.espera_ate) : Number.NaN;
    if (espera > agora.getTime()) {
      // Esperando a vez depois de uma falha: a reserva só o trouxe porque a `proxima` venceu antes.
      await this.marcarEstado(conta, dataset, agora, null, { ...cursor, proxima: new Date(espera).toISOString() }, false);
      return { dataset, status: 'adiada' };
    }

    const cliente = new ClienteConector(this.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), balde: BALDE_DO_SEARCH_CONSOLE, tentativas: 1 });
    const inicial = semFalha(cursor);
    const primeira = !inicial.primeira_em;
    const alvo: ContaDoSite = { tenantId: conta.tenant_id, brandId: conta.brand_id, connectedAccountId: conta.id };
    const resultado: ResultadoDasBuscas = { dataset, status: 'ok' };
    let runId: string | null = null;
    try {
      const accessToken = await acessoGoogle(this.config, this.config.oauth.google?.tokenUrl ?? '', credencial.refresh_token);
      const conector = await criarConectorSearchConsole(this.db, cliente, this.config.plataformas);
      runId = await this.abrirExecucao(conta, dataset, primeira ? 'carga_inicial' : 'incremental', conector.versoes.buscas, agora);
      const proximo: CursorDasBuscas = { ...inicial, primeira_em: inicial.primeira_em ?? agora.toISOString(), proxima: depois(INTERVALO_DAS_BUSCAS_MIN[dataset]), falhas_seguidas: 0 };
      if (dataset === DATASET_DIAS) {
        const janela = janelaDosDias(inicial, agora);
        const dias = await conector.lerDias({ accessToken }, conta.external_id, janela);
        const gravado = await withTenant(this.db, conta.tenant_id, (tx) => gravarDias(tx, alvo, dias, agora));
        resultado.gravados = gravado.gravados;
        await this.marcarEstado(conta, dataset, agora, null, { ...proximo, lido_ate: janela.fim });
      } else {
        // Uma semana de cada vez: a que foi lida fica gravada mesmo se a seguinte falhar (o cursor anda junto).
        let gravadas = 0;
        let lidoAte = inicial.lido_ate;
        const semanas = semanasParaLer(inicial, agora);
        for (const semana of semanas) {
          const buscas = await conector.lerBuscas({ accessToken }, conta.external_id, { inicio: semana, fim: somarDias(semana, 6) });
          gravadas += (await withTenant(this.db, conta.tenant_id, (tx) => gravarSemana(tx, alvo, semana, buscas, agora))).gravadas;
          lidoAte = semana;
          await this.marcarEstado(conta, dataset, agora, null, { ...inicial, lido_ate: lidoAte }, false);
        }
        resultado.gravados = gravadas;
        resultado.semanas = semanas.length;
        await this.marcarEstado(conta, dataset, agora, null, { ...proximo, ...(lidoAte ? { lido_ate: lidoAte } : {}) });
      }
    } catch (err) {
      const e = err instanceof ErroConector ? err : null;
      const texto = e ? `${e.tipo}: ${e.message}`.slice(0, 500) : 'erro interno';
      // Token recusado: o site para até conectar de novo.
      if (e?.tipo === 'autenticacao') {
        if (runId) await this.fecharExecucao(conta, runId, 'falhou', cliente.chamadas, 0, texto, agora);
        return this.desconectar(conta, dataset, await this.cursorAtual(conta, dataset, inicial), e, agora);
      }
      if (!e) this.logger.error(`conta ${conta.id} (${dataset}): ${err instanceof Error ? err.message : String(err)}`);
      else this.logger.warn(`conta ${conta.id} (${dataset}): ${texto}`);
      const tipo: TipoFalha = e?.tipo ?? 'interno';
      // O cursor da falha parte do que já foi gravado nesta leitura (as semanas lidas antes da falha).
      const atual = await this.cursorAtual(conta, dataset, inicial);
      const falhas = (inicial.falhas_seguidas ?? 0) + 1;
      const quando = new Date(agora.getTime() + esperaDaFalhaDasBuscas({ tipo, esperarMs: e?.esperarMs ?? null }, falhas)).toISOString();
      await this.marcarEstado(conta, dataset, agora, texto, { ...atual, proxima: quando, espera_ate: quando, falha: tipo, falhas_seguidas: falhas });
      if (runId) await this.fecharExecucao(conta, runId, 'falhou', cliente.chamadas, 0, texto, agora);
      await this.situacaoPelosConjuntos(conta, agora);
      return { dataset, status: tipo === 'permissao' ? 'sem_permissao' : 'falhou', erro: texto };
    }
    await this.fecharExecucao(conta, runId, 'ok', cliente.chamadas, resultado.gravados ?? 0, null, agora);
    await this.situacaoPelosConjuntos(conta, agora);
    return resultado;
  }

  /** O cursor como está gravado agora (sem a espera da falha), ou o do começo da leitura. */
  private async cursorAtual(conta: LinhaConta, dataset: DatasetDasBuscas, inicial: CursorDasBuscas): Promise<CursorDasBuscas> {
    const gravado = await withTenant(this.db, conta.tenant_id, async (tx) => {
      const r = await tx.execute<{ cursor: CursorDasBuscas | null }>(sql`select cursor from liame.sync_state where connected_account_id = ${conta.id} and dataset = ${dataset}`);
      return r.rows[0]?.cursor ?? null;
    });
    return semFalha(gravado ?? inicial);
  }

  /**
   * A situação do site sai dos dois conjuntos juntos: a leitura boa de um não apaga o defeito do outro. Falta de
   * permissão pesa mais que erro; o limite e a falha passageira não mudam a situação.
   */
  private async situacaoPelosConjuntos(conta: LinhaConta, agora: Date): Promise<void> {
    const falhas = await withTenant(this.db, conta.tenant_id, async (tx) => {
      const r = await tx.execute<{ falha: string | null }>(sql`
        select s.cursor ->> 'falha' as falha from liame.sync_state s
         where s.connected_account_id = ${conta.id} and s.dataset in ${[...DATASETS_DAS_BUSCAS]}`);
      return r.rows.map((l) => l.falha);
    });
    if (falhas.includes('permissao')) await this.situacaoDaConta(conta, 'sem_permissao', MOTIVO_SEM_PERMISSAO, agora);
    else if (falhas.includes('definitivo') || falhas.includes('interno')) await this.situacaoDaConta(conta, 'erro', MOTIVO_ERRO, agora);
    else await this.situacaoDaConta(conta, 'ativa', null, agora);
  }

  private async abrirExecucao(conta: LinhaConta, dataset: DatasetDasBuscas, tipo: 'carga_inicial' | 'incremental', versao: string, agora: Date): Promise<string> {
    const id = uuidv7();
    await withTenant(this.db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        insert into liame.sync_run (id, tenant_id, connected_account_id, dataset, kind, api_version, started_at)
        values (${id}, ${conta.tenant_id}, ${conta.id}, ${dataset}, ${tipo}, ${versao}, ${agora.toISOString()}::timestamptz)`),
    );
    return id;
  }

  private async fecharExecucao(conta: LinhaConta, id: string | null, status: 'ok' | 'falhou', chamadas: number, gravados: number, erro: string | null, agora: Date) {
    if (!id) return;
    await withTenant(this.db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        update liame.sync_run set status = ${status}, calls = ${chamadas}, entities_written = ${gravados}, error = ${erro?.slice(0, 500) ?? null},
               finished_at = ${agora.toISOString()}::timestamptz
         where id = ${id}`),
    );
  }

  /**
   * O estado da leitura (o frescor e a fila): a leitura boa limpa o erro e grava o cursor; a falha guarda o motivo.
   * `tentativa: false` = o site só foi adiado (função desligada, espera depois de falha), ou é o passo do meio de uma
   * leitura de várias semanas: o frescor não muda. O instante é o de quem chama (V34).
   */
  private async marcarEstado(conta: LinhaConta, dataset: DatasetDasBuscas, agora: Date, erro: string | null, cursor: CursorDasBuscas, tentativa = true) {
    const sucesso = erro === null && tentativa;
    const quando = sql`${agora.toISOString()}::timestamptz`;
    await withTenant(this.db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at, last_attempt_at, last_error, cursor)
        values (${conta.id}, ${dataset}, ${conta.tenant_id}, ${INTERVALO_DAS_BUSCAS_MIN[dataset]}, ${sucesso ? quando : sql`null`}, ${quando}, ${erro}, ${JSON.stringify(cursor)}::jsonb)
        on conflict (connected_account_id, dataset) do update
           set expected_every_minutes = excluded.expected_every_minutes,
               last_success_at = case when ${sucesso}::boolean then ${quando} else liame.sync_state.last_success_at end,
               last_attempt_at = case when ${tentativa}::boolean then ${quando} else liame.sync_state.last_attempt_at end,
               last_error = case when ${tentativa}::boolean then excluded.last_error else liame.sync_state.last_error end,
               cursor = excluded.cursor,
               updated_at = ${quando}`),
    );
  }

  private async situacaoDaConta(conta: LinhaConta, status: 'ativa' | 'desconectada' | 'sem_permissao' | 'erro', motivo: string | null, agora: Date) {
    if (conta.status === status && conta.status_reason === motivo) return;
    await withTenant(this.db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        update liame.connected_account set status = ${status}, status_reason = ${motivo}, updated_at = ${agora.toISOString()}::timestamptz
         where id = ${conta.id} and disconnected_at is null`),
    );
  }

  /** Autorização recusada ou ausente: a leitura para até conectar de novo; o site espera 30 min dobrando (até 12 h). */
  private async desconectar(conta: LinhaConta, dataset: DatasetDasBuscas, cursor: CursorDasBuscas, err: ErroConector, agora: Date): Promise<ResultadoDasBuscas> {
    const texto = `${err.tipo}: ${err.message}`.slice(0, 500);
    this.logger.warn(`conta ${conta.id} (${dataset}): ${texto}`);
    const falhas = (cursor.falhas_seguidas ?? 0) + 1;
    const quando = new Date(agora.getTime() + esperaDaFalhaDasBuscas({ tipo: 'autenticacao', esperarMs: null }, falhas)).toISOString();
    await this.situacaoDaConta(conta, 'desconectada', MOTIVO_RECUSADA, agora);
    await this.marcarEstado(conta, dataset, agora, texto, { ...semFalha(cursor), proxima: quando, falhas_seguidas: falhas });
    return { dataset, status: 'falhou', erro: texto };
  }
}
