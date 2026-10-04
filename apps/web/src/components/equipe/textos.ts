import type { AutonomyItem, AutonomyThresholds, TeamActivityItem, TeamMember, TeamResponse, TeamShadowDecision, TeamShadowResponse } from '@liame/contracts';
import type { NomeIcone } from '@/components/ui/icone';
import { inteiro, paraSeletor, quandoComHora, reaisDeMicros } from '@/lib/formato';

// Textos e contas da tela "Sua equipe" (mockups/prototipo-equipe.html, P7 aprovado em 03/10/2026). Funções puras:
// o que a API manda (`/v1/team`, `/v1/team/members/:key/activity`, `/v1/team/shadow`, `/v1/autonomy`) vira a frase
// que a pessoa lê. Quem conta é o servidor; aqui só se escreve.

const ESPACO = String.fromCharCode(160);

// ------------------------------------------------------------------ dinheiro e datas

const MICROS_POR_CENTAVO = 10_000n;

/** Micros de dólar em "US$ 4,34", sem ponto flutuante (metade para cima). */
export function usdDeMicros(micros: string | bigint): string {
  const valor = typeof micros === 'bigint' ? micros : BigInt(micros);
  const centavos = (valor + MICROS_POR_CENTAVO / 2n) / MICROS_POR_CENTAVO;
  return `US$${ESPACO}${inteiro(centavos / 100n)},${(centavos % 100n).toString().padStart(2, '0')}`;
}

/** Micros de dólar em micros de real, pela cotação em texto ("5.2238"), só com inteiros (a mesma conta do servidor). */
export function emReais(usdMicros: bigint, taxa: string): bigint {
  const [inteira = '0', fracao = ''] = taxa.split('.');
  const taxaE6 = BigInt(inteira) * 1_000_000n + BigInt(`${fracao}000000`.slice(0, 6));
  return (usdMicros * taxaE6 + 500_000n) / 1_000_000n;
}

type Cotacao = TeamResponse['usd_brl'];

/** O custo de IA como a tela mostra: em reais pela cotação de referência (aproximado) ou, sem cotação, em dólar. */
export function custoNaTela(usdMicros: string, cotacao: Cotacao): string {
  return cotacao ? reaisDeMicros(emReais(BigInt(usdMicros), cotacao.rate)) : usdDeMicros(usdMicros);
}

/** "02/10/2026" de "2026-10-02" (dia do calendário, sem fuso). */
export function dataDe(dia: string): string {
  const [a, m, d] = dia.split('-');
  return `${d}/${m}/${a}`;
}

/** "02/10" de "2026-10-02". */
export function diaMesDe(dia: string): string {
  const [, m, d] = dia.split('-');
  return `${d}/${m}`;
}

/** O dia da loja como a tabela mostra: "hoje" ou "02/10". */
export function diaDaLoja(dia: string, agora: Date): string {
  return dia === paraSeletor(agora.toISOString()) ? 'hoje' : diaMesDe(dia);
}

/** De onde vem o valor em reais (D-A3-14): a tela diz a fonte e o dia da cotação. Nula sem cotação. */
export function notaDaCotacao(cotacao: Cotacao): string | null {
  if (!cotacao) return null;
  const [inteira = '0', fracao = ''] = cotacao.rate.split('.');
  const taxa = `${inteira},${`${fracao}0000`.slice(0, 4)}`;
  return `Valor aproximado em reais, pela PTAX de venda do Banco Central de ${dataDe(cotacao.date)} (US$${ESPACO}1 = R$${ESPACO}${taxa}). O custo e o teto de IA são medidos em dólar.`;
}

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** "outubro" de "2026-10-01". */
export function mesDe(dia: string): string {
  return MESES[Number(dia.split('-')[1]) - 1] ?? 'este mês';
}

const vezes = (n: bigint | number, um: string, varios: string) => `${inteiro(n)} ${BigInt(n) === 1n ? um : varios}`;

/** O instante dentro de uma frase: "hoje, 21:02", "ontem, 18:20" ou "em 30/09, 18:20". */
export function quandoNaFrase(iso: string, agora: Date): string {
  const q = quandoComHora(iso, agora);
  return q.startsWith('hoje') || q.startsWith('ontem') ? q : `em ${q}`;
}
const numero = (m: TeamMember, chave: string): bigint => BigInt(m.stats.find((s) => s.key === chave)?.value ?? '0');

// ------------------------------------------------------------------ quem é quem

export type ChaveDoMembro = 'lia' | 'analista' | 'relatorios' | 'compliance' | 'estrategista' | 'pesquisador' | 'trafego';

export interface Ficha {
  nome: string;
  cargo: string;
  /** `lia`: o ícone da LIA (kit da marca); os outros, um ícone de traço. */
  icone: NomeIcone | 'lia';
  /** Como ele trabalha, no selo "Modo". */
  modo: string;
  resumo: string;
  faz: string[];
  nunca: string[];
}

/** A descrição de cada funcionário é da tela (o protótipo aprovado); a situação e os números vêm da API. */
export const FICHAS: Record<ChaveDoMembro, Ficha> = {
  lia: {
    nome: 'LIA',
    cargo: 'Atendimento',
    icone: 'lia',
    modo: 'Conversa',
    resumo:
      'A única da equipe que conversa com as pessoas: responde com os números do sistema, registra pedidos como demanda e leva propostas de cupom para Aprovações. Não mexe em campanha.',
    faz: ['Responde com os números do sistema', 'Abre demanda para a equipe', 'Propõe cupom (vai para Aprovações)'],
    nunca: ['Mexer em campanha', 'Aprovar gasto'],
  },
  analista: {
    nome: 'Analista de dados',
    cargo: 'Explica os números',
    icone: 'chart',
    modo: 'Explica',
    resumo:
      'Explica, em Resultados e na Atenção, o que aconteceu e por quê, citando só números que o sistema calculou, cada um com a fonte. Os números são sempre do código; ele interpreta.',
    faz: ['Lê resultados, avisos, cupons, links e o frescor das fontes', 'Explica com a fonte de cada número'],
    nunca: ['Mudar qualquer coisa', 'Citar número que o sistema não calculou'],
  },
  relatorios: {
    nome: 'Relatórios',
    cargo: 'Revisão da semana',
    icone: 'file',
    modo: 'Auto · relatório',
    resumo:
      'Monta a revisão da semana toda segunda-feira de manhã, com os números calculados pelo código e a leitura da LIA. Sem a LIA, a revisão sai com o resumo do sistema.',
    faz: ['Gera a revisão na segunda-feira', 'Manda o e-mail para quem recebe'],
    nunca: ['Mudar qualquer coisa'],
  },
  compliance: {
    nome: 'Compliance',
    cargo: 'Marca, lei e políticas',
    icone: 'shield',
    modo: 'Política',
    resumo:
      'Confere todo texto feito por IA antes de aparecer: conteúdo político, promessa de resultado, categoria proibida, dado pessoal e as regras da sua marca. Quem decide é o código; ele nunca aprova sozinho.',
    faz: ['Barra texto que fere uma regra'],
    nunca: ['Aprovar sozinho o que é sensível', 'Ser desligado: sem ele, nenhum texto de IA aparece'],
  },
  estrategista: {
    nome: 'Estrategista',
    cargo: 'Plano e pauta',
    icone: 'compass',
    modo: 'Sugerir',
    resumo: 'Monta planos (promoção, pauta da semana, calendário) com os números da loja. Todo plano vai para você aprovar, editar ou recusar; nada vai ao ar sem isso.',
    faz: ['Monta plano e pauta'],
    nunca: ['Colocar verba', 'Publicar'],
  },
  pesquisador: {
    nome: 'Pesquisador',
    cargo: 'Mercado e concorrência',
    icone: 'search',
    modo: 'Leitura',
    resumo:
      'Lê só as páginas que você informar (site, cardápio, concorrentes), por um leitor isolado que não pode escrever nada, e traz sugestões para Minha marca. Nada entra sem você confirmar.',
    faz: ['Lê as páginas informadas'],
    nunca: ['Buscar na internet por conta própria', 'Escrever em qualquer lugar'],
  },
  trafego: {
    nome: 'Gestor de tráfego',
    cargo: 'Campanhas da Meta e do Google',
    icone: 'megaphone',
    modo: 'Sombra',
    resumo:
      'Em sombra: todo dia, depois da leitura da manhã, registra o que faria em cada campanha (pausar, reduzir ou aumentar a verba), sem mexer em nada. Depois olha o que você fez e compara o resultado. É assim que ele junta prova para um dia poder fazer mais.',
    faz: ['Registra o que faria e compara com o que você fez'],
    nunca: ['Pausar, mudar verba ou criar campanha'],
  },
};

export const ORDEM: ChaveDoMembro[] = ['lia', 'analista', 'relatorios', 'compliance', 'estrategista', 'pesquisador', 'trafego'];

/** "do Analista de dados", "de Relatórios": o funcionário na frase. */
const DO_MEMBRO: Record<ChaveDoMembro, string> = {
  lia: 'da LIA',
  analista: 'do Analista de dados',
  relatorios: 'de Relatórios',
  compliance: 'do Compliance',
  estrategista: 'do Estrategista',
  pesquisador: 'do Pesquisador',
  trafego: 'do Gestor de tráfego',
};

/**
 * "Conversar sobre ele" (protótipo P7): a pergunta que abre a conversa com a LIA, já sobre o trabalho do funcionário.
 * A LIA responde lendo Sua equipe (a leitura `equipe_trabalho`), com os mesmos números desta tela.
 */
export function perguntaSobre(chave: ChaveDoMembro): string {
  return `Quero falar sobre o trabalho ${DO_MEMBRO[chave]}: o que ele fez este mês?`;
}

/**
 * O botão "Conversar sobre ele" aparece para quem conversa com a LIA, quando ela está trabalhando nesta marca. Sobre
 * a própria LIA não há o que perguntar por aqui: a conversa com ela é o botão do topo.
 */
export function podeConversarSobre(chave: ChaveDoMembro, t: TeamResponse, conversaDisponivel: boolean): boolean {
  return chave !== 'lia' && conversaDisponivel && t.ai.enabled && t.members.some((m) => m.key === 'lia' && m.status === 'ativo');
}

export const ehMembro = (chave: string): chave is ChaveDoMembro => (ORDEM as string[]).includes(chave);

/** Os funcionários das fases seguintes do roadmap: aparecem na lista, sem trabalhar ainda. */
export const PROXIMAS_FASES: Array<{ chave: string; nome: string; cargo: string; icone: NomeIcone; fase: string; resumo: string }> = [
  { chave: 'criativo', nome: 'Criativo', cargo: 'Textos, artes e vídeos', icone: 'image', fase: 'A4', resumo: 'Cria peças a partir do que já vendeu bem, com o Compliance conferindo antes de você.' },
  { chave: 'crm', nome: 'CRM e mensageria', cargo: 'WhatsApp, e-mail e SMS', icone: 'send', fase: 'A5', resumo: 'Cuida das réguas de relacionamento pelo RegemCast, só com quem deu permissão.' },
  { chave: 'social', nome: 'Social media', cargo: 'Redes e comunidade', icone: 'share', fase: 'A6', resumo: 'Calendário e publicação orgânica, com aprovação.' },
  { chave: 'cro', nome: 'CRO e páginas', cargo: 'Páginas e funil', icone: 'target', fase: 'A8', resumo: 'Páginas e formulários que levam ao pedido.' },
];

// ------------------------------------------------------------------ situação, modo e grupos

export interface Selo {
  rotulo: string;
  classe: string;
  /** O selo leva a bolinha da situação. */
  ponto: boolean;
}

/** Atendem na hora, quando alguém pede: ficam "Online" enquanto estão ligados. */
const SEMPRE_A_POSTOS: string[] = ['lia', 'analista', 'compliance'];

export function situacaoDo(m: TeamMember): Selo {
  switch (m.status) {
    case 'desligado_pela_liame':
      return { rotulo: 'Desligado pela Liame', classe: 'st st--off', ponto: false };
    case 'parado':
      return { rotulo: 'Parado', classe: 'st st--pausado', ponto: true };
    case 'desligado':
      return { rotulo: 'Desligado', classe: 'st st--off', ponto: true };
    case 'sombra':
      return { rotulo: 'Em sombra', classe: 'st st--sombra', ponto: true };
    default:
      if (m.working_now) return { rotulo: 'Trabalhando', classe: 'st st--trabalhando', ponto: true };
      if (SEMPRE_A_POSTOS.includes(m.key)) return { rotulo: 'Online', classe: 'st st--online', ponto: true };
      return { rotulo: 'Em espera', classe: 'st st--espera', ponto: true };
  }
}

const desligado = (m: TeamMember) => m.status === 'desligado' || m.status === 'desligado_pela_liame';

/** O selo "Modo": como ele trabalha. O Gestor de tráfego mostra "Sombra e Sugerir" quando alguma ação já foi promovida. */
export function modoDo(m: TeamMember, autonomia: AutonomyItem[] | null): { rotulo: string; classe: string } {
  if (desligado(m)) return { rotulo: 'Desligado', classe: 'modo-chip modo-chip--off' };
  const ficha = ehMembro(m.key) ? FICHAS[m.key] : null;
  if (m.key === 'trafego') {
    const sugere = (autonomia ?? []).some((a) => a.mode === 'SUGGEST');
    return sugere ? { rotulo: 'Sombra e Sugerir', classe: 'modo-chip modo-chip--sugerir' } : { rotulo: 'Sombra', classe: 'modo-chip modo-chip--sombra' };
  }
  const classe = m.key === 'estrategista' ? 'modo-chip modo-chip--sugerir' : m.key === 'relatorios' ? 'modo-chip modo-chip--auto' : 'modo-chip';
  return { rotulo: ficha?.modo ?? 'Ativo', classe };
}

export interface Grupos {
  ativos: TeamMember[];
  sombra: TeamMember[];
  desligados: TeamMember[];
}

/** Os grupos da lista, na ordem do protótipo. O que a tela não conhece (funcionário novo no servidor) fica de fora. */
export function gruposDa(t: TeamResponse): Grupos {
  const conhecidos = ORDEM.map((k) => t.members.find((m) => m.key === k)).filter((m): m is TeamMember => m !== undefined);
  return {
    ativos: conhecidos.filter((m) => m.key !== 'trafego' && m.status !== 'desligado'),
    sombra: conhecidos.filter((m) => m.key === 'trafego' && m.status !== 'desligado'),
    desligados: conhecidos.filter((m) => m.status === 'desligado'),
  };
}

/** A linha de baixo de cada funcionário na lista: o que ele fez no mês, ou o que faz. */
export function atividadeDo(m: TeamMember, mes: string, agora: Date): string {
  if (m.status === 'desligado') return m.paused ? `Desligado ${m.paused.by ? `por ${m.paused.by.name} ` : ''}${quandoNaFrase(m.paused.at, agora)}` : 'Desligado nesta marca';
  if (m.status === 'desligado_pela_liame') return ehMembro(m.key) ? FICHAS[m.key].cargo : m.key;
  if (m.status === 'parado') return 'Parado com a equipe';
  switch (m.key) {
    case 'lia':
      return numero(m, 'respostas') > 0n ? `Respondeu ${vezes(numero(m, 'respostas'), 'pergunta', 'perguntas')} em ${mes}` : 'Conversa com quem tem acesso';
    case 'analista':
      return numero(m, 'explicacoes') > 0n ? `Explicou ${vezes(numero(m, 'explicacoes'), 'número', 'números')} em ${mes}` : 'Explica os números quando você pede';
    case 'relatorios':
      return numero(m, 'revisoes') > 0n ? `${vezes(numero(m, 'revisoes'), 'revisão', 'revisões')} em ${mes}; a próxima sai na segunda-feira` : 'Próxima revisão: segunda-feira de manhã';
    case 'compliance': {
      const conferidos = numero(m, 'textos_conferidos');
      return conferidos > 0n ? `Conferiu ${vezes(conferidos, 'texto', 'textos')} em ${mes} e barrou ${inteiro(numero(m, 'textos_barrados'))}` : 'Confere todo texto feito por IA';
    }
    case 'estrategista':
      if (m.working_now) return 'Montando um plano';
      if (numero(m, 'planos_esperando') > 0n) return `${vezes(numero(m, 'planos_esperando'), 'plano espera', 'planos esperam')} você`;
      return 'Monta planos quando você pede';
    case 'pesquisador':
      if (m.working_now) return 'Lendo uma página';
      return numero(m, 'paginas_lidas') > 0n ? `Leu ${vezes(numero(m, 'paginas_lidas'), 'página', 'páginas')} em ${mes}` : 'Lê as páginas que você informar';
    case 'trafego':
      return numero(m, 'recomendacoes') > 0n ? `Recomendou ${vezes(numero(m, 'recomendacoes'), 'ação', 'ações')} em ${mes}, sem mexer em nada` : 'Registra o que faria, sem mexer em nada';
    default:
      return '';
  }
}

// ------------------------------------------------------------------ acerto e custo

export interface Numero {
  valor: string;
  rotulo: string;
}

/** O bloco "Acerto": o que foi contado no mês (o Gestor de tráfego usa os blocos da sombra). */
export function acertoDo(m: TeamMember, mes: string): Numero[] {
  const n = (k: string) => inteiro(numero(m, k));
  switch (m.key) {
    case 'lia': {
      const respostas = numero(m, 'respostas');
      return [
        { valor: n('fez_sentido'), rotulo: `de ${vezes(respostas, 'resposta marcada', 'respostas marcadas')} "Fez sentido"` },
        { valor: n('demandas'), rotulo: numero(m, 'demandas') === 1n ? 'demanda aberta' : 'demandas abertas' },
        { valor: n('retiradas_na_conferencia'), rotulo: 'respostas retiradas na conferência' },
      ];
    }
    case 'analista': {
      const total = numero(m, 'explicacoes');
      const bom = numero(m, 'fez_sentido');
      const parte = total > 0n ? ` (${(bom * 100n) / total}%)` : '';
      return [
        { valor: n('fez_sentido'), rotulo: `de ${vezes(total, 'explicação marcada', 'explicações marcadas')} "Fez sentido"${parte}` },
        { valor: n('discordo'), rotulo: '"Discordo", com o motivo' },
        { valor: n('retiradas_na_conferencia'), rotulo: 'respostas retiradas na conferência dos números' },
      ];
    }
    case 'relatorios':
      return [
        { valor: n('revisoes'), rotulo: numero(m, 'revisoes') === 1n ? 'revisão entregue' : 'revisões entregues' },
        { valor: n('com_leitura_da_ia'), rotulo: 'com a leitura da LIA' },
        { valor: n('so_do_sistema'), rotulo: 'saídas sem a leitura da LIA' },
      ];
    case 'compliance':
      return [
        { valor: n('textos_barrados'), rotulo: `${numero(m, 'textos_barrados') === 1n ? 'texto barrado' : 'textos barrados'} em ${mes}` },
        { valor: n('textos_conferidos'), rotulo: numero(m, 'textos_conferidos') === 1n ? 'texto conferido' : 'textos conferidos' },
      ];
    case 'estrategista':
      return [
        { valor: n('planos_aprovados'), rotulo: numero(m, 'planos_aprovados') === 1n ? 'plano aprovado' : 'planos aprovados' },
        { valor: n('planos_recusados'), rotulo: numero(m, 'planos_recusados') === 1n ? 'recusado, com o motivo' : 'recusados, com o motivo' },
        { valor: n('planos_esperando'), rotulo: 'esperando você' },
        { valor: n('em_preparo'), rotulo: 'em preparo' },
      ];
    case 'pesquisador':
      return [
        { valor: n('paginas_lidas'), rotulo: numero(m, 'paginas_lidas') === 1n ? 'página lida' : 'páginas lidas' },
        { valor: n('sugestoes'), rotulo: numero(m, 'sugestoes') === 1n ? 'sugestão para Minha marca' : 'sugestões para Minha marca' },
        { valor: n('recusadas'), rotulo: 'páginas que ele não pôde ler' },
      ];
    default:
      return [];
  }
}

/** O que foi contado junto do custo: "52 explicações", "3 planos". */
function feitosDo(m: TeamMember): string {
  switch (m.key) {
    case 'lia':
      return vezes(numero(m, 'respostas'), 'resposta', 'respostas');
    case 'analista':
      return vezes(numero(m, 'explicacoes'), 'explicação', 'explicações');
    case 'relatorios':
      return vezes(numero(m, 'revisoes'), 'revisão', 'revisões');
    case 'estrategista':
      return vezes(numero(m, 'planos_aprovados') + numero(m, 'planos_recusados') + numero(m, 'planos_esperando'), 'plano', 'planos');
    case 'pesquisador':
      return vezes(numero(m, 'paginas_lidas'), 'página lida', 'páginas lidas');
    default:
      return 'custo de IA';
  }
}

/** O bloco "Custo em <mês>": o valor (em reais pela cotação, ou em dólar) e o que foi feito com ele. */
export function custoDo(m: TeamMember, t: TeamResponse): Numero {
  if (m.key === 'compliance') {
    // As regras de texto rodam no código, sem custo. Com o revisor de IA ligado para a empresa, o custo é o dele.
    return m.cost.calls > 0
      ? { valor: custoNaTela(m.cost.usd_micros, t.usd_brl), rotulo: `${vezes(m.cost.calls, 'chamada', 'chamadas')} ao revisor de IA; as regras rodam no código` }
      : { valor: custoNaTela('0', t.usd_brl), rotulo: 'as regras rodam no código' };
  }
  if (m.key === 'trafego') return { valor: custoNaTela('0', t.usd_brl), rotulo: 'nesta fase, as recomendações são por regra' };
  return { valor: custoNaTela(m.cost.usd_micros, t.usd_brl), rotulo: feitosDo(m) };
}

/** O selo do topo: "IA em outubro: R$ 22,67 de R$ 104,48". */
export function seloDaIa(t: TeamResponse): string {
  return `IA em ${mesDe(t.month.from)}: ${custoNaTela(t.ai.spent_usd_micros, t.usd_brl)} de ${custoNaTela(t.ai.ceiling_usd_micros, t.usd_brl)}`;
}

// ------------------------------------------------------------------ avisos do topo

export interface AvisoDoTopo {
  chave: 'ia' | 'parada' | 'teto';
  tipo?: 'atencao' | 'perigo';
  icone: NomeIcone;
  titulo: string;
  texto: string;
}

export function avisosDa(t: TeamResponse, agora: Date): AvisoDoTopo[] {
  const avisos: AvisoDoTopo[] = [];
  if (!t.ai.enabled) {
    avisos.push({
      chave: 'ia',
      icone: 'info',
      titulo: 'A IA está desligada nesta empresa',
      texto:
        'Nenhum funcionário de IA trabalha. As telas, os avisos, a revisão da semana e as aprovações seguem funcionando, com os textos montados pelo sistema. Quem liga é a Liame, a pedido do dono.',
    });
  }
  if (t.stop) {
    const desde = quandoComHora(t.stop.since, agora);
    avisos.push(
      t.stop.by_company
        ? {
            chave: 'parada',
            tipo: 'perigo',
            icone: 'pause',
            titulo: `A equipe está parada desde ${desde}${t.stop.by ? `, por ${t.stop.by.name}` : ''}`,
            texto: `Nenhum funcionário de IA trabalha até ${t.can_stop ? 'você retomar' : 'alguém retomar'}. As telas, os números e as aprovações seguem funcionando.`,
          }
        : {
            chave: 'parada',
            tipo: 'perigo',
            icone: 'pause',
            titulo: `A equipe está parada pela Liame desde ${desde}`,
            texto: 'Nenhum funcionário de IA trabalha até a Liame retomar. As telas, os números e as aprovações seguem funcionando.',
          },
    );
  }
  if (t.ai.enabled && t.ai.band !== 'livre') {
    const gasto = BigInt(t.ai.spent_usd_micros);
    const teto = BigInt(t.ai.ceiling_usd_micros);
    const mes = mesDe(t.month.from);
    // A faixa é a pior entre o dia e o mês: se o mês não explica a faixa, quem passou foi o teto do dia.
    const peloMes = teto > 0n && gasto * 100n >= teto * (t.ai.band === 'bloqueado' ? 100n : t.ai.band === 'economico' ? 80n : 70n);
    const valores = `${custoNaTela(t.ai.spent_usd_micros, t.usd_brl)} de ${custoNaTela(t.ai.ceiling_usd_micros, t.usd_brl)} em ${mes}.`;
    if (t.ai.band === 'bloqueado') {
      avisos.push({
        chave: 'teto',
        tipo: 'perigo',
        icone: 'alert',
        titulo: peloMes ? `O uso de IA de ${mes} chegou ao teto da empresa` : 'O uso de IA de hoje chegou ao teto do dia',
        texto: `${valores} Os funcionários de IA param até ${peloMes ? 'o mês' : 'o dia'} virar; as telas seguem funcionando, com os textos do sistema.`,
      });
    } else {
      const parte = t.ai.band === 'economico' ? '80%' : '70%';
      avisos.push({
        chave: 'teto',
        tipo: 'atencao',
        icone: 'alert',
        titulo: peloMes ? `O uso de IA de ${mes} passou de ${parte} do teto da empresa` : `O uso de IA de hoje passou de ${parte} do teto do dia`,
        texto: `${valores} Perto do teto, as respostas ficam mais curtas; no teto, os funcionários param até ${peloMes ? 'o mês' : 'o dia'} virar, e as telas seguem funcionando.`,
      });
    }
  }
  return avisos;
}

// ------------------------------------------------------------------ o que fez

const TIPO_DE_DEMANDA: Record<string, string> = { promocao: 'promoção', plano: 'plano', pauta: 'pauta', analise: 'análise', outro: 'outro assunto' };
const TIPO_DE_PLANO: Record<string, string> = { noventa_dias: 'Plano de 90 dias', pauta: 'Pauta da semana', oferta: 'Oferta' };
/** De quem era o texto barrado, na frase; o que a tela não conhece vira "da equipe". */
const deQuem = (chave: string | null): string => (chave && ehMembro(chave) ? DO_MEMBRO[chave] : 'da equipe');
/** As regras de texto do servidor (`policy/texto.ts`), como a pessoa lê; nome novo aparece sem os traços. */
const REGRAS: Record<string, string> = {
  politico_eleitoral: 'conteúdo político ou eleitoral',
  promessa_de_resultado: 'promessa de resultado',
  categoria_proibida: 'categoria proibida',
  dado_pessoal: 'dado pessoal',
  texto_longo: 'texto longo demais para conferir',
  regra_da_marca: 'regra da marca',
};
const PAGINA_RECUSADA: Record<string, string> = {
  robots: 'O site pede para não ser lido por robôs.',
  instrucao_na_pagina: 'A página tinha texto tentando dar ordens a quem lê.',
  sem_texto: 'A página não tinha texto para ler.',
  nao_e_pagina: 'O endereço não é uma página.',
  grande_demais: 'A página é grande demais.',
  rede_interna: 'O endereço não é público.',
};
const PAGINA_FALHOU: Record<string, string> = {
  fora_do_ar: 'O site estava fora do ar.',
  sem_ia: 'A IA não estava disponível.',
  formato: 'A resposta veio fora do formato.',
};
/** As categorias do revisor de IA do Compliance (`ai/revisor/parecer.ts`), como a pessoa lê; vêm no mesmo campo das regras. */
const DO_REVISOR: Record<string, string> = {
  tom: 'o tom',
  clareza: 'a clareza',
  alegacao: 'uma alegação que ninguém pode provar',
};
const RETIRADA: Record<string, string> = {
  revisor: 'Barrado pelo revisor de IA.',
  revisor_sem_resposta: 'O revisor de IA não respondeu, e sem a revisão dele o texto não aparece.',
  numero_fora: 'Citava um número que o sistema não calculou.',
  dado_velho: 'Os dados não estavam em dia.',
  formato: 'A resposta veio fora do formato.',
};
const COMPARACAO: Record<string, string> = {
  teria_melhorado: 'A recomendação teria rendido mais do que o que foi feito.',
  teria_piorado: 'A recomendação teria rendido menos do que o que foi feito.',
  igual: 'Daria no mesmo.',
  sem_dado: 'Sem dado para comparar.',
};

const nomeDaRegra = (r: string) => REGRAS[r] ?? r.replaceAll('_', ' ');
const emLista = (itens: string[]) => (itens.length < 2 ? itens.join('') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`);
/** Por que o Compliance barrou: a regra de texto que bateu ou, quando foi o revisor de IA, o que ele apontou. */
function regrasDe(rules: string[]): string {
  if (!rules.length) return '';
  if (rules.every((r) => Object.hasOwn(DO_REVISOR, r))) return `O revisor de IA apontou ${emLista(rules.map((r) => DO_REVISOR[r]!))}. `;
  return `Regra: ${rules.map(nomeDaRegra).join(', ')}. `;
}

/** "reduzir a verba em 10%", "pausar a campanha", "aumentar a verba em 10%". */
export function acaoDa(tool: string | null, percent: number | null): string {
  const quanto = percent ? ` em ${percent}%` : '';
  if (tool === 'orcamento_reduzir') return `reduzir a verba${quanto}`;
  if (tool === 'orcamento_aumentar') return `aumentar a verba${quanto}`;
  if (tool === 'campanha_pausar') return 'pausar a campanha';
  return 'mexer na campanha';
}

const maiuscula = (s: string) => s.charAt(0).toLocaleUpperCase('pt-BR') + s.slice(1);

/** Quem fez, na frase: "Você aprovou", "Juliana aprovou" ou só o verbo no particípio. */
function quemFez(i: TeamActivityItem, verbo: string, semNome: string): string {
  if (i.mine) return `Você ${verbo}`;
  return i.by ? `${i.by.name} ${verbo}` : semNome;
}

function retornoDe(i: TeamActivityItem): string {
  if (i.feedback === 'fez_sentido') return i.mine ? ' Você marcou "Fez sentido".' : ' Marcada "Fez sentido".';
  if (i.feedback === 'discordo') return i.mine ? ' Você discordou; o motivo ficou guardado.' : ' Marcada "Discordo"; o motivo ficou guardado.';
  return i.mine ? ' Sem retorno ainda.' : '';
}

export interface LinhaDoHistorico {
  quando: string;
  titulo: string;
  texto: string;
}

/** Um acontecimento de `/v1/team/members/:key/activity` como a tela escreve. O que a tela não conhece vira uma linha genérica. */
export function historicoDo(i: TeamActivityItem, agora: Date): LinhaDoHistorico {
  const quando = quandoComHora(i.at, agora);
  const semana = i.period ? `de ${diaMesDe(i.period.from)} a ${diaMesDe(i.period.to)}` : 'da semana';
  const n = i.count ?? 0;
  switch (i.kind) {
    case 'respondeu':
      return {
        quando,
        titulo: i.subject ? `Respondeu na conversa "${i.subject}"` : i.mine ? 'Respondeu a uma pergunta sua' : 'Respondeu a uma pergunta',
        texto: `Com a fonte de cada número.${retornoDe(i)}`,
      };
    case 'abriu_demanda':
      return {
        quando,
        titulo: i.subject ? `Abriu a demanda "${i.subject}"` : 'Abriu uma demanda',
        texto: `Pedido de ${TIPO_DE_DEMANDA[i.detail ?? ''] ?? 'trabalho'}, entregue ao Estrategista.${i.mine ? ' Foi você quem pediu.' : i.by ? ` Quem pediu: ${i.by.name}.` : ''}`,
      };
    case 'explicou_resultados':
      return { quando, titulo: 'Explicou os resultados', texto: `Com a fonte de cada número.${retornoDe(i)}` };
    case 'explicou_aviso':
      return { quando, titulo: 'Explicou um aviso da Atenção', texto: `Com a fonte de cada número.${retornoDe(i)}` };
    case 'gerou_revisao':
      return {
        quando,
        titulo: `Gerou a revisão ${semana}`,
        texto: `${i.detail === 'lia' ? 'Com a leitura da LIA.' : 'Com o resumo do sistema, sem a leitura da LIA.'}${i.feedback ? retornoDe(i) : ''}`,
      };
    case 'enviou_revisao':
      return { quando, titulo: `Enviou a revisão ${semana} por e-mail`, texto: n === 1 ? 'Para 1 pessoa.' : `Para ${inteiro(n)} pessoas.` };
    case 'barrou_texto':
      return {
        quando,
        titulo: `${n > 1 ? `Barrou ${inteiro(n)} textos` : 'Barrou um texto'} ${deQuem(i.detail)}`,
        texto: `${regrasDe(i.rules)}${n > 1 ? 'Eles não apareceram' : 'Ele não apareceu'}: ficou o que o sistema escreve.`,
      };
    case 'retirada_na_conferencia': {
      // O Compliance barra por regra de texto (`compliance`) ou pelo revisor de IA (`revisor`): a regra, ou o que ele apontou.
      const doCompliance = i.detail === 'compliance' || (i.detail === 'revisor' && i.rules.length > 0);
      const motivo = doCompliance ? `Barrado pelo Compliance. ${regrasDe(i.rules)}`.trim() : (RETIRADA[i.detail ?? ''] ?? 'Não passou na conferência do código.');
      return { quando, titulo: n > 1 ? `${inteiro(n)} textos não passaram na conferência` : 'Um texto não passou na conferência', texto: `${motivo} Ficou o que o sistema escreve.` };
    }
    case 'recebeu_demanda':
      return {
        quando,
        titulo: i.subject ? `Recebeu a demanda "${i.subject}"` : 'Recebeu uma demanda',
        texto: `Pedido de ${TIPO_DE_DEMANDA[i.detail ?? ''] ?? 'trabalho'}. O plano chega para uma pessoa decidir.`,
      };
    case 'montou_plano':
      return {
        quando,
        titulo: i.subject ? `Montou o plano "${i.subject}"` : 'Montou um plano',
        texto: `${TIPO_DE_PLANO[i.detail ?? ''] ?? 'Plano'}${n > 1 ? `, versão ${n}` : ''}. Nada vai ao ar sem a decisão de uma pessoa.`,
      };
    case 'plano_aprovado':
      return { quando, titulo: i.subject ? `Plano "${i.subject}" aprovado` : 'Plano aprovado', texto: `${quemFez(i, 'aprovou', 'Aprovado')}.` };
    case 'plano_recusado':
      return { quando, titulo: i.subject ? `Plano "${i.subject}" recusado` : 'Plano recusado', texto: `${quemFez(i, 'recusou', 'Recusado')}. Ele guardou o motivo.` };
    case 'plano_nova_analise':
      return { quando, titulo: i.subject ? `Nova análise pedida para "${i.subject}"` : 'Nova análise pedida', texto: `${quemFez(i, 'pediu outra versão', 'Outra versão foi pedida')}.` };
    case 'leu_pagina':
      return {
        quando,
        titulo: i.subject ? `Leu a página de ${i.subject}` : 'Leu uma página',
        texto: n > 0 ? `Trouxe ${n === 1 ? 'sugestão para 1 parte' : `sugestões para ${n} partes`} de Minha marca. Nada entra sem alguém confirmar.` : 'Não achou o que sugerir.',
      };
    case 'pagina_recusada':
      return { quando, titulo: i.subject ? `Não leu a página de ${i.subject}` : 'Não leu uma página', texto: PAGINA_RECUSADA[i.detail ?? ''] ?? 'A leitura foi recusada.' };
    case 'pagina_falhou':
      return { quando, titulo: i.subject ? `Não conseguiu ler a página de ${i.subject}` : 'Não conseguiu ler uma página', texto: PAGINA_FALHOU[i.detail ?? ''] ?? 'A leitura falhou.' };
    case 'recomendou':
      return { quando, titulo: `Recomendou ${acaoDa(i.detail, i.count)}${i.subject ? `: ${i.subject}` : ''}`, texto: 'Em sombra: nada mudou na plataforma.' };
    case 'comparou':
      return { quando, titulo: `Comparou o resultado${i.subject ? `: ${i.subject}` : ''}`, texto: COMPARACAO[i.detail ?? ''] ?? 'Comparação registrada.' };
    case 'promocao_proposta':
      return {
        quando,
        titulo: `O sistema propôs mostrar as recomendações de ${acaoDa(i.detail, null)}`,
        texto: `${i.subject ? `${i.subject}: ` : ''}os cinco portões passaram${n ? `, com ${inteiro(n)} decisões comparáveis` : ''}. Quem decide é uma pessoa.`,
      };
    case 'promocao_aprovada':
      return { quando, titulo: `Promoção aprovada: ${acaoDa(i.detail, null)}`, texto: `${quemFez(i, 'aprovou', 'Aprovada')}. As recomendações dessa ação aparecem na Atenção.` };
    case 'promocao_recusada':
      return { quando, titulo: `Promoção recusada: ${acaoDa(i.detail, null)}`, texto: `${quemFez(i, 'recusou', 'Recusada')}. Ele segue em sombra nessa ação.` };
    case 'promocao_retirada':
      return { quando, titulo: `Proposta retirada: ${acaoDa(i.detail, null)}`, texto: 'Os portões deixaram de passar antes de alguém decidir.' };
    case 'voltou_para_sombra':
      return { quando, titulo: `De volta para sombra: ${acaoDa(i.detail, null)}`, texto: `${quemFez(i, 'voltou a ação para sombra', 'A ação voltou para sombra')}. Nada mais aparece na Atenção por ele.` };
    case 'desligado':
      return { quando, titulo: 'Desligado nesta marca', texto: `${quemFez(i, 'desligou', 'Desligado pela empresa')}. O histórico ficou guardado.` };
    case 'ligado':
      return { quando, titulo: 'Ligado de novo', texto: `${quemFez(i, 'ligou', 'Ligado pela empresa')}.` };
    default:
      return { quando, titulo: 'Registrou um trabalho', texto: i.subject ?? '' };
  }
}

// ------------------------------------------------------------------ a sombra do Gestor de tráfego

const moedaAbs = (micros: string) => reaisDeMicros(BigInt(micros) < 0n ? -BigInt(micros) : BigInt(micros));
const mesmaDirecao = (a: string | null) => a === 'igual' || a === 'mesma_direcao';

export interface LinhaDaSombra {
  dia: string;
  campanha: string;
  eleFaria: string;
  voceFez: string;
  resultado: string;
}

const FEZ: Record<string, string> = { pausou: 'Pausou', reduziu_verba: 'Reduziu a verba', aumentou_verba: 'Aumentou a verba', nenhuma: 'Nada' };

/** Uma recomendação em sombra como a tabela do Pro mostra. */
export function linhaDaSombra(d: TeamShadowDecision, agora: Date): LinhaDaSombra {
  const fez = d.human_action ? (FEZ[d.human_action] ?? 'Mexeu na campanha') : d.status === 'aberta' ? 'Nada ainda' : 'Nada';
  const quandoFez = d.human_action && d.human_action !== 'nenhuma' && d.human_action_on ? (d.human_action_on === d.decided_on ? ' no mesmo dia' : ` em ${diaMesDe(d.human_action_on)}`) : '';
  let resultado: string;
  if (d.status === 'aberta') resultado = `${mesmaDirecao(d.agreement) ? 'mesma direção · ' : ''}compara em ${diaMesDe(d.evaluate_on)}`;
  else if (d.status === 'descartada') resultado = 'sem como comparar';
  else if (d.regret_label === 'teria_melhorado' && d.regret_micros) resultado = `teria rendido ${moedaAbs(d.regret_micros)} a mais`;
  else if (d.regret_label === 'teria_piorado' && d.regret_micros) resultado = `teria rendido ${moedaAbs(d.regret_micros)} a menos`;
  else if (d.regret_label === 'igual') resultado = 'daria no mesmo';
  else resultado = `${mesmaDirecao(d.agreement) ? 'mesma direção · ' : ''}sem como comparar`;
  return { dia: diaDaLoja(d.decided_on, agora), campanha: d.campaign.name, eleFaria: maiuscula(acaoDa(d.tool, d.percent)), voceFez: `${fez}${quandoFez}`, resultado };
}

export interface FraseDaSombra {
  /** Trechos da frase; os marcados vão em negrito. */
  partes: Array<{ texto: string; forte?: boolean }>;
}

/** A frase do Lite: quantas recomendações no mês, em quantas a pessoa foi na mesma direção e o resultado na soma. */
export function fraseDaSombra(m: TeamMember, mes: string): FraseDaSombra {
  const recomendacoes = numero(m, 'recomendacoes');
  const comparaveis = numero(m, 'comparaveis');
  const iguais = numero(m, 'mesma_direcao');
  const soma = numero(m, 'arrependimento');
  if (recomendacoes === 0n) return { partes: [{ texto: `Em ${mes}, ele ainda não recomendou nada. As recomendações saem todo dia, depois da leitura da manhã, quando alguma campanha pede.` }] };
  const partes: FraseDaSombra['partes'] = [{ texto: `Em ${mes}, ele recomendou ` }, { texto: inteiro(recomendacoes), forte: true }, { texto: recomendacoes === 1n ? ' ação. ' : ' ações. ' }];
  if (comparaveis === 0n) {
    partes.push({ texto: 'Ainda não dá para comparar nenhuma: a comparação sai 7 dias depois de cada recomendação.' });
    return { partes };
  }
  partes.push(
    { texto: `Das ${inteiro(comparaveis)} que já dá para comparar, em ` },
    { texto: inteiro(iguais), forte: true },
    { texto: ' você fez o mesmo ou foi na mesma direção. ' },
  );
  if (soma === 0n) partes.push({ texto: 'Na soma, as recomendações dele dariam no mesmo que o que foi feito.' });
  else {
    partes.push(
      { texto: 'Na soma, as recomendações dele teriam rendido ' },
      { texto: `${moedaAbs(soma.toString())} ${soma < 0n ? 'a mais' : 'a menos'}`, forte: true },
      { texto: ' do que o que foi feito.' },
    );
  }
  return { partes };
}

export interface Rodada {
  /** "hoje" ou "02/10": o último dia em que a rotina terminou. */
  dia: string;
  nota: string;
  passos: Array<{ texto: string; ferramentas: string[] }>;
  /** A última tentativa não rodou (os dados não estavam em dia). */
  aviso: string | null;
}

/** O bloco "Última rodada" (Pro): o que a rotina fez no último dia em que terminou. Nulo antes da primeira. */
export function rodadaDa(s: TeamShadowResponse, agora: Date): Rodada | null {
  if (!s.last_run?.on) return null;
  const dia = s.last_run.on;
  const registradas = s.items.filter((d) => d.decided_on === dia).length;
  return {
    dia: diaDaLoja(dia, agora),
    nota: `regras da sombra, versão ${s.rule_version}`,
    passos: [
      { texto: 'Leu os resultados de 7 dias das campanhas', ferramentas: ['Resultados · leitura'] },
      { texto: 'Comparou cada campanha com as regras da sombra', ferramentas: ['Cálculo por código'] },
      { texto: registradas === 0 ? 'Não registrou recomendação nova: nenhuma campanha pediu' : `Registrou ${vezes(registradas, 'recomendação', 'recomendações')}, sem mexer em nada`, ferramentas: ['Sombra · registro'] },
      { texto: 'Conferiu o que você fez desde a rodada anterior', ferramentas: ['Meta Ads e Google Ads · leitura'] },
    ],
    aviso:
      s.last_run.status === 'dado_velho'
        ? `A última tentativa${s.last_run.at ? ` (${quandoComHora(s.last_run.at, agora)})` : ''} não rodou: os dados das contas não estavam em dia.`
        : null,
  };
}

// ------------------------------------------------------------------ prontidão e promoção

const PLATAFORMA: Record<string, string> = { meta_ads: 'Meta Ads', google_ads: 'Google Ads' };
const MODO: Record<string, string> = { SHADOW: 'Sombra', SUGGEST: 'Sugerir', APPROVAL: 'Aprovação', LIMITED_AUTO: 'Auto limitado', AUTO: 'Automático', ESCALATE: 'Escalar' };

export const plataformaDe = (provider: string) => PLATAFORMA[provider] ?? provider;
export const modoEscrito = (mode: string) => MODO[mode] ?? mode;

/** "Meta Ads · Reduzir a verba". */
export function alvoDe(a: AutonomyItem): string {
  return `${plataformaDe(a.provider)} · ${maiuscula(acaoDa(a.tool, null))}`;
}

/** "83.4" → "83,4%"; "86.0" → "86%"; nula → "—". */
export function porcento(p: string | null): string {
  if (p === null) return '—';
  return `${p.endsWith('.0') ? p.slice(0, -2) : p.replace('.', ',')}%`;
}

export interface Portao {
  chave: string;
  rotulo: string;
  valor: string;
  passou: boolean;
  /** Como aparece em "Falta: …". */
  curto: string;
}

/** Os cinco portões da prontidão de uma conta e ação, com o valor de agora. Sem retrato, nenhum passou. */
export function portoesDe(a: AutonomyItem, limites: AutonomyThresholds): Portao[] {
  const r = a.readiness;
  const passou = (chave: string) => r !== null && !r.missing.includes(chave);
  const soma = r ? BigInt(r.regret_sum_micros) : 0n;
  return [
    { chave: 'amostra', rotulo: 'Decisões comparáveis', valor: `${r ? r.sample_size : 0} de ${limites.sample_size}`, passou: passou('amostra'), curto: 'decisões comparáveis' },
    {
      chave: 'concordancia',
      rotulo: 'Você fez o mesmo ou foi na mesma direção',
      valor: `${porcento(r?.agreement_pct ?? null)} (mín. ${limites.agreement_min_pct}%)`,
      passou: passou('concordancia'),
      curto: 'concordância',
    },
    { chave: 'piora', rotulo: 'Vezes em que ele teria piorado', valor: `${porcento(r?.worse_pct ?? null)} (máx. ${limites.worse_max_pct}%)`, passou: passou('piora'), curto: 'vezes em que teria piorado' },
    {
      chave: 'arrependimento',
      rotulo: 'Na soma, ele teria feito',
      valor: !r ? '—' : soma === 0n ? 'igual a você' : `${moedaAbs(r.regret_sum_micros)} ${soma < 0n ? 'melhor' : 'pior'} que você`,
      passou: passou('arrependimento'),
      curto: 'resultado na soma',
    },
    {
      chave: 'confianca',
      rotulo: 'Confiança média das recomendações',
      valor: `${porcento(r?.confidence_avg_pct ?? null)} (mín. ${limites.confidence_min_pct}%)`,
      passou: passou('confianca'),
      curto: 'confiança',
    },
  ];
}

/** Quantas decisões comparáveis faltam para o portão da amostra. */
export function faltamNaAmostra(a: AutonomyItem, limites: AutonomyThresholds): number {
  return Math.max(0, limites.sample_size - (a.readiness?.sample_size ?? 0));
}
