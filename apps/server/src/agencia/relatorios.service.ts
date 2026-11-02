import type {
  AgencyReportDetailResponse,
  AgencyReportItem,
  AgencyReportRecipient,
  AgencyReportSend,
  AgencyReportSendSummary,
  AgencyReportSentResponse,
  AgencyReportsResponse,
  SendAgencyReportRequest,
} from '@liame/contracts';
import { type Database, type Tx, uuidv7, withContext } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { pessoaPode } from '../auth/pessoa-pode.js';
import { FLAG_COBRANCA } from '../cobranca/assinatura.js';
import { passosDoAtraso } from '../cobranca/vida.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { AuthContext } from '../context/request-context.js';
import { actorLabel, actorTypeOf } from '../context/unit-of-work.interceptor.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { Mailer, maskEmail } from '../mail/mailer.js';
import { fimDaEspera } from '../results/espera-da-agencia.js';
import { diaNoFuso } from '../results/fora-do-normal.js';
import { emailDoRelatorio } from '../results/relatorio-email.js';
import { type ConteudoDoRelatorio, paraQuemVe, pessoasDaVerba, VERSOES_DO_RELATORIO } from '../results/relatorio-mensal.js';
import { enderecoPublicoDoLogo } from './logo-publico.controller.js';

// O relatório do mês que a agência manda ao cliente (A7, W7, parte 4a; P29; D-A7-65 a D-A7-68; D-A7-82). A agência lê
// e manda dentro de cada cliente, no contexto dele e com a pessoa da agência que está no time (a RLS e o nível dela ali
// decidem, como na lista de clientes, D-A7-80): quem manda é quem vê os resultados (`vendas.ver`) no cliente; quem
// recebe é gente da empresa que já pode receber o relatório (o Dono sempre); com a marca do relatório suspensa, ele
// fica só com o Dono. O envio grava a versão e cada entrega; o e-mail sai com o nome e o logo da agência e o "Responder"
// para ela. O envio sozinho no dia 2 e o lembrete do dia 3 vêm na parte 4b.

/** Quem da empresa pode receber o relatório (D-A7-66), na ordem da lista. */
const NIVEIS_QUE_RECEBEM = ['dono', 'administrador', 'so_relatorios'] as const;
type NivelQueRecebe = (typeof NIVEIS_QUE_RECEBEM)[number];
/** Dois envios do mesmo relatório pela mesma agência em menos de um minuto são o mesmo clique. */
const INTERVALO_ENTRE_ENVIOS_SEG = 60;
const FUSO_PADRAO = 'America/Sao_Paulo';

type Vinculo = { id: string; client_id: string; client_name: string };
type Relatorio = { id: string; brand_id: string; generated_at: Date | string; timezone: string; month_to: string; espera_ate: Date | string };
type Envio = {
  id: string;
  report_id: string;
  version: number;
  mode: 'manual' | 'sozinho';
  comment: string | null;
  sent_by_name: string | null;
  recipients: number;
  created_at: Date | string;
};
type Pessoa = { id: string; name: string; email: string; role_key: NivelQueRecebe };

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

const semAcesso = () =>
  new AppProblem(403, 'sem-acesso-ao-relatorio', 'Sem acesso ao relatório', 'Para ver e mandar o relatório, você precisa estar no time deste cliente com um nível que vê os resultados.');
const naoEncontrado = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Relatório não encontrado neste cliente.');

/** O mês fechado anterior a hoje (no fuso padrão da loja), em `AAAA-MM`. */
export function ultimoMesFechado(agora: Date): string {
  const hoje = diaNoFuso(agora, FUSO_PADRAO);
  const [a, m] = hoje.split('-').map(Number) as [number, number];
  const ano = m === 1 ? a - 1 : a;
  const mes = m === 1 ? 12 : m - 1;
  return `${ano}-${String(mes).padStart(2, '0')}`;
}

@Injectable()
export class AgencyReportsService {
  private readonly logger = new Logger('relatorio-da-agencia');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private banco(): Database {
    if (!this.database) throw new Error('relatório da agência: sem banco');
    return this.database;
  }

  // ------------------------------------------------------------------ a lista do mês

  /** O relatório do mês de cada marca de cada cliente, com a situação (só os clientes em que a pessoa está, para o membro). */
  async lista(auth: AuthContext, mes: string | undefined, agora = new Date()): Promise<AgencyReportsResponse> {
    const db = this.banco().db;
    const { agencyId, vinculos, meus } = await this.vinculosDaPessoa(auth);
    const mesFrom = `${mes ?? ultimoMesFechado(agora)}-01`;
    const items: AgencyReportItem[] = [];
    for (const v of vinculos) {
      if (!meus.has(v.id)) {
        items.push(itemVazio(v, 'fora_do_time'));
        continue;
      }
      items.push(
        ...(await withContext(db, { tenantId: v.client_id, userId: auth.userId }, async (tx) => {
          const podeVer = await pessoaPode(tx, { tenantId: v.client_id, userId: auth.userId, permissao: 'vendas.ver' });
          if (!podeVer) return [itemVazio(v, 'sem_acesso')];
          const marcas = await tx.execute<{ id: string; name: string }>(sql`
            select id, name from liame.brand where tenant_id = ${v.client_id} and archived_at is null order by name, id`);
          const relatorios = await tx.execute<Relatorio>(sql`
            select m.id, m.brand_id, m.generated_at, m.timezone, m.month_to::text as month_to,
                   ${fimDaEspera(sql`m.month_to`, sql`m.timezone`)} as espera_ate
              from liame.monthly_report m
             where m.tenant_id = ${v.client_id} and m.month_from = ${mesFrom}::date`);
          const porMarca = new Map(relatorios.rows.map((r) => [r.brand_id, r]));
          const envios = await ultimosEnvios(
            tx,
            agencyId,
            relatorios.rows.map((r) => r.id),
          );
          const suspensas = await this.marcasSuspensas(tx, v.client_id, auth.userId);
          const dono = suspensas.size ? await nomeDoDono(tx, v.client_id) : null;
          return marcas.rows.map((b): AgencyReportItem => {
            const r = porMarca.get(b.id) ?? null;
            const ultimo = r ? (envios.get(r.id) ?? null) : null;
            const suspensa = suspensas.get(b.id) ?? null;
            const state = suspensa ? 'suspensa' : !r ? 'sem_relatorio' : ultimo ? 'mandado' : 'esperando';
            const espera = r && state === 'esperando' && new Date(r.espera_ate).getTime() > agora.getTime() ? iso(r.espera_ate) : null;
            return {
              link_id: v.id,
              organization: { id: v.client_id, name: v.client_name },
              brand: { id: b.id, name: b.name },
              report_id: r?.id ?? null,
              generated_at: r ? iso(r.generated_at) : null,
              state,
              suspended_since: suspensa,
              owner_name: suspensa ? dono : null,
              last_send: ultimo ? resumoDoEnvio(ultimo) : null,
              liame_email_waits_until: espera,
            };
          });
        })),
      );
    }
    return { month: mesFrom.slice(0, 7), items };
  }

  // ------------------------------------------------------------------ um relatório para revisar

  async detalhe(auth: AuthContext, linkId: string, reportId: string, agora = new Date()): Promise<AgencyReportDetailResponse> {
    const db = this.banco().db;
    const { agencyId, vinculo, agencia } = await this.vinculoEAgencia(auth, linkId);
    const lido = await withContext(db, { tenantId: vinculo.client_id, userId: auth.userId }, (tx) => this.lerNoCliente(tx, auth, vinculo, agencyId, reportId, agora));
    return {
      item: lido.item,
      report: lido.report,
      agency: { name: agencia.name, logo_url: agencia.logo ? enderecoPublicoDoLogo(this.config.apiUrl, agencyId) : null, reply_to: agencia.reply_to },
      recipients: lido.recipients,
      sends: lido.sends,
      can_send: lido.item.state !== 'suspensa',
    };
  }

  // ------------------------------------------------------------------ mandar

  /**
   * Manda o relatório: confere o time, o nível e a conta; grava o envio (a versão seguinte desta agência) e uma entrega
   * por pessoa, com a auditoria; manda os e-mails sem transação aberta e grava o resultado de cada um.
   */
  async mandar(auth: AuthContext, linkId: string, reportId: string, body: SendAgencyReportRequest, agora = new Date()): Promise<AgencyReportSentResponse> {
    const db = this.banco().db;
    const { agencyId, vinculo, agencia } = await this.vinculoEAgencia(auth, linkId);
    const lido = await withContext(db, { tenantId: vinculo.client_id, userId: auth.userId }, async (tx) => {
      const l = await this.lerNoCliente(tx, auth, vinculo, agencyId, reportId, agora);
      const conteudo = await tx.execute<{ content: ConteudoDoRelatorio; marca: string }>(sql`
        select m.content, b.name as marca from liame.monthly_report m join liame.brand b on b.id = m.brand_id where m.id = ${reportId}`);
      return { ...l, conteudo: conteudo.rows[0]!.content, marca: conteudo.rows[0]!.marca };
    });
    if (lido.item.state === 'suspensa') {
      throw new AppProblem(409, 'conta-suspensa', 'Conta suspensa', 'Com a conta do cliente suspensa, o relatório fica só com o Dono até ela voltar.');
    }
    const escolhidos = new Set(body.recipient_ids);
    const possiveis = new Map(lido.pessoas.map((p) => [p.id, p]));
    for (const id of escolhidos) {
      if (!possiveis.has(id)) throw new AppProblem(422, 'destinatario-fora', 'Pessoa fora da lista', 'Só recebe quem da empresa já pode receber o relatório.');
    }
    const para = lido.pessoas.filter((p) => p.role_key === 'dono' || escolhidos.has(p.id));
    if (!para.length) throw new AppProblem(409, 'sem-destinatario', 'Ninguém para receber', 'A empresa não tem ninguém com o e-mail confirmado que possa receber o relatório.');
    const comentario = body.comment ?? null;

    // O envio e as entregas, na agência (a RLS deixa a agência gravar os dela), com a auditoria na mesma transação.
    const envio = await withContext(db, { tenantId: agencyId, userId: auth.userId }, async (tx) => {
      const recente = await tx.execute(sql`
        select 1 from liame.agency_report_send
         where report_id = ${reportId} and agency_id = ${agencyId}
           and created_at > now() - make_interval(secs => ${INTERVALO_ENTRE_ENVIOS_SEG})`);
      if (recente.rows.length) throw new AppProblem(409, 'acabou-de-mandar', 'Já foi mandado', 'Este relatório acabou de ser mandado. Espere um minuto para mandar de novo.');
      const v = await tx.execute<{ versao: number }>(sql`
        select coalesce(max(version), 0)::int + 1 as versao from liame.agency_report_send where report_id = ${reportId} and agency_id = ${agencyId}`);
      const versao = v.rows[0]!.versao;
      const id = uuidv7();
      await tx.execute(sql`
        insert into liame.agency_report_send
          (id, tenant_id, agency_id, partner_link_id, report_id, version, mode, comment, sent_by, sent_by_name, recipients, with_logo)
        values (${id}, ${vinculo.client_id}, ${agencyId}, ${linkId}, ${reportId}, ${versao}, 'manual', ${comentario}, ${auth.userId},
                ${auth.name}, ${para.length}, ${agencia.logo})`);
      await tx.execute(sql`
        insert into liame.agency_report_delivery (id, tenant_id, send_id, user_id, role_key)
        values ${sql.join(
          para.map((p) => sql`(${uuidv7()}, ${vinculo.client_id}, ${id}, ${p.id}, ${p.role_key})`),
          sql`, `,
        )}`);
      await writeAudit(tx, {
        tenantId: agencyId,
        actorType: actorTypeOf(auth),
        actorId: auth.userId,
        actorLabel: actorLabel(auth),
        actorRole: auth.roleKey,
        action: 'agencia.relatorio_mandar',
        resourceType: 'agency_report_send',
        resourceId: id,
        after: { client_id: vinculo.client_id, report_id: reportId, version: versao, recipients: para.length, comment: comentario !== null },
        traceId: activeTraceId(),
        origin: 'api',
      });
      return { id, versao };
    });

    // Os e-mails, sem transação aberta; cada resultado fica gravado na entrega (o tipo do erro, nunca o endereço).
    const link = `${this.config.appUrl}/resultados/relatorio?marca=${lido.report.brand_id}&mes=${lido.report.month.from.slice(0, 7)}`;
    const imagens = { logo: `${this.config.appUrl}/email/liame-logo.png`, lia: `${this.config.appUrl}/email/lia.png` };
    let falhas = 0;
    for (const p of para) {
      const email = emailDoRelatorio(
        lido.conteudo,
        { marca: lido.marca, empresa: vinculo.client_name, nivel: p.role_key, link, imagens },
        {
          nome: agencia.name,
          logoUrl: agencia.logo ? enderecoPublicoDoLogo(this.config.apiUrl, agencyId) : null,
          logoLargura: agencia.logo_width,
          logoAltura: agencia.logo_height,
          comentario,
          assinatura: auth.name,
          versao: envio.versao,
          responde: Boolean(agencia.reply_to),
          primeiroNome: p.name.split(/\s+/)[0] || p.name,
        },
      );
      let falha: string | null = null;
      try {
        await this.mailer.send({
          to: p.email,
          subject: email.subject,
          text: email.text,
          html: email.html,
          fromName: `${agencia.name} pelo Liame`,
          ...(agencia.reply_to ? { replyTo: agencia.reply_to } : {}),
        });
      } catch (err) {
        falhas += 1;
        falha = (err instanceof Error ? err.name : 'Erro').slice(0, 100) || 'Erro';
        this.logger.warn(`relatório da agência ${envio.id}: envio para ${maskEmail(p.email)} falhou (${err instanceof Error ? err.message : String(err)})`);
      }
      await withContext(db, { tenantId: vinculo.client_id, userId: auth.userId }, (tx) =>
        tx.execute(sql`
          update liame.agency_report_delivery
             set status = ${falha ? 'falhou' : 'enviado'}, attempts = attempts + 1, error = ${falha},
                 sent_at = ${falha ? null : agora.toISOString()}::timestamptz
           where send_id = ${envio.id} and user_id = ${p.id}`),
      ).catch((err: unknown) => this.logger.error(`relatório da agência ${envio.id}: não gravou a entrega (${err instanceof Error ? err.message : String(err)})`));
    }
    return { version: envio.versao, sent_at: agora.toISOString(), recipients: para.length - falhas, failed: falhas };
  }

  // ------------------------------------------------------------------ dentro do cliente

  /** O relatório no cliente: o time, o nível, o relatório, a situação, quem pode receber e os envios desta agência. */
  private async lerNoCliente(tx: Tx, auth: AuthContext, v: Vinculo, agencyId: string, reportId: string, agora: Date) {
    const noTime = await tx.execute(sql`
      select 1 from liame.membership
       where tenant_id = ${v.client_id} and user_id = ${auth.userId} and partner_link_id = ${v.id}
         and revoked_at is null and (expires_at is null or expires_at > now())`);
    if (!noTime.rows.length || !(await pessoaPode(tx, { tenantId: v.client_id, userId: auth.userId, permissao: 'vendas.ver' }))) throw semAcesso();
    const r = await tx.execute<Relatorio & { content: ConteudoDoRelatorio; content_version: number; email_status: string; email_sent_at: Date | string | null; email_recipients: number; marca: string }>(sql`
      select m.id, m.brand_id, m.generated_at, m.timezone, m.month_to::text as month_to, m.content, m.content_version,
             m.email_status, m.email_sent_at, m.email_recipients, b.name as marca,
             ${fimDaEspera(sql`m.month_to`, sql`m.timezone`)} as espera_ate
        from liame.monthly_report m join liame.brand b on b.id = m.brand_id and b.archived_at is null
       where m.id = ${reportId} and m.tenant_id = ${v.client_id}`);
    const linha = r.rows[0];
    if (!linha) throw naoEncontrado();
    if (!VERSOES_DO_RELATORIO.has(linha.content_version)) throw new Error(`relatório do mês ${linha.id}: conteúdo na versão ${linha.content_version}, que o código não lê`);
    const permissoes = new Set<string>(['vendas.ver']);
    if (await pessoaPode(tx, { tenantId: v.client_id, userId: auth.userId, permissao: 'campanhas.ver' })) permissoes.add('campanhas.ver');
    const ids = pessoasDaVerba(linha.content);
    const nomes = ids.length
      ? new Map((await tx.execute<{ id: string; name: string }>(sql`select id, name from liame.app_user where id in ${ids}`)).rows.map((p) => [p.id, p.name]))
      : new Map<string, string>();
    const suspensas = await this.marcasSuspensas(tx, v.client_id, auth.userId);
    const suspensa = suspensas.get(linha.brand_id) ?? null;
    const todos = await tx.execute<Envio>(sql`
      select id, report_id, version, mode, comment, sent_by_name, recipients, created_at
        from liame.agency_report_send where report_id = ${reportId} and agency_id = ${agencyId} order by version desc`);
    const ultimo = todos.rows[0] ?? null;
    const state = suspensa ? 'suspensa' : ultimo ? 'mandado' : 'esperando';
    const pessoas = await tx.execute<Pessoa>(sql`
      select u.id, u.name, u.email, m.role_key
        from liame.membership m join liame.app_user u on u.id = m.user_id
       where m.tenant_id = ${v.client_id} and m.revoked_at is null and (m.expires_at is null or m.expires_at > now())
         and m.partner_link_id is null
         and m.role_key in (${sql.join(NIVEIS_QUE_RECEBEM.map((n) => sql`${n}`), sql`, `)})
         and u.disabled_at is null and u.email_verified_at is not null
       order by (m.role_key = 'dono') desc, u.name, u.id`);
    const para = todos.rows.length
      ? await tx.execute<{ send_id: string; name: string; role_key: string }>(sql`
          select d.send_id, u.name, d.role_key
            from liame.agency_report_delivery d join liame.app_user u on u.id = d.user_id
           where d.send_id in ${todos.rows.map((e) => e.id)} and d.status = 'enviado'
           order by (d.role_key = 'dono') desc, u.name`)
      : { rows: [] };
    const sends: AgencyReportSend[] = todos.rows.map((e) => ({
      ...resumoDoEnvio(e),
      comment: e.comment,
      sent_to: para.rows.filter((p) => p.send_id === e.id).map((p) => ({ name: p.name, role: p.role_key })),
    }));
    const item: AgencyReportItem = {
      link_id: v.id,
      organization: { id: v.client_id, name: v.client_name },
      brand: { id: linha.brand_id, name: linha.marca },
      report_id: linha.id,
      generated_at: iso(linha.generated_at),
      state,
      suspended_since: suspensa,
      owner_name: suspensa ? await nomeDoDono(tx, v.client_id) : null,
      last_send: ultimo ? resumoDoEnvio(ultimo) : null,
      liame_email_waits_until: state === 'esperando' && new Date(linha.espera_ate).getTime() > agora.getTime() ? iso(linha.espera_ate) : null,
    };
    const recipients: AgencyReportRecipient[] = pessoas.rows.map((p) => ({ user_id: p.id, name: p.name, email: p.email, role: p.role_key, always: p.role_key === 'dono' }));
    return {
      item,
      report: {
        ...paraQuemVe(linha.content, permissoes, nomes),
        id: linha.id,
        email: { status: linha.email_status, sent_at: linha.email_sent_at ? iso(linha.email_sent_at) : null, recipients: linha.email_recipients },
      },
      recipients,
      pessoas: pessoas.rows,
      sends,
    };
  }

  /** As marcas suspensas do cliente (com a função da cobrança ligada), com o dia em que a suspensão começou. */
  private async marcasSuspensas(tx: Tx, tenantId: string, userId: string): Promise<Map<string, string>> {
    const r = await tx.execute<{ brand_id: string; venc: string | null }>(sql`
      select s.brand_id,
             (select min(i.due_date)::text from liame.billing_invoice i
               where i.subscription_id = s.id and i.kind = 'mensalidade' and i.status = 'aberta') as venc
        from liame.subscription s where s.tenant_id = ${tenantId} and s.status = 'suspensa'`);
    const mapa = new Map<string, string>();
    for (const s of r.rows) {
      if (!s.venc) continue;
      if (!(await this.flags.isEnabled(FLAG_COBRANCA, this.flags.context({ tenantId, userId, brandId: s.brand_id })))) continue;
      mapa.set(s.brand_id, passosDoAtraso(s.venc).suspendeEm);
    }
    return mapa;
  }

  // ------------------------------------------------------------------ na agência

  /** Os clientes vivos da agência e os vínculos em que a pessoa está no time (o membro só vê os dele). */
  private async vinculosDaPessoa(auth: AuthContext): Promise<{ agencyId: string; vinculos: Vinculo[]; meus: Set<string> }> {
    const agencyId = exigirAgencia(auth);
    return withContext(this.banco().db, { tenantId: agencyId, userId: auth.userId }, async (tx) => {
      await conferirAgencia(tx, agencyId);
      const cuida = auth.permissions.has('agencia.clientes');
      const meus = await tx.execute<{ partner_link_id: string }>(sql`
        select m.partner_link_id from liame.membership m join liame.partner_link l on l.id = m.partner_link_id
         where l.partner_org_id = ${agencyId} and l.status = 'ativo' and m.user_id = ${auth.userId}
           and m.revoked_at is null and (m.expires_at is null or m.expires_at > now())`);
      const deles = new Set(meus.rows.map((m) => m.partner_link_id));
      const r = await tx.execute<Vinculo>(sql`
        select l.id, l.client_org_id as client_id, o.name as client_name
          from liame.partner_link l join liame.organization o on o.id = l.client_org_id
         where l.partner_org_id = ${agencyId} and l.status = 'ativo'
         order by o.name, l.id`);
      return { agencyId, vinculos: r.rows.filter((v) => cuida || deles.has(v.id)), meus: deles };
    });
  }

  /** O vínculo vivo desta agência e a marca dela (o nome, se tem logo, o e-mail de resposta confirmado). */
  private async vinculoEAgencia(auth: AuthContext, linkId: string) {
    const agencyId = exigirAgencia(auth);
    return withContext(this.banco().db, { tenantId: agencyId, userId: auth.userId }, async (tx) => {
      await conferirAgencia(tx, agencyId);
      const r = await tx.execute<Vinculo>(sql`
        select l.id, l.client_org_id as client_id, o.name as client_name
          from liame.partner_link l join liame.organization o on o.id = l.client_org_id
         where l.id = ${linkId} and l.partner_org_id = ${agencyId} and l.status = 'ativo'`);
      const vinculo = r.rows[0];
      if (!vinculo) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Este cliente não está com a agência.');
      const a = await tx.execute<{ name: string; logo: boolean; logo_width: number | null; logo_height: number | null; reply_to: string | null }>(sql`
        select o.name, b.logo_id is not null as logo, b.logo_width, b.logo_height, b.reply_to_email as reply_to
          from liame.organization o left join liame.agency_brand b on b.tenant_id = o.id
         where o.id = ${agencyId}`);
      return { agencyId, vinculo, agencia: a.rows[0]! };
    });
  }
}

function exigirAgencia(auth: AuthContext): string {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma organização', 'Selecione a agência para continuar.');
  return auth.tenantId;
}

async function conferirAgencia(tx: Tx, agencyId: string): Promise<void> {
  const r = await tx.execute<{ kind: string }>(sql`select kind from liame.organization where id = ${agencyId}`);
  if (r.rows[0]?.kind !== 'agencia') {
    throw new AppProblem(403, 'nao-e-agencia', 'Não é uma agência', 'Esta tela é da agência: troque para ela no seletor do alto do menu.');
  }
}

function itemVazio(v: Vinculo, state: 'fora_do_time' | 'sem_acesso'): AgencyReportItem {
  return {
    link_id: v.id,
    organization: { id: v.client_id, name: v.client_name },
    brand: null,
    report_id: null,
    generated_at: null,
    state,
    suspended_since: null,
    owner_name: null,
    last_send: null,
    liame_email_waits_until: null,
  };
}

function resumoDoEnvio(e: Envio): AgencyReportSendSummary {
  return { version: e.version, mode: e.mode, sent_at: iso(e.created_at), sent_by_name: e.sent_by_name, has_comment: e.comment !== null, recipients: e.recipients };
}

/** O último envio desta agência de cada relatório. */
async function ultimosEnvios(tx: Tx, agencyId: string, reportIds: string[]): Promise<Map<string, Envio>> {
  if (!reportIds.length) return new Map();
  const r = await tx.execute<Envio>(sql`
    select distinct on (report_id) id, report_id, version, mode, comment, sent_by_name, recipients, created_at
      from liame.agency_report_send
     where agency_id = ${agencyId} and report_id in ${reportIds}
     order by report_id, version desc`);
  return new Map(r.rows.map((e) => [e.report_id, e]));
}

async function nomeDoDono(tx: Tx, tenantId: string): Promise<string | null> {
  const r = await tx.execute<{ name: string }>(sql`
    select u.name from liame.membership m join liame.app_user u on u.id = m.user_id
     where m.tenant_id = ${tenantId} and m.role_key = 'dono' and m.revoked_at is null
     limit 1`);
  return r.rows[0]?.name ?? null;
}
