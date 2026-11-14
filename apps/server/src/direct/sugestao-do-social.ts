import type { DirectAiSuggestionResponse } from '@liame/contracts';
import type { Database } from '@liame/database';
import { AiError, type AiGateway } from '../ai/gateway.js';
import { registrarRecusa } from '../ai/recusas.js';
import {
  baseDoDirect,
  contextoDoDirect,
  faltaDoDirect,
  type MensagemDaConversa,
  mensagemDoDirect,
  PROMPT_SOCIAL_DIRECT,
  RespostaDoDirect,
  sugestoesDoDirect,
  TAREFA_SOCIAL_DIRECT,
  type TipoComSugestaoNoDirect,
  WORKFLOW_DO_SOCIAL_DIRECT,
} from '../ai/social/direct.js';
import { SOCIAL } from '../ai/social/prompt.js';
import type { MarcaDoCriativo } from '../criativo/base.js';
import { REGRAS_DE_TEXTO_VERSAO } from '../policy/texto.js';

// O pedido ao Social media numa conversa do Direct ou do Messenger (A6, Z12; D-A6-110, D-A6-145 e D-A6-148): o modelo,
// a conferência de cada sugestão e o que a conferência tirou em Sua equipe. Quem chama já leu a conversa: a sugestão a
// pedido de quem atende (`sugestao.service.ts`, parte 4b-2) e o atendimento automático da pergunta (a rotina
// `worker/direct-automatico.ts`, parte 5c), que só manda o que vier com `certeza`. Nada é guardado aqui.

/** Os tipos que pedem o modelo: a pergunta e a reclamação. */
export const TIPOS_COM_IA_NO_DIRECT: readonly string[] = ['pergunta', 'reclamacao'];

/** A conversa como quem chama a leu: o tipo, o Social media na marca, Minha marca, o canal e as mensagens (da mais velha para a mais nova). */
export type ConversaParaOSocial = {
  tipo: string | null;
  /** O Social media ativo na marca. */
  ativo: boolean;
  /** O nome da marca. */
  nome: string;
  marca: MarcaDoCriativo | null;
  canal: 'instagram' | 'messenger';
  mensagens: readonly MensagemDaConversa[];
  /** O @ (ou o nome, no Messenger) de quem escreveu: só para a conferência, para a resposta não o citar; nunca vai ao modelo. */
  quemEscreveu: string | null;
};

/**
 * A resposta para a tela e a certeza para o automático. `certeza` é a régua da D-A6-105 aplicada ao Direct (D-A6-115):
 * a pergunta com o "sim" do Social media, a primeira sugestão conferida sem aviso nenhum e nada tirado da mesma resposta
 * (nem barrado pela conferência, nem descartado). Na reclamação, nunca.
 */
export type SugestaoDoSocialNoDirect = { resposta: DirectAiSuggestionResponse; certeza: boolean };

/**
 * Pede ao Social media. `userId` nulo é a rotina do sistema (não entra no limite por pessoa). `anteriores`: o "Pedir
 * outra" (as sugestões que a pessoa já viu).
 */
export async function sugestaoDoSocialNoDirect(
  deps: { database: Database; gateway: AiGateway },
  quem: { tenantId: string; userId: string | null },
  brandId: string,
  conversa: ConversaParaOSocial,
  anteriores: readonly { enfoque: string; texto: string }[] = [],
): Promise<SugestaoDoSocialNoDirect> {
  const tipo = conversa.tipo;
  const semIa = (reason: NonNullable<DirectAiSuggestionResponse['reason']>, extra: { voltaEm?: Date; usageId?: string; dropped?: number } = {}): SugestaoDoSocialNoDirect => ({
    resposta: {
      origin: 'sem_ia',
      reason,
      kind: tipo && TIPOS_COM_IA_NO_DIRECT.includes(tipo) ? (tipo as TipoComSugestaoNoDirect) : null,
      suggestions: [],
      answered: false,
      missing: null,
      dropped: extra.dropped ?? 0,
      retry_at: extra.voltaEm ? extra.voltaEm.toISOString() : null,
      usage_id: extra.usageId ?? null,
    },
    certeza: false,
  });
  // O elogio e a menção têm a resposta pronta, sem IA; o golpe e a ofensa, nenhuma; o que a regra não decide fica com
  // a pessoa (parte 4a).
  if (!tipo || !TIPOS_COM_IA_NO_DIRECT.includes(tipo)) return semIa('tipo_sem_ia');
  const tipoComIa = tipo as TipoComSugestaoNoDirect;
  if (!conversa.ativo) return semIa('funcionario_desligado');
  if (!(await deps.gateway.ligada({ tenantId: quem.tenantId, userId: quem.userId, brandId }))) return semIa('ia_desligada');

  const marca = conversa.marca;
  const pedido = {
    marca: conversa.nome,
    dossie: marca?.dossie ?? `Marca "${conversa.nome}": Minha marca ainda não foi preenchida.`,
    canal: conversa.canal,
    tipo: tipoComIa,
    mensagens: conversa.mensagens,
    anteriores,
  };
  let r: Awaited<ReturnType<AiGateway['structured']>>;
  try {
    r = await deps.gateway.structured({
      tenantId: quem.tenantId,
      brandId,
      userId: quem.userId,
      workflow: WORKFLOW_DO_SOCIAL_DIRECT,
      task: TAREFA_SOCIAL_DIRECT,
      promptVersion: `${PROMPT_SOCIAL_DIRECT.key}@${PROMPT_SOCIAL_DIRECT.version}`,
      instructions: PROMPT_SOCIAL_DIRECT.content,
      context: contextoDoDirect(pedido),
      messages: [{ role: 'user', content: mensagemDoDirect(pedido) }],
      schema: RespostaDoDirect,
    });
  } catch (err) {
    if (!(err instanceof AiError)) throw err;
    return semIa(err.code === 'desligada' ? 'ia_desligada' : err.code, { voltaEm: err.detalhe.voltaEm });
  }

  // O que a conferência tirou conta em Sua equipe (sem o texto): uma linha por motivo, com quantas sugestões.
  const anotar = (kind: string, rules: string[], items: number) =>
    registrarRecusa(deps.database, {
      tenantId: quem.tenantId,
      brandId,
      userId: quem.userId,
      usageId: r.usageId,
      member: SOCIAL.key,
      workflow: WORKFLOW_DO_SOCIAL_DIRECT,
      kind,
      rules,
      rulesVersion: kind === 'compliance' ? REGRAS_DE_TEXTO_VERSAO : null,
      items,
    });
  const resposta = RespostaDoDirect.safeParse(r.object);
  if (!resposta.success) {
    await anotar('formato', [], 1);
    return semIa('formato', { usageId: r.usageId });
  }
  // A conferência (a mesma das respostas aos comentários, com os caminhos do Direct): o nome ou o @ de quem escreveu
  // entra só aqui, para a resposta não o citar.
  const base = baseDoDirect(conversa.mensagens, { fatos: marca?.fatos ?? '', proibidas: marca?.proibidas ?? [], concorrentes: marca?.concorrentes ?? [] }, conversa.quemEscreveu);
  const { sugestoes, descartes } = sugestoesDoDirect(
    resposta.data,
    base,
    tipoComIa,
    marca?.dossie ?? '',
    anteriores.map((a) => a.texto),
  );
  const passam = sugestoes.filter((s) => s.conferencia.situacao !== 'barrou');
  const barradas = sugestoes.filter((s) => s.conferencia.situacao === 'barrou');
  if (barradas.length) {
    const regras = [...new Set(barradas.flatMap((s) => s.conferencia.itens.flatMap((i) => (i.situacao === 'barrou' ? i.achados.map((a) => a.tipo) : []))))];
    await anotar('compliance', regras, barradas.length);
  }
  const semDadoPessoal = descartes.filter((d) => d === 'dado_pessoal').length;
  if (semDadoPessoal) await anotar('compliance', ['dado_pessoal'], semDadoPessoal);
  const fora = descartes.length + barradas.length;
  if (!passam.length) {
    if (!barradas.length && !semDadoPessoal) await anotar('formato', [], 1);
    return semIa(barradas.length || semDadoPessoal ? 'barrado' : 'formato', { usageId: r.usageId, dropped: fora });
  }
  // "Conferido" só quando ele respondeu com o que Minha marca diz E a conferência passou sem aviso; senão, "precisa de você".
  const respondeu = tipoComIa === 'pergunta' && resposta.data.respondida === 'sim' && passam[0]!.conferencia.situacao === 'passou';
  return {
    resposta: {
      origin: 'ia',
      reason: null,
      kind: tipoComIa,
      suggestions: passam.map((s) => ({ focus: s.enfoque, text: s.texto, check: s.conferencia.situacao === 'passou' ? ('passou' as const) : ('aviso' as const) })),
      answered: respondeu,
      missing: faltaDoDirect(tipoComIa, resposta.data),
      dropped: fora,
      retry_at: null,
      usage_id: r.usageId,
    },
    // A certeza do automático: o "conferido" da tela e nada tirado da mesma resposta.
    certeza: respondeu && fora === 0,
  };
}
