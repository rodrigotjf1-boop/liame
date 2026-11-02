import type { KeyObject } from 'node:crypto';
import { type Db, type Tx, withSystem } from '@liame/database';
import { sql } from 'drizzle-orm';
import { writeAudit } from '../../audit/audit.js';
import { abrir } from './lacre.js';
import { DIAS_DE_ESPERA, DIAS_DOS_DOCUMENTOS, type EmpresaDoPedido } from './recuperacao.service.js';

// O lado da DMS na recuperação da conta do Dono (A7, W8, parte 4a; D-A7-62, D-A7-64; D-A7-85): o comando da
// distribuição (`scripts/recuperacao-da-conta.ts`) lista os pedidos, abre o documento com a chave PRIVADA da DMS (que
// nunca vai ao servidor), e grava a conferência ou a recusa. Roda no escopo de sistema, com o papel dono do banco
// informado só na hora. A auditoria de cada empresa de que a pessoa é a dona guarda o que a DMS conferiu e quem decidiu,
// sem a imagem. O e-mail de cada decisão sai pelo worker (parte 4b), que tem o envio: o comando não manda e-mail.

export type PedidoNaDistribuicao = {
  id: string;
  protocol: string;
  status: string;
  reason: string;
  created_at: Date;
  checked_at: Date | null;
  applies_at: Date | null;
  pessoa: { name: string; email: string };
  companies: EmpresaDoPedido[];
  documentos: number;
};

type Linha = Omit<PedidoNaDistribuicao, 'pessoa' | 'companies' | 'created_at' | 'checked_at' | 'applies_at'> & {
  name: string;
  email: string;
  companies: EmpresaDoPedido[] | string;
  created_at: Date | string;
  checked_at: Date | string | null;
  applies_at: Date | string | null;
};

const data = (v: Date | string | null): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v));

function doBanco(r: Linha): PedidoNaDistribuicao {
  return {
    id: r.id,
    protocol: r.protocol,
    status: r.status,
    reason: r.reason,
    created_at: data(r.created_at)!,
    checked_at: data(r.checked_at),
    applies_at: data(r.applies_at),
    pessoa: { name: r.name, email: r.email },
    companies: typeof r.companies === 'string' ? (JSON.parse(r.companies) as EmpresaDoPedido[]) : r.companies,
    documentos: Number(r.documentos),
  };
}

const SELECAO = sql`
  select r.id, r.protocol, r.status, r.reason, r.created_at, r.checked_at, r.applies_at, r.companies, u.name, u.email,
         (select count(*) from liame.account_recovery_document d where d.recovery_id = r.id) as documentos
    from liame.account_recovery r join liame.app_user u on u.id = r.user_id`;

/** Os pedidos em andamento (ou todos os dos últimos 60 dias, com `todos`). */
export async function listarPedidos(db: Db, opcoes: { todos?: boolean } = {}): Promise<PedidoNaDistribuicao[]> {
  return withSystem(db, async (tx) => {
    const filtro = opcoes.todos ? sql`r.created_at > now() - interval '60 days'` : sql`r.status in ('pedido', 'conferido', 'parado')`;
    const r = await tx.execute<Linha>(sql`${SELECAO} where ${filtro} order by r.created_at`);
    return r.rows.map(doBanco);
  });
}

async function pedidoPorProtocolo(tx: Tx, protocolo: string, travar = false): Promise<PedidoNaDistribuicao> {
  const r = await tx.execute<Linha>(sql`${SELECAO} where r.protocol = ${protocolo} ${travar ? sql`for update of r` : sql``}`);
  const linha = r.rows[0];
  if (!linha) throw new Error(`o pedido ${protocolo} não existe`);
  return doBanco(linha);
}

/** O pedido e os documentos abertos com a chave privada da DMS (para conferir; o comando grava numa pasta e avisa para apagar). */
export async function abrirDocumentos(
  db: Db,
  protocolo: string,
  privada: KeyObject,
): Promise<{ pedido: PedidoNaDistribuicao; arquivos: { media_type: string; bytes: Buffer }[] }> {
  return withSystem(db, async (tx) => {
    const pedido = await pedidoPorProtocolo(tx, protocolo);
    const docs = await tx.execute<{ media_type: string; key_id: string; wrapped_key: Buffer; iv: Buffer; tag: Buffer; ciphertext: Buffer }>(sql`
      select media_type, key_id, wrapped_key, iv, tag, ciphertext from liame.account_recovery_document
       where recovery_id = ${pedido.id} order by created_at`);
    const arquivos = docs.rows.map((d) => ({
      media_type: d.media_type,
      bytes: abrir(privada, { keyId: d.key_id, wrappedKey: d.wrapped_key, iv: d.iv, tag: d.tag, ciphertext: d.ciphertext }),
    }));
    return { pedido, arquivos };
  });
}

function exigirQuem(por: string): string {
  const quem = por.trim();
  if (quem.length < 2 || quem.length > 80) throw new Error('diga quem decidiu (--por), de 2 a 80 letras');
  return quem;
}

/** O autor das decisões da DMS na auditoria. */
const daDms = (por: string) => ({ quem: `Distribuição DMS (${por})`, origem: 'console' as const });

/**
 * A auditoria de uma decisão sobre o pedido em cada empresa (viva) de que a pessoa era a dona; sem nenhuma, na cadeia do
 * sistema. A DMS (pelo comando) e a rotina do worker (a troca no fim da espera) gravam por aqui.
 */
export async function auditarNasEmpresas(
  tx: Tx,
  pedido: { id: string; protocol: string; companies: readonly EmpresaDoPedido[] },
  p: { quem: string; origem: 'console' | 'worker'; action: string; after: Record<string, unknown>; reason?: string | null },
): Promise<void> {
  const ids = pedido.companies.map((c) => c.tenant_id);
  const vivas = ids.length
    ? (await tx.execute<{ id: string }>(sql`select id from liame.organization where id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`)).rows.map((o) => o.id)
    : [];
  const base = {
    actorType: 'system' as const,
    actorId: null,
    actorLabel: p.quem,
    action: p.action,
    resourceType: 'account_recovery',
    resourceId: pedido.id,
    after: { protocolo: pedido.protocol, ...p.after },
    reason: p.reason ?? null,
    origin: p.origem,
  };
  if (!vivas.length) {
    await writeAudit(tx, { ...base, tenantId: null });
    return;
  }
  for (const tenantId of vivas) await writeAudit(tx, { ...base, tenantId });
}

/**
 * A DMS conferiu: o documento, o nome no quadro de sócios pelo CNPJ e a videochamada (os três, D-A7-62). Começa a espera
 * de 7 dias; os documentos saem 30 dias depois desta decisão.
 */
export async function conferirPedido(
  db: Db,
  p: { protocolo: string; por: string; documento: boolean; socios: boolean; videochamada: boolean },
): Promise<{ appliesAt: Date }> {
  const por = exigirQuem(p.por);
  if (!p.documento || !p.socios || !p.videochamada) {
    throw new Error('a conferência precisa dos três: o documento (--documento), o quadro de sócios (--socios) e a videochamada (--videochamada)');
  }
  return withSystem(db, async (tx) => {
    const pedido = await pedidoPorProtocolo(tx, p.protocolo, true);
    if (pedido.status !== 'pedido') throw new Error(`o pedido ${p.protocolo} está ${pedido.status}: só se confere o que está pedido`);
    const r = await tx.execute<{ applies_at: Date | string }>(sql`
      update liame.account_recovery
         set status = 'conferido', checked_at = now(), checked_by = ${por},
             checks = ${JSON.stringify({ documento: true, socios: true, videochamada: true })}::jsonb,
             applies_at = now() + make_interval(days => ${DIAS_DE_ESPERA}),
             documents_expire_at = now() + make_interval(days => ${DIAS_DOS_DOCUMENTOS})
       where id = ${pedido.id}
       returning applies_at`);
    const appliesAt = data(r.rows[0]!.applies_at)!;
    await auditarNasEmpresas(tx, pedido, {
      ...daDms(por),
      action: 'segundo_fator.recuperacao_conferir',
      after: { documento: true, socios: true, videochamada: true, aplica_em: appliesAt.toISOString() },
    });
    return { appliesAt };
  });
}

/**
 * A DMS retoma o pedido que um Administrador parou, depois de falar com o Dono pelo e-mail e pelo telefone cadastrados
 * (D-A7-64): a espera de 7 dias recomeça agora, com aviso de novo ao Dono e aos Administradores.
 */
export async function retomarPedido(db: Db, p: { protocolo: string; por: string; motivo: string }): Promise<{ appliesAt: Date }> {
  const por = exigirQuem(p.por);
  const motivo = p.motivo.trim();
  if (motivo.length < 5 || motivo.length > 200) throw new Error('diga como a DMS confirmou com o Dono (--motivo), de 5 a 200 letras');
  return withSystem(db, async (tx) => {
    const pedido = await pedidoPorProtocolo(tx, p.protocolo, true);
    if (pedido.status !== 'parado') throw new Error(`o pedido ${p.protocolo} está ${pedido.status}: só se retoma o que foi parado`);
    const r = await tx.execute<{ applies_at: Date | string }>(sql`
      update liame.account_recovery
         set status = 'conferido', applies_at = now() + make_interval(days => ${DIAS_DE_ESPERA})
       where id = ${pedido.id}
       returning applies_at`);
    const appliesAt = data(r.rows[0]!.applies_at)!;
    await auditarNasEmpresas(tx, pedido, { ...daDms(por), action: 'segundo_fator.recuperacao_retomar', after: { aplica_em: appliesAt.toISOString() }, reason: motivo });
    return { appliesAt };
  });
}

/** A DMS recusou, com o motivo que a pessoa lê. Vale para o pedido ainda não conferido e para o parado. */
export async function recusarPedido(db: Db, p: { protocolo: string; por: string; motivo: string }): Promise<void> {
  const por = exigirQuem(p.por);
  const motivo = p.motivo.trim();
  if (motivo.length < 3 || motivo.length > 500) throw new Error('diga o motivo da recusa (--motivo), de 3 a 500 letras: a pessoa lê este texto');
  await withSystem(db, async (tx) => {
    const pedido = await pedidoPorProtocolo(tx, p.protocolo, true);
    if (pedido.status !== 'pedido' && pedido.status !== 'parado') throw new Error(`o pedido ${p.protocolo} está ${pedido.status}: não dá para recusar`);
    await tx.execute(sql`
      update liame.account_recovery
         set status = 'recusado', refusal_reason = ${motivo}, closed_at = now(),
             documents_expire_at = now() + make_interval(days => ${DIAS_DOS_DOCUMENTOS})
       where id = ${pedido.id}`);
    await auditarNasEmpresas(tx, pedido, { ...daDms(por), action: 'segundo_fator.recuperacao_recusar', after: { situacao_antes: pedido.status }, reason: motivo });
  });
}
