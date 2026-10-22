import { z } from 'zod';
import { citaONome, compensacaoPrometida } from '../../actions/avaliacao-plano.js';
import { bebidasAlcoolicas, temLink } from '../../policy/anuncio.js';
import { conferirTexto, normalizar, type RegraDeTexto } from '../../policy/texto.js';
import { temDadoPessoal, temMarcaDeRemocao } from '../sanitizar.js';
import { conferirNumeros } from '../verificador-numeros.js';

// As sugestões de resposta do Social media e a conferência delas (A6, Z6; D-A6-26 a D-A6-28; P31). O modelo propõe
// uma ou duas respostas, cada uma com o enfoque (para a pessoa escolher) e o texto. O código confere cada uma antes de
// qualquer pessoa ver: as regras da resposta do P17, que valem também para a resposta que uma pessoa escreve (sem
// compensação prometida em público, sem o nome de quem avaliou, sem dado pessoal), as regras da Liame e das
// plataformas, as da marca, e o que só vale para o texto da IA (D-A6-28): não dizer que a loja já resolveu o que não
// está confirmado, não prometer compensação com outras palavras, não citar nome que aparece na avaliação e não
// inventar número. A que barra não aparece (a avaliação fica com o "Responder" de sempre); o tamanho acima do
// recomendado só avisa. Funções puras.

/** O schema que vai ao modelo: o mais simples possível; a quantidade e os limites são conferidos aqui, depois. */
export const RespostaDoSocial = z.strictObject({
  sugestoes: z.array(z.strictObject({ enfoque: z.string(), texto: z.string() })),
});
export type RespostaDoSocial = z.infer<typeof RespostaDoSocial>;

export interface SugestaoDeResposta {
  /** O jeito da resposta ("Curta", "Pede desculpas e chama para conversar"), para a pessoa escolher. */
  enfoque: string;
  /** O texto que vai ao Google, se a pessoa escolher e aprovar. */
  texto: string;
}

/**
 * O tamanho. O Google aceita respostas longas, e o pedido aceita até 1.500 caracteres (`TAMANHO_DA_RESPOSTA`); a
 * sugestão é curta de propósito (o P31 tem respostas de uma a três frases): avisa acima de 350 e não segue acima de 600.
 * O enfoque é um rótulo: avisa acima de 40 e não segue acima de 60. Os números são escolha do Liame, não regra do Google.
 */
export const TAMANHO_RECOMENDADO = { enfoque: 40, texto: 350 } as const;
export const TAMANHO_MAXIMO = { enfoque: 60, texto: 600 } as const;

/** Os caracteres como a pessoa conta: uma letra com acento vale um. */
export const caracteres = (t: string): number => Array.from(t).length;

/** Do que a sugestão parte, para a conferência: a avaliação e o que a marca afirma, não diz e não cita. */
export interface BaseDaSugestao {
  /** A nota da avaliação, de 1 a 5. */
  estrelas: number;
  /** O texto da avaliação, como o Liame o guarda; nulo quando ela é só a nota. */
  avaliacao: string | null;
  /** O que a marca afirma de si (`fatosDoDossie`). */
  fatos: string;
  /** O que a marca nunca diz (Minha marca). */
  proibidas: string[];
  /** Os concorrentes que a marca informou: não são citados. */
  concorrentes: string[];
  /** O nome de quem avaliou, quando a rotina o leu do Google na hora (nunca guardado); nulo quando não leu. */
  quem?: string | null;
}

export const ITENS_DA_CONFERENCIA = ['regras_da_resposta', 'regras_da_liame', 'regras_da_marca', 'numeros', 'tamanho'] as const;
export type ItemDaConferencia = (typeof ITENS_DA_CONFERENCIA)[number];
export type SituacaoDaConferencia = 'passou' | 'aviso' | 'barrou';

export type TipoDeAchado =
  | 'compensacao'
  | 'nome'
  | 'resolucao_inventada'
  | Exclude<RegraDeTexto, 'regra_da_marca'>
  | 'link'
  | 'bebida_alcoolica'
  | 'concorrente'
  | 'regra_da_marca'
  | 'numero_fora'
  | 'acima_do_recomendado';

export interface AchadoDaSugestao {
  tipo: TipoDeAchado;
  campo: keyof SugestaoDeResposta;
  /** O trecho que casou (a palavra, a frase da regra, o número como foi escrito, a contagem); nunca um dado pessoal. */
  trecho: string;
}

export interface ItemConferido {
  item: ItemDaConferencia;
  situacao: SituacaoDaConferencia;
  achados: AchadoDaSugestao[];
}

export interface ConferenciaDaSugestao {
  /** A pior situação entre os itens: com um item barrado, a sugestão não aparece. */
  situacao: SituacaoDaConferencia;
  itens: ItemConferido[];
  caracteres: Record<keyof SugestaoDeResposta, number>;
}

/**
 * A compensação dita com outras palavras, que só se confere no texto da IA (a resposta de uma pessoa segue só com as
 * palavras do P17): cupom, "por nossa conta", "de graça", "grátis", vale-compra, ressarcir, estornar, compensar e
 * devolver o dinheiro. Alternativas literais, sobre o texto normalizado (sem acento, minúsculo).
 */
const COMPENSACAO_DA_IA =
  /(?<![a-z0-9])(cupom|cupons|por nossa conta|de graca|gratis|vale[- ]compra|ressarc[a-z]*|estorn[a-z]*|compens[a-z]*|devolv[a-z]* (?:o seu |o |seu )?(?:dinheiro|valor))(?![a-z0-9])/g;

/**
 * A loja "já resolveu" o que a sugestão não tem como saber (D-A6-28): resolvemos, corrigimos, tomamos providência,
 * conversamos com alguém, a equipe foi orientada. Alternativas literais, sobre o texto normalizado.
 */
const RESOLUCAO =
  /(?<![a-z0-9])(ja resolvemos|ja corrigimos|ja ajustamos|ja mudamos|ja conversamos com|ja falamos com|ja foi resolvid[ao]s?|ja foi corrigid[ao]s?|ja esta resolvid[ao]s?|ja esta corrigid[ao]s?|foi resolvid[ao] internamente|(?:ja )?tomamos (?:as )?providencias|(?:a equipe|o funcionario|a funcionaria|o entregador) (?:ja )?foi (?:orientad[ao]|treinad[ao]|advertid[ao]|desligad[ao]))(?![a-z0-9])/g;

/** Os trechos de um padrão no texto normalizado, sem repetir. */
const trechos = (normal: string, padrao: RegExp): string[] => [...new Set([...normal.matchAll(padrao)].map((m) => m[1]!))];

/** Palavra com letra maiúscula que não é nome de pessoa (marca de plataforma, palavras de respeito). */
const NAO_SAO_NOMES = new Set(['google', 'ifood', 'whatsapp', 'instagram', 'facebook', 'deus', 'pix', 'delivery']);

/**
 * Os nomes de pessoa que a avaliação traz (o atendente, o entregador, um amigo), para a sugestão não repetir: as
 * palavras de três letras ou mais que começam com maiúscula fora do começo de uma frase e que não estão no que a marca
 * escreve de si (o nome dela, os produtos, a região). A busca é estreita de propósito: no pior caso, uma palavra que não
 * é nome segura uma sugestão (que a pessoa pode escrever à mão), e um nome nunca vai para o Google pela IA.
 */
export function nomesNaAvaliacao(avaliacao: string | null, conhecido: string): string[] {
  if (!avaliacao) return [];
  const daMarca = new Set(normalizar(conhecido).split(/[^a-z0-9]+/).filter(Boolean));
  const nomes = new Set<string>();
  let comecoDeFrase = true;
  for (const pedaco of avaliacao.slice(0, 4000).split(/(\s+)/)) {
    if (!pedaco.trim()) continue;
    const palavra = pedaco.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
    const inicial = palavra[0];
    if (!comecoDeFrase && palavra.length >= 3 && inicial !== undefined && inicial !== inicial.toLowerCase() && palavra.slice(1) === palavra.slice(1).toLowerCase()) {
      const normal = normalizar(palavra);
      if (!daMarca.has(normal) && !NAO_SAO_NOMES.has(normal)) nomes.add(normal);
    }
    comecoDeFrase = /[.!?…]["')\]]*$/.test(pedaco);
  }
  return [...nomes];
}

/** O texto traz a palavra inteira (já normalizada)? */
function temAPalavra(normal: string, palavra: string): boolean {
  for (let i = normal.indexOf(palavra); i >= 0; i = normal.indexOf(palavra, i + 1)) {
    const antes = normal[i - 1];
    const depois = normal[i + palavra.length];
    const letra = (c: string | undefined) => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'));
    if (!letra(antes) && !letra(depois)) return true;
  }
  return false;
}

/**
 * Confere uma sugestão contra a base dela. As regras da resposta do P17 são as mesmas do plano da resposta
 * (`problemasDaResposta`): a sugestão que passa aqui não é recusada quando vira pedido. O número precisa estar na
 * avaliação (a nota e o que ela escreveu) ou nos fatos da marca: o funcionário não inventa prazo, preço nem horário.
 */
export function conferirSugestao(s: SugestaoDeResposta, base: BaseDaSugestao, conhecido = ''): ConferenciaDaSugestao {
  const resposta: AchadoDaSugestao[] = [];
  const liame: AchadoDaSugestao[] = [];
  const marca: AchadoDaSugestao[] = [];
  const numeros: AchadoDaSugestao[] = [];
  const tamanho: AchadoDaSugestao[] = [];
  const nomes = nomesNaAvaliacao(base.avaliacao, `${conhecido}\n${base.fatos}`);
  const fontes = [base.avaliacao ?? '', `${base.estrelas} estrelas`, base.fatos];
  for (const campo of ['enfoque', 'texto'] as const) {
    const t = s[campo];
    const normal = normalizar(t);
    // As regras da resposta (P17): a compensação, o nome de quem avaliou; e as que só valem para a IA (D-A6-28).
    for (const trecho of compensacaoPrometida(t)) resposta.push({ tipo: 'compensacao', campo, trecho });
    for (const trecho of trechos(normal, COMPENSACAO_DA_IA)) resposta.push({ tipo: 'compensacao', campo, trecho });
    if (citaONome(t, base.quem)) resposta.push({ tipo: 'nome', campo, trecho: 'o nome de quem avaliou' });
    if (nomes.some((nome) => temAPalavra(normal, nome))) resposta.push({ tipo: 'nome', campo, trecho: 'um nome que aparece na avaliação' });
    for (const trecho of trechos(normal, RESOLUCAO)) resposta.push({ tipo: 'resolucao_inventada', campo, trecho });
    // As regras da Liame e das plataformas: as de todo texto, o link, a bebida alcoólica e o concorrente.
    const doTexto = conferirTexto(t);
    for (const a of doTexto) if (a.regra !== 'regra_da_marca') liame.push({ tipo: a.regra, campo, trecho: a.trecho });
    // O que sai do gateway já vem limpo: o dado pessoal chega como a marca da limpeza ("[telefone]").
    if (temMarcaDeRemocao(t) && !doTexto.some((a) => a.regra === 'dado_pessoal')) liame.push({ tipo: 'dado_pessoal', campo, trecho: 'dado pessoal no texto' });
    if (temLink(t)) liame.push({ tipo: 'link', campo, trecho: 'endereço de site no texto' });
    for (const trecho of bebidasAlcoolicas(t)) liame.push({ tipo: 'bebida_alcoolica', campo, trecho });
    for (const a of conferirTexto(t, { daMarca: base.concorrentes })) if (a.regra === 'regra_da_marca') liame.push({ tipo: 'concorrente', campo, trecho: a.trecho });
    // O que a marca nunca diz.
    for (const a of conferirTexto(t, { daMarca: base.proibidas })) if (a.regra === 'regra_da_marca') marca.push({ tipo: 'regra_da_marca', campo, trecho: a.trecho });
    for (const trecho of new Set(conferirNumeros(t, fontes).fora)) numeros.push({ tipo: 'numero_fora', campo, trecho });
    const n = caracteres(t);
    if (n > TAMANHO_RECOMENDADO[campo]) tamanho.push({ tipo: 'acima_do_recomendado', campo, trecho: `${n} de ${TAMANHO_RECOMENDADO[campo]}` });
  }
  const item = (nome: ItemDaConferencia, achados: AchadoDaSugestao[], comAchado: SituacaoDaConferencia): ItemConferido => ({ item: nome, situacao: achados.length ? comAchado : 'passou', achados });
  const itens = [item('regras_da_resposta', resposta, 'barrou'), item('regras_da_liame', liame, 'barrou'), item('regras_da_marca', marca, 'barrou'), item('numeros', numeros, 'barrou'), item('tamanho', tamanho, 'aviso')];
  const situacao: SituacaoDaConferencia = itens.some((i) => i.situacao === 'barrou') ? 'barrou' : itens.some((i) => i.situacao === 'aviso') ? 'aviso' : 'passou';
  return { situacao, itens, caracteres: { enfoque: caracteres(s.enfoque), texto: caracteres(s.texto) } };
}

export interface SugestaoConferida extends SugestaoDeResposta {
  conferencia: ConferenciaDaSugestao;
}

/** Por que uma sugestão do modelo nem chegou à conferência (vai para o log e para o registro; nunca o texto). */
export type DescarteDaSugestao = 'vazia' | 'longa' | 'dado_pessoal' | 'repetida' | 'sobra';

/** Uma linha só, sem espaço dobrado nem tabulação: a resposta é curta, e o enfoque é um rótulo. */
const arrumar = (t: string): string => t.replace(/\s+/g, ' ').trim();

/**
 * O que o código faz com a resposta do modelo. Cada sugestão tem os espaços arrumados e só segue se tem enfoque e
 * texto, cabe no teto do Liame, não traz dado pessoal (cru, ou já trocado pela marca da limpeza do gateway) e não
 * repete o texto de outra. Seguem no máximo as `pedidas` (uma ou duas, D-A6-26); as que sobram são descartadas. As
 * que seguem saem conferidas: a barrada fica com o motivo e não aparece.
 */
export function sugestoesDaResposta(r: RespostaDoSocial, base: BaseDaSugestao, pedidas: 1 | 2, conhecido = ''): { sugestoes: SugestaoConferida[]; descartes: DescarteDaSugestao[] } {
  const sugestoes: SugestaoConferida[] = [];
  const descartes: DescarteDaSugestao[] = [];
  const vistas = new Set<string>();
  for (const bruta of r.sugestoes) {
    const s: SugestaoDeResposta = { enfoque: arrumar(bruta.enfoque), texto: arrumar(bruta.texto) };
    if (!s.enfoque || !s.texto) descartes.push('vazia');
    else if (caracteres(s.enfoque) > TAMANHO_MAXIMO.enfoque || caracteres(s.texto) > TAMANHO_MAXIMO.texto) descartes.push('longa');
    else if (temDadoPessoal(`${s.enfoque}\n${s.texto}`)) descartes.push('dado_pessoal');
    else if (vistas.has(normalizar(s.texto))) descartes.push('repetida');
    else if (sugestoes.length >= pedidas) descartes.push('sobra');
    else {
      vistas.add(normalizar(s.texto));
      sugestoes.push({ ...s, conferencia: conferirSugestao(s, base, conhecido) });
    }
  }
  return { sugestoes, descartes };
}

/** Sinais de estilo que o prompt proíbe e a conferência não barra (não são regra da resposta): servem ao eval. */
export function estiloDaSugestao(s: SugestaoDeResposta): string[] {
  const sinais: string[] = [];
  if (/#[\p{L}\p{N}_]/u.test(s.texto)) sinais.push('hashtag');
  if (/\p{Extended_Pictographic}/u.test(`${s.enfoque}${s.texto}`)) sinais.push('emoji');
  if (/[A-ZÀ-Ú]{12,}/u.test(s.texto.replace(/\s/g, ''))) sinais.push('caixa_alta');
  return sinais;
}
