import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ActionService } from '../actions/action.service.js';
import { recursoDaConversa, textoDaRespostaNoDirect } from '../actions/direct-plano.js';
import { AiGateway } from '../ai/gateway.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import { MENSAGENS_NO_PEDIDO } from '../ai/social/direct.js';
import { SOCIAL } from '../ai/social/prompt.js';
import { PROVEDOR_INSTAGRAM, PROVEDOR_PAGINA } from '../connectors/meta/publicacao.js';
import { currentTx } from '../context/request-context.js';
import { marcaDoCriativo } from '../criativo/base.js';
import { DATABASE } from '../database/database.module.js';
import {
  comAvisoDoDirect,
  FERRAMENTA_DO_DIRECT_AUTOMATICO,
  oQueSeguraODirectAutomatico,
  RESPOSTAS_AUTOMATICAS_DO_DIRECT_POR_HORA,
} from '../direct/automatico.js';
import { JANELA_DO_DIRECT_HORAS } from '../direct/direct.js';
import { type ConversaParaOSocial, sugestaoDoSocialNoDirect } from '../direct/sugestao-do-social.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

/** As situações do pedido automático que contam no teto da hora (as mesmas do portão). */
const NO_TETO = ['aprovada', 'executando', 'executada'] as const;

type Candidata = { tenant_id: string; brand_id: string; connected_account_id: string; conversation_id: string; channel: string; ultima: string };

/** O que a rotina fez com a conversa: respondeu sozinha (o pedido), deixou com uma pessoa (o porquê) ou nada. */
export type VezDoDirectAutomatico = { conversa: string } & ({ status: 'respondida'; pedido: string } | { status: 'com_a_pessoa'; motivo: string } | { status: 'fora' });

/** A pergunta que o portão deixou passar: a mensagem da pessoa que ela responde e a conversa para o Social media. */
type PerguntaParaOSocial = { pergunta: { mensagem: string; conversa: ConversaParaOSocial } };

/**
 * O atendimento automático do Direct (A6, Z12, partes 5a e 5c; P39 versão 2; D-A6-115, D-A6-119 e D-A6-148). Olha as
 * conversas que esperam resposta nas marcas com o automático ligado, cuja última mensagem da pessoa ainda não foi decidida
 * (`auto_checked_message`), dentro da janela da Meta e com a marca abaixo do teto da hora (a condição do teto fica na
 * consulta, para a marca no teto não travar a fila das outras: V84). Cada conversa é decidida na transação da empresa,
 * presa com SKIP LOCKED (dois workers não decidem a mesma) e marcada como decidida: ou o Social media pede a resposta
 * automática pelo trilho (o portão de novo no Action Service e no executor), ou ela fica com uma pessoa, com o porquê.
 * A mensagem seguinte da pessoa é decidida de novo.
 *
 * A pergunta (parte 5c) tem três tempos, para o modelo não segurar a transação nem a trava da conversa: (1) a mesma
 * transação marca a mensagem como decidida e lê o que vai ao Social media; (2) fora dela, o modelo, e só a `certeza`
 * dele segue (o "sim", a conferência sem aviso e nada tirado; D-A6-105); (3) numa transação nova, o portão de novo e a
 * mesma última mensagem da pessoa, e o pedido com o texto dele e o aviso. Falhou qualquer um, a conversa fica com uma
 * pessoa (a mensagem já está decidida: o modelo não é chamado duas vezes para ela).
 */
@Injectable()
export class DirectAutomaticoLoop {
  private readonly logger = new Logger('direct-automatico');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly acoes: ActionService,
    private readonly gateway: AiGateway,
  ) {}

  async executarLote(limite = 10, scope: JobScope = {}, agora: Date = new Date()): Promise<VezDoDirectAutomatico[]> {
    if (!this.database) return [];
    const ref = sql`${agora.toISOString()}::timestamptz`;
    const candidatas = await withSystem(this.database.db, async (tx) =>
      (
        await tx.execute<Candidata>(sql`
          select c.tenant_id, c.brand_id, c.connected_account_id, c.conversation_id, c.channel, p.message_id as ultima
            from liame.direct_conversation c
            join liame.direct_auto_reply r on r.brand_id = c.brand_id and r.enabled
            join lateral (
              select m.message_id from liame.direct_message m
               where m.connected_account_id = c.connected_account_id and m.conversation_id = c.conversation_id and m.direction = 'entrada'
               order by m.sent_at desc, m.message_id desc limit 1) p on true
           where c.last_direction = 'entrada'
             and c.last_inbound_at > ${ref} - make_interval(hours => ${JANELA_DO_DIRECT_HORAS})
             and (c.concluded_at is null or c.concluded_at < c.last_inbound_at)
             and c.auto_checked_message is distinct from p.message_id
             and (select count(*) from liame.action_request q
                   where q.tenant_id = c.tenant_id and q.created_at > ${ref} - interval '1 hour'
                     and q.brand_id = c.brand_id and q.tool = ${FERRAMENTA_DO_DIRECT_AUTOMATICO} and q.status in ${[...NO_TETO]}) < ${RESPOSTAS_AUTOMATICAS_DO_DIRECT_POR_HORA}
             ${tenantFilter(scope, sql`c.tenant_id`)}
           order by c.last_inbound_at, c.conversation_id
           limit ${limite}`)
      ).rows,
    );
    const vezes: VezDoDirectAutomatico[] = [];
    for (const c of candidatas) {
      try {
        vezes.push(await this.decidir(c, agora));
      } catch (err) {
        // Falha fora do previsto: na resposta pronta, a conversa não foi marcada e volta na próxima volta (a resposta que
        // saiu não sai duas vezes: o conector confere pelo texto); na pergunta, a mensagem já estava decidida e fica com
        // uma pessoa.
        this.logger.error(`conversa ${c.conversation_id}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    }
    return vezes;
  }

  private async decidir(c: Candidata, agora: Date): Promise<VezDoDirectAutomatico> {
    const conversa = c.conversation_id;
    let primeira: VezDoDirectAutomatico | PerguntaParaOSocial;
    try {
      primeira = await naTransacaoDaEmpresa(this.banco(), { tenantId: c.tenant_id, userId: null }, async (): Promise<VezDoDirectAutomatico | PerguntaParaOSocial> => {
        const tx = currentTx();
        const presa = (
          await tx.execute<{ auto_checked_message: string | null }>(sql`
            select auto_checked_message from liame.direct_conversation
             where connected_account_id = ${c.connected_account_id}::uuid and conversation_id = ${conversa}
             for update skip locked`)
        ).rows[0];
        if (!presa || presa.auto_checked_message === c.ultima) return { conversa, status: 'fora' };
        await this.marcar(c);
        const portao = await oQueSeguraODirectAutomatico(tx, this.flags, this.alvo(c), agora);
        if ('segura' in portao) return { conversa, status: 'com_a_pessoa', motivo: portao.segura };
        if (portao.resposta.texto === null) {
          return { pergunta: { mensagem: portao.resposta.mensagem, conversa: await this.conversaParaOSocial(c, agora) } };
        }
        return this.pedir(c, portao.resposta.texto, agora);
      });
    } catch (err) {
      // O pedido foi recusado (o portão fechou entre a escolha e o pedido, a política pede outra coisa, o plano recusou):
      // a transação de cima desfez a marca; a conversa fica com uma pessoa, marcada numa transação nova.
      if (err instanceof AppProblem && err.getStatus() < 500) {
        await naTransacaoDaEmpresa(this.banco(), { tenantId: c.tenant_id, userId: null }, () => this.marcar(c));
        return { conversa, status: 'com_a_pessoa', motivo: err.code };
      }
      throw err;
    }
    if (!('pergunta' in primeira)) return primeira;
    return this.responderAPergunta(c, primeira.pergunta, agora);
  }

  /**
   * A pergunta (parte 5c), depois da primeira transação (a mensagem já está decidida): o Social media, fora da
   * transação, e, com a certeza dele, o pedido numa transação nova, com o portão de novo e a mesma última mensagem da
   * pessoa (a que chegou no meio volta à fila e é decidida por ela mesma).
   */
  private async responderAPergunta(c: Candidata, p: PerguntaParaOSocial['pergunta'], agora: Date): Promise<VezDoDirectAutomatico> {
    const conversa = c.conversation_id;
    const s = await sugestaoDoSocialNoDirect({ database: this.banco(), gateway: this.gateway }, { tenantId: c.tenant_id, userId: null }, c.brand_id, p.conversa);
    if (!s.certeza) return { conversa, status: 'com_a_pessoa', motivo: s.resposta.reason ?? 'sem_certeza' };
    const texto = textoDaRespostaNoDirect(comAvisoDoDirect(s.resposta.suggestions[0]!.text));
    if (!texto) return { conversa, status: 'com_a_pessoa', motivo: 'texto_longo' };
    try {
      return await naTransacaoDaEmpresa(this.banco(), { tenantId: c.tenant_id, userId: null }, async (): Promise<VezDoDirectAutomatico> => {
        const portao = await oQueSeguraODirectAutomatico(currentTx(), this.flags, this.alvo(c), agora);
        if ('segura' in portao) return { conversa, status: 'com_a_pessoa', motivo: portao.segura };
        if (portao.resposta.texto !== null || portao.resposta.mensagem !== p.mensagem) return { conversa, status: 'com_a_pessoa', motivo: 'conversa_mudou' };
        return this.pedir(c, texto, agora);
      });
    } catch (err) {
      // A mensagem já estava decidida (a primeira transação a marcou): não marca de novo, para não voltar a marca de uma
      // mensagem que chegou depois e já foi decidida por outra volta.
      if (err instanceof AppProblem && err.getStatus() < 500) return { conversa, status: 'com_a_pessoa', motivo: err.code };
      throw err;
    }
  }

  /** O pedido da resposta automática pelo trilho, em nome do dono da empresa (quem responde pelo que o funcionário manda). */
  private async pedir(c: Candidata, texto: string, agora: Date): Promise<VezDoDirectAutomatico> {
    const conversa = c.conversation_id;
    const dono = (
      await currentTx().execute<{ user_id: string }>(sql`
        select user_id from liame.membership where tenant_id = ${c.tenant_id} and role_key = 'dono' and revoked_at is null`)
    ).rows[0];
    if (!dono) return { conversa, status: 'com_a_pessoa', motivo: 'sem_dono' };
    const pedido = await this.acoes.responderSozinhoNoDirect(
      { tenantId: c.tenant_id, agentKey: SOCIAL.key, agentLabel: SOCIAL.name, emNomeDe: dono.user_id },
      {
        tool: FERRAMENTA_DO_DIRECT_AUTOMATICO,
        brand_id: c.brand_id,
        // O Messenger sai pela conta da Página (Z14, parte 2); o Direct, pela do Instagram.
        provider: c.channel === 'messenger' ? PROVEDOR_PAGINA : PROVEDOR_INSTAGRAM,
        account_id: c.connected_account_id,
        resource_id: recursoDaConversa(conversa),
        params: { texto },
      },
      agora,
    );
    return { conversa, status: 'respondida', pedido };
  }

  /**
   * O que vai ao Social media na pergunta (na transação da empresa): o Social media na marca, Minha marca, o canal e as
   * mensagens mais novas da conversa (as que o modelo lê), da mais velha para a mais nova. O @ (ou o nome) de quem
   * escreveu fica só para a conferência.
   */
  private async conversaParaOSocial(c: Candidata, agora: Date): Promise<ConversaParaOSocial> {
    const tx = currentTx();
    const ativo = await funcionarioAtivo(tx, { tenantId: c.tenant_id, brandId: c.brand_id, agentKey: SOCIAL.key, ativoPorPadrao: SOCIAL.ativoPorPadrao });
    const fuso = (await tx.execute<{ timezone: string | null }>(sql`select timezone from liame.organization where id = ${c.tenant_id}`)).rows[0]?.timezone ?? 'America/Sao_Paulo';
    const nome = (await tx.execute<{ name: string }>(sql`select name from liame.brand where id = ${c.brand_id}`)).rows[0]!.name;
    const quem = (
      await tx.execute<{ username: string | null; display_name: string | null }>(sql`
        select username, display_name from liame.direct_conversation
         where connected_account_id = ${c.connected_account_id}::uuid and conversation_id = ${c.conversation_id}`)
    ).rows[0];
    const mensagens = (
      await tx.execute<{ direction: string; kind: string; body: string }>(sql`
        select direction, kind, body from (
          select direction, kind, body, sent_at, message_id from liame.direct_message
           where connected_account_id = ${c.connected_account_id}::uuid and conversation_id = ${c.conversation_id}
           order by sent_at desc, message_id desc
           limit ${MENSAGENS_NO_PEDIDO}) z
         order by sent_at, message_id`)
    ).rows;
    return {
      tipo: 'pergunta',
      ativo,
      nome,
      marca: await marcaDoCriativo(c.brand_id, fuso, agora),
      canal: c.channel === 'messenger' ? 'messenger' : 'instagram',
      mensagens: mensagens.map((m) => ({ de: m.direction === 'saida' ? 'marca' : 'pessoa', tipo: m.kind, texto: m.body })),
      quemEscreveu: quem?.username ?? quem?.display_name ?? null,
    };
  }

  private alvo(c: Candidata) {
    return { tenantId: c.tenant_id, brandId: c.brand_id, connectedAccountId: c.connected_account_id, conversationId: c.conversation_id };
  }

  /** A última mensagem da pessoa foi decidida pelo automático: a mesma não volta à fila; a seguinte, sim. */
  private async marcar(c: Candidata): Promise<void> {
    await currentTx().execute(sql`
      update liame.direct_conversation set auto_checked_message = ${c.ultima}
       where connected_account_id = ${c.connected_account_id}::uuid and conversation_id = ${c.conversation_id}`);
  }

  private banco(): Database {
    if (!this.database) throw new Error('atendimento automático do Direct: sem banco');
    return this.database;
  }
}
