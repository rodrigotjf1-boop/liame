// Os lugares do Google Ads para "quem vê por bairros" (plano da região, R9; D-RG-87). O Google tem uma lista de lugares
// (`geoTargetConstants`), e a campanha pode valer para um bairro que está nela. Para achar o bairro certo, nunca se
// compara o texto do nome canônico (vem em inglês e sem acento, e "Rio de Janeiro" é a cidade e o estado): primeiro a
// constante do ESTADO da loja (`State`, no Brasil), depois a da CIDADE cujo pai é esse estado (`City`), e por fim o bairro
// cujo pai é essa cidade (`Neighborhood`). O que não fecha assim vai por um círculo no centro do bairro (como na Meta).
// A consulta é a `geoTargetConstants:suggest` (leitura; não é de conta de cliente). Partes puras: sem rede e sem banco.

/** Um lugar sugerido pelo Google, só com o que o Liame usa. */
export type LugarNoGoogle = {
  /** `geoTargetConstants/NNN`. */
  recurso: string;
  nome: string;
  nomeCanonico: string;
  tipo: string;
  pais: string;
  /** O `geoTargetConstants/NNN` do lugar de cima, quando o Google diz. */
  pai: string | null;
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

/** Os lugares da resposta da `suggest`; o que vem fora do formato fica de fora. */
export function lugaresDaResposta(corpo: unknown): LugarNoGoogle[] {
  const sugestoes = (corpo as { geoTargetConstantSuggestions?: unknown } | null)?.geoTargetConstantSuggestions;
  if (!Array.isArray(sugestoes)) return [];
  const saida: LugarNoGoogle[] = [];
  for (const s of sugestoes as Array<{ searchTerm?: unknown; geoTargetConstant?: Record<string, unknown> } | null>) {
    const g = s?.geoTargetConstant;
    const recurso = texto(g?.resourceName);
    if (!g || !RECURSO.test(recurso)) continue;
    const pai = texto(g.parentGeoTarget);
    saida.push({
      recurso,
      nome: texto(g.name),
      nomeCanonico: texto(g.canonicalName),
      tipo: texto(g.targetType),
      pais: texto(g.countryCode),
      pai: RECURSO.test(pai) ? pai : null,
      situacao: texto(g.status),
      buscado: texto(s?.searchTerm),
    });
  }
  return saida;
}

/**
 * O lugar de um tipo cujo pai é o lugar dado (o estado não tem pai a conferir: basta ser do Brasil). Só um: com dois que
 * fecham, ou nenhum, volta nulo (na dúvida, o bairro vai por círculo). Só os ativos (`ENABLED`).
 */
export function lugarDoTipo(lugares: readonly LugarNoGoogle[], tipo: 'State' | 'City' | 'Neighborhood', pai: string | null): LugarNoGoogle | null {
  const unicos = new Map<string, LugarNoGoogle>();
  for (const l of lugares) {
    if (l.tipo !== tipo || l.pais !== 'BR' || l.situacao !== 'ENABLED') continue;
    if (tipo !== 'State' && (!pai || l.pai !== pai)) continue;
    unicos.set(l.recurso, l);
  }
  return unicos.size === 1 ? [...unicos.values()][0]! : null;
}
