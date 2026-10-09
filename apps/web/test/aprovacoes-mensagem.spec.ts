import type { ActionResponse, MessagingCampaign } from '@liame/contracts';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { quemPediu } from '@/components/aprovacoes/anuncio-textos';
import { DetalheMensagem } from '@/components/aprovacoes/detalhe-mensagem';
import {
  type AcaoDeMensagem,
  bolhaDaMensagem,
  cupomContaEmMensagens,
  ehPedidoDeMensagem,
  etiquetaDaMensagem,
  horaCurta,
  impedimentoDoPedido,
  janelaEscrita,
  mensagemApresentada,
  pessoasDaMensagem,
  quantoCusta,
  quemRecebe,
  regraDoCupomEscrita,
  resultadoDaPausa,
  resultadoDoEnvio,
  textosDaMensagem,
  trechosDoTexto,
} from '@/components/aprovacoes/mensagem-textos';
import { grupoDe } from '@/components/aprovacoes/textos';
import { horaDe } from '@/lib/formato';

// O pedido de mensagem de WhatsApp em Aprovações (A5 · Y5; mockups/prototipo-mensagens.html, P15): como o pedido de
// envio se apresenta (as quatro partes, o cupom, o risco), o que impede a aprovação, o resultado depois de decidido com
// os números do RegemCast, a pausa direta e o detalhe desenhado para quem decide e para quem só acompanha.

const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const agora = new Date(2026, 9, 9, 15, 0);
const local = (h: number, m = 0, d = 9) => new Date(2026, 9, d, h, m).toISOString();
const RS = `R$${String.fromCharCode(160)}`;

type Mensagem = NonNullable<ActionResponse['message']>;
const mensagem = (o: Partial<Mensagem> = {}): Mensagem => ({
  campaign_id: uuid(90),
  name: 'Combo família de domingo',
  template: { name: 'combo_domingo_v2', language: 'pt_BR', category: 'marketing', header: null, body: 'Oi, {{1}}! Domingo tem combo família por R$ 89,90. Peça com o cupom {{2}} e ganhe 10% de desconto.', footer: 'Responda SAIR para não receber mais.', buttons: ['Ver o cardápio'] },
  variables: [
    { origin: 'primeiro_nome', value: null },
    { origin: 'fixo', value: 'COMBO10' },
  ],
  header_variable: null,
  audience: { name: 'Quem pediu nos últimos 30 dias', rule: 'Pediu pelo menos uma vez nos últimos 30 dias', can_receive: 412, resting: 38, rest_days: 7 },
  window: { days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '20:00' },
  coupon: { code: 'COMBO10', kind: 'percentual', percent: 10, value_cents: null, min_order_cents: null, valid_from: '2026-10-10', valid_until: '2026-10-12', created: false },
  plan: { status: 'rascunho', people: 412, recipients: 412, cost_cents: 13_184, currency: 'BRL', budget: { defined: true, periods: [{ period: 'mes', label: 'Outubro', limit_cents: 30_000, spent_cents: 12_736, signal: 'ok' }], notice: null } },
  ...o,
});

const pedido = (o: Partial<ActionResponse> = {}): AcaoDeMensagem =>
  ({
    id: uuid(1),
    tool: 'mensagem_disparar',
    action: 'mensagem.disparar',
    brand_id: uuid(50),
    provider: 'regemcast',
    account_id: uuid(60),
    resource_id: `mensagem:${uuid(90)}`,
    params: {},
    risk_level: 'R3',
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
    policy: { allowed: true, mode: 'APPROVAL', violations: [], versions: ['plataforma@6'] },
    approvals: [],
    workflow: null,
    expires_at: local(10, 12, 12),
    created_at: local(10, 12),
    updated_at: local(10, 12),
    requested_by: { id: uuid(2), name: 'Rodrigo' },
    account_name: 'Smash da Vila',
    campaign: null,
    recommendation: null,
    agent_key: 'crm',
    target: null,
    from: null,
    to: null,
    execution: null,
    message: mensagem(),
    ...o,
  }) as AcaoDeMensagem;

const aprovacao = (h = 11, m = 2) => [{ approved_by: uuid(2), approver_name: 'Rodrigo', approver_role: 'dono', sufficient: true, current_plan: true, created_at: local(h, m) }];
const campanha = (o: Partial<MessagingCampaign> = {}): MessagingCampaign => ({
  id: uuid(90),
  name: 'Combo família de domingo',
  status: 'enviando',
  pause_reason: null,
  template: 'combo_domingo_v2',
  category: 'marketing',
  audience: 'Quem pediu nos últimos 30 dias',
  recipients: 412,
  queued: 232,
  sent: 180,
  delivered: 171,
  read: 96,
  failed: 0,
  replied: 4,
  created_at: local(10, 12),
  started_at: local(11, 3),
  finished_at: null,
  ...o,
});
const corrido = (t: { t: string }[]) => t.map((x) => x.t).join('');
const semMarcas = (html: string) => html.replace(/<[^>]+>/g, '');

function desenho(a: AcaoDeMensagem, o: { pro?: boolean; podeDecidir?: boolean; podeOperar?: boolean } = {}) {
  return renderToStaticMarkup(
    createElement(DetalheMensagem, {
      acao: a,
      grupo: grupoDe(a, agora),
      agora,
      pro: o.pro ?? false,
      podeDecidir: o.podeDecidir ?? true,
      podeOperar: o.podeOperar ?? true,
      temApp: true,
      pausa: null,
      titulo: createRef<HTMLHeadingElement>(),
      campoCodigo: createRef<HTMLInputElement>(),
      aoVoltar: () => {},
      aoAprovar: async () => ({ ok: true }) as const,
      aoRecusar: async () => ({ ok: true }) as const,
      aoConferir: async () => ({ ok: true }) as const,
      aoPausar: async () => ({ ok: true }) as const,
    }),
  );
}

describe('pedido de mensagem: o que é e quem pediu', () => {
  it('é pedido de mensagem o envio e a pausa que trazem a mensagem; os outros, não', () => {
    expect(ehPedidoDeMensagem(pedido())).toBe(true);
    expect(ehPedidoDeMensagem(pedido({ tool: 'mensagem_pausar' }))).toBe(true);
    expect(ehPedidoDeMensagem(pedido({ message: null }))).toBe(false);
    expect(ehPedidoDeMensagem(pedido({ tool: 'regem_cupom_criar' }))).toBe(false);
  });

  it('o funcionário de CRM e mensageria tem nome; a pessoa aparece com o dela', () => {
    expect(quemPediu(pedido())).toEqual({ nome: 'CRM e mensageria', funcionario: true });
    expect(quemPediu(pedido({ agent_key: null }))).toEqual({ nome: 'Rodrigo', funcionario: false });
  });

  it('a lista: o título com as pessoas, o custo como teto, e a pausa sem valor', () => {
    expect(mensagemApresentada(pedido())).toMatchObject({ titulo: 'Enviar “Combo família de domingo” para 412 pessoas', impacto: `até ${RS}131,84`, depoisDeAprovar: 'O RegemCast começa a enviar dentro da janela.' });
    expect(mensagemApresentada(pedido({ tool: 'mensagem_pausar' }))).toMatchObject({ titulo: 'Pausar o envio de “Combo família de domingo”', impacto: null });
    expect(mensagemApresentada(pedido({ message: mensagem({ plan: null }) })).impacto).toBeNull();
    expect(pessoasDaMensagem(mensagem({ plan: null }))).toBe(412);
    expect(textosDaMensagem(pedido({ message: mensagem({ plan: { ...mensagem().plan!, people: 1 } }) })).titulo).toBe('Enviar “Combo família de domingo” para 1 pessoa');
  });
});

describe('pedido de mensagem: as quatro partes', () => {
  it('a mensagem: o valor fixo no lugar, e a marca do que o RegemCast preenche (o Liame não vê o nome)', () => {
    const b = bolhaDaMensagem(mensagem());
    expect(b.corpo).toEqual([{ t: 'Oi, ' }, { t: 'primeiro nome', variavel: true }, { t: '! Domingo tem combo família por R$ 89,90. Peça com o cupom ' }, { t: 'COMBO10' }, { t: ' e ganhe 10% de desconto.' }]);
    expect(b).toMatchObject({ titulo: null, rodape: 'Responda SAIR para não receber mais.', botoes: ['Ver o cardápio'] });
    expect(b.nota).toBe('Modelo de marketing, aprovado pela Meta. O RegemCast põe o primeiro nome de cada pessoa na hora do envio; o Liame não vê nome nem telefone.');
    // Sem variável de pessoa, a nota não promete o que não acontece.
    const fixa = bolhaDaMensagem(mensagem({ template: { ...mensagem().template, body: 'Hoje tem {{1}}.', category: null }, variables: [{ origin: 'fixo', value: 'smash em dobro' }] }));
    expect(fixa.nota).toBe('Modelo, aprovado pela Meta. O Liame não vê nome nem telefone de quem recebe.');
    expect(corrido(fixa.corpo)).toBe('Hoje tem smash em dobro.');
    // O título com variável, e duas variáveis de pessoa.
    const comTitulo = bolhaDaMensagem(mensagem({ template: { ...mensagem().template, header: 'Novidade na {{1}}' }, header_variable: { origin: 'fixo', value: 'Loja Centro' }, variables: [{ origin: 'nome', value: null }, { origin: 'cashback_saldo', value: null }] }));
    expect(corrido(comTitulo.titulo!)).toBe('Novidade na Loja Centro');
    expect(comTitulo.nota).toContain('O RegemCast põe o nome e o saldo de cashback de cada pessoa na hora do envio');
    // A variável sem valor na proposta fica como veio, em vez de sumir.
    expect(trechosDoTexto('A {{1}} e a {{3}}.', [{ origin: 'fixo', value: 'um' }])).toEqual([{ t: 'A ' }, { t: 'um' }, { t: ' e a ' }, { t: '{{3}}' }, { t: '.' }]);
    expect(trechosDoTexto('Sem variável.', [])).toEqual([{ t: 'Sem variável.' }]);
  });

  it('quem recebe: a conta de quem pode, quem fica de fora pelo descanso e quem recebe', () => {
    expect(quemRecebe(mensagem())).toEqual({
      forte: '412 pessoas',
      publico: 'Quem pediu nos últimos 30 dias: Pediu pelo menos uma vez nos últimos 30 dias.',
      conta: [
        { rotulo: 'Podem receber neste público', valor: '450' },
        { rotulo: 'Ficam de fora: receberam marketing nos últimos 7 dias', valor: '38' },
        { rotulo: 'Recebem esta mensagem', valor: '412' },
      ],
      nota: 'Quem pediu para sair ou não tem WhatsApp já não entra nos 450.',
    });
    // Sem ninguém em descanso, a linha não aparece; sem regra, só o nome do público.
    const simples = quemRecebe(mensagem({ audience: { name: 'Clientes de domingo', rule: null, can_receive: 412, resting: 0, rest_days: null } }));
    expect(simples.publico).toBe('Clientes de domingo.');
    expect(simples.conta.map((c) => c.rotulo)).toEqual(['Podem receber neste público', 'Recebem esta mensagem']);
    expect(quemRecebe(mensagem({ audience: { ...mensagem().audience, rest_days: null } })).conta[1]!.rotulo).toBe('Ficam de fora: receberam marketing há pouco');
  });

  it('quando sai: a janela em palavras, sempre com o horário', () => {
    expect(horaCurta('09:00')).toBe('9h');
    expect(horaCurta('14:30')).toBe('14h30');
    expect(janelaEscrita({ days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '20:00' })).toBe('todos os dias, das 9h às 20h');
    expect(janelaEscrita({ days: [6, 0], start: '11:00', end: '14:30' })).toBe('domingo e sábado, das 11h às 14h30');
    expect(janelaEscrita({ days: [5], start: '18:00', end: '20:00' })).toBe('só sexta, das 18h às 20h');
    expect(janelaEscrita({ days: [1, 3, 5], start: '09:00', end: '12:00' })).toBe('segunda, quarta e sexta, das 9h às 12h');
    const t = textosDaMensagem(pedido());
    expect(t.quando).toEqual({ forte: 'Depois da aprovação, todos os dias, das 9h às 20h', texto: 'Só dentro da janela das 9h às 20h. O que não sair num dia continua no seguinte, na mesma janela.' });
  });

  it('quanto custa: é teto, e a conta com o teto de gasto do mês diz se cabe', () => {
    expect(quantoCusta(mensagem())).toEqual({ forte: `até ${RS}131,84`, texto: `É estimativa e é teto: a Meta só cobra a mensagem entregue. Do seu teto de gasto de outubro (${RS}300,00) sobram ${RS}172,64: cabe.`, naoCabe: false });
    const cara = mensagem({ plan: { ...mensagem().plan!, cost_cents: 20_000 } });
    expect(quantoCusta(cara)).toMatchObject({ forte: `até ${RS}200,00`, naoCabe: true });
    expect(quantoCusta(cara).texto).toContain(`sobram ${RS}172,64: não cabe.`);
    // Sem teto do mês, sem preço e sem o plano.
    const semMes = mensagem({ plan: { ...mensagem().plan!, budget: { defined: true, periods: [{ period: 'dia', label: 'Hoje', limit_cents: 5000, spent_cents: 0, signal: 'ok' }], notice: 'A campanha vai sair aos poucos' } } });
    expect(quantoCusta(semMes).texto).toBe('É estimativa e é teto: a Meta só cobra a mensagem entregue. A campanha vai sair aos poucos.');
    expect(quantoCusta(mensagem({ plan: { ...mensagem().plan!, budget: { defined: false, periods: [], notice: null } } })).texto).toContain('A conta não tem teto de gasto de mensagens definido no RegemCast.');
    expect(quantoCusta(mensagem({ plan: { ...mensagem().plan!, cost_cents: null } }))).toEqual({ forte: 'Sem preço para estimar', texto: 'O RegemCast não tem preço cadastrado para estimar o custo desta mensagem.', naoCabe: false });
    expect(quantoCusta(mensagem({ plan: null })).forte).toBe('Sem preço para estimar');
  });

  it('o cupom: a regra em palavras, e que ele nasce junto com o envio', () => {
    expect(regraDoCupomEscrita(mensagem().coupon!)).toBe('10% de desconto, válido de 10/10 a 12/10');
    expect(regraDoCupomEscrita({ ...mensagem().coupon!, kind: 'valor', percent: null, value_cents: 500, min_order_cents: 4000 })).toBe(`${RS}5,00 de desconto, em pedidos a partir de ${RS}40,00, válido de 10/10 a 12/10`);
    expect(regraDoCupomEscrita({ ...mensagem().coupon!, kind: 'frete_gratis', percent: null })).toBe('entrega grátis, válido de 10/10 a 12/10');
    expect(textosDaMensagem(pedido()).cupom).toEqual({ codigo: 'COMBO10', texto: '10% de desconto, válido de 10/10 a 12/10. Ele é criado no Regem junto com o envio e é só desta mensagem: é por ele que os pedidos que vieram dela são contados no caixa.' });
    expect(textosDaMensagem(pedido({ message: mensagem({ coupon: { ...mensagem().coupon!, created: true } }) })).cupom!.texto).toContain('Ele já foi criado no Regem, junto com o envio, e é só desta mensagem');
    expect(textosDaMensagem(pedido({ message: mensagem({ coupon: null }) })).cupom).toBeNull();
  });

  it('a frase do modo simples e o risco, que é o do servidor', () => {
    const t = textosDaMensagem(pedido());
    expect(corrido(t.frase)).toBe(`O funcionário de CRM e mensageria propõe enviar “Combo família de domingo” por WhatsApp para 412 pessoas (Quem pediu nos últimos 30 dias), todos os dias, das 9h às 20h. Pode custar até ${RS}131,84. Se você aprovar, o RegemCast envia.`);
    expect(t.frase.filter((x) => x.b).map((x) => x.t)).toEqual(['“Combo família de domingo”', '412 pessoas', `até ${RS}131,84`]);
    expect([t.risco, t.doRisco]).toEqual(['alto', `Gasta até ${RS}131,84 e fala com 412 clientes de uma vez.`]);
    expect(corrido(textosDaMensagem(pedido({ agent_key: null })).frase)).toContain('Rodrigo pediu para enviar “Combo família de domingo”');
    // Com impedimento, a frase não promete o envio.
    expect(corrido(textosDaMensagem(pedido({ blocked_reason: 'O modelo desta campanha ainda não foi aprovado pela Meta.' })).frase)).not.toContain('Se você aprovar');
  });
});

describe('pedido de mensagem: o que impede a aprovação', () => {
  it('a frase do RegemCast faz o pedido esperar, e a tela diz que o Liame confere de novo sozinho e avisa', () => {
    expect(impedimentoDoPedido(pedido())).toBeNull();
    expect(impedimentoDoPedido(pedido({ blocked_reason: 'O modelo desta campanha ainda não foi aprovado pela Meta' }))).toEqual({
      tom: 'espera',
      icone: 'clock',
      forte: 'Ainda não dá para aprovar.',
      texto: 'O modelo desta campanha ainda não foi aprovado pela Meta. O Liame confere de novo sozinho, de 15 em 15 minutos, e avisa por e-mail quando der para aprovar.',
    });
    // Depois de decidido, o impedimento não aparece mais.
    expect(impedimentoDoPedido(pedido({ status: 'cancelada', blocked_reason: 'x' }))).toBeNull();
  });

  it('o envio que não cabe no teto de gasto tem o título dele, e a conta em seguida', () => {
    const motivo = `Não cabe no teto de gasto de mensagens do mês: o envio pode custar até ${RS}200,00, e sobram ${RS}172,64 de ${RS}300,00. Quem muda o teto é o dono da conta, no RegemCast; outra saída é um público menor.`;
    expect(impedimentoDoPedido(pedido({ blocked_reason: motivo }))).toEqual({
      tom: 'falha',
      icone: 'wallet',
      forte: 'Ainda não dá para aprovar: não cabe no teto de gasto de mensagens.',
      texto: `O envio pode custar até ${RS}200,00, e sobram ${RS}172,64 de ${RS}300,00. Quem muda o teto é o dono da conta, no RegemCast; outra saída é um público menor.`,
    });
  });
});

describe('pedido de mensagem: o resultado', () => {
  const enviado = (o: Partial<ActionResponse> = {}) => pedido({ status: 'executada', approvals: aprovacao(), updated_at: local(11, 3), ...o });

  it('recusada, cancelada, expirada e a que não foi enviada: nada saiu, com o motivo', () => {
    expect(resultadoDoEnvio(pedido({ status: 'cancelada', status_reason: 'recusada por Rodrigo: Quero outro texto' }), null, null, null)).toMatchObject({ tom: 'falha', texto: 'Recusada por Rodrigo: “Quero outro texto”. Nada foi enviado.', podePausar: false });
    expect(resultadoDoEnvio(pedido({ status: 'cancelada', status_reason: 'cancelada por quem opera' }), null, null, null).texto).toBe('Cancelada por quem pediu. Nada foi enviado.');
    expect(resultadoDoEnvio(pedido({ status: 'expirada' }), null, null, null).texto).toBe('Expirou sem aprovação: nada foi enviado.');
    const falhou = resultadoDoEnvio(pedido({ status: 'falhou', approvals: aprovacao(), status_reason: 'O cupom COMBO10 desta mensagem não foi criado no Regem. Já existe um cupom com este código no Regem. Nada foi enviado.' }), null, null, null);
    expect(falhou).toMatchObject({ tom: 'falha', forte: `Aprovada por Rodrigo às ${horaDe(local(11, 2))}, mas a mensagem não foi enviada.` });
    expect(falhou.texto).toBe(' O cupom COMBO10 desta mensagem não foi criado no Regem. Já existe um cupom com este código no Regem. Nada foi enviado.');
  });

  it('aprovada e ainda não enviada ao RegemCast; e a que o RegemCast pediu para esperar', () => {
    expect(resultadoDoEnvio(pedido({ status: 'aprovada', approvals: aprovacao() }), null, null, null)).toMatchObject({ tom: 'espera', forte: `Aprovada por Rodrigo às ${horaDe(local(11, 2))}.`, texto: ' O Liame manda o envio para o RegemCast em instantes.' });
    const adiada = resultadoDoEnvio(pedido({ status: 'aprovada', approvals: aprovacao(), next_attempt_at: local(11, 20), status_reason: 'o RegemCast está fora do ar' }), null, null, null);
    expect(adiada.texto).toBe(` Ainda não foi para o RegemCast: o RegemCast está fora do ar. O Liame tenta de novo às ${horaDe(local(11, 20))}.`);
  });

  it('enviando: quantas já saíram, e dá para pausar; sem a leitura do RegemCast, a tela não inventa número', () => {
    expect(resultadoDoEnvio(enviado(), campanha(), null, null)).toEqual({ tom: 'espera', icone: 'clock', forte: `Aprovada por Rodrigo às ${horaDe(local(11, 2))}. O RegemCast está enviando:`, texto: ' 180 de 412 já saíram.', podePausar: true });
    expect(resultadoDoEnvio(enviado(), campanha({ status: 'agendada', sent: 0 }), null, null)).toMatchObject({ texto: ' 0 de 412 já saíram.', podePausar: true });
    expect(resultadoDoEnvio(enviado(), null, null, null)).toMatchObject({ tom: 'espera', texto: ' O envio está com o RegemCast.', podePausar: false });
  });

  it('pausada: o que saiu não volta, o que não saiu, e quem pausou quando a tela sabe', () => {
    const parada = campanha({ status: 'pausada', queued: 232, sent: 180 });
    expect(resultadoDoEnvio(enviado(), parada, null, { quem: 'Rodrigo', quando: local(11, 7) })).toEqual({
      tom: 'neutro',
      icone: 'pause',
      forte: `Pausada por Rodrigo às ${horaDe(local(11, 7))}.`,
      texto: ' 180 mensagens já tinham saído e não voltam; 232 não saíram. Para retomar o envio, abra a campanha no RegemCast.',
      podePausar: false,
    });
    expect(resultadoDoEnvio(enviado(), parada, null, null).forte).toBe('Pausada.');
    expect(resultadoDoEnvio(enviado(), campanha({ status: 'pausada', recipients: 2, sent: 1 }), null, null).texto).toBe(' 1 mensagem já tinha saído e não volta; 1 não saiu. Para retomar o envio, abra a campanha no RegemCast.');
  });

  it('enviada: quantas pessoas receberam, o que custou e a estimativa; cancelada no RegemCast', () => {
    const feita = campanha({ status: 'concluida', sent: 405, delivered: 398, queued: 0, finished_at: local(11, 19) });
    const custo = { currency: 'BRL', spent_cents: 12_736, to_spend_cents: 0, lines: [], notices: [] };
    expect(resultadoDoEnvio(enviado(), feita, custo, null)).toEqual({
      tom: 'ok',
      icone: 'check',
      forte: 'Enviada.',
      texto: ` O RegemCast terminou às ${horaDe(local(11, 19))}: 398 pessoas receberam, e custou ${RS}127,36 (a estimativa era até ${RS}131,84).`,
      podePausar: false,
    });
    expect(resultadoDoEnvio(enviado(), feita, null, null).texto).toBe(` O RegemCast terminou às ${horaDe(local(11, 19))}: 398 pessoas receberam.`);
    expect(resultadoDoEnvio(enviado(), campanha({ status: 'cancelada', sent: 12 }), null, null).texto).toBe(' A campanha foi cancelada no RegemCast: 12 mensagens saíram antes disso.');
  });

  it('a pausa é direta: quem pediu é quem pausou, e ela entra nas decididas do dia, não no "feito sozinho"', () => {
    const pausa = pedido({ tool: 'mensagem_pausar', action: 'mensagem.pausar', risk_level: 'R1', mode: 'AUTO', agent_key: null, undoes: uuid(1), status: 'executada', updated_at: local(11, 7) });
    expect(resultadoDaPausa(pausa)).toMatchObject({ tom: 'neutro', forte: `Pausada por Rodrigo às ${horaDe(local(11, 7))}.`, texto: ' O que já foi enviado não volta. Para retomar o envio, abra a campanha no RegemCast.' });
    expect(resultadoDaPausa({ ...pausa, status: 'aprovada' })).toMatchObject({ tom: 'espera', forte: 'Rodrigo pediu a pausa.', texto: ' O Liame pausa no RegemCast em instantes.' });
    expect(resultadoDaPausa({ ...pausa, status: 'falhou', status_reason: 'O RegemCast não pausou o envio: a campanha já terminou' }).texto).toBe(' O RegemCast não pausou o envio: a campanha já terminou.');
    expect(grupoDe(pausa, agora)).toBe('feito');
    // O que a política faz sozinha de verdade (outra ferramenta, sem pessoa) continua no grupo dele.
    expect(grupoDe(pedido({ tool: 'orcamento_ajustar', mode: 'AUTO', status: 'executada', updated_at: local(11, 7) }), agora)).toBe('auto');
  });

  it('a etiqueta na lista segue o que aconteceu', () => {
    expect(etiquetaDaMensagem(pedido({ status: 'cancelada', status_reason: 'recusada por Rodrigo: Não é o momento' }))).toBe('Recusada');
    expect(etiquetaDaMensagem(pedido({ status: 'expirada' }))).toBe('Expirou');
    expect(etiquetaDaMensagem(pedido({ status: 'falhou' }))).toBe('Não enviada');
    expect(etiquetaDaMensagem(pedido({ status: 'aprovada' }))).toBe('Indo para o RegemCast');
    expect(etiquetaDaMensagem(pedido({ status: 'executada' }))).toBe('No RegemCast');
    expect(etiquetaDaMensagem(pedido({ status: 'executada', undone_by: { id: uuid(3), status: 'executada' } }))).toBe('Pausada');
    expect(etiquetaDaMensagem(pedido({ tool: 'mensagem_pausar', status: 'executada' }))).toBe('Pausada');
    expect(etiquetaDaMensagem(pedido({ tool: 'mensagem_pausar', status: 'falhou' }))).toBe('Não pausada');
  });
});

describe('pedido de mensagem: o detalhe desenhado', () => {
  it('esperando a decisão, no modo simples: a frase, as quatro partes à vista, o cupom, o risco e aprovar com o código do app', () => {
    const html = desenho(pedido());
    const t = semMarcas(html);
    expect(t).toContain('CRM e mensageria pediu');
    expect(t).toContain('funcionário de IA');
    expect(html).toContain('id="ap-det-titulo"');
    expect(t).toContain('Enviar “Combo família de domingo” para 412 pessoas');
    expect(t).toContain('Se você aprovar, o RegemCast envia.');
    expect(t).toContain('Mensagem enviada não volta');
    expect(t).toContain('modelo combo_domingo_v2 · a aprovação vale só para este plano: mudou o texto, o público ou o horário, é outro pedido');
    for (const parte of ['A mensagem', 'Quem recebe', 'Quando sai', 'Quanto custa']) expect(t).toContain(parte);
    expect(html).toContain('class="mens-var">primeiro nome</span>');
    expect(html).toContain('aria-label="A mensagem, como aparece no WhatsApp de quem recebe"');
    expect(t).toContain('Recebem esta mensagem412');
    expect(t).toContain('O cupom da mensagem');
    expect(t).toContain('Risco alto');
    expect(t).toContain('Se ninguém decidir, o pedido expira e nada é enviado.');
    // A aprovação é a de sempre, com o código do app e os motivos da mensagem.
    expect(html).toContain('one-time-code');
    expect(t).toContain('Aprovar');
    for (const motivo of ['Não é o momento', 'Quero outro texto', 'Quero outro público', 'Não quero enviar']) expect(t).toContain(motivo);
    expect(html).not.toContain('id="mens-impede"');
    expect(html).not.toContain('data-mens-conferir');
    // Nenhum nome e nenhum telefone de quem recebe.
    expect(html).not.toMatch(/\+55\d{10,11}/);
  });

  it('no modo completo a frase do modo simples sai, e as quatro partes ficam', () => {
    const html = desenho(pedido(), { pro: true });
    expect(semMarcas(html)).not.toContain('Se você aprovar, o RegemCast envia.');
    expect(html).toContain('class="mens-quatro"');
    expect(semMarcas(html)).toContain('Risco e limites');
  });

  it('com impedimento, o motivo vem logo abaixo do título, e sobram conferir de novo e recusar: sem o campo do código', () => {
    const html = desenho(pedido({ blocked_reason: 'O modelo desta campanha ainda não foi aprovado pela Meta.' }));
    const t = semMarcas(html);
    expect(html).toContain('id="mens-impede"');
    expect(html).toContain('class="resultado resultado--espera" role="status"');
    expect(t).toContain('Ainda não dá para aprovar.');
    expect(t).toContain('Enquanto isso não se resolve, o pedido espera aqui, e o Liame confere de novo sozinho. Você também pode conferir agora, ou recusar.');
    expect(html).toContain('data-mens-conferir');
    expect(t).toContain('Conferir de novo');
    expect(t).toContain('Recusar');
    expect(html).not.toContain('one-time-code');
    expect(t).not.toContain('Aprovando');
    // O teto que não cabe é anunciado na hora.
    const teto = desenho(pedido({ blocked_reason: 'Não cabe no teto de gasto de mensagens do mês: o envio pode custar até R$ 200,00.' }));
    expect(teto).toContain('class="resultado resultado--falha" role="alert"');
    expect(semMarcas(teto)).toContain('Ainda não dá para aprovar: não cabe no teto de gasto de mensagens.');
  });

  it('quem só acompanha vê o pedido inteiro, sem aprovar, recusar nem conferir', () => {
    const html = desenho(pedido({ blocked_reason: 'O modelo ainda não foi aprovado.' }), { podeDecidir: false });
    const t = semMarcas(html);
    expect(t).toContain('Só quem pode aprovar decide este pedido. Você acompanha por aqui.');
    expect(html).not.toContain('data-mens-conferir');
    expect(html).not.toContain('one-time-code');
    expect(html).toContain('class="mens-quatro"');
  });

  it('decidido: o resultado em cima, "o que foi pedido" embaixo, e a recusada sem o cupom', () => {
    const recusada = desenho(pedido({ status: 'cancelada', status_reason: 'recusada por Rodrigo: Quero outro texto', updated_at: local(11, 5) }));
    const t = semMarcas(recusada);
    expect(recusada).toContain('class="resultado resultado--falha"');
    expect(t).toContain('Recusada por Rodrigo: “Quero outro texto”. Nada foi enviado.');
    expect(t).toContain('O que foi pedido');
    expect(t).not.toContain('O cupom da mensagem');
    expect(recusada).not.toContain('one-time-code');
    // A pausa, feita: quem pausou, e o que foi pedido continua à vista.
    const pausa = desenho(pedido({ tool: 'mensagem_pausar', action: 'mensagem.pausar', mode: 'AUTO', agent_key: null, status: 'executada', updated_at: local(11, 7) }));
    expect(semMarcas(pausa)).toContain('Pausar o envio de “Combo família de domingo”');
    expect(semMarcas(pausa)).toContain(`Pausada por Rodrigo às ${horaDe(local(11, 7))}.`);
    expect(pausa).not.toContain('data-mens-pausar');
  });

  it('o envio que foi para o RegemCast com o cupom criado diz onde os pedidos do cupom aparecem; antes disso, não', () => {
    const criado = mensagem({ coupon: { ...mensagem().coupon!, created: true } });
    const enviado = pedido({ status: 'executada', approvals: aprovacao(), message: criado });
    expect(cupomContaEmMensagens(enviado)).toBe(true);
    const html = desenho(enviado);
    expect(html).toContain('id="mens-cupom-onde"');
    expect(semMarcas(html)).toContain('Os pedidos com o cupom COMBO10 aparecem em Mensagens conforme forem confirmados no caixa.');
    // Esperando a decisão, o cupom ainda não existe; e o envio que falhou não tem o que contar.
    expect(cupomContaEmMensagens(pedido())).toBe(false);
    expect(desenho(pedido())).not.toContain('id="mens-cupom-onde"');
    expect(cupomContaEmMensagens(pedido({ status: 'falhou', approvals: aprovacao(), message: criado }))).toBe(false);
    // Sem cupom, e no pedido de pausa, a linha não aparece.
    expect(cupomContaEmMensagens(pedido({ status: 'executada', approvals: aprovacao(), message: mensagem({ coupon: null }) }))).toBe(false);
    expect(cupomContaEmMensagens(pedido({ tool: 'mensagem_pausar', action: 'mensagem.pausar', mode: 'AUTO', agent_key: null, status: 'executada', message: criado }))).toBe(false);
    expect(desenho(pedido({ status: 'executada', approvals: aprovacao(), message: mensagem({ coupon: { ...mensagem().coupon!, created: false } }) }))).not.toContain('id="mens-cupom-onde"');
  });
});
