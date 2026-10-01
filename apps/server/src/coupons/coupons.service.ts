import type {
  CouponCampaign,
  CouponItem,
  CouponListResponse,
  CouponResponse,
  CouponStore,
  CreateExternalCouponRequest,
  LinkCouponRequest,
  OrderPlatformResponse,
  SetOrderPlatformRequest,
} from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { atribuirPedidos, pedidosDoCupomDeCampanha } from '../attribution/motor.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { frescor } from '../media/frescor.js';
import { diaNoFuso, enderecoDoCardapio, type MotivoEndereco, periodoDoVinculo, sugerirPlataforma } from './plataforma.js';

// Cupons de campanha (A2.5, F6): tudo na transação da requisição, sob a RLS da empresa. Os cupons do Regem
// vêm da leitura (F4); o de outra plataforma de pedidos (Anota AI, CardápioWeb) a empresa informa, e o Liame
// o reconhece pelo código nos pedidos que chegam ao Regem. Ligar, desligar e informar refazem na hora a
// atribuição dos pedidos com o código (o motor lê o período da ligação).

const DIA_MS = 86_400_000;
/** Janela do "Usos em 7 dias" e do gasto do aviso de cupom sem uso (protótipo P3). */
const DIAS_USOS = 7;
const FUSO_PADRAO = 'America/Sao_Paulo';

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
type CupomTravado = { id: string; tenant_id: string; brand_id: string; code: string; removed_at: Date | string | null; valid_until: Date | string | null; active: boolean; fuso: string };

type Ligacao = { id: string; campaign_id: string; exclusive: boolean; linked_at: Date | string; unlinked_at: Date | string | null };

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
  /** Lojas, cupons (com os usos de 7 dias e a ligação em vigor), campanhas e a plataforma sugerida pelos anúncios. */
  async list(brandId: string, agora = new Date()): Promise<CouponListResponse> {
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
      campaigns: campanhas.rows,
      detected_platform: await this.plataformaDosAnuncios(
        brandId,
        lojas.map((l) => l.cardapio).filter((c): c is string => typeof c === 'string'),
      ),
      create_in_regem: false,
      generated_at: agora.toISOString(),
    };
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

  private async travarCupom(couponId: string): Promise<CupomTravado> {
    const r = await currentTx().execute<CupomTravado>(sql`
      select cp.id, cp.tenant_id, cp.brand_id, cp.code, cp.removed_at, cp.valid_until, cp.active,
             coalesce(u.timezone, a.timezone, ${FUSO_PADRAO}) as fuso
        from liame.coupon cp
        join liame.connected_account a on a.id = cp.connected_account_id
        left join liame.unit u on u.id = a.unit_id
       where cp.id = ${couponId}
         for update of cp`);
    if (!r.rows[0]) throw naoEncontrado('Cupom não encontrado nesta empresa.');
    return r.rows[0];
  }

  private async ligacaoEmVigor(couponId: string): Promise<Ligacao | null> {
    const r = await currentTx().execute<Ligacao>(sql`
      select id, campaign_id, exclusive, linked_at, unlinked_at from liame.campaign_coupon
       where coupon_id = ${couponId} and (unlinked_at is null or unlinked_at > now())
       order by linked_at desc limit 1`);
    return r.rows[0] ?? null;
  }

  /** Grava o vínculo (com o cupom já travado) e refaz a atribuição dos pedidos com o código, se ele for exclusivo. */
  private async ligar(
    auth: AuthContext,
    cupom: CupomTravado,
    body: LinkCouponRequest,
    agora: Date,
  ): Promise<{ ligacaoId: string; inicio: string; fim: string | null; reatribuidos: number; repetido: boolean }> {
    const tx = currentTx();
    const campanha = (
      await tx.execute<{ id: string; name: string; provider: string; status: string; brand_id: string }>(sql`
        select c.id, c.name, c.provider, c.status, a.brand_id
          from liame.campaign c join liame.connected_account a on a.id = c.connected_account_id
         where c.id = ${body.campaign_id}`)
    ).rows[0];
    if (!campanha) throw naoEncontrado('Campanha não encontrada nesta empresa.');
    if (campanha.brand_id !== cupom.brand_id) throw new AppProblem(422, 'campanha-fora-da-marca', 'Campanha de outra marca', 'Escolha uma campanha da mesma marca da loja do cupom.');
    if (campanha.provider !== 'meta_ads' && campanha.provider !== 'google_ads') {
      throw new AppProblem(422, 'plataforma-sem-cupom', 'Plataforma sem cupom de campanha', 'O cupom de campanha vale para as campanhas da Meta e do Google Ads.');
    }
    if (campanha.status === 'removida' || campanha.status === 'arquivada') {
      throw new AppProblem(422, 'campanha-encerrada', 'Campanha encerrada', 'Esta campanha foi removida ou arquivada na plataforma.');
    }

    const hoje = diaNoFuso(agora, cupom.fuso);
    const periodo = periodoDoVinculo(hoje, body.starts_on, body.ends_on);
    if (!periodo.ok) {
      throw new AppProblem(
        422,
        periodo.motivo === 'inicio_no_passado' ? 'inicio-no-passado' : periodo.motivo === 'fim_antes_do_inicio' ? 'fim-antes-do-inicio' : 'dia-invalido',
        'Período não aceito',
        periodo.motivo === 'inicio_no_passado'
          ? 'O vínculo começa hoje ou depois.'
          : periodo.motivo === 'fim_antes_do_inicio'
            ? 'O fim do vínculo não pode ser antes do início.'
            : 'Informe as datas do vínculo no formato de calendário.',
      );
    }

    const atual = await this.ligacaoEmVigor(cupom.id);
    if (atual) {
      if (atual.campaign_id === campanha.id && atual.exclusive === body.exclusive && body.starts_on === undefined && body.ends_on == null && atual.unlinked_at === null) {
        return { ligacaoId: atual.id, inicio: periodo.inicio, fim: null, reatribuidos: 0, repetido: true };
      }
      const nome = (await tx.execute<{ name: string }>(sql`select name from liame.campaign where id = ${atual.campaign_id}`)).rows[0]?.name ?? 'outra campanha';
      throw new AppProblem(409, 'cupom-ja-ligado', 'Cupom já ligado', `O cupom já está ligado à campanha ${nome}. Desligue antes de ligar a outra.`);
    }

    const id = uuidv7();
    await tx.execute(sql`
      insert into liame.campaign_coupon (id, tenant_id, brand_id, coupon_id, campaign_id, exclusive, linked_at, unlinked_at, created_by)
      select ${id}, ${cupom.tenant_id}, ${cupom.brand_id}, ${cupom.id}, ${campanha.id}, ${body.exclusive},
             greatest((${periodo.inicio}::date)::timestamp at time zone ${cupom.fuso},
                      coalesce((select max(cc.unlinked_at) from liame.campaign_coupon cc where cc.coupon_id = ${cupom.id}), '-infinity'::timestamptz)),
             case when ${periodo.fim}::date is null then null else ((${periodo.fim}::date + 1)::timestamp at time zone ${cupom.fuso}) end,
             ${auth.userId}`);
    const reatribuidos = body.exclusive ? await this.reatribuir(cupom.tenant_id, id) : 0;
    return { ligacaoId: id, inicio: periodo.inicio, fim: periodo.fim, reatribuidos, repetido: false };
  }

  /** Os pedidos com o código do cupom desde o início do vínculo passam de novo pelo motor. */
  private async reatribuir(tenantId: string, ligacaoId: string): Promise<number> {
    const tx = currentTx();
    const pedidos = await pedidosDoCupomDeCampanha(tx, tenantId, [ligacaoId]);
    if (!pedidos.length) return 0;
    const r = await atribuirPedidos(tx, { tenantId, orderIds: pedidos, gatilho: 'cupons' });
    return r.considerados;
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
             s.last_success_at, s.expected_every_minutes, s.last_error
        from liame.connected_account a
        left join liame.unit u on u.id = a.unit_id
        left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = 'cupons'
       where a.provider = 'regem' and a.disconnected_at is null and ${filtro}
       order by u.name nulls last, a.name, a.id`);
    return r.rows;
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
