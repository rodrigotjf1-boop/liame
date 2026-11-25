// Os lugares do Google Ads para "quem vê por bairros" (plano da região, R9; D-RG-87). O Google tem uma lista de lugares
// (`geoTargetConstants`), e a campanha pode valer para um bairro que está nela. A consulta é a `geoTargetConstants:suggest`
// (leitura; não é de conta de cliente). Partes puras: sem rede e sem banco.
//
// Como o bairro é decidido (D-RG-103, depois da prova de 25/11/2026 na conta real): pela CADEIA do próprio bairro, a lista
// dos lugares acima dele que a `suggest` devolve junto (`geoTargetConstantParents`). Na prova, o Google não mandou o pai
// direto (`parentGeoTarget`) de nenhuma cidade e devolveu DUAS "City" Rio de Janeiro (1001655 e 9198038): escolher uma
// cidade antes e exigir o bairro filho dela deixava todo bairro de fora. O bairro passa quando tem o nome buscado, é do
// Brasil, está ativo e a cadeia dele traz o estado da loja e um lugar com o nome da cidade da loja (City ou Municipality,
// qualquer um dos dois). Sem a cadeia, o plano B é o nome canônico do bairro (o nome da cidade e o do estado nas partes
// depois do primeiro): é frágil, e quem chama diz qual dos dois caminhos decidiu. Mais de um bairro que passa, ou
// nenhum: nulo, e o bairro vai por um círculo no centro dele (como na Meta). Nunca se compara só o texto do nome: "Rio de
// Janeiro" é a cidade e o estado, e "Penha" existe em Santa Catarina e em São Paulo.

/** Um lugar da cadeia de um lugar sugerido (os de cima dele), só com o que o Liame usa. */
export type LugarDaCadeia = {
  /** `geoTargetConstants/NNN`. */
  recurso: string;
  nome: string;
  nomeCanonico: string;
  tipo: string;
};

/** Um lugar sugerido pelo Google, só com o que o Liame usa. */
export type LugarNoGoogle = {
  /** `geoTargetConstants/NNN`. */
  recurso: string;
  nome: string;
  nomeCanonico: string;
  tipo: string;
  pais: string;
  /** O `geoTargetConstants/NNN` do lugar de cima, quando o Google diz (na prova de 25/11/2026, não disse). */
  pai: string | null;
  /** Os lugares acima dele (`geoTargetConstantParents`), na ordem em que o Google mandou; vazia quando não mandou. */
  cadeia: LugarDaCadeia[];
  situacao: string;
  /** O texto que foi buscado. */
  buscado: string;
};

/** Os estados do Brasil por extenso, para buscar a constante do estado pela sigla da loja. */
export const ESTADOS_DO_BRASIL: Readonly<Record<string, string>> = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal',
  ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais',
  PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte',
  RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

/** O corpo da `geoTargetConstants:suggest`: os nomes em português, no Brasil. */
export function consultaDeLugares(nomes: readonly string[]): { locale: string; countryCode: string; locationNames: { names: string[] } } {
  return { locale: 'pt', countryCode: 'BR', locationNames: { names: nomes.map((n) => n.replace(/\s+/g, ' ').trim()).filter(Boolean) } };
}

const texto = (v: unknown): string => (typeof v === 'string' ? v : '');
const RECURSO = /^geoTargetConstants\/\d+$/;
/** Os tipos de lugar que contam como a cidade da loja na cadeia do bairro. */
const TIPOS_DE_CIDADE = new Set(['City', 'Municipality']);

/** Para comparar nomes: sem acento, sem caixa e com os espaços de um só. */
export function nomeComparavel(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Um lugar da cadeia como a `suggest` manda (um `GeoTargetConstant` inteiro); o que vem fora do formato fica de fora. */
function lugarDaCadeia(g: unknown): LugarDaCadeia | null {
  const o = g as Record<string, unknown> | null;
  const recurso = texto(o?.resourceName);
  if (!o || !RECURSO.test(recurso)) return null;
  return { recurso, nome: texto(o.name), nomeCanonico: texto(o.canonicalName), tipo: texto(o.targetType) };
}

/** Os lugares da resposta da `suggest`; o que vem fora do formato fica de fora. */
export function lugaresDaResposta(corpo: unknown): LugarNoGoogle[] {
  const sugestoes = (corpo as { geoTargetConstantSuggestions?: unknown } | null)?.geoTargetConstantSuggestions;
  if (!Array.isArray(sugestoes)) return [];
  const saida: LugarNoGoogle[] = [];
  for (const s of sugestoes as Array<{ searchTerm?: unknown; geoTargetConstant?: Record<string, unknown>; geoTargetConstantParents?: unknown } | null>) {
    const g = s?.geoTargetConstant;
    const recurso = texto(g?.resourceName);
    if (!g || !RECURSO.test(recurso)) continue;
    const pai = texto(g.parentGeoTarget);
    const pais = Array.isArray(s?.geoTargetConstantParents) ? s.geoTargetConstantParents : [];
    saida.push({
      recurso,
      nome: texto(g.name),
      nomeCanonico: texto(g.canonicalName),
      tipo: texto(g.targetType),
      pais: texto(g.countryCode),
      pai: RECURSO.test(pai) ? pai : null,
      cadeia: pais.map(lugarDaCadeia).filter((l): l is LugarDaCadeia => l !== null),
      situacao: texto(g.status),
      buscado: texto(s?.searchTerm),
    });
  }
  return saida;
}

const doBrasilEAtivo = (l: LugarNoGoogle) => l.pais === 'BR' && l.situacao === 'ENABLED';

/**
 * O lugar de um tipo cujo pai é o lugar dado (o estado não tem pai a conferir: basta ser do Brasil). Só um: com dois que
 * fecham, ou nenhum, volta nulo. Só os ativos (`ENABLED`). Serve ao estado; a cidade e o bairro têm as funções abaixo.
 */
export function lugarDoTipo(lugares: readonly LugarNoGoogle[], tipo: 'State' | 'City' | 'Neighborhood', pai: string | null): LugarNoGoogle | null {
  const unicos = new Map<string, LugarNoGoogle>();
  for (const l of lugares) {
    if (l.tipo !== tipo || !doBrasilEAtivo(l)) continue;
    if (tipo !== 'State' && (!pai || l.pai !== pai)) continue;
    unicos.set(l.recurso, l);
  }
  return unicos.size === 1 ? [...unicos.values()][0]! : null;
}

/** A loja onde os bairros ficam: a cidade, o estado por extenso e, quando o passo do estado achou, a constante dele. */
export type LojaNoMapa = { cidade: string; nomeDoEstado: string; estado: LugarNoGoogle | null };

/** O lugar da cadeia é o estado da loja: pela constante achada ou, sem ela, um `State` com o nome do estado. */
function ehOEstado(l: LugarDaCadeia, loja: LojaNoMapa): boolean {
  if (loja.estado) return l.recurso === loja.estado.recurso;
  return l.tipo === 'State' && nomeComparavel(l.nome) === nomeComparavel(loja.nomeDoEstado);
}

/** O lugar da cadeia é a cidade da loja: City ou Municipality com o nome dela. */
const ehACidade = (l: LugarDaCadeia, loja: LojaNoMapa) => TIPOS_DE_CIDADE.has(l.tipo) && nomeComparavel(l.nome) === nomeComparavel(loja.cidade);

/**
 * As cidades com o nome da cidade da loja (City ou Municipality, do Brasil e ativas). Do estado da loja, quando dá para
 * saber (pelo pai, pela cadeia ou pelo nome canônico); sem nada disso, ficam (é só para a linha da prova: o bairro não
 * depende delas). Na prova de 25/11/2026 vieram duas "City" Rio de Janeiro.
 */
export function cidadesDaLoja(lugares: readonly LugarNoGoogle[], loja: LojaNoMapa): LugarNoGoogle[] {
  const unicos = new Map<string, LugarNoGoogle>();
  for (const l of lugares) {
    if (!TIPOS_DE_CIDADE.has(l.tipo) || !doBrasilEAtivo(l) || nomeComparavel(l.nome) !== nomeComparavel(loja.cidade)) continue;
    const sabeOEstado = l.pai !== null || l.cadeia.length > 0;
    const doEstado = l.cadeia.some((c) => ehOEstado(c, loja)) || (loja.estado !== null && l.pai === loja.estado.recurso);
    if (sabeOEstado && !doEstado) continue;
    unicos.set(l.recurso, l);
  }
  return [...unicos.values()];
}

/** O bairro achado no Google e por qual caminho ele foi decidido. */
export type BairroNoGoogle = { lugar: LugarNoGoogle; caminho: 'pela cadeia' | 'pelo nome canônico' };

/** O plano B, sem a cadeia: o nome da cidade e o do estado nas partes do nome canônico depois da primeira. */
function peloNomeCanonico(l: LugarNoGoogle, loja: LojaNoMapa): boolean {
  const resto = l.nomeCanonico.split(',').slice(1).map(nomeComparavel);
  const estado = nomeComparavel(loja.nomeDoEstado);
  return resto.includes(nomeComparavel(loja.cidade)) && resto.some((p) => p === estado || p === `state of ${estado}`);
}

/**
 * O bairro da loja entre os lugares sugeridos (D-RG-103): um `Neighborhood` com o nome buscado, do Brasil e ativo, cuja
 * cadeia traz o estado e a cidade da loja (ou, sem cadeia, cujo nome canônico os traz). Só um: com dois que passam, ou
 * nenhum, volta nulo (na dúvida, o bairro vai por círculo).
 */
export function bairroDaLoja(lugares: readonly LugarNoGoogle[], bairro: string, loja: LojaNoMapa): BairroNoGoogle | null {
  const unicos = new Map<string, BairroNoGoogle>();
  for (const l of lugares) {
    if (l.tipo !== 'Neighborhood' || !doBrasilEAtivo(l) || nomeComparavel(l.nome) !== nomeComparavel(bairro)) continue;
    if (l.cadeia.length) {
      if (l.cadeia.some((c) => ehOEstado(c, loja)) && l.cadeia.some((c) => ehACidade(c, loja))) unicos.set(l.recurso, { lugar: l, caminho: 'pela cadeia' });
    } else if (peloNomeCanonico(l, loja)) {
      unicos.set(l.recurso, { lugar: l, caminho: 'pelo nome canônico' });
    }
  }
  return unicos.size === 1 ? [...unicos.values()][0]! : null;
}
