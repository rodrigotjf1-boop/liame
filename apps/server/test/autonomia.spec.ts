import type { PolicyDocument } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { chooseMode, evaluatePolicy, type LoadedPolicy, PLATFORM_POLICY } from '../src/policy/engine.js';
import { avisoDaSugestao } from '../src/results/sugestoes-da-sombra.js';
import {
  ACAO_DA_FERRAMENTA,
  comRegraDaConta,
  LIMIARES_DA_AUTONOMIA,
  modoDaAcao,
  mostraNaAtencao,
  portoesQuePassaram,
  propostaDaAcao,
  vezDaProposta,
} from '../src/sombra/autonomia.js';

// A3 · I13: a autonomia das ações da sombra. O modo vem do motor de políticas; a promoção troca uma regra da
// política da marca; o sistema propõe, retira e encerra pela regra pura; a recomendação em Sugerir vira aviso.

const CONTA = '0192f0c4-7e3a-7c2e-9d1a-1b2c3d4e5f60';
const MARCA = '0192f0c4-7e3a-7c2e-9d1a-1b2c3d4e5f61';
const alvo = { tool: 'orcamento_reduzir' as const, brandId: MARCA, provider: 'meta_ads', accountId: CONTA };
const politica = (source: 'tenant' | 'brand', version: number, rules: PolicyDocument['rules']): LoadedPolicy => ({ source, version, document: { rules } });
/** O `Intl` separa "R$" do número com espaço inquebrável. */
const nbsp = (s: string) => s.replaceAll('R$ ', `R$${String.fromCharCode(160)}`);

describe('autonomia das ações da sombra (A3, I13)', () => {
  it('cada ferramenta da sombra é uma ação da política, e a proposta para o motor não pede nada', () => {
    expect(ACAO_DA_FERRAMENTA).toEqual({ orcamento_reduzir: 'orcamento.reduzir', campanha_pausar: 'campanha.pausar', orcamento_aumentar: 'orcamento.aumentar' });
    expect(propostaDaAcao({ ...alvo, valorAtualMicros: 30_000_000, valorMicros: 24_000_000 })).toEqual({
      tool: 'orcamento_ajustar',
      action: 'orcamento.reduzir',
      brand_id: MARCA,
      provider: 'meta_ads',
      account_id: CONTA,
      risk_level: 'R3',
      budget_impact: 'decrease',
      value_micros: 24_000_000,
      current_value_micros: 30_000_000,
      categories: [],
      recent_count: 0,
    });
    expect(propostaDaAcao({ ...alvo, tool: 'campanha_pausar' })).toMatchObject({ tool: 'campanha_pausar', action: 'campanha.pausar', risk_level: 'R1', value_micros: null });
  });

  it('sem regra, Sombra; a regra da conta na marca decide; a da marca vence a larga da empresa; ESCALATE vence sempre', () => {
    expect(modoDaAcao([PLATFORM_POLICY], alvo)).toEqual({ mode: 'SHADOW', source: null, version: null });
    const promovida = politica('brand', 3, [{ type: 'autonomy', action: 'orcamento.reduzir', account: CONTA, mode: 'SUGGEST' }]);
    expect(modoDaAcao([PLATFORM_POLICY, promovida], alvo)).toEqual({ mode: 'SUGGEST', source: 'brand', version: 3 });
    // Outra conta não casa.
    expect(modoDaAcao([PLATFORM_POLICY, promovida], { ...alvo, accountId: MARCA }).mode).toBe('SHADOW');
    const larga = politica('tenant', 2, [{ type: 'autonomy', action: 'orcamento.*', mode: 'SUGGEST' }]);
    expect(modoDaAcao([PLATFORM_POLICY, larga], alvo)).toEqual({ mode: 'SUGGEST', source: 'tenant', version: 2 });
    const deVolta = politica('brand', 4, [{ type: 'autonomy', action: 'orcamento.reduzir', account: CONTA, mode: 'SHADOW' }]);
    expect(modoDaAcao([PLATFORM_POLICY, larga, deVolta], alvo)).toEqual({ mode: 'SHADOW', source: 'brand', version: 4 });
    const escala = politica('tenant', 5, [{ type: 'autonomy', action: 'orcamento.*', mode: 'ESCALATE' }]);
    expect(modoDaAcao([PLATFORM_POLICY, escala, promovida], alvo)).toEqual({ mode: 'ESCALATE', source: 'tenant', version: 5 });
  });

  it('o modo escolhido é o mesmo que a avaliação da política dá (a extração não mudou o motor)', () => {
    const politicas = [
      PLATFORM_POLICY,
      politica('tenant', 1, [{ type: 'autonomy', action: 'orcamento.*', mode: 'APPROVAL' }, { type: 'max_value', action: 'orcamento.*', max_micros: 1 }]),
      politica('brand', 1, [{ type: 'autonomy', action: 'orcamento.reduzir', account: CONTA, up_to_percent: 30, mode: 'LIMITED_AUTO' }]),
    ];
    for (const valor of [null, 24_000_000, 10_000_000]) {
      const p = propostaDaAcao({ ...alvo, valorAtualMicros: 30_000_000, valorMicros: valor });
      expect(evaluatePolicy(politicas, p, { at: new Date('2026-10-03T12:00:00Z'), timezone: 'America/Sao_Paulo' }).mode).toBe(chooseMode(politicas, p).mode);
    }
    // A regra com faixa de variação só casa quando a variação cabe nela.
    expect(chooseMode(politicas, propostaDaAcao({ ...alvo, valorAtualMicros: 30_000_000, valorMicros: 24_000_000 })).mode).toBe('LIMITED_AUTO');
    expect(chooseMode(politicas, propostaDaAcao(alvo)).mode).toBe('APPROVAL');
  });

  it('a promoção troca só a regra da ação na conta; as outras ficam, na mesma ordem', () => {
    expect(comRegraDaConta(null, { action: 'orcamento.reduzir', account: CONTA, mode: 'SUGGEST' })).toEqual({
      rules: [{ type: 'autonomy', action: 'orcamento.reduzir', account: CONTA, mode: 'SUGGEST' }],
    });
    const doc: PolicyDocument = {
      rules: [
        { type: 'forbidden_words', words: ['grátis'] },
        { type: 'autonomy', action: 'orcamento.reduzir', account: CONTA, mode: 'SUGGEST' },
        // Com outro seletor é outra regra: não é a da promoção.
        { type: 'autonomy', action: 'orcamento.reduzir', account: CONTA, risk: 'R3', mode: 'APPROVAL' },
        { type: 'autonomy', action: 'orcamento.aumentar', account: CONTA, mode: 'SUGGEST' },
      ],
    };
    expect(comRegraDaConta(doc, { action: 'orcamento.reduzir', account: CONTA, mode: 'SHADOW' }).rules).toEqual([
      { type: 'forbidden_words', words: ['grátis'] },
      { type: 'autonomy', action: 'orcamento.reduzir', account: CONTA, risk: 'R3', mode: 'APPROVAL' },
      { type: 'autonomy', action: 'orcamento.aumentar', account: CONTA, mode: 'SUGGEST' },
      { type: 'autonomy', action: 'orcamento.reduzir', account: CONTA, mode: 'SHADOW' },
    ]);
  });

  it('a vez da proposta: propõe, espera a amostra da recusa, retira e encerra', () => {
    const passa = { sampleSize: 31, missing: [] };
    const falta = { sampleSize: 31, missing: ['concordancia'] };
    expect(vezDaProposta(passa, 'SHADOW', null)).toBe('propor');
    expect(vezDaProposta(falta, 'SHADOW', null)).toBe('nada');
    expect(vezDaProposta(passa, 'SUGGEST', null)).toBe('nada');
    // Pendente: segue enquanto vale; sai quando os portões param de passar ou o modo muda.
    expect(vezDaProposta(passa, 'SHADOW', { status: 'pendente', nextSampleSize: null })).toBe('nada');
    expect(vezDaProposta(falta, 'SHADOW', { status: 'pendente', nextSampleSize: null })).toBe('retirar');
    expect(vezDaProposta(passa, 'SUGGEST', { status: 'pendente', nextSampleSize: null })).toBe('retirar');
    // Recusada (ou desfeita): só com a amostra pedida.
    expect(vezDaProposta(passa, 'SHADOW', { status: 'recusada', nextSampleSize: 61 })).toBe('nada');
    expect(vezDaProposta({ sampleSize: 61, missing: [] }, 'SHADOW', { status: 'recusada', nextSampleSize: 61 })).toBe('propor');
    expect(vezDaProposta(passa, 'SHADOW', { status: 'retirada', nextSampleSize: null })).toBe('propor');
    // Aprovada: vale enquanto o modo não volta para Sombra por outro caminho.
    expect(vezDaProposta(falta, 'SUGGEST', { status: 'aprovada', nextSampleSize: null })).toBe('nada');
    expect(vezDaProposta(passa, 'SHADOW', { status: 'aprovada', nextSampleSize: null })).toBe('encerrar');
  });

  it('na A3, qualquer modo acima de Sombra só mostra na Atenção; os limiares vêm das regras da sombra', () => {
    expect(mostraNaAtencao('SHADOW')).toBe(false);
    for (const m of ['SUGGEST', 'APPROVAL', 'LIMITED_AUTO', 'AUTO', 'ESCALATE'] as const) expect(mostraNaAtencao(m)).toBe(true);
    expect(LIMIARES_DA_AUTONOMIA).toEqual({ sample_size: 30, agreement_min_pct: 80, worse_max_pct: 10, regret_max_micros: '0', confidence_min_pct: 70, sample_after_rejection: 30 });
    expect(portoesQuePassaram([])).toBe(5);
    expect(portoesQuePassaram(['amostra', 'confianca'])).toBe(3);
  });

  it('o aviso da recomendação em Sugerir usa os números do retrato e diz que nada muda sem a pessoa', () => {
    const retrato = {
      campanha: { nome: 'Delivery noite', verba_diaria_micros: '30000000' },
      janela: { ate: '2026-09-14' },
      plataforma: { spend_micros: '150000000' },
      caixa: { margin_known_micros: '40000000' },
    };
    const base = { campaignId: MARCA, connectedAccountId: CONTA, provider: 'meta_ads', retrato };
    expect(avisoDaSugestao({ ...base, tool: 'orcamento_reduzir', percent: 20 })).toEqual({
      kind: 'sugestao_reduzir_verba',
      severity: 'atencao',
      title: 'Sugestão do Gestor de tráfego: reduzir a verba da campanha "Delivery noite" em 20%',
      detail: nbsp('Nos 7 dias até 14/09, ela gastou R$ 150,00 e deixou R$ 40,00 de margem conhecida no caixa: prejuízo. A verba diária iria de R$ 30,00 para R$ 24,00.'),
      action: 'Se concordar, reduza a verba na Meta. Nada muda sem você.',
      connected_account_id: CONTA,
      campaign_id: MARCA,
      provider: 'meta_ads',
    });
    expect(avisoDaSugestao({ ...base, tool: 'orcamento_aumentar', percent: 20 })).toMatchObject({
      kind: 'sugestao_aumentar_verba',
      title: 'Sugestão do Gestor de tráfego: aumentar a verba da campanha "Delivery noite" em 20%',
      detail: nbsp('Nos 7 dias até 14/09, ela gastou R$ 150,00 e deixou R$ 40,00 de margem conhecida no caixa, com a verba no limite. A verba diária iria de R$ 30,00 para R$ 36,00.'),
      action: 'Se concordar, aumente a verba na Meta. Nada muda sem você.',
    });
    expect(avisoDaSugestao({ ...base, provider: 'google_ads', tool: 'campanha_pausar', percent: null })).toMatchObject({
      kind: 'sugestao_pausar_campanha',
      title: 'Sugestão do Gestor de tráfego: pausar a campanha "Delivery noite"',
      detail: nbsp('Nos 7 dias até 14/09, ela gastou R$ 150,00 e deixou R$ 40,00 de margem conhecida no caixa: menos da metade do que gastou.'),
      action: 'Se concordar, pause a campanha no Google Ads. Nada muda sem você.',
    });
    // Retrato sem os números (antigo ou incompleto): sem aviso, em vez de um aviso sem prova.
    expect(avisoDaSugestao({ ...base, tool: 'orcamento_reduzir', percent: 20, retrato: { ...retrato, caixa: { margin_known_micros: null } } })).toBeNull();
  });
});
