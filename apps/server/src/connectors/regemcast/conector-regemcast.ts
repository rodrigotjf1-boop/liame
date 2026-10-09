import type { z } from 'zod';
import type { ClienteConector } from '../cliente-http.js';
import { ErroConector } from '../cliente-http.js';
import {
  CampanhaDetalhadaRegemcast,
  CampanhasRegemcast,
  ContaRegemcast,
  ConversaAnuncio,
  ModelosRegemcast,
  OrcamentoRegemcast,
  PaginaConversas,
  PublicosRegemcast,
  RespostaMcp,
  RevogacaoRegemcast,
  SituacaoRegemcast,
} from './contrato-regemcast.js';

// Chamadas ao RegemCast pelo MCP dele (contrato v2, docs/integracoes/regemcast.md; emendas da ADR-008 e da
// ADR-019 de 02/10/2026). MCP 2026-07-28, sem estado: cada chamada é um POST com um pedido JSON-RPC e a
// resposta vem em JSON. A chamada sai pelo cliente dos conectores, como a de qualquer plataforma: endereço
// da distribuição liberado pela origem (V33), cota e disjuntor por conta, novas tentativas e o 401/403/429
// classificados. O token vai só no cabeçalho e nunca em log; a frase de recusa que vai para a mensagem do
// erro é do RegemCast (sem telefone nem token).

/** A versão do protocolo MCP que o conector fala (base §8.1). */
export const VERSAO_MCP = '2026-07-28';
export const VERSAO_CONTRATO_REGEMCAST = 'v2';

const CLIENTE = { name: 'liame', version: VERSAO_CONTRATO_REGEMCAST };

type Contexto = { cliente: ClienteConector; apiUrl: string };

let ultimoId = 0;

function conferir<T extends z.ZodType>(schema: T, corpo: unknown, ferramenta: string): z.infer<T> {
  const r = schema.safeParse(corpo);
  // O corpo não vai para a mensagem (traz telefone): só a ferramenta e o primeiro campo que falhou.
  if (!r.success) {
    const campo = r.error.issues[0]?.path.join('.') || '(corpo)';
    throw new ErroConector('definitivo', 'regemcast', `resposta fora do contrato em ${ferramenta} (${campo})`);
  }
  return r.data;
}

/**
 * Chama uma ferramenta e devolve o `structuredContent` conferido. Erros:
 * - HTTP 401/403/429/5xx: classificados pelo cliente dos conectores (token, conta, limite, passageiro);
 * - erro do protocolo `-32602` "Tool … not found": a ferramenta não existe para este token, ou seja, falta o
 *   escopo (o RegemCast nem lista o que o token não pode usar) → `permissao`;
 * - `isError` da ferramenta: "Erro interno…" é passageiro; o resto (cursor que não vale, argumento fora do
 *   esquema) é definitivo.
 */
async function chamarFerramenta<T extends z.ZodType>(
  ctx: Contexto,
  p: { token: string; contaChave: string; ferramenta: string; argumentos: Record<string, unknown>; schema: T },
): Promise<z.infer<T>> {
  ultimoId = (ultimoId % 1_000_000_000) + 1;
  const r = await ctx.cliente.requisitar({
    provider: 'regemcast',
    conta: p.contaChave,
    url: `${ctx.apiUrl}/mcp`,
    metodo: 'POST',
    cabecalhos: {
      authorization: `Bearer ${p.token}`,
      accept: 'application/json, text/event-stream',
      // A especificação manda o servidor conferir estes contra o corpo (erro -32020 se divergirem).
      'mcp-method': 'tools/call',
      'mcp-name': p.ferramenta,
      'mcp-protocol-version': VERSAO_MCP,
    },
    corpo: {
      jsonrpc: '2.0',
      id: ultimoId,
      method: 'tools/call',
      params: {
        name: p.ferramenta,
        arguments: p.argumentos,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': VERSAO_MCP,
          'io.modelcontextprotocol/clientInfo': CLIENTE,
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    },
    endpoint: p.ferramenta,
    apiVersion: VERSAO_MCP,
  });

  const envelope = RespostaMcp.safeParse(r.corpo);
  if (!envelope.success) throw new ErroConector('definitivo', 'regemcast', `resposta fora do protocolo MCP em ${p.ferramenta}`);
  const { result, error } = envelope.data;
  if (error) {
    const semEscopo = error.code === -32602 && /not found|não encontrada/i.test(error.message);
    throw new ErroConector(
      semEscopo ? 'permissao' : 'definitivo',
      'regemcast',
      semEscopo ? `${p.ferramenta}: o token não tem a permissão desta ferramenta` : `${p.ferramenta}: erro ${error.code} do protocolo MCP`,
      null,
      null,
      String(error.code),
    );
  }
  if (!result) throw new ErroConector('definitivo', 'regemcast', `${p.ferramenta}: resposta MCP sem resultado`);
  if (result.isError) {
    const texto = (result.content?.find((c) => c.type === 'text')?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    const interno = /^erro interno/i.test(texto);
    throw new ErroConector(interno ? 'transitorio' : 'definitivo', 'regemcast', `${p.ferramenta}: ${texto || 'recusada pela ferramenta'}`);
  }
  return conferir(p.schema, result.structuredContent, p.ferramenta);
}

/** De quem é o token: a conta (id que não muda, nome, fuso), o produto, a classe e as permissões. */
export function lerSituacao(ctx: Contexto, token: string, contaChave: string): Promise<SituacaoRegemcast> {
  return chamarFerramenta(ctx, { token, contaChave, ferramenta: 'integracao_situacao', argumentos: {}, schema: SituacaoRegemcast });
}

/**
 * Uma página das conversas abertas por anúncio. `desde` (instante ISO) só na carga inicial: a ferramenta
 * filtra pela hora da mensagem e o cursor anda junto.
 */
export async function lerConversas(
  ctx: Contexto,
  p: { token: string; contaChave: string; cursor: string | null; limite?: number; desde?: string | null },
): Promise<{ itens: ConversaAnuncio[]; proximoCursor: string | null; temMais: boolean }> {
  const argumentos: Record<string, unknown> = { limite: p.limite ?? 200 };
  if (p.cursor) argumentos.cursor = p.cursor;
  if (p.desde) argumentos.desde = p.desde;
  const pg = await chamarFerramenta(ctx, { token: p.token, contaChave: p.contaChave, ferramenta: 'conversas_anuncio_listar', argumentos, schema: PaginaConversas });
  return { itens: pg.itens, proximoCursor: pg.proximo_cursor, temMais: pg.tem_mais };
}

// ---------------------------------------------------------------- a mensageria (A5, Y4; contrato §8)
// Leituras para o Liame saber o que dá para enviar e o que já foi enviado. Cada uma pede a permissão dela no token
// (sem ela, a ferramenta "não existe" e a chamada sai como `permissao`). Nenhuma traz telefone nem nome de contato, e
// nenhuma muda nada no RegemCast.

type Acesso = { token: string; contaChave: string };

/** Se a conta pode enviar agora (a saúde do WhatsApp na Meta, com o que resolver), o plano e o uso do ciclo. `conta.ler`. */
export function lerContaDeMensagens(ctx: Contexto, a: Acesso): Promise<ContaRegemcast> {
  return chamarFerramenta(ctx, { ...a, ferramenta: 'conta_situacao', argumentos: {}, schema: ContaRegemcast });
}

/** As campanhas de mensagens, das mais novas para as mais antigas, com os números de cada uma (até 50). `campanhas.ler`. */
export function lerCampanhasDeMensagens(ctx: Contexto, a: Acesso & { situacao?: string | null; limite?: number }): Promise<CampanhasRegemcast> {
  const argumentos: Record<string, unknown> = { limite: Math.min(50, Math.max(1, a.limite ?? 20)) };
  if (a.situacao) argumentos.situacao = a.situacao;
  return chamarFerramenta(ctx, { token: a.token, contaChave: a.contaChave, ferramenta: 'campanhas_listar', argumentos, schema: CampanhasRegemcast });
}

/** Uma campanha: por que está pausada ou esperando, as falhas por motivo e o custo na Meta. Não diz quem recebeu. `campanhas.ler`. */
export function detalharCampanhaDeMensagens(ctx: Contexto, a: Acesso & { id: string }): Promise<CampanhaDetalhadaRegemcast> {
  return chamarFerramenta(ctx, { token: a.token, contaChave: a.contaChave, ferramenta: 'campanha_detalhar', argumentos: { id: a.id }, schema: CampanhaDetalhadaRegemcast });
}

/** As listas, os públicos prontos e os perfis da base, com quantas pessoas de cada um podem receber. Só contagens. `publicos.ler`. */
export function lerPublicos(ctx: Contexto, a: Acesso): Promise<PublicosRegemcast> {
  return chamarFerramenta(ctx, { ...a, ferramenta: 'publicos_listar', argumentos: {}, schema: PublicosRegemcast });
}

/** Os modelos de mensagem como a Meta os tem agora (o RegemCast fala com a Meta nesta chamada). `modelos.ler`. */
export function lerModelos(ctx: Contexto, a: Acesso & { soAprovados?: boolean }): Promise<ModelosRegemcast> {
  return chamarFerramenta(ctx, { token: a.token, contaChave: a.contaChave, ferramenta: 'modelos_listar', argumentos: a.soAprovados ? { soAprovados: true } : {}, schema: ModelosRegemcast });
}

/** Os tetos de gasto de mensagens que o dono da conta definiu no RegemCast e quanto já saiu em cada período. `orcamento.ler`. */
export function lerOrcamentoDeMensagens(ctx: Contexto, a: Acesso): Promise<OrcamentoRegemcast> {
  return chamarFerramenta(ctx, { ...a, ferramenta: 'orcamento_ler', argumentos: {}, schema: OrcamentoRegemcast });
}

/** Desliga o token no RegemCast (segunda camada: ele já saiu do cofre do Liame). */
export async function revogarNoRegemcast(ctx: Contexto, token: string, contaChave: string): Promise<void> {
  await chamarFerramenta(ctx, { token, contaChave, ferramenta: 'integracao_revogar', argumentos: { confirmar: true }, schema: RevogacaoRegemcast });
}
