import { describe, expect, it } from 'vitest';
import { cliquesPorBairro, type EntradaDosCliques } from '../src/regiao/cliques-por-bairro.js';

// Os cliques por bairro e de fora da área de entrega (plano da região, R4, os bairros; D-RG-44 a D-RG-47): a conta pura,
// com os tipos de lugar que o Google devolveu na medição de 13/11/2026 (Neighborhood, District, Postal Code, City…).

const base = (o: Partial<EntradaDosCliques> = {}): EntradaDosCliques => ({
  locais: [
    { tipo: 'City', nome: 'Rio de Janeiro', cliques: 328 },
    { tipo: 'Neighborhood', nome: 'Tijuca', cliques: 21 },
    { tipo: 'Neighborhood', nome: 'Cordovil', cliques: 17 },
    { tipo: 'District', nome: 'Vila Isabel', cliques: 14 },
    { tipo: 'District', nome: 'Praca da Bandeira', cliques: 10 },
    { tipo: 'Postal Code', nome: '20550', cliques: 9 },
    { tipo: 'District', nome: 'Mare', cliques: 8 },
    { tipo: 'Postal Code', nome: '21941', cliques: 5 },
    // De outro município (o distrito não é bairro do Censo do Rio) e o CEP de fora do município: ficam fora da lista.
    { tipo: 'District', nome: 'Duque de Caxias', cliques: 6 },
    { tipo: 'Postal Code', nome: '25250', cliques: 3 },
    // O lugar ainda sem nome e o sem clique também.
    { tipo: null, nome: null, cliques: 4 },
    { tipo: 'Neighborhood', nome: 'Grajau', cliques: 0 },
  ],
  bairrosDoMunicipio: new Map([
    ['tijuca', 'Tijuca'],
    ['cordovil', 'Cordovil'],
    ['vila isabel', 'Vila Isabel'],
    ['praca da bandeira', 'Praça da Bandeira'],
    ['mare', 'Maré'],
    ['grajau', 'Grajaú'],
  ]),
  cepsDoMunicipio: new Set(['20550', '21941']),
  areas: ['Tijuca', 'Maracanã', 'Vila Isabel', 'Praça da Bandeira', 'Andaraí', 'Grajaú', 'Rio Comprido'],
  papeis: new Map([
    ['tijuca', 'manter' as const],
    ['vila isabel', 'atacar' as const],
    ['praca da bandeira', 'defender' as const],
  ]),
  cliquesDoGoogle: 528,
  cliquesDoMunicipio: 412,
  municipio: 'Rio de Janeiro',
  ...o,
});

describe('os cliques por bairro (D-RG-44 e D-RG-45)', () => {
  it('o bairro casa com o Censo do município (o nome do Censo, com acento), o CEP do município entra como CEP; o resto fica de fora', () => {
    const r = cliquesPorBairro(base());
    expect(r.districts).toEqual({
      city: 'Rio de Janeiro',
      city_clicks: 412,
      located: 84,
      few: false,
      items: [
        { name: 'Tijuca', kind: 'bairro', clicks: 21, in_delivery_area: true, role: 'manter' },
        { name: 'Cordovil', kind: 'bairro', clicks: 17, in_delivery_area: false, role: null },
        { name: 'Vila Isabel', kind: 'bairro', clicks: 14, in_delivery_area: true, role: 'atacar' },
        { name: 'Praça da Bandeira', kind: 'bairro', clicks: 10, in_delivery_area: true, role: 'defender' },
        { name: 'CEP 20550', kind: 'cep', clicks: 9, in_delivery_area: null, role: null },
        { name: 'Maré', kind: 'bairro', clicks: 8, in_delivery_area: false, role: null },
        { name: 'CEP 21941', kind: 'cep', clicks: 5, in_delivery_area: null, role: null },
      ],
    });
  });

  it('o mesmo bairro em dois tipos do Google (bairro e distrito) soma numa linha', () => {
    const r = cliquesPorBairro(base({ locais: [{ tipo: 'Neighborhood', nome: 'Tijuca', cliques: 5 }, { tipo: 'District', nome: 'Tijuca', cliques: 7 }] }));
    expect(r.districts.items).toEqual([{ name: 'Tijuca', kind: 'bairro', clicks: 12, in_delivery_area: true, role: 'manter' }]);
  });

  it('com menos de 10 cliques localizados, é pouco para tirar conclusão', () => {
    const r = cliquesPorBairro(base({ locais: [{ tipo: 'Neighborhood', nome: 'Tijuca', cliques: 2 }, { tipo: 'Postal Code', nome: '20550', cliques: 1 }] }));
    expect(r.districts).toMatchObject({ located: 3, few: true });
  });

  it('o bairro de fora da área nunca leva o papel dos pedidos', () => {
    const r = cliquesPorBairro(base({ locais: [{ tipo: 'Neighborhood', nome: 'Cordovil', cliques: 5 }], papeis: new Map([['cordovil', 'atacar' as const]]) }));
    expect(r.districts.items[0]).toMatchObject({ in_delivery_area: false, role: null });
  });
});

describe('os cliques de fora da área de entrega (D-RG-46)', () => {
  it('os de outros municípios e os de bairros localizados fora da área; o CEP e o clique só com a cidade não contam', () => {
    expect(cliquesPorBairro(base()).outside_area).toEqual({
      clicks: 141,
      pct: 27,
      other_cities: 116,
      outside_districts: 25,
      outside_names: ['Cordovil', 'Maré'],
      has_area: true,
    });
  });

  it('sem a área de entrega: só os outros municípios, e nenhum bairro é dito dentro ou fora', () => {
    const r = cliquesPorBairro(base({ areas: [] }));
    expect(r.outside_area).toEqual({ clicks: 116, pct: 22, other_cities: 116, outside_districts: 0, outside_names: [], has_area: false });
    expect(r.districts.items.every((i) => i.in_delivery_area === null)).toBe(true);
  });

  it('sem clique do Google, nada a dizer', () => {
    expect(cliquesPorBairro(base({ locais: [], cliquesDoGoogle: 0, cliquesDoMunicipio: 0 })).outside_area).toBeNull();
  });
});
