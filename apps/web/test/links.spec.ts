import type { LinkCampaignOption, LinkDestination, LinkSource, TrackingCheckItem, TrackingCheckResponse, TrackingLink } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DialogoLinkPronto } from '@/components/links/dialogo-link-pronto';
import { FaixaRastreio } from '@/components/links/faixa-rastreio';
import { QrLink, svgDoQr } from '@/components/links/qr-link';
import { TabelaLinks } from '@/components/links/tabela-links';
import {
  arquivoDoQr,
  avisoDoLink,
  campanhaAceitaLink,
  conferidoEm,
  criadoEm,
  errosDoLink,
  faixaRastreio,
  gruposDeCampanhas,
  motivoCampanhaSemLink,
  motivoDestino,
  ondeColar,
  rotuloDestino,
} from '@/components/links/textos';
import { emFerramenta, itensVisiveis, NAVEGACAO, temModos, tituloDa } from '@/components/shell/navegacao';
import { AvisosProvider } from '@/components/ui/avisos';

// Tela "Links e cupons" (P3), aba Links: a faixa da conferência dos anúncios, os textos de onde colar,
// o formulário de criar link, a tabela, o link pronto com o QR e o lugar dela no menu ("Mais
// ferramentas"). Datas no horário local da máquina (como as outras specs), então valem em qualquer fuso.

const local = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString();
const agora = new Date(2026, 8, 30, 15, 0);
const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const fonte = (provider: string, read_at: string | null): LinkSource => ({
  connected_account_id: uuid(provider === 'meta_ads' ? 1 : 2),
  provider,
  name: provider === 'meta_ads' ? 'Mister Burgers (Meta)' : 'Mister Burgers (Google)',
  read_at,
  freshness: 'fresh',
});

const item = (n: number, o: Partial<TrackingCheckItem> = {}): TrackingCheckItem => ({
  status: 'sem_rastreio',
  reason: 'sem_parametros',
  title: `O anúncio "Anúncio ${n}" está sem os parâmetros do Liame`,
  detail: 'O link do anúncio não tem os parâmetros do Liame: as vendas dele ficam sem origem.',
  action: 'Cole os parâmetros do link desta campanha, em Links e cupons.',
  provider: 'meta_ads',
  connected_account_id: uuid(1),
  campaign: { id: uuid(100), name: 'Combo sexta' },
  ad: { id: uuid(200 + n), name: `Anúncio ${n}`, external_id: `12021${n}` },
  destination_url: null,
  first_seen_at: local(24, 9),
  suggested_link_id: null,
  ...o,
});

const conferencia = (o: Partial<TrackingCheckResponse['summary']>, itens: TrackingCheckItem[], sources = [fonte('meta_ads', local(30, 6, 12)), fonte('google_ads', local(30, 6, 40))]): TrackingCheckResponse => ({
  summary: { active_ads: 6, with_tracking: 6, without_tracking: 0, not_verifiable: 0, not_applicable: 1, ...o },
  items: itens,
  sources,
  generated_at: local(30, 15),
});

const link = (n: number, o: Partial<TrackingLink> = {}): TrackingLink => ({
  id: uuid(300 + n),
  brand_id: uuid(9),
  unit: { id: uuid(10), name: 'Loja Centro' },
  name: `Combo sexta ${n}`,
  code: `7K3M9QX2A${n}`,
  provider: 'meta_ads',
  campaign: { id: uuid(100), name: 'Combo sexta', status: 'ativa' },
  ad: null,
  destination_url: 'https://app.dmsregem.com/c/mister',
  tracking_url: `https://app.dmsregem.com/c/mister?utm_source=meta&utm_medium=paid&utm_campaign=combo-sexta&lk=7K3M9QX2A${n}`,
  platform_params: {
    field: 'url_tags',
    value: `utm_source=meta&utm_medium=paid&utm_campaign={{campaign.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}&lk=7K3M9QX2A${n}`,
  },
  orders_7d: 13,
  created_at: local(22, 10),
  ...o,
});

describe('conferência dos anúncios ativos', () => {
  it('sem conta de anúncio lida, não há faixa', () => {
    expect(faixaRastreio(conferencia({}, [], []), agora)).toBeNull();
  });

  it('a conferência é tão nova quanto a leitura mais antiga entre as contas', () => {
    expect(conferidoEm([fonte('meta_ads', local(30, 6, 12)), fonte('google_ads', local(29, 22, 5))], agora)).toBe('ontem, 22:05');
    expect(conferidoEm([fonte('meta_ads', null)], agora)).toBeNull();
  });

  it('anúncios sem rastreio: atenção, com a contagem certa e o botão para a lista inteira', () => {
    const um = faixaRastreio(conferencia({ without_tracking: 1, with_tracking: 5 }, [item(1)]), agora)!;
    expect(um).toMatchObject({ tipo: 'atencao', icone: 'alert', lista: true, botao: 'Ver o anúncio' });
    expect(um.titulo).toBe('1 anúncio ativo sem os parâmetros do Liame — as vendas dele ficam sem origem.');
    expect(um.texto).toBe('Conferido hoje, 06:12, com os anúncios ativos da Meta e do Google Ads. O Liame não mexe nos anúncios: cole os parâmetros em cada um.');

    const tres = faixaRastreio(
      conferencia({ without_tracking: 2, not_verifiable: 1, with_tracking: 3 }, [item(1), item(2), item(3, { status: 'nao_verificavel', reason: 'leitura_pendente' })]),
      agora,
    )!;
    expect(tres.titulo).toBe('2 anúncios ativos sem os parâmetros do Liame — as vendas deles ficam sem origem.');
    expect(tres.botao).toBe('Ver os 3 anúncios');
  });

  it('só não conferidos: informativa, dizendo que os outros estão certos', () => {
    const f = faixaRastreio(conferencia({ not_verifiable: 2, with_tracking: 1 }, [item(1, { status: 'nao_verificavel' }), item(2, { status: 'nao_verificavel' })], [fonte('meta_ads', local(30, 6, 12))]), agora)!;
    expect(f).toMatchObject({ tipo: undefined, icone: 'info', lista: true, botao: 'Ver os 2 anúncios' });
    expect(f.titulo).toBe('2 anúncios ativos ainda não foram conferidos.');
    expect(f.texto).toBe('Conferido hoje, 06:12, com os anúncios ativos da Meta. O outro anúncio ativo tem os parâmetros do Liame.');
  });

  it('tudo certo e nenhum anúncio ativo', () => {
    expect(faixaRastreio(conferencia({}, []), agora)).toMatchObject({ tipo: 'acao', icone: 'check', lista: false, titulo: 'Todos os anúncios ativos têm os parâmetros do Liame' });
    const nada = faixaRastreio(conferencia({ active_ads: 0, with_tracking: 0 }, [], [fonte('google_ads', null)]), agora)!;
    expect(nada.titulo).toBe('Nenhum anúncio ativo na última leitura');
    expect(nada.texto).toContain('Os anúncios do Google Ads ainda não foram lidos.');
  });
});

describe('onde colar os parâmetros', () => {
  it('Meta no "Parâmetros de URL" e Google no "Sufixo do URL final", com o cardápio como endereço', () => {
    const meta = ondeColar('url_tags', 'meta_ads', 'https://app.dmsregem.com/c/mister');
    expect(meta.titulo).toBe('No anúncio, no campo “Parâmetros de URL”, cole:');
    expect(meta.dica).toContain('(https://app.dmsregem.com/c/mister)');
    const google = ondeColar('final_url_suffix', 'google_ads', 'https://app.dmsregem.com/c/mister');
    expect(google.titulo).toBe('No campo “Sufixo do URL final”, cole:');
    expect(google.copiado).toContain('Sufixo do Google Ads copiado');
  });
});

describe('criar link', () => {
  const camp = (id: number, provider: string, destination_kind: string): LinkCampaignOption => ({
    id: uuid(id),
    name: `Campanha ${id}`,
    provider,
    status: 'ativa',
    destination_kind,
    ads: [],
  });

  it('confere nome, campanha e destino antes de enviar', () => {
    expect(errosDoLink({ nome: ' ', campanha: '', destino: '' })).toEqual({
      nome: 'Dê um nome ao link, para achar depois.',
      campanha: 'Escolha a campanha.',
      destino: 'Escolha o cardápio de destino.',
    });
    expect(errosDoLink({ nome: 'x'.repeat(61), campanha: uuid(1), destino: uuid(2) })).toEqual({ nome: 'Use até 60 caracteres.' });
    expect(errosDoLink({ nome: 'Combo sexta · stories', campanha: uuid(1), destino: uuid(2) })).toEqual({});
  });

  it('campanha de mensagens (abre o WhatsApp) não leva link; as outras vão por plataforma', () => {
    const lista = [camp(1, 'meta_ads', 'site'), camp(2, 'meta_ads', 'mensagens'), camp(3, 'google_ads', 'desconhecido')];
    expect(lista.map(campanhaAceitaLink)).toEqual([true, false, true]);
    expect(motivoCampanhaSemLink(lista[1]!)).toBe('mensagens: o anúncio abre o WhatsApp');
    expect(gruposDeCampanhas(lista).map((g) => [g.titulo, g.campanhas.length])).toEqual([
      ['Meta Ads', 2],
      ['Google Ads', 1],
    ]);
  });

  it('cardápio que não serve de destino diz por quê', () => {
    const d = (o: Partial<LinkDestination>): LinkDestination => ({
      connected_account_id: uuid(5),
      unit: { id: uuid(10), name: 'Loja Centro' },
      store_name: 'Mister Burguer Steakhouse',
      menu_url: 'https://app.dmsregem.com/c/mister',
      usable: true,
      reason: null,
      ...o,
    });
    expect(motivoDestino(d({}))).toBeNull();
    expect(rotuloDestino(d({}))).toBe('Cardápio online · Loja Centro');
    expect(motivoDestino(d({ usable: false, unit: null, reason: 'sem_loja' }))).toContain('Contas conectadas');
    expect(rotuloDestino(d({ unit: null }))).toBe('Cardápio online · Mister Burguer Steakhouse');
    expect(motivoDestino(d({ usable: false, menu_url: null, reason: 'sem_cardapio' }))).toBe('o Regem não informou o cardápio online desta loja');
  });

  it('aviso de link novo ou do mesmo link que já existia; arquivo do QR sem acento', () => {
    expect(avisoDoLink({ code: 'ABC' }, true)).toBe('Link criado. Copie os parâmetros e cole no anúncio.');
    expect(avisoDoLink({ code: 'ABC' }, false)).toBe('Esse link já existia (código ABC): os parâmetros e o QR são os mesmos.');
    expect(arquivoDoQr({ name: 'Promoção · Sábado à noite!', code: '7K3M' }, 'png')).toBe('qr-promocao-sabado-a-noite-7K3M.png');
    expect(arquivoDoQr({ name: '***', code: '7K3M' }, 'svg')).toBe('qr-link-7K3M.svg');
  });

  it('quando o link foi criado', () => {
    expect(criadoEm(local(30, 9), agora)).toBe('criado hoje');
    expect(criadoEm(local(29, 9), agora)).toBe('criado ontem');
    expect(criadoEm(local(22, 9), agora)).toBe('criado em 22/09');
  });
});

describe('desenho da aba Links (o mesmo componente do navegador)', () => {
  it('tabela: nome, cardápio, campanha com a plataforma, código, pedidos e ações com rótulo', () => {
    const html = renderToStaticMarkup(
      createElement(TabelaLinks, {
        links: [link(1), link(2, { campaign: null, ad: { id: uuid(400), name: 'Vídeo 15s' }, orders_7d: 0, provider: 'google_ads' })],
        marca: 'Mister Burgers',
        agora,
        aoCopiar: () => {},
        aoParametros: () => {},
      }),
    );
    expect(html).toContain('<caption class="sr-only">Links de campanha de Mister Burgers</caption>');
    expect(html).toContain('app.dmsregem.com/c/mister');
    expect(html).toContain('<span class="cod-lk">7K3M9QX2A1</span>');
    expect(html).toContain('Todos os anúncios');
    expect(html).toContain('Anúncio: Vídeo 15s');
    expect(html).toContain('Campanha fora da conta conectada');
    expect(html).toContain('aria-label="Parâmetros e QR do link Combo sexta 1"');
    expect(html).toContain('<span class="plat plat--google">Google Ads</span>');
  });

  it('faixa: lista fechada no começo; "Ver parâmetros" com link sugerido, "Criar link" sem ele, nada no não conferido', () => {
    const check = conferencia({ without_tracking: 2, not_verifiable: 1, with_tracking: 3 }, [
      item(1, { suggested_link_id: uuid(301) }),
      item(2),
      item(3, { status: 'nao_verificavel', reason: 'leitura_pendente', title: 'Ainda não conferimos o anúncio "Anúncio 3"' }),
    ]);
    const desenhar = (podeCriar: boolean) =>
      renderToStaticMarkup(createElement(FaixaRastreio, { check, links: [link(1)], agora, podeCriar, aoVerParametros: () => {}, aoCriarLink: () => {} }));
    const html = desenhar(true);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/<ul class="sem-rastreio" id="[^"]+" hidden=""/);
    expect(html.match(/>Ver parâmetros</g)).toHaveLength(1);
    expect(html.match(/>Criar link</g)).toHaveLength(1);
    expect(html).toContain('Ainda não conferimos o anúncio &quot;Anúncio 3&quot;');
    expect(html).toContain('Campanha Combo sexta · visto desde 24/09');
    expect(desenhar(false).match(/>Criar link</g)).toBeNull();
  });

  it('link pronto: o link, os parâmetros da plataforma, o QR e a faixa do link criado', () => {
    const l = link(1);
    const html = renderToStaticMarkup(createElement(AvisosProvider, null, createElement(DialogoLinkPronto, { link: l, criado: true, reserva: { current: null }, aoFechar: () => {} })));
    expect(html).toContain('Link pronto: Combo sexta 1');
    expect(html).toContain(`value="${l.tracking_url.replaceAll('&', '&amp;')}"`);
    expect(html).toContain('No anúncio, no campo “Parâmetros de URL”, cole:');
    expect(html).toContain('{{campaign.id}}');
    expect(html).toContain('role="img" aria-label="QR do link Combo sexta 1"');
    expect(html).toContain('Link criado');
    const lista = renderToStaticMarkup(createElement(AvisosProvider, null, createElement(DialogoLinkPronto, { link: { ...l, platform_params: null }, criado: null, reserva: { current: null }, aoFechar: () => {} })));
    expect(lista).toContain('Combo sexta 1: parâmetros e QR');
    expect(lista).not.toContain('param-bloco');
    expect(lista).not.toContain('Link criado');
  });

  it('QR: o SVG para baixar só tem números e as duas cores (nada do texto entra no desenho)', () => {
    const texto = 'https://app.dmsregem.com/c/mister?lk=7K3M9QX2A1&x="><script>';
    const svg = svgDoQr(texto);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).not.toContain('script');
    expect(svg).not.toContain('app.dmsregem');
    expect(svg).toMatch(/^[<>a-zA-Z0-9 ="/:.\-#]+$/);
    expect(renderToStaticMarkup(createElement(QrLink, { texto, rotulo: 'QR do link' }))).toContain('role="img" aria-label="QR do link"');
  });
});

describe('menu: "Links e cupons" em "Mais ferramentas"', () => {
  const operacao = NAVEGACAO.find((g) => g.id === 'operacao')!;

  it('grupo de ferramenta, com a permissão que a API exige para ver os links', () => {
    expect(operacao).toMatchObject({ rotulo: 'Operação', ferramenta: true });
    expect(operacao.itens).toEqual([{ href: '/links', rotulo: 'Links e cupons', icone: 'link', permissao: 'vendas.ver' }]);
    expect(itensVisiveis(operacao, (p) => p !== 'vendas.ver')).toEqual([]);
    expect(NAVEGACAO.map((g) => g.id)).toEqual(['agencia', 'operacao', 'conta']);
  });

  it('título, "Mais ferramentas" aberto na própria tela e sem seletor Lite/Pro (a tela tem uma visão só)', () => {
    expect(tituloDa('/links')).toBe('Links e cupons');
    expect(emFerramenta('/links')).toBe(true);
    expect(emFerramenta('/resultados')).toBe(false);
    expect(temModos('/links', () => true)).toBe(false);
  });
});
