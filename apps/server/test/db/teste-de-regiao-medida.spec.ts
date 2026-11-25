import { randomInt, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ResultadoDoTesteDeRegiao } from '../../src/campanhas/teste-regiao-plano.js';
import { loadConfig } from '../../src/config.js';
import { registrarConexaoDaDistribuicao } from '../../src/connections/distribuicao.js';
import { chaveDe } from '../../src/connectors/cota.js';
import { diaNoFuso } from '../../src/coupons/plataforma.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { type ResultadoDaMedida, TestesDeRegiaoRotina } from '../../src/worker/testes-de-regiao.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { hasDb } from './env.js';

// Plano da região, R8: a medida do teste de região (D-RG-81, D-RG-82 e D-RG-102), contra Postgres e um Regem de mentira
// que devolve os pedidos de entrega por bairro (`GET {base}/pedidos/bairros`, o contrato da R3) de cada loja. O que se prova:
//   - o teste `terminado`, sem resultado e com o fim antes de hoje, ganha o resultado pelos pedidos dos 14 dias (a janela
//     pedida ao Regem), uma vez, com os bairros que ficaram e os pedidos de cada um, antes e durante, e a API mostra;
//     rodar de novo não lê o Regem nem muda o resultado;
//   - o teste rodando, o interrompido, o que acabou hoje e o de outra empresa (fora do escopo) não são tocados;
//   - a leitura que falha não grava e o teste volta depois da espera; passados 7 dias do fim, fica "sem leitura"; a empresa
//     cujo Regem falha não para a outra;
//   - a Atenção mostra o resultado medido, só informação, por 14 dias depois da medida (D-RG-102 e D-RG-94).
// As datas são relativas a hoje no fuso da loja (ERR-237), com o mesmo relógio na rotina (V89).

const FUSO = 'America/Sao_Paulo';
const AGORA = new Date();
const HOJE = diaNoFuso(AGORA, FUSO);
const dia = (n: number) => new Date(Date.parse(`${HOJE}T12:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const TOKEN_A = `rgm_it_${'m'.repeat(32)}`;
const TOKEN_B = `rgm_it_${'n'.repeat(32)}`;
const PROBLEMA = 'https://api.dmsregem.com/problemas/';

/** As 4 semanas de antes que a pessoa viu no pedido: a Lapa (o bairro do teste) e os de comparar. */
const ANTES = [
  { nome: 'Centro', pedidos: 1000 },
  { nome: 'Lapa', pedidos: 480 },
  { nome: 'Glória', pedidos: 412 },
  { nome: 'Saúde', pedidos: 300 },
];
/** Os 14 dias do teste no Regem: a Lapa caiu, os outros seguiram; a Barra não estava antes, e o Centro de Niterói é de outra cidade. */
const DURANTE = [
  { bairro: 'Centro', cidade: 'Rio de Janeiro', uf: 'RJ', pedidos: 520, receita_micros: '26000000000' },
  { bairro: 'LAPA', cidade: 'Rio de Janeiro', uf: 'RJ', pedidos: 168, receita_micros: '8400000000' },
  { bairro: 'Gloria', cidade: 'Rio de Janeiro', uf: 'RJ', pedidos: 210, receita_micros: '10500000000' },
  { bairro: 'Saúde', cidade: 'Rio de Janeiro', uf: 'RJ', pedidos: 150, receita_micros: '7500000000' },
  { bairro: 'Barra', cidade: 'Rio de Janeiro', uf: 'RJ', pedidos: 40, receita_micros: '2000000000' },
  { bairro: 'Centro', cidade: 'Niterói', uf: 'RJ', pedidos: 70, receita_micros: '3500000000' },
];

type Empresa = { cookie: string; tenantId: string; brandId: string; unitId: string; anuncios: string; loja: string };

describe.skipIf(!hasDb)('a medida do teste de região (plano da região, R8)', () => {
  let api: TestApi;
  let database: Database;
  let rotina: TestesDeRegiaoRotina;
  let regem: Server;
  let base = '';
  const anterior: Record<string, string | undefined> = {};
  let a: Empresa;
  let b: Empresa;
  /** O teste terminado da empresa B, criado no primeiro caso e medido no segundo, quando o Regem dela volta. */
  let doB = '';
  /** As lojas com o município de mentira: o endereço sai no fim (V190). */
  const lojasCriadas: string[] = [];

  // ---- o Regem de mentira: as duas lojas, cada uma com o seu token; a da empresa B pode cair (503).
  const lojas: Record<string, { loja_id: string; loja_nome: string }> = {
    [TOKEN_A]: { loja_id: `loja-medida-a-${randomUUID().slice(0, 8)}`, loja_nome: 'Brasa — Loja Centro' },
    [TOKEN_B]: { loja_id: `loja-medida-b-${randomUUID().slice(0, 8)}`, loja_nome: 'Fornalha — Loja Centro' },
  };
  const estado = { caiB: true };
  /** As leituras dos bairros que chegaram, com a loja e a janela (cada tentativa conta). */
  const leituras: Array<{ loja: string; de: string | null; ate: string | null }> = [];

  function responder(req: IncomingMessage): { status: number; corpo: unknown } {
    const url = new URL(req.url ?? '/', base);
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const loja = lojas[token];
    if (!loja) return { status: 401, corpo: { type: `${PROBLEMA}token-invalido`, title: 'Token inválido', status: 401 } };
    if (url.pathname === '/regem/loja') return { status: 200, corpo: { ...loja, empresa_nome: loja.loja_nome, fuso: FUSO, moeda: 'BRL', escopos: ['pedidos.ler', 'cupons.ler'] } };
    if (url.pathname === '/regem/pedidos/bairros') {
      const [de, ate] = [url.searchParams.get('de'), url.searchParams.get('ate')];
      leituras.push({ loja: loja.loja_id, de, ate });
      if (token === TOKEN_B && estado.caiB) return { status: 503, corpo: { type: 'about:blank', title: 'Indisponível', status: 503 } };
      return {
        status: 200,
        corpo: {
          loja_id: loja.loja_id,
          de,
          ate,
          fuso: FUSO,
          minimo: 5,
          bairros: DURANTE,
          outros: { bairros: 3, pedidos: 9, receita_micros: '450000000' },
          sem_bairro: { pedidos: 4, receita_micros: '200000000' },
          retirada_e_balcao: { pedidos: 30 },
        },
      };
    }
    return { status: 404, corpo: { type: 'about:blank', title: 'Não encontrado', status: 404 } };
  }

  /** Uma empresa com a loja no Rio, ligada ao Regem pela distribuição, a conta de anúncios e a função do teste ligada. */
  async function empresa(nome: string, token: string): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    const unitId = randomUUID();
    // O município começa com 9 (a R2 não apaga) e sai no fim do arquivo (V190): a medida só usa a cidade do endereço.
    await ownerQuery(
      `insert into liame.unit (id, tenant_id, brand_id, name, address_postal_code, address_city, address_state, ibge_city_code, location_source, timezone)
       values ($1, $2, $3, 'Loja Centro', '20040002', 'Rio de Janeiro', 'RJ', $4, 'cep', $5)`,
      [unitId, tenantId, brandId, String(randomInt(9_100_000, 9_999_999)), FUSO],
    );
    lojasCriadas.push(unitId);
    const r = await registrarConexaoDaDistribuicao({ db: database.db, vault: api.app.get(VaultService), config: loadConfig() }, { tenantId, brandId, produto: 'regem', tokens: [token] });
    const ligar = await api.call('POST', `/v1/connections/${r.connectionId}/accounts`, {
      cookie: s.cookie,
      body: { accounts: [{ provider: 'regem', external_id: lojas[token]!.loja_id, unit_id: unitId }] },
    });
    expect(ligar.status, JSON.stringify(ligar.body)).toBe(200);
    const anuncios = randomUUID();
    await ownerQuery(`insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone) values ($1, $2, $3, 'meta_ads', $4, 'CA', 'BRL', $5)`, [
      anuncios,
      tenantId,
      brandId,
      randomUUID(),
      FUSO,
    ]);
    await ownerQuery(
      `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, rollout_percent, created_by)
       values (gen_random_uuid(), 'teste_de_regiao', 'tenant', $1, 'true'::jsonb, null, 'testes')`,
      [tenantId],
    );
    return { cookie: s.cookie, tenantId, brandId, unitId, anuncios, loja: lojas[token]!.loja_id };
  }

  /** Um teste de região na situação pedida, com o plano que o pedido grava (a Lapa e as 4 semanas de antes). */
  async function teste(e: Empresa, situacao: string, inicio: string | null, fim: string | null): Promise<string> {
    const id = randomUUID();
    const plano = {
      teste: id,
      marca: e.brandId,
      loja: { id: e.unitId, nome: 'Loja Centro' },
      fuso: FUSO,
      bairro: { codigo: '3304557017', nome: 'Lapa', meta: null, latitude: -22.9133, longitude: -43.1825, raio_km: 1 },
      dias: 14,
      semanas: { de: dia(60), ate: dia(33), bairros: ANTES },
      conjuntos: [{ campanha: '120210000000000001', conjunto: '120210000000000101', nome: 'Raio de 3 km', impressao: 'a'.repeat(64) }],
    };
    await ownerQuery(
      `insert into liame.campaign_test (id, tenant_id, brand_id, unit_id, ad_account_id, kind, status, name, min_days, max_days, plan, started_on, ended_on, updated_at)
       values ($1, $2, $3, $4, $5, 'regiao', $6, 'Lapa sem anúncio por 14 dias', 14, 14, $7::jsonb, $8::date, $9::date, now() - interval '2 hours')`,
      [id, e.tenantId, e.brandId, e.unitId, e.anuncios, situacao, JSON.stringify(plano), inicio, fim],
    );
    return id;
  }

  const linhaDe = async (id: string) => (await ownerQuery<{ result: unknown; updated_at: Date; status: string }>(`select result, updated_at, status from liame.campaign_test where id = $1`, [id]))[0]!;
  const emOrdem = (r: ResultadoDaMedida[]) => [...r].sort((x, y) => (x.teste < y.teste ? -1 : 1));

  beforeAll(async () => {
    regem = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const r = responder(req);
        res.writeHead(r.status, { 'content-type': r.status >= 400 ? 'application/problem+json' : 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => regem.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(regem.address() as AddressInfo).port}`;
    anterior.REGEM_API_URL = process.env.REGEM_API_URL;
    process.env.REGEM_API_URL = `${base}/regem`;
    api = await startApi();
    await resetIpRateLimits();
    database = api.app.get(DATABASE);
    const flags = api.app.get(FlagService);
    a = await empresa('Brasa Teste Medida', TOKEN_A);
    b = await empresa('Fornalha Teste Medida', TOKEN_B);
    flags.invalidate();
    rotina = new TestesDeRegiaoRotina(database, loadConfig(), api.app.get(VaultService), flags);
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    if (lojasCriadas.length) {
      await ownerQuery(
        `update liame.unit set address_postal_code = null, address_city = null, address_state = null, ibge_city_code = null, location_source = null where id = any($1::uuid[])`,
        [lojasCriadas],
      );
    }
    await api?.close();
    await new Promise((ok) => regem?.close(ok));
    if (anterior.REGEM_API_URL === undefined) delete process.env.REGEM_API_URL;
    else process.env.REGEM_API_URL = anterior.REGEM_API_URL;
  });

  it('o teste terminado ganha o resultado uma vez, pelos 14 dias no Regem; o rodando, o interrompido, o que acabou hoje e a outra empresa ficam como estão', async () => {
    const terminado = await teste(a, 'terminado', dia(16), dia(3));
    const rodando = await teste(a, 'rodando', dia(10), null);
    const interrompido = await teste(a, 'interrompido', dia(20), dia(3));
    const deHoje = await teste(a, 'terminado', dia(13), HOJE);
    doB = await teste(b, 'terminado', dia(16), dia(3));
    const intocados = [rodando, interrompido, deHoje, doB];
    const antes = await Promise.all(intocados.map(linhaDe));

    const r = await rotina.executarLote(10, { tenantIds: [a.tenantId] }, AGORA);
    expect(r).toEqual([{ tenantId: a.tenantId, teste: terminado, situacao: 'medido', motivo: null }]);
    // A janela pedida ao Regem: do primeiro dia sem anúncio ao 14º.
    expect(leituras).toEqual([{ loja: a.loja, de: dia(16), ate: dia(3) }]);
    const guardado = ResultadoDoTesteDeRegiao.parse((await linhaDe(terminado)).result);
    expect(guardado).toMatchObject({
      janela: { de: dia(16), ate: dia(3) },
      // O Centro de Niterói e a Barra (que não estava antes) ficam de fora; "LAPA" e "Gloria" casam com a Lapa e a Glória.
      pedidos: { alvoAntes: 480, outrosAntes: 1712, alvoDurante: 168, outrosDurante: 880 },
      // Cada bairro que ficou, com o nome do pedido e os pedidos das 4 semanas de antes e dos 14 dias no Regem.
      bairros: [
        { nome: 'Centro', antes: 1000, durante: 520 },
        { nome: 'Glória', antes: 412, durante: 210 },
        { nome: 'Saúde', antes: 300, durante: 150 },
      ],
      motivo: null,
      esperadoPorSemana: null,
      minimoDoRegem: 5,
      medido_em: AGORA.toISOString(),
    });
    expect(guardado.efeito).toMatchObject({ feitoPorSemana: 84, provou: true });
    expect(await Promise.all(intocados.map(linhaDe))).toEqual(antes);
    expect((await linhaDe(terminado)).status).toBe('terminado');

    // A API mostra o resultado no formato do contrato; o teste ainda sem medida mostra nulo.
    const lido = await api.call('GET', `/v1/region-tests/${terminado}`, { cookie: a.cookie });
    expect(lido.status, JSON.stringify(lido.body)).toBe(200);
    expect(lido.body.result).toEqual({
      window: { from: dia(16), to: dia(3) },
      orders: { target_before: 480, others_before: 1712, target_during: 168, others_during: 880 },
      districts: [
        { name: 'Centro', orders_before: 1000, orders_during: 520 },
        { name: 'Glória', orders_before: 412, orders_during: 210 },
        { name: 'Saúde', orders_before: 300, orders_during: 150 },
      ],
      effect: {
        expected_per_week: guardado.efeito!.esperadoPorSemana,
        actual_per_week: 84,
        brings_per_week: guardado.efeito!.trazPorSemana,
        range: { from: guardado.efeito!.faixa.de, to: guardado.efeito!.faixa.ate },
        proven: true,
      },
      reason: null,
      expected_per_week: null,
      regem_minimum: 5,
      measured_at: AGORA.toISOString(),
    });
    expect((await api.call('GET', `/v1/region-tests/${rodando}`, { cookie: a.cookie })).body.result).toBeNull();

    // De novo, com a espera vencida: o teste medido não volta à fila, o Regem não é lido e o resultado não muda.
    await ownerQuery(`update liame.campaign_test set updated_at = now() - interval '2 hours' where id = $1`, [terminado]);
    expect(await rotina.executarLote(10, { tenantIds: [a.tenantId] }, AGORA)).toEqual([]);
    expect(leituras).toHaveLength(1);
    expect(ResultadoDoTesteDeRegiao.parse((await linhaDe(terminado)).result)).toEqual(guardado);
  }, 60_000);

  it('a leitura que falha não grava e volta depois da espera; passados 7 dias do fim, fica sem leitura; o Regem de uma empresa que cai não para a outra', async () => {
    const vencido = await teste(b, 'terminado', dia(23), dia(9));
    const daA = await teste(a, 'terminado', dia(17), dia(4));
    const escopo = { tenantIds: [a.tenantId, b.tenantId] };

    const r = await rotina.executarLote(10, escopo, AGORA);
    expect(emOrdem(r)).toEqual(
      emOrdem([
        { tenantId: b.tenantId, teste: doB, situacao: 'esperando', motivo: 'leitura_falhou' },
        { tenantId: b.tenantId, teste: vencido, situacao: 'medido', motivo: 'sem_leitura' },
        { tenantId: a.tenantId, teste: daA, situacao: 'medido', motivo: null },
      ]),
    );
    expect((await linhaDe(doB)).result).toBeNull();
    expect(ResultadoDoTesteDeRegiao.parse((await linhaDe(vencido)).result)).toMatchObject({
      janela: { de: dia(23), ate: dia(10) },
      pedidos: { alvoAntes: 480, outrosAntes: 1712, alvoDurante: null, outrosDurante: null },
      // Sem a leitura, cada bairro vai só com os pedidos de antes.
      bairros: [
        { nome: 'Centro', antes: 1000, durante: null },
        { nome: 'Glória', antes: 412, durante: null },
        { nome: 'Saúde', antes: 300, durante: null },
      ],
      efeito: null,
      motivo: 'sem_leitura',
      minimoDoRegem: null,
    });
    expect(ResultadoDoTesteDeRegiao.parse((await linhaDe(daA)).result)).toMatchObject({ janela: { de: dia(17), ate: dia(4) }, motivo: null });
    expect((await api.call('GET', `/v1/region-tests/${vencido}`, { cookie: b.cookie })).body.result).toMatchObject({
      reason: 'sem_leitura',
      effect: null,
      regem_minimum: null,
      districts: [
        { name: 'Centro', orders_before: 1000, orders_during: null },
        { name: 'Glória', orders_before: 412, orders_during: null },
        { name: 'Saúde', orders_before: 300, orders_during: null },
      ],
    });

    // Logo depois, o teste que falhou espera a hora: nada é lido.
    const lidas = leituras.length;
    expect(await rotina.executarLote(10, escopo, AGORA)).toEqual([]);
    expect(leituras).toHaveLength(lidas);

    // O Regem da empresa B volta e a espera passou: o teste ganha o resultado, com a janela dele. As quedas abriram o
    // disjuntor do conector desta loja (5 falhas seguidas); aqui ele fecha como fecharia depois da espera dele.
    estado.caiB = false;
    const chave = chaveDe('regem', b.loja);
    await ownerQuery(`delete from liame.circuit_state where circuit_key = $1`, [chave]);
    await ownerQuery(`delete from liame.quota_bucket where bucket_key = $1`, [chave]);
    await ownerQuery(`update liame.campaign_test set updated_at = now() - interval '2 hours' where id = $1`, [doB]);
    expect(await rotina.executarLote(10, escopo, AGORA)).toEqual([{ tenantId: b.tenantId, teste: doB, situacao: 'medido', motivo: null }]);
    expect(leituras.at(-1)).toEqual({ loja: b.loja, de: dia(16), ate: dia(3) });
    expect(ResultadoDoTesteDeRegiao.parse((await linhaDe(doB)).result)).toMatchObject({ pedidos: { alvoDurante: 168, outrosDurante: 880 }, motivo: null });
  }, 60_000);

  it('a Atenção mostra o resultado medido por 14 dias depois da medida, com o caminho para o teste em Aprovações (D-RG-102)', async () => {
    const id = await teste(a, 'terminado', dia(30), dia(17));
    const resultado = (medidoHaDias: number) => ({
      janela: { de: dia(30), ate: dia(17) },
      pedidos: { alvoAntes: 480, outrosAntes: 1712, alvoDurante: 168, outrosDurante: 730 },
      bairros: [
        { nome: 'Centro', antes: 1000, durante: 520 },
        { nome: 'Glória', antes: 412, durante: 210 },
      ],
      efeito: null,
      motivo: 'poucos_bairros',
      esperadoPorSemana: null,
      minimoDoRegem: 5,
      medido_em: new Date(AGORA.getTime() - medidoHaDias * 86_400_000).toISOString(),
    });
    const gravar = (medidoHaDias: number) =>
      ownerQuery(`update liame.campaign_test set result = $2::jsonb where id = $1`, [id, JSON.stringify(ResultadoDoTesteDeRegiao.parse(resultado(medidoHaDias)))]);
    const avisos = async () => {
      const lido = await api.call('GET', `/v1/results/attention?brand_id=${a.brandId}`, { cookie: a.cookie });
      expect(lido.status, JSON.stringify(lido.body)).toBe(200);
      return (lido.body.items as Array<{ kind: string; test?: { id: string } }>).filter((i) => i.kind === 'teste_regiao_com_resultado' && i.test?.id === id);
    };
    // Medido há 13 dias: o aviso aparece, só informação, com o motivo da medida e o caminho para pedir outro teste.
    await gravar(13);
    expect(await avisos()).toEqual([
      {
        kind: 'teste_regiao_com_resultado',
        severity: 'info',
        title: 'O teste "Lapa sem anúncio por 14 dias" terminou sem conta',
        detail: 'Nos dias do teste, sobraram 2 bairros para comparar; a conta pede pelo menos 3.',
        action: 'Veja o teste em Aprovações. Para medir de novo, peça outro teste em Minha marca › Região › Sua região.',
        connected_account_id: a.anuncios,
        campaign_id: null,
        provider: 'meta_ads',
        brand_id: a.brandId,
        // O teste criado direto no banco não tem o pedido em Aprovações.
        test: { id, action_id: null },
      },
    ]);
    // Medido há 15 dias: o prazo passou, e o aviso sai (o teste de região não deixa dinheiro gastando à espera de decisão).
    await gravar(15);
    expect(await avisos()).toEqual([]);
    // O resultado fora da forma da medida não derruba a Atenção nem vira aviso.
    await ownerQuery(`update liame.campaign_test set result = '{"medido_em": "ontem"}'::jsonb where id = $1`, [id]);
    expect(await avisos()).toEqual([]);
  }, 60_000);
});
