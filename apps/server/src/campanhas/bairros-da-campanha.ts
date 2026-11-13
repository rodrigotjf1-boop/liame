import { z } from 'zod';
import { nomeComparavel } from '../regiao/coordenada.js';

// Os bairros da campanha nova (plano da região, R6, parte 3; revisão R6-3 da P42 aprovada pelo dono em 13/11/2026,
// D-RG-53 a D-RG-57). Quem vê pode ser o raio em volta da loja ou de 1 a 20 bairros do município dela. Cada bairro vai
// para a Meta de um de dois jeitos (D-RG-54): o bairro da Meta, quando a busca de lugares dela acha o mesmo nome na
// mesma cidade (a chave dele em `geo_locations.neighborhoods`), ou um círculo no centro do bairro (o ponto pelo
// OpenStreetMap, como o da loja na R1), do tamanho do bairro no IBGE. A Meta aceita até 200 círculos de 1 a 80 km num
// conjunto (Basic Targeting, `custom_locations`). Partes puras: sem rede e sem banco.

/** Até 20 bairros por campanha (D-RG-53). */
export const MAXIMO_DE_BAIRROS = 20;
/** O círculo de um bairro: de 1 a 3 km. */
export const RAIO_MINIMO_DO_BAIRRO = 1;
export const RAIO_MAXIMO_DO_BAIRRO = 3;
/** A resposta da Meta sobre o bairro vale 30 dias (a busca dela muda pouco; depois, pergunta de novo). */
export const VALIDADE_DA_BUSCA_DA_META_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * O raio do círculo do bairro: o raio de um círculo com a área do bairro no IBGE, arredondado para cima de meio em meio
 * km, de 1 a 3 km (D-RG-54). Sem a área, 1 km.
 */
export function raioDoBairro(areaKm2: number | null): number {
  if (areaKm2 === null || !Number.isFinite(areaKm2) || areaKm2 <= 0) return RAIO_MINIMO_DO_BAIRRO;
  const r = Math.ceil(Math.sqrt(areaKm2 / Math.PI) * 2) / 2;
  return Math.min(RAIO_MAXIMO_DO_BAIRRO, Math.max(RAIO_MINIMO_DO_BAIRRO, r));
}

type Ponto = { latitude: number; longitude: number };

/** O ponto a partir da loja, em km para leste (`x`) e para norte (`y`), pela aproximação plana (boa para alguns km). */
export function deslocamentoEmKm(loja: Ponto, ponto: Ponto): { x: number; y: number } {
  const y = (ponto.latitude - loja.latitude) * 110.574;
  const x = (ponto.longitude - loja.longitude) * 111.32 * Math.cos((loja.latitude * Math.PI) / 180);
  return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
}

/** O tamanho máximo do texto de fora que vai para a comparação de nomes (V41: teto antes de qualquer regex). */
const TEXTO_MAXIMO = 200;

/**
 * A chave do bairro na resposta da busca de lugares da Meta (`GET /search?type=adgeolocation`): só quando um resultado
 * é do tipo bairro, com o mesmo nome e a mesma cidade (`primary_city`), sem diferença de acento e de maiúscula. Sem essa
 * certeza, nula: vai o círculo (D-RG-54). A Meta não documenta quais países têm bairro; quem não tem, não acha.
 */
export function bairroNaBuscaDaMeta(corpo: unknown, nome: string, cidade: string): string | null {
  const data = (corpo as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const alvo = nomeComparavel(nome);
  const daCidade = nomeComparavel(cidade);
  for (const item of data.slice(0, 50)) {
    const i = (item ?? {}) as Record<string, unknown>;
    if (i.type !== 'neighborhood') continue;
    const { key: chave, name: nomeDaMeta, primary_city: cidadeDaMeta } = i;
    if (typeof chave !== 'string' || typeof nomeDaMeta !== 'string' || typeof cidadeDaMeta !== 'string') continue;
    if (chave.length < 1 || chave.length > 60 || nomeDaMeta.length > TEXTO_MAXIMO || cidadeDaMeta.length > TEXTO_MAXIMO) continue;
    if (nomeComparavel(nomeDaMeta) === alvo && nomeComparavel(cidadeDaMeta) === daCidade) return chave;
  }
  return null;
}

/** Um bairro da campanha, como vai para o pedido (o que a pessoa aprova): o IBGE, a chave da Meta ou o círculo. */
export const BairroDaCampanha = z.object({
  codigo: z.string().length(10),
  nome: z.string().min(1).max(200),
  /** A chave do bairro na Meta; nula: vai o círculo no centro. */
  meta: z.string().min(1).max(60).nullable(),
  latitude: z.number().min(-34).max(6),
  longitude: z.number().min(-75).max(-28),
  raio_km: z.number().min(RAIO_MINIMO_DO_BAIRRO).max(RAIO_MAXIMO_DO_BAIRRO),
});
export type BairroDaCampanha = z.infer<typeof BairroDaCampanha>;

/** Os lugares do raio em volta da loja, em quilômetros (o padrão da Meta é milha). */
export function lugaresDoRaio(latitude: number, longitude: number, raioKm: number): Record<string, unknown> {
  return { custom_locations: [{ latitude, longitude, radius: raioKm, distance_unit: 'kilometer' }] };
}

/** Os lugares dos bairros: os da Meta pela chave (`neighborhoods`) e um círculo no centro de cada um dos outros. */
export function lugaresDosBairros(bairros: readonly BairroDaCampanha[]): Record<string, unknown> {
  const circulos = bairros
    .filter((b) => b.meta === null)
    .map((b) => ({ latitude: b.latitude, longitude: b.longitude, radius: b.raio_km, distance_unit: 'kilometer' }));
  const daMeta = bairros.filter((b) => b.meta !== null).map((b) => ({ key: b.meta }));
  return { ...(circulos.length ? { custom_locations: circulos } : {}), ...(daMeta.length ? { neighborhoods: daMeta } : {}) };
}

/** "3 bairros", "1 bairro". */
export const bairrosEscritos = (n: number): string => `${n} ${n === 1 ? 'bairro' : 'bairros'}`;
