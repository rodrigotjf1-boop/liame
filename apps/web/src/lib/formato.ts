// Formatos pt-BR usados nas telas. Dinheiro chega da API em micros (1 real = 1.000.000).

export const MICROS = 1_000_000;

const reais = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const diaMes = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
const diaMesAno = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
const hora = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function moeda(micros: number): string {
  return reais.format(micros / MICROS);
}

const MICROS_POR_CENTAVO = 10_000n;
const MICROS_POR_REAL = 1_000_000n;
const inteiros = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });

/** "1234567" → "1.234.567" (o texto é só de dígitos, vindo de um BigInt). */
function milhares(digitos: string): string {
  let saida = '';
  for (let i = 0; i < digitos.length; i++) {
    if (i > 0 && (digitos.length - i) % 3 === 0) saida += '.';
    saida += digitos[i];
  }
  return saida;
}

/**
 * Dinheiro da API (micros em texto, que cabe em bigint) em reais, **sem ponto flutuante**: "R$ 1.234,57",
 * arredondado para o centavo (ou para o real, com `casas` 0) mais próximo, metade para cima. O espaço
 * depois do "R$" é o mesmo espaço fixo do `Intl` (as telas não quebram o valor no meio).
 */
export function reaisDeMicros(micros: string | bigint, casas: 0 | 2 = 2): string {
  const valor = typeof micros === 'bigint' ? micros : BigInt(micros);
  const negativo = valor < 0n;
  const absoluto = negativo ? -valor : valor;
  const passo = casas === 2 ? MICROS_POR_CENTAVO : MICROS_POR_REAL;
  const arredondado = (absoluto + passo / 2n) / passo;
  const parteInteira = casas === 2 ? arredondado / 100n : arredondado;
  const centavos = casas === 2 ? `,${(arredondado % 100n).toString().padStart(2, '0')}` : '';
  const texto = `R$ ${milhares(parteInteira.toString())}${centavos}`;
  return negativo && arredondado > 0n ? `-${texto}` : texto;
}

/** Contagem com separador de milhar ("1.036"); aceita o texto de inteiro da API (conversas, conversões). */
export function inteiro(n: number | bigint | string): string {
  return inteiros.format(typeof n === 'string' ? BigInt(n) : n);
}

function inicioDoDia(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Dias de calendário entre hoje e a data (negativo = passado). */
export function diasAte(iso: string, agora = new Date()): number {
  return Math.round((inicioDoDia(new Date(iso)) - inicioDoDia(agora)) / 86_400_000);
}

/** "agora", "hoje, 08:10", "ontem, 21:40" ou "23/09". */
export function quando(iso: string, agora = new Date()): string {
  const d = new Date(iso);
  if (agora.getTime() - d.getTime() < 5 * 60_000) return 'agora';
  const dias = diasAte(iso, agora);
  if (dias === 0) return `hoje, ${hora.format(d)}`;
  if (dias === -1) return `ontem, ${hora.format(d)}`;
  return d.getFullYear() === agora.getFullYear() ? diaMes.format(d) : diaMesAno.format(d);
}

/** "hoje" ou "23/09". */
export function dia(iso: string, agora = new Date()): string {
  if (diasAte(iso, agora) === 0) return 'hoje';
  const d = new Date(iso);
  return d.getFullYear() === agora.getFullYear() ? diaMes.format(d) : diaMesAno.format(d);
}

export function dataCompleta(iso: string): string {
  return diaMesAno.format(new Date(iso));
}

/** "08:10". */
export function horaDe(iso: string): string {
  return hora.format(new Date(iso));
}

/** "20/09, 08:10" (com o ano quando não é o ano de agora). */
export function diaHora(iso: string, agora = new Date()): string {
  const d = new Date(iso);
  return `${d.getFullYear() === agora.getFullYear() ? diaMes.format(d) : diaMesAno.format(d)}, ${hora.format(d)}`;
}

/** "hoje, 08:10", "ontem, 23:47" ou "24/09, 19:32": sempre com a hora (atividade, atualização). */
export function quandoComHora(iso: string, agora = new Date()): string {
  const dias = diasAte(iso, agora);
  if (dias === 0) return `hoje, ${horaDe(iso)}`;
  if (dias === -1) return `ontem, ${horaDe(iso)}`;
  return diaHora(iso, agora);
}

/** "vence hoje", "vence amanhã" ou "vence em 5 dias". */
export function vencimento(iso: string, agora = new Date()): string {
  const dias = diasAte(iso, agora);
  if (dias <= 0) return 'vence hoje';
  if (dias === 1) return 'vence amanhã';
  return `vence em ${dias} dias`;
}

/** Data do seletor nativo (AAAA-MM-DD) → fim daquele dia no fuso de quem usa, em ISO. */
export function fimDoDia(data: string): string {
  const [a, m, d] = data.split('-').map(Number);
  return new Date(a!, m! - 1, d!, 23, 59, 59).toISOString();
}

/** ISO → AAAA-MM-DD no fuso local (para preencher o seletor nativo). */
export function paraSeletor(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function hojeSeletor(): string {
  return paraSeletor(new Date().toISOString());
}

/** Iniciais do nome (ou do e-mail): "Juliana Prado" → "JP". */
export function iniciais(nome: string): string {
  const partes = nome.replace(/@.*/, '').split(/[\s._-]+/).filter(Boolean);
  return partes.slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
}
