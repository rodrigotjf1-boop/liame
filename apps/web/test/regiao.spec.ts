import type { StoreLocation, StoreLocationsResponse } from '@liame/contracts';
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
