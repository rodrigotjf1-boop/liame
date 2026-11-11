import {
  DIRECT_ATTENDANCE_HOURS,
  DIRECT_AUTO_REPLY_PREVIEW_LIMIT,
  DIRECT_LIST_LIMIT,
  DIRECT_MESSAGES_LIMIT,
  type DirectAccount,
  type DirectAttendanceRequest,
  type DirectAttendanceResponse,
  type DirectAutoReplyPreviewResponse,
  type DirectAutoReplyRequest,
  type DirectAutoReplyResponse,
  type DirectReplyRequest,
  type DirectReplyResponse,
  type DirectConversation,
  type DirectConversationResponse,
  type DirectConversationsQuery,
  type DirectConversationsResponse,
  type DirectCounts,
  type DirectMessengerSettings,
  type DirectSettingsQuery,
  type DirectSettingsRequest,
  type DirectSettingsResponse,
  type DirectWaitingResponse,
} from '@liame/contracts';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ActionService } from '../actions/action.service.js';
import { recursoDaConversa } from '../actions/direct-plano.js';
import { ConfirmacaoService } from '../auth/confirmacao.service.js';
import { contaConectada } from '../connections/conectada.js';
import { PROVEDOR_INSTAGRAM, PROVEDOR_PAGINA } from '../connectors/meta/publicacao.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { marcaDaEmpresa, quemPede } from '../fotos/fotos.service.js';
import { type CanalDoDirect, DATASET_DO_DIRECT, type DirecaoDoDirect, FLAG_DO_DIRECT, FLAG_DO_MESSENGER, JANELA_DO_DIRECT_HORAS, situacaoDaConversa } from './direct.js';
import type { CursorDoDirect } from './sincronizador-do-direct.js';
import {
  automaticoDoDirect,
  comAvisoDoDirect,
  FLAG_DO_DIRECT_AUTOMATICO,
  pedeUmaPessoa,
  RESPOSTAS_AUTOMATICAS_DO_DIRECT_POR_HORA,
  respostasAutomaticasDoDirectNaHora,
  TIPOS_DO_DIRECT_AUTOMATICO,
  tipoDoAutomatico,
} from './automatico.js';
import { PENDENTES_DO_TIPO, sugestaoNoDirect, type TipoNoDirect, tipoNoDirect } from './tipo-no-direct.js';

// O Direct do Instagram na API (A6, Z12, parte 1; P39, D-A6-106 a D-A6-112): o ajuste da marca (ligar, com o código do
// app, e desligar, na hora) e o que a tela lê do que a rotina `direct` guardou. Nada aqui chama a Meta nem o Regem:
// a leitura é do worker (V53). Responder, com o atendimento aberto, pelo trilho de ações (parte 2); o tipo de cada
// conversa e a sugestão sem IA (parte 4a), por `tipo-no-direct.ts`.

/** Ligar o Direct: o Dono ou um Administrador (D-A6-109, como o automático dos comentários). */
const PERMISSAO_DE_LIGAR = 'politicas.gerenciar';
/** Desligar: quem aprova, na hora e sem código (a rota pede esta). */
const PERMISSAO_DE_DESLIGAR = 'acoes.aprovar';
/** Responder no Direct: o Dono, os Administradores e quem aprova (D-A6-109; a rota pede esta). */
const PERMISSAO_DE_RESPONDER = 'acoes.aprovar';
/** Quantas conversas a lista olha para contar e filtrar (a mais nova primeiro). */
const CONVERSAS_OLHADAS = 500;
/** Quantas conversas recentes a prévia do automático olha para achar as que ele sabe responder. */
const PREVIA_OLHADAS = 50;

/** O que a pessoa mandou, para a prévia: o texto, ou o que só o Instagram guarda (o story). */
function previaDaMensagem(c: DirectConversation): string {
  const m = c.last_message;
  if (!m) return '';
  if (m.text) return m.text;
  if (m.kind === 'story_mencao') return 'Marcou a marca no story';
  if (m.kind === 'story_resposta') return 'Respondeu ao story';
  return '';
}

type LinhaDaConta = { id: string; usuario: string | null; nome: string | null; last_success_at: Date | string | null; last_error: string | null; cursor: CursorDoDirect | null };
/** Uma conta da marca que o Liame lê agora, com o canal (A6, Z14): o Instagram (o Direct) ou a Página (o Messenger). */
type ContaLida = LinhaDaConta & { canal: CanalDoDirect };
type AjusteDoCanal = { enabled: boolean; sem_outro_programa: boolean; updated_at: Date | string | null; updated_by: string | null };
type LinhaDaConversa = {
  connected_account_id: string;
  conversation_id: string;
  username: string | null;
  channel: string;
  display_name: string | null;
  last_message_at: Date | string;
  last_inbound_at: Date | string | null;
  last_direction: DirecaoDoDirect;
  concluded_at: Date | string | null;
  unread: boolean;
  m_direction: string | null;
  m_kind: string | null;
  m_body: string | null;
  /** O que a pessoa mandou desde a última resposta da marca (e depois de concluída), da mais velha à mais nova. */
  p_pendentes: { id: string; kind: string; body: string }[] | null;
};

/**
 * As mensagens da pessoa depois da última resposta da marca e de "concluir" (as mais novas, até `PENDENTES_DO_TIPO`),
 * para o tipo da conversa (parte 4a). O texto de cada uma, cortado em 600 (a regra olha o começo).
 */
const PENDENTES = sql`
  left join lateral (
    select coalesce(jsonb_agg(jsonb_build_object('id', y.message_id, 'kind', y.kind, 'body', left(y.body, 600)) order by y.sent_at, y.message_id), '[]'::jsonb) as p_pendentes
      from (select z.message_id, z.kind, z.body, z.sent_at from liame.direct_message z
             where z.connected_account_id = c.connected_account_id and z.conversation_id = c.conversation_id and z.direction = 'entrada'
               and z.sent_at > coalesce(c.concluded_at, '-infinity'::timestamptz)
               and z.sent_at > coalesce((select max(w.sent_at) from liame.direct_message w
                                          where w.connected_account_id = c.connected_account_id and w.conversation_id = c.conversation_id
                                            and w.direction = 'saida'), '-infinity'::timestamptz)
             order by z.sent_at desc, z.message_id desc limit ${PENDENTES_DO_TIPO}) y) p on true`;

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
    const lidas = await this.contasLidas(quem.tenantId, quem.userId, brandId);
    if (!lidas.length) {
      throw new AppProblem(409, 'direct-desligado', 'O Direct não está ligado', 'O Direct desta marca não está ligado no Liame, ou o Regem atende o Direct desta conta.');
    }
    if (!(await this.atendimentoDe(quem.tenantId, quem.userId)).open) {
      throw new AppProblem(409, 'atendimento-fechado', 'Abra o atendimento', 'Para responder no Direct, abra o atendimento com o código do app: vale por 8 horas.');
    }
    const tx = currentTx();
    const existe = (
      await tx.execute<{ connected_account_id: string; channel: string }>(sql`
        select connected_account_id, channel from liame.direct_conversation
         where connected_account_id in ${lidas.map((c) => c.id)} and conversation_id = ${conversationId}`)
    ).rows[0];
    if (!existe) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Conversa não encontrada nesta marca.');
    // Responder no Messenger pelo Liame vem na parte 2 da Z14 (o conector da Página).
    if (existe.channel === 'messenger') {
      throw new AppProblem(409, 'messenger-sem-resposta', 'Ainda não responde no Messenger', 'Responder no Messenger pelo Liame chega na próxima parte; por enquanto, responda pelo Messenger da Página.');
    }
    const id = await this.acoes.pedirPelaRota(auth, {
      tool: 'direct_responder',
      brand_id: brandId,
      provider: PROVEDOR_INSTAGRAM,
      account_id: existe.connected_account_id,
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
    const lidas = await this.contasLidas(quem.tenantId, quem.userId, brandId);
    const naoAchou = new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Conversa não encontrada nesta marca.');
    if (!lidas.length) throw naoAchou;
    const r = await currentTx().execute<{ connected_account_id: string }>(sql`
      select connected_account_id from liame.direct_conversation
       where connected_account_id in ${lidas.map((c) => c.id)} and conversation_id = ${conversationId}`);
    if (!r.rows[0]) throw naoAchou;
    return r.rows[0].connected_account_id;
  }

  private disponivel(tenantId: string, userId: string, brandId: string, canal: CanalDoDirect = 'instagram'): Promise<boolean> {
    return this.flags.isEnabled(canal === 'messenger' ? FLAG_DO_MESSENGER : FLAG_DO_DIRECT, this.flags.context({ tenantId, userId, brandId }));
  }

  /** As contas da marca que o Liame lê agora (A6, Z14): o Instagram do Direct e a Página do Messenger, cada uma pelo canal. */
  private async contasLidas(tenantId: string, userId: string, brandId: string): Promise<ContaLida[]> {
    const lidas: ContaLida[] = [];
    for (const canal of ['instagram', 'messenger'] as const) {
      const conta = await this.contaDaMarca(brandId, canal);
      if (conta && (await this.lendo(tenantId, userId, brandId, conta, canal))) lidas.push({ ...conta, canal });
    }
    return lidas;
  }

  /**
   * O contador do menu (P39): as conversas que esperam resposta, somadas as marcas ativas da empresa em que o Liame mostra
   * o Direct (a função, o Direct ligado na marca e o Regem sem atender a conta). A regra de "espera" é a de
   * `situacaoDaConversa`, em SQL (V74): a última mensagem é da pessoa, sem "concluir" depois dela, dentro da janela.
   */
  async esperando(auth: AuthContext, agora = new Date()): Promise<DirectWaitingResponse> {
    const quem = quemPede(auth);
    const marcas = (await currentTx().execute<{ id: string }>(sql`select id from liame.brand where archived_at is null`)).rows;
    const contas: string[] = [];
    for (const m of marcas) for (const c of await this.contasLidas(quem.tenantId, quem.userId, m.id)) contas.push(c.id);
    if (!contas.length) return { waiting: 0 };
    const r = await currentTx().execute<{ n: string | number }>(sql`
      select count(*) as n from liame.direct_conversation c
       where c.connected_account_id in ${contas} and c.last_direction = 'entrada' and c.last_inbound_at is not null
         and c.last_inbound_at > ${agora.toISOString()}::timestamptz - make_interval(hours => ${JANELA_DO_DIRECT_HORAS})
         and (c.concluded_at is null or c.concluded_at < c.last_inbound_at)`);
    return { waiting: Number(r.rows[0]?.n ?? 0) };
  }

  /**
   * A conta da marca no canal (a primeira conectada): o Instagram do Direct ou a Página do Messenger (A6, Z14), e o
   * estado da leitura dela.
   */
  private async contaDaMarca(brandId: string, canal: CanalDoDirect = 'instagram'): Promise<LinhaDaConta | null> {
    const r = await currentTx().execute<LinhaDaConta>(sql`
      select a.id, a.provider_attributes->>'usuario' as usuario, a.name as nome, s.last_success_at, s.last_error, s.cursor
        from liame.connected_account a
        left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = ${DATASET_DO_DIRECT}
       where a.brand_id = ${brandId} and a.provider = ${canal === 'messenger' ? PROVEDOR_PAGINA : PROVEDOR_INSTAGRAM} and ${contaConectada('a')}
       order by a.id
       limit 1`);
    return r.rows[0] ?? null;
  }

  /** O ajuste do canal na marca: o do Direct (`direct_setting`) ou o do Messenger (`messenger_setting`). */
  private async ajusteDaMarca(brandId: string, canal: CanalDoDirect = 'instagram'): Promise<AjusteDoCanal> {
    const r =
      canal === 'messenger'
        ? await currentTx().execute<AjusteDoCanal>(sql`select enabled, sem_outro_programa, updated_at, updated_by from liame.messenger_setting where brand_id = ${brandId}`)
        : await currentTx().execute<AjusteDoCanal>(sql`select enabled, sem_outro_programa, updated_at, updated_by from liame.direct_setting where brand_id = ${brandId}`);
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
      messenger: await this.ajusteDoMessenger(quem.tenantId, quem.userId, brandId),
    };
  }

  /** O Messenger da Página na marca (A6, Z14; D-A6-121): liberado, ligado, a Página, a conferência com o Regem e a leitura. */
  private async ajusteDoMessenger(tenantId: string, userId: string, brandId: string): Promise<DirectMessengerSettings> {
    const available = await this.disponivel(tenantId, userId, brandId, 'messenger');
    const ajuste = await this.ajusteDaMarca(brandId, 'messenger');
    const pagina = await this.contaDaMarca(brandId, 'messenger');
    const quemMudou = ajuste.updated_by ? (await currentTx().execute<{ id: string; name: string }>(sql`select id, name from liame.app_user where id = ${ajuste.updated_by}`)).rows[0] : undefined;
    const cursor = pagina?.cursor ?? {};
    return {
      available,
      enabled: ajuste.enabled,
      no_other_app: ajuste.sem_outro_programa,
      page: pagina ? { id: pagina.id, name: (pagina.nome ?? 'Página').slice(0, 200) } : null,
      regem: cursor.regem ?? 'pendente',
      regem_checked_at: cursor.regem_em ?? null,
      reading: leitura(available && ajuste.enabled, pagina),
      read_at: pagina?.last_success_at ? iso(pagina.last_success_at) : null,
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
    return this.mudarCanal(auth, body, 'instagram');
  }

  /**
   * Liga ou desliga o Messenger da Página na marca (A6, Z14; D-A6-121), separado do Direct: as mesmas regras (o Dono ou um
   * Administrador, a função `messenger`, a Página conectada, a confirmação de que nenhum outro programa responde aquele
   * Messenger e o código do app para ligar; desligar, quem aprova, sem código).
   */
  async mudarMessenger(auth: AuthContext, body: DirectSettingsRequest): Promise<DirectSettingsResponse> {
    return this.mudarCanal(auth, body, 'messenger');
  }

  private async mudarCanal(auth: AuthContext, body: DirectSettingsRequest, canal: CanalDoDirect): Promise<DirectSettingsResponse> {
    const quem = quemPede(auth);
    const brandId = body.brand_id;
    await marcaDaEmpresa(brandId);
    const tx = currentTx();
    const doMessenger = canal === 'messenger';
    const antes = await this.ajusteDaMarca(brandId, canal);
    const liga = body.enabled && !antes.enabled;
    if (body.enabled && !body.no_other_app) {
      throw new AppProblem(
        422,
        'confirme-outro-programa',
        doMessenger ? 'Confirme o Messenger' : 'Confirme o Direct',
        doMessenger
          ? 'Para ligar, confirme que nenhum outro programa responde o Messenger desta Página (um robô ou outro atendimento).'
          : 'Para ligar, confirme que nenhum outro programa responde o Direct desta conta (um robô ou outro atendimento).',
      );
    }
    const conta = liga ? await this.contaDaMarca(brandId, canal) : null;
    if (liga) {
      if (!auth.permissions.has(PERMISSAO_DE_LIGAR)) {
        throw new AppProblem(403, 'so-dono-ou-administrador', 'Só o Dono ou um Administrador', `Só o Dono ou um Administrador liga ${doMessenger ? 'o Messenger' : 'o Direct'}. Você pode desligar.`);
      }
      if (!(await this.disponivel(quem.tenantId, quem.userId, brandId, canal))) {
        throw new AppProblem(409, 'funcao-desligada', 'Ainda não está liberado', `${doMessenger ? 'O Messenger' : 'O Direct'} ainda não está liberado para esta empresa.`);
      }
      if (!conta) {
        throw doMessenger
          ? new AppProblem(409, 'sem-pagina', 'Conecte a Página', 'A marca ainda não tem uma Página do Facebook conectada. Conecte em Contas conectadas e volte aqui.')
          : new AppProblem(409, 'sem-instagram', 'Conecte o Instagram', 'A marca ainda não tem um Instagram conectado. Conecte em Contas conectadas e volte aqui.');
      }
      await this.confirmacao.confirmar(tx, quem.userId, body);
    }
    const sem = body.enabled ? true : body.no_other_app;
    if (doMessenger) {
      await tx.execute(sql`
        insert into liame.messenger_setting (brand_id, tenant_id, enabled, sem_outro_programa, updated_by, created_at, updated_at)
        values (${brandId}, ${quem.tenantId}, ${body.enabled}, ${sem}, ${quem.userId}, now(), now())
        on conflict (brand_id) do update
          set enabled = excluded.enabled, sem_outro_programa = excluded.sem_outro_programa, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
    } else {
      await tx.execute(sql`
        insert into liame.direct_setting (brand_id, tenant_id, enabled, sem_outro_programa, updated_by, created_at, updated_at)
        values (${brandId}, ${quem.tenantId}, ${body.enabled}, ${sem}, ${quem.userId}, now(), now())
        on conflict (brand_id) do update
          set enabled = excluded.enabled, sem_outro_programa = excluded.sem_outro_programa, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
    }
    // Ligar traz a vez da conta para agora: desligada, ela esperava um dia (V106, ERR-143).
    if (liga && conta) {
      await tx.execute(sql`
        update liame.sync_state set cursor = coalesce(cursor, '{}'::jsonb) || jsonb_build_object('proxima', now()), updated_at = now()
         where connected_account_id = ${conta.id} and dataset = ${DATASET_DO_DIRECT}`);
    }
    auditDetail({
      resourceId: brandId,
      before: { enabled: antes.enabled, no_other_app: antes.sem_outro_programa },
      after: { enabled: body.enabled, no_other_app: sem, confirmed: liga, channel: canal },
    });
    return this.verAjuste(auth, { brand_id: brandId });
  }

  /** O atendimento automático do Direct da marca (A6, Z12, parte 5a; D-A6-115): liberado, ligado, os tipos e a hora. */
  async verAutomatico(auth: AuthContext, query: DirectSettingsQuery, agora = new Date()): Promise<DirectAutoReplyResponse> {
    const quem = quemPede(auth);
    const brandId = query.brand_id;
    await marcaDaEmpresa(brandId);
    const tx = currentTx();
    const available = await this.flags.isEnabled(FLAG_DO_DIRECT_AUTOMATICO, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId }));
    const m = await automaticoDoDirect(tx, brandId);
    const quemMudou = m.updatedBy ? (await tx.execute<{ id: string; name: string }>(sql`select id, name from liame.app_user where id = ${m.updatedBy}`)).rows[0] : undefined;
    return {
      brand_id: brandId,
      available,
      enabled: m.enabled,
      kinds: m.kinds,
      can_enable: auth.permissions.has(PERMISSAO_DE_LIGAR),
      can_disable: auth.permissions.has(PERMISSAO_DE_DESLIGAR),
      updated_at: m.updatedAt ? m.updatedAt.toISOString() : null,
      updated_by: quemMudou ? { id: quemMudou.id, name: quemMudou.name } : null,
      last_hour: await respostasAutomaticasDoDirectNaHora(tx, brandId, agora),
      hourly_limit: RESPOSTAS_AUTOMATICAS_DO_DIRECT_POR_HORA,
    };
  }

  /**
   * Liga, desliga ou muda os tipos do atendimento automático do Direct (D-A6-115). Ligar e somar um tipo: o Dono ou um
   * Administrador, com a função liberada, o Direct ligado na marca e a confirmação (o código do app ou a chave de acesso).
   * Desligar e tirar um tipo: quem aprova, na hora e sem código; desligar segura também o que já estava na fila (o
   * executor confere o portão de novo). Ligado pede pelo menos um tipo. A mudança vai para a auditoria.
   */
  async mudarAutomatico(auth: AuthContext, body: DirectAutoReplyRequest): Promise<DirectAutoReplyResponse> {
    const quem = quemPede(auth);
    const brandId = body.brand_id;
    await marcaDaEmpresa(brandId);
    const tx = currentTx();
    const antes = await automaticoDoDirect(tx, brandId);
    const kinds = TIPOS_DO_DIRECT_AUTOMATICO.filter((t) => body.kinds.includes(t));
    if (body.enabled && kinds.length === 0) throw new AppProblem(422, 'sem-tipo', 'Marque um tipo', 'Para ligar o atendimento automático, marque pelo menos um tipo de conversa.');
    const liga = body.enabled && !antes.enabled;
    const soma = body.enabled && kinds.some((k) => !antes.kinds.includes(k));
    const comCodigo = liga || soma;
    if (comCodigo) {
      if (!auth.permissions.has(PERMISSAO_DE_LIGAR)) {
        throw new AppProblem(403, 'so-dono-ou-administrador', 'Só o Dono ou um Administrador', 'Só o Dono ou um Administrador liga o atendimento automático ou soma um tipo. Você pode desligar ou tirar um tipo.');
      }
      if (!(await this.flags.isEnabled(FLAG_DO_DIRECT_AUTOMATICO, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId })))) {
        throw new AppProblem(409, 'funcao-desligada', 'Ainda não está liberado', 'O atendimento automático do Direct ainda não está liberado para esta empresa.');
      }
      if (!(await this.ajusteDaMarca(brandId)).enabled) {
        throw new AppProblem(409, 'direct-desligado', 'Ligue o Direct antes', 'O Direct está desligado nesta marca: ligue o Direct antes do atendimento automático.');
      }
      await this.confirmacao.confirmar(tx, quem.userId, body);
    }
    await tx.execute(sql`
      insert into liame.direct_auto_reply (brand_id, tenant_id, enabled, kinds, updated_by, created_at, updated_at)
      values (${brandId}, ${quem.tenantId}, ${body.enabled}, ${`{${kinds.join(',')}}`}::text[], ${quem.userId}, now(), now())
      on conflict (brand_id) do update
        set enabled = excluded.enabled, kinds = excluded.kinds, updated_by = excluded.updated_by, updated_at = excluded.updated_at`);
    auditDetail({
      resourceId: brandId,
      before: { enabled: antes.enabled, kinds: antes.kinds },
      after: { enabled: body.enabled, kinds, confirmed: comCodigo },
    });
    return this.verAutomatico(auth, { brand_id: brandId });
  }

  /**
   * "Veja como ele teria respondido" (P39 versão 2): até 3 conversas da marca, das últimas 24 horas, que esperam resposta
   * e que ele sabe responder (a resposta pronta), as mais novas primeiro, cada uma com a resposta que sairia (com o
   * aviso). Nada disto é enviado. Com o Direct desligado ou o Regem atendendo a conta, vazia.
   */
  async previaDoAutomatico(auth: AuthContext, query: DirectSettingsQuery, agora = new Date()): Promise<DirectAutoReplyPreviewResponse> {
    const quem = quemPede(auth);
    const brandId = query.brand_id;
    await marcaDaEmpresa(brandId);
    const conta = await this.contaDaMarca(brandId);
    if (!conta || !(await this.lendo(quem.tenantId, quem.userId, brandId, conta))) return { items: [] };
    const linhas = (
      await currentTx().execute<LinhaDaConversa>(sql`
        select c.connected_account_id, c.conversation_id, c.username, c.channel, c.display_name, c.last_message_at, c.last_inbound_at,
               c.last_direction, c.concluded_at, c.unread, m.direction as m_direction, m.kind as m_kind, m.body as m_body, p.p_pendentes
          from liame.direct_conversation c
          left join lateral (
            select x.direction, x.kind, x.body from liame.direct_message x
             where x.connected_account_id = c.connected_account_id and x.conversation_id = c.conversation_id
             order by x.sent_at desc, x.message_id desc limit 1) m on true
          ${PENDENTES}
         where c.connected_account_id = ${conta.id} and c.last_direction = 'entrada'
           and c.last_inbound_at > ${agora.toISOString()}::timestamptz - make_interval(hours => ${JANELA_DO_DIRECT_HORAS})
         order by c.last_inbound_at desc
         limit ${PREVIA_OLHADAS}`)
    ).rows;
    const items: DirectAutoReplyPreviewResponse['items'] = [];
    for (const l of linhas) {
      const c = conversaDaLinha(l, agora, conta.usuario);
      const ultima = l.p_pendentes?.at(-1);
      if (c.status !== 'espera' || !ultima || !c.kind || !tipoDoAutomatico(c.kind as TipoNoDirect)) continue;
      if (pedeUmaPessoa((l.p_pendentes ?? []).map((p) => p.body).join(' '))) continue;
      const s = sugestaoNoDirect(c.kind as TipoNoDirect, ultima.id);
      if (s?.kind !== 'pronta') continue;
      items.push({ conversation_id: c.id, username: c.username, message: previaDaMensagem(c), kind: c.kind, reply: comAvisoDoDirect(s.text) });
      if (items.length >= DIRECT_AUTO_REPLY_PREVIEW_LIMIT) break;
    }
    return { items };
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
    // As contas lidas agora (o Direct e o Messenger, A6, Z14), só as do canal pedido; as contagens seguem o canal.
    const lidas = (await this.contasLidas(quem.tenantId, quem.userId, brandId)).filter((c) => !query.channel || c.canal === query.channel);
    if (!lidas.length) return base;
    const usuarioDoInstagram = lidas.find((c) => c.canal === 'instagram')?.usuario ?? null;

    const busca = query.q ? `%${query.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const linhas = (
      await currentTx().execute<LinhaDaConversa>(sql`
        select c.connected_account_id, c.conversation_id, c.username, c.channel, c.display_name, c.last_message_at, c.last_inbound_at,
               c.last_direction, c.concluded_at, c.unread, m.direction as m_direction, m.kind as m_kind, m.body as m_body, p.p_pendentes
          from liame.direct_conversation c
          left join lateral (
            select x.direction, x.kind, x.body from liame.direct_message x
             where x.connected_account_id = c.connected_account_id and x.conversation_id = c.conversation_id
             order by x.sent_at desc, x.message_id desc limit 1) m on true
          ${PENDENTES}
         where c.connected_account_id in ${lidas.map((c) => c.id)}
           ${busca ? sql`and (c.username ilike ${busca} or c.display_name ilike ${busca} or exists (select 1 from liame.direct_message y where y.connected_account_id = c.connected_account_id and y.conversation_id = c.conversation_id and y.body ilike ${busca}))` : sql``}
         order by c.last_message_at desc, c.conversation_id
         limit ${CONVERSAS_OLHADAS}`)
    ).rows;
    const todas = linhas.map((l) => conversaDaLinha(l, agora, l.channel === 'messenger' ? null : usuarioDoInstagram));
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
    const lidas = await this.contasLidas(quem.tenantId, quem.userId, brandId);
    const naoAchou = new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Conversa não encontrada nesta marca.');
    if (!lidas.length) throw naoAchou;
    const tx = currentTx();
    const linha = (
      await tx.execute<LinhaDaConversa>(sql`
        select c.connected_account_id, c.conversation_id, c.username, c.channel, c.display_name, c.last_message_at, c.last_inbound_at,
               c.last_direction, c.concluded_at, c.unread, m.direction as m_direction, m.kind as m_kind, m.body as m_body, p.p_pendentes
          from liame.direct_conversation c
          left join lateral (
            select x.direction, x.kind, x.body from liame.direct_message x
             where x.connected_account_id = c.connected_account_id and x.conversation_id = c.conversation_id
             order by x.sent_at desc, x.message_id desc limit 1) m on true
          ${PENDENTES}
         where c.connected_account_id in ${lidas.map((c) => c.id)} and c.conversation_id = ${conversationId}`)
    ).rows[0];
    if (!linha) throw naoAchou;
    const conta = lidas.find((c) => c.id === linha.connected_account_id)!;
    const usuarioDaMarca = conta.canal === 'messenger' ? null : conta.usuario;
    const mensagens = (
      await tx.execute<{ message_id: string; direction: string; kind: string; body: string; sent_at: Date | string }>(sql`
        select * from (
          select message_id, direction, kind, body, sent_at from liame.direct_message
           where connected_account_id = ${conta.id} and conversation_id = ${conversationId}
           order by sent_at desc, message_id desc
           limit ${DIRECT_MESSAGES_LIMIT}) z
         order by sent_at, message_id`)
    ).rows;
    const conversation = conversaDaLinha(linha, agora, usuarioDaMarca);
    // A sugestão sem IA só para o que espera resposta (P39), variando pela última mensagem da pessoa.
    const ultima = linha.p_pendentes?.at(-1);
    const suggestion = conversation.status === 'espera' && ultima ? sugestaoNoDirect(tipoNoDirect(linha.p_pendentes ?? [], usuarioDaMarca), ultima.id) : null;
    return {
      brand_id: brandId,
      conversation,
      messages: mensagens.map((m) => ({ id: m.message_id, direction: m.direction, kind: m.kind, text: m.body, sent_at: iso(m.sent_at) })),
      suggestion,
    };
  }

  /**
   * O Liame mostra o canal desta conta: a função do canal liberada, o canal ligado na marca e o Regem sem atender a conta
   * (no Messenger, a Página).
   */
  private async lendo(tenantId: string, userId: string, brandId: string, conta: LinhaDaConta, canal: CanalDoDirect = 'instagram'): Promise<boolean> {
    if (conta.cursor?.regem === 'atende') return false;
    const ajuste = await this.ajusteDaMarca(brandId, canal);
    return ajuste.enabled && (await this.disponivel(tenantId, userId, brandId, canal));
  }
}

/** A leitura do Direct, para a tela: desligada, nunca lida, lida, sem a permissão ou falhou. */
function leitura(ligado: boolean, conta: LinhaDaConta | null): string {
  if (!ligado || !conta) return 'desligada';
  if (conta.last_error && conta.cursor?.falha === 'permissao') return 'sem_permissao';
  if (conta.last_success_at) return 'ok';
  return conta.last_error ? 'falhou' : 'nunca';
}

function conversaDaLinha(l: LinhaDaConversa, agora: Date, usuarioDaMarca: string | null): DirectConversation {
  const s = situacaoDaConversa({ last_direction: l.last_direction, last_inbound_at: l.last_inbound_at, concluded_at: l.concluded_at }, agora);
  return {
    id: l.conversation_id,
    username: l.username,
    channel: l.channel,
    name: l.display_name,
    status: s.situacao,
    closing: s.fechando,
    window_until: s.janelaAte,
    unread: l.unread,
    kind: tipoNoDirect(l.p_pendentes ?? [], usuarioDaMarca),
    last_message_at: iso(l.last_message_at),
    last_message: l.m_direction ? { direction: l.m_direction, kind: l.m_kind ?? 'texto', text: l.m_body ?? '' } : null,
  };
}
