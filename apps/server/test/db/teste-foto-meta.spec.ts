import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDatabase, type Database, withTenant } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErroDoTeste, LEGENDA_DO_TESTE, PERMISSAO_DE_PUBLICAR, testarFotoNaMeta, VALIDADE_DO_ENDERECO_DO_TESTE_S } from '../../src/connectors/meta/teste-da-foto.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { SEGREDO_DO_APP_DA_META } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A6 · Z5: o teste da D-A6-10 (`connectors/meta/teste-da-foto.ts`, que o `scripts/teste-foto-meta.ts` roda no contêiner
// da API), contra uma Graph API de mentira. Ele confere NA META (`me/permissions`; se ele for recusado, como pode ser com
// o token de usuário do sistema, o `debug_token` com o token do app) as autorizações em uso, das mais novas para as mais
// antigas, e usa a primeira cujo token tem a permissão de publicar no Instagram concedida: a coluna `scopes`
// das autorizações da Meta fica vazia, porque a troca do código da Meta não a preenche (ERR-179), e a semente daqui grava
// do mesmo jeito. Depois escolhe a foto mais nova que cabe na proporção do Instagram, cria o contêiner com o endereço
// assinado e confere se a Meta baixou a foto; NUNCA publica (nenhuma chamada ao `media_publish`); o token vai só no
// cabeçalho, com o `appsecret_proof`; e quem pediu e o porquê ficam na auditoria da empresa. O que a Graph API devolve
// segue a base §2.2 (content publishing, reconferida em 21/10/2026; `me/permissions` lida em 28/10/2026): o contêiner com
// `status_code` (`IN_PROGRESS`, `FINISHED`, `ERROR`) e as permissões com `status` (`granted`, `declined`, `expired`); o
// formato exato do erro de download da imagem não está na página [NC], e aqui é um erro comum da Graph API.

type Chamada = { metodo: string; caminho: string; params: Record<string, string>; token: string | null };
type Permissao = { permission: string; status: 'granted' | 'declined' | 'expired' };

/** Uma Graph API de mentira: as permissões de cada token, a lista das Páginas, a criação do contêiner e a situação dele. */
class GraphDeMentira {
  base = '';
  readonly chamadas: Chamada[] = [];
  /** O que cada token tem concedido. Token fora daqui é recusado como vencido (código 190). */
  readonly concedidas = new Map<string, Permissao[]>();
  /**
   * Com `false`, o `me/permissions` recusa todo token, como a Meta pode fazer com o token de usuário do sistema (a página
   * dele não diz se serve; o erro aqui é o pior caso, inventado [NC]): a conferência tem de ir pelo `debug_token`.
   */
  permissoesDoUsuario = true;
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
    this.concedidas.clear();
    this.permissoesDoUsuario = true;
    this.consultas = 0;
    this.criacao = 'ok';
    this.situacoes = [{ status_code: 'IN_PROGRESS' }, { status_code: 'FINISHED' }];
  }

  private responder(req: IncomingMessage, texto: string): { status: number; corpo: unknown } {
    const url = new URL(req.url ?? '/', 'http://graph.local');
    // O caminho sem a versão (`/v26.0/me/accounts` vira `me/accounts`).
    const caminho = url.pathname.split('/').slice(2).join('/');
    const params = Object.fromEntries(req.method === 'POST' ? new URLSearchParams(texto) : url.searchParams);
    const cabecalho = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice('Bearer '.length) : null;
    this.chamadas.push({ metodo: req.method ?? 'GET', caminho, params, token });
    if (req.method === 'GET' && caminho === 'me/permissions') {
      if (!this.permissoesDoUsuario) {
        return { status: 400, corpo: { error: { message: '(#100) Tried accessing nonexisting field (permissions)', type: 'OAuthException', code: 100 } } };
      }
      const lista = token ? this.concedidas.get(token) : undefined;
      if (!lista) return { status: 400, corpo: { error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 } } };
      return { status: 200, corpo: { data: lista } };
    }
    // O `debug_token` (reference/debug_token, 28/10/2026): só com o token do app; o token conferido vem em `input_token`.
    if (req.method === 'GET' && caminho === 'debug_token') {
      if (token !== `${ID_DO_APP_DA_META}|${SEGREDO_DO_APP_DA_META}`) {
        return { status: 400, corpo: { error: { message: 'Invalid OAuth access token - Cannot parse access token', type: 'OAuthException', code: 190 } } };
      }
      const lista = this.concedidas.get(params.input_token ?? '');
      if (!lista) {
        return { status: 200, corpo: { data: { is_valid: false, scopes: [], error: { code: 190, message: 'Error validating access token: Session has expired' } } } };
      }
      const scopes = lista.filter((p) => p.status === 'granted').map((p) => p.permission);
      return { status: 200, corpo: { data: { app_id: ID_DO_APP_DA_META, type: 'SYSTEM_USER', is_valid: true, scopes } } };
    }
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

/** O id do app da Meta nos testes: com o segredo, forma o token do app que o `debug_token` pede. */
const ID_DO_APP_DA_META = '100000000000001';

/** O armazenamento de mentira: o endereço assinado que a Meta receberia, conferível pelo teste. */
const enderecoAssinado = (chave: string, segundos: number) => `https://imagens.exemplo.com/${chave}?assinado=sim&valido=${segundos}`;

/**
 * O que o token de uma autorização tem na Meta: a permissão de publicar concedida, nunca pedida (a autorização de antes
 * da Z5), desmarcada pela pessoa na hora de autorizar, ou o token recusado pela Meta (vencido).
 */
type Concede = 'publica' | 'sem' | 'desmarcada' | 'recusada';

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

  /**
   * Uma autorização da Meta como a troca do código grava: o token no cofre e a coluna `scopes` VAZIA (ERR-179). O que o
   * token pode, só a Graph API de mentira sabe.
   */
  async function autorizacao(tenantId: string, brandId: string, a: { status: 'ativa' | 'aguardando_escolha' | 'revogada'; horasAtras: number; concede: Concede }) {
    const token = randomBytes(16).toString('hex');
    const segredo = await withTenant(database.db, tenantId, (tx) =>
      vault.putSecret(tx, { tenantId, purpose: 'oauth_meta', plaintext: JSON.stringify({ tipo: 'meta', access_token: token, obtido_em: new Date().toISOString(), expira_em: null }) }),
    );
    if (a.concede !== 'recusada') {
      graph.concedidas.set(token, [
        { permission: 'ads_read', status: 'granted' },
        { permission: 'ads_management', status: 'granted' },
        ...(a.concede === 'publica' ? [{ permission: PERMISSAO_DE_PUBLICAR, status: 'granted' as const }] : []),
        ...(a.concede === 'desmarcada' ? [{ permission: PERMISSAO_DE_PUBLICAR, status: 'declined' as const }] : []),
      ]);
    }
    const id = randomUUID();
    await ownerQuery(
      `insert into liame.oauth_connection (id, tenant_id, brand_id, provider, status, state_hash, redirect_uri, expires_at, completed_at, credential_secret_id, scopes)
       values ($1, $2, $3, 'meta', $4, $5, 'https://api.example/v1/oauth/callback', now() + interval '10 minutes', now() - make_interval(hours => $6::int), $7, '{}'::text[])`,
      [id, tenantId, brandId, a.status, createHash('sha256').update(id).digest('hex'), a.horasAtras, segredo],
    );
    return { id, token };
  }

  /**
   * Uma empresa com fotos prontas, nas medidas pedidas, e duas autorizações da Meta: a antiga, ativa (a de 20/10 no
   * piloto), e a nova, esperando a escolha das contas (a de 28/10). Com `revogadaComPublicar`, uma terceira, a mais nova
   * de todas, revogada e com a permissão: não pode ser usada.
   */
  async function empresa(opcoes: { nova?: Concede; antiga?: Concede; revogadaComPublicar?: boolean; semAutorizacao?: boolean; fotos?: Array<[number, number]> } = {}) {
    const s = await signupAndLogin(api, undefined, 'Hamburgueria do teste da foto');
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
    const antiga = opcoes.semAutorizacao ? null : await autorizacao(tenantId, brandId, { status: 'ativa', horasAtras: 192, concede: opcoes.antiga ?? 'sem' });
    const nova = opcoes.semAutorizacao ? null : await autorizacao(tenantId, brandId, { status: 'aguardando_escolha', horasAtras: 1, concede: opcoes.nova ?? 'publica' });
    const revogada = opcoes.revogadaComPublicar ? await autorizacao(tenantId, brandId, { status: 'revogada', horasAtras: 0, concede: 'publica' }) : null;
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
    return { tenantId, fotos, antiga, nova, revogada };
  }

  const deps = () => ({
    db: database.db,
    vault,
    armazem: { enderecoDeLeitura: async (chave: string, segundos: number) => enderecoAssinado(chave, segundos) },
    meta: { base: graph.base, appId: ID_DO_APP_DA_META as string | null, appSecret: SEGREDO_DO_APP_DA_META },
    esperaMs: 2_000,
    intervaloMs: 10,
  });
  const pedido = (tenantId: string, fotoId: string | null = null) => ({ tenantId, fotoId, por: 'Rodrigo', motivo: 'teste da D-A6-10, pedido pelo dono' });
  const prova = (token: string) => createHmac('sha256', SEGREDO_DO_APP_DA_META).update(token).digest('hex');
  const caminhos = () => graph.chamadas.map((c) => `${c.metodo} ${c.caminho}`);

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
    // A autorização mais nova já tem a permissão: uma consulta de permissões, com o token dela, e o resto do teste.
    expect(caminhos()).toEqual(['GET me/permissions', 'GET me/accounts', 'POST 17841400000000001/media', 'GET 17900000000000001', 'GET 17900000000000001']);
    const criacao = graph.chamadas[2]!;
    expect(criacao.params.image_url).toBe(enderecoAssinado(e.fotos[0]!.chave, VALIDADE_DO_ENDERECO_DO_TESTE_S));
    expect(criacao.params.caption).toBe(LEGENDA_DO_TESTE);
    expect(VALIDADE_DO_ENDERECO_DO_TESTE_S).toBe(300);
    for (const c of graph.chamadas) {
      expect(c.token).toBe(e.nova!.token);
      expect(c.params.appsecret_proof).toBe(prova(e.nova!.token));
      expect(Object.values(c.params)).not.toContain(e.nova!.token);
    }
    expect(graph.chamadas.some((c) => c.caminho.includes('media_publish'))).toBe(false);
    const auditoria = await ownerQuery<{ actor_label: string; reason: string; resource_id: string; after: Record<string, unknown> }>(
      `select actor_label, reason, resource_id, after from liame.audit_event where tenant_id = $1 and action = 'meta.teste_da_foto'`,
      [e.tenantId],
    );
    expect(auditoria).toHaveLength(1);
    expect(auditoria[0]).toMatchObject({ actor_label: 'Distribuição DMS (Rodrigo)', reason: 'teste da D-A6-10, pedido pelo dono', resource_id: e.fotos[0]!.id });
    expect(auditoria[0]!.after).toMatchObject({ conexao: e.nova!.id, instagram: 'misterburguerpenharj', conteiner: '17900000000000001', situacao: 'pronto', publicado: false });
    expect(JSON.stringify(auditoria[0])).not.toContain(e.nova!.token);
    expect(JSON.stringify(auditoria[0])).not.toContain('assinado=sim');
  });

  it('as permissões vêm da Meta, não da coluna vazia: pula a mais nova (permissão desmarcada) e a revogada, e usa a anterior que tem a de publicar', async () => {
    const e = await empresa({ nova: 'desmarcada', antiga: 'publica', revogadaComPublicar: true });
    const r = await testarFotoNaMeta(deps(), pedido(e.tenantId));
    expect(r.situacao).toBe('pronto');
    expect(caminhos().slice(0, 3)).toEqual(['GET me/permissions', 'GET me/permissions', 'GET me/accounts']);
    expect(graph.chamadas[0]!.token).toBe(e.nova!.token);
    // Da segunda consulta em diante, tudo com o token da antiga; o da revogada nunca sai.
    for (const c of graph.chamadas.slice(1)) expect(c.token).toBe(e.antiga!.token);
    expect(graph.chamadas.some((c) => c.token === e.revogada!.token)).toBe(false);
    const auditoria = await ownerQuery<{ after: Record<string, unknown> }>(`select after from liame.audit_event where tenant_id = $1 and action = 'meta.teste_da_foto'`, [e.tenantId]);
    expect(auditoria[0]!.after).toMatchObject({ conexao: e.antiga!.id, situacao: 'pronto', publicado: false });
  });

  it('o token de usuário do sistema, com o `me/permissions` recusado: confere pelo `debug_token`, com o token do app, e o token conferido só nessa chamada', async () => {
    graph.permissoesDoUsuario = false;
    const e = await empresa({ nova: 'desmarcada', antiga: 'publica' });
    const r = await testarFotoNaMeta(deps(), pedido(e.tenantId));
    expect(r.situacao).toBe('pronto');
    expect(caminhos()).toEqual([
      'GET me/permissions',
      'GET debug_token',
      'GET me/permissions',
      'GET debug_token',
      'GET me/accounts',
      'POST 17841400000000001/media',
      'GET 17900000000000001',
      'GET 17900000000000001',
    ]);
    const depuracoes = graph.chamadas.filter((c) => c.caminho === 'debug_token');
    expect(depuracoes.map((c) => c.params.input_token)).toEqual([e.nova!.token, e.antiga!.token]);
    for (const c of depuracoes) {
      // O token do app no cabeçalho, sem `appsecret_proof` (ele já leva o segredo).
      expect(c.token).toBe(`${ID_DO_APP_DA_META}|${SEGREDO_DO_APP_DA_META}`);
      expect(c.params.appsecret_proof).toBeUndefined();
    }
    // Fora do `debug_token`, nenhum token no endereço; o resto do teste com o token da antiga, a que tem a permissão.
    for (const c of graph.chamadas.filter((x) => x.caminho !== 'debug_token')) {
      expect(Object.values(c.params)).not.toContain(e.nova!.token);
      expect(Object.values(c.params)).not.toContain(e.antiga!.token);
    }
    for (const c of graph.chamadas.slice(4)) expect(c.token).toBe(e.antiga!.token);
    const auditoria = await ownerQuery<{ after: Record<string, unknown> }>(`select after from liame.audit_event where tenant_id = $1 and action = 'meta.teste_da_foto'`, [e.tenantId]);
    expect(auditoria[0]!.after).toMatchObject({ conexao: e.antiga!.id, situacao: 'pronto', publicado: false });

    // Sem o id do app, não há token do app: a conferência para no `me/permissions`, com o motivo da Meta, e nada é criado.
    graph.chamadas.splice(0);
    const semApp = await empresa({ antiga: 'publica' });
    const erro = await testarFotoNaMeta({ ...deps(), meta: { base: graph.base, appId: null, appSecret: SEGREDO_DO_APP_DA_META } }, pedido(semApp.tenantId)).catch((err: unknown) => err);
    expect(erro).toBeInstanceOf(ErroDoTeste);
    expect((erro as Error).message).toContain('uma que a Meta recusou: (#100) Tried accessing nonexisting field (permissions) · código 100');
    expect(caminhos()).toEqual(['GET me/permissions', 'GET me/permissions']);
  });

  it('a Meta não consegue baixar a foto: recusado na criação, com o motivo dela, sem consultar nem publicar; a auditoria registra', async () => {
    const e = await empresa();
    graph.criacao = 'sem_download';
    const r = await testarFotoNaMeta(deps(), pedido(e.tenantId));
    expect(r).toMatchObject({ situacao: 'recusado_na_criacao', conteiner: null });
    expect(r.detalhe).toBe('Media download has failed. · código 9004 · subcódigo 2207052');
    expect(caminhos()).toEqual(['GET me/permissions', 'GET me/accounts', 'POST 17841400000000001/media']);
    const auditoria = await ownerQuery<{ after: Record<string, unknown> }>(`select after from liame.audit_event where tenant_id = $1 and action = 'meta.teste_da_foto'`, [e.tenantId]);
    expect(auditoria[0]!.after).toMatchObject({ situacao: 'recusado_na_criacao', conteiner: null, publicado: false });
  });

  it('o contêiner com erro: a situação e o texto da Meta', async () => {
    const e = await empresa();
    graph.situacoes = [{ status_code: 'ERROR', status: 'Error: Media download has failed (2207052)' }];
    const r = await testarFotoNaMeta(deps(), pedido(e.tenantId));
    expect(r).toMatchObject({ situacao: 'erro', detalhe: 'Error: Media download has failed (2207052)', conteiner: '17900000000000001' });
  });

  it('sem autorização em uso, sem a permissão concedida em nenhuma, sem Instagram ligado ou sem foto que caiba: não chega a criar nada', async () => {
    const semAutorizacao = await empresa({ semAutorizacao: true });
    const erro1 = await testarFotoNaMeta(deps(), pedido(semAutorizacao.tenantId)).catch((err: unknown) => err);
    expect(erro1).toBeInstanceOf(ErroDoTeste);
    expect((erro1 as Error).message).toContain('não tem autorização da Meta em uso');
    expect(graph.chamadas).toEqual([]);

    // A nova com a permissão desmarcada e a antiga com o token vencido (o `me/permissions` recusa, e o `debug_token`
    // confirma que o token não vale): as duas conferidas na Meta, cada uma com o motivo.
    const semPublicar = await empresa({ nova: 'desmarcada', antiga: 'recusada' });
    const erro2 = await testarFotoNaMeta(deps(), pedido(semPublicar.tenantId)).catch((err: unknown) => err);
    expect(erro2).toBeInstanceOf(ErroDoTeste);
    expect((erro2 as Error).message).toContain(`permissão de publicar no Instagram (${PERMISSAO_DE_PUBLICAR}) concedida, conferido na Meta`);
    expect((erro2 as Error).message).toContain('uma sem a permissão concedida; uma com o token recusado pela Meta: Error validating access token: Session has expired · código 190');
    expect((erro2 as Error).message).not.toContain(semPublicar.nova!.token);
    expect((erro2 as Error).message).not.toContain(semPublicar.antiga!.token);
    expect(caminhos()).toEqual(['GET me/permissions', 'GET me/permissions', 'GET debug_token']);

    graph.chamadas.splice(0);
    const semInstagram = await empresa();
    graph.paginas = { data: [{ id: '2220001', name: 'Página sem Instagram' }] };
    try {
      await expect(testarFotoNaMeta(deps(), pedido(semInstagram.tenantId))).rejects.toThrow('Instagram profissional');
    } finally {
      graph.paginas = { data: [{ id: '2220001', name: 'Mister Burguer - Penha RJ', instagram_business_account: { id: '17841400000000001', username: 'misterburguerpenharj' } }] };
    }
    expect(caminhos()).toEqual(['GET me/permissions', 'GET me/accounts']);

    // A foto se escolhe antes de qualquer chamada à Meta.
    graph.chamadas.splice(0);
    const emPe = await empresa({ fotos: [[1000, 2000]] });
    await expect(testarFotoNaMeta(deps(), pedido(emPe.tenantId))).rejects.toThrow('proporção do Instagram');
    // A foto pedida pelo id que não cabe também não vai.
    await expect(testarFotoNaMeta(deps(), pedido(emPe.tenantId, emPe.fotos[0]!.id))).rejects.toThrow('não cabe na proporção');
    expect(graph.chamadas).toEqual([]);
    const nenhuma = await ownerQuery(`select 1 from liame.audit_event where tenant_id in ($1, $2, $3, $4) and action = 'meta.teste_da_foto'`, [
      semAutorizacao.tenantId,
      semPublicar.tenantId,
      semInstagram.tenantId,
      emPe.tenantId,
    ]);
    expect(nenhuma).toEqual([]);
  });
});
