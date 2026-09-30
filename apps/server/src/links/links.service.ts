import type {
  CreatedTrackingLinkResponse,
  CreateTrackingLinkRequest,
  LinkCampaignOption,
  LinkDestination,
  LinkListQuery,
  LinkOptionsResponse,
  LinkSource,
  TrackingCheckItem,
  TrackingCheckResponse,
  TrackingLink,
  TrackingLinkDetailResponse,
  TrackingLinkListResponse,
} from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { MODELO_PADRAO } from '../attribution/motor.js';
import type { RastreioLido } from '../connectors/tipos.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { frescor } from '../media/frescor.js';
import { conferirAnuncio, textoDoAviso, tipoDeDestino } from './conferencia.js';
import {
  cardapioValido,
  codigoDoLink,
  destinoNoCardapio,
  linkComRastreio,
  type MotivoDestino,
  parametrosParaColar,
  PLATAFORMAS_DO_LINK,
  type PlataformaDoLink,
  qrSvg,
  REGRAS,
  slugCampanha,
} from './construtor.js';

// Links de campanha (A2.5, F5): tudo na transação da requisição, sob a RLS da empresa, em poucas consultas de
// conjunto. O destino vem da conexão do Regem da loja (`cardapio_url` da rota `/loja`, guardado nos atributos
// da conta conectada); nada de redirecionador no Liame: o link leva direto ao cardápio.

const DIA_MS = 86_400_000;
/** Janela do "Pedidos em 7 dias" da lista (protótipo P3). */
const DIAS_PEDIDOS = 7;
/** Tentativas de código para a mesma chave (colisão de 50 bits: na prática, nunca passa da primeira). */
const TENTATIVAS_CODIGO = 3;

const iso = (v: Date | string) => new Date(v).toISOString();
const naoEncontrado = (detail: string) => new AppProblem(404, 'nao-encontrado', 'Não encontramos', detail);

const MOTIVO_DESTINO: Record<MotivoDestino, string> = {
  invalido: 'O destino não é um endereço válido.',
  longo_demais: 'O destino é longo demais para um link que também vira QR impresso.',
  esquema: 'O destino precisa começar por https://.',
  credenciais: 'O destino não pode ter usuário ou senha no endereço.',
  fora_do_cardapio: 'Só o cardápio da loja (ou uma página dentro dele) pode ser o destino do link.',
  parametro_de_rastreio: 'O destino já tem parâmetros de rastreio (lk, utm, ids de campanha ou de clique): use o endereço sem eles.',
};

type LinhaLink = {
  id: string;
  brand_id: string;
  unit_id: string | null;
  unit_name: string | null;
  name: string;
  code: string;
  provider: string;
  campaign_id: string | null;
  campaign_name: string | null;
  campaign_status: string | null;
  ad_id: string | null;
  ad_name: string | null;
  destination_url: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string | null;
  created_at: Date | string;
  orders_7d: number;
};

type LinhaAnuncio = {
  id: string;
  external_id: string;
  name: string;
  provider: string;
  first_seen_at: Date | string;
  ad_attrs: Record<string, unknown>;
  grupo_externo: string | null;
  grupo_attrs: Record<string, unknown> | null;
  campanha_id: string;
  campanha_externa: string;
  campanha_nome: string;
  criativo_attrs: Record<string, unknown> | null;
  conta_id: string;
};

const ehPlataformaDoLink = (p: string): p is PlataformaDoLink => (PLATAFORMAS_DO_LINK as readonly string[]).includes(p);

/** O rastreio que o conector guardou: no criativo (Meta) ou no anúncio (Google). */
function rastreioDe(l: LinhaAnuncio): RastreioLido | null {
  const attrs = l.provider === 'meta_ads' ? l.criativo_attrs : l.ad_attrs;
  const r = attrs?.rastreio as RastreioLido | undefined;
  return r && Array.isArray(r.destinos) ? r : null;
}

function montarLink(l: LinhaLink): TrackingLink {
  const plataforma = ehPlataformaDoLink(l.provider) ? l.provider : null;
  return {
    id: l.id,
    brand_id: l.brand_id,
    unit: l.unit_id && l.unit_name ? { id: l.unit_id, name: l.unit_name } : null,
    name: l.name,
    code: l.code,
    provider: l.provider,
    campaign: l.campaign_id && l.campaign_name ? { id: l.campaign_id, name: l.campaign_name, status: l.campaign_status ?? 'desconhecida' } : null,
    ad: l.ad_id && l.ad_name ? { id: l.ad_id, name: l.ad_name } : null,
    destination_url: l.destination_url,
    tracking_url: linkComRastreio(l.destination_url, { utmSource: l.utm_source, utmMedium: l.utm_medium, utmCampaign: l.utm_campaign, codigo: l.code }),
    platform_params: plataforma ? { field: REGRAS[plataforma].campo, value: parametrosParaColar(plataforma, l.code) } : null,
    orders_7d: Number(l.orders_7d),
    created_at: iso(l.created_at),
  };
}

@Injectable()
export class LinksService {
  /** Links da marca (ou de uma loja, ou de uma campanha), do mais novo ao mais antigo. */
  async list(q: LinkListQuery, agora = new Date()): Promise<TrackingLinkListResponse> {
    await this.marca(q.brand_id);
    const linhas = await this.links(
      sql`tl.brand_id = ${q.brand_id} ${q.unit_id ? sql`and tl.unit_id = ${q.unit_id}` : sql``} ${q.campaign_id ? sql`and tl.campaign_id = ${q.campaign_id}` : sql``}`,
      agora,
    );
    return { items: linhas.map(montarLink) };
  }

  /** Um link, com o QR do link com rastreio (o mesmo `lk`). */
  async detail(id: string, agora = new Date()): Promise<TrackingLinkDetailResponse> {
    const [linha] = await this.links(sql`tl.id = ${id}`, agora);
    if (!linha) throw naoEncontrado('Link não encontrado nesta empresa.');
    const link = montarLink(linha);
    return { ...link, qr_svg: qrSvg(link.tracking_url) };
  }

  /**
   * Cria o link, ou devolve o que já existe: a chave natural é a loja, a campanha, o anúncio (ou todos) e o
   * destino, e o `lk` sai dela (`codigoDoLink`). Com o índice único `(tenant_id, code)`, criar o mesmo link
   * duas vezes, inclusive ao mesmo tempo, dá um link só; o nome da primeira vez fica.
   */
  async create(auth: AuthContext, body: CreateTrackingLinkRequest, agora = new Date()): Promise<CreatedTrackingLinkResponse> {
    const tx = currentTx();
    const tenantId = auth.tenantId!;
    const nome = body.name.replace(/\s+/g, ' ').trim();

    const loja = (
      await tx.execute<{ id: string; brand_id: string }>(sql`
        select u.id, u.brand_id from liame.unit u join liame.brand b on b.id = u.brand_id and b.archived_at is null where u.id = ${body.unit_id}`)
    ).rows[0];
    if (!loja) throw naoEncontrado('Loja não encontrada nesta empresa.');

    const campanha = (
      await tx.execute<{ id: string; name: string; provider: string; status: string; brand_id: string; destinos: (string | null)[] }>(sql`
        select c.id, c.name, c.provider, c.status, a.brand_id,
               coalesce((select array_agg(g.provider_attributes->>'destination_type') from liame.ad_group g
                          where g.campaign_id = c.id and g.status <> 'removida'), '{}') as destinos
          from liame.campaign c join liame.connected_account a on a.id = c.connected_account_id
         where c.id = ${body.campaign_id}`)
    ).rows[0];
    if (!campanha) throw naoEncontrado('Campanha não encontrada nesta empresa.');
    if (campanha.brand_id !== loja.brand_id) {
      throw new AppProblem(422, 'campanha-fora-da-marca', 'Campanha de outra marca', 'Escolha uma campanha da mesma marca da loja.');
    }
    if (!ehPlataformaDoLink(campanha.provider)) {
      throw new AppProblem(422, 'plataforma-sem-link', 'Plataforma sem link de campanha', 'O link de campanha vale para a Meta e o Google Ads.');
    }
    if (campanha.status === 'removida' || campanha.status === 'arquivada') {
      throw new AppProblem(422, 'campanha-encerrada', 'Campanha encerrada', 'Esta campanha foi removida ou arquivada na plataforma.');
    }
    const tipo = campanha.provider === 'meta_ads' ? tipoDeDestino(campanha.destinos) : 'site';
    if (tipo === 'mensagens' || tipo === 'outro') {
      throw new AppProblem(
        422,
        'campanha-sem-site',
        'Campanha sem link para site',
        tipo === 'mensagens' ? 'Os anúncios desta campanha abrem o WhatsApp: o link do cardápio não entra neles. Use um cupom exclusivo.' : 'Os anúncios desta campanha não levam a um site.',
      );
    }

    let anuncio: { id: string; ad_group_id: string | null } | null = null;
    if (body.ad_id) {
      const a = (
        await tx.execute<{ id: string; ad_group_id: string | null; campaign_id: string | null }>(sql`
          select ad.id, ad.ad_group_id, g.campaign_id from liame.ad ad left join liame.ad_group g on g.id = ad.ad_group_id where ad.id = ${body.ad_id}`)
      ).rows[0];
      if (!a) throw naoEncontrado('Anúncio não encontrado nesta empresa.');
      if (a.campaign_id !== campanha.id) throw new AppProblem(422, 'anuncio-fora-da-campanha', 'Anúncio de outra campanha', 'Escolha um anúncio da campanha do link.');
      anuncio = { id: a.id, ad_group_id: a.ad_group_id };
    }

    // O destino é o cardápio da loja, que o Regem informou na conexão (V33: nada fora dele).
    const cardapios = (
      await tx.execute<{ url: string | null }>(sql`
        select provider_attributes->>'cardapio_url' as url from liame.connected_account
         where provider = 'regem' and unit_id = ${loja.id} and brand_id = ${loja.brand_id} and disconnected_at is null
         order by connected_at desc, id`)
    ).rows
      .map((r) => r.url)
      .filter((u): u is string => cardapioValido(u) !== null);
    if (!cardapios.length) {
      throw new AppProblem(422, 'loja-sem-cardapio', 'Loja sem cardápio online', 'Esta loja não tem o cardápio online do Regem conectado: conecte o Regem e ligue a loja em Contas conectadas.');
    }
    const destino = destinoNoCardapio(body.destination_url ?? cardapios[0]!, cardapios);
    if (!destino.ok) throw new AppProblem(422, 'destino-fora-do-cardapio', 'Destino não aceito', MOTIVO_DESTINO[destino.motivo]);

    const regra = REGRAS[campanha.provider];
    const chave = { tenantId, unitId: loja.id, campaignId: campanha.id, adId: anuncio?.id ?? null, destinationUrl: destino.url };
    let linkId: string | null = null;
    let criado = false;
    let codigo = '';
    for (let tentativa = 0; tentativa < TENTATIVAS_CODIGO && !linkId; tentativa++) {
      codigo = codigoDoLink(chave, tentativa);
      const id = uuidv7();
      const novo = await tx.execute<{ id: string }>(sql`
        insert into liame.tracking_link (id, tenant_id, brand_id, unit_id, code, name, provider, campaign_id, ad_group_id, ad_id,
                                         destination_url, utm_source, utm_medium, utm_campaign, created_by)
        values (${id}, ${tenantId}, ${loja.brand_id}, ${loja.id}, ${codigo}, ${nome}, ${campanha.provider}, ${campanha.id},
                ${anuncio?.ad_group_id ?? null}, ${anuncio?.id ?? null}, ${destino.url}, ${regra.utmSource}, ${regra.utmMedium},
                ${slugCampanha(campanha.name)}, ${auth.userId})
        on conflict (tenant_id, code) do nothing
        returning id`);
      if (novo.rows[0]) {
        linkId = id;
        criado = true;
        break;
      }
      // Já existe um link com este código: é o mesmo link (mesma chave) ou, com chance de 1 em 2^50, outro.
      const existente = (
        await tx.execute<{ id: string; unit_id: string | null; campaign_id: string | null; ad_id: string | null; destination_url: string; archived_at: Date | string | null }>(sql`
          select id, unit_id, campaign_id, ad_id, destination_url, archived_at from liame.tracking_link where tenant_id = ${tenantId} and code = ${codigo}`)
      ).rows[0];
      if (existente && existente.unit_id === chave.unitId && existente.campaign_id === chave.campaignId && existente.ad_id === chave.adId && existente.destination_url === chave.destinationUrl) {
        linkId = existente.id;
        if (existente.archived_at) {
          // Link arquivado criado de novo: volta a valer, com o nome novo.
          await tx.execute(sql`update liame.tracking_link set archived_at = null, name = ${nome} where id = ${existente.id}`);
          criado = true;
        }
      }
    }
    if (!linkId) throw new Error(`link de campanha sem código livre depois de ${TENTATIVAS_CODIGO} tentativas`);

    auditDetail({
      resourceId: linkId,
      after: { code: codigo, criado, unit_id: loja.id, campaign_id: campanha.id, ad_id: anuncio?.id ?? null, provider: campanha.provider },
    });
    return { ...(await this.detail(linkId, agora)), created: criado };
  }

  /** O que a tela de criar link precisa: os cardápios das lojas, as campanhas com os anúncios e quando foram lidas. */
  async options(brandId: string, agora = new Date()): Promise<LinkOptionsResponse> {
    await this.marca(brandId);
    const tx = currentTx();
    const lojas = await tx.execute<{ id: string; name: string; unit_id: string | null; unit_name: string | null; url: string | null }>(sql`
      select a.id, a.name, a.unit_id, u.name as unit_name, a.provider_attributes->>'cardapio_url' as url
        from liame.connected_account a left join liame.unit u on u.id = a.unit_id
       where a.brand_id = ${brandId} and a.provider = 'regem' and a.disconnected_at is null
       order by u.name nulls last, a.name, a.id`);
    const destinations: LinkDestination[] = lojas.rows.map((l) => {
      const menu = cardapioValido(l.url);
      const reason = !l.unit_id ? 'sem_loja' : !menu ? 'sem_cardapio' : null;
      return {
        connected_account_id: l.id,
        unit: l.unit_id && l.unit_name ? { id: l.unit_id, name: l.unit_name } : null,
        store_name: l.name,
        menu_url: menu ? menu.toString() : null,
        usable: reason === null,
        reason,
      };
    });

    const campanhas = await tx.execute<{ id: string; name: string; provider: string; status: string; destinos: (string | null)[] }>(sql`
      select c.id, c.name, c.provider, c.status,
             coalesce((select array_agg(g.provider_attributes->>'destination_type') from liame.ad_group g
                        where g.campaign_id = c.id and g.status <> 'removida'), '{}') as destinos
        from liame.campaign c join liame.connected_account a on a.id = c.connected_account_id
       where a.brand_id = ${brandId} and a.disconnected_at is null and a.provider in ('meta_ads', 'google_ads')
         and c.status in ('ativa', 'pausada')
       order by (c.status = 'ativa') desc, c.name, c.id`);
    const ids = campanhas.rows.map((c) => c.id);
    const anuncios = ids.length
      ? (
          await tx.execute<{ id: string; name: string; status: string; campaign_id: string }>(sql`
            select ad.id, ad.name, ad.status, g.campaign_id from liame.ad ad join liame.ad_group g on g.id = ad.ad_group_id
             where g.campaign_id in ${ids} and ad.status in ('ativa', 'pausada')
             order by (ad.status = 'ativa') desc, ad.name, ad.id`)
        ).rows
      : [];
    const campaigns: LinkCampaignOption[] = campanhas.rows.map((c) => ({
      id: c.id,
      name: c.name,
      provider: c.provider,
      status: c.status,
      destination_kind: c.provider === 'meta_ads' ? tipoDeDestino(c.destinos) : 'site',
      ads: anuncios.filter((a) => a.campaign_id === c.id).map((a) => ({ id: a.id, name: a.name, status: a.status })),
    }));
    return { destinations, campaigns, sources: await this.fontes(brandId, agora) };
  }

  /**
   * Conferência do rastreio (F5; aviso "anúncio ativo sem rastreio" da F9): os anúncios ativos na última
   * leitura de cada conta da marca, cada um conferido pela função pura `conferirAnuncio`.
   */
  async trackingCheck(brandId: string, agora = new Date()): Promise<TrackingCheckResponse> {
    await this.marca(brandId);
    const tx = currentTx();
    // Ativo = anúncio, grupo e campanha ativos, visto na última leitura com sucesso da conta (o que sumiu da
    // plataforma fica no Liame com a leitura antiga e não entra) e não reprovado nem parado pela Meta.
    const anuncios = await tx.execute<LinhaAnuncio>(sql`
      with contas as (
        select a.id,
               (select max(r.started_at) from liame.sync_run r
                 where r.connected_account_id = a.id and r.dataset = 'entidades' and r.status = 'ok') as leitura_em
          from liame.connected_account a
         where a.brand_id = ${brandId} and a.disconnected_at is null and a.provider in ('meta_ads', 'google_ads')
      )
      select ad.id, ad.external_id, ad.name, ad.provider, ad.first_seen_at, ad.provider_attributes as ad_attrs,
             g.external_id as grupo_externo, g.provider_attributes as grupo_attrs,
             c.id as campanha_id, c.external_id as campanha_externa, c.name as campanha_nome,
             cr.provider_attributes as criativo_attrs, ct.id as conta_id
        from contas ct
        join liame.ad ad on ad.connected_account_id = ct.id
        join liame.ad_group g on g.id = ad.ad_group_id
        join liame.campaign c on c.id = g.campaign_id
        left join liame.creative cr on cr.id = ad.creative_id
       where ct.leitura_em is not null and ad.last_seen_at >= ct.leitura_em
         and ad.status = 'ativa' and g.status = 'ativa' and c.status = 'ativa'
         and coalesce(ad.provider_status, '') not in ('DISAPPROVED', 'CAMPAIGN_PAUSED', 'ADSET_PAUSED', 'PAUSED', 'DELETED', 'ARCHIVED')
       order by c.name, ad.name, ad.id`);

    // Todos os links da empresa (o motor liga o `lk` pela empresa, não pela marca); os desta marca, do mais
    // antigo ao mais novo, para sugerir o que colar (o do anúncio; senão, o primeiro da campanha).
    const links = await tx.execute<{ id: string; code: string; brand_id: string; campaign_id: string | null; ad_id: string | null; archived_at: Date | string | null }>(sql`
      select id, code, brand_id, campaign_id, ad_id, archived_at from liame.tracking_link order by created_at, id`);
    const porCodigo = new Map(links.rows.map((l) => [l.code, { campaignId: l.campaign_id }]));
    const cardapios = (
      await tx.execute<{ url: string | null }>(sql`
        select provider_attributes->>'cardapio_url' as url from liame.connected_account
         where brand_id = ${brandId} and provider = 'regem' and disconnected_at is null`)
    ).rows
      .map((r) => r.url)
      .filter((u): u is string => cardapioValido(u) !== null);
    const sugestao = (campanhaId: string, anuncioId: string): string | null => {
      const daMarca = links.rows.filter((l) => l.brand_id === brandId && !l.archived_at && l.campaign_id === campanhaId);
      return (daMarca.find((l) => l.ad_id === anuncioId) ?? daMarca.find((l) => l.ad_id === null) ?? daMarca[0])?.id ?? null;
    };

    const summary = { active_ads: 0, with_tracking: 0, without_tracking: 0, not_verifiable: 0, not_applicable: 0 };
    const semRastreio: TrackingCheckItem[] = [];
    const naoVerificados: TrackingCheckItem[] = [];
    for (const l of anuncios.rows) {
      if (!ehPlataformaDoLink(l.provider)) continue;
      summary.active_ads++;
      const r = conferirAnuncio(
        {
          provider: l.provider,
          campaignId: l.campanha_id,
          externos: { campanha: l.campanha_externa, grupo: l.grupo_externo, anuncio: l.external_id },
          destinoDoConjunto: typeof l.grupo_attrs?.destination_type === 'string' ? l.grupo_attrs.destination_type : null,
          rastreio: rastreioDe(l),
        },
        { links: porCodigo, cardapios },
      );
      if (r.status === 'com_rastreio') {
        summary.with_tracking++;
        continue;
      }
      if (r.status === 'nao_se_aplica') {
        summary.not_applicable++;
        continue;
      }
      if (r.status === 'sem_rastreio') summary.without_tracking++;
      else summary.not_verifiable++;
      const item: TrackingCheckItem = {
        status: r.status,
        reason: r.reason,
        ...textoDoAviso(l.name, l.provider, r),
        provider: l.provider,
        connected_account_id: l.conta_id,
        campaign: { id: l.campanha_id, name: l.campanha_nome },
        ad: { id: l.id, name: l.name, external_id: l.external_id },
        destination_url: r.status === 'sem_rastreio' && r.reason === 'destino_fora_do_cardapio' ? r.destino : null,
        first_seen_at: iso(l.first_seen_at),
        suggested_link_id: sugestao(l.campanha_id, l.id),
      };
      (r.status === 'sem_rastreio' ? semRastreio : naoVerificados).push(item);
    }
    return { summary, items: [...semRastreio, ...naoVerificados], sources: await this.fontes(brandId, agora), generated_at: agora.toISOString() };
  }

  // ------------------------------------------------------------------ apoio

  private async marca(brandId: string): Promise<void> {
    const r = await currentTx().execute<{ id: string }>(sql`select id from liame.brand where id = ${brandId} and archived_at is null`);
    if (!r.rows[0]) throw naoEncontrado('Marca não encontrada nesta empresa.');
  }

  /** Links pelo filtro, com os pedidos dos últimos 7 dias que chegaram pelo código de cada um. */
  private async links(filtro: SQL, agora: Date): Promise<LinhaLink[]> {
    const desde = new Date(agora.getTime() - DIAS_PEDIDOS * DIA_MS).toISOString();
    const r = await currentTx().execute<LinhaLink>(sql`
      with links as (
        select tl.* from liame.tracking_link tl where tl.archived_at is null and ${filtro}
      ),
      -- Pedido do link = resultado contado do modelo padrão cuja evidência é o clique com o código dele (o
      -- cupom exclusivo vence o clique, e esse pedido conta pelo cupom).
      pedidos as (
        select t.link_code, count(distinct r.order_id)::int as n
          from liame.attribution_result r
          join liame.touchpoint t on t.id = r.touchpoint_id
          join liame.order_fact o on o.id = r.order_id
         where r.model_id = ${MODELO_PADRAO} and r.counted and r.evidence = 'clique_campanha'
           and r.campaign_id in (select campaign_id from links where campaign_id is not null)
           and t.link_code in (select code from links)
           and o.confirmed_at >= ${desde}::timestamptz
         group by 1
      )
      select l.id, l.brand_id, l.unit_id, u.name as unit_name, l.name, l.code, l.provider, l.campaign_id, c.name as campaign_name,
             c.status as campaign_status, l.ad_id, a.name as ad_name, l.destination_url, l.utm_source, l.utm_medium, l.utm_campaign,
             l.created_at, coalesce(p.n, 0) as orders_7d
        from links l
        left join liame.unit u on u.id = l.unit_id
        left join liame.campaign c on c.id = l.campaign_id
        left join liame.ad a on a.id = l.ad_id
        left join pedidos p on p.link_code = l.code
       order by l.created_at desc, l.id`);
    return r.rows;
  }

  /** Quando as campanhas e os anúncios de cada conta de anúncio da marca foram lidos. */
  private async fontes(brandId: string, agora: Date): Promise<LinkSource[]> {
    const r = await currentTx().execute<{ id: string; provider: string; name: string; last_success_at: Date | string | null; expected_every_minutes: number | null }>(sql`
      select a.id, a.provider, a.name, s.last_success_at, s.expected_every_minutes
        from liame.connected_account a
        left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = 'entidades'
       where a.brand_id = ${brandId} and a.disconnected_at is null and a.provider in ('meta_ads', 'google_ads')
       order by a.provider, a.name, a.id`);
    return r.rows.map((l) => ({
      connected_account_id: l.id,
      provider: l.provider,
      name: l.name,
      read_at: l.last_success_at ? iso(l.last_success_at) : null,
      freshness: frescor({ lastSuccessAt: l.last_success_at, expectedEveryMinutes: l.expected_every_minutes ?? 1440 }, agora),
    }));
  }
}
