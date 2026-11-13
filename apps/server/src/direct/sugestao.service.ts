import type { DirectAiSuggestionRequest, DirectAiSuggestionResponse } from '@liame/contracts';
import type { Database } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AiError, AiGateway } from '../ai/gateway.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { registrarRecusa } from '../ai/recusas.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
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
import { type AuthContext, currentTx } from '../context/request-context.js';
import { marcaDoCriativo } from '../criativo/base.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { REGRAS_DE_TEXTO_VERSAO } from '../policy/texto.js';
import { DirectService } from './direct.service.js';

// A sugestão do Social media numa conversa do Direct ou do Messenger, a pedido de quem atende (A6, Z12, parte 4b-2; P39;
// D-A6-110 e D-A6-145). A pessoa da equipe abre a conversa que espera resposta e pede ("Pedir ao Social media"); o
// Liame lê a conversa como a tela a mostra (as mesmas regras de quem vê), manda ao modelo as dez últimas mensagens sem o
// nome nem o @ de ninguém, confere cada sugestão e devolve só as que passam. Nada é guardado: a sugestão vive na tela de
// quem pediu, e a resposta só sai quando a pessoa manda (parte 2, com o atendimento aberto). Sem a rota do modelo (ela só
// entra depois do eval pago e do item da Política 7), a rota responde `sem_ia`, e nenhuma mensagem vai a modelo.

type Quem = { tenantId: string; userId: string };

const TIPOS_COM_IA: readonly string[] = ['pergunta', 'reclamacao'];

@Injectable()
export class DirectSuggestionService {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly direct: DirectService,
    private readonly gateway: AiGateway,
  ) {}

  private quem(auth: AuthContext): Quem {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
    return { tenantId: auth.tenantId, userId: auth.userId };
  }

  async sugerir(auth: AuthContext, conversationId: string, body: DirectAiSuggestionRequest, agora = new Date()): Promise<DirectAiSuggestionResponse> {
    const quem = this.quem(auth);
    if (!this.database) throw new AppProblem(503, 'sem-banco', 'Indisponível', 'Tente de novo em instantes.');
    const database = this.database;

    // A conversa como a tela a lê (quem vê o Direct da marca, o canal ligado, o Regem sem atender a conta), a marca e o
    // Social media na marca, numa transação curta.
    const lido = await naTransacaoDaEmpresa(database, quem, async () => {
      const tx = currentTx();
      const c = await this.direct.conversa(auth, body.brand_id, conversationId, agora);
      if (c.conversation.status !== 'espera') {
        throw new AppProblem(409, 'conversa-nao-espera', 'A conversa não espera resposta', 'O Social media só sugere resposta para a conversa que espera resposta, dentro da janela da Meta.');
      }
      const ativo = await funcionarioAtivo(tx, { tenantId: quem.tenantId, brandId: body.brand_id, agentKey: SOCIAL.key, ativoPorPadrao: SOCIAL.ativoPorPadrao });
      const fuso = (await tx.execute<{ timezone: string | null }>(sql`select timezone from liame.organization where id = ${quem.tenantId}`)).rows[0]?.timezone ?? 'America/Sao_Paulo';
      const nome = (await tx.execute<{ name: string }>(sql`select name from liame.brand where id = ${body.brand_id}`)).rows[0]!.name;
      return { conversa: c, ativo, nome, marca: await marcaDoCriativo(body.brand_id, fuso, agora) };
    });

    const tipo = lido.conversa.conversation.kind;
    const semIa = (reason: NonNullable<DirectAiSuggestionResponse['reason']>, extra: { voltaEm?: Date; usageId?: string; dropped?: number } = {}): DirectAiSuggestionResponse => ({
      origin: 'sem_ia',
      reason,
      kind: tipo && TIPOS_COM_IA.includes(tipo) ? (tipo as TipoComSugestaoNoDirect) : null,
      suggestions: [],
      answered: false,
      missing: null,
      dropped: extra.dropped ?? 0,
      retry_at: extra.voltaEm ? extra.voltaEm.toISOString() : null,
      usage_id: extra.usageId ?? null,
    });
    // O elogio e a menção têm a resposta pronta, sem IA; o golpe e a ofensa, nenhuma; o que a regra não decide fica com
    // a pessoa (parte 4a).
    if (!tipo || !TIPOS_COM_IA.includes(tipo)) return semIa('tipo_sem_ia');
    const tipoComIa = tipo as TipoComSugestaoNoDirect;
    if (!lido.ativo) return semIa('funcionario_desligado');
    if (!(await this.gateway.ligada({ tenantId: quem.tenantId, userId: quem.userId, brandId: body.brand_id }))) return semIa('ia_desligada');

    // O que vai ao modelo: quem (a pessoa ou a marca), o tipo e o texto de cada mensagem. O nome e o @ ficam aqui.
    const mensagens: MensagemDaConversa[] = lido.conversa.messages.map((m) => ({ de: m.direction === 'saida' ? 'marca' : 'pessoa', tipo: m.kind, texto: m.text }));
    const marca = lido.marca;
    const anteriores = body.previous.map((a) => ({ enfoque: a.focus, texto: a.text }));
    const pedido = {
      marca: lido.nome,
      dossie: marca?.dossie ?? `Marca "${lido.nome}": Minha marca ainda não foi preenchida.`,
      canal: lido.conversa.conversation.channel === 'messenger' ? ('messenger' as const) : ('instagram' as const),
      tipo: tipoComIa,
      mensagens,
      anteriores,
    };
    let r: Awaited<ReturnType<AiGateway['structured']>>;
    try {
      r = await this.gateway.structured({
        tenantId: quem.tenantId,
        brandId: body.brand_id,
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
      registrarRecusa(database, {
        tenantId: quem.tenantId,
        brandId: body.brand_id,
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
    const quemEscreveu = lido.conversa.conversation.username ?? lido.conversa.conversation.name;
    const base = baseDoDirect(mensagens, { fatos: marca?.fatos ?? '', proibidas: marca?.proibidas ?? [], concorrentes: marca?.concorrentes ?? [] }, quemEscreveu);
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
      origin: 'ia',
      reason: null,
      kind: tipoComIa,
      suggestions: passam.map((s) => ({ focus: s.enfoque, text: s.texto, check: s.conferencia.situacao === 'passou' ? ('passou' as const) : ('aviso' as const) })),
      answered: respondeu,
      missing: faltaDoDirect(tipoComIa, resposta.data),
      dropped: fora,
      retry_at: null,
      usage_id: r.usageId,
    };
  }
}
