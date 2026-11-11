import { OSM_ATTRIBUTION, type StoreLocation } from '@liame/contracts';

// A loja no mapa (plano da região, R1): as regras puras, sem banco e sem rede.

/** A função da região (nasce desligada; a Liame libera por empresa). */
export const FLAG_DA_REGIAO = 'regiao';
export const ATRIBUICAO = OSM_ATTRIBUTION;

/**
 * A rua e o número de uma linha de endereço do Perfil do Google ("Rua X, 123" ou "Rua X, 123 - Loja 2"). Sem vírgula,
 * ou sem número depois dela, a linha inteira é a rua e o número fica nulo: a pessoa completa.
 */
export function ruaENumero(linha: string | undefined): { rua: string | null; numero: string | null } {
  const t = (linha ?? '').trim();
  if (!t) return { rua: null, numero: null };
  const virgula = t.indexOf(',');
  if (virgula < 0) return { rua: t.slice(0, 200), numero: null };
  const rua = t.slice(0, virgula).trim();
  const depois = t.slice(virgula + 1).trim();
  let fim = 0;
  while (fim < depois.length && fim < 20 && depois[fim]! >= '0' && depois[fim]! <= '9') fim++;
  // "s/n" e "sem número" contam como sem número.
  if (fim === 0 || !rua) return { rua: (rua || t).slice(0, 200), numero: null };
  return { rua: rua.slice(0, 200), numero: depois.slice(0, fim) };
}

/** As áreas de entrega, sem repetir (sem diferença de caixa) e sem vazias, na ordem em que vieram, até 20. */
export function areasDeEntrega(areas: readonly string[]): string[] {
  const vistas = new Set<string>();
  const lista: string[] = [];
  for (const a of areas) {
    const t = a.trim().replace(/\s+/g, ' ').slice(0, 80);
    const chave = t.toLowerCase();
    if (!t || vistas.has(chave)) continue;
    vistas.add(chave);
    lista.push(t);
    if (lista.length === 20) break;
  }
  return lista;
}

/** A linha da loja como o banco devolve. */
export type LinhaDaLoja = {
  id: string;
  name: string;
  address_postal_code: string | null;
  address_street: string | null;
  address_number: string | null;
  address_complement: string | null;
  address_district: string | null;
  address_city: string | null;
  address_state: string | null;
  ibge_city_code: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
  location_precision: string | null;
  location_source: string | null;
  delivery_radius_km: string | number | null;
  delivery_areas: unknown;
  location_set_at: Date | string | null;
  user_id: string | null;
  user_name: string | null;
  /** Nenhuma conta do Regem apontou para a loja: ela nasceu no Liame (D-RG-17). */
  created_here: boolean;
  /** O Perfil do Google desta loja (`connected_account.unit_id`), conectado. */
  google_profile_account_id: string | null;
};

/**
 * O fuso da loja criada no Liame, pela UF (o Brasil não tem horário de verão desde 2019). As lojas do Regem vêm com o
 * fuso dele; aqui só os estados fora do horário de Brasília mudam (no Amazonas, o oeste do estado fica com Manaus).
 */
export function fusoDaUf(uf: string): string {
  const fusos: Record<string, string> = {
    AC: 'America/Rio_Branco',
    AM: 'America/Manaus',
    RR: 'America/Boa_Vista',
    RO: 'America/Porto_Velho',
    MT: 'America/Cuiaba',
    MS: 'America/Campo_Grande',
  };
  return fusos[uf] ?? 'America/Sao_Paulo';
}

const numero = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** A loja no formato da resposta. */
export function lojaNoMapa(l: LinhaDaLoja): StoreLocation {
  const temEndereco = l.address_postal_code !== null && l.address_city !== null && l.address_state !== null && l.ibge_city_code !== null;
  const lat = numero(l.latitude);
  const lng = numero(l.longitude);
  return {
    unit_id: l.id,
    unit_name: l.name,
    address: temEndereco
      ? {
          postal_code: l.address_postal_code!,
          street: l.address_street,
          number: l.address_number,
          complement: l.address_complement,
          district: l.address_district,
          city: l.address_city!,
          state: l.address_state!,
          ibge_city_code: l.ibge_city_code!,
        }
      : null,
    coordinates: lat !== null && lng !== null && l.location_precision ? { latitude: lat, longitude: lng, precision: l.location_precision } : null,
    source: l.location_source,
    delivery_radius_km: numero(l.delivery_radius_km),
    delivery_areas: Array.isArray(l.delivery_areas) ? l.delivery_areas.filter((a): a is string => typeof a === 'string') : [],
    set_by: l.user_id ? { id: l.user_id, name: l.user_name ?? '' } : null,
    set_at: l.location_set_at ? (l.location_set_at instanceof Date ? l.location_set_at : new Date(l.location_set_at)).toISOString() : null,
    created_here: l.created_here === true,
    google_profile_account_id: l.google_profile_account_id,
  };
}
