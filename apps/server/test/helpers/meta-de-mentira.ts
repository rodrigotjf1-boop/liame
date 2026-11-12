import { randomInt, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type Database, uuidv7, withTenant } from '@liame/database';
import type { ReadResult } from '../../src/actions/connectors.js';
import { metaAnunciosConnector } from '../../src/actions/meta-anuncios.js';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { versaoRegistrada } from '../../src/connectors/tipos.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { menosDias } from '../../src/results/fora-do-normal.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { enableMfa, ownerQuery, signupAndLogin, type TestApi } from './api.js';

// Uma Graph API local para os testes de escrita na Meta (A4). Segue a referência conferida em 04/10/2026 (base de
// conhecimento §2.1): `GET /{id}?fields=…` devolve o objeto; `POST /{id}` muda `status` e `daily_budget` (na menor
// unidade da moeda); com `execution_options=["validate_only"]` valida sem mudar; a resposta é `{"success": true}`;
// os erros trazem `code`, `error_subcode` e `error_user_msg`; o uso da conta vem no cabeçalho.

export type ObjetoNaMeta = { id: string; name: string; status: string; effective_status: string; daily_budget?: string; lifetime_budget?: string; account_id: string };
export type ChamadaNaMeta = { metodo: string; id: string; params: Record<string, string>; validar: boolean };
export type FalhaDaMeta = { status: number; corpo: unknown; cabecalhos?: Record<string, string>; aplicaAntes?: boolean };
export type TipoDeObjeto = 'campanha' | 'conjunto' | 'anuncio';

/** Um objeto criado na conta pela campanha nova (A4, X5). */
export type CriadoNaMeta = { aresta: string; id: string; params: Record<string, string>; chave: string | null };

export const TOKEN_DA_META = 'token-de-sistema-da-meta-para-o-teste';
export const SEGREDO_DO_APP_DA_META = 'segredo-do-app-da-meta-de-teste';

export class MetaDeMentira {
  // Uma conta de anúncios por execução do arquivo: o balde e o disjuntor do cliente ficam no banco, por conta.
  readonly conta = String(randomInt(1_000_000_000, 9_999_999_999));
  readonly outraConta = String(randomInt(1_000_000_000, 9_999_999_999));
  readonly objetos = new Map<string, ObjetoNaMeta>();
  readonly chamadas: ChamadaNaMeta[] = [];
  /** O que apareceu de errado no pedido (token na URL, sem a prova do segredo do app). */
  readonly defeitos: string[] = [];
  /** O que a Meta responde às próximas escritas (na ordem), antes de voltar ao normal. */
  falhasDaEscrita: FalhaDaMeta[] = [];
  /** O mesmo, para as próximas leituras. */
  falhasDaLeitura: FalhaDaMeta[] = [];
  /** Cabeçalho de uso devolvido em toda resposta enquanto estiver definido. */
  uso: string | null = null;
  /** Quanto a Meta demora para responder à próxima chamada (uma vez só). */
  atrasoDaProximaRespostaMs = 0;
  /** O que foi criado na conta (A4, X5): a campanha, o conjunto, o criativo, o anúncio e o vídeo, na ordem. */
  readonly criados: CriadoNaMeta[] = [];
  /** As próximas criações que falham, por aresta; `aplicaAntes`: a Meta cria e a resposta se perde. */
  falhasDaCriacao: Array<FalhaDaMeta & { aresta: string }> = [];
  /** Quantas conferências do próximo vídeo ainda dizem "processing" antes de "ready". */
  leiturasDoVideoEmPreparo = 0;
  /** O próximo vídeo enviado dá erro no preparo. */
  videoComErro = false;
  /**
   * Os Reels do Instagram da Página (A4, X5, parte 6): o id do post e o que a Meta responde em
   * `boost_eligibility_info.eligible_to_boost` (nulo: o campo não vem). O post fora daqui não existe.
   */
  readonly reels = new Map<string, boolean | null>();
  base = '';
  private servidor: Server | null = null;
  private seq = 0;
  private readonly porChave = new Map<string, string>();
  private readonly videos = new Map<string, { leituras: number; erro: boolean }>();

  async ligar(): Promise<void> {
    const servidor = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        const r = this.responder(req);
        const atraso = this.atrasoDaProximaRespostaMs;
        this.atrasoDaProximaRespostaMs = 0;
        const enviar = () => {
          // Quem pediu pode ter desistido de esperar: aí não há mais a quem responder.
          if (res.destroyed) return;
          res.writeHead(r.status, { 'content-type': 'application/json', ...(this.uso ? { 'x-business-use-case-usage': this.uso } : {}), ...r.cabecalhos });
          res.end(JSON.stringify(r.corpo));
        };
        // O temporizador não segura o processo do teste: quem pediu pode ter desistido bem antes.
        if (atraso > 0) setTimeout(enviar, atraso).unref();
        else enviar();
      });
    });
    await new Promise<void>((ok) => servidor.listen(0, '127.0.0.1', ok));
    this.servidor = servidor;
    this.base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
  }

  async desligar(): Promise<void> {
    const servidor = this.servidor;
    if (servidor) await new Promise((ok) => servidor.close(ok));
  }

  /** Volta ao normal: sem falha combinada e sem cabeçalho de uso. */
  normalizar(): void {
    this.falhasDaEscrita = [];
    this.falhasDaLeitura = [];
    this.uso = null;
    this.atrasoDaProximaRespostaMs = 0;
    this.falhasDaCriacao = [];
    this.leiturasDoVideoEmPreparo = 0;
    this.videoComErro = false;
    this.reels.clear();
  }

  erro(code: number, message: string, extra: Record<string, unknown> = {}): unknown {
    return { error: { message, type: 'OAuthException', code, fbtrace_id: 'AbCdEf', ...extra } };
  }

  /** Um objeto novo na Meta (ativo; campanha e conjunto com R$ 30,00 por dia). */
  novo(tipo: TipoDeObjeto, extra: Partial<ObjetoNaMeta> = {}): ObjetoNaMeta {
    this.seq += 1;
    const id = `12021${String(Date.now()).slice(-8)}${String(this.seq).padStart(4, '0')}`;
    const o: ObjetoNaMeta = { id, name: `${tipo} ${this.seq}`, status: 'ACTIVE', effective_status: 'ACTIVE', account_id: this.conta, ...(tipo === 'anuncio' ? {} : { daily_budget: '3000' }), ...extra };
    this.objetos.set(id, o);
    return o;
  }

  chamadasDe(id: string): ChamadaNaMeta[] {
    return this.chamadas.filter((c) => c.id === id);
  }

  escritasDe(id: string): ChamadaNaMeta[] {
    return this.chamadasDe(id).filter((c) => c.metodo === 'POST');
  }

  resumo(id: string): string[] {
    return this.chamadasDe(id).map((c) => (c.metodo === 'GET' ? 'ler' : c.validar ? 'validar' : 'escrever'));
  }

  private responder(req: IncomingMessage): { status: number; corpo: unknown; cabecalhos?: Record<string, string> } {
    const url = new URL(req.url ?? '/', this.base);
    const token = (req.headers.authorization ?? '').replace('Bearer ', '');
    if (url.searchParams.has('access_token') || (req.url ?? '').includes(TOKEN_DA_META)) this.defeitos.push('token na URL');
    if (!url.searchParams.get('appsecret_proof')) this.defeitos.push('sem appsecret_proof');
    const daConta = /^\/graph\/v26\.0\/act_(\d+)\/(campaigns|adsets|adcreatives|ads|advideos)$/.exec(url.pathname);
    if (daConta) return this.criarNaConta(req, url, token, daConta[1]!, daConta[2]!);
    const id = /^\/graph\/v26\.0\/(\d+)$/.exec(url.pathname)?.[1];
    if (!id) return { status: 404, corpo: this.erro(100, 'Unknown path') };
    const params = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'appsecret_proof'));
    const validar = (params.execution_options ?? '') === '["validate_only"]';
    this.chamadas.push({ metodo: req.method ?? 'GET', id, params, validar });
    if (token !== TOKEN_DA_META) return { status: 400, corpo: this.erro(190, 'Error validating access token: Session has expired') };
    // A situação de um vídeo enviado à conta (A4, X5): `processing` nas primeiras conferências, depois `ready` (ou `error`).
    const video = req.method === 'GET' ? this.videos.get(id) : undefined;
    if (video) {
      const situacao = video.erro ? 'error' : video.leituras > 0 ? 'processing' : 'ready';
      if (video.leituras > 0) video.leituras -= 1;
      return { status: 200, corpo: { id, status: { video_status: situacao } } };
    }
    // Um Reels do Instagram: `GET /{ig-media-id}?fields=boost_eligibility_info` (o guia "Use Posts as Instagram Ads").
    if (req.method === 'GET' && this.reels.has(id)) {
      const falha = this.falhasDaLeitura.shift();
      if (falha) return falha;
      const elegivel = this.reels.get(id);
      return { status: 200, corpo: elegivel === null ? { id } : { id, boost_eligibility_info: { eligible_to_boost: elegivel } } };
    }
    const o = this.objetos.get(id);
    if (!o) {
      return {
        status: 400,
        corpo: this.erro(100, `Unsupported get request. Object with ID '${id}' does not exist, cannot be loaded due to missing permissions, or does not support this operation`, { error_subcode: 33 }),
      };
    }
    if (req.method === 'GET') return this.falhasDaLeitura.shift() ?? { status: 200, corpo: o };

    const aplicar = () => {
      if (params.status) o.status = o.effective_status = params.status;
      if (params.daily_budget) o.daily_budget = params.daily_budget;
    };
    const falha = this.falhasDaEscrita.shift();
    if (falha) {
      // "A Meta aceitou, mas a resposta se perdeu": a mudança acontece e quem pediu não fica sabendo.
      if (falha.aplicaAntes && !validar) aplicar();
      return falha;
    }
    // As regras da própria Meta, que a validação aplica sem mudar nada.
    if (params.daily_budget !== undefined && Number(params.daily_budget) < 600) {
      return {
        status: 400,
        corpo: this.erro(100, 'Invalid parameter', { error_subcode: 1885272, error_user_title: 'Orçamento baixo demais', error_user_msg: 'O orçamento diário precisa ser de pelo menos R$ 6,00.' }),
      };
    }
    if (params.daily_budget !== undefined && o.daily_budget === undefined) {
      return { status: 400, corpo: this.erro(100, 'Invalid parameter', { error_user_msg: 'O orçamento fica na campanha: não dá para definir no conjunto.' }) };
    }
    if (!validar) aplicar();
    return { status: 200, corpo: { success: true } };
  }

  /**
   * A criação na conta (A4, X5), pela referência oficial reconferida em 11/11/2026 (base §2.1): `POST
   * /act_{id}/campaigns`, `adsets`, `adcreatives` e `ads` aceitam `execution_options=["validate_only"]` (confere sem
   * criar, `{"success": true}`) e a chave de idempotência (`X-Client-Idempotent-Key`: a mesma chave devolve o mesmo
   * objeto, sem criar de novo); `advideos` recebe o `file_url` e o vídeo fica pronto depois de algumas conferências. As
   * regras que a Meta aplica e o teste precisa pegar: a verba no conjunto pede `is_adset_budget_sharing_enabled`; o raio
   * em quilômetros, de 1 a 80; o `advantage_audience` explícito; o destino WhatsApp com a Página promovida; o objetivo de
   * otimização que o objetivo da campanha aceita; o criativo com a Página, sem `instagram_actor_id` e sem
   * `standard_enhancements`, com o link do botão igual ao do criativo; o vídeo pronto antes do criativo; e o anúncio com o
   * conjunto e o criativo que existem.
   */
  private criarNaConta(req: IncomingMessage, url: URL, token: string, conta: string, aresta: string): { status: number; corpo: unknown; cabecalhos?: Record<string, string> } {
    const params = Object.fromEntries([...url.searchParams].filter(([k]) => k !== 'appsecret_proof'));
    const validar = (params.execution_options ?? '') === '["validate_only"]';
    this.chamadas.push({ metodo: req.method ?? 'GET', id: `act_${conta}/${aresta}`, params, validar });
    if (token !== TOKEN_DA_META) return { status: 400, corpo: this.erro(190, 'Error validating access token: Session has expired') };
    if (req.method !== 'POST' || conta !== this.conta) {
      return { status: 400, corpo: this.erro(100, `Unsupported post request. Object with ID 'act_${conta}' does not exist`, { error_subcode: 33 }) };
    }
    const invalido = (mensagem: string, extra: Record<string, unknown> = {}) => ({ status: 400, corpo: this.erro(100, 'Invalid parameter', { error_user_msg: mensagem, ...extra }) });
    const json = <T>(campo: string): T | null => {
      try {
        return params[campo] ? (JSON.parse(params[campo]!) as T) : null;
      } catch {
        return null;
      }
    };
    const criado = (id: string | undefined, qual: string) => this.criados.find((c) => c.id === id && c.aresta === qual);

    // As regras da Meta, que a validação também aplica.
    if (aresta === 'campaigns') {
      if (!params.special_ad_categories) return invalido('special_ad_categories is required');
      if (!/^OUTCOME_/.test(params.objective ?? '')) return invalido('Objetivo inválido.');
      if (!params.daily_budget && params.is_adset_budget_sharing_enabled === undefined) return invalido('Must specify True or False in is_adset_budget_sharing_enabled field', { error_subcode: 4834011 });
    }
    if (aresta === 'adsets') {
      const campanha = criado(params.campaign_id, 'campaigns');
      if (!campanha) return invalido('A campanha do conjunto não existe nesta conta.');
      const alvo = json<{ geo_locations?: { custom_locations?: Array<{ radius?: number; distance_unit?: string }> }; targeting_automation?: { advantage_audience?: number } }>('targeting');
      const pontos = alvo?.geo_locations?.custom_locations ?? [];
      if (!pontos.length) return invalido('O público precisa de um lugar.');
      if (pontos.some((p) => p.distance_unit !== 'kilometer' || (p.radius ?? 0) < 1 || (p.radius ?? 0) > 80)) return invalido('O raio vai de 1 a 80 quilômetros.', { error_subcode: 1815946 });
      if (alvo?.targeting_automation?.advantage_audience !== 0 && alvo?.targeting_automation?.advantage_audience !== 1) return invalido('Informe advantage_audience (0 ou 1).');
      if (Number(params.daily_budget ?? 0) < 600) return invalido('O orçamento diário precisa ser de pelo menos R$ 6,00.', { error_subcode: 1885272 });
      const objetivo = campanha.params.objective;
      const aceitos = objetivo === 'OUTCOME_TRAFFIC' ? ['LINK_CLICKS', 'LANDING_PAGE_VIEWS'] : ['CONVERSATIONS', 'LINK_CLICKS'];
      if (!aceitos.includes(params.optimization_goal ?? '')) return invalido('O objetivo de otimização não combina com o da campanha.');
      if (params.destination_type === 'WHATSAPP' && !json<{ page_id?: string }>('promoted_object')?.page_id) return invalido('O WhatsApp pede a Página promovida.');
    }
    // O criativo de um post já publicado no Instagram (A4, X5, parte 6): a Página (`object_id`), o Instagram dela, o
    // post (`source_instagram_media_id`) e o botão; sem `object_story_spec`. O post que não pode virar anúncio é recusado.
    if (aresta === 'adcreatives' && params.source_instagram_media_id !== undefined) {
      if ('object_story_spec' in params) return invalido('Use source_instagram_media_id ou object_story_spec, não os dois.');
      if (!params.object_id || !params.instagram_user_id) return invalido('O criativo de um post do Instagram precisa da Página (object_id) e do Instagram (instagram_user_id).');
      if (!this.reels.has(params.source_instagram_media_id)) return invalido('O post do Instagram não existe ou não é desta conta.');
      if (this.reels.get(params.source_instagram_media_id) === false) return invalido('Este post não pode ser usado como anúncio.', { error_subcode: 2446886 });
      const botao = json<{ type?: string; value?: { link?: string; app_destination?: string } }>('call_to_action');
      if (!botao?.type || (!botao.value?.link && !botao.value?.app_destination)) return invalido('O botão precisa do tipo e do destino.');
    }
    if (aresta === 'adcreatives' && params.source_instagram_media_id === undefined) {
      const spec = json<Record<string, unknown>>('object_story_spec');
      if (!spec?.page_id) return invalido('O criativo precisa da Página.');
      if ('instagram_actor_id' in spec) return invalido('instagram_actor_id foi descontinuado: use instagram_user_id.');
      if (params.degrees_of_freedom_spec?.includes('standard_enhancements')) return invalido('standard_enhancements foi descontinuado.');
      const link = spec.link_data as { link?: string; call_to_action?: { value?: { link?: string } } } | undefined;
      if (link && link.link !== link.call_to_action?.value?.link) return invalido('O link do botão tem de ser o mesmo do criativo.');
      const video = spec.video_data as { video_id?: string } | undefined;
      if (video) {
        const v = this.videos.get(video.video_id ?? '');
        if (!v || v.leituras > 0 || v.erro) return invalido('O vídeo ainda não está pronto.');
      }
    }
    if (aresta === 'ads') {
      if (!criado(params.adset_id, 'adsets')) return invalido('O conjunto do anúncio não existe nesta conta.');
      if (!criado(json<{ creative_id?: string }>('creative')?.creative_id, 'adcreatives')) return invalido('O criativo do anúncio não existe nesta conta.');
    }
    if (aresta === 'advideos' && !params.file_url) return invalido('Informe o vídeo (file_url).');

    const falha = this.falhasDaCriacao.findIndex((f) => f.aresta === aresta && (!validar || !f.aplicaAntes));
    const chave = typeof req.headers['x-client-idempotent-key'] === 'string' ? req.headers['x-client-idempotent-key'] : null;
    const criar = () => {
      const ja = chave ? this.porChave.get(chave) : undefined;
      if (ja) return ja;
      this.seq += 1;
      const id = `23850${String(Date.now()).slice(-8)}${String(this.seq).padStart(4, '0')}`;
      this.criados.push({ aresta, id, params, chave });
      if (chave) this.porChave.set(chave, id);
      if (aresta === 'advideos') {
        this.videos.set(id, { leituras: this.leiturasDoVideoEmPreparo, erro: this.videoComErro });
        this.leiturasDoVideoEmPreparo = 0;
        this.videoComErro = false;
      }
      // A campanha, o conjunto e o anúncio entram na conta, como os outros objetos (a parte de ativar os lê).
      const tipo = { campaigns: 'campanha', adsets: 'conjunto', ads: 'anuncio' }[aresta];
      if (tipo) {
        this.objetos.set(id, {
          id,
          name: params.name ?? '',
          status: params.status ?? 'PAUSED',
          effective_status: params.status ?? 'PAUSED',
          account_id: this.conta,
          ...(aresta === 'adsets' ? { daily_budget: params.daily_budget } : {}),
        });
      }
      return id;
    };
    if (falha >= 0) {
      const f = this.falhasDaCriacao.splice(falha, 1)[0]!;
      if (f.aplicaAntes && !validar) criar();
      return f;
    }
    if (validar) return { status: 200, corpo: { success: true } };
    return { status: 200, corpo: { id: criar() } };
  }
}

/**
 * O conector de escrita apontado para a Meta de mentira, com a conferência sem espera e um balde folgado (o teste
 * escreve muito). `tempoDaLeituraDoPedidoMs`: quanto a leitura da hora do pedido espera (o padrão do conector é 10 s).
 */
export function ligarConectorNaMetaDeMentira(api: TestApi, meta: MetaDeMentira, opcoes: { tempoDaLeituraDoPedidoMs?: number } = {}): void {
  const database: Database = api.app.get(DATABASE);
  const vault = api.app.get(VaultService);
  metaAnunciosConnector.ligar({
    lerSegredo: (tx, secretId) => vault.readSecret(tx, secretId),
    cliente: () => new ClienteConector(database.db, { enderecos: { meta_ads: [`${meta.base}/graph`] }, tentativas: 1, balde: { capacidade: 10_000, porSegundo: 1_000 } }),
    graphUrl: `${meta.base}/graph`,
    appSecret: SEGREDO_DO_APP_DA_META,
    versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
    esperaDaConferenciaMs: 0,
    ...opcoes,
  });
}

export type EmpresaComMeta = {
  cookie: string;
  userId: string;
  /** O segredo do app autenticador de quem aprova. */
  secret: string;
  tenantId: string;
  brandId: string;
  /** A conta conectada da Meta, com a autorização guardada no cofre. */
  conta: string;
  /** Outra conta da Meta, sem a autorização guardada (revogada). */
  contaSemToken: string;
};

/** Uma empresa com o app autenticador ativo e duas contas da Meta conectadas (uma com a autorização, outra sem). */
export async function empresaComMeta(api: TestApi, meta: MetaDeMentira, nome: string, contas: { conta?: string; outra?: string } = {}): Promise<EmpresaComMeta> {
  const database: Database = api.app.get(DATABASE);
  const vault = api.app.get(VaultService);
  const s = await signupAndLogin(api, undefined, nome);
  const { secret } = await enableMfa(api, s.cookie);
  const tenantId = s.me.active_organization_id as string;
  const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
  const segredo = await withTenant(database.db, tenantId, (tx) =>
    vault.putSecret(tx, { tenantId, purpose: 'oauth_meta', plaintext: JSON.stringify({ tipo: 'meta', access_token: TOKEN_DA_META, obtido_em: new Date().toISOString(), expira_em: null }) }),
  );
  const [conta, contaSemToken] = [randomUUID(), randomUUID()];
  await ownerQuery(
    `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, credential_secret_id)
     values ($1, $3, $4, 'meta_ads', $5, 'CA - Mister Burgers', 'BRL', 'America/Sao_Paulo', $7),
            ($2, $3, $4, 'meta_ads', $6, 'CA - sem autorização', 'BRL', 'America/Sao_Paulo', null)`,
    [conta, contaSemToken, tenantId, brandId, `act_${contas.conta ?? meta.conta}`, `act_${contas.outra ?? meta.outraConta}`, segredo],
  );
  return { cookie: s.cookie, userId: s.me.user.id as string, secret, tenantId, brandId, conta, contaSemToken };
}

/** Liga ou desliga uma flag (`meta_write`, `google_write`, `conversoes_google`, `perfil_google`, `perfil_google_write`, `search_console`, `desempenho_anuncios`, `fotos`, `videos`, `cobranca`, `social_write`) para a empresa. */
export async function ligarFlagDaEmpresa(
  api: TestApi,
  chave:
    | 'meta_write'
    | 'google_write'
    | 'conversoes_google'
    | 'perfil_google'
    | 'perfil_google_write'
    | 'search_console'
    | 'desempenho_anuncios'
    | 'fotos'
    | 'videos'
    | 'cobranca'
    | 'social_write'
    | 'resumo_das_pessoas'
    | 'escolha_de_modelo'
    | 'verba_por_plataforma'
    | 'comentarios'
    | 'comentarios_responder'
    | 'comentarios_sugeridos'
    | 'comentarios_automatico'
    | 'direct'
    | 'direct_responder'
    | 'direct_automatico'
    | 'messenger'
    | 'stories'
    | 'campanha_nova'
    | 'campanha_google'
    | 'video_montado'
    | 'regiao'
    | 'ia',
  tenantId: string,
  valor: boolean,
): Promise<void> {
  await ownerQuery(`delete from liame.feature_flag_rule where flag_key = $1 and scope_type = 'tenant' and scope_id = $2`, [chave, tenantId]);
  if (valor) {
    await ownerQuery(
      `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, rollout_percent, created_by)
       values (gen_random_uuid(), $1, 'tenant', $2, 'true'::jsonb, null, 'testes')`,
      [chave, tenantId],
    );
  }
  api.app.get(FlagService).invalidate();
}

/** Liga ou desliga a flag `meta_write` para a empresa. */
export async function ligarEscritaNaMeta(api: TestApi, tenantId: string, valor: boolean): Promise<void> {
  await ligarFlagDaEmpresa(api, 'meta_write', tenantId, valor);
}

/**
 * Um objeto novo na Meta e na lista que o Liame leu da conta. `semLinha`: o Liame não leu o objeto (não o conhece).
 * `conta`: a conta conectada do Liame em que ele entra (por padrão, a da empresa com a autorização).
 */
export async function objetoLido(
  meta: MetaDeMentira,
  e: Pick<EmpresaComMeta, 'tenantId' | 'conta'>,
  tipo: TipoDeObjeto,
  extra: Partial<ObjetoNaMeta> = {},
  opcoes: { conta?: string; semLinha?: boolean } = {},
): Promise<{ id: string; recurso: string }> {
  const o = meta.novo(tipo, extra);
  if (!opcoes.semLinha) {
    const tabela = { campanha: 'campaign', conjunto: 'ad_group', anuncio: 'ad' }[tipo];
    await ownerQuery(`insert into liame.${tabela} (id, tenant_id, connected_account_id, provider, external_id, name, status) values ($1, $2, $3, 'meta_ads', $4, $5, 'ativa')`, [
      randomUUID(),
      e.tenantId,
      opcoes.conta ?? e.conta,
      o.id,
      o.name,
    ]);
  }
  return { id: o.id, recurso: `${tipo}:${o.id}` };
}

/** A regra da sombra que recomenda cada ação (`sombra/regras.ts`). */
export const REGRA_DA_SOMBRA = { orcamento_reduzir: 'prejuizo', orcamento_aumentar: 'lucro_no_limite', campanha_pausar: 'prejuizo_forte' } as const;
export type AcaoRecomendada = keyof typeof REGRA_DA_SOMBRA;

/**
 * Uma campanha lida da conta (com a verba diária de R$ 30,00 que o Liame guardou dela) e a recomendação em aberto do
 * Gestor de tráfego para ela, como a rotina da sombra grava: do dia dado (no fuso da loja), com os números dos 7 dias
 * anteriores e o passo de 10% nas de verba.
 */
export async function campanhaComRecomendacao(
  meta: MetaDeMentira,
  emp: Pick<EmpresaComMeta, 'tenantId' | 'brandId' | 'conta'>,
  tool: AcaoRecomendada,
  opcoes: { dia: string; nome?: string },
): Promise<{ id: string; recurso: string; campanha: string; recomendacao: string }> {
  const nome = opcoes.nome ?? 'Delivery noite';
  const c = await objetoLido(meta, emp, 'campanha', { name: nome });
  const [linha] = await ownerQuery<{ id: string }>(`update liame.campaign set daily_budget_micros = 30000000 where tenant_id = $1 and external_id = $2 returning id`, [emp.tenantId, c.id]);
  const retrato = {
    campanha: { nome, situacao: 'ativa', verba_diaria_micros: '30000000' },
    janela: { de: menosDias(opcoes.dia, 7), ate: menosDias(opcoes.dia, 1), fuso: 'America/Sao_Paulo' },
    plataforma: { spend_micros: '150000000' },
    caixa: { orders: 2, revenue_micros: '120000000', margin_known_micros: '90000000', margin_coverage_pct: '100.0', verdict: 'prejuizo' },
  };
  const recomendacao = uuidv7();
  await ownerQuery(
    `insert into liame.shadow_decision (id, tenant_id, brand_id, connected_account_id, campaign_id, provider, source, tool, rule_key, rule_version, params,
                                        confidence, state_snapshot, decided_on, window_from, window_to, evaluate_on, status)
     values ($1, $2, $3, $4, $5, 'meta_ads', 'regra', $6, $7, 2, $8, 0.9, $9, $10, $11, $12, $13, 'aberta')`,
    [
      recomendacao,
      emp.tenantId,
      emp.brandId,
      emp.conta,
      linha!.id,
      tool,
      REGRA_DA_SOMBRA[tool],
      JSON.stringify(tool === 'campanha_pausar' ? {} : { percent: 10 }),
      JSON.stringify(retrato),
      opcoes.dia,
      menosDias(opcoes.dia, 7),
      menosDias(opcoes.dia, 1),
      menosDias(opcoes.dia, -7),
    ],
  );
  return { ...c, campanha: linha!.id, recomendacao };
}

/** O estado do objeto como o conector o lê (na Meta de mentira), sob a RLS da empresa. */
export function lerNaMetaDeMentira(api: TestApi, tenantId: string, conta: string, recurso: string): Promise<ReadResult | null> {
  const database: Database = api.app.get(DATABASE);
  return withTenant(database.db, tenantId, (tx) => metaAnunciosConnector.read(tx, { tenantId, accountId: conta, resourceId: recurso }));
}
