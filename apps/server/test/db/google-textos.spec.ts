import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations } from '@liame/database';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TAREFA_CRIATIVO_GOOGLE } from '../../src/ai/criativo/google.js';
import { ModelosIa } from '../../src/ai/modelos.js';
import { APP_CONFIG } from '../../src/config.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarIa, ModelosDeTeste, responde, rotaCompartilhada } from '../helpers/ia.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { hasDb, OWNER_URL } from './env.js';

// Os textos da campanha nova no Google pelo Criativo (A5 · Y9, parte 4; D-A5-22; P45, "Pedir ao Criativo"), com o
// modelo simulado: a proposta conferida volta inteira, sem o texto que não passa (que conta em Sua equipe, sem o texto);
// o que vai ao modelo é a oferta do pedido da peça e a peça aprovada; abaixo do mínimo do Google, sem IA; a recusa do
// Criativo; sem a IA ligada ou com o Criativo desligado, sem IA; a função desligada e a peça que não serve recusam antes
// de qualquer chamada.

type Empresa = { cookie: string; tenantId: string; brandId: string; userId: string };

const OFERTA = 'Combo sexta: smash, batata e refri por R$ 34,90';
const DOSSIE = {
  identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' },
  voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' },
  products: { items: ['Smash Clássico R$ 29,90'] },
  offers: { items: [OFERTA] },
  forbidden: { items: [{ text: 'o melhor hambúrguer do Rio', why: 'não temos como provar' }] },
  region: { area: 'Centro e Lapa', pickup: true },
};
const BOA = {
  recusa: null,
  titulos: ['Combo sexta: R$ 34,90', 'Smash, batata e refri', 'Sexta é dia de combo', 'Peça no cardápio online', 'O smash sai da chapa'],
  titulos_longos: ['Sexta é dia de combo: smash, batata e refri por R$ 34,90'],
  descricoes: ['Smash, batata e refri por R$ 34,90 às sextas. Peça pelo cardápio online.', 'O smash sai da chapa com batata e refri. É só escolher no cardápio.', 'Combo de sexta da casa, para pedir pelo cardápio online.'],
};

describe.skipIf(!hasDb)('os textos do Google pelo Criativo (Y9, parte 4)', () => {
  let api: TestApi;
  let flags: FlagService;
  let modelos: ModelosDeTeste;
  let alvo: Awaited<ReturnType<typeof rotaCompartilhada>>;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    flags = api.app.get(FlagService);
    modelos = new ModelosDeTeste(api.app.get(APP_CONFIG));
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    alvo = await rotaCompartilhada(modelos, TAREFA_CRIATIVO_GOOGLE, new MockLanguageModelV4({ doGenerate: [] }));
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  async function empresa(nome: string, o: { ia?: boolean; google?: boolean; criativo?: boolean } = {}): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    if (o.google !== false) await ligarFlagDaEmpresa(api, 'campanha_google', tenantId, true);
    if (o.criativo !== false) await ligarFlagDaEmpresa(api, 'criativo', tenantId, true);
    if (o.ia !== false) await ligarIa(flags, tenantId);
    const salvo = await api.call('PUT', '/v1/brand-dossier', { cookie: s.cookie, body: { brand_id: brandId, base_version: 0, content: DOSSIE } });
    if (salvo.status !== 200) throw new Error(`dossiê não salvo: ${salvo.status} ${JSON.stringify(salvo.body)}`);
    return { cookie: s.cookie, tenantId, brandId, userId: s.me.user.id as string };
  }

  /** Uma peça da marca, na situação dada, com a oferta no pedido dela. */
  async function peca(e: Empresa, status = 'aprovada'): Promise<string> {
    const pedido = randomUUID();
    const id = randomUUID();
    await ownerQuery(
      `insert into liame.ad_piece_request (id, tenant_id, brand_id, offer, dossier_version, destination, variations, status) values ($1, $2, $3, $4, 1, 'cardapio', 1, 'concluido')`,
      [pedido, e.tenantId, e.brandId, OFERTA],
    );
    await ownerQuery(
      `insert into liame.ad_piece (id, tenant_id, brand_id, request_id, status, version, review_status, decided_by, decided_at) values ($1, $2, $3, $4, $5, 1, 'passou', $6, now())`,
      [id, e.tenantId, e.brandId, pedido, status, e.userId],
    );
    await ownerQuery(
      `insert into liame.ad_piece_version (id, tenant_id, piece_id, version, title, body, button, review, review_status, rules_version, content_hash, author)
       values ($1, $2, $3, 1, 'Sexta é dia de combo', 'Smash, batata e refri por R$ 34,90. Peça pelo cardápio online.', 'pedir_agora', '{}'::jsonb, 'passou', '{}'::jsonb, $4, 'criativo')`,
      [randomUUID(), e.tenantId, id, randomBytes(32).toString('hex')],
    );
    return id;
  }

  const responder = (r: Record<string, unknown>) => {
    const mock = responde(JSON.stringify(r));
    modelos.porChave.set(`${alvo.provider}/${alvo.model}`, mock);
    return mock;
  };
  const pedir = (e: Empresa, piece: string, brand = e.brandId) => api.call('POST', '/v1/google-campaigns/texts', { cookie: e.cookie, body: { brand_id: brand, piece_id: piece } });

  it('a proposta conferida volta sem o texto que não passa, que conta em Sua equipe; o modelo recebe a oferta e a peça', async () => {
    const e = await empresa('Brasa Textos do Google');
    const p = await peca(e);
    const mock = responder({ ...BOA, titulos: [...BOA.titulos, 'O melhor hambúrguer do Rio'] });
    const r = await pedir(e, p);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toEqual({
      origin: 'ia',
      reason: null,
      texts: { headlines: BOA.titulos, long_headlines: BOA.titulos_longos, descriptions: BOA.descricoes },
      dropped: 1,
      retry_at: null,
      usage_id: expect.any(String),
    });
    const enviado = JSON.stringify(mock.doGenerateCalls[0]!.prompt);
    expect(enviado).toContain(OFERTA);
    expect(enviado).toContain('Sexta é dia de combo');
    expect(enviado).toContain('Hamburgueria de bairro');
    // O texto barrado conta em Sua equipe, sem o texto.
    const recusas = await ownerQuery<{ member: string; workflow: string; kind: string; rules: string[]; items: number }>(
      `select member, workflow, kind, rules, items from liame.ai_refusal where usage_id = $1`,
      [r.body.usage_id],
    );
    expect(recusas).toEqual([{ member: 'criativo', workflow: 'criativo.google', kind: 'compliance', rules: ['regra_da_marca'], items: 1 }]);
  }, 120_000);

  it('abaixo do mínimo, sem IA; a recusa do Criativo; sem a IA ou sem o Criativo; a função desligada e a peça que não serve recusam', async () => {
    const e = await empresa('Brasa Textos Google Recusas');
    const p = await peca(e);
    // Barrados pelo Compliance até ficar abaixo do mínimo: `barrado`; poucos sem barrar: `formato`.
    responder({ ...BOA, titulos: ['Combo sexta: R$ 34,90', 'O melhor hambúrguer do Rio', 'Combo por R$ 9,90'] });
    expect((await pedir(e, p)).body).toMatchObject({ origin: 'sem_ia', reason: 'barrado', texts: null, dropped: 2, usage_id: expect.any(String) });
    responder({ ...BOA, descricoes: ['Peça pelo cardápio online.'] });
    expect((await pedir(e, p)).body).toMatchObject({ origin: 'sem_ia', reason: 'formato', texts: null });
    responder({ recusa: 'bebida_alcoolica', titulos: [], titulos_longos: [], descricoes: [] });
    expect((await pedir(e, p)).body).toMatchObject({ origin: 'sem_ia', reason: 'recusa', texts: null, dropped: 0 });

    const semIa = await empresa('Brasa Textos Google Sem IA', { ia: false });
    expect((await pedir(semIa, await peca(semIa))).body).toMatchObject({ origin: 'sem_ia', reason: 'ia_desligada', texts: null });
    const semCriativo = await empresa('Brasa Textos Google Sem Criativo', { criativo: false });
    expect((await pedir(semCriativo, await peca(semCriativo))).body).toMatchObject({ origin: 'sem_ia', reason: 'funcionario_desligado', texts: null });

    const desligada = await empresa('Brasa Textos Google Desligada', { google: false });
    expect((await pedir(desligada, await peca(desligada))).body.code).toBe('funcao-desligada');
    expect((await pedir(e, await peca(e, 'decidir'))).body.code).toBe('peca-nao-aprovada');
    expect((await pedir(e, await peca(desligada))).body.code).toBe('peca-nao-encontrada');
  }, 180_000);
});
