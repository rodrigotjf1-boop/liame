import { z } from 'zod';
import { bebidasAlcoolicas, gratisForaDasFontes, temLink, valoresComerciais, valoresForaDaOferta } from '../../policy/anuncio.js';
import { conferirTexto, normalizar, type RegraDeTexto } from '../../policy/texto.js';
import { limparTexto } from '../sanitizar.js';
import { conferirNumeros } from '../verificador-numeros.js';

// A peça do Criativo e a conferência dela (A4, X6; `plano-a4.md` D-A4-28 e D-A4-29). O modelo só propõe título, texto
// principal e botão; o código confere cada peça, item por item, antes de ela aparecer: o preço e as condições são os
// da oferta, as regras da Liame e das plataformas, as regras da marca e o tamanho que a Meta recomenda. O que barra
// impede aprovar e ir para a Meta; o tamanho só avisa. A mesma conferência vale para o texto que uma pessoa edita
// (sem a regra dos números em geral: quem escreve responde pelo que escreve; o preço continua sendo o da oferta).
// Funções puras.

export const BOTOES_DA_PECA = ['pedir_agora', 'ver_cardapio', 'enviar_mensagem'] as const;
export type BotaoDaPeca = (typeof BOTOES_DA_PECA)[number];

/** Para onde o anúncio leva: o cardápio online da loja (com o rastreio do Liame) ou uma conversa no WhatsApp. */
export const DESTINOS_DA_PECA = ['cardapio', 'whatsapp'] as const;
export type DestinoDaPeca = (typeof DESTINOS_DA_PECA)[number];

/** Os botões que cada destino aceita (na campanha, quem manda é o objetivo dela). */
export const BOTOES_DO_DESTINO: Record<DestinoDaPeca, readonly BotaoDaPeca[]> = {
  cardapio: ['pedir_agora', 'ver_cardapio'],
  whatsapp: ['enviar_mensagem'],
};

/** O Criativo não escreve sobre isto: devolve o motivo e nenhuma peça. */
export const RECUSAS_DO_CRIATIVO = ['politica', 'bebida_alcoolica', 'categoria_proibida'] as const;
export type RecusaDoCriativo = (typeof RECUSAS_DO_CRIATIVO)[number];

/** O schema que vai ao modelo: o mais simples possível; os limites são conferidos aqui, depois. */
export const RespostaDoCriativo = z.strictObject({
  recusa: z.enum(RECUSAS_DO_CRIATIVO).nullable(),
  pecas: z.array(z.strictObject({ titulo: z.string(), texto: z.string(), botao: z.enum(BOTOES_DA_PECA) })),
});
export type RespostaDoCriativo = z.infer<typeof RespostaDoCriativo>;

export interface TextoDaPeca {
  titulo: string;
  texto: string;
}
export interface Peca extends TextoDaPeca {
  botao: BotaoDaPeca;
}

/**
 * O que o guia de anúncios da Meta recomenda (base §2.1): título de até 27 caracteres no Feed do Facebook (40 no do
 * Instagram) e texto principal de até 125. É recomendação: passar disso avisa, não barra.
 */
export const TAMANHO_RECOMENDADO = { titulo: 27, tituloNoInstagram: 40, texto: 125 } as const;
/** O teto do Liame: acima disto não é uma peça de anúncio, e ela nem aparece. */
export const TAMANHO_MAXIMO = { titulo: 60, texto: 400 } as const;
/** Quantas peças um pedido pode trazer. */
export const VARIACOES = { min: 1, max: 4 } as const;

/** Os caracteres como a pessoa conta: um emoji ou uma letra com acento valem um. */
export const caracteres = (t: string): number => Array.from(t).length;

/** Do que a peça parte, para a conferência: o que ela pode afirmar e o que não pode dizer. */
export interface BaseDaPeca {
  /** A oferta de Minha marca, como está escrita lá. */
  oferta: string;
  /** O que a marca afirma de si (`fatosDoDossie`): o dossiê sem o que ela não diz, sem os concorrentes e sem o exemplo de como não escrever. */
  fatos: string;
  /** O que a marca nunca diz (Minha marca). */
  proibidas: string[];
  /** Os concorrentes que a marca informou: não são citados em anúncio. */
  concorrentes: string[];
  /** A instrução de quem pediu, quando houve. */
  instrucao: string | null;
}

export const ITENS_DA_CONFERENCIA = ['oferta', 'regras_da_liame', 'regras_da_marca', 'tamanho'] as const;
export type ItemDaConferencia = (typeof ITENS_DA_CONFERENCIA)[number];
export type SituacaoDaConferencia = 'passou' | 'aviso' | 'barrou';

export type TipoDeAchado =
  | 'preco_fora'
  | 'numero_fora'
  | 'gratis_fora'
  | Exclude<RegraDeTexto, 'regra_da_marca'>
  | 'link'
  | 'bebida_alcoolica'
  | 'concorrente'
  | 'regra_da_marca'
  | 'acima_do_recomendado';

export interface AchadoDaPeca {
  tipo: TipoDeAchado;
  campo: keyof TextoDaPeca;
  /** O trecho que casou (o número como foi escrito, a frase da regra, a contagem); nunca um dado pessoal. */
  trecho: string;
}

export interface ItemConferido {
  item: ItemDaConferencia;
  situacao: SituacaoDaConferencia;
  achados: AchadoDaPeca[];
}

export interface ConferenciaDaPeca {
  /** A pior situação entre os itens: com um item barrado, a peça não pode ser aprovada. */
  situacao: SituacaoDaConferencia;
  itens: ItemConferido[];
  /** A peça cita algum valor (preço ou percentual)? Para a tela dizer "o texto não cita preço". */
  cita_valor: boolean;
  caracteres: Record<keyof TextoDaPeca, number>;
}

const CAMPOS: Array<keyof TextoDaPeca> = ['titulo', 'texto'];

/**
 * Confere uma peça contra a base dela. `autor` diz quem escreveu esta versão: no texto do modelo, todo número
 * precisa estar na oferta, nos fatos do dossiê ou na instrução (ele não inventa quantidade, prazo nem horário); no texto de uma
 * pessoa, essa regra não roda. O preço, o percentual e o "grátis" são os da oferta para os dois.
 */
export function conferirPeca(peca: TextoDaPeca, base: BaseDaPeca, autor: 'ia' | 'pessoa' = 'ia'): ConferenciaDaPeca {
  const oferta: AchadoDaPeca[] = [];
  const liame: AchadoDaPeca[] = [];
  const marca: AchadoDaPeca[] = [];
  const tamanho: AchadoDaPeca[] = [];
  let citaValor = false;
  const fontesDosNumeros = [base.oferta, base.fatos, base.instrucao ?? ''];
  for (const campo of CAMPOS) {
    const t = peca[campo];
    // O preço e o percentual: só os da oferta. O "grátis": só quando a oferta ou o dossiê dizem.
    const valoresFora = valoresForaDaOferta(t, base.oferta);
    if (valoresComerciais(t).length) citaValor = true;
    for (const trecho of new Set(valoresFora)) oferta.push({ tipo: 'preco_fora', campo, trecho });
    for (const trecho of gratisForaDasFontes(t, [base.oferta, base.fatos])) oferta.push({ tipo: 'gratis_fora', campo, trecho });
    if (autor === 'ia') {
      const jaDitos = new Set(valoresFora);
      for (const trecho of new Set(conferirNumeros(t, fontesDosNumeros).fora)) if (!jaDitos.has(trecho)) oferta.push({ tipo: 'numero_fora', campo, trecho });
    }
    // As regras da Liame e das plataformas: as de todo texto, o link, a bebida alcoólica e o concorrente.
    for (const a of conferirTexto(t)) if (a.regra !== 'regra_da_marca') liame.push({ tipo: a.regra, campo, trecho: a.trecho });
    if (temLink(t)) liame.push({ tipo: 'link', campo, trecho: 'endereço de site no texto' });
    for (const trecho of bebidasAlcoolicas(t)) liame.push({ tipo: 'bebida_alcoolica', campo, trecho });
    for (const a of conferirTexto(t, { daMarca: base.concorrentes })) if (a.regra === 'regra_da_marca') liame.push({ tipo: 'concorrente', campo, trecho: a.trecho });
    // O que a marca nunca diz.
    for (const a of conferirTexto(t, { daMarca: base.proibidas })) if (a.regra === 'regra_da_marca') marca.push({ tipo: 'regra_da_marca', campo, trecho: a.trecho });
    // O tamanho: recomendação da Meta, só avisa.
    const n = caracteres(t);
    if (n > TAMANHO_RECOMENDADO[campo]) tamanho.push({ tipo: 'acima_do_recomendado', campo, trecho: `${n} de ${TAMANHO_RECOMENDADO[campo]}` });
  }
  const item = (nome: ItemDaConferencia, achados: AchadoDaPeca[], comAchado: SituacaoDaConferencia): ItemConferido => ({ item: nome, situacao: achados.length ? comAchado : 'passou', achados });
  const itens = [item('oferta', oferta, 'barrou'), item('regras_da_liame', liame, 'barrou'), item('regras_da_marca', marca, 'barrou'), item('tamanho', tamanho, 'aviso')];
  const situacao: SituacaoDaConferencia = itens.some((i) => i.situacao === 'barrou') ? 'barrou' : itens.some((i) => i.situacao === 'aviso') ? 'aviso' : 'passou';
  return { situacao, itens, cita_valor: citaValor, caracteres: { titulo: caracteres(peca.titulo), texto: caracteres(peca.texto) } };
}

export interface PecaConferida extends Peca {
  conferencia: ConferenciaDaPeca;
}

/** Quantas peças do modelo não chegam a aparecer, por motivo (vai para o log e para o registro do pedido; nunca o texto). */
export interface DescartesDasPecas {
  vazia: number;
  longa: number;
  dado_pessoal: number;
  repetida: number;
  a_mais: number;
  com_recusa: number;
}

const arrumar = (t: string): string => t.replace(/\s+/g, ' ').trim();
/** A forma de comparar duas peças: sem acento, em minúsculas e sem pontuação nem espaço. */
const chaveDaPeca = (p: TextoDaPeca): string => normalizar(`${p.titulo}|${p.texto}`).replace(/[^a-z0-9|]/g, '');

/**
 * O que o código faz com a resposta do modelo. Com recusa, nenhuma peça é usada. Sem recusa, cada peça tem os espaços
 * arrumados e só fica se tem título e texto, cabe no teto do Liame, não traz dado pessoal (essa nem é guardada) e não
 * repete outra; ficam no máximo as pedidas. As que ficam saem conferidas: a barrada aparece, com o motivo, para a
 * pessoa corrigir ou pedir outra.
 */
export function pecasDaResposta(r: RespostaDoCriativo, base: BaseDaPeca, variacoes: number): { recusa: RecusaDoCriativo | null; pecas: PecaConferida[]; descartes: DescartesDasPecas } {
  const descartes: DescartesDasPecas = { vazia: 0, longa: 0, dado_pessoal: 0, repetida: 0, a_mais: 0, com_recusa: 0 };
  if (r.recusa) {
    descartes.com_recusa = r.pecas.length;
    return { recusa: r.recusa, pecas: [], descartes };
  }
  const vistas = new Set<string>();
  const pecas: PecaConferida[] = [];
  for (const bruta of r.pecas) {
    const p: Peca = { titulo: arrumar(bruta.titulo), texto: arrumar(bruta.texto), botao: bruta.botao };
    if (!p.titulo || !p.texto) descartes.vazia += 1;
    else if (caracteres(p.titulo) > TAMANHO_MAXIMO.titulo || caracteres(p.texto) > TAMANHO_MAXIMO.texto) descartes.longa += 1;
    else if (limparTexto(`${p.titulo}\n${p.texto}`).removidos > 0) descartes.dado_pessoal += 1;
    else if (vistas.has(chaveDaPeca(p))) descartes.repetida += 1;
    else if (pecas.length >= variacoes) descartes.a_mais += 1;
    else {
      vistas.add(chaveDaPeca(p));
      pecas.push({ ...p, conferencia: conferirPeca(p, base, 'ia') });
    }
  }
  return { recusa: null, pecas, descartes };
}

/** Sinais de estilo que o prompt proíbe e a conferência não barra (não são regra de anúncio): servem ao eval. */
export function estiloDaPeca(p: TextoDaPeca): string[] {
  const t = `${p.titulo}\n${p.texto}`;
  const sinais: string[] = [];
  if (/#[\p{L}\p{N}_]/u.test(t)) sinais.push('hashtag');
  if (/\p{Extended_Pictographic}/u.test(t)) sinais.push('emoji');
  return sinais;
}
