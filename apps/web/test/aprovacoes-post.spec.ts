import type { ActionResponse, BrandPhoto } from '@liame/contracts';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DetalhePost } from '@/components/aprovacoes/detalhe-post';
import {
  type AcaoDePost,
  canaisDaLista,
  ehPedidoDePost,
  etiquetaDoPost,
  horaJaPassou,
  MOTIVOS_DO_POST,
  ondeSai,
  postApresentado,
  quandoDoPost,
  resultadoDoPost,
} from '@/components/aprovacoes/post-textos';
import { grupoDe } from '@/components/aprovacoes/textos';

// O post em Aprovações (A6 · Z5c, parte 4; mockups/prototipo-post.html, P19): o título e a hora no fuso da empresa, a
// frase do modo simples, a etiqueta da lista, o resultado depois de decidido e o detalhe desenhado para quem decide,
// para quem só acompanha e depois da decisão (cancelar o agendado, o que saiu em cada canal).

const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Quinta, 29/10/2026, 12:00 em São Paulo (15:00 UTC).
const agora = new Date('2026-10-29T15:00:00Z');
const SP = 'America/Sao_Paulo';
const semMarcas = (html: string) => html.replace(/<[^>]+>/g, '');

type Post = AcaoDePost['post'];
const post = (o: Partial<Post> = {}): Post => ({
  id: uuid(70),
  brand_id: uuid(50),
  kind: 'post',
  photo_id: uuid(80),
  crop_pos: null,
  // Sexta, 30/10, 19:00 em São Paulo.
  publish_at: '2026-10-30T22:00:00.000Z',
  action_id: uuid(1),
  status: 'esperando_aprovacao',
  created_at: '2026-10-29T14:20:00.000Z',
  timezone: SP,
  link: null,
  channels: [
    { channel: 'instagram', account_id: uuid(60), account_name: '@casabrasa', text: 'Sexta é dia de combo. Peça pelo link da bio.', status: 'aguardando', permalink: null, error: null, published_at: null, metrics: null, metrics_status: null, metrics_read_at: null, retry_until: null },
    { channel: 'facebook', account_id: uuid(61), account_name: 'Casa Brasa', text: 'Sexta é dia de combo: smash, batata e refrigerante.', status: 'aguardando', permalink: null, error: null, published_at: null, metrics: null, metrics_status: null, metrics_read_at: null, retry_until: null },
  ],
  ...o,
});

const pedido = (o: Partial<ActionResponse> = {}): AcaoDePost =>
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
    post: post(),
    ...o,
  }) as AcaoDePost;

const aprovacao = [{ approved_by: uuid(2), approver_name: 'Rodrigo', approver_role: 'dono', sufficient: true, current_plan: true, created_at: '2026-10-29T15:05:00.000Z' }];
const foto: BrandPhoto = {
  id: uuid(80),
  brand_id: uuid(50),
  status: 'pronta',
  url: 'https://fotos.exemplo/f80.jpg',
  width: 1080,
  height: 1080,
  product: 'Combo sexta',
  description: 'O combo de sexta na mesa',
} as unknown as BrandPhoto;

function desenho(a: AcaoDePost, o: { pro?: boolean; podeDecidir?: boolean; podeOperar?: boolean; podeVerContas?: boolean; foto?: BrandPhoto | null; agora?: Date } = {}) {
  const quando = o.agora ?? agora;
  return renderToStaticMarkup(
    createElement(DetalhePost, {
      acao: a,
      grupo: grupoDe(a, quando),
      agora: quando,
      pro: o.pro ?? false,
      podeDecidir: o.podeDecidir ?? true,
      podeOperar: o.podeOperar ?? true,
      podeVerContas: o.podeVerContas ?? true,
      temApp: true,
      foto: o.foto === undefined ? foto : o.foto,
      titulo: createRef<HTMLHeadingElement>(),
      campoCodigo: createRef<HTMLInputElement>(),
      aoVoltar: () => {},
      aoAprovar: async () => ({ ok: true }) as const,
      aoRecusar: async () => ({ ok: true }) as const,
      aoCancelar: async () => ({ ok: true }) as const,
      aoFalharImagem: () => {},
    }),
  );
}

describe('pedido de post: o que é e como aparece na lista', () => {
  it('é pedido de post o de publicar que traz o post; sem o post (saiu do Liame) ou de outra ferramenta, não', () => {
    expect(ehPedidoDePost(pedido())).toBe(true);
    expect(ehPedidoDePost(pedido({ post: null }))).toBe(false);
    expect(ehPedidoDePost(pedido({ tool: 'mensagem_disparar' }))).toBe(false);
  });

  it('o título e a frase: a hora no fuso da empresa, e onde sai com a preposição de cada canal', () => {
    const p = postApresentado(pedido(), agora);
    expect(p.titulo).toBe('Post de amanhã, às 19:00');
    expect(p.resumo).toBe('Você vai publicar um post no Instagram e na Página do Facebook, amanhã, às 19:00. Ele é público e sai em nome da empresa. Se você aprovar, o Liame publica na hora marcada.');
    expect(p.depoisDeAprovar).toBe('O post sai amanhã, às 19:00.');
    expect(ondeSai(post({ channels: [post().channels[1]!] }))).toBe('na Página do Facebook');
    expect(canaisDaLista(post())).toBe('Instagram · Página do Facebook');
  });

  it('o mesmo instante em outro fuso: Lisboa mostra a hora de Lisboa (o fuso é o da empresa, não o do navegador)', () => {
    const lisboa = post({ timezone: 'Europe/Lisbon' });
    expect(quandoDoPost(lisboa, agora)).toBe('amanhã, às 22:00');
    // Na virada do dia: 02:30 UTC de sábado ainda é sexta, 23:30, em São Paulo.
    expect(quandoDoPost(post({ publish_at: '2026-10-31T02:30:00.000Z' }), agora)).toBe('amanhã, às 23:30');
    expect(quandoDoPost(post({ publish_at: '2026-11-03T12:00:00.000Z' }), agora)).toBe('terça, 03/11, às 09:00');
  });

  it('a hora que já passou: aprovado agora, sai em seguida (D-A6-33)', () => {
    const tarde = pedido({ post: post({ publish_at: '2026-10-29T14:00:00.000Z' }) });
    expect(horaJaPassou(tarde.post, agora)).toBe(true);
    expect(postApresentado(tarde, agora).depoisDeAprovar).toBe('O post sai em seguida (entre 8h e 22h, no fuso da empresa).');
    expect(horaJaPassou(post(), agora)).toBe(false);
  });

  it('a etiqueta do decidido é a situação do post, como na Agenda', () => {
    expect(etiquetaDoPost(pedido({ post: post({ status: 'agendado' }) }))).toBe('Agendado');
    expect(etiquetaDoPost(pedido({ post: post({ status: 'em_parte' }) }))).toBe('Saiu em parte');
    expect(etiquetaDoPost(pedido({ post: post({ status: 'expirado' }) }))).toBe('Expirou sem aprovação');
  });

  it('os motivos da recusa são os do P19', () => {
    expect(MOTIVOS_DO_POST).toEqual(['Quero outro texto', 'Quero outra foto', 'Não é o momento']);
  });
});

describe('pedido de post: o resultado depois da decisão', () => {
  it('recusado, com quem e o motivo; cancelado e expirado: nada foi publicado', () => {
    const recusado = pedido({ status: 'cancelada', status_reason: 'recusada por Rodrigo: Quero outra foto', post: post({ status: 'recusado' }) });
    expect(resultadoDoPost(recusado, agora)).toMatchObject({ titulo: 'Recusado.', texto: 'Por Rodrigo: “Quero outra foto”. Nada foi publicado.' });
    expect(resultadoDoPost(pedido({ status: 'cancelada', status_reason: 'cancelada por quem opera', post: post({ status: 'cancelado' }) }), agora).texto).toBe('Nada foi publicado.');
    expect(resultadoDoPost(pedido({ status: 'expirada', post: post({ status: 'expirado' }) }), agora).titulo).toBe('Expirou sem aprovação.');
  });

  it('agendado: quem aprovou e a hora da aprovação no fuso da empresa, quando sai e em quantos canais', () => {
    const r = resultadoDoPost(pedido({ status: 'aprovada', approvals: aprovacao, post: post({ status: 'agendado' }) }), agora);
    expect(r).toMatchObject({ tom: 'espera', titulo: 'Aprovado por Rodrigo às 12:05. Sai amanhã, às 19:00, nos dois canais.' });
    const so = resultadoDoPost(pedido({ status: 'aprovada', approvals: aprovacao, post: post({ status: 'agendado', channels: [post().channels[0]!] }) }), agora);
    expect(so.titulo).toBe('Aprovado por Rodrigo às 12:05. Sai amanhã, às 19:00, no Instagram.');
  });

  it('publicado, em parte e não saiu: o tom de cada um', () => {
    expect(resultadoDoPost(pedido({ status: 'executada', post: post({ status: 'publicado' }) }), agora).tom).toBe('ok');
    expect(resultadoDoPost(pedido({ status: 'falhou', post: post({ status: 'em_parte' }) }), agora).tom).toBe('falha');
    expect(resultadoDoPost(pedido({ status: 'falhou', post: post({ status: 'nao_saiu' }) }), agora).titulo).toBe('Não saiu.');
  });
});

describe('pedido de post: o detalhe', () => {
  it('esperando, no modo simples: a frase, "Post público", a prévia com os dois canais, o que foi conferido e a decisão', () => {
    const html = desenho(pedido());
    const texto = semMarcas(html);
    expect(texto).toContain('Post de amanhã, às 19:00');
    expect(texto).toContain('Você vai publicar um post no Instagram e na Página do Facebook, amanhã, às 19:00.');
    expect(html).toContain('<span class="risco risco--medio">Post público</span>');
    // A prévia começa no Instagram (o primeiro canal), com a foto e a conta.
    expect(html).toMatch(/<button type="button" aria-pressed="true">Instagram<\/button><button type="button" aria-pressed="false">Página do Facebook<\/button>/);
    expect(html).toContain('src="https://fotos.exemplo/f80.jpg"');
    expect(texto).toContain('@casabrasa');
    expect(texto).toContain('O que foi conferido');
    expect(texto).toContain('a aprovação vale para este post nos canais escolhidos: mudar o texto, a foto ou os canais é outro pedido');
    for (const m of MOTIVOS_DO_POST) expect(texto).toContain(m);
    expect(texto).toContain('Código do app');
    expect(texto).not.toContain('já passou');
  });

  it('quem só acompanha lê, e não decide; a hora que passou ganha o aviso', () => {
    expect(semMarcas(desenho(pedido(), { podeDecidir: false }))).toContain('Só quem pode aprovar decide este pedido.');
    const tarde = semMarcas(desenho(pedido({ post: post({ publish_at: '2026-10-29T14:00:00.000Z' }) })));
    expect(tarde).toContain('A hora marcada (hoje, às 11:00) já passou. Aprovado agora, o post sai em seguida');
  });

  it('a foto: a que não pôde ser lida diz isso; a que saiu das Fotos diz que o post não sai', () => {
    expect(semMarcas(desenho(pedido(), { foto: null }))).toContain('A foto deste post não pôde ser mostrada aqui.');
    expect(semMarcas(desenho(pedido({ post: post({ photo_id: null }) }), { foto: null }))).toContain('A foto deste post foi apagada nas Fotos: ele não sai.');
  });

  it('agendado: o resultado e "Cancelar o post" para quem opera, sem o código; quem não opera não vê o botão', () => {
    const agendado = pedido({ status: 'aprovada', approvals: aprovacao, updated_at: '2026-10-29T15:05:00.000Z', post: post({ status: 'agendado' }) });
    const html = desenho(agendado);
    expect(semMarcas(html)).toContain('Aprovado por Rodrigo às 12:05. Sai amanhã, às 19:00, nos dois canais.');
    expect(html).toContain('data-po-cancelar');
    expect(semMarcas(html)).toContain('Cancelar não pede o código do app: o post não sai.');
    expect(desenho(agendado, { podeOperar: false })).not.toContain('data-po-cancelar');
  });

  it('publicado: cada canal com a hora e o link do post na rede (só https)', () => {
    const publicado = pedido({
      status: 'executada',
      approvals: aprovacao,
      updated_at: '2026-10-29T15:05:00.000Z',
      post: post({
        status: 'publicado',
        channels: [
          { ...post().channels[0]!, status: 'publicado', permalink: 'https://www.instagram.com/p/abc/', published_at: '2026-10-29T15:04:00.000Z' },
          { ...post().channels[1]!, status: 'publicado', permalink: 'javascript:alert(1)', published_at: '2026-10-29T15:04:30.000Z' },
        ],
      }),
    });
    const html = desenho(publicado);
    expect(semMarcas(html)).toContain('Instagram: publicado hoje, às 12:04.');
    expect(html).toContain('href="https://www.instagram.com/p/abc/"');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data-po-cancelar');
  });

  it('não saiu: o motivo de cada canal e Contas conectadas para quem vê as contas', () => {
    const falhou = pedido({
      status: 'falhou',
      updated_at: '2026-10-29T15:05:00.000Z',
      post: post({ status: 'nao_saiu', channels: [{ ...post().channels[0]!, status: 'falhou', error: 'A Meta recusou o acesso desta conta.' }] }),
    });
    const html = desenho(falhou);
    expect(semMarcas(html)).toContain('Instagram: não saiu. A Meta recusou o acesso desta conta.');
    expect(html).toContain('href="/contas"');
    expect(desenho(falhou, { podeVerContas: false })).not.toContain('href="/contas"');
  });
});
