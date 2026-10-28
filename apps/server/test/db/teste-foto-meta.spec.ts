import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDatabase, type Database, withTenant } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErroDoTeste, LEGENDA_DO_TESTE, PERMISSAO_DE_PUBLICAR, testarFotoNaMeta, VALIDADE_DO_ENDERECO_DO_TESTE_S } from '../../src/connectors/meta/teste-da-foto.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { SEGREDO_DO_APP_DA_META, TOKEN_DA_META } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A6 · Z5: o teste da D-A6-10 (`connectors/meta/teste-da-foto.ts`, que o `scripts/teste-foto-meta.ts` roda no contêiner
// da API), contra uma Graph API de mentira. Ele usa a autorização mais nova com a permissão de publicar no Instagram,
// escolhe a foto mais nova que cabe na proporção do Instagram, cria o contêiner com o endereço assinado e confere se a
// Meta baixou a foto; NUNCA publica (nenhuma chamada ao `media_publish`); o token vai só no cabeçalho, com o
// `appsecret_proof`; e quem pediu e o porquê ficam na auditoria da empresa. O que a Graph API devolve segue a base
// §2.2 (content publishing, reconferida em 21/10/2026): o contêiner com `status_code` (`IN_PROGRESS`, `FINISHED`,
// `ERROR`); o formato exato do erro de download da imagem não está na página [NC], e aqui é um erro comum da Graph API.

type Chamada = { metodo: string; caminho: string; params: Record<string, string>; autorizacao: string | null };

/** Uma Graph API de mentira: a lista das Páginas, a criação do contêiner e a situação dele. */
class GraphDeMentira {
  base = '';
  readonly chamadas: Chamada[] = [];
  paginas: unknown = { data: [{ id: '2220001', name: 'Mister Burguer - Penha RJ', instagram_business_account: { id: '17841400000000001', username: 'misterburguerpenharj' } }] };
  /** Como a criação responde: o contêiner, ou o erro de quem não conseguiu baixar a imagem. */
  criacao: 'ok' | 'sem_download' = 'ok';
  /** As situações que o contêiner vai mostrando, uma por consulta (a última se repete). */
  situacoes: Array<{ status_code: string; status?: string }> = [{ status_code: 'IN_PROGRESS' }, { status_code: 'FINISHED' }];
  private servidor: Server | null = null;
  private consultas = 0;

  async ligar(): Promise<void> {
    this.servidor = createServer((req, res) => {
      let texto = '';
      req.on('data', (c: Buffer) => {
        texto += c.toString('utf8');
      });
      req.on('end', () => {
        const r = this.responder(req, texto);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.corpo));
      });
    });
    const s = this.servidor;
    await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
    this.base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  async desligar(): Promise<void> {
    const s = this.servidor;
    if (s) await new Promise((ok) => s.close(ok));
  }

  limpar(): void {
    this.chamadas.splice(0);
    this.consultas = 0;
    this.criacao = 'ok';
    this.situacoes = [{ status_code: 'IN_PROGRESS' }, { status_code: 'FINISHED' }];
  }

  private responder(req: IncomingMessage, texto: string): { status: number; corpo: unknown } {
    const url = new URL(req.url ?? '/', 'http://graph.local');
    // O caminho sem a versão (`/v26.0/me/accounts` vira `me/accounts`).
    const caminho = url.pathname.split('/').slice(2).join('/');
    const params = Object.fromEntries(req.method === 'POST' ? new URLSearchParams(texto) : url.searchParams);
    this.chamadas.push({ metodo: req.method ?? 'GET', caminho, params, autorizacao: typeof req.headers.authorization === 'string' ? req.headers.authorization : null });
    if (req.method === 'GET' && caminho === 'me/accounts') return { status: 200, corpo: this.paginas };
    if (req.method === 'POST' && caminho.endsWith('/media')) {
      if (this.criacao === 'sem_download') {
        return { status: 400, corpo: { error: { message: 'Media download has failed.', type: 'OAuthException', code: 9004, error_subcode: 2207052 } } };
      }
      return { status: 200, corpo: { id: '17900000000000001' } };
    }
    if (req.method === 'GET' && caminho === '17900000000000001') {
      const s = this.situacoes[Math.min(this.consultas, this.situacoes.length - 1)]!;
      this.consultas += 1;
      return { status: 200, corpo: { id: '17900000000000001', ...s } };
    }
    // Publicar (`media_publish`) ou qualquer outra coisa: o teste nunca pode chegar aqui.
    return { status: 500, corpo: { error: { message: `rota inesperada: ${req.method} ${caminho}`, code: 1 } } };
  }
}

/** O armazenamento de mentira: o endereço assinado que a Meta receberia, conferível pelo teste. */
const enderecoAssinado = (chave: string, segundos: number) => `https://imagens.exemplo.com/${chave}?assinado=sim&valido=${segundos}`;

describe.skipIf(!hasDb)('O teste da foto com a Meta (A6 · Z5, D-A6-10)', () => {
  let api: TestApi;
  let database: Database;
  let vault: VaultService;
  const graph = new GraphDeMentira();

  beforeAll(async () => {
    await graph.ligar();
    api = await startApi();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    vault = api.app.get(VaultService);
  }, 120_000);
  beforeEach(async () => {
    graph.limpar();
    // Cada caso cria empresas pelo cadastro: o limite por IP do cadastro não passa de um caso para o outro (V39).
    await resetIpRateLimits();
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await graph.desligar();
  });

  /** Uma empresa com a autorização da Meta (com ou sem a permissão de publicar) e fotos prontas, nas medidas pedidas. */
  async function empresa(opcoes: { publicar?: boolean; fotos?: Array<[number, number]> } = {}) {
    const s = await signupAndLogin(api, undefined, 'Hamburgueria do teste da foto');
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    const segredo = await withTenant(database.db, tenantId, (tx) =>
      vault.putSecret(tx, { tenantId, purpose: 'oauth_meta', plaintext: JSON.stringify({ tipo: 'meta', access_token: TOKEN_DA_META, obtido_em: new Date().toISOString(), expira_em: null }) }),
    );
    const escopos = ['ads_read', 'ads_management', ...(opcoes.publicar === false ? [] : [PERMISSAO_DE_PUBLICAR, 'instagram_basic'])];
    // A autorização antiga, sem a permissão de publicar, e a nova (a do teste), mais recente.
    for (const [diasAtras, lista] of [
      [8, ['ads_read', 'ads_management']],
      [0, escopos],
    ] as const) {
      const id = randomUUID();
      await ownerQuery(
        `insert into liame.oauth_connection (id, tenant_id, brand_id, provider, status, state_hash, redirect_uri, expires_at, completed_at, credential_secret_id, scopes)
         values ($1, $2, $3, 'meta', 'aguardando_escolha', $4, 'https://api.example/v1/oauth/callback', now() + interval '10 minutes', now() - make_interval(days => $7::int), $5, $6::text[])`,
        [id, tenantId, brandId, createHash('sha256').update(id).digest('hex'), segredo, lista, diasAtras],
      );
    }
    const fotos: Array<{ id: string; chave: string }> = [];
    let minuto = 0;
    for (const [largura, altura] of opcoes.fotos ?? [[2048, 1365]]) {
      const id = randomUUID();
      const chave = `t/${tenantId}/b/${brandId}/foto_produto/${id}.jpg`;
      minuto += 1;
      await ownerQuery(
        `insert into liame.brand_photo (id, tenant_id, brand_id, status, object_key, sha256, bytes, width, height, created_at, updated_at)
         values ($1, $2, $3, 'pronta', $4, $5, 1000, $6, $7, now() - make_interval(mins => $8::int), now())`,
        [id, tenantId, brandId, chave, randomBytes(32).toString('hex'), largura, altura, 100 - minuto],
      );
      fotos.push({ id, chave });
    }
    return { tenantId, fotos };
  }

  const deps = () => ({
    db: database.db,
    vault,
    armazem: { enderecoDeLeitura: async (chave: string, segundos: number) => enderecoAssinado(chave, segundos) },
    meta: { base: graph.base, appSecret: SEGREDO_DO_APP_DA_META },
    esperaMs: 2_000,
    intervaloMs: 10,
  });
  const pedido = (tenantId: string, fotoId: string | null = null) => ({ tenantId, fotoId, por: 'Rodrigo', motivo: 'teste da D-A6-10, pedido pelo dono' });

  it('a Meta baixa a foto: o contêiner fica pronto e NÃO é publicado; o token só no cabeçalho, com a prova do segredo; a auditoria leva quem pediu', async () => {
    // A mais nova é em pé demais para o Instagram (1:2): fica a de 3:2, mais antiga.
    const e = await empresa({ fotos: [[2048, 1365], [1000, 2000]] });
    const r = await testarFotoNaMeta(deps(), pedido(e.tenantId));
    expect(r).toEqual({
      situacao: 'pronto',
      detalhe: null,
      conteiner: '17900000000000001',
      instagram: 'misterburguerpenharj',
      pagina: 'Mister Burguer - Penha RJ',
      foto: { id: e.fotos[0]!.id, largura: 2048, altura: 1365 },
    });
    expect(graph.chamadas.map((c) => `${c.metodo} ${c.caminho}`)).toEqual([
      'GET me/accounts',
      'POST 17841400000000001/media',
      'GET 17900000000000001',
      'GET 17900000000000001',
    ]);
    const criacao = graph.chamadas[1]!;
    expect(criacao.params.image_url).toBe(enderecoAssinado(e.fotos[0]!.chave, VALIDADE_DO_ENDERECO_DO_TESTE_S));
    expect(criacao.params.caption).toBe(LEGENDA_DO_TESTE);
    expect(VALIDADE_DO_ENDERECO_DO_TESTE_S).toBe(300);
    for (const c of graph.chamadas) {
      expect(c.autorizacao).toBe(`Bearer ${TOKEN_DA_META}`);
      expect(c.params.appsecret_proof).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.values(c.params)).not.toContain(TOKEN_DA_META);
    }
    expect(graph.chamadas.some((c) => c.caminho.includes('media_publish'))).toBe(false);
    const auditoria = await ownerQuery<{ actor_label: string; reason: string; resource_id: string; after: Record<string, unknown> }>(
      `select actor_label, reason, resource_id, after from liame.audit_event where tenant_id = $1 and action = 'meta.teste_da_foto'`,
      [e.tenantId],
    );
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]).toMatchObject({ actor_label: 'Distribuição DMS (Rodrigo)', reason: 'teste da D-A6-10, pedido pelo dono', resource_id: e.fotos[0]!.id });
    expect(auditoria[0]!.after).toMatchObject({ instagram: 'misterburguerpenharj', conteiner: '17900000000000001', situacao: 'pronto', publicado: false });
    expect(JSON.stringify(auditoria[0])).not.toContain(TOKEN_DA_META);
    expect(JSON.stringify(auditoria[0])).not.toContain('assinado=sim');
  });

  it('a Meta não consegue baixar a foto: recusado na criação, com o motivo dela, sem consultar nem publicar; a auditoria registra', async () => {
    const e = await empresa();
    graph.criacao = 'sem_download';
    const r = await testarFotoNaMeta(deps(), pedido(e.tenantId));
    expect(r).toMatchObject({ situacao: 'recusado_na_criacao', conteiner: null });
    expect(r.detalhe).toBe('Media download has failed. · código 9004 · subcódigo 2207052');
    expect(graph.chamadas.map((c) => `${c.metodo} ${c.caminho}`)).toEqual(['GET me/accounts', 'POST 17841400000000001/media']);
    const auditoria = await ownerQuery<{ after: Record<string, unknown> }>(`select after from liame.audit_event where tenant_id = $1 and action = 'meta.teste_da_foto'`, [e.tenantId]);
    expect(auditoria[0]!.after).toMatchObject({ situacao: 'recusado_na_criacao', conteiner: null, publicado: false });
  });

  it('o contêiner com erro: a situação e o texto da Meta', async () => {
    const e = await empresa();
    graph.situacoes = [{ status_code: 'ERROR', status: 'Error: Media download has failed (2207052)' }];
    const r = await testarFotoNaMeta(deps(), pedido(e.tenantId));
    expect(r).toMatchObject({ situacao: 'erro', detalhe: 'Error: Media download has failed (2207052)', conteiner: '17900000000000001' });
  });

  it('sem a autorização com a permissão de publicar, sem Instagram ligado ou sem foto que caiba: não chega a criar nada', async () => {
    const semPublicar = await empresa({ publicar: false });
    await expect(testarFotoNaMeta(deps(), pedido(semPublicar.tenantId))).rejects.toThrow(ErroDoTeste);
    await expect(testarFotoNaMeta(deps(), pedido(semPublicar.tenantId))).rejects.toThrow('permissão de publicar');
    expect(graph.chamadas).toEqual([]);

    const semInstagram = await empresa();
    graph.paginas = { data: [{ id: '2220001', name: 'Página sem Instagram' }] };
    try {
      await expect(testarFotoNaMeta(deps(), pedido(semInstagram.tenantId))).rejects.toThrow('Instagram profissional');
    } finally {
      graph.paginas = { data: [{ id: '2220001', name: 'Mister Burguer - Penha RJ', instagram_business_account: { id: '17841400000000001', username: 'misterburguerpenharj' } }] };
    }
    expect(graph.chamadas.map((c) => `${c.metodo} ${c.caminho}`)).toEqual(['GET me/accounts']);

    const emPe = await empresa({ fotos: [[1000, 2000]] });
    await expect(testarFotoNaMeta(deps(), pedido(emPe.tenantId))).rejects.toThrow('proporção do Instagram');
    // A foto pedida pelo id que não cabe também não vai.
    await expect(testarFotoNaMeta(deps(), pedido(emPe.tenantId, emPe.fotos[0]!.id))).rejects.toThrow('não cabe na proporção');
    const nenhuma = await ownerQuery(`select 1 from liame.audit_event where tenant_id in ($1, $2, $3) and action = 'meta.teste_da_foto'`, [
      semPublicar.tenantId,
      semInstagram.tenantId,
      emPe.tenantId,
    ]);
    expect(nenhuma).toEqual([]);
  });
});
