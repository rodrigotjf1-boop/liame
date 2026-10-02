import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { type Database, runMigrations } from '@liame/database';
import type { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExplicarService } from '../../src/ai/explicar/explicar.service.js';
import { PROMPT_EXPLICAR_RESULTADOS, TAREFA_EXPLICAR_RESULTADOS } from '../../src/ai/explicar/prompt.js';
import type { Explicacao } from '../../src/ai/explicar/resposta.js';
import { AiGateway } from '../../src/ai/gateway.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { ResultsService } from '../../src/results/results.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarIa, ModelosDeTeste, modeloComPreco, recusa, responde, rotaAtiva } from '../helpers/ia.js';
import { hasDb, OWNER_URL } from './env.js';

describe.skipIf(!hasDb)('Explicar dos resultados: a IA escreve, o código confere, e sem IA a explicação continua (A3, I4)', () => {
  const RODADA = `teste_${randomBytes(4).toString('hex')}`;
  const PERIODO = { from: '2026-09-18', to: '2026-10-01' };
  let api: TestApi;
  let database: Database;
  let config: AppConfig;
  let flags: FlagService;
  let modelos: ModelosDeTeste;
  let explicar: ExplicarService;
  /** O modelo da rota da tarefa: cada teste troca o simulado que responde por ele. */
  let alvo: { provider: string; model: string };
  const responder = (mock: MockLanguageModelV4) => {
    modelos.porChave.set(`${alvo.provider}/${alvo.model}`, mock);
    return mock;
  };

  type Dono = { cookie: string; tenantId: string; userId: string; brandId: string; contaId: string };

  /** Empresa com uma conta da Meta lida há pouco e gasto em dois períodos seguidos (R$ 100,00 e depois R$ 200,00). */
  async function dono(opcoes: { ia?: boolean; lidaHaHoras?: number } = {}): Promise<Dono> {
    const s = await signupAndLogin(api, undefined, 'Pizzaria do Explicar');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    const [contaId, campanha, grupo, anuncio] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', 'act_' || $4, 'Conta da Pizzaria', 'BRL', 'America/Sao_Paulo')`,
      [contaId, tenantId, brandId, Math.floor(Math.random() * 1e9).toString()],
    );
    await ownerQuery(
      `insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at) values ($1, 'metricas', $2, 1440, now() - make_interval(hours => $3))`,
      [contaId, tenantId, opcoes.lidaHaHoras ?? 1],
    );
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', 'c1', 'Delivery noite', 'ativa')`, [campanha, tenantId, contaId]);
    await ownerQuery(`insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', 'g1', 'Bairros', 'ativa')`, [grupo, tenantId, contaId, campanha]);
    await ownerQuery(`insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', 'a1', 'Combo', 'ativa')`, [anuncio, tenantId, contaId, grupo]);
    for (const [dia, valor] of [['2026-09-10', 100], ['2026-09-20', 200]] as const) {
      await ownerQuery(
        `insert into liame.metric_latest (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window, tenant_id, brand_id, provider, entity_id, metric_value, currency, observed_at, changed_at)
         values ($1, 'ad', 'a1', $2, 'spend', '', $3, $4, 'meta_ads', $5, $6, 'BRL', now(), now())`,
        [contaId, dia, tenantId, brandId, anuncio, valor],
      );
    }
    if (opcoes.ia !== false) await ligarIa(flags, tenantId);
    return { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId, contaId };
  }
  const pedir = (d: Dono, permissoes: string[] = ['vendas.ver']) => explicar.dosResultados({ tenantId: d.tenantId, userId: d.userId, permissions: new Set(permissoes) }, { brand_id: d.brandId, ...PERIODO });
  const usos = (tenantId: string) =>
    ownerQuery<{ workflow: string; task: string; prompt_version: string; outcome: string; cost: number }>(
      `select workflow, task, prompt_version, outcome, cost_usd_micros::int as cost from liame.ai_usage where tenant_id = $1 order by occurred_at, id`,
      [tenantId],
    );

  const BOA: Explicacao = {
    o_que_aconteceu: 'O investimento em anúncios dobrou: foi de R$ 100,00 para R$ 200,00 (+100,0%), e o caixa ainda não confirmou pedido com origem em campanha.',
    motivos: ['A campanha "Delivery noite" recebeu R$ 200,00 no período e não tem pedido confirmado no caixa.'],
    risco: 'alto',
    o_que_fazer: ['Confira se o link com rastreio está no anúncio antes de manter a verba.'],
  };

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    config = api.app.get(APP_CONFIG);
    flags = api.app.get(FlagService);
    modelos = new ModelosDeTeste(config);
    explicar = new ExplicarService(database, new AiGateway(database, config, flags, api.app.get(KillSwitchService), modelos), api.app.get(ResultsService));
    // A rota é da tarefa de verdade (uma ativa por tarefa): este arquivo é o único que a usa, e a apaga no fim.
    await ownerQuery(`delete from liame.ai_model_route where task = $1 and created_by = 'testes'`, [TAREFA_EXPLICAR_RESULTADOS]);
    alvo = await modeloComPreco(modelos, RODADA, responde(JSON.stringify(BOA)));
    await rotaAtiva(TAREFA_EXPLICAR_RESULTADOS, alvo);
  });
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await ownerQuery(`delete from liame.ai_model_route where task = $1 and created_by = 'testes'`, [TAREFA_EXPLICAR_RESULTADOS]);
    await ownerQuery(`delete from liame.ai_model_price where model like $1`, [`${RODADA}%`]);
    await api?.close();
  });

  it('a IA recebe os números prontos (com a comparação calculada pelo código) e a explicação dela vai para a tela', async () => {
    const d = await dono();
    const mock = responder(responde(JSON.stringify(BOA)));
    const r = await pedir(d);
    expect(r).toMatchObject({
      origem: 'ia',
      motivo_sem_ia: null,
      explicacao: BOA,
      periodo: { de: '18/09/2026', ate: '01/10/2026' },
      comparado_com: { de: '04/09/2026', ate: '17/09/2026' },
      fontes_fora_do_dia: [],
    });
    expect(r.usage_id).toMatch(/^[0-9a-f-]{36}$/);
    // O que o modelo recebeu: o prompt registrado como instrução e, como mensagem, o contexto do código.
    const chamada = mock.doGenerateCalls[0]!;
    const enviado = JSON.stringify(chamada.prompt);
    expect(enviado).toContain('Você é o Analista do Liame');
    for (const trecho of ['R$ 200,00', 'R$ 100,00', '+100,0%', 'Delivery noite', '18/09/2026', '04/09/2026']) expect(enviado, trecho).toContain(trecho);
    expect(chamada.responseFormat).toMatchObject({ type: 'json' });
    expect(await usos(d.tenantId)).toEqual([
      { workflow: 'resultados.explicar', task: TAREFA_EXPLICAR_RESULTADOS, prompt_version: `${PROMPT_EXPLICAR_RESULTADOS.key}@${PROMPT_EXPLICAR_RESULTADOS.version}`, outcome: 'ok', cost: 14_000 },
    ]);
  });

  it('A3-5: número que não está no contexto derruba a resposta da IA; a tela recebe a explicação do código', async () => {
    const d = await dono();
    responder(responde(JSON.stringify({ ...BOA, motivos: ['Cada real investido trouxe R$ 3,10 e o custo por clique foi de R$ 0,42.'] })));
    const r = await pedir(d);
    expect(r).toMatchObject({ origem: 'sem_ia', motivo_sem_ia: 'numero_fora', usage_id: null });
    expect(r.explicacao.o_que_aconteceu).toContain('o investimento em anúncios foi de R$ 200,00');
    expect(r.explicacao.o_que_aconteceu).toContain('o investimento subiu 100,0%');
    expect(JSON.stringify(r.explicacao)).not.toContain('3,10');
    // A chamada foi feita e paga: fica registrada, mesmo recusada.
    expect((await usos(d.tenantId)).map((u) => [u.outcome, u.cost])).toEqual([['ok', 14_000]]);
  });

  it('A3-6: com a IA desligada, fora do ar ou devolvendo fora do formato, a explicação continua, sem a IA', async () => {
    const desligada = await dono({ ia: false });
    const mock = responder(responde(JSON.stringify(BOA)));
    expect(await pedir(desligada)).toMatchObject({ origem: 'sem_ia', motivo_sem_ia: 'desligada', explicacao: { risco: 'medio' } });
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await usos(desligada.tenantId)).toEqual([]);

    const d = await dono();
    responder(recusa(400));
    expect(await pedir(d)).toMatchObject({ origem: 'sem_ia', motivo_sem_ia: 'indisponivel' });
    responder(responde(JSON.stringify({ risco: 'gigante' })));
    expect(await pedir(d)).toMatchObject({ origem: 'sem_ia', motivo_sem_ia: 'indisponivel' });
    responder(responde(JSON.stringify({ ...BOA, o_que_fazer: ['Leia https://exemplo.com/guia antes de decidir.'] })));
    expect(await pedir(d)).toMatchObject({ origem: 'sem_ia', motivo_sem_ia: 'trecho_proibido' });
  });

  it('não explica com dado velho nem com o funcionário desligado para a empresa: nem chama o modelo', async () => {
    const mock = responder(responde(JSON.stringify(BOA)));
    const velho = await dono({ lidaHaHoras: 24 * 5 });
    const r = await pedir(velho);
    expect(r).toMatchObject({ origem: 'sem_ia', motivo_sem_ia: 'dado_velho', fontes_fora_do_dia: [{ plataforma: 'Meta', conta: 'Conta da Pizzaria' }] });
    expect(r.explicacao.o_que_fazer[0]).toContain('Contas conectadas');

    const d = await dono();
    await ownerQuery(`insert into liame.agent_activation (id, tenant_id, agent_key, enabled, set_by, reason) values (gen_random_uuid(), $1, 'analista', false, 'testes', 'fora do plano')`, [d.tenantId]);
    expect(await pedir(d)).toMatchObject({ origem: 'sem_ia', motivo_sem_ia: 'funcionario_desligado' });
    expect(mock.doGenerateCalls).toHaveLength(0);
  });

  it('A3-4: só explica para quem vê os resultados, e a marca de outra empresa não existe', async () => {
    const [a, b] = [await dono(), await dono()];
    responder(responde(JSON.stringify(BOA)));
    await expect(pedir(a, ['campanhas.ver'])).rejects.toMatchObject({ status: 403 });
    await expect(explicar.dosResultados({ tenantId: b.tenantId, userId: b.userId, permissions: new Set(['vendas.ver']) }, { brand_id: a.brandId, ...PERIODO })).rejects.toMatchObject({ status: 404 });
    // A rotina do sistema (relatório, sem pessoa) explica do mesmo jeito.
    expect(await explicar.dosResultados({ tenantId: a.tenantId, userId: null, permissions: 'sistema' }, { brand_id: a.brandId, ...PERIODO })).toMatchObject({ origem: 'ia' });
  });
});
