import { type Database, uuidv7, withSystem, withTenant } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { avisosDoRitmoDasMarcas } from '../campanhas/ritmo-avisos.js';
import { avisosParaGuardar } from '../campanhas/ritmo-conferido.js';
import { DIAS_DA_VOLTA } from '../campanhas/ritmo-passos.js';
import { DATABASE } from '../database/database.module.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// A conferência do ritmo da semana (plano da região, R7; D-RG-75, "antes de ligar além do piloto"). Fica na pasta do
// worker porque procura o que conferir em todas as empresas, em escopo de sistema. Depois da leitura da manhã da conta de
// anúncios de cada ritmo que ainda pode avisar (a semana corrente e os 35 dias da volta), calcula os avisos da marca (as
// contas puras de `campanhas/ritmo-avisos.ts`, as mesmas de antes) e grava a linha do dia em `budget_rhythm_check`; a
// Atenção só lê a gravada (`campanhas/ritmo-conferido.ts`). A linha do dia é refeita quando uma entrada muda depois de
// calculada: o ritmo, um passo, uma leitura nova da conta (o gasto) ou a verba lida das campanhas e dos conjuntos. Nada é
// escrito em plataforma nenhuma.

const FUSO_PADRAO = 'America/Sao_Paulo';

type Pendente = { id: string; tenant_id: string; brand_id: string; hoje: string };
export type RitmoConferido = { tenantId: string; marca: string; ritmo: string; dia: string; avisos: number };

@Injectable()
export class ConferenciaDoRitmo {
  private readonly logger = new Logger('conferencia-do-ritmo');

  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  /**
   * Um lote: até `limite` ritmos por conferir agora, nas contas já lidas hoje. Repetir não duplica (uma linha por ritmo e
   * dia, refeita só com entrada nova), então várias instâncias do worker podem rodar juntas. O instante é o do banco, lido
   * antes de tudo: o que mudar depois dele refaz a linha na volta seguinte.
   */
  async executarLote(limite = 50, scope: JobScope = {}, agora?: Date): Promise<RitmoConferido[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const instante = agora
      ? agora.toISOString()
      : (await withSystem(db, (tx) => tx.execute<{ agora: string }>(sql`select clock_timestamp()::text as agora`))).rows[0]!.agora;
    const pendentes = await withSystem(db, (tx) =>
      tx.execute<Pendente>(sql`
        select b.id, b.tenant_id, b.brand_id, x.hoje::text as hoje
          from liame.budget_rhythm b
          join liame.unit u on u.id = b.unit_id and u.tenant_id = b.tenant_id
          join liame.sync_state s on s.connected_account_id = b.ad_account_id and s.dataset = 'metricas'
          cross join lateral (select (${instante}::timestamptz at time zone coalesce(u.timezone, ${FUSO_PADRAO}))::date as hoje) x
         where b.status in ('aprovado', 'parado', 'encerrado')
           and b.week_start <= x.hoje and b.week_end >= x.hoje - ${DIAS_DA_VOLTA}::int
           -- Só com a leitura de hoje da conta: ela traz o gasto da véspera e a verba de agora.
           and (s.last_success_at at time zone coalesce(u.timezone, ${FUSO_PADRAO}))::date = x.hoje
           ${tenantFilter(scope, sql`b.tenant_id`)}
           -- Fora: a linha de hoje calculada depois da última entrada, e a que falhou há menos de uma hora (ela fica fora
           -- e não volta na frente de quem nunca foi conferido a cada rodada; V84).
           and not exists (
             select 1 from liame.budget_rhythm_check k
              where k.rhythm_id = b.id and k.checked_on = x.hoje
                and ((k.error is null and k.computed_at >= greatest(
                        b.updated_at,
                        s.last_success_at,
                        (select max(st.updated_at) from liame.budget_rhythm_step st where st.rhythm_id = b.id),
                        (select max(c.last_seen_at) from liame.campaign c where c.connected_account_id = b.ad_account_id),
                        (select max(g.last_seen_at) from liame.ad_group g where g.connected_account_id = b.ad_account_id)))
                     or (k.error is not null and k.computed_at >= ${instante}::timestamptz - interval '1 hour')))
         -- Quem ainda não tem a linha de hoje primeiro; depois, a conferida há mais tempo.
         order by (select k.computed_at from liame.budget_rhythm_check k where k.rhythm_id = b.id and k.checked_on = x.hoje) nulls first,
                  b.tenant_id, b.brand_id, b.id
         limit ${limite}`),
    );

    // Uma transação por marca (as contas da marca juntas, como antes): o erro de uma não deixa as outras sem a linha.
    const porMarca = new Map<string, Pendente[]>();
    for (const p of pendentes.rows) porMarca.set(`${p.tenant_id}|${p.brand_id}`, [...(porMarca.get(`${p.tenant_id}|${p.brand_id}`) ?? []), p]);
    const resultado: RitmoConferido[] = [];
    for (const lista of porMarca.values()) {
      const { tenant_id: tenantId, brand_id: marca } = lista[0]!;
      try {
        resultado.push(
          ...(await withTenant(db, tenantId, async (tx) => {
            const avisos = await this.calcular(tx, [marca], instante);
            const linhas = lista.map((p) => {
              const doRitmo = avisos.filter((a) => a.aviso.ritmo === p.id);
              return { id: uuidv7(), rhythm_id: p.id, checked_on: p.hoje, warnings: avisosParaGuardar(doRitmo, p.hoje), n: doRitmo.length };
            });
            await tx.execute(sql`
              insert into liame.budget_rhythm_check (id, tenant_id, rhythm_id, brand_id, checked_on, warnings, computed_at, error)
              select x.id, ${tenantId}, x.rhythm_id, ${marca}, x.checked_on, x.warnings, ${instante}::timestamptz, null
                from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) as x (id uuid, rhythm_id uuid, checked_on date, warnings jsonb)
              on conflict (rhythm_id, checked_on) do update set warnings = excluded.warnings, computed_at = excluded.computed_at, error = null`);
            return linhas.map((l): RitmoConferido => ({ tenantId, marca, ritmo: l.rhythm_id, dia: l.checked_on, avisos: l.n }));
          })),
        );
      } catch (err) {
        // A causa no log; a linha de hoje guarda a tentativa com os avisos da conferência de antes (o aviso de dinheiro não
        // some), e o ritmo volta depois de uma hora, atrás de quem espera (LIC-001; V84).
        const motivo = err instanceof Error ? err.message : String(err);
        this.logger.error(`marca ${marca}: ${motivo}`);
        await this.marcarFalha(tenantId, marca, lista, instante, motivo).catch((e: unknown) => this.logger.error(`marca ${marca}: não deu para marcar a falha (${e instanceof Error ? e.message : String(e)})`));
      }
    }
    const comAviso = resultado.filter((r) => r.avisos > 0);
    if (comAviso.length) this.logger.log(`${resultado.length} ritmo(s) conferido(s), ${comAviso.length} com aviso`);
    return resultado;
  }

  /** A conta dos avisos de uma marca (as contas puras de `campanhas/ritmo-avisos.ts`); nos testes, uma que falha. */
  calcular: typeof avisosDoRitmoDasMarcas = avisosDoRitmoDasMarcas;

  /** A tentativa que falhou: a linha de hoje com o erro, e os avisos da conferência mais nova de antes (ou nenhum). */
  private async marcarFalha(tenantId: string, marca: string, lista: readonly Pendente[], instante: string, motivo: string): Promise<void> {
    if (!this.database) return;
    const linhas = lista.map((p) => ({ id: uuidv7(), rhythm_id: p.id, checked_on: p.hoje }));
    await withTenant(this.database.db, tenantId, (tx) =>
      tx.execute(sql`
        insert into liame.budget_rhythm_check (id, tenant_id, rhythm_id, brand_id, checked_on, warnings, computed_at, error)
        select x.id, ${tenantId}, x.rhythm_id, ${marca}, x.checked_on,
               coalesce((select k.warnings from liame.budget_rhythm_check k where k.rhythm_id = x.rhythm_id order by k.checked_on desc limit 1), '[]'::jsonb),
               ${instante}::timestamptz, ${motivo.slice(0, 500)}
          from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb) as x (id uuid, rhythm_id uuid, checked_on date)
        on conflict (rhythm_id, checked_on) do update set computed_at = excluded.computed_at, error = excluded.error`),
    );
  }
}
