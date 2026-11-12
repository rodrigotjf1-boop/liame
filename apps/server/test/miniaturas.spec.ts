import { describe, expect, it } from 'vitest';
import { baixarMiniatura, enderecoDaMeta, LIMITE_DA_MINIATURA, origemDaMiniatura } from '../src/media/miniaturas.js';
import { linkDoAnuncio, tipoDoAnuncio } from '../src/results/anuncio-da-campanha.js';

// A miniatura do anúncio (A3 · I14, parte 1; P44), sem rede e sem banco: de onde o Liame aceita baixar, o que conta como
// a mesma imagem, as recusas do download, o tipo do anúncio e o link do Gerenciador.

describe('a miniatura do anúncio: o download', () => {
  it('só HTTPS, só os domínios da Meta; a mesma imagem é o endereço sem a assinatura', () => {
    expect(enderecoDaMeta('https://scontent.xx.fbcdn.net/v/t45/a.jpg?oh=1')).not.toBeNull();
    expect(enderecoDaMeta('https://external.fbcdn.net/x.jpg')).not.toBeNull();
    expect(enderecoDaMeta('https://scontent.cdninstagram.com/a.jpg')).not.toBeNull();
    expect(enderecoDaMeta('http://scontent.xx.fbcdn.net/a.jpg')).toBeNull();
    expect(enderecoDaMeta('https://fbcdn.net.exemplo.com/a.jpg')).toBeNull();
    expect(enderecoDaMeta('https://exemplofbcdn.net/a.jpg')).toBeNull();
    expect(enderecoDaMeta('não é endereço')).toBeNull();
    expect(enderecoDaMeta(null)).toBeNull();
    expect(origemDaMiniatura(new URL('https://scontent.xx.fbcdn.net/v/t45/a.jpg?oh=1&oe=2'))).toBe('https://scontent.xx.fbcdn.net/v/t45/a.jpg');
  });

  it('recusa a resposta que não é imagem, a grande demais e o endereço fora da Meta; não segue redirecionamento', async () => {
    let pedido: RequestInit | undefined;
    const responde = (corpo: Uint8Array, tipo: string, extra: Record<string, string> = {}) =>
      (async (_url: URL | string, init?: RequestInit) => {
        pedido = init;
        return new Response(corpo, { status: 200, headers: { 'content-type': tipo, ...extra } });
      }) as typeof fetch;
    const url = new URL('https://scontent.xx.fbcdn.net/v/a.jpg');
    expect((await baixarMiniatura(url, responde(new Uint8Array([1, 2, 3]), 'image/jpeg'))).length).toBe(3);
    expect(pedido?.redirect).toBe('error');
    await expect(baixarMiniatura(url, responde(new Uint8Array([1]), 'text/html'))).rejects.toThrow('não é uma imagem');
    await expect(baixarMiniatura(url, responde(new Uint8Array([1]), 'image/jpeg', { 'content-length': String(LIMITE_DA_MINIATURA + 1) }))).rejects.toThrow('maior que o esperado');
    await expect(baixarMiniatura(new URL('https://exemplo.com/a.jpg'), responde(new Uint8Array([1]), 'image/jpeg'))).rejects.toThrow('fora da Meta');
  });
});

describe('a miniatura do anúncio: o que a tela recebe', () => {
  it('o tipo do anúncio e o link do Gerenciador (só na Meta, a conta sem act_)', () => {
    expect(tipoDoAnuncio('meta_ads', 'VIDEO')).toBe('video');
    expect(tipoDoAnuncio('meta_ads', 'PHOTO')).toBe('imagem');
    expect(tipoDoAnuncio('meta_ads', null)).toBe('imagem');
    expect(tipoDoAnuncio('google_ads', 'RESPONSIVE_SEARCH_AD')).toBe('texto');
    expect(tipoDoAnuncio('google_ads', 'RESPONSIVE_DISPLAY_AD')).toBe('imagem');
    expect(linkDoAnuncio('meta_ads', 'act_123', '456')).toBe('https://adsmanager.facebook.com/adsmanager/manage/ads?act=123&selected_ad_ids=456');
    expect(linkDoAnuncio('google_ads', '123', '456')).toBeNull();
  });
});
