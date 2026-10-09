import { ActionProposal } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { type EstadoDaMensagem, faseDaMensagem, motivoDeNaoCaberNoTeto } from '../src/actions/mensagem-plano.js';
import { estadoDoPlano, mensagemDoRecurso, mudancaPedida, recusaDoRegemcast, regemcastMensagemConnector, versaoDaMensagem } from '../src/actions/regemcast-mensagem.js';
import { CONNECTORS } from '../src/actions/connectors.js';
import { PlanoRecusado, TOOLS } from '../src/actions/tools.js';
import { ErroConector } from '../src/connectors/cliente-http.js';
import type { PlanoDoDisparoRegemcast } from '../src/connectors/regemcast/contrato-regemcast.js';
import { chooseMode, evaluatePolicy, PLATFORM_POLICY } from '../src/policy/engine.js';

// A5 · Y5 (parte 2): as regras puras do pedido de mensagem de WhatsApp. O estado do recurso é o plano do disparo que o
// RegemCast devolve; as ferramentas `mensagem_disparar` e `mensagem_pausar` montam o plano da ação a partir dele; a
// versão diz quando o plano mudou; e a política da distribuição (versão 5) manda esperar a aprovação de uma pessoa.

const CAMPANHA = '0199f1aa-2222-7333-8444-555566667777';
const CONFIRMACAO = 'c0nf1rmacao-do-plano-0123456789ab';

const estado = (over: Partial<EstadoDaMensagem> = {}): EstadoDaMensagem => ({
  tipo: 'mensagem',
  id: CAMPANHA,
  nome: 'Sexta em dobro',
  situacao: 'rascunho',
  modelo: 'promo_sexta_v2',
  categoria: 'marketing',
  publico: 'Quem pediu nos últimos 30 dias',
  destinatarios: 412,
  pessoas: 412,
  enviadas: 0,
  moeda: 'BRL',
  custo_centavos: 13_184,
  pode_disparar: true,
  impedimentos: [],
  confirmacao: CONFIRMACAO,
  orcamento: { definido: true, periodos: [{ periodo: 'mes', rotulo: 'Outubro', teto_centavos: 30_000, gasto_centavos: 12_736, sinal: 'ok' }], aviso: null },
  ...over,
});
const recusa = (ferramenta: string, antes: unknown): string => {
  try {
    TOOLS[ferramenta]!.plan(antes as Record<string, unknown>, {});
  } catch (err) {
    expect(err, ferramenta).toBeInstanceOf(PlanoRecusado);
    return (err as Error).message.replace(/ /g, ' ');
  }
  throw new Error(`${ferramenta} não recusou`);
};

describe('pedido de mensagem: as ferramentas e o plano (A5 · Y5)', () => {
  it('o registro: risco, provedor, compensação e a trava de sempre esperar uma pessoa; o conector ainda fora do registro', () => {
    const resumo = Object.fromEntries(
      Object.values(TOOLS)
        .filter((t) => t.providers.includes('regemcast'))
        .map((t) => [t.name, [t.risk, t.providers.join('+'), t.compensation, t.alwaysApproval === true, Boolean(t.undo)]]),
    );
    expect(resumo).toEqual({
      // Custa dinheiro, fala com clientes e não tem volta: o risco mais alto, e nunca sem uma pessoa.
      mensagem_disparar: ['R3', 'regemcast', 'pausar_o_que_ainda_nao_saiu', true, true],
      mensagem_pausar: ['R1', 'regemcast', 'sem_volta_pelo_liame', false, false],
    });
    expect(TOOLS.mensagem_disparar!.undo!({})).toEqual({ tool: 'mensagem_pausar', params: {} });
    // Nenhuma outra ferramenta tem a trava; e as duas não aceitam parâmetro.
    expect(Object.values(TOOLS).filter((t) => t.alwaysApproval).map((t) => t.name)).toEqual(['mensagem_disparar']);
    for (const nome of ['mensagem_disparar', 'mensagem_pausar']) expect(TOOLS[nome]!.params.safeParse({ pessoas: 1 }).success).toBe(false);
    // O conector existe, com a flag de escrita das mensagens e sem exigir os tetos de verba de mídia (D-A5-12), mas não
    // está no registro: nenhum pedido chega a ele por enquanto.
    expect([regemcastMensagemConnector.provider, regemcastMensagemConnector.writeFlag, regemcastMensagemConnector.requiresSpendLimits]).toEqual(['regemcast', 'whatsapp_campaign', false]);
    expect(Object.keys(CONNECTORS)).not.toContain('regemcast');
  });

  it('enviar: o plano que pode disparar vira o pedido, sem reservar verba de mídia; o que a pessoa aprova é o plano inteiro', () => {
    const antes = estado();
    const plano = TOOLS.mensagem_disparar!.plan(antes, {});
    expect(plano).toEqual({ action: 'mensagem.disparar', budgetImpact: 'none', valueMicros: null, currentValueMicros: null, reserveMicros: 0, desiredState: { ...antes, situacao: 'enviando' } });
    // A confirmação, as pessoas e o custo vão no estado desejado: mudou um deles, é outro plano.
    expect(plano.desiredState).toMatchObject({ confirmacao: CONFIRMACAO, pessoas: 412, custo_centavos: 13_184 });
  });

  it('enviar: cada coisa que impede vira recusa no pedido, com o motivo', () => {
    expect(recusa('mensagem_disparar', { tipo: 'campanha', id: '123', status: 'ativo' })).toBe('Esta ferramenta é para uma mensagem montada no RegemCast.');
    expect(recusa('mensagem_disparar', { ...estado(), telefone: '+5521999990001' })).toBe('Esta ferramenta é para uma mensagem montada no RegemCast.');
    // As frases do RegemCast para o que impede.
    expect(recusa('mensagem_disparar', estado({ pode_disparar: false, confirmacao: null, impedimentos: ['O modelo desta campanha ainda não foi aprovado pela Meta.', 'A conta não tem teto de gasto de disparos definido.'] }))).toBe(
      'O modelo desta campanha ainda não foi aprovado pela Meta. A conta não tem teto de gasto de disparos definido.',
    );
    expect(recusa('mensagem_disparar', estado({ pode_disparar: false, confirmacao: null }))).toBe('O RegemCast não deixa enviar esta mensagem agora.');
    // "Pode disparar" sem a confirmação não é plano que se aprove.
    expect(recusa('mensagem_disparar', estado({ confirmacao: null }))).toBe('O RegemCast não deixa enviar esta mensagem agora.');
    expect(recusa('mensagem_disparar', estado({ pessoas: 0 }))).toBe('Ninguém deste público pode receber esta mensagem agora.');
    for (const situacao of ['agendada', 'enviando', 'concluida', 'cancelada', 'situacao_nova']) expect(recusa('mensagem_disparar', estado({ situacao })), situacao).toBe('Esta mensagem já foi enviada ou cancelada: não dá para enviar de novo.');
    expect(recusa('mensagem_disparar', estado({ situacao: 'pausada' }))).toBe('Esta mensagem já foi enviada e está pausada. Quem retoma é uma pessoa, no RegemCast.');
  });

  it('A5-12: o envio precisa caber no teto de gasto de mensagens do mês; os tetos do dia e da semana só espalham', () => {
    // Sobram R$ 172,64: R$ 131,84 cabe, R$ 172,64 cabe (no limite), R$ 172,65 não.
    expect(motivoDeNaoCaberNoTeto(estado())).toBeNull();
    expect(motivoDeNaoCaberNoTeto(estado({ custo_centavos: 17_264 }))).toBeNull();
    expect(recusa('mensagem_disparar', estado({ custo_centavos: 17_265 }))).toBe(
      'Não cabe no teto de gasto de mensagens do mês: o envio pode custar até R$ 172,65, e sobram R$ 172,64 de R$ 300,00. Quem muda o teto é o dono da conta, no RegemCast; outra saída é um público menor.',
    );
    // O teto já estourado: sobra zero, e não um número negativo.
    const cheio = estado({ orcamento: { definido: true, periodos: [{ periodo: 'mes', rotulo: 'Outubro', teto_centavos: 30_000, gasto_centavos: 31_000, sinal: 'cheio' }], aviso: null } });
    expect(recusa('mensagem_disparar', cheio)).toContain('sobram R$ 0,00 de R$ 300,00');
    // Só com teto do dia (menor que o custo): não barra; o RegemCast espalha o envio, e o aviso dele vai no estado.
    const soDia = estado({ orcamento: { definido: true, periodos: [{ periodo: 'dia', rotulo: 'Hoje', teto_centavos: 5_000, gasto_centavos: 0, sinal: 'ok' }], aviso: 'A campanha vai sair aos poucos.' } });
    expect(motivoDeNaoCaberNoTeto(soDia)).toBeNull();
    expect(TOOLS.mensagem_disparar!.plan(soDia, {}).desiredState).toMatchObject({ orcamento: { aviso: 'A campanha vai sair aos poucos.' } });
    // Sem preço para estimar, o Liame não inventa: quem barra a conta sem preço é o RegemCast, no plano dele.
    expect(motivoDeNaoCaberNoTeto(estado({ custo_centavos: null }))).toBeNull();
  });

  it('pausar: só o que está em andamento; reduz gasto e não tem volta pelo Liame', () => {
    for (const situacao of ['agendada', 'enviando']) {
      const antes = estado({ situacao, pode_disparar: false, confirmacao: null, pessoas: 232, enviadas: 180 });
      expect(TOOLS.mensagem_pausar!.plan(antes, {}), situacao).toEqual({ action: 'mensagem.pausar', budgetImpact: 'decrease', valueMicros: null, currentValueMicros: null, reserveMicros: 0, desiredState: { ...antes, situacao: 'pausada' } });
    }
    expect(recusa('mensagem_pausar', estado())).toBe('Esta mensagem ainda não foi enviada: não há o que pausar.');
    expect(recusa('mensagem_pausar', estado({ situacao: 'pausada' }))).toBe('O envio desta mensagem já está pausado.');
    for (const situacao of ['concluida', 'cancelada']) expect(recusa('mensagem_pausar', estado({ situacao })), situacao).toBe('O envio desta mensagem já terminou: não há o que pausar.');
    expect(recusa('mensagem_pausar', { tipo: 'campanha' })).toBe('Esta ferramenta é para uma mensagem montada no RegemCast.');
    expect(TOOLS.mensagem_pausar!.undo).toBeUndefined();
  });

  it('a fase e a versão: no rascunho, o plano que muda é outra versão; depois do disparo, a fila que anda não é "alguém mexeu"', () => {
    expect(['rascunho', 'agendada', 'enviando', 'pausada', 'concluida', 'cancelada', 'outra', null].map(faseDaMensagem)).toEqual(['rascunho', 'andamento', 'andamento', 'pausada', 'fim', 'fim', 'fim', 'fim']);
    const v = versaoDaMensagem(estado());
    expect(v).toBeGreaterThan(0);
    expect(Number.isSafeInteger(v)).toBe(true);
    expect(versaoDaMensagem(estado())).toBe(v);
    // No rascunho: a confirmação, as pessoas, o custo ou o "pode disparar" mudam a versão.
    for (const outro of [{ confirmacao: 'outra-confirmacao-0123456789abcd' }, { pessoas: 430 }, { custo_centavos: 13_760 }, { pode_disparar: false, confirmacao: null }]) expect(versaoDaMensagem(estado(outro)), JSON.stringify(outro)).not.toBe(v);
    // O nome ou o que já foi gasto no mês não mudam o plano por si (se mudarem o plano, a confirmação muda junto).
    expect(versaoDaMensagem(estado({ nome: 'Outro nome' }))).toBe(v);
    // Em andamento: agendada e enviando são a mesma fase, e a fila andando não muda a versão.
    const andando = versaoDaMensagem(estado({ situacao: 'enviando', confirmacao: null, pode_disparar: false }));
    expect(versaoDaMensagem(estado({ situacao: 'agendada', confirmacao: null, pode_disparar: false }))).toBe(andando);
    expect(versaoDaMensagem(estado({ situacao: 'enviando', confirmacao: null, pode_disparar: false, pessoas: 12, enviadas: 400 }))).toBe(andando);
    expect(new Set([v, andando, versaoDaMensagem(estado({ situacao: 'pausada' })), versaoDaMensagem(estado({ situacao: 'concluida' }))]).size).toBe(4);
    // Concluída e cancelada são fim: nenhuma das duas se pausa.
    expect(versaoDaMensagem(estado({ situacao: 'cancelada' }))).toBe(versaoDaMensagem(estado({ situacao: 'concluida' })));
  });

  it('o que precisa acontecer no RegemCast: disparar o rascunho, pausar o que está saindo, ou nada', () => {
    const quer = (situacao: string) => ({ ...estado(), situacao });
    expect(mudancaPedida(estado(), quer('enviando'))).toEqual({ tipo: 'disparar' });
    // Já saiu (a tentativa anterior caiu depois de o RegemCast aceitar): nada a fazer.
    for (const situacao of ['agendada', 'enviando', 'concluida']) expect(mudancaPedida(estado({ situacao }), quer('enviando')), situacao).toEqual({ tipo: 'nada' });
    expect(mudancaPedida(estado({ situacao: 'pausada' }), quer('enviando'))).toMatchObject({ tipo: 'invalida', motivo: expect.stringContaining('Quem retoma é uma pessoa, no RegemCast') });
    expect(mudancaPedida(estado({ situacao: 'cancelada' }), quer('enviando'))).toMatchObject({ tipo: 'invalida', motivo: expect.stringContaining('cancelada') });
    for (const situacao of ['agendada', 'enviando']) expect(mudancaPedida(estado({ situacao }), quer('pausada')), situacao).toEqual({ tipo: 'pausar' });
    expect(mudancaPedida(estado({ situacao: 'pausada' }), quer('pausada'))).toEqual({ tipo: 'nada' });
    expect(mudancaPedida(estado(), quer('pausada'))).toMatchObject({ tipo: 'invalida' });
    expect(mudancaPedida(estado({ situacao: 'concluida' }), quer('pausada'))).toMatchObject({ tipo: 'invalida' });
    // O Liame não devolve uma mensagem ao rascunho, não retoma e não mexe em outra campanha.
    expect(mudancaPedida(estado({ situacao: 'enviando' }), quer('rascunho'))).toMatchObject({ tipo: 'invalida', motivo: 'Pelo Liame, uma mensagem só é enviada ou pausada.' });
    expect(mudancaPedida(estado(), { ...quer('enviando'), id: '0199f1aa-9999-7333-8444-555566667777' })).toEqual({ tipo: 'invalida', motivo: 'O pedido não é desta mensagem.' });
    expect(mudancaPedida(estado(), { tipo: 'campanha', id: CAMPANHA, situacao: 'enviando' })).toEqual({ tipo: 'invalida', motivo: 'O pedido não é desta mensagem.' });
  });

  it('o plano do RegemCast vira o estado, só com números e frases; o recurso é `mensagem:<id>`; e a recusa do RegemCast chega com a frase dele', () => {
    const plano: PlanoDoDisparoRegemcast = {
      campanha: {
        id: CAMPANHA,
        nome: 'Sexta em dobro',
        situacao: 'rascunho',
        pausaMotivo: null,
        modelo: 'promo_sexta_v2',
        categoria: 'marketing',
        publico: 'Quem pediu nos últimos 30 dias',
        destinatarios: 412,
        naFila: 412,
        enviadas: 0,
        entregues: 0,
        lidas: 0,
        falhas: 0,
        responderam: 0,
        criadaEm: '2026-09-30T12:12:00.000Z',
        iniciadaEm: null,
        concluidaEm: null,
      },
      custo: { moeda: 'BRL', gastoCentavos: 0, aSairCentavos: 13_184, linhas: [], avisos: [] },
      orcamento: { definido: true, periodos: [{ periodo: 'mes', rotulo: 'Outubro', tetoCentavos: 30_000, gastoCentavos: 12_736, texto: 'R$ 127,36 de R$ 300,00 neste mês', sinal: 'ok' }], aviso: null },
      podeDisparar: true,
      impedimentos: [],
      confirmacao: CONFIRMACAO,
    };
    expect(estadoDoPlano(plano)).toEqual(estado());
    // Sem preço na conta: o custo fica nulo, e não zero.
    expect(estadoDoPlano({ ...plano, custo: null })).toMatchObject({ moeda: null, custo_centavos: null });

    expect(mensagemDoRecurso(`mensagem:${CAMPANHA}`)).toBe(CAMPANHA);
    expect(mensagemDoRecurso(`mensagem:${CAMPANHA.toUpperCase()}`)).toBe(CAMPANHA);
    for (const torto of ['campanha:123', `campanha:${CAMPANHA}`, 'mensagem:123', 'mensagem:', `mensagem:${CAMPANHA}/../x`, CAMPANHA]) expect(mensagemDoRecurso(torto), torto).toBeNull();

    const definitivo = new ErroConector('definitivo', 'regemcast', 'campanha_disparar: O plano mudou desde a confirmação. Peça um plano novo com campanha_disparo_planejar.');
    expect(recusaDoRegemcast(definitivo, 'disparo')).toBe('O RegemCast recusou o envio: O plano mudou desde a confirmação. Peça um plano novo com campanha_disparo_planejar. Nada foi enviado.');
    expect(recusaDoRegemcast(definitivo, 'leitura')).toContain('O RegemCast não deixou ler o plano do envio');
    expect(recusaDoRegemcast(new ErroConector('definitivo', 'regemcast', 'campanha_pausar: A campanha não está em andamento.'), 'pausa')).toBe('O RegemCast não pausou o envio: A campanha não está em andamento.');
    expect(recusaDoRegemcast(new ErroConector('autenticacao', 'regemcast', 'x'), 'disparo')).toContain('Conecte o RegemCast de novo');
    expect(recusaDoRegemcast(new ErroConector('permissao', 'regemcast', 'x'), 'disparo')).toContain('não inclui enviar mensagens');
    // O que é passageiro não é recusa: sobe, e quem executa adia.
    for (const tipo of ['transitorio', 'limite', 'circuito_aberto'] as const) expect(recusaDoRegemcast(new ErroConector(tipo, 'regemcast', 'x'), 'disparo'), tipo).toBeNull();
    expect(recusaDoRegemcast(new Error('defeito nosso'), 'disparo')).toBeNull();
  });

  it('D-A5-11: a política da distribuição (versão 5) manda esperar a aprovação de uma pessoa, peça quem pedir; enviar e pausar', () => {
    expect(PLATFORM_POLICY.version).toBe(5);
    const proposta = (action: string, actor: 'human' | 'agent') =>
      ActionProposal.parse({
        tool: action === 'mensagem.disparar' ? 'mensagem_disparar' : 'mensagem_pausar',
        action,
        provider: 'regemcast',
        account_id: 'a',
        risk_level: action === 'mensagem.disparar' ? 'R3' : 'R1',
        budget_impact: action === 'mensagem.disparar' ? 'none' : 'decrease',
        value_micros: null,
        current_value_micros: null,
        actor,
      });
    for (const action of ['mensagem.disparar', 'mensagem.pausar']) {
      for (const actor of ['human', 'agent'] as const) {
        expect(chooseMode([PLATFORM_POLICY], proposta(action, actor)), `${action} ${actor}`).toEqual({ mode: 'APPROVAL', source: 'platform', version: 5 });
      }
    }
    // Sábado, 26/09/2026, 15:00 em São Paulo.
    const em = { at: new Date('2026-09-26T18:00:00Z'), timezone: 'America/Sao_Paulo' };
    expect(evaluatePolicy([PLATFORM_POLICY], proposta('mensagem.disparar', 'human'), em)).toMatchObject({ allowed: true, mode: 'APPROVAL', violations: [], versions: ['plataforma@5'] });
    // A regra mais específica de uma marca venceria a da distribuição no modo: por isso a trava também está na ferramenta.
    const daMarca = { source: 'brand' as const, version: 1, document: { rules: [{ type: 'autonomy' as const, action: 'mensagem.disparar', provider: 'regemcast', mode: 'AUTO' as const }] } };
    expect(chooseMode([PLATFORM_POLICY, daMarca], proposta('mensagem.disparar', 'human')).mode).toBe('AUTO');
    expect(TOOLS.mensagem_disparar!.alwaysApproval).toBe(true);
  });
});
