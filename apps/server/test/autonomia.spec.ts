import type { PolicyDocument } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { chooseMode, evaluatePolicy, type LoadedPolicy, PLATFORM_POLICY } from '../src/policy/engine.js';
import { avisoDaSugestao } from '../src/results/sugestoes-da-sombra.js';
import {
  ACAO_DA_FERRAMENTA,
  comRegraDaConta,
  type DesfechoDoPedido,
  desfechoDoPedido,
  LIMIARES_DA_AUTONOMIA,
  modoDaAcao,
  MODOS_DO_FUNCIONARIO,
  mostraNaAtencao,
  portoesQuePassaram,
  prontidaoDaAprovacao,
  propostaDaAcao,
  umPassoAtras,
  vezDaProposta,
  vezDaPropostaDeAprovacao,
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
      actor: 'agent',
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

  it('o modo do funcionário de IA e o pedido de uma pessoa são regras separadas (A4, X2)', () => {
    // Na Meta, a plataforma manda o pedido de uma pessoa esperar aprovação; isso não tira o funcionário da Sombra.
    const daPessoa = { ...propostaDaAcao(alvo), actor: 'human' as const };
    expect(chooseMode([PLATFORM_POLICY], daPessoa)).toEqual({ mode: 'APPROVAL', source: 'platform', version: 5 });
    expect(modoDaAcao([PLATFORM_POLICY], alvo).mode).toBe('SHADOW');
    // A regra que a promoção e a volta para Sombra escrevem é do funcionário: o pedido da pessoa segue em aprovação.
    for (const mode of ['SUGGEST', 'SHADOW'] as const) {
      const daMarca = politica('brand', 6, comRegraDaConta(null, { action: 'orcamento.reduzir', account: CONTA, mode }).rules);
      expect(modoDaAcao([PLATFORM_POLICY, daMarca], alvo).mode).toBe(mode);
      expect(chooseMode([PLATFORM_POLICY, daMarca], daPessoa).mode).toBe('APPROVAL');
    }
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
      rules: [{ type: 'autonomy', action: 'orcamento.reduzir', actor: 'agent', account: CONTA, mode: 'SUGGEST' }],
    });
    const doc: PolicyDocument = {
      rules: [
        { type: 'forbidden_words', words: ['grátis'] },
        // Escrita antes da A4, sem o ator: é a mesma regra, e sai na troca.
        { type: 'autonomy', action: 'orcamento.reduzir', account: CONTA, mode: 'SUGGEST' },
        // Com outro seletor é outra regra: não é a da promoção.
        { type: 'autonomy', action: 'orcamento.reduzir', account: CONTA, risk: 'R3', mode: 'APPROVAL' },
        // A do pedido de uma pessoa também é outra.
        { type: 'autonomy', action: 'orcamento.reduzir', actor: 'human', account: CONTA, mode: 'ESCALATE' },
        { type: 'autonomy', action: 'orcamento.aumentar', actor: 'agent', account: CONTA, mode: 'SUGGEST' },
      ],
    };
    const trocada = comRegraDaConta(doc, { action: 'orcamento.reduzir', account: CONTA, mode: 'SHADOW' });
    expect(trocada.rules).toEqual([
      { type: 'forbidden_words', words: ['grátis'] },
      { type: 'autonomy', action: 'orcamento.reduzir', account: CONTA, risk: 'R3', mode: 'APPROVAL' },
      { type: 'autonomy', action: 'orcamento.reduzir', actor: 'human', account: CONTA, mode: 'ESCALATE' },
      { type: 'autonomy', action: 'orcamento.aumentar', actor: 'agent', account: CONTA, mode: 'SUGGEST' },
      { type: 'autonomy', action: 'orcamento.reduzir', actor: 'agent', account: CONTA, mode: 'SHADOW' },
    ]);
    // Trocar de novo não empilha: a regra com o ator também é reconhecida.
    expect(comRegraDaConta(trocada, { action: 'orcamento.reduzir', account: CONTA, mode: 'SUGGEST' }).rules.filter((r) => r.type === 'autonomy' && r.action === 'orcamento.reduzir' && r.actor === 'agent')).toEqual([
      { type: 'autonomy', action: 'orcamento.reduzir', actor: 'agent', account: CONTA, mode: 'SUGGEST' },
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
    expect(LIMIARES_DA_AUTONOMIA).toEqual({
      sample_size: 30,
      agreement_min_pct: 80,
      worse_max_pct: 10,
      regret_max_micros: '0',
      confidence_min_pct: 70,
      sample_after_rejection: 30,
      // De Sugerir para Aprovação (A4, X3): 8 aprovados nos 10 pedidos decididos mais recentes; mais 10 depois de uma recusa.
      approval_requests: 10,
      approval_min_approved: 8,
      requests_after_rejection: 10,
    });
    expect(portoesQuePassaram([])).toBe(5);
    expect(portoesQuePassaram(['amostra', 'confianca'])).toBe(3);
  });

  it('A4 · X3: os três modos do funcionário passam pela mesma regra da conta, e voltar é um passo por vez', () => {
    expect(MODOS_DO_FUNCIONARIO).toEqual(['SHADOW', 'SUGGEST', 'APPROVAL']);
    // A regra de Aprovação é a mesma regra da conta, com o ator do funcionário: troca a de Sugerir, sem empilhar.
    const emSugerir = comRegraDaConta(null, { action: 'orcamento.reduzir', account: CONTA, mode: 'SUGGEST' });
    const emAprovacao = comRegraDaConta(emSugerir, { action: 'orcamento.reduzir', account: CONTA, mode: 'APPROVAL' });
    expect(emAprovacao.rules).toEqual([{ type: 'autonomy', action: 'orcamento.reduzir', actor: 'agent', account: CONTA, mode: 'APPROVAL' }]);
    const daMarca = politica('brand', 7, emAprovacao.rules);
    expect(modoDaAcao([PLATFORM_POLICY, daMarca], alvo)).toEqual({ mode: 'APPROVAL', source: 'brand', version: 7 });
    // O pedido de uma pessoa segue pela regra da distribuição; outra ação e outra conta seguem em Sombra.
    expect(chooseMode([PLATFORM_POLICY, daMarca], { ...propostaDaAcao(alvo), actor: 'human' }).mode).toBe('APPROVAL');
    expect(modoDaAcao([PLATFORM_POLICY, daMarca], { ...alvo, tool: 'campanha_pausar' }).mode).toBe('SHADOW');
    expect(modoDaAcao([PLATFORM_POLICY, daMarca], { ...alvo, accountId: MARCA }).mode).toBe('SHADOW');
    // De Aprovação volta para Sugerir; de Sugerir (ou de outro modo que a empresa tenha escrito na política), para Sombra.
    expect(umPassoAtras('APPROVAL')).toBe('SUGGEST');
    for (const m of ['SUGGEST', 'LIMITED_AUTO', 'AUTO', 'ESCALATE', 'SHADOW'] as const) expect(umPassoAtras(m)).toBe('SHADOW');
  });

  it('A4 · X3: os portões da Aprovação olham os 10 pedidos decididos mais recentes (8 aprovados, nenhum com erro)', () => {
    // O desfecho de cada pedido, pela situação dele; o que espera decisão e o que foi retirado por quem pediu não contam.
    expect((['aprovada', 'executando', 'executada'] as const).map((status) => desfechoDoPedido({ status, recusado: false }))).toEqual(['aprovado', 'aprovado', 'aprovado']);
    expect(desfechoDoPedido({ status: 'falhou', recusado: false })).toBe('aprovado_com_erro');
    expect(desfechoDoPedido({ status: 'expirada', recusado: false })).toBe('expirado');
    expect(desfechoDoPedido({ status: 'cancelada', recusado: true })).toBe('recusado');
    expect(desfechoDoPedido({ status: 'cancelada', recusado: false })).toBeNull();
    for (const status of ['aguardando_aprovacao', 'sombra']) expect(desfechoDoPedido({ status, recusado: false })).toBeNull();

    const n = (quantos: number, d: DesfechoDoPedido) => Array.from({ length: quantos }, () => d);
    expect(prontidaoDaAprovacao([])).toEqual({ sampleSize: 0, approved: 0, failed: 0, missing: ['pedidos', 'aprovacao'] });
    // Nove aprovados ainda não são dez pedidos.
    expect(prontidaoDaAprovacao(n(9, 'aprovado'))).toEqual({ sampleSize: 9, approved: 9, failed: 0, missing: ['pedidos'] });
    // Oito em dez passa; sete, não. Recusado e expirado contam como não aprovado.
    expect(prontidaoDaAprovacao([...n(8, 'aprovado'), 'recusado', 'expirado'])).toEqual({ sampleSize: 10, approved: 8, failed: 0, missing: [] });
    expect(prontidaoDaAprovacao([...n(7, 'aprovado'), ...n(3, 'recusado')]).missing).toEqual(['aprovacao']);
    // Um aprovado que terminou em erro barra, mesmo com a taxa de aprovação cheia (ele conta como aprovado).
    expect(prontidaoDaAprovacao([...n(9, 'aprovado'), 'aprovado_com_erro'])).toEqual({ sampleSize: 10, approved: 10, failed: 1, missing: ['erro'] });
    // Só os dez mais recentes: o erro e as recusas mais antigos saem da conta.
    expect(prontidaoDaAprovacao([...n(10, 'aprovado'), 'aprovado_com_erro', ...n(5, 'recusado')])).toEqual({ sampleSize: 10, approved: 10, failed: 0, missing: [] });
    expect(prontidaoDaAprovacao(['aprovado_com_erro', ...n(12, 'aprovado')]).missing).toEqual(['erro']);
  });

  it('A4 · X3: a vez da proposta de Aprovação: só em Sugerir, com os dois grupos de portões e o modo disponível na conta', () => {
    const pedidosOk = prontidaoDaAprovacao(Array.from({ length: 10 }, () => 'aprovado' as const));
    const pedidosFaltam = prontidaoDaAprovacao(Array.from({ length: 4 }, () => 'aprovado' as const));
    const tudo = { disponivel: true, passamOsCinco: true, pedidos: pedidosOk, decididos: 10 };
    expect(vezDaPropostaDeAprovacao(tudo, 'SUGGEST', null)).toBe('propor');
    // Falta um dos lados: os cinco da sombra, os dos pedidos, ou o modo não existe ali (Google, escrita desligada).
    expect(vezDaPropostaDeAprovacao({ ...tudo, passamOsCinco: false }, 'SUGGEST', null)).toBe('nada');
    expect(vezDaPropostaDeAprovacao({ ...tudo, pedidos: pedidosFaltam }, 'SUGGEST', null)).toBe('nada');
    expect(vezDaPropostaDeAprovacao({ ...tudo, disponivel: false }, 'SUGGEST', null)).toBe('nada');
    // Em Sombra não se pula um passo; em Aprovação não há o que propor.
    for (const modo of ['SHADOW', 'APPROVAL', 'ESCALATE'] as const) expect(vezDaPropostaDeAprovacao(tudo, modo, null)).toBe('nada');
    // Pendente: segue enquanto tudo vale; sai quando algo deixa de valer ou o modo muda.
    const pendente = { status: 'pendente', nextRequestCount: null };
    expect(vezDaPropostaDeAprovacao(tudo, 'SUGGEST', pendente)).toBe('nada');
    expect(vezDaPropostaDeAprovacao({ ...tudo, pedidos: pedidosFaltam }, 'SUGGEST', pendente)).toBe('retirar');
    expect(vezDaPropostaDeAprovacao({ ...tudo, disponivel: false }, 'SUGGEST', pendente)).toBe('retirar');
    expect(vezDaPropostaDeAprovacao(tudo, 'SHADOW', pendente)).toBe('retirar');
    // Recusada ou desfeita: só com os pedidos decididos que ela pediu.
    expect(vezDaPropostaDeAprovacao({ ...tudo, decididos: 19 }, 'SUGGEST', { status: 'recusada', nextRequestCount: 20 })).toBe('nada');
    expect(vezDaPropostaDeAprovacao({ ...tudo, decididos: 20 }, 'SUGGEST', { status: 'desfeita', nextRequestCount: 20 })).toBe('propor');
    expect(vezDaPropostaDeAprovacao(tudo, 'SUGGEST', { status: 'retirada', nextRequestCount: null })).toBe('propor');
    // Aprovada: vale enquanto o modo é Aprovação; se saiu por outro caminho, encerra.
    expect(vezDaPropostaDeAprovacao({ ...tudo, pedidos: pedidosFaltam }, 'APPROVAL', { status: 'aprovada', nextRequestCount: null })).toBe('nada');
    expect(vezDaPropostaDeAprovacao(tudo, 'SUGGEST', { status: 'aprovada', nextRequestCount: null })).toBe('encerrar');
    expect(vezDaPropostaDeAprovacao(tudo, 'SHADOW', { status: 'aprovada', nextRequestCount: null })).toBe('encerrar');
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
