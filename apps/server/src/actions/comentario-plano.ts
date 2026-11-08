import { z } from 'zod';
import { canonicalJson, sha256 } from '../audit/audit.js';
import { conferirTexto } from '../policy/texto.js';
import { citaONome, compensacaoPrometida, textoComparavel } from './avaliacao-plano.js';

// O estado de um comentário de um post da marca (o Instagram ou a Página), como o Action Service o guarda no pedido de
// resposta, de ocultar ou de mostrar (A6, Z11, parte 2; P38, D-A6-88, D-A6-89 e D-A6-94), e as regras puras em cima
// dele. Mora aqui, fora do conector, porque o registro de ferramentas (`tools.ts`) usa as mesmas.
//
// O estado NÃO leva o texto do comentário nem nada de quem comentou: o texto fica em `social_comment`, com o prazo dele
// (90 dias), e no pedido vai só um resumo criptográfico, que serve para notar que ele mudou. O @ ou o nome de quem
// comentou é lido na hora e passa pelo plano só para conferir que a resposta não o cita: não entra no estado, no pedido
// nem na auditoria (como o nome de quem avaliou, D-A6-5).

/**
 * A função de escrita dos comentários (D-A6-91): responder, apagar a resposta, ocultar e mostrar. Desligada; a parada
 * geral a alcança (`is_write`). É a flag das ferramentas, conferida junto com a do conector (`social_write`).
 */
export const FLAG_DE_RESPONDER_COMENTARIOS = 'comentarios_responder';

/** O tamanho máximo da resposta a um comentário: um limite do Liame (as referências da Meta não dizem um). */
export const TAMANHO_DA_RESPOSTA_AO_COMENTARIO = 1000;

/** As ações para a política (`policy/engine.ts`, v11). */
export const ACAO_DE_RESPONDER = 'comentario.responder';
export const ACAO_DE_APAGAR_A_RESPOSTA = 'comentario.apagar_resposta';
export const ACAO_DE_OCULTAR = 'comentario.ocultar';
export const ACAO_DE_MOSTRAR = 'comentario.mostrar';

/** Uma sugestão do Social media (Z11, parte 2d), como o pedido a guarda. Os limites são os da conferência dele. */
const SugestaoDoPedido = z.strictObject({
  enfoque: z.string().min(1).max(60),
  texto: z.string().min(1).max(TAMANHO_DA_RESPOSTA_AO_COMENTARIO),
  rodada: z.union([z.literal(1), z.literal(2)]),
});

/** Quantas sugestões cabem num pedido: três na reclamação (D-A6-94), e mais uma rodada do "Pedir outra". */
export const SUGESTOES_NO_PEDIDO = 4;

/**
 * O texto que a marca publica como resposta, como parâmetro da ferramenta. No pedido do Social media, vêm também as
 * sugestões dele (`agentParams`): o que vai para a rede é só o `texto`.
 */
export const ParametrosDaRespostaAoComentario = z.strictObject({
  texto: z.string().min(1).max(TAMANHO_DA_RESPOSTA_AO_COMENTARIO * 4),
  sugestoes: z.array(SugestaoDoPedido).min(1).max(SUGESTOES_NO_PEDIDO).optional(),
});

const Instante = z.iso.datetime();

export const EstadoDoComentario = z.strictObject({
  tipo: z.literal('comentario'),
  /** `instagram` ou `facebook` (a Página). */
  canal: z.enum(['instagram', 'facebook']),
  /** O id do comentário na rede e o do post de onde ele veio. */
  id: z.string().min(1).max(120),
  post_id: z.string().min(1).max(80),
  /** Falso quando a rede diz que o comentário não existe mais (quem escreveu apagou, ou a conta restringiu quem fez). */
  existe: z.boolean(),
  oculto: z.boolean(),
  /** O comentário de primeiro nível (a rede só aceita resposta a ele). */
  primeiro_nivel: z.boolean(),
  /** Feito pela própria marca (a marca não responde nem oculta o próprio comentário). */
  da_marca: z.boolean(),
  feito_em: Instante.nullable(),
  /** O resumo criptográfico do texto do comentário; nulo quando ele não tem texto. O texto em si não vem para o pedido. */
  texto_resumo: z.string().nullable(),
  /** A resposta da marca que já está lá (a mais nova), com o texto, que é da própria marca; nula quando não há. */
  resposta: z.strictObject({ id: z.string().min(1).max(120), texto: z.string() }).nullable(),
  /**
   * Só no estado desejado: o que o pedido faz. A execução decide por ele, e não pela diferença dos estados (o pedido de
   * responder também deseja o comentário à vista, e "já está à vista" não quer dizer que a resposta saiu).
   */
  operacao: z.enum(['responder', 'apagar_resposta', 'ocultar', 'mostrar']).optional(),
});
export type EstadoDoComentario = z.infer<typeof EstadoDoComentario>;

/** O que o plano confere e o pedido não guarda: o @ ou o nome de quem comentou, lido da rede na hora (nulo se não vier). */
export type ContextoDoComentario = { quem: string | null };

/** O resumo criptográfico do texto de um comentário (o do pedido e o do que está em `social_comment` se comparam). */
export function resumoDoComentario(texto: string | null | undefined): string | null {
  const t = typeof texto === 'string' ? texto.trim() : '';
  return t ? sha256(t) : null;
}

/**
 * A versão do estado, tirada dele mesmo: muda quando o comentário muda no que a pessoa leu para decidir (o texto),
 * some, é ocultado ou mostrado, ou ganha, perde ou troca a resposta da marca. É o que impede publicar a resposta aprovada
 * num comentário que já é outro, ocultar o que já foi mostrado de novo e apagar uma resposta que já não é a do Liame.
 * Cabe na coluna inteira do pedido e nunca é zero.
 */
export function versaoDoComentario(e: Pick<EstadoDoComentario, 'existe' | 'oculto' | 'texto_resumo' | 'resposta'>): number {
  const base = { existe: e.existe, oculto: e.oculto, texto_resumo: e.texto_resumo, resposta: e.resposta ? { id: e.resposta.id, texto: textoComparavel(e.resposta.texto) } : null };
  return (Number.parseInt(sha256(canonicalJson(base)).slice(0, 12), 16) % 2_147_483_646) + 1;
}

/** O texto da resposta como sai: sem o caractere nulo, sem espaço nas pontas, até o limite. Nulo quando não serve. */
export function textoDaRespostaAoComentario(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const limpo = v.split('\u0000').join('').trim();
  if (!limpo || [...limpo].length > TAMANHO_DA_RESPOSTA_AO_COMENTARIO) return null;
  return limpo;
}

const REGRA_EM_PALAVRAS: Record<string, string> = {
  politico_eleitoral: 'conteúdo político ou eleitoral (regra da Liame)',
  promessa_de_resultado: 'promessa de resultado (regra da Liame)',
  categoria_proibida: 'categoria que as plataformas proíbem (regra da Liame)',
  dado_pessoal: 'dado pessoal no texto (e-mail, telefone ou documento)',
  texto_longo: 'texto longo demais para conferir',
};

/**
 * O que o Compliance não deixa passar numa resposta a comentário (D-A6-88), cada problema em palavras; vazio quando o
 * texto serve. A resposta é pública e sai em nome da marca: sem compensação prometida ali (desconto, brinde, reembolso
 * e cortesia se combinam em particular), sem o nome de quem comentou e sem dado pessoal.
 */
export function problemasDaRespostaAoComentario(texto: string, contexto?: ContextoDoComentario | null): string[] {
  const problemas = conferirTexto(texto).map((x) => REGRA_EM_PALAVRAS[x.regra] ?? x.regra);
  const prometido = compensacaoPrometida(texto);
  if (prometido.length) problemas.push(`promessa de compensação em público (${prometido.join(', ')}): desconto, brinde e reembolso se combinam em particular`);
  if (citaONome(texto, contexto?.quem)) problemas.push('o nome de quem comentou: a resposta é pública, e o pedido fica guardado');
  return problemas;
}

type Recusa = { ok: false; motivo: string };
const NAO_E = 'Esta ferramenta é para um comentário de um post da marca, no Instagram ou na Página.';
const SUMIU = 'Este comentário não está mais na rede: quem escreveu apagou, ou a conta restringiu quem fez.';

/** O plano da resposta. */
export type PlanoDaRespostaAoComentario = Recusa | { ok: true; acao: string; texto: string; desejado: EstadoDoComentario };

/** Do estado do comentário e do texto pedido, o plano da resposta. Função pura. */
export function planoDaRespostaAoComentario(before: unknown, params: unknown, contexto?: ContextoDoComentario | null): PlanoDaRespostaAoComentario {
  const lido = EstadoDoComentario.safeParse(before);
  if (!lido.success) return { ok: false, motivo: NAO_E };
  const e = lido.data;
  if (!e.existe) return { ok: false, motivo: `${SUMIU} Não há o que responder.` };
  if (e.da_marca) return { ok: false, motivo: 'Este comentário é da própria marca: não há o que responder.' };
  if (!e.primeiro_nivel) return { ok: false, motivo: 'A rede só aceita resposta ao comentário de primeiro nível: responda ao comentário que abriu a conversa.' };
  if (e.oculto) return { ok: false, motivo: 'Este comentário está oculto, e a rede não deixa responder a comentário oculto. Mostre de novo antes, se quiser responder.' };
  if (e.resposta) return { ok: false, motivo: 'A marca já respondeu a este comentário.' };
  const pedido = ParametrosDaRespostaAoComentario.safeParse(params);
  const texto = pedido.success ? textoDaRespostaAoComentario(pedido.data.texto) : null;
  if (!texto) return { ok: false, motivo: `A resposta precisa de um texto, com até ${TAMANHO_DA_RESPOSTA_AO_COMENTARIO.toLocaleString('pt-BR')} caracteres.` };
  const problemas = problemasDaRespostaAoComentario(texto, contexto);
  if (problemas.length) return { ok: false, motivo: `O texto da resposta não passa assim. Ajuste e salve de novo: ${problemas.join('; ')}.` };
  // O id da resposta só existe depois de ela sair: o desejado leva o texto, e a execução confere pelo texto.
  return { ok: true, acao: ACAO_DE_RESPONDER, texto, desejado: { ...e, resposta: { id: 'nova', texto }, operacao: 'responder' } };
}

/** A resposta já está lá (a tentativa anterior caiu depois de a rede aceitar)? Pelo texto, como a rede o devolve. */
export function respostaAoComentarioJaPublicada(atual: EstadoDoComentario, desejado: unknown): boolean {
  const quer = EstadoDoComentario.safeParse(desejado);
  return quer.success && quer.data.resposta !== null && atual.resposta !== null && textoComparavel(atual.resposta.texto) === textoComparavel(quer.data.resposta.texto);
}

/** O plano de apagar a resposta da marca (a volta da resposta publicada). Função pura. */
export type PlanoDoComentario = Recusa | { ok: true; acao: string; desejado: EstadoDoComentario };

export function planoDeApagarARespostaAoComentario(before: unknown): PlanoDoComentario {
  const lido = EstadoDoComentario.safeParse(before);
  if (!lido.success) return { ok: false, motivo: NAO_E };
  const e = lido.data;
  if (!e.existe) return { ok: false, motivo: `${SUMIU} A resposta saiu junto.` };
  if (!e.resposta) return { ok: false, motivo: 'Este comentário não tem resposta da marca: não há o que apagar.' };
  return { ok: true, acao: ACAO_DE_APAGAR_A_RESPOSTA, desejado: { ...e, resposta: null, operacao: 'apagar_resposta' } };
}

/** A resposta já saiu da rede (a tentativa anterior de apagar caiu depois de a rede aceitar)? */
export function respostaAoComentarioJaApagada(atual: EstadoDoComentario, desejado: unknown): boolean {
  const quer = EstadoDoComentario.safeParse(desejado);
  return quer.success && quer.data.resposta === null && atual.existe && atual.resposta === null;
}

/** O plano de ocultar (D-A6-89). Função pura. */
export function planoDeOcultar(before: unknown): PlanoDoComentario {
  const lido = EstadoDoComentario.safeParse(before);
  if (!lido.success) return { ok: false, motivo: NAO_E };
  const e = lido.data;
  if (!e.existe) return { ok: false, motivo: `${SUMIU} Não há o que ocultar.` };
  // A rede sempre mostra o comentário do dono da mídia, mesmo oculto (referência do comentário do Instagram).
  if (e.da_marca) return { ok: false, motivo: 'Este comentário é da própria marca: a rede sempre o mostra.' };
  if (e.oculto) return { ok: false, motivo: 'Este comentário já está oculto.' };
  return { ok: true, acao: ACAO_DE_OCULTAR, desejado: { ...e, oculto: true, operacao: 'ocultar' } };
}

/** O plano de mostrar de novo (a volta de ocultar). Função pura. */
export function planoDeMostrar(before: unknown): PlanoDoComentario {
  const lido = EstadoDoComentario.safeParse(before);
  if (!lido.success) return { ok: false, motivo: NAO_E };
  const e = lido.data;
  if (!e.existe) return { ok: false, motivo: `${SUMIU} Não há o que mostrar.` };
  if (!e.oculto) return { ok: false, motivo: 'Este comentário já está à vista.' };
  return { ok: true, acao: ACAO_DE_MOSTRAR, desejado: { ...e, oculto: false, operacao: 'mostrar' } };
}

/**
 * O comentário já está como o pedido queria (a tentativa anterior caiu depois de a rede aceitar)? Pela operação do
 * pedido: a resposta pelo texto, apagar pela falta da resposta, ocultar e mostrar pela visibilidade.
 */
export function jaComoOPedidoQueria(atual: EstadoDoComentario, desejado: unknown): boolean {
  const quer = EstadoDoComentario.safeParse(desejado);
  if (!quer.success || !atual.existe) return false;
  switch (quer.data.operacao) {
    case 'responder':
      return respostaAoComentarioJaPublicada(atual, desejado);
    case 'apagar_resposta':
      return respostaAoComentarioJaApagada(atual, desejado);
    case 'ocultar':
      return atual.oculto;
    case 'mostrar':
      return !atual.oculto;
    default:
      return false;
  }
}

/** Os tipos de comentário cuja resposta entra no lote de um código só (D-A6-93). */
const TIPOS_DA_RESPOSTA_EM_LOTE: readonly string[] = ['elogio', 'marcacao', 'pergunta'];

/**
 * Por que um pedido não entra no lote de uma confirmação só (D-A6-93, P38: o "pronto" do protótipo); nulo quando
 * entra. Entram a resposta a um elogio, a uma marcação ou a uma pergunta e ocultar um comentário; a reclamação fica
 * fora (uma por vez: cada uma pede escolher o caminho), e também o comentário de tipo ainda não decidido, que pode ser
 * uma reclamação. `tipo`: o que o Liame guarda do comentário agora (indefinido quando ele não está mais guardado).
 * Função pura.
 */
export function foraDoLote(tool: string, tipo: string | null | undefined): string | null {
  if (tool !== 'comentario_responder' && tool !== 'comentario_ocultar') return 'só a resposta a um comentário e ocultar um comentário entram no lote';
  if (tipo === undefined) return 'o comentário não está mais no Liame (apagado na rede ou fora do prazo de 90 dias)';
  if (tipo === 'reclamacao') return 'a reclamação é decidida uma por vez';
  if (tipo === null) return 'o tipo do comentário ainda não foi decidido: decida este pedido sozinho';
  if (tool === 'comentario_responder' && !TIPOS_DA_RESPOSTA_EM_LOTE.includes(tipo)) return 'no lote, só a resposta a um elogio, a uma marcação ou a uma pergunta';
  return null;
}
