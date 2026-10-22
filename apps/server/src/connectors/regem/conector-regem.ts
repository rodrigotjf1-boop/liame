import type { z } from 'zod';
import type { ClienteConector } from '../cliente-http.js';
import { ErroConector } from '../cliente-http.js';
import { CABECALHO_LIGACAO } from '../dms/integracao-dms.js';
import type { AcessoAoRegem } from './acesso-da-loja.js';
import { AvisoRegem, CupomRegem, LigacaoRegem, LigacoesDoClique, LojaRegem, PedidoDeAutorizacaoRegem, pagina, TokensRegem } from './contrato-regem.js';

// Chamadas ao Regem pelo contrato v1 (docs/integracoes/regem.md; ADR-019). A credencial vai só no cabeçalho e nunca em
// log; o endereço é o da distribuição, liberado no cliente HTTP (V33). Cota e disjuntor por loja, como nas plataformas
// de anúncio. Cada chamada recebe o acesso da loja (`acesso-da-loja.ts`): o `rgm_it_`, ou o token do DMS ID do
// aplicativo do Liame com o segredo da ligação no `DMS-Ligacao` (Hub DMS, F3). As recusas vêm em problem+json, com o
// nome do problema em `codigoProvider` (`token-invalido`, `ligacao-invalida`, `escopo-insuficiente`…).

export const VERSAO_CONTRATO_REGEM = 'v1';

type Contexto = { cliente: ClienteConector; apiUrl: string };

function conferir<T extends z.ZodType>(schema: T, corpo: unknown, rota: string): z.infer<T> {
  const r = schema.safeParse(corpo);
  // O corpo não vai para a mensagem (pode trazer telefone): só a rota e o primeiro campo que falhou.
  if (!r.success) {
    const campo = r.error.issues[0]?.path.join('.') || '(corpo)';
    throw new ErroConector('definitivo', 'regem', `resposta fora do contrato em ${rota} (${campo})`);
  }
  return r.data;
}

/** Os cabeçalhos da credencial: o token e, pela ligação, o segredo dela. */
function cabecalhosDoAcesso(a: AcessoAoRegem): Record<string, string> {
  return { authorization: `Bearer ${a.token}`, ...(a.ligacao ? { [CABECALHO_LIGACAO]: a.ligacao } : {}) };
}

/** Quem é a loja do acesso (nome, fuso, moeda, escopos que valem na chamada). */
export async function lerLoja(ctx: Contexto, a: AcessoAoRegem): Promise<LojaRegem> {
  const r = await ctx.cliente.requisitar({
    provider: 'regem',
    conta: a.lojaChave,
    url: `${ctx.apiUrl}/loja`,
    cabecalhos: cabecalhosDoAcesso(a),
    endpoint: 'loja',
    apiVersion: VERSAO_CONTRATO_REGEM,
  });
  return conferir(LojaRegem, r.corpo, 'loja');
}

/** Uma página de uma rota com cursor (pedidos, cupons, usos, clientes anonimizados). */
export async function lerPagina<T extends z.ZodType>(
  ctx: Contexto,
  p: AcessoAoRegem & { rota: string; item: T; cursor: string | null; limite?: number; extra?: Record<string, string> },
): Promise<{ itens: z.infer<T>[]; proximoCursor: string | null; temMais: boolean }> {
  const q = new URLSearchParams({ limite: String(p.limite ?? 200), ...(p.cursor ? { cursor: p.cursor } : {}), ...(p.extra ?? {}) });
  const r = await ctx.cliente.requisitar({
    provider: 'regem',
    conta: p.lojaChave,
    url: `${ctx.apiUrl}/${p.rota}?${q.toString()}`,
    cabecalhos: cabecalhosDoAcesso(p),
    endpoint: p.rota,
    apiVersion: VERSAO_CONTRATO_REGEM,
  });
  const pg = conferir(pagina(p.item), r.corpo, p.rota);
  return { itens: pg.itens as z.infer<T>[], proximoCursor: pg.proximo_cursor, temMais: pg.tem_mais };
}

/**
 * Troca o código da autorização (C1b) pelos tokens das lojas escolhidas, entre servidores, com o PKCE e
 * a credencial de cliente do Liame (da distribuição). Uma tentativa só: o código vale uma vez.
 */
export async function trocarCodigoRegem(
  ctx: Contexto,
  p: { codigo: string; verificador: string; redirectUri: string; clientId: string; clientSecret: string },
): Promise<TokensRegem> {
  const r = await ctx.cliente.requisitar({
    provider: 'regem',
    conta: 'autorizacao',
    url: `${ctx.apiUrl}/autorizacao/token`,
    metodo: 'POST',
    corpo: { code: p.codigo, code_verifier: p.verificador, redirect_uri: p.redirectUri, client_id: p.clientId, client_secret: p.clientSecret },
    endpoint: 'autorizacao/token',
    apiVersion: VERSAO_CONTRATO_REGEM,
  });
  return conferir(TokensRegem, r.corpo, 'autorizacao/token');
}

// ---------------------------------------------------------------- a autorização por clique (Hub DMS, F3, parte C)
// O presidente da empresa no Regem liga o Liame numa página de lá, confirmando com a senha do Regem (Regem #706). O
// servidor do Liame registra o pedido antes (pedido empurrado, RFC 9126) e, depois da volta, troca o código por uma
// ligação por loja; as duas chamadas vão com o token do DMS ID do aplicativo do Liame, de servidor para servidor. O
// contrato é o da B1 do RegemCast. As recusas vêm em problem+json (`token-invalido`, `cliente-invalido`,
// `parametro-invalido`, `autorizacao-invalida`, `integracao-parada`); 404 = a autorização por clique desligada no Regem.

/** A conta que pede, no Liame: o que a página do Regem mostra ao presidente antes de ele decidir. */
export type ContaQuePedeAoRegem = { nome: string; cnpj: string | null; email: string; marca: string | null };

/**
 * O pedido empurrado (RFC 9126): o Regem guarda o endereço de volta, as permissões, o `state`, o desafio PKCE e a conta
 * que pede, e devolve o número do pedido. O navegador leva só o aplicativo e esse número, então o que a página mostra
 * não se troca no caminho. Uma tentativa só: pedido repetido é outro pedido.
 */
export async function pedirAutorizacaoAoRegem(
  ctx: Contexto,
  a: { tokenDmsId: string; contaChave: string; clientId: string; redirectUri: string; estado: string; desafio: string; permissoes: readonly string[]; conta: ContaQuePedeAoRegem },
): Promise<PedidoDeAutorizacaoRegem> {
  const corpo: Record<string, string> = {
    response_type: 'code',
    client_id: a.clientId,
    redirect_uri: a.redirectUri,
    scope: a.permissoes.join(' '),
    state: a.estado,
    code_challenge: a.desafio,
    code_challenge_method: 'S256',
    conta_nome: a.conta.nome,
    conta_email: a.conta.email,
    ...(a.conta.cnpj ? { conta_cnpj: a.conta.cnpj } : {}),
    ...(a.conta.marca ? { conta_marca: a.conta.marca } : {}),
  };
  const r = await ctx.cliente.requisitar({
    provider: 'regem',
    conta: a.contaChave,
    url: `${ctx.apiUrl}/autorizacao/pedido`,
    metodo: 'POST',
    cabecalhos: { authorization: `Bearer ${a.tokenDmsId}` },
    corpo,
    endpoint: 'autorizacao/pedido',
    apiVersion: VERSAO_CONTRATO_REGEM,
  });
  return conferir(PedidoDeAutorizacaoRegem, r.corpo, 'autorizacao/pedido');
}

/**
 * Troca o código da volta por uma ligação por loja. O código vale uma vez, 10 minutos, e o Regem o gasta antes de
 * conferir o verificador e o endereço: uma tentativa só. Os segredos em claro nunca vão para log.
 */
export async function trocarCodigoDoCliqueRegem(
  ctx: Contexto,
  a: { tokenDmsId: string; contaChave: string; clientId: string; codigo: string; verificador: string; redirectUri: string },
): Promise<LigacoesDoClique> {
  const r = await ctx.cliente.requisitar({
    provider: 'regem',
    conta: a.contaChave,
    url: `${ctx.apiUrl}/autorizacao/token`,
    metodo: 'POST',
    cabecalhos: { authorization: `Bearer ${a.tokenDmsId}` },
    corpo: { grant_type: 'authorization_code', code: a.codigo, code_verifier: a.verificador, redirect_uri: a.redirectUri, client_id: a.clientId },
    endpoint: 'autorizacao/token',
    apiVersion: VERSAO_CONTRATO_REGEM,
  });
  return conferir(LigacoesDoClique, r.corpo, 'autorizacao/token');
}

/**
 * Registra (ou repete) no Regem para onde ele avisa que algo mudou nesta loja (contrato §3): o endereço do
 * inbox desta conexão e o segredo da assinatura. O segredo vai só no corpo e nunca em log. A cota e o
 * disjuntor são à parte dos da leitura (`<loja>:aviso`): o aviso fora do ar não segura as vendas. O registro é do id do
 * token, que é o mesmo da ligação: registrar por uma vale para as duas.
 */
export async function registrarAvisoNoRegem(ctx: Contexto, a: AcessoAoRegem, p: { url: string; segredo: string }): Promise<AvisoRegem> {
  const r = await ctx.cliente.requisitar({
    provider: 'regem',
    conta: `${a.lojaChave}:aviso`,
    url: `${ctx.apiUrl}/webhook`,
    metodo: 'PUT',
    corpo: { url: p.url, segredo: p.segredo },
    cabecalhos: cabecalhosDoAcesso(a),
    endpoint: 'webhook',
    apiVersion: VERSAO_CONTRATO_REGEM,
  });
  return conferir(AvisoRegem, r.corpo, 'webhook');
}

/**
 * Revoga o acesso da loja no Regem (segunda camada: a credencial já saiu do cofre do Liame). Revogar o token revoga a
 * ligação; pela ligação (a da autorização por clique), o Regem revoga a linha dela, que é a do acesso da loja.
 */
export async function revogarNoRegem(ctx: Contexto, a: AcessoAoRegem): Promise<void> {
  try {
    await ctx.cliente.requisitar({
      provider: 'regem',
      conta: a.lojaChave,
      url: `${ctx.apiUrl}/autorizacao/revogar`,
      metodo: 'POST',
      corpo: {},
      cabecalhos: cabecalhosDoAcesso(a),
      endpoint: 'autorizacao/revogar',
      apiVersion: VERSAO_CONTRATO_REGEM,
    });
  } catch (err) {
    // Já revogado lá: o objetivo foi atingido. Pelo `rgm_it_`, todo 401 é dele. Pela ligação, só `ligacao-invalida`: o
    // `token-invalido` é o token do DMS ID do aplicativo recusado, e a ligação segue valendo lá (sobe, e quem pede o
    // token pede outro uma vez; ERR-149).
    if (err instanceof ErroConector && err.tipo === 'autenticacao' && (!a.ligacao || err.codigoProvider === 'ligacao-invalida')) return;
    throw err;
  }
}

/**
 * Cria o cupom de campanha na loja (contrato de cupons §3.3). O Regem exige `Idempotency-Key` e nunca atualiza cupom
 * existente pelo código (409): a mesma chave devolve o mesmo cupom. A resposta é conferida por quem chama (o cupom pode
 * ter nascido mesmo com a resposta fora do contrato).
 */
export async function criarCupomNoRegem(ctx: Contexto, a: AcessoAoRegem, p: { regra: unknown; chaveDeIdempotencia: string }): Promise<unknown> {
  const r = await ctx.cliente.requisitar({
    provider: 'regem',
    conta: a.lojaChave,
    url: `${ctx.apiUrl}/cupons`,
    metodo: 'POST',
    corpo: p.regra,
    cabecalhos: { ...cabecalhosDoAcesso(a), 'idempotency-key': p.chaveDeIdempotencia },
    endpoint: 'cupons.criar',
    apiVersion: VERSAO_CONTRATO_REGEM,
  });
  return r.corpo;
}

/** A resposta da criação conferida pelo contrato do cupom, ou nula se veio fora dele. */
export function cupomCriado(corpo: unknown): CupomRegem | null {
  const lido = CupomRegem.safeParse(corpo);
  return lido.success ? lido.data : null;
}

/**
 * A troca automática do Hub DMS (F3, parte A; Regem #690): com o token do DMS ID do aplicativo do Liame e o `rgm_it_`
 * que ele já usa na loja, o Regem devolve o segredo da ligação, com o mesmo id, a loja e as permissões do token. Repetir
 * gira o segredo (o anterior para de valer). Recusas: 401 `token-invalido` (o token do DMS ID) ou `ligacao-invalida` (o
 * `rgm_it_` não vale para o aplicativo); 403 `escopo-insuficiente` (o token sem permissão do Regem); 404 com a via
 * desligada no Regem; 503 `integracao-parada`. O segredo em claro nunca vai para log.
 */
export async function trocarPorLigacaoRegem(ctx: Contexto, a: { tokenDmsId: string; tokenIntegracao: string; lojaChave: string }): Promise<LigacaoRegem> {
  const r = await ctx.cliente.requisitar({
    provider: 'regem',
    conta: a.lojaChave,
    url: `${ctx.apiUrl}/dms-id/ligacao`,
    metodo: 'POST',
    cabecalhos: { authorization: `Bearer ${a.tokenDmsId}` },
    corpo: { token_integracao: a.tokenIntegracao },
    endpoint: 'dms-id/ligacao',
    apiVersion: VERSAO_CONTRATO_REGEM,
  });
  return conferir(LigacaoRegem, r.corpo, 'dms-id/ligacao');
}
