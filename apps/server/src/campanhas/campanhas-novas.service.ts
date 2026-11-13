import type {
  CreateNewCampaignRequest,
  NewCampaignAudienceQuery,
  NewCampaignAudienceResponse,
  NewCampaignDistrictSearchQuery,
  NewCampaignDistrictSearchResponse,
  NewCampaignDistrictsQuery,
  NewCampaignDistrictsResponse,
  NewCampaignOptionsQuery,
  NewCampaignOptionsResponse,
  NewCampaignResponse,
} from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { ActionService } from '../actions/action.service.js';
import { contaConectada } from '../connections/conectada.js';
import { ErroConector } from '../connectors/cliente-http.js';
import { emMenorUnidade } from '../connectors/meta/verba.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { tetoDaVerba } from '../policy/teto-da-verba.js';
import { destinoDoPost } from '../posts/link-do-post.js';
import { bairroDaArea, nomeComparavel } from '../regiao/coordenada.js';
import { centrosDosBairros } from '../worker/centros-dos-bairros.js';
import {
  BairroDaCampanha,
  bairroNaBuscaDaMeta,
  bairrosEscritos,
  deslocamentoEmKm,
  lugaresDoRaio,
  lugaresDosBairros,
  MAXIMO_DE_BAIRROS,
  raioDoBairro,
  VALIDADE_DA_BUSCA_DA_META_MS,
} from './bairros-da-campanha.js';
import { levaAoCardapio, OBJETIVOS_DO_TOPO, type ObjetivoDaCampanhaNova, PARTE_DO_TOPO_NO_MES, PUBLICO_MINIMO_NO_RAIO, recursoDaCampanhaNova } from './campanha-nova-plano.js';
import { type PublicoEstimado, publicoNoRaio, publicoSuficiente } from './publico-no-raio.js';

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

/** A estimativa lida agora: pronta (com o público), sem estimativa (a Meta não estimou) ou indisponível (sem como ler). */
type Estimativa = { status: 'pronta'; publico: PublicoEstimado } | { status: 'sem_estimativa' } | { status: 'indisponivel' };

function recusa(code: string, title: string, detail: string, path?: string): AppProblem {
  return new AppProblem(422, code, title, detail, {}, path ? [{ path, message: detail }] : undefined);
}
function conflito(code: string, title: string, detail: string): AppProblem {
  return new AppProblem(409, code, title, detail);
}

type Conta = { id: string; provider: string; name: string; currency: string | null; instagram_id: string | null; external_id: string; credential_secret_id: string | null };

/** A conta de anúncios da Meta e a Página da marca, conectadas (D-A4-35). */
async function contasDaMarca(tx: ReturnType<typeof currentTx>, tenantId: string, brandId: string): Promise<{ anuncios: Conta[]; paginas: Conta[] }> {
  const contas = (
    await tx.execute<Conta>(sql`
      select a.id, a.provider, a.name, a.currency, a.provider_attributes->>'instagram_id' as instagram_id, a.external_id, a.credential_secret_id
        from liame.connected_account a
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

/** Pessoas escritas ("1.234"). */
const pessoas = (n: number): string => n.toLocaleString('pt-BR');
/** O raio escrito ("2,5 km"). */
const raioEscrito = (km: number): string => `${String(km).replace('.', ',')} km`;

/** O porquê do público pequeno demais no raio (R6, D-RG-50): a mesma frase no pedido recusado e na gaveta. */
export function textoDoPublicoPequeno(p: PublicoEstimado, raioKm: number, loja: string): string {
  return `A Meta estima de ${pessoas(p.de)} a ${pessoas(p.ate)} pessoas de 18 anos ou mais num raio de ${raioEscrito(raioKm)} em volta da ${loja}: com menos de ${pessoas(PUBLICO_MINIMO_NO_RAIO)} pessoas, ela não entrega bem. Aumente o raio.`;
}

/** O porquê do público pequeno demais nos bairros (R6, parte 3): a mesma régua do raio. */
export function textoDoPublicoPequenoNosBairros(p: PublicoEstimado, bairros: number): string {
  const onde = bairros === 1 ? 'no bairro escolhido' : `nos ${bairrosEscritos(bairros)} escolhidos`;
  return `A Meta estima de ${pessoas(p.de)} a ${pessoas(p.ate)} pessoas de 18 anos ou mais ${onde}: com menos de ${pessoas(PUBLICO_MINIMO_NO_RAIO)} pessoas, ela não entrega bem. Escolha mais bairros.`;
}

/** O tempo da gaveta para procurar os centros que faltam (uma consulta por segundo) e para perguntar à Meta. */
const PRAZO_DOS_CENTROS_MS = 6_000;
const PRAZO_DA_BUSCA_DA_META_MS = 5_000;

/** Os bairros guardados na campanha (`districts`), na resposta: o código, o nome, se vai como o bairro da Meta e o raio. */
function bairrosDaResposta(v: unknown): NewCampaignResponse['districts'] {
  const lido = z.array(BairroDaCampanha).safeParse(v);
  if (!lido.success) return null;
  return lido.data.map((b) => ({ code: b.codigo, name: b.nome, meta: b.meta !== null, radius_km: b.raio_km }));
}

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
  radius_km: string | null;
  districts: unknown;
  daily_budget_micros: string;
  end_date: string | null;
  link: string | null;
  audience_lower: string | null;
  audience_upper: string | null;
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
    radius_km: l.radius_km === null ? null : Number(l.radius_km),
    districts: bairrosDaResposta(l.districts),
    daily_budget_micros: Number(l.daily_budget_micros),
    end_date: l.end_date,
    link: l.link,
    audience: l.audience_lower !== null && l.audience_upper !== null ? { lower: Number(l.audience_lower), upper: Number(l.audience_upper) } : null,
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
  private readonly logger = new Logger('campanha-nova');

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
      await tx.execute<{ name: string; location_precision: string | null; latitude: string | null; longitude: string | null; ibge_city_code: string | null }>(sql`
        select name, location_precision, latitude::text, longitude::text, ibge_city_code from liame.unit
         where id = ${body.unit_id} and tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id}`)
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

    // Quem vê: o raio em volta da loja, ou os bairros do município dela, cada um já com o centro achado (R6, parte 3;
    // D-RG-53 e D-RG-54). O contrato garante um dos dois.
    const bairros = body.districts ? await this.bairrosDoPedido(tx, loja.ibge_city_code, body.districts) : null;
    const lugares = bairros ? lugaresDosBairros(bairros) : lugaresDoRaio(Number(loja.latitude), Number(loja.longitude), body.radius_km!);

    // O público pela estimativa da Meta (R6, D-RG-50): com menos de 1.000 pessoas, ela não entrega bem e o pedido não é
    // criado. Sem a estimativa agora (a Meta não estimou ou não respondeu), o pedido segue sem ela.
    const estimativa = await this.estimativa(tx, contaDeAnuncios, lugares);
    if (estimativa.status === 'pronta' && !publicoSuficiente(estimativa.publico)) {
      throw bairros
        ? recusa('publico-pequeno', 'Público pequeno demais nos bairros', textoDoPublicoPequenoNosBairros(estimativa.publico, bairros.length), 'districts')
        : recusa('publico-pequeno', 'Público pequeno demais no raio', textoDoPublicoPequeno(estimativa.publico, body.radius_km!, loja.name), 'radius_km');
    }
    const publico = estimativa.status === 'pronta' ? estimativa.publico : null;

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
                                         name, objective, radius_km, districts, daily_budget_micros, end_date, link, audience_lower, audience_upper, created_by)
      values (${id}, ${quem.tenantId}, ${body.brand_id}, ${contaDeAnuncios.id}, ${paginas[0]!.id}, ${body.piece_id ?? null}, ${versaoDaPeca}, ${body.media_id ?? null}, ${reels}, ${body.unit_id},
              ${body.name}, ${body.objective}, ${body.radius_km ?? null}, ${bairros ? JSON.stringify(bairros) : null}::jsonb, ${body.daily_budget_micros}, ${body.end_date ?? null}, ${link}, ${publico?.de ?? null}, ${publico?.ate ?? null}, ${quem.userId})
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
        radius_km: body.radius_km ?? null,
        districts: body.districts ?? null,
        daily_budget_micros: body.daily_budget_micros,
        end_date: body.end_date ?? null,
        audience: publico ? { lower: publico.de, upper: publico.ate } : null,
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

  /**
   * A estimativa de público no raio para a gaveta (R6, parte 2; D-RG-50): ao abrir e ao trocar o raio ou a loja. Pronta
   * (o mínimo, o máximo e se dá para a Meta entregar), sem estimativa, ou indisponível (sem uma conta de anúncios, sem o
   * ponto da loja no endereço, ou a Meta não respondeu agora). Só leitura; marca ou loja de fora, 404.
   */
  async estimarPublico(auth: AuthContext, query: NewCampaignAudienceQuery): Promise<NewCampaignAudienceResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    const marca = await tx.execute(sql`select 1 from liame.brand where id = ${query.brand_id} and tenant_id = ${quem.tenantId} and archived_at is null`);
    if (!marca.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    const loja = (
      await tx.execute<{ location_precision: string | null; latitude: string | null; longitude: string | null; ibge_city_code: string | null }>(sql`
        select location_precision, latitude::text, longitude::text, ibge_city_code from liame.unit
         where id = ${query.unit_id} and tenant_id = ${quem.tenantId} and brand_id = ${query.brand_id}`)
    ).rows[0];
    if (!loja) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'A loja não é desta marca.');
    const { anuncios } = await contasDaMarca(tx, quem.tenantId, query.brand_id);
    if (anuncios.length !== 1 || loja.location_precision !== 'endereco' || loja.latitude === null || loja.longitude === null) {
      return { status: 'indisponivel', lower: null, upper: null, minimum: PUBLICO_MINIMO_NO_RAIO, enough: null };
    }
    // Os bairros (R6, parte 3): os mesmos lugares que o pedido vai mandar à Meta.
    const lugares = query.districts
      ? lugaresDosBairros(await this.bairrosDoPedido(tx, loja.ibge_city_code, query.districts.split(',')))
      : lugaresDoRaio(Number(loja.latitude), Number(loja.longitude), query.radius_km!);
    const e = await this.estimativa(tx, anuncios[0]!, lugares);
    return e.status === 'pronta'
      ? { status: 'pronta', lower: e.publico.de, upper: e.publico.ate, minimum: PUBLICO_MINIMO_NO_RAIO, enough: publicoSuficiente(e.publico) }
      : { status: e.status, lower: null, upper: null, minimum: PUBLICO_MINIMO_NO_RAIO, enough: null };
  }

  /**
   * A estimativa da Meta para o raio em volta do ponto da loja. A falha da Meta (fora do ar, sem permissão, demorou) vira
   * `indisponivel` com o motivo no log: a estimativa informa, não decide sozinha quando não há número.
   */
  private async estimativa(tx: ReturnType<typeof currentTx>, conta: Conta, lugares: Record<string, unknown>): Promise<Estimativa> {
    try {
      const publico = await publicoNoRaio.estimar(tx, { externalId: conta.external_id, segredo: conta.credential_secret_id }, lugares);
      return publico ? { status: 'pronta', publico } : { status: 'sem_estimativa' };
    } catch (e) {
      if (!(e instanceof ErroConector)) throw e;
      this.logger.warn(`estimativa de público indisponível (conta ${conta.id}): ${e.tipo} ${e.status ?? ''} ${e.message}`.trim());
      return { status: 'indisponivel' };
    }
  }

  /**
   * Os bairros da gaveta (R6, parte 3; D-RG-54 e D-RG-55): as áreas de entrega da loja (marcadas ao abrir), os bairros
   * com pedidos na última leitura do Regem e os escolhidos pela busca (`extra`), nos bairros do IBGE do município, cada
   * um com o jeito de ir para a Meta. O centro que falta é procurado agora (um por segundo, até o prazo); o que não deu
   * tempo fica `procurando`, e a gaveta pergunta de novo. A busca do bairro na Meta vale 30 dias.
   */
  async bairros(auth: AuthContext, query: NewCampaignDistrictsQuery, agora: Date = new Date()): Promise<NewCampaignDistrictsResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    const loja = await this.lojaDaMarca(tx, quem.tenantId, query.brand_id, query.unit_id);
    const vazio = { maximum: MAXIMO_DE_BAIRROS, items: [], pending: false, unmatched: [] };
    if (loja.location_precision !== 'endereco' || !loja.ibge_city_code || !loja.address_city || !loja.address_state || loja.latitude === null || loja.longitude === null) {
      return { status: 'sem_cidade', city: null, ...vazio };
    }
    const cidade = loja.ibge_city_code;

    // As áreas de entrega (Minha marca › Região) e os bairros com pedidos (Sua região), pelo nome, nos bairros do IBGE.
    const areas = (Array.isArray(loja.delivery_areas) ? loja.delivery_areas : [])
      .filter((a): a is string => typeof a === 'string')
      .map(bairroDaArea)
      .slice(0, MAXIMO_DE_BAIRROS);
    const pedidos = (
      await tx.execute<{ district: string; orders: string; dias: number }>(sql`
        select district, sum(orders)::text as orders, max(day_to - day_from + 1)::int as dias from liame.region_order_district
         where tenant_id = ${quem.tenantId} and unit_id = ${query.unit_id} and kind = 'bairro' and district is not null
         group by district order by sum(orders) desc, district limit ${MAXIMO_DE_BAIRROS}`)
    ).rows;
    type DoIbge = { name_key: string; district_code: string; name: string; area_km2: string | null };
    const chaves = [...new Set([...areas, ...pedidos.map((x) => x.district)].map(nomeComparavel))];
    const porNome = chaves.length
      ? (
          await tx.execute<DoIbge>(sql`
            select distinct on (name_key) name_key, district_code, name, area_km2::text from liame.region_district
             where city_code = ${cidade} and name_key in (select jsonb_array_elements_text(${JSON.stringify(chaves)}::jsonb))
             order by name_key, population desc nulls last, district_code`)
        ).rows
      : [];
    const extras = query.extra ? query.extra.split(',') : [];
    const porCodigo = extras.length
      ? (
          await tx.execute<DoIbge>(sql`
            select name_key, district_code, name, area_km2::text from liame.region_district
             where city_code = ${cidade} and district_code in (select jsonb_array_elements_text(${JSON.stringify(extras)}::jsonb))
             order by name, district_code`)
        ).rows
      : [];

    // A lista: as áreas de entrega primeiro, depois os bairros dos pedidos (os que mais pedem), depois os da busca.
    type Candidato = { codigo: string; nome: string; area: number | null; entrega: boolean; pedidos: number | null; dias: number | null };
    const lista = new Map<string, Candidato>();
    const doNome = new Map(porNome.map((r) => [r.name_key, r]));
    const dosPedidos = new Map<string, { orders: number; dias: number }>();
    for (const x of pedidos) {
      const k = nomeComparavel(x.district);
      if (!dosPedidos.has(k)) dosPedidos.set(k, { orders: Number(x.orders), dias: x.dias });
    }
    const por = (r: DoIbge, entrega: boolean) => {
      const ja = lista.get(r.district_code);
      if (ja) {
        ja.entrega ||= entrega;
        return;
      }
      const pd = dosPedidos.get(r.name_key);
      lista.set(r.district_code, { codigo: r.district_code, nome: r.name, area: r.area_km2 === null ? null : Number(r.area_km2), entrega, pedidos: pd?.orders ?? null, dias: pd?.dias ?? null });
    };
    const unmatched: string[] = [];
    for (const a of areas) {
      const r = doNome.get(nomeComparavel(a));
      if (r) por(r, true);
      else unmatched.push(a);
    }
    for (const x of pedidos) {
      const r = doNome.get(nomeComparavel(x.district));
      if (r) por(r, false);
    }
    for (const r of porCodigo) por(r, false);

    // O centro de cada um (o cache; o que falta, procurado agora) e o bairro na Meta (o cache; o que venceu, perguntado).
    const codigos = [...lista.keys()];
    type Ponto = { district_code: string; located: string; latitude: string | null; longitude: string | null; meta_location: string | null; meta_checked_at: Date | null };
    const lerPontos = async () =>
      new Map(
        (
          await tx.execute<Ponto>(sql`
            select district_code, located, latitude::text, longitude::text, meta_location, meta_checked_at from liame.region_district_point
             where district_code in (select jsonb_array_elements_text(${JSON.stringify(codigos)}::jsonb))`)
        ).rows.map((x) => [x.district_code, x]),
      );
    let pontos = codigos.length ? await lerPontos() : new Map<string, Ponto>();
    const semCentro = [...lista.values()].filter((c) => !pontos.has(c.codigo));
    if (semCentro.length) {
      await centrosDosBairros.procurarCentros(semCentro, loja.address_city, loja.address_state, Date.now() + PRAZO_DOS_CENTROS_MS);
      pontos = await lerPontos();
    }
    const { anuncios } = await contasDaMarca(tx, quem.tenantId, query.brand_id);
    const vencida = agora.getTime() - VALIDADE_DA_BUSCA_DA_META_MS;
    const perguntar = [...lista.values()].filter((c) => {
      const x = pontos.get(c.codigo);
      return x?.located === 'achado' && (x.meta_checked_at === null || new Date(x.meta_checked_at).getTime() < vencida);
    });
    if (anuncios.length === 1 && perguntar.length) {
      await this.perguntarBairrosAMeta(tx, anuncios[0]!, perguntar, loja.address_city);
      pontos = await lerPontos();
    }

    const daLoja = { latitude: Number(loja.latitude), longitude: Number(loja.longitude) };
    const items = [...lista.values()].map((c) => {
      const x = pontos.get(c.codigo);
      const centro = x?.located === 'achado' && x.latitude !== null && x.longitude !== null ? { latitude: Number(x.latitude), longitude: Number(x.longitude) } : null;
      const d = centro ? deslocamentoEmKm(daLoja, centro) : null;
      const how = !x ? 'procurando' : x.located !== 'achado' ? 'sem_centro' : x.meta_location ? 'meta' : 'circulo';
      return { code: c.codigo, name: c.nome, delivery_area: c.entrega, orders: c.pedidos, orders_days: c.dias, how, radius_km: centro ? raioDoBairro(c.area) : null, x_km: d?.x ?? null, y_km: d?.y ?? null };
    });
    return { status: 'pronta', city: loja.address_city, maximum: MAXIMO_DE_BAIRROS, items, pending: items.some((i) => i.how === 'procurando'), unmatched };
  }

  /** A busca de outro bairro na gaveta (D-RG-55): os bairros do IBGE do município da loja com o nome, até 10. */
  async buscarBairros(auth: AuthContext, query: NewCampaignDistrictSearchQuery): Promise<NewCampaignDistrictSearchResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    const loja = await this.lojaDaMarca(tx, quem.tenantId, query.brand_id, query.unit_id);
    const chave = nomeComparavel(query.q);
    if (!loja.ibge_city_code || chave.length < 2) return { items: [] };
    // O nome que começa com o que foi digitado vem antes; `strpos`, não `like`: o texto da pessoa não vira padrão.
    const r = await tx.execute<{ district_code: string; name: string }>(sql`
      select district_code, name from (
        select distinct on (name_key) name_key, district_code, name from liame.region_district
         where city_code = ${loja.ibge_city_code} and strpos(name_key, ${chave}) > 0
         order by name_key, population desc nulls last, district_code) b
       order by strpos(name_key, ${chave}) = 1 desc, name
       limit 10`);
    return { items: r.rows.map((x) => ({ code: x.district_code, name: x.name })) };
  }

  /** A loja da marca (404 de fora), com o município, o ponto e as áreas de entrega. */
  private async lojaDaMarca(tx: ReturnType<typeof currentTx>, tenantId: string, brandId: string, unitId: string) {
    const marca = await tx.execute(sql`select 1 from liame.brand where id = ${brandId} and tenant_id = ${tenantId} and archived_at is null`);
    if (!marca.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    const loja = (
      await tx.execute<{
        ibge_city_code: string | null;
        address_city: string | null;
        address_state: string | null;
        latitude: string | null;
        longitude: string | null;
        location_precision: string | null;
        delivery_areas: unknown;
      }>(sql`
        select ibge_city_code, address_city, address_state, latitude::text, longitude::text, location_precision, delivery_areas from liame.unit
         where id = ${unitId} and tenant_id = ${tenantId} and brand_id = ${brandId}`)
    ).rows[0];
    if (!loja) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'A loja não é desta marca.');
    return loja;
  }

  /**
   * Pergunta à Meta pelos bairros, um por vez, até o prazo, e guarda o que ela achou. A Meta que recusa a busca (pedido
   * errado: ela não tem bairros aqui) vale como "não achou"; fora do ar ou sem permissão, para e pergunta depois (o
   * bairro vai como círculo até lá), com o motivo no log.
   */
  private async perguntarBairrosAMeta(tx: ReturnType<typeof currentTx>, conta: Conta, bairros: ReadonlyArray<{ codigo: string; nome: string }>, cidade: string): Promise<void> {
    const prazo = Date.now() + PRAZO_DA_BUSCA_DA_META_MS;
    for (const b of bairros) {
      if (Date.now() > prazo) return;
      try {
        const corpo = await publicoNoRaio.procurarBairro(tx, { externalId: conta.external_id, segredo: conta.credential_secret_id }, b.nome);
        if (corpo === null) return;
        await centrosDosBairros.guardarMeta(b.codigo, bairroNaBuscaDaMeta(corpo, b.nome, cidade));
      } catch (e) {
        if (!(e instanceof ErroConector)) throw e;
        if (e.tipo === 'definitivo') {
          await centrosDosBairros.guardarMeta(b.codigo, null);
          continue;
        }
        this.logger.warn(`busca de bairro na Meta indisponível (conta ${conta.id}): ${e.tipo} ${e.status ?? ''} ${e.message}`.trim());
        return;
      }
    }
  }

  /**
   * Os bairros do pedido (e da estimativa), como vão para a Meta: do município da loja, cada um com o centro achado. O
   * bairro de outra cidade e o sem centro são recusados com o nome.
   */
  private async bairrosDoPedido(tx: ReturnType<typeof currentTx>, cidade: string | null, codigos: readonly string[]): Promise<BairroDaCampanha[]> {
    const linhas = cidade
      ? (
          await tx.execute<{ district_code: string; name: string; area_km2: string | null; located: string | null; latitude: string | null; longitude: string | null; meta_location: string | null }>(sql`
            select d.district_code, d.name, d.area_km2::text, p.located, p.latitude::text, p.longitude::text, p.meta_location
              from liame.region_district d left join liame.region_district_point p on p.district_code = d.district_code
             where d.city_code = ${cidade} and d.district_code in (select jsonb_array_elements_text(${JSON.stringify(codigos)}::jsonb))`)
        ).rows
      : [];
    const porCodigo = new Map(linhas.map((l) => [l.district_code, l]));
    if (codigos.some((c) => !porCodigo.has(c))) {
      throw recusa('bairro-fora-da-cidade', 'Bairro fora do município da loja', 'Os bairros são os do município da loja: escolha de novo na lista.', 'districts');
    }
    const semCentro = codigos.map((c) => porCodigo.get(c)!).filter((l) => l.located !== 'achado' || l.latitude === null || l.longitude === null);
    if (semCentro.length) {
      const nomes = semCentro.map((l) => l.name).join(', ');
      throw recusa(
        'bairro-sem-centro',
        'Bairro sem o centro no mapa',
        `O Liame ainda não tem o centro de ${nomes} no mapa: espere um pouco e peça de novo, ou tire ${semCentro.length === 1 ? 'esse bairro' : 'esses bairros'}.`,
        'districts',
      );
    }
    return codigos.map((c) => {
      const l = porCodigo.get(c)!;
      return { codigo: c, nome: l.name, meta: l.meta_location, latitude: Number(l.latitude), longitude: Number(l.longitude), raio_km: raioDoBairro(l.area_km2 === null ? null : Number(l.area_km2)) };
    });
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
             c.unit_id, c.name, c.objective, c.radius_km::text, c.districts, c.daily_budget_micros::text,
             c.end_date::text as end_date, c.link, c.audience_lower::text, c.audience_upper::text,
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
