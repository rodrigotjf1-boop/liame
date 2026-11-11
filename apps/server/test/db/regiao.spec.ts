import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { runMigrations } from '@liame/database';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { hasDb, OWNER_URL } from './env.js';

// Plano da região, R1 (a loja no mapa; migration 0132), contra Postgres, com o ViaCEP e o OpenStreetMap de mentira (o
// `fetch` da API é desviado só para esses dois sites; nada sai para a internet). O que se prova:
//   - com a função `regiao` desligada, a lista vem vazia e salvar volta 409;
//   - ligada: a lista traz a loja sem endereço; conferir pelo CEP completa o endereço e acha a coordenada (no município do
//     CEP), sem gravar nada; CEP que não existe é 422 e o ViaCEP fora do ar é 503;
//   - salvar grava a loja (com quem e quando), a auditoria leva o antes e o depois, e o banco recusa o raio fora do passo
//     e a coordenada fora do Brasil (pelo contrato, 400).

const CEP = '21615000';
const VIACEP = { cep: '21615-000', logradouro: 'Avenida General Benedito da Silveira', bairro: 'Vila Militar', localidade: 'Rio de Janeiro', uf: 'RJ', ibge: '3304557' };
const OSM = [{ lat: '-22.8612', lon: '-43.4031', address: { suburb: 'Vila Militar', city: 'Rio de Janeiro', state: 'Rio de Janeiro' } }];

describe.skipIf(!hasDb)('a loja no mapa (plano da região, R1)', () => {
  let api: TestApi;
  let cookie: string;
  let tenantId: string;
  let brandId: string;
  let unitId: string;
  /** O que o ViaCEP de mentira responde agora. */
  let viacep: { status: number; corpo: unknown } = { status: 200, corpo: VIACEP };
  const pedidosDeFora: string[] = [];
  const original = globalThis.fetch;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Loja no mapa');
    cookie = s.cookie;
    // O Dono só usa rotas de permissão com o app autenticador ativo.
    await enableMfa(api, cookie);
    tenantId = s.me.active_organization_id as string;
    brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    unitId = randomUUID();
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $2, $3, 'Loja Centro')`, [unitId, tenantId, brandId]);
  }, 120_000);

  beforeEach(async () => {
    await resetIpRateLimits();
    viacep = { status: 200, corpo: VIACEP };
    pedidosDeFora.length = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (entrada, init) => {
      const url = entrada instanceof Request ? entrada.url : String(entrada);
      const host = new URL(url).host;
      if (host === 'viacep.com.br') {
        pedidosDeFora.push(url);
        return new Response(JSON.stringify(viacep.corpo), { status: viacep.status, headers: { 'content-type': 'application/json' } });
      }
      if (host === 'nominatim.openstreetmap.org') {
        pedidosDeFora.push(url);
        return new Response(JSON.stringify(OSM), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return original(entrada, init);
    });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    await ligarFlagDaEmpresa(api, 'regiao', tenantId, false);
    await api?.close();
  });

  const salvar = (corpo: Record<string, unknown>) =>
    api.call('PUT', `/v1/units/${unitId}/location`, {
      cookie,
      body: {
        address: { postal_code: CEP, street: 'Avenida General Benedito da Silveira', number: '123', district: 'Vila Militar', city: 'Rio de Janeiro', state: 'RJ', ibge_city_code: '3304557' },
        coordinates: { latitude: -22.8612, longitude: -43.4031, precision: 'endereco' },
        source: 'cep',
        delivery_radius_km: 3.5,
        delivery_areas: ['Vila Militar', ' vila militar ', 'Deodoro'],
        ...corpo,
      },
    });

  it('desligada: a lista vem vazia e salvar volta 409', async () => {
    await ligarFlagDaEmpresa(api, 'regiao', tenantId, false);
    const lista = await api.call('GET', `/v1/region/stores?brand_id=${brandId}`, { cookie });
    expect(lista.status, JSON.stringify(lista.body)).toBe(200);
    expect(lista.body).toMatchObject({ availability: { status: 'desligado_pela_liame' }, stores: [], can_edit: false });
    const r = await salvar({});
    expect([r.status, r.body.code]).toEqual([409, 'funcao-desligada']);
  });

  it('ligada: confere pelo CEP sem gravar, salva com a auditoria, e recusa o que o contrato não aceita', async () => {
    await ligarFlagDaEmpresa(api, 'regiao', tenantId, true);
    const antes = await api.call('GET', `/v1/region/stores?brand_id=${brandId}`, { cookie });
    expect(antes.status, JSON.stringify(antes.body)).toBe(200);
    expect(antes.body).toMatchObject({ availability: { status: 'disponivel' }, can_edit: true, attribution: '© OpenStreetMap' });
    expect(antes.body.stores).toEqual([expect.objectContaining({ unit_id: unitId, unit_name: 'Loja Centro', address: null, coordinates: null })]);

    const conferido = await api.call('POST', '/v1/region/address-lookup', { cookie, body: { brand_id: brandId, postal_code: '21615-000', number: '123' } });
    expect(conferido.status, JSON.stringify(conferido.body)).toBe(200);
    expect(conferido.body).toMatchObject({
      address: { postal_code: CEP, street: 'Avenida General Benedito da Silveira', number: '123', district: 'Vila Militar', city: 'Rio de Janeiro', state: 'RJ', ibge_city_code: '3304557' },
      coordinates: { latitude: -22.8612, longitude: -43.4031, precision: 'endereco' },
      coordinates_status: 'achada',
      needs_street: false,
    });
    expect(pedidosDeFora.some((u) => u.startsWith('https://viacep.com.br/ws/21615000/json/'))).toBe(true);
    // Conferir não grava nada.
    const [semNada] = await ownerQuery<{ address_postal_code: string | null }>(`select address_postal_code from liame.unit where id = $1`, [unitId]);
    expect(semNada!.address_postal_code).toBeNull();

    viacep = { status: 200, corpo: { erro: 'true' } };
    const naoAchado = await api.call('POST', '/v1/region/address-lookup', { cookie, body: { brand_id: brandId, postal_code: '99999-999' } });
    expect([naoAchado.status, naoAchado.body.code]).toEqual([422, 'cep-nao-encontrado']);
    viacep = { status: 500, corpo: {} };
    const foraDoAr = await api.call('POST', '/v1/region/address-lookup', { cookie, body: { brand_id: brandId, postal_code: '20000-001' } });
    expect([foraDoAr.status, foraDoAr.body.code]).toEqual([503, 'cep-fora-do-ar']);
    const invalido = await api.call('POST', '/v1/region/address-lookup', { cookie, body: { brand_id: brandId, postal_code: '2161-5000' } });
    expect([invalido.status, invalido.body.code]).toEqual([422, 'cep-invalido']);

    const salvo = await salvar({});
    expect(salvo.status, JSON.stringify(salvo.body)).toBe(200);
    expect(salvo.body.store).toMatchObject({
      unit_id: unitId,
      address: { postal_code: CEP, number: '123', ibge_city_code: '3304557' },
      coordinates: { latitude: -22.8612, longitude: -43.4031, precision: 'endereco' },
      source: 'cep',
      delivery_radius_km: 3.5,
      delivery_areas: ['Vila Militar', 'Deodoro'],
    });
    expect(salvo.body.store.set_by).not.toBeNull();
    const [auditoria] = await ownerQuery<{ action: string; before: unknown; after: { delivery_radius_km: number } }>(
      `select action, "before", "after" from liame.audit_event where resource_id = $1 order by chain_seq desc limit 1`,
      [unitId],
    );
    expect(auditoria).toMatchObject({ action: 'loja.localizacao', after: { delivery_radius_km: 3.5 } });

    // O contrato recusa o raio fora do passo e a coordenada fora do Brasil, antes do banco.
    expect((await salvar({ delivery_radius_km: 3.3 })).status).toBe(400);
    expect((await salvar({ delivery_radius_km: 20 })).status).toBe(400);
    expect((await salvar({ coordinates: { latitude: 40.7, longitude: -74, precision: 'endereco' } })).status).toBe(400);
    // E o banco recusa endereço sem o município (a regra `unit_endereco_inteiro`).
    await expect(ownerQuery(`update liame.unit set address_city = null where id = $1`, [unitId])).rejects.toThrow(/unit_endereco_inteiro/);
    // E coordenada sem a precisão (a regra `unit_coordenada_inteira`).
    await expect(ownerQuery(`update liame.unit set location_precision = null where id = $1`, [unitId])).rejects.toThrow(/unit_coordenada_inteira/);
  });

  it('parte 2 (P40): sem o número, o ponto fica no bairro; a marca sem Regem cria a loja; um perfil por loja; o complemento', async () => {
    await ligarFlagDaEmpresa(api, 'regiao', tenantId, true);
    await ligarFlagDaEmpresa(api, 'perfil_google', tenantId, true);

    // "s/n": nada de procurar pela rua; o ponto é o do bairro (D-RG-14).
    const semNumero = await api.call('POST', '/v1/region/address-lookup', { cookie, body: { brand_id: brandId, postal_code: '21615-000', number: 's/n' } });
    expect(semNumero.status, JSON.stringify(semNumero.body)).toBe(200);
    expect(semNumero.body.coordinates).toMatchObject({ precision: 'bairro' });
    expect(pedidosDeFora.filter((u) => u.includes('nominatim')).some((u) => u.includes('street='))).toBe(false);

    // A marca sem Regem pode criar loja; a Loja Centro (sem conta do Regem) conta como criada aqui.
    const lista = await api.call('GET', `/v1/region/stores?brand_id=${brandId}`, { cookie });
    expect(lista.body).toMatchObject({ has_regem: false, can_create_store: true });
    expect(lista.body.stores[0]).toMatchObject({ unit_id: unitId, created_here: true, google_profile_account_id: null });

    const corpo = {
      brand_id: brandId,
      name: '  Loja   Tijuca ',
      address: { postal_code: '20520054', street: 'Rua Conde de Bonfim', number: '450', complement: 'Loja 2', district: 'Tijuca', city: 'Rio de Janeiro', state: 'RJ', ibge_city_code: '3304557' },
      coordinates: { latitude: -22.9244, longitude: -43.2327, precision: 'endereco' },
      source: 'cep',
      delivery_radius_km: 3,
      delivery_areas: ['Tijuca', 'Maracanã'],
    };
    const criada = await api.call('POST', '/v1/region/stores', { cookie, body: corpo });
    expect(criada.status, JSON.stringify(criada.body)).toBe(201);
    expect(criada.body.store).toMatchObject({
      unit_name: 'Loja Tijuca',
      created_here: true,
      address: { complement: 'Loja 2', district: 'Tijuca' },
      delivery_areas: ['Tijuca', 'Maracanã'],
      google_profile_account_id: null,
    });
    const novaId = criada.body.store.unit_id as string;
    const [nova] = await ownerQuery<{ tenant_id: string; timezone: string }>(`select tenant_id, timezone from liame.unit where id = $1`, [novaId]);
    expect(nova).toEqual({ tenant_id: tenantId, timezone: 'America/Sao_Paulo' });
    const [criacao] = await ownerQuery<{ action: string; before: unknown; after: { unit_name: string } }>(
      `select action, "before", "after" from liame.audit_event where resource_id = $1 order by chain_seq desc limit 1`,
      [novaId],
    );
    expect(criacao).toMatchObject({ action: 'loja.criar', before: null, after: { unit_name: 'Loja Tijuca' } });
    // O mesmo nome, sem diferença de caixa, não nasce de novo (o Regem se liga pelo nome).
    const repetida = await api.call('POST', '/v1/region/stores', { cookie, body: { ...corpo, name: 'loja tijuca' } });
    expect([repetida.status, repetida.body.code]).toEqual([409, 'loja-com-este-nome']);

    // Um Perfil do Google por loja (D-RG-16): o da Loja Centro não serve à Loja Tijuca.
    const perfilId = randomUUID();
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name) values ($1, $2, $3, 'google_business', $4, 'Perfil Centro')`,
      [perfilId, tenantId, brandId, `locations/${perfilId}`],
    );
    const doPerfil = await salvar({ source: 'perfil_google', google_profile_account_id: perfilId });
    expect(doPerfil.status, JSON.stringify(doPerfil.body)).toBe(200);
    expect(doPerfil.body.store).toMatchObject({ source: 'perfil_google', google_profile_account_id: perfilId });
    const comPerfil = await api.call('GET', `/v1/region/stores?brand_id=${brandId}`, { cookie });
    expect(comPerfil.body.google_profiles).toEqual([{ account_id: perfilId, name: 'Perfil Centro', unit_id: unitId }]);
    const deOutra = await api.call('PUT', `/v1/units/${novaId}/location`, {
      cookie,
      body: { ...corpo, brand_id: undefined, name: undefined, source: 'perfil_google', google_profile_account_id: perfilId },
    });
    expect([deOutra.status, deOutra.body.code], JSON.stringify(deOutra.body)).toEqual([409, 'perfil-de-outra-loja']);
    // O 409 desfaz tudo: a Loja Tijuca continua pelo CEP.
    const [tijuca] = await ownerQuery<{ location_source: string }>(`select location_source from liame.unit where id = $1`, [novaId]);
    expect(tijuca!.location_source).toBe('cep');

    // O complemento só existe com o endereço (a regra `unit_complemento_com_endereco`).
    const semEndereco = randomUUID();
    await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $2, $3, 'Loja Sem Endereço')`, [semEndereco, tenantId, brandId]);
    await expect(ownerQuery(`update liame.unit set address_complement = 'Fundos' where id = $1`, [semEndereco])).rejects.toThrow(/unit_complemento_com_endereco/);

    // Com o Regem conectado, as lojas vêm dele: criar aqui volta 409.
    const regemId = randomUUID();
    await ownerQuery(`insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name) values ($1, $2, $3, 'regem', $4, 'Regem')`, [
      regemId,
      tenantId,
      brandId,
      `loja-${regemId}`,
    ]);
    const comRegem = await api.call('GET', `/v1/region/stores?brand_id=${brandId}`, { cookie });
    expect(comRegem.body).toMatchObject({ has_regem: true, can_create_store: false });
    const recusada = await api.call('POST', '/v1/region/stores', { cookie, body: { ...corpo, name: 'Loja Penha' } });
    expect([recusada.status, recusada.body.code]).toEqual([409, 'marca-com-regem']);
    await ownerQuery(`update liame.connected_account set disconnected_at = now() where id = $1`, [regemId]);
    await ligarFlagDaEmpresa(api, 'perfil_google', tenantId, false);
  });
});
