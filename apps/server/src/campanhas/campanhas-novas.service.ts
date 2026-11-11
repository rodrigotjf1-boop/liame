import type { CreateNewCampaignRequest, NewCampaignResponse } from '@liame/contracts';
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
import { recursoDaCampanhaNova } from './campanha-nova-plano.js';

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

/** O dia de hoje no fuso da empresa (`AAAA-MM-DD`). */
function hojeNoFuso(agora: Date, fuso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}

type LinhaDaCampanhaNova = {
  id: string;
  brand_id: string;
  piece_id: string;
  piece_version: number;
  media_id: string;
  unit_id: string;
  name: string;
  objective: 'cardapio' | 'whatsapp';
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
  created_at: Date;
};

function resposta(l: LinhaDaCampanhaNova): NewCampaignResponse {
  return {
    id: l.id,
    brand_id: l.brand_id,
    piece_id: l.piece_id,
    piece_version: l.piece_version,
    media_id: l.media_id,
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
    meta: { campaign_id: l.meta_campaign_id, adset_id: l.meta_adset_id, video_id: l.meta_video_id, creative_id: l.meta_creative_id, ad_id: l.meta_ad_id },
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

    // A peça aprovada, na versão atual.
    const peca = (
      await tx.execute<{ status: string; version: number }>(sql`
        select status, version from liame.ad_piece where id = ${body.piece_id} and tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id}`)
    ).rows[0];
    if (!peca) throw recusa('peca-nao-encontrada', 'Peça não encontrada', 'A peça não está em Criativos desta marca.', 'piece_id');
    if (peca.status !== 'aprovada') throw recusa('peca-nao-aprovada', 'A peça não foi aprovada', 'Só a peça aprovada em Criativos vira campanha. Aprove a peça antes.', 'piece_id');

    // A foto ou o vídeo pronto de Fotos (o vídeo só com a capa guardada: o anúncio de vídeo leva a capa).
    const midia = (
      await tx.execute<{ kind: string; has_cover: boolean | null }>(sql`
        select kind, has_cover from liame.brand_photo
         where id = ${body.media_id} and tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id} and status = 'pronta' and removed_at is null`)
    ).rows[0];
    if (!midia) throw recusa('midia-fora-das-fotos', 'Mídia não encontrada', 'Escolha uma foto ou um vídeo pronto de Fotos desta marca.', 'media_id');
    if (midia.kind === 'video' && !midia.has_cover) {
      throw recusa('video-sem-capa', 'O vídeo não tem capa', 'O anúncio de vídeo leva a capa: escolha a capa do vídeo em Fotos, ou use outro vídeo.', 'media_id');
    }

    // A conta de anúncios da Meta e a Página da marca (D-A4-35): uma de cada.
    const contas = (
      await tx.execute<{ id: string; provider: string; currency: string | null }>(sql`
        select a.id, a.provider, a.currency from liame.connected_account a
         where a.tenant_id = ${quem.tenantId} and a.brand_id = ${body.brand_id} and a.provider in ('meta_ads', 'facebook_page') and ${contaConectada('a')}
         order by a.provider, a.id`)
    ).rows;
    const anuncios = contas.filter((c) => c.provider === 'meta_ads');
    const paginas = contas.filter((c) => c.provider === 'facebook_page');
    if (anuncios.length === 0) throw conflito('sem-conta-de-anuncios', 'Sem conta de anúncios', 'Conecte a conta de anúncios da Meta da marca em Contas conectadas.');
    if (anuncios.length > 1) throw conflito('varias-contas-de-anuncios', 'Mais de uma conta de anúncios', 'A marca tem mais de uma conta de anúncios da Meta: deixe uma só em Contas conectadas.');
    if (paginas.length === 0) {
      throw conflito('sem-pagina', 'Falta a Página do Facebook', 'Na Meta, todo anúncio sai em nome de uma Página do Facebook. Conecte a Meta de novo em Contas conectadas e escolha a Página da marca.');
    }
    if (paginas.length > 1) throw conflito('varias-paginas', 'Mais de uma Página', 'A marca tem mais de uma Página do Facebook ligada: deixe uma só em Contas conectadas.');
    const contaDeAnuncios = anuncios[0]!;
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

    // O destino: o cardápio da loja escolhida, ou o WhatsApp da Página.
    let link: string | null = null;
    if (body.objective === 'cardapio') {
      const destino = await destinoDoPost(tx, quem.tenantId, body.brand_id);
      if (!destino.ok || destino.unitId !== body.unit_id) {
        throw recusa(
          'sem-cardapio',
          'Sem o cardápio da loja',
          destino.ok || destino.motivo === 'varias_lojas'
            ? 'O cardápio online ligado à marca é o de outra loja: escolha a loja do cardápio, ou o objetivo de conversas no WhatsApp.'
            : destino.motivo === 'outra_plataforma'
              ? 'A loja recebe os pedidos online por outra plataforma: use o objetivo de conversas no WhatsApp.'
              : 'A loja não tem o cardápio online ligado ao Liame: ligue o Regem em Contas conectadas, ou use o objetivo de conversas no WhatsApp.',
          'objective',
        );
      }
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

    // O pedido anterior com a mesma peça que já se encerrou em Aprovações (recusado, expirado, ou que falhou no meio) sai
    // do caminho: a campanha nova dele fica cancelada (ou não criada, se já tinha começado na Meta).
    await tx.execute(sql`
      update liame.ad_campaign_new c
         set status = case when c.status = 'criando' then 'nao_criada' else 'cancelada' end,
             error = case when c.status = 'criando' then coalesce(left(r.status_reason, 2000), 'A criação parou antes do fim.') else c.error end,
             updated_at = now()
        from liame.action_request r
       where c.tenant_id = ${quem.tenantId} and c.piece_id = ${body.piece_id} and c.status in ('pedida', 'criando')
         and r.id = c.action_id and r.tenant_id = c.tenant_id and r.status in ${ENCERRADOS}`);

    // A campanha nova e o pedido. O segundo pedido com a mesma peça espera o primeiro (o índice único de peça em aberto).
    const id = uuidv7();
    const nova = await tx.execute(sql`
      insert into liame.ad_campaign_new (id, tenant_id, brand_id, ad_account_id, page_account_id, piece_id, piece_version, media_id, unit_id,
                                         name, objective, radius_km, daily_budget_micros, end_date, link, created_by)
      values (${id}, ${quem.tenantId}, ${body.brand_id}, ${contaDeAnuncios.id}, ${paginas[0]!.id}, ${body.piece_id}, ${peca.version}, ${body.media_id}, ${body.unit_id},
              ${body.name}, ${body.objective}, ${body.radius_km}, ${body.daily_budget_micros}, ${body.end_date ?? null}, ${link}, ${quem.userId})
      on conflict do nothing
      returning id`);
    if (!nova.rows[0]) {
      throw conflito('ja-pedida', 'Já existe um pedido com esta peça', 'Já existe um pedido de campanha com esta peça esperando aprovação. Decida esse antes de pedir outro.');
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
      after: { brand_id: body.brand_id, piece_id: body.piece_id, piece_version: peca.version, media_id: body.media_id, unit_id: body.unit_id, objective: body.objective, radius_km: body.radius_km, daily_budget_micros: body.daily_budget_micros, end_date: body.end_date ?? null, action_id: pedido },
    });
    return this.obter(auth, id);
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
      await tx.execute<{ brand_id: string; ad_account_id: string; status: string; active: boolean; daily_budget_micros: string }>(sql`
        select brand_id, ad_account_id, status, active, daily_budget_micros::text from liame.ad_campaign_new
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

  /** Uma campanha nova da empresa. */
  async obter(auth: AuthContext, id: string): Promise<NewCampaignResponse> {
    const quem = this.quem(auth);
    // O pedido que se encerrou em Aprovações sem criar: cancelada (ou não criada, se já tinha começado na Meta).
    const r = await currentTx().execute<LinhaDaCampanhaNova>(sql`
      select c.id, c.brand_id, c.piece_id, c.piece_version, c.media_id, c.unit_id, c.name, c.objective, c.radius_km::text, c.daily_budget_micros::text,
             c.end_date::text as end_date, c.link,
             case when c.status in ('pedida', 'criando') and r.status in ${ENCERRADOS}
                  then (case when c.status = 'criando' then 'nao_criada' else 'cancelada' end) else c.status end as status,
             c.action_id,
             case when c.status = 'criando' and r.status in ${ENCERRADOS} then coalesce(r.status_reason, 'A criação parou antes do fim.') else c.error end as error,
             c.meta_campaign_id, c.meta_adset_id, c.meta_video_id, c.meta_creative_id, c.meta_ad_id, c.created_at,
             c.active, c.activated_at,
             (select a.id from liame.action_request a
               where a.tenant_id = c.tenant_id and a.resource_id = ${recursoDaCampanhaNova(id)} and a.tool in ('campanha_nova_ativar', 'campanha_nova_pausar')
                 and a.status in ${EM_ABERTO}
               order by a.created_at desc limit 1) as pending_action_id
        from liame.ad_campaign_new c
        left join liame.action_request r on r.id = c.action_id and r.tenant_id = c.tenant_id
       where c.id = ${id} and c.tenant_id = ${quem.tenantId}`);
    const l = r.rows[0];
    if (!l) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Esta campanha nova não está aqui.');
    return resposta(l);
  }
}
