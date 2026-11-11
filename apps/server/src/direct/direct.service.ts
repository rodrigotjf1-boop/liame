import {
  DIRECT_ATTENDANCE_HOURS,
  DIRECT_LIST_LIMIT,
  DIRECT_MESSAGES_LIMIT,
  type DirectAccount,
  type DirectAttendanceRequest,
  type DirectAttendanceResponse,
  type DirectReplyRequest,
  type DirectReplyResponse,
  type DirectConversation,
  type DirectConversationResponse,
  type DirectConversationsQuery,
  type DirectConversationsResponse,
  type DirectCounts,
  type DirectSettingsQuery,
  type DirectSettingsRequest,
  type DirectSettingsResponse,
} from '@liame/contracts';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ActionService } from '../actions/action.service.js';
import { recursoDaConversa } from '../actions/direct-plano.js';
import { ConfirmacaoService } from '../auth/confirmacao.service.js';
import { contaConectada } from '../connections/conectada.js';
import { PROVEDOR_INSTAGRAM } from '../connectors/meta/publicacao.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { marcaDaEmpresa, quemPede } from '../fotos/fotos.service.js';
import { DATASET_DO_DIRECT, type DirecaoDoDirect, FLAG_DO_DIRECT, situacaoDaConversa } from './direct.js';
import type { CursorDoDirect } from './sincronizador-do-direct.js';

// O Direct do Instagram na API (A6, Z12, parte 1; P39, D-A6-106 a D-A6-112): o ajuste da marca (ligar, com o código do
// app, e desligar, na hora) e o que a tela lê do que a rotina `direct` guardou. Nada aqui chama a Meta nem o Regem:
// a leitura é do worker (V53), e responder vem à parte (Z12, parte 3).

/** Ligar o Direct: o Dono ou um Administrador (D-A6-109, como o automático dos comentários). */
const PERMISSAO_DE_LIGAR = 'politicas.gerenciar';
/** Desligar: quem aprova, na hora e sem código (a rota pede esta). */
const PERMISSAO_DE_DESLIGAR = 'acoes.aprovar';
/** Responder no Direct: o Dono, os Administradores e quem aprova (D-A6-109; a rota pede esta). */
const PERMISSAO_DE_RESPONDER = 'acoes.aprovar';
/** Quantas conversas a lista olha para contar e filtrar (a mais nova primeiro). */
const CONVERSAS_OLHADAS = 500;

type LinhaDaConta = { id: string; usuario: string | null; last_success_at: Date | string | null; last_error: string | null; cursor: CursorDoDirect | null };
type LinhaDaConversa = {
  conversation_id: string;
  username: string | null;
  last_message_at: Date | string;
  last_inbound_at: Date | string | null;
  last_direction: DirecaoDoDirect;
  concluded_at: Date | string | null;
  unread: boolean;
  m_direction: string | null;
  m_kind: string | null;
  m_body: string | null;
};

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const ZERO: DirectCounts = { espera: 0, fechando: 0, respondida: 0, fora: 0, todas: 0 };

@Injectable()
export class DirectService {
  constructor(
    private readonly flags: FlagService,
    private readonly confirmacao: ConfirmacaoService,
    private readonly acoes: ActionService,
  ) {}

  /** O atendimento aberto da pessoa: aberto agora (não fechado e dentro das 8 horas) e até quando. */
  private async atendimentoDe(tenantId: string, userId: string): Promise<{ open: boolean; until: string | null }> {
    const r = await currentTx().execute<{ expires_at: Date | string; aberto: boolean }>(sql`
      select expires_at, (closed_at is null and expires_at > now()) as aberto
        from liame.direct_attendance where tenant_id = ${tenantId} and user_id = ${userId}`);
    const l = r.rows[0];
    return l?.aberto ? { open: true, until: iso(l.expires_at) } : { open: false, until: null };
  }

  /** O atendimento da pessoa (D-A6-109): aberto, até quando e se ela pode responder no Direct. */
  async verAtendimento(auth: AuthContext): Promise<DirectAttendanceResponse> {
    const quem = quemPede(auth);
    return { ...(await this.atendimentoDe(quem.tenantId, quem.userId)), can_reply: auth.permissions.has(PERMISSAO_DE_RESPONDER) };
  }

  /**
   * Abre o atendimento (D-A6-109): a confirmação de quem é (o código do app ou a chave de acesso) uma vez, e por 8 horas
   * as respostas da pessoa no Direct saem sem pedir de novo. Abrir de novo recomeça as 8 horas. Fica na auditoria.
   */
  async abrirAtendimento(auth: AuthContext, body: DirectAttendanceRequest): Promise<DirectAttendanceResponse> {
    const quem = quemPede(auth);
    const tx = currentTx();
    await this.confirmacao.confirmar(tx, quem.userId, body);
    const r = await tx.execute<{ expires_at: Date | string }>(sql`
      insert into liame.direct_attendance (tenant_id, user_id, opened_at, expires_at, closed_at)
      values (${quem.tenantId}, ${quem.userId}, now(), now() + make_interval(hours => ${DIRECT_ATTENDANCE_HOURS}), null)
      on conflict (tenant_id, user_id) do update set opened_at = excluded.opened_at, expires_at = excluded.expires_at, closed_at = null
      returning expires_at`);
    auditDetail({ resourceId: quem.userId, after: { until: iso(r.rows[0]!.expires_at), hours: DIRECT_ATTENDANCE_HOURS } });
    return this.verAtendimento(auth);
  }

  /** Fecha o atendimento antes da hora: a próxima resposta pede o código de novo. */
  async fecharAtendimento(auth: AuthContext): Promise<DirectAttendanceResponse> {
    const quem = quemPede(auth);
    await currentTx().execute(sql`
      update liame.direct_attendance set closed_at = now()
       where tenant_id = ${quem.tenantId} and user_id = ${quem.userId} and closed_at is null and expires_at > now()`);
    auditDetail({ resourceId: quem.userId, after: { closed: true } });
    return this.verAtendimento(auth);
  }

  /**
   * Manda a resposta numa conversa (D-A6-109 e D-A6-111): o Direct ligado e lido na marca, o atendimento aberto e a
   * conversa guardada; o pedido vai pelo trilho de ações (a trava, as flags `social_write` e `direct_responder`, a
   * política v13 e o plano, que confere a janela de 24 horas e o texto) e nasce aprovado, para o executor mandar.
   */
  async responder(auth: AuthContext, conversationId: string, body: DirectReplyRequest): Promise<DirectReplyResponse> {
    const quem = quemPede(auth);
    const brandId = body.brand_id;
    await marcaDaEmpresa(brandId);
    const conta = await this.contaDaMarca(brandId);
    if (!conta || !(await this.lendo(quem.tenantId, quem.userId, brandId, conta))) {
      throw new AppProblem(409, 'direct-desligado', 'O Direct não está ligado', 'O Direct desta marca não está ligado no Liame, ou o Regem atende o Direct desta conta.');
    }
    if (!(await this.atendimentoDe(quem.tenantId, quem.userId)).open) {
      throw new AppProblem(409, 'atendimento-fechado', 'Abra o atendimento', 'Para responder no Direct, abra o atendimento com o código do app: vale por 8 horas.');
    }
    const tx = currentTx();
    const existe = await tx.execute<{ conversation_id: string }>(sql`
      select conversation_id from liame.direct_conversation where connected_account_id = ${conta.id} and conversation_id = ${conversationId}`);
    if (!existe.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Conversa não encontrada nesta marca.');
    const id = await this.acoes.pedirPelaRota(auth, {
      tool: 'direct_responder',
      brand_id: brandId,
      provider: PROVEDOR_INSTAGRAM,
      account_id: conta.id,
      resource_id: recursoDaConversa(conversationId),
      params: { texto: body.text },
    });
    const r = await tx.execute<{ status: string; status_reason: string | null }>(sql`select status, status_reason from liame.action_request where id = ${id}`);
    const pedido = r.rows[0]!;
    return { action_id: id, status: pedido.status, status_reason: pedido.status_reason };
  }

  /** Conclui a conversa sem responder (P39): sai de "Esperam resposta"; a mensagem nova da pessoa reabre. */
  async concluir(auth: AuthContext, conversationId: string, brandId: string): Promise<DirectConversationResponse> {
    const conta = await this.conversaDaMarca(auth, brandId, conversationId);
    await currentTx().execute(sql`
      update liame.direct_conversation set concluded_at = now(), unread = false
       where connected_account_id = ${conta} and conversation_id = ${conversationId}`);
    auditDetail({ resourceId: conversationId, after: { concluded: true } });
    return this.conversa(auth, brandId, conversationId);
  }

  /** Marca a conversa como lida no Liame (a pessoa abriu): só o "não lida" da lista; o Instagram não muda. */
  async marcarLida(auth: AuthContext, conversationId: string, brandId: string): Promise<DirectConversationResponse> {
    const conta = await this.conversaDaMarca(auth, brandId, conversationId);
    await currentTx().execute(sql`
      update liame.direct_conversation set unread = false where connected_account_id = ${conta} and conversation_id = ${conversationId}`);
    return this.conversa(auth, brandId, conversationId);
  }

  /** A conta da conversa, conferida na marca e no Direct ligado; 404 quando não está. */
  private async conversaDaMarca(auth: AuthContext, brandId: string, conversationId: string): Promise<string> {
    const quem = quemPede(auth);
    await marcaDaEmpresa(brandId);
    const conta = await this.contaDaMarca(brandId);
    const naoAchou = new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Conversa não encontrada nesta marca.');
    if (!conta || !(await this.lendo(quem.tenantId, quem.userId, brandId, conta))) throw naoAchou;
    const r = await currentTx().execute<{ conversation_id: string }>(sql`
      select conversation_id from liame.direct_conversation where connected_account_id = ${conta.id} and conversation_id = ${conversationId}`);
    if (!r.rows[0]) throw naoAchou;
    return conta.id;
  }

  private disponivel(tenantId: string, userId: string, brandId: string): Promise<boolean> {
    return this.flags.isEnabled(FLAG_DO_DIRECT, this.flags.context({ tenantId, userId, brandId }));
  }

  /** A conta do Instagram da marca (a primeira conectada) e o estado da leitura do Direct dela. */
  private async contaDaMarca(brandId: string): Promise<LinhaDaConta | null> {
    const r = await currentTx().execute<LinhaDaConta>(sql`
      select a.id, a.provider_attributes->>'usuario' as usuario, s.last_success_at, s.last_error, s.cursor
        from liame.connected_account a
        left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = ${DATASET_DO_DIRECT}
       where a.brand_id = ${brandId} and a.provider = ${PROVEDOR_INSTAGRAM} and ${contaConectada('a')}
       order by a.id
       limit 1`);
    return r.rows[0] ?? null;
  }

  private async ajusteDaMarca(brandId: string): Promise<{ enabled: boolean; sem_outro_programa: boolean; updated_at: Date | string | null; updated_by: string | null }> {
    const r = await currentTx().execute<{ enabled: boolean; sem_outro_programa: boolean; updated_at: Date | string; updated_by: string | null }>(sql`
      select enabled, sem_outro_programa, updated_at, updated_by from liame.direct_setting where brand_id = ${brandId}`);
    return r.rows[0] ?? { enabled: false, sem_outro_programa: false, updated_at: null, updated_by: null };
  }

  /** O ajuste do Direct da marca: liberado, ligado, quem pode mudar, a conta, a conferência com o Regem e a leitura. */
  async verAjuste(auth: AuthContext, query: DirectSettingsQuery): Promise<DirectSettingsResponse> {
    const quem = quemPede(auth);
    const brandId = query.brand_id;
    await marcaDaEmpresa(brandId);
    const tx = currentTx();
    const available = await this.disponivel(quem.tenantId, quem.userId, brandId);
    const ajuste = await this.ajusteDaMarca(brandId);
    const conta = await this.contaDaMarca(brandId);
    const quemMudou = ajuste.updated_by ? (await tx.execute<{ id: string; name: string }>(sql`select id, name from liame.app_user where id = ${ajuste.updated_by}`)).rows[0] : undefined;
    const cursor = conta?.cursor ?? {};
    return {
      brand_id: brandId,
      available,
      enabled: ajuste.enabled,
      no_other_app: ajuste.sem_outro_programa,
      can_enable: auth.permissions.has(PERMISSAO_DE_LIGAR),
      can_disable: auth.permissions.has(PERMISSAO_DE_DESLIGAR),
      account: conta ? { id: conta.id, username: conta.usuario } : null,
      regem: cursor.regem ?? 'pendente',
      regem_checked_at: cursor.regem_em ?? null,
      reading: leitura(available && ajuste.enabled, conta),
      read_at: conta?.last_success_at ? iso(conta.last_success_at) : null,
      updated_at: ajuste.updated_at ? iso(ajuste.updated_at) : null,
      updated_by: quemMudou ? { id: quemMudou.id, name: quemMudou.name } : null,
    };
  }

  /**
   * Liga ou desliga o Direct da marca (D-A6-107 e D-A6-109). Ligar: o Dono ou um Administrador, com a função liberada,
   * o Instagram conectado, a confirmação de que nenhum outro programa responde aquele Direct e a confirmação de quem é
   * (o código do app ou a chave de acesso); a leitura começa na volta seguinte da rotina. Desligar: quem aprova, na hora e
   * sem código. A mudança vai para a auditoria, com o antes e o depois.
   */
  async mudarAjuste(auth: AuthContext, body: DirectSettingsRequest): Promise<DirectSettingsResponse> {
    const quem = quemPede(auth);
    const brandId = body.brand_id;
    await marcaDaEmpresa(brandId);
    const tx = currentTx();
    const antes = await this.ajusteDaMarca(brandId);
    const liga = body.enabled && !antes.enabled;
    if (body.enabled && !body.no_other_app) {
      throw new AppProblem(422, 'confirme-outro-programa', 'Confirme o Direct', 'Para ligar, confirme que nenhum outro programa responde o Direct desta conta (um robô ou outro atendimento).');
    }
    const conta = liga ? await this.contaDaMarca(brandId) : null;
    if (liga) {
      if (!auth.permissions.has(PERMISSAO_DE_LIGAR)) {
        throw new AppProblem(403, 'so-dono-ou-administrador', 'Só o Dono ou um Administrador', 'Só o Dono ou um Administrador liga o Direct. Você pode desligar.');
      }
      if (!(await this.disponivel(quem.tenantId, quem.userId, brandId))) {
        throw new AppProblem(409, 'funcao-desligada', 'Ainda não está liberado', 'O Direct ainda não está liberado para esta empresa.');
      }
      if (!conta) throw new AppProblem(409, 'sem-instagram', 'Conecte o Instagram', 'A marca ainda não tem um Instagram conectado. Conecte em Contas conectadas e volte aqui.');
      await this.confirmacao.confirmar(tx, quem.userId, body);
    }
    const sem = body.enabled ? true : body.no_other_app;
    await tx.execute(sql`
      insert into liame.direct_setting (brand_id, tenant_id, enabled, sem_outro_programa, updated_by, created_at, updated_at)
      values (${brandId}, ${quem.tenantId}, ${body.enabled}, ${sem}, ${quem.userId}, now(), now())
      on conflict (brand_id) do update
        set enabled = excluded.enabled, sem_outro_programa = excluded.sem_outro_programa, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
    // Ligar traz a vez da conta para agora: desligada, ela esperava um dia (V106, ERR-143).
    if (liga && conta) {
      await tx.execute(sql`
        update liame.sync_state set cursor = coalesce(cursor, '{}'::jsonb) || jsonb_build_object('proxima', now()), updated_at = now()
         where connected_account_id = ${conta.id} and dataset = ${DATASET_DO_DIRECT}`);
    }
    auditDetail({
      resourceId: brandId,
      before: { enabled: antes.enabled, no_other_app: antes.sem_outro_programa },
      after: { enabled: body.enabled, no_other_app: sem, confirmed: liga },
    });
    return this.verAjuste(auth, { brand_id: brandId });
  }

  /**
   * As conversas da marca (D-A6-106 e D-A6-111), na situação pedida: as que esperam resposta (a que fecha a janela antes
   * primeiro), as com a janela fechando, as respondidas, as fora da janela e todas; a busca olha o @ e o texto. Vazia com
   * a função desligada, o Direct desligado na marca ou o Regem atendendo a conta (D-A6-107).
   */
  async conversas(auth: AuthContext, query: DirectConversationsQuery, agora = new Date()): Promise<DirectConversationsResponse> {
    const quem = quemPede(auth);
    const brandId = query.brand_id;
    await marcaDaEmpresa(brandId);
    const conta = await this.contaDaMarca(brandId);
    const account: DirectAccount | null = conta ? { id: conta.id, username: conta.usuario } : null;
    const base: DirectConversationsResponse = { brand_id: brandId, account, counts: ZERO, items: [] };
    if (!conta || !(await this.lendo(quem.tenantId, quem.userId, brandId, conta))) return base;

    const busca = query.q ? `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const linhas = (
      await currentTx().execute<LinhaDaConversa>(sql`
        select c.conversation_id, c.username, c.last_message_at, c.last_inbound_at, c.last_direction, c.concluded_at, c.unread,
               m.direction as m_direction, m.kind as m_kind, m.body as m_body
          from liame.direct_conversation c
          left join lateral (
            select x.direction, x.kind, x.body from liame.direct_message x
             where x.connected_account_id = c.connected_account_id and x.conversation_id = c.conversation_id
             order by x.sent_at desc, x.message_id desc limit 1) m on true
         where c.connected_account_id = ${conta.id}
           ${busca ? sql`and (c.username ilike ${busca} or exists (select 1 from liame.direct_message y where y.connected_account_id = c.connected_account_id and y.conversation_id = c.conversation_id and y.body ilike ${busca}))` : sql``}
         order by c.last_message_at desc, c.conversation_id
         limit ${CONVERSAS_OLHADAS}`)
    ).rows;
    const todas = linhas.map((l) => conversaDaLinha(l, agora));
    const counts: DirectCounts = {
      espera: todas.filter((c) => c.status === 'espera').length,
      fechando: todas.filter((c) => c.status === 'espera' && c.closing).length,
      respondida: todas.filter((c) => c.status === 'respondida').length,
      fora: todas.filter((c) => c.status === 'fora').length,
      todas: todas.length,
    };
    const filtro = query.status;
    const escolhidas = todas.filter((c) => filtro === 'todas' || (filtro === 'fechando' ? c.status === 'espera' && c.closing : c.status === filtro));
    // As que esperam: a janela que fecha antes primeiro; as outras, a mais nova primeiro.
    const ordenadas = escolhidas.sort((a, b) => {
      const pa = a.status === 'espera' ? 0 : 1;
      const pb = b.status === 'espera' ? 0 : 1;
      if (pa !== pb) return pa - pb;
      if (pa === 0) return (a.window_until ?? '').localeCompare(b.window_until ?? '');
      return b.last_message_at.localeCompare(a.last_message_at);
    });
    return { brand_id: brandId, account, counts, items: ordenadas.slice(0, DIRECT_LIST_LIMIT) };
  }

  /** Uma conversa e as mensagens guardadas dela (as 100 mais novas, da mais velha para a mais nova). */
  async conversa(auth: AuthContext, brandId: string, conversationId: string, agora = new Date()): Promise<DirectConversationResponse> {
    const quem = quemPede(auth);
    await marcaDaEmpresa(brandId);
    const conta = await this.contaDaMarca(brandId);
    const naoAchou = new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Conversa não encontrada nesta marca.');
    if (!conta || !(await this.lendo(quem.tenantId, quem.userId, brandId, conta))) throw naoAchou;
    const tx = currentTx();
    const linha = (
      await tx.execute<LinhaDaConversa>(sql`
        select c.conversation_id, c.username, c.last_message_at, c.last_inbound_at, c.last_direction, c.concluded_at, c.unread,
               m.direction as m_direction, m.kind as m_kind, m.body as m_body
          from liame.direct_conversation c
          left join lateral (
            select x.direction, x.kind, x.body from liame.direct_message x
             where x.connected_account_id = c.connected_account_id and x.conversation_id = c.conversation_id
             order by x.sent_at desc, x.message_id desc limit 1) m on true
         where c.connected_account_id = ${conta.id} and c.conversation_id = ${conversationId}`)
    ).rows[0];
    if (!linha) throw naoAchou;
    const mensagens = (
      await tx.execute<{ message_id: string; direction: string; kind: string; body: string; sent_at: Date | string }>(sql`
        select * from (
          select message_id, direction, kind, body, sent_at from liame.direct_message
           where connected_account_id = ${conta.id} and conversation_id = ${conversationId}
           order by sent_at desc, message_id desc
           limit ${DIRECT_MESSAGES_LIMIT}) z
         order by sent_at, message_id`)
    ).rows;
    return {
      brand_id: brandId,
      conversation: conversaDaLinha(linha, agora),
      messages: mensagens.map((m) => ({ id: m.message_id, direction: m.direction, kind: m.kind, text: m.body, sent_at: iso(m.sent_at) })),
    };
  }

  /** O Liame mostra o Direct desta conta: a função liberada, o Direct ligado na marca e o Regem sem atender a conta. */
  private async lendo(tenantId: string, userId: string, brandId: string, conta: LinhaDaConta): Promise<boolean> {
    if (conta.cursor?.regem === 'atende') return false;
    const ajuste = await this.ajusteDaMarca(brandId);
    return ajuste.enabled && (await this.disponivel(tenantId, userId, brandId));
  }
}

/** A leitura do Direct, para a tela: desligada, nunca lida, lida, sem a permissão ou falhou. */
function leitura(ligado: boolean, conta: LinhaDaConta | null): string {
  if (!ligado || !conta) return 'desligada';
  if (conta.last_error && conta.cursor?.falha === 'permissao') return 'sem_permissao';
  if (conta.last_success_at) return 'ok';
  return conta.last_error ? 'falhou' : 'nunca';
}

function conversaDaLinha(l: LinhaDaConversa, agora: Date): DirectConversation {
  const s = situacaoDaConversa({ last_direction: l.last_direction, last_inbound_at: l.last_inbound_at, concluded_at: l.concluded_at }, agora);
  return {
    id: l.conversation_id,
    username: l.username,
    status: s.situacao,
    closing: s.fechando,
    window_until: s.janelaAte,
    unread: l.unread,
    last_message_at: iso(l.last_message_at),
    last_message: l.m_direction ? { direction: l.m_direction, kind: l.m_kind ?? 'texto', text: l.m_body ?? '' } : null,
  };
}
