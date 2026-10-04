import { TEAM_MEMBERS } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { WORKFLOW_DA_REVISAO, WORKFLOW_DO_AVISO, WORKFLOW_DOS_RESULTADOS } from '../src/ai/explicar/explicar.service.js';
import { WORKFLOW as WORKFLOW_DA_CONVERSA } from '../src/conversa/conversa.service.js';
import { EQUIPE, MEMBROS } from '../src/equipe/membros.js';
import { type ContagensDoMes, type FatosDoMembro, numerosDoMembro, situacaoDoMembro } from '../src/equipe/numeros.js';
import { WORKFLOW as WORKFLOW_DO_ESTRATEGISTA } from '../src/worker/estrategista.service.js';
import { WORKFLOW as WORKFLOW_DO_PESQUISADOR } from '../src/worker/pesquisa.service.js';

// A3 · I13b: Sua equipe. A situação de cada membro vem de quatro chaves (a empresa, o plano, as flags e a parada);
// o que ele fez no mês sai das contagens do banco; os fluxos de IA de cada um são os que os serviços gravam.

const tudoLigado: FatosDoMembro = { pausado: false, peloPlano: true, ia: true, sombra: true, parada: false };
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
};

describe('Sua equipe (A3, I13b)', () => {
  it('os membros são os do contrato, e os fluxos de IA de cada um são os que os serviços gravam', () => {
    expect([...MEMBROS]).toEqual([...TEAM_MEMBERS]);
    expect(EQUIPE.lia.fluxos).toEqual([WORKFLOW_DA_CONVERSA]);
    expect(EQUIPE.analista.fluxos).toEqual([WORKFLOW_DOS_RESULTADOS, WORKFLOW_DO_AVISO]);
    expect(EQUIPE.relatorios.fluxos).toEqual([WORKFLOW_DA_REVISAO]);
    expect(EQUIPE.estrategista.fluxos).toEqual([WORKFLOW_DO_ESTRATEGISTA]);
    expect(EQUIPE.pesquisador.fluxos).toEqual([WORKFLOW_DO_PESQUISADOR]);
    expect(EQUIPE.compliance).toMatchObject({ kind: 'regra', desligavel: false, fluxos: [] });
    expect(MEMBROS.filter((m) => EQUIPE[m].kind === 'ia')).toEqual(['lia', 'analista', 'estrategista', 'pesquisador']);
    for (const m of MEMBROS) expect(EQUIPE[m].funcionario?.key ?? m).toBe(m);
  });

  it('a situação: desligado pela empresa pesa mais; fora do plano; a IA e a parada só valem para quem usa IA; a sombra', () => {
    const s = (m: (typeof MEMBROS)[number], f: Partial<FatosDoMembro>) => situacaoDoMembro(EQUIPE[m], { ...tudoLigado, ...f });
    expect(MEMBROS.map((m) => s(m, {}))).toEqual(['ativo', 'ativo', 'ativo', 'ativo', 'ativo', 'ativo', 'sombra']);
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
    ]);
    // A parada trava a IA e as ações: quem trabalha por regra segue (a revisão sai com o resumo do sistema).
    expect(MEMBROS.map((m) => s(m, { parada: true }))).toEqual(['parado', 'parado', 'ativo', 'ativo', 'parado', 'parado', 'sombra']);
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
      ]),
      entreguesPorFluxo: new Map([
        [WORKFLOW_DA_CONVERSA, 61],
        [WORKFLOW_DOS_RESULTADOS, 40],
        [WORKFLOW_DO_AVISO, 12],
        [WORKFLOW_DA_REVISAO, 1],
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
      ]),
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
    // Sem nada no mês, tudo zero (e nada de buraco na lista).
    expect(numerosDoMembro(EQUIPE.lia, vazio).map((x) => x.value)).toEqual(['0', '0', '0', '0', '0']);
    expect(numerosDoMembro(EQUIPE.compliance, vazio).map((x) => `${x.key}=${x.value}`)).toEqual(['textos_conferidos=0', 'textos_barrados=0']);
  });
});
