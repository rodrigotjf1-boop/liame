import { describe, expect, it } from 'vitest';
import { tokenDaPagina } from '../src/connectors/meta/publicacao.js';
import { METRICAS_DA_PAGINA, METRICAS_DO_INSTAGRAM, numerosDaPagina, numerosDoInstagram, proximaLeitura } from '../src/posts/numeros-do-post.js';

// A6 · Z7, parte c, sem banco: a leitura das respostas da Meta (as páginas oficiais conferidas em 29/10/2026: a lista
// `data`, cada métrica com `name` e `values[0].value`, o dado que falta como lista vazia) e a próxima leitura.

const metrica = (name: string, value: unknown) => ({ name, period: 'lifetime', values: [{ value }], title: name, description: name, id: `1/insights/${name}/lifetime` });
const DIA = 86_400_000;

describe('os números de cada post (A6 · Z7, parte c)', () => {
  it('o Instagram: as métricas do post do feed; o que falta fica nulo; a resposta vazia é "ainda sem dado"', () => {
    expect(METRICAS_DO_INSTAGRAM.join(',')).toBe('views,reach,likes,comments,saved,shares');
    expect(numerosDoInstagram({ data: [metrica('views', 1520), metrica('reach', 980), metrica('likes', 87), metrica('comments', 12), metrica('saved', 9), metrica('shares', 4)] })).toEqual({
      views: 1520, reach: 980, likes: 87, comments: 12, shares: 4, saves: 9, clicks: null, reactions: null,
    });
    // O valor pelo `total_value` também vale; o que não é número inteiro e positivo não passa.
    expect(numerosDoInstagram({ data: [{ name: 'views', total_value: { value: 10 } }, metrica('reach', -1), metrica('likes', 'muito')] })).toMatchObject({ views: 10, reach: null, likes: null });
    expect(numerosDoInstagram({ data: [] })).toBeNull();
    expect(numerosDoInstagram({})).toBeNull();
    expect(numerosDoInstagram(null)).toBeNull();
  });

  it('a Página: as vezes vistas, as pessoas, os cliques e as reações somadas por tipo', () => {
    expect(METRICAS_DA_PAGINA.join(',')).toBe('post_media_view,post_total_media_view_unique,post_clicks,post_reactions_by_type_total');
    expect(numerosDaPagina({ data: [metrica('post_media_view', 640), metrica('post_total_media_view_unique', 410), metrica('post_clicks', 35), metrica('post_reactions_by_type_total', { like: 20, love: 5, wow: 1 })] })).toEqual({
      views: 640, reach: 410, likes: null, comments: null, shares: null, saves: null, clicks: 35, reactions: 26,
    });
    expect(numerosDaPagina({ data: [metrica('post_reactions_by_type_total', {})] })).toBeNull();
    expect(numerosDaPagina({ data: [], paging: {} })).toBeNull();
  });

  it('a próxima leitura: em 24 horas, até 30 dias depois de sair; depois, nenhuma', () => {
    const saiu = new Date('2026-10-01T22:00:00Z');
    expect(proximaLeitura(saiu, new Date(saiu.getTime() + 3_600_000))?.toISOString()).toBe(new Date(saiu.getTime() + 3_600_000 + DIA).toISOString());
    // Perto do fim, a última leitura é no fim; depois do fim, nenhuma.
    expect(proximaLeitura(saiu, new Date(saiu.getTime() + 29.5 * DIA))?.toISOString()).toBe(new Date(saiu.getTime() + 30 * DIA).toISOString());
    expect(proximaLeitura(saiu, new Date(saiu.getTime() + 30 * DIA))).toBeNull();
  });

  it('o token da Página diz se quem autorizou pode analisar (ANALYZE), para ler os números', () => {
    const contas = { data: [{ id: '111111111111111', access_token: 'token-a', tasks: ['ANALYZE'] }, { id: '222222222222222', access_token: 'token-b', tasks: ['CREATE_CONTENT'] }] };
    expect(tokenDaPagina(contas, '111111111111111')).toEqual({ token: 'token-a', podePublicar: false, podeAnalisar: true });
    expect(tokenDaPagina(contas, '222222222222222')).toEqual({ token: 'token-b', podePublicar: true, podeAnalisar: false });
  });
});
