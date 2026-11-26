import type { BrandPhoto, GoogleCampaignOptionsResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import {
  type CamposDoGoogle,
  conferirCampanhaGoogle,
  erroDoPedidoGoogle,
  fonteDosTemas,
  idDaCampanhaGoogle,
  motivoDaFotoPequena,
  motivoDosTemas,
  motivoDosTextos,
  recortesDaFoto,
  situacaoDaCampanhaGoogle,
  temasDaLoja,
  textosDaPeca,
} from '../src/components/criativos/campanha-google-textos';

// A campanha nova no Google (A5, Y9, parte 5b; P45): a gaveta confere o mesmo que o servidor antes de mandar (os textos
// nos tamanhos do Google, a foto grande o bastante para os recortes, a loja com o cardápio, a verba e o fim), a recusa do
// servidor vai para o campo certo, e os textos que a gaveta traz da peça.

const LOJA = '0190a000-0000-7000-8000-000000000001';
const OUTRA = '0190a000-0000-7000-8000-000000000002';
const opcoes = (o: Partial<GoogleCampaignOptionsResponse> = {}): GoogleCampaignOptionsResponse => ({
  enabled: true,
  blocks: [],
  ad_account: { name: 'Hamburgueria Ads', currency: 'BRL' },
  business_name: 'Mister Burgers',
  logo: { width: 512, height: 512 },
  units: [
    { id: LOJA, name: 'Loja Centro', address: 'Rua da Assembleia, 10, Centro', has_address: true, delivery_radius_km: 4, menu_available: true, menu_block: null },
    { id: OUTRA, name: 'Loja Tijuca', address: 'Rua Conde, 5', has_address: true, delivery_radius_km: null, menu_available: false, menu_block: 'A loja recebe os pedidos online por outra plataforma.' },
  ],
  campaign_cap_micros: 50_000_000,
  by_piece: [],
  search_themes: { terms: [], by_unit: [] },
  ...o,
});
const foto = (o: Partial<BrandPhoto> = {}): BrandPhoto => ({ id: 'f1', brand_id: 'b', product: 'Smash', description: '', width: 1440, height: 1800, kind: 'foto_produto', thumbnail_url: 'x', url: 'x', ...o }) as BrandPhoto;
const campos = (o: Partial<CamposDoGoogle> = {}): CamposDoGoogle => ({
  titulos: ['Combo sexta: R$ 34,90', 'Smash, batata e refri', 'Peça no cardápio online'],
  longo: 'Sexta é dia de combo: smash, batata e refri por R$ 34,90',
  descricoes: ['Peça o combo de sexta pelo cardápio online.', 'Smash, batata e refrigerante por R$ 34,90.'],
  foto: 'f1',
  loja: LOJA,
  nome: 'Combo sexta · Google · novembro',
  raio: 5,
  verba: '30,00',
  fim: '',
  temas: [],
  ...o,
});
const HOJE = '2026-11-12';

describe('campanha nova no Google: a gaveta', () => {
  it('os recortes pelo centro: os números do servidor e do P45; a foto pequena com as medidas', () => {
    expect(recortesDaFoto(1440, 1800).map((r) => [r.id, r.largura, r.altura, r.ok])).toEqual([
      ['deitada', 1440, 754, true],
      ['quadrada', 1440, 1440, true],
      ['em_pe', 1440, 1800, true],
    ]);
    // A em pé pequena não impede (é opcional).
    expect(recortesDaFoto(900, 500).find((r) => r.id === 'em_pe')?.ok).toBe(false);
    expect(motivoDaFotoPequena(900, 500)).toBeNull();
    expect(motivoDaFotoPequena(520, 520)).toBe('A foto é pequena para o recorte deitado: o Google pede pelo menos 600 × 314, e o maior recorte desta foto dá 520 × 272. Use outra foto.');
  });

  it('os textos que a gaveta traz da peça: o título, a primeira frase e o convite; o longo e as descrições; só o que cabe no Google (D-A5-33)', () => {
    expect(textosDaPeca({ title: 'Sexta é dia de combo', body: 'Smash e batata por R$ 34,90. Peça pelo cardápio online.' })).toEqual({
      titulos: ['Sexta é dia de combo', 'Smash e batata por R$ 34,90', 'Peça pelo cardápio online'],
      longo: 'Sexta é dia de combo: Smash e batata por R$ 34,90',
      descricoes: ['Smash e batata por R$ 34,90. Peça pelo cardápio online.', 'Peça pelo cardápio online.'],
    });
    // Sem frase diferente do título, o campo que falta vem vazio (a pessoa escreve ou pede ao Criativo).
    expect(textosDaPeca({ title: 'Peça pelo cardápio online', body: 'Peça pelo cardápio online.' })).toEqual({
      titulos: ['Peça pelo cardápio online', '', ''],
      longo: 'Peça pelo cardápio online',
      descricoes: ['Peça pelo cardápio online.', ''],
    });
    // A peça do piloto em 13/11/2026, escrita para a Meta (o texto com 110 caracteres): a gaveta abria com três campos em
    // vermelho (70 de 30, 92 de 90 e 110 de 90). O que não cabe dá lugar à frase ou ao título; nada é cortado no meio.
    const piloto = textosDaPeca({
      title: 'Combo Família Mister',
      body: 'Reúna a família em volta da mesa com o Combo Família do Mister Burgers. Peça pelo cardápio online e aproveite.',
    });
    expect(piloto).toEqual({
      titulos: ['Combo Família Mister', 'Peça pelo cardápio online', ''],
      longo: 'Reúna a família em volta da mesa com o Combo Família do Mister Burgers',
      descricoes: ['Reúna a família em volta da mesa com o Combo Família do Mister Burgers.', 'Peça pelo cardápio online.'],
    });
    // Nada do que a gaveta traz passa do tamanho: o que sobra para a pessoa é só o campo vazio.
    expect(motivoDosTextos(piloto)).toEqual({ campo: 'titulos', motivo: 'Há título vazio: escreva ou tire.' });
    // A frase com exclamação fica com o sinal dela na descrição; o texto sem versão que caiba deixa o campo vazio.
    expect(textosDaPeca({ title: 'Combo', body: `Hoje tem combo! ${'Muito texto depois. '.repeat(6)}` }).descricoes).toEqual(['Hoje tem combo!', 'Peça pelo cardápio online.']);
    const semFrase = textosDaPeca({ title: 'x'.repeat(31), body: 'y'.repeat(95) });
    expect(semFrase).toEqual({ titulos: ['Peça pelo cardápio online', '', ''], longo: 'x'.repeat(31), descricoes: ['Peça pelo cardápio online.', ''] });
  });

  it('os textos: as quantidades, os tamanhos, os vazios e os repetidos, no campo de cada um, com as palavras do servidor', () => {
    expect(motivoDosTextos(campos())).toBeNull();
    expect(motivoDosTextos(campos({ titulos: ['a', 'b'] }))).toEqual({ campo: 'titulos', motivo: 'O Google pede pelo menos 3 títulos.' });
    expect(motivoDosTextos(campos({ longo: 'x'.repeat(91) }))).toMatchObject({ campo: 'longo', motivo: expect.stringMatching(/tem 91 caracteres: o título longo vai até 90\.$/) });
    expect(motivoDosTextos(campos({ descricoes: ['Uma', ''] }))).toEqual({ campo: 'descricoes', motivo: 'Há descrição vazio: escreva ou tire.' });
    expect(motivoDosTextos(campos({ titulos: ['Combo', 'combo', 'Outro'] }))).toEqual({ campo: 'titulos', motivo: 'Há títulos repetidos: o Google recusa o mesmo texto duas vezes.' });
  });

  it('a conferência inteira: a foto, a loja com o cardápio, o nome, a verba e o fim', () => {
    expect(conferirCampanhaGoogle(campos(), opcoes(), [foto()], HOJE)).toEqual({});
    expect(conferirCampanhaGoogle(campos({ foto: null }), opcoes(), [foto()], HOJE)).toEqual({ foto: 'Escolha uma foto de Fotos.' });
    expect(conferirCampanhaGoogle(campos(), opcoes(), [foto({ width: 520, height: 520 })], HOJE).foto).toMatch(/^A foto é pequena/);
    expect(conferirCampanhaGoogle(campos({ loja: OUTRA }), opcoes(), [foto()], HOJE)).toEqual({ loja: 'A loja recebe os pedidos online por outra plataforma.' });
    expect(conferirCampanhaGoogle(campos({ nome: ' ' }), opcoes(), [foto()], HOJE)).toEqual({ nome: 'Dê um nome à campanha.' });
    expect(conferirCampanhaGoogle(campos({ verba: '80,00' }), opcoes(), [foto()], HOJE).verba).toMatch(/passa do teto por campanha/);
    expect(conferirCampanhaGoogle(campos({ verba: 'abc' }), opcoes(), [foto()], HOJE)).toEqual({ verba: 'Digite a verba diária em reais, como 30,00.' });
    expect(conferirCampanhaGoogle(campos({ fim: HOJE }), opcoes(), [foto()], HOJE)).toEqual({ fim: 'A data de fim precisa ser depois de hoje.' });
    expect(conferirCampanhaGoogle(campos({ titulos: ['a', 'b'] }), opcoes(), [foto()], HOJE)).toEqual({ titulos: 'O Google pede pelo menos 3 títulos.' });
  });

  it('a recusa do servidor: o código (e, nos textos, o campo do erro) diz o campo; o resto vai no erro geral', () => {
    expect(erroDoPedidoGoogle({ status: 422, code: 'textos-do-google', title: 'x', detail: 'O Google aceita até 15 títulos.', errors: [{ path: 'headlines', message: 'x' }] })).toEqual({ campo: 'titulos', texto: 'O Google aceita até 15 títulos.' });
    expect(erroDoPedidoGoogle({ status: 422, code: 'textos-do-google', title: 'x', detail: 'd', errors: [{ path: 'descriptions', message: 'x' }] }).campo).toBe('descricoes');
    expect(erroDoPedidoGoogle({ status: 422, code: 'foto-pequena', title: 'x', detail: 'A foto é pequena.' })).toEqual({ campo: 'foto', texto: 'A foto é pequena.' });
    expect(erroDoPedidoGoogle({ status: 422, code: 'sem-cardapio', title: 'x', detail: 'd' }).campo).toBe('loja');
    expect(erroDoPedidoGoogle({ status: 409, code: 'ja-pedida', title: 'Já pedida', detail: 'A peça já tem um pedido em aberto.' })).toEqual({ campo: null, texto: 'A peça já tem um pedido em aberto.' });
  });

  it('as buscas (R9): a lista sugerida por loja, de onde ela veio, a conferência com as palavras do servidor e a recusa no campo', () => {
    const o = opcoes({
      search_themes: {
        terms: ['hamburgueria', 'smash burger'],
        by_unit: [{ unit_id: LOJA, themes: ['hamburgueria perto de mim', 'hamburgueria Penha'], cut: 'A lista parou em 25 temas: Olaria ficou com um tema só. Tire um tema para pôr outro.' }],
      },
    });
    expect(temasDaLoja(o, LOJA)).toEqual({ temas: ['hamburgueria perto de mim', 'hamburgueria Penha'], corte: 'A lista parou em 25 temas: Olaria ficou com um tema só. Tire um tema para pôr outro.' });
    // A loja sem sugestão (ou nenhuma escolhida) começa vazia; a lista devolvida é uma cópia, para a gaveta mexer à vontade.
    expect(temasDaLoja(o, OUTRA)).toEqual({ temas: [], corte: '' });
    expect(temasDaLoja(o, null)).toEqual({ temas: [], corte: '' });
    temasDaLoja(o, LOJA).temas.push('outro');
    expect(o.search_themes.by_unit[0]!.themes).toHaveLength(2);
    expect(fonteDosTemas(['hamburgueria', 'smash burger'])).toBe('O Liame montou a lista, sem IA, com “hamburgueria” e “smash burger” (Minha marca), mais “perto de mim”, “delivery” e os bairros de entrega da loja.');
    expect(fonteDosTemas([])).toContain('Minha marca › Identidade, no campo "Termos de busca da loja"');

    // As mesmas palavras do servidor (`problemaDosTemas`): o vazio, o longo, o repetido sem acento e sem maiúscula, o 26º.
    expect(motivoDosTemas([])).toBeNull();
    expect(motivoDosTemas(['hamburgueria Penha', 'delivery Olaria'])).toBeNull();
    expect(motivoDosTemas(['hamburgueria Penha', '  '])).toBe('Tema 2: O tema está vazio: escreva o tema ou tire a linha.');
    expect(motivoDosTemas(['x'.repeat(81)])).toBe('Tema 1: O tema passa de 80 caracteres.');
    expect(motivoDosTemas(['açaí na Penha', 'Acai  na penha'])).toBe('Tema 2: O tema repete o tema 1.');
    expect(motivoDosTemas(Array.from({ length: 27 }, (_, i) => `tema ${i}`))).toBe('Tema 26: O Google aceita até 25 temas por campanha: tire 2 temas.');
    expect(motivoDosTemas(Array.from({ length: 25 }, (_, i) => `tema ${i}`))).toBeNull();
    expect(conferirCampanhaGoogle(campos({ temas: ['pizza', 'Pizza'] }), opcoes(), [foto()], HOJE)).toEqual({ temas: 'Tema 2: O tema repete o tema 1.' });
    // A recusa do servidor (a conferência dos textos, que a gaveta não faz) vai para o campo das buscas.
    expect(erroDoPedidoGoogle({ status: 422, code: 'tema-de-busca', detail: 'Tema 1: “Brasa Burger” é nome de concorrente.', errors: [{ path: 'search_themes[0]', message: 'x' }] } as never)).toEqual({
      campo: 'temas',
      texto: 'Tema 1: “Brasa Burger” é nome de concorrente.',
    });
  });

  it('a etiqueta de cada situação e o recurso do pedido', () => {
    expect(situacaoDaCampanhaGoogle({ status: 'pedida', active: false }).rotulo).toBe('Espera a aprovação');
    expect(situacaoDaCampanhaGoogle({ status: 'criada', active: false })).toEqual({ rotulo: 'Criada e pausada', tom: 'neutro' });
    expect(situacaoDaCampanhaGoogle({ status: 'criada', active: true })).toEqual({ rotulo: 'Ativa no Google', tom: 'concluido' });
    expect(situacaoDaCampanhaGoogle({ status: 'nao_criada', active: false }).tom).toBe('perigo');
    expect(idDaCampanhaGoogle(`campanha_google:${LOJA}`)).toBe(LOJA);
    expect(idDaCampanhaGoogle(`campanha_nova:${LOJA}`)).toBeNull();
  });
});
