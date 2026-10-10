import { TEAM_MEMBERS } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_DO_CRIATIVO } from '../src/ai/criativo/prompt.js';
import { WORKFLOW_DO_CRM } from '../src/ai/crm/prompt.js';
import { WORKFLOW_DA_REVISAO, WORKFLOW_DO_AVISO, WORKFLOW_DOS_RESULTADOS } from '../src/ai/explicar/explicar.service.js';
import { WORKFLOW_DO_REVISOR } from '../src/ai/revisor/prompt.js';
import { WORKFLOW as WORKFLOW_DA_CONVERSA } from '../src/conversa/conversa.service.js';
import { EQUIPE, MEMBROS } from '../src/equipe/membros.js';
import { agoraDoCrm, type ContagensDoMes, type FatosDoMembro, numerosDoMembro, type PropostaEmAndamento, situacaoDoMembro } from '../src/equipe/numeros.js';
import { WORKFLOW as WORKFLOW_DO_ESTRATEGISTA } from '../src/worker/estrategista.service.js';
import { WORKFLOW as WORKFLOW_DO_PESQUISADOR } from '../src/worker/pesquisa.service.js';

// A3 · I13b: Sua equipe. A situação de cada membro vem de quatro chaves (a empresa, o plano, as flags e a parada);
// o que ele fez no mês sai das contagens do banco; os fluxos de IA de cada um são os que os serviços gravam.

const tudoLigado: FatosDoMembro = { pausado: false, peloPlano: true, ia: true, sombra: true, criativo: true, crm: true, parada: false };
const semPecas = { pedidos: 0, escritas: 0, aprovadas: 0, recusadas: 0, refeitas: 0, hoje: 0, esperando: 0, barradas: 0 };
const semMensagens = { propostas: 0, enviadas: 0, recusadas: 0, esperando: 0, rascunhos: 0, pedidosComCupom: 0, caixaComCupomMicros: 0n };
const vazio: ContagensDoMes = {
  respostasPorFluxo: new Map(),
  entreguesPorFluxo: new Map(),
  retornoPorFluxo: new Map(),
  demandasDaLia: 0,
  revisoes: 0,
  revisoesComLeituraDaIa: 0,
  planosAprovados: 0,
  planosRecusados: 0,
  planosEsperando: 0,
  emPreparo: 0,
  paginasLidas: 0,
  paginasRecusadas: 0,
  sugestoesDoPesquisador: 0,
  recomendacoes: 0,
  comparaveis: 0,
  mesmaDirecao: 0,
  arrependimentoMicros: 0n,
  recusasPorMembro: new Map(),
  pecas: semPecas,
  mensagens: semMensagens,
};

describe('Sua equipe (A3, I13b)', () => {
  it('os membros são os do contrato, e os fluxos de IA de cada um são os que os serviços gravam', () => {
    expect([...MEMBROS]).toEqual([...TEAM_MEMBERS]);
    expect(EQUIPE.lia.fluxos).toEqual([WORKFLOW_DA_CONVERSA]);
    expect(EQUIPE.analista.fluxos).toEqual([WORKFLOW_DOS_RESULTADOS, WORKFLOW_DO_AVISO]);
    expect(EQUIPE.relatorios.fluxos).toEqual([WORKFLOW_DA_REVISAO]);
    expect(EQUIPE.estrategista.fluxos).toEqual([WORKFLOW_DO_ESTRATEGISTA]);
    expect(EQUIPE.pesquisador.fluxos).toEqual([WORKFLOW_DO_PESQUISADOR]);
    // O Compliance segue por regra e não desliga; o fluxo dele é o do revisor de IA (o custo, quando a empresa o tem).
    expect(EQUIPE.compliance).toMatchObject({ kind: 'regra', desligavel: false, fluxos: [WORKFLOW_DO_REVISOR] });
    expect(MEMBROS.filter((m) => EQUIPE[m].kind === 'ia')).toEqual(['lia', 'analista', 'estrategista', 'pesquisador', 'criativo', 'crm']);
    // O Criativo (A4; P12): o fluxo é o que o worker das peças grava, e a empresa pode desligar.
    expect(EQUIPE.criativo).toMatchObject({ kind: 'ia', desligavel: true, fluxos: [WORKFLOW_DO_CRIATIVO] });
    // O CRM e mensageria (A5; P16): o fluxo é o das chamadas que escrevem a mensagem, e a empresa pode desligar.
    expect(EQUIPE.crm).toMatchObject({ kind: 'ia', desligavel: true, fluxos: [WORKFLOW_DO_CRM] });
    for (const m of MEMBROS) expect(EQUIPE[m].funcionario?.key ?? m).toBe(m);
  });

  it('a situação: desligado pela empresa pesa mais; fora do plano; a IA e a parada só valem para quem usa IA; a sombra', () => {
    const s = (m: (typeof MEMBROS)[number], f: Partial<FatosDoMembro>) => situacaoDoMembro(EQUIPE[m], { ...tudoLigado, ...f });
    expect(MEMBROS.map((m) => s(m, {}))).toEqual(['ativo', 'ativo', 'ativo', 'ativo', 'ativo', 'ativo', 'sombra', 'ativo', 'ativo']);
    expect(s('lia', { pausado: true, peloPlano: false, ia: false })).toBe('desligado');
    expect(s('analista', { peloPlano: false })).toBe('desligado_pela_liame');
    expect(MEMBROS.map((m) => s(m, { ia: false }))).toEqual([
      'desligado_pela_liame',
      'desligado_pela_liame',
      'ativo',
      'ativo',
      'desligado_pela_liame',
      'desligado_pela_liame',
      'sombra',
      'desligado_pela_liame',
      'desligado_pela_liame',
    ]);
    // A parada trava a IA e as ações: quem trabalha por regra segue (a revisão sai com o resumo do sistema).
    expect(MEMBROS.map((m) => s(m, { parada: true }))).toEqual(['parado', 'parado', 'ativo', 'ativo', 'parado', 'parado', 'sombra', 'parado', 'parado']);
    // O Criativo precisa da flag dele além da IA: sem ela, só ele fica desligado pela Liame; a empresa desligar pesa mais.
    expect(MEMBROS.filter((m) => s(m, { criativo: false }) !== s(m, {}))).toEqual(['criativo']);
    expect(s('criativo', { criativo: false })).toBe('desligado_pela_liame');
    expect(s('criativo', { criativo: false, pausado: true })).toBe('desligado');
    expect(s('criativo', { criativo: false, parada: true })).toBe('desligado_pela_liame');
    // O CRM e mensageria precisa das flags dele (a dele e as do envio de mensagens) além da IA: sem elas, só ele fica
    // desligado pela Liame ("ainda não ligado"); a empresa desligar pesa mais.
    expect(MEMBROS.filter((m) => s(m, { crm: false }) !== s(m, {}))).toEqual(['crm']);
    expect(s('crm', { crm: false })).toBe('desligado_pela_liame');
    expect(s('crm', { crm: false, pausado: true })).toBe('desligado');
    expect(s('crm', { ia: false })).toBe('desligado_pela_liame');
    expect(s('trafego', { sombra: false })).toBe('desligado_pela_liame');
    expect(s('trafego', { pausado: true })).toBe('desligado');
  });

  it('o que cada um fez no mês, com as chaves do contrato', () => {
    const c: ContagensDoMes = {
      ...vazio,
      // O que chegou à conferência (a chamada que respondeu, uma por pedido) e, disso, o que chegou à pessoa: a
      // diferença são as respostas que a conferência retirou (5 da LIA, 5 do Analista e 1 da leitura da revisão).
      respostasPorFluxo: new Map([
        [WORKFLOW_DA_CONVERSA, 66],
        [WORKFLOW_DOS_RESULTADOS, 44],
        [WORKFLOW_DO_AVISO, 13],
        [WORKFLOW_DA_REVISAO, 2],
        // Os pareceres do revisor de IA são chamadas do Compliance, não textos para conferir.
        [WORKFLOW_DO_REVISOR, 120],
      ]),
      entreguesPorFluxo: new Map([
        [WORKFLOW_DA_CONVERSA, 61],
        [WORKFLOW_DOS_RESULTADOS, 40],
        [WORKFLOW_DO_AVISO, 12],
        [WORKFLOW_DA_REVISAO, 1],
        [WORKFLOW_DO_REVISOR, 120],
      ]),
      retornoPorFluxo: new Map([
        [WORKFLOW_DA_CONVERSA, { fezSentido: 28, discordo: 5 }],
        [WORKFLOW_DOS_RESULTADOS, { fezSentido: 30, discordo: 2 }],
        [WORKFLOW_DO_AVISO, { fezSentido: 4, discordo: 1 }],
      ]),
      demandasDaLia: 2,
      revisoes: 4,
      revisoesComLeituraDaIa: 3,
      planosAprovados: 2,
      planosRecusados: 1,
      planosEsperando: 1,
      emPreparo: 1,
      paginasLidas: 3,
      paginasRecusadas: 1,
      sugestoesDoPesquisador: 2,
      recomendacoes: 26,
      comparaveis: 19,
      mesmaDirecao: 15,
      arrependimentoMicros: -41_200_000n,
      // O que a conferência recusou: 9 textos barrados pelo Compliance (de três funcionários) e 4 retirados por outro motivo.
      recusasPorMembro: new Map([
        ['lia', { doCompliance: 4, outras: 1 }],
        ['analista', { doCompliance: 3, outras: 2 }],
        ['relatorios', { doCompliance: 1, outras: 0 }],
        ['pesquisador', { doCompliance: 1, outras: 1 }],
        ['criativo', { doCompliance: 0, outras: 1 }],
      ]),
      // O Criativo: 2 pedidos atendidos, 5 peças no mês (2 aprovadas), 1 versão refeita, 3 de hoje; agora, 2 esperam e 1 está barrada.
      pecas: { pedidos: 2, escritas: 5, aprovadas: 2, recusadas: 0, refeitas: 1, hoje: 3, esperando: 2, barradas: 1 },
      // O CRM e mensageria: 2 mensagens propostas no mês (1 enviada), 1 esperando agora, 1 rascunho esperando o modelo, e
      // 12 pedidos com o cupom delas (R$ 540,00).
      mensagens: { propostas: 2, enviadas: 1, recusadas: 0, esperando: 1, rascunhos: 1, pedidosComCupom: 12, caixaComCupomMicros: 540_000_000n },
    };
    const ver = (m: (typeof MEMBROS)[number]) => Object.fromEntries(numerosDoMembro(EQUIPE[m], c).map((x) => [x.key, `${x.value} ${x.unit}`]));
    expect(ver('lia')).toEqual({ respostas: '61 qtd', fez_sentido: '28 qtd', discordo: '5 qtd', demandas: '2 qtd', retiradas_na_conferencia: '5 qtd' });
    // O Analista soma o Explicar dos resultados e o de um aviso; a leitura da revisão é do Relatórios.
    expect(ver('analista')).toEqual({ explicacoes: '52 qtd', fez_sentido: '34 qtd', discordo: '3 qtd', retiradas_na_conferencia: '5 qtd' });
    expect(ver('relatorios')).toEqual({ revisoes: '4 qtd', com_leitura_da_ia: '3 qtd', so_do_sistema: '1 qtd' });
    // D-A3-15: conferidos = todo texto de IA que chegou à conferência (as respostas atendidas de todos os fluxos,
    // entregues ou retiradas); barrados = os que uma regra de texto barrou, de qualquer funcionário (sem o texto, só a
    // contagem).
    expect(ver('compliance')).toEqual({ textos_conferidos: '125 qtd', textos_barrados: '9 qtd' });
    expect(ver('estrategista')).toEqual({ planos_aprovados: '2 qtd', planos_recusados: '1 qtd', planos_esperando: '1 qtd', em_preparo: '1 qtd', retiradas_na_conferencia: '0 qtd' });
    expect(ver('pesquisador')).toEqual({ paginas_lidas: '3 qtd', recusadas: '1 qtd', sugestoes: '2 qtd', retiradas_na_conferencia: '2 qtd' });
    expect(ver('trafego')).toEqual({ recomendacoes: '26 qtd', comparaveis: '19 qtd', mesma_direcao: '15 qtd', arrependimento: '-41200000 brl_micros' });
    expect(ver('criativo')).toEqual({
      pedidos: '2 qtd',
      pecas_escritas: '5 qtd',
      pecas_aprovadas: '2 qtd',
      pecas_recusadas: '0 qtd',
      versoes_refeitas: '1 qtd',
      pecas_hoje: '3 qtd',
      pecas_esperando: '2 qtd',
      pecas_barradas: '1 qtd',
      retiradas_na_conferencia: '1 qtd',
    });
    expect(numerosDoMembro(EQUIPE.criativo, vazio).every((x) => x.value === '0')).toBe(true);
    expect(ver('crm')).toEqual({
      mensagens_propostas: '2 qtd',
      mensagens_enviadas: '1 qtd',
      mensagens_recusadas: '0 qtd',
      mensagens_esperando: '1 qtd',
      rascunhos_esperando_o_modelo: '1 qtd',
      pedidos_com_cupom: '12 qtd',
      caixa_com_cupom: '540000000 brl_micros',
      retiradas_na_conferencia: '0 qtd',
    });
    expect(numerosDoMembro(EQUIPE.crm, vazio).every((x) => x.value === '0')).toBe(true);
    // Sem nada no mês, tudo zero (e nada de buraco na lista).
    expect(numerosDoMembro(EQUIPE.lia, vazio).map((x) => x.value)).toEqual(['0', '0', '0', '0', '0']);
    expect(numerosDoMembro(EQUIPE.compliance, vazio).map((x) => `${x.key}=${x.value}`)).toEqual(['textos_conferidos=0', 'textos_barrados=0']);
  });

  it('o CRM e mensageria agora (A5 · P16): o que ele tem em andamento e o que o segura, do que mais pesa ao que menos', () => {
    const OFERTA = 'Combo sexta: smash, batata e refri por R$ 34,90';
    const preparando: PropostaEmAndamento = { situacao: 'preparando', motivo: 'promocao', oferta: OFERTA, nome: null, pessoas: 412, situacaoDoModelo: null, abertaEm: '2026-10-09T12:00:00.000Z', rascunhoEm: null };
    const rascunho: PropostaEmAndamento = {
      situacao: 'rascunho',
      motivo: 'volte_a_pedir',
      oferta: null,
      nome: 'Volte a pedir',
      pessoas: 96,
      situacaoDoModelo: 'rascunho',
      abertaEm: '2026-10-08T12:00:00.000Z',
      rascunhoEm: '2026-10-08T12:05:00.000Z',
    };
    const agora = (over: Partial<Parameters<typeof agoraDoCrm>[0]> = {}) => agoraDoCrm({ ativo: true, semRegemcast: false, semOferta: false, emAndamento: [], veAsCampanhas: true, ...over });

    // Ligado, com tudo no lugar e nada em andamento: nada a dizer.
    expect(agora()).toEqual({ workingNow: false, inProgress: null, blockedBy: null });
    // Preparando: é trabalho em andamento, sem impedimento; a oferta, o motivo, as pessoas e desde quando.
    expect(agora({ emAndamento: [preparando] })).toEqual({ workingNow: true, inProgress: { subject: OFERTA, count: 412, by: null, since: preparando.abertaEm, kind: 'promocao' }, blockedBy: null });
    // O rascunho que ninguém enviou ainda para a Meta, e o que a Meta ainda analisa: o nome da mensagem e desde quando o rascunho nasceu.
    const esperando = { subject: 'Volte a pedir', count: 96, by: null, since: rascunho.rascunhoEm, kind: 'volte_a_pedir' };
    expect(agora({ emAndamento: [rascunho] })).toEqual({ workingNow: false, inProgress: esperando, blockedBy: 'modelo_sem_envio' });
    expect(agora({ emAndamento: [{ ...rascunho, situacaoDoModelo: null }] }).blockedBy).toBe('modelo_sem_envio');
    for (const daMeta of ['em análise', 'em recurso']) expect(agora({ emAndamento: [{ ...rascunho, situacaoDoModelo: daMeta }] }).blockedBy).toBe('modelo_em_analise');
    // Com as duas, o que ele prepara agora vem primeiro (em qualquer ordem da lista).
    expect(agora({ emAndamento: [rascunho, preparando] })).toMatchObject({ workingNow: true, inProgress: { kind: 'promocao' }, blockedBy: null });

    // Sem o RegemCast não há para quem propor: pesa mais que a proposta em andamento, que nem aparece.
    expect(agora({ semRegemcast: true, emAndamento: [preparando, rascunho] })).toEqual({ workingNow: false, inProgress: null, blockedBy: 'sem_regemcast' });
    // Minha marca sem oferta só é o impedimento quando nada está em andamento: o "volte a pedir" não precisa de oferta.
    expect(agora({ semOferta: true }).blockedBy).toBe('sem_oferta');
    expect(agora({ semOferta: true, emAndamento: [rascunho] }).blockedBy).toBe('modelo_sem_envio');
    expect(agora({ semOferta: true, emAndamento: [{ ...preparando, motivo: 'volte_a_pedir', oferta: null }] })).toMatchObject({ workingNow: true, blockedBy: null });

    // Quem não vê as campanhas não recebe a oferta nem o nome da mensagem; o resto fica.
    expect(agora({ veAsCampanhas: false, emAndamento: [preparando] }).inProgress).toEqual({ subject: null, count: 412, by: null, since: preparando.abertaEm, kind: 'promocao' });
    expect(agora({ veAsCampanhas: false, emAndamento: [rascunho] }).inProgress?.subject).toBeNull();
    // Desligado, não ligado ou parado: nada disso se diz.
    expect(agora({ ativo: false, semRegemcast: true, semOferta: true, emAndamento: [preparando, rascunho] })).toEqual({ workingNow: false, inProgress: null, blockedBy: null });
  });
});
