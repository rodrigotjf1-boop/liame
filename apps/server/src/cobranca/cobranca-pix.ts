import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { type ApiAsaas, PROVIDER_ASAAS, situacaoParaGravar } from '../connectors/asaas/api-asaas.js';
import { ErroConector } from '../connectors/cliente-http.js';
import { diaNoFuso, diasEntre } from './vida.js';

// A cobrança PIX de cada fatura no Asaas (A7, W2a; `plano-a7.md` D-A7-30 e D-A7-31; `base-conhecimento.md` §18.5). O
// caminho é um só, para o worker (as faturas que nascem) e para a pessoa que pede o QR Code:
//   1. numa transação curta, a fatura é lida com o que a cobrança precisa e reservada (a trava da vez: só um caminho
//      cria a cobrança de cada fatura);
//   2. sem transação aberta, o Asaas: o cliente da empresa (procurado pelo id dela antes de criar) e a cobrança
//      (procurada pelo id da fatura antes de criar). A API não tem chave de idempotência; procurar antes é o que
//      impede a cobrança em dobro quando a vez anterior caiu depois de criar;
//   3. numa transação curta, a referência é gravada e a trava sai.
// Quem chama dá a transação (a da empresa, na rota; a do sistema, no worker) e o relógio.

/** Quanto a trava da vez segura a fatura (se o processo cair no meio, a próxima vez procura antes de criar). */
export const TRAVA_DA_COBRANCA_MS = 2 * 60_000;

export type Transacao = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/** O porquê da falha, em código (a coluna `charge_error`). */
export type FalhaDaCobranca = 'sem_cnpj' | 'meio_fora_do_ar' | 'limite_do_meio' | 'chave_recusada' | 'recusada_pelo_meio';

/** A cobrança no Asaas, com o valor e o vencimento da fatura do Liame (o vencimento do Asaas pode ser outro: a atrasada vai vencendo hoje). */
export type CobrancaPronta = { id: string; url: string | null; status: string; valorCentavos: number; vencimento: string };

export type ResultadoDaCobranca =
  | { situacao: 'pronta'; cobranca: CobrancaPronta }
  | { situacao: 'em_criacao' }
  | { situacao: 'sem_cnpj' }
  | { situacao: 'nao_cobravel'; motivo: 'nao_existe' | 'nao_aberta' | 'nao_pix' }
  | { situacao: 'falhou'; falha: FalhaDaCobranca; esperarMs: number };

type LinhaDaFatura = {
  id: string;
  tenant_id: string;
  status: string;
  amount_cents: string;
  due_date: string;
  period_start: string | null;
  period_end: string | null;
  external_id: string | null;
  provider_url: string | null;
  provider_status: string | null;
  charge_locked_until: Date | string | null;
  charge_attempts: number;
  method: string;
  plan_name: string;
  empresa: string;
  cnpj: string | null;
  timezone: string;
  cliente: string | null;
};

const dataBr = (dia: string): string => `${dia.slice(8, 10)}/${dia.slice(5, 7)}/${dia.slice(0, 4)}`;

/** O texto da cobrança no Asaas (até 500 letras): o plano e o período, ou a primeira mensalidade. */
export function descricaoDaCobranca(plano: string, inicio: string | null, fim: string | null): string {
  const periodo = inicio && fim ? `${dataBr(inicio)} a ${dataBr(fim)}` : 'primeira mensalidade';
  return `Liame · plano ${plano} · ${periodo}`;
}

/**
 * Quanto esperar antes de tentar de novo, pela vez (1 minuto, 5, 30 e, daí em diante, 2 horas) ou pelo que o Asaas
 * pediu, quando ele pediu (o 429 com o `RateLimit-Reset`).
 */
export function esperaDaCobranca(tentativas: number, pedidaMs: number | null): number {
  const degraus = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000];
  const pela = degraus[Math.min(Math.max(tentativas, 1), degraus.length) - 1]!;
  return pedidaMs && pedidaMs > pela ? pedidaMs : pela;
}

/** O erro do Asaas em código, para a fila (nunca o texto). */
export function falhaDoErro(err: unknown): FalhaDaCobranca {
  if (!(err instanceof ErroConector)) return 'meio_fora_do_ar';
  if (err.tipo === 'limite') return 'limite_do_meio';
  if (err.tipo === 'autenticacao' || err.tipo === 'permissao') return 'chave_recusada';
  if (err.tipo === 'definitivo') return 'recusada_pelo_meio';
  return 'meio_fora_do_ar';
}

async function lerFatura(tx: Tx, faturaId: string): Promise<LinhaDaFatura | null> {
  const r = await tx.execute<LinhaDaFatura>(sql`
    select i.id, i.tenant_id, i.status, i.amount_cents::text as amount_cents, i.due_date::text as due_date,
           i.period_start::text as period_start, i.period_end::text as period_end, i.external_id, i.provider_url,
           i.provider_status, i.charge_locked_until, i.charge_attempts, s.method, p.name as plan_name, o.name as empresa,
           o.cnpj, o.timezone, c.external_id as cliente
      from liame.billing_invoice i
      join liame.subscription s on s.id = i.subscription_id
      join liame.billing_plan p on p.id = i.plan_id
      join liame.organization o on o.id = i.tenant_id
      left join liame.billing_customer c on c.tenant_id = i.tenant_id and c.provider = ${PROVIDER_ASAAS}
     where i.id = ${faturaId}
       for update of i`);
  return r.rows[0] ?? null;
}

const pronta = (f: { external_id: string; provider_url: string | null; provider_status: string | null; amount_cents: string; due_date: string }): ResultadoDaCobranca => ({
  situacao: 'pronta',
  cobranca: { id: f.external_id, url: f.provider_url, status: f.provider_status ?? 'PENDING', valorCentavos: Number(f.amount_cents), vencimento: f.due_date },
});

/** Grava a falha na fila da fatura e solta a trava. */
async function gravarFalha(tx: Tx, faturaId: string, falha: FalhaDaCobranca, tentativas: number, esperarMs: number, agora: Date): Promise<void> {
  await tx.execute(sql`
    update liame.billing_invoice
       set charge_locked_until = null, charge_attempts = ${tentativas}, charge_error = ${falha},
           charge_next_at = ${new Date(agora.getTime() + esperarMs).toISOString()}::timestamptz, updated_at = now()
     where id = ${faturaId}`);
}

/**
 * Garante a cobrança PIX da fatura no Asaas e devolve a referência dela (ou o porquê de não ter). A fatura precisa estar
 * em aberto, ser de uma assinatura no PIX e a empresa ter o CNPJ (o Asaas exige o documento do cliente).
 */
export async function garantirCobrancaPix(transacao: Transacao, api: ApiAsaas, faturaId: string, agora: Date): Promise<ResultadoDaCobranca> {
  // 1. A fatura, reservada.
  type Leitura = { tipo: 'resposta'; r: ResultadoDaCobranca } | { tipo: 'reservada'; f: LinhaDaFatura };
  const resposta = (r: ResultadoDaCobranca): Leitura => ({ tipo: 'resposta', r });
  const lida = await transacao<Leitura>(async (tx) => {
    const f = await lerFatura(tx, faturaId);
    if (!f) return resposta({ situacao: 'nao_cobravel', motivo: 'nao_existe' });
    if (f.external_id) return resposta(pronta({ ...f, external_id: f.external_id }));
    if (f.status !== 'aberta') return resposta({ situacao: 'nao_cobravel', motivo: 'nao_aberta' });
    if (f.method !== 'pix') return resposta({ situacao: 'nao_cobravel', motivo: 'nao_pix' });
    if (!f.cnpj) {
      await gravarFalha(tx, f.id, 'sem_cnpj', f.charge_attempts + 1, esperaDaCobranca(4, null), agora);
      return resposta({ situacao: 'sem_cnpj' });
    }
    if (f.charge_locked_until && new Date(f.charge_locked_until).getTime() > agora.getTime()) return resposta({ situacao: 'em_criacao' });
    await tx.execute(sql`
      update liame.billing_invoice
         set charge_locked_until = ${new Date(agora.getTime() + TRAVA_DA_COBRANCA_MS).toISOString()}::timestamptz, updated_at = now()
       where id = ${f.id}`);
    return { tipo: 'reservada', f };
  });
  if (lida.tipo === 'resposta') return lida.r;
  const f = lida.f;

  // 2. O Asaas, sem transação aberta.
  let cliente = f.cliente;
  let cobranca;
  try {
    if (!cliente) {
      const achado = await api.clientePelaReferencia(f.tenant_id);
      cliente = (achado ?? (await api.criarCliente({ nome: f.empresa, cnpj: f.cnpj as string, referencia: f.tenant_id }))).id;
    }
    const hoje = diaNoFuso(agora, f.timezone);
    cobranca =
      (await api.cobrancaPelaReferencia(f.id)) ??
      (await api.criarCobrancaPix({
        cliente,
        valorCentavos: Number(f.amount_cents),
        // A fatura atrasada vai ao Asaas vencendo hoje: ele não cria cobrança com vencimento no passado [NC].
        vencimento: diasEntre(f.due_date, hoje) > 0 ? hoje : f.due_date,
        descricao: descricaoDaCobranca(f.plan_name, f.period_start, f.period_end),
        referencia: f.id,
      }));
  } catch (err) {
    const falha = falhaDoErro(err);
    const tentativas = f.charge_attempts + 1;
    const esperarMs = esperaDaCobranca(tentativas, err instanceof ErroConector ? err.esperarMs : null);
    await transacao(async (tx) => {
      // O cliente achado ou criado antes da falha fica guardado: a próxima vez não o procura de novo.
      if (cliente && !f.cliente) await gravarCliente(tx, f.tenant_id, cliente);
      await gravarFalha(tx, f.id, falha, tentativas, esperarMs, agora);
    });
    return { situacao: 'falhou', falha, esperarMs };
  }

  // 3. A referência, gravada.
  const final = cobranca;
  await transacao(async (tx) => {
    if (!f.cliente) await gravarCliente(tx, f.tenant_id, cliente);
    await tx.execute(sql`
      update liame.billing_invoice
         set provider = ${PROVIDER_ASAAS}, external_id = ${final.id}, provider_url = ${final.urlDaFatura}, provider_status = ${situacaoParaGravar(final.status)},
             charge_locked_until = null, charge_error = null, charge_next_at = null, updated_at = now()
       where id = ${f.id} and external_id is null`);
  });
  return {
    situacao: 'pronta',
    cobranca: { id: final.id, url: final.urlDaFatura, status: final.status, valorCentavos: Number(f.amount_cents), vencimento: f.due_date },
  };
}

/** O cliente da empresa no Asaas, uma vez só (o primeiro que gravou vence). */
async function gravarCliente(tx: Tx, tenantId: string, externalId: string): Promise<void> {
  await tx.execute(sql`
    insert into liame.billing_customer (tenant_id, provider, external_id) values (${tenantId}, ${PROVIDER_ASAAS}, ${externalId})
    on conflict do nothing`);
}
