import { createHash, randomBytes } from 'node:crypto';
import type { AppConfig } from '../config.js';
import { enderecoLiberado, ErroConector } from '../connectors/cliente-http.js';

// OAuth das plataformas (A2, G3; base §2.1 e §3.1). Estado aleatório guardado só como hash; PKCE (S256)
// no Google; na Meta, o Facebook Login for Business com `config_id` devolve o token de usuário do
// sistema da integração, que não expira por padrão (a Meta não documenta PKCE nesse fluxo). Segredos
// do app são da distribuição (config); o token da empresa vai direto para o cofre, nunca para log.

export type ProvedorOAuth = 'meta' | 'google' | 'regem' | 'regemcast';

/** Escopos do Google: Ads e GA4 só leitura na mesma autorização (plano-a2 §1). */
export const ESCOPOS_GOOGLE = ['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/analytics.readonly'];

const TEMPO_LIMITE_MS = 15_000;

export const novoEstado = (): string => randomBytes(32).toString('base64url');
export const hashEstado = (estado: string): string => createHash('sha256').update(estado, 'utf8').digest('hex');
export const novoVerificador = (): string => randomBytes(48).toString('base64url');
export const desafioPkce = (verificador: string): string => createHash('sha256').update(verificador, 'ascii').digest('base64url');

/** Endereço de volta registrado nos apps das plataformas. */
export const enderecoDeVolta = (config: Pick<AppConfig, 'apiUrl'>): string => `${config.apiUrl}/v1/oauth/callback`;

/** Para onde mandar a pessoa autorizar. */
export function urlDeAutorizacao(
  provedor: ProvedorOAuth,
  config: Pick<AppConfig, 'oauth'>,
  p: { estado: string; redirectUri: string; verificador?: string; versaoMeta: string },
): string {
  if (provedor === 'meta') {
    const meta = config.oauth.meta!;
    const q = new URLSearchParams({
      client_id: meta.appId,
      redirect_uri: p.redirectUri,
      state: p.estado,
      config_id: meta.configId,
      response_type: 'code',
      override_default_response_type: 'true',
    });
    return `${meta.dialogUrl}/${p.versaoMeta}/dialog/oauth?${q.toString()}`;
  }
  if (provedor === 'regem') {
    // Página "Autorizar o Liame" do Regem (C1b): o presidente escolhe as lojas e vê os escopos.
    const regem = config.oauth.regem!;
    const q = new URLSearchParams({
      cliente: regem.clientId,
      redirect_uri: p.redirectUri,
      state: p.estado,
      code_challenge: desafioPkce(p.verificador!),
      code_challenge_method: 'S256',
    });
    return `${regem.authUrl}/integracoes/autorizar?${q.toString()}`;
  }
  if (provedor === 'regemcast') throw new ErroConector('definitivo', 'regemcast', 'autorização do RegemCast ainda não existe (C2b)');
  const google = config.oauth.google!;
  const q = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: p.redirectUri,
    response_type: 'code',
    scope: ESCOPOS_GOOGLE.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state: p.estado,
    code_challenge: desafioPkce(p.verificador!),
    code_challenge_method: 'S256',
  });
  return `${google.authUrl}/o/oauth2/v2/auth?${q.toString()}`;
}

/** Credencial guardada no cofre (JSON), por provedor. */
export type CredencialMeta = { tipo: 'meta'; access_token: string; obtido_em: string; expira_em: string | null };
export type CredencialGoogle = { tipo: 'google'; refresh_token: string; escopos: string[]; obtido_em: string; refresh_expira_em: string | null };
/** Produtos DMS: um token por loja (Regem) ou por conta (RegemCast), com os escopos concedidos. */
type TokensDeLoja = { lojas: { loja_id: string; token: string; escopos: string[] }[]; obtido_em: string };
export type CredencialRegem = (TokensDeLoja & { tipo: 'regem' }) | (TokensDeLoja & { tipo: 'regemcast' });
export type CredencialGuardada = CredencialMeta | CredencialGoogle | CredencialRegem;

export type ResultadoTroca = {
  credencial: CredencialGuardada;
  /** Token de acesso para já descobrir as contas (Google: curto; nunca guardado). */
  accessToken: string;
  escopos: string[];
  refreshExpiraEm: Date | null;
};

type Enderecos = { graph: string; googleToken: string };

async function pedir(provider: string, url: string, init: RequestInit, liberados: string[]): Promise<{ status: number; corpo: Record<string, unknown> }> {
  if (!enderecoLiberado(url, liberados)) throw new ErroConector('definitivo', provider, 'endereço de OAuth fora da lista');
  let resposta: Response;
  try {
    resposta = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TEMPO_LIMITE_MS) });
  } catch (err) {
    throw new ErroConector('transitorio', provider, `OAuth sem resposta: ${err instanceof Error ? err.name : 'erro'}`);
  }
  const texto = await resposta.text();
  let corpo: Record<string, unknown> = {};
  try {
    corpo = texto ? (JSON.parse(texto) as Record<string, unknown>) : {};
  } catch {
    corpo = {};
  }
  return { status: resposta.status, corpo };
}

/** Erro do OAuth sem ecoar corpo (pode trazer pedaço de token): só o código e o status. */
function erroOAuth(provider: string, status: number, corpo: Record<string, unknown>): ErroConector {
  const codigo = typeof corpo.error === 'string' ? corpo.error : typeof (corpo.error as { code?: unknown })?.code === 'number' ? String((corpo.error as { code: number }).code) : null;
  if (status >= 500 || status === 429) return new ErroConector(status === 429 ? 'limite' : 'transitorio', provider, `OAuth: HTTP ${status}`, status, null, codigo);
  return new ErroConector('autenticacao', provider, `OAuth recusado (${codigo ?? status})`, status, null, codigo);
}

/** Troca o código pela credencial. Uma tentativa só: o código vale uma vez. */
export async function trocarCodigo(
  provedor: ProvedorOAuth,
  config: Pick<AppConfig, 'oauth'>,
  enderecos: Enderecos,
  p: { codigo: string; redirectUri: string; verificador: string | null; versaoMeta: string },
  agora = new Date(),
): Promise<ResultadoTroca> {
  if (provedor === 'regem' || provedor === 'regemcast') throw new ErroConector('definitivo', provedor, 'a troca dos produtos DMS é do conector deles');
  if (provedor === 'meta') {
    const meta = config.oauth.meta!;
    const q = new URLSearchParams({ client_id: meta.appId, redirect_uri: p.redirectUri, client_secret: meta.appSecret, code: p.codigo });
    const r = await pedir('meta_ads', `${enderecos.graph}/${p.versaoMeta}/oauth/access_token?${q.toString()}`, { method: 'GET', headers: { accept: 'application/json' } }, [enderecos.graph]);
    const token = r.corpo.access_token;
    if (r.status !== 200 || typeof token !== 'string') throw erroOAuth('meta_ads', r.status, r.corpo);
    const expira = typeof r.corpo.expires_in === 'number' || typeof r.corpo.expires_in === 'string' ? Number(r.corpo.expires_in) : 0;
    return {
      credencial: { tipo: 'meta', access_token: token, obtido_em: agora.toISOString(), expira_em: expira > 0 ? new Date(agora.getTime() + expira * 1000).toISOString() : null },
      accessToken: token,
      escopos: [],
      refreshExpiraEm: null,
    };
  }
  const google = config.oauth.google!;
  const corpo = new URLSearchParams({
    code: p.codigo,
    client_id: google.clientId,
    client_secret: google.clientSecret,
    redirect_uri: p.redirectUri,
    grant_type: 'authorization_code',
    ...(p.verificador ? { code_verifier: p.verificador } : {}),
  });
  const r = await pedir(
    'google_oauth',
    `${enderecos.googleToken}/token`,
    { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: corpo.toString() },
    [enderecos.googleToken],
  );
  const acesso = r.corpo.access_token;
  const refresh = r.corpo.refresh_token;
  if (r.status !== 200 || typeof acesso !== 'string') throw erroOAuth('google_oauth', r.status, r.corpo);
  // Sem refresh token não há leitura diária: a autorização precisa ser refeita com consentimento.
  if (typeof refresh !== 'string') throw new ErroConector('autenticacao', 'google_oauth', 'OAuth do Google sem refresh token', r.status, null, 'sem_refresh_token');
  const escopos = typeof r.corpo.scope === 'string' ? r.corpo.scope.split(' ').filter(Boolean) : [];
  const vidaRefresh = Number(r.corpo.refresh_token_expires_in ?? 0);
  const refreshExpiraEm = vidaRefresh > 0 ? new Date(agora.getTime() + vidaRefresh * 1000) : null;
  return {
    credencial: { tipo: 'google', refresh_token: refresh, escopos, obtido_em: agora.toISOString(), refresh_expira_em: refreshExpiraEm?.toISOString() ?? null },
    accessToken: acesso,
    escopos,
    refreshExpiraEm,
  };
}

/** Token de acesso curto do Google a partir do refresh token (só na memória de quem vai ler). */
export async function acessoGoogle(config: Pick<AppConfig, 'oauth'>, tokenUrl: string, refreshToken: string): Promise<string> {
  const google = config.oauth.google;
  if (!google) throw new ErroConector('definitivo', 'google_oauth', 'app OAuth do Google não configurado');
  const corpo = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: google.clientId, client_secret: google.clientSecret });
  const r = await pedir('google_oauth', `${tokenUrl}/token`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: corpo.toString() }, [tokenUrl]);
  if (r.status !== 200 || typeof r.corpo.access_token !== 'string') throw erroOAuth('google_oauth', r.status, r.corpo);
  return r.corpo.access_token;
}

/** Revoga no Google (o refresh token e os acessos dele). A Meta não documenta revogação por API: a empresa remove o app nas Configurações do negócio. */
export async function revogarGoogle(tokenUrl: string, token: string): Promise<void> {
  const r = await pedir(
    'google_oauth',
    `${tokenUrl}/revoke`,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() },
    [tokenUrl],
  );
  // 400 invalid_token = já estava revogado: o objetivo foi atingido.
  if (r.status !== 200 && !(r.status === 400 && r.corpo.error === 'invalid_token')) throw erroOAuth('google_oauth', r.status, r.corpo);
}
