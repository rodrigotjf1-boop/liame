import type { DetectedPlatform, OrderPlatform } from '@liame/contracts';

// Plataforma de pedidos da loja e período do vínculo do cupom (A2.5, F6): funções puras, testadas sem banco.
// A sugestão da plataforma sai do destino dos anúncios ativos; quem confirma é a empresa.

/** Domínios das plataformas de pedidos que chegam ao Regem pela integração (conferidos em 30/09/2026). */
const DOMINIOS: { dominio: string; plataforma: OrderPlatform }[] = [
  { dominio: 'anota.ai', plataforma: 'anotaai' },
  { dominio: 'cardapioweb.com', plataforma: 'cardapioweb' },
];

const noDominio = (host: string, dominio: string) => host === dominio || host.endsWith(`.${dominio}`);

function hostDe(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** A plataforma de um endereço de anúncio: a das integrações pelo domínio, ou o cardápio do Regem da loja. */
export function plataformaDoEndereco(url: string, cardapios: readonly string[]): { plataforma: OrderPlatform; host: string } | null {
  const host = hostDe(url);
  if (!host) return null;
  const conhecida = DOMINIOS.find((d) => noDominio(host, d.dominio));
  if (conhecida) return { plataforma: conhecida.plataforma, host };
  if (cardapios.some((c) => hostDe(c) === host)) return { plataforma: 'regem', host };
  return null;
}

/**
 * A plataforma para onde vai a maior parte dos anúncios ativos (um anúncio conta uma vez por plataforma).
 * Empate: a integração vence o cardápio do Regem (o anúncio que leva a ela é o que perde o clique).
 */
export function sugerirPlataforma(destinos: readonly { adId: string; provider: string; url: string }[], cardapios: readonly string[]): DetectedPlatform | null {
  const porPlataforma = new Map<OrderPlatform, { ads: Set<string>; hosts: Map<string, number>; providers: Map<string, number> }>();
  for (const d of destinos) {
    const p = plataformaDoEndereco(d.url, cardapios);
    if (!p) continue;
    const g = porPlataforma.get(p.plataforma) ?? { ads: new Set(), hosts: new Map(), providers: new Map() };
    if (!g.ads.has(d.adId)) {
      g.ads.add(d.adId);
      g.hosts.set(p.host, (g.hosts.get(p.host) ?? 0) + 1);
      g.providers.set(d.provider, (g.providers.get(d.provider) ?? 0) + 1);
    }
    porPlataforma.set(p.plataforma, g);
  }
  const mais = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  const ordem: OrderPlatform[] = ['anotaai', 'cardapioweb', 'regem'];
  const escolhida = [...porPlataforma].sort((a, b) => b[1].ads.size - a[1].ads.size || ordem.indexOf(a[0]) - ordem.indexOf(b[0]))[0];
  if (!escolhida) return null;
  const [platform, g] = escolhida;
  return { platform, host: mais(g.hosts), provider: mais(g.providers), ads: g.ads.size };
}

export type MotivoEndereco = 'invalido' | 'esquema' | 'credenciais' | 'sem_dominio';

/** Endereço do cardápio de "outra plataforma": só https, sem usuário e senha, com domínio de verdade. */
export function enderecoDoCardapio(texto: string): { ok: true; url: string } | { ok: false; motivo: MotivoEndereco } {
  let u: URL;
  try {
    u = new URL(texto.trim());
  } catch {
    return { ok: false, motivo: 'invalido' };
  }
  if (u.protocol !== 'https:') return { ok: false, motivo: 'esquema' };
  if (u.username || u.password) return { ok: false, motivo: 'credenciais' };
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(u.hostname)) return { ok: false, motivo: 'sem_dominio' };
  const url = u.toString();
  return url.length <= 1024 ? { ok: true, url } : { ok: false, motivo: 'invalido' };
}

/** O dia (AAAA-MM-DD) de um instante no fuso da loja. */
export function diaNoFuso(instante: Date, fuso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instante);
}

export type Periodo = { ok: true; inicio: string; fim: string | null } | { ok: false; motivo: 'inicio_no_passado' | 'fim_antes_do_inicio' | 'dia_invalido' };

const diaValido = (d: string) => {
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d;
};

/** O período do vínculo em dias do fuso da loja: começa hoje ou depois; o fim (inclusive) não vem antes do início. */
export function periodoDoVinculo(hoje: string, inicio?: string, fim?: string | null): Periodo {
  const de = inicio ?? hoje;
  if (!diaValido(de) || (fim != null && !diaValido(fim))) return { ok: false, motivo: 'dia_invalido' };
  if (de < hoje) return { ok: false, motivo: 'inicio_no_passado' };
  if (fim != null && fim < de) return { ok: false, motivo: 'fim_antes_do_inicio' };
  return { ok: true, inicio: de, fim: fim ?? null };
}
