// Verificador de números (A3-5): a IA não calcula número final. Todo número que ela escreve precisa
// estar no contexto que o código entregou; se aparecer um que não está, a resposta inteira é descartada
// e a tela mostra o texto sem IA. É condição necessária, não suficiente: número certo atribuído à coisa
// errada é assunto dos evals (`evals/`), não daqui.

/** Um número como aparece num texto em português: "1.250,00", "12,56", "83,4", "38", "2026". */
const NUMERO = /\d[\d.,]*\d|\d/g;
/**
 * Uma data (com a hora, quando vem junto): "18/09/2026", "02/10/2026 01:54". Conta inteira, como uma
 * ficha só: o "10" de outubro não autoriza a IA a escrever "10%".
 */
const DATA = /\d{2}\/\d{2}\/\d{4}(?: \d{2}:\d{2})?/g;

/** Tamanho máximo do texto conferido (a resposta de uma explicação fica muito abaixo disto). */
const TEXTO_MAXIMO = 400_000;

/**
 * A forma única de um número, para comparar o que a IA escreveu com o que o código entregou:
 * "1.250,00" → "1250", "12,56" → "12.56", "83,4" → "83.4", "09" → "9", "2.6" → "2.6".
 * O ponto seguido de exatamente três dígitos é separador de milhar; a vírgula é a casa decimal.
 */
export function formaDoNumero(bruto: string): string {
  let inteiro = bruto;
  let fracao = '';
  const virgula = bruto.lastIndexOf(',');
  if (virgula >= 0) {
    inteiro = bruto.slice(0, virgula);
    fracao = bruto.slice(virgula + 1);
  } else {
    // Sem vírgula: "1.250" e "1.234.567" são milhares; "2.6" e "12.56" são decimais escritos com ponto.
    const partes = bruto.split('.');
    const ultima = partes[partes.length - 1] ?? '';
    if (partes.length === 2 && ultima.length !== 3) {
      inteiro = partes[0] ?? '';
      fracao = ultima;
    }
  }
  const digitos = (s: string) => {
    let saida = '';
    for (const c of s) if (c >= '0' && c <= '9') saida += c;
    return saida;
  };
  let i = digitos(inteiro);
  let f = digitos(fracao);
  while (i.length > 1 && i.startsWith('0')) i = i.slice(1);
  while (f.endsWith('0')) f = f.slice(0, -1);
  return f ? `${i || '0'}.${f}` : i || '0';
}

interface Ficha {
  /** Como estava escrito. */
  bruto: string;
  /** Como se compara: a data inteira (`data:18/09/2026`) ou a forma única do número. */
  forma: string;
}

/** As datas e os números de um texto, na ordem: datas primeiro (cada uma inteira), depois os números do resto. */
function fichasDe(texto: string): Ficha[] {
  if (texto.length > TEXTO_MAXIMO) throw new Error('verificador de números: texto grande demais');
  const datas = texto.match(DATA) ?? [];
  const resto = datas.length ? texto.replace(DATA, ' ') : texto;
  return [...datas.map((d) => ({ bruto: d, forma: `data:${d}` })), ...(resto.match(NUMERO) ?? []).map((n) => ({ bruto: n, forma: formaDoNumero(n) }))];
}

/** As datas e os números de um texto, cada um na forma em que é comparado. */
export function numerosDe(texto: string): string[] {
  return fichasDe(texto).map((f) => f.forma);
}

/** Uma data ou um número, o que vier primeiro na leitura (a data antes: ela conta inteira). */
const FICHA = /\d{2}\/\d{2}\/\d{4}(?: \d{2}:\d{2})?|\d[\d.,]*\d|\d/g;

export interface Trecho {
  texto: string;
  /** A forma em que o trecho é comparado, quando ele é uma data ou um número; nula no texto comum. */
  forma: string | null;
}

/**
 * O texto na ordem em que se lê, partido em trechos: cada data e cada número num trecho próprio, e o
 * texto comum entre eles. É o que a tela usa para mostrar de onde veio cada número; a conferência
 * (`conferirNumeros`) continua sendo a de cima.
 */
export function trechosDe(texto: string): Trecho[] {
  if (texto.length > TEXTO_MAXIMO) throw new Error('verificador de números: texto grande demais');
  const trechos: Trecho[] = [];
  let fim = 0;
  for (const m of texto.matchAll(FICHA)) {
    const bruto = m[0];
    if (m.index > fim) trechos.push({ texto: texto.slice(fim, m.index), forma: null });
    trechos.push({ texto: bruto, forma: bruto.includes('/') ? `data:${bruto}` : formaDoNumero(bruto) });
    fim = m.index + bruto.length;
  }
  if (fim < texto.length) trechos.push({ texto: texto.slice(fim), forma: null });
  return trechos;
}

/** Todo texto de um valor (objeto, lista ou texto), junto. */
function textosDe(valor: unknown): string[] {
  if (typeof valor === 'string') return [valor];
  if (typeof valor === 'number') return [String(valor)];
  if (Array.isArray(valor)) return valor.flatMap(textosDe);
  if (valor && typeof valor === 'object') return Object.values(valor).flatMap(textosDe);
  return [];
}

export interface Conferencia {
  ok: boolean;
  /** Os números (e as datas) da resposta que não estão no contexto, como a IA os escreveu. */
  fora: string[];
}

/**
 * Confere a resposta da IA contra o contexto entregue: cada número escrito (em qualquer texto da
 * resposta) precisa existir, com o mesmo valor, em algum texto ou número do contexto; cada data, igual.
 */
export function conferirNumeros(resposta: unknown, contexto: unknown): Conferencia {
  const permitidos = new Set(textosDe(contexto).flatMap(numerosDe));
  // A data sem a hora também vale quando o contexto a traz com a hora.
  for (const p of [...permitidos]) if (p.startsWith('data:') && p.length > 15) permitidos.add(p.slice(0, 15));
  const fora = textosDe(resposta)
    .flatMap(fichasDe)
    .filter((f) => !permitidos.has(f.forma))
    .map((f) => f.bruto);
  return { ok: fora.length === 0, fora };
}
