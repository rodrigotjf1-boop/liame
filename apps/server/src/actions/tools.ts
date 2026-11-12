import { type BudgetImpact, DIRECT_AUTO_REPLY_NOTICE, type RiskLevel } from '@liame/contracts';
import { z } from 'zod';
import { emMenorUnidade } from '../connectors/meta/verba.js';
import { type ContextoDaAvaliacao, EstadoDaAvaliacao, ehNotaBaixa, ParametrosDaResposta, planoDaResposta, planoDeApagar } from './avaliacao-plano.js';
import {
  ACAO_DE_RESPONDER_SOZINHO,
  AVISO_DE_RESPOSTA_AUTOMATICA,
  type ContextoDoComentario,
  FLAG_DE_RESPONDER_COMENTARIOS,
  ParametrosDaRespostaAoComentario,
  ParametrosDaRespostaAutomatica,
  planoDaRespostaAoComentario,
  planoDeApagarARespostaAoComentario,
  planoDeMostrar,
  planoDeOcultar,
} from './comentario-plano.js';
import {
  ACAO_DE_RESPONDER_NO_DIRECT_SOZINHO,
  FERRAMENTA_DO_DIRECT_AUTOMATICO,
  FLAG_DE_RESPONDER_NO_DIRECT,
  ParametrosDaRespostaNoDirect,
  planoDaRespostaNoDirect,
} from './direct-plano.js';
import { EstadoDaMensagem, faseDaMensagem, impedimentoDaMensagem } from './mensagem-plano.js';
import { planoDaCampanhaGoogle } from '../campanhas/campanha-google-plano.js';
import { planoDaCampanhaNova, planoDeAtivar, planoDePausar } from '../campanhas/campanha-nova-plano.js';
import { EstadoDoPost, planoDeApagarOPost, planoDeTentarDeNovo, planoDoPost, quandoSai } from '../posts/post-plano.js';
import { motivoDoCompartilhado, orcamentoCompartilhado } from './orcamento-compartilhado.js';

// Registro de ferramentas (arquitetura §6, ADR-007): cada ferramenta declara risco, impacto financeiro,
// estratégia de compensação e o formato dos parâmetros. Ferramenta nova só entra com isso e com testes.

export type ResourceState = Record<string, unknown>;

export interface ToolPlan {
  /** Código da ação para a política: `orcamento.aumentar`, `anuncio.pausar`. */
  action: string;
  budgetImpact: BudgetImpact;
  valueMicros: number | null;
  currentValueMicros: number | null;
  /** Quanto reservar no envelope do mês. */
  reserveMicros: number;
  desiredState: ResourceState;
  /**
   * O que impede a aprovação agora (A5, Y5; P15): o pedido entra e espera em Aprovações com este motivo, e ninguém
   * aprova enquanto ele durar. Diferente de `PlanoRecusado`, que é o pedido que nem nasce.
   */
  blocked?: string | null;
  /**
   * O texto que a ação publica em nome da empresa (A6, Z2: a resposta a uma avaliação). Vai para a política, para as
   * palavras que a empresa ou a marca proíbem valerem para ele. Nulo ou ausente: a ação não publica texto.
   */
  text?: string | null;
}

export interface ToolDefinition {
  name: string;
  /** Sobe a cada mudança de descrição, parâmetros ou risco: o registro (`tool_registry`) guarda cada versão. */
  version: number;
  /** Área responsável pela ferramenta. */
  owner: string;
  description: string;
  risk: RiskLevel;
  providers: readonly string[];
  compensation: string;
  params: z.ZodType<Record<string, unknown>>;
  /**
   * Do estado atual e dos parâmetros, o plano. Função pura: a mesma entrada dá o mesmo plano. `context` é o que o
   * conector leu junto com o estado e que o pedido NÃO guarda (A6, Z2: o nome de quem fez a avaliação, só para conferir
   * que a resposta não o cita): serve para recusar o plano, e nunca entra nele.
   */
  plan(before: ResourceState, params: Record<string, unknown>, context?: ResourceState | null): ToolPlan;
  /**
   * A volta (A4, X2): a ferramenta e os parâmetros que desfazem a ação, a partir do estado de ANTES dela. A volta é um
   * pedido novo, pelo mesmo trilho (política, aprovação, validação), e só é aceita se ninguém mexeu no objeto depois.
   * Sem esta função, a ação não tem volta pelo Liame.
   */
  undo?(before: ResourceState): { tool: string; params: Record<string, unknown> };
  /**
   * Nunca roda sem a aprovação de uma pessoa, mesmo que a política da empresa ou da marca peça autonomia e o
   * `autopilot` esteja ligado (A5, D-A5-11: mensagem de WhatsApp). A política ainda pode deixá-la em sombra.
   */
  alwaysApproval?: boolean;
  /**
   * O que impede a aprovação, lido do estado que o pedido guardou (o mesmo motivo de `plan().blocked`); nulo quando
   * nada impede. É o que a tela mostra no lugar do botão de aprovar.
   */
  blockedBy?(before: ResourceState): string | null;
  /**
   * A aprovação lê o recurso de novo na plataforma (A5, Y5): o plano de uma mensagem muda sozinho (a Meta aprova o
   * modelo, o público cresce, o teto enche), e a pessoa só aprova o plano de agora. Mudou, ela confere de novo;
   * impedido, espera.
   */
  revalidateOnApproval?: boolean;
  /**
   * Quando quem pede é uma pessoa e a política deixa a ação em modo automático, ela executa sem o código do app e
   * sem depender do `autopilot` (A5, Y5: pausar um envio de mensagem). A pessoa confirma na tela, e o pedido fica com o
   * nome dela. Só para ação que não gasta, não envia e não desfaz nada. O funcionário de IA não ganha isto. A exceção é a
   * nova tentativa do post (A6, Z5d; D-A6-54; P19): ela publica, mas o mesmo post que uma pessoa já aprovou com o código,
   * no canal que a aprovação cobriu e que não saiu.
   */
  directByPerson?: boolean;
  /**
   * A aprovação desta ação é de uma pessoa NO DESTINO (Hub DMS, F5 parte D; decisão F5-9; Padrão DMS §8, item 10): o
   * Liame não pede a própria aprovação. O pedido sai `aprovada` (fora da sombra) e o executor o leva ao destino, que
   * cria lá o pedido que uma pessoa da conta aprova com o código do aplicativo autenticador. A ferramenta tem a sua
   * `flag` (conferida no pedido e na execução), e o conector só aceita pelo caminho do pedido ao destino.
   */
  aprovacaoNoDestino?: boolean;
  /**
   * Só o dono da empresa decide este pedido: aprovar, recusar e alterar (A6, D-A6-4; P17: a resposta a uma avaliação
   * de 1 ou 2 estrelas). Lido do estado que o pedido guardou. Os outros leem o pedido e não mexem nele. A política põe
   * a mesma ação em ESCALATE, para a aprovação de outro papel nunca bastar; isto barra a tentativa antes. A volta de um
   * pedido assim também é só do dono.
   */
  ownerOnly?(before: ResourceState): boolean;
  /**
   * Só existe como a volta de outra ação (A6, Z2: apagar a resposta que o Liame publicou; Z5d, parte 6: apagar das redes
   * o post que o Liame publicou, pela rota do post). Não se pede direto (`POST /v1/actions`), nem por um funcionário de IA:
   * o Liame não apaga o que não publicou.
   */
  onlyAsUndo?: boolean;
  /**
   * Só existe como a nova tentativa de outra ação (A6, Z5d: o post no canal que não saiu), pedida pela rota dela, que
   * confere o prazo e o motivo e prepara o recurso. Não se pede direto (`POST /v1/actions`), nem por um funcionário de IA.
   */
  onlyAsRetry?: boolean;
  /**
   * Só se pede pela rota própria do recurso, que confere o que a ferramenta exige antes (A6, Z12, parte 2: a resposta no
   * Direct, pela rota da conversa, que confere o atendimento aberto com o código do app). Não se pede direto
   * (`POST /v1/actions`), nem por um funcionário de IA.
   */
  onlyByRoute?: boolean;
  /**
   * A trava (kill switch) de outra ferramenta que também para esta (A6, Z5d: a trava do `post_publicar` para a nova
   * tentativa do post). Conferida no pedido e na execução, junto com a desta.
   */
  travaTambem?: string;
  /**
   * Os parâmetros que só o funcionário de IA preenche (A6, Z6: as sugestões de resposta do Social media). O pedido de
   * uma pessoa não os traz (400, como parâmetro inválido), e alterar o pedido os mantém como o funcionário deixou: a
   * pessoa troca o texto escolhido, e o que aparece como escrito pelo funcionário é o que ele escreveu.
   */
  agentParams?: readonly string[];
  /**
   * A hora em que o pedido aprovado executa (A6, Z5b; D-A6-8: o post sai na hora marcada, que o Liame segura), a partir
   * do estado que o pedido guardou, da hora da aprovação e do fuso da empresa. Sem esta função, ou com nulo, o pedido
   * aprovado executa na hora, como sempre. É a `next_attempt_at` do pedido: o executor só o pega quando ela chega.
   */
  executeAt?(before: ResourceState, agora: Date, fuso: string): Date | null;
  /**
   * A flag de escrita da ferramenta, além da do conector (A6, Z11, parte 2: `comentarios_responder` nas ferramentas do
   * comentário, que usam o conector da conta do Instagram e da Página, cuja flag é a dos posts). Conferida no pedido, na
   * aprovação que lê de novo e na execução, como a do conector: as duas precisam estar ligadas.
   */
  flag?: string;
  /**
   * A resposta automática dos comentários (A6, Z11, parte 2e-1; D-A6-92 e D-A6-104): só o funcionário de IA pede, só pelo
   * atendimento automático (a rotina, que confere o portão antes), e o pedido nasce aprovado, sem o código do app e sem o
   * `autopilot`, pela regra própria da política (`comentario.responder_automatico`, só para o funcionário). O executor
   * confere o portão de novo antes de publicar: desligar ou tirar o tipo segura na hora o que está na fila.
   */
  atendimentoAutomatico?: boolean;
}

/** O plano não pode ser montado com este estado (cupom que já existe, loja sem permissão): vira 422 no pedido. */
export class PlanoRecusado extends Error {}

const Dia = z.iso.date();
/**
 * Cupom de campanha no Regem (contrato de cupons §3.3). O código é o do recurso (`cupom:CODIGO`); a campanha e
 * "exclusivo" são do Liame: o cupom nasce ligado à campanha, e só o exclusivo prova de onde veio o pedido.
 */
const CupomParams = z
  .strictObject({
    codigo: z.string().regex(/^[A-Z0-9]{4,20}$/, { error: 'De 4 a 20 letras maiúsculas ou números, sem espaço' }),
    nome: z.string().trim().min(1).max(80).optional(),
    tipo: z.enum(['percentual', 'valor', 'frete_gratis']),
    /** Só no percentual: de 1 a 100, inteiro (o Regem recebe com duas casas). */
    percentual: z.int().min(1).max(100).optional(),
    /** Só no valor fixo. */
    valor_centavos: z.int().min(1).max(100_000_000).optional(),
    pedido_minimo_centavos: z.int().min(0).max(100_000_000).default(0),
    valido_de: Dia,
    valido_ate: Dia,
    campaign_id: z.uuid(),
    exclusive: z.boolean(),
  })
  .superRefine((p, ctx) => {
    if (p.tipo === 'percentual' && p.percentual === undefined) ctx.addIssue({ code: 'custom', path: ['percentual'], message: 'Informe o desconto em %' });
    if (p.tipo !== 'percentual' && p.percentual !== undefined) ctx.addIssue({ code: 'custom', path: ['percentual'], message: 'O percentual só vale no cupom percentual' });
    if (p.tipo === 'valor' && p.valor_centavos === undefined) ctx.addIssue({ code: 'custom', path: ['valor_centavos'], message: 'Informe o valor do desconto' });
    if (p.tipo !== 'valor' && p.valor_centavos !== undefined) ctx.addIssue({ code: 'custom', path: ['valor_centavos'], message: 'O valor só vale no cupom de valor fixo' });
    if (p.valido_ate < p.valido_de) ctx.addIssue({ code: 'custom', path: ['valido_ate'], message: 'O fim não pode ser antes do início' });
  });

const BudgetParams = z.strictObject({ daily_budget_micros: z.int().min(1_000_000).max(Number.MAX_SAFE_INTEGER) });
const NoParams = z.strictObject({});

const budgetOf = (s: ResourceState): number => {
  const v = s.daily_budget_micros;
  if (typeof v !== 'number') throw new Error('o recurso não tem daily_budget_micros');
  return v;
};

// ---- objetos de anúncio (A4, X2): o estado vem do conector da plataforma (`actions/meta-anuncios.ts`), com o tipo do
// objeto (`campanha`, `conjunto` ou `anuncio`) e a situação (`ativo`, `pausado`, `arquivado`…). O estado do sandbox não
// tem tipo: para ele, as ferramentas seguem como eram.

type TipoDeAnuncio = 'campanha' | 'conjunto' | 'anuncio';
const NOME: Record<TipoDeAnuncio, { o: string; um: string; a: 'a' | 'o' }> = {
  campanha: { o: 'a campanha', um: 'campanha', a: 'a' },
  conjunto: { o: 'o conjunto', um: 'conjunto de anúncios', a: 'o' },
  anuncio: { o: 'o anúncio', um: 'anúncio', a: 'o' },
};
const tipoDe = (s: ResourceState): TipoDeAnuncio | null => (s.tipo === 'campanha' || s.tipo === 'conjunto' || s.tipo === 'anuncio' ? s.tipo : null);

/** A ferramenta vale para um tipo de objeto: pedir com outro é engano de quem pede. */
function exigirTipo(before: ResourceState, aceitos: TipoDeAnuncio[]): TipoDeAnuncio | null {
  const tipo = tipoDe(before);
  if (tipo && !aceitos.includes(tipo)) {
    throw new PlanoRecusado(`Esta ferramenta é para ${aceitos.map((t) => NOME[t].um).join(' ou ')}; o pedido aponta para ${NOME[tipo].um}.`);
  }
  return tipo;
}

/** O objeto de anúncio que foi arquivado ou removido na plataforma não muda mais. */
function exigirVivo(before: ResourceState, tipo: TipoDeAnuncio): void {
  const { o, a } = NOME[tipo];
  if (before.status !== 'ativo' && before.status !== 'pausado') throw new PlanoRecusado(`${maiuscula(o)} foi arquivad${a} ou removid${a} na plataforma: não dá para mudar.`);
}
const maiuscula = (s: string) => s.charAt(0).toLocaleUpperCase('pt-BR') + s.slice(1);

/** A verba diária do objeto, quando ela mora nele (em micros); nula em anúncio e em quem tem a verba em outro nível. */
const verbaDiaria = (s: ResourceState): number | null => (typeof s.daily_budget_micros === 'number' && s.daily_budget_micros > 0 ? s.daily_budget_micros : null);

/** Pausar: o objeto ativo passa a pausado. Reduz gasto: nada a reservar. */
function planoDePausa(before: ResourceState, alvo: TipoDeAnuncio): ToolPlan {
  const tipo = exigirTipo(before, [alvo]);
  if (tipo) {
    exigirVivo(before, tipo);
    if (before.status === 'pausado') throw new PlanoRecusado(`${maiuscula(NOME[tipo].o)} já está em pausa.`);
  }
  return { action: `${alvo}.pausar`, budgetImpact: 'decrease', valueMicros: null, currentValueMicros: null, reserveMicros: 0, desiredState: { ...before, status: 'pausado' } };
}

/** Retomar: o objeto pausado volta a ativo. Volta a gastar: reserva um dia da verba dele, quando a verba mora nele. */
function planoDeRetomada(before: ResourceState, alvo: TipoDeAnuncio): ToolPlan {
  const tipo = exigirTipo(before, [alvo]);
  if (!tipo) throw new PlanoRecusado('Retomar vale para campanha, conjunto e anúncio de uma plataforma conectada.');
  exigirVivo(before, tipo);
  if (before.status !== 'pausado') throw new PlanoRecusado(`Só dá para retomar o que está em pausa, e ${NOME[tipo].o} está ativ${NOME[tipo].a}.`);
  const verba = verbaDiaria(before);
  return { action: `${alvo}.retomar`, budgetImpact: 'new_spend', valueMicros: verba, currentValueMicros: null, reserveMicros: verba ?? 0, desiredState: { ...before, status: 'ativo' } };
}

const pausa = (alvo: TipoDeAnuncio, providers: readonly string[], version = 1): ToolDefinition => ({
  name: `${alvo}_pausar`,
  version,
  owner: 'midia',
  description: alvo === 'anuncio' ? 'Pausa um anúncio (reversível).' : alvo === 'conjunto' ? 'Pausa um conjunto de anúncios; os anúncios dele param de rodar (reversível).' : 'Pausa uma campanha; os conjuntos e anúncios dela param de rodar (reversível).',
  risk: 'R1',
  providers,
  compensation: 'reativar_se_inalterado',
  params: NoParams,
  plan: (before) => planoDePausa(before, alvo),
  undo: () => ({ tool: `${alvo}_retomar`, params: {} }),
});

const retomada = (alvo: TipoDeAnuncio, providers: readonly string[]): ToolDefinition => ({
  name: `${alvo}_retomar`,
  version: 1,
  owner: 'midia',
  description:
    alvo === 'anuncio'
      ? 'Retoma um anúncio em pausa: ele volta a rodar e a gastar.'
      : alvo === 'conjunto'
        ? 'Retoma um conjunto de anúncios em pausa: os anúncios ativos dele voltam a rodar e a gastar.'
        : 'Retoma uma campanha em pausa: os conjuntos e anúncios ativos dela voltam a rodar e a gastar.',
  // Volta a gastar: exige a aprovação de uma pessoa, como ativar o que nasceu pausado (D-A4-3).
  risk: 'R2',
  providers,
  compensation: 'pausar_se_inalterado',
  params: NoParams,
  plan: (before) => planoDeRetomada(before, alvo),
  undo: () => ({ tool: `${alvo}_pausar`, params: {} }),
});

/** O que impede o envio da mensagem em rascunho agora (as frases do RegemCast e o teto do mês); nulo se nada. */
function impedimentoDoRascunho(before: ResourceState): string | null {
  const lido = EstadoDaMensagem.safeParse(before);
  return lido.success && faseDaMensagem(lido.data.situacao) === 'rascunho' ? impedimentoDaMensagem(lido.data) : null;
}

/** O plano do envio de uma mensagem em rascunho no RegemCast: o mesmo para o disparo aprovado aqui e o pedido ao destino. */
function planoDoEnvio(before: ResourceState, action: 'mensagem.disparar' | 'mensagem.pedir_ao_destino'): ToolPlan {
  const lido = EstadoDaMensagem.safeParse(before);
  if (!lido.success) throw new PlanoRecusado('Esta ferramenta é para uma mensagem montada no RegemCast.');
  const e = lido.data;
  const fase = faseDaMensagem(e.situacao);
  if (fase === 'pausada') throw new PlanoRecusado('Esta mensagem já foi enviada e está pausada. Quem retoma é uma pessoa, no RegemCast.');
  if (fase !== 'rascunho') throw new PlanoRecusado('Esta mensagem já foi enviada ou cancelada: não dá para enviar de novo.');
  if (e.pessoas === 0) throw new PlanoRecusado('Ninguém deste público pode receber esta mensagem agora.');
  return {
    action,
    // O dinheiro das mensagens não é verba de mídia: vale o teto do RegemCast, conferido acima, e nada entra no
    // envelope do mês (D-A5-12). O custo vai no estado (`custo_centavos`), que é o que a pessoa aprova.
    budgetImpact: 'none',
    valueMicros: null,
    currentValueMicros: null,
    reserveMicros: 0,
    desiredState: { ...e, situacao: 'enviando' },
    // O que impede não recusa o pedido (P15, escolha 6; critério A5-12): ele espera em Aprovações com o motivo. São
    // as frases do RegemCast (o modelo ainda em análise na Meta, a conta sem teto de gasto…) e o envio que não cabe no
    // teto de gasto de mensagens do mês.
    blocked: impedimentoDaMensagem(e),
  };
}

export const TOOLS: Record<string, ToolDefinition> = {
  orcamento_ajustar: {
    name: 'orcamento_ajustar',
    version: 1,
    owner: 'midia',
    description: 'Muda o orçamento diário de uma campanha ou conjunto.',
    risk: 'R3',
    // No Google (A5, Y3) a verba é a do orçamento que é só da campanha; grupo de anúncios e anúncio ficam fora.
    providers: ['sandbox', 'meta_ads', 'google_ads'],
    compensation: 'restaurar_orcamento_anterior_se_inalterado',
    params: BudgetParams,
    plan(before, params) {
      const { daily_budget_micros: value } = BudgetParams.parse(params);
      // Na plataforma de anúncio, a verba diária mora na campanha (orçamento de campanha) ou no conjunto, nunca no anúncio.
      const tipo = exigirTipo(before, ['campanha', 'conjunto']);
      if (tipo) {
        exigirVivo(before, tipo);
        // No Google, a verba dividida entre campanhas nunca é alterada (D-A5-4): o pedido nem nasce.
        const dividido = orcamentoCompartilhado(before);
        if (dividido) throw new PlanoRecusado(motivoDoCompartilhado(dividido));
        const verba = verbaDiaria(before);
        if (verba === null) throw new PlanoRecusado(`${maiuscula(NOME[tipo].o)} não tem verba diária própria: a verba fica em outro nível, ou é de período.`);
        if (value === verba) throw new PlanoRecusado('A verba pedida é igual à de agora.');
        if (emMenorUnidade(value, typeof before.moeda === 'string' ? before.moeda : null) === null) throw new PlanoRecusado('A verba diária não pode ter fração de centavo.');
      }
      const current = budgetOf(before);
      const increase = value > current;
      return {
        action: increase ? 'orcamento.aumentar' : 'orcamento.reduzir',
        budgetImpact: value === current ? 'none' : increase ? 'increase' : 'decrease',
        valueMicros: value,
        currentValueMicros: current,
        // Reserva a diferença de um dia a mais de gasto; redução não reserva.
        reserveMicros: increase ? value - current : 0,
        desiredState: { ...before, daily_budget_micros: value },
      };
    },
    // A volta devolve a verba de antes (se ninguém mexeu depois).
    undo: (before) => ({ tool: 'orcamento_ajustar', params: { daily_budget_micros: budgetOf(before) } }),
  },
  // A campanha nova na Meta, criada pausada (A4, X5, parte 1; P10, aprovado em 05/10/2026; D-A4-31 e D-A4-40): a peça
  // aprovada com a foto ou o vídeo da loja vira a campanha, o conjunto e o anúncio, tudo pausado. Não gasta (ativar é
  // outro pedido, a parte 3), mas fala em público em nome da empresa quando for ativada: sempre com a aprovação de uma
  // pessoa e o código do app. Só pela rota da campanha nova (`POST /v1/new-campaigns`), que confere a peça, a mídia, a
  // Página, a loja e o teto por campanha, e só com a função `campanha_nova`, além da escrita na Meta.
  campanha_criar: {
    name: 'campanha_criar',
    version: 1,
    owner: 'midia',
    description:
      'Cria na Meta uma campanha nova com a peça aprovada em Criativos e a foto ou o vídeo da loja: a campanha, o conjunto (o raio em volta da loja e a verba diária) e o anúncio nascem pausados e não gastam. Ativar é outro pedido, com outra aprovação.',
    risk: 'R1',
    providers: ['meta_ads'],
    compensation: 'fica_pausada_na_meta',
    alwaysApproval: true,
    onlyByRoute: true,
    flag: 'campanha_nova',
    params: NoParams,
    plan(before) {
      const plano = planoDaCampanhaNova(before);
      if (!plano.ok) throw new PlanoRecusado(plano.motivo);
      return {
        action: 'campanha.criar',
        // Nasce pausada: não gasta nada até ser ativada, então nada a reservar no envelope do mês.
        budgetImpact: 'none',
        valueMicros: null,
        currentValueMicros: null,
        reserveMicros: 0,
        desiredState: plano.desejado as unknown as ResourceState,
      };
    },
  },
  // Ativar a campanha nova (A4, X5, parte 3; D-A4-31): o anúncio, o conjunto e a campanha passam a rodar e a gastar a
  // verba diária, depois da revisão da Meta. Volta a gastar: os limites da empresa e a verba do mês valem (D-A4-19), como
  // em retomar. Só pela rota da campanha nova (`POST /v1/new-campaigns/{id}/activate`); a volta é pausar.
  campanha_nova_ativar: {
    name: 'campanha_nova_ativar',
    version: 1,
    owner: 'midia',
    description:
      'Ativa na Meta a campanha nova que o Liame criou pausada: o anúncio, o conjunto e a campanha passam a rodar e a gastar a verba diária, depois da revisão da Meta. A volta é pausar.',
    risk: 'R2',
    providers: ['meta_ads'],
    compensation: 'pausar_se_inalterado',
    alwaysApproval: true,
    onlyByRoute: true,
    flag: 'campanha_nova',
    params: NoParams,
    plan(before) {
      const plano = planoDeAtivar(before);
      if (!plano.ok) throw new PlanoRecusado(plano.motivo);
      const verba = plano.desejado.verba_diaria_micros;
      return { action: 'campanha.ativar', budgetImpact: 'new_spend', valueMicros: verba, currentValueMicros: null, reserveMicros: verba, desiredState: plano.desejado as unknown as ResourceState };
    },
    undo: () => ({ tool: 'campanha_nova_pausar', params: {} }),
  },
  // A volta de ativar: a campanha nova para de rodar e de gastar (a campanha em pausa; os filhos herdam).
  campanha_nova_pausar: {
    name: 'campanha_nova_pausar',
    version: 1,
    owner: 'midia',
    description: 'Pausa na Meta a campanha nova que o Liame ativou: ela para de aparecer e de gastar (reversível).',
    risk: 'R1',
    providers: ['meta_ads'],
    compensation: 'reativar_se_inalterado',
    onlyAsUndo: true,
    flag: 'campanha_nova',
    params: NoParams,
    plan(before) {
      const plano = planoDePausar(before);
      if (!plano.ok) throw new PlanoRecusado(plano.motivo);
      return { action: 'campanha.pausar', budgetImpact: 'decrease', valueMicros: null, currentValueMicros: null, reserveMicros: 0, desiredState: plano.desejado as unknown as ResourceState };
    },
    undo: () => ({ tool: 'campanha_nova_ativar', params: {} }),
  },
  // A campanha nova no Google, criada pausada (A5, Y9, parte 2; P45; D-A5-21 a D-A5-26): a peça aprovada, com os textos
  // nos tamanhos do Google e uma foto da loja recortada, vira uma Performance Max pausada, numa requisição só (o Google
  // cria tudo ou nada). Não gasta (ativar é outro pedido); sempre com a aprovação de uma pessoa e o código do app. Só
  // pela rota da campanha nova no Google (`POST /v1/google-campaigns`) e só com a função `campanha_google`, além da
  // escrita no Google. A criação no Google é a parte 3: até lá, o conector recusa sem ir ao Google.
  campanha_google_criar: {
    name: 'campanha_google_criar',
    version: 1,
    owner: 'midia',
    description:
      'Cria no Google uma campanha Performance Max nova com a peça aprovada em Criativos, nos tamanhos do Google, e uma foto da loja recortada: o orçamento, a campanha (o raio em volta da loja e a verba diária) e o grupo de recursos nascem pausados, numa requisição só, e não gastam. Ativar é outro pedido, com outra aprovação.',
    risk: 'R1',
    providers: ['google_ads'],
    compensation: 'fica_pausada_no_google',
    alwaysApproval: true,
    onlyByRoute: true,
    flag: 'campanha_google',
    params: NoParams,
    plan(before) {
      const plano = planoDaCampanhaGoogle(before);
      if (!plano.ok) throw new PlanoRecusado(plano.motivo);
      // Nasce pausada: não gasta nada até ser ativada, então nada a reservar no envelope do mês.
      return { action: 'campanha.criar', budgetImpact: 'none', valueMicros: null, currentValueMicros: null, reserveMicros: 0, desiredState: plano.desejado as unknown as ResourceState };
    },
  },
  regem_cupom_criar: {
    name: 'regem_cupom_criar',
    version: 1,
    owner: 'vendas',
    description: 'Cria um cupom de campanha na loja do Regem e liga à campanha.',
    risk: 'R1',
    providers: ['regem'],
    compensation: 'desativar_cupom',
    params: CupomParams,
    plan(before, params) {
      const p = CupomParams.parse(params);
      if (before.codigo !== p.codigo) throw new PlanoRecusado('O código do cupom não confere com o recurso do pedido.');
      if (before.pode_criar !== true) throw new PlanoRecusado('A loja não liberou "criar cupom de campanha" no Regem. Autorize de novo em Contas conectadas e ligue essa chave lá.');
      if (before.existe === true) throw new PlanoRecusado('Já existe um cupom com este código nesta loja. Escolha outro código.');
      const regra = {
        codigo: p.codigo,
        nome: p.nome ?? `Campanha · ${p.codigo}`,
        tipo: p.tipo,
        ...(p.tipo === 'percentual' ? { percentual: `${p.percentual}.00` } : {}),
        ...(p.tipo === 'valor' ? { valor_centavos: p.valor_centavos } : {}),
        ...(p.pedido_minimo_centavos > 0 ? { pedido_minimo_centavos: p.pedido_minimo_centavos } : {}),
        valido_de: p.valido_de,
        valido_ate: p.valido_ate,
      };
      return {
        action: 'cupom.criar',
        // O desconto sai do caixa da loja, não do orçamento de mídia: nada a reservar no envelope.
        budgetImpact: 'none',
        valueMicros: null,
        currentValueMicros: null,
        reserveMicros: 0,
        desiredState: { codigo: p.codigo, existe: true, regra, campanha: { id: p.campaign_id, exclusivo: p.exclusive } },
      };
    },
  },
  // Pausar e retomar (A4, X2): uma ferramenta por tipo de objeto, para o pedido dizer o que vai parar. Pausar a campanha
  // para os conjuntos e os anúncios dela; pausar o conjunto para os anúncios dele (base §2.1). No Google (A5, Y3), só a
  // campanha: o Liame não mexe em grupo de anúncios nem em anúncio do Google nesta fase (D-A5-3).
  anuncio_pausar: pausa('anuncio', ['sandbox', 'meta_ads']),
  conjunto_pausar: pausa('conjunto', ['meta_ads']),
  campanha_pausar: pausa('campanha', ['meta_ads', 'google_ads']),
  anuncio_retomar: retomada('anuncio', ['meta_ads']),
  conjunto_retomar: retomada('conjunto', ['meta_ads']),
  campanha_retomar: retomada('campanha', ['meta_ads', 'google_ads']),
  // Mensagem de WhatsApp pelo RegemCast (A5, Y5). O estado do recurso é o plano do disparo que o RegemCast devolve para
  // a campanha em rascunho que o Liame montou (`mensagem-plano.ts`): é esse plano, com as pessoas e o custo, que a
  // pessoa aprova. Sem a flag de escrita `whatsapp_campaign`, nenhum pedido chega a estas ferramentas.
  mensagem_disparar: {
    name: 'mensagem_disparar',
    version: 1,
    owner: 'mensageria',
    description: 'Envia uma mensagem de WhatsApp já montada no RegemCast, para o público e pelo custo do plano que a pessoa aprova. Mensagem enviada não volta.',
    // Custa dinheiro, fala com clientes da loja e não tem volta: o risco mais alto, sempre com a aprovação de uma pessoa (D-A5-11).
    risk: 'R3',
    providers: ['regemcast'],
    compensation: 'pausar_o_que_ainda_nao_saiu',
    alwaysApproval: true,
    revalidateOnApproval: true,
    params: NoParams,
    blockedBy: impedimentoDoRascunho,
    plan: (before) => planoDoEnvio(before, 'mensagem.disparar'),
    // A volta possível é pausar o que ainda não saiu; o que já foi entregue, fica.
    undo: () => ({ tool: 'mensagem_pausar', params: {} }),
  },
  // O mesmo envio quando a aprovação é do RegemCast (Hub DMS F5, parte D; decisão F5-9): a conta ligada pela autorização
  // por clique, com a flag `regemcast_pede_ao_destino`. O Liame não pede a própria aprovação: o executor cria o cupom e
  // PEDE o disparo ao RegemCast, onde uma pessoa da conta aprova com o código do aplicativo autenticador e o teto de
  // gasto. A mensagem fica "esperando o destino" (`message_request.destination_*`), e a rotina `pedidos-no-destino`
  // acompanha o pedido. O que impede o plano agora não espera: o RegemCast recusaria o pedido, e a ação falha com a
  // frase dele (o funcionário pode propor de novo depois).
  mensagem_pedir_ao_destino: {
    name: 'mensagem_pedir_ao_destino',
    version: 1,
    owner: 'mensageria',
    description:
      'Pede ao RegemCast o envio de uma mensagem de WhatsApp já montada lá. Uma pessoa da conta do RegemCast aprova lá, com o código do aplicativo autenticador e o teto de gasto; só então a mensagem sai.',
    risk: 'R3',
    providers: ['regemcast'],
    compensation: 'pausar_o_que_ainda_nao_saiu',
    aprovacaoNoDestino: true,
    flag: 'regemcast_pede_ao_destino',
    params: NoParams,
    // Sem `blockedBy`: ela nunca espera aprovação aqui (o que impede vira a recusa do RegemCast, com a frase dele).
    plan: (before) => planoDoEnvio(before, 'mensagem.pedir_ao_destino'),
    undo: () => ({ tool: 'mensagem_pausar', params: {} }),
  },
  mensagem_pausar: {
    name: 'mensagem_pausar',
    version: 1,
    owner: 'mensageria',
    description: 'Pausa o envio de uma mensagem de WhatsApp que o Liame disparou: segura o que ainda não saiu. Quem retoma é uma pessoa, no RegemCast.',
    risk: 'R1',
    providers: ['regemcast'],
    compensation: 'sem_volta_pelo_liame',
    // Pausar só segura o que ainda não saiu: uma pessoa pausa direto, com confirmação na tela (decisão do dono, 09/10/2026).
    directByPerson: true,
    params: NoParams,
    plan(before) {
      const lido = EstadoDaMensagem.safeParse(before);
      if (!lido.success) throw new PlanoRecusado('Esta ferramenta é para uma mensagem montada no RegemCast.');
      const e = lido.data;
      const fase = faseDaMensagem(e.situacao);
      if (fase === 'rascunho') throw new PlanoRecusado('Esta mensagem ainda não foi enviada: não há o que pausar.');
      if (fase === 'pausada') throw new PlanoRecusado('O envio desta mensagem já está pausado.');
      if (fase !== 'andamento') throw new PlanoRecusado('O envio desta mensagem já terminou: não há o que pausar.');
      return { action: 'mensagem.pausar', budgetImpact: 'decrease', valueMicros: null, currentValueMicros: null, reserveMicros: 0, desiredState: { ...e, situacao: 'pausada' } };
    },
  },
  // A resposta da empresa a uma avaliação do perfil no Google (A6, Z2; P17). O estado do recurso é a avaliação, lida
  // do Google na hora, sem o texto dela e sem nada de quem avaliou (`avaliacao-plano.ts`). O texto da resposta é o
  // parâmetro: entra no hash do plano, e a aprovação vale só para ele. Sem a flag de escrita `perfil_google_write`,
  // nenhum pedido chega a esta ferramenta. v2 (A6, Z6; P31): o pedido do Social media traz também as sugestões que
  // ele escreveu, para a pessoa escolher uma; o que vai ao Google continua sendo só o texto escolhido.
  avaliacao_responder: {
    name: 'avaliacao_responder',
    version: 2,
    owner: 'social',
    description:
      'Publica a resposta da empresa a uma avaliação do perfil no Google, com o texto que a pessoa aprova. A resposta é pública; quem avaliou é avisado pelo Google. No pedido do Social media, vêm as sugestões dele, para a pessoa escolher uma e ajustar.',
    // Fala em público em nome da empresa, e o aviso a quem avaliou não se desfaz: sempre com a aprovação de uma pessoa (D-A6-3).
    risk: 'R2',
    providers: ['google_business'],
    compensation: 'apagar_a_resposta',
    alwaysApproval: true,
    params: ParametrosDaResposta,
    agentParams: ['sugestoes'],
    // 1 ou 2 estrelas: só o dono decide (D-A6-4).
    ownerOnly(before) {
      const lido = EstadoDaAvaliacao.safeParse(before);
      return lido.success && ehNotaBaixa(lido.data.estrelas);
    },
    plan(before, params, context) {
      const plano = planoDaResposta(before, params, (context ?? null) as ContextoDaAvaliacao | null);
      if (!plano.ok) throw new PlanoRecusado(plano.motivo);
      return {
        action: plano.acao,
        // Responder não gasta verba: nada a reservar no envelope do mês.
        budgetImpact: 'none',
        valueMicros: null,
        currentValueMicros: null,
        reserveMicros: 0,
        desiredState: plano.desejado,
        text: plano.texto,
      };
    },
    // A volta é apagar a resposta do perfil. O aviso que quem avaliou já recebeu do Google não volta.
    undo: () => ({ tool: 'avaliacao_apagar_resposta', params: {} }),
  },
  avaliacao_apagar_resposta: {
    name: 'avaliacao_apagar_resposta',
    version: 1,
    owner: 'social',
    description: 'Apaga do perfil no Google a resposta a uma avaliação que o Liame publicou. Quem avaliou já foi avisado da resposta: apagar não desfaz esse aviso.',
    risk: 'R1',
    providers: ['google_business'],
    compensation: 'sem_volta_pelo_liame',
    // Tirar do ar o que a própria empresa publicou não gasta, não envia e não fala com ninguém: uma pessoa apaga direto,
    // com a confirmação na tela (P17, aprovado em 09/10/2026). Só como a volta da resposta que o Liame publicou.
    directByPerson: true,
    onlyAsUndo: true,
    params: NoParams,
    plan(before) {
      const plano = planoDeApagar(before);
      if (!plano.ok) throw new PlanoRecusado(plano.motivo);
      return { action: plano.acao, budgetImpact: 'none', valueMicros: null, currentValueMicros: null, reserveMicros: 0, desiredState: plano.desejado };
    },
  },
  // O post da marca (A6, Z5b; P19). O estado do recurso é o post como o Liame o guarda (`posts/post-plano.ts`): a foto
  // pelo resumo do arquivo, o recorte, a hora e cada canal com o texto. A aprovação vale para o conjunto (D-A6-7) e o
  // pedido aprovado espera a hora marcada no trilho (D-A6-8). Sem a flag de escrita `social_write`, nenhum pedido chega
  // a esta ferramenta.
  post_publicar: {
    name: 'post_publicar',
    version: 1,
    owner: 'social',
    description:
      'Publica o post da marca nos canais escolhidos (o Instagram e a Página do Facebook), com a foto e o texto que a pessoa aprova, na hora marcada. O post é público e sai em nome da empresa; apagar depois não desfaz quem já viu.',
    // Fala em público em nome da empresa, e quem viu não "desvê": sempre com a aprovação de uma pessoa (D-A6-3).
    risk: 'R2',
    providers: ['instagram', 'facebook_page'],
    compensation: 'apagar_o_post_das_redes',
    alwaysApproval: true,
    params: NoParams,
    plan(before) {
      const plano = planoDoPost(before);
      if (!plano.ok) throw new PlanoRecusado(plano.motivo);
      return {
        action: 'post.publicar',
        // Publicar não gasta verba de mídia: nada a reservar no envelope do mês.
        budgetImpact: 'none',
        valueMicros: null,
        currentValueMicros: null,
        reserveMicros: 0,
        desiredState: plano.desejado,
        text: plano.texto,
      };
    },
    executeAt(before, agora, fuso) {
      const lido = EstadoDoPost.safeParse(before);
      return lido.success ? quandoSai(lido.data.hora, agora, fuso) : null;
    },
  },
  // "Tentar de novo" (A6, Z5d; P19, aprovado pelo dono em 21/10/2026; D-A6-54): o post que saiu num canal e não no outro
  // manda o MESMO post aprovado só no canal que faltou. Quem pede é uma pessoa (na gaveta do post ou em Aprovações), e o
  // pedido executa sem o código do app: o texto, a foto e o canal são os que a aprovação cobriu (a política da
  // distribuição v10 põe a ação em AUTO só para uma pessoa). Só existe pela rota do post (`POST /v1/posts/{id}/retry`),
  // que confere o prazo de 24 horas e o motivo da falha e põe o canal de volta na espera; a trava do `post_publicar` vale
  // para ela também.
  post_tentar_de_novo: {
    name: 'post_tentar_de_novo',
    version: 1,
    owner: 'social',
    description:
      'Publica de novo o post aprovado no canal em que ele não saiu (o mesmo texto e a mesma foto), quando ele já saiu no outro canal. O post é público e sai em nome da empresa.',
    risk: 'R2',
    providers: ['instagram', 'facebook_page'],
    compensation: 'apagar_o_post_das_redes',
    directByPerson: true,
    onlyAsRetry: true,
    travaTambem: 'post_publicar',
    params: NoParams,
    plan(before) {
      const plano = planoDeTentarDeNovo(before);
      if (!plano.ok) throw new PlanoRecusado(plano.motivo);
      return { action: 'post.tentar_de_novo', budgetImpact: 'none', valueMicros: null, currentValueMicros: null, reserveMicros: 0, desiredState: plano.desejado, text: plano.texto };
    },
    // Sai agora, dentro da janela das 8h às 22h no fuso da empresa (a hora marcada já passou).
    executeAt(before, agora, fuso) {
      const lido = EstadoDoPost.safeParse(before);
      return lido.success ? quandoSai(lido.data.hora, agora, fuso) : null;
    },
  },
  // "Apagar das redes" (A6, Z5d, parte 6; P19, aprovado pelo dono em 21/10/2026; D-A6-57): o post que o Liame publicou sai
  // de cada canal em que está no ar. Só existe como a volta da publicação, pela rota do post (`POST /v1/posts/{id}/unpublish`),
  // que pede e aprova com o código do app na mesma chamada, como o P19 desenhou: apagar não se desfaz (o post não volta, nem
  // as curtidas e os comentários dele). A regra `post.*` da política já pede a aprovação; a trava `alwaysApproval` segura a
  // regra de uma empresa ou de uma marca. Executa na hora, a qualquer hora do dia: tirar do ar não espera a janela do post.
  // A trava do `post_publicar` NÃO para esta: apagar é o que se faz quando algo saiu errado.
  post_apagar: {
    name: 'post_apagar',
    version: 1,
    owner: 'social',
    description:
      'Apaga das redes o post da marca que o Liame publicou, em cada canal em que ele está no ar (o Instagram e a Página do Facebook). Apagar não se desfaz, e quem já viu o post, viu.',
    // Tira do ar o que a própria empresa publicou: não gasta, não envia e não fala com ninguém. A aprovação vem do P19.
    risk: 'R1',
    providers: ['instagram', 'facebook_page'],
    compensation: 'sem_volta_pelo_liame',
    alwaysApproval: true,
    onlyAsUndo: true,
    params: NoParams,
    plan(before) {
      const plano = planoDeApagarOPost(before);
      if (!plano.ok) throw new PlanoRecusado(plano.motivo);
      return { action: 'post.apagar', budgetImpact: 'none', valueMicros: null, currentValueMicros: null, reserveMicros: 0, desiredState: plano.desejado };
    },
  },
  // A resposta da marca a um comentário de um post dela, no Instagram ou na Página (A6, Z11, parte 2; P38, D-A6-88). O
  // estado do recurso é o comentário, lido da rede na hora, sem o texto dele e sem nada de quem comentou
  // (`comentario-plano.ts`). O texto da resposta é o parâmetro: entra no hash do plano, e a aprovação vale só para ele.
  // Sem a flag de escrita dos posts (`social_write`, a do conector) e a da ferramenta (`comentarios_responder`), nenhum
  // pedido chega aqui. O atendimento automático (D-A6-92) vem na parte 2e. v2 (Z11, parte 3c; D-A6-103): o pedido do
  // Social media leva até seis sugestões (as três da reclamação e as três do "Pedir outra").
  comentario_responder: {
    name: 'comentario_responder',
    version: 2,
    owner: 'social',
    description:
      'Publica a resposta da marca a um comentário de um post dela, no Instagram ou na Página do Facebook, com o texto que a pessoa aprova. A resposta é pública e fica no post, embaixo do comentário.',
    // Fala em público em nome da marca: com a aprovação de uma pessoa (D-A6-88).
    risk: 'R2',
    providers: ['instagram', 'facebook_page'],
    compensation: 'apagar_a_resposta',
    alwaysApproval: true,
    flag: FLAG_DE_RESPONDER_COMENTARIOS,
    params: ParametrosDaRespostaAoComentario,
    agentParams: ['sugestoes'],
    plan(before, params, context) {
      const plano = planoDaRespostaAoComentario(before, params, (context ?? null) as ContextoDoComentario | null);
      if (!plano.ok) throw new PlanoRecusado(plano.motivo);
      return {
        action: plano.acao,
        // Responder não gasta verba: nada a reservar no envelope do mês.
        budgetImpact: 'none',
        valueMicros: null,
        currentValueMicros: null,
        reserveMicros: 0,
        desiredState: plano.desejado,
        text: plano.texto,
      };
    },
    // A volta é apagar a resposta do post. Quem já leu, leu.
    undo: () => ({ tool: 'comentario_apagar_resposta', params: {} }),
  },
  // A resposta automática a um comentário (A6, Z11, parte 2e-1; P38 versão 2; D-A6-92 e D-A6-104): o atendimento
  // automático, que o Dono ou um Administrador liga na marca com o código do app, responde sozinho os tipos marcados,
  // sem pedido de aprovação. Só o Social media pede, pela rotina, que confere o portão antes; o executor confere de
  // novo antes de publicar. O texto termina com o aviso de resposta automática (Termos 6.3). A volta é a de sempre:
  // apagar a resposta, direto, por quem aprova.
  comentario_responder_auto: {
    name: 'comentario_responder_auto',
    version: 1,
    owner: 'social',
    description:
      'Publica sozinho, pelo atendimento automático que a marca ligou, a resposta da marca a um comentário de um post dela, no Instagram ou na Página do Facebook, com o aviso de resposta automática no fim. A resposta é pública e fica no post.',
    // Fala em público em nome da marca sem uma pessoa ver antes: só pelo atendimento automático, com o portão dele.
    risk: 'R2',
    providers: ['instagram', 'facebook_page'],
    compensation: 'apagar_a_resposta',
    atendimentoAutomatico: true,
    flag: FLAG_DE_RESPONDER_COMENTARIOS,
    params: ParametrosDaRespostaAutomatica,
    plan(before, params, context) {
      const texto = typeof params.texto === 'string' ? params.texto : '';
      if (!texto.endsWith(AVISO_DE_RESPOSTA_AUTOMATICA)) throw new PlanoRecusado('A resposta automática termina com o aviso de resposta automática.');
      const plano = planoDaRespostaAoComentario(before, params, (context ?? null) as ContextoDoComentario | null);
      if (!plano.ok) throw new PlanoRecusado(plano.motivo);
      return {
        action: ACAO_DE_RESPONDER_SOZINHO,
        budgetImpact: 'none',
        valueMicros: null,
        currentValueMicros: null,
        reserveMicros: 0,
        desiredState: plano.desejado,
        text: plano.texto,
      };
    },
    undo: () => ({ tool: 'comentario_apagar_resposta', params: {} }),
  },
  // A resposta numa conversa do Direct do Instagram (A6, Z12, parte 2; P39, D-A6-109 e D-A6-111): uma pessoa da equipe
  // escreve (ou escolhe a sugestão) e manda, sem pedido em Aprovações; o código do app vem uma vez, ao abrir o atendimento
  // (8 horas), e a rota da conversa confere o atendimento aberto antes de pedir. Só dentro da janela de 24 horas da Meta.
  // A mensagem particular não volta pela API: sem volta pelo Liame.
  direct_responder: {
    name: 'direct_responder',
    // 2: também no Messenger da Página (A6, Z14, parte 2).
    version: 2,
    owner: 'social',
    description:
      'Manda a resposta da marca numa conversa do Direct do Instagram ou do Messenger da Página, com o texto que uma pessoa da equipe escreveu ou escolheu. A mensagem é particular, para quem escreveu, e só sai até 24 horas depois da última mensagem da pessoa.',
    // Fala com uma pessoa em nome da marca, em particular: quem manda é uma pessoa da equipe, com o atendimento aberto.
    risk: 'R2',
    providers: ['instagram', 'facebook_page'],
    compensation: 'sem_volta_pelo_liame',
    directByPerson: true,
    onlyByRoute: true,
    flag: FLAG_DE_RESPONDER_NO_DIRECT,
    params: ParametrosDaRespostaNoDirect,
    plan(before, params) {
      const plano = planoDaRespostaNoDirect(before, params);
      if (!plano.ok) throw new PlanoRecusado(plano.motivo);
      return {
        action: plano.acao,
        // Responder não gasta verba: nada a reservar no envelope do mês.
        budgetImpact: 'none',
        valueMicros: null,
        currentValueMicros: null,
        reserveMicros: 0,
        desiredState: plano.desejado,
        text: plano.texto,
      };
    },
  },
  // A resposta automática numa conversa do Direct (A6, Z12, parte 5a; P39 versão 2; D-A6-115 e D-A6-119): o
  // atendimento automático, que o Dono ou um Administrador liga na marca com o código do app, responde sozinho os tipos
  // marcados (nesta parte, o elogio, a resposta ao story e a menção, com a resposta pronta), sem uma pessoa ver antes.
  // Só o Social media pede, pela rotina, que confere o portão antes; o executor confere de novo antes de mandar. O texto
  // termina com o aviso de resposta automática e o caminho para uma pessoa (Termos 5.5 e 6.3). Sem volta pelo Liame.
  [FERRAMENTA_DO_DIRECT_AUTOMATICO]: {
    name: FERRAMENTA_DO_DIRECT_AUTOMATICO,
    // 2: também no Messenger da Página (A6, Z14, parte 2).
    version: 2,
    owner: 'social',
    description:
      'Manda sozinho, pelo atendimento automático que a marca ligou, a resposta pronta da marca numa conversa do Direct do Instagram ou do Messenger da Página (o agradecimento ao elogio, à resposta ao story ou à menção), com o aviso de resposta automática e o caminho para uma pessoa no fim. A mensagem é particular e só sai até 24 horas depois da última mensagem da pessoa.',
    // Fala com uma pessoa em nome da marca sem uma pessoa ver antes: só pelo atendimento automático, com o portão dele.
    risk: 'R2',
    providers: ['instagram', 'facebook_page'],
    compensation: 'sem_volta_pelo_liame',
    atendimentoAutomatico: true,
    flag: FLAG_DE_RESPONDER_NO_DIRECT,
    params: ParametrosDaRespostaNoDirect,
    plan(before, params) {
      const texto = typeof params.texto === 'string' ? params.texto : '';
      if (!texto.endsWith(DIRECT_AUTO_REPLY_NOTICE)) throw new PlanoRecusado('A resposta automática termina com o aviso de resposta automática.');
      const plano = planoDaRespostaNoDirect(before, params);
      if (!plano.ok) throw new PlanoRecusado(plano.motivo);
      return {
        action: ACAO_DE_RESPONDER_NO_DIRECT_SOZINHO,
        budgetImpact: 'none',
        valueMicros: null,
        currentValueMicros: null,
        reserveMicros: 0,
        desiredState: plano.desejado,
        text: plano.texto,
      };
    },
  },
  comentario_apagar_resposta: {
    name: 'comentario_apagar_resposta',
    version: 1,
    owner: 'social',
    description: 'Apaga do post a resposta da marca a um comentário, que o Liame publicou. Quem já leu a resposta, leu: apagar não desfaz isso.',
    risk: 'R1',
    providers: ['instagram', 'facebook_page'],
    compensation: 'sem_volta_pelo_liame',
    // Tirar do ar o que a própria marca publicou não gasta, não envia e não fala com ninguém: uma pessoa apaga direto,
    // com a confirmação na tela (P38). Só como a volta da resposta que o Liame publicou.
    directByPerson: true,
    onlyAsUndo: true,
    flag: FLAG_DE_RESPONDER_COMENTARIOS,
    params: NoParams,
    plan(before) {
      const plano = planoDeApagarARespostaAoComentario(before);
      if (!plano.ok) throw new PlanoRecusado(plano.motivo);
      return { action: plano.acao, budgetImpact: 'none', valueMicros: null, currentValueMicros: null, reserveMicros: 0, desiredState: plano.desejado };
    },
  },
  // Ocultar um comentário de um post da marca (A6, Z11, parte 2; P38, D-A6-89): sugerido no ofensivo e no golpe, e
  // possível em qualquer comentário de outra pessoa. Com a aprovação de uma pessoa, com o código do app; a volta é
  // mostrar de novo, também com o código. O Liame não apaga comentário.
  comentario_ocultar: {
    name: 'comentario_ocultar',
    version: 1,
    owner: 'social',
    description:
      'Oculta um comentário de um post da marca, no Instagram ou na Página do Facebook: ele some para quem vê o post. Dá para mostrar de novo depois. O Liame não apaga comentário.',
    risk: 'R1',
    providers: ['instagram', 'facebook_page'],
    compensation: 'mostrar_de_novo',
    alwaysApproval: true,
    flag: FLAG_DE_RESPONDER_COMENTARIOS,
    params: NoParams,
    plan(before) {
      const plano = planoDeOcultar(before);
      if (!plano.ok) throw new PlanoRecusado(plano.motivo);
      return { action: plano.acao, budgetImpact: 'none', valueMicros: null, currentValueMicros: null, reserveMicros: 0, desiredState: plano.desejado };
    },
    undo: () => ({ tool: 'comentario_mostrar', params: {} }),
  },
  comentario_mostrar: {
    name: 'comentario_mostrar',
    version: 1,
    owner: 'social',
    description: 'Mostra de novo um comentário que o Liame ocultou num post da marca.',
    risk: 'R1',
    providers: ['instagram', 'facebook_page'],
    compensation: 'sem_volta_pelo_liame',
    // Mostrar de novo também é com o código do app (P38, D-A6-89): o comentário volta a falar em público no post da marca.
    alwaysApproval: true,
    onlyAsUndo: true,
    flag: FLAG_DE_RESPONDER_COMENTARIOS,
    params: NoParams,
    plan(before) {
      const plano = planoDeMostrar(before);
      if (!plano.ok) throw new PlanoRecusado(plano.motivo);
      return { action: plano.acao, budgetImpact: 'none', valueMicros: null, currentValueMicros: null, reserveMicros: 0, desiredState: plano.desejado };
    },
  },
};
