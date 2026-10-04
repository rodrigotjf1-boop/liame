import type { ActionResponse, PlanContent, PlanResponse, PlanSummary } from '@liame/contracts';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DetalhePlano } from '@/components/aprovacoes/detalhe-plano';
import { chaveDaAcao, chaveDoPlano, montarLista, pendentesDe } from '@/components/aprovacoes/lista';
import {
  avisoDaVersao,
  cabecalhoDoPlano,
  caminhosDoCorpo,
  caminhosNaTela,
  comDias,
  comOferta,
  comVerba,
  diaDaPauta,
  diaDoCalendario,
  dinheiroDoPlano,
  enderecoDoPlano,
  erroDaOferta,
  erroDaPauta,
  erroDaVerba,
  erroDoPlano,
  etiquetaDoPlano,
  fraseDaVerba,
  grupoDoPlano,
  identidadeDaVersao,
  mesmoConteudo,
  motivosDoPlano,
  type Noventa,
  numerosDosCaminhos,
  type Oferta,
  origemDoPlano,
  type Pauta,
  quandoDaOferta,
  resultadoDoPlano,
  riscoDoPlano,
  tabelaDaVerba,
  totalDaVerba,
  trechosDo,
} from '@/components/aprovacoes/planos-textos';
import { horaDe, quandoComHora } from '@/lib/formato';

// Planos do Estrategista em Aprovações (A3 · P8, parte 2; mockups/prototipo-resumo.html): o que a tela escreve em
// volta do plano que a API manda pronto, a fila com ações e planos juntos, a versão que a pessoa edita e o plano
// desenhado nos modos Lite e Pro, esperando decisão e já decidido.

const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const agora = new Date(2026, 9, 3, 15, 0);
const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const NBSP = String.fromCharCode(160);
const HASH = `a81e${'0'.repeat(56)}07d2`;
const EU = uuid(9);

const resumo = (o: Partial<PlanSummary> = {}): PlanSummary => ({
  id: uuid(1),
  brand_id: uuid(50),
  kind: 'oferta',
  title: 'Promoção de sexta: combo com refrigerante',
  status: 'pendente',
  version: 1,
  risk: 'baixo',
  money_micros: null,
  content_hash: HASH,
  expires_at: local(6, 10, 42),
  created_at: local(3, 10, 42),
  updated_at: local(3, 10, 42),
  demand_id: uuid(70),
  requested_by: { id: EU, name: 'Rodrigo' },
  ...o,
});

const COMUM = {
  summary: 'O Estrategista propõe o Combo sexta em destaque, com o cupom SEXTA10.',
  reasons: ['A Combo sexta teve 31 pedidos em 7 dias: é a campanha que dá lucro.', 'Quase ninguém vê o cupom SEXTA10.'],
  risk: 'baixo' as const,
  risk_reason: 'não muda verba nem cria campanha ou cupom.',
  to_do: ['Na Meta, troque o texto do anúncio da Combo sexta pelo do plano.', 'No balcão, avise a equipe da oferta.'],
  after: 'A revisão de segunda, 05/10, mostra o que a promoção trouxe no caixa.',
};
const OFERTA: Oferta = {
  kind: 'oferta',
  ...COMUM,
  offer: 'Combo sexta (smash, batata e refrigerante) em destaque',
  day: '2026-10-09',
  starts_at: '18:00',
  ends_at: '23:00',
  where: 'no anúncio da Combo sexta (Meta Ads), no cardápio online e no balcão',
  ad_text: 'Sexta é dia de combo: smash, batata e refri. Já escolheu o seu?',
  coupon_code: 'SEXTA10',
  how_to_measure: 'Pedidos com o SEXTA10 e pelo link da campanha, confirmados no caixa.',
};
const PAUTA: Pauta = {
  kind: 'pauta',
  ...COMUM,
  summary: 'O que fazer em cada dia até domingo.',
  days: [
    { day: '2026-10-07', item: 'Ver na Meta por que a Delivery noite parou.' },
    { day: '2026-10-08', item: 'Pôr o rastreio do Liame nos 3 anúncios que estão sem.' },
    { day: '2026-10-09', item: 'Promoção de sexta, se você aprovar o plano dela.' },
  ],
};
const NOVENTA: Noventa = {
  kind: 'noventa_dias',
  ...COMUM,
  summary: 'Em três meses: provar de onde vêm os pedidos e chegar preparado à Black Friday.',
  goals: [
    { goal: 'Provar a origem dos pedidos.', how_to_know: 'os pedidos sem origem, hoje 46,5%, caindo na revisão de cada segunda.' },
    { goal: 'Fazer sobrar mais do marketing.', how_to_know: 'o que sobra depois dos anúncios subindo a cada semana.' },
  ],
  months: [
    { month: 'Outubro', plan: 'Arrumar a casa: rastreio nos anúncios e um cupom exclusivo por campanha.' },
    { month: 'Novembro', plan: 'Black Friday com um combo para dividir e cupom próprio.' },
  ],
  budget: { today: { meta: 3890, google: 1140 }, proposal: { meta: 4190, google: 840 } },
  dates: [{ day: '2026-11-27', name: 'Black Friday', what: 'combo para dividir, com cupom próprio.' }],
};

const t = (text: string, number: number | null = null) => ({ text, number });
const plano = (content: PlanContent, o: Partial<PlanResponse> = {}, r: Partial<PlanSummary> = {}): PlanResponse => ({
  plan: resumo({ kind: content.kind, risk: content.risk, ...r }),
  content,
  numbers: [
    { value: '31', sources: ['Regem · pedidos da campanha confirmados no caixa · 26/09 a 02/10'] },
    { value: 'R$ 3.890,00', sources: ['Liame · gasto em Meta Ads de 26/09 a 02/10 × 30 ÷ 7 · calculado pelo sistema'] },
  ],
  marked: [
    { path: 'reasons.0', text: [t('A Combo sexta teve '), t('31', 0), t(' pedidos em 7 dias: é a campanha que dá lucro.')] },
    { path: 'budget.today.meta', text: [t('R$ 3.890,00', 1)] },
  ],
  author: 'estrategista',
  edited_by: null,
  reanalysis: null,
  decisions: [],
  can_decide: true,
  ...o,
});

const nada = async () => ({ ok: true }) as const;
const desenhar = (r: PlanResponse, o: Partial<{ pro: boolean; podeDecidir: boolean; temApp: boolean }> = {}) =>
  renderToStaticMarkup(
    createElement(DetalhePlano, {
      r,
      agora,
      pro: o.pro ?? false,
      euId: EU,
      podeDecidir: o.podeDecidir ?? true,
      temApp: o.temApp ?? true,
      podeConferirTexto: true,
      titulo: createRef<HTMLHeadingElement>(),
      campoCodigo: createRef<HTMLInputElement>(),
      aoVoltar: () => {},
      aoAprovar: nada,
      aoRecusar: nada,
      aoEditar: nada,
      aoPedirNovaAnalise: nada,
      aoAvisar: () => {},
    }),
  );

describe('Planos em Aprovações: o que pesa na lista', () => {
  it('risco, verba, etiqueta e identidade da versão', () => {
    expect(riscoDoPlano('baixo')).toBe('baixo');
    expect(riscoDoPlano('alto')).toBe('alto');
    // Risco que a tela ainda não conhece é tratado como médio.
    expect(riscoDoPlano('novo_nivel')).toBe('medio');
    expect(dinheiroDoPlano(null)).toBe('sem verba nova');
    expect(dinheiroDoPlano('0')).toBe('sem verba nova');
    expect(dinheiroDoPlano('-300000000')).toBe('sem verba nova');
    expect(dinheiroDoPlano('200000000')).toBe(`+R$${NBSP}200/mês`);
    expect(etiquetaDoPlano('aprovado')).toBe('Aprovado');
    expect(etiquetaDoPlano('nova_analise')).toBe('Nova análise pedida');
    expect(etiquetaDoPlano('expirado')).toBe('Expirou');
    expect(identidadeDaVersao(resumo({ version: 2 }))).toEqual({ plano: 'a0000000', versao: 2, hash: 'a81e…07d2' });
    expect(enderecoDoPlano(uuid(1))).toBe(`/aprovacoes?plano=${uuid(1)}`);
  });

  it('o grupo do plano: o que espera decisão; o decidido ou expirado hoje; o resto fica de fora', () => {
    expect(grupoDoPlano(resumo(), agora)).toBe('pendente');
    expect(grupoDoPlano(resumo({ status: 'aprovado', updated_at: local(3, 14) }), agora)).toBe('feito');
    expect(grupoDoPlano(resumo({ status: 'recusado', updated_at: local(2, 14) }), agora)).toBeNull();
    expect(grupoDoPlano(resumo({ status: 'nova_analise', updated_at: local(3, 9) }), agora)).toBe('feito');
    // O que expirou conta pelo dia em que expirou (ninguém mexeu nele).
    expect(grupoDoPlano(resumo({ status: 'expirado', expires_at: local(3, 8), updated_at: local(1, 8) }), agora)).toBe('feito');
    expect(grupoDoPlano(resumo({ status: 'expirado', expires_at: local(2, 8), updated_at: local(3, 8) }), agora)).toBeNull();
  });

  it('a fila é uma só: ações e planos juntos, o que expira primeiro no topo; o número conta o que a pessoa decide', () => {
    const acao = (id: number, o: Partial<ActionResponse>): ActionResponse =>
      ({ id: uuid(id), status: 'aguardando_aprovacao', mode: 'APPROVAL', approvals: [], expires_at: local(5, 10), created_at: local(3, 9), updated_at: local(3, 9), ...o }) as ActionResponse;
    const grupos = montarLista(
      [acao(100, { expires_at: local(5, 10) }), acao(101, { status: 'executada', approvals: [], mode: 'AUTO', updated_at: local(3, 11) })],
      [resumo({ id: uuid(1), expires_at: local(4, 10) }), resumo({ id: uuid(2), expires_at: local(6, 10) }), resumo({ id: uuid(3), status: 'aprovado', updated_at: local(3, 14) }), resumo({ id: uuid(4), status: 'recusado', updated_at: local(1, 14) })],
      agora,
    );
    expect(grupos.pendente.map((i) => i.chave)).toEqual([chaveDoPlano(uuid(1)), chaveDaAcao(uuid(100)), chaveDoPlano(uuid(2))]);
    expect(grupos.auto.map((i) => i.chave)).toEqual([chaveDaAcao(uuid(101))]);
    expect(grupos.feito.map((i) => i.chave)).toEqual([chaveDoPlano(uuid(3))]);
    expect(pendentesDe(grupos, true, true)).toBe(3);
    expect(pendentesDe(grupos, true, false)).toBe(1);
    expect(pendentesDe(grupos, false, true)).toBe(2);
    expect(pendentesDe(grupos, false, false)).toBe(0);
  });
});

describe('Planos em Aprovações: de onde veio e o que aconteceu', () => {
  it('a origem: o pedido de alguém na conversa, a nova análise ou a rotina do Estrategista', () => {
    expect(origemDoPlano(plano(OFERTA), EU)).toBe('a pedido de você, na conversa com a LIA');
    expect(origemDoPlano(plano(OFERTA), uuid(8))).toBe('a pedido de Rodrigo, na conversa com a LIA');
    expect(origemDoPlano(plano(OFERTA, {}, { demand_id: null }), uuid(8))).toBe('a pedido de Rodrigo');
    expect(origemDoPlano(plano(NOVENTA, {}, { requested_by: null, demand_id: null }), EU)).toBe('o plano do trimestre');
    expect(origemDoPlano(plano(PAUTA, { reanalysis: 'Quero sem verba nova.' }, { requested_by: null }), EU)).toBe('versão nova, a pedido: “Quero sem verba nova.”');
    expect(cabecalhoDoPlano(plano(OFERTA), EU, agora)).toEqual({ quando: quandoComHora(local(3, 10, 42), agora), origem: 'a pedido de você, na conversa com a LIA' });
  });

  it('o texto com os números marcados quando o servidor marcou; senão, o texto do conteúdo', () => {
    const r = plano(OFERTA);
    expect(trechosDo(r.marked, 'reasons.0', OFERTA.reasons[0]!).map((s) => s.number)).toEqual([null, 0, null]);
    expect(trechosDo(r.marked, 'reasons.1', OFERTA.reasons[1]!)).toEqual([{ text: 'Quase ninguém vê o cupom SEXTA10.', number: null }]);
  });

  it('a lista das fontes traz só os números dos textos que estão na tela', () => {
    expect(caminhosDoCorpo(OFERTA)).toEqual(['offer', 'where', 'ad_text', 'how_to_measure']);
    expect(caminhosDoCorpo(PAUTA)).toEqual(['days.0.item', 'days.1.item', 'days.2.item']);
    expect(caminhosDoCorpo(NOVENTA)).toEqual(['goals.0.goal', 'goals.0.how_to_know', 'goals.1.goal', 'goals.1.how_to_know', 'months.0.plan', 'months.1.plan', 'budget.today.meta', 'budget.today.google', 'dates.0.what']);
    // Esperando decisão, tudo aparece (a frase, os porquês, o corpo, o risco e o que vem depois); decidido, só o corpo.
    expect(caminhosNaTela(OFERTA, 'pendente')).toEqual(['summary', 'reasons.0', 'reasons.1', 'offer', 'where', 'ad_text', 'how_to_measure', 'risk_reason', 'to_do.0', 'to_do.1', 'after']);
    expect(caminhosNaTela(OFERTA, 'aprovado')).toEqual(['to_do.0', 'to_do.1', 'after', 'offer', 'where', 'ad_text', 'how_to_measure']);
    expect(caminhosNaTela(OFERTA, 'decidido')).toEqual(['offer', 'where', 'ad_text', 'how_to_measure']);
    const marked = [
      { path: 'reasons.0', text: [t('teve '), t('31', 0), t(' pedidos e '), t('3,42', 2)] },
      { path: 'offer', text: [t('2', 1), t(' combos, como os '), t('31', 0)] },
      { path: 'budget.today.meta', text: [t('R$ 3.890,00', 3)] },
    ];
    expect(numerosDosCaminhos(marked, caminhosNaTela(OFERTA, 'pendente'))).toEqual([0, 2, 1]);
    expect(numerosDosCaminhos(marked, caminhosNaTela(OFERTA, 'decidido'))).toEqual([1, 0]);
    expect(numerosDosCaminhos(marked, ['after'])).toEqual([]);
  });

  it('as datas do plano são dias do calendário, sem fuso', () => {
    expect(diaDaPauta('2026-10-07')).toBe('Qua, 07/10');
    expect(diaDoCalendario('2026-11-27')).toBe('27/11 · sex');
    expect(quandoDaOferta(OFERTA)).toBe('sexta, 09/10, das 18:00 às 23:00');
  });

  it('o resultado de cada situação: aprovado, recusado, nova análise pedida e expirado', () => {
    const decisao = (decision: string, o: object = {}) => ({ version: 1, decision, reasons: [], comment: null, decided_by: { id: EU, name: 'Rodrigo' }, created_at: local(3, 14, 40), ...o });
    expect(resultadoDoPlano(plano(OFERTA), EU, agora)).toBeNull();
    const aprovado = resultadoDoPlano(plano(OFERTA, { decisions: [decisao('aprovado')] }, { status: 'aprovado' }), EU, agora)!;
    expect(aprovado).toMatchObject({ aprovado: true, icone: 'check' });
    expect(aprovado.texto).toBe(`Aprovado por você às ${horaDe(local(3, 14, 40))} (versão 1). Nada foi publicado pela Liame: o plano virou a lista do que fazer.`);
    expect(resultadoDoPlano(plano(PAUTA, { decisions: [decisao('aprovado')] }, { status: 'aprovado' }), uuid(8), agora)!.texto).toContain('Aprovado por Rodrigo');
    expect(resultadoDoPlano(plano(PAUTA, { decisions: [decisao('aprovado')] }, { status: 'aprovado' }), EU, agora)!.texto).toContain('a pauta é a lista desta semana');
    const recusado = resultadoDoPlano(plano(NOVENTA, { decisions: [decisao('recusado', { reasons: ['verba_nao_serve', 'motivo_novo'], comment: 'Prefiro manter o Google.' })] }, { status: 'recusado' }), EU, agora)!;
    expect(recusado.texto).toBe('Recusado por você: “A verba não serve; outro motivo; Prefiro manter o Google.”. Nada foi executado. O Estrategista guardou o motivo para o próximo plano.');
    const nova = resultadoDoPlano(plano(OFERTA, { decisions: [decisao('nova_analise', { comment: 'Quero a promoção também no sábado.' })] }, { status: 'nova_analise' }), EU, agora)!;
    expect(nova.texto).toBe(`Nova análise pedida por você às ${horaDe(local(3, 14, 40))}: “Quero a promoção também no sábado.”. O Estrategista refaz o plano e manda a versão 2 para cá; esta versão não pode mais ser aprovada.`);
    expect(resultadoDoPlano(plano(OFERTA, {}, { status: 'expirado' }), EU, agora)!.texto).toContain('Expirou sem decisão: nada foi feito.');
    // Decidido em outro dia: a data vai junto. Situação nova: a tela diz o que sabe.
    expect(resultadoDoPlano(plano(OFERTA, { decisions: [decisao('aprovado', { created_at: local(1, 9, 5) })] }, { status: 'aprovado' }), EU, agora)!.texto).toContain(`em 01/10, ${horaDe(local(1, 9, 5))}`);
    expect(resultadoDoPlano(plano(OFERTA, {}, { status: 'situacao_nova' }), EU, agora)!.texto).toBe('Este plano não espera mais decisão.');
  });

  it('a versão editada por uma pessoa avisa quem editou; os motivos da recusa mudam com o tipo', () => {
    expect(avisoDaVersao(plano(OFERTA), EU)).toBeNull();
    expect(avisoDaVersao(plano(OFERTA, { author: 'pessoa', edited_by: { id: EU, name: 'Rodrigo' } }, { version: 2 }), EU)).toBe('Você editou o plano: agora é a versão 2 (hash a81e…07d2). A aprovação vale só para esta versão.');
    expect(avisoDaVersao(plano(OFERTA, { author: 'pessoa', edited_by: { id: uuid(8), name: 'Ana' } }, { version: 3 }), EU)).toContain('Ana editou o plano: agora é a versão 3');
    expect(motivosDoPlano('noventa_dias').map((m) => m.rotulo)).toEqual(['Não é o momento', 'A verba não serve', 'Não concordo com o plano']);
    expect(motivosDoPlano('pauta').map((m) => [m.valor, m.rotulo])).toEqual([
      ['nao_e_o_momento', 'Não é o momento'],
      ['falta_gente', 'Falta gente para fazer'],
      ['nao_concordo', 'Não concordo com a pauta'],
    ]);
    expect(motivosDoPlano('oferta').map((m) => m.valor)).toEqual(['nao_e_o_momento', 'oferta_nao_serve', 'nao_concordo']);
    expect(motivosDoPlano('tipo_novo').map((m) => m.valor)).toEqual(['nao_e_o_momento', 'nao_concordo']);
  });

  it('as recusas do servidor, em palavras de gente', () => {
    expect(erroDoPlano({ code: 'plano-mudou', title: 'x' })).toMatchObject({ recarregar: true, noCodigo: false });
    expect(erroDoPlano({ code: 'plano-nao-aguarda', title: 'x' }).texto).toBe('Este plano não espera mais decisão: alguém já decidiu.');
    expect(erroDoPlano({ code: 'plano-expirado', title: 'x' }).texto).toContain('Peça uma nova análise');
    expect(erroDoPlano({ code: 'plano-sem-mudanca', title: 'x' })).toMatchObject({ recarregar: false });
    // O código do app é o mesmo dos pedidos; o texto recusado diz o que o servidor achou.
    expect(erroDoPlano({ code: 'codigo-invalido', title: 'x' })).toMatchObject({ noCodigo: true });
    expect(erroDoPlano({ code: 'texto-recusado', title: 'O texto não passa assim', detail: 'Ajuste e salve de novo: promessa de resultado (regra da Liame).' }).texto).toBe('Ajuste e salve de novo: promessa de resultado (regra da Liame).');
  });
});

describe('Planos em Aprovações: a verba e a versão que a pessoa edita', () => {
  it('a frase e o total da verba saem das contas dos campos', () => {
    expect(fraseDaVerba(NOVENTA.budget)).toBe(`O total em anúncios fica igual, R$${NBSP}5.030 por mês: R$${NBSP}300 saem do Google e vão para a Meta.`);
    expect(fraseDaVerba({ today: NOVENTA.budget.today, proposal: { meta: 4390, google: 840 } })).toBe(`O total em anúncios sobe para R$${NBSP}5.230 por mês: R$${NBSP}200 a mais que hoje.`);
    expect(fraseDaVerba({ today: NOVENTA.budget.today, proposal: { meta: 3890, google: 1000 } })).toBe(`O total em anúncios cai para R$${NBSP}4.890 por mês: R$${NBSP}140 a menos que hoje.`);
    expect(fraseDaVerba({ today: NOVENTA.budget.today, proposal: NOVENTA.budget.today })).toBe(`A verba fica como está: R$${NBSP}5.030 por mês.`);
    expect(totalDaVerba(4390, 840, NOVENTA.budget.today)).toBe(`Total: R$${NBSP}5.230 por mês, R$${NBSP}200 a mais que hoje.`);
    expect(totalDaVerba(3890, 1140, NOVENTA.budget.today)).toBe(`Total: R$${NBSP}5.030 por mês, igual a hoje.`);
    expect(tabelaDaVerba(NOVENTA.budget)).toEqual({
      linhas: [
        { canal: 'Instagram e Facebook', caminho: 'budget.today.meta', hoje: `R$${NBSP}3.890`, proposta: `R$${NBSP}4.190` },
        { canal: 'Google', caminho: 'budget.today.google', hoje: `R$${NBSP}1.140`, proposta: `R$${NBSP}840` },
      ],
      total: { hoje: `R$${NBSP}5.030`, proposta: `R$${NBSP}5.030` },
    });
  });

  it('editar a verba: o risco acompanha a conta, e a verba de hoje não muda', () => {
    const mais = comVerba(NOVENTA, 4390, 840);
    expect(mais.budget).toEqual({ today: { meta: 3890, google: 1140 }, proposal: { meta: 4390, google: 840 } });
    expect(mais.risk).toBe('medio');
    expect(mais.risk_reason).toBe(`pede R$${NBSP}200 a mais por mês do que hoje. Nada é executado por aqui: quem muda a verba é quem cuida das campanhas.`);
    expect(comVerba(NOVENTA, 3000, 1000)).toMatchObject({ risk: 'baixo', risk_reason: 'o total por mês cai, e nada é executado por aqui.' });
    expect(comVerba(NOVENTA, 3890, 1140).risk_reason).toBe('a verba fica como está, e nada é executado por aqui.');
    expect(erroDaVerba(4390, 840)).toBeNull();
    expect(erroDaVerba(0, 0)).toBe('Use reais inteiros, e um total maior que zero.');
    expect(erroDaVerba(10.5, 100)).not.toBeNull();
    expect(erroDaVerba(-1, 100)).not.toBeNull();
    expect(erroDaVerba(Number.NaN, 100)).not.toBeNull();
  });

  it('editar a pauta e a oferta: os dias não mudam, o fim vem depois do começo e o texto não pode bater em regra', () => {
    const pauta = comDias(PAUTA, ['  Resolver a Delivery noite.  ', PAUTA.days[1]!.item, 'nada novo']);
    expect(pauta.days.map((d) => d.day)).toEqual(PAUTA.days.map((d) => d.day));
    expect(pauta.days.map((d) => d.item)).toEqual(['Resolver a Delivery noite.', PAUTA.days[1]!.item, 'nada novo']);
    expect(erroDaPauta(['a', ' ', 'c'])).toContain('Cada dia precisa de um item');
    expect(erroDaPauta(['a', 'b', 'c'])).toBeNull();
    const campos = { oferta: ' Combo em dobro ', inicio: '19:00', fim: '23:00', texto: ' Sexta é dia de combo. ' };
    expect(comOferta(OFERTA, campos)).toMatchObject({ offer: 'Combo em dobro', starts_at: '19:00', ends_at: '23:00', ad_text: 'Sexta é dia de combo.', coupon_code: 'SEXTA10', day: '2026-10-09' });
    expect(erroDaOferta(campos, 0)).toBeNull();
    expect(erroDaOferta({ ...campos, oferta: ' ' }, 0)).toBe('Preencha a oferta, o horário e o texto do anúncio.');
    expect(erroDaOferta({ ...campos, fim: '18:00' }, 0)).toBe('O fim precisa ser depois do começo.');
    expect(erroDaOferta(campos, 1)).toBe('O texto do anúncio bate numa regra e não passa assim.');
  });

  it('versão igual à aberta não vira versão nova', () => {
    expect(mesmoConteudo(OFERTA, comOferta(OFERTA, { oferta: OFERTA.offer, inicio: OFERTA.starts_at, fim: OFERTA.ends_at, texto: OFERTA.ad_text }))).toBe(true);
    expect(mesmoConteudo(OFERTA, comOferta(OFERTA, { oferta: OFERTA.offer, inicio: '19:00', fim: OFERTA.ends_at, texto: OFERTA.ad_text }))).toBe(false);
    expect(mesmoConteudo(NOVENTA, comVerba(NOVENTA, 4190, 840))).toBe(true);
    expect(mesmoConteudo(NOVENTA, comVerba(NOVENTA, 4390, 840))).toBe(false);
    expect(mesmoConteudo(PAUTA, comDias(PAUTA, PAUTA.days.map((d) => d.item)))).toBe(true);
    expect(mesmoConteudo(PAUTA, OFERTA)).toBe(false);
  });
});

describe('Planos em Aprovações: o plano desenhado', () => {
  it('a oferta esperando decisão, no Lite: a frase, os selos, os detalhes fechados e a barra da decisão', () => {
    const html = desenhar(plano(OFERTA));
    expect(html).toContain('<b>Estrategista</b> propôs');
    expect(html).toContain('a pedido de você, na conversa com a LIA');
    expect(html).toContain('Promoção de sexta: combo com refrigerante');
    expect(html).toContain('Nada vai ao ar sozinho');
    expect(html).toContain('Risco baixo');
    expect(html).toContain('expira em 3 dias');
    expect(html).toContain('Ver detalhes');
    // Os detalhes estão na página, fechados: o plano inteiro que a aprovação assina.
    expect(html).toMatch(/hidden=""[^>]*>\s*<p class="plano-id">Plano a0000000 · versão 1 · hash <b>a81e…07d2<\/b> · a aprovação vale só para esta versão/);
    expect(html).toContain('Por quê');
    expect(html).toContain('class="nf"');
    expect(html).toContain('Texto do anúncio');
    expect(html).toContain('SEXTA10, que já existe. Nenhum cupom novo.');
    expect(html).toContain('sexta, 09/10, das 18:00 às 23:00');
    expect(html).toContain('Depois de aprovado');
    // Só o número que está na tela entra na lista (a verba de hoje é de outro tipo de plano).
    expect(html).toContain('De onde vêm os números (1)');
    expect(html).toContain('Quer mudar algo antes de decidir?');
    expect(html).toContain('Editar o plano');
    expect(html).toContain('Pedir nova análise');
    expect(html).toContain('Código do app');
    expect(html).toContain('A aprovação vale só para a versão 1.');
    expect(html).toContain('A oferta não serve');
    expect(html).not.toContain('O que fazer agora');
  });

  it('no Pro, tudo aberto e a frase do plano junto dos detalhes; sem o app, o caminho para ativar', () => {
    const pro = desenhar(plano(OFERTA), { pro: true });
    expect(pro).not.toContain('Ver detalhes');
    expect(pro).not.toMatch(/hidden=""[^>]*>\s*<p class="plano-id">/);
    expect(pro).toContain('O Estrategista propõe o Combo sexta em destaque');
    const semApp = desenhar(plano(OFERTA), { temApp: false });
    expect(semApp).toContain('ative o app autenticador');
    expect(semApp).not.toContain('Código do app');
  });

  it('o plano de 90 dias: objetivos, mês a mês, a verba de hoje com a fonte, a proposta e o calendário', () => {
    const html = desenhar(plano(NOVENTA, {}, { money_micros: '0' }), { pro: true });
    expect(html).toContain('O que o plano quer, e como saber se deu certo');
    expect(html).toContain('Como saber: os pedidos sem origem');
    expect(html).toContain('Mês a mês');
    expect(html).toContain('Verba por canal, por mês');
    expect(html).toContain('Instagram e Facebook');
    // A verba de hoje é um número com fonte (calculado pelo sistema); a proposta é do plano.
    expect(html).toMatch(/class="n num ap-antes"><button type="button" class="nf"[^>]*>R\$ 3\.890,00/);
    expect(html).toContain(`R$${NBSP}4.190`);
    expect(html).toContain('Calendário comercial');
    expect(html).toContain('27/11 · sex');
    expect(html).toContain('não da memória da IA');
    expect(html).toContain(`O total em anúncios fica igual, R$${NBSP}5.030 por mês`);
    expect(html).toContain('A verba não serve');
  });

  it('a pauta: um item por dia; e a versão editada avisa que a aprovação vale só para ela', () => {
    const html = desenhar(plano(PAUTA, { author: 'pessoa', edited_by: { id: EU, name: 'Rodrigo' } }, { version: 2, requested_by: null, demand_id: null }), { pro: true });
    expect(html).toContain('Dia a dia');
    expect(html).toContain('Qua, 07/10');
    expect(html).toContain('Você editou o plano: agora é a versão 2');
    expect(html).toContain('Falta gente para fazer');
    expect(html).toContain('Não concordo com a pauta');
  });

  it('quem só acompanha não decide: sem editar, sem a barra', () => {
    const html = desenhar(plano(OFERTA, { can_decide: false }), { podeDecidir: false });
    expect(html).toContain('Só quem pode decidir os planos aprova este.');
    expect(html).not.toContain('Código do app');
    expect(html).not.toContain('Editar o plano');
  });

  it('aprovado: o que fazer agora e o que vem depois; recusado e nova análise: o que aconteceu; expirado: dá para pedir nova análise', () => {
    const decisao = (decision: string, comment: string | null = null) => ({ version: 1, decision, reasons: decision === 'recusado' ? ['oferta_nao_serve'] : [], comment, decided_by: { id: EU, name: 'Rodrigo' }, created_at: local(3, 14, 40) });
    const aprovado = desenhar(plano(OFERTA, { decisions: [decisao('aprovado')], can_decide: false }, { status: 'aprovado', updated_at: local(3, 14, 40) }));
    expect(aprovado).toContain('Aprovado por você');
    expect(aprovado).toContain('O que fazer agora');
    expect(aprovado).toContain('Na Meta, troque o texto do anúncio');
    expect(aprovado).toContain('A revisão de segunda, 05/10');
    expect(aprovado).not.toContain('Código do app');
    expect(aprovado).not.toContain('Quer mudar algo antes de decidir?');
    // O número do "por quê" não está nesta vista: a lista das fontes não aparece vazia de sentido.
    expect(aprovado).not.toContain('De onde vêm os números');
    const recusado = desenhar(plano(OFERTA, { decisions: [decisao('recusado')], can_decide: false }, { status: 'recusado' }));
    expect(recusado).toContain('Recusado por você: “A oferta não serve”. Nada foi executado.');
    expect(recusado).not.toContain('O que fazer agora');
    const nova = desenhar(plano(OFERTA, { decisions: [decisao('nova_analise', 'Quero também no sábado.')], can_decide: false }, { status: 'nova_analise' }));
    expect(nova).toContain('manda a versão 2 para cá');
    const expirado = desenhar(plano(OFERTA, { can_decide: false }, { status: 'expirado' }));
    expect(expirado).toContain('Expirou sem decisão');
    expect(expirado).toContain('Pedir nova análise');
    // Quem não decide planos vê que expirou, sem o pedido de nova análise.
    expect(desenhar(plano(OFERTA, { can_decide: false }, { status: 'expirado' }), { podeDecidir: false })).not.toContain('Pedir nova análise');
  });
});
