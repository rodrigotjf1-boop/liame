import type { KeyObject } from 'node:crypto';
import { type Db, type Tx, withSystem } from '@liame/database';
import { sql } from 'drizzle-orm';
import { writeAudit } from '../../audit/audit.js';
import { abrir } from './lacre.js';

// O lado da DMS no pedido da propriedade quando o Dono não está mais (A7, W8, parte 6a; D-A7-63, D-A7-64; D-A7-86), pelo
// comando da distribuição (`scripts/propriedade-pela-dms.ts`), no escopo de sistema e com o papel dono do banco
// informado só na hora: listar, abrir os documentos com a chave PRIVADA da DMS, conferir, aprovar (só depois dos 14 dias
// de espera) e recusar. A auditoria da empresa guarda o que a DMS conferiu e quem decidiu, sem a imagem; os e-mails saem
// pelo worker (o comando não tem o envio).

/** A espera depois da conferência, antes de a DMS poder aprovar (D-A7-63). */
export const DIAS_DE_ESPERA_DA_PROPRIEDADE = 14;
const DIAS_DOS_DOCUMENTOS = 30;

export type PropriedadeNaDistribuicao = {
  id: string;
  tenant_id: string;
  protocol: string;
  status: string;
  reason: string;
  note: string | null;
  empresa: { name: string; cnpj: string | null };
  quem_pede: { user_id: string; name: string; email: string };
  dono: { user_id: string | null; name: string | null; email: string | null };
  created_at: Date;
  sent_at: Date | null;
  checked_at: Date | null;
  decide_from: Date | null;
  contested_at: Date | null;
};

type Linha = {
  id: string;
  tenant_id: string;
  protocol: string;
  status: string;
  reason: string;
  note: string | null;
  empresa: string;
  cnpj: string | null;
  quem_id: string;
  quem_nome: string;
  quem_email: string;
  dono_id: string | null;
  dono_nome: string | null;
  dono_email: string | null;
  created_at: Date | string;
  sent_at: Date | string | null;
  checked_at: Date | string | null;
  decide_from: Date | string | null;
  contested_at: Date | string | null;
};

const data = (v: Date | string | null): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v));

function doBanco(r: Linha): PropriedadeNaDistribuicao {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    protocol: r.protocol,
    status: r.status,
    reason: r.reason,
    note: r.note,
    empresa: { name: r.empresa, cnpj: r.cnpj },
    quem_pede: { user_id: r.quem_id, name: r.quem_nome, email: r.quem_email },
    dono: { user_id: r.dono_id, name: r.dono_nome, email: r.dono_email },
    created_at: data(r.created_at)!,
    sent_at: data(r.sent_at),
    checked_at: data(r.checked_at),
    decide_from: data(r.decide_from),
    contested_at: data(r.contested_at),
  };
}

const SELECAO = sql`
  select c.id, c.tenant_id, c.protocol, c.status, c.reason, c.note, o.name as empresa, o.cnpj,
         q.id as quem_id, q.name as quem_nome, q.email as quem_email, d.id as dono_id, d.name as dono_nome, d.email as dono_email,
         c.created_at, c.sent_at, c.checked_at, c.decide_from, c.contested_at
    from liame.ownership_claim c
    join liame.organization o on o.id = c.tenant_id
    join liame.app_user q on q.id = c.requester_user_id
    left join liame.app_user d on d.id = c.owner_user_id`;

/** Os pedidos enviados e em andamento (ou todos os dos últimos 60 dias, com `todos`); o rascunho não aparece. */
export async function listarPropriedades(db: Db, opcoes: { todos?: boolean } = {}): Promise<PropriedadeNaDistribuicao[]> {
  return withSystem(db, async (tx) => {
    const filtro = opcoes.todos
      ? sql`c.status <> 'rascunho' and c.created_at > now() - interval '60 days'`
      : sql`c.status in ('pedido', 'conferido', 'contestado')`;
    const r = await tx.execute<Linha>(sql`${SELECAO} where ${filtro} order by c.created_at`);
    return r.rows.map(doBanco);
  });
}

async function porProtocolo(tx: Tx, protocolo: string, travar = false): Promise<PropriedadeNaDistribuicao> {
  const r = await tx.execute<Linha>(sql`${SELECAO} where c.protocol = ${protocolo} ${travar ? sql`for update of c` : sql``}`);
  const linha = r.rows[0];
  if (!linha || linha.status === 'rascunho') throw new Error(`o pedido ${protocolo} não existe ou ainda não foi enviado`);
  return doBanco(linha);
}

/** O pedido e os dois documentos abertos com a chave privada da DMS (o comando grava numa pasta e avisa para apagar). */
export async function abrirDocumentosDaPropriedade(
  db: Db,
  protocolo: string,
  privada: KeyObject,
): Promise<{ pedido: PropriedadeNaDistribuicao; arquivos: { kind: string; media_type: string; bytes: Buffer }[] }> {
  return withSystem(db, async (tx) => {
    const pedido = await porProtocolo(tx, protocolo);
    const docs = await tx.execute<{ kind: string; media_type: string; key_id: string; wrapped_key: Buffer; iv: Buffer; tag: Buffer; ciphertext: Buffer }>(sql`
      select kind, media_type, key_id, wrapped_key, iv, tag, ciphertext from liame.ownership_claim_document
       where claim_id = ${pedido.id} order by kind`);
    return {
      pedido,
      arquivos: docs.rows.map((d) => ({
        kind: d.kind,
        media_type: d.media_type,
        bytes: abrir(privada, { keyId: d.key_id, wrappedKey: d.wrapped_key, iv: d.iv, tag: d.tag, ciphertext: d.ciphertext }),
      })),
    };
  });
}

function exigirQuem(por: string): string {
  const quem = por.trim();
  if (quem.length < 2 || quem.length > 80) throw new Error('diga quem decidiu (--por), de 2 a 80 letras');
  return quem;
}

async function auditar(tx: Tx, pedido: PropriedadeNaDistribuicao, por: string, action: string, after: Record<string, unknown>, reason: string | null = null) {
  await writeAudit(tx, {
    tenantId: pedido.tenant_id,
    actorType: 'system',
    actorId: null,
    actorLabel: `Distribuição DMS (${por})`,
    action,
    resourceType: 'ownership_claim',
    resourceId: pedido.id,
    after: { protocolo: pedido.protocol, ...after },
    reason,
    origin: 'console',
  });
}

/**
 * A DMS conferiu os dois documentos, o quadro de sócios pelo CNPJ e fez a videochamada com quem pede (os quatro). Começa
 * a espera de 14 dias, com aviso ao Dono no e-mail dele (pelo worker).
 */
export async function conferirPropriedade(
  db: Db,
  p: { protocolo: string; por: string; documento: boolean; empresa: boolean; socios: boolean; videochamada: boolean },
): Promise<{ decideFrom: Date }> {
  const por = exigirQuem(p.por);
  if (!p.documento || !p.empresa || !p.socios || !p.videochamada) {
    throw new Error('a conferência precisa dos quatro: o documento com foto (--documento), o da empresa (--empresa), o quadro de sócios (--socios) e a videochamada (--videochamada)');
  }
  return withSystem(db, async (tx) => {
    const pedido = await porProtocolo(tx, p.protocolo, true);
    if (pedido.status !== 'pedido') throw new Error(`o pedido ${p.protocolo} está ${pedido.status}: só se confere o que está pedido`);
    const r = await tx.execute<{ decide_from: Date | string }>(sql`
      update liame.ownership_claim
         set status = 'conferido', checked_at = now(), checked_by = ${por},
             checks = ${JSON.stringify({ documento: true, empresa: true, socios: true, videochamada: true })}::jsonb,
             decide_from = now() + make_interval(days => ${DIAS_DE_ESPERA_DA_PROPRIEDADE})
       where id = ${pedido.id}
       returning decide_from`);
    const decideFrom = data(r.rows[0]!.decide_from)!;
    await auditar(tx, pedido, por, 'pessoas.propriedade_dms_conferir', { documento: true, empresa: true, socios: true, videochamada: true, decide_a_partir_de: decideFrom.toISOString() });
    return { decideFrom };
  });
}

/**
 * A DMS aprova, depois da espera (e, com o Dono tendo respondido, depois de falar com os dois): quem pediu vira a dona, e
 * o acesso do Dono antigo sai. Confere de novo que quem pede ainda é Administrador da empresa, com o app, de fora das
 * agências, e que o Dono é o mesmo do pedido.
 */
export async function aprovarPropriedade(db: Db, p: { protocolo: string; por: string; motivo: string }): Promise<void> {
  const por = exigirQuem(p.por);
  const motivo = p.motivo.trim();
  if (motivo.length < 5 || motivo.length > 200) throw new Error('diga como a DMS decidiu (--motivo), de 5 a 200 letras');
  await withSystem(db, async (tx) => {
    const pedido = await porProtocolo(tx, p.protocolo, true);
    if (pedido.status !== 'conferido' && pedido.status !== 'contestado') throw new Error(`o pedido ${p.protocolo} está ${pedido.status}: só se aprova o conferido`);
    if (!pedido.decide_from || pedido.decide_from.getTime() > Date.now()) {
      throw new Error(`a espera de ${DIAS_DE_ESPERA_DA_PROPRIEDADE} dias ainda não terminou: a decisão sai a partir de ${pedido.decide_from?.toISOString() ?? '—'}`);
    }
    const quem = await tx.execute(sql`
      select 1 from liame.membership m
       where m.tenant_id = ${pedido.tenant_id} and m.user_id = ${pedido.quem_pede.user_id} and m.role_key = 'administrador'
         and m.revoked_at is null and m.partner_link_id is null and (m.expires_at is null or m.expires_at > now())
         and exists (select 1 from liame.secret s
                      where s.owner_user_id = m.user_id and s.tenant_id is null and s.purpose = 'totp' and s.revoked_at is null)
       for update of m`);
    if (!quem.rows.length) throw new Error('quem pediu já não é Administrador da empresa com o app: recuse o pedido');
    // O Dono antigo deixa de ser dono e sai (também na linha que fica guardada); depois, quem pediu passa a ser.
    const antigo = await tx.execute<{ user_id: string }>(sql`
      update liame.membership
         set role_key = 'administrador', revoked_at = now(), approve_limit_micros = null, dual_approval = true, billing_access = false
       where tenant_id = ${pedido.tenant_id} and role_key = 'dono' and revoked_at is null
       returning user_id`);
    if (antigo.rows.length && antigo.rows[0]!.user_id !== pedido.dono.user_id) {
      throw new Error('o Dono da empresa mudou depois do pedido: recuse e peça um pedido novo');
    }
    await tx.execute(sql`
      update liame.membership
         set role_key = 'dono', approve_limit_micros = null, dual_approval = true, billing_access = false, expires_at = null
       where tenant_id = ${pedido.tenant_id} and user_id = ${pedido.quem_pede.user_id} and revoked_at is null`);
    await tx.execute(sql`
      update liame.ownership_claim
         set status = 'aprovado', closed_at = now(), documents_expire_at = now() + make_interval(days => ${DIAS_DOS_DOCUMENTOS})
       where id = ${pedido.id}`);
    await auditar(tx, pedido, por, 'pessoas.propriedade_dms_aprovar', { dono_antigo: antigo.rows[0]?.user_id ?? null, dono_novo: pedido.quem_pede.user_id }, motivo);
  });
}

/** A DMS recusa, com o motivo que quem pediu lê. */
export async function recusarPropriedade(db: Db, p: { protocolo: string; por: string; motivo: string }): Promise<void> {
  const por = exigirQuem(p.por);
  const motivo = p.motivo.trim();
  if (motivo.length < 3 || motivo.length > 500) throw new Error('diga o motivo da recusa (--motivo), de 3 a 500 letras: quem pediu lê este texto');
  await withSystem(db, async (tx) => {
    const pedido = await porProtocolo(tx, p.protocolo, true);
    if (!['pedido', 'conferido', 'contestado'].includes(pedido.status)) throw new Error(`o pedido ${p.protocolo} está ${pedido.status}: não dá para recusar`);
    await tx.execute(sql`
      update liame.ownership_claim
         set status = 'recusado', refusal_reason = ${motivo}, closed_at = now(),
             documents_expire_at = now() + make_interval(days => ${DIAS_DOS_DOCUMENTOS})
       where id = ${pedido.id}`);
    await auditar(tx, pedido, por, 'pessoas.propriedade_dms_recusar', { situacao_antes: pedido.status }, motivo);
  });
}
