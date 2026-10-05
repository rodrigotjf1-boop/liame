import { resolve } from 'node:path';
import { AdPieceListResponse, AdPieceOptionsResponse, AdPieceResponse } from '@liame/contracts';
import { type Database, runMigrations } from '@liame/database';
import { MockLanguageModelV4 } from 'ai/test';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TAREFA_CRIATIVO_TEXTO, WORKFLOW_DO_CRIATIVO } from '../../src/ai/criativo/prompt.js';
import { AiGateway } from '../../src/ai/gateway.js';
import { ModelosIa } from '../../src/ai/modelos.js';
import { APP_CONFIG } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { ResultsService } from '../../src/results/results.service.js';
import { CriativoLoop } from '../../src/worker/criativo-loop.js';
import { CriativoService } from '../../src/worker/criativo.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { ligarCriativo, ligarIa, ModelosDeTeste, responde, rotaCompartilhada, uso } from '../helpers/ia.js';
import { hasDb, OWNER_URL } from './env.js';

// O custo das peças do Criativo à vista (A4, X6; D-A4-32): antes de pedir, o uso de IA da empresa e a estimativa do
// pedido; o pedido que não cabe no que resta do limite é negado na hora; decidir sobre o que já existe não depende do
// limite; e cada versão traz a parte dela no custo da chamada que a escreveu. Com o modelo simulado.

const OFERTA = 'Combo sexta: smash, batata e refri por R$ 34,90';
const DOSSIE = {
  identity: { summary: 'Hamburgueria de bairro com smash feito na chapa', audience: 'Quem mora ou trabalha no Centro', differentiator: 'Pão feito na casa todo dia', since: '2019' },
  voice: { traits: ['Direta'], rules: ['Frases curtas.'], do_example: 'Bateu a fome? O smash sai da chapa rapidinho.', dont_example: '' },
  products: { items: ['Smash Clássico R$ 29,90'] },
  offers: { items: [OFERTA] },
  forbidden: { items: [{ text: 'gourmet', why: 'não combina com a casa' }] },
  region: { area: 'Centro e Lapa', pickup: true },
};
const BOA = { titulo: 'Sexta é dia de combo', texto: 'Smash, batata e refri por R$ 34,90. Peça pelo cardápio e retire no balcão.', botao: 'pedir_agora' };
const OUTRA = { titulo: 'Combo sexta por R$ 34,90', texto: 'Smash na chapa, batata e refri por R$ 34,90. É só pedir pelo cardápio.', botao: 'ver_cardapio' };
/** O teto de custo da rota de teste da tarefa (`rotaCompartilhada`): é a estimativa enquanto a empresa não tem histórico. */
const TETO_DA_ROTA = 1_000_000;

describe.skipIf(!hasDb)('Peças do Criativo: o custo à vista (A4, X6; D-A4-32)', () => {
  let api: TestApi;
  let database: Database;
  let flags: FlagService;
  let modelos: ModelosDeTeste;
  let alvo: { provider: string; model: string };
  let loop: CriativoLoop;

  type Dono = { cookie: string; tenantId: string; userId: string; brandId: string };
  type Peca = ReturnType<typeof AdPieceResponse.parse>;

  async function dono(): Promise<Dono> {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria do Custo');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    await ligarIa(flags, tenantId);
    await ligarCriativo(flags, tenantId);
    const d = { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId };
    const salvo = await api.call('PUT', '/v1/brand-dossier', { cookie: d.cookie, body: { brand_id: d.brandId, base_version: 0, content: DOSSIE } });
    if (salvo.status !== 200) throw new Error(`dossiê não salvo: ${salvo.status} ${JSON.stringify(salvo.body)}`);
    return d;
  }

  async function membro(d: Dono, role: string): Promise<{ cookie: string }> {
    const email = uniqueEmail(role);
    const body: Record<string, unknown> = { email, role };
    if (['administrador', 'gestor', 'aprovador'].includes(role)) body.approve_limit_micros = 1_000_000;
    expect((await api.call('POST', '/v1/invitations', { cookie: d.cookie, body })).status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${role}`, password: PASSWORD, terms_version: TERMOS } });
    if (!s.cookie) throw new Error(`convite não aceito: ${s.status} ${JSON.stringify(s.body)}`);
    await enableMfa(api, s.cookie);
    return { cookie: s.cookie };
  }

  /** O teto de IA da empresa (quem define é a distribuição): o do dia e o do mês, em micros de dólar. */
  const definirTeto = (d: Dono, dia: number, mes: number) =>
    ownerQuery(
      `insert into liame.ai_budget (tenant_id, daily_usd_micros, monthly_usd_micros, set_by, reason) values ($1, $2, $3, 'testes', 'teste do custo à vista')
       on conflict (tenant_id) do update set daily_usd_micros = excluded.daily_usd_micros, monthly_usd_micros = excluded.monthly_usd_micros`,
      [d.tenantId, dia, mes],
    );
  /** O que as chamadas do Criativo desta empresa custaram, da mais nova para a mais antiga. */
  const custos = async (d: Dono) =>
    (await ownerQuery<{ custo: string }>(`select cost_usd_micros::text as custo from liame.ai_usage where tenant_id = $1 and workflow = $2 and answered order by occurred_at desc`, [d.tenantId, WORKFLOW_DO_CRIATIVO])).map((l) =>
      Number(l.custo),
    );
  const opcoes = async (d: Dono, cookie = d.cookie) => AdPieceOptionsResponse.parse((await api.call('GET', `/v1/ad-pieces/options?brand_id=${d.brandId}`, { cookie })).body);
  const pedir = (d: Dono, variations = 1) =>
    api.call('POST', '/v1/ad-pieces/requests', { cookie: d.cookie, body: { brand_id: d.brandId, offer: OFERTA, destination: 'cardapio', variations } });
  const responder = (...pecas: Array<Record<string, unknown>>) => modelos.porChave.set(`${alvo.provider}/${alvo.model}`, responde(JSON.stringify({ recusa: null, pecas }), uso(2000, 300)));
  const rodarFila = (d: Dono) => loop.executarLote(10, { tenantIds: [d.tenantId] });
  const lista = async (d: Dono) => AdPieceListResponse.parse((await api.call('GET', `/v1/ad-pieces?brand_id=${d.brandId}`, { cookie: d.cookie })).body).items;

  /** Um pedido atendido de ponta a ponta: a rota aceita, o Criativo (o modelo simulado) escreve, as peças ficam para decidir. */
  async function pedidoAtendido(d: Dono, ...pecas: Array<Record<string, unknown>>): Promise<void> {
    const r = await pedir(d, pecas.length);
    if (r.status !== 202) throw new Error(`pedido não aceito: ${r.status} ${JSON.stringify(r.body)}`);
    responder(...pecas);
    expect((await rodarFila(d))[0]).toMatchObject({ status: 'concluido' });
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = api.app.get(DATABASE);
    flags = api.app.get(FlagService);
    modelos = new ModelosDeTeste(api.app.get(APP_CONFIG));
    api.app.get(ModelosIa).modelo = (provider, model) => modelos.modelo(provider, model);
    loop = new CriativoLoop(database, flags, new CriativoService(database, api.app.get(AiGateway), api.app.get(ResultsService)));
    // A rota desta tarefa é dividida com `pecas.spec.ts` e `pecas-decisoes.spec.ts`: nome e teto fixos, ninguém apaga (V76).
    alvo = await rotaCompartilhada(modelos, TAREFA_CRIATIVO_TEXTO, new MockLanguageModelV4({ doGenerate: [] }));
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
  });

  it('as opções trazem o uso de IA da empresa e a estimativa do pedido: sem histórico, o teto da rota; com três pedidos, a média deles', async () => {
    const d = await dono();
    await definirTeto(d, 5_000_000, 50_000_000);

    // Antes do primeiro pedido: nada gasto, e a estimativa é o máximo que um pedido deve custar.
    const antes = await opcoes(d);
    expect(antes).toMatchObject({ available: true, reason: null });
    expect(antes.ai).toEqual({
      band: 'livre',
      day: { spent_usd_micros: '0', ceiling_usd_micros: '5000000' },
      month: { spent_usd_micros: '0', ceiling_usd_micros: '50000000' },
      remaining_usd_micros: '5000000',
      binding: 'dia',
      pieces_today_usd_micros: '0',
      request_estimate: { usd_micros: String(TETO_DA_ROTA), basis: 'teto_da_rota', sample: 0 },
      fits: true,
    });

    // Dois pedidos atendidos ainda não fazem média: segue o teto da rota, e o gasto do dia já conta os dois.
    await pedidoAtendido(d, BOA);
    await pedidoAtendido(d, OUTRA);
    const comDois = await opcoes(d);
    const doisCustos = await custos(d);
    expect(doisCustos).toHaveLength(2);
    expect(doisCustos.every((c) => c > 0)).toBe(true);
    const gastoDeDois = doisCustos.reduce((a, b) => a + b, 0);
    expect(comDois.ai).toMatchObject({
      day: { spent_usd_micros: String(gastoDeDois) },
      month: { spent_usd_micros: String(gastoDeDois) },
      remaining_usd_micros: String(5_000_000 - gastoDeDois),
      pieces_today_usd_micros: String(gastoDeDois),
      request_estimate: { usd_micros: String(TETO_DA_ROTA), basis: 'teto_da_rota', sample: 0 },
      fits: true,
    });

    // Com o terceiro, a estimativa passa a ser a média do que os pedidos da própria empresa custaram.
    await pedidoAtendido(d, { ...BOA, titulo: 'Hoje tem combo de sexta' });
    const tresCustos = await custos(d);
    const media = Math.round(tresCustos.reduce((a, b) => a + b, 0) / 3);
    const comTres = await opcoes(d);
    expect(comTres.ai!.request_estimate).toEqual({ usd_micros: String(media), basis: 'historico', sample: 3 });
    expect(comTres.ai!.fits).toBe(true);
    expect(media).toBeLessThan(TETO_DA_ROTA);

    // O custo é de quem pode pedir: quem só vê as campanhas não recebe o gasto de IA da empresa; o gestor recebe.
    const leitor = await membro(d, 'somente_leitura');
    expect(await opcoes(d, leitor.cookie)).toMatchObject({ ai: null, usd_brl: null });
    const gestor = await membro(d, 'gestor');
    expect((await opcoes(d, gestor.cookie)).ai).toMatchObject({ request_estimate: { basis: 'historico', sample: 3 } });

    // O que outra empresa gastou não entra: uma empresa nova começa do zero, com o teto da rota.
    const outra = await dono();
    expect((await opcoes(outra)).ai).toMatchObject({ day: { spent_usd_micros: '0' }, pieces_today_usd_micros: '0', request_estimate: { basis: 'teto_da_rota', sample: 0 } });
  });

  it('o pedido que não cabe no que resta do limite é negado na hora; decidir continua valendo; a versão traz a parte dela no custo', async () => {
    const d = await dono();
    await definirTeto(d, 5_000_000, 50_000_000);
    await pedidoAtendido(d, BOA, OUTRA);
    const [custoDaChamada] = await custos(d);
    const pecas = await lista(d);
    expect(pecas).toHaveLength(2);
    // Uma chamada escreveu as duas peças: cada versão leva metade do custo dela.
    for (const p of pecas) expect(p.current.cost_usd_micros).toBe(String(Math.floor(custoDaChamada! / 2)));
    const [boa, outra] = [pecas.find((p) => p.current.title === BOA.titulo)!, pecas.find((p) => p.current.title === OUTRA.titulo)!] as [Peca, Peca];

    // O limite do dia fica com menos do que a estimativa (sem histórico, o teto da rota): não dá para pedir.
    await definirTeto(d, custoDaChamada! + 500_000, 50_000_000);
    const o = await opcoes(d);
    expect(o).toMatchObject({ available: false, reason: 'limite_de_ia' });
    expect(o.ai).toMatchObject({ remaining_usd_micros: '500000', binding: 'dia', request_estimate: { usd_micros: String(TETO_DA_ROTA), basis: 'teto_da_rota' }, fits: false });
    const negado = await pedir(d);
    expect(negado.body).toMatchObject({ status: 409, code: 'limite-de-ia', title: 'O pedido não cabe no limite de uso de IA de hoje' });
    expect(negado.body.detail).toContain('O pedido custa até US$ 1,00, e restam US$ 0,50.');
    // Pedir outra versão também é um pedido à IA.
    const outraVersao = await api.call('POST', `/v1/ad-pieces/${boa.id}/redo`, { cookie: d.cookie, body: { content_hash: boa.current.content_hash } });
    expect(outraVersao.body).toMatchObject({ status: 409, code: 'limite-de-ia' });
    // Nada foi para a fila, e nenhuma chamada nova foi feita.
    expect(await rodarFila(d)).toEqual([]);
    expect(await custos(d)).toHaveLength(1);

    // Decidir sobre o que já existe não depende do limite: editar (a versão da pessoa não tem custo de IA) e aprovar.
    const editada = AdPieceResponse.parse(
      (await api.call('PUT', `/v1/ad-pieces/${boa.id}`, { cookie: d.cookie, body: { base_version: 1, title: 'Sexta tem combo', body: boa.current.body, button: boa.current.button } })).body,
    );
    expect(editada.current).toMatchObject({ version: 2, author: 'pessoa', cost_usd_micros: null });
    expect(editada.versions!.map((v) => [v.version, v.cost_usd_micros])).toEqual([
      [2, null],
      [1, String(Math.floor(custoDaChamada! / 2))],
    ]);
    expect((await api.call('POST', `/v1/ad-pieces/${outra.id}/approve`, { cookie: d.cookie, body: { content_hash: outra.current.content_hash } })).status).toBe(200);

    // Com o limite revisto, o pedido volta a caber.
    await definirTeto(d, 5_000_000, 50_000_000);
    expect(await opcoes(d)).toMatchObject({ available: true, reason: null, ai: { fits: true } });
    expect((await pedir(d)).status).toBe(202);
  });
});
