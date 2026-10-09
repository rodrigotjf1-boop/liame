import type { z } from 'zod';
import type { ClienteConector } from '../cliente-http.js';
import { ErroConector } from '../cliente-http.js';
import {
  CampanhaDetalhadaRegemcast,
  CampanhasRegemcast,
  ContaRegemcast,
  ConversaAnuncio,
  DisparoRegemcast,
  EstimativaRegemcast,
  ModelosRegemcast,
  OrcamentoRegemcast,
  PaginaConversas,
  PausaRegemcast,
  PlanoDoDisparoRegemcast,
  PublicosRegemcast,
  RascunhoDeCampanhaRegemcast,
  RascunhoDeModeloRegemcast,
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

// ---------------------------------------------------------------- o pedido de mensagem (A5, Y5; contrato §9)
// As ferramentas que montam e disparam uma campanha. As de rascunho gravam no RegemCast e não fazem mensagem sair. O
// disparo é a única que custa dinheiro: só roda com a confirmação do plano e só se nada mudou desde ele. Toda
// ferramenta que grava leva uma chave de idempotência: repetir o MESMO pedido com a mesma chave devolve a mesma
// resposta, sem fazer de novo (é o que deixa a nova tentativa do cliente dos conectores segura). O público sai sempre
// de uma lista ou da base do RegemCast: estas funções não têm por onde mandar um número de telefone.

/** De onde sai o público, como o RegemCast o descreve (`publicos_listar` dá os ids). */
export type PublicoDaCampanha = {
  origem: 'lista' | 'importacao' | 'base' | 'perfil' | 'regiao' | 'publico';
  /** O id da lista ou da importação. */
  origemId?: string;
  /** O id do perfil. */
  segmento?: string;
  uf?: string;
  /** O id do público pronto. */
  publico?: string;
  /** O bairro, o mês ou o produto, quando o público pede. */
  publicoValor?: string;
};

/** O valor de uma variável da mensagem. O nome de cada pessoa é posto pelo RegemCast: o Liame nunca o vê. */
export type VariavelDaMensagem = { origem: 'fixo' | 'nome' | 'primeiro_nome' | 'cashback_saldo' | 'cashback_validade'; valor?: string };

export type ModeloParaRascunhar = {
  /** O rascunho a alterar: só um que o Liame criou e que ainda não foi enviado à Meta. */
  id?: string;
  nome: string;
  categoria: 'marketing' | 'utilidade';
  idioma?: string;
  titulo?: string;
  tituloExemplo?: string;
  corpo: string;
  corpoExemplos?: string[];
  rodape?: string;
  botoes?: Array<{ tipo: 'URL' | 'PHONE_NUMBER' | 'QUICK_REPLY' | 'COPY_CODE'; texto: string; url?: string; telefone?: string }>;
};

export type CampanhaParaRascunhar = {
  nome: string;
  /** O nome do modelo aprovado, como veio em `modelos_listar`. */
  modeloNome: string;
  modeloIdioma?: string;
  publico: PublicoDaCampanha;
  variaveis?: VariavelDaMensagem[];
  variavelDoTitulo?: VariavelDaMensagem;
  /** 0 = domingo … 6 = sábado. */
  janelaDias?: number[];
  /** HH:MM, no fuso da conta. */
  janelaInicio?: string;
  janelaFim?: string;
  pausaSegundos?: number;
  maxPorDia?: number;
  maxPorSemana?: number;
  maxPorMes?: number;
};

/** A chave de idempotência como o RegemCast a aceita: 8 a 100 letras, números, ponto, dois-pontos, hífen e sublinhado. */
export const FORMATO_DA_CHAVE_REGEMCAST = /^[A-Za-z0-9_.:-]{8,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O que não tem o formato que o RegemCast exige nem sai do Liame. */
function exigir(cond: boolean, oque: string): void {
  if (!cond) throw new ErroConector('definitivo', 'regemcast', `${oque} fora do formato do RegemCast`);
}

/** Sem os campos vazios: o RegemCast confere o pedido campo a campo, e a chave de idempotência compara o pedido inteiro. */
function semVazios<T extends Record<string, unknown>>(o: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));
}

/** Quantas pessoas de um público podem receber, quantas estão em descanso e, com a categoria, o custo estimado (teto). `publicos.ler`. */
export function estimarPublico(ctx: Contexto, a: Acesso & { publico: PublicoDaCampanha; categoria?: 'marketing' | 'utilidade' }): Promise<EstimativaRegemcast> {
  return chamarFerramenta(ctx, { token: a.token, contaChave: a.contaChave, ferramenta: 'publico_estimar', argumentos: semVazios({ ...a.publico, categoria: a.categoria }), schema: EstimativaRegemcast });
}

/** Grava um rascunho de modelo no RegemCast e devolve o que barraria o envio. Não vai para a Meta: quem envia é uma pessoa. `modelos.rascunhar`. */
export function rascunharModelo(ctx: Contexto, a: Acesso & { chave: string; modelo: ModeloParaRascunhar }): Promise<RascunhoDeModeloRegemcast> {
  exigir(FORMATO_DA_CHAVE_REGEMCAST.test(a.chave), 'chave de idempotência');
  exigir(a.modelo.id === undefined || UUID.test(a.modelo.id), 'id do rascunho');
  return chamarFerramenta(ctx, { token: a.token, contaChave: a.contaChave, ferramenta: 'modelo_rascunhar', argumentos: { chaveIdempotencia: a.chave, ...semVazios(a.modelo) }, schema: RascunhoDeModeloRegemcast });
}

/** Monta uma campanha em rascunho (modelo aprovado, público, variáveis, janela e ritmo). Nenhuma mensagem sai. `campanhas.rascunhar`. */
export function rascunharCampanha(ctx: Contexto, a: Acesso & { chave: string; campanha: CampanhaParaRascunhar }): Promise<RascunhoDeCampanhaRegemcast> {
  exigir(FORMATO_DA_CHAVE_REGEMCAST.test(a.chave), 'chave de idempotência');
  const { publico, ...resto } = a.campanha;
  return chamarFerramenta(ctx, {
    token: a.token,
    contaChave: a.contaChave,
    ferramenta: 'campanha_rascunhar',
    argumentos: { chaveIdempotencia: a.chave, ...semVazios(resto), publico: semVazios(publico) },
    schema: RascunhoDeCampanhaRegemcast,
  });
}

/** O plano do disparo de uma campanha que o Liame montou: pessoas, custo, orçamento, o que impede e a confirmação. Não muda nada. `campanhas.disparar`. */
export function planejarDisparo(ctx: Contexto, a: Acesso & { id: string }): Promise<PlanoDoDisparoRegemcast> {
  exigir(UUID.test(a.id), 'id da campanha');
  return chamarFerramenta(ctx, { token: a.token, contaChave: a.contaChave, ferramenta: 'campanha_disparo_planejar', argumentos: { id: a.id }, schema: PlanoDoDisparoRegemcast });
}

/**
 * DISPARA a campanha: as mensagens saem e a Meta cobra. Só com a confirmação que veio no plano; se o público, o custo,
 * o orçamento ou a situação mudaram desde ele, o RegemCast recusa e pede um plano novo (erro definitivo, com a frase
 * dele). `campanhas.disparar`.
 */
export function dispararCampanha(ctx: Contexto, a: Acesso & { chave: string; id: string; confirmacao: string }): Promise<DisparoRegemcast> {
  exigir(FORMATO_DA_CHAVE_REGEMCAST.test(a.chave), 'chave de idempotência');
  exigir(UUID.test(a.id), 'id da campanha');
  exigir(a.confirmacao.length >= 16 && a.confirmacao.length <= 64, 'confirmação do plano');
  return chamarFerramenta(ctx, { token: a.token, contaChave: a.contaChave, ferramenta: 'campanha_disparar', argumentos: { chaveIdempotencia: a.chave, id: a.id, confirmacao: a.confirmacao }, schema: DisparoRegemcast });
}

/** Pausa uma campanha que o Liame disparou: segura o que ainda não saiu. Quem retoma é uma pessoa, na tela do RegemCast. `campanhas.disparar`. */
export function pausarCampanha(ctx: Contexto, a: Acesso & { chave: string; id: string }): Promise<PausaRegemcast> {
  exigir(FORMATO_DA_CHAVE_REGEMCAST.test(a.chave), 'chave de idempotência');
  exigir(UUID.test(a.id), 'id da campanha');
  return chamarFerramenta(ctx, { token: a.token, contaChave: a.contaChave, ferramenta: 'campanha_pausar', argumentos: { chaveIdempotencia: a.chave, id: a.id }, schema: PausaRegemcast });
}

/** Desliga o token no RegemCast (segunda camada: ele já saiu do cofre do Liame). */
export async function revogarNoRegemcast(ctx: Contexto, token: string, contaChave: string): Promise<void> {
  await chamarFerramenta(ctx, { token, contaChave, ferramenta: 'integracao_revogar', argumentos: { confirmar: true }, schema: RevogacaoRegemcast });
}
