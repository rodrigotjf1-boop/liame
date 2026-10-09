import type {
  GoogleConversionAccount,
  GoogleConversionActionsResponse,
  GoogleConversionsResponse,
  SetGoogleConversionDestinationRequest,
  StopGoogleConversionDestinationRequest,
} from '@liame/contracts';
import type { Database } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { acessoGoogle, type CredencialGuardada } from '../connections/oauth.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { type AcaoDeConversao, criarConectorGoogleAds } from '../connectors/google-ads/conector-google-ads.js';
import { ESCOPO_DATA_MANAGER } from '../connectors/google-ads/data-manager.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { actorLabel } from '../context/unit-of-work.interceptor.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { KillSwitchService } from '../kill-switch/kill-switch.service.js';
import { VaultService } from '../vault/vault.service.js';
import { ESPERA_ANTES_DE_INFORMAR_MIN, FLAG_CONVERSOES_GOOGLE, pedidosAInformar, type TipoDaFalha } from './conversoes-google.js';
import { estaRecusando, JANELA_DAS_RECUSAS_DIAS } from './recusando.js';

// Conversões para o Google, pelas rotas (A5, Y1; protótipo P14, aprovado em 09/10/2026): a situação de cada conta do Google Ads da marca, as
// conversões da conta lidas do Google na hora, e escolher ou parar o destino. O envio em si é da rotina do worker
// (`conversoes-google.ts`): aqui nada é enviado.
//
// Ver e parar rodam na transação da rota. Ler as conversões e escolher o destino falam com o Google, e por isso são
// rotas `@SemTransacao`: o banco numa transação curta da empresa, o Google depois, sem transação aberta, e a gravação
// noutra transação curta, com o evento de auditoria junto.

/** As contagens da tela são deste número de dias. */
export const JANELA_DAS_CONTAGENS_DIAS = 30;
/** Há uma pessoa esperando a lista: o Google tem este tempo para responder. */
const TEMPO_DO_GOOGLE_MS = 15_000;
const DIA_MS = 86_400_000;

export const ACAO_DEFINIR = 'conversao.destino_definir';
export const ACAO_PARAR = 'conversao.destino_parar';
const RECURSO = 'conversion_destination';

type Quem = { tenantId: string; userId: string };

type LinhaDaConta = {
  id: string;
  name: string;
  external_id: string;
  authorized: boolean;
  conversion_action_id: string | null;
  conversion_action_name: string | null;
  starts_at: Date | string | null;
  stopped_at: Date | string | null;
  set_by: string | null;
  setter: string | null;
  stopped_by: string | null;
  stopper: string | null;
  last_run_at: Date | string | null;
  next_run_at: Date | string | null;
  last_error: string | null;
  last_error_kind: TipoDaFalha | null;
  informed: number;
  queued: number;
  corrected: number;
  refused: number;
  recent_refused: number;
  recent_answered: number;
  refusal_at: Date | string | null;
  refusal_reason: string | null;
};

/** A conta do Google Ads pronta para a leitura no Google: o que a parte do banco deixa para depois da transação. */
type ContaPronta = {
  id: string;
  brand_id: string;
  external_id: string;
  timezone: string | null;
  currency: string | null;
  login_customer_id: string | null;
  refreshToken: string;
};

const iso = (v: Date | string) => new Date(v).toISOString();
const ou = (v: Date | string | null) => (v === null ? null : iso(v));
const pessoa = (id: string | null, nome: string | null) => (id && nome ? { id, name: nome } : null);

const contaNaoEncontrada = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Conta do Google Ads não encontrada nesta empresa.');
const desligada = () =>
  new AppProblem(409, 'conversoes-desligadas', 'A função não está ligada', 'Informar as vendas ao Google ainda não está ligado para esta empresa. Quem liga é a Liame, a pedido do dono.');
const semPermissao = (detalhe: string) => new AppProblem(409, 'google-sem-permissao', 'Autorize o Google de novo', detalhe);

function quemPede(auth: AuthContext): Quem {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return { tenantId: auth.tenantId, userId: auth.userId };
}

/**
 * A situação da conta, do que mais pesa ao que menos, na ordem em que a rotina confere antes de enviar: a parada, a
 * autorização, o destino e, por fim, como foi a última passagem.
 */
export function situacaoDaConta(c: { parada: boolean; autorizada: boolean; temDestino: boolean; parado: boolean; falha: TipoDaFalha | null }): string {
  if (c.parada) return 'equipe_parada';
  if (!c.autorizada) return 'sem_permissao';
  if (!c.temDestino) return 'sem_destino';
  if (c.parado) return 'parado';
  if (c.falha === 'permissao') return 'sem_permissao';
  // A falha "parada" de uma passagem antiga não vale mais: a parada é conferida agora, acima.
  return c.falha === 'esperar' || c.falha === 'outro' ? 'esperando_a_plataforma' : 'informando';
}

@Injectable()
export class ConversoesService {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly flags: FlagService,
    private readonly switches: KillSwitchService,
    private readonly vault: VaultService,
  ) {}

  /** A situação de cada conta do Google Ads da marca. Com a função desligada para a empresa, nenhuma conta. */
  async ver(auth: AuthContext, brandId: string): Promise<GoogleConversionsResponse> {
    const quem = quemPede(auth);
    const tx = currentTx();
    const marca = await tx.execute(sql`select 1 from liame.brand where id = ${brandId} and archived_at is null`);
    if (!marca.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    const base = { brand_id: brandId, can_manage: auth.permissions.has('contas.conectar'), wait_minutes: ESPERA_ANTES_DE_INFORMAR_MIN, window_days: JANELA_DAS_CONTAGENS_DIAS };
    if (!(await this.ligada(quem, brandId))) return { ...base, enabled: false, accounts: [] };

    const r = await tx.execute<LinhaDaConta>(sql`
      select a.id, a.name, a.external_id,
             coalesce(${ESCOPO_DATA_MANAGER} = any(c.scopes), false) as authorized,
             d.conversion_action_id, d.conversion_action_name, d.starts_at, d.stopped_at,
             d.set_by, quem.name as setter, d.stopped_by, parou.name as stopper,
             d.last_run_at, d.next_run_at, d.last_error, d.last_error_kind,
             coalesce(n.informed, 0)::int as informed, coalesce(n.queued, 0)::int as queued,
             coalesce(n.corrected, 0)::int as corrected, coalesce(n.refused, 0)::int as refused,
             coalesce(n.recent_refused, 0)::int as recent_refused, coalesce(n.recent_answered, 0)::int as recent_answered,
             rec.at as refusal_at, rec.reason as refusal_reason
        from liame.connected_account a
        left join liame.oauth_connection c on c.id = a.connection_id
        left join liame.conversion_destination d on d.connected_account_id = a.id
        left join liame.app_user quem on quem.id = d.set_by
        left join liame.app_user parou on parou.id = d.stopped_by
        left join lateral (
          select count(*) filter (where x.status in ('enviado', 'aceito')) as informed,
                 count(*) filter (where x.status = 'pendente') as queued,
                 count(*) filter (where x.corrections > 0) as corrected,
                 count(*) filter (where x.status = 'recusado') as refused,
                 -- As que tiveram resposta do Google nos últimos dias (aceitas ou recusadas), para a regra de "está recusando".
                 count(*) filter (where x.status = 'recusado' and x.updated_at >= now() - make_interval(days => ${JANELA_DAS_RECUSAS_DIAS})) as recent_refused,
                 count(*) filter (where x.status in ('aceito', 'recusado') and x.updated_at >= now() - make_interval(days => ${JANELA_DAS_RECUSAS_DIAS})) as recent_answered
            from liame.conversion_upload x
           where x.connected_account_id = a.id and x.created_at >= now() - make_interval(days => ${JANELA_DAS_CONTAGENS_DIAS})) n on true
        left join lateral (
          select x.updated_at as at, x.last_error as reason
            from liame.conversion_upload x
           where x.connected_account_id = a.id and x.status = 'recusado' and x.last_error is not null
             and x.created_at >= now() - make_interval(days => ${JANELA_DAS_CONTAGENS_DIAS})
           order by x.updated_at desc, x.id desc
           limit 1) rec on true
       where a.brand_id = ${brandId} and a.provider = 'google_ads' and a.disconnected_at is null
       order by lower(a.name), a.id
       limit 50`);

    const accounts: GoogleConversionAccount[] = [];
    for (const l of r.rows) {
      const temDestino = l.conversion_action_id !== null;
      const parado = l.stopped_at !== null;
      const trava = await this.switches.check(tx, { tenantId: quem.tenantId, provider: 'google_ads', brandId, accountId: l.id });
      const desde = trava ? await tx.execute<{ activated_at: Date | string }>(sql`select activated_at from liame.kill_switch where id = ${trava.id}`) : null;
      // Os pedidos confirmados que ainda vão entrar na fila (não completaram o prazo, ou a rotina ainda não passou).
      let aCaminho = 0;
      if (temDestino && !parado) {
        const inicio = Math.max(new Date(l.starts_at!).getTime(), Date.now() - JANELA_DAS_CONTAGENS_DIAS * DIA_MS);
        const n = await tx.execute<{ n: number }>(
          sql`select count(*)::int as n ${pedidosAInformar({ tenant_id: quem.tenantId, brand_id: brandId, connected_account_id: l.id }, { desde: new Date(inicio).toISOString(), ate: null })}`,
        );
        aCaminho = n.rows[0]?.n ?? 0;
      }
      const status = situacaoDaConta({ parada: trava !== null, autorizada: l.authorized, temDestino, parado, falha: l.last_error_kind });
      const falhou = temDestino && !parado && l.last_error !== null && l.last_error_kind !== null && l.last_error_kind !== 'parada';
      accounts.push({
        connected_account_id: l.id,
        name: l.name,
        external_id: l.external_id,
        authorized: l.authorized,
        destination: temDestino
          ? {
              conversion_action_id: l.conversion_action_id!,
              conversion_action_name: l.conversion_action_name!,
              starts_at: iso(l.starts_at!),
              stopped_at: ou(l.stopped_at),
              stopped_by: parado ? pessoa(l.stopped_by, l.stopper) : null,
              set_by: pessoa(l.set_by, l.setter),
            }
          : null,
        status,
        team_stopped_at: desde?.rows[0] ? iso(desde.rows[0].activated_at) : null,
        counts: { informed: l.informed, waiting: parado ? 0 : l.queued + aCaminho, corrected: l.corrected, refused: l.refused },
        last_run_at: ou(l.last_run_at),
        next_run_at: temDestino && !parado ? ou(l.next_run_at) : null,
        last_failure: falhou && l.last_run_at ? { at: iso(l.last_run_at), reason: l.last_error!, kind: l.last_error_kind! } : null,
        last_refusal: l.refusal_at && l.refusal_reason ? { at: iso(l.refusal_at), reason: l.refusal_reason } : null,
        refusing:
          temDestino && !parado && estaRecusando(l.recent_refused, l.recent_answered)
            ? { days: JANELA_DAS_RECUSAS_DIAS, refused: l.recent_refused, answered: l.recent_answered }
            : null,
      });
    }
    return { ...base, enabled: true, accounts };
  }

  /** As conversões ativas da conta que recebem venda por clique, lidas do Google agora. Fora da transação da requisição. */
  async acoes(auth: AuthContext, contaId: string): Promise<GoogleConversionActionsResponse> {
    const quem = quemPede(auth);
    const conta = await naTransacaoDaEmpresa(this.banco(), quem, () => this.contaParaMexer(quem, contaId));
    const items = await this.lerAcoes(conta);
    return { connected_account_id: contaId, items };
  }

  /**
   * Escolhe (ou troca) a conversão que recebe as vendas da conta, ou volta a informar depois de uma parada. Só entram
   * os pedidos confirmados a partir de agora. A conversão é conferida no Google antes de gravar: o id não é aceito de
   * olhos fechados. Fora da transação da requisição; a gravação e o evento de auditoria entram juntos.
   */
  async definir(auth: AuthContext, body: SetGoogleConversionDestinationRequest): Promise<GoogleConversionsResponse> {
    const quem = quemPede(auth);
    const database = this.banco();
    const conta = await naTransacaoDaEmpresa(database, quem, () => this.contaParaMexer(quem, body.connected_account_id));
    const escolhida = (await this.lerAcoes(conta)).find((a) => a.id === body.conversion_action_id);
    if (!escolhida) {
      throw new AppProblem(
        422,
        'conversao-nao-encontrada',
        'Conversão não encontrada',
        'Esta conversão não está entre as que recebem vendas importadas nesta conta. Leia a lista de novo e escolha outra.',
        {},
        [{ path: 'conversion_action_id', message: 'Conversão não encontrada nesta conta.' }],
      );
    }
    return naTransacaoDaEmpresa(database, quem, async () => {
      const tx = currentTx();
      // A conta pode ter sido desligada enquanto o Google respondia.
      const ainda = await tx.execute(sql`select 1 from liame.connected_account where id = ${conta.id} and provider = 'google_ads' and disconnected_at is null`);
      if (!ainda.rows[0]) throw contaNaoEncontrada();
      const lida = await tx.execute<{ conversion_action_id: string; stopped_at: Date | string | null }>(
        sql`select conversion_action_id, stopped_at from liame.conversion_destination where connected_account_id = ${conta.id} for update`,
      );
      const antes = lida.rows[0] ?? null;
      const trocou = antes !== null && antes.conversion_action_id !== escolhida.id;
      await tx.execute(sql`
        insert into liame.conversion_destination (connected_account_id, tenant_id, brand_id, conversion_action_id, conversion_action_name, starts_at, set_by, next_run_at)
        values (${conta.id}, ${quem.tenantId}, ${conta.brand_id}, ${escolhida.id}, ${escolhida.name}, now(), ${quem.userId}, now())
        on conflict (connected_account_id) do update
           set conversion_action_name = excluded.conversion_action_name,
               -- Trocar a conversão, ou voltar depois de parar, recomeça de agora: não há carga do passado. Confirmar a
               -- mesma conversão, com ela informando, não muda o começo nem quem escolheu.
               starts_at = case when liame.conversion_destination.conversion_action_id = excluded.conversion_action_id and liame.conversion_destination.stopped_at is null
                                then liame.conversion_destination.starts_at else now() end,
               set_by = case when liame.conversion_destination.conversion_action_id = excluded.conversion_action_id and liame.conversion_destination.stopped_at is null
                             then liame.conversion_destination.set_by else excluded.set_by end,
               conversion_action_id = excluded.conversion_action_id,
               stopped_at = null, stopped_by = null, next_run_at = now(), last_error = null, last_error_kind = null, failures = 0, updated_at = now()`);
      // O que esperava a vez para a conversão antiga não vai para a nova.
      if (trocou) {
        await tx.execute(sql`
          update liame.conversion_upload set status = 'desistiu', last_error = 'a conversão da conta foi trocada', updated_at = now()
           where connected_account_id = ${conta.id} and status = 'pendente'`);
      }
      await writeAudit(tx, {
        tenantId: quem.tenantId,
        actorType: 'human',
        actorId: quem.userId,
        actorLabel: actorLabel(auth),
        actorRole: auth.roleKey,
        action: ACAO_DEFINIR,
        resourceType: RECURSO,
        resourceId: conta.id,
        before: antes ? { conversion_action_id: antes.conversion_action_id, parado: antes.stopped_at !== null } : null,
        after: { conversion_action_id: escolhida.id, conversion_action_name: escolhida.name },
        traceId: activeTraceId(),
        origin: 'api',
      });
      return this.ver(auth, conta.brand_id);
    });
  }

  /**
   * Para de informar as vendas da conta: nada novo sai, e o que esperava a vez não sai. O que já foi informado continua
   * no Google. Vale também com a função desligada para a empresa (parar nunca depende de nada). Na transação da rota.
   */
  async parar(auth: AuthContext, body: StopGoogleConversionDestinationRequest): Promise<GoogleConversionsResponse> {
    const quem = quemPede(auth);
    const tx = currentTx();
    const r = await tx.execute<{ brand_id: string; stopped_at: Date | string | null }>(sql`
      select d.brand_id, d.stopped_at
        from liame.conversion_destination d
        join liame.connected_account a on a.id = d.connected_account_id and a.provider = 'google_ads'
       where d.connected_account_id = ${body.connected_account_id}
         for update of d`);
    const destino = r.rows[0];
    if (!destino) throw contaNaoEncontrada();
    if (destino.stopped_at === null) {
      await tx.execute(sql`
        update liame.conversion_destination set stopped_at = now(), stopped_by = ${quem.userId}, updated_at = now() where connected_account_id = ${body.connected_account_id}`);
      await tx.execute(sql`
        update liame.conversion_upload set status = 'desistiu', last_error = 'parado por uma pessoa antes do envio', updated_at = now()
         where connected_account_id = ${body.connected_account_id} and status = 'pendente'`);
    }
    auditDetail({ resourceId: body.connected_account_id, before: { parado: destino.stopped_at !== null }, after: { parado: true } });
    return this.ver(auth, destino.brand_id);
  }

  private banco(): Database {
    if (!this.database) throw new Error('conversões para o Google: sem banco');
    return this.database;
  }

  private ligada(quem: Quem, brandId: string): Promise<boolean> {
    return this.flags.isEnabled(FLAG_CONVERSOES_GOOGLE, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId }));
  }

  /**
   * A parte do banco de ler as conversões e de escolher o destino: a conta do Google Ads da empresa, com a função
   * ligada e a autorização que inclui o envio. Roda numa transação curta da empresa (`currentTx()`).
   */
  private async contaParaMexer(quem: Quem, contaId: string): Promise<ContaPronta> {
    const tx = currentTx();
    const r = await tx.execute<Omit<ContaPronta, 'refreshToken'> & { credential_secret_id: string | null }>(sql`
      select a.id, a.brand_id, a.external_id, a.timezone, a.currency, a.provider_attributes->>'login_customer_id' as login_customer_id, a.credential_secret_id
        from liame.connected_account a
       where a.id = ${contaId} and a.provider = 'google_ads' and a.disconnected_at is null`);
    const conta = r.rows[0];
    if (!conta) throw contaNaoEncontrada();
    if (!(await this.ligada(quem, conta.brand_id))) throw desligada();
    const segredo = conta.credential_secret_id ? await this.vault.readSecret(tx, conta.credential_secret_id) : null;
    const credencial = segredo ? (JSON.parse(segredo) as CredencialGuardada) : null;
    if (credencial?.tipo !== 'google' || !credencial.escopos.includes(ESCOPO_DATA_MANAGER)) {
      throw semPermissao('A autorização do Google desta conta não inclui a permissão de informar vendas. Autorize o Google de novo em Contas conectadas: as contas ligadas continuam como estão.');
    }
    const { credential_secret_id: _segredo, ...resto } = conta;
    return { ...resto, refreshToken: credencial.refresh_token };
  }

  /** A leitura no Google, sem transação aberta. Cada falha vira um problema que a pessoa entende. */
  private async lerAcoes(conta: ContaPronta): Promise<AcaoDeConversao[]> {
    const database = this.banco();
    // Uma tentativa: há uma pessoa esperando a lista, e ela tenta de novo pelo botão.
    const cliente = new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas), tentativas: 1, tempoLimiteMs: TEMPO_DO_GOOGLE_MS });
    try {
      const accessToken = await acessoGoogle(this.config, this.config.oauth.google?.tokenUrl ?? '', conta.refreshToken);
      const conector = await criarConectorGoogleAds(database.db, cliente, this.config.plataformas);
      return await conector.lerAcoesDeConversao({
        credencial: { accessToken },
        externalId: conta.external_id,
        timezone: conta.timezone,
        currency: conta.currency,
        loginCustomerId: conta.login_customer_id,
      });
    } catch (err) {
      if (!(err instanceof ErroConector)) throw err;
      if (err.tipo === 'autenticacao' || err.tipo === 'permissao') {
        throw semPermissao('O Google recusou a leitura das conversões desta conta (a autorização foi revogada, venceu ou não alcança a conta). Autorize o Google de novo em Contas conectadas.');
      }
      if (err.tipo === 'definitivo') {
        throw new AppProblem(422, 'plataforma-recusou', 'O Google recusou a leitura', 'O Google não deixou ler as conversões desta conta. Nada mudou.');
      }
      // Limite de uso, fora do ar ou muitas falhas seguidas: é tentar de novo daqui a pouco.
      throw new AppProblem(502, 'plataforma-indisponivel', 'O Google não respondeu', 'Não foi possível ler as conversões desta conta agora. Nada mudou; tente de novo em instantes.');
    }
  }
}
