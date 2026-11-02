import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { auditarNasEmpresas } from '../auth/recuperacao/distribuicao.js';
import type { EmpresaDoPedido } from '../auth/recuperacao/recuperacao.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATABASE } from '../database/database.module.js';
import { Mailer, type MailMessage, maskEmail } from '../mail/mailer.js';
import { ATENDIMENTO } from '../suporte.js';

// A espera da recuperação da conta do Dono (A7, W8, parte 4b; P34; D-A7-62, D-A7-64; D-A7-85), numa rotina do worker
// (escopo de sistema):
// - a troca: no fim dos 7 dias depois da conferência da DMS, se nada mudou, o app autenticador antigo e os códigos de
//   recuperação deixam de valer e todas as sessões fecham; ao entrar com a senha, o Dono cadastra o app novo;
// - os avisos: cada situação que muda fora da API (a DMS confere, recusa ou retoma pelo comando; um Administrador para;
//   a espera termina; o Dono cancela depois da conferência) vira e-mail ao Dono, aos Administradores ou à DMS, uma vez;
// - o expurgo: os documentos saem 30 dias depois da decisão.

/** Em teste, o escopo explícito: só os pedidos destas pessoas (os arquivos de teste dividem o banco). */
export type EscopoDaRecuperacao = { userIds?: string[] };

function doEscopo(escopo: EscopoDaRecuperacao, coluna: SQL): SQL {
  if (!escopo.userIds) return sql``;
  if (!escopo.userIds.length) return sql`and false`;
  return sql`and ${coluna} in (${sql.join(
    escopo.userIds.map((u) => sql`${u}`),
    sql`, `,
  )})`;
}

const empresasDe = (v: EmpresaDoPedido[] | string): EmpresaDoPedido[] => (typeof v === 'string' ? (JSON.parse(v) as EmpresaDoPedido[]) : v);

/** Data e hora como a pessoa lê, no horário de Brasília. */
export function quando(d: Date | string): string {
  return new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
}

export type PedidoParaAvisar = {
  id: string;
  protocol: string;
  status: 'pedido' | 'conferido' | 'parado' | 'aplicado' | 'recusado' | 'cancelado';
  applies_at: Date | string | null;
  refusal_reason: string | null;
  dono: { name: string; email: string };
};

export type AdministradorParaAvisar = { name: string; email: string; empresa: string };

/** Os e-mails de cada situação: ao Dono, aos Administradores das empresas dele, ou à DMS. */
export function emailsDaSituacao(p: PedidoParaAvisar, admins: readonly AdministradorParaAvisar[], appUrl: string): MailMessage[] {
  const link = `\n\n${appUrl}`;
  const dono = p.dono.name;
  const aosAdmins = (assunto: (a: AdministradorParaAvisar) => string, texto: (a: AdministradorParaAvisar) => string): MailMessage[] =>
    admins.map((a) => ({ to: a.email, subject: assunto(a), text: texto(a) + link }));
  switch (p.status) {
    case 'conferido': {
      const em = p.applies_at ? quando(p.applies_at) : '';
      return [
        {
          to: p.dono.email,
          subject: `Liame: a DMS conferiu o seu pedido de recuperação (${p.protocol})`,
          text:
            [
              'A DMS conferiu o seu documento, o seu nome no quadro de sócios e a videochamada.',
              `Se nada mudar, em ${em}, o app autenticador antigo e os códigos de recuperação deixam de valer e todas as sessões fecham. Ao entrar com a senha, você lê o QR do app novo e recebe 10 códigos novos.`,
              'Achou o celular ou os códigos? Entre normalmente: o pedido cai sozinho. Se não foi você quem pediu, entre com a senha, cancele o pedido e troque a senha.',
              'Avisamos os Administradores das suas empresas.',
            ].join('\n\n') + link,
        },
        ...aosAdmins(
          (a) => `Liame: ${dono} pediu para recuperar a entrada na conta da ${a.empresa}`,
          (a) =>
            [
              `${dono} disse que perdeu o celular e os códigos de recuperação. A DMS conferiu o documento, o quadro de sócios da ${a.empresa} na Receita e fez uma videochamada.`,
              `Se nada mudar, em ${em}, o app autenticador dele é trocado.`,
              `Se você não reconhece este pedido, pare-o em Pessoas e acessos ("Não reconheço este pedido"): a DMS fala com ${dono} antes de seguir.`,
            ].join('\n\n'),
        ),
      ];
    }
    case 'parado':
      return [
        {
          to: p.dono.email,
          subject: `Liame: o seu pedido de recuperação foi parado (${p.protocol})`,
          text: `Um Administrador de uma das suas empresas não reconheceu o pedido de recuperação ${p.protocol} e o parou. A DMS fala com você pelo e-mail e pelo telefone cadastrados antes de seguir. Nada mudou na sua conta.${link}`,
        },
        {
          to: ATENDIMENTO.email,
          subject: `Liame: pedido de recuperação parado (${p.protocol})`,
          text: `Um Administrador parou o pedido ${p.protocol} ("Não reconheço este pedido"). Fale com o Dono antes de retomar (recuperacao-da-conta --retomar) ou recusar (--recusar).`,
        },
      ];
    case 'recusado':
      return [
        {
          to: p.dono.email,
          subject: `Liame: pedido de recuperação recusado (${p.protocol})`,
          text: `A DMS recusou o pedido de recuperação ${p.protocol}. Motivo: ${p.refusal_reason ?? ''}\n\nNada mudou na sua conta. Se precisar, faça outro pedido pela entrada.${link}`,
        },
      ];
    case 'aplicado':
      return [
        {
          to: p.dono.email,
          subject: `Liame: o app autenticador da sua conta foi trocado (${p.protocol})`,
          text: `Terminou a espera do pedido ${p.protocol}: o app autenticador antigo e os códigos de recuperação deixaram de valer, e todas as sessões foram fechadas. Entre com o seu e-mail e a senha: você lê o QR do app novo e recebe 10 códigos novos.${link}`,
        },
        ...aosAdmins(
          () => `Liame: o app autenticador de ${dono} foi trocado`,
          () => `Terminou a espera do pedido de recuperação de ${dono} (${p.protocol}): o app autenticador antigo dele deixou de valer, e ele cadastra um novo ao entrar.`,
        ),
      ];
    case 'cancelado':
      // O Dono já recebeu o e-mail da própria API; aqui, os Administradores que tinham sido avisados na conferência.
      return aosAdmins(
        (a) => `Liame: o pedido de recuperação de ${dono} foi cancelado (${a.empresa})`,
        () => `O pedido de recuperação de ${dono} (${p.protocol}) foi cancelado. Nada mudou na conta.`,
      );
    default:
      return [];
  }
}

@Injectable()
export class RecuperacaoDaContaRotina {
  private readonly logger = new Logger('recuperacao-da-conta');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** No fim da espera: o app antigo e os códigos saem, as sessões fecham, e o pedido vira `aplicado`. */
  async aplicarLote(limite = 20, escopo: EscopoDaRecuperacao = {}, agora = new Date()): Promise<string[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const ref = sql`${agora.toISOString()}::timestamptz`;
    const devidos = await withSystem(db, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from liame.account_recovery
         where status = 'conferido' and applies_at <= ${ref} ${doEscopo(escopo, sql`user_id`)}
         order by applies_at, id
         limit ${limite}`),
    );
    const feitos: string[] = [];
    for (const { id } of devidos.rows) {
      const feito = await withSystem(db, async (tx) => {
        // Conferido de novo, travado: o Dono pode ter entrado (o pedido caiu) ou um Administrador pode ter parado.
        const r = await tx.execute<{ user_id: string; protocol: string; companies: EmpresaDoPedido[] | string }>(sql`
          select user_id, protocol, companies from liame.account_recovery
           where id = ${id} and status = 'conferido' and applies_at <= ${ref}
           for update`);
        const p = r.rows[0];
        if (!p) return false;
        await tx.execute(sql`
          update liame.secret set revoked_at = now()
           where owner_user_id = ${p.user_id} and tenant_id is null and purpose in ('totp', 'totp_pendente') and revoked_at is null`);
        await tx.execute(sql`delete from liame.recovery_code where user_id = ${p.user_id} and used_at is null`);
        await tx.execute(sql`update liame.user_token set used_at = now() where user_id = ${p.user_id} and purpose = 'trocar_segundo_fator' and used_at is null`);
        await tx.execute(sql`update liame.session set revoked_at = now() where user_id = ${p.user_id} and revoked_at is null`);
        await tx.execute(sql`update liame.app_user set totp_last_step = null, mfa_enabled_at = null where id = ${p.user_id}`);
        await tx.execute(sql`update liame.account_recovery set status = 'aplicado', closed_at = now() where id = ${id}`);
        await auditarNasEmpresas(
          tx,
          { id, protocol: p.protocol, companies: empresasDe(p.companies) },
          { quem: 'Recuperação da conta (rotina)', origem: 'worker', action: 'segundo_fator.recuperacao_aplicar', after: { app_antigo: 'revogado', sessoes: 'fechadas' } },
        );
        return true;
      });
      if (feito) feitos.push(id);
    }
    return feitos;
  }

  /** Os e-mails das situações ainda não avisadas; uma vez cada (a marca muda só depois do envio). */
  async avisosLote(limite = 20, escopo: EscopoDaRecuperacao = {}): Promise<string[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const linhas = await withSystem(db, (tx) =>
      tx.execute<{
        id: string;
        user_id: string;
        protocol: string;
        status: PedidoParaAvisar['status'];
        applies_at: Date | string | null;
        refusal_reason: string | null;
        companies: EmpresaDoPedido[] | string;
        name: string;
        email: string;
      }>(sql`
        select r.id, r.user_id, r.protocol, r.status, r.applies_at, r.refusal_reason, r.companies, u.name, u.email
          from liame.account_recovery r join liame.app_user u on u.id = r.user_id
         where r.status is distinct from r.notified_status ${doEscopo(escopo, sql`r.user_id`)}
         order by r.updated_at, r.id
         limit ${limite}`),
    );
    const avisados: string[] = [];
    for (const l of linhas.rows) {
      const ids = empresasDe(l.companies).map((c) => c.tenant_id);
      const admins = ids.length
        ? (
            await withSystem(db, (tx) =>
              tx.execute<AdministradorParaAvisar>(sql`
                select distinct u.name, u.email, o.name as empresa
                  from liame.membership m
                  join liame.app_user u on u.id = m.user_id
                  join liame.organization o on o.id = m.tenant_id and o.status <> 'encerrada'
                 where m.tenant_id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
                   and m.role_key = 'administrador' and m.revoked_at is null and m.partner_link_id is null and m.user_id <> ${l.user_id}`),
            )
          ).rows
        : [];
      const mensagens = emailsDaSituacao(
        { id: l.id, protocol: l.protocol, status: l.status, applies_at: l.applies_at, refusal_reason: l.refusal_reason, dono: { name: l.name, email: l.email } },
        admins,
        this.config.appUrl,
      );
      try {
        for (const m of mensagens) await this.mailer.send(m);
      } catch (e) {
        // Falha passageira do envio: tenta de novo na próxima volta (a marca não mudou).
        this.logger.warn(`aviso da recuperação ${l.protocol} (${l.status}) para ${maskEmail(l.email)} não saiu: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
        continue;
      }
      await withSystem(db, (tx) => tx.execute(sql`update liame.account_recovery set notified_status = ${l.status} where id = ${l.id} and status = ${l.status}`));
      avisados.push(l.id);
    }
    return avisados;
  }

  /** Os documentos que passaram dos 30 dias depois da decisão saem (D-A7-64). Devolve quantos saíram. */
  async expurgarLote(limite = 50, escopo: EscopoDaRecuperacao = {}, agora = new Date()): Promise<number> {
    if (!this.database) return 0;
    const ref = sql`${agora.toISOString()}::timestamptz`;
    const r = await withSystem(this.database.db, (tx) =>
      tx.execute<{ id: string }>(sql`
        delete from liame.account_recovery_document
         where id in (select d.id from liame.account_recovery_document d
                        join liame.account_recovery r on r.id = d.recovery_id
                       where r.documents_expire_at <= ${ref} ${doEscopo(escopo, sql`r.user_id`)}
                       limit ${limite})
        returning id`),
    );
    return r.rows.length;
  }
}
