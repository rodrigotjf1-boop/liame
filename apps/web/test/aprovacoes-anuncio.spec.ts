import type { ActionResponse } from '@liame/contracts';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  type AcaoDeAnuncio,
  anuncioApresentado,
  caminhoDoAnuncio,
  colunasDoAnuncio,
  ehPedidoDeAnuncio,
  erroAoDesfazer,
  etiquetaDoAnuncio,
  type MesDoPedido,
  origemDoAnuncio,
  porqueDoAnuncio,
  quemPediu,
  resultadoDoAnuncio,
  textosDoAnuncio,
} from '@/components/aprovacoes/anuncio-textos';
import { DetalheAnuncio } from '@/components/aprovacoes/detalhe-anuncio';
import { textoDe } from '@/components/resultados/textos';
import { textoCorrido } from '@/components/resumo/textos';
import { horaDe, quandoComHora } from '@/lib/formato';

// O pedido de anúncio em Aprovações (A4 · X8; mockups/prototipo-anuncios.html, P9): como o pedido de verba, de pausa e
// de retomada se apresenta, o porquê quando nasceu de uma recomendação, o resultado e o caminho do pedido decidido, a
// volta e o detalhe desenhado para quem decide, para quem opera campanhas e para quem só acompanha.

const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const agora = new Date(2026, 8, 29, 15, 0);
const local = (h: number, m = 0, d = 29) => new Date(2026, 8, d, h, m).toISOString();
const nbsp = (s: string) => s.replaceAll('R$ ', `R$${String.fromCharCode(160)}`);
const r = (reais: number) => Math.round(reais * 100) * 10_000;
const MES: MesDoPedido = { nome: 'setembro', faltam: 2, tetoPorCampanha: r(80), passo: 10, mudancasPorHora: 3 };

const pedido = (o: Partial<ActionResponse> = {}): AcaoDeAnuncio =>
  ({
    id: uuid(1),
    tool: 'orcamento_ajustar',
    action: 'orcamento.reduzir',
    brand_id: uuid(50),
    provider: 'meta_ads',
    account_id: uuid(60),
    resource_id: 'campanha:120210000000013',
    params: { daily_budget_micros: r(36) },
    risk_level: 'R3',
    budget_impact: 'decrease',
    value_micros: r(36),
    current_value_micros: r(40),
    reserved_micros: 0,
    plan_hash: `a1b2${'0'.repeat(56)}c3d4`,
    mode: 'APPROVAL',
    status: 'aguardando_aprovacao',
    status_reason: null,
    attempts: 0,
    next_attempt_at: null,
    undoes: null,
    undone_by: null,
    policy: { allowed: true, mode: 'APPROVAL', violations: [], versions: ['plataforma@3'] },
    approvals: [],
    workflow: null,
    expires_at: local(14, 20, 32),
    created_at: local(14, 20),
    updated_at: local(14, 20),
    requested_by: { id: uuid(2), name: 'Rodrigo' },
    account_name: 'Hamburgueria Exemplo',
    campaign: null,
    recommendation: null,
    agent_key: null,
    target: { kind: 'campanha', name: 'Smash em dobro', campaign: { id: uuid(70), name: 'Smash em dobro' } },
    from: { status: 'ativo', daily_micros: r(40) },
    to: { status: 'ativo', daily_micros: r(36) },
    execution: null,
    ...o,
  }) as AcaoDeAnuncio;

const aumento = (o: Partial<ActionResponse> = {}) =>
  pedido({ action: 'orcamento.aumentar', budget_impact: 'increase', target: { kind: 'campanha', name: 'Combo sexta', campaign: { id: uuid(71), name: 'Combo sexta' } }, from: { status: 'ativo', daily_micros: r(60) }, to: { status: 'ativo', daily_micros: r(66) }, ...o });
const pausa = (o: Partial<ActionResponse> = {}) =>
  pedido({
    tool: 'conjunto_pausar',
    action: 'conjunto.pausar',
    resource_id: 'conjunto:1',
    target: { kind: 'conjunto', name: 'Noite · raio de 3 km', campaign: { id: uuid(72), name: 'Delivery noite' } },
    from: { status: 'ativo', daily_micros: r(18) },
    to: { status: 'pausado', daily_micros: r(18) },
    ...o,
  });
const retomada = (o: Partial<ActionResponse> = {}) =>
  pedido({ tool: 'anuncio_retomar', action: 'anuncio.retomar', budget_impact: 'new_spend', resource_id: 'anuncio:2', target: { kind: 'anuncio', name: 'Smash em dobro · foto', campaign: null }, from: { status: 'pausado', daily_micros: null }, to: { status: 'ativo', daily_micros: null }, ...o });
const aprovado = { approved_by: uuid(2), approver_name: 'Rodrigo', approver_role: 'dono', sufficient: true, current_plan: true, created_at: local(14, 40) };
const recomendacao: NonNullable<ActionResponse['recommendation']> = {
  id: uuid(90),
  tool: 'orcamento_reduzir',
  rule: 'prejuizo',
  rule_version: 2,
  confidence_pct: '82.0',
  percent: 10,
  decided_on: '2026-09-29',
  window: { from: '2026-09-22', to: '2026-09-28' },
  daily_budget_micros: String(r(40)),
  spend_micros: String(r(280)),
  orders: 6,
  revenue_micros: String(r(402)),
  margin_known_micros: String(r(190)),
  margin_coverage_pct: '100.0',
};

describe('o pedido de anúncio em palavras', () => {
  it('só o pedido com o objeto, o antes e o depois é de anúncio; o cupom segue com os textos de sempre', () => {
    expect(ehPedidoDeAnuncio(pedido())).toBe(true);
    expect(ehPedidoDeAnuncio(pedido({ target: null, from: null, to: null }))).toBe(false);
    expect(ehPedidoDeAnuncio(pedido({ target: undefined }))).toBe(false);
  });

  it('reduzir a verba: o título com o objeto, o que pesa na lista, a frase do Lite, o antes e depois e os limites', () => {
    const t = textosDoAnuncio(pedido(), MES);
    expect([t.tipo, t.titulo, t.impacto, t.risco, t.chip]).toEqual(['verba', 'Reduzir a verba da campanha “Smash em dobro”', nbsp('−R$ 4,00/dia'), 'baixo', 'Dá para desfazer']);
    expect(textoDe(t.frase)).toBe(nbsp('A verba diária da campanha “Smash em dobro” cai de R$ 40,00 para R$ 36,00 (−10%). Se você aprovar, o Liame confere com a Meta e faz a mudança.'));
    expect(t.frase.filter((x) => x.b).map((x) => x.t)).toEqual([nbsp('R$ 40,00'), nbsp('R$ 36,00')]);
    expect(t.mudancas).toEqual([
      ['Verba diária', nbsp('R$ 40,00'), nbsp('R$ 36,00')],
      ['Gasto por dia', '—', nbsp('−R$ 4,00')],
    ]);
    expect(t.doRisco).toBe('Reduz o gasto. Está dentro do limite de 10% por pedido; reduzir não depende do teto por campanha nem da verba do mês.');
    expect(t.desfazer).toBe(nbsp('Dá para desfazer: um pedido novo devolve a verba para R$ 40,00, se ninguém mexer na campanha depois. Se alguém mexer, o Liame não passa por cima.'));
    expect([t.depoisDeAprovar, t.volta]).toEqual(['O Liame faz a mudança na Meta em instantes.', nbsp('voltar a verba para R$ 40,00 por dia')]);
    // Sem a verba do mês lida, o texto não cita o limite por pedido.
    expect(textosDoAnuncio(pedido(), null).doRisco).toBe('Reduz o gasto. Reduzir não depende do teto por campanha nem da verba do mês.');
    // Na lista e nos avisos, o mesmo pedido no formato dos outros.
    expect(anuncioApresentado(pedido(), MES)).toMatchObject({ titulo: 'Reduzir a verba da campanha “Smash em dobro”', impacto: nbsp('−R$ 4,00/dia'), depoisDeAprovar: 'O Liame faz a mudança na Meta em instantes.' });
  });

  it('aumentar a verba: risco médio, quanto pesa até o fim do mês e os limites que o pedido passou', () => {
    const t = textosDoAnuncio(aumento(), MES);
    expect([t.titulo, t.impacto, t.risco]).toEqual(['Aumentar a verba da campanha “Combo sexta”', nbsp('+R$ 6,00/dia'), 'medio']);
    expect(textoDe(t.frase)).toBe(nbsp('A verba diária da campanha “Combo sexta” sobe de R$ 60,00 para R$ 66,00 (+10%). Até o fim de setembro são R$ 12,00 a mais. Se você aprovar, o Liame confere com a Meta e faz a mudança.'));
    expect(t.mudancas.at(-1)).toEqual(['Até o fim de setembro', '—', nbsp('+R$ 12,00')]);
    expect(t.doRisco).toBe(nbsp('Aumenta o gasto em R$ 6,00 por dia. O pedido passou pelos limites da empresa: até 10% por pedido, o teto por campanha (R$ 80,00 por dia) e a verba do mês.'));
    // Sem a verba do mês lida: sem a conta do mês e sem os valores dos limites.
    const semMes = textosDoAnuncio(aumento(), null);
    expect(textoDe(semMes.frase)).not.toContain('Até o fim de');
    expect(semMes.mudancas).toHaveLength(2);
    expect(semMes.doRisco).toBe(nbsp('Aumenta o gasto em R$ 6,00 por dia. O pedido passou pelos limites da empresa: o teto por campanha e a verba do mês.'));
    // Quando nasceu de uma recomendação, a frase diz o motivo em poucas palavras.
    expect(textoDe(textosDoAnuncio(aumento({ recommendation: { ...recomendacao, tool: 'orcamento_aumentar', rule: 'lucro_no_limite' } }), MES).frase)).toContain('Nos 7 dias até 28/09, ela deu lucro folgado e gastou quase toda a verba.');
    expect(textoDe(textosDoAnuncio(pedido({ recommendation: recomendacao }), MES).frase)).toContain('Nos 7 dias até 28/09, a margem dos pedidos não pagou o anúncio.');
  });

  it('pausar: o conjunto com a campanha dele e a verba de hoje; a campanha no feminino', () => {
    const t = textosDoAnuncio(pausa(), MES);
    expect([t.tipo, t.titulo, t.impacto, t.risco]).toEqual(['pausar', 'Pausar o conjunto “Noite · raio de 3 km”', 'para de gastar', 'baixo']);
    expect(textoDe(t.frase)).toBe(
      nbsp('O conjunto “Noite · raio de 3 km”, da campanha “Delivery noite”, para de aparecer e de gastar (hoje R$ 18,00 por dia). Fica pausado, não apagado: dá para retomar depois. Se você aprovar, o Liame confere com a Meta e pausa.'),
    );
    expect(t.mudancas).toEqual([
      ['Situação', 'ativo', 'pausado'],
      ['Verba diária', nbsp('R$ 18,00'), 'não gasta'],
    ]);
    expect([t.doRisco, t.desfazer, t.volta]).toEqual(['Para o gasto. Pausar não depende do teto por campanha nem da verba do mês.', 'Dá para desfazer: um pedido novo retoma, se ninguém mexer no conjunto depois.', 'retomar']);
    const daCampanha = textosDoAnuncio(pausa({ tool: 'campanha_pausar', resource_id: 'campanha:1', target: { kind: 'campanha', name: 'Delivery noite', campaign: { id: uuid(72), name: 'Delivery noite' } }, from: { status: 'ativo', daily_micros: null }, to: { status: 'pausado', daily_micros: null } }), MES);
    expect(textoDe(daCampanha.frase)).toBe('A campanha “Delivery noite” para de aparecer e de gastar. Fica pausada, não apagada: dá para retomar depois. Se você aprovar, o Liame confere com a Meta e pausa.');
    expect(daCampanha.mudancas).toEqual([['Situação', 'ativa', 'pausada']]);
    expect(textoDe(daCampanha.feito)).toBe('a campanha “Delivery noite” está pausada');
  });

  it('retomar: sem verba própria, volta a gastar dentro da que já existe; com verba, até quanto por dia e até o fim do mês', () => {
    const t = textosDoAnuncio(retomada(), MES);
    expect([t.tipo, t.titulo, t.impacto, t.risco]).toEqual(['retomar', 'Retomar o anúncio “Smash em dobro · foto”', 'volta a gastar', 'medio']);
    expect(textoDe(t.frase)).toBe('O anúncio “Smash em dobro · foto” volta a aparecer e a gastar dentro da verba que já existe: a verba não muda. Se você aprovar, o Liame confere com a Meta e retoma.');
    expect(t.doRisco).toBe('Volta a gastar, dentro da verba que já existe. Retomar só é aceito com o teto do mês definido.');
    const comVerba = textosDoAnuncio(retomada({ tool: 'conjunto_retomar', resource_id: 'conjunto:2', target: { kind: 'conjunto', name: 'Noite · quem já pediu', campaign: { id: uuid(72), name: 'Delivery noite' } }, from: { status: 'pausado', daily_micros: r(12) }, to: { status: 'ativo', daily_micros: r(12) } }), MES);
    expect(comVerba.impacto).toBe(nbsp('até R$ 12,00/dia'));
    expect(textoDe(comVerba.frase)).toBe(nbsp('O conjunto “Noite · quem já pediu”, da campanha “Delivery noite”, volta a aparecer e a gastar até R$ 12,00 por dia. Até o fim de setembro são até R$ 24,00. Se você aprovar, o Liame confere com a Meta e retoma.'));
    expect(comVerba.mudancas).toEqual([
      ['Situação', 'pausado', 'ativo'],
      ['Verba diária', 'não gasta', nbsp('até R$ 12,00')],
      ['Até o fim de setembro', '—', nbsp('até R$ 24,00')],
    ]);
  });

  it('a volta de um pedido: o título, a frase e os limites dizem que ela devolve o que estava antes', () => {
    const volta = textosDoAnuncio(pedido({ undoes: uuid(5), action: 'orcamento.aumentar', budget_impact: 'increase', from: { status: 'ativo', daily_micros: r(36) }, to: { status: 'ativo', daily_micros: r(40) } }), MES);
    expect([volta.titulo, volta.chip]).toEqual([nbsp('Desfazer: voltar a verba da campanha “Smash em dobro” para R$ 40,00'), 'É a volta de um pedido']);
    expect(textoDe(volta.frase)).toBe(nbsp('A verba diária da campanha “Smash em dobro” volta de R$ 36,00 para R$ 40,00, como estava antes do pedido que está sendo desfeito. Se você aprovar, o Liame confere com a Meta e desfaz.'));
    expect(volta.doRisco).toBe('Devolve o que estava antes. A volta fica fora do limite de 10% por pedido e do teto por campanha, mas conta na verba do mês e no limite de 3 mudanças de verba por hora.');
    expect([volta.desfazer, volta.depoisDeAprovar]).toEqual(['A volta não tem volta: para mudar de novo, faça um pedido novo.', 'O Liame desfaz na Meta em instantes.']);
    expect(textosDoAnuncio(pausa({ undoes: uuid(5) }), MES).titulo).toBe('Desfazer: pausar de novo o conjunto “Noite · raio de 3 km”');
    expect(textosDoAnuncio(retomada({ undoes: uuid(5) }), MES).titulo).toBe('Desfazer: retomar o anúncio “Smash em dobro · foto”');
  });

  it('quem pediu e de onde o pedido veio', () => {
    expect(quemPediu(pedido())).toEqual({ nome: 'Rodrigo', funcionario: false });
    expect(quemPediu(pedido({ agent_key: 'trafego' }))).toEqual({ nome: 'Gestor de tráfego', funcionario: true });
    expect([origemDoAnuncio(pedido()), origemDoAnuncio(pedido({ recommendation: recomendacao })), origemDoAnuncio(pedido({ recommendation: recomendacao, agent_key: 'trafego' })), origemDoAnuncio(pedido({ undoes: uuid(5) }))]).toEqual([
      null,
      'pela recomendação do Gestor de tráfego',
      null,
      'é a volta de outro pedido',
    ]);
  });
});

describe('o porquê do pedido que nasceu de uma recomendação', () => {
  it('reduzir: o gasto, os pedidos e o que faltou para pagar o anúncio, cada número com a fonte, e a regra com a confiança', () => {
    const p = porqueDoAnuncio(pedido({ recommendation: recomendacao }))!;
    expect(p.itens.map((i) => [textoCorrido(i.valor), i.rotulo, textoCorrido(i.sub)])).toEqual([
      [nbsp('R$ 280,00'), 'gastos em 7 dias', nbsp('a verba é de R$ 40,00 por dia')],
      ['6 pedidos', 'confirmados no caixa', nbsp('R$ 402,00 de receita')],
      [nbsp('R$ 90,00'), 'faltaram para pagar o anúncio', nbsp('a margem conhecida foi de R$ 190,00')],
    ]);
    expect(textoCorrido(p.regra)).toBe('Regra do Gestor de tráfego (versão 2): campanha em prejuízo nos últimos 7 dias pede uma redução de 10% na verba. Confiança de 82,0%: é evidência, não certeza.');
    expect(p.fontes.map((f) => f.fonte)).toEqual([
      'Meta Ads · gasto da campanha · 22/09 a 28/09',
      'Regem · receita da campanha confirmada no caixa · 22/09 a 28/09',
      'Regem · margem dos pedidos com custo cadastrado · 22/09 a 28/09',
      'Regem · pedidos da campanha confirmados no caixa · 22/09 a 28/09',
      'Liame · investimento − margem conhecida da campanha · calculado pelo sistema',
      'Liame · confiança da recomendação (gasto observado e margem conhecida) · calculada pelo sistema',
    ]);
  });

  it('aumentar: a margem contra o investido e quanto da verba foi gasta; pausar: a regra da margem abaixo da metade', () => {
    const sobe = porqueDoAnuncio(aumento({ recommendation: { ...recomendacao, tool: 'orcamento_aumentar', rule: 'lucro_no_limite', daily_budget_micros: String(r(60)), spend_micros: String(r(412.5)), margin_known_micros: String(r(655.2)) } }))!;
    expect(sobe.itens.map((i) => [textoCorrido(i.valor), i.rotulo, textoCorrido(i.sub)])).toEqual([
      [nbsp('R$ 655,20'), 'de margem conhecida', nbsp('para R$ 412,50 investidos em 7 dias')],
      ['6 pedidos', 'confirmados no caixa', nbsp('R$ 402,00 de receita')],
      ['98%', 'da verba foi gasta', nbsp('a verba é de R$ 60,00 por dia')],
    ]);
    expect(textoCorrido(sobe.regra)).toContain('campanha com lucro folgado (margem de pelo menos uma vez e meia o investido) e gasto de 80% ou mais da verba pede um aumento de 10%');
    const pausar = porqueDoAnuncio(pausa({ recommendation: { ...recomendacao, tool: 'campanha_pausar', rule: 'prejuizo_forte', percent: null } }))!;
    expect(textoCorrido(pausar.regra)).toContain('campanha com a margem conhecida abaixo da metade do que gastou nos últimos 7 dias pede a pausa');
  });

  it('quem não vê as vendas recebe só o gasto; o pedido comum e a volta não têm porquê; regra que a tela não conhece sai sem descrição', () => {
    const semVendas = porqueDoAnuncio(pedido({ recommendation: { ...recomendacao, orders: null, revenue_micros: null, margin_known_micros: null, margin_coverage_pct: null } }))!;
    expect(semVendas.itens.map((i) => i.rotulo)).toEqual(['gastos em 7 dias']);
    expect(porqueDoAnuncio(pedido())).toBeNull();
    expect(porqueDoAnuncio(pedido({ recommendation: recomendacao, undoes: uuid(5) }))).toBeNull();
    expect(textoCorrido(porqueDoAnuncio(pedido({ recommendation: { ...recomendacao, rule: 'regra_nova' } }))!.regra)).toBe('Regra do Gestor de tráfego (versão 2). Confiança de 82,0%: é evidência, não certeza.');
  });
});

describe('o que aconteceu com o pedido de anúncio decidido', () => {
  const t = (a: AcaoDeAnuncio) => textosDoAnuncio(a, MES);
  const resultado = (a: AcaoDeAnuncio) => {
    const x = resultadoDoAnuncio(a, t(a));
    return { tom: x.tom, texto: `${x.forte}${textoDe(x.texto)}`, depois: x.depois };
  };
  const feita = { status: 'executada', finished_at: local(14, 41), no_write: false, observed: null };
  const aprovada = (o: Partial<ActionResponse> = {}) => pedido({ status: 'aprovada', approvals: [aprovado], updated_at: local(14, 40), ...o });

  it('aprovado e ainda não executado: executa em instantes, ou a plataforma pediu para esperar', () => {
    expect(resultado(aprovada())).toEqual({ tom: 'espera', texto: `Aprovado por Rodrigo às ${horaDe(local(14, 40))}. O Liame faz a mudança na Meta em instantes.`, depois: { tipo: 'nada' } });
    const esperando = aprovada({ attempts: 1, next_attempt_at: local(15, 40), status_reason: 'a Meta pediu para esperar (limite de uso da conta de anúncios)', execution: { status: 'adiada', finished_at: local(14, 41), no_write: false, observed: null } });
    expect(resultado(esperando).texto).toBe(`Aprovado por Rodrigo às ${horaDe(local(14, 40))}. Ainda não foi executado: a Meta pediu para esperar (limite de uso da conta de anúncios). O Liame tenta de novo às ${horaDe(local(15, 40))}, sem insistir antes.`);
    expect(etiquetaDoAnuncio(esperando)).toBe('Esperando a Meta');
    expect(caminhoDoAnuncio(esperando, agora).map((p) => [p.situacao, p.titulo])).toEqual([
      ['ok', 'Pedido por Rodrigo'],
      ['ok', 'Aprovado por Rodrigo, com o código do app'],
      ['espera', 'A Meta pediu para esperar'],
      ['depois', 'Mudança na Meta'],
      ['depois', 'Leitura de conferência'],
    ]);
    expect(caminhoDoAnuncio(esperando, agora)[2]!.sub).toBe(`a Meta pediu para esperar (limite de uso da conta de anúncios); 1ª espera. O Liame tenta de novo às ${horaDe(local(15, 40))}`);
    expect(caminhoDoAnuncio(aprovada(), agora)[2]).toEqual({ situacao: 'espera', titulo: 'Conferindo com a Meta…', sub: 'o Liame lê o que está valendo e pede que a Meta valide a mudança' });
  });

  it('a plataforma recusou na conferência: o que ela respondeu, e dá para pedir de novo', () => {
    const recusou = pedido({ status: 'falhou', approvals: [aprovado], status_reason: 'Esta campanha faz parte de um teste A/B em andamento.', execution: { status: 'falhou', finished_at: local(14, 41), no_write: false, observed: null } });
    const x = resultado(recusou);
    expect([x.tom, x.texto]).toEqual(['falha', `Aprovado por Rodrigo às ${horaDe(local(14, 40))}, mas a Meta recusou na conferência. Nada mudou. O que a Meta respondeu: “Esta campanha faz parte de um teste A/B em andamento.”`]);
    expect(x.depois).toEqual({ tipo: 'pedir-de-novo', rotulo: 'Pedir de novo', nota: 'O Liame pede à Meta que valide a mudança antes de escrever. Quando ela recusa, nada é escrito e o pedido não é repetido.' });
    expect(etiquetaDoAnuncio(recusou)).toBe('A Meta recusou');
    expect(caminhoDoAnuncio(recusou, agora).at(-1)).toEqual({ situacao: 'falha', titulo: 'A Meta recusou na conferência', sub: `${quandoComHora(local(14, 41), agora)} · nada foi escrito` });
    expect(colunasDoAnuncio(recusou)).toEqual({ rotulo: 'O que o pedido queria', legenda: 'Como era quando foi pedido e o que o pedido queria', colunas: ['Era', 'Pedido'] });
    // Esperou a plataforma vezes demais: o motivo já diz para conferir o objeto, e a tela não afirma que nada mudou.
    const desistiu = pedido({ status: 'falhou', approvals: [aprovado], attempts: 6, status_reason: 'a Meta pediu para esperar; depois de 6 tentativas, a ação foi encerrada. Confira o objeto na plataforma e peça de novo, se ainda fizer sentido.', execution: { status: 'falhou', finished_at: local(16, 0), no_write: false, observed: null } });
    expect(resultado(desistiu).texto).toContain('mas a execução foi encerrada depois de esperar a Meta. A Meta pediu para esperar; depois de 6 tentativas');
    expect(resultado(desistiu).texto).not.toContain('Nada mudou');
    expect(etiquetaDoAnuncio(desistiu)).toBe('Não executado');
  });

  it('alguém mexeu depois do pedido: a tela diz o que encontrou e oferece pedir a partir do valor de agora', () => {
    const mudou = pedido({ status: 'falhou', approvals: [aprovado], status_reason: 'o recurso mudou desde o pedido; nada foi sobrescrito', execution: { status: 'estado_mudou', finished_at: local(14, 41), no_write: false, observed: { status: 'ativo', daily_micros: r(38) } } });
    const x = resultado(mudou);
    expect(x.texto).toBe(nbsp(`Aprovado por Rodrigo às ${horaDe(local(14, 40))}, mas não foi executado: alguém mexeu na campanha na Meta depois do pedido. A verba agora é de R$ 38,00 (era de R$ 40,00 quando o pedido foi feito). O Liame não passa por cima do que uma pessoa mudou. Nada mudou.`));
    expect(x.depois).toEqual({ tipo: 'pedir-de-novo', rotulo: 'Pedir de novo, a partir do valor de agora', nota: null });
    expect(caminhoDoAnuncio(mudou, agora).at(-1)!.titulo).toBe('O que está na Meta mudou depois do pedido');
    const pausaMudou = pausa({ status: 'falhou', approvals: [aprovado], execution: { status: 'estado_mudou', finished_at: local(14, 41), no_write: false, observed: { status: 'pausado', daily_micros: r(18) } } });
    expect(resultado(pausaMudou).texto).toContain('alguém mexeu no conjunto na Meta depois do pedido. Não está mais como quando o pedido foi feito.');
    expect(resultado(pausaMudou).depois).toMatchObject({ rotulo: 'Pedir de novo' });
    // Barrado antes de escrever: a trava, a aprovação que deixou de valer ou a escrita desligada, em palavras.
    const travado = pedido({ status: 'falhou', approvals: [aprovado], status_reason: 'trava ativa (tenant): pausa de segurança', execution: { status: 'bloqueada', finished_at: local(14, 41), no_write: false, observed: null } });
    expect(resultado(travado).texto).toBe(`Aprovado por Rodrigo às ${horaDe(local(14, 40))}, mas não foi executado: há uma trava ativa na empresa. Nada mudou.`);
    expect(caminhoDoAnuncio(travado, agora).at(-1)!.titulo).toBe('A execução foi barrada');
  });

  it('executado: o que a plataforma confirmou, o caminho inteiro e o desfazer; sem escrita, não há o que desfazer', () => {
    const executado = pedido({ status: 'executada', approvals: [aprovado], updated_at: local(14, 41), execution: feita });
    const x = resultado(executado);
    expect([x.tom, x.texto]).toEqual(['ok', nbsp(`Aprovado por Rodrigo às ${horaDe(local(14, 40))} e executado às ${horaDe(local(14, 41))}. A Meta confirmou: a verba da campanha “Smash em dobro” está em R$ 36,00 por dia.`)]);
    expect(x.depois).toEqual({ tipo: 'desfazer', nota: t(executado).desfazer });
    expect(caminhoDoAnuncio(executado, agora).map((p) => p.titulo)).toEqual(['Pedido por Rodrigo', 'Aprovado por Rodrigo, com o código do app', 'A Meta validou a mudança', 'Mudança feita na Meta', 'Leitura de conferência: está como o pedido']);
    expect(colunasDoAnuncio(executado).colunas).toEqual(['Antes', 'Depois']);
    const semEscrita = pausa({ status: 'executada', approvals: [aprovado], execution: { ...feita, no_write: true } });
    expect(resultado(semEscrita).texto).toBe(`Aprovado por Rodrigo às ${horaDe(local(14, 40))} e conferido às ${horaDe(local(14, 41))}. O conjunto “Noite · raio de 3 km” já estava como o pedido queria: o Liame não precisou mudar nada.`);
    expect(resultado(semEscrita).depois).toEqual({ tipo: 'nota', texto: 'Como o Liame não mudou nada, não há o que desfazer por aqui.' });
    expect(caminhoDoAnuncio(semEscrita, agora).at(-1)!.titulo).toBe('Conferido com a Meta: já estava como o pedido');
  });

  it('a volta: pedida e esperando, executada (desfeito) e a volta que é ela mesma um pedido', () => {
    const base = { status: 'executada' as const, approvals: [aprovado], execution: feita };
    expect(resultado(pedido({ ...base, undone_by: { id: uuid(9), status: 'aguardando_aprovacao' } })).depois).toEqual({ tipo: 'volta-pendente', pedido: uuid(9) });
    const desfeito = pedido({ ...base, undone_by: { id: uuid(9), status: 'executada' } });
    expect(resultado(desfeito)).toEqual({ tom: 'neutro', texto: nbsp('Desfeito por um pedido novo: a verba da campanha “Smash em dobro” voltou para R$ 40,00 por dia.'), depois: { tipo: 'volta-feita', pedido: uuid(9) } });
    expect(etiquetaDoAnuncio(desfeito)).toBe('Desfeito');
    // A volta que falhou ou foi recusada não prende: dá para desfazer de novo.
    expect(resultado(pedido({ ...base, undone_by: { id: uuid(9), status: 'falhou' } })).depois.tipo).toBe('desfazer');
    // A volta, executada, não tem volta.
    expect(resultado(pedido({ ...base, undoes: uuid(5) })).depois).toEqual({ tipo: 'nota', texto: 'A volta não tem volta: para mudar de novo, faça um pedido novo.' });
  });

  it('recusado, cancelado e expirado: o resultado de sempre, sem caminho', () => {
    const recusado = pedido({ status: 'cancelada', status_reason: 'recusada por Rodrigo: Quero outro valor' });
    expect(resultado(recusado)).toEqual({ tom: 'falha', texto: 'Recusado por Rodrigo: “Quero outro valor”. Nada foi executado.', depois: { tipo: 'nada' } });
    expect(caminhoDoAnuncio(recusado, agora)).toEqual([]);
    expect(resultado(pedido({ status: 'expirada' })).texto).toBe('Expirou sem aprovação: nada foi feito.');
    expect(caminhoDoAnuncio(pedido(), agora)).toEqual([]);
  });

  it('a recusa do servidor ao desfazer, em palavras', () => {
    expect(erroAoDesfazer({ code: 'estado-mudou', title: 'x' }, pedido())).toEqual({ texto: 'alguém mexeu na campanha na Meta depois. O Liame não passa por cima do que uma pessoa mudou. Para mudar de novo, faça um pedido novo.', naoDa: true });
    expect(erroAoDesfazer({ code: 'acao-sem-volta', title: 'Sem volta', detail: 'O objeto já estava assim quando o Liame foi executar.' }, pedido())).toEqual({ texto: 'O objeto já estava assim quando o Liame foi executar.', naoDa: false });
  });
});

describe('o pedido de anúncio aberto', () => {
  type Opcoes = { pro?: boolean; podeDecidir?: boolean; podeOperar?: boolean; pedindo?: boolean };
  const aberto = (a: AcaoDeAnuncio, grupo: 'pendente' | 'feito', o: Opcoes = {}) =>
    renderToStaticMarkup(
      createElement(DetalheAnuncio, {
        acao: a,
        grupo,
        agora,
        pro: o.pro ?? false,
        podeDecidir: o.podeDecidir ?? true,
        podeOperar: o.podeOperar ?? true,
        temApp: true,
        mes: MES,
        pedindo: o.pedindo ?? false,
        titulo: createRef<HTMLHeadingElement>(),
        campoCodigo: createRef<HTMLInputElement>(),
        aoVoltar: () => {},
        aoAprovar: async () => ({ ok: true as const }),
        aoRecusar: async () => ({ ok: true as const }),
        aoDesfazer: async () => ({ ok: true as const }),
        aoPedirDeNovo: () => {},
        aoAbrir: () => {},
      }),
    );

  it('esperando a decisão, no Lite: quem pediu e de onde veio, a frase com os valores em destaque, o risco e o código do app', () => {
    const html = aberto(pedido({ recommendation: recomendacao }), 'pendente');
    expect(html).toContain('<b>Rodrigo</b> pediu');
    expect(html).toContain(`· ${quandoComHora(local(14, 20), agora)} · pela recomendação do Gestor de tráfego`);
    expect(html).toContain('<h2 class="det-titulo" id="ap-det-titulo" tabindex="-1">Reduzir a verba da campanha “Smash em dobro”</h2>');
    expect(html).toContain(`cai de <b>${nbsp('R$ 40,00')}</b> para <b>${nbsp('R$ 36,00')}</b> (−10%).`);
    expect(html).toContain('<span class="risco risco--baixo">Risco baixo</span>');
    expect(html).toContain('<span class="lite-chip">Dá para desfazer</span>');
    expect(html).toContain('Ver detalhes');
    // Os detalhes existem, fechados; aprovar pede o código do app.
    expect(html).toMatch(/id="[^"]*-detalhes" hidden=""/);
    expect(html).toContain('inputMode="numeric"');
  });

  it('no Pro: o porquê com os números e a regra, o antes e depois, o risco e os limites e de onde vêm os números', () => {
    const html = aberto(pedido({ recommendation: recomendacao }), 'pendente', { pro: true });
    expect(html).not.toContain('Ver detalhes');
    expect(html).toContain('<p class="rotulo-marca">Por quê</p>');
    expect(html).toContain('faltaram para pagar o anúncio');
    expect(html).toContain('Regra do Gestor de tráfego (versão 2)');
    expect(html).toContain('<caption class="sr-only">O que muda na Meta se o pedido for aprovado</caption>');
    expect(html).toContain('<th scope="col">Agora</th><th scope="col">Depois</th>');
    expect(html).toContain('<b class="risco risco--baixo">Risco baixo.</b> Reduz o gasto.');
    expect(html).toContain('A plataforma confere antes');
    expect(html).toContain('De onde vêm os números (6)');
    // Sem recomendação, não há porquê nem lista de fontes.
    const comum = aberto(pedido(), 'pendente', { pro: true });
    expect(comum).not.toContain('Por quê');
    expect(comum).not.toContain('De onde vêm os números');
  });

  it('quem só acompanha vê o pedido sem a barra da decisão', () => {
    const html = aberto(pedido(), 'pendente', { podeDecidir: false });
    expect(html).toContain('Só quem pode aprovar decide este pedido. Você acompanha por aqui.');
    expect(html).not.toContain('inputMode="numeric"');
  });

  it('executado: o resultado, o caminho do pedido, o antes e depois e o desfazer só para quem opera campanhas', () => {
    const executado = pedido({ status: 'executada', approvals: [aprovado], updated_at: local(14, 41), execution: { status: 'executada', finished_at: local(14, 41), no_write: false, observed: null } });
    const html = aberto(executado, 'feito');
    expect(html).toContain('<div class="resultado resultado--ok">');
    expect(html).toContain('A Meta confirmou: a verba da campanha “Smash em dobro” está em ');
    expect(html).toContain('<p class="rotulo-marca">O caminho do pedido</p>');
    expect(html.match(/<span class="passo" aria-hidden="true">/g)).toHaveLength(5);
    expect(html).toContain('<th scope="col">Antes</th><th scope="col">Depois</th>');
    expect(html).toContain('Desfazer</button>');
    expect(html).toContain('Dá para desfazer: um pedido novo devolve a verba para');
    const semOperar = aberto(executado, 'feito', { podeOperar: false });
    expect(semOperar).not.toContain('Desfazer</button>');
    expect(semOperar).toContain('Dá para desfazer: um pedido novo devolve a verba para');
  });

  it('não executado: pedir de novo abre a gaveta, só com a campanha na lista e para quem opera campanhas', () => {
    const mudou = pedido({ status: 'falhou', approvals: [aprovado], execution: { status: 'estado_mudou', finished_at: local(14, 41), no_write: false, observed: { status: 'ativo', daily_micros: r(38) } } });
    const html = aberto(mudou, 'feito');
    expect(html).toContain('<div class="resultado resultado--falha">');
    expect(html).toContain('data-pedir-de-novo="true" aria-haspopup="dialog" aria-expanded="false"');
    expect(html).toContain('Pedir de novo, a partir do valor de agora');
    expect(html).toContain('<p class="rotulo-marca">O que o pedido queria</p>');
    expect(aberto(mudou, 'feito', { pedindo: true })).toContain('aria-expanded="true"');
    expect(aberto(mudou, 'feito', { podeOperar: false })).not.toContain('data-pedir-de-novo');
    expect(aberto(pedido({ ...mudou, target: { kind: 'campanha', name: 'Smash em dobro', campaign: null } }), 'feito')).not.toContain('data-pedir-de-novo');
  });

  it('a volta pedida e a volta feita levam ao pedido de volta', () => {
    const base = { status: 'executada' as const, approvals: [aprovado], execution: { status: 'executada', finished_at: local(14, 41), no_write: false, observed: null } };
    const pendente = aberto(pedido({ ...base, undone_by: { id: uuid(9), status: 'aguardando_aprovacao' } }), 'feito');
    expect(pendente).toContain('A volta deste pedido já foi pedida e espera aprovação.');
    expect(pendente).toContain('Ver o pedido de volta');
    expect(pendente).not.toContain('Desfazer</button>');
    const desfeito = aberto(pedido({ ...base, undone_by: { id: uuid(9), status: 'executada' } }), 'feito');
    expect(desfeito).toContain('<div class="resultado">');
    expect(desfeito).toContain('<b>Desfeito</b>');
    expect(desfeito).toContain('Ver o pedido de volta');
  });
});

describe('o pedido do Google em Aprovações (A5 · Y3; protótipo P13, parte 1)', () => {
  const t = (a: AcaoDeAnuncio) => textosDoAnuncio(a, MES);
  const resultado = (a: AcaoDeAnuncio) => {
    const x = resultadoDoAnuncio(a, t(a));
    return { tom: x.tom, texto: nbspFora(`${x.forte}${textoDe(x.texto)}`), tecnico: x.tecnico ?? null, depois: x.depois };
  };
  const nbspFora = (s: string) => s.replaceAll(String.fromCharCode(160), ' ');
  /** O pedido do protótipo: reduzir a verba da Busca “hambúrguer perto”, de R$ 55,00 para R$ 49,50. */
  const doGoogle = (o: Partial<ActionResponse> = {}) =>
    pedido({
      provider: 'google_ads',
      resource_id: 'campanha:21000000004',
      params: { daily_budget_micros: r(49.5) },
      value_micros: r(49.5),
      current_value_micros: r(55),
      target: { kind: 'campanha', name: 'Busca “hambúrguer perto”', campaign: null },
      from: { status: 'ativo', daily_micros: r(55) },
      to: { status: 'ativo', daily_micros: r(49.5) },
      ...o,
    });
  const falhou = (reply: { text: string; code: string | null } | null | undefined, motivo: string) =>
    doGoogle({ status: 'falhou', approvals: [aprovado], status_reason: motivo, execution: { status: 'falhou', finished_at: local(14, 41), no_write: false, observed: null, ...(reply === undefined ? {} : { provider_reply: reply }) } });
  const RECUSA = "O Google recusou a mudança: Budget amount must be above this campaign's per-day minimum (campaignBudgetError.BUDGET_BELOW_PER_DAY_MINIMUM).";
  const DO_GOOGLE = { text: "Budget amount must be above this campaign's per-day minimum.", code: 'campaignBudgetError.BUDGET_BELOW_PER_DAY_MINIMUM' };
  const aberto = (a: AcaoDeAnuncio, pro: boolean) =>
    renderToStaticMarkup(
      createElement(DetalheAnuncio, {
        acao: a,
        grupo: 'feito',
        agora,
        pro,
        podeDecidir: true,
        podeOperar: true,
        temApp: true,
        mes: MES,
        pedindo: false,
        titulo: createRef<HTMLHeadingElement>(),
        campoCodigo: createRef<HTMLInputElement>(),
        aoVoltar: () => {},
        aoAprovar: async () => ({ ok: true as const }),
        aoRecusar: async () => ({ ok: true as const }),
        aoDesfazer: async () => ({ ok: true as const }),
        aoPedirDeNovo: () => {},
        aoAbrir: () => {},
      }),
    );

  it('o pedido fala do Google: o Liame confere com o Google e faz a mudança no Google', () => {
    const x = t(doGoogle());
    expect(x.titulo).toBe('Reduzir a verba da campanha “Busca “hambúrguer perto””');
    expect(nbspFora(textoDe(x.frase))).toContain('de R$ 55,00 para R$ 49,50 (−10%).');
    expect(textoDe(x.frase)).toContain('Se você aprovar, o Liame confere com o Google e faz a mudança.');
    expect(x.depoisDeAprovar).toBe('O Liame faz a mudança no Google em instantes.');
    expect(colunasDoAnuncio(doGoogle()).legenda).toBe('O que muda no Google se o pedido for aprovado');
    expect(`${textoDe(x.frase)}${x.depoisDeAprovar}${x.desfazer}${x.doRisco}`).not.toMatch(/\bMeta\b/);
  });

  it('executado: o Google confirmou, e o caminho do pedido passa pela validação e pela mudança no Google', () => {
    const feito = doGoogle({ status: 'executada', approvals: [aprovado], execution: { status: 'executada', finished_at: local(14, 41), no_write: false, observed: null, provider_reply: null } });
    expect(resultado(feito).texto).toBe(`Aprovado por Rodrigo às ${horaDe(local(14, 40))} e executado às ${horaDe(local(14, 41))}. O Google confirmou: a verba da campanha “Busca “hambúrguer perto”” está em R$ 49,50 por dia.`);
    expect(caminhoDoAnuncio(feito, agora).map((p) => p.titulo).slice(2)).toEqual(['O Google validou a mudança', 'Mudança feita no Google', 'Leitura de conferência: está como o pedido']);
    expect(etiquetaDoAnuncio(feito)).not.toMatch(/Meta|plataforma/);
  });

  it('o Google pediu para esperar: o selo, o motivo e a hora da próxima tentativa', () => {
    const esperando = doGoogle({ status: 'aprovada', approvals: [aprovado], attempts: 1, next_attempt_at: local(15, 40), status_reason: 'o Google pediu para esperar (limite de uso do Google)', execution: { status: 'adiada', finished_at: local(14, 41), no_write: false, observed: null, provider_reply: null } });
    expect(etiquetaDoAnuncio(esperando)).toBe('Esperando o Google');
    expect(resultado(esperando).texto).toBe(`Aprovado por Rodrigo às ${horaDe(local(14, 40))}. Ainda não foi executado: o Google pediu para esperar (limite de uso do Google). O Liame tenta de novo às ${horaDe(local(15, 40))}, sem insistir antes.`);
    expect(caminhoDoAnuncio(esperando, agora)[2]).toMatchObject({ situacao: 'espera', titulo: 'O Google pediu para esperar' });
    // A plataforma que a tela ainda não conhece não ganha artigo errado.
    expect(etiquetaDoAnuncio(doGoogle({ provider: 'plataforma_nova', status: 'aprovada', approvals: [aprovado], attempts: 1, next_attempt_at: local(15, 40) }))).toBe('Esperando a plataforma');
  });

  it('o Google recusou na conferência: o texto dele entre aspas, em inglês como ele escreve, e o código só no Pro', () => {
    const recusou = falhou(DO_GOOGLE, RECUSA);
    const x = resultado(recusou);
    expect(x.texto).toBe(
      `Aprovado por Rodrigo às ${horaDe(local(14, 40))}, mas o Google recusou na conferência. Nada mudou. O que o Google respondeu, em inglês, como ele escreve: “Budget amount must be above this campaign's per-day minimum.”`,
    );
    expect(x.tecnico).toEqual({ rotulo: 'Código do Google', valor: 'campaignBudgetError.BUDGET_BELOW_PER_DAY_MINIMUM' });
    expect(x.depois).toEqual({ tipo: 'pedir-de-novo', rotulo: 'Pedir de novo', nota: 'O Liame pede ao Google que valide a mudança antes de escrever. Quando ele recusa, nada é escrito e o pedido não é repetido.' });
    expect(etiquetaDoAnuncio(recusou)).toBe('O Google recusou');
    expect(caminhoDoAnuncio(recusou, agora).at(-1)).toMatchObject({ situacao: 'falha', titulo: 'O Google recusou na conferência' });
    // O motivo guardado no pedido (com "O Google recusou a mudança:" e o código) não aparece repetido na tela.
    expect(x.texto).not.toContain('recusou a mudança');
    expect(x.texto).not.toContain('campaignBudgetError');

    const lite = aberto(recusou, false);
    const pro = aberto(recusou, true);
    expect(lite).toContain('em inglês, como ele escreve');
    expect(lite).not.toContain('campaignBudgetError');
    expect(lite).not.toContain('resultado-codigo');
    expect(pro).toContain('<span class="resultado-codigo"> Código do Google: <code>campaignBudgetError.BUDGET_BELOW_PER_DAY_MINIMUM</code>.</span>');
    expect(`${lite}${pro}`).not.toMatch(/NaN|undefined|\[object Object\]/);
  });

  it('o motivo que é uma frase do Liame sai sem aspas; a resposta de antes da separação segue como sempre saiu', () => {
    // A autorização venceu: quem fala é o Liame, e não o Google.
    const semAcesso = falhou(null, 'O Google recusou o acesso desta conta (a autorização foi revogada ou venceu). Conecte o Google de novo em Contas conectadas.');
    expect(resultado(semAcesso).texto).toBe(
      `Aprovado por Rodrigo às ${horaDe(local(14, 40))}, mas o Google recusou na conferência. Nada mudou. O Google recusou o acesso desta conta (a autorização foi revogada ou venceu). Conecte o Google de novo em Contas conectadas.`,
    );
    expect(resultado(semAcesso).tecnico).toBeNull();
    expect(resultado(semAcesso).texto).not.toContain('“');
    // Sem o campo novo (servidor de antes de 09/10/2026), o motivo inteiro entre aspas.
    expect(resultado(falhou(undefined, 'Request contains an invalid argument.')).texto).toContain('O que o Google respondeu: “Request contains an invalid argument.”');
    // Na Meta, o texto que ela escreve para a pessoa, sem "em inglês" e sem código.
    const daMeta = pedido({ status: 'falhou', approvals: [aprovado], status_reason: 'A Meta recusou a mudança: O orçamento diário precisa ser de pelo menos R$ 6,00.', execution: { status: 'falhou', finished_at: local(14, 41), no_write: false, observed: null, provider_reply: { text: 'O orçamento diário precisa ser de pelo menos R$ 6,00.', code: null } } });
    expect(resultado(daMeta).texto).toBe(`Aprovado por Rodrigo às ${horaDe(local(14, 40))}, mas a Meta recusou na conferência. Nada mudou. O que a Meta respondeu: “O orçamento diário precisa ser de pelo menos R$ 6,00.”`);
    expect(resultado(daMeta).tecnico).toBeNull();
    expect(resultado(daMeta).depois).toMatchObject({ nota: 'O Liame pede à Meta que valide a mudança antes de escrever. Quando ela recusa, nada é escrito e o pedido não é repetido.' });
  });

  it('alguém mudou no Google antes da execução: a tela diz o que encontrou, e o Liame não passa por cima', () => {
    const mudou = doGoogle({ status: 'falhou', approvals: [aprovado], status_reason: 'o recurso mudou desde o pedido; nada foi sobrescrito', execution: { status: 'estado_mudou', finished_at: local(14, 41), no_write: false, observed: { status: 'ativo', daily_micros: r(52) }, provider_reply: null } });
    expect(resultado(mudou).texto).toBe(
      `Aprovado por Rodrigo às ${horaDe(local(14, 40))}, mas não foi executado: alguém mexeu na campanha no Google depois do pedido. A verba agora é de R$ 52,00 (era de R$ 55,00 quando o pedido foi feito). O Liame não passa por cima do que uma pessoa mudou. Nada mudou.`,
    );
    expect(caminhoDoAnuncio(mudou, agora).at(-1)).toMatchObject({ titulo: 'O que está no Google mudou depois do pedido' });
    expect(erroAoDesfazer({ code: 'estado-mudou', title: 'x' }, doGoogle()).texto).toContain('alguém mexeu na campanha no Google depois');
  });
});
