import { z } from 'zod';
import { bebidasAlcoolicas, gratisForaDasFontes, temLink, valoresComerciais, valoresForaDaOferta } from '../../policy/anuncio.js';
import { conferirTexto, type RegraDeTexto } from '../../policy/texto.js';
import { temDadoPessoal, temMarcaDeRemocao } from '../sanitizar.js';
import { conferirNumeros } from '../verificador-numeros.js';

// A mensagem do funcionário de CRM e mensageria e a conferência dela (A5, Y6; `plano-a5.md` D-A5-14 a D-A5-16 e
// critério A5-11). O modelo só propõe o nome da mensagem (para a equipe da loja) e o corpo do modelo de WhatsApp. O
// código confere, item por item, antes de qualquer pessoa ver: o preço e o benefício são os da oferta e do cupom, as
// regras da Liame e das plataformas, as regras da marca e o formato que a Meta aceita num modelo. O que barra não vira
// rascunho no RegemCast; o tamanho recomendado só avisa. Funções puras.
//
// As variáveis do modelo são fixas, e quem as preenche nunca é o modelo de IA: `{{1}}` é o primeiro nome de quem
// recebe (o RegemCast põe na hora do envio; o Liame não vê nome nem telefone) e `{{2}}` é o código do cupom da mensagem
// (o código do Liame põe). O rodapé de saída também é do código (`RODAPE_DE_SAIDA`), e não do modelo.

/** Por que a mensagem existe (D-A5-14): divulgar uma oferta de Minha marca, ou chamar de volta quem não pede há tempo. */
export const MOTIVOS_DA_MENSAGEM = ['promocao', 'volte_a_pedir'] as const;
export type MotivoDaMensagem = (typeof MOTIVOS_DA_MENSAGEM)[number];

/** Como a pessoa pede depois de ler: pelo cardápio online da loja, ou respondendo a própria mensagem. */
export const COMO_PEDIR = ['cardapio', 'whatsapp'] as const;
export type ComoPedir = (typeof COMO_PEDIR)[number];

/** O funcionário não escreve sobre isto: devolve o motivo e nenhuma mensagem. */
export const RECUSAS_DO_CRM = ['politica', 'bebida_alcoolica', 'categoria_proibida'] as const;
export type RecusaDoCrm = (typeof RECUSAS_DO_CRM)[number];

/** O schema que vai ao modelo: o mais simples possível; os limites são conferidos aqui, depois. */
export const RespostaDoCrm = z.strictObject({
  recusa: z.enum(RECUSAS_DO_CRM).nullable(),
  mensagem: z.strictObject({ nome: z.string(), corpo: z.string() }).nullable(),
});
export type RespostaDoCrm = z.infer<typeof RespostaDoCrm>;

export interface TextoDaMensagem {
  /** O nome da mensagem, para a equipe da loja (aparece em Aprovações e em Mensagens; quem recebe não o vê). */
  nome: string;
  /** O corpo do modelo de WhatsApp, com `{{1}}` (primeiro nome) e `{{2}}` (código do cupom). */
  corpo: string;
}

/** A variável do primeiro nome de quem recebe e a do código do cupom, como o modelo da Meta as escreve. */
export const VARIAVEL_DO_NOME = '{{1}}';
export const VARIAVEL_DO_CUPOM = '{{2}}';

/**
 * O rodapé de toda mensagem de marketing que o Liame rascunha. O RegemCast reconhece "sair" (a resposta inteira) como
 * pedido de saída e tira a pessoa dos próximos envios (`webhook.service.ts`, `PEDIDOS_DE_SAIDA`).
 */
export const RODAPE_DE_SAIDA = 'Responda SAIR para não receber mais.';

/**
 * O tamanho. O corpo de um modelo da Meta aceita até 1.024 caracteres; o Liame não rascunha acima de 700 (não é uma
 * mensagem de promoção, é um texto), e avisa acima de 450. O nome é só para a equipe: até 60, e avisa acima de 40. Os
 * dois "recomendados" são escolha do Liame, não regra da Meta.
 */
export const TAMANHO_RECOMENDADO = { nome: 40, corpo: 450 } as const;
export const TAMANHO_MAXIMO = { nome: 60, corpo: 700 } as const;
export const TAMANHO_DA_META = { corpo: 1024, rodape: 60 } as const;

/** Os caracteres como a pessoa conta: uma letra com acento vale um. */
export const caracteres = (t: string): number => Array.from(t).length;

/** Do que a mensagem parte, para a conferência: o que ela pode afirmar e o que não pode dizer. */
export interface BaseDaMensagem {
  /** A oferta de Minha marca, como está escrita lá; nula no "volte a pedir" sem oferta. */
  oferta: string | null;
  /** O benefício do cupom, em palavras ("10% de desconto"), e até quando vale ("válido até domingo, 12/10"). */
  cupom: { beneficio: string; validade: string };
  /** O que a marca afirma de si (`fatosDoDossie`). */
  fatos: string;
  /** O que a marca nunca diz (Minha marca). */
  proibidas: string[];
  /** Os concorrentes que a marca informou: não são citados. */
  concorrentes: string[];
}

export const ITENS_DA_CONFERENCIA = ['oferta', 'regras_da_liame', 'regras_da_marca', 'formato', 'tamanho'] as const;
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
  | 'sem_o_nome'
  | 'sem_o_cupom'
  | 'variavel_repetida'
  | 'variavel_estranha'
  | 'variavel_na_ponta'
  | 'acima_do_recomendado';

export interface AchadoDaMensagem {
  tipo: TipoDeAchado;
  campo: keyof TextoDaMensagem;
  /** O trecho que casou (o número como foi escrito, a frase da regra, a contagem); nunca um dado pessoal. */
  trecho: string;
}

export interface ItemConferido {
  item: ItemDaConferencia;
  situacao: SituacaoDaConferencia;
  achados: AchadoDaMensagem[];
}

export interface ConferenciaDaMensagem {
  /** A pior situação entre os itens: com um item barrado, a mensagem não vira rascunho. */
  situacao: SituacaoDaConferencia;
  itens: ItemConferido[];
  /** A mensagem cita algum valor (preço ou percentual)? */
  cita_valor: boolean;
  caracteres: Record<keyof TextoDaMensagem, number>;
}

const CAMPOS: Array<keyof TextoDaMensagem> = ['nome', 'corpo'];
const VARIAVEL = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** As variáveis que o corpo usa, na ordem em que aparecem, pelo que está entre as chaves ("1", "2", "nome"…). */
export function variaveisDoCorpo(corpo: string): string[] {
  return Array.from(corpo.matchAll(VARIAVEL), (m) => m[1] ?? '');
}

/** O corpo sem as variáveis, para as regras que olham número e palavra (o "1" de `{{1}}` não é um número do texto). */
const semVariaveis = (t: string): string => t.replace(VARIAVEL, ' ').replace(/[{}]/g, ' ');

/**
 * O formato que a Meta aceita num modelo, e o que o Liame combina com o RegemCast: `{{1}}` uma vez (o primeiro nome),
 * `{{2}}` uma vez (o código do cupom), nenhuma outra variável, nenhuma chave solta, e o corpo não começa nem termina
 * com uma variável (a Meta recusa). O nome da mensagem não leva variável nenhuma.
 */
function conferirFormato(m: TextoDaMensagem): AchadoDaMensagem[] {
  const achados: AchadoDaMensagem[] = [];
  if (/[{}]/.test(m.nome)) achados.push({ tipo: 'variavel_estranha', campo: 'nome', trecho: 'o nome não leva variável' });
  const usadas = variaveisDoCorpo(m.corpo);
  const quantas = (v: string) => usadas.filter((u) => u === v).length;
  if (quantas('1') === 0) achados.push({ tipo: 'sem_o_nome', campo: 'corpo', trecho: VARIAVEL_DO_NOME });
  if (quantas('2') === 0) achados.push({ tipo: 'sem_o_cupom', campo: 'corpo', trecho: VARIAVEL_DO_CUPOM });
  for (const v of ['1', '2']) if (quantas(v) > 1) achados.push({ tipo: 'variavel_repetida', campo: 'corpo', trecho: `{{${v}}} aparece ${quantas(v)} vezes` });
  for (const v of new Set(usadas)) if (v !== '1' && v !== '2') achados.push({ tipo: 'variavel_estranha', campo: 'corpo', trecho: `{{${v}}}`.slice(0, 40) });
  // Chave que sobrou fora de uma variável bem formada ("{1}", "{{2}").
  if (/[{}]/.test(m.corpo.replace(VARIAVEL, ''))) achados.push({ tipo: 'variavel_estranha', campo: 'corpo', trecho: 'chave solta no texto' });
  const corpo = m.corpo.trim();
  if (/^\{\{[^{}]*\}\}/.test(corpo)) achados.push({ tipo: 'variavel_na_ponta', campo: 'corpo', trecho: 'começa com uma variável' });
  if (/\{\{[^{}]*\}\}$/.test(corpo)) achados.push({ tipo: 'variavel_na_ponta', campo: 'corpo', trecho: 'termina com uma variável' });
  return achados;
}

/**
 * Confere uma mensagem contra a base dela. O preço, o percentual e o "grátis" são os da oferta e do benefício do
 * cupom; qualquer outro número precisa estar na oferta, no cupom (o benefício e a validade) ou nos fatos da marca: o
 * funcionário não inventa quantidade, prazo nem horário. As regras de texto são as de todo texto que a IA escreve.
 */
export function conferirMensagem(m: TextoDaMensagem, base: BaseDaMensagem): ConferenciaDaMensagem {
  const oferta: AchadoDaMensagem[] = [];
  const liame: AchadoDaMensagem[] = [];
  const marca: AchadoDaMensagem[] = [];
  const tamanho: AchadoDaMensagem[] = [];
  let citaValor = false;
  // De onde um valor pode vir: a oferta e o benefício do cupom. De onde um número pode vir: esses, a validade e os fatos.
  const fonteDosValores = [base.oferta ?? '', base.cupom.beneficio].join('\n');
  const fontesDosNumeros = [base.oferta ?? '', base.cupom.beneficio, base.cupom.validade, base.fatos];
  for (const campo of CAMPOS) {
    const t = semVariaveis(m[campo]);
    const valoresFora = valoresForaDaOferta(t, fonteDosValores);
    if (valoresComerciais(t).length) citaValor = true;
    for (const trecho of new Set(valoresFora)) oferta.push({ tipo: 'preco_fora', campo, trecho });
    for (const trecho of gratisForaDasFontes(t, [base.oferta ?? '', base.cupom.beneficio, base.fatos])) oferta.push({ tipo: 'gratis_fora', campo, trecho });
    const jaDitos = new Set(valoresFora);
    for (const trecho of new Set(conferirNumeros(t, fontesDosNumeros).fora)) if (!jaDitos.has(trecho)) oferta.push({ tipo: 'numero_fora', campo, trecho });
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
    const n = caracteres(m[campo]);
    if (n > TAMANHO_RECOMENDADO[campo]) tamanho.push({ tipo: 'acima_do_recomendado', campo, trecho: `${n} de ${TAMANHO_RECOMENDADO[campo]}` });
  }
  const item = (nome: ItemDaConferencia, achados: AchadoDaMensagem[], comAchado: SituacaoDaConferencia): ItemConferido => ({ item: nome, situacao: achados.length ? comAchado : 'passou', achados });
  const itens = [
    item('oferta', oferta, 'barrou'),
    item('regras_da_liame', liame, 'barrou'),
    item('regras_da_marca', marca, 'barrou'),
    item('formato', conferirFormato(m), 'barrou'),
    item('tamanho', tamanho, 'aviso'),
  ];
  const situacao: SituacaoDaConferencia = itens.some((i) => i.situacao === 'barrou') ? 'barrou' : itens.some((i) => i.situacao === 'aviso') ? 'aviso' : 'passou';
  return { situacao, itens, cita_valor: citaValor, caracteres: { nome: caracteres(m.nome), corpo: caracteres(m.corpo) } };
}

export interface MensagemConferida extends TextoDaMensagem {
  conferencia: ConferenciaDaMensagem;
}

/** Por que a mensagem do modelo nem chegou à conferência (vai para o log e para o registro; nunca o texto). */
export type DescarteDaMensagem = 'vazia' | 'longa' | 'dado_pessoal' | 'com_recusa' | 'sem_mensagem';

/** O corpo com os espaços arrumados: uma linha em branco no máximo entre parágrafos, sem espaço dobrado nem tabulação. */
const arrumarCorpo = (t: string): string =>
  t
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[\t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
const arrumarNome = (t: string): string => t.replace(/\s+/g, ' ').trim();

/**
 * O que o código faz com a resposta do modelo. Com recusa, nenhuma mensagem é usada. Sem recusa, a mensagem tem os
 * espaços arrumados e só segue se tem nome e corpo, cabe no teto do Liame e não traz dado pessoal (cru, ou já trocado
 * pela marca da limpeza do gateway). A que segue sai conferida: a barrada fica registrada, com o motivo, e não vira
 * rascunho no RegemCast.
 */
export function mensagemDaResposta(r: RespostaDoCrm, base: BaseDaMensagem): { recusa: RecusaDoCrm | null; mensagem: MensagemConferida | null; descarte: DescarteDaMensagem | null } {
  if (r.recusa) return { recusa: r.recusa, mensagem: null, descarte: r.mensagem ? 'com_recusa' : null };
  if (!r.mensagem) return { recusa: null, mensagem: null, descarte: 'sem_mensagem' };
  const m: TextoDaMensagem = { nome: arrumarNome(r.mensagem.nome), corpo: arrumarCorpo(r.mensagem.corpo) };
  if (!m.nome || !m.corpo) return { recusa: null, mensagem: null, descarte: 'vazia' };
  if (caracteres(m.nome) > TAMANHO_MAXIMO.nome || caracteres(m.corpo) > TAMANHO_MAXIMO.corpo) return { recusa: null, mensagem: null, descarte: 'longa' };
  if (temDadoPessoal(`${m.nome}\n${m.corpo}`)) return { recusa: null, mensagem: null, descarte: 'dado_pessoal' };
  return { recusa: null, mensagem: { ...m, conferencia: conferirMensagem(m, base) }, descarte: null };
}

/**
 * O corpo como quem recebe vai ler, para a pessoa que aprova e para os exemplos que a Meta pede no modelo: o primeiro
 * nome vira um exemplo fixo, que não é de ninguém, e o cupom vira o código.
 */
export const NOME_DE_EXEMPLO = 'Maria';
export function corpoDeExemplo(corpo: string, codigoDoCupom: string): string {
  return corpo.replaceAll(VARIAVEL_DO_NOME, NOME_DE_EXEMPLO).replaceAll(VARIAVEL_DO_CUPOM, codigoDoCupom);
}

/** Sinais de estilo que o prompt proíbe e a conferência não barra (não são regra de mensagem): servem ao eval. */
export function estiloDaMensagem(m: TextoDaMensagem): string[] {
  const t = `${m.nome}\n${m.corpo}`;
  const sinais: string[] = [];
  if (/#[\p{L}\p{N}_]/u.test(t)) sinais.push('hashtag');
  if (/\p{Extended_Pictographic}/u.test(t)) sinais.push('emoji');
  if (/[A-ZÀ-Ú]{12,}/u.test(t.replace(/\s/g, ''))) sinais.push('caixa_alta');
  return sinais;
}
