import type { TeamStat } from '@liame/contracts';
import { CRIATIVO_DA_EQUIPE, CRM_DA_EQUIPE, type DefinicaoDoMembro, GESTOR_DE_TRAFEGO, type Membro, SOCIAL_DA_EQUIPE } from './membros.js';

// Sua equipe (A3, I13b): a situação de cada membro e o que ele fez no mês, montados pelo código a partir das
// contagens que o serviço lê do banco. Funções puras.

export type SituacaoDoMembro = 'ativo' | 'sombra' | 'desligado' | 'desligado_pela_liame' | 'parado';

export interface FatosDoMembro {
  /** A empresa desligou este membro nesta marca. */
  pausado: boolean;
  /** A chave da distribuição (o plano) deixa este membro trabalhar (quem não está no registro, sempre). */
  peloPlano: boolean;
  /** A flag `ia` da empresa. */
  ia: boolean;
  /** A flag `sombra` da empresa. */
  sombra: boolean;
  /** A flag `criativo` da empresa (só o Criativo depende dela). */
  criativo: boolean;
  /**
   * O CRM e mensageria está ligado para a empresa: a flag `crm` e as duas do envio de mensagens (`mensageria` e
   * `whatsapp_campaign`). Sem uma delas ele não consegue propor nada, e a tela diz que ainda não está ligado.
   */
  crm: boolean;
  /**
   * O Social media está ligado para a empresa, por um dos dois trabalhos dele: as respostas (a função das sugestões,
   * `respostas_sugeridas`, e a resposta pelo Liame, `perfil_google_write`, que a rotina confere em
   * `oQueDesligaAsSugestoes`) ou os posts (a função `posts_sugeridos` e a publicação pelo Liame, `social_write`, que a
   * rotina confere em `oQueDesligaOsPosts`). Sem nenhum dos dois ele não propõe nada, e a tela diz que ainda não está ligado.
   */
  social: boolean;
  /** Há uma parada (da empresa ou da Liame) que trava a IA desta marca. */
  parada: boolean;
}

/**
 * A situação de um membro, do que mais pesa ao que menos: desligado pela empresa; fora do plano; quem usa IA para
 * sem a IA e trava com a parada (o Criativo e o CRM e mensageria, além da IA, precisam das flags deles); o Gestor de
 * tráfego só trabalha com a sombra ligada. Quem trabalha por regra
 * (Relatórios, Compliance, a sombra) segue com a parada: ela trava a IA e as ações, e eles não fazem nenhuma das duas
 * (a revisão da semana sai com o resumo do sistema).
 */
export function situacaoDoMembro(def: DefinicaoDoMembro, f: FatosDoMembro): SituacaoDoMembro {
  if (f.pausado) return 'desligado';
  if (!f.peloPlano) return 'desligado_pela_liame';
  if (def.kind === 'ia') {
    if (!f.ia) return 'desligado_pela_liame';
    if (def.key === CRIATIVO_DA_EQUIPE && !f.criativo) return 'desligado_pela_liame';
    if (def.key === CRM_DA_EQUIPE && !f.crm) return 'desligado_pela_liame';
    if (def.key === SOCIAL_DA_EQUIPE && !f.social) return 'desligado_pela_liame';
    return f.parada ? 'parado' : 'ativo';
  }
  if (def.key === GESTOR_DE_TRAFEGO) return f.sombra ? 'sombra' : 'desligado_pela_liame';
  return 'ativo';
}

/** As contagens do mês que o serviço leu (zero quando não há). */
export interface ContagensDoMes {
  /**
   * Respostas do modelo, por fluxo: as chamadas que entregaram a resposta de um pedido (`ai_usage.answered`). Uma
   * resposta com leituras faz várias chamadas; só a última conta. É o que chegou à conferência.
   */
  respostasPorFluxo: Map<string, number>;
  /** As respostas que chegaram à pessoa, por fluxo: as de cima, menos as que a conferência recusou. */
  entreguesPorFluxo: Map<string, number>;
  /** "Fez sentido" e "Discordo" das pessoas, por fluxo. */
  retornoPorFluxo: Map<string, { fezSentido: number; discordo: number }>;
  demandasDaLia: number;
  revisoes: number;
  revisoesComLeituraDaIa: number;
  planosAprovados: number;
  planosRecusados: number;
  planosEsperando: number;
  emPreparo: number;
  paginasLidas: number;
  paginasRecusadas: number;
  sugestoesDoPesquisador: number;
  recomendacoes: number;
  comparaveis: number;
  mesmaDirecao: number;
  /** Soma do arrependimento das comparáveis, em micros de real (negativo: as recomendações teriam feito melhor). */
  arrependimentoMicros: bigint;
  /**
   * O que a conferência recusou, por funcionário que escreveu (`ai_refusal`, D-A3-15): os textos barrados pelo
   * Compliance (regra de texto ou revisor de IA) e as outras recusas (número, formato, dado velho).
   */
  recusasPorMembro: Map<string, { doCompliance: number; outras: number }>;
  /** O trabalho do Criativo (A4, X6): os pedidos e as peças do mês, as de hoje e as que esperam a pessoa agora. */
  pecas: PecasDoCriativo;
  /** O trabalho do CRM e mensageria (A5, Y6): as mensagens que ele propôs no mês e o que elas trouxeram pelo cupom. */
  mensagens: MensagensDoCrm;
  /** O trabalho do Social media (A6, Z6): as respostas às avaliações que ele propôs no mês e o que as pessoas decidiram. */
  respostas: RespostasDoSocial;
  /** O trabalho do Social media (A6, Z6, os posts): os posts que ele propôs no mês e o que as pessoas decidiram. */
  posts: PostsDoSocial;
}

export interface RespostasDoSocial {
  /** Pedidos de resposta que ele montou no mês (cada um com uma ou duas sugestões). */
  propostas: number;
  /** Dos propostos no mês, os que uma pessoa aprovou e foram para o Google, e os que foram recusados. */
  aprovadas: number;
  recusadas: number;
  /** Agora, na marca inteira: os pedidos dele que esperam a decisão em Aprovações. */
  esperando: number;
  /** As avaliações do mês em que a conferência barrou todas as sugestões (nada foi para Aprovações). */
  barradas: number;
}

export interface PostsDoSocial {
  /** Pedidos de post que ele montou no mês (o post na Agenda, um pedido em Aprovações). */
  propostos: number;
  /** Dos propostos no mês, os que saíram em pelo menos uma rede, e os que uma pessoa recusou. */
  publicados: number;
  recusados: number;
  /** Agora, na marca inteira: os pedidos de post dele que esperam a decisão em Aprovações. */
  esperando: number;
  /** Os dias do mês em que a conferência barrou o post que ele escreveu (nada foi para Aprovações). */
  barrados: number;
}

/** Os posts do Social media agora, como o serviço os leu (ligados os posts para a empresa). */
export interface PostsAgora {
  /** Nenhum Instagram nem Página conectados a esta marca: não há onde publicar. */
  semRede: boolean;
  /** Nenhuma foto pronta nas Fotos da marca: ele só usa as fotos de verdade da empresa. */
  semFotos: boolean;
  /** Nenhum item da pauta aprovada daqui em diante: ele propõe a partir da pauta, e não há o que propor. */
  semPauta: boolean;
  /** Os dias da pauta na fila dele (as vezes `esperando`), desde quando espera o mais antigo e o teto de IA que os segura. */
  fila: { dias: number; desde: string | null; teto: 'dia' | 'mes' | null };
}

/** A fila do Social media agora, como o serviço a leu (as vezes `esperando` da marca). */
export interface FilaDoSocial {
  /** Quantas avaliações esperam as sugestões dele, inclusive a que espera uma nova tentativa. */
  avaliacoes: number;
  /** Desde quando espera a mais antiga, em ISO (nulo sem fila). */
  desde: string | null;
  /** O teto de gasto de IA da empresa segura a fila: o do mês pesa mais que o do dia. */
  teto: 'dia' | 'mes' | null;
}

export interface AgoraDoSocial {
  workingNow: boolean;
  /** `kind` é `posts` quando o que está na fila são os dias da pauta; nas avaliações, não vem. */
  inProgress: { subject: null; count: number; by: null; since: string; kind?: string } | null;
  blockedBy: string | null;
}

/**
 * O que o Social media tem na fila e o que o segura agora (P21), do que mais pesa ao que menos. Só com as respostas: sem
 * uma loja do Perfil conectada não há avaliação para responder, e nada mais importa; o teto de IA da empresa segura a
 * fila inteira (a tela diz qual, e quantas esperam); com avaliação na fila, ele está trabalhando. Com os posts (o
 * trabalho principal, D-A6-60): o teto segura as duas filas; sem Instagram nem Página conectados (`sem_rede`) ou sem
 * nenhuma foto pronta (`sem_fotos`) ele não propõe post, e as respostas da fila seguem; os dias da pauta na fila vêm
 * antes das avaliações; sem fila e sem item da pauta aprovada daqui em diante, ele espera a pauta (`sem_pauta`).
 * Desligado ou parado, nada disso se diz. Sem o texto da avaliação nem o do item: eles ficam nas telas deles.
 */
export function agoraDoSocial(f: { ativo: boolean; semPerfil: boolean; fila: FilaDoSocial; respostas?: boolean; posts?: PostsAgora | null }): AgoraDoSocial {
  if (!f.ativo) return { workingNow: false, inProgress: null, blockedBy: null };
  // Só as respostas ligadas (o P21 antes dos posts): a regra de sempre.
  if (!f.posts) {
    if (f.semPerfil) return { workingNow: false, inProgress: null, blockedBy: 'sem_perfil' };
    const naFila = f.fila.avaliacoes > 0 && f.fila.desde ? { subject: null, count: f.fila.avaliacoes, by: null, since: f.fila.desde } : null;
    if (f.fila.teto) return { workingNow: false, inProgress: naFila, blockedBy: limiteDeIa(f.fila.teto) };
    return { workingNow: naFila !== null, inProgress: naFila, blockedBy: null };
  }
  // Com os posts (o P21 inteiro): o post é o trabalho principal, e as respostas, quando ligadas, seguem ao lado.
  const p = f.posts;
  const respostas = f.respostas === true && !f.semPerfil;
  const avaliacoes = respostas && f.fila.avaliacoes > 0 && f.fila.desde ? { subject: null, count: f.fila.avaliacoes, by: null, since: f.fila.desde } : null;
  const semOndePostar = p.semRede ? 'sem_rede' : p.semFotos ? 'sem_fotos' : null;
  const dias = !semOndePostar && p.fila.dias > 0 && p.fila.desde ? { subject: null, count: p.fila.dias, by: null, since: p.fila.desde, kind: 'posts' } : null;
  // O teto de IA da empresa segura as duas filas: o do mês pesa mais que o do dia.
  const teto = p.fila.teto === 'mes' || (respostas && f.fila.teto === 'mes') ? 'mes' : p.fila.teto === 'dia' || (respostas && f.fila.teto === 'dia') ? 'dia' : null;
  if (teto && (dias || avaliacoes)) return { workingNow: false, inProgress: dias ?? avaliacoes, blockedBy: limiteDeIa(teto) };
  // Sem rede ou sem Fotos, ele não propõe post (a tela diz o que falta); as respostas da fila seguem.
  if (semOndePostar) return { workingNow: avaliacoes !== null, inProgress: avaliacoes, blockedBy: semOndePostar };
  if (dias || avaliacoes) return { workingNow: true, inProgress: dias ?? avaliacoes, blockedBy: null };
  // Nada na fila e nenhum item da pauta aprovada daqui em diante: ele espera a pauta.
  return { workingNow: false, inProgress: null, blockedBy: p.semPauta ? 'sem_pauta' : null };
}

const limiteDeIa = (teto: 'dia' | 'mes'): string => (teto === 'mes' ? 'limite_de_ia_do_mes' : 'limite_de_ia_do_dia');

export interface MensagensDoCrm {
  /** Pedidos de envio que ele montou no mês. */
  propostas: number;
  /** Dos propostos no mês, os que uma pessoa aprovou e foram para o RegemCast, e os que foram recusados. */
  enviadas: number;
  recusadas: number;
  /** Agora, na marca inteira: os pedidos dele que esperam a decisão em Aprovações. */
  esperando: number;
  /** Agora: as propostas cujo rascunho de modelo está no RegemCast, esperando a Meta (a fila `message_proposal`). */
  rascunhos: number;
  /** Os pedidos confirmados no caixa com o cupom das mensagens propostas no mês, e a receita deles, em micros de real. */
  pedidosComCupom: number;
  caixaComCupomMicros: bigint;
}

/** Uma proposta dele que ainda está no caminho (a fila `message_proposal`), como o serviço a leu. */
export interface PropostaEmAndamento {
  situacao: 'preparando' | 'rascunho';
  /** `promocao` ou `volte_a_pedir`. */
  motivo: string;
  /** A oferta de Minha marca de onde ela parte (nula no "volte a pedir" sem oferta). */
  oferta: string | null;
  /** O nome da mensagem, depois de escrita e conferida. */
  nome: string | null;
  /** Quantas pessoas do público podiam receber quando ele propôs. */
  pessoas: number;
  /** A situação do modelo que o RegemCast informou por último: `rascunho` enquanto ninguém o enviou para a Meta. */
  situacaoDoModelo: string | null;
  /** Quando ele começou a preparar e quando o rascunho do modelo nasceu no RegemCast, em ISO. */
  abertaEm: string;
  rascunhoEm: string | null;
}

export interface AgoraDoCrm {
  workingNow: boolean;
  inProgress: { subject: string | null; count: number; by: null; since: string; kind: string } | null;
  blockedBy: string | null;
}

/** O rascunho que o RegemCast guarda e ninguém enviou ainda para a análise da Meta (`modelo_rascunhar` devolve assim). */
const MODELO_SO_NO_REGEMCAST = 'rascunho';

/**
 * O que o CRM e mensageria tem em andamento e o que o segura agora (protótipo P16), do que mais pesa ao que menos:
 * sem o RegemCast conectado não há para quem propor, e nada mais importa; a proposta que ele prepara é trabalho em
 * andamento, sem impedimento; o rascunho que espera o modelo diz o que falta (uma pessoa enviar para a Meta, ou a
 * Meta terminar a análise); depois, a falta do desconto do cupom das mensagens (toda mensagem leva um cupom: sem ele,
 * nenhuma sai, nem o "volte a pedir"); por fim, Minha marca sem oferta. Desligado ou parado, nada disso se diz. A
 * oferta e o nome da mensagem só vão para quem vê as campanhas.
 */
export function agoraDoCrm(f: {
  ativo: boolean;
  semRegemcast: boolean;
  semDesconto: boolean;
  semOferta: boolean;
  emAndamento: PropostaEmAndamento[];
  veAsCampanhas: boolean;
}): AgoraDoCrm {
  if (!f.ativo) return { workingNow: false, inProgress: null, blockedBy: null };
  if (f.semRegemcast) return { workingNow: false, inProgress: null, blockedBy: 'sem_regemcast' };
  const preparando = f.emAndamento.find((p) => p.situacao === 'preparando');
  if (preparando) {
    const subject = f.veAsCampanhas ? preparando.oferta : null;
    return { workingNow: true, inProgress: { subject, count: preparando.pessoas, by: null, since: preparando.abertaEm, kind: preparando.motivo }, blockedBy: null };
  }
  const rascunho = f.emAndamento.find((p) => p.situacao === 'rascunho');
  if (rascunho) {
    const semEnvio = rascunho.situacaoDoModelo === null || rascunho.situacaoDoModelo === MODELO_SO_NO_REGEMCAST;
    return {
      workingNow: false,
      inProgress: { subject: f.veAsCampanhas ? rascunho.nome : null, count: rascunho.pessoas, by: null, since: rascunho.rascunhoEm ?? rascunho.abertaEm, kind: rascunho.motivo },
      blockedBy: semEnvio ? 'modelo_sem_envio' : 'modelo_em_analise',
    };
  }
  return { workingNow: false, inProgress: null, blockedBy: f.semDesconto ? 'sem_desconto' : f.semOferta ? 'sem_oferta' : null };
}

export interface PecasDoCriativo {
  /** Pedidos de peças novas atendidos no mês. */
  pedidos: number;
  /** Peças que nasceram no mês e, delas, as que uma pessoa aprovou ou recusou. */
  escritas: number;
  aprovadas: number;
  recusadas: number;
  /** Outras versões de uma peça, pedidas e entregues no mês. */
  refeitas: number;
  /** Peças que nasceram hoje (no fuso da empresa). */
  hoje: number;
  /** Agora, na marca inteira: as que passaram na conferência e esperam a decisão, e as que a conferência barrou. */
  esperando: number;
  barradas: number;
}

const qtd = (key: string, n: number): TeamStat => ({ key, value: String(n), unit: 'qtd' });

/**
 * Os números de Sua equipe que são de agora, e não do mês: o que espera a decisão, o que está em preparo, o de hoje. O
 * relatório do mês fechado não os guarda (D-A3-22): no dia 1º eles diriam o que está acontecendo, e não o que o mês fez.
 */
export const NUMEROS_DE_AGORA: ReadonlySet<string> = new Set([
  'planos_esperando',
  'em_preparo',
  'pecas_hoje',
  'pecas_esperando',
  'pecas_barradas',
  'mensagens_esperando',
  'rascunhos_esperando_o_modelo',
  'respostas_esperando',
  'posts_esperando',
]);

/** O que o membro fez no mês, como a tela mostra (as chaves estão no contrato `TeamStat`). */
export function numerosDoMembro(def: DefinicaoDoMembro, c: ContagensDoMes): TeamStat[] {
  const soma = (mapa: Map<string, number>) => def.fluxos.reduce((n, f) => n + (mapa.get(f) ?? 0), 0);
  const retorno = def.fluxos.reduce(
    (r, f) => ({ fezSentido: r.fezSentido + (c.retornoPorFluxo.get(f)?.fezSentido ?? 0), discordo: r.discordo + (c.retornoPorFluxo.get(f)?.discordo ?? 0) }),
    { fezSentido: 0, discordo: 0 },
  );
  const chave: Membro = def.key;
  // O que a conferência não deixou aparecer, do que este funcionário escreveu (por qualquer motivo).
  const recusas = c.recusasPorMembro.get(chave);
  const retiradas = qtd('retiradas_na_conferencia', (recusas?.doCompliance ?? 0) + (recusas?.outras ?? 0));
  switch (chave) {
    // Respostas e explicações são as que chegaram à pessoa; as que a conferência retirou vêm ao lado, em `retiradas`.
    case 'lia':
      return [qtd('respostas', soma(c.entreguesPorFluxo)), qtd('fez_sentido', retorno.fezSentido), qtd('discordo', retorno.discordo), qtd('demandas', c.demandasDaLia), retiradas];
    case 'analista':
      return [qtd('explicacoes', soma(c.entreguesPorFluxo)), qtd('fez_sentido', retorno.fezSentido), qtd('discordo', retorno.discordo), retiradas];
    case 'relatorios':
      return [qtd('revisoes', c.revisoes), qtd('com_leitura_da_ia', c.revisoesComLeituraDaIa), qtd('so_do_sistema', c.revisoes - c.revisoesComLeituraDaIa)];
    case 'compliance': {
      // Conferidos: todo texto de IA que chegou à conferência (cada resposta atendida de quem escreve; as chamadas do
      // próprio revisor de IA, que são os fluxos do Compliance, não são texto para conferir). Barrados: os que uma regra
      // de texto (ou o revisor de IA) não deixou aparecer, de qualquer funcionário.
      const conferidos = [...c.respostasPorFluxo.entries()].filter(([fluxo]) => !def.fluxos.includes(fluxo)).reduce((n, [, x]) => n + x, 0);
      const barrados = [...c.recusasPorMembro.values()].reduce((n, x) => n + x.doCompliance, 0);
      return [qtd('textos_conferidos', conferidos), qtd('textos_barrados', barrados)];
    }
    case 'estrategista':
      return [qtd('planos_aprovados', c.planosAprovados), qtd('planos_recusados', c.planosRecusados), qtd('planos_esperando', c.planosEsperando), qtd('em_preparo', c.emPreparo), retiradas];
    case 'pesquisador':
      return [qtd('paginas_lidas', c.paginasLidas), qtd('recusadas', c.paginasRecusadas), qtd('sugestoes', c.sugestoesDoPesquisador), retiradas];
    case 'criativo':
      return [
        qtd('pedidos', c.pecas.pedidos),
        qtd('pecas_escritas', c.pecas.escritas),
        qtd('pecas_aprovadas', c.pecas.aprovadas),
        qtd('pecas_recusadas', c.pecas.recusadas),
        qtd('versoes_refeitas', c.pecas.refeitas),
        qtd('pecas_hoje', c.pecas.hoje),
        qtd('pecas_esperando', c.pecas.esperando),
        qtd('pecas_barradas', c.pecas.barradas),
        retiradas,
      ];
    case 'crm':
      return [
        qtd('mensagens_propostas', c.mensagens.propostas),
        qtd('mensagens_enviadas', c.mensagens.enviadas),
        qtd('mensagens_recusadas', c.mensagens.recusadas),
        qtd('mensagens_esperando', c.mensagens.esperando),
        qtd('rascunhos_esperando_o_modelo', c.mensagens.rascunhos),
        qtd('pedidos_com_cupom', c.mensagens.pedidosComCupom),
        { key: 'caixa_com_cupom', value: c.mensagens.caixaComCupomMicros.toString(), unit: 'brl_micros' },
        retiradas,
      ];
    case 'social':
      return [
        qtd('posts_propostos', c.posts.propostos),
        qtd('posts_publicados', c.posts.publicados),
        qtd('posts_recusados', c.posts.recusados),
        qtd('posts_esperando', c.posts.esperando),
        qtd('posts_barrados', c.posts.barrados),
        qtd('respostas_propostas', c.respostas.propostas),
        qtd('respostas_aprovadas', c.respostas.aprovadas),
        qtd('respostas_recusadas', c.respostas.recusadas),
        qtd('respostas_esperando', c.respostas.esperando),
        qtd('sugestoes_barradas', c.respostas.barradas),
        retiradas,
      ];
    case 'trafego':
      return [
        qtd('recomendacoes', c.recomendacoes),
        qtd('comparaveis', c.comparaveis),
        qtd('mesma_direcao', c.mesmaDirecao),
        { key: 'arrependimento', value: c.arrependimentoMicros.toString(), unit: 'brl_micros' },
      ];
  }
}
