import type {
  CreateGoogleCampaignRequest,
  GoogleCampaignOptionsQuery,
  GoogleCampaignOptionsResponse,
  GoogleCampaignResponse,
  GoogleCampaignTextsRequest,
  GoogleCampaignTextsResponse,
} from '@liame/contracts';
import { type Database, uuidv7 } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ActionService } from '../actions/action.service.js';
import { baseDoPedido } from '../ai/criativo/contexto.js';
import {
  contextoDosTextosDoGoogle,
  mensagemDosTextosDoGoogle,
  PROMPT_CRIATIVO_GOOGLE,
  RespostaDosTextosDoGoogle,
  TAREFA_CRIATIVO_GOOGLE,
  textosDoGoogleDaResposta,
  totalDeDescartes,
  WORKFLOW_DO_CRIATIVO_GOOGLE,
} from '../ai/criativo/google.js';
import { CRIATIVO } from '../ai/criativo/prompt.js';
import { AiError, AiGateway } from '../ai/gateway.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { registrarRecusa } from '../ai/recusas.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import { contaConectada } from '../connections/conectada.js';
import { emMenorUnidade } from '../connectors/meta/verba.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { marcaDoCriativo } from '../criativo/base.js';
import { FLAG_DO_CRIATIVO } from '../criativo/pecas.service.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { REGRAS_DE_TEXTO_VERSAO } from '../policy/texto.js';
import { tetoDaVerba } from '../policy/teto-da-verba.js';
import { destinoDoPost } from '../posts/link-do-post.js';
import { LIMITES_DO_GOOGLE, motivoDaFotoPequena, motivoDosTextos, recursoDaCampanhaGoogle } from './campanha-google-plano.js';

// A campanha nova no Google, criada pausada (A5, Y9, parte 2; P45 pré-aprovado em 12/11/2026; D-A5-21 a D-A5-26). A
// rota confere tudo o que a ferramenta `campanha_google_criar` exige antes de pedir: a peça aprovada, os textos nos
// tamanhos do Google, a foto pronta e grande o bastante para os recortes, o nome e a logo da loja, a conta do Google Ads
// da marca, a loja com o ponto no endereço, o cardápio dela (o destino), a verba (sem fração de centavo e dentro do teto
// por campanha) e o fim. O pedido nasce em Aprovações, esperando o código do app; nada vai ao Google antes disso.

export const FLAG_DA_CAMPANHA_GOOGLE = 'campanha_google';

/** As situações do pedido que encerram sem criar: recusado (cancelado), expirado ou que falhou. */
const ENCERRADOS = sql`('cancelada', 'expirada', 'falhou')`;

type Quem = { tenantId: string; userId: string };
type Conta = { id: string; name: string; currency: string | null };

function recusa(code: string, title: string, detail: string, path?: string): AppProblem {
  return new AppProblem(422, code, title, detail, {}, path ? [{ path, message: detail }] : undefined);
}
function conflito(code: string, title: string, detail: string): AppProblem {
  return new AppProblem(409, code, title, detail);
}

const SEM_LOGO = conflito(
  'sem-logo',
  'Falta a logo da loja',
  `A campanha no Google sai com o nome e a logo da loja. Envie a logo em Minha marca antes (quadrada, de pelo menos ${LIMITES_DO_GOOGLE.logoMinimo} × ${LIMITES_DO_GOOGLE.logoMinimo}).`,
);

/** A conta do Google Ads da marca, conectada (uma só). */
async function contasDoGoogle(tx: ReturnType<typeof currentTx>, tenantId: string, brandId: string): Promise<Conta[]> {
  return (
    await tx.execute<Conta>(sql`
      select a.id, a.name, a.currency from liame.connected_account a
       where a.tenant_id = ${tenantId} and a.brand_id = ${brandId} and a.provider = 'google_ads' and ${contaConectada('a')}
       order by a.id`)
  ).rows;
}

/** O que impede pela conta: uma conta do Google Ads. A mesma regra no pedido e nas opções da gaveta. */
function bloqueioDaConta(contas: Conta[]): AppProblem | null {
  if (contas.length === 0) return conflito('sem-conta-do-google', 'Sem conta do Google Ads', 'Conecte a conta do Google Ads da marca em Contas conectadas.');
  if (contas.length > 1) return conflito('varias-contas-do-google', 'Mais de uma conta do Google Ads', 'A marca tem mais de uma conta do Google Ads: deixe uma só em Contas conectadas.');
  return null;
}

/** Por que o cardápio não vale para a loja (no Google, o destino é o cardápio: D-A5-26); `null` quando vale. */
function motivoSemCardapio(destino: Awaited<ReturnType<typeof destinoDoPost>>, unitId: string): string | null {
  if (destino.ok && destino.unitId === unitId) return null;
  if (destino.ok || destino.motivo === 'varias_lojas') return 'O cardápio online ligado à marca é o de outra loja: escolha a loja do cardápio.';
  if (destino.motivo === 'outra_plataforma') return 'A loja recebe os pedidos online por outra plataforma: no Google, o anúncio leva ao cardápio do Liame.';
  return 'A loja não tem o cardápio online ligado ao Liame: ligue o Regem em Contas conectadas.';
}

/** O dia de hoje no fuso da empresa (`AAAA-MM-DD`). */
function hojeNoFuso(agora: Date, fuso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(agora);
}

type Linha = {
  id: string;
  brand_id: string;
  piece_id: string;
  piece_version: number;
  media_id: string;
  unit_id: string;
  name: string;
  headlines: string[];
  long_headlines: string[];
  descriptions: string[];
  business_name: string;
  radius_km: string;
  daily_budget_micros: string;
  end_date: string | null;
  link: string;
  status: GoogleCampaignResponse['status'];
  action_id: string | null;
  error: string | null;
  active: boolean;
  activated_at: Date | null;
  google_budget_id: string | null;
  google_campaign_id: string | null;
  google_asset_group_id: string | null;
  conta_externa: string | null;
  created_at: Date;
};

function resposta(l: Linha): GoogleCampaignResponse {
  return {
    id: l.id,
    brand_id: l.brand_id,
    piece_id: l.piece_id,
    piece_version: l.piece_version,
    media_id: l.media_id,
    unit_id: l.unit_id,
    name: l.name,
    headlines: l.headlines,
    long_headlines: l.long_headlines,
    descriptions: l.descriptions,
    business_name: l.business_name,
    radius_km: Number(l.radius_km),
    daily_budget_micros: Number(l.daily_budget_micros),
    end_date: l.end_date,
    link: l.link,
    status: l.status,
    action_id: l.action_id,
    error: l.error,
    active: l.active,
    activated_at: l.activated_at ? new Date(l.activated_at).toISOString() : null,
    google: { account_id: l.conta_externa, budget_id: l.google_budget_id, campaign_id: l.google_campaign_id, asset_group_id: l.google_asset_group_id },
    created_at: new Date(l.created_at).toISOString(),
  };
}

@Injectable()
export class CampanhasGoogleService {
  constructor(
    private readonly actions: ActionService,
    private readonly flags: FlagService,
    private readonly policies: PolicyService,
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly gateway: AiGateway,
  ) {}

  private quem(auth: AuthContext): Quem {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
    return { tenantId: auth.tenantId, userId: auth.userId };
  }

  /**
   * Pede a campanha nova no Google: confere o pedido, guarda a campanha nova e cria o pedido `campanha_google_criar`,
   * que espera a aprovação com o código do app em Aprovações. Um pedido em aberto por peça.
   */
  async criar(auth: AuthContext, body: CreateGoogleCampaignRequest, agora: Date = new Date()): Promise<GoogleCampaignResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    const marca = (await tx.execute<{ logo_id: string | null; logo_lado: number | null }>(sql`
      select logo_id, least(logo_width, logo_height) as logo_lado from liame.brand where id = ${body.brand_id} and tenant_id = ${quem.tenantId} and archived_at is null`)).rows[0];
    if (!marca) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    const ligada = await this.flags.isEnabled(FLAG_DA_CAMPANHA_GOOGLE, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId: body.brand_id }));
    if (!ligada) throw conflito('funcao-desligada', 'Função desligada', 'A campanha nova no Google não está ligada para esta empresa.');

    // A peça aprovada, na versão atual.
    const peca = (
      await tx.execute<{ status: string; version: number }>(sql`
        select status, version from liame.ad_piece where id = ${body.piece_id} and tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id}`)
    ).rows[0];
    if (!peca) throw recusa('peca-nao-encontrada', 'Peça não encontrada', 'A peça não está em Criativos desta marca.', 'piece_id');
    if (peca.status !== 'aprovada') throw recusa('peca-nao-aprovada', 'A peça não foi aprovada', 'Só a peça aprovada em Criativos vira campanha. Aprove a peça antes.', 'piece_id');

    // Os textos nos tamanhos do Google (D-A5-22), com as palavras da tela, no campo de cada um.
    const textos = { titulos: body.headlines.map((t) => t.trim()), titulosLongos: body.long_headlines.map((t) => t.trim()), descricoes: body.descriptions.map((t) => t.trim()) };
    const ruim = motivoDosTextos(textos);
    if (ruim) throw recusa('textos-do-google', 'Os textos não cabem no Google', ruim.motivo, ruim.campo);
    if ([...body.business_name].length > LIMITES_DO_GOOGLE.nomeDaLoja) {
      throw recusa('nome-da-loja-longo', 'O nome da loja é longo', `O Google mostra o nome da loja com até ${LIMITES_DO_GOOGLE.nomeDaLoja} caracteres.`, 'business_name');
    }

    // A foto pronta de Fotos (não o vídeo), grande o bastante para os recortes deitado e quadrado (D-A5-23).
    const foto = (
      await tx.execute<{ kind: string; width: number; height: number }>(sql`
        select kind, width, height from liame.brand_photo
         where id = ${body.media_id} and tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id} and status = 'pronta' and removed_at is null`)
    ).rows[0];
    if (!foto) throw recusa('midia-fora-das-fotos', 'Foto não encontrada', 'Escolha uma foto pronta de Fotos desta marca.', 'media_id');
    if (foto.kind === 'video') throw recusa('nao-e-foto', 'Não é uma foto', 'No Google, a campanha nova leva uma foto: o vídeo fica para depois.', 'media_id');
    const pequena = motivoDaFotoPequena(foto.width, foto.height);
    if (pequena) throw recusa('foto-pequena', 'A foto é pequena', pequena, 'media_id');

    // A logo de Minha marca (quadrada, de pelo menos 128 × 128).
    if (!marca.logo_id || (marca.logo_lado ?? 0) < LIMITES_DO_GOOGLE.logoMinimo) throw SEM_LOGO;

    // A conta do Google Ads da marca: uma só.
    const contas = await contasDoGoogle(tx, quem.tenantId, body.brand_id);
    const bloqueio = bloqueioDaConta(contas);
    if (bloqueio) throw bloqueio;
    const conta = contas[0]!;
    if (emMenorUnidade(body.daily_budget_micros, conta.currency) === null) {
      throw recusa('verba-invalida', 'Verba inválida', 'A verba diária não pode ter fração de centavo.', 'daily_budget_micros');
    }

    // A loja e o ponto dela no endereço (D-A4-41; D-RG-14).
    const loja = (
      await tx.execute<{ location_precision: string | null }>(sql`
        select location_precision from liame.unit where id = ${body.unit_id} and tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id}`)
    ).rows[0];
    if (!loja) throw recusa('loja-nao-encontrada', 'Loja não encontrada', 'A loja não é desta marca.', 'unit_id');
    if (loja.location_precision !== 'endereco') {
      throw recusa('loja-sem-endereco', 'Falta o endereço da loja', 'A campanha mostra o anúncio em volta da loja, e o ponto dela ainda não está no endereço. Ajuste o endereço da loja em Minha marca antes.', 'unit_id');
    }

    // O destino: o cardápio da loja escolhida (D-A5-26).
    const destino = await destinoDoPost(tx, quem.tenantId, body.brand_id);
    const semCardapio = motivoSemCardapio(destino, body.unit_id);
    if (semCardapio || !destino.ok) throw recusa('sem-cardapio', 'Sem o cardápio da loja', semCardapio ?? '', 'unit_id');

    // A verba dentro do teto por campanha do Google, quando ele existe.
    const { policies, timezone } = await this.policies.load(tx, quem.tenantId, body.brand_id);
    const teto = tetoDaVerba(policies, 'google_ads');
    if (teto !== null && body.daily_budget_micros > teto) {
      throw recusa(
        'acima-do-teto',
        'Acima do teto por campanha',
        `A verba diária passa do teto por campanha, que é de R$ ${(teto / 1_000_000).toFixed(2).replace('.', ',')} por dia. Quem muda o teto é o Dono ou o Administrador, em Verba do mês.`,
        'daily_budget_micros',
      );
    }
    if (body.end_date && body.end_date <= hojeNoFuso(agora, timezone)) throw recusa('fim-no-passado', 'Data de fim', 'A data de fim precisa ser depois de hoje.', 'end_date');

    // O pedido anterior com a mesma peça que já se encerrou em Aprovações sai do caminho: a campanha nova dele fica
    // cancelada (ou não criada, se já estava sendo criada).
    await tx.execute(sql`
      update liame.google_campaign_new c
         set status = case when c.status = 'criando' then 'nao_criada' else 'cancelada' end,
             error = case when c.status = 'criando' then coalesce(left(r.status_reason, 2000), 'A criação parou antes do fim.') else c.error end,
             updated_at = now()
        from liame.action_request r
       where c.tenant_id = ${quem.tenantId} and c.piece_id = ${body.piece_id} and c.status in ('pedida', 'criando')
         and r.id = c.action_id and r.tenant_id = c.tenant_id and r.status in ${ENCERRADOS}`);

    const id = uuidv7();
    // Cada texto como um parâmetro: o `${lista}` do Drizzle vira `($1, $2, …)`, e o literal `{a,b}` quebraria na vírgula.
    const lista = (itens: string[]) => sql`array[${sql.join(itens.map((t) => sql`${t}`), sql`, `)}]::text[]`;
    const nova = await tx.execute(sql`
      insert into liame.google_campaign_new (id, tenant_id, brand_id, ad_account_id, piece_id, piece_version, headlines, long_headlines, descriptions,
                                             business_name, media_id, unit_id, link, name, radius_km, daily_budget_micros, end_date, created_by)
      values (${id}, ${quem.tenantId}, ${body.brand_id}, ${conta.id}, ${body.piece_id}, ${peca.version},
              ${lista(textos.titulos)}, ${lista(textos.titulosLongos)}, ${lista(textos.descricoes)},
              ${body.business_name}, ${body.media_id}, ${body.unit_id}, ${destino.url}, ${body.name}, ${body.radius_km}, ${body.daily_budget_micros},
              ${body.end_date ?? null}, ${quem.userId})
      on conflict do nothing
      returning id`);
    if (!nova.rows[0]) {
      throw conflito('ja-pedida', 'Já existe um pedido com esta peça', 'Já existe um pedido de campanha no Google com esta peça esperando aprovação. Decida esse antes de pedir outro.');
    }
    const pedido = await this.actions.pedirPelaRota(auth, {
      tool: 'campanha_google_criar',
      brand_id: body.brand_id,
      provider: 'google_ads',
      account_id: conta.id,
      resource_id: recursoDaCampanhaGoogle(id),
      params: {},
    });
    await tx.execute(sql`update liame.google_campaign_new set action_id = ${pedido}, updated_at = now() where id = ${id}`);
    auditDetail({
      resourceId: id,
      before: null,
      after: {
        brand_id: body.brand_id,
        piece_id: body.piece_id,
        piece_version: peca.version,
        media_id: body.media_id,
        unit_id: body.unit_id,
        headlines: textos.titulos.length,
        long_headlines: textos.titulosLongos.length,
        descriptions: textos.descricoes.length,
        radius_km: body.radius_km,
        daily_budget_micros: body.daily_budget_micros,
        end_date: body.end_date ?? null,
        action_id: pedido,
      },
    });
    return this.obter(auth, id);
  }

  /**
   * Os textos do Google pelo Criativo (parte 4; D-A5-22; P45, "Pedir ao Criativo"): a leitura numa transação curta (a
   * marca, a função, a peça aprovada com a oferta do pedido dela, o Criativo e Minha marca); a IA sem transação aberta (a
   * rota espera o modelo por segundos); cada texto conferido antes de voltar, e a proposta só com o mínimo do Google. Sem
   * a IA, `sem_ia` com o motivo, e a pessoa fica com os textos da gaveta; o texto barrado conta em Sua equipe, sem o texto.
   */
  async textos(auth: AuthContext, body: GoogleCampaignTextsRequest): Promise<GoogleCampaignTextsResponse> {
    const quem = this.quem(auth);
    if (!this.database) throw new AppProblem(503, 'sem-banco', 'Indisponível', 'Tente de novo em instantes.');
    const database = this.database;
    const contexto = { tenantId: quem.tenantId, userId: quem.userId, brandId: body.brand_id };
    const lido = await naTransacaoDaEmpresa(database, quem, async () => {
      const tx = currentTx();
      const marca = (await tx.execute<{ name: string }>(sql`select name from liame.brand where id = ${body.brand_id} and tenant_id = ${quem.tenantId} and archived_at is null`)).rows[0];
      if (!marca) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
      if (!(await this.flags.isEnabled(FLAG_DA_CAMPANHA_GOOGLE, this.flags.context(contexto)))) {
        throw conflito('funcao-desligada', 'Função desligada', 'A campanha nova no Google não está ligada para esta empresa.');
      }
      // A peça aprovada, na versão atual, com a oferta do pedido dela.
      const peca = (
        await tx.execute<{ status: string; title: string | null; body: string | null; offer: string | null }>(sql`
          select p.status, v.title, v.body, r.offer
            from liame.ad_piece p
            left join liame.ad_piece_version v on v.piece_id = p.id and v.version = p.version and v.tenant_id = p.tenant_id
            left join liame.ad_piece_request r on r.id = p.request_id and r.tenant_id = p.tenant_id
           where p.id = ${body.piece_id} and p.tenant_id = ${quem.tenantId} and p.brand_id = ${body.brand_id}`)
      ).rows[0];
      if (!peca || !peca.title || !peca.body) throw recusa('peca-nao-encontrada', 'Peça não encontrada', 'A peça não está em Criativos desta marca.', 'piece_id');
      if (peca.status !== 'aprovada') throw recusa('peca-nao-aprovada', 'A peça não foi aprovada', 'Só a peça aprovada em Criativos vira campanha. Aprove a peça antes.', 'piece_id');
      // O Criativo trabalha com a função dele ligada e ativo na marca (pelo plano e pela própria empresa).
      const ativo =
        (await this.flags.isEnabled(FLAG_DO_CRIATIVO, this.flags.context(contexto))) &&
        (await funcionarioAtivo(tx, { tenantId: quem.tenantId, brandId: body.brand_id, agentKey: CRIATIVO.key, ativoPorPadrao: CRIATIVO.ativoPorPadrao }));
      const fuso = (await tx.execute<{ timezone: string | null }>(sql`select timezone from liame.organization where id = ${quem.tenantId}`)).rows[0]?.timezone ?? 'America/Sao_Paulo';
      return { ativo, nome: marca.name, peca: { titulo: peca.title, texto: peca.body, oferta: peca.offer ?? '' }, dossie: await marcaDoCriativo(body.brand_id, fuso, new Date()) };
    });

    const semIa = (reason: NonNullable<GoogleCampaignTextsResponse['reason']>, extra: { voltaEm?: Date; usageId?: string; dropped?: number } = {}): GoogleCampaignTextsResponse => ({
      origin: 'sem_ia',
      reason,
      texts: null,
      dropped: extra.dropped ?? 0,
      retry_at: extra.voltaEm ? extra.voltaEm.toISOString() : null,
      usage_id: extra.usageId ?? null,
    });
    if (!lido.ativo) return semIa('funcionario_desligado');
    if (!(await this.gateway.ligada(contexto))) return semIa('ia_desligada');

    const dossie = lido.dossie;
    const pedido = {
      marca: lido.nome,
      dossie: dossie?.dossie ?? `Marca "${lido.nome}": Minha marca ainda não foi preenchida.`,
      oferta: lido.peca.oferta,
      peca: { titulo: lido.peca.titulo, texto: lido.peca.texto },
    };
    let r: Awaited<ReturnType<AiGateway['structured']>>;
    try {
      r = await this.gateway.structured({
        tenantId: quem.tenantId,
        brandId: body.brand_id,
        userId: quem.userId,
        workflow: WORKFLOW_DO_CRIATIVO_GOOGLE,
        task: TAREFA_CRIATIVO_GOOGLE,
        promptVersion: `${PROMPT_CRIATIVO_GOOGLE.key}@${PROMPT_CRIATIVO_GOOGLE.version}`,
        instructions: PROMPT_CRIATIVO_GOOGLE.content,
        context: contextoDosTextosDoGoogle(pedido),
        messages: [{ role: 'user', content: mensagemDosTextosDoGoogle(pedido) }],
        schema: RespostaDosTextosDoGoogle,
      });
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      return semIa(err.code === 'desligada' ? 'ia_desligada' : err.code, { voltaEm: err.detalhe.voltaEm });
    }

    // O que a conferência tirou conta em Sua equipe (sem o texto): uma linha por motivo, com quantos textos.
    const anotar = (kind: string, rules: string[], items: number) =>
      registrarRecusa(database, {
        tenantId: quem.tenantId,
        brandId: body.brand_id,
        userId: quem.userId,
        usageId: r.usageId,
        member: CRIATIVO.key,
        workflow: WORKFLOW_DO_CRIATIVO_GOOGLE,
        kind,
        rules,
        rulesVersion: kind === 'compliance' ? REGRAS_DE_TEXTO_VERSAO : null,
        items,
      });
    const resposta = RespostaDosTextosDoGoogle.safeParse(r.object);
    if (!resposta.success) {
      await anotar('formato', [], 1);
      return semIa('formato', { usageId: r.usageId });
    }
    const c = textosDoGoogleDaResposta(resposta.data, baseDoPedido({ oferta: pedido.oferta, instrucao: null }, { fatos: dossie?.fatos ?? '', proibidas: dossie?.proibidas ?? [], concorrentes: dossie?.concorrentes ?? [] }));
    if (c.descartes.barrado) await anotar('compliance', c.achados.map((a) => a.tipo), c.descartes.barrado);
    if (c.descartes.dado_pessoal) await anotar('compliance', ['dado_pessoal'], c.descartes.dado_pessoal);
    if (!c.ok) {
      if (c.motivo === 'recusa') return semIa('recusa', { usageId: r.usageId });
      if (c.motivo === 'formato') await anotar('formato', [], 1);
      return semIa(c.motivo, { usageId: r.usageId, dropped: totalDeDescartes(c.descartes) });
    }
    return { origin: 'ia', reason: null, texts: c.textos, dropped: totalDeDescartes(c.descartes), retry_at: null, usage_id: r.usageId };
  }

  /**
   * As opções da gaveta (P45): se a função está ligada, o que impede pedir agora (as mesmas palavras do pedido), a conta,
   * o nome e a logo da loja, as lojas, o teto e em que pé está a campanha do Google de cada peça. Só leitura.
   */
  async opcoes(auth: AuthContext, query: GoogleCampaignOptionsQuery): Promise<GoogleCampaignOptionsResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    const marca = (await tx.execute<{ name: string; logo_id: string | null; logo_width: number | null; logo_height: number | null }>(sql`
      select name, logo_id, logo_width, logo_height from liame.brand where id = ${query.brand_id} and tenant_id = ${quem.tenantId} and archived_at is null`)).rows[0];
    if (!marca) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    const enabled = await this.flags.isEnabled(FLAG_DA_CAMPANHA_GOOGLE, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId: query.brand_id }));

    const blocks: GoogleCampaignOptionsResponse['blocks'] = [];
    if (!enabled) blocks.push({ code: 'funcao-desligada', title: 'Função desligada', detail: 'A campanha nova no Google não está ligada para esta empresa.' });
    const contas = await contasDoGoogle(tx, quem.tenantId, query.brand_id);
    const bloqueio = bloqueioDaConta(contas);
    if (bloqueio) blocks.push({ code: bloqueio.code, title: bloqueio.title, detail: bloqueio.detail });
    const logoOk = !!marca.logo_id && Math.min(marca.logo_width ?? 0, marca.logo_height ?? 0) >= LIMITES_DO_GOOGLE.logoMinimo;
    if (!logoOk) blocks.push({ code: SEM_LOGO.code, title: SEM_LOGO.title, detail: SEM_LOGO.detail });

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

    const { policies } = await this.policies.load(tx, quem.tenantId, query.brand_id);
    const by_piece = (
      await tx.execute<{ piece_id: string; campaign_id: string; status: GoogleCampaignResponse['status']; active: boolean; action_id: string | null }>(sql`
        select distinct on (piece_id) piece_id, id as campaign_id, status, active, action_id
          from liame.google_campaign_new
         where tenant_id = ${quem.tenantId} and brand_id = ${query.brand_id} and status <> 'cancelada'
         order by piece_id, created_at desc, id desc`)
    ).rows;

    return {
      enabled,
      blocks,
      ad_account: contas.length === 1 ? { name: contas[0]!.name, currency: contas[0]!.currency } : null,
      business_name: [...marca.name].slice(0, LIMITES_DO_GOOGLE.nomeDaLoja).join('').trim(),
      logo: marca.logo_id && marca.logo_width && marca.logo_height ? { width: marca.logo_width, height: marca.logo_height } : null,
      units,
      campaign_cap_micros: tetoDaVerba(policies, 'google_ads'),
      by_piece,
    };
  }

  /** Uma campanha nova do Google da empresa. */
  async obter(auth: AuthContext, id: string): Promise<GoogleCampaignResponse> {
    const quem = this.quem(auth);
    // O pedido que se encerrou em Aprovações sem criar: cancelada (ou não criada, se já estava sendo criada).
    const r = await currentTx().execute<Linha>(sql`
      select c.id, c.brand_id, c.piece_id, c.piece_version, c.media_id, c.unit_id, c.name, c.headlines, c.long_headlines, c.descriptions,
             c.business_name, c.radius_km::text, c.daily_budget_micros::text, c.end_date::text as end_date, c.link,
             case when c.status in ('pedida', 'criando') and r.status in ${ENCERRADOS}
                  then (case when c.status = 'criando' then 'nao_criada' else 'cancelada' end) else c.status end as status,
             c.action_id,
             case when c.status = 'criando' and r.status in ${ENCERRADOS} then coalesce(r.status_reason, 'A criação parou antes do fim.') else c.error end as error,
             c.active, c.activated_at, c.google_budget_id, c.google_campaign_id, c.google_asset_group_id, c.created_at,
             (select x.external_id from liame.connected_account x where x.id = c.ad_account_id and x.tenant_id = c.tenant_id) as conta_externa
        from liame.google_campaign_new c
        left join liame.action_request r on r.id = c.action_id and r.tenant_id = c.tenant_id
       where c.id = ${id} and c.tenant_id = ${quem.tenantId}`);
    const l = r.rows[0];
    if (!l) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Esta campanha nova não está aqui.');
    return resposta(l);
  }
}
