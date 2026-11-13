import type { BrandPhoto, NewCampaignOptionsResponse, NewCampaignResponse } from '@liame/contracts';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  type CamposDaCampanha,
  conferirCampanha,
  diaDoReels,
  efeitoDaCampanha,
  erroDoPedido,
  falaDoLinkDaBio,
  idDaCampanhaNova,
  linhaDaEstimativa,
  linhaDoTopo,
  linkDoGerenciador,
  nomeDaCampanhaDoReels,
  notaDoLinkDaBio,
  passosDaCriacao,
  pessoasEscritas,
  raiosDaLoja,
  situacaoDaCampanha,
} from '../src/components/criativos/campanha-nova-textos';
import { EstimativaDoRaio } from '../src/components/criativos/estimativa-do-raio';

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
  top_of_funnel: null,
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

  it('a campanha com raio (R6): alcance pede o cardápio, seguidores pede o Instagram, e os dois cabem no teto de 25% do mês', () => {
    expect(conferirCampanha(campos({ objetivo: 'alcance' }), opcoes(), [midia()], '2026-11-11')).toEqual({});
    const semCardapio = opcoes({ units: [{ ...opcoes().units[1]!, has_address: true }] });
    expect(conferirCampanha(campos({ loja: OUTRA, objetivo: 'alcance' }), semCardapio, [midia()], '2026-11-11').objetivo).toMatch(/^A loja recebe os pedidos online/);
    expect(conferirCampanha(campos({ objetivo: 'seguidores' }), opcoes(), [midia()], '2026-11-11')).toEqual({});
    expect(conferirCampanha(campos({ objetivo: 'seguidores' }), opcoes({ instagram: null }), [midia()], '2026-11-11').objetivo).toMatch(/^Seguidores no Instagram leva ao perfil/);
    // O teto do topo: R$ 100 por dia nos 10 dias que faltam; R$ 60 já reservados por dia.
    const topo = { cap_micros: 1_000_000_000, used_micros: 600_000_000, days_left: 10 };
    expect(conferirCampanha(campos({ objetivo: 'alcance', verba: '40,00' }), opcoes({ top_of_funnel: topo }), [midia()], '2026-11-11')).toEqual({});
    const passa = conferirCampanha(campos({ objetivo: 'alcance', verba: '45,00' }), opcoes({ top_of_funnel: topo }), [midia()], '2026-11-11').verba;
    expect(passa).toMatch(/Esta passa do teto: diminua a verba diária para até R\$\s40,00\.$/);
    // O cardápio não conta no topo.
    expect(conferirCampanha(campos({ verba: '45,00' }), opcoes({ top_of_funnel: topo }), [midia()], '2026-11-11')).toEqual({});
    const linha = linhaDoTopo(topo, 30_000_000);
    expect(linha.passa).toBe(false);
    expect(linha.texto.replace(/ /g, ' ')).toBe('Alcance e seguidores: até 25% do teto do mês (R$ 1.000,00). Já há R$ 600,00 reservados em campanhas assim; esta usa até R$ 300,00 até o fim do mês.');
    expect(erroDoPedido({ status: 422, code: 'acima-do-teto-do-topo', title: 't', detail: 'd' } as never).campo).toBe('verba');
    expect(erroDoPedido({ status: 422, code: 'sem-instagram-na-pagina', title: 't', detail: 'd' } as never).campo).toBe('objetivo');
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

describe('campanha nova: a estimativa de público no raio (R6, parte 2; D-RG-50)', () => {
  const pronta = (lower: number, upper: number, enough: boolean) => ({ status: 'pronta' as const, lower, upper, minimum: 1000, enough });

  it('as pessoas escritas de forma curta, como no protótipo', () => {
    expect(pessoasEscritas(760)).toBe('760');
    expect(pessoasEscritas(1500)).toBe('1.500');
    expect(pessoasEscritas(182_400)).toBe('182 mil');
    expect(pessoasEscritas(999_600)).toBe('1 milhão');
    expect(pessoasEscritas(1_240_000)).toBe('1,2 milhão');
    expect(pessoasEscritas(2_400_000)).toBe('2,4 milhões');
  });

  it('a linha: a faixa no raio; pequeno demais com a frase do servidor; sem a estimativa, o pedido segue', () => {
    expect(linhaDaEstimativa(pronta(182_000, 214_000, true), 5, 'Loja Centro')).toMatchObject({ tom: 'ok', destaque: 'Cerca de 182 mil a 214 mil pessoas' });
    expect(linhaDaEstimativa(pronta(182_000, 214_000, true), 5, 'Loja Centro').texto).toContain('no raio de 5 km, pela estimativa da Meta (lida agora)');
    // A mesma frase da recusa `publico-pequeno` do servidor (`textoDoPublicoPequeno`).
    expect(linhaDaEstimativa(pronta(640, 760, false), 2.5, 'Loja Centro')).toEqual({
      tom: 'pequeno',
      titulo: 'Público pequeno demais no raio',
      destaque: null,
      texto: 'A Meta estima de 640 a 760 pessoas de 18 anos ou mais num raio de 2,5 km em volta da Loja Centro: com menos de 1.000 pessoas, ela não entrega bem. Aumente o raio.',
    });
    const sem = { status: 'sem_estimativa' as const, lower: null, upper: null, minimum: 1000, enough: null };
    expect(linhaDaEstimativa(sem, 5, 'Loja Centro')).toMatchObject({ tom: 'sem', texto: 'A Meta não deu a estimativa deste raio agora: o pedido pode seguir sem ela.' });
    expect(linhaDaEstimativa({ ...sem, status: 'indisponivel' }, 5, 'Loja Centro').tom).toBe('sem');
    expect(linhaDaEstimativa('falhou', 5, 'Loja Centro').texto).toBe('Não deu para ler a estimativa da Meta agora: o pedido pode seguir sem ela.');
  });

  it('a tela: lendo, a faixa como informação e o pequeno como aviso que impede', () => {
    const aviso = createRef<HTMLDivElement>();
    const html = (e: Parameters<typeof EstimativaDoRaio>[0]['estimativa']) => renderToStaticMarkup(createElement(EstimativaDoRaio, { id: 'p', estimativa: e, km: 3, loja: 'Loja Centro', aviso }));
    expect(html('lendo')).toContain('Lendo a estimativa da Meta para este raio…');
    expect(html('lendo')).toContain('role="status"');
    const ok = html(pronta(64_000, 75_000, true));
    expect(ok).toContain('<b>Cerca de 64 mil a 75 mil pessoas</b>');
    expect(ok).toContain('role="status"');
    const pequeno = html(pronta(640, 760, false));
    expect(pequeno).toContain('role="alert"');
    expect(pequeno).toContain('<b>Público pequeno demais no raio</b>');
    expect(pequeno).toContain('num raio de 3 km em volta da Loja Centro');
  });
});
