import { type Database, type Tx, uuidv7, withSystem, withTenant } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { conferir, DIAS_CONFERINDO, type EstadoConferido, type ResultadoDaConferencia, type SituacaoDoObjeto, situacaoDaLeitura, verbaDaLeitura } from '../actions/conferencia-do-gasto.js';
import { CONNECTORS } from '../actions/connectors.js';
import { objetoDoRecurso, type TipoDeObjeto } from '../actions/meta-anuncios.js';
import { DATABASE } from '../database/database.module.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// A conferência diária do gasto (A4, X4 parte 2; D-A4-24 e critério A4-8). Fica na pasta do worker porque procura o que
// conferir em todas as empresas, em escopo de sistema (regra `liame-escopo-sistema`). Depois da leitura da manhã de uma
// conta de anúncio, cada mudança que o Liame executou nela e que continua valendo (a mais recente de cada objeto, nos
// últimos 35 dias, executada antes de hoje) ganha a linha do dia em `action_spend_check`: execução → informado → gasto
// real. A conta é pura (`actions/conferencia-do-gasto.ts`); aqui, a leitura e a gravação, por conta, sob a RLS da
// empresa. Nada é escrito em plataforma nenhuma, e nada é desfeito: a conferência só registra e avisa.

const FUSO_PADRAO = 'America/Sao_Paulo';
/** Os provedores que gastam dinheiro de mídia de verdade: só neles há o que conferir. */
const PROVEDORES = Object.values(CONNECTORS)
  .filter((c) => c.requiresSpendLimits)
  .map((c) => c.provider);
const TABELA: Record<TipoDeObjeto, SQL> = { campanha: sql`liame.campaign`, conjunto: sql`liame.ad_group`, anuncio: sql`liame.ad` };

type Pendente = {
  id: string;
  tenant_id: string;
  conta: string;
  fuso: string;
  resource_id: string;
  before_state: Record<string, unknown> | null;
  desired_state: Record<string, unknown>;
  /** O dia da execução e o dia de hoje, no fuso da conta. */
  dia: string;
  hoje: string;
};

export type ContaConferida = { tenantId: string; contaId: string; dia: string; conferidas: number; mudou: number; acima: number };

/** A situação e a verba de um estado guardado no pedido (o que o conector leu ou o que a ação pediu). */
const estadoDoPedido = (estado: Record<string, unknown> | null): EstadoConferido => ({
  status: typeof estado?.status === 'string' ? estado.status : 'desconhecido',
  verbaDiaria: typeof estado?.daily_budget_micros === 'number' ? verbaDaLeitura(estado.daily_budget_micros) : null,
});

@Injectable()
export class ConferenciaDoGasto {
  private readonly logger = new Logger('conferencia-do-gasto');

  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  /**
   * Um lote: até `limite` mudanças por conferir hoje, nas contas de anúncio já lidas hoje. Repetir não duplica (uma
   * linha por mudança e por dia), então várias instâncias do worker podem rodar juntas. O relógio injetado vale para a
   * operação inteira (V34).
   */
  async executarLote(limite = 100, scope: JobScope = {}, agora?: Date): Promise<ContaConferida[]> {
    if (!this.database || !PROVEDORES.length) return [];
    const db = this.database.db;
    const referencia = agora ? sql`${agora.toISOString()}::timestamptz` : sql`now()`;
    const hojeDa = (fuso: SQL) => sql`(${referencia} at time zone ${fuso})::date`;
    const pendentes = await withSystem(db, (tx) =>
      tx.execute<Pendente>(sql`
        with lidas as (
          select a.id, a.tenant_id, a.provider, coalesce(a.timezone, ${FUSO_PADRAO}) as fuso
            from liame.connected_account a
            join liame.sync_state s on s.connected_account_id = a.id and s.dataset = 'metricas'
           where a.disconnected_at is null and a.provider in ${PROVEDORES} ${tenantFilter(scope, sql`a.tenant_id`)}
             -- Só com a leitura de hoje: ela traz a véspera inteira e a situação de agora.
             and (s.last_success_at at time zone coalesce(a.timezone, ${FUSO_PADRAO}))::date = ${hojeDa(sql`coalesce(a.timezone, ${FUSO_PADRAO})`)}
        ),
        vigentes as (
          -- A mudança que vale em cada objeto: a executada mais recente. A que achou o objeto já como queria não mudou nada.
          select distinct on (r.tenant_id, r.account_id, r.resource_id)
                 r.id, r.tenant_id, l.id as conta, l.fuso, r.resource_id, r.before_state, r.desired_state, r.updated_at
            from liame.action_request r
            join lidas l on l.tenant_id = r.tenant_id and l.id::text = r.account_id and l.provider = r.provider
           where r.status = 'executada' and r.updated_at >= ${referencia} - make_interval(days => ${DIAS_CONFERINDO + 1})
             and r.resource_id ~ '^(campanha|conjunto|anuncio):[0-9]{1,25}$'
             and exists (select 1 from liame.action_execution x
                          where x.action_request_id = r.id and x.status = 'executada'
                            and coalesce((x.result_state->>'sem_escrita')::boolean, false) = false)
           order by r.tenant_id, r.account_id, r.resource_id, r.updated_at desc, r.id desc
        )
        select v.id, v.tenant_id, v.conta, v.fuso, v.resource_id, v.before_state, v.desired_state,
               (v.updated_at at time zone v.fuso)::date::text as dia, ${hojeDa(sql`v.fuso`)}::text as hoje
          from vigentes v
         -- Executada antes de hoje (o gasto de hoje só é lido amanhã) e ainda dentro do prazo de conferência.
         where (v.updated_at at time zone v.fuso)::date < ${hojeDa(sql`v.fuso`)}
           and (v.updated_at at time zone v.fuso)::date >= ${hojeDa(sql`v.fuso`)} - ${DIAS_CONFERINDO}::int
           -- Pelo Liame, o objeto só fica ativo ou pausado. Outro estado desejado não se confere, e não pode ficar
           -- voltando a cada rodada no lugar de quem espera a vez.
           and v.desired_state->>'status' in ('ativo', 'pausado')
           and not exists (select 1 from liame.action_spend_check k where k.action_request_id = v.id and k.checked_on = ${hojeDa(sql`v.fuso`)})
         order by v.tenant_id, v.conta, v.id
         limit ${limite}`),
    );

    const porConta = new Map<string, Pendente[]>();
    for (const p of pendentes.rows) porConta.set(p.conta, [...(porConta.get(p.conta) ?? []), p]);
    const resultados: ContaConferida[] = [];
    for (const lista of porConta.values()) {
      const { tenant_id: tenantId, conta } = lista[0]!;
      try {
        resultados.push(await withTenant(db, tenantId, (tx) => this.conferirConta(tx, lista)));
      } catch (err) {
        // Falha numa conta não para as outras; ela volta na próxima rodada (LIC-001).
        this.logger.error(`conta ${conta}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return resultados;
  }

  /** Confere as mudanças de uma conta, num dia: lê a situação de hoje e o gasto de cada objeto e grava as linhas. */
  private async conferirConta(tx: Tx, lista: Pendente[]): Promise<ContaConferida> {
    const { tenant_id: tenantId, conta, fuso, hoje } = lista[0]!;
    const alvos = lista.flatMap((p) => {
      const objeto = objetoDoRecurso(p.resource_id);
      const pedido = estadoDoPedido(p.desired_state);
      // Pelo Liame, um objeto de anúncio só fica ativo ou pausado: outro estado desejado não é mudança que se confira.
      const status: SituacaoDoObjeto | null = pedido.status === 'ativo' ? 'ativo' : pedido.status === 'pausado' ? 'pausado' : null;
      return objeto && status ? [{ p, objeto, chave: `${objeto.tipo}:${objeto.externalId}`, depois: { status, verbaDiaria: pedido.verbaDiaria } }] : [];
    });
    const idsDe = (tipo: TipoDeObjeto) => [...new Set(alvos.filter((a) => a.objeto.tipo === tipo).map((a) => a.objeto.externalId))];
    const ids: Record<TipoDeObjeto, string[]> = { campanha: idsDe('campanha'), conjunto: idsDe('conjunto'), anuncio: idsDe('anuncio') };

    // 1. Informado: como a leitura de hoje mostra cada objeto. O que não veio na leitura de hoje saiu da lista da conta.
    const informados = new Map<string, EstadoConferido>();
    for (const tipo of ['campanha', 'conjunto', 'anuncio'] as const) {
      if (!ids[tipo].length) continue;
      const verba = tipo === 'anuncio' ? sql`null::text` : sql`daily_budget_micros::text`;
      const r = await tx.execute<{ external_id: string; status: string; verba: string | null; visto: string }>(sql`
        select external_id, status, ${verba} as verba, (last_seen_at at time zone ${fuso})::date::text as visto
          from ${TABELA[tipo]} where connected_account_id = ${conta} and external_id in ${ids[tipo]}`);
      for (const l of r.rows) {
        if (l.visto >= hoje) informados.set(`${tipo}:${l.external_id}`, { status: situacaoDaLeitura(l.status), verbaDiaria: verbaDaLeitura(l.verba) });
      }
    }

    // 2. Gasto real: o gasto de cada anúncio por dia, somado no objeto de cada mudança (campanha, conjunto ou anúncio).
    const series = new Map<string, Map<string, bigint>>();
    const dosObjetos = [
      ...(ids.campanha.length ? [sql`c.external_id in ${ids.campanha}`] : []),
      ...(ids.conjunto.length ? [sql`g.external_id in ${ids.conjunto}`] : []),
      ...(ids.anuncio.length ? [sql`ad.external_id in ${ids.anuncio}`] : []),
    ];
    if (dosObjetos.length) {
      const gastos = await tx.execute<{ campanha: string; conjunto: string; anuncio: string; dia: string; micros: string }>(sql`
        select c.external_id as campanha, g.external_id as conjunto, ad.external_id as anuncio, l.metric_date::text as dia,
               round(sum(l.metric_value) * 1000000)::bigint::text as micros
          from liame.metric_latest l
          join liame.ad ad on ad.id = l.entity_id
          join liame.ad_group g on g.id = ad.ad_group_id
          join liame.campaign c on c.id = g.campaign_id
         where l.connected_account_id = ${conta} and l.level = 'ad' and l.metric_name = 'spend' and l.attribution_window = ''
           and l.metric_date >= ${hoje}::date - ${DIAS_CONFERINDO + 1}::int and l.metric_date < ${hoje}::date
           and (${sql.join(dosObjetos, sql` or `)})
         group by 1, 2, 3, 4`);
      const somar = (chave: string, dia: string, micros: bigint) => {
        const serie = series.get(chave) ?? new Map<string, bigint>();
        serie.set(dia, (serie.get(dia) ?? 0n) + micros);
        series.set(chave, serie);
      };
      for (const g of gastos.rows) {
        const micros = BigInt(g.micros);
        somar(`campanha:${g.campanha}`, g.dia, micros);
        somar(`conjunto:${g.conjunto}`, g.dia, micros);
        somar(`anuncio:${g.anuncio}`, g.dia, micros);
      }
    }

    // 3. A conferência de cada mudança e a linha do dia.
    const contagem: Record<ResultadoDaConferencia, number> = { confere: 0, mudou: 0, acima: 0 };
    const linhas = alvos.map(({ p, chave, depois }) => {
      const informado = informados.get(chave) ?? null;
      const c = conferir({ executadaEm: p.dia, antes: estadoDoPedido(p.before_state), depois }, { hoje, informado, gastoPorDia: series.get(chave) ?? new Map() });
      contagem[c.status] += 1;
      return {
        id: uuidv7(),
        action_request_id: p.id,
        expected_status: depois.status,
        expected_daily_micros: depois.verbaDiaria?.toString() ?? null,
        informed_status: informado?.status ?? null,
        informed_daily_micros: informado?.verbaDiaria?.toString() ?? null,
        window_from: c.janela.de,
        window_to: c.janela.ate,
        spend_micros: c.gasto.toString(),
        allowed_micros: c.permitido?.toString() ?? null,
        days_after: c.diasDepois,
        spend_after_micros: c.gastoDepois.toString(),
        status: c.status,
      };
    });
    if (linhas.length) {
      await tx.execute(sql`
        insert into liame.action_spend_check (id, tenant_id, action_request_id, connected_account_id, checked_on, expected_status, expected_daily_micros,
                                              informed_status, informed_daily_micros, window_from, window_to, spend_micros, allowed_micros,
                                              days_after, spend_after_micros, status)
        select x.id, ${tenantId}, x.action_request_id, ${conta}, ${hoje}::date, x.expected_status, x.expected_daily_micros,
               x.informed_status, x.informed_daily_micros, x.window_from, x.window_to, x.spend_micros, x.allowed_micros,
               x.days_after, x.spend_after_micros, x.status
          from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) as x (
            id uuid, action_request_id uuid, expected_status text, expected_daily_micros bigint, informed_status text, informed_daily_micros bigint,
            window_from date, window_to date, spend_micros bigint, allowed_micros bigint, days_after integer, spend_after_micros bigint, status text)
        on conflict (action_request_id, checked_on) do nothing`);
    }
    if (contagem.mudou || contagem.acima) this.logger.log(`conta ${conta}: ${linhas.length} mudança(s) conferida(s), ${contagem.mudou} mudada(s) na plataforma, ${contagem.acima} com gasto acima`);
    return { tenantId, contaId: conta, dia: hoje, conferidas: linhas.length, mudou: contagem.mudou, acima: contagem.acima };
  }
}
