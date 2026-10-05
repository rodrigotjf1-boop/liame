import type { ActionProposal } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import type { EstadoDoObjeto } from '../src/actions/meta-anuncios.js';
import { TOOLS } from '../src/actions/tools.js';
import { evaluatePolicy, PLATFORM_POLICY } from '../src/policy/engine.js';
import {
  alvoDaRecomendacao,
  direcaoDaRecomendacao,
  motivoDoProblema,
  pedidoDaRecomendacao,
  type RecomendacaoParaPedir,
  recursoDaCampanha,
  verbaRecomendada,
} from '../src/sombra/pedido.js';
import { LIMIARES_SOMBRA } from '../src/sombra/regras.js';

// A4 · X3: o pedido que nasce de uma recomendação (conta pura). A verba recomendada é arredondada para a menor unidade
// da moeda sem passar do percentual, para o pedido caber no limite por pedido da política; e o pedido só fica ligado à
// recomendação quando é da mesma conta, da mesma campanha e vai na mesma direção.

const REAL = 1_000_000n;
const CONTA = '0192f0c4-7e3a-7c2e-9d1a-1b2c3d4e5f60';
const rec = (over: Partial<RecomendacaoParaPedir> = {}): RecomendacaoParaPedir => ({
  tool: 'orcamento_reduzir',
  provider: 'meta_ads',
  campanhaExterna: '120210000000001',
  verbaDiariaMicros: 30n * REAL,
  percent: 10,
  moeda: 'BRL',
  ...over,
});
const campanha = (verba: bigint): EstadoDoObjeto => ({
  tipo: 'campanha',
  id: '120210000000001',
  nome: 'Delivery noite',
  status: 'ativo',
  status_efetivo: 'ACTIVE',
  daily_budget_micros: Number(verba),
  lifetime_budget_micros: null,
  moeda: 'BRL',
});

describe('o pedido que nasce de uma recomendação (A4, X3)', () => {
  it('a verba recomendada: o percentual sobre a verba de agora, na menor unidade da moeda', () => {
    expect(verbaRecomendada(30n * REAL, 10, 'reduzir', 'BRL')).toBe(27n * REAL);
    expect(verbaRecomendada(30n * REAL, 10, 'aumentar', 'BRL')).toBe(33n * REAL);
    // Com fração de centavo, arredonda para o lado da verba de agora: nunca passa do percentual.
    expect(verbaRecomendada(30_050_000n, 10, 'reduzir', 'BRL')).toBe(27_050_000n);
    expect(verbaRecomendada(30_050_000n, 10, 'aumentar', 'BRL')).toBe(33_050_000n);
    // Moeda sem casas decimais: a menor unidade é a própria unidade.
    expect(verbaRecomendada(1_005n * REAL, 10, 'reduzir', 'JPY')).toBe(905n * REAL);
    expect(verbaRecomendada(1_005n * REAL, 10, 'aumentar', 'JPY')).toBe(1_105n * REAL);
    // Sem moeda conhecida, vale a conta em centavos.
    expect(verbaRecomendada(30n * REAL, 10, 'reduzir', null)).toBe(27n * REAL);
  });

  it('nada a pedir: sem verba, percentual fora de 1 a 99, abaixo do mínimo ou sem mudança depois do arredondamento', () => {
    expect(verbaRecomendada(null, 10, 'reduzir', 'BRL')).toBeNull();
    expect(verbaRecomendada(0n, 10, 'reduzir', 'BRL')).toBeNull();
    for (const percent of [null, 0, 100, -10, 2.5]) expect(verbaRecomendada(30n * REAL, percent, 'reduzir', 'BRL')).toBeNull();
    // R$ 1,05 menos 10% daria R$ 0,95: abaixo do mínimo que um pedido aceita.
    expect(verbaRecomendada(1_050_000n, 10, 'reduzir', 'BRL')).toBeNull();
    expect(verbaRecomendada(1_050_000n, 10, 'aumentar', 'BRL')).toBe(1_150_000n);
    // 1% de 10 ienes não chega a 1 iene: o arredondamento devolve a verba de agora, e não há pedido.
    expect(verbaRecomendada(10n * REAL, 1, 'aumentar', 'JPY')).toBeNull();
    expect(verbaRecomendada(10n * REAL, 1, 'reduzir', 'JPY')).toBeNull();
  });

  it('a mudança nunca passa do percentual, em nenhuma verba (o pedido cabe no limite por pedido da política)', () => {
    const passo = LIMIARES_SOMBRA.passoDaVerba;
    for (let centavos = 150n; centavos <= 40_000n; centavos += 37n) {
      const atual = centavos * 10_000n;
      for (const sentido of ['reduzir', 'aumentar'] as const) {
        const nova = verbaRecomendada(atual, passo, sentido, 'BRL')!;
        const diferenca = sentido === 'reduzir' ? atual - nova : nova - atual;
        expect(nova % 10_000n, `${atual} ${sentido}`).toBe(0n);
        expect(diferenca > 0n && diferenca * 100n <= atual * BigInt(passo), `${atual} ${sentido} deu ${nova}`).toBe(true);
        // E fica a menos de um centavo do percentual exato.
        expect(atual * BigInt(passo) - diferenca * 100n < 10_000n * 100n).toBe(true);
      }
    }
  });

  it('o pedido de cada recomendação: a ferramenta, a campanha como recurso e os parâmetros', () => {
    expect(pedidoDaRecomendacao(rec({ tool: 'campanha_pausar', percent: null }))).toEqual({ tool: 'campanha_pausar', resource_id: 'campanha:120210000000001', params: {} });
    expect(pedidoDaRecomendacao(rec())).toEqual({ tool: 'orcamento_ajustar', resource_id: 'campanha:120210000000001', params: { daily_budget_micros: 27_000_000 } });
    expect(pedidoDaRecomendacao(rec({ tool: 'orcamento_aumentar' }))).toEqual({ tool: 'orcamento_ajustar', resource_id: 'campanha:120210000000001', params: { daily_budget_micros: 33_000_000 } });
    // Pausar não depende da verba; mudar a verba, sim (a campanha com a verba no conjunto não tem o que mudar aqui).
    expect(pedidoDaRecomendacao(rec({ tool: 'campanha_pausar', percent: null, verbaDiariaMicros: null }))).not.toBeNull();
    expect(pedidoDaRecomendacao(rec({ verbaDiariaMicros: null }))).toBeNull();
    expect(pedidoDaRecomendacao(rec({ percent: null }))).toBeNull();
  });

  it('só na plataforma em que o Liame muda campanha, e só com o id da campanha na plataforma', () => {
    expect(pedidoDaRecomendacao(rec({ provider: 'google_ads' }))).toBeNull();
    expect(pedidoDaRecomendacao(rec({ provider: 'google_ads', tool: 'campanha_pausar' }))).toBeNull();
    expect(recursoDaCampanha('120210000000001')).toBe('campanha:120210000000001');
    for (const id of ['', 'c1', '12 3', '1'.repeat(26), '123/../456']) {
      expect(recursoDaCampanha(id)).toBeNull();
      expect(pedidoDaRecomendacao(rec({ campanhaExterna: id }))).toBeNull();
    }
  });

  it('o pedido montado passa pela ferramenta e pela política da distribuição, e vai na direção da recomendação', () => {
    for (const verba of [30n * REAL, 30_050_000n, 199_990_000n, 12_340_000n]) {
      for (const tool of ['orcamento_reduzir', 'orcamento_aumentar'] as const) {
        const pedido = pedidoDaRecomendacao(rec({ tool, verbaDiariaMicros: verba, percent: LIMIARES_SOMBRA.passoDaVerba }))!;
        const ferramenta = TOOLS[pedido.tool]!;
        const plano = ferramenta.plan(campanha(verba), ferramenta.params.parse(pedido.params));
        expect(direcaoDaRecomendacao(tool, plano.action)).toBeNull();
        const proposta: ActionProposal = {
          tool: ferramenta.name,
          action: plano.action,
          brand_id: null,
          provider: 'meta_ads',
          account_id: CONTA,
          risk_level: ferramenta.risk,
          budget_impact: plano.budgetImpact,
          value_micros: plano.valueMicros,
          current_value_micros: plano.currentValueMicros,
          categories: [],
          recent_count: 0,
          actor: 'human',
        };
        const decisao = evaluatePolicy([PLATFORM_POLICY], proposta, { at: new Date('2026-10-05T15:00:00Z'), timezone: 'America/Sao_Paulo' });
        expect(decisao.violations, `${tool} em ${verba}`).toEqual([]);
        expect(decisao.mode).toBe('APPROVAL');
      }
    }
    const pausa = pedidoDaRecomendacao(rec({ tool: 'campanha_pausar', percent: null }))!;
    expect(direcaoDaRecomendacao('campanha_pausar', TOOLS[pausa.tool]!.plan(campanha(30n * REAL), {}).action)).toBeNull();
  });

  it('o alvo do pedido tem de ser o da recomendação: em aberto, na mesma conta e na mesma campanha', () => {
    const r = { tool: 'orcamento_reduzir' as const, status: 'aberta', provider: 'meta_ads', connectedAccountId: CONTA, campanhaExterna: '120210000000001' };
    const pedido = { provider: 'meta_ads', accountId: CONTA, resourceId: 'campanha:120210000000001' };
    expect(alvoDaRecomendacao(r, pedido)).toBeNull();
    for (const status of ['avaliada', 'descartada']) {
      expect(alvoDaRecomendacao({ ...r, status }, pedido)).toEqual({
        codigo: 'recomendacao-encerrada',
        detalhe: 'Esta recomendação já foi avaliada ou saiu da lista. Se a mudança ainda fizer sentido, peça sem ela.',
      });
    }
    const outra = { codigo: 'recomendacao-nao-confere', detalhe: 'O pedido não é da campanha desta recomendação.' };
    expect(alvoDaRecomendacao(r, { ...pedido, resourceId: 'campanha:120210000000002' })).toEqual(outra);
    // O conjunto e o anúncio da campanha não são a campanha.
    expect(alvoDaRecomendacao(r, { ...pedido, resourceId: 'conjunto:120210000000001' })).toEqual(outra);
    expect(alvoDaRecomendacao(r, { ...pedido, accountId: '0192f0c4-7e3a-7c2e-9d1a-1b2c3d4e5f61' })).toEqual(outra);
    expect(alvoDaRecomendacao(r, { ...pedido, provider: 'sandbox' })).toEqual(outra);
    // A campanha sem id de plataforma que sirva de recurso não confere com pedido nenhum.
    expect(alvoDaRecomendacao({ ...r, campanhaExterna: 'c1' }, { ...pedido, resourceId: 'campanha:c1' })).toEqual(outra);
  });

  it('modo Aprovação: o problema que barrou o pedido vira o motivo que fica na recomendação', () => {
    // O código e o texto do Action Service, como estão.
    expect(motivoDoProblema({ code: 'acao-duplicada', detail: 'Já há um pedido ativo desta ferramenta para este recurso.' })).toEqual({
      codigo: 'acao-duplicada',
      detalhe: 'Já há um pedido ativo desta ferramenta para este recurso.',
    });
    // Na recusa da política, o motivo leva a primeira regra que negou (é ela que diz o que fazer); nos outros, não.
    const regras = [{ message: 'O valor R$ 220,00 passa do teto de R$ 150,00 por ação.' }, { message: 'A variação de 13,33% passa do máximo de 10%.' }];
    expect(motivoDoProblema({ code: 'politica-negou', detail: 'Esta ação fere uma regra da política.', errors: regras }).detalhe).toBe(
      'Esta ação fere uma regra da política. O valor R$ 220,00 passa do teto de R$ 150,00 por ação.',
    );
    expect(motivoDoProblema({ code: 'plano-recusado', detail: 'A campanha já está em pausa.', errors: regras }).detalhe).toBe('A campanha já está em pausa.');
    expect(motivoDoProblema({ code: 'politica-negou', detail: 'Esta ação fere uma regra da política.', errors: [] }).detalhe).toBe('Esta ação fere uma regra da política.');
    // Cabe na coluna: até 300 caracteres (com reticências no corte), nunca vazio, e o código no formato da coluna.
    const longo = motivoDoProblema({ code: 'plataforma-recusou', detail: `A Meta não deixou ler o objeto: ${'x'.repeat(400)}` });
    expect([longo.detalhe.length, longo.detalhe.endsWith('…')]).toEqual([300, true]);
    expect(motivoDoProblema({ code: 'conflito', detail: '   ' }).detalhe).toBe('O pedido não pôde ser feito.');
    for (const code of ['Erro Estranho', '', '9começa-com-número', 'x', 'a'.repeat(62)]) expect(motivoDoProblema({ code, detail: 'Falhou.' }).codigo).toBe('problema');
    for (const code of ['teto-nao-definido', 'sem-responsavel', 'ab']) expect(motivoDoProblema({ code, detail: 'Falhou.' }).codigo).toBe(code);
  });

  it('a direção: o pedido faz o que a recomendação diz (o valor pode ser outro)', () => {
    expect(direcaoDaRecomendacao('orcamento_reduzir', 'orcamento.reduzir')).toBeNull();
    expect(direcaoDaRecomendacao('orcamento_aumentar', 'orcamento.aumentar')).toBeNull();
    expect(direcaoDaRecomendacao('campanha_pausar', 'campanha.pausar')).toBeNull();
    expect(direcaoDaRecomendacao('orcamento_reduzir', 'orcamento.aumentar')).toEqual({
      codigo: 'recomendacao-nao-confere',
      detalhe: 'A recomendação é de reduzir a verba, e este pedido faz outra coisa. Peça sem ligar à recomendação.',
    });
    expect(direcaoDaRecomendacao('orcamento_aumentar', 'orcamento.reduzir')?.detalhe).toContain('aumentar a verba');
    // Pausar a campanha não é reduzir a verba, nem o contrário; retomar não é de recomendação nenhuma.
    expect(direcaoDaRecomendacao('campanha_pausar', 'orcamento.reduzir')?.detalhe).toContain('pausar a campanha');
    expect(direcaoDaRecomendacao('orcamento_reduzir', 'campanha.pausar')?.codigo).toBe('recomendacao-nao-confere');
    expect(direcaoDaRecomendacao('campanha_pausar', 'campanha.retomar')?.codigo).toBe('recomendacao-nao-confere');
  });
});
