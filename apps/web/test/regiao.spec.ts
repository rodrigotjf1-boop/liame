import type { RegionOverviewResponse, StoreLocation, StoreLocationsResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LinhaDaRegiaoVista } from '@/components/regiao/linha-da-regiao';
import { LojaNoMapa } from '@/components/regiao/loja-no-mapa';
import {
  cepComHifen,
  cepDigitado,
  erroDeSalvar,
  juntarArea,
  km,
  linhaDaRua,
  linhaDeMinhaMarca,
  lojaDoPerfil,
  nomeDaLojaNova,
  raioNaRegua,
  seloDasLojas,
  semNumero,
  textoDoPonto,
} from '@/components/regiao/textos';
import {
  comparaDensidade,
  fonteDaRendaDoBairro,
  fonteDoNumero,
  fraseDaRenda,
  frescor,
  grande,
  inteiro,
  fontesQueFalharam,
  mesAno,
  movimentoDaContagem,
  pct,
  reais,
  situacaoEmPalavras,
  tiposDaContagem,
  trimestre,
  umaCasa,
  variacao,
} from '@/components/regiao/textos-da-regiao';
import { temModos, tituloDa } from '@/components/shell/navegacao';
import { ModoProvider } from '@/lib/modo';

// Minha marca › Região (mockups/prototipo-regiao.html, P40 aprovado em 11/11/2026; plano da região, R1, parte 2): a loja
// no mapa, a gaveta e a linha da parte Região de Minha marca. Os números e o ponto são os do servidor; aqui, o que a tela
// escreve com eles.

const LOJA: StoreLocation = {
  unit_id: '0190d2b0-0000-7000-8000-000000000001',
  unit_name: 'Mister Burgers Tijuca',
  address: { postal_code: '20520054', street: 'Rua Conde de Bonfim', number: '450', complement: 'Loja 2', district: 'Tijuca', city: 'Rio de Janeiro', state: 'RJ', ibge_city_code: '3304557' },
  coordinates: { latitude: -22.9244, longitude: -43.2327, precision: 'endereco' },
  source: 'perfil_google',
  delivery_radius_km: 3.5,
  delivery_areas: ['Tijuca', 'Maracanã'],
  set_by: { id: '0190d2b0-0000-7000-8000-000000000009', name: 'Rodrigo' },
  set_at: '2026-11-11T14:06:00.000Z',
  created_here: false,
  google_profile_account_id: '0190d2b0-0000-7000-8000-000000000101',
};

const SEM_ENDERECO: StoreLocation = { ...LOJA, unit_id: '0190d2b0-0000-7000-8000-000000000002', unit_name: 'Mister Burgers Penha', address: null, coordinates: null, source: null, delivery_radius_km: null, delivery_areas: [], set_by: null, set_at: null, google_profile_account_id: null };

function resposta(extra: Partial<StoreLocationsResponse> = {}): StoreLocationsResponse {
  return {
    brand_id: '0190d2b0-0000-7000-8000-000000000050',
    availability: { status: 'disponivel' },
    stores: [LOJA, SEM_ENDERECO],
    google_profiles: [
      { account_id: '0190d2b0-0000-7000-8000-000000000101', name: 'Mister Burgers Tijuca', unit_id: LOJA.unit_id },
      { account_id: '0190d2b0-0000-7000-8000-000000000102', name: 'Mister Burgers Penha', unit_id: null },
    ],
    can_edit: true,
    has_regem: true,
    can_create_store: false,
    attribution: '© OpenStreetMap',
    generated_at: '2026-11-11T14:06:00.000Z',
    ...extra,
  };
}

const html = (loja: StoreLocation, { podeEditar = true, temPerfil = true, modo = 'lite' as 'lite' | 'pro' } = {}) =>
  renderToStaticMarkup(createElement(ModoProvider, { inicial: modo, children: createElement(LojaNoMapa, { loja, podeEditar, temPerfil, agora: new Date('2026-11-11T15:00:00Z'), abrir: () => {} }) }));

describe('os textos da região', () => {
  it('o raio, o CEP e o "s/n"', () => {
    expect([km(3), km(3.5), km(15)]).toEqual(['3 km', '3,5 km', '15 km']);
    expect([raioNaRegua(3.3), raioNaRegua(0), raioNaRegua(20), raioNaRegua(4.75)]).toEqual([3.5, 1, 15, 5]);
    expect([cepComHifen('20520054'), cepDigitado('20520-054'), cepDigitado('2052-0054x'), cepDigitado('2052005')]).toEqual(['20520-054', '20520054', null, null]);
    expect(['s/n', 'S/N', ' sn ', 'sem número'].every(semNumero)).toBe(true);
    expect(semNumero('450')).toBe(false);
  });

  it('as áreas: sem repetir, sem vazia e até 20', () => {
    expect(juntarArea(['Tijuca'], '  Vila   Isabel ')).toEqual({ areas: ['Tijuca', 'Vila Isabel'], recusa: null });
    expect(juntarArea(['Tijuca'], 'tijuca').recusa).toBe('tijuca já está na lista.');
    expect(juntarArea(['Tijuca'], '  ').recusa).toBe('Digite o nome do bairro.');
    const vinte = Array.from({ length: 20 }, (_, i) => `Bairro ${i}`);
    expect(juntarArea(vinte, 'Mais um').recusa).toMatch(/No máximo 20/);
  });

  it('o nome da loja nova (D-RG-17): o do perfil ou "Loja" e o bairro', () => {
    expect(nomeDaLojaNova('Casa Brasa', 'Tijuca')).toBe('Casa Brasa');
    expect(nomeDaLojaNova(null, 'Tijuca')).toBe('Loja Tijuca');
    expect(nomeDaLojaNova(null, null)).toBe('');
  });

  it('o ponto em palavras (D-RG-14) e a rua com o complemento', () => {
    expect(textoDoPonto(LOJA)).toEqual({ tipo: 'endereco', texto: 'Achado pelo endereço.' });
    expect(textoDoPonto({ ...LOJA, coordinates: { ...LOJA.coordinates!, precision: 'bairro' } }).texto).toBe('No centro da Tijuca: o mapa não achou o número 450.');
    expect(textoDoPonto({ ...LOJA, address: { ...LOJA.address!, number: 's/n' }, coordinates: { ...LOJA.coordinates!, precision: 'bairro' } }).texto).toBe('No centro da Tijuca: o mapa não achou o número.');
    expect(textoDoPonto({ ...LOJA, coordinates: null }).tipo).toBe('sem');
    expect(linhaDaRua(LOJA.address!)).toBe('Rua Conde de Bonfim, 450 · Loja 2');
  });

  it('o selo das lojas, a linha de Minha marca (D-RG-11) e o perfil de outra loja (D-RG-16)', () => {
    expect(seloDasLojas([LOJA, SEM_ENDERECO])).toEqual({ texto: '1 de 2 lojas no mapa', completo: false });
    expect(seloDasLojas([])).toBeNull();
    expect(linhaDeMinhaMarca(resposta())).toBe('1 loja no mapa: Mister Burgers Tijuca, até 3,5 km');
    expect(linhaDeMinhaMarca(resposta({ stores: [SEM_ENDERECO] }))).toBe('Nenhuma loja no mapa ainda');
    expect(linhaDeMinhaMarca(resposta({ availability: { status: 'desligado_pela_liame' } }))).toBeNull();
    const r = resposta();
    expect(lojaDoPerfil(r, '0190d2b0-0000-7000-8000-000000000101', SEM_ENDERECO.unit_id)).toBe('Mister Burgers Tijuca');
    expect(lojaDoPerfil(r, '0190d2b0-0000-7000-8000-000000000101', LOJA.unit_id)).toBeNull();
    expect(lojaDoPerfil(r, '0190d2b0-0000-7000-8000-000000000102', LOJA.unit_id)).toBeNull();
  });

  it('a recusa de salvar diz o que fazer, pelo código do servidor', () => {
    expect(erroDeSalvar('loja-com-este-nome', 'x')).toMatch(/Escolha outro nome/);
    expect(erroDeSalvar('perfil-de-outra-loja', 'x')).toMatch(/Cada perfil vale para uma loja/);
    expect(erroDeSalvar('outro', 'o padrão')).toBe('o padrão');
  });
});

describe('a loja no mapa (o cartão)', () => {
  it('com endereço: a origem, o ponto, o raio, as áreas e a prévia; o Pro mostra a coordenada e o código', () => {
    const lite = html(LOJA);
    expect(lite).toContain('Do seu Perfil da Empresa no Google');
    expect(lite).toContain('Rua Conde de Bonfim, 450 · Loja 2');
    expect(lite).toContain('Achado pelo endereço.');
    expect(lite).toContain('3,5 km');
    expect(lite).toContain('Maracanã');
    expect(lite).toContain('Ver detalhes');
    expect(lite).toContain('rg-anel-exp');
    expect(lite).toContain('CEP <span class="num">20520-054</span>');
    // No Lite, o bloco do Pro existe (o "Ver detalhes" aponta para ele), escondido.
    expect(lite).toMatch(/<div id="[^"]*-pro" hidden="">/);
    const pro = html(LOJA, { modo: 'pro' });
    expect(pro).toMatch(/<div id="[^"]*-pro">/);
    expect(pro).toContain('3304557');
    expect(pro).toContain('-22,9244; -43,2327');
    expect(pro).not.toContain('Ver detalhes');
  });

  it('o ponto no centro do bairro avisa para ajustar; quem só vê não ganha botão', () => {
    const noBairro = html({ ...LOJA, coordinates: { ...LOJA.coordinates!, precision: 'bairro' } });
    expect(noBairro).toContain('O ponto está no centro do bairro, não na loja');
    expect(noBairro).toContain('Ajustar o endereço');
    const leitura = html(LOJA, { podeEditar: false });
    expect(leitura).not.toContain('Editar<span class="sr-only">');
    expect(html(LOJA)).toContain('Editar<span class="sr-only">');
    expect(leitura).toContain('Para corrigir, fale com o Dono ou um Administrador.');
  });

  it('sem endereço: o convite, pelo Perfil do Google ou pelo CEP', () => {
    expect(html(SEM_ENDERECO)).toContain('Usar o endereço do Perfil do Google');
    const semPerfil = html(SEM_ENDERECO, { temPerfil: false });
    expect(semPerfil).toContain('Informar pelo CEP');
    expect(semPerfil).toContain('Ligar o Perfil do Google');
    expect(html(SEM_ENDERECO, { podeEditar: false })).toContain('Só o Dono e os Administradores põem a loja no mapa.');
  });

  it('a loja criada no Liame leva o selo (D-RG-17)', () => {
    expect(html({ ...LOJA, created_here: true, source: 'cep' })).toContain('Loja criada aqui');
  });
});

describe('Minha marca › Região', () => {
  it('a parte Região ganha a linha e o botão (só com a função liberada)', () => {
    const marca = '0190d2b0-0000-7000-8000-000000000050';
    const linha = renderToStaticMarkup(createElement(LinhaDaRegiaoVista, { dados: resposta(), brandId: marca }));
    expect(linha).toContain('1 loja no mapa: Mister Burgers Tijuca, até 3,5 km');
    expect(linha).toContain(`/marca/regiao?marca=${marca}`);
    expect(renderToStaticMarkup(createElement(LinhaDaRegiaoVista, { dados: resposta({ availability: { status: 'desligado_pela_liame' } }), brandId: marca }))).toBe('');
  });

  it('a subtela tem título na trilha e os modos Lite e Pro (D-RG-19), com a permissão de ver Minha marca', () => {
    expect(tituloDa('/marca/regiao')).toBe('Minha marca · Região');
    expect(temModos('/marca/regiao', (p) => p === 'dossie.ver')).toBe(true);
    expect(temModos('/marca/regiao', () => false)).toBe(false);
    expect(temModos('/marca', (p) => p === 'dossie.ver')).toBe(false);
  });
});

describe('Sua região (R2, parte 2)', () => {
  const retrato: RegionOverviewResponse = {
    brand_id: '0190d2b0-0000-7000-8000-000000000050',
    unit_id: LOJA.unit_id,
    availability: { status: 'disponivel' },
    status: 'pronto',
    district_status: 'achado',
    district: {
      code: '3304557030',
      name: 'Tijuca',
      population: 142909,
      area_km2: 9.9413,
      density: 14375.3,
      head_income_median: 5500,
      head_income_mean: 8056.52,
      head_income_median_today: 6601,
      head_income_mean_today: 9669,
      income_rank: { above_pct: 87, districts: 162, typical_median: 2000 },
    },
    ipca: { from: '2022-07', to: '2026-09', factor: 1.2002 },
    delivery_area: { matched: 2, total: 3, population: 167909 },
    city: {
      code: '3304557',
      name: 'Rio de Janeiro',
      state: 'RJ',
      population: { value: 6211223, period: '2022', source: 'ibge_4714' },
      density: { value: 5174.6, period: '2022', source: 'ibge_4714' },
      population_estimate: { value: 6731133, period: '2026', source: 'ibge_6579' },
      income_pc_median: { value: 1212, period: '2022', source: 'ibge_10295' },
      income_pc_mean: { value: 2515.32, period: '2022', source: 'ibge_10295' },
      restaurants: { value: 16242, period: '2024', source: 'ibge_9528' },
      restaurants_per_10k: 24.1,
      rm_code: '3301',
      income_pc_uf: { value: 2732, period: '2025', source: 'ibge_7531' },
      income_pc_rm: { value: 2972, period: '2025', source: 'ibge_7395' },
      work_income_capital: { value: 5692, period: '2026-06', quarters: 4, source: 'ibge_6472' },
      pix: { period: '2026-10', payers: 5109806, value: 44244787453.94, payers_prev_year: 4900000, value_prev_year: 40000000000 },
      food_away_inflation: { scope: 'rm', period: '2026-09', away: 4.31, meal: 2.66, snack: 7.75, brasil: { away: 5.79, meal: 5.01, snack: 7.59 } },
    },
    food_places: {
      period: '2026-10',
      since: '2025-10',
      city: { active: 30000, restaurant: 12000, snack: 9000, bar: 6000, home: 3000, opened_12m: 4000, closed_12m: 2500, per_10k: 44.6, district_coverage_pct: 70 },
      district: { active: 800, restaurant: 300, snack: 250, bar: 200, home: 50, opened_12m: 90, closed_12m: 1, per_km2: 80.5 },
      postal: { active: 1, restaurant: 1, snack: 0, bar: 0, home: 0, opened_12m: 0, closed_12m: 0, prefix: '20520' },
      delivery_area: null,
    },
    sources: [
      { source: 'ibge_censo_bairro', status: 'em_dia', read_at: '2026-11-11T09:10:00.000Z', next_try_at: null },
      { source: 'ibge_9528', status: 'falhou', read_at: null, next_try_at: '2026-11-11T18:00:00.000Z' },
      { source: 'receita_cnpj', status: 'falhou', read_at: null, next_try_at: '2026-11-11T18:00:00.000Z' },
    ],
    generated_at: '2026-11-11T15:00:00.000Z',
  };

  it('os restaurantes do CNPJ (parte 4) em palavras; a falha da Receita fica fora da faixa do IBGE', () => {
    const fp = retrato.food_places!;
    expect(tiposDaContagem(fp.district!)).toBe('300 restaurantes, 250 lanchonetes, 200 bares e 50 de comida para casa');
    expect(tiposDaContagem(fp.postal!)).toBe('1 restaurante');
    expect(tiposDaContagem({ ...fp.postal!, restaurant: 0 })).toBe('nenhum ativo');
    expect(movimentoDaContagem(fp.district!, fp.since)).toBe('90 abriram e 1 deu baixa no CNPJ desde out/2025');
    expect(fontesQueFalharam(retrato).map((f) => f.source)).toEqual(['ibge_9528']);
  });

  it('os números como a tela escreve: inteiro, uma casa e reais sem centavos quando redondo', () => {
    expect([inteiro(142909), umaCasa(5174.6), umaCasa(24), reais(5500), reais(8056.52)]).toEqual(['142.909', '5.174,6', '24', 'R$ 5.500', 'R$ 8.056,52']);
  });

  it('a densidade comparada à do município, a renda com a posição entre os bairros (valor de 2022) e a fonte com o período', () => {
    // Sem preposição colada no nome do lugar ("no Rio", "em São Paulo", "na Tijuca", "no Grajaú" variam).
    expect(comparaDensidade(14375.3, 5174.6, 'Rio de Janeiro')).toBe('2,8 vezes a densidade do município (Rio de Janeiro: 5.174,6 por km²)');
    expect(comparaDensidade(3000, 5174.6, 'Rio de Janeiro')).toMatch(/^menos denso que a média do município/);
    // Com o IPCA lido, a renda (e o bairro típico) a preços do mês mais novo; sem ele, "valor de 2022, sem correção" (D-RG-20).
    expect(fraseDaRenda(retrato)).toBe('é a renda mediana do responsável pelo domicílio no bairro Tijuca, a preços de set/2026. O bairro típico do município (Rio de Janeiro) tem R$ 2.400: este fica acima de 87% dos 162 bairros.');
    expect(fonteDaRendaDoBairro(retrato)).toBe('IBGE · Censo 2022, corrigido pelo IPCA até set/2026');
    const semIpca = { ...retrato, ipca: null, district: { ...retrato.district!, head_income_median_today: null, head_income_mean_today: null } };
    expect(fraseDaRenda(semIpca)).toBe('é a renda mediana do responsável pelo domicílio no bairro Tijuca. O bairro típico do município (Rio de Janeiro) tem R$ 2.000: este fica acima de 87% dos 162 bairros.');
    expect(fonteDaRendaDoBairro(semIpca)).toBe('IBGE · Censo 2022 · valor de 2022, sem correção');
    expect([mesAno('2026-09'), trimestre('2026-06'), grande(5109806), grande(44244787453.94), variacao(5109806, 4900000), variacao(1, null), pct(4.31)]).toEqual([
      'set/2026',
      '2º tri/2026',
      '5,1 milhões',
      '44,2 bilhões',
      '+4,3%',
      null,
      '4,31%',
    ]);
    expect(fraseDaRenda({ ...retrato, district: null })).toBeNull();
    expect(fonteDoNumero(retrato.city!.restaurants!)).toBe('IBGE · Cadastro Central de Empresas, 2024');
    expect(fonteDoNumero(retrato.city!.population!)).toBe('IBGE · Censo 2022');
  });

  it('o frescor e a situação de cada fonte em palavras', () => {
    expect(frescor(retrato)).toBe('Lida em 11/11/2026');
    expect(frescor({ ...retrato, status: 'parcial' })).toBe('Lida em 11/11/2026 · uma fonte falhou');
    expect(frescor({ ...retrato, status: 'lendo' })).toBe('Lendo agora');
    expect(situacaoEmPalavras(retrato.sources[0]!)).toEqual({ texto: 'Em dia', tipo: 'ok' });
    expect(situacaoEmPalavras(retrato.sources[1]!).tipo).toBe('falhou');
    expect(situacaoEmPalavras(retrato.sources[1]!).texto).toMatch(/^Não respondeu · de novo às \d{2}:\d{2}$/);
  });
});
