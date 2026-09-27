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
  const v4 = ip.replace(/^::ffff:/, '');
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(v4);
  if (m) return `${m[1]}.${m[2]}.${m[3]}.x`;
  if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::x`;
  return null;
}
