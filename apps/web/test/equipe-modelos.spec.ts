import type { TeamMember, TeamModelPurposeState, TeamModelsResponse, TeamResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AcoesDosModelos } from '@/components/equipe/bloco-modelos';
import { EquipeConteudo } from '@/components/equipe/equipe-conteudo';
import {
  atualDe,
  avisoDoRetirado,
  baseDaEstimativa,
  type CargaDosModelos,
  estimativaDe,
  notaDe,
  quemUsaTexto,
  resumoDosModelos,
  velocidadeDe,
} from '@/components/equipe/modelos-textos';
import type { Modo } from '@/lib/modo';

// "Modelos de IA" em Sua equipe, só no Pro (A3, I13; mockups/prototipo-equipe.html, P7 aprovado em 03/10/2026;
// D-A3-12 e D-A3-25 a D-A3-28): os textos e o bloco saem do que `/v1/team/models` manda.

const AGORA = new Date('2026-11-01T10:00:00Z');
const NBSP = String.fromCharCode(160);
const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const PTAX = { rate: '5.2238', date: '2026-10-30', source: 'bcb_ptax_venda' };
const semTags = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const nada = () => {};

const OPUS = { provider: 'anthropic', model: 'claude-opus-5-5', label: 'Claude Opus 5.5', speed: 'mais_lento', eval_score: '0.9600', estimated_usd_micros: '6000000' };

const finalidade = (over: Partial<TeamModelPurposeState> = {}): TeamModelPurposeState => ({
  purpose: 'conversa',
  label: 'Conversa e atendimento',
  tasks: ['conversa_lia'],
  members: ['LIA'],
  answered: 61,
  automatic: { provider: 'anthropic', model: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  spent_usd_micros: '1800000',
  options: [OPUS],
  choice: null,
  ...over,
});

function modelos(over: Partial<TeamModelsResponse> = {}): TeamModelsResponse {
  return {
    enabled: true,
    can_change: true,
    window: { from: '2026-10-02', to: '2026-10-31' },
    usd_brl: PTAX,
    purposes: [
      finalidade(),
      finalidade({ purpose: 'analise', label: 'Análise e decisão', tasks: ['explicar_resultados', 'estrategista_plano'], members: ['Analista de dados', 'Estrategista'], answered: 1, options: [], spent_usd_micros: '0' }),
      finalidade({ purpose: 'texto', label: 'Textos', tasks: ['criativo_texto'], members: ['Criativo'], answered: 0, options: [], spent_usd_micros: '0' }),
    ],
    ...over,
  };
}

const membro = (key: string): TeamMember => ({
  key,
  kind: ['relatorios', 'compliance', 'trafego'].includes(key) ? 'regra' : 'ia',
  status: key === 'trafego' ? 'sombra' : 'ativo',
  working_now: false,
  can_pause: key !== 'compliance',
  paused: null,
  cost: { usd_micros: '0', calls: 0 },
  stats: [],
});

const equipe = (): TeamResponse => ({
  brand_id: uuid(1),
  month: { from: '2026-11-01', to: '2026-11-30', timezone: 'America/Sao_Paulo' },
  ai: { enabled: true, spent_usd_micros: '0', ceiling_usd_micros: '20000000', band: 'livre' },
  usd_brl: PTAX,
  stop: null,
  members: ['lia', 'analista', 'relatorios', 'compliance', 'estrategista', 'pesquisador', 'trafego'].map(membro),
  can_manage: true,
  can_stop: true,
  generated_at: AGORA.toISOString(),
});

const acoes = (over: Partial<AcoesDosModelos> = {}): AcoesDosModelos => ({ ocupado: null, editando: null, aoEditar: nada, aoSalvar: nada, aoRecarregar: nada, ...over });

function tela(over: { modo?: Modo; escolhido?: string; carga?: CargaDosModelos; acoes?: Partial<AcoesDosModelos>; semModelos?: boolean } = {}) {
  return renderToStaticMarkup(
    createElement(EquipeConteudo, {
      t: equipe(),
      autonomia: null,
      sombra: null,
      historicos: {},
      escolhido: over.escolhido ?? 'lia',
      mostraDetalhe: false,
      modo: over.modo ?? 'pro',
      agora: AGORA,
      nomeDaMarca: 'Mister Burgers',
      topo: { ocupado: null, parando: false, aoPedirParada: nada, aoParar: nada, aoRetomar: nada },
      membro: { ocupado: null, desligando: null, aoPedirDesligar: nada, aoDesligar: nada, aoLigar: nada, aoIrParaPro: nada, aoRecarregarHistorico: nada },
      prontidao: { ocupado: null, recusando: null, aoAprovar: nada, aoPedirRecusa: nada, aoRecusar: nada, aoVoltarParaSombra: nada, linha: null, voltando: null, aoEscolherLinha: nada, aoPedirVolta: nada },
      quem: { souDono: true, podePedir: true },
      ...(over.semModelos ? {} : { modelos: { carga: over.carga ?? { tipo: 'ok', dados: modelos() }, acoes: acoes(over.acoes) } }),
      aoEscolher: nada,
      aoVoltar: nada,
    }),
  );
}

describe('os textos dos modelos de IA', () => {
  it('a velocidade, a nota e a estimativa em reais pela cotação (sem preço, sem número)', () => {
    expect(velocidadeDe('mais_lento')).toBe('mais lento');
    expect(velocidadeDe('rapido')).toBe('rápido');
    expect(velocidadeDe('super_rapido')).toBe('super rapido');
    expect(notaDe('0.9600')).toBe('nota 96% no teste');
    expect(notaDe('1.0000')).toBe('nota 100% no teste');
    // US$ 6,00 × 5,2238 = R$ 31,34.
    expect(estimativaDe(OPUS, PTAX)).toBe(`R$${NBSP}31,34 estimados em 30 dias`);
    expect(estimativaDe(OPUS, null)).toBe(`US$${NBSP}6,00 estimados em 30 dias`);
    expect(estimativaDe({ ...OPUS, estimated_usd_micros: null }, PTAX)).toBe('sem estimativa de custo');
  });

  it('a base da estimativa no singular, no plural e sem nenhuma resposta; quem usa, por extenso', () => {
    const janela = { from: '2026-10-02', to: '2026-10-31' };
    expect(baseDaEstimativa(finalidade({ answered: 1234 }), janela)).toBe('1.234 respostas de 02/10 a 31/10');
    expect(baseDaEstimativa(finalidade({ answered: 1 }), janela)).toBe('1 resposta de 02/10 a 31/10');
    expect(baseDaEstimativa(finalidade({ answered: 0 }), janela)).toBe('nenhuma resposta de 02/10 a 31/10');
    expect(quemUsaTexto(['LIA'])).toBe('LIA');
    expect(quemUsaTexto(['Analista de dados', 'Estrategista', 'Compliance'])).toBe('Analista de dados, Estrategista e Compliance');
    expect(quemUsaTexto([])).toBe('');
  });

  it('o que vale agora: o automático com o gasto de verdade, ou o escolhido com quem e quando; o retirado avisa', () => {
    expect(atualDe(finalidade(), PTAX)).toEqual({ titulo: 'Automático (recomendado): Claude Sonnet 5.5', nota: `R$${NBSP}9,40 nos últimos 30 dias` });
    expect(atualDe(finalidade({ automatic: null }), PTAX).titulo).toBe('Automático (recomendado): o modelo de cada tarefa');
    const escolhido = finalidade({ choice: { provider: 'anthropic', model: 'claude-opus-5-5', label: 'Claude Opus 5.5', by: { id: uuid(9), name: 'Rodrigo' }, at: '2026-10-31T13:00:00.000Z', offered: true } });
    expect(atualDe(escolhido, PTAX)).toEqual({ titulo: 'Claude Opus 5.5, escolhido por Rodrigo em 31/10', nota: `R$${NBSP}31,34 estimados em 30 dias · mais lento · nota 96% no teste` });
    expect(avisoDoRetirado(escolhido)).toBeNull();
    const retirado = finalidade({ options: [], choice: { ...escolhido.choice!, offered: false } });
    expect(atualDe(retirado, PTAX).titulo).toBe('Automático (recomendado): Claude Sonnet 5.5');
    expect(avisoDoRetirado(retirado)).toBe('Claude Opus 5.5 saiu do catálogo do Liame. As respostas voltaram ao automático; escolha de novo quando quiser.');
  });

  it('o resumo da lista conta só as escolhas que valem', () => {
    expect(resumoDosModelos(modelos())).toBe('Automático em todas as finalidades');
    const escolha = { provider: 'anthropic', model: 'claude-opus-5-5', label: 'Claude Opus 5.5', by: null, at: '2026-10-31T13:00:00.000Z', offered: true };
    expect(resumoDosModelos(modelos({ purposes: [finalidade({ choice: escolha }), finalidade({ purpose: 'texto', choice: { ...escolha, offered: false } })] }))).toBe('1 de 2 com modelo escolhido');
  });
});

describe('Modelos de IA em Sua equipe', () => {
  it('a entrada só aparece no Pro e com a função ligada; no Lite fica o selo do automático', () => {
    expect(semTags(tela())).toContain('Configuração da equipe Modelos de IA Automático em todas as finalidades');
    expect(tela({ modo: 'lite' })).not.toContain('eqp-item-modelos');
    expect(tela({ modo: 'lite' })).toContain('Modelos de IA: automático');
    expect(tela({ carga: { tipo: 'ok', dados: modelos({ enabled: false }) } })).not.toContain('eqp-item-modelos');
    expect(tela({ carga: { tipo: 'carregando' } })).not.toContain('eqp-item-modelos');
    expect(tela({ carga: { tipo: 'erro' } })).not.toContain('eqp-item-modelos');
    // Sem a propriedade (como os testes antigos montam a tela), nada muda.
    expect(tela({ semModelos: true })).not.toContain('eqp-item-modelos');
  });

  it('o detalhe: cada finalidade, o automático, a base, "Trocar o modelo" só onde há catálogo, e as regras', () => {
    const t = semTags(tela({ escolhido: 'modelos' }));
    expect(t).toContain('Modelos de IA O modelo de cada finalidade, dentro do catálogo do Liame');
    expect(t).toContain('Conversa e atendimento LIA Automático (recomendado): Claude Sonnet 5.5');
    expect(t).toContain('Base da estimativa: 61 respostas de 02/10 a 31/10.');
    expect(t).toContain('Análise e decisão Analista de dados e Estrategista');
    expect(t).toContain('Por enquanto, só o automático: nenhum outro modelo passou no teste de todas as tarefas desta finalidade.');
    expect(t.match(/Trocar o modelo/g)).toHaveLength(1);
    expect(t).toContain('Regras do catálogo');
    expect(t).toContain('Valor aproximado em reais, pela PTAX de venda do Banco Central de 30/10/2026');
  });

  it('o formulário: o automático e o catálogo, com o custo, a velocidade e a nota; salvar só depois de mudar', () => {
    const html = tela({ escolhido: 'modelos', acoes: { editando: 'conversa' } });
    const t = semTags(html);
    expect(t).toContain('Modelo para conversa e atendimento');
    expect(t).toContain('Automático (recomendado) O Liame escolhe pelo teste da finalidade; hoje, Claude Sonnet 5.5.');
    // O `semTags` junta os espaços, e o espaço fixo do "R$" vira espaço comum.
    expect(t).toContain('Claude Opus 5.5 R$ 31,34 estimados em 30 dias · mais lento · nota 96% no teste');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""/);
    expect(semTags(tela({ escolhido: 'modelos', acoes: { editando: 'conversa', ocupado: 'modelo-conversa' } }))).toContain('Salvando…');
  });

  it('quem não troca lê o motivo; a falha e a espera da leitura dizem o que fazer', () => {
    expect(semTags(tela({ escolhido: 'modelos', carga: { tipo: 'ok', dados: modelos({ can_change: false }) } }))).toContain('Só o Dono e o Administrador trocam o modelo.');
    expect(tela({ escolhido: 'modelos', carga: { tipo: 'ok', dados: modelos({ can_change: false }) } })).not.toContain('Trocar o modelo');
    expect(semTags(tela({ escolhido: 'modelos', carga: { tipo: 'erro' } }))).toContain('Não deu para carregar os modelos agora. Nada mudou: as respostas seguem com o modelo de antes. Tentar de novo');
    expect(tela({ escolhido: 'modelos', carga: { tipo: 'carregando' } })).toContain('aria-busy="true"');
  });

  it('o escolhido que saiu do catálogo avisa e mostra o automático', () => {
    const retirado = finalidade({ options: [], choice: { provider: 'anthropic', model: 'claude-opus-5-5', label: 'Claude Opus 5.5', by: null, at: '2026-10-31T13:00:00.000Z', offered: false } });
    const t = semTags(tela({ escolhido: 'modelos', carga: { tipo: 'ok', dados: modelos({ purposes: [retirado] }) } }));
    expect(t).toContain('Claude Opus 5.5 saiu do catálogo do Liame.');
    expect(t).toContain('Automático (recomendado): Claude Sonnet 5.5');
  });
});
