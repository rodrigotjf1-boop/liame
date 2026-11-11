import type { ActionComment, ActionResponse } from '@liame/contracts';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  type AcaoDeComentario,
  canalETipoDaLista,
  comentarioApresentado,
  ehPedidoDeComentario,
  etiquetaDoComentario,
  fraseDoComentario,
  porQueOcultar,
  resultadoDoComentario,
  situacaoDoComentario,
  textoDoComentarioValido,
  tituloDoComentario,
} from '@/components/aprovacoes/comentario-textos';
import { DetalheComentario } from '@/components/aprovacoes/detalhe-comentario';
import { grupoDe } from '@/components/aprovacoes/textos';

// O pedido sobre um comentário em Aprovações (A6 · Z11, parte 3a; mockups/prototipo-comentarios.html, P38): o título
// com quem comentou (o @ no Instagram, o nome na Página, e que pode faltar), a linha da lista, a situação de cada pedido
// (inclusive a retirada pelo Social media, com o porquê), a frase, o resultado, e o detalhe desenhado para quem decide e
// para quem só lê, no responder e no ocultar.

const uuid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const agora = new Date(2026, 10, 10, 15, 0);
const local = (h: number, m = 0, d = 10) => new Date(2026, 10, d, h, m).toISOString();
const RESPOSTA = 'Entregamos no Centro e na Lapa. Qualquer dúvida, chama a gente pelos contatos do perfil da loja.';

const comentario = (o: Partial<ActionComment> = {}, atual: Partial<NonNullable<ActionComment['current']>> = {}): ActionComment => ({
  id: '17900000000000001',
  channel: 'instagram',
  operation: 'responder',
  reply_text: RESPOSTA,
  current: { author: 'duda.come.bem', message: 'Vocês entregam na Tijuca?', published_at: local(13, 20), kind: 'pergunta', hidden: false, brand_reply: null, ...atual },
  post: { id: '17800000000000001', caption: 'Combo duplo na chapa', permalink: null, thumbnail_url: null, published_at: local(9, 0) },
  changed: false,
  withdrawn: null,
  ...o,
});

const pedido = (o: Partial<ActionResponse> = {}, c: Partial<ActionComment> = {}, atual: Partial<NonNullable<ActionComment['current']>> = {}): AcaoDeComentario =>
  ({
    id: uuid(1),
    tool: 'comentario_responder',
    action: 'comentario.responder',
    brand_id: uuid(50),
    provider: 'meta_instagram',
    account_id: uuid(60),
    resource_id: 'comentario:17900000000000001',
    params: { texto: RESPOSTA },
    risk_level: 'R1',
    budget_impact: 'none',
    value_micros: null,
    current_value_micros: null,
    reserved_micros: 0,
    plan_hash: `e5f6${'0'.repeat(56)}a7b8`,
    mode: 'APPROVAL',
    status: 'aguardando_aprovacao',
    status_reason: null,
    blocked_reason: null,
    attempts: 0,
    next_attempt_at: null,
    undoes: null,
    undone_by: null,
    policy: { allowed: true, mode: 'APPROVAL', violations: [], versions: ['plataforma@8'] },
    approvals: [],
    workflow: null,
    expires_at: local(13, 30, 13),
    created_at: local(13, 30),
    updated_at: local(13, 30),
    requested_by: { id: uuid(2), name: 'Rodrigo' },
    account_name: '@misterburguer',
    campaign: null,
    recommendation: null,
    agent_key: null,
    target: null,
    from: null,
    to: null,
    execution: null,
    message: null,
    review: null,
    comment: comentario(c, atual),
    ...o,
  }) as AcaoDeComentario;
const doSocial = (o: Partial<ActionResponse> = {}, c: Partial<ActionComment> = {}, atual: Partial<NonNullable<ActionComment['current']>> = {}) =>
  pedido({ agent_key: 'social', ...o }, c, atual);
const ocultar = (o: Partial<ActionResponse> = {}) =>
  doSocial({ tool: 'comentario_ocultar', action: 'comentario.ocultar', params: {}, ...o }, { operation: 'ocultar', reply_text: null }, { kind: 'golpe', message: 'Ganhe seguidores grátis no meu perfil', author: 'promo_fake' });
const aprovacao = () => [{ approved_by: uuid(2), approver_name: 'Rodrigo', approver_role: 'dono', sufficient: true, current_plan: true, created_at: local(14, 2) }];

function desenho(a: AcaoDeComentario, o: { pro?: boolean; podeDecidir?: boolean; podeOperar?: boolean; euPedi?: boolean } = {}) {
  return renderToStaticMarkup(
    createElement(DetalheComentario, {
      acao: a,
      grupo: grupoDe(a, agora),
      agora,
      pro: o.pro ?? false,
      euPedi: o.euPedi ?? false,
      podeDecidir: o.podeDecidir ?? true,
      podeOperar: o.podeOperar ?? true,
      temApp: true,
      titulo: createRef<HTMLHeadingElement>(),
      campoCodigo: createRef<HTMLInputElement>(),
      aoVoltar: () => {},
      aoAprovar: async () => ({ ok: true }) as const,
      aoRecusar: async () => ({ ok: true }) as const,
      aoSalvarTexto: async () => ({ ok: true }) as const,
      aoPedirOutra: async () => ({ ok: true }) as const,
      aoAvisar: () => {},
    }),
  );
}
const semMarcas = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

describe('o pedido sobre um comentário em Aprovações: os textos (A6 · Z11, parte 3a)', () => {
  it('o pedido se reconhece pela ferramenta e pelo comentário', () => {
    for (const tool of ['comentario_responder', 'comentario_ocultar', 'comentario_apagar_resposta', 'comentario_mostrar']) expect(ehPedidoDeComentario(pedido({ tool }))).toBe(true);
    expect(ehPedidoDeComentario(pedido({ comment: null }))).toBe(false);
    expect(ehPedidoDeComentario(pedido({ tool: 'avaliacao_responder' }))).toBe(false);
  });

  it('o título leva o @ no Instagram e o nome na Página; sem quem comentou, onde está', () => {
    expect(tituloDoComentario(pedido())).toBe('Responder ao comentário de @duda.come.bem');
    expect(tituloDoComentario(pedido({}, {}, { author: '@duda.come.bem' }))).toBe('Responder ao comentário de @duda.come.bem');
    expect(tituloDoComentario(pedido({}, { channel: 'facebook' }, { author: 'Duda Lima' }))).toBe('Responder ao comentário de Duda Lima');
    expect(tituloDoComentario(pedido({}, {}, { author: null }))).toBe('Responder a um comentário no Instagram');
    expect(tituloDoComentario(pedido({}, { channel: 'facebook', current: null }))).toBe('Responder a um comentário na Página do Facebook');
    expect(tituloDoComentario(ocultar())).toBe('Ocultar o comentário de @promo_fake');
    expect(tituloDoComentario(pedido({}, { operation: 'apagar_resposta' }))).toBe('Apagar a resposta ao comentário de @duda.come.bem');
    expect(tituloDoComentario(pedido({}, { operation: 'mostrar' }))).toBe('Mostrar de novo o comentário de @duda.come.bem');
  });

  it('a linha da lista diz o canal e o tipo; sem o tipo, só o canal', () => {
    expect(canalETipoDaLista(pedido())).toBe('Instagram · Pergunta');
    expect(canalETipoDaLista(pedido({}, { channel: 'facebook' }, { kind: 'reclamacao' }))).toBe('Facebook · Reclamação');
    expect(canalETipoDaLista(pedido({}, {}, { kind: null }))).toBe('Instagram');
    expect(canalETipoDaLista(pedido({}, { current: null }))).toBe('Instagram');
  });

  it('a situação e a etiqueta: esperando, saindo, feito, recusado, retirado pelo Social media com o porquê, cancelado, expirado e o que mudou', () => {
    const casos: Array<[AcaoDeComentario, string, string]> = [
      [pedido(), 'pendente', 'Espera aprovação'],
      [pedido({ status: 'aprovada' }), 'saindo', 'Saindo'],
      [ocultar({ status: 'executando' }), 'saindo', 'Ocultando'],
      [pedido({ status: 'executada', approvals: aprovacao() }), 'feito', 'Respondido'],
      [ocultar({ status: 'executada' }), 'feito', 'Oculto'],
      [pedido({ status: 'cancelada', status_reason: 'recusada por Rodrigo: Prefiro não responder' }), 'recusado', 'Recusado'],
      [doSocial({ status: 'cancelada', status_reason: 'retirada pelo funcionário: respondido_na_rede' }, { withdrawn: 'respondido_na_rede' }), 'retirado', 'Respondido na rede'],
      [doSocial({ status: 'cancelada' }, { withdrawn: 'comentario_sumiu' }), 'retirado', 'O comentário foi apagado'],
      [doSocial({ status: 'cancelada' }, { withdrawn: 'novo_motivo' }), 'retirado', 'Retirado'],
      [pedido({ status: 'cancelada' }), 'cancelado', 'Cancelado'],
      [pedido({ status: 'expirada' }), 'expirado', 'Expirou'],
      [pedido({ status: 'falhou', execution: { status: 'estado_mudou', finished_at: local(14, 3) } as ActionResponse['execution'] }), 'mudou', 'O comentário mudou'],
      [pedido({ status: 'falhou' }), 'falhou', 'Não saiu'],
    ];
    for (const [a, s, e] of casos) expect([situacaoDoComentario(a), etiquetaDoComentario(a)]).toEqual([s, e]);
  });

  it('a frase do Lite diz quem propõe, o tipo, onde e que é pública; quem não aprova não lê o "se você aprovar"', () => {
    const texto = (a: AcaoDeComentario, o: { euPedi?: boolean; possoAprovar?: boolean } = {}) =>
      fraseDoComentario(a, { euPedi: o.euPedi ?? false, possoAprovar: o.possoAprovar ?? true })
        .map((p) => p.t)
        .join('');
    expect(texto(doSocial())).toBe('Social media propõe uma resposta para a pergunta que @duda.come.bem deixou no Instagram. Ela é pública e sai em nome da marca. Se você aprovar, o Liame responde no Instagram.');
    expect(texto(pedido(), { euPedi: true })).toContain('Você escreveu uma resposta para a pergunta');
    expect(texto(doSocial({}, {}, { kind: 'reclamacao' }))).toContain('para a reclamação que');
    expect(texto(doSocial({}, {}, { kind: 'elogio' }))).toContain('para o comentário que');
    expect(texto(doSocial(), { possoAprovar: false })).not.toContain('Se você aprovar');
    expect(texto(ocultar())).toBe('Social media sugere ocultar o comentário que @promo_fake deixou no Instagram. Os outros deixam de ver o comentário; dá para mostrar de novo. Se você aprovar, o Liame oculta o comentário no Instagram.');
    expect(fraseDoComentario(doSocial(), { euPedi: false, possoAprovar: true }).find((p) => p.b)?.t).toBe('pública');
  });

  it('o porquê de ocultar vem do tipo; o pedido de uma pessoa diz que ela escolheu', () => {
    expect(porQueOcultar(ocultar())).toContain('Tem cara de golpe');
    expect(porQueOcultar(doSocial({ tool: 'comentario_ocultar' }, { operation: 'ocultar' }, { kind: 'ofensivo' }))).toContain('É ofensivo');
    expect(porQueOcultar(pedido({ tool: 'comentario_ocultar' }, { operation: 'ocultar' }))).toBe('Escolhido no lugar de responder.');
  });

  it('o resultado de cada situação decidida, com o porquê da retirada', () => {
    expect(resultadoDoComentario(pedido({ status: 'executada', approvals: aprovacao() }))).toMatchObject({ tom: 'ok', forte: 'Respondido no Instagram, em nome da marca.' });
    expect(resultadoDoComentario(ocultar({ status: 'executada' }))).toMatchObject({ tom: 'ok', icone: 'eye-off', forte: 'Oculto no Instagram.' });
    expect(resultadoDoComentario(doSocial({ status: 'cancelada' }, { withdrawn: 'respondido_na_rede' }))).toMatchObject({ tom: 'neutro', forte: 'O comentário já tem resposta da marca, dada direto no Instagram.' });
    expect(resultadoDoComentario(doSocial({ status: 'cancelada' }, { withdrawn: 'comentario_mudou' })).forte).toBe('Quem comentou editou o comentário depois da sugestão.');
    expect(resultadoDoComentario(pedido({ status: 'cancelada', status_reason: 'recusada por Rodrigo: Prefiro não responder' })).texto).toBe('Recusado por Rodrigo: “Prefiro não responder”. Nada foi feito.');
    expect(resultadoDoComentario(pedido({ status: 'aprovada', approvals: aprovacao() }))).toMatchObject({ tom: 'espera', texto: ' A resposta está saindo no Instagram.' });
  });

  it('o texto para salvar: vazio, no limite e passando do limite de 1.000 caracteres', () => {
    expect(textoDoComentarioValido('   ')).toBe('Escreva a resposta antes de salvar.');
    expect(textoDoComentarioValido('a'.repeat(1000))).toBeNull();
    expect(textoDoComentarioValido('a'.repeat(1001))).toBe('A resposta passa de 1.000 caracteres.');
  });

  it('o pedido em palavras para a lista e os avisos', () => {
    expect(comentarioApresentado(pedido())).toMatchObject({ titulo: 'Responder ao comentário de @duda.come.bem', impacto: null, depoisDeAprovar: 'O Liame responde no Instagram em instantes.' });
    expect(comentarioApresentado(ocultar()).depoisDeAprovar).toBe('O Liame oculta o comentário no Instagram em instantes.');
  });
});

describe('o pedido sobre um comentário em Aprovações: o detalhe (A6 · Z11, parte 3a)', () => {
  it('esperando: o comentário como está, a resposta proposta com "Editar o texto", o conferido e a decisão com o código', () => {
    const t = semMarcas(desenho(doSocial()));
    expect(t).toContain('Responder ao comentário de @duda.come.bem');
    expect(t).toContain('O comentário, como está no Instagram');
    expect(t).toContain('Vocês entregam na Tijuca?');
    expect(t).toContain('No post: “Combo duplo na chapa”.');
    expect(t).toContain('A resposta proposta');
    expect(t).toContain(RESPOSTA);
    expect(t).toContain('Editar o texto');
    expect(t).toContain('O Compliance conferiu o texto');
    expect(t).toContain('a aprovação vale só para este texto');
    expect(t).toContain('Social media sugeriu');
    expect(t).toContain('funcionário de IA');
    expect(desenho(doSocial())).toContain('co-canal co-canal--ig');
    expect(desenho(doSocial())).toContain('co-tipo co-tipo--pergunta');
  });

  it('o de ocultar mostra o porquê e não oferece editar; o de quem só lê não tem a decisão nem o editar', () => {
    const o = semMarcas(desenho(ocultar()));
    expect(o).toContain('Ocultar o comentário de @promo_fake');
    expect(o).toContain('Por que ocultar');
    expect(o).toContain('Tem cara de golpe');
    expect(o).toContain('a aprovação vale só para ocultar este comentário');
    expect(o).not.toContain('Editar o texto');
    const leitura = semMarcas(desenho(doSocial(), { podeDecidir: false, podeOperar: false }));
    expect(leitura).toContain('Só quem pode aprovar decide este pedido.');
    expect(leitura).not.toContain('Editar o texto');
    expect(leitura).not.toContain('Se você aprovar');
  });

  it('o comentário que mudou avisa antes da decisão; o que saiu da guarda do Liame diz isso no lugar do texto', () => {
    expect(semMarcas(desenho(doSocial({}, { changed: true })))).toContain('O comentário mudou depois deste pedido.');
    expect(semMarcas(desenho(doSocial({}, { current: null })))).toContain('O Liame não guarda mais este comentário');
  });

  it('as sugestões do Social media (parte 3c): escolher uma, editar a escolhida e pedir outra uma vez; escrevendo, a decisão espera', () => {
    const sugestoes = [1, 2, 3].map((n) => ({ focus: `Caminho ${n}`, text: `Texto ${n}. Chama a gente pelos contatos do perfil da loja.`, round: 1 }));
    const reclamacao = doSocial({}, { reply_text: sugestoes[0]!.text, suggestions: sugestoes, more_suggestions: 'pode_pedir' }, { kind: 'reclamacao' });
    const html = desenho(reclamacao);
    const t = semMarcas(html);
    expect(t).toContain('As sugestões do Social media');
    expect(t).toContain('Escolha a resposta');
    expect(t).toContain('Sugestão 1 · Caminho 1');
    expect(html.match(/type="radio"/g)?.length).toBe(3);
    expect(t).toContain('Editar o texto escolhido');
    expect(t).toContain('Pedir outras sugestões');
    expect(t).toContain('Social media escreveu três sugestões de resposta para a reclamação que @duda.come.bem deixou no Instagram. Escolha a que preferir e ajuste se quiser');
    // A pergunta tem uma sugestão: "Pedir outra sugestão".
    const umaSo = { suggestions: [{ focus: 'Responde e chama a equipe', text: RESPOSTA, round: 1 }] };
    expect(semMarcas(desenho(doSocial({}, { ...umaSo, more_suggestions: 'pode_pedir' })))).toContain('Pedir outra sugestão');
    // Escrevendo: a espera no lugar das opções, e a decisão espera a nova.
    const escrevendo = semMarcas(desenho(doSocial({}, { ...umaSo, more_suggestions: 'escrevendo', more_suggestions_asked_at: new Date(agora.getTime() - 30_000).toISOString() })));
    expect(escrevendo).toContain('O Social media está escrevendo outra sugestão');
    expect(escrevendo).toContain('Espere a sugestão nova para aprovar.');
    expect(escrevendo).not.toContain('Código do app');
    // Feitas: a nova primeiro, a da primeira rodada embaixo, sem pedir de novo.
    const NOVA = 'Fazemos entrega no Centro e na Lapa. Chama a gente pelos contatos do perfil da loja.';
    const feitas = semMarcas(
      desenho(doSocial({}, { reply_text: NOVA, suggestions: [{ focus: 'Responde e chama a equipe', text: NOVA, round: 2 }, ...umaSo.suggestions], more_suggestions: 'feitas' })),
    );
    expect(feitas.indexOf(NOVA)).toBeLessThan(feitas.indexOf('As da primeira rodada'));
    expect(feitas).not.toContain('Pedir outra');
    expect(feitas).toContain('Esta é a segunda rodada');
    // Quem só lê vê os cartões, com a escolhida marcada, sem escolher nem pedir.
    const leitura = desenho(reclamacao, { podeOperar: false, podeDecidir: false });
    expect(leitura).not.toContain('type="radio"');
    expect(semMarcas(leitura)).toContain('Sugestão 1 · Caminho 1 · a escolhida');
    expect(semMarcas(leitura)).not.toContain('Pedir outras');
    expect(semMarcas(leitura)).not.toContain('Escolha a que preferir');
  });

  it('decidido: o resultado e o que foi pedido, sem a decisão', () => {
    const d = semMarcas(desenho(doSocial({ status: 'cancelada', status_reason: 'retirada pelo funcionário: respondido_na_rede', updated_at: local(14, 10) }, { withdrawn: 'respondido_na_rede' })));
    expect(d).toContain('O comentário já tem resposta da marca, dada direto no Instagram.');
    expect(d).toContain('O que foi pedido');
    expect(d).not.toContain('O que foi conferido');
    expect(d).not.toContain('Editar o texto');
  });
});
