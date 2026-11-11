import { createHash } from 'node:crypto';
import { respostaPronta } from '../ai/social/comentario.js';
import { tipoPorRegra } from '../comentarios/comentarios.js';

// O tipo de uma conversa do Direct e a sugestão sem IA (A6, Z12, parte 4a; P39; D-A6-118). O tipo sai da mesma regra
// dos comentários (D-A6-87), aplicada ao que a pessoa escreveu depois da última resposta da marca: golpe, reclamação,
// ofensa, pergunta e elogio; a marcação de amigo não vale no Direct (lá, um @ não é convite), e a menção no story sem
// texto vira "menção". A sugestão, sem IA: o agradecimento pronto do elogio e da menção (variando por mensagem), o
// "como proceder" da reclamação e o aviso do golpe. A pergunta e a reclamação ganham as sugestões do Social media na
// parte 4b (com o eval pago, que é decisão do dono).

export type TipoNoDirect = 'golpe' | 'reclamacao' | 'ofensivo' | 'pergunta' | 'elogio' | 'mencao';

/** O que a pessoa mandou desde a última resposta da marca (o tipo e o texto de cada mensagem). */
export type Pendente = { kind: string; body: string };

/** Quantas mensagens da pessoa, desde a última resposta da marca, entram no tipo (as mais novas). */
export const PENDENTES_DO_TIPO = 5;

/** O tipo da conversa pelo que a pessoa mandou desde a última resposta da marca, ou nulo (a regra não decide). */
export function tipoNoDirect(pendentes: readonly Pendente[], usuarioDaMarca: string | null): TipoNoDirect | null {
  const texto = pendentes
    .map((p) => p.body.trim())
    .filter(Boolean)
    .join(' ');
  if (texto) {
    const t = tipoPorRegra(texto, usuarioDaMarca);
    if (t && t !== 'marcacao') return t;
  }
  if (pendentes.some((p) => p.kind === 'story_mencao')) return 'mencao';
  return null;
}

/** O agradecimento pronto da menção no story: curto, sem nome, número, link, preço ou promessa. */
export const RESPOSTAS_DA_MENCAO = [
  'Obrigado por marcar a gente! Bom demais ver você por aí.',
  'Valeu pela marcação! Esperamos você de novo.',
  'Que bom ver a gente no seu story! Obrigado.',
  'Obrigado por compartilhar! Até a próxima.',
  'Adoramos a marcação! Volte sempre.',
] as const;

/** O "como proceder" da reclamação (D-A6-94, no Direct): os passos, sem IA. */
export const PASSOS_DA_RECLAMACAO = [
  'Peça desculpas, sem discutir o que houve.',
  'Peça o número do pedido, se ainda não veio, e confira com a loja o que aconteceu antes de prometer qualquer coisa.',
  'Combine a solução com a loja. O Liame não promete reembolso, troca nem brinde: isso é decisão sua, escrita por você.',
  'Se a pessoa falar de saúde (passou mal, alergia), avise o Dono e não entre em detalhe na conversa.',
] as const;

export type SugestaoNoDirect = { kind: 'pronta'; text: string; steps: string[] } | { kind: 'passos'; text: null; steps: string[] } | { kind: 'golpe'; text: null; steps: string[] };

/**
 * A sugestão sem IA para o tipo, ou nula. `semente`: o id da última mensagem da pessoa (a mesma mensagem recebe sempre
 * a mesma resposta pronta; a seguinte pode receber outra).
 */
export function sugestaoNoDirect(tipo: TipoNoDirect | null, semente: string): SugestaoNoDirect | null {
  if (tipo === 'elogio') return { kind: 'pronta', text: respostaPronta('elogio', semente), steps: [] };
  if (tipo === 'mencao') {
    const n = createHash('sha256').update(`mencao:${semente}`).digest().readUInt32BE(0);
    return { kind: 'pronta', text: RESPOSTAS_DA_MENCAO[n % RESPOSTAS_DA_MENCAO.length]!, steps: [] };
  }
  if (tipo === 'reclamacao') return { kind: 'passos', text: null, steps: [...PASSOS_DA_RECLAMACAO] };
  if (tipo === 'golpe') return { kind: 'golpe', text: null, steps: [] };
  return null;
}
