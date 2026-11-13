import { type Database, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ActionService } from '../actions/action.service.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { controleDoRitmo, decidirPasso, DIAS_DA_VOLTA, type PassoDecidido } from '../campanhas/ritmo-passos.js';
import { CAMPANHAS_NO_RITMO, EstadoDoRitmo, FERRAMENTA_DO_PASSO, FERRAMENTA_DO_RITMO, FLAG_DO_RITMO, FORA_DO_RITMO, recursoDoRitmo } from '../campanhas/ritmo-plano.js';
import { contaConectada } from '../connections/conectada.js';
import { currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { GESTOR_DE_TRAFEGO } from '../equipe/membros.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { carregarPoliticas } from '../policy/policy.service.js';
import { tetoDaVerba } from '../policy/teto-da-verba.js';
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
//
// Os passos do dia (parte 1b-2; D-RG-62 e D-RG-63), em `executarPassos`: com o ritmo aprovado, a verba de cada campanha
// passa à do dia no começo de cada dia (no fuso da loja); com o ritmo parado, ou depois do fim da semana, ela volta à de
// antes. Cada passo é um pedido do Gestor de tráfego pelo trilho de ações (`orcamento_do_ritmo`), em nome de quem
// aprovou a semana: sai sem outro pedido de aprovação, com o portão do ritmo conferido no pedido e na execução, e com os
// limites de sempre (10% por mudança, o teto por campanha, a verba do mês). Uma tentativa por campanha e por dia; a
// campanha mexida por fora sai do ritmo e fica como a pessoa deixou; o passo que não cabe fica bloqueado, com o motivo.
// O limite da empresa que não deixa a verba SUBIR (a verba do mês, o teto por campanha, a política) tira a campanha do
// ritmo: seguir só descendo deixaria o ritmo pior do que sem ele. Ela volta à verba de antes, e a volta é tentada todo
// dia até sair (D-RG-72).

export { FLAG_DO_RITMO };
const ROTULO_DO_GESTOR = 'Gestor de tráfego';
/** O dia e a hora da proposta, no fuso da loja: domingo, a partir das 16h (a previsão já cobre quase toda a semana). */
export const DIA_DA_PROPOSTA = 0;
export const HORA_DA_PROPOSTA = 16;
/** Quantas marcas a volta lê do banco de cada vez. */
const PAGINA = 200;

export type ResultadoDoRitmo = { tenantId: string; brandId: string; situacao: 'pedido' | 'sem_ritmo' | 'nao_pediu'; motivo: string | null };

type Candidata = { tenant_id: string; brand_id: string; unit_id: string; conta: string };

/** O que a rotina fez com o passo de uma campanha numa volta (`encerrado`: o ritmo cuja semana acabou e voltou). */
export type ResultadoDoPasso = {
  tenantId: string;
  ritmo: string;
  recurso: string | null;
  situacao: 'pedido' | 'igual' | 'fora' | 'bloqueado' | 'nao_pediu' | 'encerrado';
  motivo: string | null;
};

type RitmoDoDia = { id: string; tenant_id: string; brand_id: string; conta: string; status: 'aprovado' | 'parado'; week_end: string; plan: unknown; action_id: string | null; hoje: string };
type PassoGuardado = { resource_id: string; dia: string; kind: 'ritmo' | 'volta'; status: string };
type PassoAGuardar = { dia: string; recurso: string; tipo: 'ritmo' | 'volta'; valor: number; esperado: number };

@Injectable()
export class RitmoDaSemanaService {
  private readonly logger = new Logger('ritmo-da-semana');
  /** A última marca que a volta anterior olhou, quando ela parou com o lote cheio; nulo: a lista recomeça do início. */
  private depoisDe: string | null = null;
  /** O mesmo, para os passos do dia: o último ritmo que a volta anterior olhou. */
  private depoisDoRitmo: string | null = null;

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
        campanhas: campanhas.map((x) => {
          const { recurso, partida } = montado.recursos[x.id]!;
          // A partida só fica no plano quando a semana continua de outro ritmo (a verba da véspera não é a de antes).
          return { recurso, nome: x.name, base_micros: x.base_micros, dias_micros: x.days_micros, ...(partida !== x.base_micros ? { partida_micros: partida } : {}) };
        }),
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
        { tool: FERRAMENTA_DO_RITMO, brand_id: c.brand_id, provider: 'meta_ads', account_id: c.conta, resource_id: recursoDoRitmo(id), params: {} },
      );
      await tx.execute(sql`update liame.budget_rhythm set action_id = ${pedido}, updated_at = now() where id = ${id}`);
      return { ...base, situacao: 'pedido' as const, motivo: null };
    });
  }
  /**
   * Os passos do dia (R7, parte 1b-2). Uma volta:
   *   1) fecha os passos cujo pedido terminou: feito; fora, quando a verba tinha mudado entre o pedido e a execução;
   *      bloqueado, com o motivo, no resto;
   *   2) para cada ritmo aprovado (na semana dele, ou depois dela, devolvendo a verba) ou parado, dá o passo de hoje de
   *      cada campanha que ainda não tem passo hoje;
   *   3) encerra o ritmo cuja semana acabou e cujas campanhas já voltaram à verba de antes.
   * `limite`: quantos pedidos de passo a volta faz (o ritmo começado termina); com o lote cheio, a seguinte continua.
   */
  async executarPassos(limite = 20, scope: JobScope = {}, agora: Date = new Date()): Promise<ResultadoDoPasso[]> {
    const database = this.database;
    if (!database) return [];
    const referencia = sql`${agora.toISOString()}::timestamptz`;
    await withSystem(database.db, (tx) =>
      tx.execute(sql`
        update liame.budget_rhythm_step s
           set status = case when r.status = 'executada' then 'feito'
                             when exists (select 1 from liame.action_execution e
                                           where e.action_request_id = r.id and e.tenant_id = r.tenant_id and e.status = 'estado_mudou') then 'fora'
                             else 'bloqueado' end,
               reason = case when r.status = 'executada' then null else left(coalesce(r.status_reason, r.status), 500) end,
               updated_at = now()
          from liame.action_request r
         where r.id = s.action_id and r.tenant_id = s.tenant_id and s.status = 'pedido' and r.status in ('executada', 'falhou', 'cancelada', 'expirada')
           ${tenantFilter(scope, sql`s.tenant_id`)}`),
    );
    const resultados: ResultadoDoPasso[] = [];
    let pedidos = 0;
    for (;;) {
      const depoisDe = this.depoisDoRitmo;
      // Os ritmos com passo a dar hoje: aprovados ou parados, da semana em curso ou recém-acabada, em que alguma campanha
      // ainda não tem o passo de hoje (as que saíram do ritmo e as que já voltaram à verba de antes não contam). Com o
      // ritmo rodando, qualquer passo de hoje conta; com ele parado ou com a semana acabada, só o de volta (o ritmo
      // parado no mesmo dia em que a verba subiu ainda deve o passo de volta de hoje).
      const pagina = await withSystem(database.db, async (tx) =>
        (
          await tx.execute<RitmoDoDia>(sql`
            select r.id, r.tenant_id, r.brand_id, r.ad_account_id as conta, r.status, r.week_end::text as week_end, r.plan, r.action_id, h.hoje::text as hoje
              from liame.budget_rhythm r
              join liame.unit u on u.id = r.unit_id and u.tenant_id = r.tenant_id
              join lateral (select (${referencia} at time zone coalesce(u.timezone, 'America/Sao_Paulo'))::date as hoje) h on true
             where r.status in ('aprovado', 'parado') ${tenantFilter(scope, sql`r.tenant_id`)}
               ${depoisDe ? sql`and r.id > ${depoisDe}::uuid` : sql``}
               and r.week_start <= h.hoje and r.week_end >= h.hoje - ${DIAS_DA_VOLTA}::int
               and (select count(distinct s.resource_id) from liame.budget_rhythm_step s
                     where s.rhythm_id = r.id and s.tenant_id = r.tenant_id
                       and (s.status = 'fora' or (s.kind = 'volta' and s.status = 'igual')
                            or (s.day = h.hoje and (s.kind = 'volta' or (r.status = 'aprovado' and h.hoje <= r.week_end))))) < jsonb_array_length(r.plan -> 'campanhas')
             order by r.id
             limit ${PAGINA}`)
        ).rows,
      );
      for (const r of pagina) {
        try {
          const feitos = await this.passosDoRitmo(database, r, agora);
          resultados.push(...feitos);
          pedidos += feitos.filter((f) => f.situacao === 'pedido').length;
        } catch (err) {
          // Um ritmo que falha não para os outros; a volta seguinte tenta de novo.
          this.logger.warn(`os passos do ritmo ${r.id} não saíram: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.depoisDoRitmo = r.id;
        if (pedidos >= limite) return resultados;
      }
      if (pagina.length < PAGINA) {
        this.depoisDoRitmo = null;
        return resultados;
      }
    }
  }

  /** Os passos de hoje de um ritmo: uma campanha de cada vez, cada pedido na transação dele. */
  private async passosDoRitmo(database: Database, r: RitmoDoDia, agora: Date): Promise<ResultadoDoPasso[]> {
    const plano = EstadoDoRitmo.omit({ situacao: true }).safeParse(r.plan);
    if (!plano.success) return [];
    const dias = plano.data.dias.map((d) => d.dia);
    // O que há: os passos do ritmo, o que o Liame deixou em cada objeto, o teto por campanha de agora e quem aprovou.
    const lido = await naTransacaoDaEmpresa(database, { tenantId: r.tenant_id, userId: null }, async () => {
      const tx = currentTx();
      const passos = (
        await tx.execute<PassoGuardado>(sql`
          select resource_id, day::text as dia, kind, status from liame.budget_rhythm_step where tenant_id = ${r.tenant_id} and rhythm_id = ${r.id}`)
      ).rows;
      const controle = await controleDoRitmo(tx, { tenantId: r.tenant_id, brandId: r.brand_id, hoje: r.hoje });
      const { policies } = await carregarPoliticas(tx, r.tenant_id, r.brand_id);
      // Em nome de quem aprovou a semana (o funcionário nunca pode mais do que ela); sem a aprovação à mão, o dono.
      const aprovou = (
        await tx.execute<{ user_id: string | null }>(sql`
          select coalesce(
                   (select a.approved_by from liame.approval a
                     where a.tenant_id = ${r.tenant_id} and a.action_request_id = ${r.action_id} and a.sufficient order by a.created_at desc limit 1),
                   (select m.user_id from liame.membership m where m.tenant_id = ${r.tenant_id} and m.role_key = 'dono' and m.revoked_at is null limit 1)) as user_id`)
      ).rows[0]?.user_id;
      return { passos, controle, teto: tetoDaVerba(policies, 'meta_ads'), aprovou: aprovou ?? null };
    });
    const emNomeDe = lido.aprovou;
    if (!emNomeDe) return [];
    const base = { tenantId: r.tenant_id, ritmo: r.id };
    const resultados: ResultadoDoPasso[] = [];
    let voltaram = 0;
    for (const c of plano.data.campanhas) {
      const meus = lido.passos.filter((p) => p.resource_id === c.recurso);
      // Fora do ritmo (mexida por fora) ou já de volta à verba de antes: nada mais a fazer nela.
      if (meus.some((p) => p.status === 'fora' || (p.kind === 'volta' && p.status === 'igual'))) {
        voltaram++;
        continue;
      }
      const conduzida = lido.controle.objetos.get(c.recurso);
      // Outro ritmo, mais novo, já conduz o objeto (a semana seguinte começou): este não mexe mais nele.
      const deOutro = conduzida !== undefined && conduzida.ritmo !== r.id;
      const deixada = conduzida && !deOutro ? conduzida.deixadaMicros : c.base_micros;
      // A campanha que já está voltando (os limites da empresa não deixaram a verba subir) segue na volta, mesmo com o
      // ritmo rodando: o sinal é ela já ter um passo de volta.
      const emVolta = meus.some((p) => p.kind === 'volta');
      const decidir = (situacao: 'aprovado' | 'parado') => decidirPasso({ situacao, hoje: r.hoje, dias, campanha: c, deixadaMicros: deixada, tetoMicros: lido.teto });
      const passo = deOutro ? { tipo: 'volta' as const, alvoMicros: deixada, valorMicros: deixada } : decidir(emVolta ? 'parado' : r.status);
      // Uma tentativa por campanha e por dia.
      if (!passo || meus.some((p) => p.dia === r.hoje && p.kind === passo.tipo)) continue;
      const dado = await this.darPasso(database, r, c.recurso, passo, deixada, emNomeDe, agora, deOutro ? 'segue no ritmo da semana seguinte' : null);
      resultados.push({ ...base, ...dado.resultado });
      if (dado.voltou) voltaram++;
      if (!dado.saiu) continue;
      // Os limites da empresa não deixaram a verba subir: a campanha sai do ritmo e começa a voltar hoje.
      const volta = decidir('parado');
      if (!volta) continue;
      const daVolta = await this.darPasso(database, r, c.recurso, volta, deixada, emNomeDe, agora, 'saiu do ritmo: a verba já é a de antes');
      resultados.push({ ...base, ...daVolta.resultado });
      if (daVolta.voltou) voltaram++;
    }
    // A semana acabou e todas as campanhas voltaram à verba de antes (ou saíram do ritmo): o ritmo se encerra.
    if (r.status === 'aprovado' && r.hoje > r.week_end && voltaram === plano.data.campanhas.length) {
      const encerrado = await naTransacaoDaEmpresa(database, { tenantId: r.tenant_id, userId: null }, async () =>
        currentTx().execute(sql`
          update liame.budget_rhythm set status = 'encerrado', version = version + 1, updated_at = now()
           where id = ${r.id} and tenant_id = ${r.tenant_id} and status = 'aprovado' returning id`),
      );
      if (encerrado.rows[0]) resultados.push({ ...base, recurso: null, situacao: 'encerrado', motivo: null });
    }
    return resultados;
  }

  /**
   * O passo de hoje de uma campanha. Sem o que mudar, só registra: "igual" quando a verba já é a do dia (ou já voltou à
   * de antes), "bloqueado" quando o teto por campanha não deixa subir. Senão, pede a mudança pelo trilho de ações.
   * `voltou`: a campanha terminou a volta. `saiu`: os limites da empresa não deixaram a verba do dia SUBIR, e a
   * campanha sai do ritmo (quem chama dá o passo de volta de hoje).
   */
  private async darPasso(
    database: Database,
    r: RitmoDoDia,
    recurso: string,
    passo: PassoDecidido,
    deixada: number,
    emNomeDe: string,
    agora: Date,
    motivoDoIgual: string | null,
  ): Promise<{ resultado: Omit<ResultadoDoPasso, 'tenantId' | 'ritmo'>; voltou: boolean; saiu: boolean }> {
    const linha: PassoAGuardar = { dia: r.hoje, recurso, tipo: passo.tipo, valor: passo.valorMicros, esperado: deixada };
    if (passo.valorMicros !== deixada) return this.pedirPasso(database, r, linha, emNomeDe, agora);
    const igual = passo.alvoMicros === deixada;
    const motivo = igual ? motivoDoIgual : passo.tipo === 'ritmo' ? 'o teto por campanha não deixa a verba subir' : 'o teto por campanha não deixa a verba voltar à de antes';
    await this.guardarPasso(database, r, linha, igual ? 'igual' : 'bloqueado', motivo);
    return { resultado: { recurso, situacao: igual ? 'igual' : 'bloqueado', motivo }, voltou: igual && passo.tipo === 'volta', saiu: !igual && passo.tipo === 'ritmo' };
  }

  /** O passo que não vira pedido (a verba já é a do dia, o teto não deixa subir, a campanha saiu do ritmo), guardado com o porquê. */
  private async guardarPasso(database: Database, r: RitmoDoDia, linha: PassoAGuardar, status: 'igual' | 'bloqueado' | 'fora', motivo: string | null): Promise<void> {
    await naTransacaoDaEmpresa(database, { tenantId: r.tenant_id, userId: null }, async () => {
      await currentTx().execute(sql`
        insert into liame.budget_rhythm_step (id, tenant_id, rhythm_id, day, resource_id, kind, target_micros, expected_micros, status, reason)
        values (${uuidv7()}, ${r.tenant_id}, ${r.id}, ${linha.dia}::date, ${linha.recurso}, ${linha.tipo}, ${linha.valor}, ${linha.esperado}, ${status}, ${motivo})
        on conflict (rhythm_id, day, resource_id, kind) do nothing`);
    });
  }

  /**
   * O pedido do passo: guarda o passo e pede a mudança da verba pelo trilho de ações, na mesma transação (o que falhar
   * desfaz os dois; o executor acha o passo pelo pedido, e por isso os dois nascem juntos). A recusa fica guardada com o
   * porquê:
   *   - o plano recusado (a campanha não está como o Liame deixou, ou foi arquivada): ela sai do ritmo e fica como está;
   *   - o limite da empresa (422: a verba do mês, a política) num passo do dia que SOBE: bloqueado, e a campanha sai do
   *     ritmo para voltar à verba de antes (`saiu`);
   *   - o resto (o portão, a trava, a política pedindo outro modo): o passo de hoje fica bloqueado.
   * Não guardam nada, e a volta seguinte tenta de novo: a falha passageira (a Meta fora do ar) e o pedido de ontem que
   * ainda está na fila para o mesmo objeto (o executor o encerra pelo dia, e aí o de hoje entra).
   */
  private async pedirPasso(
    database: Database,
    r: RitmoDoDia,
    linha: PassoAGuardar,
    emNomeDe: string,
    agora: Date,
  ): Promise<{ resultado: Omit<ResultadoDoPasso, 'tenantId' | 'ritmo'>; voltou: boolean; saiu: boolean }> {
    const base = { recurso: linha.recurso, voltou: false, saiu: false };
    try {
      return await naTransacaoDaEmpresa(database, { tenantId: r.tenant_id, userId: null }, async () => {
        const tx = currentTx();
        const id = uuidv7();
        const guardado = await tx.execute(sql`
          insert into liame.budget_rhythm_step (id, tenant_id, rhythm_id, day, resource_id, kind, target_micros, expected_micros, status)
          values (${id}, ${r.tenant_id}, ${r.id}, ${linha.dia}::date, ${linha.recurso}, ${linha.tipo}, ${linha.valor}, ${linha.esperado}, 'pedido')
          on conflict (rhythm_id, day, resource_id, kind) do nothing
          returning id`);
        // Outra volta chegou antes: esta não pede de novo.
        if (!guardado.rows[0]) return { ...base, resultado: { recurso: linha.recurso, situacao: 'nao_pediu' as const, motivo: 'ja_tem_passo' } };
        const pedido = await this.actions.ajustarPeloRitmo(
          { tenantId: r.tenant_id, agentKey: GESTOR_DE_TRAFEGO, agentLabel: ROTULO_DO_GESTOR, emNomeDe },
          {
            tool: FERRAMENTA_DO_PASSO,
            brand_id: r.brand_id,
            provider: 'meta_ads',
            account_id: r.conta,
            resource_id: linha.recurso,
            params: { daily_budget_micros: linha.valor, expected_micros: linha.esperado },
          },
          { ritmo: r.id, dia: linha.dia, tipo: linha.tipo },
          agora,
        );
        await tx.execute(sql`update liame.budget_rhythm_step set action_id = ${pedido}, updated_at = now() where id = ${id}`);
        return { ...base, resultado: { recurso: linha.recurso, situacao: 'pedido' as const, motivo: null } };
      });
    } catch (err) {
      const passageira = !(err instanceof AppProblem) || err.code === 'acao-duplicada';
      if (passageira) {
        const motivo = err instanceof AppProblem ? `${err.code}: ${err.detail}` : err instanceof Error ? err.message : String(err);
        if (!(err instanceof AppProblem)) this.logger.warn(`o passo do ritmo ${r.id} em ${linha.recurso} não foi pedido: ${motivo}`);
        return { ...base, resultado: { recurso: linha.recurso, situacao: 'nao_pediu', motivo: motivo.slice(0, 300) } };
      }
      const fora = err.code === 'plano-recusado';
      const motivo = (fora ? (err.detail === FORA_DO_RITMO ? 'a campanha não está como o Liame deixou' : err.detail) : `${err.code}: ${err.detail}`).slice(0, 500);
      await this.guardarPasso(database, r, linha, fora ? 'fora' : 'bloqueado', motivo);
      // O limite da empresa não deixou a verba do dia subir (D-RG-72).
      const saiu = !fora && linha.tipo === 'ritmo' && linha.valor > linha.esperado && err.getStatus() === 422;
      return { ...base, saiu, resultado: { recurso: linha.recurso, situacao: fora ? 'fora' : 'bloqueado', motivo } };
    }
  }
}
