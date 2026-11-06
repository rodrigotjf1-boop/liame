import type { ActionResponse, BrandPhoto, PostListResponse, PostResponse } from '@liame/contracts';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fraseDaSituacao, linhaDoCanal, situacaoNaTela, telaDaAgenda } from '@/components/agenda/textos';
import {
  capaDoPost,
  conferidoDoVideo,
  deOndeVemACapa,
  fatoDoVideo,
  PREPARANDO,
  SEM_PREPARO,
  type VideoDasFotos,
  videoSemPreparo,
} from '@/components/agenda/video-do-post';
import { DetalhePost } from '@/components/aprovacoes/detalhe-post';
import { type AcaoDePost, etiquetaDoPost, postApresentado, resultadoDoPost } from '@/components/aprovacoes/post-textos';
import { grupoDe } from '@/components/aprovacoes/textos';

// A6 · Z10, parte 4b: o post com vídeo já feito, em Aprovações e na Agenda (P37, parte B). A capa como foi pedida (uma das
// Fotos, o quadro pelo tempo ou a capa guardada); o fato do vídeo na gaveta e o que foi conferido; a Meta preparando o vídeo
// ("Preparando o vídeo" no cartão e na lista, a frase do canal e o resultado); o vídeo que não terminou de preparar, com a
// nota do "Tentar de novo"; e o cartão da semana com a duração e o Reels.

const uuid = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Quinta, 29/10/2026, 12:00 em São Paulo (15:00 UTC).
const agora = new Date('2026-10-29T15:00:00Z');
const SP = 'America/Sao_Paulo';
const semMarcas = (html: string) => html.replace(/<[^>]+>/g, '');

const base: BrandPhoto = {
  id: uuid(80),
  brand_id: uuid(50),
  product: 'Smash duplo',
  description: 'A chapa e o queijo derretendo',
  width: 1080,
  height: 1920,
  bytes: 18_000_000,
  orientation: 'vertical',
  narrow_for_instagram: false,
  instagram_crop: 'nenhum',
  uploaded_at: '2026-10-28T12:00:00.000Z',
  uploaded_by: null,
  url: 'https://bucket.example/video.mp4?assinado',
  thumbnail_url: 'https://bucket.example/video-mini.jpg?assinado',
  urls_expire_at: '2026-10-29T15:05:00.000Z',
  kind: 'video',
  video: { width: 1080, height: 1920, duration_ms: 24_000, media_type: 'video/mp4', has_audio: true, has_cover: true },
};
const video = (gravado: Partial<NonNullable<BrandPhoto['video']>> = {}): VideoDasFotos => ({ ...base, video: { ...base.video!, ...gravado } }) as VideoDasFotos;
const capaFoto: BrandPhoto = { ...base, id: uuid(81), kind: 'foto_produto', video: null, product: 'Combo sexta', thumbnail_url: 'https://bucket.example/foto-mini.jpg' };

const canal = (channel: string, o: Partial<PostResponse['channels'][number]> = {}): PostResponse['channels'][number] => ({
  channel,
  account_id: uuid(channel === 'instagram' ? 60 : 61),
  account_name: channel === 'instagram' ? '@casabrasa' : 'Casa Brasa',
  text: 'O smash saindo da chapa. Peça pelo link da bio.',
  status: 'aguardando',
  permalink: null,
  error: null,
  published_at: null,
  removed_at: null,
  metrics: null,
  metrics_status: null,
  metrics_read_at: null,
  retry_until: null,
  ...o,
});

type Post = AcaoDePost['post'];
const post = (o: Partial<Post> = {}): Post => ({
  id: uuid(70),
  brand_id: uuid(50),
  kind: 'post',
  photo_id: uuid(80),
  media: 'video',
  cover_photo_id: null,
  cover_offset_ms: null,
  crop_pos: null,
  // Sexta, 30/10, 19:00 em São Paulo.
  publish_at: '2026-10-30T22:00:00.000Z',
  action_id: uuid(1),
  status: 'esperando_aprovacao',
  created_at: '2026-10-29T14:20:00.000Z',
  timezone: SP,
  link: null,
  removal: null,
  channels: [canal('instagram'), canal('facebook')],
  ...o,
});

const pedido = (o: Partial<ActionResponse> = {}, p: Partial<Post> = {}): AcaoDePost =>
  ({
    id: uuid(1),
    tool: 'post_publicar',
    action: 'post.publicar',
    brand_id: uuid(50),
    provider: 'instagram',
    account_id: uuid(60),
    resource_id: `post:${uuid(70)}`,
    params: {},
    risk_level: 'R2',
    budget_impact: 'none',
    value_micros: null,
    current_value_micros: null,
    reserved_micros: 0,
    plan_hash: `a1b2${'0'.repeat(56)}c3d4`,
    mode: 'APPROVAL',
    status: 'aguardando_aprovacao',
    status_reason: null,
    blocked_reason: null,
    attempts: 0,
    next_attempt_at: null,
    undoes: null,
    undone_by: null,
    policy: { allowed: true, mode: 'APPROVAL', violations: [], versions: ['plataforma@10'] },
    approvals: [],
    workflow: null,
    expires_at: '2026-11-01T14:20:00.000Z',
    created_at: '2026-10-29T14:20:00.000Z',
    updated_at: '2026-10-29T14:20:00.000Z',
    requested_by: { id: uuid(2), name: 'Rodrigo' },
    account_name: '@casabrasa',
    campaign: null,
    recommendation: null,
    agent_key: null,
    target: null,
    from: null,
    to: null,
    execution: null,
    message: null,
    review: null,
    post: post(p),
    ...o,
  }) as AcaoDePost;

/** O vídeo que a Meta não terminou de preparar: nenhum canal no ar, os dois com "Tentar de novo" até amanhã. */
const semPreparo = (): Partial<Post> => ({
  status: 'nao_saiu',
  channels: [
    canal('instagram', { status: 'falhou', error: 'A Meta não terminou de preparar o vídeo em 5 minutos.', retry_until: '2026-10-30T15:00:00.000Z' }),
    canal('facebook', { status: 'falhou', error: 'A Meta não terminou de publicar o vídeo na Página do Facebook em 5 minutos: ele pode aparecer lá daqui a pouco.', retry_until: '2026-10-30T15:00:00.000Z' }),
  ],
});

function desenho(a: AcaoDePost, o: { pro?: boolean; foto?: BrandPhoto | null; capa?: BrandPhoto | null } = {}) {
  return semMarcas(
    renderToStaticMarkup(
      createElement(DetalhePost, {
        acao: a,
        grupo: grupoDe(a, agora),
        agora,
        pro: o.pro ?? false,
        podeDecidir: true,
        podeOperar: true,
        podeVerContas: true,
        temApp: true,
        foto: o.foto === undefined ? video() : o.foto,
        capaFoto: o.capa ?? null,
        titulo: createRef<HTMLHeadingElement>(),
        campoCodigo: createRef<HTMLInputElement>(),
        aoVoltar: () => {},
        aoAprovar: async () => ({ ok: true }) as const,
        aoRecusar: async () => ({ ok: true }) as const,
        aoCancelar: async () => ({ ok: true }) as const,
        aoTentarDeNovo: async () => ({ ok: true }) as const,
        aoMudarAHora: async () => ({ ok: true }) as const,
        aoApagar: async () => ({ ok: true }) as const,
        aoFalharImagem: () => {},
      }),
    ),
  );
}

describe('o post com vídeo já feito (A6 · Z10, parte 4b)', () => {
  it('a capa como foi pedida: uma das Fotos, o quadro pelo tempo ou a capa guardada (sem ela, o quadro do meio)', () => {
    const v = video();
    expect(capaDoPost({ cover_photo_id: capaFoto.id, cover_offset_ms: null }, v, capaFoto)).toEqual({ imagem: capaFoto.thumbnail_url });
    expect(capaDoPost({ cover_photo_id: null, cover_offset_ms: 6000 }, v, null)).toEqual({ video: v.url, tempoMs: 6000 });
    expect(capaDoPost({ cover_photo_id: null, cover_offset_ms: null }, v, null)).toEqual({ imagem: v.thumbnail_url });
    expect(capaDoPost({ cover_photo_id: null, cover_offset_ms: null }, video({ has_cover: false }), null)).toEqual({ video: v.url, tempoMs: 12000 });
    // A foto da capa que saiu da lista: a tela mostra a do vídeo (o servidor não deixa o post sair com a capa trocada).
    expect(capaDoPost({ cover_photo_id: capaFoto.id, cover_offset_ms: null }, v, null)).toEqual({ imagem: v.thumbnail_url });
    expect(deOndeVemACapa({ cover_photo_id: capaFoto.id, cover_offset_ms: null }, v, capaFoto)).toBe('uma das Fotos (Combo sexta)');
    expect(deOndeVemACapa({ cover_photo_id: null, cover_offset_ms: 6000 }, v, null)).toBe('o quadro de 0:06');
    expect(deOndeVemACapa({ cover_photo_id: null, cover_offset_ms: null }, v, null)).toBe('a capa guardada com o vídeo');
    expect(deOndeVemACapa({ cover_photo_id: null, cover_offset_ms: null }, video({ has_cover: false }), null)).toBe('o quadro de 0:12');
  });

  it('o fato do vídeo na gaveta e o que foi conferido (em pé, deitado e pequeno para o Reels da Página)', () => {
    const p = { cover_photo_id: null, cover_offset_ms: 6000 };
    expect(fatoDoVideo(p, video(), null)).toBe('Smash duplo, 24 segundos, em pé; a capa: o quadro de 0:06');
    expect(fatoDoVideo(p, video({ width: 1920, height: 1080 }), null)).toBe('Smash duplo, 24 segundos, deitado; a capa: o quadro de 0:06');
    expect(conferidoDoVideo(p, video(), null)).toContain('como a loja gravou: sem edição e sem imagem feita por IA. Está em pé (9:16): sai como Reels. A capa: o quadro de 0:06.');
    expect(conferidoDoVideo(p, video({ width: 1920, height: 1080 }), null)).toContain('Está deitado: na Página, sai como vídeo comum.');
    expect(conferidoDoVideo(p, video({ width: 480, height: 854 }), null)).toContain('É pequeno para o Reels da Página (a partir de 540 × 960): lá, sai como vídeo comum.');
  });

  it('a Meta preparando o vídeo: "Preparando o vídeo" na tela, a frase do canal e da gaveta; o post de foto segue "Publicando"', () => {
    const preparando = post({ status: 'publicando', channels: [canal('instagram', { status: 'publicando' }), canal('facebook', { status: 'publicando' })] });
    expect(situacaoNaTela(preparando)).toEqual({ rotulo: 'Preparando o vídeo', icone: 'clock', tom: 'espera' });
    expect(situacaoNaTela({ status: 'publicando' })).toMatchObject({ rotulo: 'Publicando' });
    expect(linhaDoCanal(preparando.channels[0]!, preparando, SP, '2026-10-29').frase).toBe(PREPARANDO.noCanal);
    expect(linhaDoCanal(preparando.channels[0]!, { ...preparando, media: undefined }, SP, '2026-10-29').frase).toBe('publicando agora.');
    expect(fraseDaSituacao(preparando, SP, '2026-10-29')).toBe(`${PREPARANDO.titulo} ${PREPARANDO.texto}`);
    const a = pedido({ status: 'aprovada', approvals: [] }, { status: 'publicando' });
    expect(etiquetaDoPost(a)).toBe('Preparando o vídeo');
    expect(resultadoDoPost(a, agora)).toMatchObject({ tom: 'espera', titulo: PREPARANDO.titulo, texto: PREPARANDO.texto });
  });

  it('o vídeo que a Meta não terminou de preparar: o resultado e a nota; com um canal no ar, ou sem prazo, segue o de sempre', () => {
    const tenta = (c: PostResponse['channels'][number]) => c.retry_until !== null && new Date(c.retry_until).getTime() > agora.getTime();
    expect(videoSemPreparo(post(semPreparo()), tenta)).toBe(true);
    // O post de foto e o vídeo sem prazo de nova tentativa não são o preparo.
    expect(videoSemPreparo({ ...post(semPreparo()), media: undefined }, tenta)).toBe(false);
    const vencido = post(semPreparo());
    expect(videoSemPreparo({ ...vencido, channels: vencido.channels.map((c) => ({ ...c, retry_until: '2026-10-29T14:00:00.000Z' })) }, tenta)).toBe(false);
    expect(resultadoDoPost(pedido({ status: 'falhou' }, semPreparo()), agora)).toMatchObject({ tom: 'falha', titulo: SEM_PREPARO.titulo, texto: SEM_PREPARO.texto });
    // Saiu num canal: "Saiu em parte", como sempre.
    const emParte = pedido({ status: 'executada' }, { status: 'em_parte', channels: [canal('instagram', { status: 'publicado', published_at: '2026-10-29T14:00:00.000Z' }), semPreparo().channels![1]!] });
    expect(resultadoDoPost(emParte, agora).titulo).toBe('Saiu em parte.');
    // Publicado: o texto, o vídeo e a capa aprovados.
    expect(resultadoDoPost(pedido({ status: 'executada' }, { status: 'publicado' }), agora).texto).toContain('o texto, o vídeo e a capa aprovados');
  });

  it('Aprovações: o título, a frase, o selo do vídeo e o que foi conferido; decidido, o preparo e a nota do "Tentar de novo"', () => {
    const a = pedido();
    expect(postApresentado(a, agora).titulo).toBe('Post com vídeo de amanhã, às 19:00');
    expect(postApresentado(a, agora).resumo).toContain('Você vai publicar um vídeo no Instagram e na Página do Facebook');
    const pendente = desenho(a, { capa: capaFoto });
    expect(pendente).toContain('Vídeo · 0:24');
    expect(pendente).toContain('Está em pé (9:16): sai como Reels. A capa: a capa guardada com o vídeo.');
    expect(pendente).toContain('Cabe no que o Reels aceita: 24 segundos (de 3 a 90)');
    expect(pendente).toContain('Antes de publicar, a Meta prepara o vídeo');
    expect(pendente).toContain('mudar o texto, o vídeo, a capa ou os canais é outro pedido');
    expect(pendente).not.toContain('A foto é uma das Fotos');
    // Sem o vídeo na lista (quem não vê as Fotos): a frase do vídeo, sem o selo e sem as medidas.
    const semVideo = desenho(a, { foto: null });
    expect(semVideo).toContain('O vídeo é um dos vídeos da tela Fotos');
    expect(semVideo).not.toContain('Vídeo · ');
    expect(semVideo).toContain('O vídeo deste post não pôde ser mostrado aqui.');
    // Decidido: a Meta preparando; e o vídeo que não terminou, com a nota.
    expect(desenho(pedido({ status: 'aprovada' }, { status: 'publicando', channels: [canal('instagram', { status: 'publicando' })] }))).toContain(PREPARANDO.titulo);
    const falhou = desenho(pedido({ status: 'falhou' }, semPreparo()));
    expect(falhou).toContain(SEM_PREPARO.titulo);
    expect(falhou).toContain(SEM_PREPARO.nota);
    expect(falhou).toContain('Tentar de novo');
    expect(falhou).toContain('ele pode aparecer lá daqui a pouco');
  });

  it('a semana da Agenda: "Post com vídeo" com a duração, "Reels no Instagram" e a duração na miniatura; sem a lista das Fotos, sem a duração', () => {
    const dados: PostListResponse = {
      enabled: true,
      timezone: SP,
      channels: [
        { channel: 'instagram', accounts: [{ id: uuid(60), name: '@casabrasa' }] },
        { channel: 'facebook', accounts: [{ id: uuid(61), name: 'Casa Brasa' }] },
      ],
      items: [post({ status: 'agendado' })],
      post_link: { ok: true, reason: null },
      pauta: [],
      dates: [],
    };
    const comFotos = telaDaAgenda(dados, '2026-10-26', '2026-10-29', new Map([[base.id, video()]]));
    if (comFotos.tipo !== 'semana') throw new Error('esperava a semana');
    const item = comFotos.dias.flatMap((d) => d.posts)[0]!;
    expect(item.rotulo).toBe('Post com vídeo (24 segundos) de amanhã, às 19:00, Instagram e Página do Facebook: agendado');
    expect(item.canais).toBe('Reels no Instagram · Facebook');
    expect(item.duracao).toBe('0:24');
    const semFotos = telaDaAgenda(dados, '2026-10-26', '2026-10-29');
    if (semFotos.tipo !== 'semana') throw new Error('esperava a semana');
    const sem = semFotos.dias.flatMap((d) => d.posts)[0]!;
    expect(sem.rotulo).toBe('Post com vídeo de amanhã, às 19:00, Instagram e Página do Facebook: agendado');
    expect(sem.duracao).toBeNull();
  });
});
