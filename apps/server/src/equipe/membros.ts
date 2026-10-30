import { LIA } from '../ai/conversa/prompt.js';
import { CRIATIVO, WORKFLOW_DO_CRIATIVO } from '../ai/criativo/prompt.js';
import { CRM, WORKFLOW_DO_CRM } from '../ai/crm/prompt.js';
import { ESTRATEGISTA } from '../ai/estrategista/prompt.js';
import { ANALISTA } from '../ai/explicar/prompt.js';
import { PESQUISADOR } from '../ai/pesquisador/prompt.js';
import { WORKFLOW_DO_REVISOR } from '../ai/revisor/prompt.js';
import type { FuncionarioDef } from '../ai/registro/definicoes.js';
import { SOCIAL, WORKFLOW_DO_SOCIAL, WORKFLOW_DO_SOCIAL_POST } from '../ai/social/prompt.js';

// A equipe da A3 (I13b; protótipo P7, aprovado em 03/10/2026): quem trabalha para a marca. Os funcionários de IA têm
// definição no registro (`ai/registro/definicoes.ts`) e a ativação da distribuição; Relatórios, Compliance e o Gestor
// de tráfego trabalham por regra (sem modelo próprio) e entram aqui pela chave. A descrição de cada um (o que faz e o
// que nunca faz) é da tela. Os da fase seguinte não estão aqui: a tela mostra com a fase deles. O Criativo (A4) entrou
// com o protótipo P12, aprovado em 09/10/2026: ele só trabalha a pedido, e só para a empresa com a flag `criativo`. O
// CRM e mensageria (A5) entrou com o protótipo P16, aprovado em 09/10/2026: propõe mensagens de WhatsApp, sempre como
// pedido em Aprovações, e só para a empresa com a flag `crm` e as flags do envio de mensagens. O Social media (A6) entrou
// com o protótipo P21, aprovado em 21/10/2026, por ora só com as respostas às avaliações (o dono pediu em 29/10/2026 para
// portar sem os posts, que entram com a Z5): sugere respostas, sempre como pedido em Aprovações, e só para a empresa com
// a função `respostas_sugeridas` e a resposta pelo Liame ligadas.

/** Relatórios: a revisão da semana (a leitura dela usa o mesmo prompt do Analista). */
export const RELATORIOS = 'relatorios';
/**
 * Compliance: as regras de texto no código; não desliga. Para a empresa com a flag `revisor`, depois das regras vem o
 * revisor de IA: o custo dele é o do Compliance (o fluxo abaixo), e sem a IA só as regras trabalham.
 */
export const COMPLIANCE = 'compliance';
/** Gestor de tráfego: a sombra por regra (I5), sem modelo. */
export const GESTOR_DE_TRAFEGO = 'trafego';

/** Criativo: escreve as peças de anúncio que alguém pede em Criativos (A4, X6). */
export const CRIATIVO_DA_EQUIPE = 'criativo';

/** CRM e mensageria: propõe mensagens de WhatsApp para os clientes da loja, pelo RegemCast (A5, Y6). */
export const CRM_DA_EQUIPE = 'crm';

/** Social media: sugere as respostas às avaliações do Perfil no Google (A6, Z6); os posts entram com a Z5. */
export const SOCIAL_DA_EQUIPE = 'social';

export const MEMBROS = ['lia', 'analista', RELATORIOS, COMPLIANCE, 'estrategista', 'pesquisador', GESTOR_DE_TRAFEGO, CRIATIVO_DA_EQUIPE, CRM_DA_EQUIPE, SOCIAL_DA_EQUIPE] as const;
export type Membro = (typeof MEMBROS)[number];

export interface DefinicaoDoMembro {
  key: Membro;
  /** `ia`: usa modelo (tem custo e para com a IA desligada ou com a parada); `regra`: trabalha por regra. */
  kind: 'ia' | 'regra';
  /** O funcionário do registro, quando há (a ativação da distribuição é a dele). */
  funcionario: FuncionarioDef | null;
  /**
   * Os fluxos dele em `ai_usage.workflow` (o custo e as chamadas do mês). Os nomes são os que cada serviço grava;
   * o teste da equipe confere que não se afastaram.
   */
  fluxos: string[];
  /** A empresa pode desligar. */
  desligavel: boolean;
}

export const EQUIPE: Record<Membro, DefinicaoDoMembro> = {
  lia: { key: 'lia', kind: 'ia', funcionario: LIA, fluxos: ['conversa.lia'], desligavel: true },
  analista: { key: 'analista', kind: 'ia', funcionario: ANALISTA, fluxos: ['resultados.explicar', 'atencao.explicar'], desligavel: true },
  relatorios: { key: RELATORIOS, kind: 'regra', funcionario: null, fluxos: ['revisao.semanal', 'relatorio.mensal'], desligavel: true },
  compliance: { key: COMPLIANCE, kind: 'regra', funcionario: null, fluxos: [WORKFLOW_DO_REVISOR], desligavel: false },
  estrategista: { key: 'estrategista', kind: 'ia', funcionario: ESTRATEGISTA, fluxos: ['estrategista.plano'], desligavel: true },
  pesquisador: { key: 'pesquisador', kind: 'ia', funcionario: PESQUISADOR, fluxos: ['pesquisador.pagina'], desligavel: true },
  trafego: { key: GESTOR_DE_TRAFEGO, kind: 'regra', funcionario: null, fluxos: [], desligavel: true },
  // A chave da pausa (`agent_pause`) é a do funcionário no registro: é ela que o serviço das peças confere ao pedir.
  criativo: { key: CRIATIVO_DA_EQUIPE, kind: 'ia', funcionario: CRIATIVO, fluxos: [WORKFLOW_DO_CRIATIVO], desligavel: true },
  // A chave é a do funcionário no registro e a do pedido que ele faz (`action_request.agent_key`, `message_request.agent_key`).
  crm: { key: CRM_DA_EQUIPE, kind: 'ia', funcionario: CRM, fluxos: [WORKFLOW_DO_CRM], desligavel: true },
  // A chave é a do funcionário no registro, a do pedido que ele faz (`action_request.agent_key`) e a da pausa que as
  // rotinas dele conferem (`oQueDesligaAsSugestoes` e `oQueDesligaOsPosts`): desligado aqui, ele não sugere resposta nem
  // propõe post nesta marca. O custo soma os dois trabalhos: as respostas e os posts.
  social: { key: SOCIAL_DA_EQUIPE, kind: 'ia', funcionario: SOCIAL, fluxos: [WORKFLOW_DO_SOCIAL, WORKFLOW_DO_SOCIAL_POST], desligavel: true },
};

export const ehMembro = (key: string): key is Membro => (MEMBROS as readonly string[]).includes(key);
