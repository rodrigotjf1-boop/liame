import type { BillingInvoice, BillingPlan, BillingResponse, BrandSubscription } from '@liame/contracts';
import { type Tx, uuidv7 } from '@liame/database';
import { sql } from 'drizzle-orm';
import { writeAudit } from '../audit/audit.js';
import { protocoloDaDesistencia } from './confirmacao-da-desistencia.js';
import {
  DIAS_DA_FATURA_ANTES,
  DIAS_PARA_O_PRIMEIRO_PAGAMENTO,
  diaDoMes,
  diaNoFuso,
  diasEntre,
  diferencaDoPlano,
  MINIMO_DA_COBRANCA_CENTAVOS,
  passosDoAtraso,
  proximoVencimento,
  situacaoPeloAtraso,
  somarDias,
  ultimoDiaParaDesistir,
} from './vida.js';

// A assinatura no banco (A7, W1; `plano-a7.md` D-A7-6, D-A7-16 a D-A7-19 e D-A7-20 a D-A7-26): o que muda a assinatura e
// as faturas, sempre na transação de quem chama (a da requisição, a da rotina do worker ou, na W2, a do aviso do meio de
// pagamento). As contas de data são as de `vida.ts`, sobre o dia do calendário da empresa; o relógio é o de quem chama
// (V34). Nada aqui confere permissão nem a função `cobranca`: isso é de quem chama.

/** A função que liga Plano e cobrança por empresa (migration 0080); nasce desligada. */
export const FLAG_COBRANCA = 'cobranca';

export type Forma = 'cartao' | 'pix' | 'pix_automatico';
export type MotivoDoFim = 'cancelada' | 'desistencia' | 'nao_paga' | 'substituida';

/** Quantos períodos a rotina anda numa vez só (o worker parado por meses não trava a assinatura num laço sem fim). */
const PERIODOS_POR_VEZ = 24;
/** As faturas na tela: até 36 (três anos de mensalidades). */
export const FATURAS_NA_TELA = 36;

const ROTULO_DA_ROTINA = 'Liame (cobrança)';

export type LinhaDoPlano = { id: string; key: string; version: number; name: string; price_cents: string; currency: string; agents: string[] };

export type LinhaDaAssinatura = {
  id: string;
  tenant_id: string;
  brand_id: string;
  plan_id: string;
  next_plan_id: string | null;
  status: string;
  method: string;
  anchor_day: number | null;
  period_start: string | null;
  period_end: string | null;
  first_paid_at: Date | string | null;
  withdraw_until: string | null;
  cancel_at_period_end: boolean;
  ended_at: Date | string | null;
  end_reason: string | null;
  created_at: Date | string;
  timezone: string;
};

const COLUNAS_DA_ASSINATURA = sql`s.id, s.tenant_id, s.brand_id, s.plan_id, s.next_plan_id, s.status, s.method, s.anchor_day,
  s.period_start::text as period_start, s.period_end::text as period_end, s.first_paid_at, s.withdraw_until::text as withdraw_until,
  s.cancel_at_period_end, s.ended_at, s.end_reason, s.created_at, o.timezone`;

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const isoOuNulo = (v: Date | string | null): string | null => (v === null ? null : iso(v));

/** O instante em que começa um dia do calendário da empresa (para `next_check_at`). */
const comecoDoDia = (dia: string, fuso: string) => sql`((${dia}::date)::timestamp at time zone ${fuso})`;

function paraOPlano(l: LinhaDoPlano): BillingPlan {
  return { key: l.key, version: l.version, name: l.name, price_cents: l.price_cents, currency: 'BRL', agents: l.agents };
}

/** O plano oferecido hoje com esta chave (a versão que uma assinatura nova recebe), ou nulo. */
export async function planoOferecido(tx: Tx, chave: string): Promise<LinhaDoPlano | null> {
  const r = await tx.execute<LinhaDoPlano>(sql`
    select id, key, version, name, price_cents::text as price_cents, currency, agents
      from liame.billing_plan where key = ${chave} and offered`);
  return r.rows[0] ?? null;
}

/** Os planos oferecidos, na ordem da tela. */
export async function planosOferecidos(tx: Tx): Promise<BillingPlan[]> {
  const r = await tx.execute<LinhaDoPlano>(sql`
    select id, key, version, name, price_cents::text as price_cents, currency, agents
      from liame.billing_plan where offered order by sort, key`);
  return r.rows.map(paraOPlano);
}

async function planoPeloId(tx: Tx, id: string): Promise<LinhaDoPlano> {
  const r = await tx.execute<LinhaDoPlano>(sql`
    select id, key, version, name, price_cents::text as price_cents, currency, agents from liame.billing_plan where id = ${id}`);
  const l = r.rows[0];
  if (!l) throw new Error(`cobrança: plano ${id} não existe`);
  return l;
}

/** O fuso da empresa (o da organização). */
export async function fusoDaEmpresa(tx: Tx, tenantId: string): Promise<string> {
  const r = await tx.execute<{ timezone: string }>(sql`select timezone from liame.organization where id = ${tenantId}`);
  const l = r.rows[0];
  if (!l) throw new Error('cobrança: empresa não encontrada no contexto');
  return l.timezone;
}

/** A assinatura viva da marca, travada para mudar (`for update`), ou nula. */
export async function assinaturaVivaTravada(tx: Tx, brandId: string): Promise<LinhaDaAssinatura | null> {
  const r = await tx.execute<LinhaDaAssinatura>(sql`
    select ${COLUNAS_DA_ASSINATURA}
      from liame.subscription s join liame.organization o on o.id = s.tenant_id
     where s.brand_id = ${brandId} and s.status <> 'encerrada'
       for update of s`);
  return r.rows[0] ?? null;
}

async function assinaturaTravadaPeloId(tx: Tx, id: string): Promise<LinhaDaAssinatura | null> {
  const r = await tx.execute<LinhaDaAssinatura>(sql`
    select ${COLUNAS_DA_ASSINATURA}
      from liame.subscription s join liame.organization o on o.id = s.tenant_id
     where s.id = ${id}
       for update of s`);
  return r.rows[0] ?? null;
}

/** O vencimento da mensalidade mais antiga em aberto que já venceu (antes de hoje), ou nulo. */
async function vencimentoEmAberto(tx: Tx, assinaturaId: string, hoje: string): Promise<string | null> {
  const r = await tx.execute<{ venc: string | null }>(sql`
    select min(due_date)::text as venc from liame.billing_invoice
     where subscription_id = ${assinaturaId} and kind = 'mensalidade' and status = 'aberta' and due_date < ${hoje}::date`);
  return r.rows[0]?.venc ?? null;
}

/**
 * A mensalidade de um período, se ainda não existe (uma por período: a repetida não entra). Vence no começo do período;
 * a que nasce atrasada (a rotina esteve parada) vence no dia em que nasce, nunca antes.
 */
async function garantirMensalidade(tx: Tx, s: LinhaDaAssinatura, inicio: string, fim: string, planoId: string, hoje: string): Promise<void> {
  const plano = await planoPeloId(tx, planoId);
  const vence = diasEntre(inicio, hoje) > 0 ? hoje : inicio;
  await tx.execute(sql`
    insert into liame.billing_invoice (id, tenant_id, brand_id, subscription_id, kind, plan_id, period_start, period_end, due_date, amount_cents)
    values (${uuidv7()}, ${s.tenant_id}, ${s.brand_id}, ${s.id}, 'mensalidade', ${plano.id}, ${inicio}::date, ${fim}::date, ${vence}::date, ${plano.price_cents}::bigint)
    on conflict do nothing`);
}

/**
 * A fatura que já tem a cobrança no meio de pagamento volta para a fila da releitura agora (W2a, parte 2): cancelada,
 * a cobrança sai de lá; com o valor novo, a cobrança velha sai e nasce outra.
 */
const relerAgora = (agora: Date) => sql`charge_next_at = case when external_id is not null then ${agora.toISOString()}::timestamptz else charge_next_at end`;

/** Cancela as faturas em aberto da assinatura que o filtro escolher (nenhuma é cobrada depois disso). */
async function cancelarFaturas(tx: Tx, assinaturaId: string, agora: Date, filtro = sql``): Promise<number> {
  const r = await tx.execute(sql`
    update liame.billing_invoice set status = 'cancelada', canceled_at = ${agora.toISOString()}::timestamptz, ${relerAgora(agora)}, updated_at = now()
     where subscription_id = ${assinaturaId} and status = 'aberta' ${filtro}`);
  return r.rowCount ?? 0;
}

/** Encerra a assinatura agora, com o porquê, e cancela as faturas em aberto. A parada da cobrança dela sai junto. */
export async function encerrar(tx: Tx, assinaturaId: string, motivo: MotivoDoFim, agora: Date): Promise<void> {
  await cancelarFaturas(tx, assinaturaId, agora);
  await tx.execute(sql`
    update liame.subscription
       set status = 'encerrada', end_reason = ${motivo}, ended_at = ${agora.toISOString()}::timestamptz, updated_at = now()
     where id = ${assinaturaId} and status <> 'encerrada'`);
  await tx.execute(sql`
    update liame.kill_switch set deactivated_at = ${agora.toISOString()}::timestamptz
     where subscription_id = ${assinaturaId} and deactivated_at is null`);
}

/** O motivo da parada da cobrança, como a empresa lê na lista das paradas e em Sua equipe. */
export const MOTIVO_DA_PARADA_DA_COBRANCA =
  'Cobrança: a mensalidade desta marca chegou ao 10º dia de atraso. As ações dos funcionários de IA voltam assim que ela for paga.';

/** As situações em que as ações da marca param (D-A7-6): do 10º dia de atraso em diante. */
export const SITUACOES_QUE_PARAM: readonly string[] = ['acoes_paradas', 'suspensa'];

/**
 * A parada da cobrança acompanha a situação da assinatura (D-A7-6, D-A7-38), na transação de quem mudou a situação:
 * do 10º dia de atraso em diante, a parada da marca, acionada pela rotina e ligada à assinatura (uma de cada vez: o
 * índice único segura a segunda volta); em dia, ou só em atraso, a parada sai, na hora. Cada mudança fica na auditoria
 * da assinatura. Devolve o que mudou.
 */
export async function acertarParadaDaCobranca(tx: Tx, s: LinhaDaAssinatura, status: string, agora: Date): Promise<'parou' | 'voltou' | 'nada'> {
  const quando = agora.toISOString();
  if (SITUACOES_QUE_PARAM.includes(status)) {
    const r = await tx.execute<{ id: string }>(sql`
      insert into liame.kill_switch (id, level, tenant_id, brand_id, reason, activated_by, activated_at, subscription_id)
      values (${uuidv7()}, 'brand', ${s.tenant_id}, ${s.brand_id}, ${MOTIVO_DA_PARADA_DA_COBRANCA}, null, ${quando}::timestamptz, ${s.id})
      on conflict do nothing
      returning id`);
    const id = r.rows[0]?.id;
    if (!id) return 'nada';
    await auditarDaRotina(tx, s, 'cobranca.parar_acoes', null, { status, parada: id });
    return 'parou';
  }
  const r = await tx.execute<{ id: string }>(sql`
    update liame.kill_switch set deactivated_at = ${quando}::timestamptz
     where subscription_id = ${s.id} and deactivated_at is null
     returning id`);
  const id = r.rows[0]?.id;
  if (!id) return 'nada';
  await auditarDaRotina(tx, s, 'cobranca.voltar_acoes', null, { status, parada: id });
  return 'voltou';
}

/** Cria a assinatura que espera o primeiro pagamento e a primeira mensalidade, vencendo hoje. */
export async function criarAssinatura(
  tx: Tx,
  p: { tenantId: string; brandId: string; planoId: string; forma: Forma; quem: string; agora: Date },
): Promise<string> {
  const fuso = await fusoDaEmpresa(tx, p.tenantId);
  const hoje = diaNoFuso(p.agora, fuso);
  const plano = await planoPeloId(tx, p.planoId);
  const id = uuidv7();
  await tx.execute(sql`
    insert into liame.subscription (id, tenant_id, brand_id, plan_id, status, method, next_check_at, created_by, created_at)
    values (${id}, ${p.tenantId}, ${p.brandId}, ${p.planoId}, 'aguardando_pagamento', ${p.forma},
            ${comecoDoDia(somarDias(hoje, DIAS_PARA_O_PRIMEIRO_PAGAMENTO), fuso)}, ${p.quem}, ${p.agora.toISOString()}::timestamptz)`);
  await tx.execute(sql`
    insert into liame.billing_invoice (id, tenant_id, brand_id, subscription_id, kind, plan_id, due_date, amount_cents)
    values (${uuidv7()}, ${p.tenantId}, ${p.brandId}, ${id}, 'mensalidade', ${p.planoId}, ${hoje}::date, ${plano.price_cents}::bigint)`);
  return id;
}

export type ResultadoDoPagamento =
  | { situacao: 'paga'; assinatura: string; status: string }
  | { situacao: 'ja_paga' | 'cancelada' | 'devolvida' | 'nao_existe' };

/**
 * Registra o pagamento de uma fatura (W2: depois de ler a cobrança na API do meio de pagamento; aqui também o teste). A
 * repetida não muda nada (`ja_paga`). A fatura cancelada não é paga aqui (`cancelada`): quem recebeu o dinheiro decide a
 * devolução. A primeira mensalidade começa a assinatura: o período começa no dia do pagamento, que vira o dia do
 * vencimento (D-A7-21), e a desistência vale até o 7º dia, só na primeira contratação da empresa (Termos 11.1). A
 * diferença paga muda o plano na hora (D-A7-23). Pagou o que estava em atraso, a situação volta na hora.
 */
export async function pagarFatura(tx: Tx, p: { faturaId: string; pagoEm: Date; forma: Forma; agora: Date }): Promise<ResultadoDoPagamento> {
  // A ordem das travas é a de todo caminho que mexe na cobrança: a assinatura primeiro, depois as faturas dela (a rotina
  // e as rotas também), para dois caminhos ao mesmo tempo não se travarem um ao outro.
  const dona = (await tx.execute<{ subscription_id: string }>(sql`select subscription_id from liame.billing_invoice where id = ${p.faturaId}`)).rows[0];
  if (!dona) return { situacao: 'nao_existe' };
  const s = await assinaturaTravadaPeloId(tx, dona.subscription_id);
  if (!s) return { situacao: 'nao_existe' };
  const f = (
    await tx.execute<{ id: string; subscription_id: string; kind: string; plan_id: string; status: string; period_start: string | null }>(sql`
      select id, subscription_id, kind, plan_id, status, period_start::text as period_start
        from liame.billing_invoice where id = ${p.faturaId} for update`)
  ).rows[0];
  if (!f) return { situacao: 'nao_existe' };
  if (f.status === 'paga') return { situacao: 'ja_paga' };
  if (f.status === 'cancelada' || f.status === 'devolvida') return { situacao: f.status };
  const diaDoPagamento = diaNoFuso(p.pagoEm, s.timezone);
  const pagoEm = p.pagoEm.toISOString();

  if (f.kind === 'mensalidade' && f.period_start === null) {
    // A primeira mensalidade: o período começa hoje, e o dia do vencimento é o de hoje.
    const dia = diaDoMes(diaDoPagamento);
    const fim = proximoVencimento(diaDoPagamento, dia);
    const primeiraDaEmpresa = (
      await tx.execute<{ antes: boolean }>(sql`
        select exists (select 1 from liame.subscription o where o.tenant_id = ${s.tenant_id} and o.id <> ${s.id} and o.first_paid_at is not null) as antes`)
    ).rows[0]?.antes !== true;
    await tx.execute(sql`
      update liame.billing_invoice
         set status = 'paga', paid_at = ${pagoEm}::timestamptz, paid_method = ${p.forma}, period_start = ${diaDoPagamento}::date,
             period_end = ${fim}::date, updated_at = now()
       where id = ${f.id}`);
    await tx.execute(sql`
      update liame.subscription
         set status = 'ativa', anchor_day = ${dia}, period_start = ${diaDoPagamento}::date, period_end = ${fim}::date,
             first_paid_at = ${pagoEm}::timestamptz, withdraw_until = ${primeiraDaEmpresa ? ultimoDiaParaDesistir(diaDoPagamento) : null}::date,
             next_check_at = ${comecoDoDia(somarDias(diaNoFuso(p.agora, s.timezone), 1), s.timezone)}, updated_at = now()
       where id = ${s.id}`);
    await auditarDaRotina(tx, s, 'cobranca.pagamento', null, { fatura: f.id, tipo: 'primeira', forma: p.forma, periodo_ate: fim }, 'integration');
    return { situacao: 'paga', assinatura: s.id, status: 'ativa' };
  }

  await tx.execute(sql`
    update liame.billing_invoice set status = 'paga', paid_at = ${pagoEm}::timestamptz, paid_method = ${p.forma}, updated_at = now()
     where id = ${f.id}`);
  if (f.kind === 'diferenca' && s.status !== 'encerrada') {
    // Subir de plano vale quando a diferença é paga (D-A7-23); a mensalidade do período seguinte, se já nasceu, vai pelo plano novo.
    const novo = await planoPeloId(tx, f.plan_id);
    await tx.execute(sql`update liame.subscription set plan_id = ${novo.id}, next_plan_id = null, updated_at = now() where id = ${s.id}`);
    await tx.execute(sql`
      update liame.billing_invoice set plan_id = ${novo.id}, amount_cents = ${novo.price_cents}::bigint, ${relerAgora(p.agora)}, updated_at = now()
       where subscription_id = ${s.id} and kind = 'mensalidade' and status = 'aberta' and period_start >= ${s.period_end}::date`);
  }
  const antes = s.status;
  const depois = s.status === 'encerrada' ? s.status : situacaoPeloAtraso(await vencimentoEmAberto(tx, s.id, diaNoFuso(p.agora, s.timezone)), diaNoFuso(p.agora, s.timezone));
  if (depois !== antes) await tx.execute(sql`update liame.subscription set status = ${depois}, updated_at = now() where id = ${s.id}`);
  await auditarDaRotina(tx, s, 'cobranca.pagamento', { status: antes }, { fatura: f.id, tipo: f.kind, forma: p.forma, status: depois }, 'integration');
  // Pagou: as ações voltam na hora (pela mensalidade que ainda ficar em aberto, se houver outra; D-A7-6).
  await acertarParadaDaCobranca(tx, s, depois, p.agora);
  return { situacao: 'paga', assinatura: s.id, status: depois };
}

export type VezDaAssinatura =
  | 'nada'
  | 'esperando_o_primeiro_pagamento'
  | 'nao_paga'
  | 'cancelada'
  | 'conferida';

/**
 * A vez da assinatura na rotina do worker (D-A7-22, D-A7-24; Termos 10.4 e 11.1), pelo relógio de quem chama: o pedido
 * sem o primeiro pagamento em 7 dias termina; no fim do período, a cancelada termina e a outra passa ao período
 * seguinte (com o plano marcado para descer, se houver, e sem a diferença que não foi paga); 5 dias antes do
 * vencimento, nasce a fatura do período seguinte; e a situação segue o atraso da mensalidade mais antiga em aberto. A
 * próxima vez é o começo do dia seguinte, no fuso da empresa.
 */
export async function vezDaAssinatura(tx: Tx, assinaturaId: string, agora: Date): Promise<VezDaAssinatura> {
  const s = await assinaturaTravadaPeloId(tx, assinaturaId);
  if (!s || s.status === 'encerrada') return 'nada';
  const hoje = diaNoFuso(agora, s.timezone);
  const amanha = comecoDoDia(somarDias(hoje, 1), s.timezone);

  if (s.status === 'aguardando_pagamento') {
    const prazo = somarDias(diaNoFuso(new Date(iso(s.created_at)), s.timezone), DIAS_PARA_O_PRIMEIRO_PAGAMENTO);
    if (diasEntre(prazo, hoje) >= 0) {
      await encerrar(tx, s.id, 'nao_paga', agora);
      await auditarDaRotina(tx, s, 'cobranca.encerrar', { status: s.status }, { status: 'encerrada', motivo: 'nao_paga' });
      return 'nao_paga';
    }
    await tx.execute(sql`update liame.subscription set next_check_at = ${comecoDoDia(prazo, s.timezone)}, updated_at = now() where id = ${s.id}`);
    return 'esperando_o_primeiro_pagamento';
  }

  // Paga ao menos uma vez: tem o período e o dia do vencimento (o `check` da tabela garante).
  const dia = s.anchor_day as number;
  let inicio = s.period_start as string;
  let fim = s.period_end as string;
  let plano = s.plan_id;
  let proximo = s.next_plan_id;
  let andou = false;
  for (let volta = 0; volta < PERIODOS_POR_VEZ && diasEntre(fim, hoje) >= 0; volta++) {
    if (s.cancel_at_period_end) {
      await encerrar(tx, s.id, 'cancelada', agora);
      await auditarDaRotina(tx, s, 'cobranca.encerrar', { status: s.status }, { status: 'encerrada', motivo: 'cancelada', fim_do_periodo: fim });
      return 'cancelada';
    }
    // O período acaba: o seguinte começa, com o plano marcado para descer, se houver.
    inicio = fim;
    fim = proximoVencimento(inicio, dia);
    plano = proximo ?? plano;
    proximo = null;
    andou = true;
  }
  if (andou) {
    // A diferença que não foi paga até o fim do período não vale mais (D-A7-23). Só o período em vigor ganha a
    // mensalidade: o que passou com a rotina parada (a função desligada) não é cobrado depois.
    await cancelarFaturas(tx, s.id, agora, sql`and kind = 'diferenca'`);
    await tx.execute(sql`
      update liame.subscription
         set period_start = ${inicio}::date, period_end = ${fim}::date, plan_id = ${plano}, next_plan_id = null, updated_at = now()
       where id = ${s.id}`);
    await garantirMensalidade(tx, s, inicio, fim, plano, hoje);
  }

  // A fatura do período seguinte nasce 5 dias antes do vencimento (o e-mail do PIX, D-A7-17).
  if (!s.cancel_at_period_end && diasEntre(hoje, fim) <= DIAS_DA_FATURA_ANTES) {
    await garantirMensalidade(tx, s, fim, proximoVencimento(fim, dia), proximo ?? plano, hoje);
  }

  const depois = situacaoPeloAtraso(await vencimentoEmAberto(tx, s.id, hoje), hoje);
  await tx.execute(sql`update liame.subscription set status = ${depois}, next_check_at = ${amanha}, updated_at = now() where id = ${s.id}`);
  if (depois !== s.status) await auditarDaRotina(tx, s, 'cobranca.situacao', { status: s.status }, { status: depois });
  // No 10º dia de atraso, as ações da marca param; em dia de novo, voltam (D-A7-6).
  await acertarParadaDaCobranca(tx, s, depois, agora);
  return 'conferida';
}

/** A mensalidade do período seguinte que já nasceu (5 dias antes do vencimento) passa a ser a do plano dado. */
async function mensalidadeSeguintePeloPlano(tx: Tx, s: LinhaDaAssinatura, planoId: string, agora: Date): Promise<void> {
  const plano = await planoPeloId(tx, planoId);
  await tx.execute(sql`
    update liame.billing_invoice set plan_id = ${plano.id}, amount_cents = ${plano.price_cents}::bigint, ${relerAgora(agora)}, updated_at = now()
     where subscription_id = ${s.id} and kind = 'mensalidade' and status = 'aberta' and period_start >= ${s.period_end}::date`);
}

export type Troca =
  | { tipo: 'subir'; diferencaCents: number; faturaId: string | null }
  | { tipo: 'descer' }
  | { tipo: 'desfeita' }
  | { tipo: 'nada' };

/**
 * Troca o plano da assinatura em dia (D-A7-16, D-A7-23): subir vale quando a diferença dos dias que faltam é paga (a
 * fatura da diferença vence hoje; a anterior, se ainda estava em aberto, é refeita); descer vale no período seguinte;
 * escolher de novo o plano em vigor desfaz a troca marcada. Quem chama já travou a assinatura e conferiu que ela está
 * em dia.
 */
export async function trocarPlano(tx: Tx, s: LinhaDaAssinatura, novo: { id: string; price_cents: string }, agora: Date): Promise<Troca> {
  const hoje = diaNoFuso(agora, s.timezone);
  const desfezDiferenca = (await cancelarFaturas(tx, s.id, agora, sql`and kind = 'diferenca'`)) > 0;
  if (novo.id === s.plan_id) {
    if (!s.next_plan_id) return desfezDiferenca ? { tipo: 'desfeita' } : { tipo: 'nada' };
    await tx.execute(sql`update liame.subscription set next_plan_id = null, updated_at = now() where id = ${s.id}`);
    await mensalidadeSeguintePeloPlano(tx, s, s.plan_id, agora);
    return { tipo: 'desfeita' };
  }
  const atual = await planoPeloId(tx, s.plan_id);
  if (BigInt(novo.price_cents) <= BigInt(atual.price_cents)) {
    await tx.execute(sql`update liame.subscription set next_plan_id = ${novo.id}, updated_at = now() where id = ${s.id}`);
    await mensalidadeSeguintePeloPlano(tx, s, novo.id, agora);
    return { tipo: 'descer' };
  }
  // Subir: a descida marcada antes deixa de valer.
  if (s.next_plan_id) {
    await tx.execute(sql`update liame.subscription set next_plan_id = null, updated_at = now() where id = ${s.id}`);
    await mensalidadeSeguintePeloPlano(tx, s, s.plan_id, agora);
  }
  const inicio = s.period_start as string;
  const fim = s.period_end as string;
  const valor = diferencaDoPlano(Number(atual.price_cents), Number(novo.price_cents), diasEntre(hoje, fim), diasEntre(inicio, fim));
  if (valor < MINIMO_DA_COBRANCA_CENTAVOS) {
    // Sem dia a pagar (o último dia do período) ou abaixo do mínimo do meio de pagamento (D-A7-32): o plano muda já, sem
    // cobrança, e o período seguinte vai por ele.
    await tx.execute(sql`update liame.subscription set plan_id = ${novo.id}, updated_at = now() where id = ${s.id}`);
    await mensalidadeSeguintePeloPlano(tx, s, novo.id, agora);
    return { tipo: 'subir', diferencaCents: 0, faturaId: null };
  }
  const faturaId = uuidv7();
  await tx.execute(sql`
    insert into liame.billing_invoice (id, tenant_id, brand_id, subscription_id, kind, plan_id, period_start, period_end, due_date, amount_cents)
    values (${faturaId}, ${s.tenant_id}, ${s.brand_id}, ${s.id}, 'diferenca', ${novo.id}, ${hoje}::date, ${fim}::date, ${hoje}::date, ${valor})`);
  return { tipo: 'subir', diferencaCents: valor, faturaId };
}

export type Cancelamento = 'encerrada' | 'no_fim_do_periodo' | 'ja_cancelada';

/**
 * O Dono cancela (Termos 11.1): vale no fim do período pago, e a fatura do período seguinte, se já nasceu, não é
 * cobrada. Se o período em vigor (ou um anterior) não foi pago, não há período pago para esperar: a assinatura termina
 * agora, e o que está em aberto não é cobrado (D-A7-25). A que ainda espera o primeiro pagamento termina agora.
 */
export async function cancelar(tx: Tx, s: LinhaDaAssinatura, quem: string, agora: Date): Promise<Cancelamento> {
  const hoje = diaNoFuso(agora, s.timezone);
  if (s.status === 'aguardando_pagamento') {
    await encerrar(tx, s.id, 'cancelada', agora);
    return 'encerrada';
  }
  const naoPago = (
    await tx.execute<{ existe: boolean }>(sql`
      select exists (select 1 from liame.billing_invoice
                      where subscription_id = ${s.id} and kind = 'mensalidade' and status = 'aberta' and due_date <= ${hoje}::date) as existe`)
  ).rows[0]?.existe === true;
  if (naoPago) {
    await encerrar(tx, s.id, 'cancelada', agora);
    return 'encerrada';
  }
  if (s.cancel_at_period_end) return 'ja_cancelada';
  await tx.execute(sql`
    update liame.subscription
       set cancel_at_period_end = true, cancel_requested_at = ${agora.toISOString()}::timestamptz, cancel_requested_by = ${quem}, updated_at = now()
     where id = ${s.id}`);
  await cancelarFaturas(tx, s.id, agora, sql`and (kind = 'diferenca' or due_date > ${hoje}::date)`);
  return 'no_fim_do_periodo';
}

/**
 * O Dono mantém a assinatura que tinha cancelado: ela segue como estava, e a rotina olha de novo agora (a fatura do
 * período seguinte, se já é tempo dela, nasce de novo).
 */
export async function manter(tx: Tx, s: LinhaDaAssinatura, agora: Date): Promise<'mantida' | 'nada'> {
  if (!s.cancel_at_period_end) return 'nada';
  await tx.execute(sql`
    update liame.subscription
       set cancel_at_period_end = false, cancel_requested_at = null, cancel_requested_by = null,
           next_check_at = ${agora.toISOString()}::timestamptz, updated_at = now()
     where id = ${s.id}`);
  return 'mantida';
}

/**
 * A desistência em 7 dias (Termos 11.1; D-A7-19): só na primeira contratação, até o 7º dia depois do primeiro
 * pagamento. A assinatura termina agora; o que foi pago desta assinatura fica com a devolução pedida (o meio de
 * pagamento devolve, W2), e o que está em aberto não é cobrado. Devolve quanto volta, em centavos.
 */
export async function desistir(tx: Tx, s: LinhaDaAssinatura, agora: Date): Promise<{ devolveCents: number } | 'fora_do_prazo'> {
  const hoje = diaNoFuso(agora, s.timezone);
  if (!s.withdraw_until || diasEntre(hoje, s.withdraw_until) < 0) return 'fora_do_prazo';
  // A devolução vai para a fila da releitura na hora (W2a, parte 3b): a rotina pede o estorno ao Asaas e acompanha até o
  // estorno feito. A paga sem a cobrança no Asaas (nunca devia existir) fica com o porquê, para a distribuição devolver à mão.
  const r = await tx.execute<{ total: string }>(sql`
    with pedidas as (
      update liame.billing_invoice
         set refund_requested_at = ${agora.toISOString()}::timestamptz, ${relerAgora(agora)},
             charge_error = case when external_id is null then 'devolucao_sem_cobranca' else charge_error end, updated_at = now()
       where subscription_id = ${s.id} and status = 'paga' and refund_requested_at is null
      returning amount_cents
    )
    select coalesce(sum(amount_cents), 0)::text as total from pedidas`);
  await encerrar(tx, s.id, 'desistencia', agora);
  return { devolveCents: Number(r.rows[0]?.total ?? 0) };
}

/**
 * Registra a devolução feita de uma fatura (W2a, parte 3b; D-A7-29: só com o estorno feito, `DONE`, lido no meio de
 * pagamento). Só a paga com a devolução pedida vira devolvida; a repetida não muda nada (`ja_devolvida`). A assinatura já
 * terminou na desistência: aqui não há o que mudar nela.
 */
export async function devolverFatura(tx: Tx, p: { faturaId: string; agora: Date }): Promise<'devolvida' | 'ja_devolvida' | 'sem_pedido'> {
  const dona = (await tx.execute<{ subscription_id: string }>(sql`select subscription_id from liame.billing_invoice where id = ${p.faturaId}`)).rows[0];
  if (!dona) return 'sem_pedido';
  // A ordem das travas de todo caminho da cobrança: a assinatura, depois a fatura.
  const s = await assinaturaTravadaPeloId(tx, dona.subscription_id);
  if (!s) return 'sem_pedido';
  const f = (
    await tx.execute<{ id: string; status: string; amount_cents: string; refund_requested_at: Date | string | null }>(sql`
      select id, status, amount_cents::text as amount_cents, refund_requested_at from liame.billing_invoice where id = ${p.faturaId} for update`)
  ).rows[0];
  if (!f) return 'sem_pedido';
  if (f.status === 'devolvida') return 'ja_devolvida';
  if (f.status !== 'paga' || !f.refund_requested_at) return 'sem_pedido';
  await tx.execute(sql`
    update liame.billing_invoice set status = 'devolvida', refunded_at = ${p.agora.toISOString()}::timestamptz, updated_at = now() where id = ${f.id}`);
  await auditarDaRotina(tx, s, 'cobranca.devolucao', { status: 'paga' }, { fatura: f.id, devolvido_cents: Number(f.amount_cents), status: 'devolvida' }, 'integration');
  return 'devolvida';
}

async function auditarDaRotina(
  tx: Tx,
  s: LinhaDaAssinatura,
  acao: string,
  antes: Record<string, unknown> | null,
  depois: Record<string, unknown>,
  ator: 'system' | 'integration' = 'system',
): Promise<void> {
  await writeAudit(tx, {
    tenantId: s.tenant_id,
    actorType: ator,
    actorId: null,
    actorLabel: ROTULO_DA_ROTINA,
    action: acao,
    resourceType: 'subscription',
    resourceId: s.id,
    before: antes,
    after: { brand_id: s.brand_id, ...depois },
    origin: 'worker',
  });
}

type LinhaDaFatura = {
  id: string;
  kind: string;
  plan_key: string;
  plan_name: string;
  period_start: string | null;
  period_end: string | null;
  due_date: string;
  amount_cents: string;
  status: string;
  paid_at: Date | string | null;
  paid_method: string | null;
  refund_requested_at: Date | string | null;
};

/** A cobrança da marca como a tela lê: a assinatura viva (ou a última que terminou) e as faturas. */
export async function estadoDaMarca(
  tx: Tx,
  p: { tenantId: string; brandId: string; agora: Date; ligada: boolean; podeMudar: boolean; podePagar: boolean },
): Promise<BillingResponse> {
  const fuso = await fusoDaEmpresa(tx, p.tenantId);
  const hoje = diaNoFuso(p.agora, fuso);
  const vazio: BillingResponse = {
    brand_id: p.brandId,
    enabled: p.ligada,
    can_manage: p.podeMudar,
    can_pay: p.podePagar,
    today: hoje,
    subscription: null,
    invoices: [],
  };
  if (!p.ligada) return vazio;
  const s = (
    await tx.execute<LinhaDaAssinatura>(sql`
      select ${COLUNAS_DA_ASSINATURA}
        from liame.subscription s join liame.organization o on o.id = s.tenant_id
       where s.brand_id = ${p.brandId}
       order by (s.status <> 'encerrada') desc, coalesce(s.ended_at, s.created_at) desc, s.id desc
       limit 1`)
  ).rows[0];
  const faturas = await tx.execute<LinhaDaFatura>(sql`
    select i.id, i.kind, b.key as plan_key, b.name as plan_name, i.period_start::text as period_start, i.period_end::text as period_end,
           i.due_date::text as due_date, i.amount_cents::text as amount_cents, i.status, i.paid_at, i.paid_method, i.refund_requested_at
      from liame.billing_invoice i join liame.billing_plan b on b.id = i.plan_id
     where i.brand_id = ${p.brandId}
     order by i.due_date desc, i.created_at desc, i.id desc
     limit ${FATURAS_NA_TELA}`);
  const invoices: BillingInvoice[] = faturas.rows.map((f) => ({
    id: f.id,
    kind: f.kind,
    plan_key: f.plan_key,
    plan_name: f.plan_name,
    period_start: f.period_start,
    period_end: f.period_end,
    due_date: f.due_date,
    amount_cents: f.amount_cents,
    status: f.status,
    paid_at: isoOuNulo(f.paid_at),
    paid_method: f.paid_method,
    refund_requested_at: isoOuNulo(f.refund_requested_at),
  }));
  if (!s) return { ...vazio, invoices };
  return { ...vazio, subscription: await paraATela(tx, s, hoje), invoices };
}

async function paraATela(tx: Tx, s: LinhaDaAssinatura, hoje: string): Promise<BrandSubscription> {
  const plano = paraOPlano(await planoPeloId(tx, s.plan_id));
  const proximo = s.next_plan_id ? paraOPlano(await planoPeloId(tx, s.next_plan_id)) : null;
  const viva = s.status !== 'encerrada';
  const venc = viva && s.status !== 'aguardando_pagamento' ? await vencimentoEmAberto(tx, s.id, hoje) : null;
  const passos = venc ? passosDoAtraso(venc) : null;
  return {
    id: s.id,
    plan: plano,
    next_plan: proximo,
    status: s.status,
    method: s.method,
    period_start: s.period_start,
    period_end: s.period_end,
    first_payment_until:
      s.status === 'aguardando_pagamento' ? somarDias(diaNoFuso(new Date(iso(s.created_at)), s.timezone), DIAS_PARA_O_PRIMEIRO_PAGAMENTO - 1) : null,
    overdue: venc && passos ? { due_date: venc, days: diasEntre(venc, hoje), actions_stop_on: passos.acoesParamEm, suspends_on: passos.suspendeEm } : null,
    cancel_at_period_end: s.cancel_at_period_end,
    withdraw_until: viva && s.withdraw_until && diasEntre(hoje, s.withdraw_until) >= 0 ? s.withdraw_until : null,
    ended_at: isoOuNulo(s.ended_at),
    end_reason: s.end_reason,
    withdraw_protocol: s.end_reason === 'desistencia' && s.ended_at ? protocoloDaDesistencia(s.id, new Date(iso(s.ended_at))) : null,
  };
}
