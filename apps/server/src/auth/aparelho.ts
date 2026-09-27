import { isIPv6 } from 'node:net';

// Como a pessoa reconhece um aparelho na tela "Segurança da conta": "Chrome no Windows" e o IP com o
// final escondido ("177.52.18.x"). Só para exibição à própria pessoa; nada disso decide acesso.

const NAVEGADORES: [RegExp, string][] = [
  [/Edg(A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SISTEMAS: [RegExp, string][] = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'Mac'],
  [/CrOS/, 'Chromebook'],
  [/Linux/, 'Linux'],
];

export function descreverAparelho(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Aparelho desconhecido';
  const navegador = NAVEGADORES.find(([re]) => re.test(userAgent))?.[1];
  const sistema = SISTEMAS.find(([re]) => re.test(userAgent))?.[1];
  if (navegador && sistema) return `${navegador} no ${sistema}`;
  return navegador ?? sistema ?? 'Aparelho desconhecido';
}

/** IPv4 sem o último número ("177.52.18.x"); IPv6 com os três primeiros grupos ("2804:14c:65::x"). */
export function mascararIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v4 = ip.replace(/^::ffff:/i, '');
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(v4);
  if (m) return `${m[1]}.${m[2]}.${m[3]}.x`;
  // O "::" comprime grupos de zero: expandir antes de cortar, senão "2804::1a2b" sairia inteiro (ERR-032).
  const grupos = gruposIpv6(ip);
  return grupos ? `${grupos.slice(0, 3).join(':')}::x` : null;
}

/** Os 8 grupos de um IPv6 (sem zeros à esquerda), ou null se não for um IPv6 válido. */
function gruposIpv6(ip: string): string[] | null {
  const semZona = ip.split('%')[0]!.toLowerCase();
  if (!isIPv6(semZona)) return null;
  // IPv4 no fim (ex.: 64:ff9b::192.0.2.1) conta como dois grupos.
  const partes = semZona.replace(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/, (_, a, b, c, d) => {
    const n = [a, b, c, d].map(Number);
    return `${((n[0]! << 8) | n[1]!).toString(16)}:${((n[2]! << 8) | n[3]!).toString(16)}`;
  });
  const [cabeca = '', cauda] = partes.split('::');
  const antes = cabeca ? cabeca.split(':') : [];
  if (cauda === undefined) return antes.length === 8 ? antes.map(limpo) : null;
  const depois = cauda ? cauda.split(':') : [];
  const zeros = 8 - antes.length - depois.length;
  if (zeros < 1) return null;
  return [...antes, ...Array<string>(zeros).fill('0'), ...depois].map(limpo);
}

const limpo = (g: string) => g.replace(/^0+(?=.)/, '');
