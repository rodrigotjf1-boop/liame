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
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem, type FieldError } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { valoresComerciais } from '../policy/anuncio.js';
import { diaNoFuso, menosDias } from '../results/fora-do-normal.js';
import { ResultsService } from '../results/results.service.js';
import { type LinhaDaPeca, type LinhaDaVersao, type LinhaDoPedido, respostaDaPeca, respostaDoPedido } from './apresentacao.js';
import { type MarcaDoCriativo, marcaDoCriativo, mensagemDoProblema } from './base.js';

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

const COLUNAS_DO_PEDIDO = sql`r.id, r.brand_id, r.kind, r.offer, r.dossier_version, r.destination, r.variations, r.instruction, r.reference_ad_id, r.reference_name,
  r.piece_id, r.status, r.reason, r.pieces, r.requested_by, u.name as requester, r.created_at, r.finished_at`;
const COLUNAS_DA_PECA = sql`p.id, p.brand_id, p.request_id, p.status, q.offer, q.destination,
  exists (select 1 from liame.ad_piece_version x where x.piece_id = p.id and x.author = 'criativo') as ai_generated,
  p.decided_by, d.name as decider, p.decided_at, p.created_at, p.updated_at`;
const COLUNAS_DA_VERSAO = sql`v.version, v.title, v.body, v.button, v.review, v.content_hash, v.author, v.created_by, c.name as creator, v.created_at`;

const naoEncontrado = (detail: string) => new AppProblem(404, 'nao-encontrado', 'Não encontramos', detail);

@Injectable()
export class PecasService {
  constructor(
    private readonly gateway: AiGateway,
    private readonly flags: FlagService,
    private readonly limite: RateLimitService,
    private readonly resultados: ResultsService,
  ) {}

  /** O que a tela de pedir uma peça precisa: se dá para pedir agora, as ofertas de Minha marca e os anúncios que já vendem. */
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
    const motivo = !ligado ? 'criativo_desligado' : !marca ? 'sem_dossie' : !ofertas.length ? 'sem_oferta' : emAndamento ? 'lote_em_andamento' : null;
    return {
      brand_id: brandId,
      available: motivo === null,
      reason: motivo,
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
    const tx = currentTx();
    const pecas = await tx.execute<LinhaDaPeca & { version: number }>(sql`
      select ${COLUNAS_DA_PECA}, p.version
        from liame.ad_piece p
        join liame.ad_piece_request q on q.id = p.request_id
        left join liame.app_user d on d.id = p.decided_by
       where p.brand_id = ${query.brand_id} ${query.status ? sql`and p.status = ${query.status}` : sql``}
       order by p.created_at desc, p.id desc
       limit 100`);
    if (!pecas.rows.length) return { items: [] };
    // A versão atual de cada peça listada (o Drizzle abre a lista em parâmetros: `in`, nunca `= any`, V16).
    const ids = pecas.rows.map((p) => p.id);
    const versoes = await tx.execute<LinhaDaVersao & { piece_id: string }>(sql`
      select v.piece_id, ${COLUNAS_DA_VERSAO}
        from liame.ad_piece_version v
        join liame.ad_piece p on p.id = v.piece_id and p.version = v.version
        left join liame.app_user c on c.id = v.created_by
       where v.piece_id in ${ids}`);
    const atual = new Map(versoes.rows.map((v) => [v.piece_id, v]));
    return { items: pecas.rows.filter((p) => atual.has(p.id)).map((p) => respostaDaPeca(p, atual.get(p.id)!)) };
  }

  /** Uma peça, com todas as versões (da mais nova para a mais antiga) e a conferência de cada uma. */
  async detalhe(auth: AuthContext, id: string): Promise<AdPieceResponse> {
    this.empresa(auth);
    const tx = currentTx();
    const peca = (
      await tx.execute<LinhaDaPeca & { version: number }>(sql`
        select ${COLUNAS_DA_PECA}, p.version
          from liame.ad_piece p
          join liame.ad_piece_request q on q.id = p.request_id
          left join liame.app_user d on d.id = p.decided_by
         where p.id = ${id}`)
    ).rows[0];
    if (!peca) throw naoEncontrado('Esta peça não existe nesta empresa.');
    const versoes = await tx.execute<LinhaDaVersao>(sql`
      select ${COLUNAS_DA_VERSAO} from liame.ad_piece_version v left join liame.app_user c on c.id = v.created_by
       where v.piece_id = ${id}
       order by v.version desc`);
    const atual = versoes.rows.find((v) => v.version === peca.version);
    if (!atual) throw new Error(`peça ${id}: sem a versão ${peca.version}`);
    return respostaDaPeca(peca, atual, versoes.rows);
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
