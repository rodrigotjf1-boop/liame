import type { BrandPhoto, GoogleCampaignOptionsResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import {
  type CamposDoGoogle,
  conferirCampanhaGoogle,
  erroDoPedidoGoogle,
  idDaCampanhaGoogle,
  motivoDaFotoPequena,
  motivoDosTextos,
  recortesDaFoto,
  situacaoDaCampanhaGoogle,
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

  it('os textos que a gaveta traz da peça: o título, a primeira frase e o convite; o longo e as descrições', () => {
    expect(textosDaPeca({ title: 'Sexta é dia de combo', body: 'Smash, batata e refri por R$ 34,90. Peça pelo cardápio online.' })).toEqual({
      titulos: ['Sexta é dia de combo', 'Smash, batata e refri por R$ 34,90', 'Peça pelo cardápio online'],
      longo: 'Sexta é dia de combo: Smash, batata e refri por R$ 34,90',
      descricoes: ['Smash, batata e refri por R$ 34,90. Peça pelo cardápio online.', 'Peça pelo cardápio online.'],
    });
    // Sem frase diferente do título, o campo que falta vem vazio (a pessoa escreve ou pede ao Criativo).
    expect(textosDaPeca({ title: 'Peça pelo cardápio online', body: 'Peça pelo cardápio online.' }).titulos).toEqual(['Peça pelo cardápio online', '', '']);
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

  it('a etiqueta de cada situação e o recurso do pedido', () => {
    expect(situacaoDaCampanhaGoogle({ status: 'pedida', active: false }).rotulo).toBe('Espera a aprovação');
    expect(situacaoDaCampanhaGoogle({ status: 'criada', active: false })).toEqual({ rotulo: 'Criada e pausada', tom: 'neutro' });
    expect(situacaoDaCampanhaGoogle({ status: 'criada', active: true })).toEqual({ rotulo: 'Ativa no Google', tom: 'concluido' });
    expect(situacaoDaCampanhaGoogle({ status: 'nao_criada', active: false }).tom).toBe('perigo');
    expect(idDaCampanhaGoogle(`campanha_google:${LOJA}`)).toBe(LOJA);
    expect(idDaCampanhaGoogle(`campanha_nova:${LOJA}`)).toBeNull();
  });
});
