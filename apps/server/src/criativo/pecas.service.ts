import {
  AD_PIECE_LIMITS,
  type AdPieceListQuery,
  type AdPieceListResponse,
  type AdPieceOptionsResponse,
  type AdPieceRequestListResponse,
  type AdPieceRequestResponse,
  type AdPieceResponse,
  type CreateAdPieceRequest,
} from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { conferirPedido } from '../ai/criativo/contexto.js';
import { CRIATIVO } from '../ai/criativo/prompt.js';
import { AiGateway } from '../ai/gateway.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import { MODELO_PADRAO } from '../attribution/motor.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { ultimaCotacao } from '../cambio/cotacao.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem, type FieldError } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { valoresComerciais } from '../policy/anuncio.js';
import { diaNoFuso, menosDias } from '../results/fora-do-normal.js';
import { ResultsService } from '../results/results.service.js';
import { type LinhaDoPedido, respostaDoPedido } from './apresentacao.js';
import { marcaDoCriativo, mensagemDoProblema } from './base.js';
import { COLUNAS_DO_PEDIDO, pecaComHistorico, pecasComAVersaoAtual } from './consultas.js';
import { CustoDasPecasService, respostaDoCusto } from './custo.service.js';

// As peças do Criativo na API (A4, X6; protótipo P10, aguardando aprovação; sem tela ainda). A rota só confere e
// enfileira: quem escreve as peças é o Criativo, na fila do worker (`worker/criativo.service.ts`), e cada uma só
// aparece depois da conferência do código. Pedir: quem opera campanhas; ver: quem vê campanhas. Tudo atrás da flag
// `criativo`, que nasce desligada.

/** A flag que liga o Criativo para a empresa. */
export const FLAG_DO_CRIATIVO = 'criativo';
/** Pedidos de peça por marca por dia (cada um chama a IA). */
export const PEDIDOS_POR_DIA = 30;
/** Quantos anúncios de referência a tela oferece. */
const REFERENCIAS = 10;
/** Os dias completos de pedidos que fazem um anúncio ser referência. */
const DIAS_DA_REFERENCIA = 7;

const CAMPO_DO_PEDIDO = { oferta: 'offer', instrucao: 'instruction', variacoes: 'variations' } as const;

const naoEncontrado = (detail: string) => new AppProblem(404, 'nao-encontrado', 'Não encontramos', detail);

@Injectable()
export class PecasService {
  constructor(
    private readonly gateway: AiGateway,
    private readonly flags: FlagService,
    private readonly limite: RateLimitService,
    private readonly resultados: ResultsService,
    private readonly custo: CustoDasPecasService,
  ) {}

  /**
   * O que a tela de pedir uma peça precisa: se dá para pedir agora, as ofertas de Minha marca, os anúncios que já vendem
   * e, para quem pode pedir, o custo à vista (o uso de IA da empresa e a estimativa do pedido, D-A4-32).
   */
  async opcoes(auth: AuthContext, brandId: string, agora = new Date()): Promise<AdPieceOptionsResponse> {
    const tenantId = this.empresa(auth);
    const fuso = await this.resultados.fusoDaMarca(brandId);
    const ligado = await this.ligado(auth, tenantId, brandId);
    const marca = await marcaDoCriativo(brandId, fuso, agora);
    const ofertas = marca?.conteudo.offers.items ?? [];
    const emAndamento = await this.loteEmAndamento(brandId);
    const hoje = diaNoFuso(agora, fuso);
    const de = menosDias(hoje, DIAS_DA_REFERENCIA);
    const referencias = await currentTx().execute<{ ad_id: string; name: string; campaign: string | null; orders: number }>(sql`
      select a.id as ad_id, a.name, c.name as campaign, count(*)::int as orders
        from liame.order_fact o
        join liame.attribution_result r on r.order_id = o.id and r.model_id = ${MODELO_PADRAO} and r.counted and r.ad_id is not null
        join liame.ad a on a.id = r.ad_id
        left join liame.campaign c on c.id = r.campaign_id
       where o.brand_id = ${brandId} and o.status = 'confirmado'
         and o.confirmed_at >= (${de}::date)::timestamp at time zone ${fuso}
         and o.confirmed_at < (${hoje}::date)::timestamp at time zone ${fuso}
       group by a.id, a.name, c.name
       order by orders desc, a.name, a.id
       limit ${REFERENCIAS}`);
    // O custo é de quem pode pedir: quem só vê as campanhas não recebe o gasto de IA da empresa.
    const custo = auth.permissions.has('campanhas.operar') ? await this.custo.ler(tenantId, brandId, agora) : null;
    const semLimite = custo !== null && !custo.cabe;
    const motivo = !ligado ? 'criativo_desligado' : !marca ? 'sem_dossie' : !ofertas.length ? 'sem_oferta' : semLimite ? 'limite_de_ia' : emAndamento ? 'lote_em_andamento' : null;
    return {
      brand_id: brandId,
      available: motivo === null,
      reason: motivo,
      ai: custo ? respostaDoCusto(custo) : null,
      // O custo e o teto seguem em dólar; a cotação é só para a tela mostrar o valor aproximado em reais (D-A3-14).
      usd_brl: custo ? await ultimaCotacao(currentTx()) : null,
      dossier_version: marca?.versao ?? null,
      offers: ofertas.map((texto) => ({
        text: texto,
        has_value: valoresComerciais(texto).length > 0,
        problems: conferirPedido({ oferta: texto, instrucao: null, variacoes: AD_PIECE_LIMITS.variations_min }, marca!).map((p) => ({ reason: p.motivo, excerpt: p.trecho })),
      })),
      reference_ads: referencias.rows,
      reference_period: { from: de, to: menosDias(hoje, 1) },
      limits: { ...AD_PIECE_LIMITS },
      in_progress: emAndamento,
    };
  }

  /** Põe o pedido de peças na fila do Criativo. Um lote por marca de cada vez. */
  async pedir(auth: AuthContext, body: CreateAdPieceRequest, agora = new Date()): Promise<AdPieceRequestResponse> {
    const tenantId = this.empresa(auth);
    const tx = currentTx();
    const fuso = await this.resultados.fusoDaMarca(body.brand_id);
    if (!(await this.ligado(auth, tenantId, body.brand_id))) {
      throw new AppProblem(409, 'criativo-desligado', 'O Criativo não está ligado', 'Pedir peças depende da IA ligada para a empresa e do Criativo ativo.');
    }
    const marca = await marcaDoCriativo(body.brand_id, fuso, agora);
    if (!marca) throw new AppProblem(409, 'sem-dossie', 'Minha marca ainda não foi preenchida', 'O Criativo parte de uma oferta de Minha marca. Preencha as ofertas da marca antes de pedir uma peça.');
    // A oferta é uma das de Minha marca, como está lá: o Criativo não recebe oferta digitada no pedido.
    if (!marca.conteudo.offers.items.includes(body.offer)) {
      throw new AppProblem(422, 'oferta-desconhecida', 'Esta oferta não está em Minha marca', 'A oferta mudou ou saiu de Minha marca depois que você abriu a tela. Atualize e escolha de novo.');
    }
    const instrucao = body.instruction ?? null;
    const problemas = conferirPedido({ oferta: body.offer, instrucao, variacoes: body.variations }, marca);
    if (problemas.length) {
      const erros: FieldError[] = problemas.map((p) => ({ path: CAMPO_DO_PEDIDO[p.campo], message: mensagemDoProblema(p) }));
      throw new AppProblem(422, 'pedido-recusado', 'O Criativo não pode fazer este pedido', 'O pedido bate numa regra de anúncio. Veja o que mudar em cada campo.', {}, erros);
    }
    const referencia = body.reference_ad_id ? await this.anuncioDaMarca(body.brand_id, body.reference_ad_id) : null;
    // O pedido que não cabe no que resta do limite de IA é negado na hora, antes de contar no limite de pedidos do dia.
    await this.custo.exigirQueCaiba(tenantId, body.brand_id, agora);
    await this.limite.consume(`pecas:${body.brand_id}`, PEDIDOS_POR_DIA, 86_400);
    const id = uuidv7();
    const novo = await tx.execute<{ id: string }>(sql`
      insert into liame.ad_piece_request (id, tenant_id, brand_id, kind, offer, dossier_version, destination, variations, instruction, reference_ad_id, reference_name, requested_by)
      values (${id}, ${tenantId}, ${body.brand_id}, 'texto', ${body.offer}, ${marca.versao}, ${body.destination}, ${body.variations}, ${instrucao},
              ${referencia?.id ?? null}, ${referencia?.name ?? null}, ${auth.userId})
      on conflict (brand_id) where status in ('pendente', 'gerando') and piece_id is null do nothing
      returning id`);
    if (!novo.rows[0]) {
      throw new AppProblem(409, 'lote-em-andamento', 'O Criativo ainda está fazendo o pedido anterior', 'Espere as peças do pedido anterior desta marca ficarem prontas para pedir outras.');
    }
    auditDetail({ resourceId: id, after: { brand_id: body.brand_id, destination: body.destination, variations: body.variations, dossier_version: marca.versao, com_instrucao: instrucao !== null, com_referencia: referencia !== null } });
    return this.pedidoPorId(id);
  }

  /** Os pedidos de peça da marca, os mais novos primeiro (até 50). */
  async pedidos(auth: AuthContext, brandId: string): Promise<AdPieceRequestListResponse> {
    this.empresa(auth);
    await this.exigirMarca(brandId);
    const r = await currentTx().execute<LinhaDoPedido>(sql`
      select ${COLUNAS_DO_PEDIDO} from liame.ad_piece_request r left join liame.app_user u on u.id = r.requested_by
       where r.brand_id = ${brandId}
       order by r.created_at desc, r.id desc
       limit 50`);
    return { items: r.rows.map(respostaDoPedido) };
  }

  /** As peças da marca, as mais novas primeiro (até 100), com a versão atual de cada uma. */
  async lista(auth: AuthContext, query: AdPieceListQuery): Promise<AdPieceListResponse> {
    this.empresa(auth);
    await this.exigirMarca(query.brand_id);
    return { items: await pecasComAVersaoAtual(sql`p.brand_id = ${query.brand_id} ${query.status ? sql`and p.status = ${query.status}` : sql``}`, 100) };
  }

  /** Uma peça, com todas as versões e as decisões (das mais novas para as mais antigas) e a conferência de cada versão. */
  async detalhe(auth: AuthContext, id: string): Promise<AdPieceResponse> {
    this.empresa(auth);
    const peca = await pecaComHistorico(id);
    if (!peca) throw naoEncontrado('Esta peça não existe nesta empresa.');
    return peca;
  }

  /** A flag do Criativo, a IA da empresa e o funcionário ativo (pelo plano e pela própria empresa). */
  private async ligado(auth: AuthContext, tenantId: string, brandId: string): Promise<boolean> {
    const contexto = { tenantId, userId: auth.userId, brandId };
    if (!(await this.flags.isEnabled(FLAG_DO_CRIATIVO, this.flags.context(contexto)))) return false;
    if (!(await this.gateway.ligada(contexto))) return false;
    return funcionarioAtivo(currentTx(), { tenantId, brandId, agentKey: CRIATIVO.key, ativoPorPadrao: CRIATIVO.ativoPorPadrao });
  }

  /** O pedido de peças novas da marca que está na fila ou sendo feito. */
  private async loteEmAndamento(brandId: string): Promise<AdPieceRequestResponse | null> {
    const r = await currentTx().execute<LinhaDoPedido>(sql`
      select ${COLUNAS_DO_PEDIDO} from liame.ad_piece_request r left join liame.app_user u on u.id = r.requested_by
       where r.brand_id = ${brandId} and r.status in ('pendente', 'gerando') and r.piece_id is null`);
    return r.rows[0] ? respostaDoPedido(r.rows[0]) : null;
  }

  /** O anúncio de referência precisa ser de uma conta desta marca. */
  private async anuncioDaMarca(brandId: string, adId: string): Promise<{ id: string; name: string }> {
    const r = await currentTx().execute<{ id: string; name: string }>(sql`
      select a.id, a.name from liame.ad a join liame.connected_account ca on ca.id = a.connected_account_id
       where a.id = ${adId} and ca.brand_id = ${brandId}`);
    const anuncio = r.rows[0];
    if (!anuncio) throw new AppProblem(422, 'anuncio-desconhecido', 'Este anúncio não é desta marca', 'Escolha um anúncio da lista dos que já trouxeram pedidos, ou peça sem anúncio de referência.');
    return { id: anuncio.id, name: anuncio.name.trim().slice(0, 300) || 'Anúncio sem nome' };
  }

  private async pedidoPorId(id: string): Promise<AdPieceRequestResponse> {
    const r = await currentTx().execute<LinhaDoPedido>(sql`
      select ${COLUNAS_DO_PEDIDO} from liame.ad_piece_request r left join liame.app_user u on u.id = r.requested_by where r.id = ${id}`);
    return respostaDoPedido(r.rows[0]!);
  }

  private empresa(auth: AuthContext): string {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa', 'Sem empresa ativa', 'Escolha uma empresa para continuar.');
    return auth.tenantId;
  }

  private async exigirMarca(brandId: string): Promise<void> {
    const r = await currentTx().execute(sql`select 1 from liame.brand where id = ${brandId} and archived_at is null`);
    if (!r.rows.length) throw naoEncontrado('Esta marca não existe nesta empresa.');
  }
}
