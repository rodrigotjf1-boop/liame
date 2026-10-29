import type { Tx } from '@liame/database';
import { type SQL, sql } from 'drizzle-orm';
import { type ApiAsaas, type CobrancaAsaas, PROVIDER_ASAAS, situacaoParaGravar } from '../connectors/asaas/api-asaas.js';
import { ErroConector } from '../connectors/cliente-http.js';
import { devolverFatura, pagarFatura } from './assinatura.js';
import { DESCRICAO_DO_ESTORNO, type DecisaoDaDevolucao, decidirDevolucao, type ProblemaDaDevolucao } from './devolucao.js';
import {
  type DecisaoDaReleitura,
  decidirReleitura,
  type ProblemaDaReleitura,
  pagoEmDaCobranca,
  RELEITURA_DIARIA_MS,
  SITUACAO_REMOVIDA,
  SITUACOES_PAGAS,
} from './releitura.js';
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
  /** A próxima vez como estava na leitura, em microssegundos (texto): é por ela que se sabe se um aviso a mudou depois. */
  charge_next_us: string | null;
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
           i.provider_status, i.charge_locked_until, i.charge_attempts,
           (extract(epoch from i.charge_next_at) * 1000000)::bigint::text as charge_next_us, s.method, p.name as plan_name, o.name as empresa,
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

/**
 * A próxima vez da fila, só se ninguém a mudou enquanto esta vez falava com o Asaas (V49): o aviso que chega no meio marca
 * a fatura para reler agora, e quem termina a vez não pode apagar essa marca com a releitura do dia seguinte. A comparação
 * é pelo carimbo em microssegundos, exato (o `Date` do JavaScript perde os microssegundos).
 */
function proximaSeNinguemMudou(lido: string | null, proxima: Date): SQL {
  return sql`case when (extract(epoch from charge_next_at) * 1000000)::bigint is not distinct from ${lido}::bigint
                  then ${proxima.toISOString()}::timestamptz else charge_next_at end`;
}

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

  // 3. A referência, gravada. Daí em diante, a fila é a da releitura (W2a, parte 2): no dia seguinte, ou na hora, se a
  // cobrança achada já está paga (a vez anterior caiu depois de criar, e o cliente pagou) ou se chegou um aviso no meio.
  const final = cobranca;
  const proxima = SITUACOES_PAGAS.has(final.status) ? agora : new Date(agora.getTime() + RELEITURA_DIARIA_MS);
  await transacao(async (tx) => {
    if (!f.cliente) await gravarCliente(tx, f.tenant_id, cliente);
    await tx.execute(sql`
      update liame.billing_invoice
         set provider = ${PROVIDER_ASAAS}, external_id = ${final.id}, provider_url = ${final.urlDaFatura}, provider_status = ${situacaoParaGravar(final.status)},
             charge_locked_until = null, charge_error = null, charge_attempts = 0,
             charge_next_at = ${proximaSeNinguemMudou(f.charge_next_us, proxima)}, updated_at = now()
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

// ------------------------------------------------------------ a releitura (W2a, parte 2; D-A7-28 a D-A7-30)

export type ResultadoDaReleitura =
  | { situacao: 'paga' }
  | { situacao: 'esperando' }
  | { situacao: 'refeita' }
  | { situacao: 'removida' }
  | { situacao: 'encerrada' }
  | { situacao: 'parada'; problema: ProblemaDaReleitura }
  | { situacao: 'em_uso' }
  | { situacao: 'fora_da_fila' }
  | { situacao: 'falhou'; falha: FalhaDaCobranca; esperarMs: number };

type LinhaDaReleitura = {
  id: string;
  status: string;
  amount_cents: string;
  provider: string | null;
  external_id: string | null;
  charge_locked_until: Date | string | null;
  charge_attempts: number;
  charge_next_us: string | null;
};

/**
 * Relê a cobrança de uma fatura no Asaas e faz o que a conta de `decidirReleitura` disser, com a mesma trava da vez da
 * criação (o aviso, a rotina diária e a rota do QR Code nunca mexem na mesma fatura ao mesmo tempo):
 *   1. numa transação curta, a fatura é lida e reservada (só ela é travada: nada de assinatura aqui);
 *   2. sem transação aberta, a cobrança é lida no Asaas e, se a decisão manda, removida lá;
 *   3. noutra transação curta, o resultado é gravado. O pagamento entra pelo `pagarFatura`, que trava a assinatura antes
 *      das faturas, como todo caminho da cobrança: por isso nenhuma trava de fatura vem antes dele.
 * Quem chama dá a transação (a do sistema, no worker) e o relógio.
 */
export async function relerCobranca(transacao: Transacao, api: ApiAsaas, faturaId: string, agora: Date): Promise<ResultadoDaReleitura> {
  type Leitura = { tipo: 'resposta'; r: ResultadoDaReleitura } | { tipo: 'reservada'; f: LinhaDaReleitura; externo: string };
  const lida = await transacao<Leitura>(async (tx) => {
    const f = (
      await tx.execute<LinhaDaReleitura>(sql`
        select id, status, amount_cents::text as amount_cents, provider, external_id, charge_locked_until, charge_attempts,
               (extract(epoch from charge_next_at) * 1000000)::bigint::text as charge_next_us
          from liame.billing_invoice where id = ${faturaId} for update`)
    ).rows[0];
    // Sem a cobrança (outra vez acabou de refazê-la): a fila da criação é quem cuida dela agora.
    if (!f || f.provider !== PROVIDER_ASAAS || !f.external_id) return { tipo: 'resposta', r: { situacao: 'fora_da_fila' } };
    if (f.charge_locked_until && new Date(f.charge_locked_until).getTime() > agora.getTime()) return { tipo: 'resposta', r: { situacao: 'em_uso' } };
    await tx.execute(sql`
      update liame.billing_invoice
         set charge_locked_until = ${new Date(agora.getTime() + TRAVA_DA_COBRANCA_MS).toISOString()}::timestamptz, updated_at = now()
       where id = ${f.id}`);
    return { tipo: 'reservada', f, externo: f.external_id };
  });
  if (lida.tipo === 'resposta') return lida.r;
  const { f, externo } = lida;

  // 2. O Asaas, sem transação aberta.
  let cobranca: CobrancaAsaas | null;
  let decisao: DecisaoDaReleitura;
  try {
    cobranca = await api.lerCobranca(externo);
    decisao = decidirReleitura(f, cobranca);
    if (decisao.acao === 'remover' || (decisao.acao === 'refazer' && decisao.removerAntes)) await api.removerCobranca(externo);
  } catch (err) {
    const falha = falhaDoErro(err);
    const tentativas = f.charge_attempts + 1;
    const esperarMs = esperaDaCobranca(tentativas, err instanceof ErroConector ? err.esperarMs : null);
    await transacao((tx) => gravarFalha(tx, f.id, falha, tentativas, esperarMs, agora));
    return { situacao: 'falhou', falha, esperarMs };
  }

  // 3. O resultado, gravado.
  const situacao = cobranca ? situacaoParaGravar(cobranca.status) : null;
  const url = cobranca?.urlDaFatura ?? null;
  return transacao<ResultadoDaReleitura>(async (tx) => {
    const fim = sql`charge_locked_until = null, charge_error = null, charge_attempts = 0, updated_at = now()`;
    switch (decisao.acao) {
      case 'pagar': {
        const r = await pagarFatura(tx, { faturaId: f.id, pagoEm: pagoEmDaCobranca(decisao.pagoNoDia, agora), forma: 'pix', agora });
        if (r.situacao === 'paga' || r.situacao === 'ja_paga') {
          await tx.execute(sql`update liame.billing_invoice set provider_status = ${situacao}, charge_next_at = null, ${fim} where id = ${f.id}`);
          return { situacao: 'paga' };
        }
        // A fatura mudou entre a reserva e agora (cancelada no Liame): a próxima vez decide com a situação nova.
        await tx.execute(sql`update liame.billing_invoice set charge_next_at = ${agora.toISOString()}::timestamptz, ${fim} where id = ${f.id}`);
        return { situacao: 'esperando' };
      }
      case 'esperar':
        await tx.execute(sql`
          update liame.billing_invoice
             set provider_status = ${situacao}, provider_url = coalesce(${url}, provider_url),
                 charge_next_at = ${proximaSeNinguemMudou(f.charge_next_us, new Date(agora.getTime() + RELEITURA_DIARIA_MS))}, ${fim}
           where id = ${f.id}`);
        return { situacao: 'esperando' };
      case 'refazer':
        // A referência sai (as duas colunas juntas, como a 0080 exige) e a fila da criação faz a cobrança nova na hora.
        await tx.execute(sql`
          update liame.billing_invoice
             set provider = null, external_id = null, provider_url = null, provider_status = null,
                 charge_next_at = ${agora.toISOString()}::timestamptz, ${fim}
           where id = ${f.id} and external_id = ${externo}`);
        return { situacao: 'refeita' };
      case 'remover':
        await tx.execute(sql`update liame.billing_invoice set provider_status = ${SITUACAO_REMOVIDA}, charge_next_at = null, ${fim} where id = ${f.id}`);
        return { situacao: 'removida' };
      case 'encerrar':
        await tx.execute(sql`
          update liame.billing_invoice
             set provider_status = ${cobranca && !cobranca.removida ? situacao : SITUACAO_REMOVIDA}, charge_next_at = null, ${fim}
           where id = ${f.id}`);
        return { situacao: 'encerrada' };
      case 'parar':
        await tx.execute(sql`
          update liame.billing_invoice
             set provider_status = coalesce(${situacao}, provider_status), charge_next_at = null, charge_locked_until = null,
                 charge_error = ${decisao.problema}, updated_at = now()
           where id = ${f.id}`);
        return { situacao: 'parada', problema: decisao.problema };
    }
  });
}

// ------------------------------------------------------------ a devolução (W2a, parte 3b; D-A7-19, D-A7-29, D-A7-35 a D-A7-37)

/** Depois de pedir o estorno: a confirmação costuma vir pelo aviso; sem ele, a releitura em meia hora. */
export const RELEITURA_DEPOIS_DO_PEDIDO_MS = 30 * 60_000;
/** O estorno em andamento: o aviso traz a mudança; sem ele, a releitura a cada 6 horas (o cartão leva dias). */
export const RELEITURA_DO_ESTORNO_MS = 6 * 3_600_000;
/** O estorno que espera uma autorização fora do Liame: a releitura uma vez por dia, com o chamado à distribuição. */
export const RELEITURA_DA_AUTORIZACAO_MS = 24 * 3_600_000;

export type ResultadoDaDevolucao =
  | { situacao: 'devolvida' }
  /** O estorno foi pedido agora ao Asaas, e ainda não está feito. `autorizacao`: ele já nasceu esperando alguém fora do Liame. */
  | { situacao: 'pedida'; autorizacao: boolean }
  | { situacao: 'esperando'; autorizacao: boolean }
  | { situacao: 'parada'; problema: ProblemaDaDevolucao }
  | { situacao: 'em_uso' }
  | { situacao: 'fora_da_fila' }
  | { situacao: 'falhou'; falha: FalhaDaCobranca; esperarMs: number };

type LinhaDaDevolucao = {
  id: string;
  status: string;
  provider: string | null;
  external_id: string | null;
  refund_requested_at: Date | string | null;
  charge_locked_until: Date | string | null;
  charge_attempts: number;
  charge_next_us: string | null;
};

/**
 * Devolve o que foi pago numa fatura com a devolução pedida (a desistência em 7 dias), com a mesma trava da vez da criação
 * e da releitura:
 *   1. numa transação curta, a fatura é lida e reservada;
 *   2. sem transação aberta, a cobrança é lida no Asaas e, só se não há estorno feito nem em andamento, o estorno é pedido
 *      (uma vez por vez: a resposta é decidida de novo, e o que ainda falta espera a próxima leitura);
 *   3. noutra transação curta, o resultado é gravado: o estorno feito vira a fatura devolvida (`devolverFatura`).
 * Quem chama dá a transação (a do sistema, no worker) e o relógio.
 */
export async function devolverCobranca(transacao: Transacao, api: ApiAsaas, faturaId: string, agora: Date): Promise<ResultadoDaDevolucao> {
  type Leitura = { tipo: 'resposta'; r: ResultadoDaDevolucao } | { tipo: 'reservada'; f: LinhaDaDevolucao; externo: string };
  const lida = await transacao<Leitura>(async (tx) => {
    const f = (
      await tx.execute<LinhaDaDevolucao>(sql`
        select id, status, provider, external_id, refund_requested_at, charge_locked_until, charge_attempts,
               (extract(epoch from charge_next_at) * 1000000)::bigint::text as charge_next_us
          from liame.billing_invoice where id = ${faturaId} for update`)
    ).rows[0];
    if (!f || f.status !== 'paga' || !f.refund_requested_at) return { tipo: 'resposta', r: { situacao: 'fora_da_fila' } };
    if (f.provider !== PROVIDER_ASAAS || !f.external_id) {
      await tx.execute(sql`
        update liame.billing_invoice
           set charge_error = 'devolucao_sem_cobranca', charge_next_at = null, charge_locked_until = null, updated_at = now()
         where id = ${f.id}`);
      return { tipo: 'resposta', r: { situacao: 'parada', problema: 'devolucao_sem_cobranca' } };
    }
    if (f.charge_locked_until && new Date(f.charge_locked_until).getTime() > agora.getTime()) return { tipo: 'resposta', r: { situacao: 'em_uso' } };
    await tx.execute(sql`
      update liame.billing_invoice
         set charge_locked_until = ${new Date(agora.getTime() + TRAVA_DA_COBRANCA_MS).toISOString()}::timestamptz, updated_at = now()
       where id = ${f.id}`);
    return { tipo: 'reservada', f, externo: f.external_id };
  });
  if (lida.tipo === 'resposta') return lida.r;
  const { f, externo } = lida;

  // 2. O Asaas, sem transação aberta.
  let cobranca: CobrancaAsaas | null;
  let decisao: DecisaoDaDevolucao;
  let pedida = false;
  try {
    cobranca = await api.lerCobranca(externo);
    decisao = decidirDevolucao(cobranca);
    if (decisao.acao === 'pedir') {
      cobranca = await api.estornarCobranca(externo, { valorCentavos: decisao.valorCentavos, descricao: DESCRICAO_DO_ESTORNO });
      pedida = true;
      decisao = decidirDevolucao(cobranca);
      // Um pedido por vez: se a resposta ainda não mostra o estorno, a próxima leitura decide (nunca um segundo pedido aqui).
      if (decisao.acao === 'pedir') decisao = { acao: 'esperar', autorizacao: false };
    }
  } catch (err) {
    // Pedido sem resposta conta como talvez feito: a próxima vez relê antes de pedir de novo. A falha do Asaas (fora do ar,
    // limite, saldo que falta no PIX logo depois do recebimento) espera e tenta de novo, com o porquê em código.
    const falha = falhaDoErro(err);
    const tentativas = f.charge_attempts + 1;
    const esperarMs = esperaDaCobranca(tentativas, err instanceof ErroConector ? err.esperarMs : null);
    await transacao((tx) => gravarFalha(tx, f.id, falha, tentativas, esperarMs, agora));
    return { situacao: 'falhou', falha, esperarMs };
  }

  // 3. O resultado, gravado.
  const situacao = cobranca ? situacaoParaGravar(cobranca.status) : null;
  return transacao<ResultadoDaDevolucao>(async (tx) => {
    const fim = sql`charge_locked_until = null, charge_error = null, charge_attempts = 0, updated_at = now()`;
    switch (decisao.acao) {
      case 'concluir': {
        await devolverFatura(tx, { faturaId: f.id, agora });
        await tx.execute(sql`update liame.billing_invoice set provider_status = coalesce(${situacao}, provider_status), charge_next_at = null, ${fim} where id = ${f.id}`);
        return { situacao: 'devolvida' };
      }
      case 'esperar': {
        const autorizacao = decisao.autorizacao;
        const espera = autorizacao ? RELEITURA_DA_AUTORIZACAO_MS : pedida ? RELEITURA_DEPOIS_DO_PEDIDO_MS : RELEITURA_DO_ESTORNO_MS;
        await tx.execute(sql`
          update liame.billing_invoice
             set provider_status = coalesce(${situacao}, provider_status),
                 charge_next_at = ${proximaSeNinguemMudou(f.charge_next_us, new Date(agora.getTime() + espera))}, ${fim}
           where id = ${f.id}`);
        return pedida ? { situacao: 'pedida', autorizacao } : { situacao: 'esperando', autorizacao };
      }
      case 'parar':
        await tx.execute(sql`
          update liame.billing_invoice
             set provider_status = coalesce(${situacao}, provider_status), charge_next_at = null, charge_locked_until = null,
                 charge_error = ${decisao.problema}, updated_at = now()
           where id = ${f.id}`);
        return { situacao: 'parada', problema: decisao.problema };
    }
  });
}
