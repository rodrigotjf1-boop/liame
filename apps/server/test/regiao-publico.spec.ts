import { describe, expect, it } from 'vitest';
import {
  cidadesDevidas,
  cidadesDosSeguidores,
  ehOMunicipio,
  inicioDoDiaEmSegundos,
  janelaEmSegundos,
  type LinhaDoPublico,
  nomeDaCidade,
  retratoDoPublico,
  seguiramEDeixaram,
  seguidoresDoNo,
  somaDaPagina,
  toquesDoPerfil,
} from '../src/regiao/publico-nas-redes.js';

// O público nas redes (plano da região, R4, parte 3; D-RG-40 a D-RG-43): as respostas da Graph API (o formato da
// referência do Instagram e da Página, lida em 12/11/2026) e o bloco do retrato de Sua região.

const totalValue = (name: string, chave: string, valores: Record<string, unknown>) => ({
  data: [
    {
      name,
      period: 'day',
      total_value: { value: 0, breakdowns: [{ dimension_keys: [chave], results: Object.entries(valores).map(([k, v]) => ({ dimension_values: [k], value: v })) }] },
      id: `x/insights/${name}/day`,
    },
  ],
});

describe('as respostas da Meta', () => {
  it('os seguidores do nó; fora do formato, nulo', () => {
    expect(seguidoresDoNo({ followers_count: 4812, id: '1' })).toBe(4812);
    expect(seguidoresDoNo({ followers_count: '86' })).toBe(86);
    expect(seguidoresDoNo({ id: '1' })).toBeNull();
    expect(seguidoresDoNo({ followers_count: -1 })).toBeNull();
    expect(seguidoresDoNo(null)).toBeNull();
  });

  it('quem seguiu e quem deixou de seguir (follow_type); sem a métrica (menos de 100 seguidores), nulo', () => {
    expect(seguiramEDeixaram(totalValue('follows_and_unfollows', 'follow_type', { FOLLOWER: 287, NON_FOLLOWER: '73', UNKNOWN: 4 }))).toEqual({ seguiram: 287, deixaram: 73 });
    expect(seguiramEDeixaram(totalValue('follows_and_unfollows', 'follow_type', {}))).toEqual({ seguiram: 0, deixaram: 0 });
    expect(seguiramEDeixaram({ data: [] })).toBeNull();
    expect(seguiramEDeixaram(null)).toBeNull();
  });

  it('os toques no perfil por botão: como chegar, ligar, mensagem e o resto', () => {
    expect(toquesDoPerfil(totalValue('profile_links_taps', 'contact_button_type', { DIRECTION: 98, CALL: 31, TEXT: 17, EMAIL: 2, BOOK_NOW: 1, UNDEFINED: 'x' }))).toEqual({
      como_chegar: 98,
      ligar: 31,
      mensagem: 17,
      outros: 3,
    });
  });

  it('as cidades dos seguidores, da maior para a menor, sem a vazia nem a zerada, até 45', () => {
    const muitas = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`Cidade ${String(i).padStart(2, '0')}, RJ`, 100 + i]));
    const cidades = cidadesDosSeguidores(totalValue('follower_demographics', 'city', { ...muitas, '': 9, 'Zerada, RJ': 0 }))!;
    expect(cidades).toHaveLength(45);
    expect(cidades[0]).toEqual({ cidade: 'Cidade 49, RJ', seguidores: 149 });
    expect(cidadesDosSeguidores({ data: [] })).toBeNull();
  });

  it('a soma de uma métrica diária da Página; a que não veio é nula', () => {
    const corpo = {
      data: [
        { name: 'page_daily_follows_unique', period: 'day', values: [{ value: 3 }, { value: 5 }, { value: null }] },
        { name: 'page_views_total', period: 'day', values: [{ value: '600' }, { value: 604 }] },
      ],
    };
    expect(somaDaPagina(corpo, 'page_daily_follows_unique')).toBe(8);
    expect(somaDaPagina(corpo, 'page_views_total')).toBe(1204);
    expect(somaDaPagina(corpo, 'page_daily_unfollows_unique')).toBeNull();
    expect(somaDaPagina(null, 'page_views_total')).toBeNull();
  });
});

describe('a janela e a cidade', () => {
  it('o começo do dia no fuso, em segundos (Brasília, -3 h)', () => {
    expect(inicioDoDiaEmSegundos('2026-10-15', 'America/Sao_Paulo')).toBe(Date.parse('2026-10-15T03:00:00Z') / 1000);
    expect(inicioDoDiaEmSegundos('2026-10-15', 'UTC')).toBe(Date.parse('2026-10-15T00:00:00Z') / 1000);
    // Deslocamento positivo e com minutos (+05:30).
    expect(inicioDoDiaEmSegundos('2026-10-15', 'Asia/Kolkata')).toBe(Date.parse('2026-10-14T18:30:00Z') / 1000);
    // As 4 semanas de 15/10 a 11/11: até o começo de 12/11.
    expect(janelaEmSegundos({ inicio: '2026-10-15', fim: '2026-11-11' }, 'America/Sao_Paulo')).toEqual({
      since: Date.parse('2026-10-15T03:00:00Z') / 1000,
      until: Date.parse('2026-11-12T03:00:00Z') / 1000,
    });
  });

  it('a cidade sem o estado e o município da loja sem acento nem caixa', () => {
    expect(nomeDaCidade('Rio de Janeiro, Rio de Janeiro')).toBe('Rio de Janeiro');
    expect(nomeDaCidade('Niterói')).toBe('Niterói');
    expect(ehOMunicipio('Niteroi, Rio de Janeiro', 'Niterói')).toBe(true);
    expect(ehOMunicipio('São Gonçalo, Rio de Janeiro', 'Niterói')).toBe(false);
    expect(ehOMunicipio('Niterói, RJ', null)).toBe(false);
  });

  it('a cidade é relida uma vez por semana', () => {
    const agora = new Date('2026-11-12T15:00:00Z');
    expect(cidadesDevidas(null, agora)).toBe(true);
    expect(cidadesDevidas(new Date('2026-11-06T15:00:00Z'), agora)).toBe(false);
    // A leitura diária pode sair um pouco mais cedo no 7º dia: ainda conta.
    expect(cidadesDevidas(new Date('2026-11-05T15:30:00Z'), agora)).toBe(true);
  });
});

describe('o bloco do retrato (D-RG-40 a D-RG-43)', () => {
  const linha = (o: Partial<LinhaDoPublico>): LinhaDoPublico => ({
    provider: 'instagram',
    name: '@casabrasa',
    day_from: '2026-10-15',
    day_to: '2026-11-11',
    followers: '4812',
    follows: '287',
    unfollows: '73',
    taps: { como_chegar: 98, ligar: 31, mensagem: 17, outros: 0 },
    page_views: null,
    cities: [
      { cidade: 'Rio de Janeiro, Rio de Janeiro', seguidores: 3417 },
      { cidade: 'Duque de Caxias, Rio de Janeiro', seguidores: 289 },
      { cidade: 'Niterói, Rio de Janeiro', seguidores: 192 },
      { cidade: 'São Gonçalo, Rio de Janeiro', seguidores: 144 },
      { cidade: 'Nova Iguaçu, Rio de Janeiro', seguidores: 96 },
      { cidade: 'Belford Roxo, Rio de Janeiro', seguidores: 50 },
    ],
    cities_read_at: '2026-11-12T15:00:00Z',
    read_at: '2026-11-12T15:00:00Z',
    base: null,
    ...o,
  });

  it('sem rede conectada, `sem_redes`; conectada sem leitura, `lendo`', () => {
    expect(retratoDoPublico([], 'Rio de Janeiro')).toEqual({ status: 'sem_redes', publico: null });
    expect(retratoDoPublico([linha({ read_at: null, day_from: null, day_to: null })], 'Rio de Janeiro')).toEqual({ status: 'lendo', publico: null });
  });

  it('o Instagram e a Página: os seguidores e a mudança, os toques, as visitas e as 5 maiores cidades com o município da loja', () => {
    const r = retratoDoPublico(
      [
        linha({}),
        linha({ provider: 'facebook_page', name: 'Casa Brasa', followers: '2356', follows: '25', unfollows: '7', taps: null, page_views: '1204', cities: null, cities_read_at: null, read_at: '2026-11-12T14:00:00Z' }),
      ],
      'Rio de Janeiro',
    );
    expect(r.status).toBe('disponivel');
    expect(r.publico).toMatchObject({
      from: '2026-10-15',
      to: '2026-11-11',
      instagram: {
        name: '@casabrasa',
        followers: 4812,
        follows: 287,
        unfollows: 73,
        followers_change: 214,
        taps: { total: 146, directions: 98, call: 31, message: 17, other: 0 },
        cities_status: 'disponivel',
      },
      page: { name: 'Casa Brasa', followers: 2356, followers_change: 18, views: 1204, read_at: '2026-11-12T14:00:00.000Z' },
    });
    expect(r.publico!.instagram!.cities).toEqual([
      { name: 'Rio de Janeiro', full_name: 'Rio de Janeiro, Rio de Janeiro', followers: 3417, followers_pct: 71, store_city: true },
      { name: 'Duque de Caxias', full_name: 'Duque de Caxias, Rio de Janeiro', followers: 289, followers_pct: 6, store_city: false },
      { name: 'Niterói', full_name: 'Niterói, Rio de Janeiro', followers: 192, followers_pct: 4, store_city: false },
      { name: 'São Gonçalo', full_name: 'São Gonçalo, Rio de Janeiro', followers: 144, followers_pct: 3, store_city: false },
      { name: 'Nova Iguaçu', full_name: 'Nova Iguaçu, Rio de Janeiro', followers: 96, followers_pct: 2, store_city: false },
    ]);
  });

  it('com menos de 100 seguidores: sem quem seguiu, a mudança pela série do Liame, e a cidade não vem', () => {
    const r = retratoDoPublico([linha({ followers: '86', follows: null, unfollows: null, cities: null, base: '77' })], 'Rio de Janeiro');
    expect(r.publico).toMatchObject({ instagram: { followers: 86, follows: null, followers_change: 9, cities_status: 'poucos_seguidores', cities: [] }, page: null });
    // Sem a série no começo da janela, a mudança não é inventada.
    expect(retratoDoPublico([linha({ followers: '86', follows: null, unfollows: null, cities: null })], null).publico!.instagram!.followers_change).toBeNull();
  });

  it('a cidade ainda não lida: `lendo`', () => {
    expect(retratoDoPublico([linha({ cities: null, cities_read_at: null })], 'Rio de Janeiro').publico!.instagram).toMatchObject({ cities_status: 'lendo', cities: [] });
  });
});
