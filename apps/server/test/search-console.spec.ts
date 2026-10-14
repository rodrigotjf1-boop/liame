import { describe, expect, it } from 'vitest';
import { classificar, limiteDoGoogle } from '../src/connectors/cliente-http.js';
import {
  buscasDoGoogle,
  diasDoGoogle,
  ESCOPO_SEARCH_CONSOLE,
  nomeDoSite,
  siteNoCaminho,
  sitesDoGoogle,
  siteValido,
  TAMANHO_DA_BUSCA,
} from '../src/connectors/search-console/search-console.js';

// A6 · Z3 (parte a): o que o Liame tira das respostas do Search Console, sem rede e sem banco (base §3.3, conferida
// nas páginas oficiais em 14/10/2026).

describe('Search Console: os sites', () => {
  it('a permissão é a de só leitura (critério A6-6)', () => {
    expect(ESCOPO_SEARCH_CONSOLE).toBe('https://www.googleapis.com/auth/webmasters.readonly');
  });

  it('o site como o Google escreve: o domínio inteiro ou um começo de endereço, na forma canônica', () => {
    for (const bom of ['sc-domain:exemplo.com', 'sc-domain:mister-burgers.com.br', 'sc-domain:xn--pizzaria-2xa.com', 'https://www.exemplo.com/', 'http://exemplo.com/', 'https://exemplo.com/cardapio/']) {
      expect(siteValido(bom), bom).toBe(bom);
    }
    for (const ruim of [
      '',
      'exemplo.com',
      'sc-domain:',
      'sc-domain:localhost',
      'sc-domain:-exemplo.com',
      'sc-domain:exemplo-.com',
      'sc-domain:exe mplo.com',
      'sc-domain:Exemplo.com',
      'sc-domain:exemplo..com',
      'https://www.exemplo.com',
      'https://www.exemplo.com/?q=1',
      'https://www.exemplo.com/#x',
      'https://pessoa:senha@exemplo.com/',
      'ftp://exemplo.com/',
      'javascript:alert(1)//',
      'https://WWW.exemplo.com/',
      `https://exemplo.com/${'a'.repeat(2048)}/`,
      42,
      null,
    ]) {
      expect(siteValido(ruim), String(ruim)).toBeNull();
    }
  });

  it('o nome na tela e o site no caminho do endereço', () => {
    expect(nomeDoSite('sc-domain:exemplo.com')).toBe('exemplo.com');
    expect(nomeDoSite('https://www.exemplo.com/')).toBe('www.exemplo.com');
    expect(nomeDoSite('https://exemplo.com/cardapio/')).toBe('exemplo.com/cardapio');
    // Codificado inteiro, como o exemplo oficial do `searchAnalytics.query`.
    expect(siteNoCaminho('https://www.exemplo.com/')).toBe('https%3A%2F%2Fwww.exemplo.com%2F');
    expect(siteNoCaminho('sc-domain:exemplo.com')).toBe('sc-domain%3Aexemplo.com');
  });

  it('a lista: só os sites que a empresa pode ler, nas duas grafias do Google; o sem verificação, o fora do formato e o repetido ficam de fora', () => {
    const corpo = {
      siteEntry: [
        { siteUrl: 'sc-domain:misterburgers.com.br', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://cardapio.misterburgers.com.br/', permissionLevel: 'SITE_FULL_USER' },
        { siteUrl: 'https://blog.misterburgers.com.br/', permissionLevel: 'siteRestrictedUser' },
        { siteUrl: 'https://outro.exemplo.com/', permissionLevel: 'siteUnverifiedUser' },
        { siteUrl: 'https://outro2.exemplo.com/', permissionLevel: 'SITE_UNVERIFIED_USER' },
        { siteUrl: 'https://semnivel.exemplo.com/' },
        { siteUrl: 'semformato', permissionLevel: 'siteOwner' },
        { siteUrl: 'sc-domain:misterburgers.com.br', permissionLevel: 'siteFullUser' },
        null,
      ],
    };
    expect(sitesDoGoogle(corpo)).toEqual([
      { site: 'sc-domain:misterburgers.com.br', nome: 'misterburgers.com.br', permissao: 'dono' },
      { site: 'https://cardapio.misterburgers.com.br/', nome: 'cardapio.misterburgers.com.br', permissao: 'completo' },
      { site: 'https://blog.misterburgers.com.br/', nome: 'blog.misterburgers.com.br', permissao: 'restrito' },
    ]);
    // Sem site nenhum, a resposta vem sem a lista.
    expect(sitesDoGoogle({})).toEqual([]);
    expect(sitesDoGoogle(null)).toEqual([]);
    expect(sitesDoGoogle({ siteEntry: 'x' })).toEqual([]);
  });
});

describe('Search Console: as buscas', () => {
  const JANELA = { inicio: '2026-10-01', fim: '2026-10-07' };

  it('por dia: só os dias da janela, em ordem, sem inventar o dia que não veio; a contagem que não confere fica de fora', () => {
    const corpo = {
      rows: [
        { keys: ['2026-10-03'], clicks: 12, impressions: 340, ctr: 0.035, position: 7.4 },
        { keys: ['2026-10-01'], clicks: 0, impressions: 15, ctr: 0, position: 18.2 },
        // Fora da janela, repetido, data impossível, sem chave e com contagem que não confere.
        { keys: ['2026-09-30'], clicks: 3, impressions: 30, position: 5 },
        { keys: ['2026-10-03'], clicks: 99, impressions: 999, position: 1 },
        { keys: ['2026-10-32'], clicks: 1, impressions: 1, position: 1 },
        { clicks: 1, impressions: 1, position: 1 },
        { keys: ['2026-10-04'], clicks: 5, impressions: 2, position: 3 },
        { keys: ['2026-10-05'], clicks: -1, impressions: 10, position: 3 },
        { keys: ['2026-10-06'], clicks: 'dez', impressions: 10, position: 3 },
        // A posição fora do que o Google usa (abaixo de 1) vira nula; a contagem fica.
        { keys: ['2026-10-07'], clicks: 2, impressions: 20, position: 0 },
      ],
    };
    expect(diasDoGoogle(corpo, JANELA)).toEqual([
      { dia: '2026-10-01', cliques: 0, vezes: 15, posicao: 18.2 },
      { dia: '2026-10-03', cliques: 12, vezes: 340, posicao: 7.4 },
      { dia: '2026-10-07', cliques: 2, vezes: 20, posicao: null },
    ]);
    // Sem nenhuma vez no dia, não há posição.
    expect(diasDoGoogle({ rows: [{ keys: ['2026-10-02'], clicks: 0, impressions: 0, position: 4 }] }, JANELA)).toEqual([{ dia: '2026-10-02', cliques: 0, vezes: 0, posicao: null }]);
    expect(diasDoGoogle({}, JANELA)).toEqual([]);
  });

  it('por busca: na ordem do Google, até o máximo; a vazia, a comprida demais e a repetida ficam de fora, sem cortar o texto', () => {
    const comprida = 'b'.repeat(TAMANHO_DA_BUSCA + 1);
    const corpo = {
      rows: [
        { keys: ['  hamburgueria perto de mim '], clicks: 40, impressions: 900, position: 3.2 },
        { keys: [''], clicks: 30, impressions: 300, position: 2 },
        { keys: [comprida], clicks: 20, impressions: 200, position: 2 },
        { keys: ['mister burgers'], clicks: 18, impressions: 60, position: 1.1 },
        { keys: ['hamburgueria perto de mim'], clicks: 5, impressions: 50, position: 4 },
        { keys: ['smash burger centro'], clicks: 3, impressions: 120, position: 9.8 },
        // O caractere nulo o banco não guarda em texto: a busca fica de fora.
        { keys: ['burger\u0000lapa'], clicks: 2, impressions: 90, position: 7 },
        { keys: ['delivery lapa'], clicks: 1, impressions: 80, position: 12 },
      ],
    };
    expect(buscasDoGoogle(corpo, 3)).toEqual([
      { busca: 'hamburgueria perto de mim', cliques: 40, vezes: 900, posicao: 3.2 },
      { busca: 'mister burgers', cliques: 18, vezes: 60, posicao: 1.1 },
      { busca: 'smash burger centro', cliques: 3, vezes: 120, posicao: 9.8 },
    ]);
    expect(buscasDoGoogle(corpo, 100)).toHaveLength(4);
    expect(buscasDoGoogle({ rows: 'x' }, 10)).toEqual([]);
  });
});

describe('Search Console: a cota no formato antigo do Google', () => {
  it('o 403 com motivo de cota é limite, com a espera de cada motivo; o de permissão não é', () => {
    const erro = (reason: unknown) => ({ code: 403, message: 'x', errors: [{ domain: 'usageLimits', reason }] });
    expect(limiteDoGoogle(erro('quotaExceeded'))).toEqual({ motivo: 'quotaExceeded', esperarMs: 15 * 60_000 });
    expect(limiteDoGoogle(erro('dailyLimitExceeded'))).toEqual({ motivo: 'dailyLimitExceeded', esperarMs: 3_600_000 });
    expect(limiteDoGoogle(erro('rateLimitExceeded'))).toEqual({ motivo: 'rateLimitExceeded', esperarMs: 60_000 });
    expect(limiteDoGoogle(erro('userRateLimitExceeded'))).toEqual({ motivo: 'userRateLimitExceeded', esperarMs: 60_000 });
    for (const outro of ['insufficientPermissions', 'forbidden', 'toString', '__proto__', 42, null]) expect(limiteDoGoogle(erro(outro)), String(outro)).toBeNull();
    expect(limiteDoGoogle({ code: 403, message: 'x' })).toBeNull();
    expect(limiteDoGoogle({ errors: 'x' })).toBeNull();
  });

  it('só no Search Console: nos outros conectores do Google, o mesmo 403 segue como permissão', () => {
    const corpo = { error: { code: 403, message: 'x', errors: [{ domain: 'usageLimits', reason: 'quotaExceeded' }] } };
    expect(classificar('search_console', 403, corpo, new Headers(), null)).toMatchObject({ tipo: 'limite', esperarMs: 15 * 60_000, codigoProvider: 'quotaExceeded' });
    for (const p of ['ga4', 'google_ads', 'google_business']) expect(classificar(p, 403, corpo, new Headers(), null).tipo, p).toBe('permissao');
    // O Retry-After do Google, quando vem, manda mais que a espera do motivo.
    expect(classificar('search_console', 403, corpo, new Headers({ 'retry-after': '30' }), null).esperarMs).toBe(30_000);
  });
});
