import type { CreateOwnershipClaimRequest, OwnershipClaim, OwnershipClaimDocumentKind, OwnershipClaimResponse } from '@liame/contracts';
import { type Tx, uuidv7 } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { lacrar } from '../auth/recuperacao/lacre.js';
import { DIAS_DE_ESPERA_DA_PROPRIEDADE } from '../auth/recuperacao/propriedade-pela-dms.js';
import { tipoDoDocumento } from '../auth/recuperacao/recuperacao.service.js';
import { TermosService } from '../auth/termos/termos.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { afterCommit, auditDetail, type AuthContext, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { Mailer } from '../mail/mailer.js';
import { ATENDIMENTO } from '../suporte.js';

// A propriedade pedida à DMS quando o Dono não está mais (A7, W8, parte 6a; P34; D-A7-63, D-A7-64; D-A7-86). Roda na
// transação da requisição, com a empresa ativa (a RLS limita tudo a ela). Um Administrador da própria empresa (não de
// uma agência), com o app, começa o pedido (o rascunho), manda os dois documentos, um por vez (o arquivo cru, lacrado
// com a chave pública da DMS como na recuperação), e envia. A DMS confere pelo comando da distribuição; o Dono é avisado
// no e-mail dele (pelo worker) e há 14 dias de espera; se ele responder ("Ainda cuido da conta"), a DMS fala com os dois.
// A aprovação é da DMS, pelo comando: quem pediu vira a dona, e o acesso do Dono antigo sai.

/** Os documentos saem 30 dias depois da decisão (D-A7-64). */
export const DIAS_DOS_DOCUMENTOS_DA_PROPRIEDADE = 30;
/** O último pedido que terminou aparece para quem pediu por 30 dias. */
const DIAS_DO_ULTIMO = 30;
/** Até 5 pedidos começados por dia por pessoa. */
const PEDIDOS_POR_DIA = 5;
const OS_DOIS: readonly OwnershipClaimDocumentKind[] = ['documento_com_foto', 'documento_da_empresa'];

type Linha = {
  id: string;
  protocol: string;
  status: OwnershipClaim['status'];
  reason: OwnershipClaim['reason'];
  note: string | null;
  requester_user_id: string;
  requester_name: string;
  owner_user_id: string | null;
  owner_name: string | null;
  documents: OwnershipClaimDocumentKind[] | string;
  created_at: Date | string;
  sent_at: Date | string | null;
  checked_at: Date | string | null;
  decide_from: Date | string | null;
  contested_at: Date | string | null;
  refusal_reason: string | null;
  closed_at: Date | string | null;
};

const iso = (v: Date | string | null): string | null => (v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString());
const naoEncontrado = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Este pedido de propriedade não existe ou já não está nesta situação.');

/** A lista de documentos como vem do Postgres (array, ou o texto `{a,b}` em alguns caminhos). */
function documentosDe(v: OwnershipClaimDocumentKind[] | string): OwnershipClaimDocumentKind[] {
  if (Array.isArray(v)) return v;
  return v.replace(/^\{|\}$/g, '').split(',').filter((x): x is OwnershipClaimDocumentKind => (OS_DOIS as readonly string[]).includes(x));
}

const SELECAO = sql`
  select c.id, c.protocol, c.status, c.reason, c.note, c.requester_user_id, r.name as requester_name, c.owner_user_id,
         o.name as owner_name, c.documents, c.created_at, c.sent_at, c.checked_at, c.decide_from, c.contested_at,
         c.refusal_reason, c.closed_at
    from liame.ownership_claim c
    join liame.app_user r on r.id = c.requester_user_id
    left join liame.app_user o on o.id = c.owner_user_id`;

function paraResposta(l: Linha, comNota: boolean): OwnershipClaim {
  return {
    id: l.id,
    protocol: l.protocol,
    status: l.status,
    reason: l.reason,
    note: comNota ? l.note : null,
    requester: { user_id: l.requester_user_id, name: l.requester_name },
    owner_name: l.owner_name,
    documents: OS_DOIS.filter((k) => documentosDe(l.documents).includes(k)),
    created_at: iso(l.created_at)!,
    sent_at: iso(l.sent_at),
    checked_at: iso(l.checked_at),
    decide_from: iso(l.decide_from),
    contested_at: iso(l.contested_at),
    refusal_reason: l.status === 'recusado' ? l.refusal_reason : null,
    closed_at: iso(l.closed_at),
  };
}

function empresaDe(auth: AuthContext): string {
  if (!auth.tenantId) throw new AppProblem(400, 'sem-empresa', 'Escolha uma empresa', 'Escolha a empresa no seletor do alto do menu.');
  return auth.tenantId;
}

@Injectable()
export class PropriedadePelaDmsService {
  constructor(
    private readonly mailer: Mailer,
    private readonly rateLimit: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly termos: TermosService,
  ) {}

  /** O pedido de quem lê (ou, para o Dono, o pedido sobre ele na espera) e se dá para pedir. */
  async ler(auth: AuthContext): Promise<OwnershipClaimResponse> {
    const tx = currentTx();
    const tenantId = empresaDe(auth);
    const meu = await tx.execute<Linha>(sql`${SELECAO}
      where c.tenant_id = ${tenantId} and c.requester_user_id = ${auth.userId}
        and (c.status in ('rascunho', 'pedido', 'conferido', 'contestado') or c.closed_at > now() - make_interval(days => ${DIAS_DO_ULTIMO}))
      order by (c.status in ('rascunho', 'pedido', 'conferido', 'contestado')) desc, c.created_at desc
      limit 1`);
    const cannot = await this.porQueNao(tx, auth, tenantId);
    if (meu.rows[0]) return { claim: paraResposta(meu.rows[0], true), mine: true, about_me: false, cannot_claim: cannot };
    if (auth.roleKey === 'dono') {
      const sobreMim = await tx.execute<Linha>(sql`${SELECAO}
        where c.tenant_id = ${tenantId} and c.owner_user_id = ${auth.userId} and c.status in ('conferido', 'contestado')
        order by c.created_at desc limit 1`);
      if (sobreMim.rows[0]) return { claim: paraResposta(sobreMim.rows[0], false), mine: false, about_me: true, cannot_claim: cannot };
    }
    return { claim: null, mine: false, about_me: false, cannot_claim: cannot };
  }

  /** Começa o pedido (o rascunho), ou atualiza o rascunho de quem pede. */
  async comecar(auth: AuthContext, body: CreateOwnershipClaimRequest): Promise<OwnershipClaimResponse> {
    const tx = currentTx();
    const tenantId = empresaDe(auth);
    if (body.terms_version !== (await this.termos.vigente({ userId: auth.userId, tenantId })).version) {
      throw new AppProblem(409, 'termos-desatualizados', 'Os termos mudaram', 'Recarregue a página e confira a versão nova dos termos.');
    }
    // Uma trava por empresa: dois pedidos ao mesmo tempo não passam juntos pela conferência de "um por empresa".
    await tx.execute(sql`select id from liame.organization where id = ${tenantId} for update`);
    const nota = body.note?.trim() ? body.note.trim() : null;
    const rascunho = await tx.execute<{ id: string }>(sql`
      select id from liame.ownership_claim where tenant_id = ${tenantId} and requester_user_id = ${auth.userId} and status = 'rascunho'`);
    if (rascunho.rows[0]) {
      await tx.execute(sql`
        update liame.ownership_claim set reason = ${body.reason}, note = ${nota}, terms_version = ${body.terms_version}
         where id = ${rascunho.rows[0].id}`);
      return this.ler(auth);
    }
    const motivo = await this.porQueNao(tx, auth, tenantId);
    if (motivo) throw this.recusa(motivo);
    await this.rateLimit.consume(`propriedade-pela-dms:${auth.userId}`, PEDIDOS_POR_DIA, 86_400);
    const dono = await tx.execute<{ user_id: string }>(sql`
      select user_id from liame.membership where tenant_id = ${tenantId} and role_key = 'dono' and revoked_at is null`);
    const numero = await tx.execute<{ protocol: string }>(sql`
      select 'PROP-' || to_char(now() at time zone 'America/Sao_Paulo', 'YYYY') || '-'
             || lpad(nextval('liame.ownership_claim_numero')::text, 4, '0') as protocol`);
    const id = uuidv7();
    await tx.execute(sql`
      insert into liame.ownership_claim (id, tenant_id, requester_user_id, owner_user_id, protocol, reason, note, terms_version)
      values (${id}, ${tenantId}, ${auth.userId}, ${dono.rows[0]?.user_id ?? null}, ${numero.rows[0]!.protocol}, ${body.reason}, ${nota}, ${body.terms_version})`);
    auditDetail({ resourceId: id, after: { protocolo: numero.rows[0]!.protocol, motivo: body.reason } });
    return this.ler(auth);
  }

  /** Um dos dois documentos do rascunho, cru no corpo; mandar de novo troca o anterior. */
  async documento(auth: AuthContext, id: string, kind: OwnershipClaimDocumentKind, corpo: unknown): Promise<OwnershipClaimResponse> {
    const tx = currentTx();
    const tenantId = empresaDe(auth);
    const chave = this.config.recuperacaoChavePublica;
    if (!chave) throw this.recusa('indisponivel');
    const r = await tx.execute<{ protocol: string }>(sql`
      select protocol from liame.ownership_claim
       where id = ${id} and tenant_id = ${tenantId} and requester_user_id = ${auth.userId} and status = 'rascunho'
       for update`);
    const pedido = r.rows[0];
    if (!pedido) throw naoEncontrado();
    const bytes = Buffer.isBuffer(corpo) ? corpo : null;
    if (!bytes?.length) throw new AppProblem(400, 'falta-o-documento', 'Falta o documento', 'Mande o arquivo do documento.');
    const tipo = tipoDoDocumento(bytes);
    if (!tipo) throw new AppProblem(422, 'documento-formato', 'Formato não aceito', 'Mande o documento em JPG, PNG ou PDF.');
    const lacrado = lacrar(chave, bytes);
    await tx.execute(sql`delete from liame.ownership_claim_document where claim_id = ${id} and kind = ${kind}`);
    await tx.execute(sql`
      insert into liame.ownership_claim_document (id, claim_id, kind, media_type, size_bytes, key_id, wrapped_key, iv, tag, ciphertext)
      values (${uuidv7()}, ${id}, ${kind}, ${tipo}, ${bytes.length}, ${lacrado.keyId}, ${lacrado.wrappedKey}, ${lacrado.iv}, ${lacrado.tag}, ${lacrado.ciphertext})`);
    await tx.execute(sql`
      update liame.ownership_claim
         set documents = (select coalesce(array_agg(distinct d), '{}') from unnest(documents || array[${kind}]::text[]) as d)
       where id = ${id}`);
    auditDetail({ resourceId: id, after: { protocolo: pedido.protocol, documento: kind, tipo, bytes: bytes.length } });
    return this.ler(auth);
  }

  /** Envia o pedido à DMS, com os dois documentos. */
  async enviar(auth: AuthContext, id: string): Promise<OwnershipClaimResponse> {
    const tx = currentTx();
    const tenantId = empresaDe(auth);
    const r = await tx.execute<{ protocol: string; documents: OwnershipClaimDocumentKind[] | string }>(sql`
      select protocol, documents from liame.ownership_claim
       where id = ${id} and tenant_id = ${tenantId} and requester_user_id = ${auth.userId} and status = 'rascunho'
       for update`);
    const pedido = r.rows[0];
    if (!pedido) throw naoEncontrado();
    const faltam = OS_DOIS.filter((k) => !documentosDe(pedido.documents).includes(k));
    if (faltam.length) {
      throw new AppProblem(
        422,
        'faltam-documentos',
        'Faltam documentos',
        faltam.includes('documento_com_foto') ? 'Mande o seu documento com foto.' : 'Mande o documento da empresa que mostra você como representante.',
      );
    }
    await tx.execute(sql`update liame.ownership_claim set status = 'pedido', sent_at = now(), notified_status = 'pedido' where id = ${id}`);
    auditDetail({ resourceId: id, after: { protocolo: pedido.protocol, situacao: 'pedido' } });
    afterCommit(async () => {
      await this.mailer.send({
        to: auth.email,
        subject: `Liame: recebemos o seu pedido da propriedade (${pedido.protocol})`,
        text:
          [
            `Recebemos o seu pedido da propriedade da conta, protocolo ${pedido.protocol}.`,
            'A DMS confere os documentos e o quadro de sócios, e marca uma videochamada curta com você por este e-mail.',
            `Depois, avisamos o Dono no e-mail dele e esperamos ${DIAS_DE_ESPERA_DA_PROPRIEDADE} dias. Se ele responder, a DMS fala com os dois antes de decidir.`,
            'A DMS nunca pede documento por e-mail, por WhatsApp ou pela LIA.',
          ].join('\n\n') + `\n\n${this.config.appUrl}`,
      });
      await this.mailer.send({
        to: ATENDIMENTO.email,
        subject: `Liame: pedido da propriedade ${pedido.protocol}`,
        text: `Um Administrador pediu a propriedade de uma empresa, protocolo ${pedido.protocol}. Confira pelo comando da distribuição (propriedade-pela-dms --ver ${pedido.protocol}).`,
      });
    });
    return this.ler(auth);
  }

  /** Quem pediu desiste: o rascunho some; o pedido enviado fica cancelado. */
  async cancelar(auth: AuthContext, id: string): Promise<OwnershipClaimResponse> {
    const tx = currentTx();
    const tenantId = empresaDe(auth);
    const r = await tx.execute<{ protocol: string; status: OwnershipClaim['status'] }>(sql`
      select protocol, status from liame.ownership_claim
       where id = ${id} and tenant_id = ${tenantId} and requester_user_id = ${auth.userId} and status in ('rascunho', 'pedido', 'conferido', 'contestado')
       for update`);
    const pedido = r.rows[0];
    if (!pedido) throw naoEncontrado();
    if (pedido.status === 'rascunho') {
      await tx.execute(sql`delete from liame.ownership_claim where id = ${id}`);
    } else {
      // Depois da conferência, o Dono tinha sido avisado: o worker avisa a ele que o pedido caiu.
      await tx.execute(sql`
        update liame.ownership_claim
           set status = 'cancelado', closed_at = now(),
               notified_status = case when checked_at is null then 'cancelado' else notified_status end,
               documents_expire_at = now() + make_interval(days => ${DIAS_DOS_DOCUMENTOS_DA_PROPRIEDADE})
         where id = ${id}`);
    }
    auditDetail({ resourceId: id, before: { protocolo: pedido.protocol, situacao: pedido.status } });
    return this.ler(auth);
  }

  /** O Dono responde "Ainda cuido da conta": o pedido para, e a DMS fala com os dois antes de decidir. */
  async contestar(auth: AuthContext, id: string): Promise<OwnershipClaimResponse> {
    const tx = currentTx();
    const tenantId = empresaDe(auth);
    if (auth.roleKey !== 'dono') throw new AppProblem(403, 'so-o-dono', 'Só o dono', 'Só o Dono responde ao pedido da propriedade.');
    const r = await tx.execute<{ protocol: string }>(sql`
      update liame.ownership_claim set status = 'contestado', contested_at = now()
       where id = ${id} and tenant_id = ${tenantId} and owner_user_id = ${auth.userId} and status = 'conferido'
       returning protocol`);
    if (!r.rows[0]) throw naoEncontrado();
    auditDetail({ resourceId: id, after: { protocolo: r.rows[0].protocol, situacao: 'contestado' } });
    return this.ler(auth);
  }

  /** Por que quem lê não pode pedir; nulo = pode. */
  private async porQueNao(tx: Tx, auth: AuthContext, tenantId: string): Promise<OwnershipClaimResponse['cannot_claim']> {
    if (auth.roleKey === 'dono') return 'e-o-dono';
    if (auth.partner) return 'vem-de-agencia';
    if (auth.roleKey !== 'administrador') return 'nao-e-administrador';
    if (!auth.mfaConfigured) return 'sem-segundo-fator';
    const aberto = await tx.execute(sql`
      select 1 from liame.ownership_claim where tenant_id = ${tenantId} and status in ('rascunho', 'pedido', 'conferido', 'contestado')`);
    if (aberto.rows.length) return 'pedido-em-andamento';
    if (!this.config.recuperacaoChavePublica) return 'indisponivel';
    return null;
  }

  private recusa(motivo: NonNullable<OwnershipClaimResponse['cannot_claim']>): AppProblem {
    switch (motivo) {
      case 'e-o-dono':
        return new AppProblem(403, 'e-o-dono', 'Você é o Dono', 'O Dono transfere a propriedade em Pessoas e acessos.');
      case 'vem-de-agencia':
        return new AppProblem(403, 'vem-de-agencia', 'A conta é do dono do negócio', 'Quem vem de uma agência não pede a propriedade da conta do cliente.');
      case 'nao-e-administrador':
        return new AppProblem(403, 'so-administrador', 'Só um Administrador', 'Só um Administrador da empresa pede a propriedade à DMS.');
      case 'sem-segundo-fator':
        return new AppProblem(409, 'sem-segundo-fator', 'Ative o app autenticador', 'Quem vira dono precisa entrar com o app autenticador. Ative em Segurança da conta.');
      case 'pedido-em-andamento':
        return new AppProblem(409, 'pedido-em-andamento', 'Já há um pedido', 'Esta empresa já tem um pedido da propriedade em andamento.');
      case 'indisponivel':
        return new AppProblem(503, 'propriedade-indisponivel', 'Pedido indisponível', `O pedido da propriedade à DMS ainda não está ligado. Fale com o suporte: ${ATENDIMENTO.email}.`);
    }
  }
}
