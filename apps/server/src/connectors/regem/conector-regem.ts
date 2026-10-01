import type { z } from 'zod';
import type { ClienteConector } from '../cliente-http.js';
import { ErroConector } from '../cliente-http.js';
import { AvisoRegem, LojaRegem, pagina, TokensRegem } from './contrato-regem.js';

// Chamadas ao Regem pelo contrato v1 (docs/integracoes/regem.md; ADR-019). O token da loja vai só no
// cabeçalho e nunca em log; o endereço é o da distribuição, liberado no cliente HTTP (V33). Cota e
// disjuntor por loja, como nas plataformas de anúncio.

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

/** Quem é a loja do token (nome, fuso, moeda, escopos concedidos). */
export async function lerLoja(ctx: Contexto, token: string, lojaChave: string): Promise<LojaRegem> {
  const r = await ctx.cliente.requisitar({
    provider: 'regem',
    conta: lojaChave,
    url: `${ctx.apiUrl}/loja`,
    cabecalhos: { authorization: `Bearer ${token}` },
    endpoint: 'loja',
    apiVersion: VERSAO_CONTRATO_REGEM,
  });
  return conferir(LojaRegem, r.corpo, 'loja');
}

/** Uma página de uma rota com cursor (pedidos, cupons, usos, clientes anonimizados). */
export async function lerPagina<T extends z.ZodType>(
  ctx: Contexto,
  p: { token: string; lojaChave: string; rota: string; item: T; cursor: string | null; limite?: number; extra?: Record<string, string> },
): Promise<{ itens: z.infer<T>[]; proximoCursor: string | null; temMais: boolean }> {
  const q = new URLSearchParams({ limite: String(p.limite ?? 200), ...(p.cursor ? { cursor: p.cursor } : {}), ...(p.extra ?? {}) });
  const r = await ctx.cliente.requisitar({
    provider: 'regem',
    conta: p.lojaChave,
    url: `${ctx.apiUrl}/${p.rota}?${q.toString()}`,
    cabecalhos: { authorization: `Bearer ${p.token}` },
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

/**
 * Registra (ou repete) no Regem para onde ele avisa que algo mudou nesta loja (contrato §3): o endereço do
 * inbox desta conexão e o segredo da assinatura. O segredo vai só no corpo e nunca em log. A cota e o
 * disjuntor são à parte dos da leitura (`<loja>:aviso`): o aviso fora do ar não segura as vendas.
 */
export async function registrarAvisoNoRegem(ctx: Contexto, token: string, lojaChave: string, p: { url: string; segredo: string }): Promise<AvisoRegem> {
  const r = await ctx.cliente.requisitar({
    provider: 'regem',
    conta: `${lojaChave}:aviso`,
    url: `${ctx.apiUrl}/webhook`,
    metodo: 'PUT',
    corpo: { url: p.url, segredo: p.segredo },
    cabecalhos: { authorization: `Bearer ${token}` },
    endpoint: 'webhook',
    apiVersion: VERSAO_CONTRATO_REGEM,
  });
  return conferir(AvisoRegem, r.corpo, 'webhook');
}

/** Revoga o token da loja no Regem (segunda camada: o token já saiu do cofre do Liame). */
export async function revogarNoRegem(ctx: Contexto, token: string, lojaChave: string): Promise<void> {
  try {
    await ctx.cliente.requisitar({
      provider: 'regem',
      conta: lojaChave,
      url: `${ctx.apiUrl}/autorizacao/revogar`,
      metodo: 'POST',
      corpo: {},
      cabecalhos: { authorization: `Bearer ${token}` },
      endpoint: 'autorizacao/revogar',
      apiVersion: VERSAO_CONTRATO_REGEM,
    });
  } catch (err) {
    // Já revogado lá (401): o objetivo foi atingido.
    if (err instanceof ErroConector && err.tipo === 'autenticacao') return;
    throw err;
  }
}
