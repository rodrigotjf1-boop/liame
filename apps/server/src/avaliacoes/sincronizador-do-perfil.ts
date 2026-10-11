import { type Db, uuidv7, withTenant } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import { acessoGoogle, type CredencialGuardada } from '../connections/oauth.js';
import { ClienteConector, ErroConector, type TipoErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { BALDE_DO_PERFIL_GOOGLE, criarConectorPerfilGoogle } from '../connectors/google-business/conector-perfil-google.js';
import { FLAG_PERFIL_GOOGLE, PROVEDOR_PERFIL_GOOGLE } from '../connectors/google-business/perfil-google.js';
import type { FlagService } from '../flags/flag.service.js';
import type { VaultService } from '../vault/vault.service.js';
import { type AvaliacaoNova, type ContaDoPerfil, gravarAvaliacoes, gravarNumeros, gravarResumo } from './perfil-store.js';

// Leitura de uma loja do Perfil da Empresa no Google (A6, Z1; base de conhecimento §3.3). Dois conjuntos, cada um com
// o frescor e a fila dele em `sync_state`:
//   - `avaliacoes_perfil`: as avaliações, a cada hora. A primeira leitura traz os últimos 12 meses (é o que o Liame
//     guarda: D-A6-5); as seguintes, o que mudou desde a última, com uma hora de folga. Uma vez por dia, a leitura
//     reconfere os últimos 45 dias e, uma vez por semana, relê os 12 meses: é assim que a resposta dada direto no
//     Google chega ao Liame sem depender de o Google mudar a data da avaliação (`planoDaLeitura`).
//   - `numeros_perfil`: os números do perfil por dia, uma vez por dia. A primeira leitura traz 90 dias; as seguintes
//     releem os últimos 10, porque o Google fecha e revê os dias com atraso.
// As chamadas ao Google ficam fora de transação; o que foi lido é gravado numa transação curta da empresa, junto com
// o cursor. Só lê para a empresa com a função `perfil_google` ligada.
//
// A cota do Perfil é do app do Liame, uma só para todas as empresas (zero até o Google liberar o acesso): no limite, a
// leitura para, guarda quando tentar de novo e NÃO insiste (critério A6-2). O limite não é defeito da conta: ela não
// vira "erro".

export const DATASET_AVALIACOES = 'avaliacoes_perfil';
export const DATASET_NUMEROS = 'numeros_perfil';
export const DATASETS_DO_PERFIL = [DATASET_AVALIACOES, DATASET_NUMEROS] as const;
export type DatasetDoPerfil = (typeof DATASETS_DO_PERFIL)[number];

/** De quanto em quanto tempo cada conjunto é lido, em minutos. */
export const INTERVALO_DO_PERFIL_MIN: Record<DatasetDoPerfil, number> = { avaliacoes_perfil: 60, numeros_perfil: 1440 };
/** As avaliações que o Liame lê e guarda: as que mudaram nos últimos 12 meses (D-A6-5). */
export const DIAS_DE_AVALIACOES = 365;
/** A leitura seguinte das avaliações recua uma hora do começo da anterior: o que mudou durante ela não se perde. */
export const FOLGA_DAS_AVALIACOES_MIN = 60;
/** Quantas avaliações uma leitura traz no máximo: na primeira (12 meses) e nas seguintes (uma hora). */
export const MAXIMO_NA_PRIMEIRA_LEITURA = 3000;
export const MAXIMO_NAS_SEGUINTES = 500;
/**
 * A resposta dada direto no Google. A leitura de hora em hora segue a data de mudança da AVALIAÇÃO, e a referência do
 * Google não diz que responder mexe nessa data (a resposta tem a data dela). Para não depender disso, uma vez por dia
 * a leitura reconfere as avaliações dos últimos 45 dias (cobre os 30 dias do aviso da Atenção, com folga) e, uma vez
 * por semana, relê os 12 meses inteiros (acerta a contagem das sem resposta da tela).
 */
export const DIAS_RECONFERIDOS = 45;
export const HORAS_ENTRE_RECONFERENCIAS = 24;
export const DIAS_ENTRE_RELEITURAS = 7;
export const MAXIMO_NA_RECONFERENCIA = 1000;
export const DIAS_DA_PRIMEIRA_LEITURA_DOS_NUMEROS = 90;
export const DIAS_RELIDOS_DOS_NUMEROS = 10;

const MIN_MS = 60_000;
const DIA_MS = 86_400_000;

type TipoFalha = TipoErroConector | 'interno';

export type CursorDoPerfil = {
  /** Quando a conta volta para a fila (a reserva é por esta linha). */
  proxima?: string;
  /** Quando a primeira leitura terminou. */
  primeira_em?: string;
  /** Avaliações: o começo da última leitura boa (a seguinte parte daqui, menos a folga). */
  lido_ate?: string;
  /** Avaliações: a última leitura parou no teto antes de chegar ao corte. */
  parou_no_teto?: boolean;
  /** Avaliações: a última vez em que os últimos 45 dias foram reconferidos (a primeira leitura e a releitura também contam). */
  reconferido_em?: string;
  /** Avaliações: a última vez em que os 12 meses foram lidos inteiros (a primeira leitura conta). */
  relido_em?: string;
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
  provider_attributes: Record<string, unknown> | null;
};

export type ResultadoDoPerfil = {
  dataset: DatasetDoPerfil;
  status: 'ok' | 'falhou' | 'sem_permissao' | 'adiada' | 'ignorada' | 'desligada';
  /** Avaliações gravadas e, delas, as que são novas. */
  avaliacoes?: number;
  novas?: AvaliacaoNova[];
  /** Números do perfil gravados (um por dia e métrica). */
  pontos?: number;
  erro?: string;
};

/** O cursor depois de uma leitura boa: sem a espera nem o tipo da falha anterior. */
function semFalha(c: CursorDoPerfil): CursorDoPerfil {
  const { espera_ate: _espera, falha: _falha, ...resto } = c;
  return resto;
}

/**
 * Quanto esperar depois de uma falha. Sem permissão, um dia. No limite, o que o Google pedir (no mínimo meia hora: a
 * cota é de todas as empresas juntas). Erro definitivo ou nosso, 6 h no mínimo. O resto, 30 min dobrando até 12 h.
 */
export function esperaDaFalhaDoPerfil(e: { tipo: TipoFalha; esperarMs: number | null }, falhas: number): number {
  if (e.tipo === 'permissao') return DIA_MS;
  const dobrando = Math.min(30 * MIN_MS * 2 ** Math.max(0, falhas - 1), 12 * 60 * MIN_MS);
  if (e.tipo === 'limite') return Math.max(e.esperarMs ?? 0, dobrando);
  const base = e.esperarMs && e.esperarMs > 0 ? e.esperarMs : dobrando;
  return e.tipo === 'definitivo' || e.tipo === 'interno' ? Math.max(base, 6 * 60 * MIN_MS) : base;
}

/** Desde quando ler as avaliações: os últimos 12 meses na primeira leitura; depois, o começo da anterior menos a folga. */
export function desdeDasAvaliacoes(cursor: CursorDoPerfil, agora: Date): Date {
  const limite = agora.getTime() - DIAS_DE_AVALIACOES * DIA_MS;
  const anterior = cursor.primeira_em && cursor.lido_ate ? Date.parse(cursor.lido_ate) : Number.NaN;
  if (Number.isNaN(anterior)) return new Date(limite);
  return new Date(Math.max(limite, anterior - FOLGA_DAS_AVALIACOES_MIN * MIN_MS));
}

export type PlanoDaLeitura = {
  /** `primeira` e `releitura` leem os 12 meses; `reconferencia`, os últimos 45 dias; `seguinte`, só o que mudou desde a anterior. */
  tipo: 'primeira' | 'releitura' | 'reconferencia' | 'seguinte';
  desde: Date;
  maximo: number;
};

/** Passou `prazoMs` desde `marca`? Sem a marca, ou com uma que não é data, a leitura é devida. */
function venceu(marca: string | undefined, prazoMs: number, agora: Date): boolean {
  const quando = marca ? Date.parse(marca) : Number.NaN;
  return Number.isNaN(quando) || agora.getTime() - quando >= prazoMs;
}

/**
 * Qual leitura das avaliações fazer agora. A releitura semanal e a reconferência diária existem para a resposta dada
 * direto no Google chegar ao Liame mesmo que o Google não mude a data da avaliação. A falha não gasta a vez: as marcas
 * só andam na leitura boa.
 */
export function planoDaLeitura(cursor: CursorDoPerfil, agora: Date): PlanoDaLeitura {
  const dozeMeses = new Date(agora.getTime() - DIAS_DE_AVALIACOES * DIA_MS);
  if (!cursor.primeira_em) return { tipo: 'primeira', desde: dozeMeses, maximo: MAXIMO_NA_PRIMEIRA_LEITURA };
  const relido = cursor.relido_em ?? cursor.primeira_em;
  if (venceu(relido, DIAS_ENTRE_RELEITURAS * DIA_MS, agora)) return { tipo: 'releitura', desde: dozeMeses, maximo: MAXIMO_NA_PRIMEIRA_LEITURA };
  const seguinte = desdeDasAvaliacoes(cursor, agora);
  if (venceu(cursor.reconferido_em ?? relido, HORAS_ENTRE_RECONFERENCIAS * 60 * MIN_MS, agora)) {
    // Nunca mais curta que a leitura do dia a dia: se a rotina ficou parada mais de 45 dias, vale o corte mais antigo.
    const quarentaECinco = agora.getTime() - DIAS_RECONFERIDOS * DIA_MS;
    return { tipo: 'reconferencia', desde: new Date(Math.min(quarentaECinco, seguinte.getTime())), maximo: MAXIMO_NA_RECONFERENCIA };
  }
  return { tipo: 'seguinte', desde: seguinte, maximo: MAXIMO_NAS_SEGUINTES };
}

/** A janela dos números do perfil: até ontem (o Google só informa dia fechado); 90 dias na primeira, 10 depois. */
export function janelaDosNumeros(cursor: CursorDoPerfil, agora: Date): { inicio: string; fim: string } {
  const dia = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const ontem = agora.getTime() - DIA_MS;
  const dias = cursor.primeira_em ? DIAS_RELIDOS_DOS_NUMEROS : DIAS_DA_PRIMEIRA_LEITURA_DOS_NUMEROS;
  return { inicio: dia(ontem - (dias - 1) * DIA_MS), fim: dia(ontem) };
}

const MOTIVO_SEM_PERMISSAO = 'O Google recusou a leitura do perfil desta loja. Confira no Google se a conta que autorizou tem acesso ao perfil, e autorize o Google de novo.';
const MOTIVO_RECUSADA = 'O Google recusou a autorização desta loja: conecte de novo.';
const MOTIVO_ERRO = 'A leitura do perfil no Google falhou; tentamos de novo mais tarde.';

export class SincronizadorDoPerfil {
  private readonly logger = new Logger('perfil-google');

  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly config: AppConfig,
    private readonly flags: FlagService,
  ) {}

  async sincronizar(contaId: string, tenantId: string, dataset: DatasetDoPerfil, agora: Date = new Date()): Promise<ResultadoDoPerfil> {
    const lida = await withTenant(this.db, tenantId, async (tx) => {
      const r = await tx.execute<LinhaConta & { cursor: CursorDoPerfil | null }>(sql`
        select a.id, a.tenant_id, a.brand_id, a.external_id, a.status, a.status_reason, a.credential_secret_id, a.provider_attributes,
               (select s.cursor from liame.sync_state s where s.connected_account_id = a.id and s.dataset = ${dataset}) as cursor
          from liame.connected_account a
         where a.id = ${contaId} and a.provider = ${PROVEDOR_PERFIL_GOOGLE} and a.disconnected_at is null`);
      const conta = r.rows[0];
      if (!conta) return null;
      const segredo = conta.credential_secret_id ? await this.vault.readSecret(tx, conta.credential_secret_id) : null;
      return { conta, segredo, cursor: conta.cursor ?? {} };
    });
    if (!lida) return { dataset, status: 'ignorada' };
    const { conta } = lida;
    const cursor: CursorDoPerfil = lida.cursor;
    const depois = (minutos: number) => new Date(agora.getTime() + minutos * MIN_MS).toISOString();

    // A função desligada para a empresa: nada é lido. A conta é olhada de novo no dia seguinte (a flag pode ser ligada).
    if (!(await this.flags.isEnabled(FLAG_PERFIL_GOOGLE, this.flags.context({ tenantId, brandId: conta.brand_id })))) {
      await this.marcarEstado(conta, dataset, agora, null, { ...cursor, proxima: depois(24 * 60) }, false);
      return { dataset, status: 'desligada' };
    }

    const credencial = lida.segredo ? (JSON.parse(lida.segredo) as CredencialGuardada) : null;
    if (credencial?.tipo !== 'google') {
      return this.desconectar(conta, dataset, cursor, new ErroConector('autenticacao', PROVEDOR_PERFIL_GOOGLE, 'autorização revogada ou ausente'), agora);
    }
    // A loja só é ligada por uma autorização que já tem a permissão do Perfil; se o Google a tirar depois, ele recusa
    // a leitura, e a recusa cai no caminho da falha de permissão, abaixo.
    const contaDoPerfil = typeof conta.provider_attributes?.conta === 'string' ? conta.provider_attributes.conta : null;
    const espera = cursor.espera_ate ? Date.parse(cursor.espera_ate) : Number.NaN;
    if (espera > agora.getTime()) {
      // Esperando a vez depois de uma falha: a reserva só a trouxe porque a `proxima` venceu antes.
      await this.marcarEstado(conta, dataset, agora, null, { ...cursor, proxima: new Date(espera).toISOString() }, false);
      return { dataset, status: 'adiada' };
    }

    const cliente = new ClienteConector(this.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), balde: BALDE_DO_PERFIL_GOOGLE, tentativas: 1 });
    const inicial = semFalha(cursor);
    const primeira = !inicial.primeira_em;
    const alvo: ContaDoPerfil = { tenantId: conta.tenant_id, brandId: conta.brand_id, connectedAccountId: conta.id };
    const resultado: ResultadoDoPerfil = { dataset, status: 'ok' };
    let runId: string | null = null;
    try {
      const accessToken = await acessoGoogle(this.config, this.config.oauth.google?.tokenUrl ?? '', credencial.refresh_token);
      const conector = await criarConectorPerfilGoogle(this.db, cliente, this.config.plataformas);
      runId = await this.abrirExecucao(conta, dataset, primeira ? 'carga_inicial' : 'incremental', dataset === DATASET_AVALIACOES ? conector.versoes.avaliacoes : conector.versoes.numeros, agora);
      const proximo: CursorDoPerfil = { ...inicial, primeira_em: inicial.primeira_em ?? agora.toISOString(), proxima: depois(INTERVALO_DO_PERFIL_MIN[dataset]), falhas_seguidas: 0 };
      if (dataset === DATASET_AVALIACOES) {
        if (!contaDoPerfil) throw new ErroConector('definitivo', PROVEDOR_PERFIL_GOOGLE, 'a loja não tem a conta do Perfil guardada: ligue a loja de novo');
        const plano = planoDaLeitura(inicial, agora);
        const lidas = await conector.lerAvaliacoes({ accessToken }, { conta: contaDoPerfil, loja: conta.external_id }, { desde: plano.desde, maximo: plano.maximo });
        const gravado = await withTenant(this.db, conta.tenant_id, async (tx) => {
          const g = await gravarAvaliacoes(tx, alvo, lidas.avaliacoes, agora);
          await gravarResumo(tx, alvo, { media: lidas.media, total: lidas.total }, agora);
          return g;
        });
        resultado.avaliacoes = gravado.gravadas;
        resultado.novas = gravado.novas;
        // O teto só corta as mais antigas: a leitura seguinte parte de agora do mesmo jeito, e o corte fica anotado.
        // As marcas da reconferência e da releitura só andam aqui, na leitura boa: a falha não gasta a vez.
        const quando = agora.toISOString();
        const marcas: CursorDoPerfil = {
          ...(plano.tipo === 'seguinte' ? {} : { reconferido_em: quando }),
          ...(plano.tipo === 'primeira' || plano.tipo === 'releitura' ? { relido_em: quando } : {}),
        };
        await this.marcarEstado(conta, dataset, agora, null, { ...proximo, ...marcas, lido_ate: quando, parou_no_teto: !lidas.completa });
        if (!lidas.completa) this.logger.warn(`conta ${conta.id}: a leitura das avaliações (${plano.tipo}) parou no teto (${lidas.avaliacoes.length})`);
      } else {
        const pontos = await conector.lerNumeros({ accessToken }, { loja: conta.external_id }, janelaDosNumeros(inicial, agora));
        const gravado = await withTenant(this.db, conta.tenant_id, (tx) => gravarNumeros(tx, alvo, pontos, agora));
        resultado.pontos = gravado.gravados;
        await this.marcarEstado(conta, dataset, agora, null, proximo);
      }
    } catch (err) {
      const e = err instanceof ErroConector ? err : null;
      const texto = e ? `${e.tipo}: ${e.message}`.slice(0, 500) : 'erro interno';
      // Token recusado: a loja para até conectar de novo.
      if (e?.tipo === 'autenticacao') {
        if (runId) await this.fecharExecucao(conta, runId, 'falhou', cliente.chamadas, 0, texto, agora);
        return this.desconectar(conta, dataset, inicial, e, agora);
      }
      if (!e) this.logger.error(`conta ${conta.id} (${dataset}): ${err instanceof Error ? err.message : String(err)}`);
      else this.logger.warn(`conta ${conta.id} (${dataset}): ${texto}`);
      const tipo: TipoFalha = e?.tipo ?? 'interno';
      const falhas = (inicial.falhas_seguidas ?? 0) + 1;
      const quando = new Date(agora.getTime() + esperaDaFalhaDoPerfil({ tipo, esperarMs: e?.esperarMs ?? null }, falhas)).toISOString();
      await this.marcarEstado(conta, dataset, agora, texto, { ...inicial, proxima: quando, espera_ate: quando, falha: tipo, falhas_seguidas: falhas });
      if (runId) await this.fecharExecucao(conta, runId, 'falhou', cliente.chamadas, 0, texto, agora);
      await this.situacaoPelosConjuntos(conta, agora);
      return { dataset, status: tipo === 'permissao' ? 'sem_permissao' : 'falhou', erro: texto };
    }
    await this.fecharExecucao(conta, runId, 'ok', cliente.chamadas, (resultado.avaliacoes ?? 0) + (resultado.pontos ?? 0), null, agora);
    await this.situacaoPelosConjuntos(conta, agora);
    return resultado;
  }

  /**
   * A situação da loja sai dos dois conjuntos juntos, e não só do que acabou de rodar: senão a leitura boa de um
   * apagaria o defeito do outro, e a loja ficaria trocando de "erro" para "ativa" a cada volta. Falta de permissão
   * pesa mais que erro; o limite e a falha passageira não mudam a situação (passam sozinhos).
   */
  private async situacaoPelosConjuntos(conta: LinhaConta, agora: Date): Promise<void> {
    const falhas = await withTenant(this.db, conta.tenant_id, async (tx) => {
      const r = await tx.execute<{ falha: string | null }>(sql`
        select s.cursor ->> 'falha' as falha from liame.sync_state s
         where s.connected_account_id = ${conta.id} and s.dataset in ${[...DATASETS_DO_PERFIL]}`);
      return r.rows.map((l) => l.falha);
    });
    if (falhas.includes('permissao')) await this.situacaoDaConta(conta, 'sem_permissao', MOTIVO_SEM_PERMISSAO, agora);
    else if (falhas.includes('definitivo') || falhas.includes('interno')) await this.situacaoDaConta(conta, 'erro', MOTIVO_ERRO, agora);
    else await this.situacaoDaConta(conta, 'ativa', null, agora);
  }

  private async abrirExecucao(conta: LinhaConta, dataset: DatasetDoPerfil, tipo: 'carga_inicial' | 'incremental', versao: string, agora: Date): Promise<string> {
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
   * `tentativa: false` = a conta só foi adiada (função desligada, espera depois de falha): o frescor não muda. O
   * instante é o de quem chama (V34): a fila é reservada pelo mesmo relógio.
   */
  private async marcarEstado(conta: LinhaConta, dataset: DatasetDoPerfil, agora: Date, erro: string | null, cursor: CursorDoPerfil, tentativa = true) {
    const sucesso = erro === null && tentativa;
    const quando = sql`${agora.toISOString()}::timestamptz`;
    await withTenant(this.db, conta.tenant_id, (tx) =>
      tx.execute(sql`
        insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at, last_attempt_at, last_error, cursor)
        values (${conta.id}, ${dataset}, ${conta.tenant_id}, ${INTERVALO_DO_PERFIL_MIN[dataset]}, ${sucesso ? quando : sql`null`}, ${quando}, ${erro}, ${JSON.stringify(cursor)}::jsonb)
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

  /** Autorização recusada ou ausente: a leitura para até conectar de novo; a loja espera 30 min dobrando (até 12 h). */
  private async desconectar(conta: LinhaConta, dataset: DatasetDoPerfil, cursor: CursorDoPerfil, err: ErroConector, agora: Date): Promise<ResultadoDoPerfil> {
    const texto = `${err.tipo}: ${err.message}`.slice(0, 500);
    this.logger.warn(`conta ${conta.id} (${dataset}): ${texto}`);
    const falhas = (cursor.falhas_seguidas ?? 0) + 1;
    const quando = new Date(agora.getTime() + esperaDaFalhaDoPerfil({ tipo: 'autenticacao', esperarMs: null }, falhas)).toISOString();
    await this.situacaoDaConta(conta, 'desconectada', MOTIVO_RECUSADA, agora);
    await this.marcarEstado(conta, dataset, agora, texto, { ...semFalha(cursor), proxima: quando, falhas_seguidas: falhas });
    return { dataset, status: 'falhou', erro: texto };
  }
}
