import type {
  BillingPixResponse,
  BillingPlansResponse,
  BillingResponse,
  CancelSubscriptionRequest,
  ChangePlanRequest,
  KeepSubscriptionRequest,
  SubscribeRequest,
  WithdrawSubscriptionRequest,
} from '@liame/contracts';
import { type Database, withContext } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { MfaService } from '../auth/mfa.service.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem, ValidationProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { type FalhaDaCobranca, garantirCobrancaPix, type Transacao } from './cobranca-pix.js';
import { MeioAsaas } from './meio-asaas.js';
import {
  assinaturaVivaTravada,
  cancelar,
  criarAssinatura,
  desistir,
  encerrar,
  estadoDaMarca,
  FLAG_COBRANCA,
  type LinhaDaAssinatura,
  manter,
  planoOferecido,
  planosOferecidos,
  trocarPlano,
} from './assinatura.js';

// Plano e cobrança (A7, W1; protótipo P26, aprovado em 22/10/2026; `plano-a7.md` D-A7-13 a D-A7-26): os planos, a
// assinatura de cada marca e as mudanças do contrato. Ver é do Dono e do Administrador com a cobrança liberada; mudar o
// contrato (assinar, trocar de plano, cancelar, manter, desistir) é só do Dono (D-A7-13), e trocar de plano, cancelar e
// desistir pedem o código do app (D-A7-14). O pagamento entra com a W2: até lá, a assinatura nova espera o primeiro
// pagamento. Tudo só com a função `cobranca` ligada para a empresa (409 `funcao-desligada`); desligada, ver devolve vazio.

export const RECURSO = 'subscription';
export const ACAO_ASSINAR = 'cobranca.assinar';
export const ACAO_TROCAR_PLANO = 'cobranca.trocar_plano';
export const ACAO_CANCELAR = 'cobranca.cancelar';
export const ACAO_MANTER = 'cobranca.manter';
export const ACAO_DESISTIR = 'cobranca.desistir';

type Quem = { tenantId: string; userId: string };

function quemPede(auth: AuthContext): Quem {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return { tenantId: auth.tenantId, userId: auth.userId };
}

const desligada = () => new AppProblem(409, 'funcao-desligada', 'Função desligada', 'Plano e cobrança não está ligado para esta empresa.');
const jaAssinada = () =>
  new AppProblem(409, 'assinatura-existe', 'A marca já tem uma assinatura', 'Para mudar de plano, use "Trocar de plano".');
const semAssinatura = () => new AppProblem(404, 'sem-assinatura', 'A marca não tem assinatura', 'Escolha um plano para assinar.');
const pagamentoIndisponivel = () =>
  new AppProblem(503, 'pagamento-indisponivel', 'Pagamento indisponível', 'O pagamento está indisponível agora. Tente mais tarde.');
const meioForaDoAr = () =>
  new AppProblem(502, 'meio-de-pagamento-fora-do-ar', 'O meio de pagamento não respondeu', 'O meio de pagamento não respondeu. Tente de novo.');

/** A falha do meio de pagamento ao gerar o PIX, como a rota responde (os 5xx vão ao log com a causa, V6). */
function problemaDaFalha(falha: FalhaDaCobranca, esperarMs: number): AppProblem {
  if (falha === 'sem_cnpj') return new AppProblem(409, 'cnpj-necessario', 'Falta o CNPJ da empresa', 'O CNPJ da empresa é necessário para gerar o PIX.');
  if (falha === 'limite_do_meio') {
    const segundos = String(Math.max(1, Math.ceil(esperarMs / 1000)));
    return new AppProblem(503, 'meio-de-pagamento-ocupado', 'O meio de pagamento pediu uma pausa', 'Tente de novo em instantes.', { 'retry-after': segundos });
  }
  if (falha === 'chave_recusada') return pagamentoIndisponivel();
  if (falha === 'recusada_pelo_meio') return new AppProblem(502, 'meio-de-pagamento-recusou', 'O meio de pagamento recusou a cobrança', 'O meio de pagamento recusou a cobrança desta fatura.');
  return meioForaDoAr();
}

/** A marca é da empresa e não está arquivada (a RLS esconde a de outra empresa: 404). */
async function marcaDaEmpresa(brandId: string): Promise<void> {
  const r = await currentTx().execute<{ id: string }>(sql`select id from liame.brand where id = ${brandId} and archived_at is null`);
  if (!r.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
}

/** O contrato só muda na assinatura em dia, sem cancelamento marcado (trocar de plano). */
function exigirEmDia(s: LinhaDaAssinatura): void {
  if (s.status === 'aguardando_pagamento') {
    throw new AppProblem(409, 'assinatura-sem-pagamento', 'A assinatura ainda não começou', 'Ela começa com o primeiro pagamento. Para escolher outro plano, assine de novo.');
  }
  if (s.status !== 'ativa') throw new AppProblem(409, 'assinatura-em-atraso', 'Há uma mensalidade em aberto', 'Pague a mensalidade antes de trocar de plano.');
  if (s.cancel_at_period_end) throw new AppProblem(409, 'assinatura-cancelada', 'A assinatura foi cancelada', 'Mantenha a assinatura antes de trocar de plano.');
}

@Injectable()
export class CobrancaService {
  private readonly logger = new Logger('cobranca');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly mfa: MfaService,
    private readonly meio: MeioAsaas,
  ) {}

  private ligada(quem: Quem, brandId?: string): Promise<boolean> {
    return this.flags.isEnabled(FLAG_COBRANCA, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, ...(brandId ? { brandId } : {}) }));
  }

  /** Confere a marca e a função antes de mudar o contrato. */
  private async paraMudar(auth: AuthContext, brandId: string): Promise<Quem> {
    const quem = quemPede(auth);
    await marcaDaEmpresa(brandId);
    if (!(await this.ligada(quem, brandId))) throw desligada();
    return quem;
  }

  async planos(auth: AuthContext): Promise<BillingPlansResponse> {
    const quem = quemPede(auth);
    const ligada = await this.ligada(quem);
    return { enabled: ligada, items: ligada ? await planosOferecidos(currentTx()) : [] };
  }

  async daMarca(auth: AuthContext, brandId: string): Promise<BillingResponse> {
    const quem = quemPede(auth);
    await marcaDaEmpresa(brandId);
    return estadoDaMarca(currentTx(), {
      tenantId: quem.tenantId,
      brandId,
      agora: new Date(),
      ligada: await this.ligada(quem, brandId),
      podeMudar: auth.permissions.has('cobranca.gerenciar'),
      podePagar: auth.permissions.has('cobranca.pagar'),
    });
  }

  /**
   * O PIX de uma fatura (A7, W2a; D-A7-30): garante a cobrança no Asaas (criada na hora, se ainda não existe) e devolve o
   * QR Code. Fora da transação da requisição: as chamadas ao Asaas acontecem sem transação aberta, e o banco é usado em
   * transações curtas, com a empresa no contexto da RLS (a fatura de outra empresa não aparece: 404).
   */
  async pix(auth: AuthContext, faturaId: string): Promise<BillingPixResponse> {
    const quem = quemPede(auth);
    if (!(await this.ligada(quem))) throw desligada();
    const api = this.meio.api();
    const database = this.database;
    if (!api || !database) throw pagamentoIndisponivel();
    const transacao: Transacao = (fn) => withContext(database.db, { tenantId: quem.tenantId, userId: quem.userId }, fn);
    const r = await garantirCobrancaPix(transacao, api, faturaId, new Date());
    if (r.situacao === 'nao_cobravel') {
      if (r.motivo === 'nao_existe') throw new AppProblem(404, 'fatura-nao-encontrada', 'Não encontramos', 'Não encontramos esta fatura nesta empresa.');
      if (r.motivo === 'nao_aberta') throw new AppProblem(409, 'fatura-nao-esta-em-aberto', 'A fatura não está em aberto', 'Esta fatura já foi paga, cancelada ou devolvida.');
      throw new AppProblem(409, 'fatura-nao-e-pix', 'A fatura não é no PIX', 'Esta assinatura não paga por PIX.');
    }
    if (r.situacao === 'em_criacao') {
      throw new AppProblem(409, 'cobranca-em-criacao', 'O PIX está sendo gerado', 'O PIX desta fatura está sendo gerado. Tente de novo em alguns segundos.', { 'retry-after': '5' });
    }
    if (r.situacao === 'sem_cnpj') throw problemaDaFalha('sem_cnpj', 0);
    if (r.situacao === 'falhou') {
      if (r.falha !== 'limite_do_meio') this.logger.error(`PIX da fatura ${faturaId}: o meio de pagamento falhou (${r.falha})`);
      throw problemaDaFalha(r.falha, r.esperarMs);
    }
    let qr;
    try {
      qr = await api.qrCodePix(r.cobranca.id, 15_000);
    } catch (err) {
      this.logger.error(`PIX da fatura ${faturaId}: o QR Code não veio (${err instanceof Error ? err.message : String(err)})`);
      throw meioForaDoAr();
    }
    return {
      invoice_id: faturaId,
      amount_cents: String(r.cobranca.valorCentavos),
      due_date: r.cobranca.vencimento,
      qr_code_png_base64: qr.imagemPngBase64,
      copy_paste: qr.copiaECola,
      expires_at: qr.validaAte,
      invoice_url: r.cobranca.url,
    };
  }

  /**
   * Assinar um plano: a assinatura espera o primeiro pagamento, e a primeira mensalidade vence hoje. O mesmo pedido de
   * novo não contrata duas vezes; outro plano ou outra forma, antes do primeiro pagamento, substitui o pedido.
   */
  async assinar(auth: AuthContext, req: SubscribeRequest): Promise<BillingResponse> {
    const quem = await this.paraMudar(auth, req.brand_id);
    const tx = currentTx();
    const plano = await planoOferecido(tx, req.plan);
    if (!plano) throw new ValidationProblem([{ path: 'plan', message: 'Este plano não está entre os oferecidos.' }]);
    const agora = new Date();
    const viva = await assinaturaVivaTravada(tx, req.brand_id);
    if (viva) {
      if (viva.status !== 'aguardando_pagamento') throw jaAssinada();
      if (viva.plan_id === plano.id && viva.method === req.method) {
        auditDetail({ resourceId: viva.id, after: { brand_id: req.brand_id, sem_mudanca: true } });
        return this.daMarca(auth, req.brand_id);
      }
      await encerrar(tx, viva.id, 'substituida', agora);
    }
    let id: string;
    try {
      id = await criarAssinatura(tx, { tenantId: quem.tenantId, brandId: req.brand_id, planoId: plano.id, forma: req.method, quem: quem.userId, agora });
    } catch (err) {
      const causa = (err as { cause?: { code?: string; constraint?: string } }).cause;
      if (causa?.code === '23505' && causa.constraint === 'uq_subscription_viva') throw jaAssinada();
      throw err;
    }
    auditDetail({
      resourceId: id,
      after: { brand_id: req.brand_id, plano: plano.key, versao: plano.version, forma: req.method, valor_cents: Number(plano.price_cents), substituiu: viva?.id ?? null },
    });
    return this.daMarca(auth, req.brand_id);
  }

  /** Trocar de plano, com o código do app (D-A7-14, D-A7-16, D-A7-23). */
  async trocarPlano(auth: AuthContext, req: ChangePlanRequest): Promise<BillingResponse> {
    await this.paraMudar(auth, req.brand_id);
    const tx = currentTx();
    await this.mfa.verifyStepUp(tx, auth.userId, req.code);
    const s = await assinaturaVivaTravada(tx, req.brand_id);
    if (!s) throw semAssinatura();
    exigirEmDia(s);
    const novo = await planoOferecido(tx, req.plan);
    if (!novo) throw new ValidationProblem([{ path: 'plan', message: 'Este plano não está entre os oferecidos.' }]);
    const troca = await trocarPlano(tx, s, novo, new Date());
    auditDetail({
      resourceId: s.id,
      before: { plano_id: s.plan_id, proximo_plano_id: s.next_plan_id },
      after: {
        brand_id: req.brand_id,
        plano: novo.key,
        versao: novo.version,
        troca: troca.tipo,
        ...(troca.tipo === 'subir' ? { diferenca_cents: troca.diferencaCents, fatura: troca.faturaId } : {}),
      },
    });
    return this.daMarca(auth, req.brand_id);
  }

  /** Cancelar, com o código do app (Termos 11.1; D-A7-14, D-A7-25). */
  async cancelar(auth: AuthContext, req: CancelSubscriptionRequest): Promise<BillingResponse> {
    await this.paraMudar(auth, req.brand_id);
    const tx = currentTx();
    await this.mfa.verifyStepUp(tx, auth.userId, req.code);
    const s = await assinaturaVivaTravada(tx, req.brand_id);
    if (!s) throw semAssinatura();
    const r = await cancelar(tx, s, auth.userId, new Date());
    auditDetail({ resourceId: s.id, before: { status: s.status }, after: { brand_id: req.brand_id, cancelamento: r, fim_do_periodo: s.period_end } });
    return this.daMarca(auth, req.brand_id);
  }

  /** Manter a assinatura cancelada, antes do fim do período. */
  async manter(auth: AuthContext, req: KeepSubscriptionRequest): Promise<BillingResponse> {
    await this.paraMudar(auth, req.brand_id);
    const tx = currentTx();
    const s = await assinaturaVivaTravada(tx, req.brand_id);
    if (!s) throw semAssinatura();
    const r = await manter(tx, s, new Date());
    auditDetail({ resourceId: s.id, after: { brand_id: req.brand_id, resultado: r } });
    return this.daMarca(auth, req.brand_id);
  }

  /** Desistir em 7 dias, com o código do app (Termos 11.1; D-A7-14, D-A7-19). */
  async desistir(auth: AuthContext, req: WithdrawSubscriptionRequest): Promise<BillingResponse> {
    await this.paraMudar(auth, req.brand_id);
    const tx = currentTx();
    await this.mfa.verifyStepUp(tx, auth.userId, req.code);
    const s = await assinaturaVivaTravada(tx, req.brand_id);
    if (!s) throw semAssinatura();
    const r = await desistir(tx, s, new Date());
    if (r === 'fora_do_prazo') {
      throw new AppProblem(
        409,
        'fora-do-prazo-de-desistencia',
        'O prazo para desistir acabou',
        'A desistência com a devolução integral vale até 7 dias depois do primeiro pagamento, na primeira contratação. Você ainda pode cancelar: a assinatura vai até o fim do período pago.',
      );
    }
    auditDetail({ resourceId: s.id, before: { status: s.status }, after: { brand_id: req.brand_id, devolve_cents: r.devolveCents } });
    return this.daMarca(auth, req.brand_id);
  }
}
