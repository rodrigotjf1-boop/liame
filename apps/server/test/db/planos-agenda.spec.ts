import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { type Database, runMigrations } from '@liame/database';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TAREFA_ESTRATEGISTA } from '../../src/ai/estrategista/prompt.js';
import { AiGateway } from '../../src/ai/gateway.js';
import { ModelosIa } from '../../src/ai/modelos.js';
import { FerramentasDeLeitura } from '../../src/ai/registro/leituras.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { ResultsService } from '../../src/results/results.service.js';
import { DIAS_ENTRE_PLANOS_DE_90, EstrategistaAgenda } from '../../src/worker/estrategista-agenda.js';
import { EstrategistaLoop } from '../../src/worker/estrategista-loop.js';
import { EstrategistaService } from '../../src/worker/estrategista.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarIa, ModelosDeTeste, rotaCompartilhada, uso } from '../helpers/ia.js';
import { hasDb, OWNER_URL } from './env.js';

// Planos agendados do Estrategista (A3, I11b): na segunda-feira, a partir das 9h no fuso da loja, a rotina pede a pauta
// da semana e, a cada 12 semanas, o plano de 90 dias, como demandas sem pessoa. Relógio injetado; loja em Brasília
// (UTC−3); cada teste olha só a própria empresa (o banco de testes é compartilhado).

/** Segunda-feira, 05/10/2026, na hora de Brasília. */
const segunda = (hora: number) => new Date(Date.UTC(2026, 9, 5, hora + 3));
const SEGUNDA = '2026-10-05';

describe.skipIf(!hasDb)('Planos agendados: a pauta de segunda e o plano de 90 dias pela rotina (A3, I11b)', () => {
  let api: TestApi;
  let database: Database;
  let config: AppConfig;
  let flags: FlagService;
  let modelos: ModelosDeTeste;
  let alvo: { provider: string; model: string };
  let agenda: EstrategistaAgenda;
  let loop: EstrategistaLoop;

  type Empresa = { cookie: string; tenantId: string; userId: string; brandId: string };

  /** Empresa com a conta da Meta ligada à marca e, salvo pedido em contrário, a IA ligada. */
  async function empresa(opcoes: { ia?: boolean; conta?: boolean } = {}): Promise<Empresa> {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria da Agenda');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    if (opcoes.conta !== false) {
      await ownerQuery(
        `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', 'act_' || $4, 'Conta da Agenda', 'BRL', 'America/Sao_Paulo')`,
        [randomUUID(), tenantId, brandId, Math.floor(Math.random() * 1e9).toString()],
      );
    }
    if (opcoes.ia !== false) await ligarIa(flags, tenantId);
    return { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId };
  }

  const agendar = (e: Empresa, agora: Date) => agenda.agendarLote({ tenantIds: [e.tenantId] }, agora);
  const demandas = (e: Empresa) =>
    ownerQuery<{ id: string; kind: string; title: string; detail: string; status: string; requested_by: string | null; opened_by_agent: string | null; routine_key: string | null }>(
      `select id, kind, title, detail, status, requested_by, opened_by_agent, routine_key from liame.demand where tenant_id = $1 order by kind, created_at`,
      [e.tenantId],
    );
  /** Um plano já gravado da marca, criado há `dias` dias da segunda-feira do teste. */
  async function planoDeAntes(e: Empresa, kind: 'pauta' | 'noventa_dias', dias: number): Promise<void> {
    const id = randomUUID();
    const criado = new Date(segunda(10).getTime() - dias * 86_400_000).toISOString();
    await ownerQuery(
      `insert into liame.plan (id, tenant_id, brand_id, kind, title, status, version, expires_at, created_at, updated_at)
       values ($1, $2, $3, $4, 'Plano de antes', 'aprovado', 1, $5::timestamptz + interval '3 days', $5, $5)`,
      [id, e.tenantId, e.brandId, kind, criado],
    );
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    config = api.app.get(APP_CONFIG);
    flags = api.app.get(FlagService);
    modelos = new ModelosDeTeste(config);
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    agenda = new EstrategistaAgenda(database, flags);
    loop = new EstrategistaLoop(database, flags, new EstrategistaService(database, api.app.get(AiGateway), api.app.get(FerramentasDeLeitura), api.app.get(ResultsService)));
    // A tarefa do Estrategista também é usada por `planos.spec.ts`, que roda em outro processo: a rota é a
    // compartilhada (ninguém apaga a do outro), e o modelo simulado é o deste arquivo.
    alvo = await rotaCompartilhada(modelos, TAREFA_ESTRATEGISTA, new MockLanguageModelV4({ doGenerate: [] }));
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('na segunda depois das 9h, a rotina pede a pauta da semana e o plano de 90 dias, uma vez só, sem pessoa, com auditoria', async () => {
    const e = await empresa();
    // Antes das 9h, e em outro dia da semana, nada.
    expect(await agendar(e, segunda(8))).toEqual([]);
    expect(await agendar(e, new Date(segunda(10).getTime() + 86_400_000))).toEqual([]);

    const abertos = await agendar(e, segunda(10));
    expect(abertos.map((a) => a.kind).sort()).toEqual(['noventa_dias', 'pauta']);
    expect(await demandas(e)).toEqual([
      {
        id: expect.any(String),
        kind: 'pauta',
        title: 'Pauta da semana de 05/10 a 11/10',
        detail: 'Monte a pauta desta semana, de 05/10/2026 a 11/10/2026: um item por dia, a partir dos resultados da semana passada.',
        status: 'aberta',
        requested_by: null,
        opened_by_agent: 'estrategista',
        routine_key: `pauta:${SEGUNDA}`,
      },
      {
        id: expect.any(String),
        kind: 'plano',
        title: 'Plano de 90 dias: outubro a dezembro',
        detail: 'Monte o plano dos próximos 90 dias (outubro, novembro e dezembro), com a verba por canal e as datas do calendário comercial.',
        status: 'aberta',
        requested_by: null,
        opened_by_agent: 'estrategista',
        routine_key: `noventa_dias:${SEGUNDA}`,
      },
    ]);
    // A volta seguinte (e outro worker ao mesmo tempo) não pede de novo.
    expect(await Promise.all([agendar(e, segunda(10)), agendar(e, segunda(11))])).toEqual([[], []]);
    expect(await demandas(e)).toHaveLength(2);
    const auditoria = await ownerQuery<{ actor_type: string; actor_label: string; origin: string; after: Record<string, unknown> }>(
      `select actor_type, actor_label, origin, after from liame.audit_event where tenant_id = $1 and action = 'demanda.abrir' order by occurred_at`,
      [e.tenantId],
    );
    expect(auditoria.map((a) => [a.actor_type, a.actor_label, a.origin, a.after.routine_key])).toEqual(
      expect.arrayContaining([
        ['system', 'Rotina de segunda-feira do Estrategista', 'worker', `pauta:${SEGUNDA}`],
        ['system', 'Rotina de segunda-feira do Estrategista', 'worker', `noventa_dias:${SEGUNDA}`],
      ]),
    );
  });

  it('sem a IA ligada, sem o Estrategista, sem conta de anúncio ou com a marca arquivada, a rotina não pede nada', async () => {
    const semIa = await empresa({ ia: false });
    expect(await agendar(semIa, segunda(10))).toEqual([]);
    const desligado = await empresa();
    await ownerQuery(`insert into liame.agent_activation (id, tenant_id, agent_key, enabled, set_by) values (gen_random_uuid(), $1, 'estrategista', false, 'teste')`, [desligado.tenantId]);
    expect(await agendar(desligado, segunda(10))).toEqual([]);
    const semConta = await empresa({ conta: false });
    expect(await agendar(semConta, segunda(10))).toEqual([]);
    const arquivada = await empresa();
    await ownerQuery(`update liame.brand set archived_at = now() where id = $1`, [arquivada.brandId]);
    expect(await agendar(arquivada, segunda(10))).toEqual([]);
    for (const e of [semIa, desligado, semConta, arquivada]) expect(await demandas(e)).toEqual([]);
  });

  it('com uma pauta recente ou pedida na conversa, só o plano de 90 dias sai; com um de 90 dias recente, só a pauta', async () => {
    const comPauta = await empresa();
    await planoDeAntes(comPauta, 'pauta', 1);
    expect((await agendar(comPauta, segunda(10))).map((a) => a.kind)).toEqual(['noventa_dias']);

    const pediuNaConversa = await empresa();
    await ownerQuery(
      `insert into liame.demand (id, tenant_id, brand_id, kind, title, detail, assignee_agent, requested_by, opened_by_agent) values (gen_random_uuid(), $1, $2, 'pauta', 'Pauta desta semana', 'Monta a pauta.', 'estrategista', $3, 'lia')`,
      [pediuNaConversa.tenantId, pediuNaConversa.brandId, pediuNaConversa.userId],
    );
    expect((await agendar(pediuNaConversa, segunda(10))).map((a) => a.kind)).toEqual(['noventa_dias']);

    const com90 = await empresa();
    await planoDeAntes(com90, 'noventa_dias', 30);
    expect((await agendar(com90, segunda(10))).map((a) => a.kind)).toEqual(['pauta']);
    // Doze semanas depois do último, sai outro.
    const antigo = await empresa();
    await planoDeAntes(antigo, 'noventa_dias', DIAS_ENTRE_PLANOS_DE_90 + 1);
    expect((await agendar(antigo, segunda(10))).map((a) => a.kind).sort()).toEqual(['noventa_dias', 'pauta']);
  });

  it('a pauta da rotina vira plano pela fila, sem pessoa: o custo é da empresa', async () => {
    const e = await empresa();
    const [pauta] = (await agendar(e, segunda(10))).filter((a) => a.kind === 'pauta');
    const dias = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11'];
    const resposta = {
      resumo: 'O que fazer em cada dia desta semana, sem verba nova.',
      porques: ['A semana passada não teve gasto lido nas contas de anúncio.'],
      risco: 'baixo',
      risco_motivo: 'nenhuma verba nova.',
      fazer: [],
      depois: 'A revisão da próxima segunda mostra o que foi feito.',
      dias: dias.map((dia) => ({ dia, item: 'Nada novo.' })),
    };
    modelos.porChave.set(
      `${alvo.provider}/${alvo.model}`,
      new MockLanguageModelV4({ doGenerate: [{ content: [{ type: 'text', text: JSON.stringify(resposta) }], finishReason: { unified: 'stop', raw: undefined }, usage: uso(1000, 500), warnings: [] }] }),
    );
    // Só a demanda da pauta vai à fila neste teste: a do plano de 90 dias fica para depois.
    await ownerQuery(`update liame.demand set next_attempt_at = $2::timestamptz + interval '1 day' where tenant_id = $1 and kind = 'plano'`, [e.tenantId, segunda(10).toISOString()]);
    expect(await loop.executarLote(10, { tenantIds: [e.tenantId] }, segunda(10))).toEqual([{ tipo: 'demanda', id: pauta!.demandId, tenantId: e.tenantId, status: 'proposto' }]);
    const [plano] = await ownerQuery<{ kind: string; title: string; requested_by: string | null; demand_id: string; expires_at: Date }>(
      `select kind, title, requested_by, demand_id, expires_at from liame.plan where tenant_id = $1`,
      [e.tenantId],
    );
    expect(plano).toMatchObject({ kind: 'pauta', title: 'Pauta da semana de 05/10 a 11/10', requested_by: null, demand_id: pauta!.demandId });
    // Três dias a partir da segunda às 10h (a semana termina depois disso).
    expect(new Date(plano!.expires_at).getTime()).toBe(segunda(10).getTime() + 72 * 3_600_000);
    expect(await ownerQuery(`select user_id from liame.ai_usage where tenant_id = $1 and task = $2`, [e.tenantId, TAREFA_ESTRATEGISTA])).toEqual([{ user_id: null }]);
  });
});
