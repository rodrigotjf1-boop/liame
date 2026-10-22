import type { ActionResponse, ReviewItem } from '@liame/contracts';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { quemPediu } from '@/components/aprovacoes/anuncio-textos';
import { DetalheSugestoes } from '@/components/aprovacoes/detalhe-sugestoes';
import { type AcaoDeResposta, etiquetaDaResposta, situacaoDaResposta } from '@/components/aprovacoes/resposta-textos';
import { contaDeCaracteres, ehDoSocialMedia, escolhaDoPedido, fraseDasSugestoes, outrasNaTela, resultadoDasSugestoes } from '@/components/aprovacoes/sugestoes-textos';
import { grupoDe } from '@/components/aprovacoes/textos';

// As sugestões de resposta do Social media em Aprovações (A6 · Z6, parte 3c; mockups/prototipo-respostas-sugeridas.html,
// P31): o pedido dele se reconhece pelas sugestões; a escolha (a versão ajustada, as novas e as da primeira rodada), o
// "Pedir outras" pelo que o servidor diz (com a espera da tela), a frase para quem decide e para quem só lê, e o detalhe
// desenhado para o dono, para quem não é o dono, para quem só aprova e em cada situação do P31.

const uuid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const agora = new Date(2026, 9, 22, 15, 0);
const local = (h: number, m = 0, d = 22) => new Date(2026, 9, d, h, m).toISOString();
const minutosAntes = (m: number) => new Date(agora.getTime() - m * 60_000).toISOString();

const BOAS = [
  { focus: 'Curta', text: 'Que bom ler isso! Obrigado pela visita e por elogiar o combo família. Até o próximo smash.', round: 1 },
  { focus: 'Mais calorosa', text: 'Ficamos muito felizes que o combo família chegou caprichado e rápido! Obrigado por contar aqui como foi.', round: 1 },
];
const OUTRAS = [
  { focus: 'Destaca a entrega', text: 'Obrigado pela avaliação! Entregar rápido e caprichado é o que a gente mais quer. Até a próxima.', round: 2 },
  { focus: 'Bem curta', text: 'Obrigado pelo carinho com o nosso smash! Até a próxima.', round: 2 },
];
const AJUSTADA = 'Que bom ler isso! O combo família é o nosso xodó. Obrigado pela visita, e até o próximo smash.';

const atual = (o: Partial<ReviewItem> = {}): ReviewItem => ({
  id: uuid(70),
  store_id: uuid(60),
  stars: 5,
  text: 'Melhor smash da região! O combo família veio caprichado e a entrega foi rápida.',
  reviewed_at: local(9, 12),
  changed_at: local(9, 12),
  reply: null,
  ...o,
});

const pedido = (o: Partial<ActionResponse> = {}, review: Partial<NonNullable<ActionResponse['review']>> = {}): AcaoDeResposta =>
  ({
    id: uuid(1),
    tool: 'avaliacao_responder',
    action: 'avaliacao.responder',
    brand_id: uuid(50),
    provider: 'google_business',
    account_id: uuid(60),
    resource_id: `avaliacao:${uuid(70)}`,
    params: { texto: BOAS[0]!.text },
    risk_level: 'R2',
    budget_impact: 'none',
    value_micros: null,
    current_value_micros: null,
    reserved_micros: 0,
    plan_hash: `8c1f${'0'.repeat(56)}40de`,
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
    expires_at: local(9, 30, 25),
    created_at: local(9, 30),
    updated_at: local(9, 30),
    requested_by: { id: uuid(2), name: 'Rodrigo' },
    account_name: 'Smash da Vila',
    campaign: null,
    recommendation: null,
    agent_key: 'social',
    target: null,
    from: null,
    to: null,
    execution: null,
    message: null,
    review: {
      id: uuid(70),
      stars: 5,
      owner_only: false,
      reply_text: BOAS[0]!.text,
      current: atual(),
      changed: false,
      suggestions: BOAS,
      withdrawn: null,
      more_suggestions: 'pode_pedir',
      more_suggestions_asked_at: null,
      ...review,
    },
    ...o,
  }) as AcaoDeResposta;

/** A de 1 estrela: só o dono decide. */
const BAIXA = { stars: 1, owner_only: true, current: atual({ stars: 1, text: 'Pedi às 19h e o lanche chegou depois das 21h, frio.' }) };
/** A segunda rodada que veio: as outras antes das primeiras, e o texto é o da primeira nova. */
const SEGUNDA = { suggestions: [...OUTRAS, ...BOAS], reply_text: OUTRAS[0]!.text, more_suggestions: 'feitas', more_suggestions_asked_at: minutosAntes(3) };

function desenho(a: AcaoDeResposta, o: { pro?: boolean; nome?: string | null; souDono?: boolean; podeDecidir?: boolean; podeOperar?: boolean } = {}) {
  return renderToStaticMarkup(
    createElement(DetalheSugestoes, {
      acao: a,
      grupo: grupoDe(a, agora),
      agora,
      pro: o.pro ?? false,
      nome: o.nome === undefined ? 'Marina S.' : o.nome,
      souDono: o.souDono ?? true,
      podeDecidir: o.podeDecidir ?? true,
      podeOperar: o.podeOperar ?? true,
      temApp: true,
      titulo: createRef<HTMLHeadingElement>(),
      campoCodigo: createRef<HTMLInputElement>(),
      aoVoltar: () => {},
      aoAprovar: async () => ({ ok: true }) as const,
      aoRecusar: async () => ({ ok: true }) as const,
      aoAlterarTexto: async () => ({ ok: true }) as const,
      aoPedirOutras: async () => ({ ok: true }) as const,
      aoEscreverOutra: () => {},
      aoAvisar: () => {},
    }),
  );
}
const semMarcas = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&');
const texto = (p: ReturnType<typeof fraseDasSugestoes>) => p.map((x) => x.t).join('');
/** Os botões de opção do desenho, com a opção e se está escolhida (a ordem dos atributos é a do React, não a do código). */
const opcoesDoDesenho = (html: string) => [...html.matchAll(/<input type="radio"[^>]*>/g)].map((m) => [/value="([a-z0-9-]+)"/.exec(m[0])?.[1], m[0].includes('checked=""')]);

describe('as sugestões do Social media em Aprovações: os textos (A6 · Z6, parte 3c)', () => {
  it('o Social media tem nome em quem pediu, e o pedido dele se reconhece pelas sugestões', () => {
    expect(quemPediu(pedido())).toEqual({ nome: 'Social media', funcionario: true });
    expect(ehDoSocialMedia(pedido())).toBe(true);
    expect(ehDoSocialMedia(pedido({ agent_key: null }))).toBe(false);
    expect(ehDoSocialMedia(pedido({}, { suggestions: null }))).toBe(false);
    expect(ehDoSocialMedia(pedido({}, { suggestions: [] }))).toBe(false);
  });

  it('a escolha: as sugestões numeradas na ordem da tela; depois do "Pedir outras", as novas primeiro e as da primeira rodada depois; a versão ajustada, antes de todas', () => {
    const primeira = escolhaDoPedido(pedido());
    expect(primeira.novas.map((o) => [o.chave, o.rotulo])).toEqual([
      ['sugestao-1', 'Sugestão 1 · Curta'],
      ['sugestao-2', 'Sugestão 2 · Mais calorosa'],
    ]);
    expect([primeira.daPrimeira, primeira.ajustada, primeira.escolhida, primeira.total]).toEqual([[], null, 'sugestao-1', 2]);
    expect(escolhaDoPedido(pedido({}, { reply_text: BOAS[1]!.text })).escolhida).toBe('sugestao-2');

    const segunda = escolhaDoPedido(pedido({}, SEGUNDA));
    expect(segunda.novas.map((o) => o.rotulo)).toEqual(['Sugestão 1 · Destaca a entrega', 'Sugestão 2 · Bem curta']);
    expect(segunda.daPrimeira.map((o) => o.rotulo)).toEqual(['Sugestão 3 · Curta', 'Sugestão 4 · Mais calorosa']);
    expect([segunda.escolhida, segunda.total]).toEqual(['sugestao-1', 4]);

    // O texto que não é nenhuma das sugestões é a versão ajustada (a mesma regra do servidor): vem primeiro e é a escolhida.
    const ajustada = escolhaDoPedido(pedido({}, { reply_text: AJUSTADA }));
    expect(ajustada.ajustada).toEqual({ chave: 'ajustada', rotulo: 'A versão ajustada · escrita por uma pessoa', texto: AJUSTADA });
    expect([ajustada.escolhida, ajustada.total]).toEqual(['ajustada', 3]);
  });

  it('a contagem de caracteres conta como a pessoa vê (um emoji é um)', () => {
    expect(contaDeCaracteres('Obrigado!')).toBe('9 de 1.500 caracteres');
    expect(contaDeCaracteres('😀'.repeat(1200))).toBe('1.200 de 1.500 caracteres');
  });

  it('o "Pedir outras" pelo que o servidor diz: escrevendo até dois minutos depois do pedido, demorando depois; um código novo não aparece', () => {
    expect(outrasNaTela(pedido(), agora)).toBe('pode_pedir');
    expect(outrasNaTela(pedido({}, { more_suggestions: 'escrevendo', more_suggestions_asked_at: minutosAntes(1) }), agora)).toBe('escrevendo');
    expect(outrasNaTela(pedido({}, { more_suggestions: 'escrevendo', more_suggestions_asked_at: minutosAntes(2) }), agora)).toBe('demorando');
    expect(outrasNaTela(pedido({}, { more_suggestions: 'escrevendo', more_suggestions_asked_at: minutosAntes(45) }), agora)).toBe('demorando');
    // Sem a hora do pedido, a tela não tem como medir: segue escrevendo (a releitura da lista resolve).
    expect(outrasNaTela(pedido({}, { more_suggestions: 'escrevendo', more_suggestions_asked_at: null }), agora)).toBe('escrevendo');
    expect(outrasNaTela(pedido({}, SEGUNDA), agora)).toBe('feitas');
    expect(outrasNaTela(pedido({}, { more_suggestions: 'nao_deu', more_suggestions_asked_at: minutosAntes(50) }), agora)).toBe('nao_deu');
    expect(outrasNaTela(pedido({}, { more_suggestions: 'codigo_novo' }), agora)).toBeNull();
    expect(outrasNaTela(pedido({}, { more_suggestions: null }), agora)).toBeNull();
  });

  it('a frase do Lite: o convite é para quem escolhe e aprova; quem só escolhe não lê "aprove"; quem só aprova lê o que acontece; quem só lê, a frase sem convite', () => {
    const p = pedido();
    expect(texto(fraseDasSugestoes(p, 'Marina S.', { possoMexer: true, possoAprovar: true }))).toBe(
      'O Social media escreveu duas sugestões de resposta para a avaliação de 5 estrelas que Marina S. deixou. Escolha a que preferir, ajuste se quiser e aprove: a resposta é pública e sai em nome da loja “Smash da Vila”.',
    );
    expect(texto(fraseDasSugestoes(p, 'Marina S.', { possoMexer: true, possoAprovar: false }))).toBe(
      'O Social media escreveu duas sugestões de resposta para a avaliação de 5 estrelas que Marina S. deixou. Escolha a que preferir e ajuste se quiser: a resposta é pública e sai em nome da loja “Smash da Vila”.',
    );
    expect(texto(fraseDasSugestoes(p, null, { possoMexer: false, possoAprovar: true }))).toBe(
      'O Social media escreveu duas sugestões de resposta para a avaliação de 5 estrelas. A resposta é pública e sai em nome da loja “Smash da Vila”. Se você aprovar, o Liame publica no Google o texto escolhido.',
    );
    expect(texto(fraseDasSugestoes(p, null, { possoMexer: false, possoAprovar: false }))).toBe(
      'O Social media escreveu duas sugestões de resposta para a avaliação de 5 estrelas. A resposta é pública e sai em nome da loja “Smash da Vila”.',
    );
    // Só a nota: uma sugestão só.
    const soANota = pedido({}, { stars: 4, current: atual({ stars: 4, text: null }), suggestions: [BOAS[0]!] });
    expect(texto(fraseDasSugestoes(soANota, 'Diego A.', { possoMexer: true, possoAprovar: true }))).toBe(
      'O Social media escreveu uma sugestão de resposta para a avaliação de 4 estrelas que Diego A. deixou. Leia, ajuste se quiser e aprove: a resposta é pública e sai em nome da loja “Smash da Vila”.',
    );
    expect(fraseDasSugestoes(p, null, { possoMexer: true, possoAprovar: true }).filter((x) => x.b).map((x) => x.t)).toEqual(['5 estrelas', 'pública']);
  });

  it('o pedido que ele tirou de Aprovações e o recusado: a situação, a etiqueta da lista e o resultado', () => {
    const mudou = pedido({ status: 'cancelada', status_reason: 'retirada pelo funcionário: avaliacao_mudou' }, { withdrawn: 'avaliacao_mudou', current: atual({ stars: 4 }) });
    expect([situacaoDaResposta(mudou), etiquetaDaResposta(mudou)]).toEqual(['retirada-mudou', 'A avaliação mudou']);
    expect(resultadoDasSugestoes(mudou, agora)).toEqual({
      tom: 'falha',
      icone: 'alert',
      forte: 'A avaliação mudou depois das sugestões.',
      texto:
        ' A pessoa editou a avaliação, e agora são 4 estrelas. As sugestões eram para a avaliação de antes e saíram daqui: nada foi publicado. O Social media escreve outras para a avaliação como está agora, e elas chegam num pedido novo.',
    });
    // A nota de agora só entra quando mudou; e no singular, quando é uma estrela.
    expect(resultadoDasSugestoes(pedido({ status: 'cancelada' }, { withdrawn: 'avaliacao_mudou' }), agora)!.texto).toContain(' A pessoa editou a avaliação. As sugestões');
    expect(resultadoDasSugestoes(pedido({ status: 'cancelada' }, { withdrawn: 'avaliacao_mudou', current: atual({ stars: 1 }) }), agora)!.texto).toContain('e agora é 1 estrela.');

    const respondida = pedido({ status: 'cancelada' }, { withdrawn: 'respondida_no_google', current: atual({ reply: { text: 'Obrigado!', state: 'aprovada', changed_at: local(10, 12), violation: null } }) });
    expect([situacaoDaResposta(respondida), etiquetaDaResposta(respondida)]).toEqual(['retirada-respondida', 'Respondida no Google']);
    expect(resultadoDasSugestoes(respondida, agora)).toMatchObject({ tom: 'neutro', forte: 'Esta avaliação já tem resposta, dada direto no Google (hoje, 10:12).' });
    expect(resultadoDasSugestoes(pedido({ status: 'cancelada' }, { withdrawn: 'respondida_no_google' }), agora)!.forte).toBe('Esta avaliação já tem resposta, dada direto no Google.');

    const recusada = pedido({ status: 'cancelada', status_reason: 'recusada por Rodrigo: Nenhuma serve' });
    expect(resultadoDasSugestoes(recusada, agora)!.texto).toBe('Recusada por Rodrigo: “Nenhuma serve”. Nada foi publicado. A avaliação segue sem resposta, e o Social media não escreve outras para ela.');
    // Um código de retirada que a tela não conhece fica como cancelado; o aprovado segue o resultado da resposta (P17).
    expect(situacaoDaResposta(pedido({ status: 'cancelada' }, { withdrawn: 'codigo_novo' }))).toBe('cancelada');
    expect(resultadoDasSugestoes(pedido({ status: 'aprovada' }), agora)).toBeNull();
  });
});

describe('as sugestões do Social media em Aprovações: o detalhe (A6 · Z6, parte 3c)', () => {
  it('esperando o dono decidir: a avaliação e as sugestões lado a lado, a escolhida marcada, as ações, o que foi conferido e o código do app', () => {
    const html = desenho(pedido());
    const t = semMarcas(html);
    expect(t).toContain('Social media sugeriu');
    expect(t).toContain('· funcionário de IA');
    expect(t).toContain('Responder à avaliação de Marina S.');
    expect(t).toContain('A avaliação, como está no Google');
    expect(t).toContain('As sugestões do Social media');
    expect(t).toContain('Escolha a resposta');
    expect(t).toContain('Sugestão 1 · Curta');
    expect(t).toContain(BOAS[1]!.text);
    expect(t).toContain(contaDeCaracteres(BOAS[0]!.text));
    expect(opcoesDoDesenho(html)).toEqual([
      ['sugestao-1', true],
      ['sugestao-2', false],
    ]);
    for (const b of ['data-sug-ajustar', 'data-sug-outras', 'data-sug-zero']) expect(html).toContain(b);
    expect(t).toContain('Pedir outras sugestões');
    expect(t).toContain('A escolhida aparece embaixo da avaliação, em nome da loja “Smash da Vila”.');
    expect(t).toContain('a aprovação vale só para o texto escolhido: mudou o texto, é outro pedido');
    expect(t).toContain('O Compliance conferiu as sugestões antes de elas chegarem aqui: elas não prometem desconto, brinde nem reembolso, não citam o nome de quem avaliou, não trazem dado pessoal e não afirmam o que a loja não confirmou.');
    expect(t).toContain('Se ninguém decidir, o pedido expira, nada é publicado e a avaliação volta para “sem resposta”, sem sugestão nova.');
    expect(t).toContain('Leu a nota, o texto e a data da avaliação, e Minha marca: o nome da marca, o tom de voz e o resto do dossiê.');
    expect(t).toContain('Não recebeu o nome de quem avaliou');
    expect(html).toContain('Código do app');
    expect(t).toContain('A aprovação vale só para o texto escolhido.');
    for (const m of ['Nenhuma serve', 'Prefiro não responder', 'Vou responder por conta própria']) expect(t).toContain(m);
    // Sem o canal de Minha marca (D-A6-31, com o dono), a tela não promete o WhatsApp da loja; e na de 5 estrelas, não fala de avaliação ruim.
    expect(t).not.toContain('WhatsApp');
    expect(t).not.toContain('Numa avaliação ruim');
    expect(t).not.toContain('Só o dono aprova');
  });

  it('a de 1 estrela: o dono escolhe e decide, com "só o dono aprova"; quem não é o dono lê as sugestões, com a escolhida marcada, e não escolhe, não ajusta, não pede outras nem aprova', () => {
    const baixa = pedido({ action: 'avaliacao.responder_nota_baixa', mode: 'ESCALATE' }, BAIXA);
    const doDono = semMarcas(desenho(baixa, { nome: 'Paulo R.' }));
    expect(doDono).toContain('Só o dono aprova. É uma avaliação de 1 estrela: a resposta só sai com a sua aprovação, e não com a de outro aprovador.');
    expect(doDono).toContain('Numa avaliação ruim, ele pede desculpas e chama para conversar pelos contatos do perfil da loja');
    expect(desenho(baixa)).toContain('data-sug-outras');

    const deOutro = desenho(baixa, { souDono: false, nome: 'Paulo R.' });
    expect(semMarcas(deOutro)).toContain('Esta resposta espera o dono. Resposta a avaliação de 1 ou 2 estrelas só sai com a aprovação do dono da empresa. Você pode ler as sugestões; não pode escolher, ajustar nem aprovar.');
    expect(opcoesDoDesenho(deOutro)).toEqual([]);
    expect(semMarcas(deOutro)).toContain('Sugestão 1 · Curta · a escolhida');
    for (const b of ['data-sug-ajustar', 'data-sug-outras', 'data-sug-zero', 'Código do app']) expect(deOutro).not.toContain(b);
    expect(semMarcas(deOutro)).not.toContain('Recusar');
    expect(semMarcas(deOutro)).not.toContain('Escolha a que preferir');
    // O título do bloco aparece uma vez só (o P31 o repetia numa legenda, na leitura).
    expect(semMarcas(deOutro).split('As sugestões do Social media').length - 1).toBe(1);
    expect(semMarcas(deOutro)).not.toContain('Escolha a resposta');
  });

  it('quem só aprova (sem pedir ações) lê as sugestões, com a escolhida marcada, e aprova a escolhida; quem não aprova escolhe e acompanha', () => {
    const aprovador = desenho(pedido(), { podeOperar: false });
    expect(opcoesDoDesenho(aprovador)).toEqual([]);
    expect(semMarcas(aprovador)).toContain('Sugestão 1 · Curta · a escolhida');
    expect(aprovador).not.toContain('data-sug-ajustar');
    expect(aprovador).toContain('Código do app');
    expect(semMarcas(aprovador)).toContain('Se você aprovar, o Liame publica no Google o texto escolhido.');

    const quemPede = desenho(pedido(), { podeDecidir: false });
    expect(opcoesDoDesenho(quemPede).length).toBe(2);
    expect(quemPede).toContain('data-sug-outras');
    expect(quemPede).not.toContain('Código do app');
    expect(semMarcas(quemPede)).toContain('Só quem pode aprovar decide este pedido.');
  });

  it('o "Pedir outras": escrevendo, o aviso ocupa o lugar das sugestões e a aprovação espera; demorando, as primeiras voltam para decidir; feitas, as da primeira rodada embaixo; não deu, as primeiras com o caminho', () => {
    const escrevendo = desenho(pedido({}, { more_suggestions: 'escrevendo', more_suggestions_asked_at: minutosAntes(1) }));
    expect(semMarcas(escrevendo)).toContain('O Social media está escrevendo outras duas sugestões. Costuma levar menos de um minuto; as primeiras continuam guardadas.');
    expect(opcoesDoDesenho(escrevendo)).toEqual([]);
    expect(escrevendo).not.toContain('Código do app');
    expect(semMarcas(escrevendo)).toContain('Espere as sugestões novas para aprovar.');
    // O aviso é de situação, sem `aria-busy`: a tela não fica "carregando" enquanto o Social media escreve.
    expect(escrevendo).not.toContain('aria-busy');

    const demorando = desenho(pedido({}, { more_suggestions: 'escrevendo', more_suggestions_asked_at: minutosAntes(3) }));
    expect(semMarcas(demorando)).toContain('As outras sugestões estão demorando mais que o normal. O Social media continua tentando, e elas aparecem aqui quando ficarem prontas; enquanto isso, dá para decidir com estas.');
    expect(opcoesDoDesenho(demorando).length).toBe(2);
    expect(demorando).toContain('Código do app');
    expect(demorando).not.toContain('data-sug-outras');

    const feitas = desenho(pedido({}, SEGUNDA));
    expect(semMarcas(feitas)).toContain('As da primeira rodada');
    expect(opcoesDoDesenho(feitas)).toEqual([
      ['sugestao-1', true],
      ['sugestao-2', false],
      ['sugestao-3', false],
      ['sugestao-4', false],
    ]);
    expect(semMarcas(feitas)).toContain('Esta é a segunda rodada: para outro texto, ajuste uma das sugestões ou escreva do zero.');
    expect(feitas).not.toContain('data-sug-outras');

    const naoDeu = desenho(pedido({}, { more_suggestions: 'nao_deu', more_suggestions_asked_at: minutosAntes(50) }));
    expect(semMarcas(naoDeu)).toContain('Não deu para escrever outras sugestões. Para outro texto, ajuste uma das sugestões ou escreva do zero.');
    expect(naoDeu).not.toContain('data-sug-outras');
    expect(naoDeu).toContain('Código do app');
  });

  it('a versão ajustada vem primeiro, escolhida, e o que foi conferido diz com que regras; só a nota tem uma sugestão e "Pedir outra"', () => {
    const ajustada = desenho(pedido({}, { reply_text: AJUSTADA }));
    expect(semMarcas(ajustada)).toContain('A versão ajustada · escrita por uma pessoa');
    expect(opcoesDoDesenho(ajustada)).toEqual([
      ['ajustada', true],
      ['sugestao-1', false],
      ['sugestao-2', false],
    ]);
    expect(semMarcas(ajustada)).toContain('A versão ajustada foi conferida de novo, com as regras da resposta escrita por uma pessoa: não promete desconto, brinde nem reembolso, não cita o nome de quem avaliou e não traz dado pessoal.');

    const soANota = desenho(pedido({}, { stars: 4, current: atual({ stars: 4, text: null }), suggestions: [BOAS[0]!] }), { nome: 'Diego A.' });
    const t = semMarcas(soANota);
    // Com uma sugestão só, o título não se repete na legenda (o P31 repetia): a legenda é a da escolha.
    expect(t.split('A sugestão do Social media').length - 1).toBe(1);
    expect(t).toContain('Escolha a resposta');
    expect(t).toContain('Pedir outra sugestão');
    expect(t).toContain('Só a nota, sem texto.');
    expect(t).toContain('Só a nota, sem texto: uma sugestão só, curta.');
    expect(t).toContain('O Compliance conferiu a sugestão antes de ela chegar aqui: ela não promete desconto');
  });

  it('a avaliação que mudou e o pedido ainda espera: o aviso de que ela não sai assim e de que o pedido vai sair daqui', () => {
    const t = semMarcas(desenho(pedido({}, { changed: true, current: atual({ stars: 4, text: 'Editei: a batata veio morna.' }) })));
    expect(t).toContain('A avaliação mudou depois das sugestões. Aprovada assim, a resposta não é publicada. Em alguns minutos, este pedido sai daqui, e o Social media escreve outras para a avaliação como está agora.');
    expect(t).toContain('Editei: a batata veio morna.');
  });

  it('decidido sem publicar: recusado (com "Escrever a resposta" para quem pode pedir), a avaliação mudou e respondida no Google, sempre com o que tinha sido sugerido', () => {
    const recusada = desenho(pedido({ status: 'cancelada', status_reason: 'recusada por Rodrigo: Nenhuma serve', updated_at: local(11, 0) }));
    expect(semMarcas(recusada)).toContain('Recusada por Rodrigo: “Nenhuma serve”. Nada foi publicado. A avaliação segue sem resposta, e o Social media não escreve outras para ela.');
    expect(semMarcas(recusada)).toContain('Escrever a resposta');
    expect(semMarcas(recusada)).toContain('O que tinha sido sugerido');
    expect(semMarcas(recusada)).toContain('Sugestão 1 · Curta · a escolhida');
    expect(opcoesDoDesenho(recusada)).toEqual([]);
    expect(recusada).not.toContain('Código do app');
    expect(semMarcas(desenho(pedido({ status: 'cancelada', status_reason: 'recusada por Rodrigo: Nenhuma serve' }), { podeOperar: false }))).not.toContain('Escrever a resposta');

    const mudou = semMarcas(desenho(pedido({ status: 'cancelada', status_reason: 'retirada pelo funcionário: avaliacao_mudou' }, { withdrawn: 'avaliacao_mudou', current: atual({ stars: 4, text: 'O combo veio caprichado, mas a batata chegou morna.' }) })));
    expect(mudou).toContain('A avaliação mudou depois das sugestões. A pessoa editou a avaliação, e agora são 4 estrelas.');
    expect(mudou).toContain('O combo veio caprichado, mas a batata chegou morna.');
    expect(mudou).not.toContain('Escrever a resposta');

    const respondida = semMarcas(
      desenho(pedido({ status: 'cancelada', status_reason: 'retirada pelo funcionário: respondida_no_google' }, { withdrawn: 'respondida_no_google', current: atual({ reply: { text: 'Obrigado!', state: 'aprovada', changed_at: local(10, 12), violation: null } }) })),
    );
    expect(respondida).toContain('Esta avaliação já tem resposta, dada direto no Google (hoje, 10:12). As sugestões saíram daqui e nada foi publicado pelo Liame. A resposta de lá aparece na tela Avaliações.');
    expect(respondida).toContain('O que tinha sido sugerido');
  });

  it('no Pro, sem a frase do Lite; o nome de quem avaliou só quando o Google informou', () => {
    const pro = semMarcas(desenho(pedido(), { pro: true }));
    expect(pro).not.toContain('Escolha a que preferir');
    expect(pro).toContain('Escolha a resposta');
    const semNome = semMarcas(desenho(pedido(), { nome: null }));
    expect(semNome).toContain('Responder a uma avaliação de 5 estrelas');
    expect(semNome).not.toContain('Marina');
  });
});
