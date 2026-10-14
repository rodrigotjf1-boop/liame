import type { ActionResponse, ReviewItem } from '@liame/contracts';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DetalheResposta, type Rascunho, RascunhoDaResposta } from '@/components/aprovacoes/detalhe-resposta';
import {
  type AcaoDeResposta,
  ehPedidoDeResposta,
  erroDoTexto,
  etiquetaDaResposta,
  fraseDaResposta,
  podeEscreverOutra,
  respostaApresentada,
  resultadoDaResposta,
  riscoDaResposta,
  situacaoDaResposta,
  textoDaRespostaValido,
  tituloDaResposta,
} from '@/components/aprovacoes/resposta-textos';
import { grupoDe } from '@/components/aprovacoes/textos';

// A resposta a uma avaliação do Google em Aprovações (A6 · Z2, parte e; mockups/prototipo-avaliacoes.html, P17): o
// título com o nome de quem avaliou (lido à parte, e que pode faltar), a situação de cada pedido (do pedido e da
// avaliação de agora), a frase, o resultado, e o detalhe desenhado para quem decide, para o dono e para quem só lê.

const uuid = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const agora = new Date(2026, 9, 14, 15, 0);
const local = (h: number, m = 0, d = 14) => new Date(2026, 9, d, h, m).toISOString();
const TEXTO = 'Que bom ler isso! Ficamos felizes com a visita, e até o próximo smash.';

const atual = (o: Partial<ReviewItem> = {}): ReviewItem => ({
  id: uuid(70),
  store_id: uuid(60),
  stars: 5,
  text: 'Melhor smash da região! A entrega foi rápida.',
  reviewed_at: local(20, 14, 13),
  changed_at: local(20, 14, 13),
  reply: null,
  ...o,
});
const resposta = (state: string, text = TEXTO, violation: string | null = null): NonNullable<ReviewItem['reply']> => ({ text, state, changed_at: local(11, 5), violation });

const pedido = (o: Partial<ActionResponse> = {}, review: Partial<NonNullable<ActionResponse['review']>> = {}): AcaoDeResposta =>
  ({
    id: uuid(1),
    tool: 'avaliacao_responder',
    action: 'avaliacao.responder',
    brand_id: uuid(50),
    provider: 'google_business',
    account_id: uuid(60),
    resource_id: `avaliacao:${uuid(70)}`,
    params: { texto: TEXTO },
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
    policy: { allowed: true, mode: 'APPROVAL', violations: [], versions: ['plataforma@8'] },
    approvals: [],
    workflow: null,
    expires_at: local(10, 12, 16),
    created_at: local(10, 12),
    updated_at: local(10, 12),
    requested_by: { id: uuid(2), name: 'Rodrigo' },
    account_name: 'Smash da Vila',
    campaign: null,
    recommendation: null,
    agent_key: null,
    target: null,
    from: null,
    to: null,
    execution: null,
    message: null,
    review: { id: uuid(70), stars: 5, owner_only: false, reply_text: TEXTO, current: atual(), changed: false, ...review },
    ...o,
  }) as AcaoDeResposta;

const aprovacao = (h = 11, m = 2) => [{ approved_by: uuid(2), approver_name: 'Rodrigo', approver_role: 'dono', sufficient: true, current_plan: true, created_at: local(h, m) }];
const executada = (reply: ReviewItem['reply'], o: Partial<ActionResponse> = {}) =>
  pedido({ status: 'executada', approvals: aprovacao(), updated_at: local(11, 3), ...o }, { current: atual({ reply }) });

function desenho(a: AcaoDeResposta, o: { pro?: boolean; nome?: string | null; souDono?: boolean; podeDecidir?: boolean; podeOperar?: boolean; euPedi?: boolean } = {}) {
  return renderToStaticMarkup(
    createElement(DetalheResposta, {
      acao: a,
      grupo: grupoDe(a, agora),
      agora,
      pro: o.pro ?? false,
      nome: o.nome === undefined ? 'Marina S.' : o.nome,
      euPedi: o.euPedi ?? false,
      souDono: o.souDono ?? true,
      podeDecidir: o.podeDecidir ?? true,
      podeOperar: o.podeOperar ?? true,
      temApp: true,
      apagada: null,
      titulo: createRef<HTMLHeadingElement>(),
      campoCodigo: createRef<HTMLInputElement>(),
      aoVoltar: () => {},
      aoAprovar: async () => ({ ok: true }) as const,
      aoRecusar: async () => ({ ok: true }) as const,
      aoSalvarTexto: async () => ({ ok: true }) as const,
      aoApagar: async () => ({ ok: true }) as const,
      aoEscreverOutra: () => {},
    }),
  );
}
const semMarcas = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#x27;/g, "'");

describe('a resposta a uma avaliação em Aprovações: os textos (A6 · Z2)', () => {
  it('o pedido de resposta e o de apagar a resposta se reconhecem pela ferramenta e pela avaliação', () => {
    expect(ehPedidoDeResposta(pedido())).toBe(true);
    expect(ehPedidoDeResposta(pedido({ tool: 'avaliacao_apagar_resposta' }))).toBe(true);
    expect(ehPedidoDeResposta(pedido({ review: null }))).toBe(false);
    expect(ehPedidoDeResposta(pedido({ tool: 'mensagem_disparar' }))).toBe(false);
  });

  it('o título leva o nome de quem avaliou quando o Google o informou; sem ele, a nota', () => {
    expect(tituloDaResposta(pedido(), 'Marina S.')).toBe('Responder à avaliação de Marina S.');
    expect(tituloDaResposta(pedido(), null)).toBe('Responder a uma avaliação de 5 estrelas');
    expect(tituloDaResposta(pedido({}, { stars: 1 }), null)).toBe('Responder a uma avaliação de 1 estrela');
    expect(tituloDaResposta(pedido({}, { stars: null, current: null }), null)).toBe('Responder a uma avaliação do Google');
    expect(tituloDaResposta(pedido({ tool: 'avaliacao_apagar_resposta' }), 'Marina S.')).toBe('Apagar a resposta à avaliação de Marina S.');
    expect(tituloDaResposta(pedido({ tool: 'avaliacao_apagar_resposta' }), null)).toBe('Apagar a resposta a uma avaliação de 5 estrelas');
  });

  it('a situação vem do pedido e, depois de publicada, da resposta que está no Google agora', () => {
    expect(situacaoDaResposta(pedido())).toBe('pendente');
    expect(situacaoDaResposta(pedido({ status: 'aprovada' }))).toBe('publicando');
    expect(situacaoDaResposta(executada(resposta('pendente')))).toBe('conferindo');
    expect(situacaoDaResposta(executada(resposta('aprovada')))).toBe('publicada');
    expect(situacaoDaResposta(executada(resposta('desconhecida')))).toBe('publicada');
    expect(situacaoDaResposta(executada(resposta('recusada', TEXTO, 'CODIGO_DE_EXEMPLO')))).toBe('recusada-google');
    // O Google pode devolver o texto com os espaços acertados: é a mesma resposta.
    expect(situacaoDaResposta(executada(resposta('aprovada', `  ${TEXTO.replace(', ', ',  ')}\n`)))).toBe('publicada');
    expect(situacaoDaResposta(executada(resposta('aprovada', 'Outra resposta, escrita direto no Google.')))).toBe('trocada');
    expect(situacaoDaResposta(executada(null))).toBe('fora-do-perfil');
    expect(situacaoDaResposta(pedido({ status: 'executada' }, { current: null }))).toBe('sem-avaliacao');
    expect(situacaoDaResposta(executada(resposta('aprovada'), { undone_by: { id: uuid(9), status: 'aprovada' } }))).toBe('apagando');
    expect(situacaoDaResposta(executada(null, { undone_by: { id: uuid(9), status: 'executada' } }))).toBe('apagada');
    // A volta que falhou não esconde a resposta que segue publicada.
    expect(situacaoDaResposta(executada(resposta('aprovada'), { undone_by: { id: uuid(9), status: 'falhou' } }))).toBe('publicada');
    expect(situacaoDaResposta(pedido({ status: 'falhou', execution: { status: 'estado_mudou', finished_at: local(11, 3), no_write: false, observed: null } }))).toBe('mudou');
    expect(situacaoDaResposta(pedido({ status: 'falhou', status_reason: 'escrita em google_business desligada' }))).toBe('falhou');
    expect(situacaoDaResposta(pedido({ status: 'cancelada', status_reason: 'recusada por Rodrigo: Quero outro texto' }))).toBe('recusada');
    expect(situacaoDaResposta(pedido({ status: 'cancelada' }))).toBe('cancelada');
    expect(situacaoDaResposta(pedido({ status: 'expirada' }))).toBe('expirada');
    // O pedido de apagar.
    const apagar = (status: ActionResponse['status']) => pedido({ tool: 'avaliacao_apagar_resposta', action: 'avaliacao.apagar_resposta', status, mode: 'AUTO' });
    expect([situacaoDaResposta(apagar('aprovada')), situacaoDaResposta(apagar('executada'))]).toEqual(['apagando', 'apagada']);
    expect([etiquetaDaResposta(apagar('aprovada')), etiquetaDaResposta(apagar('executada')), etiquetaDaResposta(apagar('falhou'))]).toEqual(['Apagando', 'Resposta apagada', 'Não apagada']);
  });

  it('a etiqueta na lista e o risco: a de 1 ou 2 estrelas diz que só o dono aprova; as outras, o risco da ferramenta', () => {
    expect([executada(resposta('pendente')), executada(resposta('aprovada')), executada(resposta('recusada'))].map(etiquetaDaResposta)).toEqual(['O Google está conferindo', 'Publicada', 'Recusada pelo Google']);
    expect(riscoDaResposta(pedido({}, { owner_only: true, stars: 1 }))).toEqual({ classe: 'alto', rotulo: 'Só o dono aprova' });
    expect(riscoDaResposta(pedido())).toEqual({ classe: 'medio', rotulo: 'Risco médio' });
  });

  it('a frase do Lite: quem escreveu, a nota, que é pública, em nome de qual loja e, para quem aprova, o que acontece', () => {
    const texto = (p: ReturnType<typeof fraseDaResposta>) => p.map((x) => x.t).join('');
    expect(texto(fraseDaResposta(pedido(), 'Marina S.', { euPedi: false, possoAprovar: true }))).toBe(
      'Rodrigo escreveu uma resposta para a avaliação de 5 estrelas que Marina S. deixou. Ela é pública e sai em nome da loja “Smash da Vila”. Se você aprovar, o Liame publica no Google.',
    );
    expect(texto(fraseDaResposta(pedido(), null, { euPedi: true, possoAprovar: false }))).toBe('Você escreveu uma resposta para a avaliação de 5 estrelas. Ela é pública e sai em nome da loja “Smash da Vila”.');
    expect(fraseDaResposta(pedido(), null, { euPedi: true, possoAprovar: true }).filter((x) => x.b).map((x) => x.t)).toEqual(['5 estrelas', 'pública']);
    expect(respostaApresentada(pedido(), 'Marina S.')).toMatchObject({ titulo: 'Responder à avaliação de Marina S.', impacto: null });
  });

  it('o resultado de cada situação, com a conferência do Google e o motivo da recusa só no Pro', () => {
    expect(resultadoDaResposta(executada(resposta('pendente')), null, false)).toMatchObject({ tom: 'espera', forte: 'Aprovada por Rodrigo às 11:02. O Google está conferindo a resposta.' });
    expect(resultadoDaResposta(executada(resposta('pendente')), null, false).texto).toContain('se o Google recusar, o aviso aparece em Atenção');
    expect(resultadoDaResposta(executada(resposta('aprovada')), null, false)).toMatchObject({ tom: 'ok', forte: 'Publicada no Google.' });
    expect(resultadoDaResposta(executada(resposta('aprovada')), null, false).texto).toContain('em nome da loja “Smash da Vila”');
    const recusada = executada(resposta('recusada', TEXTO, 'CODIGO_DE_EXEMPLO'));
    expect(resultadoDaResposta(recusada, null, false).texto).not.toContain('CODIGO_DE_EXEMPLO');
    expect(resultadoDaResposta(recusada, null, true).texto).toContain('(CODIGO_DE_EXEMPLO)');
    expect(resultadoDaResposta(executada(resposta('recusada')), null, true).texto).toContain('O Google não informou o motivo.');
    expect(resultadoDaResposta(executada(null, { undone_by: { id: uuid(9), status: 'executada' } }), { quem: 'Ana', quando: local(15, 2) }, false).forte).toBe('Resposta apagada por Ana às 15:02.');
    expect(resultadoDaResposta(pedido({ status: 'cancelada', status_reason: 'recusada por Rodrigo: Quero outro texto' }), null, false).texto).toBe('Recusada por Rodrigo: “Quero outro texto”. Nada foi publicado.');
    expect(resultadoDaResposta(pedido({ status: 'aprovada', approvals: aprovacao(), next_attempt_at: local(15, 30), status_reason: 'o Google pediu para esperar (limite de uso do Google)' }), null, false).texto).toContain('O Liame tenta de novo às 15:30');
  });

  it('a avaliação pode ganhar outra resposta: a recusada pelo Google, e a que ficou sem resposta depois de um pedido que não publicou', () => {
    expect(podeEscreverOutra(executada(resposta('recusada')))).toBe(true);
    expect(podeEscreverOutra(executada(resposta('aprovada')))).toBe(false);
    expect(podeEscreverOutra(pedido({ status: 'falhou', execution: { status: 'estado_mudou', finished_at: local(11, 3), no_write: false, observed: null } }))).toBe(true);
    // A que mudou e já ganhou resposta por outro caminho não.
    expect(podeEscreverOutra(pedido({ status: 'falhou', execution: { status: 'estado_mudou', finished_at: local(11, 3), no_write: false, observed: null } }, { current: atual({ reply: resposta('aprovada', 'Outra.') }) }))).toBe(false);
    expect(podeEscreverOutra(pedido({ tool: 'avaliacao_apagar_resposta', status: 'executada' }))).toBe(false);
  });

  it('o texto antes de salvar, e a recusa do servidor em palavras', () => {
    expect(textoDaRespostaValido('   ')).toBe('Escreva a resposta antes de salvar.');
    expect(textoDaRespostaValido('😀'.repeat(1500))).toBeNull();
    expect(textoDaRespostaValido('😀'.repeat(1501))).toBe('A resposta passa de 1.500 caracteres.');
    expect(erroDoTexto({ code: 'acao-duplicada', title: 'Já existe', detail: 'Já há um pedido ativo' })).toContain('Já há uma resposta esperando a aprovação para esta avaliação');
    expect(erroDoTexto({ code: 'plano-recusado', title: 'Não', detail: 'O texto da resposta não passa assim.' })).toBe('O texto da resposta não passa assim.');
  });
});

describe('a resposta a uma avaliação em Aprovações: o detalhe (A6 · Z2)', () => {
  it('esperando a decisão: a avaliação e a resposta lado a lado, o que foi conferido e a aprovação com o código do app', () => {
    const html = desenho(pedido());
    const texto = semMarcas(html);
    expect(texto).toContain('Responder à avaliação de Marina S.');
    expect(texto).toContain('A avaliação, como está no Google');
    expect(texto).toContain('Melhor smash da região!');
    expect(texto).toContain(TEXTO);
    expect(texto).toContain('Resposta pública');
    expect(texto).toContain('Risco médio');
    expect(texto).toContain('O Compliance conferiu o texto: não promete desconto, brinde nem reembolso');
    expect(texto).toContain('a aprovação vale só para este texto');
    expect(html).toContain('Código do app');
    expect(html).toContain('data-av-editar');
    // O nome de quem avaliou não aparece quando o Google não o informou.
    expect(semMarcas(desenho(pedido(), { nome: null }))).not.toContain('Marina');
  });

  it('a de 1 ou 2 estrelas: o dono vê "só o dono aprova" e decide; quem não é o dono lê e não aprova, não recusa nem edita', () => {
    const baixa = pedido({ action: 'avaliacao.responder_nota_baixa', mode: 'ESCALATE' }, { stars: 1, owner_only: true, current: atual({ stars: 1 }) });
    const doDono = semMarcas(desenho(baixa, { souDono: true }));
    expect(doDono).toContain('Só o dono aprova. É uma avaliação de 1 estrela: a resposta só sai com a sua aprovação');
    expect(desenho(baixa, { souDono: true })).toContain('Código do app');
    const deOutro = desenho(baixa, { souDono: false });
    expect(semMarcas(deOutro)).toContain('Esta resposta espera o dono.');
    expect(deOutro).not.toContain('Código do app');
    expect(deOutro).not.toContain('data-av-editar');
    expect(semMarcas(deOutro)).not.toContain('Recusar');
  });

  it('a avaliação que mudou depois do pedido avisa antes de aprovar; e quem não aprova só acompanha', () => {
    expect(semMarcas(desenho(pedido({}, { changed: true, current: atual({ stars: 4, text: 'Editei: veio frio.' }) })))).toContain('A avaliação mudou depois deste pedido.');
    const leitura = desenho(pedido(), { podeDecidir: false, podeOperar: false });
    expect(semMarcas(leitura)).toContain('Só quem pode aprovar decide este pedido.');
    expect(leitura).not.toContain('data-av-editar');
  });

  it('decidida: publicada oferece apagar (a quem pode pedir; na de nota baixa, só ao dono); recusada pelo Google oferece pedir de novo', () => {
    const publicada = desenho(executada(resposta('aprovada')));
    expect(semMarcas(publicada)).toContain('Publicada no Google.');
    expect(publicada).toContain('data-av-apagar');
    expect(semMarcas(publicada)).toContain('Não desfaz o aviso que quem avaliou já recebeu.');
    expect(desenho(executada(resposta('aprovada')), { podeOperar: false })).not.toContain('data-av-apagar');
    const baixaPublicada = pedido({ status: 'executada', approvals: aprovacao() }, { stars: 2, owner_only: true, current: atual({ stars: 2, reply: resposta('aprovada') }) });
    expect(desenho(baixaPublicada, { souDono: false })).not.toContain('data-av-apagar');
    expect(desenho(baixaPublicada, { souDono: true })).toContain('data-av-apagar');
    const recusada = desenho(executada(resposta('recusada')));
    expect(semMarcas(recusada)).toContain('Editar e pedir de novo');
    expect(recusada).not.toContain('data-av-apagar');
    expect(semMarcas(desenho(executada(resposta('pendente'))))).toContain('O Google está conferindo a resposta.');
  });

  it('o rascunho: o campo da resposta da pessoa; a avaliação que já tem resposta esperando leva a ela; a respondida não oferece o campo', () => {
    const rascunho = (o: Partial<Rascunho> = {}): Rascunho => ({ avaliacao: atual({ stars: 4, text: null }), loja: 'Smash da Vila', textoInicial: '', pendente: null, ...o });
    const desenhar = (r: Rascunho, podeOperar = true) =>
      renderToStaticMarkup(
        createElement(RascunhoDaResposta, {
          rascunho: r,
          nome: 'Diego A.',
          meuNome: 'Rodrigo',
          agora,
          podeOperar,
          titulo: createRef<HTMLHeadingElement>(),
          aoVoltar: () => {},
          aoSalvar: async () => ({ ok: true }) as const,
          aoAbrirPendente: () => {},
        }),
      );
    const livre = desenhar(rascunho());
    expect(semMarcas(livre)).toContain('Responder à avaliação de Diego A.');
    expect(semMarcas(livre)).toContain('Você vai responder à avaliação de 4 estrelas que Diego A. deixou. A resposta é pública e sai em nome da loja “Smash da Vila”.');
    expect(semMarcas(livre)).toContain('Só a nota, sem texto.');
    expect(livre).toContain('<textarea');
    expect(semMarcas(livre)).toContain('Salve o texto para poder aprovar.');
    const esperando = desenhar(rascunho({ pendente: uuid(1) }));
    expect(semMarcas(esperando)).toContain('Esta avaliação já tem uma resposta esperando a aprovação.');
    expect(esperando).not.toContain('<textarea');
    expect(desenhar(rascunho({ avaliacao: atual({ reply: resposta('aprovada') }) }))).not.toContain('<textarea');
    // A recusada pelo Google pode ganhar outra: o campo aparece.
    expect(desenhar(rascunho({ avaliacao: atual({ reply: resposta('recusada') }), textoInicial: TEXTO }))).toContain('<textarea');
    expect(desenhar(rascunho(), false)).not.toContain('<textarea');
  });
});
