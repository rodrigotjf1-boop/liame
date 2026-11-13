import { bairroDaArea, nomeComparavel } from './coordenada.js';
import { porcentoDe } from './midia-paga.js';

// Os cliques por bairro e de fora da área de entrega (plano da região, R4, os bairros; P40, revisão aprovada pelo dono
// em 13/11/2026, D-RG-44 a D-RG-47). Conta pura, sem banco: o retrato (`regiao.service.ts`) lê o local mais específico
// dos cliques do Google (`ad_local_daily`, a migration 0152) com o tipo do lugar, os bairros do Censo do município da
// loja, os CEPs do município e a área de entrega, e esta conta junta. Nada de pessoa: só somas por lugar.

/** Os tipos de lugar do Google que são bairro (o bairro, o distrito e afins). */
export const TIPOS_DE_BAIRRO = new Set(['Neighborhood', 'District', 'Sub-District', 'Borough', 'Quarter']);
/** O tipo do CEP no Google (no Brasil, os 5 primeiros dígitos). */
export const TIPO_DO_CEP = 'Postal Code';
/** Os bairros e CEPs que a visão por bairro mostra. */
export const LOCAIS_NA_SECAO = 12;
/** Abaixo disto, o Google localizou pouco para tirar conclusão (a tela diz). */
export const LOCALIZADOS_PARA_CONCLUIR = 10;
/** Quantos nomes de bairro de fora da área a frase cita. */
const NOMES_DE_FORA = 3;

/** Um lugar do Google com os cliques das 4 semanas (o tipo e o nome de `region_geo_target`; nulos se ainda sem nome). */
export type LocalDosCliques = { tipo: string | null; nome: string | null; cliques: number };
export type PapelDoBairro = 'atacar' | 'defender' | 'manter';

export type EntradaDosCliques = {
  locais: readonly LocalDosCliques[];
  /** Os bairros do Censo do município da loja, pela chave do nome (sem acento): o nome escrito pelo Censo. */
  bairrosDoMunicipio: ReadonlyMap<string, string>;
  /** Os CEPs (5 primeiros dígitos) que são do município da loja. */
  cepsDoMunicipio: ReadonlySet<string>;
  /** A área de entrega da loja (os nomes dos bairros). */
  areas: readonly string[];
  /** O papel de cada bairro em "Bairros para atacar e para defender", pela chave do nome. */
  papeis: ReadonlyMap<string, PapelDoBairro>;
  /** Os cliques do Google por cidade: todos e os do município da loja. */
  cliquesDoGoogle: number;
  cliquesDoMunicipio: number;
  municipio: string;
};

export type ItemDosCliques = { name: string; kind: 'bairro' | 'cep'; clicks: number; in_delivery_area: boolean | null; role: PapelDoBairro | null };

export type CliquesPorBairro = {
  districts: { city: string; city_clicks: number; located: number; few: boolean; items: ItemDosCliques[] };
  outside_area: { clicks: number; pct: number; other_cities: number; outside_districts: number; outside_names: string[]; has_area: boolean } | null;
};

const ehCep = (s: string): boolean => s.length === 5 && [...s].every((c) => c >= '0' && c <= '9');

/**
 * Os bairros e CEPs do município da loja de onde vieram os cliques, e a parte que veio de fora da área de entrega. O
 * bairro conta quando o nome casa com um bairro do Censo do município (o nome da tela é o do Censo, com acento); o CEP,
 * quando é do município; o resto (outros municípios, lugar sem nome) fica fora da lista. "Fora da área" é só o que se
 * sabe: os cliques de outros municípios e os de bairros localizados que não estão na área de entrega; o CEP e o clique
 * só com a cidade da loja nunca contam como fora (D-RG-46).
 */
export function cliquesPorBairro(e: EntradaDosCliques): CliquesPorBairro {
  const daEntrega = new Set(e.areas.map((a) => nomeComparavel(bairroDaArea(a))));
  const temArea = daEntrega.size > 0;
  const porChave = new Map<string, ItemDosCliques>();
  for (const l of e.locais) {
    if (!l.tipo || !l.nome || l.cliques <= 0) continue;
    let chave: string;
    let item: Omit<ItemDosCliques, 'clicks'>;
    if (TIPOS_DE_BAIRRO.has(l.tipo)) {
      const k = nomeComparavel(l.nome);
      const doCenso = e.bairrosDoMunicipio.get(k);
      if (!doCenso) continue;
      const dentro = temArea ? daEntrega.has(k) : null;
      chave = `b:${k}`;
      item = { name: doCenso, kind: 'bairro', in_delivery_area: dentro, role: dentro === false ? null : (e.papeis.get(k) ?? null) };
    } else if (l.tipo === TIPO_DO_CEP && ehCep(l.nome.trim()) && e.cepsDoMunicipio.has(l.nome.trim())) {
      chave = `c:${l.nome.trim()}`;
      item = { name: `CEP ${l.nome.trim()}`, kind: 'cep', in_delivery_area: null, role: null };
    } else {
      continue;
    }
    const antes = porChave.get(chave);
    porChave.set(chave, { ...item, clicks: (antes?.clicks ?? 0) + l.cliques });
  }
  const todos = [...porChave.values()].sort((a, b) => b.clicks - a.clicks || a.name.localeCompare(b.name, 'pt-BR'));
  const localizados = todos.reduce((t, i) => t + i.clicks, 0);
  const deFora = todos.filter((i) => i.kind === 'bairro' && i.in_delivery_area === false);
  const foraDosBairros = deFora.reduce((t, i) => t + i.clicks, 0);
  const outrosMunicipios = Math.max(0, e.cliquesDoGoogle - e.cliquesDoMunicipio);
  const fora = outrosMunicipios + foraDosBairros;
  return {
    districts: {
      city: e.municipio,
      city_clicks: e.cliquesDoMunicipio,
      located: localizados,
      few: localizados < LOCALIZADOS_PARA_CONCLUIR,
      items: todos.slice(0, LOCAIS_NA_SECAO),
    },
    outside_area:
      e.cliquesDoGoogle > 0
        ? {
            clicks: fora,
            pct: porcentoDe(fora, e.cliquesDoGoogle),
            other_cities: outrosMunicipios,
            outside_districts: foraDosBairros,
            outside_names: deFora.slice(0, NOMES_DE_FORA).map((i) => i.name),
            has_area: temArea,
          }
        : null,
  };
}
