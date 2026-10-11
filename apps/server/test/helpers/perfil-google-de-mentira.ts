import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect } from 'vitest';
import { ESCOPOS_GOOGLE } from '../../src/connections/oauth.js';
import { ESCOPO_PERFIL_GOOGLE } from '../../src/connectors/google-business/perfil-google.js';
import type { ConexaoProcessor } from '../../src/worker/conexao-processor.js';
import { enableMfa, ownerQuery, signupAndLogin, type TestApi } from './api.js';
import { ligarFlagDaEmpresa } from './meta-de-mentira.js';

// Um Google local para os testes do Perfil da Empresa (A6, Z1): o OAuth (o código com PKCE e a renovação), o Google
// Ads e o GA4 sem conta nenhuma, e as quatro APIs do Perfil (as contas, as lojas, as avaliações e os números), cada
// uma num caminho. O teste escolhe o que a loja tem no Google e como cada API responde.

export const API_PUBLICA_DE_TESTE = 'http://api.liame.test';
const VOLTA = `${API_PUBLICA_DE_TESTE}/v1/oauth/callback`;
export const CONTA_DO_PERFIL = 'accounts/111000111';
export const LOJA_DO_PERFIL = 'locations/222000222';
// Os valores de mentira que o OAuth devolve ficam em constantes de nome neutro, longe da chave da resposta: o texto
// escrito ao lado de `access_token:` ou `refresh_token:` é lido pelo gitleaks como chave de verdade (ERR-131).
export const ACESSO_RENOVADO = 'acesso-do-perfil-renovado';
const ACESSO_DA_TROCA = 'acesso-do-perfil-1';
const RENOVACAO_DA_TROCA = 'renovacao-do-perfil-1';

/** Como uma API do Perfil responde: bem, com a cota esgotada, com a leitura recusada, fora do ar ou "pedido errado". */
export type RespostaDoPerfil = 'ok' | 'sem-cota' | 'recusa' | 'fora' | 'invalido';

export type AvaliacaoNoGoogle = {
  reviewId: string;
  starRating: 'ONE' | 'TWO' | 'THREE' | 'FOUR' | 'FIVE';
  comment?: string;
  createTime: string;
  updateTime: string;
  reviewReply?: { comment: string; updateTime?: string; reviewReplyState?: string; policyViolation?: string };
  /** Só do Google de mentira: a pessoa avaliou sem se identificar (o Google manda `isAnonymous`). */
  anonima?: boolean;
};

/** O nome que o Google de mentira dá a quem fez cada avaliação (o Liame só pode mostrá-lo na tela, na hora). */
export const nomeDeQuemAvaliou = (reviewId: string): string => `Pessoa Número ${reviewId}`;

type Visto = { metodo: string; caminho: string; busca: URLSearchParams; autorizacao?: string; corpo?: unknown };

const erroDe = (r: RespostaDoPerfil): { status: number; corpo: unknown; cabecalhos?: Record<string, string> } | null => {
  if (r === 'sem-cota') return { status: 429, corpo: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for quota metric Requests and limit Requests per minute' } } };
  if (r === 'recusa') return { status: 403, corpo: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'The caller does not have permission' } } };
  if (r === 'fora') return { status: 503, corpo: { error: { code: 503, status: 'UNAVAILABLE', message: 'The service is currently unavailable' } } };
  if (r === 'invalido') return { status: 400, corpo: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument' } } };
  return null;
};

export class GoogleComPerfil {
  base = '';
  readonly vistos: Visto[] = [];
  private servidor: Server | null = null;
  private readonly desafios = new Set<string>();
  private readonly anterior: Record<string, string | undefined> = {};
  /** As permissões que o Google diz ter concedido na troca do código. */
  concedidos: string[] = [...ESCOPOS_GOOGLE, ESCOPO_PERFIL_GOOGLE];
  /** A renovação do acesso é recusada (a autorização foi revogada no Google). */
  renovacaoRecusada = false;
  /** Como respondem a lista de contas e a de lojas do Perfil (a procura das lojas). */
  lojas: RespostaDoPerfil = 'ok';
  avaliacoes: RespostaDoPerfil = 'ok';
  numeros: RespostaDoPerfil = 'ok';
  /** Quanto o Google manda esperar junto com a cota esgotada (segundos), quando manda. */
  esperar: string | null = null;
  /** As avaliações que a loja tem no Google, com o nome e a foto de quem avaliou (que o Liame não pode guardar). */
  lista: AvaliacaoNoGoogle[] = [];
  resumo: { averageRating?: number; totalReviewCount?: number } = { averageRating: 4.6, totalReviewCount: 128 };
  /** Os números do perfil que o Google devolve (as séries, como ele as manda). */
  series: unknown[] = [];
  /** Como respondem a leitura de UMA avaliação e a gravação da resposta (Z2). */
  umaAvaliacao: RespostaDoPerfil = 'ok';
  resposta: RespostaDoPerfil = 'ok';
  /** A situação com que o Google devolve a resposta gravada: ele confere antes de mostrar (`PENDING`). */
  conferencia: 'PENDING' | 'APPROVED' | 'REJECTED' = 'PENDING';
  /** O Google grava a resposta e a conexão cai antes de ele responder (503): a resposta ficou lá. */
  respostaCaiDepoisDeGravar = false;

  async subir(): Promise<void> {
    this.servidor = createServer((req, res) => {
      let texto = '';
      req.on('data', (c: Buffer) => {
        texto += c.toString('utf8');
      });
      req.on('end', () => {
        const r = this.responder(req, texto);
        res.writeHead(r.status, { 'content-type': 'application/json', ...(r.cabecalhos ?? {}) });
        res.end(JSON.stringify(r.corpo));
      });
    });
    const servidor = this.servidor;
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    this.base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
    const ambiente = this.ambiente();
    for (const k of Object.keys(ambiente)) this.anterior[k] = process.env[k];
    Object.assign(process.env, ambiente);
  }

  async fechar(): Promise<void> {
    const servidor = this.servidor;
    if (servidor) await new Promise((ok) => servidor.close(ok));
    for (const [k, v] of Object.entries(this.anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }

  /** As variáveis que apontam a API e o worker para este Google. */
  ambiente(): Record<string, string> {
    return {
      API_URL: API_PUBLICA_DE_TESTE,
      GOOGLE_OAUTH_CLIENT_ID: 'cliente-google-teste.apps.googleusercontent.com',
      GOOGLE_OAUTH_CLIENT_SECRET: 'segredo-cliente-google-teste',
      GOOGLE_AUTH_URL: `${this.base}/google`,
      GOOGLE_TOKEN_URL: `${this.base}/oauth2`,
      GOOGLE_ADS_URL: `${this.base}/ads`,
      GA4_DATA_URL: `${this.base}/ga4data`,
      GA4_ADMIN_URL: `${this.base}/ga4admin`,
      GOOGLE_BUSINESS_ACCOUNTS_URL: `${this.base}/contas`,
      GOOGLE_BUSINESS_LOCATIONS_URL: `${this.base}/lojas`,
      GOOGLE_BUSINESS_REVIEWS_URL: `${this.base}/avaliacoes`,
      GOOGLE_BUSINESS_PERFORMANCE_URL: `${this.base}/numeros`,
    };
  }

  /** A API do Liame vai mandar este desafio de PKCE na troca do código. */
  registrarDesafio(desafio: string): void {
    this.desafios.add(desafio);
  }

  /** As chamadas a uma API do Perfil (`avaliacoes`, `numeros`, `contas`, `lojas`). */
  de(api: 'avaliacoes' | 'numeros' | 'contas' | 'lojas'): Visto[] {
    return this.vistos.filter((v) => v.caminho.startsWith(`/${api}/`));
  }

  /** Volta ao padrão entre um teste e outro. */
  limpar(): void {
    this.vistos.length = 0;
    this.concedidos = [...ESCOPOS_GOOGLE, ESCOPO_PERFIL_GOOGLE];
    this.renovacaoRecusada = false;
    this.lojas = 'ok';
    this.avaliacoes = 'ok';
    this.numeros = 'ok';
    this.esperar = null;
    this.lista = [];
    this.resumo = { averageRating: 4.6, totalReviewCount: 128 };
    this.series = [];
    this.umaAvaliacao = 'ok';
    this.resposta = 'ok';
    this.conferencia = 'PENDING';
    this.respostaCaiDepoisDeGravar = false;
  }

  /** As gravações de resposta que chegaram ao Google (o `PUT …/reply`), com o corpo de cada uma. */
  respostasGravadas(): Visto[] {
    return this.vistos.filter((v) => v.metodo === 'PUT' && v.caminho.endsWith('/reply'));
  }

  private responder(req: IncomingMessage, texto: string): { status: number; corpo: unknown; cabecalhos?: Record<string, string> } {
    const url = new URL(req.url ?? '/', this.base);
    const corpo = req.headers['content-type']?.includes('x-www-form-urlencoded') ? new URLSearchParams(texto) : undefined;
    const p = url.pathname;
    const json = req.headers['content-type']?.includes('application/json') && texto ? (JSON.parse(texto) as unknown) : undefined;
    this.vistos.push({ metodo: req.method ?? '', caminho: p, busca: url.searchParams, autorizacao: req.headers.authorization, ...(json === undefined ? {} : { corpo: json }) });
    // OAuth do Google: o código (com PKCE) e a renovação.
    if (p === '/oauth2/token' && corpo?.get('grant_type') === 'authorization_code') {
      const desafio = createHash('sha256').update(corpo.get('code_verifier') ?? '').digest('base64url');
      if (corpo.get('code') !== 'codigo-google-bom' || !this.desafios.has(desafio) || corpo.get('redirect_uri') !== VOLTA) return { status: 400, corpo: { error: 'invalid_grant' } };
      return { status: 200, corpo: { access_token: ACESSO_DA_TROCA, expires_in: 3599, refresh_token: RENOVACAO_DA_TROCA, scope: this.concedidos.join(' '), token_type: 'Bearer' } };
    }
    if (p === '/oauth2/token' && corpo?.get('grant_type') === 'refresh_token') {
      if (this.renovacaoRecusada) return { status: 400, corpo: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
      return { status: 200, corpo: { access_token: ACESSO_RENOVADO, expires_in: 3599, token_type: 'Bearer' } };
    }
    if (p === '/oauth2/revoke') return { status: 200, corpo: {} };
    // Google Ads e GA4: esta conta do Google não tem nenhum dos dois.
    if (p === '/ads/v25/customers:listAccessibleCustomers') return { status: 200, corpo: { resourceNames: [] } };
    if (p === '/ga4admin/v1beta/accountSummaries') return { status: 200, corpo: { accountSummaries: [] } };
    // O Perfil da Empresa.
    if (p.startsWith('/contas/') || p.startsWith('/lojas/')) {
      const erro = erroDe(this.lojas);
      if (erro) return erro;
    }
    if (p === '/contas/v1/accounts') return { status: 200, corpo: { accounts: [{ name: CONTA_DO_PERFIL, accountName: 'Mister Burgers' }] } };
    if (p === `/lojas/v1/${CONTA_DO_PERFIL}/locations`) {
      return { status: 200, corpo: { locations: [{ name: LOJA_DO_PERFIL, title: 'Mister Burgers — Centro', websiteUri: 'https://misterburgers.exemplo.test', metadata: { placeId: 'ChIJ-centro' } }] } };
    }
    if (p === `/avaliacoes/v4/${CONTA_DO_PERFIL}/${LOJA_DO_PERFIL}/reviews`) {
      const erro = erroDe(this.avaliacoes);
      if (erro) return { ...erro, cabecalhos: this.esperar ? { 'retry-after': this.esperar } : undefined };
      // Da mais recente para a mais antiga, com o nome e a foto de quem avaliou, como o Google manda.
      const reviews = [...this.lista]
        .sort((a, b) => (a.updateTime < b.updateTime ? 1 : -1))
        .map(({ anonima, ...a }, i) => ({
          ...a,
          name: `${CONTA_DO_PERFIL}/${LOJA_DO_PERFIL}/reviews/${a.reviewId}`,
          reviewer: anonima
            ? { displayName: 'Pessoa Número anônima', isAnonymous: true }
            : { displayName: nomeDeQuemAvaliou(a.reviewId), profilePhotoUrl: `https://lh3.googleusercontent.com/a/foto-${i + 1}`, isAnonymous: false },
        }));
      return { status: 200, corpo: { reviews, ...this.resumo } };
    }
    // Uma avaliação pelo nome e a resposta da empresa (Z2), como a referência REST da v4 descreve (lida em 11/10/2026):
    // `reviews.get`; `reviews.updateReply` é PUT em `…/reply`, com `ReviewReply` no corpo e na volta, e cria a resposta
    // se ela não existir; `reviews.deleteReply` devolve um objeto vazio. A resposta tem a data DELA: a data da avaliação
    // não muda (a referência não diz que mudaria). Para a avaliação que não existe, o 404 NOT_FOUND das APIs do Google.
    const daLoja = `/avaliacoes/v4/${CONTA_DO_PERFIL}/${LOJA_DO_PERFIL}/reviews/`;
    if (p.startsWith(daLoja)) {
      const [id = '', sufixo, ...mais] = p.slice(daLoja.length).split('/');
      const naoAchou = { status: 404, corpo: { error: { code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.' } } };
      const item = this.lista.find((a) => a.reviewId === id);
      if (mais.length || (sufixo !== undefined && sufixo !== 'reply')) return naoAchou;
      if (sufixo === undefined && req.method === 'GET') {
        const erro = erroDe(this.umaAvaliacao);
        if (erro) return { ...erro, cabecalhos: this.esperar ? { 'retry-after': this.esperar } : undefined };
        if (!item) return naoAchou;
        const { anonima, ...a } = item;
        return {
          status: 200,
          corpo: {
            ...a,
            name: `${CONTA_DO_PERFIL}/${LOJA_DO_PERFIL}/reviews/${a.reviewId}`,
            reviewer: anonima ? { displayName: 'Pessoa Número anônima', isAnonymous: true } : { displayName: nomeDeQuemAvaliou(a.reviewId), profilePhotoUrl: 'https://lh3.googleusercontent.com/a/foto-1', isAnonymous: false },
          },
        };
      }
      if (sufixo === 'reply' && req.method === 'PUT') {
        const erro = erroDe(this.resposta);
        if (erro) return { ...erro, cabecalhos: this.esperar ? { 'retry-after': this.esperar } : undefined };
        if (!item) return naoAchou;
        const comment = (json as { comment?: unknown } | undefined)?.comment;
        if (typeof comment !== 'string' || !comment) return { status: 400, corpo: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'Request contains an invalid argument' } } };
        item.reviewReply = { comment, updateTime: new Date().toISOString(), reviewReplyState: this.conferencia };
        if (this.respostaCaiDepoisDeGravar) return { status: 503, corpo: { error: { code: 503, status: 'UNAVAILABLE', message: 'The service is currently unavailable' } } };
        return { status: 200, corpo: item.reviewReply };
      }
      if (sufixo === 'reply' && req.method === 'DELETE') {
        if (!item?.reviewReply) return naoAchou;
        delete item.reviewReply;
        return { status: 200, corpo: {} };
      }
      return naoAchou;
    }
    if (p === `/numeros/v1/${LOJA_DO_PERFIL}:fetchMultiDailyMetricsTimeSeries`) {
      const erro = erroDe(this.numeros);
      if (erro) return { ...erro, cabecalhos: this.esperar ? { 'retry-after': this.esperar } : undefined };
      return { status: 200, corpo: { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: this.series }] } };
    }
    return { status: 404, corpo: { error: { code: 404, status: 'NOT_FOUND', message: p } } };
  }
}

/** `segredoDoApp`: o do app autenticador do dono, para os testes que aprovam com o código. */
export type EmpresaAutorizada = { cookie: string; tenantId: string; userId: string; email: string; segredoDoApp: string; brandId: string; conexaoId: string };
export type EmpresaComLoja = EmpresaAutorizada & { contaId: string };

/**
 * Uma empresa com a função do Perfil ligada e o Google autorizado com a permissão do Perfil, pelo caminho do produto
 * (V46): a pessoa autoriza o Google, e o worker troca o código e procura as lojas. A loja ainda não está ligada.
 */
export async function empresaComPerfilAutorizado(api: TestApi, google: GoogleComPerfil, processador: ConexaoProcessor, nome: string): Promise<EmpresaAutorizada> {
  const s = await signupAndLogin(api, undefined, nome);
  const { secret: segredoDoApp } = await enableMfa(api, s.cookie);
  const tenantId = s.me.active_organization_id as string;
  const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
  const brandId = marca!.id;
  await ligarFlagDaEmpresa(api, 'perfil_google', tenantId, true);

  const inicio = await api.call('POST', '/v1/connections', { cookie: s.cookie, body: { provider: 'google', brand_id: brandId } });
  expect(inicio.status, JSON.stringify(inicio.body)).toBe(201);
  const url = new URL(inicio.body.authorize_url);
  google.registrarDesafio(url.searchParams.get('code_challenge')!);
  const volta = await fetch(`${api.base}/v1/oauth/callback?${new URLSearchParams({ state: url.searchParams.get('state')!, code: 'codigo-google-bom' }).toString()}`, {
    headers: { cookie: s.cookie },
    redirect: 'manual',
  });
  expect(volta.status).toBe(303);
  expect(await processador.processarLote(5, { tenantIds: [tenantId] })).toBe(1);
  return { cookie: s.cookie, tenantId, userId: s.me.user.id as string, email: s.email, segredoDoApp, brandId, conexaoId: inicio.body.id as string };
}

/** A pessoa escolhe a loja do Perfil entre as contas que a autorização achou; devolve a conta ligada. */
export async function ligarLojaDoPerfil(api: TestApi, e: EmpresaAutorizada): Promise<string> {
  const ligar = await api.call('POST', `/v1/connections/${e.conexaoId}/accounts`, { cookie: e.cookie, body: { accounts: [{ provider: 'google_business', external_id: LOJA_DO_PERFIL }] } });
  expect(ligar.status, JSON.stringify(ligar.body)).toBe(200);
  expect(ligar.body.linked).toHaveLength(1);
  return ligar.body.linked[0].id as string;
}

/** A mesma empresa, já com a loja do Perfil ligada à marca. */
export async function empresaComLojaDoPerfil(api: TestApi, google: GoogleComPerfil, processador: ConexaoProcessor, nome: string): Promise<EmpresaComLoja> {
  const e = await empresaComPerfilAutorizado(api, google, processador, nome);
  return { ...e, contaId: await ligarLojaDoPerfil(api, e) };
}
