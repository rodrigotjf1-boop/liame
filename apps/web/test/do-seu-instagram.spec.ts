import type { InstagramMedia } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CartaoDoInstagram } from '@/components/fotos/aba-do-instagram';
import {
  comMusicaDoInstagram,
  doTipoNoInstagram,
  estadoDaAba,
  fatosDaPublicacao,
  NOTA_DA_MUSICA,
  nomeDaPublicacao,
  notaDaLeitura,
  numeroCurto,
  quantasNoInstagram,
  ROTULOS_DAS_ABAS,
  ROTULOS_DO_TIPO_NO_INSTAGRAM,
  rotuloDoCartaoDoInstagram,
} from '@/components/fotos/do-seu-instagram';
import { GavetaDoInstagram } from '@/components/fotos/gaveta-do-instagram';

// A6 · Z10, parte 5b: "Do seu Instagram" (P37 parte A, aprovado em 04/11/2026; D-A6-71 e D-A6-83), a aba da tela Fotos
// com o que a loja já publicou no Instagram. O que se prova: os rótulos do protótipo (as abas e o filtro), o número
// curto do cartão, o nome e o rótulo de cada publicação (a posição, os números que vieram, a música do Instagram), os
// fatos da gaveta, a nota da leitura, o que a aba diz em cada situação, e o cartão e a gaveta desenhados (a capa no
// Reels, o link para o Instagram, nenhuma ação além da leitura). As horas saem do relógio local (V113).

const local = (mes: number, d: number, h = 19) => new Date(2026, mes - 1, d, h, 0).toISOString();
// Sábado, 07/11/2026, 12:00 local.
const AGORA = new Date(2026, 10, 7, 12, 0);
const semMarcas = (html: string) => html.replace(/<[^>]+>/g, '');

const pub = (o: Partial<InstagramMedia> = {}): InstagramMedia => ({
  id: '17900000000000001',
  kind: 'reels',
  caption: 'Smash duplo saindo da chapa 🔥 Peça pelo link da bio.',
  permalink: 'https://www.instagram.com/reel/abc123/',
  thumbnail_url: 'https://scontent.cdninstagram.com/v/capa.jpg?oe=1',
  has_file: true,
  published_at: local(10, 12),
  metrics: { views: 8420, reach: 6100, likes: 512, comments: 38, saved: 96, shares: 40 },
  metrics_read_at: local(11, 7, 6),
  ...o,
});

describe('"Do seu Instagram": a aba da tela Fotos (A6 · Z10, parte 5b)', () => {
  it('os rótulos do protótipo: as abas e o filtro de tipo', () => {
    expect(ROTULOS_DAS_ABAS.map(([, r]) => r)).toEqual(['Enviados por vocês', 'Do seu Instagram']);
    expect(ROTULOS_DO_TIPO_NO_INSTAGRAM.map(([, r]) => r)).toEqual(['Tudo', 'Reels', 'Posts']);
  });

  it('o número curto do cartão: até 999 inteiro, depois "mil" e "mi" com uma casa (sem arredondar para cima); sem o número, um travessão', () => {
    expect([512, 1000, 1190, 8420, 999_999, 1_250_000, 0].map(numeroCurto)).toEqual(['512', '1 mil', '1,1 mil', '8,4 mil', '999,9 mil', '1,2 mi', '0']);
    expect(numeroCurto(null)).toBe('—');
  });

  it('o filtro: Reels são os Reels; Posts, a foto, o carrossel e o vídeo do feed; e quantas a grade mostra', () => {
    const itens = [pub({ id: '1' }), pub({ id: '2', kind: 'foto' }), pub({ id: '3', kind: 'carrossel' }), pub({ id: '4', kind: 'video' })];
    expect(doTipoNoInstagram(itens, 'tudo').map((p) => p.id)).toEqual(['1', '2', '3', '4']);
    expect(doTipoNoInstagram(itens, 'reels').map((p) => p.id)).toEqual(['1']);
    expect(doTipoNoInstagram(itens, 'posts').map((p) => p.id)).toEqual(['2', '3', '4']);
    expect([quantasNoInstagram([]), quantasNoInstagram([pub()]), quantasNoInstagram(itens)]).toEqual(['Nenhuma publicação', '1 publicação do Instagram', '4 publicações do Instagram']);
  });

  it('o nome e o rótulo do cartão: o tipo e o dia, a música do Instagram, os números que vieram e a posição', () => {
    expect(nomeDaPublicacao(pub(), AGORA)).toBe('Reels de 12/10');
    expect(nomeDaPublicacao(pub({ kind: 'carrossel', published_at: local(11, 7, 9) }), AGORA)).toBe('Post de hoje');
    expect(rotuloDoCartaoDoInstagram(pub(), 1, AGORA)).toBe('Reels de 12/10: 8.420 visualizações, 512 curtidas, 38 comentários, 96 salvamentos; 1º que mais rendeu');
    const musica = pub({ has_file: false, metrics: { views: 5310, reach: null, likes: null, comments: 21, saved: null, shares: null } });
    expect(comMusicaDoInstagram(musica)).toBe(true);
    expect(rotuloDoCartaoDoInstagram(musica, 2, AGORA)).toBe('Reels de 12/10, com música do Instagram: 5.310 visualizações, 21 comentários; 2º que mais rendeu');
    // A foto sem arquivo não é "com música" (só o Reels tem música do Instagram).
    expect(comMusicaDoInstagram(pub({ kind: 'foto', has_file: false }))).toBe(false);
    const semNumeros = pub({ metrics: { views: null, reach: null, likes: null, comments: null, saved: null, shares: null } });
    expect(rotuloDoCartaoDoInstagram(semNumeros, 3, AGORA)).toBe('Reels de 12/10: ainda sem os números; 3º que mais rendeu');
  });

  it('os fatos da gaveta: a data com a hora e cada número por extenso; o que não veio, "ainda sem número"', () => {
    expect(fatosDaPublicacao(pub({ metrics: { views: 8420, reach: null, likes: 512, comments: 38, saved: 96, shares: 40 } }), AGORA)).toEqual([
      ['Publicado', '12/10, 19:00'],
      ['Visualizações', '8.420'],
      ['Alcance', 'ainda sem número'],
      ['Curtidas', '512'],
      ['Comentários', '38'],
      ['Salvamentos', '96'],
      ['Compartilhamentos', '40'],
    ]);
  });

  it('a nota da leitura: a conta, a última leitura e o que a aba é (P37); sem a hora, sem o parêntese', () => {
    expect(notaDaLeitura({ account: { name: '@casabrasa' }, read_at: local(11, 7, 6) }, AGORA)).toBe(
      'Lido da conta @casabrasa, conectada em Contas conectadas (última leitura: hoje, 06:00). O que mais rendeu primeiro, pelas visualizações. Nada aqui foi enviado para o Liame: é o que já está no Instagram. O Liame lê a conta uma vez por dia, e os números chegam com até 48 horas de atraso.',
    );
    expect(notaDaLeitura({ account: { name: '@casabrasa' }, read_at: null }, AGORA)).toMatch(/^Lido da conta @casabrasa, conectada em Contas conectadas\. O que mais rendeu/);
  });

  it('o que a aba diz em cada situação: Contas conectadas quando a conta é o caminho; "Ver de novo" na espera e na falha; com a lista, nada', () => {
    const conta = { name: '@casabrasa' };
    expect(estadoDaAba({ situation: 'sem_conta', account: null })).toMatchObject({ titulo: 'Nenhum Instagram ligado a esta marca', contas: true });
    expect(estadoDaAba({ situation: 'duas_contas', account: null })).toMatchObject({ contas: true });
    expect(estadoDaAba({ situation: 'primeira_leitura', account: conta })).toMatchObject({ deNovo: true, texto: 'A primeira leitura de @casabrasa sai em poucos minutos. Depois, o Liame lê a conta uma vez por dia.' });
    expect(estadoDaAba({ situation: 'sem_permissao', account: conta })).toMatchObject({ contas: true, faixa: 'atencao' });
    expect(estadoDaAba({ situation: 'falhou', account: conta })).toMatchObject({ deNovo: true, faixa: 'perigo' });
    expect(estadoDaAba({ situation: 'desligada', account: null })?.titulo).toBe('“Do seu Instagram” ainda não está ligado para esta empresa');
    expect(estadoDaAba({ situation: 'lido', account: conta })).toBeNull();
    // Situação nova que o servidor venha a mandar (a lista cresce, V23): a aba mostra a lista, sem quebrar.
    expect(estadoDaAba({ situation: 'outra', account: conta })).toBeNull();
  });

  it('o cartão: a miniatura da Meta, a posição, o "play" no Reels, a legenda e os números curtos; a música do Instagram', () => {
    const html = renderToStaticMarkup(createElement(CartaoDoInstagram, { p: pub(), posicao: 1, agora: AGORA, aberta: false, aoAbrir: () => undefined }));
    expect(html).toContain('src="https://scontent.cdninstagram.com/v/capa.jpg?oe=1"');
    expect(html.toLowerCase()).toContain('referrerpolicy="no-referrer"');
    expect(html).toContain('aria-label="Reels de 12/10: 8.420 visualizações, 512 curtidas, 38 comentários, 96 salvamentos; 1º que mais rendeu"');
    expect(html).toContain('aria-haspopup="dialog"');
    const texto = semMarcas(html);
    for (const t of ['1º', 'Reels de 12/10', 'Smash duplo saindo da chapa', '8,4 mil', '512', '38', '96']) expect(texto, t).toContain(t);
    expect(html).toContain('ft-play');
    expect(texto).not.toContain('com música do Instagram');
    const musica = semMarcas(renderToStaticMarkup(createElement(CartaoDoInstagram, { p: pub({ has_file: false }), posicao: 2, agora: AGORA, aberta: false, aoAbrir: () => undefined })));
    expect(musica).toContain('com música do Instagram');
    // O post (não Reels), sem a miniatura: o lugar vazio, sem o "play".
    const post = renderToStaticMarkup(createElement(CartaoDoInstagram, { p: pub({ kind: 'foto', thumbnail_url: null }), posicao: 3, agora: AGORA, aberta: false, aoAbrir: () => undefined }));
    expect(post).not.toContain('<img');
    expect(post).not.toContain('ft-play');
    expect(post).toContain('ig-sem-imagem');
  });

  it('a gaveta: "Do seu Instagram", o nome, a capa, a legenda, os números e "Ver no Instagram"; nenhuma ação além da leitura', () => {
    const gaveta = (p: InstagramMedia) => renderToStaticMarkup(createElement(GavetaDoInstagram, { publicacao: p, agora: AGORA, reserva: { current: null }, aoFechar: () => undefined }));
    const html = gaveta(pub());
    const texto = semMarcas(html);
    for (const t of ['Do seu Instagram', 'Reels de 12/10', 'Smash duplo saindo da chapa', 'Visualizações', '8.420', 'Compartilhamentos', 'Ver no Instagram', 'Fechar']) expect(texto, t).toContain(t);
    expect(html).toContain('href="https://www.instagram.com/reel/abc123/"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('alt="Reels de 12/10: Smash duplo saindo da chapa 🔥 Peça pelo link da bio."');
    for (const t of ['Usar num post de novo', 'Pôr um texto no vídeo', 'Usar como base de um anúncio', NOTA_DA_MUSICA]) expect(texto, t).not.toContain(t);
    // O Reels com música do Instagram: a nota; sem o endereço da publicação, sem o link; sem a miniatura, o aviso.
    expect(semMarcas(gaveta(pub({ has_file: false })))).toContain(NOTA_DA_MUSICA);
    const semNada = gaveta(pub({ kind: 'foto', permalink: null, thumbnail_url: null, caption: '' }));
    expect(semNada).not.toContain('Ver no Instagram');
    expect(semMarcas(semNada)).toContain('A miniatura não veio do Instagram.');
    expect(semNada).toContain('ig-tela--post');
  });
});
