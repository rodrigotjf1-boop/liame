import { type Database, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ActionService } from '../actions/action.service.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { CAMPANHAS_NO_RITMO, type EstadoDoRitmo, recursoDoRitmo } from '../campanhas/ritmo-plano.js';
import { contaConectada } from '../connections/conectada.js';
import { currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { GESTOR_DE_TRAFEGO } from '../equipe/membros.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { FLAG_DA_REGIAO } from '../regiao/regiao.js';
import { RegiaoService } from '../regiao/regiao.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// O ritmo da semana, a rotina do Gestor de tráfego (plano da região, R7, parte 1b; protótipo aprovado pelo dono em
// 13/11/2026, D-RG-58 e D-RG-62). Fica na pasta do worker porque escolhe as marcas em escopo de sistema (regra
// `liame-escopo-sistema`). No domingo, a partir das 16h no fuso da loja, monta o ritmo da semana que vem (segunda a
// domingo) de cada marca que pode e pede em Aprovações, pelo trilho de ações:
//   - só com as funções `regiao` e `ritmo_da_semana` ligadas, UMA loja no mapa e UMA conta de anúncios da Meta na marca;
//   - a montagem é a mesma da prévia (`RegiaoService.montarRitmo`): regra do código, sem IA;
//   - o pedido fica em nome do dono da empresa e espera a aprovação de uma pessoa, com o código do app;
//   - UMA proposta por marca e semana: se ela já existe (pedida, aprovada, recusada ou parada), não há outra.
// O pedido recusado, expirado ou que falhou deixa o ritmo cancelado. Nada é mudado na Meta aqui.
// Cada volta percorre TODAS as marcas da hora, em páginas pela chave: a marca que não pode ter ritmo agora (a função
// desligada, sem dono, sem campanha que caiba) não tem linha que a tire da lista, e por isso não pode segurar as que vêm
// depois dela. O lote limita só os PEDIDOS de uma volta; com o lote cheio, a volta seguinte continua de onde esta parou.

export const FLAG_DO_RITMO = 'ritmo_da_semana';
const ROTULO_DO_GESTOR = 'Gestor de tráfego';
/** O dia e a hora da proposta, no fuso da loja: domingo, a partir das 16h (a previsão já cobre quase toda a semana). */
export const DIA_DA_PROPOSTA = 0;
export const HORA_DA_PROPOSTA = 16;
/** Quantas marcas a volta lê do banco de cada vez. */
const PAGINA = 200;

export type ResultadoDoRitmo = { tenantId: string; brandId: string; situacao: 'pedido' | 'sem_ritmo' | 'nao_pediu'; motivo: string | null };

type Candidata = { tenant_id: string; brand_id: string; unit_id: string; conta: string };

@Injectable()
export class RitmoDaSemanaService {
  private readonly logger = new Logger('ritmo-da-semana');
  /** A última marca que a volta anterior olhou, quando ela parou com o lote cheio; nulo: a lista recomeça do início. */
  private depoisDe: string | null = null;

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly actions: ActionService,
    private readonly flags: FlagService,
    private readonly regiao: RegiaoService,
  ) {}

  /**
   * Uma volta: cancela os ritmos cujo pedido se encerrou sem aprovação e propõe o da semana que vem a quem é a hora.
   * `limite`: quantos pedidos a volta faz; as marcas que não recebem pedido não contam e não seguram as seguintes.
   */
  async executarLote(limite = 3, scope: JobScope = {}, agora: Date = new Date()): Promise<ResultadoDoRitmo[]> {
    const database = this.database;
    if (!database) return [];
    const referencia = sql`${agora.toISOString()}::timestamptz`;
    await withSystem(database.db, (tx) =>
      // O pedido que se encerrou em Aprovações sem aprovar (recusado, expirado ou que falhou): o ritmo fica cancelado.
      tx.execute(sql`
        update liame.budget_rhythm b set status = 'cancelado', version = b.version + 1, updated_at = now()
          from liame.action_request r
         where r.id = b.action_id and r.tenant_id = b.tenant_id and b.status = 'pedido' and r.status in ('cancelada', 'expirada', 'falhou')
           ${tenantFilter(scope, sql`b.tenant_id`)}`),
    );
    const resultados: ResultadoDoRitmo[] = [];
    let pedidos = 0;
    for (;;) {
      const depoisDe = this.depoisDe;
      // As marcas da hora: é domingo depois das 16h na loja, a marca tem UMA loja no mapa e UMA conta de anúncios da
      // Meta conectada com campanha ativa, e ainda não há ritmo dela para a semana que começa amanhã.
      const pagina = await withSystem(database.db, async (tx) =>
        (
          await tx.execute<Candidata>(sql`
            select b.tenant_id, b.id as brand_id, l.unit_id, m.conta
              from liame.brand b
              join lateral (
                select min(u.id::text)::uuid as unit_id, min(coalesce(u.timezone, 'America/Sao_Paulo')) as fuso, count(*) as lojas
                  from liame.unit u where u.brand_id = b.id and u.tenant_id = b.tenant_id and u.ibge_city_code is not null) l on l.lojas = 1
              join lateral (
                select min(a.id::text)::uuid as conta, count(*) as contas
                  from liame.connected_account a
                 where a.brand_id = b.id and a.tenant_id = b.tenant_id and a.provider = 'meta_ads' and ${contaConectada('a')}) m on m.contas = 1
             where b.archived_at is null ${tenantFilter(scope, sql`b.tenant_id`)}
               ${depoisDe ? sql`and b.id > ${depoisDe}::uuid` : sql``}
               and extract(dow from ${referencia} at time zone l.fuso) = ${DIA_DA_PROPOSTA}
               and extract(hour from ${referencia} at time zone l.fuso) >= ${HORA_DA_PROPOSTA}
               and exists (select 1 from liame.campaign c where c.connected_account_id = m.conta and c.tenant_id = b.tenant_id and c.status = 'ativa')
               and not exists (select 1 from liame.budget_rhythm r
                                where r.brand_id = b.id and r.week_start = (${referencia} at time zone l.fuso)::date + 1)
             order by b.id
             limit ${PAGINA}`)
        ).rows,
      );
      for (const c of pagina) {
        let resultado: ResultadoDoRitmo;
        try {
          resultado = await this.propor(database, c, agora);
        } catch (err) {
          // Uma marca que falha não para as outras; o motivo vai ao log e a volta seguinte tenta de novo.
          const motivo = err instanceof AppProblem ? `${err.code}: ${err.detail}` : err instanceof Error ? err.message : String(err);
          this.logger.warn(`o ritmo da semana da marca ${c.brand_id} não foi pedido: ${motivo}`);
          resultado = { tenantId: c.tenant_id, brandId: c.brand_id, situacao: 'nao_pediu', motivo: motivo.slice(0, 300) };
        }
        resultados.push(resultado);
        this.depoisDe = c.brand_id;
        // O lote encheu: a volta seguinte continua depois desta marca.
        if (resultado.situacao === 'pedido' && ++pedidos >= limite) return resultados;
      }
      if (pagina.length < PAGINA) {
        // A lista acabou: a volta seguinte recomeça do início (quem ficou sem ritmo é olhado de novo).
        this.depoisDe = null;
        return resultados;
      }
    }
  }

  /** O ritmo de uma marca: monta, guarda e pede em Aprovações, tudo na transação da empresa (o que falhar desfaz tudo). */
  private async propor(database: Database, c: Candidata, agora: Date): Promise<ResultadoDoRitmo> {
    const base = { tenantId: c.tenant_id, brandId: c.brand_id };
    const contexto = this.flags.context({ tenantId: c.tenant_id, brandId: c.brand_id });
    if (!(await this.flags.isEnabled(FLAG_DA_REGIAO, contexto)) || !(await this.flags.isEnabled(FLAG_DO_RITMO, contexto))) {
      return { ...base, situacao: 'sem_ritmo', motivo: 'funcao_desligada' };
    }
    return naTransacaoDaEmpresa(database, { tenantId: c.tenant_id, userId: null }, async () => {
      const tx = currentTx();
      const dono = (await tx.execute<{ user_id: string }>(sql`select user_id from liame.membership where tenant_id = ${c.tenant_id} and role_key = 'dono' and revoked_at is null limit 1`)).rows[0];
      if (!dono) return { ...base, situacao: 'sem_ritmo' as const, motivo: 'sem_dono' };
      const montado = await this.regiao.montarRitmo(c.tenant_id, c.brand_id, c.unit_id, agora, true);
      const r = montado.resposta;
      // Só as campanhas da conta de anúncios do pedido (a marca tem uma só conectada; a conferência fica para a leitura).
      const campanhas = r.campaigns.filter((x) => montado.recursos[x.id]?.conta === c.conta).slice(0, CAMPANHAS_NO_RITMO);
      if (r.status !== 'pronto' || !r.week || !r.source || !montado.loja || !campanhas.length) {
        return { ...base, situacao: 'sem_ritmo' as const, motivo: r.status === 'pronto' ? 'sem_campanhas' : r.status };
      }
      const id = uuidv7();
      const estado: EstadoDoRitmo = {
        ritmo: id,
        marca: c.brand_id,
        loja: { id: c.unit_id, nome: montado.loja.nome },
        semana: { de: r.week.from, ate: r.week.to },
        fonte: r.source === 'loja' ? 'loja' : 'setor',
        dias: r.days.map((d) => ({ dia: d.day, dia_da_semana: d.weekday, peso: d.weight, porques: d.reasons.map((p) => ({ ...p, kind: p.kind as 'pedidos' | 'setor' | 'chuva' | 'data' })) })),
        campanhas: campanhas.map((x) => ({ recurso: montado.recursos[x.id]!.recurso, nome: x.name, base_micros: x.base_micros, dias_micros: x.days_micros })),
        fora: r.out.map((o) => ({ nome: o.name, motivo: o.reason })),
        teto_micros: montado.teto,
        moeda: 'BRL',
        situacao: 'pedido',
      };
      // O plano guardado é o estado sem a situação (ela mora na coluna e muda com a aprovação, a parada e o fim).
      const { situacao: _situacao, ...plano } = estado;
      const guardado = await tx.execute(sql`
        insert into liame.budget_rhythm (id, tenant_id, brand_id, unit_id, ad_account_id, week_start, week_end, source, plan)
        values (${id}, ${c.tenant_id}, ${c.brand_id}, ${c.unit_id}, ${c.conta}, ${r.week.from}::date, ${r.week.to}::date, ${estado.fonte}, ${JSON.stringify(plano)}::jsonb)
        on conflict do nothing
        returning id`);
      // Outra volta chegou antes (o índice de um ritmo em aberto por marca e semana): esta não pede de novo.
      if (!guardado.rows[0]) return { ...base, situacao: 'sem_ritmo' as const, motivo: 'ja_pedido' };
      const pedido = await this.actions.pedirRitmoPeloFuncionario(
        { tenantId: c.tenant_id, agentKey: GESTOR_DE_TRAFEGO, agentLabel: ROTULO_DO_GESTOR, emNomeDe: dono.user_id },
        { tool: 'ritmo_da_semana', brand_id: c.brand_id, provider: 'meta_ads', account_id: c.conta, resource_id: recursoDoRitmo(id), params: {} },
      );
      await tx.execute(sql`update liame.budget_rhythm set action_id = ${pedido}, updated_at = now() where id = ${id}`);
      return { ...base, situacao: 'pedido' as const, motivo: null };
    });
  }
}
