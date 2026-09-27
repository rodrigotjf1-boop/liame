import { afterEach, describe, expect, it, vi } from 'vitest';
import { buscarPagina, comparar, trechos } from '../src/connectors/vigia-trechos.js';
import { etapaDoCalendario } from '../src/worker/vigia.service.js';

// A2 · G8: a página oficial em trechos por título, a comparação entre leituras, o calendário de versões
// e a busca só nos hosts oficiais (inclusive nos redirecionamentos).

const PAGINA = `<!doctype html><html><head><title>x</title><style>.a{}</style><script>var x = 1;</script></head>
<body><header><nav>Menu que muda toda hora</nav></header>
<p>Introdução &amp; avisos</p>
<h2 id="v26">v26.0</h2><p>Lançada em 29/07/2026.</p><!-- comentário -->
<h2>Mudanças</h2><ul><li>Remove <code>estimate_dau</code></li></ul>
<h3>Mudanças</h3><p>Outro trecho com o mesmo título</p>
<footer>Rodapé</footer></body></html>`;

describe('trechos da página', () => {
  it('divide por título, tira o que não é conteúdo e numera título repetido', () => {
    const t = trechos(PAGINA);
    expect(t.map((x) => [x.titulo, x.texto])).toEqual([
      ['(início)', 'x Introdução & avisos'],
      ['v26.0', 'Lançada em 29/07/2026.'],
      ['Mudanças', 'Remove estimate_dau'],
      ['Mudanças (2)', 'Outro trecho com o mesmo título'],
    ]);
    expect(t.every((x) => /^[0-9a-f]{64}$/.test(x.hash))).toBe(true);
    // Menu, script e rodapé mudando não mudam os trechos.
    expect(trechos(PAGINA.replace('Menu que muda toda hora', 'Outro menu').replace('var x = 1', 'var x = 2'))).toEqual(t);
  });

  it('compara: trecho novo, alterado e removido', () => {
    const antes = trechos(PAGINA);
    const depois = trechos(PAGINA.replace('Remove <code>estimate_dau</code>', 'Remove <code>daily_outcomes_curve</code>').replace('<h3>Mudanças</h3><p>Outro trecho com o mesmo título</p>', '<h2>v27.0</h2><p>Nova versão.</p>'));
    expect(comparar(antes, depois).map((m) => [m.mudanca, m.titulo, m.texto])).toEqual([
      ['alterado', 'Mudanças', 'Remove daily_outcomes_curve'],
      ['novo', 'v27.0', 'Nova versão.'],
      ['removido', 'Mudanças (2)', null],
    ]);
    expect(comparar(antes, antes)).toEqual([]);
  });

  it('calendário: 60/30/7 dias antes, na data, D+1 e D+7', () => {
    expect(etapaDoCalendario(61)).toBeNull();
    expect(etapaDoCalendario(60)).toEqual({ kind: 'versao_expirando', stage: '60d' });
    expect(etapaDoCalendario(30)).toEqual({ kind: 'versao_expirando', stage: '30d' });
    expect(etapaDoCalendario(7)).toEqual({ kind: 'versao_expirando', stage: '7d' });
    expect(etapaDoCalendario(1)).toEqual({ kind: 'versao_expirando', stage: '7d' });
    expect(etapaDoCalendario(0)).toEqual({ kind: 'versao_expirada', stage: 'd' });
    expect(etapaDoCalendario(-1)).toEqual({ kind: 'versao_expirada', stage: 'd+1' });
    expect(etapaDoCalendario(-7)).toEqual({ kind: 'versao_expirada', stage: 'd+7' });
  });
});

describe('busca da página oficial', () => {
  afterEach(() => vi.restoreAllMocks());

  it('segue redirecionamento dentro dos hosts oficiais e recusa o que sai deles', async () => {
    const pedidos: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (entrada) => {
      const url = String(entrada);
      pedidos.push(url);
      if (url.endsWith('/antiga')) return new Response(null, { status: 301, headers: { location: '/docs/nova' } });
      if (url.endsWith('/fuga')) return new Response(null, { status: 302, headers: { location: 'https://outro.site/roubo' } });
      return new Response('<h2>ok</h2>', { status: 200, headers: { 'content-type': 'text/html' } });
    });
    expect(await buscarPagina('https://developers.google.com/antiga')).toBe('<h2>ok</h2>');
    expect(pedidos).toEqual(['https://developers.google.com/antiga', 'https://developers.google.com/docs/nova']);
    await expect(buscarPagina('https://developers.google.com/fuga')).rejects.toThrow('fora do Vigia: outro.site');
    await expect(buscarPagina('http://developers.google.com/x')).rejects.toThrow('fora do Vigia');
    await expect(buscarPagina('https://developers.google.com.outro.site/x')).rejects.toThrow('fora do Vigia');
    expect(pedidos).not.toContain('https://outro.site/roubo');
  });

  it('recusa página grande demais e erro HTTP', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (entrada) =>
      String(entrada).endsWith('/grande')
        ? new Response('x', { status: 200, headers: { 'content-length': String(10 * 1024 * 1024) } })
        : new Response('não achei', { status: 404 }),
    );
    await expect(buscarPagina('https://developers.facebook.com/grande')).rejects.toThrow('grande demais');
    await expect(buscarPagina('https://developers.facebook.com/sumiu')).rejects.toThrow('HTTP 404');
  });
});
