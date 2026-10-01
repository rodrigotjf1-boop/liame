import { encode } from 'uqr';
import { describe, expect, it } from 'vitest';
import { resolverUrlGoogle } from '../src/connectors/google-ads/conector-google-ads.js';
import { rastreioMeta } from '../src/connectors/meta/conector-meta.js';
import type { RastreioLido } from '../src/connectors/tipos.js';
import { type AnuncioParaConferir, conferirAnuncio, type ContextoConferencia, textoDoAviso, tipoDeDestino } from '../src/links/conferencia.js';
import {
  cardapioValido,
  codigoDoLink,
  codigoValido,
  destinoNoCardapio,
  linkComRastreio,
  PARAMETROS_DE_RASTREIO,
  parametrosParaColar,
  qrSvg,
  slugCampanha,
  TAMANHO_CODIGO,
} from '../src/links/construtor.js';

// A2.5 · F5, funções puras: o que a pessoa cola no anúncio (igual ao protótipo P3), o link com rastreio, o
// código `lk` pela chave natural, o destino só dentro do cardápio da loja (V33, com os truques de endereço),
// o QR com o mesmo link, a leitura do link dos anúncios (Meta e Google) e a conferência do rastreio.

const CARDAPIO = 'https://cardapio.exemplo.com.br/misterburgers-centro';

describe('construtor do link', () => {
  it('parâmetros para colar: os do protótipo P3, com o lk; todos captados pelo cardápio', () => {
    const meta = parametrosParaColar('meta_ads', 'CS7Q2XK9PA');
    const google = parametrosParaColar('google_ads', 'BH4K8XJ2QM');
    expect(meta).toBe('utm_source=meta&utm_medium=paid&utm_campaign={{campaign.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}&lk=CS7Q2XK9PA');
    expect(google).toBe('utm_source=google&utm_medium=cpc&campaign_id={campaignid}&adgroup_id={adgroupid}&ad_id={creative}&lk=BH4K8XJ2QM');
    for (const texto of [meta, google]) {
      const nomes = texto.split('&').map((p) => p.split('=')[0]);
      for (const n of nomes) expect(PARAMETROS_DE_RASTREIO).toContain(n);
    }
  });

  it('link com rastreio: origem, meio, campanha e lk; o que o destino já tinha fica, e o fragmento vai para o fim', () => {
    expect(linkComRastreio(CARDAPIO, { utmSource: 'meta', utmMedium: 'paid', utmCampaign: 'combo-sexta', codigo: 'CS7Q2XK9PA' })).toBe(
      `${CARDAPIO}?utm_source=meta&utm_medium=paid&utm_campaign=combo-sexta&lk=CS7Q2XK9PA`,
    );
    expect(linkComRastreio(`${CARDAPIO}/produto?id=9#topo`, { utmSource: 'google', utmMedium: 'cpc', utmCampaign: null, codigo: 'BH4K8XJ2QM' })).toBe(
      `${CARDAPIO}/produto?id=9&utm_source=google&utm_medium=cpc&lk=BH4K8XJ2QM#topo`,
    );
  });

  it('utm_campaign: o nome da campanha em letras e números, sem acento, até 100 caracteres', () => {
    expect(slugCampanha('Busca “hambúrguer perto”')).toBe('busca-hamburguer-perto');
    expect(slugCampanha('Combo sexta')).toBe('combo-sexta');
    expect(slugCampanha('  VENDAS | COMPRAR | SEX A DOM ')).toBe('vendas-comprar-sex-a-dom');
    expect(slugCampanha('“” !!')).toBeNull();
    expect(slugCampanha('a'.repeat(500))).toHaveLength(100);
  });

  it('código do link: sai da chave natural (determinístico), 10 caracteres sem I, L, O e U, e muda com qualquer parte da chave', () => {
    const chave = { tenantId: 'empresa-1', unitId: 'loja-1', campaignId: 'campanha-1', adId: null, destinationUrl: CARDAPIO };
    const c = codigoDoLink(chave);
    expect(c).toHaveLength(TAMANHO_CODIGO);
    expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(codigoValido(c)).toBe(true);
    expect(codigoDoLink({ ...chave })).toBe(c);
    const variacoes = [
      c,
      codigoDoLink({ ...chave, adId: 'anuncio-1' }),
      codigoDoLink({ ...chave, campaignId: 'campanha-2' }),
      codigoDoLink({ ...chave, unitId: 'loja-2' }),
      codigoDoLink({ ...chave, destinationUrl: `${CARDAPIO}/combo` }),
      codigoDoLink({ ...chave, tenantId: 'empresa-2' }),
      codigoDoLink(chave, 1),
    ];
    expect(new Set(variacoes).size).toBe(variacoes.length);
    // Muitas chaves, nenhum código repetido (50 bits por código).
    const codigos = new Set(Array.from({ length: 5000 }, (_, i) => codigoDoLink({ ...chave, campaignId: `campanha-${i}` })));
    expect(codigos.size).toBe(5000);
  });

  it('formato do lk: letras e números, de 6 a 32, como o cardápio e o banco aceitam', () => {
    expect(codigoValido('ABCDEF')).toBe(true);
    expect(codigoValido('Qx7Lm2Pa')).toBe(true);
    expect(codigoValido('A'.repeat(32))).toBe(true);
    expect(codigoValido('ABCDE')).toBe(false);
    expect(codigoValido('A'.repeat(33))).toBe(false);
    expect(codigoValido('abc-def')).toBe(false);
    expect(codigoValido('{{lk}}')).toBe(false);
    expect(codigoValido('ÁBCDEF')).toBe(false);
    expect(codigoValido(null)).toBe(false);
  });
});

describe('destino só dentro do cardápio da loja (V33)', () => {
  const destino = (u: string, cardapios = [CARDAPIO]) => destinoNoCardapio(u, cardapios);

  it('aceita o cardápio e as páginas dentro dele, normalizado pelo new URL()', () => {
    expect(destino(CARDAPIO)).toEqual({ ok: true, url: CARDAPIO });
    expect(destino(`${CARDAPIO}/produto/9`)).toEqual({ ok: true, url: `${CARDAPIO}/produto/9` });
    expect(destino(' HTTPS://CARDAPIO.EXEMPLO.COM.BR/misterburgers-centro/ ')).toEqual({ ok: true, url: `${CARDAPIO}/` });
    expect(destino('https://cardapio.exemplo.com.br:443/misterburgers-centro')).toEqual({ ok: true, url: CARDAPIO });
    expect(destino(`${CARDAPIO}/../misterburgers-centro/combo`)).toEqual({ ok: true, url: `${CARDAPIO}/combo` });
    expect(destino(`${CARDAPIO}?mesa=3#cardapio`)).toEqual({ ok: true, url: `${CARDAPIO}?mesa=3#cardapio` });
  });

  it.each([
    ['outro host', 'https://outro.site/misterburgers-centro', 'fora_do_cardapio'],
    ['host do cardápio como subdomínio de outro', 'https://cardapio.exemplo.com.br.outro.site/misterburgers-centro', 'fora_do_cardapio'],
    ['subdomínio parecido', 'https://xcardapio.exemplo.com.br/misterburgers-centro', 'fora_do_cardapio'],
    ['subdomínio do cardápio', 'https://loja.cardapio.exemplo.com.br/misterburgers-centro', 'fora_do_cardapio'],
    ['nome parecido com acento (punycode)', 'https://cardápio.exemplo.com.br/misterburgers-centro', 'fora_do_cardapio'],
    ['@ com usuário', 'https://cardapio.exemplo.com.br@outro.site/misterburgers-centro', 'credenciais'],
    ['usuário e senha', 'https://pessoa:senha@cardapio.exemplo.com.br/misterburgers-centro', 'credenciais'],
    ['barra invertida antes do @', 'https://cardapio.exemplo.com.br\\@outro.site/misterburgers-centro', 'fora_do_cardapio'],
    ['esquema javascript:', 'javascript:alert(1)//cardapio.exemplo.com.br/misterburgers-centro', 'esquema'],
    ['esquema http:', 'http://cardapio.exemplo.com.br/misterburgers-centro', 'esquema'],
    ['esquema data:', 'data:text/html,<script>alert(1)</script>', 'esquema'],
    ['porta diferente', 'https://cardapio.exemplo.com.br:8443/misterburgers-centro', 'fora_do_cardapio'],
    ['caminho vizinho com o mesmo começo', 'https://cardapio.exemplo.com.br/misterburgers-centro-2', 'fora_do_cardapio'],
    ['subir de pasta para outra loja', 'https://cardapio.exemplo.com.br/misterburgers-centro/../outra-loja', 'fora_do_cardapio'],
    ['subir de pasta codificado', 'https://cardapio.exemplo.com.br/misterburgers-centro/%2E%2e/outra-loja', 'fora_do_cardapio'],
    ['caminho de outra caixa', 'https://cardapio.exemplo.com.br/MisterBurgers-Centro', 'fora_do_cardapio'],
    ['sem esquema', '//cardapio.exemplo.com.br/misterburgers-centro', 'invalido'],
    ['texto que não é endereço', 'cardápio da loja', 'invalido'],
    ['destino que já traz o lk', `${CARDAPIO}?lk=OUTRO1234`, 'parametro_de_rastreio'],
    ['destino que já traz UTM (qualquer caixa)', `${CARDAPIO}/p?UTM_SOURCE=x`, 'parametro_de_rastreio'],
    ['destino que já traz id de clique', `${CARDAPIO}?fbclid=IwAR0`, 'parametro_de_rastreio'],
    ['longo demais para o QR', `${CARDAPIO}/${'a'.repeat(1100)}`, 'longo_demais'],
  ])('recusa %s', (_caso, url, motivo) => {
    expect(destino(url)).toEqual({ ok: false, motivo });
  });

  it('cardápio do Regem que não serve (sem https, com usuário, outro esquema) não vira destino', () => {
    expect(cardapioValido(CARDAPIO)?.toString()).toBe(CARDAPIO);
    expect(cardapioValido('http://cardapio.exemplo.com.br/m')).toBeNull();
    expect(cardapioValido('https://a:b@cardapio.exemplo.com.br/m')).toBeNull();
    expect(cardapioValido('javascript:alert(1)')).toBeNull();
    expect(cardapioValido(null)).toBeNull();
    expect(destino('http://cardapio.exemplo.com.br/m', ['http://cardapio.exemplo.com.br/m'])).toEqual({ ok: false, motivo: 'esquema' });
    expect(destino('https://cardapio.exemplo.com.br/m', ['http://cardapio.exemplo.com.br/m'])).toEqual({ ok: false, motivo: 'fora_do_cardapio' });
    expect(destino(CARDAPIO, [])).toEqual({ ok: false, motivo: 'fora_do_cardapio' });
  });

  it('com o cardápio na raiz do site, qualquer página do mesmo site vale', () => {
    expect(destino('https://misterburgers.cardapio.dev/produto/1', ['https://misterburgers.cardapio.dev'])).toEqual({ ok: true, url: 'https://misterburgers.cardapio.dev/produto/1' });
    expect(destino('https://outra.cardapio.dev/', ['https://misterburgers.cardapio.dev/'])).toEqual({ ok: false, motivo: 'fora_do_cardapio' });
  });
});

describe('QR do link com rastreio', () => {
  const url = `${CARDAPIO}?utm_source=meta&utm_medium=paid&utm_campaign=combo-sexta&lk=CS7Q2XK9PA`;

  it('é exatamente a matriz do QR do link (o mesmo lk), em SVG com cores fixas e sem texto dentro', () => {
    const svg = qrSvg(url);
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('fill="#FFFFFF"');
    expect(svg).toContain('fill="#0B0D17"');
    expect(svg).not.toContain('lk=');
    expect(qrSvg(url)).toBe(svg);

    const { data, size } = encode(url, { ecc: 'M', border: 4 });
    expect(svg).toContain(`viewBox="0 0 ${size} ${size}"`);
    const caminho = /d="([^"]*)"/.exec(svg)?.[1] ?? '';
    const desenhada = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
    for (const m of caminho.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      const [x, y, largura] = [Number(m[1]), Number(m[2]), Number(m[3])];
      for (let i = 0; i < largura; i++) desenhada[y]![x + i] = true;
    }
    expect(desenhada).toEqual(data);
    // Margem de 4 módulos em volta (o leitor precisa da borda clara).
    expect(data.slice(0, 4).flat().some(Boolean)).toBe(false);
    expect(data.map((l) => l.slice(0, 4)).flat().some(Boolean)).toBe(false);
  });

  it('links diferentes dão QRs diferentes', () => {
    expect(qrSvg(url)).not.toBe(qrSvg(url.replace('CS7Q2XK9PA', 'CS7Q2XK9PB')));
  });
});

describe('o que o conector guarda do link do anúncio', () => {
  it('Meta: parâmetros de URL e os links do anúncio de link, dos cartões, do vídeo e do criativo dinâmico, sem repetir', () => {
    expect(
      rastreioMeta({
        id: '9001',
        url_tags: ' utm_source=meta&lk=ABCDEF12 ',
        object_url: CARDAPIO,
        object_story_spec: { link_data: { link: CARDAPIO, child_attachments: [{ link: `${CARDAPIO}/combo` }, { link: CARDAPIO }, {}] } },
        asset_feed_spec: { link_urls: [{ website_url: `${CARDAPIO}/b`, url_tags: 'lk=XYZ12345' }] },
      }),
    ).toEqual({
      url_tags: 'utm_source=meta&lk=ABCDEF12',
      destinos: [
        { url: CARDAPIO, url_tags: null },
        { url: `${CARDAPIO}/combo`, url_tags: null },
        { url: `${CARDAPIO}/b`, url_tags: 'lk=XYZ12345' },
      ],
      sufixo: null,
      sufixo_nivel: null,
      modelo: null,
      modelo_nivel: null,
    });
    expect(rastreioMeta({ id: '9002', object_story_spec: { video_data: { call_to_action: { type: 'ORDER_NOW', value: { link: CARDAPIO } } } } }).destinos).toEqual([{ url: CARDAPIO, url_tags: null }]);
    // Formato estranho ou longo demais não vira destino (nem cortado).
    expect(
      rastreioMeta({ id: '9003', url_tags: '', object_story_spec: { link_data: { link: `${CARDAPIO}/${'x'.repeat(2100)}`, child_attachments: 'nada' as never } } }),
    ).toMatchObject({ url_tags: null, destinos: [] });
  });

  it('Google: sufixo e modelo resolvidos cada um pelo nível mais específico que define (anúncio > grupo > campanha > conta)', () => {
    const conta = { finalUrlSuffix: 'lk=CONTA12345', trackingUrlTemplate: '{lpurl}?c=1' };
    expect(resolverUrlGoogle({ conta }, [CARDAPIO])).toEqual({
      url_tags: null,
      destinos: [{ url: CARDAPIO, url_tags: null }],
      sufixo: 'lk=CONTA12345',
      sufixo_nivel: 'conta',
      modelo: '{lpurl}?c=1',
      modelo_nivel: 'conta',
    });
    expect(
      resolverUrlGoogle({ anuncio: { finalUrlSuffix: '' }, grupo: { finalUrlSuffix: 'g=1' }, campanha: { finalUrlSuffix: 'c=1', trackingUrlTemplate: '{lpurl}?t=c' }, conta }, [CARDAPIO]),
    ).toMatchObject({ sufixo: 'g=1', sufixo_nivel: 'grupo', modelo: '{lpurl}?t=c', modelo_nivel: 'campanha' });
    expect(resolverUrlGoogle({ anuncio: { finalUrlSuffix: 'a=1' }, grupo: { finalUrlSuffix: 'g=1' } }, undefined)).toMatchObject({ sufixo: 'a=1', sufixo_nivel: 'anuncio', destinos: [] });
    expect(resolverUrlGoogle({}, [CARDAPIO, CARDAPIO])).toEqual({ url_tags: null, destinos: [{ url: CARDAPIO, url_tags: null }], sufixo: null, sufixo_nivel: null, modelo: null, modelo_nivel: null });
  });
});

describe('conferência do rastreio (função pura)', () => {
  const CAMPANHA = '0199a000-0000-7000-8000-00000000c001';
  const OUTRA = '0199a000-0000-7000-8000-00000000c002';
  const ctx: ContextoConferencia = {
    links: new Map([
      ['LINKCAMP01', { campaignId: CAMPANHA }],
      ['LINKOUTRA2', { campaignId: OUTRA }],
      ['LINKSEMCAMP', { campaignId: null }],
    ]),
    cardapios: [CARDAPIO],
  };
  const lido = (r: Partial<RastreioLido>): RastreioLido => ({
    url_tags: null,
    destinos: [{ url: CARDAPIO, url_tags: null }],
    sufixo: null,
    sufixo_nivel: null,
    modelo: null,
    modelo_nivel: null,
    ...r,
  });
  const meta = (r: Partial<RastreioLido> | null, over: Partial<AnuncioParaConferir> = {}): AnuncioParaConferir => ({
    provider: 'meta_ads',
    campaignId: CAMPANHA,
    externos: { campanha: '1201', grupo: '2301', anuncio: '3401' },
    destinoDoConjunto: 'WEBSITE',
    rastreio: r === null ? null : lido(r),
    ...over,
  });
  const google = (r: Partial<RastreioLido> | null, over: Partial<AnuncioParaConferir> = {}): AnuncioParaConferir => ({
    provider: 'google_ads',
    campaignId: CAMPANHA,
    externos: { campanha: '9001', grupo: '9101', anuncio: '9201' },
    destinoDoConjunto: null,
    rastreio: r === null ? null : lido(r),
    ...over,
  });
  const conferir = (a: AnuncioParaConferir, c: ContextoConferencia = ctx) => conferirAnuncio(a, c);

  it('Meta: o link desta campanha ou os ids dinâmicos nos parâmetros de URL (ou no próprio link) contam', () => {
    expect(conferir(meta({ url_tags: parametrosParaColar('meta_ads', 'LINKCAMP01') }))).toEqual({ status: 'com_rastreio', via: 'link' });
    expect(conferir(meta({ url_tags: 'campaign_id={{campaign.id}}&ad_id={{ad.id}}' }))).toEqual({ status: 'com_rastreio', via: 'ids' });
    expect(conferir(meta({ url_tags: 'campaign_id=%7B%7Bcampaign.id%7D%7D' }))).toEqual({ status: 'com_rastreio', via: 'ids' });
    expect(conferir(meta({ url_tags: 'adgroup_id={{adset.id}}' }))).toEqual({ status: 'com_rastreio', via: 'ids' });
    expect(conferir(meta({ destinos: [{ url: `${CARDAPIO}?utm_source=meta&lk=LINKCAMP01`, url_tags: null }] }))).toEqual({ status: 'com_rastreio', via: 'link' });
    expect(conferir(meta({ url_tags: 'campaign_id=1201&ad_id=3401' }))).toEqual({ status: 'com_rastreio', via: 'ids' });
    // Link do criativo dinâmico com os próprios parâmetros.
    expect(conferir(meta({ destinos: [{ url: CARDAPIO, url_tags: 'lk=LINKCAMP01' }] }))).toEqual({ status: 'com_rastreio', via: 'link' });
    // Link desconhecido, mas com os ids: o motor usa os ids.
    expect(conferir(meta({ url_tags: 'lk=NAOEXISTE1&campaign_id={{campaign.id}}' }))).toEqual({ status: 'com_rastreio', via: 'ids' });
  });

  it('Meta: sem parâmetros, só UTM, nome em outra caixa ou parâmetros da outra plataforma não contam', () => {
    const sem = (reason: string, destino: string | null = CARDAPIO) => ({ status: 'sem_rastreio', reason, destino });
    expect(conferir(meta({}))).toEqual(sem('sem_parametros'));
    expect(conferir(meta({ url_tags: 'utm_source=meta&utm_medium=paid&utm_campaign={{campaign.name}}' }))).toEqual(sem('sem_parametros'));
    expect(conferir(meta({ url_tags: 'LK=LINKCAMP01&CAMPAIGN_ID={{campaign.id}}' }))).toEqual(sem('sem_parametros'));
    // O parâmetro dinâmico só vale escrito como na documentação: com outra caixa ou espaço, ninguém troca.
    expect(conferir(meta({ url_tags: 'campaign_id={{Campaign.Id}}&ad_id={{ ad.id }}' }))).toEqual(sem('sem_parametros'));
    expect(conferir(meta({ url_tags: parametrosParaColar('google_ads', 'NAOEXISTE1').replace('&lk=NAOEXISTE1', '') }))).toEqual(sem('parametros_de_outra_plataforma'));
    expect(conferir(meta({ url_tags: 'lk=LINKOUTRA2&campaign_id={{campaign.id}}' }))).toEqual(sem('link_de_outra_campanha'));
    expect(conferir(meta({ url_tags: 'lk=NAOEXISTE1' }))).toEqual(sem('link_desconhecido'));
    expect(conferir(meta({ url_tags: 'lk=LINKSEMCAMP' }))).toEqual(sem('link_desconhecido'));
    expect(conferir(meta({ url_tags: 'lk={{lk}}' }))).toEqual(sem('sem_parametros'));
    expect(conferir(meta({ url_tags: 'campaign_id=9999&ad_id={{ad.id}}' }))).toEqual(sem('ids_de_outro_anuncio'));
  });

  it('Meta: destino fora do cardápio da loja é o motivo, mesmo com os parâmetros; sem Regem, o destino não é conferido', () => {
    const ifood = 'https://www.ifood.com.br/delivery/rio-de-janeiro-rj/mister-burgers';
    const parametros = parametrosParaColar('meta_ads', 'LINKCAMP01');
    expect(conferir(meta({ url_tags: parametros, destinos: [{ url: ifood, url_tags: null }] }))).toEqual({ status: 'sem_rastreio', reason: 'destino_fora_do_cardapio', destino: ifood });
    // Carrossel com um cartão fora do cardápio: o anúncio inteiro fica sem rastreio.
    expect(
      conferir(meta({ url_tags: parametros, destinos: [{ url: CARDAPIO, url_tags: null }, { url: ifood, url_tags: null }] })),
    ).toMatchObject({ status: 'sem_rastreio', reason: 'destino_fora_do_cardapio' });
    expect(conferir(meta({ url_tags: parametros, destinos: [{ url: ifood, url_tags: null }] }), { ...ctx, cardapios: [] })).toEqual({ status: 'com_rastreio', via: 'link' });
  });

  it('Meta: conjunto ou link que abre conversa não se aplica; sem leitura ou sem link, não verificado', () => {
    expect(conferir(meta({}, { destinoDoConjunto: 'WHATSAPP' }))).toEqual({ status: 'nao_se_aplica', reason: 'mensagens' });
    expect(conferir(meta({}, { destinoDoConjunto: 'ON_AD' }))).toEqual({ status: 'nao_se_aplica', reason: 'sem_site' });
    expect(conferir(meta({}, { destinoDoConjunto: 'APPLINKS_AUTOMATIC' }))).toMatchObject({ status: 'sem_rastreio' });
    expect(conferir(meta({ destinos: [{ url: 'https://api.whatsapp.com/send?phone=5521999998888', url_tags: null }] }, { destinoDoConjunto: null }))).toEqual({
      status: 'nao_se_aplica',
      reason: 'mensagens',
    });
    expect(conferir(meta(null))).toEqual({ status: 'nao_verificavel', reason: 'leitura_pendente' });
    expect(conferir(meta({ destinos: [] }))).toEqual({ status: 'nao_verificavel', reason: 'sem_link' });
    // Publicação existente: sem o link, mas os parâmetros de URL dizem tudo.
    expect(conferir(meta({ destinos: [], url_tags: 'lk=LINKCAMP01' }))).toEqual({ status: 'com_rastreio', via: 'link' });
    expect(conferir(meta({ destinos: [], url_tags: 'utm_source=meta' }))).toEqual({ status: 'sem_rastreio', reason: 'sem_parametros', destino: null });
  });

  it('Google: sufixo do URL final, modelo que começa por {lpurl} e a própria URL final; o resto não conta', () => {
    expect(conferir(google({ sufixo: parametrosParaColar('google_ads', 'LINKCAMP01'), sufixo_nivel: 'conta' }))).toEqual({ status: 'com_rastreio', via: 'link' });
    expect(conferir(google({ sufixo: 'campaign_id={campaignid}&adgroup_id={adgroupid}', sufixo_nivel: 'campanha' }))).toEqual({ status: 'com_rastreio', via: 'ids' });
    expect(conferir(google({ modelo: '{lpurl}?lk=LINKCAMP01', modelo_nivel: 'grupo' }))).toEqual({ status: 'com_rastreio', via: 'link' });
    expect(conferir(google({ destinos: [{ url: `${CARDAPIO}?ad_id={creative}`, url_tags: null }] }))).toEqual({ status: 'com_rastreio', via: 'ids' });
    const sem = (reason: string) => ({ status: 'sem_rastreio', reason, destino: CARDAPIO });
    expect(conferir(google({ sufixo: 'utm_source=google&utm_medium=cpc', sufixo_nivel: 'anuncio' }))).toEqual(sem('sem_parametros'));
    expect(conferir(google({ sufixo: 'campaign_id={{campaign.id}}&ad_id={{ad.id}}', sufixo_nivel: 'conta' }))).toEqual(sem('parametros_de_outra_plataforma'));
    // Modelo de terceiro (o lk vai para o rastreador, não para a página): não conta.
    expect(conferir(google({ modelo: 'https://rastreador.exemplo/?u={lpurl}&lk=LINKCAMP01', modelo_nivel: 'conta' }))).toEqual(sem('sem_parametros'));
    expect(conferir(google({ sufixo: 'lk=LINKOUTRA2', sufixo_nivel: 'conta' }))).toEqual(sem('link_de_outra_campanha'));
    expect(conferir(google({ destinos: [], sufixo: 'lk=LINKCAMP01', sufixo_nivel: 'conta' }))).toEqual({ status: 'nao_verificavel', reason: 'sem_link' });
    expect(conferir(google(null))).toEqual({ status: 'nao_verificavel', reason: 'leitura_pendente' });
  });

  it('tipo de destino da campanha pelos conjuntos: site, mensagens, outro ou desconhecido', () => {
    expect(tipoDeDestino([])).toBe('desconhecido');
    expect(tipoDeDestino([null])).toBe('desconhecido');
    expect(tipoDeDestino(['WEBSITE', 'WHATSAPP'])).toBe('site');
    expect(tipoDeDestino(['WHATSAPP', 'MESSAGING_MESSENGER_WHATSAPP'])).toBe('mensagens');
    expect(tipoDeDestino(['ON_AD'])).toBe('outro');
    expect(tipoDeDestino(['WHATSAPP', 'ON_AD'])).toBe('outro');
    expect(tipoDeDestino(['SHOP_AUTOMATIC'])).toBe('site');
  });

  it('o aviso diz o motivo e o que fazer, com as frases do protótipo P3', () => {
    expect(textoDoAviso('Combo sexta · carrossel', 'meta_ads', { status: 'sem_rastreio', reason: 'sem_parametros', destino: CARDAPIO })).toEqual({
      title: 'O anúncio "Combo sexta · carrossel" está sem o rastreio do Liame',
      detail: 'O link do anúncio não tem os parâmetros do Liame: as vendas dele ficam sem origem.',
      action: 'Copie os parâmetros de um link desta campanha em Links e cupons e cole no campo "Parâmetros de URL" do anúncio.',
    });
    expect(textoDoAviso('Anúncio de pesquisa 3', 'google_ads', { status: 'sem_rastreio', reason: 'sem_parametros', destino: CARDAPIO }).detail).toBe(
      'O URL final deste anúncio está sem o sufixo com os parâmetros do Liame: as vendas dele ficam sem a campanha.',
    );
    expect(textoDoAviso('X', 'meta_ads', { status: 'sem_rastreio', reason: 'destino_fora_do_cardapio', destino: 'https://www.ifood.com.br/x' }).detail).toContain('www.ifood.com.br');
    expect(textoDoAviso('X', 'google_ads', { status: 'nao_verificavel', reason: 'leitura_pendente' }).action).toBe('Nada a fazer agora.');
    // Meta sem link lido e sem parâmetros (anúncio de publicação que já existia): diz o porquê e o que resolve.
    expect(textoDoAviso('Reels de sexta', 'meta_ads', { status: 'nao_verificavel', reason: 'sem_link' })).toEqual({
      title: 'Não deu para conferir o anúncio "Reels de sexta"',
      detail: 'O Liame não achou o link deste anúncio, o que acontece quando ele usa uma publicação que já existia (o link fica na publicação), e o campo "Parâmetros de URL" está vazio.',
      action: 'Se o anúncio leva ao cardápio, copie os parâmetros de um link desta campanha em Links e cupons e cole no campo "Parâmetros de URL" do anúncio: o Liame passa a conferir. Se ele não leva a um site, não precisa de nada.',
    });
    // Com os parâmetros colados, o mesmo anúncio passa a ser conferido só por eles.
    expect(conferir(meta({ destinos: [], url_tags: 'lk=LINKCAMP01&utm_source=meta&utm_medium=paid_social&utm_campaign={{campaign.id}}' })).status).not.toBe('nao_verificavel');
    expect(textoDoAviso('X', 'google_ads', { status: 'nao_verificavel', reason: 'sem_link' }).action).toBe('Confira no Google Ads se o link do anúncio leva os parâmetros do Liame.');
  });
});
