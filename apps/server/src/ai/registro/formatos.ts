// Números e datas como a pessoa lê, para a visão que o modelo recebe. Tudo a partir do texto exato que
// as rotas devolvem (micros, razão com duas casas), sem ponto flutuante: a IA cita o que recebeu, e o
// verificador de números (I4) compara o que ela escreveu com estes mesmos textos.

/** Separa os milhares com ponto: "1234567" → "1.234.567". Só dígitos na entrada. */
function milhares(digitos: string): string {
  const partes: string[] = [];
  for (let fim = digitos.length; fim > 0; fim -= 3) partes.unshift(digitos.slice(Math.max(0, fim - 3), fim));
  return partes.join('.');
}

/** "R$ 12.060,00" a partir de micros em texto (1 real = 1.000.000); o centavo arredonda para o mais próximo. */
export function dinheiro(micros: string | null | undefined, moeda = 'BRL'): string | null {
  if (micros === null || micros === undefined) return null;
  const valor = BigInt(micros);
  const negativo = valor < 0n;
  const centavos = ((negativo ? -valor : valor) + 5_000n) / 10_000n;
  const texto = `${milhares((centavos / 100n).toString())},${(centavos % 100n).toString().padStart(2, '0')}`;
  return `${negativo && centavos > 0n ? '-' : ''}${moeda === 'BRL' ? 'R$' : moeda} ${texto}`;
}

/** "R$ 1.250,00" a partir do valor já na moeda, com duas casas em texto ("1250.00"), como o banco arredonda. */
export function dinheiroDecimal(valor: string | null | undefined, moeda: string | null | undefined = 'BRL'): string | null {
  if (valor === null || valor === undefined) return null;
  const negativo = valor.startsWith('-');
  const [parteInteira, fracao = ''] = (negativo ? valor.slice(1) : valor).split('.');
  return `${negativo ? '-' : ''}${!moeda || moeda === 'BRL' ? 'R$' : moeda} ${milhares(parteInteira ?? '0')},${fracao.padEnd(2, '0').slice(0, 2)}`;
}

/** Contagem com separador de milhar: 12500 → "12.500". */
export function inteiro(n: number | string | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  const texto = typeof n === 'number' ? Math.trunc(n).toString() : n.split('.')[0]!;
  const negativo = texto.startsWith('-');
  return `${negativo ? '-' : ''}${milhares(negativo ? texto.slice(1) : texto)}`;
}

/** Número com casas decimais, como veio: "1234.5" → "1.234,5" (conversões fracionárias do Google Ads). */
export function decimal(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const negativo = v.startsWith('-');
  const [parteInteira, fracao] = (negativo ? v.slice(1) : v).split('.');
  return `${negativo ? '-' : ''}${milhares(parteInteira ?? '0')}${fracao ? `,${fracao}` : ''}`;
}

/** Razão com duas casas: "3.80" → "3,80". */
export function razao(r: string | null | undefined): string | null {
  return r === null || r === undefined ? null : r.replace('.', ',');
}

/** Porcentagem com uma casa: "83.4" → "83,4%". */
export function porcento(p: string | null | undefined): string | null {
  return p === null || p === undefined ? null : `${p.replace('.', ',')}%`;
}

/** Dia: "2026-09-01" → "01/09/2026". */
export function dia(d: string | null | undefined): string | null {
  if (!d) return null;
  const [ano, mes, diaDoMes] = d.slice(0, 10).split('-');
  return `${diaDoMes}/${mes}/${ano}`;
}

/** Tira do objeto o que é nulo, indefinido ou lista vazia: o modelo recebe só o que existe. */
export function soOQueExiste<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))) as Partial<T>;
}
