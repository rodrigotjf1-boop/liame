import type { AutonomyItem, AutonomyResponse, TeamActivityItem, TeamMember, TeamResponse, TeamShadowDecision, TeamShadowResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  avisoDaDecisao,
  caixaDaLinha,
  chaveDaLinha,
  confirmacaoDaVolta,
  faltaDaLinha,
  fraseDaLinha,
  gestorNaLista,
  historicoDaAprovacao,
  limitesDaAprovacao,
  linhaDosModos,
  nomeDaLinha,
  notaDosPortoes,
  portoesDaLinha,
  resumoDosModos,
  rodadaDoGestor,
  temModoAprovacao,
} from '@/components/equipe/aprovacao-textos';
import type { AcoesDaProntidao } from '@/components/equipe/bloco-prontidao';
import { EquipeConteudo } from '@/components/equipe/equipe-conteudo';
import { modoDo } from '@/components/equipe/textos';
import type { Modo } from '@/lib/modo';

// Sua equipe com o modo Aprovação (A4 · X8, parte 5b; mockups/prototipo-equipe-aprovacao.html, P11 aprovado em
// 05/10/2026): o modo do Gestor de tráfego em cada conta e ação, os portões (cinco ou sete), a proposta, a volta de um
// passo e a rodada da manhã saem do que `/v1/autonomy` e `/v1/team/shadow` mandam. A empresa sem o modo Aprovação
// segue com a tela do P7 (`equipe.spec.ts`).

// Os instantes são montados pelo relógio local: a tela escreve a hora no fuso de quem lê, e o teste roda em qualquer fuso (ERR-116).
const AGORA = new Date(2026, 9, 8, 14, 40);
const local = (h: number, m = 0, d = 8) => new Date(2026, 9, d, h, m).toISOString();
const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const texto = (f: Array<{ t: string }>) => f.map((x) => x.t).join('');
const semTags = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

const LIMITES = { sample_size: 30, agreement_min_pct: 80, worse_max_pct: 10, regret_max_micros: '0', confidence_min_pct: 70, sample_after_rejection: 30, approval_requests: 10, approval_min_approved: 8, requests_after_rejection: 10 };
const PASSANDO = { computed_on: '2026-10-08', rule_version: 2, sample_size: 34, agreement_pct: '85.0', worse_pct: '6.0', regret_sum_micros: '-58900000', confidence_avg_pct: '78.0', missing: [] };
const FALTANDO = { computed_on: '2026-10-08', rule_version: 2, sample_size: 9, agreement_pct: '78.0', worse_pct: '11.0', regret_sum_micros: '12000000', confidence_avg_pct: '81.0', missing: ['amostra', 'concordancia', 'piora', 'arrependimento'] };
const RODRIGO = { id: uuid(9), name: 'Rodrigo' };
const META = uuid(70);
const GOOGLE = uuid(71);

const item = (over: Partial<AutonomyItem> = {}): AutonomyItem => ({
  connected_account_id: META,
  provider: 'meta_ads',
  account_name: 'CA - Mister Burguer',
  tool: 'orcamento_reduzir',
  action: 'orcamento.reduzir',
  mode: 'SUGGEST',
  mode_source: { policy: 'marca', version: 2 },
  readiness: PASSANDO,
  proposal: null,
  approval: { sample_size: 7, approved: 6, failed: 0, missing: ['pedidos', 'aprovacao'], blocked_by: null },
  ...over,
});
const proposta = (over: Partial<NonNullable<AutonomyItem['proposal']>> = {}): NonNullable<AutonomyItem['proposal']> => ({
  id: uuid(80),
  status: 'pendente',
  from_mode: 'SUGGEST',
  to_mode: 'APPROVAL',
  sample_size: 34,
  proposed_at: local(6, 32),
  decided_by: null,
  decided_at: null,
  policy_version: null,
  undone_by: null,
  undone_at: null,
  reason: null,
  next_sample_size: null,
  next_request_count: null,
  ...over,
});
const PRONTA = { sample_size: 10, approved: 9, failed: 0, missing: [], blocked_by: null };
const emSugerir = item();
const comProposta = item({ approval: PRONTA, proposal: proposta() });
const emAprovacao = item({ mode: 'APPROVAL', mode_source: { policy: 'marca', version: 4 }, approval: PRONTA, proposal: proposta({ status: 'aprovada', decided_by: RODRIGO, decided_at: local(14, 52), policy_version: 4 }) });
const aumentar = item({ tool: 'orcamento_aumentar', action: 'orcamento.aumentar', approval: { sample_size: 4, approved: 3, failed: 0, missing: ['pedidos', 'aprovacao'], blocked_by: null } });
const pausar = item({ tool: 'campanha_pausar', action: 'campanha.pausar', mode: 'SHADOW', mode_source: { policy: 'padrao', version: null }, readiness: FALTANDO, approval: { sample_size: 0, approved: 0, failed: 0, missing: ['pedidos', 'aprovacao'], blocked_by: null } });
const google = item({
  connected_account_id: GOOGLE,
  provider: 'google_ads',
  account_name: 'Mister Burgers Google',
  approval: { sample_size: 0, approved: 0, failed: 0, missing: ['pedidos', 'aprovacao'], blocked_by: 'plataforma_sem_escrita' },
});
const semEscrita = item({ approval: { ...PRONTA, blocked_by: 'escrita_desligada' } });

const autonomia = (items: AutonomyItem[], podeDecidir = true): AutonomyResponse => ({ brand_id: uuid(1), items, thresholds: LIMITES, can_decide: podeDecidir, generated_at: AGORA.toISOString() });

const decisao = (over: Partial<TeamShadowDecision> = {}): TeamShadowDecision => ({
  id: uuid(50),
  decided_on: '2026-10-08',
  campaign: { id: uuid(60), name: 'Smash em dobro', provider: 'meta_ads' },
  tool: 'orcamento_reduzir',
  percent: 10,
  confidence_pct: '82.0',
  status: 'aberta',
  evaluate_on: '2026-10-15',
  human_action: null,
  human_action_on: null,
  agreement: null,
  regret_label: null,
  regret_micros: null,
  connected_account_id: META,
  request: null,
  ...over,
});
const pedida = decisao({ request: { id: uuid(90), status: 'aguardando_aprovacao', created_at: local(6, 31), agent_key: 'trafego' } });
const sugerida = decisao({ id: uuid(51), campaign: { id: uuid(61), name: 'Combo sexta', provider: 'meta_ads' }, tool: 'orcamento_aumentar' });
const INDISPONIVEL = 'A Meta não respondeu agora, ou pediu para esperar. Nada foi pedido: tente de novo em alguns minutos.';
const naoPedida = decisao({ not_requested: { code: 'plataforma-indisponivel', detail: INDISPONIVEL, at: local(6, 31) } });
const sombra = (items: TeamShadowDecision[], over: Partial<TeamShadowResponse> = {}): TeamShadowResponse => ({
  brand_id: uuid(1),
  rule_version: 2,
  last_run: { on: '2026-10-08', status: 'feito', at: local(6, 31) },
  items,
  has_more: false,
  generated_at: AGORA.toISOString(),
  ...over,
});
const SEM_PARADA = { stop: null };

describe('o modo do Gestor de tráfego em cada conta e ação', () => {
  it('a tela do modo Aprovação só existe quando o servidor manda os portões dele', () => {
    expect(temModoAprovacao(null)).toBe(false);
    expect(temModoAprovacao(autonomia([]))).toBe(false);
    const { approval: _, ...semModo } = emSugerir;
    expect(temModoAprovacao(autonomia([semModo]))).toBe(false);
    expect(temModoAprovacao(autonomia([semModo, pausar]))).toBe(true);
    expect(limitesDaAprovacao(LIMITES)).toEqual({ pedidos: 10, aprovados: 8, depoisDaRecusa: 10 });
    // Limites de uma versão do servidor sem os números da Aprovação: os da decisão D-A4-25.
    expect(limitesDaAprovacao({ ...LIMITES, approval_requests: undefined, approval_min_approved: undefined, requests_after_rejection: undefined })).toEqual({ pedidos: 10, aprovados: 8, depoisDaRecusa: 10 });
  });

  it('cada linha diz o modo e o que ele faz ali; no Google, que vai só até Sugerir', () => {
    const itens = [emAprovacao, aumentar, pausar, google];
    expect(itens.map((a) => linhaDosModos(a, itens))).toEqual([
      { chave: `${META}:orcamento_reduzir`, nome: 'Meta Ads · Reduzir a verba', modo: 'Aprovação', classe: 'modo-chip modo-chip--aprovacao', oque: 'Ele mesmo pede a mudança; você aprova com o código do app.' },
      { chave: `${META}:orcamento_aumentar`, nome: 'Meta Ads · Aumentar a verba', modo: 'Sugerir', classe: 'modo-chip modo-chip--sugerir', oque: 'A recomendação aparece na Atenção; você pede a mudança.' },
      { chave: `${META}:campanha_pausar`, nome: 'Meta Ads · Pausar a campanha', modo: 'Sombra', classe: 'modo-chip modo-chip--sombra', oque: 'Só registra o que faria e compara com o que você fez.' },
      { chave: `${GOOGLE}:orcamento_reduzir`, nome: 'Google Ads · Reduzir a verba', modo: 'Sugerir', classe: 'modo-chip modo-chip--sugerir', oque: 'A recomendação aparece na Atenção; você pede a mudança. No Google, ele vai só até Sugerir.' },
    ]);
    expect(resumoDosModos(itens)).toBe('1 em Aprovação · 2 em Sugerir · 1 em Sombra');
    expect(resumoDosModos([pausar])).toBe('1 em Sombra');
    expect(chaveDaLinha(google)).toBe(`${GOOGLE}:orcamento_reduzir`);
    // Duas contas da mesma plataforma: o nome da conta entra na linha.
    const outra = item({ connected_account_id: uuid(72), account_name: 'CA - Loja 2' });
    expect(nomeDaLinha(outra, [emSugerir, outra, google])).toBe('Meta Ads (CA - Loja 2) · Reduzir a verba');
    expect(nomeDaLinha(google, [emSugerir, outra, google])).toBe('Google Ads · Reduzir a verba');
  });

  it('o selo do funcionário diz que o modo é por conta e ação', () => {
    const m = { key: 'trafego', kind: 'regra', status: 'sombra', working_now: false, can_pause: true, paused: null, cost: { usd_micros: '0', calls: 0 }, stats: [] } satisfies TeamMember;
    expect(modoDo(m, [emSugerir, pausar])).toEqual({ rotulo: 'por conta e ação', classe: 'modo-chip' });
    const { approval: _, ...semModo } = emSugerir;
    expect(modoDo(m, [semModo])).toEqual({ rotulo: 'Sombra e Sugerir', classe: 'modo-chip modo-chip--sugerir' });
  });
});

describe('os portões da linha', () => {
  it('cinco para sair de Sombra; sete para a Aprovação, com os pedidos mais recentes', () => {
    expect(portoesDaLinha(pausar, LIMITES).map((p) => p.chave)).toEqual(['amostra', 'concordancia', 'piora', 'arrependimento', 'confianca']);
    const sete = portoesDaLinha(emSugerir, LIMITES);
    expect(sete).toHaveLength(7);
    expect(sete.slice(5)).toEqual([
      { chave: 'aprovados', rotulo: 'Dos 10 pedidos mais recentes, você aprovou', valor: '6 de 7 (faltam 3 pedidos)', passou: false, curto: 'pedidos aprovados' },
      { chave: 'erros', rotulo: 'Pedidos aprovados que terminaram em erro', valor: '0 (máx. 0)', passou: true, curto: 'execução sem erro' },
    ]);
    expect(portoesDaLinha(comProposta, LIMITES).slice(5).map((p) => [p.valor, p.passou])).toEqual([['9 de 10 (mín. 8)', true], ['0 (máx. 0)', true]]);
    // Dez pedidos, mas só sete aprovados; um aprovado terminou em erro; falta um pedido só.
    const poucos = item({ approval: { sample_size: 10, approved: 7, failed: 1, missing: ['aprovacao', 'erro'], blocked_by: null } });
    expect(portoesDaLinha(poucos, LIMITES).slice(5).map((p) => [p.valor, p.passou])).toEqual([['7 de 10 (mín. 8)', false], ['1 (máx. 0)', false]]);
    expect(portoesDaLinha(item({ approval: { sample_size: 9, approved: 9, failed: 0, missing: ['pedidos'], blocked_by: null } }), LIMITES)[5]!.valor).toBe('9 de 9 (falta 1 pedido)');
    // Sem nenhum aprovado, "sem erro" ainda não quer dizer nada.
    expect(portoesDaLinha(item({ approval: { sample_size: 0, approved: 0, failed: 0, missing: ['pedidos', 'aprovacao'], blocked_by: null } }), LIMITES)[6]!.passou).toBe(false);
    // No Google a Aprovação não existe: ficam os cinco. Com a escrita desligada na conta, os sete continuam à vista.
    expect(portoesDaLinha(google, LIMITES)).toHaveLength(5);
    expect(portoesDaLinha(semEscrita, LIMITES)).toHaveLength(7);
  });

  it('a coluna "O que falta" e a nota de baixo', () => {
    expect(faltaDaLinha(emAprovacao, LIMITES)).toEqual({ portoes: '—', texto: 'No modo mais alto desta fase', ok: true, falta: false });
    expect(faltaDaLinha(comProposta, LIMITES)).toEqual({ portoes: '7 de 7', texto: 'Proposta esperando a decisão', ok: true, falta: false });
    expect(faltaDaLinha(emSugerir, LIMITES)).toEqual({ portoes: '6 de 7', texto: 'pedidos aprovados', ok: false, falta: true });
    expect(faltaDaLinha(pausar, LIMITES)).toEqual({ portoes: '1 de 5', texto: 'decisões comparáveis; concordância; vezes em que teria piorado; resultado na soma', ok: false, falta: true });
    expect(faltaDaLinha(google, LIMITES)).toEqual({ portoes: '5 de 5', texto: 'No Google, vai só até Sugerir', ok: false, falta: false });
    expect(faltaDaLinha(semEscrita, LIMITES)).toEqual({ portoes: '7 de 7', texto: 'A escrita na Meta não está ligada', ok: false, falta: false });
    expect(faltaDaLinha(item({ approval: PRONTA }), LIMITES)).toEqual({ portoes: '7 de 7', texto: 'Portões passando', ok: false, falta: false });
    expect(notaDosPortoes(LIMITES)).toContain('mais dois, tirados dos 10 pedidos mais recentes que nasceram de uma recomendação dele');
  });

  it('a frase do Lite para cada situação', () => {
    const f = (a: AutonomyItem, pode = true) => texto(fraseDaLinha(a, [a], LIMITES, pode));
    expect(f(emSugerir)).toBe('Ainda não. Em Meta Ads · Reduzir a verba, ele mostra a recomendação e você pede a mudança. Para ele mesmo pedir: 6 de 7 portões; faltam 3 pedidos decididos por você.');
    expect(f(comProposta)).toBe(
      'Em Meta Ads · Reduzir a verba, ele passou nos sete portões. O sistema propõe que ele mesmo passe a fazer esse pedido. Quem decide é você, e cada pedido continua esperando a aprovação com o código do app.',
    );
    expect(f(comProposta, false)).toContain('Quem decide é o Dono ou o Administrador');
    expect(f(emAprovacao)).toBe('Em Meta Ads · Reduzir a verba, ele já faz o pedido sozinho. Você aprova cada um com o código do app; sem isso, nada muda na Meta.');
    expect(f(google)).toBe('Em Google Ads · Reduzir a verba, ele mostra a recomendação na Atenção. No Google ele não passa disso: quem muda a campanha é você.');
    expect(f(semEscrita)).toBe('Em Meta Ads · Reduzir a verba, ele mostra a recomendação na Atenção. Para ele mesmo pedir a mudança, a escrita na Meta precisa estar ligada para esta conta.');
    expect(f(pausar)).toBe('Ainda não. Em Meta Ads · Pausar a campanha, ele só registra e compara: 1 de 5 portões; faltam 21 decisões comparáveis.');
    expect(f(item({ mode: 'SHADOW', proposal: proposta({ from_mode: 'SHADOW', to_mode: 'SUGGEST' }) }))).toBe(
      'Em Meta Ads · Reduzir a verba, ele passou nos cinco portões. O sistema propõe que ele passe a mostrar essas recomendações para você. Quem decide é você.',
    );
    // Os sete passando, sem proposta (recusada antes, ou a rodada ainda não propôs).
    expect(f(item({ approval: PRONTA }))).toContain('Os portões para ele mesmo pedir estão passando');
  });
});

describe('a caixa da linha: a proposta, o modo de agora e a volta de um passo', () => {
  const c = (a: AutonomyItem) => caixaDaLinha(a, [a], LIMITES, AGORA);

  it('a proposta de Sugerir para Aprovação: o que muda, o que continua igual e o que acontece se ele não conseguir pedir', () => {
    const p = c(comProposta)!;
    expect(p.titulo).toBe('Proposta do sistema: Meta Ads · Reduzir a verba, de Sugerir para Aprovação');
    expect(texto(p.texto!)).toBe(
      'Os sete portões passaram. O que muda: quando ele recomendar reduzir a verba de uma campanha da Meta, ele mesmo faz o pedido, na rodada da manhã. O pedido chega em Aprovações com o motivo e os números, e só é executado depois que uma pessoa aprova com o código do app.',
    );
    expect(p.pontos.map((x) => x.forte)).toEqual(['Continua igual:', 'Se ele não conseguir pedir']);
    expect(p.pontos[1]!.texto).toBe('(a Meta não respondeu, já existe um pedido igual, falta um limite), a recomendação fica na Atenção, com o motivo.');
    // Na linha do Google (protótipo P13, parte 2): as frases falam do Google, e a proposta diz o que é só dele.
    const g = c({ ...comProposta, provider: 'google_ads' })!;
    expect(g.titulo).toBe('Proposta do sistema: Google Ads · Reduzir a verba, de Sugerir para Aprovação');
    expect(texto(g.texto!)).toContain('quando ele recomendar reduzir a verba de uma campanha do Google, ele mesmo faz o pedido');
    expect(g.pontos.map((x) => x.forte)).toEqual(['Continua igual:', 'Se ele não conseguir pedir', 'No Google:']);
    expect(g.pontos[0]!.texto).toContain('a conferência do Google antes de mudar');
    expect(g.pontos[1]!.texto).toContain('(o Google não respondeu,');
    expect(g.pontos[2]!.texto).toBe('o pedido é sempre na campanha inteira. Se a verba da campanha for dividida com outras campanhas, ele não pede a mudança: a recomendação fica na Atenção, com o motivo.');
    expect([p.proposta, p.voltar]).toEqual([{ id: uuid(80), para: 'APPROVAL' }, null]);
  });

  it('a proposta de Sombra para Sugerir: quem pede é a pessoa onde o Liame escreve; onde só lê, ela muda na plataforma', () => {
    const meta = c(item({ mode: 'SHADOW', proposal: proposta({ from_mode: 'SHADOW', to_mode: 'SUGGEST' }) }))!;
    expect(meta.titulo).toBe('Proposta do sistema: Meta Ads · Reduzir a verba, de Sombra para Sugerir');
    expect(texto(meta.texto!)).toContain('a recomendação aparece na Atenção, com o motivo e os números. Quem pede a mudança é você.');
    expect(meta.proposta).toEqual({ id: uuid(80), para: 'SUGGEST' });
    const noGoogle = c({ ...google, mode: 'SHADOW', proposal: proposta({ from_mode: 'SHADOW', to_mode: 'SUGGEST' }) })!;
    expect(texto(noGoogle.texto!)).toContain('Quem decide e muda a campanha é você, no Google.');
  });

  it('em Aprovação: desde quando, o que ele faz e a volta para Sugerir', () => {
    const p = c(emAprovacao)!;
    expect(p.titulo).toBe('Meta Ads · Reduzir a verba está em Aprovação');
    expect(p.sub).toBe('Em Aprovação desde hoje, 14:52, aprovado por Rodrigo · regra de autonomia, versão 4.');
    expect(texto(p.texto!)).toContain('o pedido chega em Aprovações já feito, com o motivo e os números. Nada é executado sem a aprovação de uma pessoa com o código do app');
    expect([p.proposta, p.voltar]).toEqual([null, 'Sugerir']);
    expect(confirmacaoDaVolta(emAprovacao)).toEqual({ texto: 'Ele volta a só mostrar a recomendação. Os pedidos que já fez continuam esperando.', rotulo: 'Voltar para Sugerir' });
    expect(confirmacaoDaVolta(emSugerir)).toEqual({ texto: 'Ele volta a só registrar e comparar nesta ação.', rotulo: 'Voltar para Sombra' });
    // O modo veio da política, sem proposta aprovada por aqui.
    expect(c(item({ mode: 'APPROVAL', mode_source: { policy: 'empresa', version: 7 } }))!.sub).toBe('Em Aprovação pela política da empresa, versão 7.');
  });

  it('em Sugerir: o que falta, o Google que não passa disso e a escrita desligada, sempre com a volta para Sombra', () => {
    expect(c(emSugerir)).toMatchObject({ titulo: 'Meta Ads · Reduzir a verba está em Sugerir', sub: 'Em Sugerir pela política da marca, versão 2.', voltar: 'Sombra', proposta: null });
    expect(c(google)).toMatchObject({
      titulo: 'Google Ads · Reduzir a verba fica em Sugerir',
      sub: 'O Liame ainda não muda campanhas do Google: a recomendação aparece na Atenção, e quem muda é você, no Google. A Aprovação para o Google entra numa fase futura.',
      voltar: 'Sombra',
    });
    expect(c(semEscrita)).toMatchObject({ titulo: 'A Aprovação ainda não está disponível', voltar: 'Sombra' });
    expect(c(semEscrita)!.sub).toContain('A escrita na Meta não está ligada para esta conta: o Liame só lê as campanhas.');
    // Em Sombra, sem proposta: a linha não tem caixa.
    expect(c(pausar)).toBeNull();
  });

  it('o que aconteceu com a última proposta: recusada, retirada e a volta de um passo', () => {
    const recusada = c(item({ approval: PRONTA, proposal: proposta({ status: 'recusada', decided_by: RODRIGO, decided_at: local(14) }) }))!;
    expect(recusada).toMatchObject({ titulo: 'Promoção recusada por Rodrigo', sub: 'Ele segue em Sugerir nesta ação. O sistema só propõe de novo depois de mais 10 pedidos decididos.', voltar: 'Sombra', aviso: true });
    const retirada = c(item({ approval: { sample_size: 10, approved: 7, failed: 0, missing: ['aprovacao'], blocked_by: null }, proposal: proposta({ status: 'retirada', decided_at: local(6, 32) }) }))!;
    expect(retirada.titulo).toBe('Proposta retirada pelo sistema');
    expect(retirada.sub).toBe('A proposta de Aprovação saiu antes de alguém decidir: um portão deixou de passar (pedidos aprovados). Ele segue em Sugerir. O sistema propõe de novo quando os portões voltarem a passar.');
    const voltou = c(item({ approval: PRONTA, proposal: proposta({ status: 'desfeita', decided_by: RODRIGO, decided_at: local(9, 0, 1), policy_version: 4, undone_by: RODRIGO, undone_at: local(15, 10) }) }))!;
    expect(voltou).toMatchObject({ titulo: 'Meta Ads · Reduzir a verba voltou para Sugerir', sub: 'Por Rodrigo, hoje, 15:10.', voltar: 'Sombra', aviso: true });
    expect(texto(voltou.texto!)).toBe(
      'Ele volta a só mostrar a recomendação na Atenção. Os pedidos que ele já tinha feito continuam em Aprovações, esperando a sua decisão. O sistema só propõe de novo depois de mais 10 pedidos decididos.',
    );
    // De Sugerir para Sombra: o que conta para a próxima proposta são as decisões comparáveis.
    const paraSombra = c(item({ mode: 'SHADOW', proposal: proposta({ status: 'desfeita', from_mode: 'SHADOW', to_mode: 'SUGGEST', undone_by: RODRIGO, undone_at: local(15, 10) }) }))!;
    expect(paraSombra.titulo).toBe('Meta Ads · Reduzir a verba voltou para Sombra');
    expect(texto(paraSombra.texto!)).toContain('Nada mais aparece na Atenção por ele nesta ação. O sistema só propõe de novo depois de mais 30 decisões comparáveis.');
    expect(paraSombra.voltar).toBeNull();
    // A recusa antiga de Sombra para Sugerir não cobre a linha que hoje está em Sugerir.
    expect(c(item({ proposal: proposta({ status: 'recusada', from_mode: 'SHADOW', to_mode: 'SUGGEST' }) }))!.titulo).toBe('Meta Ads · Reduzir a verba está em Sugerir');
  });

  it('o aviso depois de cada decisão', () => {
    expect(avisoDaDecisao(comProposta, 'aprovar')).toBe('Promoção aprovada. A partir da próxima rodada, ele mesmo pede reduzir a verba na Meta; cada pedido espera a aprovação com o código do app.');
    expect(avisoDaDecisao(item({ mode: 'SHADOW', proposal: proposta({ from_mode: 'SHADOW', to_mode: 'SUGGEST' }) }), 'aprovar')).toBe(
      'Promoção aprovada. As recomendações de reduzir a verba na conta CA - Mister Burguer (Meta Ads) passam a aparecer na Atenção.',
    );
    expect(avisoDaDecisao(comProposta, 'recusar')).toBe('Promoção recusada. Ele segue em Sugerir.');
    expect(avisoDaDecisao(emAprovacao, 'voltar')).toBe('De volta para Sugerir. A mudança ficou registrada na auditoria.');
    expect(avisoDaDecisao(emSugerir, 'voltar')).toBe('De volta para Sombra. A mudança ficou registrada na auditoria.');
  });
});

describe('a rodada da manhã', () => {
  const itens = [emAprovacao, aumentar, pausar, google];
  const r = (ds: TeamShadowDecision[], over: Partial<TeamShadowResponse> = {}) => rodadaDoGestor(sombra(ds, over), itens, SEM_PARADA, AGORA)!;

  it('pediu uma mudança e sugeriu outra', () => {
    const rodada = r([pedida, sugerida]);
    expect([rodada.titulo, rodada.nota]).toEqual(['Rodada de hoje', 'hoje · regras da sombra, versão 2']);
    expect(texto(rodada.frase)).toBe(
      'Ele pediu 1 mudança e sugeriu outra. A redução da verba da campanha “Smash em dobro” espera a sua aprovação com o código do app; a recomendação de aumentar a verba em 10% da campanha “Combo sexta” está na Atenção, para você pedir se concordar.',
    );
    expect(rodada.passos.map((p) => [p.texto, p.falhou])).toEqual([
      ['Leu os resultados de 7 dias das campanhas', false],
      ['Comparou cada campanha com as regras da sombra', false],
      ['Pediu reduzir a verba em 10% da campanha “Smash em dobro”', false],
      ['Deixou 1 recomendação na Atenção', false],
      ['Conferiu o que mudou nas contas desde a rodada anterior', false],
    ]);
    expect([rodada.aprovacoes, rodada.naAtencao]).toEqual([{ pedido: uuid(90) }, true]);
    expect([rodada.resumo, rodada.hoje]).toEqual(['Pediu 1 mudança hoje', true]);
    // O pedido que já foi decidido no mesmo dia.
    const decidido = r([decisao({ request: { id: uuid(90), status: 'executada', created_at: local(6, 31), agent_key: 'trafego' } })]);
    expect(texto(decidido.frase)).toBe('Ele pediu 1 mudança. O pedido de reduzir a verba em 10% da campanha “Smash em dobro” já foi decidido: está em Aprovações.');
    // Vários pedidos: a tela de Aprovações, sem um pedido só.
    const varios = r([pedida, decisao({ id: uuid(52), campaign: { id: uuid(62), name: 'Almoço', provider: 'meta_ads' }, request: { id: uuid(91), status: 'aguardando_aprovacao', created_at: local(6, 31), agent_key: 'trafego' } })]);
    expect(texto(varios.frase)).toBe('Ele pediu 2 mudanças. Cada pedido espera a aprovação de uma pessoa com o código do app.');
    expect(varios.aprovacoes).toEqual({ pedido: null });
  });

  it('não conseguiu pedir: fica na Atenção, com o motivo', () => {
    const rodada = r([naoPedida]);
    expect(texto(rodada.frase)).toBe(`Ele não conseguiu fazer o pedido desta rodada. ${INDISPONIVEL} A recomendação ficou na Atenção, com o motivo: se você concordar, peça a mudança por lá.`);
    expect(rodada.passos.filter((p) => p.falhou).map((p) => p.texto)).toEqual(['Não conseguiu pedir: reduzir a verba em 10% da campanha “Smash em dobro”']);
    expect(rodada.passos.map((p) => p.texto)).toContain('Deixou 1 recomendação na Atenção, com o motivo');
    expect([rodada.aprovacoes, rodada.naAtencao]).toEqual([null, true]);
    expect(rodada.resumo).toBe('Não conseguiu fazer o pedido hoje');
    // O pedido que a pessoa fez depois, pela Atenção, não é pedido dele.
    const pelaPessoa = r([decisao({ ...naoPedida, request: { id: uuid(92), status: 'aguardando_aprovacao', created_at: local(9), agent_key: null } })]);
    expect(pelaPessoa.aprovacoes).toBeNull();
    expect(texto(pelaPessoa.frase)).toContain('Ele não conseguiu fazer o pedido desta rodada.');
  });

  it('só sugeriu, só registrou, nada pediu e a rodada de outro dia', () => {
    const sugeriu = r([sugerida, decisao({ id: uuid(53), campaign: { id: uuid(63), name: 'Almoço', provider: 'meta_ads' }, tool: 'orcamento_aumentar' })]);
    expect(texto(sugeriu.frase)).toBe(
      'Ele deixou 2 recomendações na Atenção. Aumentar a verba em 10% da campanha “Combo sexta” e aumentar a verba em 10% da campanha “Almoço”. Se você concordar, peça a mudança por lá; ela ainda passa pela aprovação com o código do app.',
    );
    // No Google, quem muda é a pessoa, na plataforma.
    const noGoogle = r([decisao({ connected_account_id: GOOGLE, campaign: { id: uuid(64), name: 'Busca', provider: 'google_ads' } })]);
    expect(texto(noGoogle.frase)).toContain('Se você concordar, quem muda a campanha é você, na plataforma.');
    const registrou = r([decisao({ tool: 'campanha_pausar', percent: null })]);
    expect(texto(registrou.frase)).toBe('Ele registrou 1 recomendação, sem mexer em nada. Em Sombra, nada aparece na Atenção: ele só compara com o que você fizer.');
    expect([registrou.aprovacoes, registrou.naAtencao]).toEqual([null, false]);
    expect([sugeriu.resumo, registrou.resumo]).toEqual(['Deixou 2 recomendações na Atenção hoje', 'Registrou 1 recomendação hoje, sem mexer em nada']);
    const nada = r([]);
    expect(texto(nada.frase)).toBe('Nenhuma campanha pediu mudança nesta rodada. Ele leu os resultados e comparou cada campanha com as regras.');
    expect(nada.passos.map((p) => p.texto)).toContain('Não registrou recomendação nova: nenhuma campanha pediu');
    const ontem = r([decisao({ decided_on: '2026-10-07' })], { last_run: { on: '2026-10-07', status: 'dado_velho', at: local(6, 31) } });
    expect([ontem.titulo, ontem.nota]).toEqual(['Última rodada', '07/10 · regras da sombra, versão 2']);
    expect(ontem.aviso).toBe('A última tentativa (hoje, 06:31) não rodou: os dados das contas não estavam em dia.');
    expect([nada.resumo, ontem.resumo, ontem.hoje]).toEqual(['Nenhuma campanha pediu mudança hoje', 'Deixou 1 recomendação na Atenção em 07/10', false]);
  });

  it('com a equipe parada, ninguém pede nada; sem a lista da sombra ou antes da primeira rodada, o bloco não aparece', () => {
    const parada = rodadaDoGestor(sombra([pedida]), itens, { stop: { id: uuid(95), level: 'tenant', by_company: true, since: local(9), reason: 'Equipe parada pela tela Sua equipe.', by: RODRIGO } }, AGORA)!;
    expect([parada.titulo, parada.nota, parada.passos, parada.aprovacoes]).toEqual(['Rodada de hoje', 'não rodou', [], null]);
    expect(texto(parada.frase)).toBe('Com a equipe parada, ele não recomenda nem pede nada. Os pedidos que já estavam em Aprovações continuam lá, mas nenhum é executado enquanto a equipe estiver parada.');
    expect(rodadaDoGestor(null, itens, SEM_PARADA, AGORA)).toBeNull();
    // Na lista de funcionários: o que ele fez na rodada, e "Concluído" quando ela foi hoje. Parado ou desligado, vale a situação de sempre.
    const gestor = { key: 'trafego', status: 'sombra' };
    expect(gestorNaLista(gestor, r([pedida]))).toEqual({ atividade: 'Pediu 1 mudança hoje', selo: { rotulo: 'Concluído', classe: 'st st--concluido', ponto: true } });
    expect(gestorNaLista(gestor, null)).toEqual({ atividade: 'Compara cada campanha com as regras, todo dia', selo: { rotulo: 'Em espera', classe: 'st st--espera', ponto: true } });
    expect(gestorNaLista({ key: 'trafego', status: 'parado' }, parada)).toBeNull();
    expect(gestorNaLista({ key: 'lia', status: 'sombra' }, r([pedida]))).toBeNull();
    expect(rodadaDoGestor(sombra([], { last_run: null }), itens, SEM_PARADA, AGORA)).toBeNull();
  });
});

describe('o histórico: os tipos do modo Aprovação', () => {
  const h = (over: Partial<TeamActivityItem>) => historicoDaAprovacao({ kind: 'pediu', subject: null, detail: null, count: null, by: null, mine: false, ...over });

  it('o pedido dele, a tentativa que não virou pedido, a proposta e a volta', () => {
    expect(h({ subject: 'Smash em dobro', detail: 'orcamento_reduzir', count: 10 })).toEqual({
      titulo: 'Pediu reduzir a verba em 10%: Smash em dobro',
      texto: 'Pedido feito por ele, no modo Aprovação. Só é executado depois que uma pessoa aprova com o código do app.',
    });
    expect(h({ kind: 'nao_pediu', subject: 'Smash em dobro', detail: 'plataforma_indisponivel' })).toEqual({
      titulo: 'Não conseguiu fazer o pedido: Smash em dobro',
      texto: 'A plataforma não respondeu na hora de ler a campanha, e sem essa leitura nada é pedido. A recomendação ficou na Atenção, com o motivo.',
    });
    expect(h({ kind: 'nao_pediu', detail: 'teto_nao_definido' })!.texto).toBe('Um limite ou uma regra da empresa não deixou o pedido entrar. A recomendação ficou na Atenção, com o motivo.');
    expect(h({ kind: 'aprovacao_proposta', subject: 'CA - Mister Burguer', detail: 'orcamento_reduzir' })).toEqual({
      titulo: 'O sistema propôs que ele mesmo peça: reduzir a verba',
      texto: 'CA - Mister Burguer: os sete portões passaram. Quem decide é uma pessoa.',
    });
    expect(h({ kind: 'aprovacao_aprovada', detail: 'orcamento_reduzir', mine: true })!.texto).toBe('Você aprovou. Ele passa a fazer o pedido; cada um espera a aprovação com o código do app.');
    expect(h({ kind: 'aprovacao_recusada', detail: 'campanha_pausar', by: RODRIGO })).toEqual({ titulo: 'Modo Aprovação recusado: pausar a campanha', texto: 'Rodrigo recusou. Ele segue em Sugerir nessa ação.' });
    expect(h({ kind: 'aprovacao_retirada', detail: 'orcamento_aumentar' })!.titulo).toBe('Proposta de Aprovação retirada: aumentar a verba');
    expect(h({ kind: 'saiu_da_aprovacao', detail: 'orcamento_reduzir' })).toEqual({
      titulo: 'De volta para Sugerir: reduzir a verba',
      texto: 'A ação voltou para Sugerir. Os pedidos que ele já tinha feito continuam esperando decisão.',
    });
    // Os tipos de sempre seguem com os textos de sempre.
    expect(h({ kind: 'recomendou' })).toBeNull();
  });
});

describe('a ficha do Gestor de tráfego com o modo Aprovação', () => {
  const nada = () => {};
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
  const equipe: TeamResponse = {
    brand_id: uuid(1),
    month: { from: '2026-10-01', to: '2026-10-31', timezone: 'America/Sao_Paulo' },
    ai: { enabled: true, spent_usd_micros: '4340000', ceiling_usd_micros: '20000000', band: 'livre' },
    usd_brl: { rate: '5.2238', date: '2026-10-07', source: 'bcb_ptax_venda' },
    stop: null,
    members: ['lia', 'analista', 'relatorios', 'compliance', 'estrategista', 'pesquisador', 'trafego'].map(membro),
    can_manage: true,
    can_stop: true,
    generated_at: AGORA.toISOString(),
  };
  function desenhar(a: AutonomyResponse, over: { modo?: Modo; sombra?: TeamShadowResponse | null; acoes?: Partial<AcoesDaProntidao> } = {}): string {
    return renderToStaticMarkup(
      createElement(EquipeConteudo, {
        t: equipe,
        autonomia: a,
        sombra: over.sombra === undefined ? sombra([pedida, sugerida]) : over.sombra,
        historicos: {},
        escolhido: 'trafego',
        mostraDetalhe: true,
        modo: over.modo ?? 'lite',
        agora: AGORA,
        nomeDaMarca: 'Mister Burgers',
        topo: { ocupado: null, parando: false, aoPedirParada: nada, aoParar: nada, aoRetomar: nada },
        membro: { ocupado: null, desligando: null, aoPedirDesligar: nada, aoDesligar: nada, aoLigar: nada, aoIrParaPro: nada, aoRecarregarHistorico: nada },
        prontidao: { ocupado: null, recusando: null, aoAprovar: nada, aoPedirRecusa: nada, aoRecusar: nada, aoVoltarParaSombra: nada, linha: null, voltando: null, aoEscolherLinha: nada, aoPedirVolta: nada, ...over.acoes },
        aoEscolher: nada,
        aoVoltar: nada,
      }),
    );
  }
  const TODAS = [comProposta, aumentar, pausar, google];

  it('no Lite: a rodada, o modo de cada conta e ação, a proposta da primeira linha e os limites do modo Aprovação', () => {
    const html = desenhar(autonomia(TODAS));
    const t = semTags(html);
    expect(t).toContain('Modo: por conta e ação');
    // A página e a lista: nada muda sem aprovação; ele sai do grupo "Em sombra" e a linha dele diz o que fez na rodada.
    expect(t).toContain('Nada muda numa campanha sem a aprovação de uma pessoa: quem cuida de anúncio começa em sombra e só faz mais quando você deixa.');
    expect(t).toContain('Trabalhando para você 7');
    expect(t).not.toContain('Em sombra');
    expect(t).toContain('Gestor de tráfego Pediu 1 mudança hoje Concluído');
    expect(t).toContain('O que ele faz com a recomendação depende do modo de cada conta e de cada ação');
    expect(t).toContain('Rodada de hoje');
    expect(html).toContain(`href="/aprovacoes?pedido=${uuid(90)}"`);
    expect(html).toContain('href="/atencao"');
    expect(t).toContain('Como ele trabalha em cada conta');
    expect(t).toContain('3 em Sugerir · 1 em Sombra');
    expect(html.match(/class="modos-item"/g)).toHaveLength(4);
    // A linha aberta é a primeira (a proposta pendente vem na frente).
    expect(html).toMatch(new RegExp(`id="eqp-linha-${META}:orcamento_reduzir" aria-current="true"`));
    expect(t).toContain('Proposta do sistema: Meta Ads · Reduzir a verba, de Sugerir para Aprovação');
    expect(t).toContain('Aprovar a promoção');
    expect(t).toContain('Fica registrado quem aprovou, quando e a versão da regra de autonomia. Dá para voltar um passo a qualquer momento.');
    expect(t).toContain('em Aprovação, faz o pedido de mudar a verba ou pausar, na Meta e no Google.');
    expect(t).toContain('No Google: o pedido é sempre na campanha inteira, com os mesmos limites da Meta (10% por pedido, teto por campanha e verba do mês).');
    expect(t).toContain('criar ou apagar campanha; mexer em verba dividida entre campanhas do Google.');
    expect(t).not.toContain('mexer no Google.');
    expect(t).toContain('Nunca: mudar qualquer coisa sem a aprovação de uma pessoa com o código do app');
    // No Lite não há portões nem tabela nem a legenda dos modos.
    expect(html).not.toContain('class="sinais"');
    expect(html).not.toContain('modos-legenda');
    expect(html).not.toContain('eqp-passos');
  });

  it('no Pro: os sete portões, a tabela de prontidão, a legenda dos modos e os passos da rodada', () => {
    const html = desenhar(autonomia(TODAS), { modo: 'pro' });
    const t = semTags(html);
    expect(html).toContain('class="portoes portoes--7"');
    expect(html.match(/<li><span class="s-(ok|alerta)">/g)).toHaveLength(7);
    expect(html).toContain('modos-legenda');
    expect(html).toContain('tabela--pilha');
    expect(t).toContain('Proposta esperando a decisão');
    expect(t).toContain('No Google, vai só até Sugerir');
    expect(t).toContain('Pediu reduzir a verba em 10% da campanha “Smash em dobro”');
    // A linha em Sombra tem cinco portões e nenhuma caixa.
    const emSombra = desenhar(autonomia(TODAS), { modo: 'pro', acoes: { linha: chaveDaLinha(pausar) } });
    expect(emSombra).toContain('class="portoes"');
    expect(emSombra.match(/<li><span class="s-(ok|alerta)">/g)).toHaveLength(5);
    expect(emSombra).not.toContain('class="promocao"');
    expect(semTags(emSombra)).toContain('Meta Ads · Pausar a campanha: Sombra');
  });

  it('quem não decide vê a proposta sem os botões; a volta e a recusa pedem confirmação na linha', () => {
    const soVe = desenhar(autonomia(TODAS, false));
    expect(soVe).not.toContain('Aprovar a promoção');
    expect(semTags(soVe)).toContain('Só o Dono e o Administrador aprovam a promoção e voltam um passo. Você acompanha por aqui.');
    const recusando = semTags(desenhar(autonomia(TODAS), { acoes: { recusando: uuid(80) } }));
    expect(recusando).toContain('Recusar a promoção? Ele segue em Sugerir nesta ação.');
    const aprovada = [emAprovacao, aumentar, pausar, google];
    const comBotao = desenhar(autonomia(aprovada));
    expect(semTags(comBotao)).toContain('Voltar para Sugerir');
    expect(comBotao).toContain(`id="eqp-bt-voltar-${META}:orcamento_reduzir"`);
    const voltando = semTags(desenhar(autonomia(aprovada), { acoes: { voltando: chaveDaLinha(emAprovacao) } }));
    expect(voltando).toContain('Ele volta a só mostrar a recomendação. Os pedidos que já fez continuam esperando.');
    // Em Aprovação, no Pro, a linha não mostra portões.
    expect(desenhar(autonomia(aprovada), { modo: 'pro' })).not.toContain('portoes-num');
  });

  it('a empresa sem o modo Aprovação segue com a tela de antes', () => {
    const { approval: _, ...semModo } = emSugerir;
    const html = desenhar(autonomia([semModo]));
    expect(html).not.toContain('eqp-modos');
    expect(html).not.toContain('eqp-rodada');
    expect(semTags(html)).toContain('Modo: Sombra e Sugerir');
    expect(semTags(html)).toContain('Nesta fase, ninguém mexe em campanha: quem cuida de anúncio trabalha em sombra');
    expect(semTags(html)).toContain('Em sombra 1');
    expect(semTags(html)).toContain('Nunca, nesta fase: pausar, mudar verba ou criar campanha.');
  });
});
