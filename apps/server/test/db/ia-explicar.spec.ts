import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ExplanationResponse } from '@liame/contracts';
import { type Database, runMigrations, withContext } from '@liame/database';
import type { MockLanguageModelV4 } from 'ai/test';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExplicarService } from '../../src/ai/explicar/explicar.service.js';
import { PROMPT_EXPLICAR_RESULTADOS, TAREFA_EXPLICAR_RESULTADOS } from '../../src/ai/explicar/prompt.js';
import type { Explicacao } from '../../src/ai/explicar/resposta.js';
import { AiGateway } from '../../src/ai/gateway.js';
import { naTransacaoDaEmpresa } from '../../src/ai/na-empresa.js';
import { ModelosIa } from '../../src/ai/modelos.js';
import { dia } from '../../src/ai/registro/formatos.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { MediaService } from '../../src/media/media.service.js';
import { AtencaoCicloService } from '../../src/results/atencao-ciclo.service.js';
import { diaNoFuso, menosDias } from '../../src/results/fora-do-normal.js';
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

  const FUSO = 'America/Sao_Paulo';
  /**
   * Empresa com a loja no Anota AI, uma campanha da Meta que gastou R$ 80,00 ontem e o cupom exclusivo dela
   * sem uso há 6 dias: a Atenção mostra o aviso `cupom_sem_uso`. As duas fontes foram lidas há pouco.
   */
  async function donoComAviso(opcoes: { ia?: boolean } = {}): Promise<Dono & { campanhaId: string }> {
    const s = await signupAndLogin(api, undefined, 'Hamburgueria do Aviso');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    const [unidade, regem, contaId, campanhaId, grupo, anuncio, cupom] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    // Ids de plataforma são só dígitos (ERR-056).
    const externo = String(Math.floor(Math.random() * 1e12));
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name, order_platform) values ($1, $2, $3, 'Loja Praia', 'anotaai')`, [unidade, tenantId, brandId]);
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone, provider_attributes)
       values ($1, $2, $3, $4, 'regem', $5, 'Praia (Regem)', 'BRL', $6, '{"escopos":["pedidos.ler"]}')`,
      [regem, tenantId, brandId, unidade, randomUUID(), FUSO],
    );
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', $4, 'CA - Praia', 'BRL', $5)`,
      [contaId, tenantId, brandId, `act_${externo}`, FUSO],
    );
    await ownerQuery(
      `insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at, last_attempt_at)
       values ($1, 'pedidos', $3, 15, now() - interval '5 minutes', now()), ($2, 'metricas', $3, 1440, now() - interval '1 hour', now())`,
      [regem, contaId, tenantId],
    );
    await ownerQuery(`insert into liame.campaign (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', $4, 'Delivery noite', 'ativa')`, [campanhaId, tenantId, contaId, externo]);
    await ownerQuery(`insert into liame.ad_group (id, tenant_id, connected_account_id, campaign_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', $5, 'Bairros', 'ativa')`, [grupo, tenantId, contaId, campanhaId, `1${externo}`]);
    await ownerQuery(`insert into liame.ad (id, tenant_id, connected_account_id, ad_group_id, provider, external_id, name, status) values ($1, $2, $3, $4, 'meta_ads', $5, 'Combo', 'ativa')`, [anuncio, tenantId, contaId, grupo, `2${externo}`]);
    await ownerQuery(
      `insert into liame.metric_latest (connected_account_id, level, external_entity_id, metric_date, metric_name, attribution_window, tenant_id, brand_id, provider, entity_id, metric_value, currency, timezone, observed_at, changed_at)
       values ($1, 'ad', $2, (now() at time zone $3)::date - 1, 'spend', '', $4, $5, 'meta_ads', $6, 80, 'BRL', $3, now(), now())`,
      [contaId, `2${externo}`, FUSO, tenantId, brandId, anuncio],
    );
    await ownerQuery(
      `insert into liame.coupon (id, tenant_id, brand_id, connected_account_id, external_id, code, kind, active, uses_count, source_version, source_updated_at, origin, platform)
       values ($1, $2, $3, $4, 'externo:NOITE15', 'NOITE15', 'outro', true, 0, 0, now(), 'externo', 'anotaai')`,
      [cupom, tenantId, brandId, regem],
    );
    await ownerQuery(
      `insert into liame.campaign_coupon (id, tenant_id, brand_id, coupon_id, campaign_id, exclusive, linked_at) values (gen_random_uuid(), $1, $2, $3, $4, true, now() - interval '6 days')`,
      [tenantId, brandId, cupom, campanhaId],
    );
    if (opcoes.ia !== false) await ligarIa(flags, tenantId);
    return { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId, contaId, campanhaId };
  }
  type Aviso = { kind: string; brand_id: string | null; connected_account_id: string | null; campaign_id: string | null; provider: string | null; title: string; detail: string; action: string };
  /** O aviso do cupom, como a tela Atenção o recebe. */
  async function avisoDoCupom(d: Dono): Promise<Aviso> {
    const r = await api.call('GET', `/v1/results/attention?brand_id=${d.brandId}`, { cookie: d.cookie });
    const aviso = (r.body.items as Aviso[] | undefined)?.find((i) => i.kind === 'cupom_sem_uso');
    if (!aviso) throw new Error(`a Atenção não trouxe o aviso do cupom: ${r.status} ${JSON.stringify(r.body)}`);
    return aviso;
  }
  /** O que a tela manda para pedir a explicação: os campos que identificam o aviso. */
  const pedidoDoAviso = (d: Dono, a: Aviso) => ({ brand_id: d.brandId, kind: a.kind, connected_account_id: a.connected_account_id, campaign_id: a.campaign_id, provider: a.provider });
  const quem = (d: Dono, permissoes: string[] = ['vendas.ver', 'campanhas.ver']) => ({ tenantId: d.tenantId, userId: d.userId, permissions: new Set(permissoes) });
  /** O contexto que o modelo recebeu na última chamada: a mensagem da pessoa é o JSON montado pelo código. */
  const contextoEnviado = (mock: MockLanguageModelV4) => {
    const mensagem = mock.doGenerateCalls.at(-1)!.prompt.find((m) => m.role === 'user')!;
    return JSON.parse((mensagem.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? '').join(''));
  };
  /** Os 7 dias completos antes de hoje, como aparecem no texto. */
  const janelaDoAviso = () => {
    const hoje = diaNoFuso(new Date(), FUSO);
    return { de: dia(menosDias(hoje, 7))!, ate: dia(menosDias(hoje, 1))! };
  };
  const usos = (tenantId: string) =>
    ownerQuery<{ workflow: string; task: string; prompt_version: string; outcome: string; cost: number }>(
      `select workflow, task, prompt_version, outcome, cost_usd_micros::int as cost from liame.ai_usage where tenant_id = $1 order by occurred_at, id`,
      [tenantId],
    );

  const BOA: Explicacao = {
    o_que_aconteceu: 'O investimento em anúncios dobrou: foi de R$ 100,00 para R$ 200,00 (+100,0%), e o caixa ainda não confirmou pedido com origem em campanha.',
    motivos: ['A campanha "Delivery noite" recebeu R$ 200,00 no período e não tem pedido confirmado no caixa.'],
    risco: 'alto',
    risco_motivo: 'o investimento subiu +100,0% e o caixa não confirmou pedido com origem em campanha.',
    o_que_fazer: ['Confira se o link com rastreio está no anúncio antes de manter a verba.'],
  };
  const BOA_DO_AVISO: Explicacao = {
    o_que_aconteceu: 'O cupom NOITE15 ficou 7 dias sem nenhum uso, enquanto a campanha "Delivery noite" gastou R$ 80,00.',
    motivos: ['A campanha "Delivery noite" seguiu no ar e não teve pedido confirmado no caixa com o cupom.'],
    risco: 'medio',
    risco_motivo: 'sem o cupom em uso, as vendas da campanha ficam sem origem provada.',
    o_que_fazer: ['Confira se o código NOITE15 aparece no anúncio e na conversa do WhatsApp.'],
  };

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    config = api.app.get(APP_CONFIG);
    flags = api.app.get(FlagService);
    modelos = new ModelosDeTeste(config);
    // As rotas da API usam o gateway da aplicação: os modelos dele passam a ser os simulados deste arquivo.
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    explicar = new ExplicarService(database, new AiGateway(database, config, flags, api.app.get(KillSwitchService), modelos), api.app.get(ResultsService), api.app.get(MediaService), api.app.get(AtencaoCicloService));
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

  it('I8: a resposta da IA com uma frase que a marca nunca diz cai na explicação do sistema (Compliance)', async () => {
    const d = await dono();
    // O dossiê da marca, salvo pela rota: "o que não pode dizer" inclui "link com rastreio".
    const salvo = await api.call('PUT', '/v1/brand-dossier', {
      cookie: d.cookie,
      body: { brand_id: d.brandId, base_version: 0, content: { forbidden: { items: [{ text: 'link com rastreio', why: 'aqui é "link do Liame"' }] } } },
    });
    expect(salvo.status).toBe(200);
    responder(responde(JSON.stringify(BOA)));
    expect(await pedir(d)).toMatchObject({ origem: 'sem_ia', motivo_sem_ia: 'compliance', usage_id: null });
  });

  it('A3-15: campanha com nome político ou eleitoral não vai para a IA; a explicação do código segue', async () => {
    const d = await dono();
    await ownerQuery(`update liame.campaign set name = 'Vote 45 | Vereador do bairro' where connected_account_id = $1`, [d.contaId]);
    const mock = responder(responde(JSON.stringify(BOA)));
    const r = await pedir(d);
    expect(r).toMatchObject({ origem: 'sem_ia', motivo_sem_ia: 'conteudo_politico', usage_id: null });
    expect(r.explicacao.o_que_aconteceu).toContain('o investimento em anúncios foi de R$ 200,00');
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await usos(d.tenantId)).toEqual([]);

    // E a IA que escreve promessa de resultado ou pedido de voto é recusada pelas regras de texto.
    const normal = await dono();
    responder(responde(JSON.stringify({ ...BOA, o_que_fazer: ['Dobre a verba: é retorno garantido.'] })));
    expect(await pedir(normal)).toMatchObject({ origem: 'sem_ia', motivo_sem_ia: 'compliance' });
  });

  it('A3-4: só explica para quem vê os resultados, e a marca de outra empresa não existe', async () => {
    const [a, b] = [await dono(), await dono()];
    responder(responde(JSON.stringify(BOA)));
    await expect(pedir(a, ['campanhas.ver'])).rejects.toMatchObject({ status: 403 });
    await expect(explicar.dosResultados({ tenantId: b.tenantId, userId: b.userId, permissions: new Set(['vendas.ver']) }, { brand_id: a.brandId, ...PERIODO })).rejects.toMatchObject({ status: 404 });
    // A rotina do sistema (relatório, sem pessoa) explica do mesmo jeito.
    expect(await explicar.dosResultados({ tenantId: a.tenantId, userId: null, permissions: 'sistema' }, { brand_id: a.brandId, ...PERIODO })).toMatchObject({ origem: 'ia' });
  });

  // ---------------------------------------------------------------- de onde vem cada número

  it('cada número da explicação sai marcado, com a fonte que o código achou no contexto (a IA não escreve fonte)', async () => {
    const d = await dono();
    responder(responde(JSON.stringify(BOA)));
    const r = await pedir(d);
    // O mesmo valor (R$ 200,00) aparece duas vezes: na frase do total e na frase da campanha. São duas linhas.
    expect(r.marcada.numeros.map((n) => n.valor)).toEqual(['R$ 100,00', 'R$ 200,00', '100,0%', 'R$ 200,00']);
    expect(r.marcada.numeros[0]!.fontes).toEqual(['Meta · investimento em anúncios no período anterior · 04/09/2026 a 17/09/2026']);
    // A frase do total: a plataforma (com a hora da leitura) e o total, do mais específico para o mais geral.
    expect(r.marcada.numeros[1]!.fontes).toEqual([
      expect.stringMatching(/^Meta · investimento da Meta · 18\/09\/2026 a 01\/10\/2026 · lido em \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/),
      'Meta · investimento em anúncios · 18/09/2026 a 01/10/2026',
    ]);
    // A frase que cita a campanha: só o número dela.
    expect(r.marcada.numeros[3]!.fontes).toEqual([expect.stringMatching(/^Meta · investimento da campanha "Delivery noite" · 18\/09\/2026 a 01\/10\/2026 · lido em /)]);
    expect(r.marcada.numeros[2]!.fontes).toEqual(['Liame · variação de investimento em anúncios sobre o período anterior (04/09/2026 a 17/09/2026) · calculado pelo sistema']);
    expect(r.marcada.o_que_aconteceu.map((t) => t.texto).join('')).toBe(BOA.o_que_aconteceu);
    // A explicação do sistema passa pela mesma marcação.
    const semIa = await pedir(await dono({ ia: false }));
    expect(semIa.marcada.numeros.length).toBeGreaterThan(3);
    expect(semIa.marcada.numeros.every((n) => n.fontes.length >= 1 && !n.fontes.includes('Liame · dado do período desta tela'))).toBe(true);
  });

  // ---------------------------------------------------------------- aviso da Atenção

  it('explica um aviso da Atenção: o aviso vai na frente do contexto, com os resultados dos últimos 7 dias completos', async () => {
    const d = await donoComAviso();
    const aviso = await avisoDoCupom(d);
    // A tela recebe a marca em cada aviso: é com ela que pede a explicação.
    expect(aviso).toMatchObject({ brand_id: d.brandId, campaign_id: d.campanhaId, connected_account_id: d.contaId, provider: 'meta_ads', title: 'O cupom NOITE15 não teve nenhum uso em 7 dias' });
    const mock = responder(responde(JSON.stringify(BOA_DO_AVISO)));
    const r = await explicar.doAviso(quem(d), pedidoDoAviso(d, aviso));
    const janela = janelaDoAviso();
    expect(r).toMatchObject({ origem: 'ia', motivo_sem_ia: null, explicacao: BOA_DO_AVISO, periodo: janela, comparado_com: null, fontes_fora_do_dia: [], volta_em: null, teto: null });

    const contexto = contextoEnviado(mock);
    expect(Object.keys(contexto)).toEqual(['aviso', 'resultado', 'comparacao', 'fontes_fora_do_dia']);
    expect(contexto.aviso).toEqual({ gravidade: 'atencao', tipo: 'cupom_sem_uso', plataforma: 'Meta', campanha: 'Delivery noite', titulo: aviso.title, detalhe: aviso.detail, o_que_fazer: aviso.action, resultados_de: 'últimos 7 dias completos' });
    expect(contexto.resultado.periodo).toMatchObject(janela);
    expect(contexto.resultado.campanhas).toMatchObject([{ campanha: 'Delivery noite', plataforma_informa: { investimento: 'R$ 80,00' }, caixa_confirma: { pedidos: '0' } }]);

    // O "7 dias" está no texto do aviso, e é dele (a janela de 7 dias do modelo de atribuição só tem o mesmo
    // valor); os R$ 80,00, também na campanha citada. O código do cupom não é número.
    expect(r.marcada.numeros).toEqual([
      { valor: '7', fontes: ['Aviso da Atenção · o número está no texto do aviso'] },
      // A frase cita a campanha: a fonte é o número dela nos 7 dias completos (o mesmo do aviso).
      { valor: 'R$ 80,00', fontes: [expect.stringContaining(`Meta · investimento da campanha "Delivery noite" · ${janela.de} a ${janela.ate} · lido em `)] },
    ]);
    expect(await usos(d.tenantId)).toEqual([
      { workflow: 'atencao.explicar', task: TAREFA_EXPLICAR_RESULTADOS, prompt_version: `${PROMPT_EXPLICAR_RESULTADOS.key}@${PROMPT_EXPLICAR_RESULTADOS.version}`, outcome: 'ok', cost: 14_000 },
    ]);
  });

  it('aviso sem IA: o que o aviso diz, o número da campanha e o que fazer; sem explicação para aviso de outro tipo, que sumiu ou de outra empresa', async () => {
    const d = await donoComAviso({ ia: false });
    const aviso = await avisoDoCupom(d);
    const mock = responder(responde(JSON.stringify(BOA_DO_AVISO)));
    const r = await explicar.doAviso(quem(d), pedidoDoAviso(d, aviso));
    const janela = janelaDoAviso();
    expect(r).toMatchObject({ origem: 'sem_ia', motivo_sem_ia: 'desligada', usage_id: null });
    expect(r.explicacao).toEqual({
      o_que_aconteceu: `${aviso.title}. ${aviso.detail}`,
      motivos: [`De ${janela.de} a ${janela.ate}, a campanha "Delivery noite" teve investimento de R$ 80,00 e 0 pedido(s) confirmado(s) no caixa.`],
      risco: 'medio',
      risco_motivo: 'pela regra do sistema, este aviso pede atenção: vale conferir antes que custe mais.',
      o_que_fazer: [aviso.action],
    });
    expect(mock.doGenerateCalls).toHaveLength(0);
    expect(await usos(d.tenantId)).toEqual([]);

    const pedido = pedidoDoAviso(d, aviso);
    // Aviso de conexão ou de leitura atrasada já diz o que fazer: não tem explicação.
    await expect(explicar.doAviso(quem(d), { ...pedido, kind: 'dado_atrasado' })).rejects.toMatchObject({ status: 422, code: 'aviso-sem-explicacao' });
    // O aviso que não está mais na tela (outra campanha, outra conta) não é explicado.
    await expect(explicar.doAviso(quem(d), { ...pedido, campaign_id: randomUUID() })).rejects.toMatchObject({ status: 404, code: 'aviso-nao-encontrado' });
    await expect(explicar.doAviso(quem(d), { ...pedido, connected_account_id: null })).rejects.toMatchObject({ status: 404, code: 'aviso-nao-encontrado' });
    // Só para quem vê as vendas; e a marca de outra empresa não existe.
    await expect(explicar.doAviso(quem(d, ['campanhas.ver']), pedido)).rejects.toMatchObject({ status: 403 });
    await expect(explicar.doAviso(quem(await dono()), pedido)).rejects.toMatchObject({ status: 404 });
    // Quem vê as vendas e não acompanha as campanhas explica o aviso de venda do mesmo jeito.
    expect(await explicar.doAviso(quem(d, ['vendas.ver']), pedido)).toMatchObject({ origem: 'sem_ia' });
  });

  // ---------------------------------------------------------------- pela API

  it('pela API: a LIA responde em trechos, cada número aponta para a fonte dele, e sem IA a mesma rota devolve a explicação do sistema', async () => {
    const d = await dono();
    responder(responde(JSON.stringify(BOA)));
    expect((await api.call('GET', `/v1/ai/status?brand_id=${d.brandId}`, { cookie: d.cookie })).body).toEqual({ lia: true });
    const r = await api.call('POST', '/v1/ai/explain/results', { cookie: d.cookie, body: { brand_id: d.brandId, ...PERIODO } });
    expect(r.status).toBe(200);
    // A resposta é exatamente o contrato (objeto estrito).
    const corpo = ExplanationResponse.parse(r.body);
    expect(corpo).toMatchObject({
      source: 'lia',
      reason: null,
      period: { from: '18/09/2026', to: '01/10/2026' },
      compared_to: { from: '04/09/2026', to: '17/09/2026' },
      stale_sources: [],
      retry_at: null,
      budget_window: null,
      explanation: { risk: 'alto' },
    });
    expect(corpo.usage_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(corpo.explanation.what_happened.map((t) => t.text).join('')).toBe(BOA.o_que_aconteceu);
    expect(corpo.explanation.reasons.map((m) => m.map((t) => t.text).join(''))).toEqual(BOA.motivos);
    expect(corpo.explanation.risk_reason.map((t) => t.text).join('')).toBe(BOA.risco_motivo);
    expect(corpo.explanation.what_to_do.map((m) => m.map((t) => t.text).join(''))).toEqual(BOA.o_que_fazer);
    expect(corpo.numbers.map((n) => n.value)).toEqual(['R$ 100,00', 'R$ 200,00', '100,0%', 'R$ 200,00']);
    // Todo trecho numerado aponta para a linha da lista com o mesmo valor.
    const trechos = [corpo.explanation.what_happened, ...corpo.explanation.reasons, corpo.explanation.risk_reason, ...corpo.explanation.what_to_do].flat();
    expect(trechos.filter((t) => t.number !== null).map((t) => [t.text, corpo.numbers[t.number!]?.value])).toEqual([
      ['R$ 100,00', 'R$ 100,00'],
      ['R$ 200,00', 'R$ 200,00'],
      ['100,0%', '100,0%'],
      ['R$ 200,00', 'R$ 200,00'],
      ['100,0%', '100,0%'],
    ]);
    expect((await usos(d.tenantId)).map((u) => [u.workflow, u.outcome])).toEqual([['resultados.explicar', 'ok']]);

    // IA desligada para a empresa: a tela sabe antes de pedir, e a explicação é a do sistema.
    const semIa = await dono({ ia: false });
    expect((await api.call('GET', '/v1/ai/status', { cookie: semIa.cookie })).body).toEqual({ lia: false });
    const s = await api.call('POST', '/v1/ai/explain/results', { cookie: semIa.cookie, body: { brand_id: semIa.brandId, ...PERIODO } });
    expect(s.status).toBe(200);
    expect(ExplanationResponse.parse(s.body)).toMatchObject({ source: 'sistema', reason: 'desligada', usage_id: null, explanation: { risk: 'medio' } });
    expect(s.body.numbers.length).toBeGreaterThan(3);
    expect(await usos(semIa.tenantId)).toEqual([]);

    // Dado velho: a rota diz quais fontes estão fora do dia.
    const velho = await dono({ lidaHaHoras: 24 * 5 });
    const v = await api.call('POST', '/v1/ai/explain/results', { cookie: velho.cookie, body: { brand_id: velho.brandId, ...PERIODO } });
    expect(ExplanationResponse.parse(v.body)).toMatchObject({ source: 'sistema', reason: 'dado_velho', stale_sources: [{ platform: 'Meta', name: 'Conta da Pizzaria', freshness: 'parado', last_read: expect.stringMatching(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/) }] });

    // Pedido fora do contrato, período invertido, marca de outra empresa e sem sessão.
    const pedir400 = await api.call('POST', '/v1/ai/explain/results', { cookie: d.cookie, body: { brand_id: d.brandId, from: PERIODO.from } });
    expect([pedir400.status, pedir400.body.code]).toEqual([400, 'validacao']);
    expect((await api.call('POST', '/v1/ai/explain/results', { cookie: d.cookie, body: { brand_id: d.brandId, ...PERIODO, extra: 1 } })).status).toBe(400);
    expect((await api.call('POST', '/v1/ai/explain/results', { cookie: d.cookie, body: { brand_id: d.brandId, from: '2026-10-02', to: '2026-10-01' } })).status).toBe(422);
    expect((await api.call('POST', '/v1/ai/explain/results', { cookie: semIa.cookie, body: { brand_id: d.brandId, ...PERIODO } })).status).toBe(404);
    expect((await api.call('POST', '/v1/ai/explain/results', { body: { brand_id: d.brandId, ...PERIODO } })).status).toBe(401);
    expect((await api.call('GET', '/v1/ai/status?brand_id=nao-e-id', { cookie: d.cookie })).status).toBe(400);

    // Com o Analista desligado para a empresa, a LIA não responde: a tela mostra o botão neutro.
    await ownerQuery(`insert into liame.agent_activation (id, tenant_id, agent_key, enabled, set_by, reason) values (gen_random_uuid(), $1, 'analista', false, 'testes', 'fora do plano')`, [d.tenantId]);
    expect((await api.call('GET', '/v1/ai/status', { cookie: d.cookie })).body).toEqual({ lia: false });
    const desligado = await api.call('POST', '/v1/ai/explain/results', { cookie: d.cookie, body: { brand_id: d.brandId, ...PERIODO } });
    expect(desligado.body).toMatchObject({ source: 'sistema', reason: 'funcionario_desligado' });
  });

  it('pela API: explica um aviso da Atenção com o que a tela recebeu dele; aviso sem explicação é 422 e aviso que sumiu, 404', async () => {
    const d = await donoComAviso();
    const aviso = await avisoDoCupom(d);
    responder(responde(JSON.stringify(BOA_DO_AVISO)));
    const r = await api.call('POST', '/v1/ai/explain/attention', { cookie: d.cookie, body: pedidoDoAviso(d, aviso) });
    expect(r.status).toBe(200);
    const corpo = ExplanationResponse.parse(r.body);
    expect(corpo).toMatchObject({ source: 'lia', reason: null, compared_to: null, stale_sources: [], explanation: { risk: 'medio' } });
    expect(corpo.period).toEqual({ from: janelaDoAviso().de, to: janelaDoAviso().ate });
    expect(corpo.numbers.map((n) => [n.value, n.sources[0]])).toEqual([
      ['7', 'Aviso da Atenção · o número está no texto do aviso'],
      ['R$ 80,00', expect.stringContaining('Meta · investimento da campanha "Delivery noite"')],
    ]);
    expect(corpo.explanation.what_happened.map((t) => t.text).join('')).toBe(BOA_DO_AVISO.o_que_aconteceu);

    const pedido = pedidoDoAviso(d, aviso);
    const semExplicacao = await api.call('POST', '/v1/ai/explain/attention', { cookie: d.cookie, body: { ...pedido, kind: 'conta_desconectada' } });
    expect([semExplicacao.status, semExplicacao.body.code]).toEqual([422, 'aviso-sem-explicacao']);
    const sumiu = await api.call('POST', '/v1/ai/explain/attention', { cookie: d.cookie, body: { ...pedido, campaign_id: randomUUID() } });
    expect([sumiu.status, sumiu.body.code]).toEqual([404, 'aviso-nao-encontrado']);
    // Fora do contrato: campo faltando, tipo que não é um identificador e campo a mais.
    expect((await api.call('POST', '/v1/ai/explain/attention', { cookie: d.cookie, body: { brand_id: d.brandId, kind: aviso.kind } })).status).toBe(400);
    expect((await api.call('POST', '/v1/ai/explain/attention', { cookie: d.cookie, body: { ...pedido, kind: 'Cupom sem uso' } })).status).toBe(400);
    expect((await api.call('POST', '/v1/ai/explain/attention', { cookie: d.cookie, body: { ...pedido, title: aviso.title } })).status).toBe(400);
    expect((await api.call('POST', '/v1/ai/explain/attention', { body: pedido })).status).toBe(401);
    // Outra empresa não explica o aviso desta.
    expect((await api.call('POST', '/v1/ai/explain/attention', { cookie: (await dono()).cookie, body: pedido })).status).toBe(404);
  });

  // ---------------------------------------------------------------- leitura da revisão da semana (I7)

  it('a leitura da revisão da semana: a mesma tarefa e o mesmo prompt, pedida pelo sistema (sem pessoa); quem vê as vendas dá o retorno', async () => {
    const d = await dono();
    responder(responde(JSON.stringify(BOA)));
    const resultados = api.app.get(ResultsService);
    const sistema = (tenantId: string) => ({ tenantId, userId: null, permissions: 'sistema' as const });
    // O worker lê os resultados das duas semanas como a empresa; a leitura é pedida depois, fora da transação.
    const ler = (e: Dono) =>
      naTransacaoDaEmpresa(database, { tenantId: e.tenantId, userId: null }, async () => ({
        atual: await resultados.closedLoop({ brand_id: e.brandId, ...PERIODO }),
        anterior: await resultados.closedLoop({ brand_id: e.brandId, from: '2026-09-04', to: '2026-09-17' }),
        ativo: await explicar.analistaLigado(sistema(e.tenantId), e.brandId),
      }));

    const r = await explicar.daSemana(sistema(d.tenantId), d.brandId, await ler(d));
    expect(r).toMatchObject({ origem: 'ia', motivo_sem_ia: null, explicacao: BOA, periodo: { de: '18/09/2026', ate: '01/10/2026' }, comparado_com: { de: '04/09/2026', ate: '17/09/2026' } });
    expect(await usos(d.tenantId)).toEqual([
      { workflow: 'revisao.semanal', task: TAREFA_EXPLICAR_RESULTADOS, prompt_version: `${PROMPT_EXPLICAR_RESULTADOS.key}@${PROMPT_EXPLICAR_RESULTADOS.version}`, outcome: 'ok', cost: 14_000 },
    ]);
    // A chamada é do sistema: a linha de uso não tem pessoa.
    expect(await ownerQuery<{ user_id: string | null }>(`select user_id from liame.ai_usage where id = $1`, [r.usage_id])).toEqual([{ user_id: null }]);

    // O retorno sobre a leitura da revisão é de quem vê as vendas na empresa (ninguém "pediu" essa leitura); de outra empresa, 404.
    const mandar = (cookie: string, body: Record<string, unknown>) => api.call('POST', '/v1/ai/feedback', { cookie, body });
    const sim = await mandar(d.cookie, { usage_id: r.usage_id, verdict: 'discordo', reasons: ['faltou'] });
    expect([sim.status, sim.body.verdict, sim.body.reasons]).toEqual([200, 'discordo', ['faltou']]);
    expect(await ownerQuery<{ user_id: string }>(`select user_id from liame.ai_feedback where usage_id = $1`, [r.usage_id])).toEqual([{ user_id: d.userId }]);
    const outra = await dono();
    expect((await mandar(outra.cookie, { usage_id: r.usage_id, verdict: 'fez_sentido' })).status).toBe(404);

    // Sem a LIA, a leitura é a do sistema e fala da semana: "à semana anterior", e não "ao período anterior".
    const desligada = await dono({ ia: false });
    const semIa = await explicar.daSemana(sistema(desligada.tenantId), desligada.brandId, await ler(desligada));
    expect(semIa).toMatchObject({ origem: 'sem_ia', motivo_sem_ia: 'desligada', usage_id: null });
    expect(semIa.explicacao.o_que_aconteceu).toContain('Em relação à semana anterior, o investimento subiu 100,0%.');
    expect(JSON.stringify(semIa.explicacao)).not.toContain('período anterior');
    // A mesma permissão da tela: uma leitura pedida por uma pessoa sem `vendas.ver` é recusada.
    await expect(explicar.daSemana({ tenantId: d.tenantId, userId: d.userId, permissions: new Set(['campanhas.ver']) }, d.brandId, await ler(d))).rejects.toMatchObject({ status: 403 });
  });

  // ---------------------------------------------------------------- retorno da pessoa

  it('retorno "Fez sentido" ou "Discordo": fica ligado à explicação, é só de quem pediu, regrava a mesma linha e não guarda dado pessoal', async () => {
    const d = await dono();
    responder(responde(JSON.stringify(BOA)));
    const explicacao = await api.call('POST', '/v1/ai/explain/results', { cookie: d.cookie, body: { brand_id: d.brandId, ...PERIODO } });
    const usageId = explicacao.body.usage_id as string;
    const retornos = () =>
      ownerQuery<{ verdict: string; reasons: string[]; comment: string | null; user_id: string; tenant_id: string }>(
        `select verdict, reasons, comment, user_id, tenant_id from liame.ai_feedback where usage_id = $1`,
        [usageId],
      );
    const mandar = (cookie: string | null, body: Record<string, unknown>) => api.call('POST', '/v1/ai/feedback', { cookie, body });

    const sim = await mandar(d.cookie, { usage_id: usageId, verdict: 'fez_sentido' });
    expect(sim.status).toBe(200);
    expect(sim.body).toEqual({ usage_id: usageId, verdict: 'fez_sentido', reasons: [], comment: null, updated_at: expect.any(String) });
    expect(await retornos()).toEqual([{ verdict: 'fez_sentido', reasons: [], comment: null, user_id: d.userId, tenant_id: d.tenantId }]);

    // Discordar pede pelo menos um motivo ou um comentário.
    const semMotivo = await mandar(d.cookie, { usage_id: usageId, verdict: 'discordo' });
    expect([semMotivo.status, semMotivo.body.code]).toEqual([422, 'motivo-obrigatorio']);
    expect((await mandar(d.cookie, { usage_id: usageId, verdict: 'discordo', comment: '   ' })).status).toBe(422);

    // Mudou de ideia: a mesma linha é regravada. Motivo repetido conta uma vez, e o contato sai do comentário.
    const nao = await mandar(d.cookie, { usage_id: usageId, verdict: 'discordo', reasons: ['numero', 'sugestao', 'numero'], comment: '  O gasto foi outro. Fale com a Maria: maria@cliente.com.br  ' });
    expect(nao.status).toBe(200);
    expect(nao.body).toMatchObject({ verdict: 'discordo', reasons: ['numero', 'sugestao'], comment: 'O gasto foi outro. Fale com a Maria: [email]' });
    expect(await retornos()).toEqual([{ verdict: 'discordo', reasons: ['numero', 'sugestao'], comment: 'O gasto foi outro. Fale com a Maria: [email]', user_id: d.userId, tenant_id: d.tenantId }]);
    // Só o comentário já basta.
    expect((await mandar(d.cookie, { usage_id: usageId, verdict: 'discordo', comment: 'Faltou falar do feriado.' })).body).toMatchObject({ reasons: [], comment: 'Faltou falar do feriado.' });
    // "Fez sentido" não leva motivo: o que vier junto é descartado.
    expect((await mandar(d.cookie, { usage_id: usageId, verdict: 'fez_sentido', reasons: ['motivo'], comment: 'não entra' })).body).toMatchObject({ verdict: 'fez_sentido', reasons: [], comment: null });
    expect(await retornos()).toEqual([{ verdict: 'fez_sentido', reasons: [], comment: null, user_id: d.userId, tenant_id: d.tenantId }]);

    // Só sobre uma explicação que a própria pessoa pediu: nem a de outra empresa, nem a de outra rotina do sistema, nem uma que não existe.
    const outra = await dono();
    expect([(await mandar(outra.cookie, { usage_id: usageId, verdict: 'discordo', reasons: ['motivo'] })).status, (await mandar(d.cookie, { usage_id: randomUUID(), verdict: 'fez_sentido' })).status]).toEqual([404, 404]);
    const doSistema = randomUUID();
    await ownerQuery(
      `insert into liame.ai_usage (id, tenant_id, workflow, task, provider, model, served_by, cost_usd_micros, outcome) values ($1, $2, 'sombra.rotina', 'teste_semente', 'teste', 'semente', 'principal', 0, 'ok')`,
      [doSistema, d.tenantId],
    );
    expect((await mandar(d.cookie, { usage_id: doSistema, verdict: 'fez_sentido' })).body).toMatchObject({ status: 404, code: 'explicacao-nao-encontrada' });
    // Fora do contrato: motivo desconhecido, comentário longo, veredito que não existe; e sem sessão.
    expect((await mandar(d.cookie, { usage_id: usageId, verdict: 'discordo', reasons: ['outro'] })).status).toBe(400);
    expect((await mandar(d.cookie, { usage_id: usageId, verdict: 'discordo', comment: 'x'.repeat(501) })).status).toBe(400);
    expect((await mandar(d.cookie, { usage_id: usageId, verdict: 'talvez' })).status).toBe(400);
    expect((await mandar(null, { usage_id: usageId, verdict: 'fez_sentido' })).status).toBe(401);
    expect(await retornos()).toHaveLength(1);

    // No banco: ninguém grava o retorno em nome de outra pessoa, e a outra empresa não lê o desta.
    const comoA = <T>(fn: Parameters<typeof withContext<T>>[2]) => withContext(database.db, { tenantId: d.tenantId, userId: d.userId }, fn);
    await expect(
      comoA((tx) => tx.execute(sql`insert into liame.ai_feedback (id, tenant_id, usage_id, user_id, verdict) values (gen_random_uuid(), ${d.tenantId}, ${doSistema}, ${outra.userId}, 'fez_sentido')`)),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    const vistos = await withContext(database.db, { tenantId: outra.tenantId, userId: outra.userId }, (tx) => tx.execute(sql`select id from liame.ai_feedback where usage_id = ${usageId}`));
    expect(vistos.rows).toEqual([]);
    // Apagar não é da aplicação.
    await expect(comoA((tx) => tx.execute(sql`delete from liame.ai_feedback where usage_id = ${usageId}`))).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
  });
});
