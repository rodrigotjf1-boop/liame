import type { CreateNewCampaignRequest, NewCampaignOptionsQuery, NewCampaignOptionsResponse, NewCampaignResponse } from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ActionService } from '../actions/action.service.js';
import { contaConectada } from '../connections/conectada.js';
import { emMenorUnidade } from '../connectors/meta/verba.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { tetoDaVerba } from '../policy/teto-da-verba.js';
import { destinoDoPost } from '../posts/link-do-post.js';
import { levaAoCardapio, OBJETIVOS_DO_TOPO, type ObjetivoDaCampanhaNova, PARTE_DO_TOPO_NO_MES, recursoDaCampanhaNova } from './campanha-nova-plano.js';

// A campanha nova na Meta, criada pausada (A4, X5, parte 1; P10 aprovado em 05/10/2026; D-A4-31, D-A4-35, D-A4-40 e
// D-A4-41). A rota confere tudo o que a ferramenta `campanha_criar` exige antes de pedir: a peça aprovada, a mídia
// pronta, a conta de anúncios e a Página da marca, a loja com o ponto no endereço, o cardápio (quando o objetivo é ele),
// a verba (sem fração de centavo e dentro do teto por campanha) e o fim. O pedido nasce em Aprovações, esperando o código
// do app; nada vai à Meta antes disso.

export const FLAG_DA_CAMPANHA_NOVA = 'campanha_nova';

/** As situações do pedido que encerram sem criar: recusado (cancelado), expirado ou que falhou. */
const ENCERRADOS = sql`('cancelada', 'expirada', 'falhou')`;
/** As situações do pedido ainda em aberto: esperando a decisão, aprovado esperando a vez, ou executando. */
const EM_ABERTO = sql`('aguardando_aprovacao', 'aprovada', 'executando')`;

type Quem = { tenantId: string; userId: string };

function recusa(code: string, title: string, detail: string, path?: string): AppProblem {
  return new AppProblem(422, code, title, detail, {}, path ? [{ path, message: detail }] : undefined);
}
function conflito(code: string, title: string, detail: string): AppProblem {
  return new AppProblem(409, code, title, detail);
}

type Conta = { id: string; provider: string; name: string; currency: string | null; instagram_id: string | null };

/** A conta de anúncios da Meta e a Página da marca, conectadas (D-A4-35). */
async function contasDaMarca(tx: ReturnType<typeof currentTx>, tenantId: string, brandId: string): Promise<{ anuncios: Conta[]; paginas: Conta[] }> {
  const contas = (
    await tx.execute<Conta>(sql`
      select a.id, a.provider, a.name, a.currency, a.provider_attributes->>'instagram_id' as instagram_id from liame.connected_account a
       where a.tenant_id = ${tenantId} and a.brand_id = ${brandId} and a.provider in ('meta_ads', 'facebook_page') and ${contaConectada('a')}
       order by a.provider, a.id`)
  ).rows;
  return { anuncios: contas.filter((c) => c.provider === 'meta_ads'), paginas: contas.filter((c) => c.provider === 'facebook_page') };
}

/** O que impede pela conta de anúncios e pela Página: uma de cada. A mesma regra no pedido e nas opções da gaveta. */
function bloqueioDasContas(anuncios: Conta[], paginas: Conta[]): AppProblem | null {
  if (anuncios.length === 0) return conflito('sem-conta-de-anuncios', 'Sem conta de anúncios', 'Conecte a conta de anúncios da Meta da marca em Contas conectadas.');
  if (anuncios.length > 1) return conflito('varias-contas-de-anuncios', 'Mais de uma conta de anúncios', 'A marca tem mais de uma conta de anúncios da Meta: deixe uma só em Contas conectadas.');
  if (paginas.length === 0) {
    return conflito('sem-pagina', 'Falta a Página do Facebook', 'Na Meta, todo anúncio sai em nome de uma Página do Facebook. Conecte a Meta de novo em Contas conectadas e escolha a Página da marca.');
  }
  if (paginas.length > 1) return conflito('varias-paginas', 'Mais de uma Página', 'A marca tem mais de uma Página do Facebook ligada: deixe uma só em Contas conectadas.');
  return null;
}

/** Por que "pedidos pelo cardápio" não vale para a loja; `null` quando vale. A mesma regra no pedido e nas opções. */
function motivoSemCardapio(destino: Awaited<ReturnType<typeof destinoDoPost>>, unitId: string): string | null {
  if (destino.ok && destino.unitId === unitId) return null;
  if (destino.ok || destino.motivo === 'varias_lojas') {
    return 'O cardápio online ligado à marca é o de outra loja: escolha a loja do cardápio, ou o objetivo de conversas no WhatsApp.';
  }
  if (destino.motivo === 'outra_plataforma') return 'A loja recebe os pedidos online por outra plataforma: use o objetivo de conversas no WhatsApp.';
  return 'A loja não tem o cardápio online ligado ao Liame: ligue o Regem em Contas conectadas, ou use o objetivo de conversas no WhatsApp.';
}

/** Reais escritos ("R$ 1.234,50") a partir de micros. */
const reais = (micros: number): string => `R$ ${(micros / 1_000_000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Os dias que faltam no mês, contando hoje (`AAAA-MM-DD`). */
export function diasQueFaltamNoMes(hoje: string): number {
  const [a, m, d] = hoje.split('-').map(Number) as [number, number, number];
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return ultimo - d + 1;
}

/**
 * O teto de alcance e seguidores (R6, D-RG-49): 25% do teto do mês da empresa. Cabe quando o que já está reservado
 * (as campanhas assim pedidas ou ativas, a verba diária vezes os dias que faltam) mais a verba diária nova vezes os
 * dias que faltam não passa dele. Função pura; dinheiro em micros.
 */
export function cabeNoTopo(t: { tetoDoMes: number; reservadoPorDia: number; dias: number }, verbaDiaria: number): { cabe: boolean; teto: number; usado: number; maximo: number } {
  const teto = Math.floor(t.tetoDoMes * PARTE_DO_TOPO_NO_MES);
  const usado = t.reservadoPorDia * t.dias;
  const maximo = t.dias > 0 ? Math.max(0, Math.floor((teto - usado) / t.dias / 10_000) * 10_000) : 0;
  return { cabe: usado + verbaDiaria * t.dias <= teto, teto, usado, maximo };
}

/** O dia de hoje no fuso da empresa (`AAAA-MM-DD`). */
function hojeNoFuso(agora: Date, fuso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}

type LinhaDaCampanhaNova = {
  id: string;
  brand_id: string;
  piece_id: string | null;
  piece_version: number | null;
  media_id: string | null;
  instagram_media_id: string | null;
  reels_caption: string | null;
  reels_permalink: string | null;
  reels_thumbnail_url: string | null;
  reels_published_at: Date | null;
  unit_id: string;
  name: string;
  objective: ObjetivoDaCampanhaNova;
  radius_km: string;
  daily_budget_micros: string;
  end_date: string | null;
  link: string | null;
  status: NewCampaignResponse['status'];
  action_id: string | null;
  error: string | null;
  active: boolean;
  activated_at: Date | null;
  pending_action_id: string | null;
  meta_campaign_id: string | null;
  meta_adset_id: string | null;
  meta_video_id: string | null;
  meta_creative_id: string | null;
  meta_ad_id: string | null;
  meta_account_id: string | null;
  created_at: Date;
};

function resposta(l: LinhaDaCampanhaNova): NewCampaignResponse {
  return {
    id: l.id,
    brand_id: l.brand_id,
    piece_id: l.piece_id,
    piece_version: l.piece_version,
    media_id: l.media_id,
    instagram_media_id: l.instagram_media_id,
    reels:
      l.instagram_media_id !== null && l.reels_published_at !== null
        ? { caption: l.reels_caption ?? '', permalink: l.reels_permalink, thumbnail_url: l.reels_thumbnail_url, published_at: new Date(l.reels_published_at).toISOString() }
        : null,
    unit_id: l.unit_id,
    name: l.name,
    objective: l.objective,
    radius_km: Number(l.radius_km),
    daily_budget_micros: Number(l.daily_budget_micros),
    end_date: l.end_date,
    link: l.link,
    status: l.status,
    action_id: l.action_id,
    error: l.error,
    active: l.active,
    activated_at: l.activated_at ? new Date(l.activated_at).toISOString() : null,
    pending_action_id: l.pending_action_id,
    meta: { account_id: l.meta_account_id, campaign_id: l.meta_campaign_id, adset_id: l.meta_adset_id, video_id: l.meta_video_id, creative_id: l.meta_creative_id, ad_id: l.meta_ad_id },
    created_at: new Date(l.created_at).toISOString(),
  };
}

@Injectable()
export class CampanhasNovasService {
  constructor(
    private readonly actions: ActionService,
    private readonly flags: FlagService,
    private readonly policies: PolicyService,
  ) {}

  private quem(auth: AuthContext): Quem {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
    return { tenantId: auth.tenantId, userId: auth.userId };
  }

  /**
   * Pede a campanha nova: confere o pedido, guarda a campanha nova e cria o pedido `campanha_criar`, que espera a
   * aprovação com o código do app em Aprovações. Um pedido em aberto por peça.
   */
  async criar(auth: AuthContext, body: CreateNewCampaignRequest, agora: Date = new Date()): Promise<NewCampaignResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    const marca = await tx.execute(sql`select 1 from liame.brand where id = ${body.brand_id} and tenant_id = ${quem.tenantId} and archived_at is null`);
    if (!marca.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    const ligada = await this.flags.isEnabled(FLAG_DA_CAMPANHA_NOVA, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId: body.brand_id }));
    if (!ligada) throw conflito('funcao-desligada', 'Função desligada', 'A campanha nova não está ligada para esta empresa.');

    // A origem: a peça aprovada (na versão atual) com a foto ou o vídeo pronto de Fotos, ou o Reels (D-A4-46).
    const reels = body.instagram_media_id ?? null;
    let versaoDaPeca: number | null = null;
    if (reels === null) {
      const peca = (
        await tx.execute<{ status: string; version: number }>(sql`
          select status, version from liame.ad_piece where id = ${body.piece_id!} and tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id}`)
      ).rows[0];
      if (!peca) throw recusa('peca-nao-encontrada', 'Peça não encontrada', 'A peça não está em Criativos desta marca.', 'piece_id');
      if (peca.status !== 'aprovada') throw recusa('peca-nao-aprovada', 'A peça não foi aprovada', 'Só a peça aprovada em Criativos vira campanha. Aprove a peça antes.', 'piece_id');
      versaoDaPeca = peca.version;

      // O vídeo só com a capa guardada: o anúncio de vídeo leva a capa.
      const midia = (
        await tx.execute<{ kind: string; has_cover: boolean | null }>(sql`
          select kind, has_cover from liame.brand_photo
           where id = ${body.media_id!} and tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id} and status = 'pronta' and removed_at is null`)
      ).rows[0];
      if (!midia) throw recusa('midia-fora-das-fotos', 'Mídia não encontrada', 'Escolha uma foto ou um vídeo pronto de Fotos desta marca.', 'media_id');
      if (midia.kind === 'video' && !midia.has_cover) {
        throw recusa('video-sem-capa', 'O vídeo não tem capa', 'O anúncio de vídeo leva a capa: escolha a capa do vídeo em Fotos, ou use outro vídeo.', 'media_id');
      }
    }

    // A conta de anúncios da Meta e a Página da marca (D-A4-35): uma de cada.
    const { anuncios, paginas } = await contasDaMarca(tx, quem.tenantId, body.brand_id);
    const bloqueio = bloqueioDasContas(anuncios, paginas);
    if (bloqueio) throw bloqueio;
    const contaDeAnuncios = anuncios[0]!;

    // O Reels do Instagram ligado à Página: o anúncio sai em nome dela e do Instagram dela, e a Meta só aceita o post
    // desse perfil. Ele precisa estar na leitura de Fotos › Do seu Instagram.
    if (reels !== null) {
      const instagramDaPagina = paginas[0]!.instagram_id;
      if (!instagramDaPagina) {
        throw recusa(
          'sem-instagram-na-pagina',
          'A Página não tem o Instagram ligado',
          'O anúncio de um Reels sai em nome do Instagram ligado à Página da marca. Ligue o Instagram à Página na Meta e conecte de novo em Contas conectadas.',
          'instagram_media_id',
        );
      }
      const doPerfil = (
        await tx.execute<{ kind: string }>(sql`
          select im.kind from liame.instagram_media im
            join liame.connected_account ig on ig.id = im.connected_account_id and ig.tenant_id = im.tenant_id
           where im.tenant_id = ${quem.tenantId} and im.brand_id = ${body.brand_id} and im.media_id = ${reels}
             and ig.provider = 'instagram' and ig.external_id = ${instagramDaPagina} and ${contaConectada('ig')}
           limit 1`)
      ).rows[0];
      if (!doPerfil) {
        throw recusa(
          'reels-nao-encontrado',
          'Reels não encontrado',
          'O Reels não está em Fotos › Do seu Instagram, no Instagram ligado à Página da marca.',
          'instagram_media_id',
        );
      }
      if (doPerfil.kind !== 'reels') throw recusa('nao-e-reels', 'Não é um Reels', 'Só o Reels vira campanha por aqui. Para a foto, use Criativos.', 'instagram_media_id');
    }
    if (emMenorUnidade(body.daily_budget_micros, contaDeAnuncios.currency) === null) {
      throw recusa('verba-invalida', 'Verba inválida', 'A verba diária não pode ter fração de centavo.', 'daily_budget_micros');
    }

    // A loja e o ponto dela no endereço (D-A4-41; D-RG-14).
    const loja = (
      await tx.execute<{ location_precision: string | null }>(sql`
        select location_precision from liame.unit where id = ${body.unit_id} and tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id}`)
    ).rows[0];
    if (!loja) throw recusa('loja-nao-encontrada', 'Loja não encontrada', 'A loja não é desta marca.', 'unit_id');
    if (loja.location_precision !== 'endereco') {
      throw recusa(
        'loja-sem-endereco',
        'Falta o endereço da loja',
        'A campanha mostra o anúncio em volta da loja, e o ponto dela ainda não está no endereço. Ajuste o endereço da loja em Minha marca antes.',
        'unit_id',
      );
    }

    // Seguidores no Instagram (R6): o destino é o perfil do Instagram ligado à Página, conectado.
    if (body.objective === 'seguidores' && !(await this.instagramDaPagina(tx, quem.tenantId, body.brand_id, paginas[0]!.instagram_id))) {
      throw recusa(
        'sem-instagram-na-pagina',
        'A Página não tem o Instagram ligado',
        'Seguidores no Instagram leva ao perfil do Instagram ligado à Página da marca. Ligue o Instagram à Página na Meta e conecte de novo em Contas conectadas.',
        'objective',
      );
    }

    // O destino: o cardápio da loja escolhida (cardápio e alcance), o WhatsApp da Página ou o perfil do Instagram.
    let link: string | null = null;
    if (levaAoCardapio(body.objective)) {
      const destino = await destinoDoPost(tx, quem.tenantId, body.brand_id);
      const motivo = motivoSemCardapio(destino, body.unit_id);
      if (motivo || !destino.ok) throw recusa('sem-cardapio', 'Sem o cardápio da loja', motivo ?? '', 'objective');
      link = destino.url;
    }

    // A verba dentro do teto por campanha, quando ele existe (D-A4-31): criar não gasta, mas ativar vai pedir o teto.
    const { policies, timezone } = await this.policies.load(tx, quem.tenantId, body.brand_id);
    const teto = tetoDaVerba(policies, 'meta_ads');
    if (teto !== null && body.daily_budget_micros > teto) {
      throw recusa(
        'acima-do-teto',
        'Acima do teto por campanha',
        `A verba diária passa do teto por campanha, que é de R$ ${(teto / 1_000_000).toFixed(2).replace('.', ',')} por dia. Quem muda o teto é o Dono ou o Administrador, em Verba do mês.`,
        'daily_budget_micros',
      );
    }

    if (body.end_date && body.end_date <= hojeNoFuso(agora, timezone)) throw recusa('fim-no-passado', 'Data de fim', 'A data de fim precisa ser depois de hoje.', 'end_date');

    // Alcance e seguidores: até 25% do teto do mês, somadas as campanhas assim pedidas ou ativas (R6, D-RG-49).
    if (OBJETIVOS_DO_TOPO.includes(body.objective)) {
      const topo = await this.topoDoMes(quem.tenantId, timezone, agora, null);
      if (topo) {
        const c = cabeNoTopo(topo, body.daily_budget_micros);
        if (!c.cabe) throw recusa('acima-do-teto-do-topo', 'Passa do teto de alcance e seguidores', this.textoDoTopo(c), 'daily_budget_micros');
      }
    }

    // O pedido anterior com a mesma peça (ou o mesmo Reels) que já se encerrou em Aprovações (recusado, expirado, ou que
    // falhou no meio) sai do caminho: a campanha nova dele fica cancelada (ou não criada, se já tinha começado na Meta).
    const mesmaOrigem = reels === null ? sql`c.piece_id = ${body.piece_id!}` : sql`c.brand_id = ${body.brand_id} and c.instagram_media_id = ${reels}`;
    await tx.execute(sql`
      update liame.ad_campaign_new c
         set status = case when c.status = 'criando' then 'nao_criada' else 'cancelada' end,
             error = case when c.status = 'criando' then coalesce(left(r.status_reason, 2000), 'A criação parou antes do fim.') else c.error end,
             updated_at = now()
        from liame.action_request r
       where c.tenant_id = ${quem.tenantId} and ${mesmaOrigem} and c.status in ('pedida', 'criando')
         and r.id = c.action_id and r.tenant_id = c.tenant_id and r.status in ${ENCERRADOS}`);

    // A campanha nova e o pedido. O segundo pedido com a mesma peça (ou o mesmo Reels) espera o primeiro (os índices
    // únicos de peça e de Reels em aberto).
    const id = uuidv7();
    const nova = await tx.execute(sql`
      insert into liame.ad_campaign_new (id, tenant_id, brand_id, ad_account_id, page_account_id, piece_id, piece_version, media_id, instagram_media_id, unit_id,
                                         name, objective, radius_km, daily_budget_micros, end_date, link, created_by)
      values (${id}, ${quem.tenantId}, ${body.brand_id}, ${contaDeAnuncios.id}, ${paginas[0]!.id}, ${body.piece_id ?? null}, ${versaoDaPeca}, ${body.media_id ?? null}, ${reels}, ${body.unit_id},
              ${body.name}, ${body.objective}, ${body.radius_km}, ${body.daily_budget_micros}, ${body.end_date ?? null}, ${link}, ${quem.userId})
      on conflict do nothing
      returning id`);
    if (!nova.rows[0]) {
      throw reels === null
        ? conflito('ja-pedida', 'Já existe um pedido com esta peça', 'Já existe um pedido de campanha com esta peça esperando aprovação. Decida esse antes de pedir outro.')
        : conflito('ja-pedida', 'Já existe um pedido com este Reels', 'Já existe um pedido de campanha com este Reels esperando aprovação. Decida esse antes de pedir outro.');
    }
    const pedido = await this.actions.pedirPelaRota(auth, {
      tool: 'campanha_criar',
      brand_id: body.brand_id,
      provider: 'meta_ads',
      account_id: contaDeAnuncios.id,
      resource_id: recursoDaCampanhaNova(id),
      params: {},
    });
    await tx.execute(sql`update liame.ad_campaign_new set action_id = ${pedido}, updated_at = now() where id = ${id}`);
    auditDetail({
      resourceId: id,
      before: null,
      after: {
        brand_id: body.brand_id,
        piece_id: body.piece_id ?? null,
        piece_version: versaoDaPeca,
        media_id: body.media_id ?? null,
        instagram_media_id: reels,
        unit_id: body.unit_id,
        objective: body.objective,
        radius_km: body.radius_km,
        daily_budget_micros: body.daily_budget_micros,
        end_date: body.end_date ?? null,
        action_id: pedido,
      },
    });
    return this.obter(auth, id);
  }

  /**
   * As opções da gaveta da campanha nova (A4, X5, parte 2; P42): se a função está ligada, o que impede pedir agora (as
   * mesmas regras e palavras do pedido), quem assina o anúncio, as lojas (o endereço, o raio de entrega e se o cardápio
   * vale para cada uma), o teto por campanha e em que pé está a campanha nova de cada peça. Só leitura.
   */
  async opcoes(auth: AuthContext, query: NewCampaignOptionsQuery): Promise<NewCampaignOptionsResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    const marca = await tx.execute(sql`select 1 from liame.brand where id = ${query.brand_id} and tenant_id = ${quem.tenantId} and archived_at is null`);
    if (!marca.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    const enabled = await this.flags.isEnabled(FLAG_DA_CAMPANHA_NOVA, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId: query.brand_id }));

    const blocks: NewCampaignOptionsResponse['blocks'] = [];
    if (!enabled) blocks.push({ code: 'funcao-desligada', title: 'Função desligada', detail: 'A campanha nova não está ligada para esta empresa.' });
    const { anuncios, paginas } = await contasDaMarca(tx, quem.tenantId, query.brand_id);
    const bloqueio = bloqueioDasContas(anuncios, paginas);
    if (bloqueio) blocks.push({ code: bloqueio.code, title: bloqueio.title, detail: bloqueio.detail });
    const pagina = paginas.length === 1 ? paginas[0]! : null;
    const instagram = pagina?.instagram_id
      ? (
          await tx.execute<{ name: string }>(sql`
            select a.name from liame.connected_account a
             where a.tenant_id = ${quem.tenantId} and a.brand_id = ${query.brand_id} and a.provider = 'instagram' and a.external_id = ${pagina.instagram_id} and ${contaConectada('a')}
             limit 1`)
        ).rows[0] ?? null
      : null;

    const destino = await destinoDoPost(tx, quem.tenantId, query.brand_id);
    const lojas = (
      await tx.execute<{ id: string; name: string; street: string | null; number: string | null; district: string | null; precision: string | null; radius: string | null }>(sql`
        select id, name, address_street as street, address_number as number, address_district as district,
               location_precision as precision, delivery_radius_km::text as radius
          from liame.unit where tenant_id = ${quem.tenantId} and brand_id = ${query.brand_id}
         order by name, id`)
    ).rows;
    const units = lojas.map((u) => {
      const motivo = motivoSemCardapio(destino, u.id);
      const rua = [u.street, u.number].filter(Boolean).join(', ');
      const address = [rua, u.district].filter(Boolean).join(', ') || null;
      return { id: u.id, name: u.name, address, has_address: u.precision === 'endereco', delivery_radius_km: u.radius === null ? null : Number(u.radius), menu_available: motivo === null, menu_block: motivo };
    });

    const { policies, timezone } = await this.policies.load(tx, quem.tenantId, query.brand_id);
    type Ultima = { campaign_id: string; status: NewCampaignResponse['status']; active: boolean; action_id: string | null };
    const by_piece = (
      await tx.execute<Ultima & { piece_id: string }>(sql`
        select distinct on (piece_id) piece_id, id as campaign_id, status, active, action_id
          from liame.ad_campaign_new
         where tenant_id = ${quem.tenantId} and brand_id = ${query.brand_id} and status <> 'cancelada' and piece_id is not null
         order by piece_id, created_at desc, id desc`)
    ).rows;
    const by_reels = (
      await tx.execute<Ultima & { instagram_media_id: string }>(sql`
        select distinct on (instagram_media_id) instagram_media_id, id as campaign_id, status, active, action_id
          from liame.ad_campaign_new
         where tenant_id = ${quem.tenantId} and brand_id = ${query.brand_id} and status <> 'cancelada' and instagram_media_id is not null
         order by instagram_media_id, created_at desc, id desc`)
    ).rows;

    return {
      enabled,
      blocks,
      ad_account: anuncios.length === 1 ? { name: anuncios[0]!.name, currency: anuncios[0]!.currency } : null,
      page: pagina ? { name: pagina.name } : null,
      instagram,
      units,
      campaign_cap_micros: tetoDaVerba(policies, 'meta_ads'),
      top_of_funnel: await this.topoDoMes(quem.tenantId, timezone, new Date(), null).then((t) =>
        t ? { cap_micros: Math.floor(t.tetoDoMes * PARTE_DO_TOPO_NO_MES), used_micros: t.reservadoPorDia * t.dias, days_left: t.dias } : null,
      ),
      by_piece,
      by_reels,
    };
  }

  /**
   * Pede para ativar a campanha nova criada e pausada (A4, X5, parte 3; D-A4-31): o pedido `campanha_nova_ativar`
   * espera a aprovação com o código do app, com os limites da empresa e a verba do mês (volta a gastar). Um pedido de
   * ativar ou pausar em aberto por campanha.
   */
  async ativar(auth: AuthContext, id: string): Promise<NewCampaignResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    const c = (
      await tx.execute<{ brand_id: string; ad_account_id: string; status: string; active: boolean; daily_budget_micros: string; objective: ObjetivoDaCampanhaNova }>(sql`
        select brand_id, ad_account_id, status, active, daily_budget_micros::text, objective from liame.ad_campaign_new
         where id = ${id} and tenant_id = ${quem.tenantId}
           for update`)
    ).rows[0];
    if (!c) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Esta campanha nova não está aqui.');
    const ligada = await this.flags.isEnabled(FLAG_DA_CAMPANHA_NOVA, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId: c.brand_id }));
    if (!ligada) throw conflito('funcao-desligada', 'Função desligada', 'A campanha nova não está ligada para esta empresa.');
    if (c.status !== 'criada') throw conflito('ainda-nao-criada', 'Ainda não foi criada', 'A campanha nova ainda não existe na Meta: ative depois que ela for criada, pausada.');
    if (c.active) throw conflito('ja-ativa', 'Já está ativa', 'Esta campanha nova já está ativa. Para parar, desfaça a ativação em Aprovações.');
    const aberto = await tx.execute(sql`
      select 1 from liame.action_request
       where tenant_id = ${quem.tenantId} and resource_id = ${recursoDaCampanhaNova(id)} and tool in ('campanha_nova_ativar', 'campanha_nova_pausar')
         and status in ${EM_ABERTO}
       limit 1`);
    if (aberto.rows[0]) throw conflito('pedido-em-aberto', 'Já há um pedido em aberto', 'Esta campanha nova já tem um pedido de ativar ou pausar esperando: decida esse antes.');
    const { policies } = await this.policies.load(tx, quem.tenantId, c.brand_id);
    const teto = tetoDaVerba(policies, 'meta_ads');
    if (teto !== null && Number(c.daily_budget_micros) > teto) {
      throw recusa('acima-do-teto', 'Acima do teto por campanha', `A verba diária passa do teto por campanha, que é de R$ ${(teto / 1_000_000).toFixed(2).replace('.', ',')} por dia. Quem muda o teto é o Dono ou o Administrador, em Verba do mês.`);
    }
    if (OBJETIVOS_DO_TOPO.includes(c.objective)) {
      const { timezone } = await this.policies.load(tx, quem.tenantId, c.brand_id);
      const topo = await this.topoDoMes(quem.tenantId, timezone, new Date(), id);
      if (topo) {
        const cabe = cabeNoTopo(topo, Number(c.daily_budget_micros));
        if (!cabe.cabe) throw recusa('acima-do-teto-do-topo', 'Passa do teto de alcance e seguidores', this.textoDoTopo(cabe));
      }
    }
    const pedido = await this.actions.pedirPelaRota(auth, {
      tool: 'campanha_nova_ativar',
      brand_id: c.brand_id,
      provider: 'meta_ads',
      account_id: c.ad_account_id,
      resource_id: recursoDaCampanhaNova(id),
      params: {},
    });
    auditDetail({ resourceId: id, before: { active: false }, after: { brand_id: c.brand_id, action_id: pedido } });
    return this.obter(auth, id);
  }

  /** O Instagram ligado à Página, conectado na marca (o destino de seguidores); nulo sem ele. */
  private async instagramDaPagina(tx: ReturnType<typeof currentTx>, tenantId: string, brandId: string, instagramId: string | null): Promise<{ name: string } | null> {
    if (!instagramId) return null;
    return (
      (
        await tx.execute<{ name: string }>(sql`
          select a.name from liame.connected_account a
           where a.tenant_id = ${tenantId} and a.brand_id = ${brandId} and a.provider = 'instagram' and a.external_id = ${instagramId} and ${contaConectada('a')}
           limit 1`)
      ).rows[0] ?? null
    );
  }

  /**
   * O teto do mês da empresa e o que já está reservado por dia para alcance e seguidores (as campanhas pedidas, criando
   * ou ativas, menos `excluir`), com os dias que faltam no mês. Nulo sem o teto do mês.
   */
  private async topoDoMes(tenantId: string, fuso: string, agora: Date, excluir: string | null): Promise<{ tetoDoMes: number; reservadoPorDia: number; dias: number } | null> {
    const tx = currentTx();
    const teto = (await tx.execute<{ limit_micros: string }>(sql`select limit_micros::text from liame.budget_policy where tenant_id = ${tenantId} and brand_id is null`)).rows[0];
    if (!teto) return null;
    const reservado = (
      await tx.execute<{ soma: string }>(sql`
        select coalesce(sum(daily_budget_micros), 0)::text as soma from liame.ad_campaign_new
         where tenant_id = ${tenantId} and objective in ('alcance', 'seguidores') and (status in ('pedida', 'criando') or (status = 'criada' and active))
           ${excluir ? sql`and id <> ${excluir}` : sql``}`)
    ).rows[0]!;
    return { tetoDoMes: Number(teto.limit_micros), reservadoPorDia: Number(reservado.soma), dias: diasQueFaltamNoMes(hojeNoFuso(agora, fuso)) };
  }

  private textoDoTopo(c: { teto: number; usado: number; maximo: number }): string {
    return `Alcance e seguidores usam até 25% do teto do mês, ${reais(c.teto)}. Já há ${reais(c.usado)} reservados em campanhas assim até o fim do mês. ${
      c.maximo > 0 ? `Diminua a verba diária para até ${reais(c.maximo)}, ou deixe esta campanha para o mês que vem.` : 'Deixe esta campanha para o mês que vem.'
    }`;
  }

  /** Uma campanha nova da empresa. */
  async obter(auth: AuthContext, id: string): Promise<NewCampaignResponse> {
    const quem = this.quem(auth);
    // O pedido que se encerrou em Aprovações sem criar: cancelada (ou não criada, se já tinha começado na Meta).
    const r = await currentTx().execute<LinhaDaCampanhaNova>(sql`
      select c.id, c.brand_id, c.piece_id, c.piece_version, c.media_id, c.instagram_media_id,
             im.caption as reels_caption, im.permalink as reels_permalink, im.thumbnail_url as reels_thumbnail_url, im.published_at as reels_published_at,
             c.unit_id, c.name, c.objective, c.radius_km::text, c.daily_budget_micros::text,
             c.end_date::text as end_date, c.link,
             case when c.status in ('pedida', 'criando') and r.status in ${ENCERRADOS}
                  then (case when c.status = 'criando' then 'nao_criada' else 'cancelada' end) else c.status end as status,
             c.action_id,
             case when c.status = 'criando' and r.status in ${ENCERRADOS} then coalesce(r.status_reason, 'A criação parou antes do fim.') else c.error end as error,
             c.meta_campaign_id, c.meta_adset_id, c.meta_video_id, c.meta_creative_id, c.meta_ad_id, c.created_at,
             c.active, c.activated_at,
             (select x.external_id from liame.connected_account x where x.id = c.ad_account_id and x.tenant_id = c.tenant_id) as meta_account_id,
             (select a.id from liame.action_request a
               where a.tenant_id = c.tenant_id and a.resource_id = ${recursoDaCampanhaNova(id)} and a.tool in ('campanha_nova_ativar', 'campanha_nova_pausar')
                 and a.status in ${EM_ABERTO}
               order by a.created_at desc limit 1) as pending_action_id
        from liame.ad_campaign_new c
        left join liame.action_request r on r.id = c.action_id and r.tenant_id = c.tenant_id
        -- O Reels (D-A4-46) como a leitura do Instagram da marca guardou; o mais novo, se a marca tiver lido por duas contas.
        left join lateral (
          select x.caption, x.permalink, x.thumbnail_url, x.published_at from liame.instagram_media x
           where c.instagram_media_id is not null and x.tenant_id = c.tenant_id and x.brand_id = c.brand_id and x.media_id = c.instagram_media_id
           order by x.read_at desc limit 1) im on true
       where c.id = ${id} and c.tenant_id = ${quem.tenantId}`);
    const l = r.rows[0];
    if (!l) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Esta campanha nova não está aqui.');
    return resposta(l);
  }
}
