import { resolve } from 'node:path';
import type { TeamActivityItem, TeamActivityResponse, TeamMember, TeamResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { criarMarcador, indiceDasOrigens } from '../src/ai/conversa/fontes.js';
import { nomesDaLeitura, rotuloDaLeitura, rotuloDoPasso } from '../src/ai/conversa/leituras.js';
import { ESTRATEGISTA } from '../src/ai/estrategista/prompt.js';
import { carregarCasosDaConversa } from '../src/ai/evals/conversa.js';
import { LEITURAS, LEITURAS_DE_DADOS } from '../src/ai/registro/leituras.defs.js';
import { ACONTECIMENTOS_MAXIMO, DO_MEMBRO, NOME_DO_MEMBRO, visaoDaEquipe } from '../src/ai/registro/visoes/equipe.js';
import { limparTexto } from '../src/ai/sanitizar.js';
import { MEMBROS } from '../src/equipe/membros.js';

// "Conversar sobre ele" (A3, P7): a leitura `equipe_trabalho`. O que a LIA recebe de Sua equipe: os números da tela, já
// ditos como a tela diz, sem nome de colega. Sem banco.

const membro = (key: string, extra: Partial<TeamMember> = {}): TeamMember => ({
  key,
  kind: ['relatorios', 'compliance', 'trafego'].includes(key) ? 'regra' : 'ia',
  status: key === 'trafego' ? 'sombra' : 'ativo',
  working_now: false,
  can_pause: key !== 'compliance',
  paused: null,
  cost: { usd_micros: '0', calls: 0 },
  stats: [],
  ...extra,
});
const stat = (key: string, value: number | string, unit = 'qtd') => ({ key, value: String(value), unit });

const EQUIPE: TeamResponse = {
  brand_id: '01a10000-0000-7000-8000-000000000001',
  month: { from: '2026-10-01', to: '2026-10-31', timezone: 'America/Sao_Paulo' },
  ai: { enabled: true, spent_usd_micros: '4340000', ceiling_usd_micros: '20000000', band: 'livre' },
  usd_brl: { rate: '5.2238', date: '2026-10-02', source: 'ptax_venda' },
  stop: null,
  members: [
    membro('lia', { cost: { usd_micros: '1800000', calls: 131 }, stats: [stat('respostas', 61), stat('fez_sentido', 28), stat('discordo', 5), stat('demandas', 2), stat('retiradas_na_conferencia', 5)] }),
    membro('analista', { cost: { usd_micros: '1310000', calls: 57 }, stats: [stat('explicacoes', 1252), stat('fez_sentido', 34), stat('discordo', 3), stat('retiradas_na_conferencia', 5)] }),
    membro('relatorios', { stats: [stat('revisoes', 4), stat('com_leitura_da_ia', 3), stat('so_do_sistema', 1)] }),
    membro('compliance', { cost: { usd_micros: '260000', calls: 130 }, stats: [stat('textos_conferidos', 138), stat('textos_barrados', 9)] }),
    membro('estrategista', { working_now: true, stats: [stat('planos_aprovados', 2), stat('planos_recusados', 1), stat('planos_esperando', 1), stat('em_preparo', 1), stat('retiradas_na_conferencia', 0)] }),
    membro('pesquisador', {
      status: 'desligado',
      paused: { by: { id: '01a10000-0000-7000-8000-000000000002', name: 'Juliana Prado' }, at: '2026-09-30T21:20:00.000Z', reason: 'não quero que ele leia o site dos concorrentes por enquanto' },
      stats: [stat('paginas_lidas', 3), stat('recusadas', 1), stat('sugestoes', 2), stat('retiradas_na_conferencia', 1)],
    }),
    membro('trafego', { stats: [stat('recomendacoes', 26), stat('comparaveis', 19), stat('mesma_direcao', 15), stat('arrependimento', '-41200000', 'brl_micros')] }),
  ],
  can_manage: true,
  can_stop: true,
  generated_at: '2026-10-03T21:00:00.000Z',
};

const JULIANA = { id: '01a10000-0000-7000-8000-000000000002', name: 'Juliana Prado' };
const RODRIGO = { id: '01a10000-0000-7000-8000-000000000003', name: 'Rodrigo Teixeira' };
const item = (extra: Partial<TeamActivityItem>): TeamActivityItem => ({ at: '2026-10-03T18:00:00.000Z', kind: 'explicou_resultados', subject: null, detail: null, period: null, count: null, rules: [], by: null, mine: false, feedback: null, ...extra });
const atividade = (member: string, items: TeamActivityItem[], has_more = false): TeamActivityResponse => ({ brand_id: EQUIPE.brand_id, member, since: '2026-07-05T21:00:00.000Z', items, has_more, generated_at: EQUIPE.generated_at });
const ver = (member: string, items: TeamActivityItem[], equipe: TeamResponse = EQUIPE) => visaoDaEquipe(equipe, atividade(member, items), 'America/Sao_Paulo') as Record<string, any>;
/** Os acontecimentos sem a hora (a mesma em todos), para comparar o que a visão diz de cada um. */
const semHora = (v: Record<string, any>) => v.ultimos_acontecimentos.map(({ quando, ...resto }: Record<string, unknown>) => resto);

describe('a leitura `equipe_trabalho`: o que a LIA recebe de Sua equipe (A3, P7)', () => {
  it('a equipe inteira: a situação, o custo como a tela mostra (em reais pela PTAX) e o que cada um fez no mês', () => {
    const v = visaoDaEquipe(EQUIPE, null, 'America/Sao_Paulo') as Record<string, any>;
    expect(v.mes).toBe('01/10/2026 a 31/10/2026');
    expect(v.ia_da_empresa).toEqual({ ligada: 'sim', gasto_no_mes: 'R$ 22,67', teto_do_mes: 'R$ 104,48', situacao_do_teto: 'dentro do teto' });
    expect(v.valores).toBe('em reais, aproximados, pela PTAX de venda do Banco Central de 02/10/2026; o custo e o teto de IA são medidos em dólar');
    expect(v.equipe.map((m: { funcionario: string }) => m.funcionario)).toEqual(['LIA', 'Analista de dados', 'Relatórios', 'Compliance', 'Estrategista', 'Pesquisador', 'Gestor de tráfego']);
    // O Analista: os mesmos números da tela (R$ 6,84 pelo dólar a 5,2238; o milhar com ponto).
    expect(v.equipe[1]).toEqual({
      funcionario: 'Analista de dados',
      situacao: 'ativo',
      trabalha: 'com um modelo de IA',
      custo_de_ia_no_mes: 'R$ 6,84',
      chamadas_ao_modelo_no_mes: '57',
      no_mes: { explicacoes_que_chegaram_a_pessoa: '1.252', marcadas_fez_sentido: '34', marcadas_discordo: '3', respostas_retiradas_na_conferencia: '5' },
    });
    expect(v.equipe[2].no_mes).toEqual({ revisoes_da_semana: '4', revisoes_com_a_leitura_da_lia: '3', revisoes_sem_a_leitura_da_lia: '1' });
    // O Compliance trabalha por regras: o custo de IA dele é o do revisor de IA, e a visão diz.
    expect(v.equipe[3]).toMatchObject({
      funcionario: 'Compliance',
      trabalha: 'por regras do sistema; o custo de IA é do revisor de IA, que lê o texto depois das regras',
      custo_de_ia_no_mes: 'R$ 1,36',
      no_mes: { textos_conferidos: '138', textos_barrados: '9' },
    });
    // No Estrategista e no Pesquisador, o que a conferência não deixou aparecer é "texto", não "resposta".
    expect(v.equipe[4]).toMatchObject({ trabalhando_agora: 'sim', no_mes: { planos_esperando_a_decisao: '1', planos_em_preparo: '1', textos_retirados_na_conferencia: '0' } });
    expect(v.equipe[5].no_mes).toEqual({ paginas_lidas: '3', paginas_que_nao_pode_ler: '1', sugestoes_para_minha_marca: '2', textos_retirados_na_conferencia: '1' });
    // O Gestor de tráfego em sombra: a soma vem como a frase da tela, sem número negativo solto.
    expect(v.equipe[6]).toMatchObject({
      situacao: 'em sombra: registra o que faria, sem mexer em nada',
      trabalha: 'por regras do sistema',
      no_mes: {
        recomendacoes_em_sombra: '26',
        recomendacoes_que_ja_da_para_comparar: '19',
        em_que_a_empresa_fez_o_mesmo_ou_foi_na_mesma_direcao: '15',
        comparacao_com_o_que_foi_feito: 'as recomendações teriam rendido R$ 41,20 a mais do que o que foi feito',
      },
    });
    // Sem pergunta sobre um funcionário, não vão acontecimentos; sem parada, não vai a parada.
    expect(v).not.toHaveProperty('ultimos_acontecimentos');
    expect(v).not.toHaveProperty('acontecimentos_desde');
    expect(v).not.toHaveProperty('equipe_parada');
    // Como as outras leituras: datas, dinheiro e contagens já formatados, nada que a limpeza de dado pessoal coma.
    expect(limparTexto(JSON.stringify(v)).removidos).toBe(0);
  });

  it('a soma da sombra, como a frase da tela: a menos, no mesmo e quando ainda não dá para comparar', () => {
    const trafego = (stats: TeamMember['stats']) => (visaoDaEquipe({ ...EQUIPE, members: [membro('trafego', { stats })] }, null, 'UTC') as Record<string, any>).equipe[0].no_mes.comparacao_com_o_que_foi_feito;
    expect(trafego([stat('recomendacoes', 4), stat('comparaveis', 2), stat('mesma_direcao', 1), stat('arrependimento', '18000000', 'brl_micros')])).toBe('as recomendações teriam rendido R$ 18,00 a menos do que o que foi feito');
    expect(trafego([stat('recomendacoes', 4), stat('comparaveis', 2), stat('mesma_direcao', 2), stat('arrependimento', '0', 'brl_micros')])).toBe('as recomendações dariam no mesmo que o que foi feito');
    expect(trafego([stat('recomendacoes', 4), stat('comparaveis', 0), stat('mesma_direcao', 0), stat('arrependimento', '0', 'brl_micros')])).toBe(
      'ainda não dá para comparar nenhuma: a comparação sai 7 dias depois de cada recomendação',
    );
  });

  it('nome de colega nunca vai ao modelo: quem desligou, pediu ou decidiu aparece sem o nome', () => {
    const v = ver('pesquisador', [
      item({ kind: 'desligado', by: JULIANA }),
      item({ kind: 'leu_pagina', subject: 'misterburgers.example', detail: 'concorrente', count: 2, by: RODRIGO, mine: true }),
      item({ kind: 'leu_pagina', subject: 'pizzariadapraca.example', count: 0, by: JULIANA }),
      item({ kind: 'pagina_recusada', subject: 'fechado.example', detail: 'robots', by: JULIANA }),
      item({ kind: 'pagina_falhou', subject: 'lento.example', detail: 'fora_do_ar', by: RODRIGO, mine: true }),
      item({ kind: 'ligado', by: RODRIGO, mine: true }),
    ]);
    const texto = JSON.stringify(v);
    expect(texto).not.toContain('Juliana');
    expect(texto).not.toContain('Rodrigo');
    // Com `funcionario`, a lista traz só ele; o motivo de estar desligado é o que a empresa escreveu (já sem dado pessoal).
    expect(v.equipe).toHaveLength(1);
    expect(v.equipe[0]).toMatchObject({
      funcionario: 'Pesquisador',
      situacao: 'desligado pela empresa nesta marca',
      desligado_desde: '30/09/2026 18:20',
      motivo_de_estar_desligado: 'não quero que ele leia o site dos concorrentes por enquanto',
    });
    // "O que fez" olha os últimos 90 dias: o dia em que a lista começa vai junto.
    expect(v.acontecimentos_desde).toBe('05/07/2026');
    expect(v.ultimos_acontecimentos[0]).toEqual({ quando: '03/10/2026 15:00', o_que: 'foi desligado pela empresa nesta marca', quem_decidiu: 'outra pessoa da empresa' });
    expect(semHora(v).slice(1)).toEqual([
      // O número da página lida é o de partes de Minha marca que ganharam sugestão; o tipo da página não vai.
      { o_que: 'leu uma página', site: 'misterburgers.example', partes_de_minha_marca_com_sugestao: '2', quem_pediu: 'você' },
      { o_que: 'leu uma página', site: 'pizzariadapraca.example', resultado: 'não achou o que sugerir', quem_pediu: 'outra pessoa da empresa' },
      { o_que: 'não leu uma página', site: 'fechado.example', motivo: 'o site pede para não ser lido por robôs', quem_pediu: 'outra pessoa da empresa' },
      { o_que: 'não conseguiu ler uma página', site: 'lento.example', motivo: 'o site estava fora do ar', quem_pediu: 'você' },
      { o_que: 'foi ligado de novo pela empresa', quem_decidiu: 'você' },
    ]);
    expect(limparTexto(texto).removidos).toBe(0);
  });

  it('cada acontecimento leva o campo do que ele é: os textos barrados, a versão do plano, o percentual da recomendação', () => {
    // LIA e Analista: a conversa pelo nome só para a própria pessoa; o retorno diz quem marcou.
    expect(
      semHora(
        ver('lia', [
          item({ kind: 'respondeu', subject: 'Como foi a semana?', mine: true, by: RODRIGO, feedback: 'fez_sentido' }),
          item({ kind: 'respondeu' }),
          item({ kind: 'abriu_demanda', subject: 'Promoção de terça', detail: 'promocao', by: JULIANA }),
          item({ kind: 'retirada_na_conferencia', detail: 'numero_fora', count: 1 }),
          item({ kind: 'explicou_aviso', feedback: 'discordo' }),
        ]),
      ),
    ).toEqual([
      { o_que: 'respondeu a uma pergunta na conversa', conversa: 'Como foi a semana?', quem_perguntou: 'você', retorno: 'você marcou "Fez sentido"' },
      { o_que: 'respondeu a uma pergunta na conversa' },
      { o_que: 'abriu uma demanda e a entregou ao Estrategista', demanda: 'Promoção de terça', tipo_de_pedido: 'promoção', quem_pediu: 'outra pessoa da empresa' },
      { o_que: 'teve um texto retirado na conferência, antes de aparecer', motivo: 'citava um número que o sistema não calculou' },
      { o_que: 'explicou um aviso da Atenção', retorno: 'marcada "Discordo"' },
    ]);

    // Relatórios: a semana, quem escreveu a leitura e para quantas pessoas o e-mail foi (uma também conta).
    expect(
      semHora(
        ver('relatorios', [
          item({ kind: 'gerou_revisao', detail: 'lia', period: { from: '2026-09-22', to: '2026-09-28' } }),
          item({ kind: 'gerou_revisao', detail: 'sistema', period: { from: '2026-09-15', to: '2026-09-21' } }),
          item({ kind: 'enviou_revisao', period: { from: '2026-09-22', to: '2026-09-28' }, count: 4 }),
          item({ kind: 'enviou_revisao', period: { from: '2026-09-15', to: '2026-09-21' }, count: 1 }),
        ]),
      ),
    ).toEqual([
      { o_que: 'gerou a revisão da semana', semana: '22/09/2026 a 28/09/2026', leitura: 'com a leitura da LIA' },
      { o_que: 'gerou a revisão da semana', semana: '15/09/2026 a 21/09/2026', leitura: 'com o resumo do sistema, sem a leitura da LIA' },
      { o_que: 'enviou a revisão da semana por e-mail', semana: '22/09/2026 a 28/09/2026', pessoas_que_receberam: '4' },
      { o_que: 'enviou a revisão da semana por e-mail', semana: '15/09/2026 a 21/09/2026', pessoas_que_receberam: '1' },
    ]);

    // Compliance: de quem era o texto, quantos de uma vez e a regra (ou o que o revisor de IA apontou).
    expect(
      semHora(
        ver('compliance', [
          item({ kind: 'barrou_texto', detail: 'lia', count: 1, rules: ['tom'] }),
          item({ kind: 'barrou_texto', detail: 'analista', count: 3, rules: ['promessa_de_resultado', 'regra_da_marca', 'regra_nova'] }),
          item({ kind: 'retirada_na_conferencia', detail: 'revisor_sem_resposta', count: 2 }),
          item({ kind: 'retirada_na_conferencia', detail: 'codigo_novo', count: 1 }),
        ]),
      ),
    ).toEqual([
      { o_que: 'barrou um texto antes de ele aparecer', escrito_por: 'LIA', regras: ['o revisor de IA apontou o tom'] },
      { o_que: 'barrou textos antes de eles aparecerem', quantos_textos: '3', escrito_por: 'Analista de dados', regras: ['promessa de resultado', 'regra da marca', 'regra nova'] },
      { o_que: 'teve textos retirados na conferência, antes de aparecerem', quantos_textos: '2', motivo: 'o revisor de IA não respondeu, e sem a revisão dele o texto não aparece' },
      { o_que: 'teve um texto retirado na conferência, antes de aparecer', motivo: 'não passou na conferência do código' },
    ]);

    // Estrategista: o número do plano é a versão (a primeira não vai), e o tipo do plano não é o tipo do pedido.
    expect(
      semHora(
        ver('estrategista', [
          item({ kind: 'recebeu_demanda', subject: 'Pauta de outubro', detail: 'pauta', by: RODRIGO, mine: true }),
          item({ kind: 'montou_plano', subject: 'Pauta de outubro', detail: 'pauta', count: 1 }),
          item({ kind: 'plano_nova_analise', subject: 'Pauta de outubro', detail: 'pauta', by: JULIANA }),
          item({ kind: 'montou_plano', subject: 'Pauta de outubro', detail: 'pauta', count: 2 }),
          item({ kind: 'plano_aprovado', subject: 'Pauta de outubro', detail: 'pauta', by: RODRIGO, mine: true }),
          item({ kind: 'plano_recusado', subject: null, detail: 'noventa_dias', by: JULIANA }),
        ]),
      ),
    ).toEqual([
      { o_que: 'recebeu uma demanda', demanda: 'Pauta de outubro', tipo_de_pedido: 'pauta', quem_pediu: 'você' },
      { o_que: 'montou um plano e o mandou para Aprovações', plano: 'Pauta de outubro', tipo_de_plano: 'pauta da semana' },
      { o_que: 'recebeu o pedido de outra versão de um plano', plano: 'Pauta de outubro', tipo_de_plano: 'pauta da semana', quem_pediu: 'outra pessoa da empresa' },
      { o_que: 'montou um plano e o mandou para Aprovações', plano: 'Pauta de outubro', tipo_de_plano: 'pauta da semana', versao_do_plano: '2' },
      { o_que: 'teve um plano aprovado', plano: 'Pauta de outubro', tipo_de_plano: 'pauta da semana', quem_decidiu: 'você' },
      { o_que: 'teve um plano recusado, com o motivo guardado', tipo_de_plano: 'plano de 90 dias', quem_decidiu: 'outra pessoa da empresa' },
    ]);

    // Gestor de tráfego: o número da recomendação é o percentual da verba; o da proposta, as decisões comparáveis.
    expect(
      semHora(
        ver('trafego', [
          item({ kind: 'recomendou', subject: 'Combo sexta', detail: 'orcamento_reduzir', count: 20 }),
          item({ kind: 'recomendou', subject: 'Almoço executivo', detail: 'campanha_pausar' }),
          item({ kind: 'comparou', subject: 'Combo sexta', detail: 'teria_melhorado' }),
          item({ kind: 'promocao_proposta', subject: 'CA - Pizzaria da Praça', detail: 'orcamento_reduzir', count: 14 }),
          item({ kind: 'promocao_aprovada', subject: 'CA - Pizzaria da Praça', detail: 'orcamento_reduzir', by: RODRIGO, mine: true }),
          item({ kind: 'promocao_recusada', subject: 'CA - Pizzaria da Praça', detail: 'campanha_pausar', by: JULIANA }),
          item({ kind: 'promocao_retirada', subject: 'CA - Pizzaria da Praça', detail: 'orcamento_aumentar' }),
          item({ kind: 'voltou_para_sombra', subject: 'CA - Pizzaria da Praça', detail: 'orcamento_reduzir', by: JULIANA }),
        ]),
      ),
    ).toEqual([
      { o_que: 'registrou uma recomendação em sombra: nada mudou na plataforma', campanha: 'Combo sexta', recomendacao: 'reduzir a verba em 20%' },
      { o_que: 'registrou uma recomendação em sombra: nada mudou na plataforma', campanha: 'Almoço executivo', recomendacao: 'pausar a campanha' },
      { o_que: 'comparou uma recomendação com o que foi feito', campanha: 'Combo sexta', resultado: 'a recomendação teria rendido mais do que o que foi feito' },
      { o_que: 'o sistema propôs mostrar as recomendações de uma ação na Atenção; quem decide é uma pessoa', conta: 'CA - Pizzaria da Praça', acao: 'reduzir a verba', decisoes_comparaveis: '14' },
      { o_que: 'teve a proposta aprovada: as recomendações dessa ação aparecem na Atenção', conta: 'CA - Pizzaria da Praça', acao: 'reduzir a verba', quem_decidiu: 'você' },
      { o_que: 'teve a proposta recusada: segue em sombra nessa ação', conta: 'CA - Pizzaria da Praça', acao: 'pausar a campanha', quem_decidiu: 'outra pessoa da empresa' },
      { o_que: 'teve a proposta retirada: os portões deixaram de passar antes de alguém decidir', conta: 'CA - Pizzaria da Praça', acao: 'aumentar a verba' },
      { o_que: 'voltou para a sombra nessa ação: nada mais aparece na Atenção por ele', conta: 'CA - Pizzaria da Praça', acao: 'reduzir a verba', quem_decidiu: 'outra pessoa da empresa' },
    ]);

    // O que a visão ainda não conhece vira um registro genérico: código nenhum vai ao modelo.
    expect(semHora(ver('analista', [item({ kind: 'acontecimento_novo', subject: 'Combo sexta', detail: 'codigo_novo', count: 7 })]))).toEqual([{ o_que: 'registrou um trabalho', assunto: 'Combo sexta' }]);
  });

  it('no máximo doze acontecimentos, com o aviso de que há mais; sem nenhum, a visão diz desde quando', () => {
    const muitos = ver('analista', Array.from({ length: 20 }, () => item({})));
    expect(muitos.ultimos_acontecimentos).toHaveLength(ACONTECIMENTOS_MAXIMO);
    expect(muitos.ha_mais_acontecimentos).toBe('sim');
    expect(limparTexto(JSON.stringify(muitos)).removidos).toBe(0);
    const nenhum = ver('analista', []);
    expect(nenhum.ultimos_acontecimentos).toBe('nenhum desde 05/07/2026');
    expect(nenhum).not.toHaveProperty('ha_mais_acontecimentos');
    expect(visaoDaEquipe(EQUIPE, atividade('analista', [item({})], true), 'America/Sao_Paulo')).toMatchObject({ ha_mais_acontecimentos: 'sim' });
  });

  it('sem cotação, o custo vai em dólar; com a equipe parada e a IA desligada, a visão diz', () => {
    const v = visaoDaEquipe(
      { ...EQUIPE, usd_brl: null, ai: { ...EQUIPE.ai, enabled: false }, stop: { id: '01a10000-0000-7000-8000-000000000009', level: 'tenant', by_company: true, since: '2026-10-03T20:42:00.000Z', reason: 'Revisando os textos da semana', by: JULIANA } },
      null,
      'America/Sao_Paulo',
    ) as Record<string, any>;
    // Com a IA desligada, o teto não tem situação a dizer.
    expect(v.ia_da_empresa).toEqual({ ligada: 'não', gasto_no_mes: 'US$ 4,34', teto_do_mes: 'US$ 20,00' });
    expect(v.valores).toBe('em dólar (ainda sem cotação de referência)');
    expect(v.equipe[0].custo_de_ia_no_mes).toBe('US$ 1,80');
    expect(v.equipe_parada).toEqual({ desde: '03/10/2026 17:42', por: 'a empresa', motivo: 'Revisando os textos da semana' });
    expect(JSON.stringify(v)).not.toContain('Juliana');
    // A parada da Liame: sem pessoa, e a hora no fuso da empresa.
    const daLiame = { id: '01a10000-0000-7000-8000-000000000009', level: 'global', by_company: false, since: '2026-10-03T20:42:00.000Z', reason: 'Manutenção', by: null };
    expect((visaoDaEquipe({ ...EQUIPE, stop: daLiame }, null, 'UTC') as Record<string, any>).equipe_parada).toEqual({ desde: '03/10/2026 20:42', por: 'a Liame', motivo: 'Manutenção' });
  });

  it('o teto de IA, como o aviso do topo da tela: a faixa é a pior entre o dia e o mês', () => {
    const teto = (band: string, spent: string) => (visaoDaEquipe({ ...EQUIPE, ai: { enabled: true, spent_usd_micros: spent, ceiling_usd_micros: '20000000', band } }, null, 'UTC') as Record<string, any>).ia_da_empresa.situacao_do_teto;
    // O gasto do mês explica a faixa: foi o teto da empresa.
    expect(teto('alerta', '14000000')).toBe('o uso de IA do mês passou de 70% do teto da empresa: perto do teto, as respostas ficam mais curtas; no teto, os funcionários de IA param até o mês virar');
    expect(teto('economico', '16000000')).toBe('o uso de IA do mês passou de 80% do teto da empresa: perto do teto, as respostas ficam mais curtas; no teto, os funcionários de IA param até o mês virar');
    expect(teto('bloqueado', '20000000')).toBe('o uso de IA do mês chegou ao teto da empresa: os funcionários de IA param até o mês virar');
    // O gasto do mês não explica a faixa: quem passou foi o teto do dia.
    expect(teto('economico', '4340000')).toBe('o uso de IA de hoje passou de 80% do teto do dia: perto do teto, as respostas ficam mais curtas; no teto, os funcionários de IA param até o dia virar');
    expect(teto('bloqueado', '4340000')).toBe('o uso de IA de hoje chegou ao teto do dia: os funcionários de IA param até o dia virar');
  });

  it('a fonte de cada número é o lugar dele na leitura, com o funcionário e o acontecimento pelo nome', () => {
    const v = ver('trafego', [
      item({ kind: 'recomendou', subject: 'Combo sexta', detail: 'orcamento_reduzir', count: 20 }),
      item({ kind: 'promocao_proposta', subject: 'CA - Pizzaria da Praça', detail: 'orcamento_reduzir', count: 14 }),
      item({ at: '2026-10-02T12:30:00.000Z', kind: 'enviou_revisao', period: { from: '2026-09-22', to: '2026-09-28' }, count: 4 }),
    ]);
    // O mesmo marcador da conversa: a resposta da LIA, com a fonte que o código dá a cada número.
    const nomes = nomesDaLeitura(v);
    const { marcar, numbers } = criarMarcador(indiceDasOrigens([{ rotulo: 'Sua equipe', valor: v, comCaminho: true, ordem: 1 }]), nomes);
    marcar('Em outubro, ele registrou 26 recomendações; na soma, elas teriam rendido R$ 41,20 a mais. O teto de IA do mês é R$ 104,48.');
    marcar('Na campanha Combo sexta, ele recomendou reduzir a verba em 20%.');
    marcar('Na conta CA - Pizzaria da Praça, a proposta saiu com 14 decisões comparáveis.');
    marcar('A revisão da semana foi por e-mail para 4 pessoas.');
    expect(numbers).toEqual([
      { value: '26', sources: ['Sua equipe · Gestor de tráfego · no mês · recomendações em sombra'] },
      { value: 'R$ 41,20', sources: ['Sua equipe · Gestor de tráfego · no mês · comparação com o que foi feito'] },
      { value: 'R$ 104,48', sources: ['Sua equipe · IA da empresa · teto do mês'] },
      // A campanha e a conta falam por si; o acontecimento sem nome, pelo dia e pelo que foi.
      { value: '20%', sources: ['Sua equipe · campanha "Combo sexta" · recomendação'] },
      { value: '14', sources: ['Sua equipe · conta "CA - Pizzaria da Praça" · decisões comparáveis'] },
      { value: '4', sources: ['Sua equipe · 02/10/2026 09:30, enviou a revisão da semana por e-mail · pessoas que receberam'] },
    ]);
    // Os nomes que vieram dos dados da empresa (número dentro deles é nome, não valor).
    expect([...nomes].sort()).toEqual(['CA - Pizzaria da Praça', 'Combo sexta']);
    expect(nomesDaLeitura(ver('estrategista', [item({ kind: 'montou_plano', subject: 'Plano de 90 dias da loja 2', detail: 'noventa_dias' })]))).toEqual(['Plano de 90 dias da loja 2']);
  });

  it('os casos do eval da conversa guardam a visão que o servidor produz (mudou a visão, regrave os casos)', () => {
    // A equipe dos casos: o mês de outubro com os sete funcionários, o Pesquisador ativo e sem trabalho.
    const doEval: TeamResponse = {
      ...EQUIPE,
      members: [
        EQUIPE.members[0]!,
        membro('analista', { cost: { usd_micros: '1310000', calls: 57 }, stats: [stat('explicacoes', 52), stat('fez_sentido', 34), stat('discordo', 3), stat('retiradas_na_conferencia', 5)] }),
        EQUIPE.members[2]!,
        EQUIPE.members[3]!,
        membro('estrategista', { cost: { usd_micros: '970000', calls: 18 }, stats: [stat('planos_aprovados', 2), stat('planos_recusados', 1), stat('planos_esperando', 1), stat('em_preparo', 1), stat('retiradas_na_conferencia', 0)] }),
        membro('pesquisador', { stats: [stat('paginas_lidas', 0), stat('recusadas', 0), stat('sugestoes', 0), stat('retiradas_na_conferencia', 0)] }),
        EQUIPE.members[6]!,
      ],
    };
    const casos = carregarCasosDaConversa(resolve(process.cwd(), '../../evals/conversa_lia/casos.jsonl'));
    const gravada = (id: string) => casos.find((c) => c.id === id)!.leituras.equipe_trabalho;
    const daEquipe = visaoDaEquipe(doEval, null, 'America/Sao_Paulo');
    expect(gravada('equipe-custo-por-dia')).toEqual(daEquipe);
    expect(gravada('equipe-desligar')).toEqual(daEquipe);
    expect(gravada('equipe-o-que-fez')).toEqual(
      ver(
        'analista',
        [
          item({ at: '2026-10-03T17:05:00.000Z', kind: 'explicou_resultados', by: RODRIGO, mine: true, feedback: 'fez_sentido' }),
          item({ at: '2026-10-03T12:12:00.000Z', kind: 'explicou_aviso' }),
          item({ at: '2026-10-02T21:40:00.000Z', kind: 'retirada_na_conferencia', detail: 'numero_fora', count: 1 }),
        ],
        doEval,
      ),
    );
    expect(gravada('equipe-sombra-nao-mexeu')).toEqual(
      ver(
        'trafego',
        [
          item({ at: '2026-10-03T09:40:00.000Z', kind: 'recomendou', subject: 'Combo sexta', detail: 'orcamento_reduzir', count: 20 }),
          item({ at: '2026-10-02T09:41:00.000Z', kind: 'comparou', subject: 'Almoço executivo', detail: 'teria_melhorado' }),
          item({ at: '2026-10-01T09:38:00.000Z', kind: 'recomendou', subject: 'Almoço executivo', detail: 'campanha_pausar' }),
        ],
        doEval,
      ),
    );
    // Todo caso que grava a leitura da equipe está nesta guarda.
    expect(casos.filter((c) => 'equipe_trabalho' in c.leituras).map((c) => c.id).sort()).toEqual(['equipe-custo-por-dia', 'equipe-desligar', 'equipe-o-que-fez', 'equipe-sombra-nao-mexeu']);
  });

  it('o Criativo (A4 · P12): só trabalha a pedido; as peças com o nome de quando são, o que escreve agora, por que não pode escrever e os acontecimentos dele', () => {
    const pecas = [stat('pedidos', 2), stat('pecas_escritas', 5), stat('pecas_aprovadas', 2), stat('pecas_recusadas', 0), stat('versoes_refeitas', 1), stat('pecas_hoje', 3), stat('pecas_esperando', 2), stat('pecas_barradas', 1), stat('retiradas_na_conferencia', 1)];
    const comCriativo = (extra: Partial<TeamMember> = {}): TeamResponse => ({ ...EQUIPE, members: [...EQUIPE.members, membro('criativo', { cost: { usd_micros: '30000', calls: 3 }, stats: pecas, in_progress: null, blocked_by: null, ...extra })] });
    const doCriativo = (t: TeamResponse) => (visaoDaEquipe(t, null, 'America/Sao_Paulo') as Record<string, any>).equipe.find((m: { funcionario: string }) => m.funcionario === 'Criativo');
    expect(doCriativo(comCriativo())).toEqual({
      funcionario: 'Criativo',
      situacao: 'ativo',
      trabalha: 'com um modelo de IA, só quando alguém pede uma peça na tela Criativos',
      custo_de_ia_no_mes: 'R$ 0,16',
      chamadas_ao_modelo_no_mes: '3',
      no_mes: {
        pedidos_de_pecas_atendidos_no_mes: '2',
        pecas_escritas_no_mes: '5',
        pecas_do_mes_aprovadas_por_uma_pessoa: '2',
        pecas_do_mes_recusadas_por_uma_pessoa: '0',
        outras_versoes_escritas_a_pedido_no_mes: '1',
        pecas_escritas_hoje: '3',
        pecas_esperando_a_decisao_de_uma_pessoa_agora: '2',
        pecas_barradas_na_conferencia_agora: '1',
        textos_retirados_na_conferencia: '1',
      },
    });
    // Escrevendo: o que e desde quando, sem o nome de quem pediu.
    const escrevendo = doCriativo(comCriativo({ working_now: true, in_progress: { subject: 'Combo sexta por R$ 34,90', count: 3, by: RODRIGO, since: '2026-10-03T17:20:00.000Z' } }));
    expect(escrevendo).toMatchObject({ trabalhando_agora: 'sim', escrevendo_agora: { o_que: 'peças novas', pecas_pedidas: '3', oferta: 'Combo sexta por R$ 34,90', pedido_feito: '03/10/2026 14:20' } });
    expect(JSON.stringify(escrevendo)).not.toContain('Rodrigo');
    expect(doCriativo(comCriativo({ working_now: true, in_progress: { subject: null, count: null, by: JULIANA, since: '2026-10-03T17:20:00.000Z' } })).escrevendo_agora).toEqual({ o_que: 'outra versão de uma peça', pedido_feito: '03/10/2026 14:20' });
    // Ligado e sem poder escrever: o porquê, como a ficha diz.
    expect(doCriativo(comCriativo({ blocked_by: 'sem_oferta' })).nao_pode_escrever_agora).toBe('Minha marca ainda não tem oferta: ele parte de uma oferta de lá, e não inventa oferta nem preço');
    expect(doCriativo(comCriativo({ blocked_by: 'limite_de_ia_do_dia' })).nao_pode_escrever_agora).toContain('volta amanhã');
    expect(doCriativo(comCriativo({ blocked_by: 'limite_de_ia_do_mes' })).nao_pode_escrever_agora).toContain('volta quando o mês virar');
    expect(doCriativo(comCriativo({ blocked_by: 'motivo_novo' })).nao_pode_escrever_agora).toBe('motivo novo');
    expect(doCriativo(comCriativo())).not.toHaveProperty('nao_pode_escrever_agora');
    // Não ligado pela Liame: a situação diz que é a chave dele, e não a sombra.
    expect(doCriativo(comCriativo({ status: 'desligado_pela_liame' })).situacao).toBe('desligado pela Liame (a IA ou o Criativo não está ligado para a empresa)');
    // Os outros funcionários não ganham os campos do Criativo, e a situação deles segue como era.
    const daLia = (visaoDaEquipe(comCriativo(), null, 'America/Sao_Paulo') as Record<string, any>).equipe[0];
    expect(daLia).not.toHaveProperty('escrevendo_agora');
    expect(daLia.trabalha).toBe('com um modelo de IA');

    // Os acontecimentos: cada um com o campo do que ele é, e sem o nome de quem pediu ou decidiu.
    const v = ver('criativo', [
      item({ kind: 'escreveu_pecas', subject: 'Combo sexta por R$ 34,90', count: 3, barred: 1, by: RODRIGO, mine: true }),
      item({ kind: 'escreveu_pecas', subject: null, count: 1, barred: 0, by: JULIANA }),
      item({ kind: 'refez_peca', subject: 'Sexta é dia de combo', count: 2, detail: 'aviso', by: RODRIGO, mine: true }),
      item({ kind: 'pedido_recusado', subject: 'Smash e chope por R$ 39,90', detail: 'bebida_alcoolica', by: JULIANA }),
      item({ kind: 'pedido_falhou', detail: 'ia_fora_do_ar', by: RODRIGO, mine: true }),
      item({ kind: 'peca_aprovada', subject: 'Sexta é dia de combo', count: 2, by: JULIANA }),
      item({ kind: 'peca_recusada', subject: 'Combo no capricho', by: RODRIGO, mine: true }),
      item({ kind: 'peca_contestada', subject: 'Entrega em 20 minutos', by: JULIANA }),
    ], comCriativo());
    expect(semHora(v)).toEqual([
      { o_que: 'escreveu peças de anúncio, a pedido', oferta: 'Combo sexta por R$ 34,90', pecas_escritas: '3', barradas_na_conferencia: '1', quem_pediu: 'você' },
      { o_que: 'escreveu uma peça de anúncio, a pedido', pecas_escritas: '1', quem_pediu: 'outra pessoa da empresa' },
      { o_que: 'escreveu outra versão de uma peça, a pedido', peca: 'Sexta é dia de combo', versao_da_peca: '2', conferencia: 'passou na conferência, com um aviso', quem_pediu: 'você' },
      { o_que: 'não atendeu um pedido de peça', oferta: 'Smash e chope por R$ 39,90', motivo: 'ele não escreve anúncio de bebida alcoólica', quem_pediu: 'outra pessoa da empresa' },
      { o_que: 'não conseguiu atender um pedido de peça', motivo: 'a IA não respondeu', quem_pediu: 'você' },
      { o_que: 'teve uma peça aprovada: ela está na biblioteca', peca: 'Sexta é dia de combo', quem_decidiu: 'outra pessoa da empresa' },
      { o_que: 'teve uma peça recusada, com o motivo guardado', peca: 'Combo no capricho', quem_decidiu: 'você' },
      { o_que: 'teve a conferência de uma peça contestada: a peça segue barrada, e o motivo ficou guardado', peca: 'Entrega em 20 minutos', quem_decidiu: 'outra pessoa da empresa' },
    ]);
    expect(v.equipe.map((m: { funcionario: string }) => m.funcionario)).toEqual(['Criativo']);
    const texto = JSON.stringify(v);
    expect(texto).not.toContain('Juliana');
    expect(texto).not.toContain('Rodrigo');
    expect(rotuloDoPasso('equipe_trabalho', { brand_id: 'x', funcionario: 'criativo' })).toBe('Lendo o trabalho do Criativo em Sua equipe');
  });

  it('o CRM e mensageria (A5 · P16): o modo dele, as mensagens com o nome de quando são, o valor do caixa (que não é a soma da sombra), por que não pode propor e os acontecimentos dele', () => {
    const mensagens = [stat('mensagens_propostas', 2), stat('mensagens_enviadas', 1), stat('mensagens_recusadas', 0), stat('mensagens_esperando', 1), stat('pedidos_com_cupom', 12), stat('caixa_com_cupom', '540000000', 'brl_micros'), stat('retiradas_na_conferencia', 0)];
    const comCrm = (extra: Partial<TeamMember> = {}): TeamResponse => ({ ...EQUIPE, members: [...EQUIPE.members, membro('crm', { cost: { usd_micros: '30000', calls: 2 }, stats: mensagens, in_progress: null, blocked_by: null, ...extra })] });
    const doCrm = (t: TeamResponse) => (visaoDaEquipe(t, null, 'America/Sao_Paulo') as Record<string, any>).equipe.find((m: { funcionario: string }) => m.funcionario === 'CRM e mensageria');
    expect(doCrm(comCrm())).toEqual({
      funcionario: 'CRM e mensageria',
      situacao: 'ativo',
      trabalha: 'com um modelo de IA, no modo Aprovação: toda mensagem é um pedido em Aprovações, que uma pessoa aprova com o código do app; nenhuma mensagem sai sozinha',
      custo_de_ia_no_mes: 'R$ 0,16',
      chamadas_ao_modelo_no_mes: '2',
      no_mes: {
        mensagens_propostas_no_mes: '2',
        mensagens_do_mes_aprovadas_por_uma_pessoa_e_enviadas: '1',
        mensagens_do_mes_recusadas_por_uma_pessoa: '0',
        mensagens_esperando_a_decisao_de_uma_pessoa_agora: '1',
        pedidos_confirmados_no_caixa_com_o_cupom_das_mensagens_do_mes: '12',
        // Dinheiro do caixa, com o nome dele: não vira a frase da soma da sombra.
        valor_confirmado_no_caixa_com_o_cupom_das_mensagens_do_mes: 'R$ 540,00',
        textos_retirados_na_conferencia: '0',
      },
    });
    // Ligado e sem ter como propor: o porquê, como a ficha diz.
    expect(doCrm(comCrm({ blocked_by: 'sem_regemcast' })).nao_pode_propor_agora).toBe('o RegemCast não está conectado nesta marca: é ele que envia as mensagens e guarda os contatos');
    expect(doCrm(comCrm({ blocked_by: 'sem_oferta' })).nao_pode_propor_agora).toContain('não inventa oferta nem preço');
    expect(doCrm(comCrm({ blocked_by: 'motivo_novo' })).nao_pode_propor_agora).toBe('motivo novo');
    expect(doCrm(comCrm())).not.toHaveProperty('nao_pode_propor_agora');
    expect(doCrm(comCrm())).not.toHaveProperty('nao_pode_escrever_agora');
    // Ainda não ligado para a empresa: a situação diz isso, e não "a IA ou a sombra".
    expect(doCrm(comCrm({ status: 'desligado_pela_liame' })).situacao).toBe('ainda não ligado para a empresa (quem liga é a Liame, a pedido do dono); enquanto isso, ninguém propõe mensagem e ele não custa nada');
    // O Gestor de tráfego segue com a soma da sombra dele, e os outros não ganham os campos do CRM.
    const todos = (visaoDaEquipe(comCrm(), null, 'America/Sao_Paulo') as Record<string, any>).equipe;
    expect(todos.find((m: { funcionario: string }) => m.funcionario === 'Gestor de tráfego').no_mes.comparacao_com_o_que_foi_feito).toContain('R$ 41,20');
    expect(todos[0]).not.toHaveProperty('nao_pode_propor_agora');

    // Os acontecimentos: cada um com o campo do que ele é, e sem o nome de quem decidiu.
    const v = ver('crm', [
      item({ kind: 'propos_mensagem', subject: 'Sexta em dobro', count: 412 }),
      item({ kind: 'mensagem_enviada', subject: 'Sobremesa por nossa conta', count: 176, by: RODRIGO, mine: true }),
      item({ kind: 'mensagem_enviada', subject: 'Combo de domingo', count: 90, by: JULIANA }),
      item({ kind: 'mensagem_recusada', subject: 'Combo kids', count: 96 }),
      item({ kind: 'mensagem_cancelada', subject: 'Promoção de teste' }),
      item({ kind: 'mensagem_expirou', subject: null }),
      item({ kind: 'mensagem_falhou', subject: 'Volte a pedir' }),
    ], comCrm());
    expect(semHora(v)).toEqual([
      { o_que: 'propôs uma mensagem de WhatsApp, como pedido em Aprovações', mensagem: 'Sexta em dobro', pessoas_que_podem_receber: '412' },
      { o_que: 'teve uma mensagem aprovada: o envio foi para o RegemCast', mensagem: 'Sobremesa por nossa conta', quem_decidiu: 'você' },
      { o_que: 'teve uma mensagem aprovada: o envio foi para o RegemCast', mensagem: 'Combo de domingo', quem_decidiu: 'outra pessoa da empresa' },
      { o_que: 'teve uma mensagem recusada: nada foi enviado', mensagem: 'Combo kids' },
      { o_que: 'teve um pedido de mensagem cancelado por quem opera: nada foi enviado', mensagem: 'Promoção de teste' },
      { o_que: 'teve um pedido de mensagem que expirou sem decisão: nada foi enviado' },
      { o_que: 'teve uma mensagem aprovada que não foi enviada: o envio falhou', mensagem: 'Volte a pedir' },
    ]);
    expect(v.equipe.map((m: { funcionario: string }) => m.funcionario)).toEqual(['CRM e mensageria']);
    const texto = JSON.stringify(v);
    expect(texto).not.toContain('Juliana');
    expect(texto).not.toContain('Rodrigo');
    expect(NOME_DO_MEMBRO.crm).toBe('CRM e mensageria');
    expect(rotuloDoPasso('equipe_trabalho', { brand_id: 'x', funcionario: 'crm' })).toBe('Lendo o trabalho do CRM e mensageria em Sua equipe');
  });

  it('o CRM e mensageria e a fila das propostas (A5 · P16): a proposta em andamento em palavras, o que falta ao modelo e os acontecimentos da fila', () => {
    const OFERTA = 'Combo sexta: smash, batata e refri por R$ 34,90';
    const mensagens = [stat('mensagens_propostas', 1), stat('mensagens_esperando', 0), stat('rascunhos_esperando_o_modelo', 1), stat('retiradas_na_conferencia', 0)];
    const comCrm = (extra: Partial<TeamMember> = {}): TeamResponse => ({ ...EQUIPE, members: [...EQUIPE.members, membro('crm', { cost: { usd_micros: '30000', calls: 2 }, stats: mensagens, in_progress: null, blocked_by: null, ...extra })] });
    const doCrm = (t: TeamResponse) => (visaoDaEquipe(t, null, 'America/Sao_Paulo') as Record<string, any>).equipe.find((m: { funcionario: string }) => m.funcionario === 'CRM e mensageria');
    const DESDE = '2026-10-09T12:00:00.000Z';
    expect(doCrm(comCrm()).no_mes.rascunhos_de_modelo_no_regemcast_esperando_a_meta_agora).toBe('1');
    expect(doCrm(comCrm())).not.toHaveProperty('proposta_em_andamento');

    // Preparando uma promoção: trabalho em andamento, com a oferta de onde ela parte; ainda não há mensagem.
    const preparando = doCrm(comCrm({ working_now: true, in_progress: { subject: OFERTA, count: 412, by: null, since: DESDE, kind: 'promocao' } }));
    expect(preparando.trabalhando_agora).toBe('sim');
    expect(preparando.proposta_em_andamento).toMatchObject({
      para: 'divulgar uma oferta de Minha marca',
      situacao: 'preparando: ele escreve o texto e o código confere antes de qualquer pessoa ver',
      oferta: OFERTA,
      pessoas_que_podem_receber: '412',
    });
    expect(preparando.proposta_em_andamento.desde).toContain('09/10');
    expect(preparando.proposta_em_andamento).not.toHaveProperty('mensagem');
    expect(preparando).not.toHaveProperty('nao_pode_propor_agora');
    // Não é o Criativo: o campo do que ele "escreve agora" é das peças.
    expect(preparando).not.toHaveProperty('escrevendo_agora');

    // O rascunho que espera o modelo: o nome da mensagem, e o que falta em palavras.
    const esperando = doCrm(comCrm({ blocked_by: 'modelo_sem_envio', in_progress: { subject: 'Volte a pedir', count: 96, by: null, since: DESDE, kind: 'volte_a_pedir' } }));
    expect(esperando).not.toHaveProperty('trabalhando_agora');
    expect(esperando.proposta_em_andamento).toMatchObject({
      para: 'chamar de volta clientes que não pedem há algum tempo',
      situacao: 'o rascunho do modelo está no RegemCast, esperando a Meta aprovar',
      mensagem: 'Volte a pedir',
      pessoas_que_podem_receber: '96',
    });
    expect(esperando.proposta_em_andamento).not.toHaveProperty('oferta');
    expect(esperando.nao_pode_propor_agora).toBe(
      'o rascunho do modelo está no RegemCast e ainda não foi enviado para a análise da Meta: quem envia é uma pessoa, no RegemCast, e só com o modelo aprovado ele monta o pedido de envio',
    );
    expect(doCrm(comCrm({ blocked_by: 'modelo_em_analise' })).nao_pode_propor_agora).toBe('o modelo da mensagem está em análise na Meta: só com o modelo aprovado ele monta o pedido de envio');
    // Quem não vê as campanhas (sem o nome) e um motivo que a visão não conhece: os campos somem, o resto fica.
    expect(doCrm(comCrm({ blocked_by: 'modelo_em_analise', in_progress: { subject: null, count: 96, by: null, since: DESDE, kind: 'motivo_novo' } })).proposta_em_andamento).toEqual({
      situacao: 'o rascunho do modelo está no RegemCast, esperando a Meta aprovar',
      pessoas_que_podem_receber: '96',
      desde: expect.stringContaining('09/10'),
    });
    // Os outros funcionários não ganham o campo, nem com trabalho em andamento.
    const todos = (visaoDaEquipe(comCrm(), null, 'America/Sao_Paulo') as Record<string, any>).equipe;
    expect(todos.filter((m: Record<string, unknown>) => 'proposta_em_andamento' in m)).toEqual([]);

    // Os acontecimentos da fila: cada um com o campo do que ele é; o que barrou em palavras; o que a visão não conhece, sem os traços.
    const v = ver('crm', [
      item({ kind: 'escreveu_rascunho', subject: 'Volte a pedir', detail: 'volte_a_pedir', count: 96 }),
      item({ kind: 'mensagem_barrada', detail: 'promocao', count: 412, rules: ['oferta', 'regras_da_liame', 'regras_da_marca', 'formato', 'item_novo'] }),
      item({ kind: 'proposta_descartada', subject: 'Sexta em dobro', detail: 'modelo_recusado' }),
      item({ kind: 'proposta_falhou', detail: 'ia_fora_do_ar' }),
      item({ kind: 'proposta_descartada', detail: 'motivo_novo' }),
    ], comCrm());
    expect(semHora(v)).toEqual([
      {
        o_que: 'escreveu uma mensagem, que passou na conferência, e deixou o rascunho do modelo no RegemCast: falta uma pessoa enviar o modelo para a análise da Meta',
        mensagem: 'Volte a pedir',
        para: 'chamar de volta clientes que não pedem há algum tempo',
        pessoas_que_podem_receber: '96',
      },
      {
        o_que: 'teve uma mensagem barrada na conferência, antes de qualquer pessoa ver: nada foi para o RegemCast, e o texto não é guardado',
        para: 'divulgar uma oferta de Minha marca',
        o_que_barrou: [
          'preço, número ou benefício que não está na oferta nem no cupom',
          'regra de texto da Liame',
          'o que a marca nunca diz, ou o nome de um concorrente',
          'formato que a Meta não aceita num modelo',
          'item novo',
        ],
      },
      { o_que: 'teve uma proposta de mensagem que não virou pedido', mensagem: 'Sexta em dobro', motivo: 'a Meta recusou o modelo' },
      { o_que: 'não conseguiu concluir uma proposta de mensagem', motivo: 'a IA não respondeu' },
      { o_que: 'teve uma proposta de mensagem que não virou pedido', motivo: 'motivo novo' },
    ]);
  });

  it('a leitura no registro: é da conversa (o Estrategista segue com as seis leituras dos números), e a tela diz o que a LIA leu', () => {
    expect(LEITURAS.map((l) => l.name)).toEqual([...LEITURAS_DE_DADOS, 'equipe_trabalho']);
    expect(ESTRATEGISTA.ferramentas).toEqual([...LEITURAS_DE_DADOS]);
    // Os nomes são os da tela, um para cada membro da equipe.
    expect(Object.keys(NOME_DO_MEMBRO).sort()).toEqual([...MEMBROS].sort());
    expect(Object.keys(DO_MEMBRO).sort()).toEqual([...MEMBROS].sort());
    expect(rotuloDoPasso('equipe_trabalho', { brand_id: 'x', funcionario: 'analista' })).toBe('Lendo o trabalho do Analista de dados em Sua equipe');
    expect(rotuloDoPasso('equipe_trabalho', { brand_id: 'x', funcionario: 'relatorios' })).toBe('Lendo o trabalho de Relatórios em Sua equipe');
    expect(rotuloDoPasso('equipe_trabalho', { brand_id: 'x' })).toBe('Lendo o trabalho da equipe');
    expect(rotuloDoPasso('equipe_trabalho', { funcionario: 'inventado' })).toBe('Lendo o trabalho da equipe');
    expect(rotuloDaLeitura('equipe_trabalho', {})).toBe('Sua equipe');
  });
});
