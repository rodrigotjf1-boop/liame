// O texto de uma página para o leitor em quarentena (A3, I12; `ai-architecture.md` §6): sem script, estilo, comentário
// nem marcação; sem link (nunca devolvemos link montado); sem caracteres invisíveis (os que escondem instrução); com
// tamanho máximo. E o reconhecimento, por regra, do texto que tenta dar ordens a uma IA: com ele, o Pesquisador não
// usa nada da página. Funções puras. A página vem de fora e pode ter sido feita para travar o leitor: a varredura do
// HTML é linear (`indexOf`, sem expressão regular que volte atrás sobre o documento inteiro).

/** Tamanho máximo do texto que vai ao modelo (a página inteira passa disso: fica o começo). */
export const TEXTO_MAXIMO = 30_000;
/** Menos texto que isto: a página não tem o que ler (provavelmente monta o conteúdo com JavaScript). */
export const TEXTO_MINIMO = 80;
/** O começo do documento em que se procuram o título e a descrição (a cabeça da página). */
const CABECA = 65_536;

/** Caracteres que não aparecem na tela e servem para esconder texto: largura zero, direção, separadores invisíveis. */
const INVISIVEIS = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ\u{e0000}-\u{e007f}]/gu;

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', ordm: 'º', ordf: 'ª', deg: '°' };

/** Blocos que saem inteiros, com o que está dentro. */
const FORA = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object', 'canvas', 'head', 'math']);
/** Etiquetas que separam blocos de texto (viram quebra de linha). */
const QUEBRA = new Set([
  'br', 'hr', 'p', 'div', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'td', 'th', 'section', 'article', 'header',
  'footer', 'nav', 'main', 'aside', 'table', 'dd', 'dt', 'blockquote', 'figcaption', 'label', 'option', 'button',
]);

/** Decodifica as entidades de HTML: as numéricas e as nomeadas mais comuns (as outras ficam como estão). */
export function decodificarEntidades(texto: string): string {
  return texto.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (inteiro, nome: string) => {
    if (nome[0] === '#') {
      const codigo = nome[1] === 'x' || nome[1] === 'X' ? parseInt(nome.slice(2), 16) : parseInt(nome.slice(1), 10);
      return Number.isFinite(codigo) && codigo > 0 && codigo <= 0x10ffff ? String.fromCodePoint(codigo) : inteiro;
    }
    return ENTIDADES[nome.toLowerCase()] ?? inteiro;
  });
}

/** Tira os caracteres invisíveis e junta os espaços (as quebras de linha ficam, uma por vez). */
export function limparInvisiveis(texto: string): string {
  return texto
    .replace(INVISIVEIS, '')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ ?\n[\n ]*/g, '\n')
    .trim();
}

/** O valor de um atributo numa etiqueta curta (a etiqueta inteira, já sem os `<` e `>`). */
function atributo(etiqueta: string, nome: string): string | null {
  const baixo = etiqueta.toLowerCase();
  for (let i = baixo.indexOf(nome); i >= 0; i = baixo.indexOf(nome, i + 1)) {
    const antes = baixo[i - 1] ?? ' ';
    if (!/[\s"'/]/.test(antes)) continue;
    let j = i + nome.length;
    while (baixo[j] === ' ') j++;
    if (baixo[j] !== '=') continue;
    j++;
    while (baixo[j] === ' ') j++;
    const aspas = etiqueta[j];
    if (aspas === '"' || aspas === "'") {
      const fim = etiqueta.indexOf(aspas, j + 1);
      return fim < 0 ? null : etiqueta.slice(j + 1, fim);
    }
    const fim = etiqueta.slice(j).search(/[\s>]/);
    return fim < 0 ? etiqueta.slice(j) : etiqueta.slice(j, j + fim);
  }
  return null;
}

/** Tira a marcação de um trecho curto (o título): o que está entre `<` e `>` sai. */
const semMarcacao = (trecho: string) => {
  let saida = '';
  let i = 0;
  while (i < trecho.length) {
    const lt = trecho.indexOf('<', i);
    if (lt < 0) return saida + trecho.slice(i);
    saida += `${trecho.slice(i, lt)} `;
    const gt = trecho.indexOf('>', lt + 1);
    if (gt < 0) return saida;
    i = gt + 1;
  }
  return saida;
};

/**
 * O título, a descrição e o texto visível de uma página HTML. Script, estilo, `noscript`, `template`, `svg`, `iframe` e
 * comentários saem inteiros; o resto da marcação some; blocos viram quebras de linha. Endereços de link não entram.
 */
export function textoDaPagina(html: string): { titulo: string; descricao: string; texto: string } {
  const baixo = html.toLowerCase();
  const cabeca = baixo.slice(0, CABECA);

  let titulo = '';
  const abreTitulo = cabeca.indexOf('<title');
  if (abreTitulo >= 0) {
    const inicio = cabeca.indexOf('>', abreTitulo);
    const fim = inicio < 0 ? -1 : cabeca.indexOf('</title', inicio);
    if (fim > inicio) titulo = limparInvisiveis(decodificarEntidades(semMarcacao(html.slice(inicio + 1, Math.min(fim, inicio + 2000)))));
  }

  let descricao = '';
  for (let i = cabeca.indexOf('<meta'); i >= 0 && !descricao; i = cabeca.indexOf('<meta', i + 5)) {
    const fim = cabeca.indexOf('>', i);
    if (fim < 0) break;
    const etiqueta = html.slice(i + 5, Math.min(fim, i + 2000));
    const nome = (atributo(etiqueta, 'name') ?? atributo(etiqueta, 'property') ?? '').toLowerCase();
    if (nome === 'description' || nome === 'og:description') descricao = limparInvisiveis(decodificarEntidades(atributo(etiqueta, 'content') ?? ''));
  }

  const partes: string[] = [];
  let tamanho = 0;
  const juntar = (t: string) => {
    partes.push(t);
    tamanho += t.length;
  };
  let i = 0;
  while (i < html.length && tamanho < TEXTO_MAXIMO * 4) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      juntar(html.slice(i));
      break;
    }
    juntar(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) {
      const fim = html.indexOf('-->', lt + 4);
      juntar(' ');
      if (fim < 0) break;
      i = fim + 3;
      continue;
    }
    const gt = html.indexOf('>', lt + 1);
    // Etiqueta sem fim: o resto do documento não é texto confiável.
    if (gt < 0) break;
    const nome = /^\/?([a-z][a-z0-9-]*)/.exec(baixo.slice(lt + 1, Math.min(gt, lt + 40)))?.[1] ?? '';
    const fechando = baixo[lt + 1] === '/';
    if (!fechando && FORA.has(nome) && baixo[gt - 1] !== '/') {
      const fecha = baixo.indexOf(`</${nome}`, gt + 1);
      if (fecha < 0) break;
      const fimDoFecha = baixo.indexOf('>', fecha);
      juntar(' ');
      if (fimDoFecha < 0) break;
      i = fimDoFecha + 1;
      continue;
    }
    juntar(QUEBRA.has(nome) ? '\n' : ' ');
    i = gt + 1;
  }
  const texto = limparInvisiveis(decodificarEntidades(partes.join('')).replace(/[<>]/g, ' '));
  return { titulo: titulo.slice(0, 300), descricao: descricao.slice(0, 500), texto: texto.slice(0, TEXTO_MAXIMO) };
}

/** O texto de uma resposta, pelo charset que ela diz (UTF-8 quando não diz; Latin-1 e Windows-1252 também). */
export function decodificarCorpo(corpo: Buffer, contentType: string | null): string {
  const doCabecalho = /charset=["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  const doDocumento = /<meta[^>]{0,200}charset=["']?([\w-]+)/i.exec(corpo.subarray(0, 2048).toString('latin1'))?.[1];
  const declarado = (doCabecalho ?? doDocumento ?? '').toLowerCase();
  const rotulo = ['iso-8859-1', 'latin1', 'windows-1252', 'cp1252', 'us-ascii'].includes(declarado) ? 'windows-1252' : 'utf-8';
  return new TextDecoder(rotulo, { fatal: false }).decode(corpo);
}

/** O tipo da resposta é uma página que dá para ler (HTML ou texto)? */
export const ehPagina = (contentType: string | null): boolean => /^(text\/html|application\/xhtml\+xml|text\/plain)\b/i.test((contentType ?? '').trim());

/**
 * Texto que tenta dar ordens a uma IA (ou a quem lê) no meio da página: "ignore as instruções", "você agora é uma IA",
 * marcas de papel de conversa ("system:", "assistant:"), etiquetas de formato de prompt. A regra é a primeira barreira;
 * o leitor também marca o que achar (`instrucao_na_pagina`). Com qualquer um dos dois, nada da página é usado. Roda
 * sobre o texto já limpo (sem sequências longas de espaço).
 */
const INSTRUCAO = [
  /\bignor[ea]\w* (?:as |todas as |tudo |qualquer )?(?:instru|regra|orienta|ordens|comando)/i,
  /\bignore (?:all |any |the )?(?:previous |prior |above |earlier )?(?:instructions|rules|prompts?)\b/i,
  /\b(?:esque[cç]a|desconsidere) (?:as |tudo |todas as )?(?:instru|regra|orienta)/i,
  /\b(?:disregard|forget) (?:all |the |your )?(?:previous |prior |above )?(?:instructions|rules)\b/i,
  /\bvoc[eê] (?:agora )?(?:é|e|deve agir como) (?:um|uma) (?:ia|assistente de ia|modelo de linguagem|chatbot)\b/i,
  /\byou are (?:now )?(?:an? )?(?:ai|assistant|language model|chatbot)\b/i,
  /(?:^|\n) ?(?:system|assistant|sistema|assistente) ?:/i,
  /<\|im_(?:start|end)\|>|\[\/?inst\]|<<\/?sys>>/i,
  /\b(?:prompt do sistema|system prompt|jailbreak)\b/i,
  /\b(?:para|to) (?:a |o )?(?:ia|ai|llm|chatgpt|claude|gpt)[:,]/i,
];
export const pareceInstrucao = (texto: string): boolean => INSTRUCAO.some((r) => r.test(texto));
