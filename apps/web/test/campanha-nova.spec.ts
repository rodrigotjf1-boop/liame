import type { BrandPhoto, NewCampaignOptionsResponse, NewCampaignResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import {
  type CamposDaCampanha,
  conferirCampanha,
  diaDoReels,
  efeitoDaCampanha,
  erroDoPedido,
  falaDoLinkDaBio,
  idDaCampanhaNova,
  linkDoGerenciador,
  nomeDaCampanhaDoReels,
  notaDoLinkDaBio,
  passosDaCriacao,
  raiosDaLoja,
  situacaoDaCampanha,
} from '../src/components/criativos/campanha-nova-textos';

// A campanha nova (A4, X5, parte 5; P42): a tela confere o mesmo que o servidor antes de mandar, a recusa do servidor vai
// para o campo certo, e Aprovações mostra a criação passo a passo.

const LOJA = '0190a000-0000-7000-8000-000000000001';
const OUTRA = '0190a000-0000-7000-8000-000000000002';
const opcoes = (o: Partial<NewCampaignOptionsResponse> = {}): NewCampaignOptionsResponse => ({
  enabled: true,
  blocks: [],
  ad_account: { name: 'Mister Burgers', currency: 'BRL' },
  page: { name: 'Mister Burgers' },
  instagram: { name: '@misterburgers' },
  units: [
    { id: LOJA, name: 'Loja Centro', address: 'Rua da Assembleia, 10, Centro', has_address: true, delivery_radius_km: 4, menu_available: true, menu_block: null },
    { id: OUTRA, name: 'Loja Tijuca', address: null, has_address: false, delivery_radius_km: null, menu_available: false, menu_block: 'A loja recebe os pedidos online por outra plataforma: use o objetivo de conversas no WhatsApp.' },
  ],
  campaign_cap_micros: 50_000_000,
  by_piece: [],
  by_reels: [],
  ...o,
});
const midia = (o: Partial<BrandPhoto> = {}): BrandPhoto =>
  ({ id: 'f1', brand_id: 'b', product: 'Smash', description: '', width: 1080, height: 1350, kind: 'foto_produto', thumbnail_url: 'x', url: 'x', ...o }) as BrandPhoto;
const campos = (o: Partial<CamposDaCampanha> = {}): CamposDaCampanha => ({ midia: 'f1', loja: LOJA, nome: 'Combo sexta', objetivo: 'cardapio', raio: 5, verba: '30,00', fim: '', ...o });

describe('campanha nova: a conferência da gaveta', () => {
  it('o pedido certo passa; cada recusa vai para o seu campo, com as palavras do servidor', () => {
    expect(conferirCampanha(campos(), opcoes(), [midia()], '2026-11-11')).toEqual({});
    const video = midia({ id: 'v1', kind: 'video', video: { width: 1080, height: 1920, duration_ms: 18_000, media_type: 'video/mp4', has_audio: true, has_cover: false } });
    expect(conferirCampanha(campos({ midia: 'v1' }), opcoes(), [video], '2026-11-11').midia).toBe('O anúncio de vídeo leva a capa: escolha a capa do vídeo em Fotos, ou use outro vídeo.');
    expect(conferirCampanha(campos({ loja: OUTRA }), opcoes(), [midia()], '2026-11-11').loja).toMatch(/^A campanha mostra o anúncio em volta da loja/);
    const semCardapio = opcoes({ units: [{ ...opcoes().units[1]!, has_address: true }] });
    expect(conferirCampanha(campos({ loja: OUTRA }), semCardapio, [midia()], '2026-11-11').objetivo).toBe('A loja recebe os pedidos online por outra plataforma: use o objetivo de conversas no WhatsApp.');
    expect(conferirCampanha(campos({ loja: OUTRA, objetivo: 'whatsapp' }), semCardapio, [midia()], '2026-11-11')).toEqual({});
    expect(conferirCampanha(campos({ verba: '30,005' }), opcoes(), [midia()], '2026-11-11').verba).toBe('Digite a verba diária em reais, como 30,00.');
    expect(conferirCampanha(campos({ verba: '60' }), opcoes(), [midia()], '2026-11-11').verba).toMatch(/^A verba diária passa do teto por campanha, que é de R\$\s50,00 por dia/);
    expect(conferirCampanha(campos({ fim: '2026-11-11' }), opcoes(), [midia()], '2026-11-11').fim).toBe('A data de fim precisa ser depois de hoje.');
    expect(conferirCampanha(campos({ nome: '  ' }), opcoes(), [midia()], '2026-11-11').nome).toBe('Dê um nome à campanha.');
  });

  it('o Reels (X5, parte 6): a mídia é o próprio post, não há o que escolher em Fotos; o resto confere igual', () => {
    expect(conferirCampanha(campos({ midia: null }), opcoes(), [], '2026-11-11', true)).toEqual({});
    expect(conferirCampanha(campos({ midia: null, loja: OUTRA }), opcoes(), [], '2026-11-11', true).loja).toMatch(/^A campanha mostra o anúncio em volta da loja/);
    // Sem o Reels, a mesma lista vazia pede a foto ou o vídeo.
    expect(conferirCampanha(campos({ midia: null }), opcoes(), [], '2026-11-11').midia).toBe('Escolha uma foto ou um vídeo de Fotos.');
  });

  it('o Reels: o nome sugerido, o dia no fuso da loja e a nota do link da bio', () => {
    // 01:30 em UTC do dia 19 ainda é o dia 18 em São Paulo.
    expect(diaDoReels('2026-09-19T01:30:00Z')).toBe('18/09');
    expect(nomeDaCampanhaDoReels('2026-09-19T01:30:00Z', '2026-11-11')).toBe('Reels de 18/09 · novembro');
    expect(falaDoLinkDaBio('Smash duplo saindo da chapa 🔥 Peça pelo link da bio.')).toBe(true);
    expect(falaDoLinkDaBio('Link na bio!')).toBe(true);
    expect(falaDoLinkDaBio('Peça pelo cardápio')).toBe(false);
    expect(notaDoLinkDaBio('cardapio')).toBe('A legenda fala do link da bio, porque é a do post. No anúncio, o botão “Pedir agora” já leva ao cardápio.');
    expect(notaDoLinkDaBio('whatsapp')).toMatch(/“Enviar mensagem” já leva à conversa\.$/);
  });

  it('a recusa do servidor: o código diz o campo; o resto vai no erro geral', () => {
    expect(erroDoPedido({ status: 422, code: 'loja-sem-endereco', title: 'Falta o endereço da loja', detail: 'Ajuste o endereço.' })).toEqual({ campo: 'loja', texto: 'Ajuste o endereço.' });
    expect(erroDoPedido({ status: 409, code: 'ja-pedida', title: 'Já existe um pedido com esta peça', detail: 'Decida esse antes.' })).toEqual({ campo: null, texto: 'Decida esse antes.' });
  });

  it('os raios: 3, 5 e 8 km, e o de entrega da loja só quando é outro, dentro de 1 a 15 km, em passos de 0,5', () => {
    expect(raiosDaLoja(opcoes().units[0]!).map((r) => r.rotulo)).toEqual(['3 km', '5 km', '8 km', 'Raio de entrega (4 km)']);
    expect(raiosDaLoja({ ...opcoes().units[0]!, delivery_radius_km: 5 }).map((r) => r.km)).toEqual([3, 5, 8]);
    expect(raiosDaLoja({ ...opcoes().units[0]!, delivery_radius_km: 4.3 }).map((r) => r.km)).toEqual([3, 5, 8]);
    expect(raiosDaLoja(null).length).toBe(3);
  });

  it('o efeito: nasce pausada; com a verba, quanto gasta por dia depois de ativada', () => {
    expect(efeitoDaCampanha('')).toMatch(/Digite a verba diária/);
    expect(efeitoDaCampanha('30')).toMatch(/Ativada, ela gasta até R\$\s30,00 por dia\.$/);
  });
});

describe('campanha nova: a situação e o passo a passo', () => {
  const c = (o: Partial<NewCampaignResponse> = {}): NewCampaignResponse =>
    ({
      id: '0190a000-0000-7000-8000-0000000000aa',
      status: 'criando',
      active: false,
      meta: { campaign_id: '1', adset_id: '2', video_id: null, creative_id: null, ad_id: null },
      ...o,
    }) as NewCampaignResponse;

  it('criando com vídeo: a campanha e o conjunto feitos, o vídeo agora, o resto pendente', () => {
    expect(passosDaCriacao(c(), true).map((p) => `${p.rotulo}:${p.estado}`)).toEqual(['A campanha:feito', 'O conjunto:feito', 'O vídeo:agora', 'O criativo:pendente', 'O anúncio:pendente']);
    expect(passosDaCriacao(c(), true)[2]!.detalhe).toBe('a Meta prepara o vídeo (até 15 minutos)');
    // Cada um com a sua concordância.
    expect(passosDaCriacao(c(), true).slice(0, 2).map((p) => p.detalhe)).toEqual(['criada na Meta, pausada', 'criado na Meta, pausado']);
    expect(passosDaCriacao(c({ status: 'nao_criada' }), false).map((p) => p.estado)).toEqual(['feito', 'feito', 'pendente', 'pendente']);
  });

  it('a etiqueta de cada situação', () => {
    // Pausada não é perigo: a etiqueta neutra, como no P42.
    expect(situacaoDaCampanha({ status: 'criada', active: false })).toEqual({ rotulo: 'Criada e pausada', tom: 'neutro' });
    expect(situacaoDaCampanha({ status: 'criada', active: true })).toEqual({ rotulo: 'Ativa na Meta', tom: 'concluido' });
    expect(situacaoDaCampanha({ status: 'nao_criada', active: false }).tom).toBe('perigo');
  });

  it('o link do Gerenciador abre na conta da campanha (sem o prefixo act_)', () => {
    expect(linkDoGerenciador('120210', 'act_9876')).toBe('https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=9876&selected_campaign_ids=120210');
    expect(linkDoGerenciador('120210', null)).toBe('https://adsmanager.facebook.com/adsmanager/manage/campaigns?selected_campaign_ids=120210');
  });

  it('o recurso do pedido aponta para a campanha nova', () => {
    expect(idDaCampanhaNova('campanha_nova:0190a000-0000-7000-8000-0000000000aa')).toBe('0190a000-0000-7000-8000-0000000000aa');
    expect(idDaCampanhaNova('campanha:123')).toBeNull();
  });
});
