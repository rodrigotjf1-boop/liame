import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DATABASE } from '../database/database.module.js';
import { Mailer, type MailMessage, maskEmail } from '../mail/mailer.js';
import { ATENDIMENTO } from '../suporte.js';
import { quando } from './recuperacao-da-conta.service.js';

// O pedido da propriedade à DMS quando o Dono não está mais (A7, W8, parte 6a; P34; D-A7-63, D-A7-64; D-A7-86), numa
// rotina do worker (escopo de sistema):
// - os avisos: cada situação que muda fora da API (a DMS confere, aprova ou recusa pelo comando; o Dono responde; quem
//   pediu desiste depois da conferência) vira e-mail ao Dono, a quem pediu ou à DMS, uma vez;
// - o expurgo: os documentos saem 30 dias depois da decisão;
// - a limpeza: o rascunho esquecido (sem envio em 2 dias) sai, com os documentos dele, para não travar a empresa.

/** Em teste, o escopo explícito: só os pedidos destas empresas (os arquivos de teste dividem o banco). */
export type EscopoDaPropriedade = { tenantIds?: string[] };

function doEscopo(escopo: EscopoDaPropriedade, coluna: SQL): SQL {
  if (!escopo.tenantIds) return sql``;
  if (!escopo.tenantIds.length) return sql`and false`;
  return sql`and ${coluna} in (${sql.join(
    escopo.tenantIds.map((t) => sql`${t}`),
    sql`, `,
  )})`;
}

/** O rascunho sem envio por 2 dias sai. */
const DIAS_DO_RASCUNHO = 2;

export type PropriedadeParaAvisar = {
  protocol: string;
  status: 'rascunho' | 'pedido' | 'conferido' | 'contestado' | 'aprovado' | 'recusado' | 'cancelado';
  empresa: string;
  quem: { name: string; email: string };
  dono: { name: string; email: string } | null;
  decide_from: Date | string | null;
  refusal_reason: string | null;
};

/** Os e-mails de cada situação. O motivo não vai no e-mail ao Dono: quem lê pode ser a família ou um sócio. */
export function emailsDaPropriedade(p: PropriedadeParaAvisar, appUrl: string): MailMessage[] {
  const link = `\n\n${appUrl}`;
  const ate = p.decide_from ? quando(p.decide_from) : '';
  switch (p.status) {
    case 'conferido':
      return [
        ...(p.dono
          ? [
              {
                to: p.dono.email,
                subject: `Liame: ${p.quem.name} pediu à DMS a propriedade da ${p.empresa}`,
                text:
                  [
                    `${p.quem.name}, Administrador da ${p.empresa}, pediu à DMS a propriedade da conta no Liame, dizendo que você não pode mais cuidar dela. A DMS conferiu os documentos de quem pede e o quadro de sócios da empresa.`,
                    `Se ninguém responder, a DMS pode aprovar a partir de ${ate}: ${p.quem.name} passa a ser o dono, e o seu acesso à conta sai.`,
                    `Se você ainda cuida da conta, entre no Liame e responda "Ainda cuido da conta" em Pessoas e acessos, ou escreva para ${ATENDIMENTO.email}. A DMS fala com os dois antes de decidir.`,
                  ].join('\n\n') + link,
              },
            ]
          : []),
        {
          to: p.quem.email,
          subject: `Liame: a DMS conferiu o seu pedido da propriedade (${p.protocol})`,
          text: `A DMS conferiu os documentos e o quadro de sócios. Avisamos o Dono no e-mail dele; a decisão sai a partir de ${ate}, depois da espera de 14 dias. Se ele responder, a DMS fala com os dois antes de decidir.${link}`,
        },
      ];
    case 'contestado':
      return [
        {
          to: p.quem.email,
          subject: `Liame: o Dono respondeu ao pedido da propriedade (${p.protocol})`,
          text: `O Dono respondeu que ainda cuida da conta da ${p.empresa}. A DMS fala com os dois antes de decidir; nada muda até lá.${link}`,
        },
        {
          to: ATENDIMENTO.email,
          subject: `Liame: o Dono respondeu ao pedido da propriedade ${p.protocol}`,
          text: `O Dono respondeu "Ainda cuido da conta" ao pedido ${p.protocol}. Fale com os dois antes de aprovar (propriedade-pela-dms --aprovar) ou recusar (--recusar).`,
        },
      ];
    case 'aprovado':
      return [
        {
          to: p.quem.email,
          subject: `Liame: agora a ${p.empresa} é sua`,
          text: `A DMS aprovou o pedido ${p.protocol}: você passou a ser a dona da conta da ${p.empresa} no Liame. Agora cuida da cobrança, de quem tem acesso, de encerrar a conta e de transferir a propriedade. Confira em Pessoas e acessos quem tem acesso, e em Plano e cobrança a forma de pagar.${link}`,
        },
        ...(p.dono
          ? [
              {
                to: p.dono.email,
                subject: `Liame: a propriedade da ${p.empresa} passou para ${p.quem.name}`,
                text: `A DMS aprovou o pedido da propriedade da ${p.empresa}: ${p.quem.name} é o dono da conta agora, e o seu acesso a ela acabou. Se isto está errado, escreva para ${ATENDIMENTO.email}.`,
              },
            ]
          : []),
      ];
    case 'recusado':
      return [
        {
          to: p.quem.email,
          subject: `Liame: pedido da propriedade recusado (${p.protocol})`,
          text: `A DMS recusou o pedido ${p.protocol}. Motivo: ${p.refusal_reason ?? ''}\n\nNada mudou na conta.${link}`,
        },
      ];
    case 'cancelado':
      // Só chega aqui o cancelamento depois da conferência: o Dono tinha sido avisado.
      return p.dono
        ? [
            {
              to: p.dono.email,
              subject: `Liame: o pedido da propriedade da ${p.empresa} foi cancelado`,
              text: `${p.quem.name} desistiu do pedido da propriedade da ${p.empresa}. Nada mudou na conta.`,
            },
          ]
        : [];
    default:
      return [];
  }
}

@Injectable()
export class PropriedadePelaDmsRotina {
  private readonly logger = new Logger('propriedade-pela-dms');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Os e-mails das situações ainda não avisadas; uma vez cada (a marca muda só depois do envio). */
  async avisosLote(limite = 20, escopo: EscopoDaPropriedade = {}): Promise<string[]> {
    if (!this.database) return [];
    const db = this.database.db;
    const linhas = await withSystem(db, (tx) =>
      tx.execute<{
        id: string;
        protocol: string;
        status: PropriedadeParaAvisar['status'];
        empresa: string;
        quem_nome: string;
        quem_email: string;
        dono_nome: string | null;
        dono_email: string | null;
        decide_from: Date | string | null;
        refusal_reason: string | null;
      }>(sql`
        select c.id, c.protocol, c.status, o.name as empresa, q.name as quem_nome, q.email as quem_email,
               d.name as dono_nome, d.email as dono_email, c.decide_from, c.refusal_reason
          from liame.ownership_claim c
          join liame.organization o on o.id = c.tenant_id
          join liame.app_user q on q.id = c.requester_user_id
          left join liame.app_user d on d.id = c.owner_user_id
         where c.status <> 'rascunho' and c.status is distinct from c.notified_status ${doEscopo(escopo, sql`c.tenant_id`)}
         order by c.updated_at, c.id
         limit ${limite}`),
    );
    const avisados: string[] = [];
    for (const l of linhas.rows) {
      const mensagens = emailsDaPropriedade(
        {
          protocol: l.protocol,
          status: l.status,
          empresa: l.empresa,
          quem: { name: l.quem_nome, email: l.quem_email },
          dono: l.dono_email ? { name: l.dono_nome ?? '', email: l.dono_email } : null,
          decide_from: l.decide_from,
          refusal_reason: l.refusal_reason,
        },
        this.config.appUrl,
      );
      try {
        for (const m of mensagens) await this.mailer.send(m);
      } catch (e) {
        // Falha passageira do envio: tenta de novo na próxima volta (a marca não mudou).
        this.logger.warn(`aviso da propriedade ${l.protocol} (${l.status}) para ${maskEmail(l.quem_email)} não saiu: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
        continue;
      }
      await withSystem(db, (tx) => tx.execute(sql`update liame.ownership_claim set notified_status = ${l.status} where id = ${l.id} and status = ${l.status}`));
      avisados.push(l.id);
    }
    return avisados;
  }

  /** Os documentos que passaram dos 30 dias depois da decisão saem. Devolve quantos saíram. */
  async expurgarLote(limite = 50, escopo: EscopoDaPropriedade = {}, agora = new Date()): Promise<number> {
    if (!this.database) return 0;
    const ref = sql`${agora.toISOString()}::timestamptz`;
    const r = await withSystem(this.database.db, (tx) =>
      tx.execute<{ id: string }>(sql`
        delete from liame.ownership_claim_document
         where id in (select d.id from liame.ownership_claim_document d
                        join liame.ownership_claim c on c.id = d.claim_id
                       where c.documents_expire_at <= ${ref} ${doEscopo(escopo, sql`c.tenant_id`)}
                       limit ${limite})
        returning id`),
    );
    return r.rows.length;
  }

  /** O rascunho sem envio por 2 dias sai, com os documentos dele. Devolve quantos saíram. */
  async limparRascunhosLote(limite = 50, escopo: EscopoDaPropriedade = {}, agora = new Date()): Promise<number> {
    if (!this.database) return 0;
    const ref = sql`${agora.toISOString()}::timestamptz`;
    const r = await withSystem(this.database.db, (tx) =>
      tx.execute<{ id: string }>(sql`
        delete from liame.ownership_claim
         where id in (select id from liame.ownership_claim
                       where status = 'rascunho' and created_at <= ${ref} - make_interval(days => ${DIAS_DO_RASCUNHO}) ${doEscopo(escopo, sql`tenant_id`)}
                       limit ${limite})
        returning id`),
    );
    return r.rows.length;
  }
}
