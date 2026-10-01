import type {
  CouponCampaign,
  CouponItem,
  CouponListResponse,
  CouponRequest,
  CouponRequestResponse,
  CouponResponse,
  CouponStore,
  CreateExternalCouponRequest,
  CreateRegemCouponRequest,
  LinkCouponRequest,
  OrderPlatformResponse,
  SetOrderPlatformRequest,
} from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { ActionService, PREFIXO_RECUSA } from '../actions/action.service.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem, type FieldError, ValidationProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { frescor } from '../media/frescor.js';
import { centavosParaMicros } from '../orders/order-store.js';
import { diaNoFuso, enderecoDoCardapio, type MotivoEndereco, sugerirPlataforma } from './plataforma.js';
import { campanhaDoVinculo, type CupomTravado, FUSO_PADRAO, type Ligacao, ligacaoEmVigor, ligarCupom, reatribuirLigacao, travarCupom, type VinculoFeito } from './vinculo.js';

// Cupons de campanha (A2.5, F6): tudo na transação da requisição, sob a RLS da empresa. Os cupons do Regem
// vêm da leitura (F4); o de outra plataforma de pedidos (Anota AI, CardápioWeb) a empresa informa, e o Liame
// o reconhece pelo código nos pedidos que chegam ao Regem. Ligar, desligar e informar refazem na hora a
// atribuição dos pedidos com o código (o motor lê o período da ligação).
//
// Criar o cupom no Regem (F6 parte 2) não acontece aqui: esta camada só monta o PEDIDO e o entrega ao Action
// Service (ferramenta `regem_cupom_criar`), que passa pela política, pela aprovação e pela flag `regem_write`.

const DIA_MS = 86_400_000;
/** Janela do "Usos em 7 dias" e do gasto do aviso de cupom sem uso (protótipo P3). */
const DIAS_USOS = 7;
/** A ferramenta do Action Service que cria o cupom na loja do Regem. */
const FERRAMENTA_CUPOM = 'regem_cupom_criar';
/** Por quantos dias o pedido que falhou ou expirou continua na lista (com o motivo). */
const DIAS_PEDIDO_ENCERRADO = 3;
const MICROS_POR_CENTAVO = 10_000n;
/** Teto do desconto em valor e do pedido mínimo: R$ 1.000.000,00 (o mesmo da ferramenta). */
const MAX_CENTAVOS = 100_000_000n;

/** Micros em texto → centavos inteiros; nulo quando não é centavo inteiro ou passa do teto. */
function microsParaCentavos(micros: string): number | null {
  const m = BigInt(micros);
  if (m < 0n || m % MICROS_POR_CENTAVO !== 0n || m / MICROS_POR_CENTAVO > MAX_CENTAVOS) return null;
  return Number(m / MICROS_POR_CENTAVO);
}

const iso = (v: Date | string) => new Date(v).toISOString();
const naoEncontrado = (detail: string) => new AppProblem(404, 'nao-encontrado', 'Não encontramos', detail);

const MOTIVO_ENDERECO: Record<MotivoEndereco, string> = {
  invalido: 'O endereço do cardápio não é válido.',
  esquema: 'O endereço do cardápio precisa começar por https://.',
  credenciais: 'O endereço do cardápio não pode ter usuário ou senha.',
  sem_dominio: 'O endereço do cardápio precisa ter um domínio, como https://pedidos.sualoja.com.br.',
};

type LinhaLoja = {
  id: string;
  name: string;
  unit_id: string | null;
  unit_name: string | null;
  fuso: string;
  order_platform: string | null;
  order_platform_url: string | null;
  order_platform_set_at: Date | string | null;
  cardapio: string | null;
  last_success_at: Date | string | null;
  expected_every_minutes: number | null;
  last_error: string | null;
  pode_criar: boolean;
};

type LinhaPedido = {
  id: string;
  account_id: string;
  params: Record<string, unknown>;
  status: string;
  status_reason: string | null;
  requested_by: string;
  requester: string;
  created_at: Date | string;
  expires_at: Date | string;
  campaign_id: string | null;
  campaign_name: string | null;
  campaign_provider: string | null;
  campaign_status: string | null;
};

type LinhaCupom = {
  id: string;
  code: string;
  origin: string;
  platform: string | null;
  connected_account_id: string;
  kind: string;
  percent: number | null;
  value_micros: string | null;
  min_order_micros: string | null;
  max_discount_micros: string | null;
  valid_from: Date | string | null;
  valid_until: Date | string | null;
  active: boolean;
  first_seen_at: Date | string;
  usos: number;
  receita: string;
  link_id: string | null;
  exclusive: boolean | null;
  linked_at: Date | string | null;
  unlinked_at: Date | string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  campaign_provider: string | null;
  campaign_status: string | null;
};

/** O cupom travado para mudar a ligação (uma mudança por vez no mesmo cupom). */
function montarLoja(l: LinhaLoja, agora: Date): CouponStore {
  return {
    connected_account_id: l.id,
    unit: l.unit_id && l.unit_name ? { id: l.unit_id, name: l.unit_name } : null,
    store_name: l.name,
    timezone: l.fuso,
    order_platform: (l.order_platform as CouponStore['order_platform']) ?? null,
    order_platform_url: l.order_platform_url,
    order_platform_set_at: l.order_platform_set_at ? iso(l.order_platform_set_at) : null,
    coupons_read_at: l.last_success_at ? iso(l.last_success_at) : null,
    coupons_freshness: frescor({ lastSuccessAt: l.last_success_at, expectedEveryMinutes: l.expected_every_minutes ?? 15 }, agora),
    // Só o tipo da falha: o texto guardado pode ter dado da loja.
    coupons_error: !l.last_error ? null : l.last_error.startsWith('sem_permissao') ? 'sem_permissao' : 'falhou',
    can_create: l.pode_criar,
  };
}

/** O pedido de criação como a aba Cupons mostra: a regra sai dos parâmetros que a ferramenta já validou. */
function montarPedido(l: LinhaPedido): CouponRequest {
  const p = l.params as { codigo: string; tipo: string; percentual?: number; valor_centavos?: number; pedido_minimo_centavos?: number; valido_de: string; valido_ate: string; exclusive: boolean };
  return {
    action_id: l.id,
    code: p.codigo,
    connected_account_id: l.account_id,
    kind: p.tipo,
    percent: p.percentual ?? null,
    value_micros: p.valor_centavos == null ? null : centavosParaMicros(p.valor_centavos).toString(),
    min_order_micros: p.pedido_minimo_centavos ? centavosParaMicros(p.pedido_minimo_centavos).toString() : null,
    valid_from: p.valido_de,
    valid_until: p.valido_ate,
    campaign: l.campaign_id && l.campaign_name ? { id: l.campaign_id, name: l.campaign_name, provider: l.campaign_provider ?? 'desconhecida', status: l.campaign_status ?? 'desconhecida' } : null,
    exclusive: p.exclusive,
    // Recusado por quem aprova: a ação fica cancelada com o motivo; para a aba Cupons, é um pedido recusado.
    status: l.status === 'cancelada' ? 'recusada' : l.status,
    status_reason: l.status_reason,
    requested_by: { id: l.requested_by, name: l.requester },
    requested_at: iso(l.created_at),
    expires_at: iso(l.expires_at),
  };
}

function montarCupom(l: LinhaCupom, gasto: Map<string, string>, agora: Date): CouponItem {
  const campanha: CouponCampaign | null =
    l.campaign_id && l.campaign_name ? { id: l.campaign_id, name: l.campaign_name, provider: l.campaign_provider ?? 'desconhecida', status: l.campaign_status ?? 'desconhecida' } : null;
  return {
    id: l.id,
    code: l.code,
    origin: l.origin,
    platform: l.platform,
    connected_account_id: l.connected_account_id,
    kind: l.kind,
    percent: l.percent === null ? null : Number(l.percent),
    value_micros: l.value_micros,
    min_order_micros: l.min_order_micros,
    max_discount_micros: l.max_discount_micros,
    valid_from: l.valid_from ? iso(l.valid_from) : null,
    valid_until: l.valid_until ? iso(l.valid_until) : null,
    active: l.active,
    expired: l.valid_until !== null && new Date(l.valid_until).getTime() <= agora.getTime(),
    first_seen_at: iso(l.first_seen_at),
    uses_7d: Number(l.usos),
    revenue_7d_micros: l.receita,
    link:
      l.link_id && campanha && l.linked_at
        ? {
            id: l.link_id,
            campaign: campanha,
            exclusive: Boolean(l.exclusive),
            starts_at: iso(l.linked_at),
            ends_at: l.unlinked_at ? iso(l.unlinked_at) : null,
            campaign_spend_7d_micros: gasto.get(campanha.id) ?? null,
          }
        : null,
  };
}

@Injectable()
export class CouponsService {
  constructor(
    private readonly actions: ActionService,
    private readonly flags: FlagService,
  ) {}

  /** Lojas, cupons (com os usos de 7 dias e a ligação em vigor), pedidos de criação, campanhas e a plataforma sugerida pelos anúncios. */
  async list(auth: AuthContext, brandId: string, agora = new Date()): Promise<CouponListResponse> {
    await this.marca(brandId);
    const tx = currentTx();
    const lojas = await this.lojas(sql`a.brand_id = ${brandId}`);
    const cupons = await this.cupons(sql`a.brand_id = ${brandId}`, agora);
    const gasto = await this.gastoDasCampanhas(
      brandId,
      [...new Set(cupons.map((c) => c.campaign_id).filter((c): c is string => c !== null))],
      agora,
    );

    const campanhas = await tx.execute<CouponCampaign>(sql`
      select c.id, c.name, c.provider, c.status
        from liame.campaign c join liame.connected_account a on a.id = c.connected_account_id
       where a.brand_id = ${brandId} and a.disconnected_at is null and a.provider in ('meta_ads', 'google_ads')
         and c.status in ('ativa', 'pausada')
       order by (c.status = 'ativa') desc, c.name, c.id`);

    return {
      stores: lojas.map((l) => montarLoja(l, agora)),
      items: cupons.map((c) => montarCupom(c, gasto, agora)),
      requests: (await this.pedidos(sql`r.brand_id = ${brandId}`)).map(montarPedido),
      campaigns: campanhas.rows,
      detected_platform: await this.plataformaDosAnuncios(
        brandId,
        lojas.map((l) => l.cardapio).filter((c): c is string => typeof c === 'string'),
      ),
      // A mesma flag que o Action Service confere na hora de pedir e de executar (nasce desligada).
      create_in_regem: await this.flags.isEnabled('regem_write', this.flags.context({ tenantId: auth.tenantId, userId: auth.userId, brandId })),
      generated_at: agora.toISOString(),
    };
  }

  /**
   * Pede a criação de um cupom de campanha na loja do Regem. Nada é criado aqui: o pedido entra no Action
   * Service, espera a aprovação de quem pode aprovar e só então o Liame cria o cupom no Regem e o liga à campanha.
   */
  async createInRegem(auth: AuthContext, body: CreateRegemCouponRequest, agora = new Date()): Promise<CouponRequestResponse> {
    const tx = currentTx();
    const loja = await this.lojaDaUnidade(body.unit_id);
    const [conta] = await this.lojas(sql`a.id = ${loja.contaId}`);

    const erros: FieldError[] = [];
    if (body.kind === 'percentual' && body.percent === undefined) erros.push({ path: 'percent', message: 'Informe o desconto em %, de 1 a 100.' });
    if (body.kind !== 'percentual' && body.percent !== undefined) erros.push({ path: 'percent', message: 'O percentual só vale no cupom percentual.' });
    const valor = body.value_micros === undefined ? undefined : microsParaCentavos(body.value_micros);
    if (body.kind === 'valor' && (!valor || valor < 1)) erros.push({ path: 'value_micros', message: 'Informe o valor do desconto, em centavos inteiros, até R$ 1.000.000,00.' });
    if (body.kind !== 'valor' && body.value_micros !== undefined) erros.push({ path: 'value_micros', message: 'O valor só vale no cupom de valor fixo.' });
    const minimo = body.min_order_micros === undefined ? 0 : microsParaCentavos(body.min_order_micros);
    if (minimo === null) erros.push({ path: 'min_order_micros', message: 'Informe o pedido mínimo em centavos inteiros, até R$ 1.000.000,00.' });
    if (body.valid_until < body.valid_from) erros.push({ path: 'valid_until', message: 'O fim da validade não pode ser antes do início.' });
    else if (body.valid_until < diaNoFuso(agora, conta?.fuso ?? FUSO_PADRAO)) erros.push({ path: 'valid_until', message: 'O fim da validade já passou.' });
    if (erros.length) throw new ValidationProblem(erros);

    // A campanha é conferida já no pedido (e de novo na hora de criar): ninguém aprova um cupom de campanha encerrada.
    const campanha = await campanhaDoVinculo(tx, body.campaign_id, loja.brandId);
    const acao = await this.actions.create(auth, {
      tool: FERRAMENTA_CUPOM,
      brand_id: loja.brandId,
      provider: 'regem',
      account_id: loja.contaId,
      resource_id: `cupom:${body.code}`,
      params: {
        codigo: body.code,
        // O nome do cupom no Regem diz de onde ele veio (o da campanha, sem caractere de controle).
        nome: `Liame · ${campanha.name.replace(/\p{Cc}/gu, ' ')}`.slice(0, 80).trim(),
        tipo: body.kind,
        ...(body.kind === 'percentual' ? { percentual: body.percent } : {}),
        ...(body.kind === 'valor' ? { valor_centavos: valor } : {}),
        pedido_minimo_centavos: minimo ?? 0,
        valido_de: body.valid_from,
        valido_ate: body.valid_until,
        campaign_id: campanha.id,
        exclusive: body.exclusive,
      },
    });
    // Política da empresa em modo sombra para esta ação: o pedido só seria registrado, sem nunca criar o cupom.
    // Volta o motivo em vez de deixar a pessoa esperando uma aprovação que não existe (a transação é desfeita).
    if (acao.status === 'sombra') {
      throw new AppProblem(409, 'criacao-em-sombra', 'A política só registra', 'A política da empresa deixa a criação de cupom em modo sombra (registra e não executa). Mude a regra na política para pedir a criação.');
    }
    return { request: await this.pedido(acao.id) };
  }

  /** Cancela o pedido de criação que ainda não foi executado (o cupom não chega a existir no Regem). */
  async cancelRegemRequest(auth: AuthContext, actionId: string): Promise<void> {
    await this.exigirPedido(actionId);
    await this.actions.cancel(auth, actionId);
  }

  /**
   * Liga o cupom a uma campanha, de hoje (ou do dia escolhido) em diante, no fuso da loja. Um cupom fica ligado a
   * uma campanha por vez: o vínculo novo começa depois do fim do anterior, para dois períodos nunca se cruzarem.
   * O mesmo pedido repetido (mesma campanha e mesmo tipo, com o vínculo em vigor) volta sem mudar nada.
   */
  async link(auth: AuthContext, couponId: string, body: LinkCouponRequest, agora = new Date()): Promise<CouponResponse> {
    const cupom = await this.travarCupom(couponId);
    if (cupom.removed_at) throw new AppProblem(422, 'cupom-apagado', 'Cupom apagado no Regem', 'Este cupom foi apagado no Regem e não pode ser ligado a uma campanha.');
    if (!cupom.active) throw new AppProblem(422, 'cupom-desativado', 'Cupom desativado', 'Este cupom está desativado no Regem. Ative-o lá para ligar a uma campanha.');
    if (cupom.valid_until && new Date(cupom.valid_until).getTime() <= agora.getTime()) {
      throw new AppProblem(422, 'cupom-vencido', 'Cupom vencido', 'A validade deste cupom já acabou no Regem.');
    }
    const r = await this.ligar(auth, cupom, body, agora);
    auditDetail({ resourceId: r.ligacaoId, after: { coupon_id: cupom.id, campaign_id: body.campaign_id, exclusive: body.exclusive, starts_on: r.inicio, ends_on: r.fim, repetido: r.repetido } });
    return { item: await this.item(cupom.id, agora), reattributed_orders: r.reatribuidos };
  }

  /**
   * Desliga o cupom da campanha agora: os pedidos até aqui continuam valendo para ela; os próximos, não. O vínculo
   * agendado que ainda não começou é apagado. Sem vínculo em vigor, volta como está.
   */
  async unlink(couponId: string, agora = new Date()): Promise<CouponResponse> {
    const tx = currentTx();
    const cupom = await this.travarCupom(couponId);
    const atual = await this.ligacaoEmVigor(cupom.id);
    let reatribuidos = 0;
    if (atual) {
      // Agendado ou em vigor pelo relógio do banco (o mesmo das regras e do motor), não pelo do servidor.
      const apagado = await tx.execute<{ id: string }>(sql`delete from liame.campaign_coupon where id = ${atual.id} and linked_at >= now() returning id`);
      if (!apagado.rows[0]) {
        await tx.execute(sql`update liame.campaign_coupon set unlinked_at = now() where id = ${atual.id}`);
        if (atual.exclusive) reatribuidos = await this.reatribuir(cupom.tenant_id, atual.id);
      }
    }
    auditDetail({
      resourceId: atual?.id ?? cupom.id,
      before: atual ? { coupon_id: cupom.id, campaign_id: atual.campaign_id, exclusive: atual.exclusive, starts_at: iso(atual.linked_at) } : null,
      after: atual ? { desligado: true } : { sem_vinculo: true },
    });
    return { item: await this.item(cupom.id, agora), reattributed_orders: reatribuidos };
  }

  /**
   * Cupom de outra plataforma de pedidos: o código, como a plataforma manda no pedido que chega ao Regem, já
   * ligado à campanha. O Liame não cria nem muda nada na plataforma; a regra e a validade ficam lá.
   */
  async createExternal(auth: AuthContext, body: CreateExternalCouponRequest, agora = new Date()): Promise<CouponResponse> {
    const tx = currentTx();
    const loja = await this.lojaDaUnidade(body.unit_id);
    const codigo = body.code.trim().toUpperCase();
    const existente = (
      await tx.execute<{ id: string }>(sql`
        select id from liame.coupon where connected_account_id = ${loja.contaId} and code = ${codigo} and removed_at is null limit 1`)
    ).rows[0];
    if (existente) throw new AppProblem(409, 'cupom-ja-existe', 'Cupom já na lista', 'Esse código já está na lista desta loja: ligue o cupom que já existe a uma campanha.');

    const id = uuidv7();
    const novo = await tx.execute<{ id: string }>(sql`
      insert into liame.coupon (id, tenant_id, brand_id, connected_account_id, external_id, code, kind, active, uses_count,
                                source_version, source_updated_at, origin, platform, created_by)
      values (${id}, ${auth.tenantId}, ${loja.brandId}, ${loja.contaId}, ${`externo:${codigo}`}, ${codigo}, 'outro', true, 0,
              0, now(), 'externo', ${body.platform}, ${auth.userId})
      on conflict (connected_account_id, external_id) do nothing
      returning id`);
    if (!novo.rows[0]) throw new AppProblem(409, 'cupom-ja-existe', 'Cupom já na lista', 'Esse código já está na lista desta loja: ligue o cupom que já existe a uma campanha.');

    const cupom = await this.travarCupom(id);
    const r = await this.ligar(auth, cupom, { campaign_id: body.campaign_id, exclusive: body.exclusive }, agora);
    auditDetail({ resourceId: id, after: { code: codigo, platform: body.platform, unit_id: body.unit_id, campaign_id: body.campaign_id, exclusive: body.exclusive, link_id: r.ligacaoId } });
    return { item: await this.item(id, agora), reattributed_orders: r.reatribuidos };
  }

  /** Onde a loja recebe os pedidos online, informado pela empresa. */
  async setOrderPlatform(auth: AuthContext, unitId: string, body: SetOrderPlatformRequest, agora = new Date()): Promise<OrderPlatformResponse> {
    const tx = currentTx();
    const loja = await this.lojaDaUnidade(unitId);
    let url: string | null = null;
    if (body.platform === 'outra') {
      if (!body.url) throw new AppProblem(422, 'endereco-obrigatorio', 'Falta o endereço', 'Informe o endereço do cardápio, começando com https://.');
      const e = enderecoDoCardapio(body.url);
      if (!e.ok) throw new AppProblem(422, 'endereco-invalido', 'Endereço não aceito', MOTIVO_ENDERECO[e.motivo]);
      url = e.url;
    }
    const antes = (
      await tx.execute<{ order_platform: string | null; order_platform_url: string | null }>(sql`
        select order_platform, order_platform_url from liame.unit where id = ${unitId} for update`)
    ).rows[0];
    await tx.execute(sql`
      update liame.unit set order_platform = ${body.platform}, order_platform_url = ${url},
             order_platform_set_at = now(), order_platform_set_by = ${auth.userId}
       where id = ${unitId}`);
    auditDetail({ resourceId: unitId, before: antes ?? null, after: { order_platform: body.platform, order_platform_url: url } });
    const [store] = await this.lojas(sql`a.id = ${loja.contaId}`);
    return { store: montarLoja(store!, agora) };
  }

  // ------------------------------------------------------------------ apoio

  private async marca(brandId: string): Promise<void> {
    const r = await currentTx().execute<{ id: string }>(sql`select id from liame.brand where id = ${brandId} and archived_at is null`);
    if (!r.rows[0]) throw naoEncontrado('Marca não encontrada nesta empresa.');
  }

  /** A loja do Liame e a conexão do Regem dela (a mais recente). */
  private async lojaDaUnidade(unitId: string): Promise<{ brandId: string; contaId: string }> {
    const r = await currentTx().execute<{ brand_id: string; conta_id: string | null }>(sql`
      select u.brand_id,
             (select a.id from liame.connected_account a
               where a.provider = 'regem' and a.unit_id = u.id and a.brand_id = u.brand_id and a.disconnected_at is null
               order by a.connected_at desc, a.id limit 1) as conta_id
        from liame.unit u join liame.brand b on b.id = u.brand_id and b.archived_at is null
       where u.id = ${unitId}`);
    const l = r.rows[0];
    if (!l) throw naoEncontrado('Loja não encontrada nesta empresa.');
    if (!l.conta_id) throw new AppProblem(422, 'loja-sem-regem', 'Loja sem o Regem', 'Esta loja não tem o Regem conectado: conecte o Regem e ligue a loja em Contas conectadas.');
    return { brandId: l.brand_id, contaId: l.conta_id };
  }

  private travarCupom(couponId: string): Promise<CupomTravado> {
    return travarCupom(currentTx(), couponId);
  }

  private ligacaoEmVigor(couponId: string): Promise<Ligacao | null> {
    return ligacaoEmVigor(currentTx(), couponId);
  }

  /** Grava o vínculo (com o cupom já travado) e refaz a atribuição dos pedidos com o código, se ele for exclusivo. */
  private ligar(auth: AuthContext, cupom: CupomTravado, body: LinkCouponRequest, agora: Date): Promise<VinculoFeito> {
    return ligarCupom(currentTx(), { userId: auth.userId, cupom, body, agora });
  }

  /** Os pedidos com o código do cupom desde o início do vínculo passam de novo pelo motor. */
  private reatribuir(tenantId: string, ligacaoId: string): Promise<number> {
    return reatribuirLigacao(currentTx(), tenantId, ligacaoId);
  }

  private async item(couponId: string, agora: Date): Promise<CouponItem> {
    const [linha] = await this.cupons(sql`true`, agora, couponId);
    if (!linha) throw naoEncontrado('Cupom não encontrado nesta empresa.');
    const gasto = await this.gastoDasCampanhas(null, linha.campaign_id ? [linha.campaign_id] : [], agora);
    return montarCupom(linha, gasto, agora);
  }

  private async lojas(filtro: SQL): Promise<LinhaLoja[]> {
    const r = await currentTx().execute<LinhaLoja>(sql`
      select a.id, a.name, a.unit_id, u.name as unit_name, coalesce(u.timezone, a.timezone, ${FUSO_PADRAO}) as fuso,
             u.order_platform, u.order_platform_url, u.order_platform_set_at,
             a.provider_attributes->>'cardapio_url' as cardapio,
             s.last_success_at, s.expected_every_minutes, s.last_error,
             coalesce(a.provider_attributes -> 'escopos' @> '["cupons.criar"]'::jsonb, false) as pode_criar
        from liame.connected_account a
        left join liame.unit u on u.id = a.unit_id
        left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = 'cupons'
       where a.provider = 'regem' and a.disconnected_at is null and ${filtro}
       order by u.name nulls last, a.name, a.id`);
    return r.rows;
  }

  /**
   * Pedidos de criação de cupom no Regem, de lojas ainda conectadas: os que estão em andamento e, por 3 dias, os
   * que falharam, expiraram ou foram recusados por quem aprova — estes só enquanto o cupom não existe e ninguém
   * pediu o mesmo código de novo. O pedido cancelado por quem pediu não aparece.
   */
  private async pedidos(filtro: SQL): Promise<LinhaPedido[]> {
    const r = await currentTx().execute<LinhaPedido>(sql`
      select r.id, r.account_id, r.params, r.status, r.status_reason, r.requested_by, u.name as requester, r.created_at, r.expires_at,
             c.id as campaign_id, c.name as campaign_name, c.provider as campaign_provider, c.status as campaign_status
        from liame.action_request r
        join liame.connected_account a on a.id::text = r.account_id and a.provider = 'regem' and a.disconnected_at is null
        join liame.app_user u on u.id = r.requested_by
        left join liame.campaign c on c.id::text = r.params->>'campaign_id'
       where r.tool = ${FERRAMENTA_CUPOM} and r.provider = 'regem' and ${filtro}
         and (r.status in ('aguardando_aprovacao', 'aprovada', 'executando')
              or ((r.status in ('falhou', 'expirada') or (r.status = 'cancelada' and starts_with(coalesce(r.status_reason, ''), ${PREFIXO_RECUSA})))
                  and r.updated_at > now() - make_interval(days => ${DIAS_PEDIDO_ENCERRADO})
                  and not exists (select 1 from liame.coupon cp
                                   where cp.connected_account_id = a.id and cp.code = r.params->>'codigo' and cp.removed_at is null)
                  and not exists (select 1 from liame.action_request n
                                   where n.tenant_id = r.tenant_id and n.tool = r.tool and n.account_id = r.account_id
                                     and n.resource_id = r.resource_id and n.created_at > r.created_at)))
       order by r.created_at desc, r.id desc limit 50`);
    return r.rows;
  }

  /** Um pedido de criação da lista, pelo id da ação. */
  private async pedido(actionId: string): Promise<CouponRequest> {
    const [linha] = await this.pedidos(sql`r.id = ${actionId}`);
    if (!linha) throw naoEncontrado('Pedido de cupom não encontrado nesta empresa.');
    return montarPedido(linha);
  }

  /** A ação é um pedido de cupom desta empresa (a rota de cancelar da aba Cupons não cancela outro tipo de ação). */
  private async exigirPedido(actionId: string): Promise<void> {
    const r = await currentTx().execute<{ id: string }>(sql`select id from liame.action_request where id = ${actionId} and tool = ${FERRAMENTA_CUPOM}`);
    if (!r.rows[0]) throw naoEncontrado('Pedido de cupom não encontrado nesta empresa.');
  }

  /**
   * Cupons das lojas do Regem pelo filtro (sem os apagados na origem), com os pedidos confirmados dos últimos 7
   * dias com o código e a ligação em vigor ou agendada. Ligados primeiro, depois pelo código.
   */
  private async cupons(filtroConta: SQL, agora: Date, couponId?: string): Promise<LinhaCupom[]> {
    const desde = new Date(agora.getTime() - DIAS_USOS * DIA_MS).toISOString();
    const r = await currentTx().execute<LinhaCupom>(sql`
      with cupons as (
        select cp.* from liame.coupon cp
          join liame.connected_account a on a.id = cp.connected_account_id
         where a.provider = 'regem' and a.disconnected_at is null and ${filtroConta}
           and cp.removed_at is null ${couponId ? sql`and cp.id = ${couponId}` : sql``}
      ),
      usos as (
        select cp.id, count(o.id)::int as n, coalesce(sum(o.revenue_micros - o.refunded_micros), 0)::text as receita
          from cupons cp
          join liame.order_fact o on o.tenant_id = cp.tenant_id and o.coupon_code = cp.code and o.connected_account_id = cp.connected_account_id
         where o.status = 'confirmado' and o.confirmed_at >= ${desde}::timestamptz
         group by cp.id
      ),
      ligacao as (
        select distinct on (cc.coupon_id) cc.* from liame.campaign_coupon cc
         where cc.coupon_id in (select id from cupons) and (cc.unlinked_at is null or cc.unlinked_at > now())
         order by cc.coupon_id, cc.linked_at desc
      )
      select cp.id, cp.code, cp.origin, cp.platform, cp.connected_account_id, cp.kind, cp.percent::float8 as percent,
             cp.value_micros::text as value_micros, cp.min_order_micros::text as min_order_micros,
             cp.max_discount_micros::text as max_discount_micros, cp.valid_from, cp.valid_until, cp.active, cp.first_seen_at,
             coalesce(us.n, 0) as usos, coalesce(us.receita, '0') as receita,
             l.id as link_id, l.exclusive, l.linked_at, l.unlinked_at,
             c.id as campaign_id, c.name as campaign_name, c.provider as campaign_provider, c.status as campaign_status
        from cupons cp
        left join usos us on us.id = cp.id
        left join ligacao l on l.coupon_id = cp.id
        left join liame.campaign c on c.id = l.campaign_id
       order by (l.id is null), cp.code, cp.id`);
    return r.rows;
  }

  /** Gasto dos últimos 7 dias (no fuso de cada conta de anúncio) das campanhas: Meta pelo anúncio, Google pela campanha. */
  private async gastoDasCampanhas(brandId: string | null, campanhas: string[], agora: Date): Promise<Map<string, string>> {
    if (!campanhas.length) return new Map();
    const r = await currentTx().execute<{ campaign_id: string; micros: string }>(sql`
      select coalesce(g.campaign_id, cd.id) as campaign_id, round(sum(ml.metric_value) * 1000000)::bigint::text as micros
        from liame.metric_latest ml
        join liame.connected_account a on a.id = ml.connected_account_id
        left join liame.ad ad on ml.level = 'ad' and ad.id = ml.entity_id
        left join liame.ad_group g on g.id = ad.ad_group_id
        left join liame.campaign cd on ml.level = 'campaign' and cd.id = ml.entity_id
       where a.provider in ('meta_ads', 'google_ads') ${brandId ? sql`and a.brand_id = ${brandId}` : sql``}
         and ((a.provider = 'meta_ads' and ml.level = 'ad') or (a.provider = 'google_ads' and ml.level = 'campaign'))
         and ml.metric_name = 'spend' and ml.attribution_window = ''
         and ml.metric_date > (${agora.toISOString()}::timestamptz at time zone coalesce(a.timezone, ${FUSO_PADRAO}))::date - ${DIAS_USOS}::int
         and coalesce(g.campaign_id, cd.id) in ${campanhas}
       group by 1`);
    return new Map(r.rows.map((l) => [l.campaign_id, l.micros]));
  }

  /** A plataforma de pedidos sugerida pelo destino dos anúncios ativos da marca (o que o conector leu do link). */
  private async plataformaDosAnuncios(brandId: string, cardapios: string[]): Promise<CouponListResponse['detected_platform']> {
    const r = await currentTx().execute<{ ad_id: string; provider: string; url: string }>(sql`
      select ad.id as ad_id, ad.provider, d.value->>'url' as url
        from liame.connected_account ct
        join liame.ad ad on ad.connected_account_id = ct.id
        join liame.ad_group g on g.id = ad.ad_group_id
        join liame.campaign c on c.id = g.campaign_id
        left join liame.creative cr on cr.id = ad.creative_id
        cross join lateral jsonb_array_elements(
          coalesce(case when ad.provider = 'meta_ads' then cr.provider_attributes else ad.provider_attributes end -> 'rastreio' -> 'destinos', '[]'::jsonb)) d
       where ct.brand_id = ${brandId} and ct.disconnected_at is null and ct.provider in ('meta_ads', 'google_ads')
         and ad.status = 'ativa' and g.status = 'ativa' and c.status = 'ativa'
         and jsonb_typeof(d.value) = 'object' and d.value->>'url' is not null`);
    return sugerirPlataforma(
      r.rows.map((l) => ({ adId: l.ad_id, provider: l.provider, url: l.url })),
      cardapios,
    );
  }
}
