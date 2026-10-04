import type { ActionResponse } from '@liame/contracts';
import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DetalhePedido } from '@/components/aprovacoes/detalhe-pedido';
import {
  agrupar,
  apresentar,
  aprovacaoParcial,
  avisoDepoisDeAprovar,
  cabecalhoDe,
  enderecoDoPedido,
  erroDaDecisao,
  erroDoCodigo,
  etiquetaDoDecidido,
  grupoDe,
  identidadeDoPlano,
  pedidoDaUrl,
  pendentesFalados,
  politicaDe,
  prazoDe,
  recusaDe,
  resultadoDe,
  riscoDe,
} from '@/components/aprovacoes/textos';
import { itensVisiveis, NAVEGACAO, temModos, tituloDa } from '@/components/shell/navegacao';

// Tela Aprovações (protótipo aprovado, vista "aprovacoes"): como cada tipo de pedido se apresenta, os grupos
// da lista, o prazo, o resultado do que já foi decidido, a conferência do código do app, as recusas do
// servidor e o detalhe nos modos Lite e Pro, para quem decide e para quem só acompanha.

const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const agora = new Date(2026, 9, 1, 15, 0);
const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const NBSP = String.fromCharCode(160);

const acao = (o: Partial<ActionResponse> = {}): ActionResponse => ({
  id: uuid(1),
  tool: 'regem_cupom_criar',
  action: 'cupom.criar',
  brand_id: uuid(50),
  provider: 'regem',
  account_id: uuid(60),
  resource_id: 'cupom:SEXTA15',
  params: { codigo: 'SEXTA15', nome: 'Liame · Combo sexta', tipo: 'percentual', percentual: 15, pedido_minimo_centavos: 5000, valido_de: '2026-10-02', valido_ate: '2026-10-31', campaign_id: uuid(70), exclusive: true },
  risk_level: 'R1',
  budget_impact: 'none',
  value_micros: null,
  current_value_micros: null,
  reserved_micros: 0,
  plan_hash: `a1b2${'0'.repeat(56)}c3d4`,
  mode: 'APPROVAL',
  status: 'aguardando_aprovacao',
  status_reason: null,
  attempts: 0,
  next_attempt_at: null,
  undoes: null,
  undone_by: null,
  policy: { allowed: true, mode: 'APPROVAL', violations: [], versions: ['plataforma@2'] },
  approvals: [],
  workflow: null,
  expires_at: local(4, 10, 14),
  created_at: local(1, 10, 14),
  updated_at: local(1, 10, 14),
  requested_by: { id: uuid(9), name: 'Rodrigo Lima' },
  account_name: 'Loja Centro',
  campaign: { id: uuid(70), name: 'Combo sexta', provider: 'meta_ads', status: 'ativa' },
  ...o,
});
const aprovacao = (o: Partial<ActionResponse['approvals'][number]> = {}): ActionResponse['approvals'][number] => ({
  approved_by: uuid(10),
  approver_name: 'Ana Aprovadora',
  approver_role: 'aprovador',
  sufficient: true,
  current_plan: true,
  created_at: local(1, 11, 5),
  ...o,
});

describe('como cada pedido se apresenta', () => {
  it('cupom no Regem: título com o código e a loja, a regra como na aba Cupons, o antes e depois e como se desfaz', () => {
    const p = apresentar(acao());
    expect(p.titulo).toBe('Criar o cupom SEXTA15 na Loja Centro');
    expect(p.impacto).toBe(`15% · mín. R$${NBSP}50`);
    expect(p.resumo).toBe(`Rodrigo Lima pediu um cupom de 15% · mín. R$${NBSP}50, válido de 02/10 a 31/10, para a campanha Combo sexta. Se você aprovar, o Liame cria o cupom no Regem e liga à campanha.`);
    expect(p.mudancas).toEqual([
      ['Cupom no Regem', 'não existe', 'SEXTA15'],
      ['Desconto', '—', `15% · mín. R$${NBSP}50`],
      ['Validade', '—', '02/10 a 31/10'],
      ['Campanha', '—', 'Combo sexta · exclusivo, prova a origem'],
    ]);
    expect(p.desfazer).toContain('desativado depois, no Regem');
    expect(p.depoisDeAprovar).toBe('O Liame cria o cupom no Regem em instantes.');
  });

  it('cupom de valor fixo (com centavos), de entrega grátis, não exclusivo e com a campanha fora da lista', () => {
    const valor = apresentar(acao({ params: { codigo: 'DEZ', tipo: 'valor', valor_centavos: 750, pedido_minimo_centavos: 0, valido_de: '2026-10-02', valido_ate: '2026-10-31', exclusive: false } }));
    expect(valor.impacto).toBe(`R$${NBSP}7,50 de desconto · sem mínimo`);
    expect(valor.mudancas[3]).toEqual(['Campanha', '—', 'Combo sexta · não exclusivo, só acompanha']);
    const frete = apresentar(acao({ params: { codigo: 'FRETE0', tipo: 'frete_gratis', pedido_minimo_centavos: 3000, valido_de: '2026-10-02', valido_ate: '2026-10-31', exclusive: true }, campaign: null, account_name: null }));
    expect(frete.titulo).toBe('Criar o cupom FRETE0 na loja do Regem');
    expect(frete.impacto).toBe(`Entrega grátis · mín. R$${NBSP}30`);
    expect(frete.mudancas[3]).toEqual(['Campanha', '—', 'a campanha saiu da lista']);
    expect(frete.resumo).not.toContain('para a campanha');
  });

  it('orçamento e pausa (sandbox) e a ferramenta que a tela não conhece, sem inventar frase', () => {
    const o = apresentar(acao({ tool: 'orcamento_ajustar', action: 'orcamento.aumentar', resource_id: 'camp_1', value_micros: 130_000_000, current_value_micros: 100_000_000, params: { daily_budget_micros: 130_000_000 } }));
    expect(o.titulo).toBe('Mudar o orçamento diário de camp_1');
    expect(o.impacto).toBe(`+R$${NBSP}30,00/dia`);
    expect(o.mudancas).toEqual([['Orçamento diário', `R$${NBSP}100,00/dia`, `R$${NBSP}130,00/dia`]]);
    const menos = apresentar(acao({ tool: 'orcamento_ajustar', value_micros: 80_000_000, current_value_micros: 100_000_000, params: {} }));
    expect(menos.impacto).toBe(`−R$${NBSP}20,00/dia`);
    expect(apresentar(acao({ tool: 'anuncio_pausar', resource_id: 'ad_9', params: {} })).titulo).toBe('Pausar o anúncio ad_9');
    const nova = apresentar(acao({ tool: 'ferramenta_nova', action: 'coisa.fazer', params: { alvo: 'x', n: 3 } }));
    expect(nova.titulo).toBe('coisa.fazer (ferramenta_nova)');
    expect(nova.mudancas).toEqual([['alvo', '—', 'x'], ['n', '—', '3']]);
    // Nome de ferramenta igual a uma propriedade de todo objeto não vira função chamada por engano.
    expect(apresentar(acao({ tool: 'constructor', action: 'x.y', params: {} })).titulo).toBe('x.y (constructor)');
  });
});

describe('risco, política, prazo e plano', () => {
  it('risco pelo nível da ferramenta; a política diz por que precisa de alguém e quais regras valem', () => {
    expect([riscoDe({ risk_level: 'R0' }), riscoDe({ risk_level: 'R1' }), riscoDe({ risk_level: 'R2' }), riscoDe({ risk_level: 'R3' })]).toEqual(['baixo', 'baixo', 'medio', 'alto']);
    expect(politicaDe(acao())).toBe('A política pede aprovação para esta ação: nada é executado antes do seu ok. Regras em vigor: plataforma@2.');
    expect(politicaDe(acao({ mode: 'ESCALATE', policy: { allowed: true, mode: 'ESCALATE', violations: [], versions: ['plataforma@2', 'empresa@3'] } }))).toBe(
      'A política pede a decisão do dono para esta ação. Regras em vigor: plataforma@2, empresa@3.',
    );
  });

  it('prazo em dias, horas e minutos; o plano pelo começo do id e as pontas do hash', () => {
    const em = (ms: number) => prazoDe({ expires_at: new Date(agora.getTime() + ms).toISOString() }, agora);
    expect([em(3 * 86_400_000), em(26 * 3_600_000), em(5 * 3_600_000), em(20 * 60_000), em(30_000), em(-1)]).toEqual(['expira em 3 dias', 'expira em 1 dia', 'expira em 5 h', 'expira em 20 min', 'expira em 1 min', 'expirou']);
    expect(identidadeDoPlano(acao())).toEqual({ plano: 'a0000000', hash: 'a1b2…c3d4' });
  });
});

describe('grupos da lista e o que aconteceu com cada pedido', () => {
  it('o que espera aprovação; o que a política fez sozinha hoje; o decidido hoje; sombra e outros dias ficam de fora', () => {
    expect(grupoDe(acao(), agora)).toBe('pendente');
    // O que espera há dias continua na fila.
    expect(grupoDe(acao({ updated_at: new Date(2026, 8, 29, 9).toISOString() }), agora)).toBe('pendente');
    expect(grupoDe(acao({ status: 'executada', approvals: [aprovacao()] }), agora)).toBe('feito');
    expect(grupoDe(acao({ status: 'executada', mode: 'LIMITED_AUTO' }), agora)).toBe('auto');
    expect(grupoDe(acao({ status: 'cancelada', status_reason: 'recusada por Ana: Não é o momento' }), agora)).toBe('feito');
    expect(grupoDe(acao({ status: 'sombra' }), agora)).toBeNull();
    expect(grupoDe(acao({ status: 'executada', updated_at: new Date(2026, 8, 30, 9).toISOString() }), agora)).toBeNull();
  });

  it('na fila, o que expira primeiro vem primeiro; nas decididas, a mais recente', () => {
    const g = agrupar(
      [
        acao({ id: uuid(1), expires_at: local(4, 10) }),
        acao({ id: uuid(2), expires_at: local(2, 9) }),
        acao({ id: uuid(3), status: 'executada', approvals: [aprovacao()], updated_at: local(1, 11) }),
        acao({ id: uuid(4), status: 'expirada', updated_at: local(1, 14) }),
      ],
      agora,
    );
    expect(g.pendente.map((a) => a.id)).toEqual([uuid(2), uuid(1)]);
    expect(g.feito.map((a) => a.id)).toEqual([uuid(4), uuid(3)]);
    expect(g.auto).toEqual([]);
  });

  it('recusa: quem recusou e o motivo saem do motivo gravado; cancelado por quem pediu não é recusa', () => {
    expect(recusaDe(acao({ status: 'cancelada', status_reason: 'recusada por Ana Aprovadora: Quero outro valor: 10%' }))).toEqual({ quem: 'Ana Aprovadora', motivo: 'Quero outro valor: 10%' });
    expect(recusaDe(acao({ status: 'cancelada', status_reason: 'cancelada por quem opera' }))).toBeNull();
    expect(recusaDe(acao({ status: 'aguardando_aprovacao', status_reason: 'recusada por X: y' }))).toBeNull();
  });

  it('etiqueta e resultado do que já foi decidido', () => {
    const ap = [aprovacao()];
    const casos: [Partial<ActionResponse>, string, string][] = [
      [{ status: 'aprovada', approvals: ap }, 'Aprovado', 'Aprovado por Ana Aprovadora às 11:05. O Liame executa em instantes.'],
      // A plataforma mandou esperar: o pedido segue aprovado, com a hora da próxima tentativa.
      [
        { status: 'aprovada', approvals: ap, attempts: 1, next_attempt_at: local(1, 12, 10), status_reason: 'a Meta pediu para esperar (limite de uso da conta)' },
        'Aprovado',
        'Aprovado por Ana Aprovadora às 11:05. Ainda não foi executado: a Meta pediu para esperar (limite de uso da conta). O Liame tenta de novo às 12:10.',
      ],
      [{ status: 'executada', approvals: ap, updated_at: local(1, 11, 6) }, 'Executado', 'Aprovado por Ana Aprovadora às 11:05 e executado às 11:06.'],
      [{ status: 'falhou', approvals: ap, status_reason: 'Já existe um cupom com este código no Regem. Escolha outro código.' }, 'Não executado', 'Aprovado por Ana Aprovadora às 11:05, mas não foi executado: Já existe um cupom com este código no Regem. Escolha outro código.'],
      [{ status: 'cancelada', status_reason: 'recusada por Ana Aprovadora: Não é o momento' }, 'Recusado', 'Recusado por Ana Aprovadora: “Não é o momento”. Nada foi executado.'],
      [{ status: 'cancelada', status_reason: 'cancelada por quem opera' }, 'Cancelado', 'Cancelado por quem pediu. Nada foi executado.'],
      [{ status: 'expirada', status_reason: 'ninguém aprovou no prazo' }, 'Expirou', 'Expirou sem aprovação: nada foi feito.'],
      [{ status: 'executada', mode: 'LIMITED_AUTO', updated_at: local(1, 9, 30) }, 'Executado', 'Aprovado pela política (dentro dos limites) e executado às 09:30.'],
    ];
    for (const [o, etiqueta, texto] of casos) {
      const a = acao(o);
      expect([etiquetaDoDecidido(a), resultadoDe(a).texto]).toEqual([etiqueta, texto]);
    }
    expect(resultadoDe(acao({ status: 'executada', approvals: ap })).ok).toBe(true);
    expect(resultadoDe(acao({ status: 'falhou', approvals: ap })).ok).toBe(false);
  });

  it('aprovação que não basta (falta o dono) aparece no pedido que continua na fila; o cabeçalho diz quem pediu e quando', () => {
    expect(aprovacaoParcial(acao())).toBeNull();
    expect(aprovacaoParcial(acao({ approvals: [aprovacao({ sufficient: false })] }))).toContain('Ana Aprovadora já aprovou. Falta a aprovação do dono');
    // Aprovação dada a um plano anterior não conta.
    expect(aprovacaoParcial(acao({ approvals: [aprovacao({ sufficient: false, current_plan: false })] }))).toBeNull();
    expect(cabecalhoDe(acao(), agora)).toEqual({ quem: 'Rodrigo Lima', verbo: 'pediu', quando: 'hoje, 10:14' });
    expect(cabecalhoDe(acao({ status: 'executada', mode: 'AUTO' }), agora)).toMatchObject({ quem: 'Liame', verbo: 'fez sozinho' });
  });
});

describe('aprovar e recusar', () => {
  it('o código do app são 6 números', () => {
    expect(erroDoCodigo('123456')).toBeNull();
    expect(erroDoCodigo(' 123456 ')).toBeNull();
    for (const ruim of ['', '12345', '1234567', '12345a', '12 456', '１２３４５６']) expect(erroDoCodigo(ruim)).toBe('Digite os 6 números do app autenticador.');
  });

  it('a recusa do servidor em palavras de gente: código errado volta ao campo; plano que mudou ou pedido já decidido recarrega a lista', () => {
    const p = (code: string, detail?: string) => ({ code, title: 'x', detail });
    expect(erroDaDecisao(p('codigo-invalido'))).toEqual({ texto: 'Código incorreto ou já usado. Espere o próximo código do app e tente de novo.', noCodigo: true, recarregar: false });
    expect(erroDaDecisao(p('segundo-fator-nao-configurado'))).toMatchObject({ noCodigo: false, recarregar: false });
    expect(erroDaDecisao(p('plano-mudou'))).toMatchObject({ recarregar: true });
    expect(erroDaDecisao(p('acao-nao-aguarda'))).toMatchObject({ recarregar: true, texto: 'Este pedido não espera mais aprovação: alguém já decidiu, ou ele expirou.' });
    expect(erroDaDecisao(p('ja-aprovou'))).toMatchObject({ recarregar: true });
    expect(erroDaDecisao(p('limite-de-tentativas', 'Muitas tentativas. Espere 15 minutos.'))).toEqual({ texto: 'Muitas tentativas. Espere 15 minutos.', noCodigo: false, recarregar: false });
  });

  it('depois de aprovar: executa em instantes, ou falta o dono; o item do menu fala quantos pedidos esperam', () => {
    const antes = apresentar(acao());
    expect(avisoDepoisDeAprovar(antes, acao({ status: 'aprovada' }))).toBe('Aprovado. O Liame cria o cupom no Regem em instantes.');
    expect(avisoDepoisDeAprovar(antes, acao({ status: 'aguardando_aprovacao' }))).toBe('Sua aprovação foi registrada. Falta a do dono para o pedido seguir.');
    expect([pendentesFalados(1), pendentesFalados(3)]).toEqual([', 1 pedido esperando', ', 3 pedidos esperando']);
  });
});

describe('telas', () => {
  const detalhe = (o: { a?: ActionResponse; pro?: boolean; podeDecidir?: boolean; temApp?: boolean } = {}) => {
    const a = o.a ?? acao();
    return renderToStaticMarkup(
      createElement(DetalhePedido, {
        acao: a,
        grupo: grupoDe(a, agora),
        agora,
        pro: o.pro ?? false,
        podeDecidir: o.podeDecidir ?? true,
        temApp: o.temApp ?? true,
        titulo: createRef<HTMLHeadingElement>(),
        campoCodigo: createRef<HTMLInputElement>(),
        aoVoltar: () => {},
        aoAprovar: async () => ({ ok: true as const }),
        aoRecusar: async () => ({ ok: true as const }),
      }),
    );
  };

  it('Lite: a frase do que acontece, o risco, o prazo e "Ver detalhes" (com os detalhes recolhidos); a decisão fica à mão', () => {
    const html = detalhe();
    expect(html).toContain('<b>Rodrigo Lima</b> pediu');
    expect(html).toContain('hoje, 10:14');
    expect(html).toContain('Criar o cupom SEXTA15 na Loja Centro');
    expect(html).toContain('Se você aprovar, o Liame cria o cupom no Regem e liga à campanha.');
    expect(html).toContain('Risco baixo');
    expect(html).toContain('expira em 3 dias');
    expect(html).toMatch(/<button class="detalhes-bt"[^>]*aria-expanded="false"[^>]*>Ver detalhes/);
    // Os detalhes existem, recolhidos.
    expect(html).toMatch(/<div id="[^"]+" hidden="">/);
    expect(html).toContain('Código do app');
    expect(html).toMatch(/<input[^>]*inputMode="numeric"[^>]*autoComplete="one-time-code"[^>]*maxLength="6"/);
    expect(html).toContain('Aprovar');
    expect(html).toMatch(/<button class="btn" type="button" aria-expanded="false"[^>]*>.*?Recusar/s);
    // Os motivos da recusa só aparecem depois de "Recusar".
    expect(html).toMatch(/<div class="motivos"[^>]*hidden=""[^>]*role="group" aria-label="Motivo da recusa">/);
    for (const m of ['Não é o momento', 'Quero outro valor', 'Não concordo com o pedido']) expect(html).toContain(m);
  });

  it('Pro: tudo aberto — o plano e o hash, o antes e depois, o risco com a política, como desfazer e o prazo', () => {
    const html = detalhe({ pro: true });
    expect(html).not.toContain('Ver detalhes');
    expect(html).toContain('Plano a0000000 · hash <b>a1b2…c3d4</b> · a aprovação vale só para este plano');
    expect(html).toContain('<caption class="sr-only">O que muda se o pedido for aprovado</caption>');
    expect(html).toContain('<th scope="row">Cupom no Regem</th><td class="ap-antes">não existe</td><td class="ap-depois">SEXTA15</td>');
    expect(html).toContain('Regras em vigor: plataforma@2.');
    expect(html).toContain('O cupom pode ser desativado depois, no Regem.');
    expect(html).toContain('Prazo: expira em 3 dias. Se ninguém decidir, o pedido expira e nada é feito.');
    expect(html).not.toMatch(/<div id="[^"]+" hidden="">/);
  });

  it('quem só acompanha não decide; quem aprova sem o app autenticador é levado a ativar', () => {
    const leitor = detalhe({ podeDecidir: false, pro: true });
    expect(leitor).toContain('Só quem pode aprovar decide este pedido.');
    expect(leitor).not.toContain('Código do app');
    expect(leitor).not.toContain('Recusar');
    const semApp = detalhe({ temApp: false });
    expect(semApp).toContain('Para aprovar, ative o app autenticador em <a href="/seguranca">Segurança da conta</a>.');
    expect(semApp).not.toContain('Código do app');
    expect(semApp).toMatch(/<button class="btn btn--primary ap-aprovar" type="submit" disabled=""/);
    // Recusar não depende do app.
    expect(semApp).toMatch(/<button class="btn" type="button" aria-expanded="false"[^>]*>.*?Recusar/s);
  });

  it('pedido com a aprovação de alguém que não basta: avisa que falta o dono', () => {
    expect(detalhe({ a: acao({ approvals: [aprovacao({ sufficient: false })] }) })).toContain('Ana Aprovadora já aprovou. Falta a aprovação do dono');
  });

  it('pedido já decidido: o que aconteceu e o antes e depois, sem nada para decidir', () => {
    const html = detalhe({ a: acao({ status: 'cancelada', status_reason: 'recusada por Ana Aprovadora: Não é o momento', updated_at: local(1, 12) }) });
    expect(html).toContain('Recusado por Ana Aprovadora: “Não é o momento”. Nada foi executado.');
    expect(html).toContain('Cupom no Regem');
    expect(html).not.toContain('Código do app');
    expect(html).not.toContain('Aprovar');
  });

  it('menu: "Aprovações" fica depois da página inicial (Resumo ou Atenção), para quem vê as campanhas, com o contador e os modos Lite e Pro', () => {
    const agencia = NAVEGACAO.find((g) => g.id === 'agencia')!;
    expect(agencia.itens.map((i) => i.href).slice(0, 3)).toEqual(['/resumo', '/atencao', '/aprovacoes']);
    const item = agencia.itens[2]!;
    expect(item).toMatchObject({ rotulo: 'Aprovações', icone: 'check-circle', permissao: 'campanhas.ver', contador: 'aprovacoes' });
    expect(itensVisiveis(agencia, (p) => p === 'pessoas.ver').map((i) => i.href)).not.toContain('/aprovacoes');
    expect(tituloDa('/aprovacoes')).toBe('Aprovações');
  });

  it('o pedido a abrir vem em ?pedido: só passa o que tem cara de id', () => {
    expect(enderecoDoPedido(uuid(7))).toBe(`/aprovacoes?pedido=${uuid(7)}`);
    expect(pedidoDaUrl(uuid(7))).toBe(uuid(7));
    expect(pedidoDaUrl(uuid(7).toUpperCase())).toBe(uuid(7));
    for (const ruim of [null, '', 'abc', `${uuid(7)}x`, 'g0000000-0000-4000-8000-000000000007', '../../../etc/passwd-000000000000000000']) expect(pedidoDaUrl(ruim)).toBeUndefined();
    expect(temModos('/aprovacoes', () => true)).toBe(true);
  });
});
