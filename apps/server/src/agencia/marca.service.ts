import type { AgencyBrandResponse, AgencyReportMode, UpdateAgencyBrandRequest } from '@liame/contracts';
import { type Database, type Tx, uuidv7 } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { newToken } from '../auth/tokens.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { afterCommit, auditDetail, type AuthContext, currentTx } from '../context/request-context.js';
import { actorLabel, actorTypeOf } from '../context/unit-of-work.interceptor.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { SemSharp } from '../fotos/processar.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens, ArmazemIndisponivel } from '../imagens/armazem.js';
import { Mailer } from '../mail/mailer.js';
import { chaveDoLogo, processarLogo, RECUSAS_DO_LOGO, RecusaDoLogo } from './logo-da-agencia.js';
import { agenciaDe } from './vinculo.service.js';

// A marca da agência (A7, W7, parte 3; D-A7-69; D-A7-81): o nome (o da organização da agência), o logo, o e-mail de
// resposta (que só vale depois do link de confirmação) e como o relatório do mês sai. Quem é da agência lê; quem cuida
// dos clientes (a dona e o administrador) muda. O relatório e o e-mail que usam a marca vêm nas partes 4 e 5.

/** O link de confirmação do e-mail de resposta vale 24 horas. */
export const HORAS_DO_LINK_DE_RESPOSTA = 24;
/** O endereço de leitura do logo, na tela da agência, vale 5 minutos (o bucket recusa mais de 10; ADR-021). */
const SEGUNDOS_DO_LOGO = 300;

type LinhaDaMarca = {
  name: string;
  logo_id: string | null;
  logo_width: number | null;
  logo_height: number | null;
  logo_updated_at: Date | string | null;
  reply_to_email: string | null;
  reply_to_confirmed_at: Date | string | null;
  pending_reply_to: string | null;
  pending_expires_at: Date | string | null;
  report_mode: AgencyReportMode | null;
};

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

export const ACAO_LOGO = 'agencia.marca_logo';

@Injectable()
export class AgencyBrandService {
  private readonly logger = new Logger('marca-da-agencia');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(ARMAZEM_DE_IMAGENS) private readonly armazem: ArmazemDeImagens,
    private readonly rateLimit: RateLimitService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private banco(): Database {
    if (!this.database) throw new Error('marca da agência: sem banco');
    return this.database;
  }

  /** A marca como a agência a vê (quem é da agência). */
  async ler(auth: AuthContext): Promise<AgencyBrandResponse> {
    const tx = currentTx();
    const agencyId = await agenciaDe(tx, auth);
    return this.resposta(await linhaDaMarca(tx, agencyId), agencyId);
  }

  /**
   * Muda o nome, o e-mail de resposta e como o relatório sai. O e-mail novo fica pendente e recebe o link de
   * confirmação; `null` tira o e-mail de resposta (o "Responder" volta a ser o do Liame).
   */
  async mudar(auth: AuthContext, body: UpdateAgencyBrandRequest): Promise<AgencyBrandResponse> {
    const tx = currentTx();
    const agencyId = await agenciaDe(tx, auth);
    const antes = await linhaDaMarca(tx, agencyId);
    await tx.execute(sql`insert into liame.agency_brand (tenant_id, updated_by) values (${agencyId}, ${auth.userId}) on conflict (tenant_id) do nothing`);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    if (body.name !== undefined && body.name !== antes.name) {
      await tx.execute(sql`update liame.organization set name = ${body.name} where id = ${agencyId}`);
      before.name = antes.name;
      after.name = body.name;
    }
    if (body.report_mode !== undefined && body.report_mode !== (antes.report_mode ?? 'revisar')) {
      await tx.execute(sql`update liame.agency_brand set report_mode = ${body.report_mode}, updated_by = ${auth.userId} where tenant_id = ${agencyId}`);
      before.report_mode = antes.report_mode ?? 'revisar';
      after.report_mode = body.report_mode;
    }
    if (body.reply_to_email === null && (antes.reply_to_email || antes.pending_reply_to)) {
      await tx.execute(sql`
        update liame.agency_brand
           set reply_to_email = null, reply_to_confirmed_at = null,
               pending_reply_to = null, pending_token_hash = null, pending_expires_at = null, pending_requested_by = null,
               updated_by = ${auth.userId}
         where tenant_id = ${agencyId}`);
      // A auditoria guarda que o e-mail mudou, não o endereço (é dado de contato de alguém da agência).
      before.reply_to = antes.reply_to_email ? 'confirmado' : 'pendente';
      after.reply_to = 'nenhum';
    } else if (body.reply_to_email) {
      const novo = body.reply_to_email;
      if (novo === antes.reply_to_email) {
        // O mesmo e-mail que já vale: o pedido pendente (de outro endereço) sai, e nada mais muda.
        if (antes.pending_reply_to) {
          await tx.execute(sql`
            update liame.agency_brand set pending_reply_to = null, pending_token_hash = null, pending_expires_at = null,
                   pending_requested_by = null, updated_by = ${auth.userId}
             where tenant_id = ${agencyId}`);
        }
      } else {
        await this.rateLimit.consume(`resposta:agencia:${agencyId}`, 10, 86400);
        const { token, hash } = newToken();
        await tx.execute(sql`
          update liame.agency_brand
             set pending_reply_to = ${novo}, pending_token_hash = ${hash},
                 pending_expires_at = now() + make_interval(hours => ${HORAS_DO_LINK_DE_RESPOSTA}),
                 pending_requested_by = ${auth.userId}, updated_by = ${auth.userId}
           where tenant_id = ${agencyId}`);
        before.reply_to = antes.reply_to_email ? 'confirmado' : 'nenhum';
        after.reply_to = 'pendente';
        const agencia = body.name ?? antes.name;
        const link = `${this.config.appUrl}/confirmar-resposta?token=${token}`;
        afterCommit(() =>
          this.mailer.send({
            to: novo,
            subject: `Liame: confirme o e-mail de resposta da ${agencia}`,
            text:
              `${auth.name} pediu que as respostas aos relatórios que a ${agencia} manda pelo Liame venham para este e-mail.\n\n` +
              `Para confirmar, abra o link (vale ${HORAS_DO_LINK_DE_RESPOSTA} horas):\n${link}\n\n` +
              'Se você não esperava este e-mail, ignore: nada muda.',
          }),
        );
      }
    }
    auditDetail({ resourceId: agencyId, before, after });
    return this.resposta(await linhaDaMarca(tx, agencyId), agencyId);
  }

  /**
   * Troca o logo. O arquivo é conferido e regravado antes de qualquer gravação; o banco em transações curtas, antes e
   * depois, e o envio ao armazenamento sem transação aberta (como as Fotos). O logo anterior sai do armazenamento depois.
   */
  async enviarLogo(auth: AuthContext, corpo: unknown): Promise<AgencyBrandResponse> {
    const database = this.banco();
    if (!Buffer.isBuffer(corpo) || corpo.length === 0) {
      throw new AppProblem(400, 'logo-sem-arquivo', 'Falta o logo', 'Mande o arquivo do logo no corpo do pedido (PNG ou JPG).');
    }
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma organização', 'Selecione a agência para continuar.');
    const quem = { tenantId: auth.tenantId, userId: auth.userId };
    await naTransacaoDaEmpresa(database, quem, async () => {
      await agenciaDe(currentTx(), auth);
    });
    if (!this.armazem.disponivel) throw logoIndisponivel();
    await this.rateLimit.consume(`logo:agencia:${quem.tenantId}`, 30, 86400);

    let logo: Awaited<ReturnType<typeof processarLogo>>;
    try {
      logo = await processarLogo(corpo);
    } catch (err) {
      if (err instanceof RecusaDoLogo) {
        const r = RECUSAS_DO_LOGO[err.motivo];
        throw new AppProblem(422, r.code, r.title, r.detail);
      }
      if (err instanceof SemSharp) {
        this.logger.error(err.message);
        throw logoIndisponivel();
      }
      throw err;
    }

    const logoId = uuidv7();
    const chave = chaveDoLogo(quem.tenantId, logoId);
    try {
      await this.armazem.gravar(chave, logo.bytes);
    } catch (err) {
      this.logger.warn(`logo da agência ${quem.tenantId}: o armazenamento não guardou (${err instanceof Error ? err.message : String(err)})`);
      if (err instanceof ArmazemIndisponivel) throw logoIndisponivel();
      throw new AppProblem(502, 'logo-nao-guardado', 'O logo não foi guardado', 'Não deu para guardar o logo agora. Tente de novo.');
    }

    try {
      const { resposta, anterior } = await naTransacaoDaEmpresa(database, quem, async () => {
        const tx = currentTx();
        const agencyId = await agenciaDe(tx, auth);
        const antes = await linhaDaMarca(tx, agencyId);
        await tx.execute(sql`
          insert into liame.agency_brand (tenant_id, logo_id, logo_width, logo_height, logo_updated_at, updated_by)
          values (${agencyId}, ${logoId}, ${logo.largura}, ${logo.altura}, now(), ${auth.userId})
          on conflict (tenant_id) do update
            set logo_id = excluded.logo_id, logo_width = excluded.logo_width, logo_height = excluded.logo_height,
                logo_updated_at = excluded.logo_updated_at, updated_by = excluded.updated_by`);
        await writeAudit(tx, {
          tenantId: agencyId,
          actorType: actorTypeOf(auth),
          actorId: auth.userId,
          actorLabel: actorLabel(auth),
          actorRole: auth.roleKey,
          action: ACAO_LOGO,
          resourceType: 'agency_brand',
          resourceId: agencyId,
          before: { logo: antes.logo_id ? 'sim' : 'não' },
          after: { logo: 'sim', width: logo.largura, height: logo.altura },
          traceId: activeTraceId(),
          origin: 'api',
        });
        return { resposta: await this.resposta(await linhaDaMarca(tx, agencyId), agencyId), anterior: antes.logo_id };
      });
      if (anterior) this.apagarDoArmazem(chaveDoLogo(quem.tenantId, anterior));
      return resposta;
    } catch (err) {
      // O banco não guardou: o arquivo novo sai do armazenamento, e o logo anterior continua.
      this.apagarDoArmazem(chave);
      throw err;
    }
  }

  /** Tira o logo: o relatório volta a mostrar só o nome da agência. */
  async apagarLogo(auth: AuthContext): Promise<void> {
    const tx = currentTx();
    const agencyId = await agenciaDe(tx, auth);
    const r = await tx.execute<{ logo_id: string }>(sql`
      with antes as (select logo_id from liame.agency_brand where tenant_id = ${agencyId} and logo_id is not null for update)
      update liame.agency_brand b
         set logo_id = null, logo_width = null, logo_height = null, logo_updated_at = null, updated_by = ${auth.userId}
        from antes
       where b.tenant_id = ${agencyId}
      returning antes.logo_id`);
    const anterior = r.rows[0]?.logo_id;
    if (!anterior) return;
    auditDetail({ resourceId: agencyId, before: { logo: 'sim' }, after: { logo: 'não' } });
    afterCommit(async () => this.apagarDoArmazem(chaveDoLogo(agencyId, anterior)));
  }

  /** Apaga sem esperar e sem derrubar o pedido: o que sobrar sai com a agência (expurgo do prefixo). */
  private apagarDoArmazem(chave: string): void {
    this.armazem.apagar([chave]).catch((err: unknown) => {
      this.logger.warn(`logo da agência: não apagou ${chave} (${err instanceof Error ? err.message : String(err)})`);
    });
  }

  private async resposta(l: LinhaDaMarca, agencyId: string): Promise<AgencyBrandResponse> {
    let logo: AgencyBrandResponse['logo'] = null;
    if (l.logo_id && l.logo_width && l.logo_height && l.logo_updated_at) {
      let url: string | null = null;
      if (this.armazem.disponivel) {
        try {
          url = await this.armazem.enderecoDeLeitura(chaveDoLogo(agencyId, l.logo_id), SEGUNDOS_DO_LOGO);
        } catch (err) {
          this.logger.warn(`logo da agência ${agencyId}: sem o endereço de leitura (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      logo = { url, width: l.logo_width, height: l.logo_height, updated_at: iso(l.logo_updated_at) };
    }
    const pendenteVivo = l.pending_reply_to && l.pending_expires_at && new Date(l.pending_expires_at).getTime() > Date.now();
    return {
      name: l.name,
      logo,
      reply_to: l.reply_to_email && l.reply_to_confirmed_at ? { email: l.reply_to_email, confirmed_at: iso(l.reply_to_confirmed_at) } : null,
      pending_reply_to: pendenteVivo ? { email: l.pending_reply_to!, expires_at: iso(l.pending_expires_at!) } : null,
      report_mode: l.report_mode ?? 'revisar',
      logo_available: this.armazem.disponivel,
    };
  }
}

/** A marca da agência como está no banco (sem a linha ainda, o padrão: sem logo, sem e-mail, "eu reviso e mando"). */
async function linhaDaMarca(tx: Tx, agencyId: string): Promise<LinhaDaMarca> {
  const r = await tx.execute<LinhaDaMarca>(sql`
    select o.name, b.logo_id, b.logo_width, b.logo_height, b.logo_updated_at, b.reply_to_email, b.reply_to_confirmed_at,
           b.pending_reply_to, b.pending_expires_at, b.report_mode
      from liame.organization o
      left join liame.agency_brand b on b.tenant_id = o.id
     where o.id = ${agencyId}`);
  const l = r.rows[0];
  if (!l) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Agência não encontrada.');
  return l;
}

function logoIndisponivel(): AppProblem {
  return new AppProblem(503, 'logo-indisponivel', 'Logo indisponível', 'Não dá para receber o logo agora. Tente mais tarde.');
}
