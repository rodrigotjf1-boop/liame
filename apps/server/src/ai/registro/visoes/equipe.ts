import type { TeamActivityItem, TeamActivityResponse, TeamMember, TeamResponse } from '@liame/contracts';
import { emReais } from '../../../cambio/ptax.js';
import { dia, dinheiro, inteiro, soOQueExiste } from '../formatos.js';
import { quando } from '../leituras.visoes.js';

// A visão de Sua equipe para o modelo (A3; "Conversar sobre ele", protótipo P7): os MESMOS números da tela
// (`/v1/team` e "O que fez"), enxutos e já ditos como a tela diz (`apps/web/src/components/equipe/textos.ts`). O custo
// vai como a tela mostra: em reais pela cotação de referência, ou em dólar antes da primeira cotação. Cada
// acontecimento leva o campo do que ele é (a versão do plano, o percentual da recomendação, as pessoas que receberam o
// e-mail): um número solto mudaria de sentido de um para o outro. Nome de colega nunca vai ao modelo: quem pediu ou
// decidiu aparece como "você" ou "outra pessoa da empresa". Funções puras.

/** Os nomes da tela: a resposta da LIA fala como a tela. */
export const NOME_DO_MEMBRO: Record<string, string> = {
  lia: 'LIA',
  analista: 'Analista de dados',
  relatorios: 'Relatórios',
  compliance: 'Compliance',
  estrategista: 'Estrategista',
  pesquisador: 'Pesquisador',
  trafego: 'Gestor de tráfego',
};

/** O funcionário na frase ("o trabalho do Analista de dados", "de Relatórios"), como a tela escreve. */
export const DO_MEMBRO: Record<string, string> = {
  lia: 'da LIA',
  analista: 'do Analista de dados',
  relatorios: 'de Relatórios',
  compliance: 'do Compliance',
  estrategista: 'do Estrategista',
  pesquisador: 'do Pesquisador',
  trafego: 'do Gestor de tráfego',
};

const SITUACAO: Record<string, string> = {
  ativo: 'ativo',
  sombra: 'em sombra: registra o que faria, sem mexer em nada',
  desligado: 'desligado pela empresa nesta marca',
  desligado_pela_liame: 'desligado pela Liame (a IA ou a sombra não está ligada para a empresa, ou está fora do plano)',
  parado: 'parado junto com a equipe',
};

/** O que cada número do mês conta, como a tela diz. */
const NUMERO: Record<string, string> = {
  respostas: 'respostas_que_chegaram_a_pessoa',
  explicacoes: 'explicacoes_que_chegaram_a_pessoa',
  fez_sentido: 'marcadas_fez_sentido',
  discordo: 'marcadas_discordo',
  demandas: 'demandas_abertas',
  revisoes: 'revisoes_da_semana',
  com_leitura_da_ia: 'revisoes_com_a_leitura_da_lia',
  so_do_sistema: 'revisoes_sem_a_leitura_da_lia',
  textos_conferidos: 'textos_conferidos',
  textos_barrados: 'textos_barrados',
  planos_aprovados: 'planos_aprovados',
  planos_recusados: 'planos_recusados',
  planos_esperando: 'planos_esperando_a_decisao',
  em_preparo: 'planos_em_preparo',
  paginas_lidas: 'paginas_lidas',
  recusadas: 'paginas_que_nao_pode_ler',
  sugestoes: 'sugestoes_para_minha_marca',
  recomendacoes: 'recomendacoes_em_sombra',
  comparaveis: 'recomendacoes_que_ja_da_para_comparar',
  mesma_direcao: 'em_que_a_empresa_fez_o_mesmo_ou_foi_na_mesma_direcao',
};
/** Os textos que a conferência não deixou aparecer: na LIA e no Analista, a tela os chama de respostas. */
const RETIRADAS: Record<string, string> = { lia: 'respostas_retiradas_na_conferencia', analista: 'respostas_retiradas_na_conferencia' };
const TEXTOS_RETIRADOS = 'textos_retirados_na_conferencia';

/** As regras de texto e as categorias do revisor de IA, em palavras; nome novo vai sem os traços. */
const REGRA: Record<string, string> = {
  politico_eleitoral: 'conteúdo político ou eleitoral',
  promessa_de_resultado: 'promessa de resultado',
  categoria_proibida: 'categoria proibida',
  dado_pessoal: 'dado pessoal',
  texto_longo: 'texto longo demais para conferir',
  regra_da_marca: 'regra da marca',
  tom: 'o revisor de IA apontou o tom',
  clareza: 'o revisor de IA apontou a clareza',
  alegacao: 'o revisor de IA apontou uma alegação que ninguém pode provar',
};
const TIPO_DE_DEMANDA: Record<string, string> = { promocao: 'promoção', plano: 'plano', pauta: 'pauta', analise: 'análise', outro: 'outro assunto' };
const TIPO_DE_PLANO: Record<string, string> = { noventa_dias: 'plano de 90 dias', pauta: 'pauta da semana', oferta: 'oferta' };
/** Por que um texto foi retirado na conferência. */
const RETIRADA: Record<string, string> = {
  compliance: 'barrado por uma regra de texto do Compliance',
  revisor: 'barrado pelo revisor de IA do Compliance',
  revisor_sem_resposta: 'o revisor de IA não respondeu, e sem a revisão dele o texto não aparece',
  numero_fora: 'citava um número que o sistema não calculou',
  dado_velho: 'os dados não estavam em dia',
  formato: 'a resposta veio fora do formato',
};
const PAGINA_RECUSADA: Record<string, string> = {
  robots: 'o site pede para não ser lido por robôs',
  instrucao_na_pagina: 'a página tinha texto tentando dar ordens a quem lê',
  sem_texto: 'a página não tinha texto para ler',
  nao_e_pagina: 'o endereço não é uma página',
  grande_demais: 'a página é grande demais',
  rede_interna: 'o endereço não é público',
};
const PAGINA_FALHOU: Record<string, string> = {
  fora_do_ar: 'o site estava fora do ar',
  sem_ia: 'a IA não estava disponível',
  formato: 'a resposta veio fora do formato',
};
const COMPARACAO: Record<string, string> = {
  teria_melhorado: 'a recomendação teria rendido mais do que o que foi feito',
  teria_piorado: 'a recomendação teria rendido menos do que o que foi feito',
  igual: 'daria no mesmo',
  sem_dado: 'sem dado para comparar',
};

/** "reduzir a verba em 20%", "pausar a campanha", "aumentar a verba em 20%". */
function acaoDa(ferramenta: string | null, percentual: number | null): string {
  const quanto = percentual ? ` em ${inteiro(percentual)}%` : '';
  if (ferramenta === 'orcamento_reduzir') return `reduzir a verba${quanto}`;
  if (ferramenta === 'orcamento_aumentar') return `aumentar a verba${quanto}`;
  if (ferramenta === 'campanha_pausar') return 'pausar a campanha';
  return 'mexer na campanha';
}

/**
 * A situação do teto de IA, como o aviso do topo da tela: a faixa é a pior entre o dia e o mês; se o gasto do mês não
 * explica a faixa, quem passou foi o teto do dia.
 */
function situacaoDoTeto(t: TeamResponse): string {
  const faixa = t.ai.band;
  if (faixa === 'livre') return 'dentro do teto';
  const gasto = BigInt(t.ai.spent_usd_micros);
  const teto = BigInt(t.ai.ceiling_usd_micros);
  const parte = faixa === 'bloqueado' ? 100n : faixa === 'economico' ? 80n : 70n;
  const peloMes = teto > 0n && gasto * 100n >= teto * parte;
  const ateVirar = `os funcionários de IA param até ${peloMes ? 'o mês' : 'o dia'} virar`;
  if (faixa === 'bloqueado') return `${peloMes ? 'o uso de IA do mês chegou ao teto da empresa' : 'o uso de IA de hoje chegou ao teto do dia'}: ${ateVirar}`;
  const passou = peloMes ? `o uso de IA do mês passou de ${parte}% do teto da empresa` : `o uso de IA de hoje passou de ${parte}% do teto do dia`;
  return `${passou}: perto do teto, as respostas ficam mais curtas; no teto, ${ateVirar}`;
}

/** A soma da sombra, como a frase da tela: quanto as recomendações teriam rendido a mais (ou a menos) do que o que foi feito. */
function somaDaSombra(micros: string): string {
  const v = BigInt(micros);
  if (v === 0n) return 'as recomendações dariam no mesmo que o que foi feito';
  return `as recomendações teriam rendido ${dinheiro((v < 0n ? -v : v).toString())!} ${v < 0n ? 'a mais' : 'a menos'} do que o que foi feito`;
}

function doMembro(m: TeamMember, naTela: (usdMicros: string) => string, fuso: string) {
  const numeros: Record<string, string> = {};
  let soma: string | null = null;
  for (const s of m.stats) {
    if (s.unit === 'brl_micros') soma = s.value;
    else if (s.key === 'retiradas_na_conferencia') numeros[RETIRADAS[m.key] ?? TEXTOS_RETIRADOS] = inteiro(s.value)!;
    else numeros[NUMERO[s.key] ?? s.key] = inteiro(s.value)!;
  }
  // A comparação da sombra só existe depois de 7 dias de cada recomendação (a frase da tela).
  const comparaveis = m.stats.find((s) => s.key === 'comparaveis')?.value;
  if (comparaveis === '0') numeros.comparacao_com_o_que_foi_feito = 'ainda não dá para comparar nenhuma: a comparação sai 7 dias depois de cada recomendação';
  else if (soma !== null) numeros.comparacao_com_o_que_foi_feito = somaDaSombra(soma);
  // O Compliance trabalha por regras; o custo de IA dele, quando há, é o do revisor de IA.
  const doRevisor = m.key === 'compliance' && m.cost.calls > 0;
  return soOQueExiste({
    funcionario: NOME_DO_MEMBRO[m.key] ?? m.key,
    situacao: SITUACAO[m.status] ?? m.status.replaceAll('_', ' '),
    trabalha: m.kind === 'ia' ? 'com um modelo de IA' : doRevisor ? 'por regras do sistema; o custo de IA é do revisor de IA, que lê o texto depois das regras' : 'por regras do sistema',
    trabalhando_agora: m.working_now ? 'sim' : null,
    desligado_desde: m.paused ? quando(m.paused.at, fuso) : null,
    motivo_de_estar_desligado: m.paused?.reason ?? null,
    custo_de_ia_no_mes: naTela(m.cost.usd_micros),
    chamadas_ao_modelo_no_mes: inteiro(m.cost.calls),
    no_mes: numeros,
  });
}

/** Um acontecimento de "O que fez", com o que a tela diz dele. O que a visão ainda não conhece vira um registro genérico. */
function doAcontecimento(i: TeamActivityItem, fuso: string) {
  const n = i.count ?? 0;
  const detalhe = i.detail ?? '';
  // Quem pediu ou decidiu: nunca o nome de um colega.
  const pessoa = i.mine ? 'você' : i.by ? 'outra pessoa da empresa' : null;
  const varios = n > 1 ? inteiro(n) : null;
  const regras = i.rules.map((r) => REGRA[r] ?? r.replaceAll('_', ' '));
  const semana = i.period ? `${dia(i.period.from)} a ${dia(i.period.to)}` : null;
  const retorno = i.feedback === 'fez_sentido' ? `${i.mine ? 'você marcou' : 'marcada'} "Fez sentido"` : i.feedback === 'discordo' ? `${i.mine ? 'você marcou' : 'marcada'} "Discordo"` : null;
  const acao = acaoDa(i.detail, null);
  const o = (campos: Record<string, unknown>) => soOQueExiste({ quando: quando(i.at, fuso), ...campos });
  switch (i.kind) {
    case 'respondeu':
      // A conversa pelo nome só chega para a própria pessoa (o que os outros perguntam não aparece).
      return o({ o_que: 'respondeu a uma pergunta na conversa', conversa: i.subject, quem_perguntou: i.mine ? 'você' : null, retorno });
    case 'abriu_demanda':
      return o({ o_que: 'abriu uma demanda e a entregou ao Estrategista', demanda: i.subject, tipo_de_pedido: TIPO_DE_DEMANDA[detalhe] ?? null, quem_pediu: pessoa });
    case 'explicou_resultados':
      return o({ o_que: 'explicou os resultados', quem_pediu: i.mine ? 'você' : null, retorno });
    case 'explicou_aviso':
      return o({ o_que: 'explicou um aviso da Atenção', quem_pediu: i.mine ? 'você' : null, retorno });
    case 'gerou_revisao':
      return o({ o_que: 'gerou a revisão da semana', semana, leitura: detalhe === 'lia' ? 'com a leitura da LIA' : 'com o resumo do sistema, sem a leitura da LIA', retorno });
    case 'enviou_revisao':
      return o({ o_que: 'enviou a revisão da semana por e-mail', semana, pessoas_que_receberam: i.count === null ? null : inteiro(n) });
    case 'barrou_texto':
      return o({ o_que: n > 1 ? 'barrou textos antes de eles aparecerem' : 'barrou um texto antes de ele aparecer', quantos_textos: varios, escrito_por: NOME_DO_MEMBRO[detalhe] ?? null, regras });
    case 'retirada_na_conferencia':
      return o({
        o_que: n > 1 ? 'teve textos retirados na conferência, antes de aparecerem' : 'teve um texto retirado na conferência, antes de aparecer',
        quantos_textos: varios,
        motivo: RETIRADA[detalhe] ?? 'não passou na conferência do código',
        regras,
      });
    case 'recebeu_demanda':
      return o({ o_que: 'recebeu uma demanda', demanda: i.subject, tipo_de_pedido: TIPO_DE_DEMANDA[detalhe] ?? null, quem_pediu: pessoa });
    case 'montou_plano':
      return o({ o_que: 'montou um plano e o mandou para Aprovações', plano: i.subject, tipo_de_plano: TIPO_DE_PLANO[detalhe] ?? null, versao_do_plano: varios });
    case 'plano_aprovado':
      return o({ o_que: 'teve um plano aprovado', plano: i.subject, tipo_de_plano: TIPO_DE_PLANO[detalhe] ?? null, quem_decidiu: pessoa });
    case 'plano_recusado':
      return o({ o_que: 'teve um plano recusado, com o motivo guardado', plano: i.subject, tipo_de_plano: TIPO_DE_PLANO[detalhe] ?? null, quem_decidiu: pessoa });
    case 'plano_nova_analise':
      return o({ o_que: 'recebeu o pedido de outra versão de um plano', plano: i.subject, tipo_de_plano: TIPO_DE_PLANO[detalhe] ?? null, quem_pediu: pessoa });
    case 'leu_pagina':
      return o({
        o_que: 'leu uma página',
        site: i.subject,
        partes_de_minha_marca_com_sugestao: n > 0 ? inteiro(n) : null,
        resultado: n > 0 ? null : 'não achou o que sugerir',
        quem_pediu: pessoa,
      });
    case 'pagina_recusada':
      return o({ o_que: 'não leu uma página', site: i.subject, motivo: PAGINA_RECUSADA[detalhe] ?? 'a leitura foi recusada', quem_pediu: pessoa });
    case 'pagina_falhou':
      return o({ o_que: 'não conseguiu ler uma página', site: i.subject, motivo: PAGINA_FALHOU[detalhe] ?? 'a leitura falhou', quem_pediu: pessoa });
    case 'recomendou':
      return o({ o_que: 'registrou uma recomendação em sombra: nada mudou na plataforma', campanha: i.subject, recomendacao: acaoDa(i.detail, i.count) });
    case 'comparou':
      return o({ o_que: 'comparou uma recomendação com o que foi feito', campanha: i.subject, resultado: COMPARACAO[detalhe] ?? null });
    case 'promocao_proposta':
      return o({
        o_que: 'o sistema propôs mostrar as recomendações de uma ação na Atenção; quem decide é uma pessoa',
        conta: i.subject,
        acao,
        decisoes_comparaveis: n > 0 ? inteiro(n) : null,
      });
    case 'promocao_aprovada':
      return o({ o_que: 'teve a proposta aprovada: as recomendações dessa ação aparecem na Atenção', conta: i.subject, acao, quem_decidiu: pessoa });
    case 'promocao_recusada':
      return o({ o_que: 'teve a proposta recusada: segue em sombra nessa ação', conta: i.subject, acao, quem_decidiu: pessoa });
    case 'promocao_retirada':
      return o({ o_que: 'teve a proposta retirada: os portões deixaram de passar antes de alguém decidir', conta: i.subject, acao });
    case 'voltou_para_sombra':
      return o({ o_que: 'voltou para a sombra nessa ação: nada mais aparece na Atenção por ele', conta: i.subject, acao, quem_decidiu: pessoa });
    case 'desligado':
      return o({ o_que: 'foi desligado pela empresa nesta marca', quem_decidiu: pessoa });
    case 'ligado':
      return o({ o_que: 'foi ligado de novo pela empresa', quem_decidiu: pessoa });
    default:
      return o({ o_que: 'registrou um trabalho', assunto: i.subject });
  }
}

/** Quantos acontecimentos de um funcionário vão ao modelo (os mais recentes). */
export const ACONTECIMENTOS_MAXIMO = 12;

/**
 * `t`: a resposta de `/v1/team`. `atividade`: "O que fez" de um funcionário, quando a pergunta é sobre um só (então a
 * lista da equipe traz só ele). `fuso`: o da empresa, para as horas saírem como a pessoa lê.
 */
export function visaoDaEquipe(t: TeamResponse, atividade: TeamActivityResponse | null, fuso: string) {
  const cotacao = t.usd_brl;
  const naTela = (usdMicros: string): string => (cotacao ? dinheiro(emReais(BigInt(usdMicros), cotacao.rate).toString())! : dinheiro(usdMicros, 'US$')!);
  const membros = atividade ? t.members.filter((m) => m.key === atividade.member) : t.members;
  // "O que fez" olha os últimos 90 dias: o dia em que a lista começa vai junto, para a LIA dizer desde quando.
  const desde = atividade ? quando(atividade.since, fuso)!.slice(0, 10) : null;
  return soOQueExiste({
    mes: `${dia(t.month.from)} a ${dia(t.month.to)}`,
    // A IA da empresa no mês, em todas as marcas (o selo do topo da tela).
    ia_da_empresa: soOQueExiste({
      ligada: t.ai.enabled ? 'sim' : 'não',
      gasto_no_mes: naTela(t.ai.spent_usd_micros),
      teto_do_mes: naTela(t.ai.ceiling_usd_micros),
      situacao_do_teto: t.ai.enabled ? situacaoDoTeto(t) : null,
    }),
    valores: cotacao
      ? `em reais, aproximados, pela PTAX de venda do Banco Central de ${dia(cotacao.date)}; o custo e o teto de IA são medidos em dólar`
      : 'em dólar (ainda sem cotação de referência)',
    equipe_parada: t.stop ? soOQueExiste({ desde: quando(t.stop.since, fuso), por: t.stop.by_company ? 'a empresa' : 'a Liame', motivo: t.stop.reason }) : null,
    equipe: membros.map((m) => doMembro(m, naTela, fuso)),
    acontecimentos_desde: desde,
    ultimos_acontecimentos: atividade ? (atividade.items.length ? atividade.items.slice(0, ACONTECIMENTOS_MAXIMO).map((i) => doAcontecimento(i, fuso)) : `nenhum desde ${desde}`) : null,
    ha_mais_acontecimentos: atividade && (atividade.has_more || atividade.items.length > ACONTECIMENTOS_MAXIMO) ? 'sim' : null,
  });
}
