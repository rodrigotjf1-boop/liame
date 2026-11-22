import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BrandPhoto, BrandPhotoEditPreview, BrandPhotosResponse, DmsGraphSituation } from '@liame/contracts';
import { createDatabase, type Database } from '@liame/database';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gerarChave } from '../../src/connectors/dms/integracao-dms.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria } from '../../src/imagens/armazem.js';
import { FotosLoop, PREVIA_DA_EDICAO_ABANDONADA_MIN } from '../../src/worker/fotos-loop.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// O DMS Graph no Liame (F4; migration 0164), com o DMS ID e o Graph de mentira num servidor local: conectar, editar (a
// prévia não aparece em Fotos), a conferência obrigatória, a original intacta, o pedido barrado, a foto editada fora do
// vídeo montado, a ligação tirada no Graph, a prévia abandonada e a outra empresa.

type Empresa = { cookie: string; tenantId: string; brandId: string };
type Argumentos = Record<string, unknown>;

const APLICATIVO = 'aplicativo-do-liame';
const VALOR_DO_APLICATIVO = 'valor-de-teste-do-aplicativo-liame';
const CODIGO = `gph_ac_${'c'.repeat(43)}`;

function jpeg(largura: number, altura: number, cor = { r: 201, g: 139, b: 78 }): Promise<Buffer> {
  return sharp({ create: { width: largura, height: altura, channels: 3, background: cor } }).jpeg({ quality: 80 }).toBuffer();
}

/** Um CNPJ montado na hora, com os dígitos certos: o repositório é público (nada com forma de documento real). */
function cnpjDeTeste(): string {
  const base = `${String(10_000_000 + Math.floor(Math.random() * 89_999_999))}0001`;
  const digito = (b: string): number => {
    let soma = 0;
    let peso = b.length - 7;
    for (const c of b) {
      soma += Number(c) * peso;
      peso = peso === 2 ? 9 : peso - 1;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = digito(base);
  return `${base}${d1}${digito(`${base}${d1}`)}`;
}

describe.skipIf(!hasDb)('DMS Graph: conectar e editar a foto real (F4)', () => {
  let api: TestApi;
  let database: Database;
  let armazem: ArmazemNaMemoria;
  let loop: FotosLoop;
  let servidor: Server;
  let base = '';
  const anterior: Record<string, string | undefined> = {};
  let chamadasDaEdicao: Argumentos[] = [];
  let ligacaoAtual = '';
  /** O que a ferramenta `editar_imagem` responde nesta vez. */
  let editar: (a: Argumentos) => Promise<{ dados?: unknown; recusa?: unknown; status?: number; problema?: string }>;

  const editarBem = async (a: Argumentos) => {
    // Cada chave dá uma imagem diferente, como o Google; a mesma chave, a mesma imagem.
    const h = createHash('sha256').update(String(a.chaveIdempotencia)).digest();
    const imagem = await jpeg(1536, 1536, { r: h[0]!, g: h[1]!, b: h[2]! });
    return { dados: { tipoArquivo: 'imagem', mimeType: 'image/jpeg', imagemBase64: imagem.toString('base64'), franquia: { mes: '2026-11', usados: 9, total: 30 } } };
  };

  beforeAll(async () => {
    servidor = createServer((req, res) => {
      const partes: Buffer[] = [];
      req.on('data', (c: Buffer) => partes.push(c));
      req.on('end', () => {
        void (async () => {
          const json = (status: number, corpo: unknown, tipo = 'application/json') => {
            res.writeHead(status, { 'content-type': tipo });
            res.end(JSON.stringify(corpo));
          };
          const url = req.url ?? '';
          if (url === '/dmsid/oidc/token') return json(200, { access_token: 'token-do-dms-id', expires_in: 3600 });
          if (url === '/v1/dms-id/autorizacao/pedido') {
            return json(201, { request_uri: `urn:ietf:params:oauth:request_uri:gph_${'n'.repeat(43)}`, expires_in: 600, authorization_endpoint: `${base}/autorizar` });
          }
          if (url === '/v1/dms-id/autorizacao/token') {
            ligacaoAtual = gerarChave('lg', 'graph').chave;
            return json(200, { ligacao: ligacaoAtual, prefixo: ligacaoAtual.slice(0, 18), conta_id: 'conta-graph', conta_nome: 'Brasa no Graph', permissoes: ['imagens.editar'] });
          }
          if (url === '/v1/dms-id/ligacao') return json(200, { ok: true });
          if (url === '/mcp') {
            const p = JSON.parse(Buffer.concat(partes).toString('utf8')) as { id: number; params: { name: string; arguments: Argumentos } };
            if (p.params.name === 'capacidades') {
              const dados = { franquias: { imagem: { mes: '2026-11', usados: 8, total: 30 } } };
              return json(200, { jsonrpc: '2.0', id: p.id, result: { content: [{ type: 'text', text: JSON.stringify(dados) }], structuredContent: dados } });
            }
            chamadasDaEdicao.push(p.params.arguments);
            const r = await editar(p.params.arguments);
            if (r.status) return json(r.status, { type: `https://dev.dmstecnologias.com/erros/${r.problema}`, title: 'recusa', status: r.status }, 'application/problem+json');
            if (r.recusa) {
              return json(200, { jsonrpc: '2.0', id: p.id, result: { isError: true, content: [{ type: 'text', text: 'recusado' }], structuredContent: r.recusa } });
            }
            return json(200, { jsonrpc: '2.0', id: p.id, result: { content: [{ type: 'text', text: '{}' }], structuredContent: r.dados } });
          }
          return json(404, { detail: 'rota inesperada' });
        })();
      });
    });
    await new Promise<void>((pronto) => servidor.listen(0, '127.0.0.1', pronto));
    base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
    for (const [nome, valor] of [
      ['DMS_GRAPH_URL', base],
      ['DMS_ID_EMISSOR', `${base}/dmsid/oidc`],
      ['DMS_ID_APLICATIVO', APLICATIVO],
      ['DMS_ID_SEGREDO', VALOR_DO_APLICATIVO],
    ] as const) {
      anterior[nome] = process.env[nome];
      process.env[nome] = valor;
    }
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
    armazem = api.app.get(ARMAZEM_DE_IMAGENS) as ArmazemNaMemoria;
    loop = new FotosLoop(database, armazem);
  }, 120_000);

  beforeEach(async () => {
    await resetIpRateLimits();
    chamadasDaEdicao = [];
    editar = editarBem;
  });

  afterAll(async () => {
    await api?.close();
    await database?.close();
    await new Promise((pronto) => servidor?.close(pronto));
    for (const [nome, valor] of Object.entries(anterior)) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
  });

  async function empresa(nome: string, { ligada = true, comCnpj = true } = {}): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    await ligarFlagDaEmpresa(api, 'fotos', tenantId, true);
    if (ligada) await ligarFlagDaEmpresa(api, 'dms_graph_fotos', tenantId, true);
    await ownerQuery(`update liame.organization set cnpj = $2 where id = $1`, [tenantId, comCnpj ? cnpjDeTeste() : null]);
    return { cookie: s.cookie, tenantId, brandId };
  }

  const situacao = async (e: Empresa) => {
    const r = await api.call('GET', '/v1/dms-graph', { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return DmsGraphSituation.parse(r.body);
  };

  async function conectar(e: Empresa): Promise<void> {
    const r = await api.call('POST', '/v1/dms-graph/authorize', { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const estado = await estadoDoPedido(e);
    const v = await api.call('POST', '/v1/dms-graph/callback', { cookie: e.cookie, body: { code: CODIGO, state: estado, iss: base } });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body).toEqual({ connected: true, account_name: 'Brasa no Graph' });
  }

  /** O `state` não fica guardado: o teste troca o resumo do pedido pelo de um valor que ele conhece. */
  async function estadoDoPedido(e: Empresa): Promise<string> {
    const estado = randomUUID().replace(/-/g, '').padEnd(43, 'a').slice(0, 43);
    await ownerQuery(
      `update liame.dms_graph_request set state_hash = $2
        where id = (select id from liame.dms_graph_request where tenant_id = $1 and used_at is null order by created_at desc limit 1)`,
      [e.tenantId, createHash('sha256').update(estado, 'utf8').digest('hex')],
    );
    return estado;
  }

  async function fotoDe(e: Empresa): Promise<BrandPhoto> {
    const r = await api.call('POST', `/v1/brand-photos?brand_id=${e.brandId}`, { cookie: e.cookie, raw: { data: await jpeg(1200, 1200), type: 'image/jpeg' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return BrandPhoto.parse(r.body);
  }

  const pedirEdicao = (e: Empresa, id: string, extra: Record<string, unknown> = {}) =>
    api.call('POST', `/v1/brand-photos/${id}/edits`, { cookie: e.cookie, body: { light: true, background: true, framing: '1:1', key: randomUUID(), ...extra } });

  const lista = async (e: Empresa) => {
    const r = await api.call('GET', `/v1/brand-photos?brand_id=${e.brandId}`, { cookie: e.cookie });
    return BrandPhotosResponse.parse(r.body).items;
  };

  it('desligado para a empresa: a situação diz que não está ligado, e nada vai ao Graph', async () => {
    const e = await empresa('Brasa Graph Desligado', { ligada: false });
    expect((await situacao(e)).enabled).toBe(false);
    const r = await api.call('POST', '/v1/dms-graph/authorize', { cookie: e.cookie });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('funcao-desligada');
  }, 60_000);

  it('o caminho inteiro: conecta, edita, a prévia não aparece, só guarda com a conferência, e a original fica', async () => {
    const e = await empresa('Brasa Graph Inteiro');
    await conectar(e);
    const s = await situacao(e);
    expect(s).toMatchObject({ enabled: true, company_has_cnpj: true, quota: { used: 8, total: 30 } });
    expect(s.link).toMatchObject({ account_name: 'Brasa no Graph', permissions: ['imagens.editar'] });
    expect(JSON.stringify(s)).not.toContain(ligacaoAtual);
    const guardado = await ownerQuery<{ secret_id: string }>(`select secret_id from liame.dms_graph_link where tenant_id = $1`, [e.tenantId]);
    expect(guardado[0]!.secret_id).toBeTruthy();

    const original = await fotoDe(e);
    const r = await pedirEdicao(e, original.id, { prompt: 'Fundo de madeira clara, com luz de fim de tarde' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const previa = BrandPhotoEditPreview.parse(r.body);
    expect(previa).toMatchObject({ source_id: original.id, quota: { used: 9, total: 30 } });

    // A regra fixa vem antes do pedido, e o pedido vai num bloco de dado.
    const enviado = chamadasDaEdicao[0]!;
    expect(enviado).toMatchObject({ proporcao: '1:1', tamanho: '2K', formato: 'jpeg' });
    const instrucao = String(enviado.instrucao);
    expect(instrucao.indexOf('Mantenha o produto EXATAMENTE')).toBeLessThan(instrucao.indexOf('<<<Fundo de madeira clara'));

    // A prévia não aparece em Fotos, e não se guarda sem a conferência.
    expect((await lista(e)).map((f) => f.id)).toEqual([original.id]);
    const semConferir = await api.call('POST', `/v1/brand-photos/edits/${previa.id}/save`, { cookie: e.cookie, body: { confirmed: false } });
    expect(semConferir.status).toBe(400);

    const salvo = await api.call('POST', `/v1/brand-photos/edits/${previa.id}/save`, { cookie: e.cookie, body: { confirmed: true } });
    expect(salvo.status, JSON.stringify(salvo.body)).toBe(200);
    const editada = BrandPhoto.parse(salvo.body);
    expect(editada.edited).toMatchObject({
      from_id: original.id,
      options: { light: true, background: true, framing: '1:1' },
      prompt: 'Fundo de madeira clara, com luz de fim de tarde',
    });
    const fotos = await lista(e);
    expect(fotos.map((f) => f.id).sort()).toEqual([original.id, editada.id].sort());
    expect(fotos.find((f) => f.id === original.id)?.edited ?? null).toBeNull();

    const repetir = await api.call('POST', `/v1/brand-photos/edits/${previa.id}/save`, { cookie: e.cookie, body: { confirmed: true } });
    expect(repetir.status).toBe(409);
    const trilha = await ownerQuery(`select 1 from liame.audit_event where tenant_id = $1 and action = 'fotos.editar_guardar' and resource_id = $2`, [e.tenantId, editada.id]);
    expect(trilha).toHaveLength(1);

    // A foto editada não se edita de novo, e não entra no vídeo montado (fica em post e Story).
    expect((await pedirEdicao(e, editada.id)).body.code).toBe('foto-ja-editada');
    await ligarFlagDaEmpresa(api, 'video_montado', e.tenantId, true);
    const video = await api.call('POST', '/v1/video-montages', {
      cookie: e.cookie,
      body: { brand_id: e.brandId, template: 'destaque', format: '9x16', duration_s: 6, media_ids: [editada.id], title: 'Smash duplo', cta: 'Peça agora' },
    });
    expect(video.body.code, JSON.stringify(video.body)).toBe('midia-fora-das-fotos');
  }, 120_000);

  it.each([
    ['Põe mais queijo e bacon no hambúrguer', 'pedido-muda-produto'],
    ['Escreve o preço de R$ 29 na foto', 'pedido-texto-na-foto'],
    ['Coloca uma pessoa segurando o prato', 'pedido-muda-produto'],
    ['Com uma mulher sorrindo ao fundo', 'pedido-com-pessoa'],
  ])('o pedido "%s" é barrado antes de gastar a franquia', async (prompt, code) => {
    const e = await empresa(`Brasa Pedido ${code}`);
    await conectar(e);
    const f = await fotoDe(e);
    const r = await pedirEdicao(e, f.id, { prompt });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe(code);
    expect(chamadasDaEdicao).toHaveLength(0);
  }, 60_000);

  it('a mesma chave não cria outra prévia; descartar tira, e a prévia abandonada sai pela rotina', async () => {
    const e = await empresa('Brasa Previa');
    await conectar(e);
    const f = await fotoDe(e);
    const key = randomUUID();
    const a = BrandPhotoEditPreview.parse((await pedirEdicao(e, f.id, { key })).body);
    const b = BrandPhotoEditPreview.parse((await pedirEdicao(e, f.id, { key })).body);
    expect(b.id).toBe(a.id);
    expect((await api.call('DELETE', `/v1/brand-photos/edits/${a.id}`, { cookie: e.cookie })).status).toBe(204);
    expect((await api.call('POST', `/v1/brand-photos/edits/${a.id}/save`, { cookie: e.cookie, body: { confirmed: true } })).status).toBe(409);

    const c = BrandPhotoEditPreview.parse((await pedirEdicao(e, f.id)).body);
    // Com 20 minutos a prévia fica (o envio comum sairia); passado o prazo dela, sai.
    await loop.executarLote(50, { tenantIds: [e.tenantId] }, new Date(Date.now() + 20 * 60_000));
    expect(await ownerQuery(`select 1 from liame.brand_photo where id = $1`, [c.id])).toHaveLength(1);
    await loop.executarLote(50, { tenantIds: [e.tenantId] }, new Date(Date.now() + (PREVIA_DA_EDICAO_ABANDONADA_MIN + 1) * 60_000));
    expect(await ownerQuery(`select 1 from liame.brand_photo where id = $1`, [c.id])).toHaveLength(0);
  }, 90_000);

  it('a franquia zerada e a ligação tirada no Graph viram frases, e a tela oferece conectar de novo', async () => {
    const e = await empresa('Brasa Franquia');
    await conectar(e);
    const f = await fotoDe(e);
    editar = async () => ({ recusa: { situacao: 'recusado', codigo: 'limite-de-chamadas', limite: 'franquia_imagem', franquia: { usados: 0, total: 0 }, pode_repetir: false } });
    expect((await pedirEdicao(e, f.id)).body.code).toBe('franquia-sem-liberar');
    editar = async () => ({ status: 401, problema: 'ligacao-invalida' });
    expect((await pedirEdicao(e, f.id)).body.code).toBe('graph-desligado');
    const s = await situacao(e);
    expect(s.link).toBeNull();
    expect(s.revoked_by_graph_at).not.toBeNull();
  }, 60_000);

  it('o CNPJ: sem ele não conecta; o torto é recusado; o certo entra uma vez', async () => {
    const e = await empresa('Brasa Sem Cnpj', { comCnpj: false });
    expect((await situacao(e)).company_has_cnpj).toBe(false);
    expect((await api.call('POST', '/v1/dms-graph/authorize', { cookie: e.cookie })).body.code).toBe('cnpj-faltando');
    const torto = await api.call('PUT', '/v1/dms-graph/cnpj', { cookie: e.cookie, body: { cnpj: '12345678000100' } });
    expect(torto.body.code).toBe('cnpj-invalido');
    const cnpj = cnpjDeTeste();
    expect((await api.call('PUT', '/v1/dms-graph/cnpj', { cookie: e.cookie, body: { cnpj } })).status).toBe(204);
    expect((await situacao(e)).company_has_cnpj).toBe(true);
    expect((await api.call('PUT', '/v1/dms-graph/cnpj', { cookie: e.cookie, body: { cnpj: cnpjDeTeste() } })).body.code).toBe('cnpj-ja-informado');
  }, 60_000);

  it('a outra empresa não guarda a prévia nem edita a foto', async () => {
    const a = await empresa('Brasa Graph A');
    const b = await empresa('Brasa Graph B');
    await conectar(a);
    await conectar(b);
    const f = await fotoDe(a);
    const p = BrandPhotoEditPreview.parse((await pedirEdicao(a, f.id)).body);
    expect((await api.call('POST', `/v1/brand-photos/edits/${p.id}/save`, { cookie: b.cookie, body: { confirmed: true } })).status).toBe(409);
    expect((await pedirEdicao(b, f.id)).status).toBe(404);
  }, 90_000);
});
