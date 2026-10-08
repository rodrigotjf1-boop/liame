import { type Db, uuidv7, withTenant } from '@liame/database';
import { Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { MODELO_PADRAO } from '../attribution/motor.js';
import type { AppConfig } from '../config.js';
import { acessoGoogle, type CredencialGuardada } from '../connections/oauth.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import {
  CAPACIDADE_CONVERSOES,
  type CliqueGoogle,
  type DestinoGoogle,
  ESCOPO_DATA_MANAGER,
  ingerirVenda,
  lerResultado,
  motivoDoErro,
  type TipoDeClique,
} from '../connectors/google-ads/data-manager.js';
import { versaoRegistrada } from '../connectors/tipos.js';
import { soDigitos } from '../connectors/validacao.js';
import type { FlagService } from '../flags/flag.service.js';
import type { KillSwitchService } from '../kill-switch/kill-switch.service.js';
import type { VaultService } from '../vault/vault.service.js';

// Conversões para o Google (A5, Y1; `plano-a5.md` D-A5-5 a D-A5-8 e o ajuste da D-A5-7). A venda confirmada no caixa
// que o Liame atribui a um anúncio do Google (a mesma que aparece em Resultados) é informada ao Google, pelo clique
// que venceu a atribuição, para a ação de conversão que uma pessoa da empresa escolheu.
//
// Uma passagem por conta do Google Ads: (1) entram na fila os pedidos confirmados há pelo menos duas horas; (2) o que
// foi cancelado antes de sair deixa a fila; (3) cada pedido é validado (`validateOnly`) e só então enviado, um por
// pedido de envio; (4) o resultado de cada envio é lido depois; (5) o pedido que mudou de valor depois de informado
// (cancelado: zero; devolução: o que ficou) tem o valor corrigido, porque a Data Manager API não retira conversão.
// As chamadas ao Google acontecem fora de transação; cada mudança de situação é uma transação curta da empresa.

export const FLAG_CONVERSOES_GOOGLE = 'conversoes_google';
/** A conta volta para a fila uma vez por hora. */
export const INTERVALO_CONVERSOES_MIN = 60;
/** O pedido só é informado depois disto: o que for cancelado no intervalo nunca sai do Liame (ajuste da D-A5-7). */
export const ESPERA_ANTES_DE_INFORMAR_MIN = 120;
/** O Google não importa a venda de um clique mais velho que isto (base de conhecimento §3.2). */
export const CLIQUE_MAX_DIAS = 90;
/**
 * Teto de pedidos por passagem. Cada pedido são duas chamadas (a validação e o envio) e depois uma leitura do
 * resultado, e a conta tem uma cota local de chamadas: a fila maior que isto termina nas passagens seguintes, que
 * então vêm logo (`COM_FILA_MIN`), sem prender o worker.
 */
const POR_PASSAGEM = 20;
/** Com a fila cheia, a conta volta em poucos minutos, e não na hora seguinte. */
const COM_FILA_MIN = 5;
/** Depois de tantas falhas passageiras, o pedido fecha como recusado, com o motivo. */
export const TENTATIVAS_DO_ENVIO = 5;
const MIN_MS = 60_000;
const DIA_MS = 86_400_000;

export type ResultadoConversoes = {
  status: 'ok' | 'ignorada' | 'parada' | 'sem_permissao' | 'falhou';
  /** Pedidos que entraram na fila, saíram dela sem envio, foram enviados, aceitos, recusados e corrigidos nesta passagem. */
  novos: number;
  desistiu: number;
  enviados: number;
  aceitos: number;
  recusados: number;
  corrigidos: number;
  erro?: string;
};

type LinhaDestino = {
  connected_account_id: string;
  tenant_id: string;
  brand_id: string;
  external_id: string;
  login_customer_id: string | null;
  credential_secret_id: string | null;
  conversion_action_id: string;
  starts_at: Date | string;
  failures: number;
};

type LinhaEnvio = {
  id: string;
  order_id: string;
  status: string;
  value_micros: string;
  currency: string;
  event_at: Date | string;
  attempts: number;
  request_id: string | null;
  conversion_action_id: string;
  correction_status: string | null;
  correction_value_micros: string | null;
  correction_request_id: string | null;
  gclid: string | null;
  gbraid: string | null;
  wbraid: string | null;
  touch_at: Date | string | null;
};

/**
 * O tipo da última falha da passagem, guardado ao lado do texto (migration 0056): a tela separa "o Google pediu para
 * esperar" (a conta volta sozinha) de "falta a permissão" (é autorizar o Google de novo) sem adivinhar pelo texto.
 */
export type TipoDaFalha = 'esperar' | 'permissao' | 'parada' | 'outro';
type Falha = { texto: string; tipo: TipoDaFalha };

const vazio = (status: ResultadoConversoes['status'], erro?: string): ResultadoConversoes => ({ status, novos: 0, desistiu: 0, enviados: 0, aceitos: 0, recusados: 0, corrigidos: 0, ...(erro ? { erro } : {}) });

/**
 * Os pedidos que o Liame atribui ao Google para uma conta e que ainda não entraram na fila dela: a mesma regra na
 * rotina (que os põe na fila) e na tela (que conta os que esperam). É o pedido confirmado, com o clique que venceu a
 * atribuição (o mesmo da tela de Resultados). Com a campanha conhecida, vai para a conta dela; só com a plataforma,
 * vai para esta conta se ela é a única do Google com destino na marca. `ate` nulo: sem esperar as duas horas.
 */
export function pedidosAInformar(d: { tenant_id: string; brand_id: string; connected_account_id: string }, janela: { desde: string; ate: string | null }): SQL {
  return sql`
      from liame.order_fact o
      join liame.attribution_result r on r.order_id = o.id and r.model_id = ${MODELO_PADRAO} and r.counted and r.provider = 'google_ads' and r.touchpoint_id is not null
      join liame.touchpoint t on t.id = r.touchpoint_id and coalesce(t.gclid, t.gbraid, t.wbraid) is not null
      left join liame.campaign c on c.id = r.campaign_id
     where o.tenant_id = ${d.tenant_id} and o.brand_id = ${d.brand_id} and o.status = 'confirmado'
       and o.confirmed_at >= ${janela.desde}::timestamptz ${janela.ate === null ? sql`` : sql`and o.confirmed_at <= ${janela.ate}::timestamptz`}
       and (c.connected_account_id = ${d.connected_account_id}
            or (c.id is null and not exists (
                  select 1 from liame.conversion_destination x
                   where x.brand_id = ${d.brand_id} and x.stopped_at is null and x.connected_account_id <> ${d.connected_account_id})))
       and not exists (select 1 from liame.conversion_upload u where u.order_id = o.id and u.connected_account_id = ${d.connected_account_id})`;
}

/** O clique que vai no evento: um só, na ordem que o Google recomenda (o gclid primeiro). */
export function cliqueDoEnvio(l: Pick<LinhaEnvio, 'gclid' | 'gbraid' | 'wbraid'>): CliqueGoogle | null {
  const ordem: TipoDeClique[] = ['gclid', 'gbraid', 'wbraid'];
  for (const tipo of ordem) {
    const valor = l[tipo];
    if (valor) return { tipo, valor };
  }
  return null;
}

/** A falha que manda a passagem parar e voltar depois (a plataforma pediu para esperar, ou está fora do ar). */
const passageira = (e: ErroConector): boolean => e.tipo === 'limite' || e.tipo === 'transitorio' || e.tipo === 'circuito_aberto';

export class ConversoesGoogle {
  private readonly logger = new Logger('conversoes-google');

  constructor(
    private readonly db: Db,
    private readonly vault: VaultService,
    private readonly config: AppConfig,
    private readonly flags: FlagService,
    private readonly switches: KillSwitchService,
  ) {}

  /** Uma passagem pela conta: fila, envio, leitura dos resultados e correções. Marca quando a conta volta para a fila. */
  async executar(contaId: string, tenantId: string, agora: Date = new Date()): Promise<ResultadoConversoes> {
    const lida = await withTenant(this.db, tenantId, async (tx) => {
      const r = await tx.execute<LinhaDestino>(sql`
        select d.connected_account_id, d.tenant_id, d.brand_id, a.external_id,
               a.provider_attributes->>'login_customer_id' as login_customer_id, a.credential_secret_id,
               d.conversion_action_id, d.starts_at, d.failures
          from liame.conversion_destination d
          join liame.connected_account a on a.id = d.connected_account_id
         where d.connected_account_id = ${contaId} and d.stopped_at is null
           and a.provider = 'google_ads' and a.disconnected_at is null`);
      const destino = r.rows[0];
      if (!destino) return null;
      const trava = await this.switches.check(tx, { tenantId, provider: 'google_ads', brandId: destino.brand_id, accountId: destino.connected_account_id });
      const segredo = destino.credential_secret_id ? await this.vault.readSecret(tx, destino.credential_secret_id) : null;
      return { destino, trava, segredo };
    });
    if (!lida) return vazio('ignorada');
    const { destino } = lida;

    // A flag da empresa e a parada valem mais que a fila: com uma delas, nada sai e nada entra.
    if (!(await this.flags.isEnabled(FLAG_CONVERSOES_GOOGLE, this.flags.context({ tenantId, brandId: destino.brand_id })))) {
      await this.marcar(destino, agora, null, INTERVALO_CONVERSOES_MIN, false);
      return vazio('ignorada');
    }
    if (lida.trava) {
      await this.marcar(destino, agora, { texto: 'parada: a empresa ou a Liame parou as ações desta conta', tipo: 'parada' }, INTERVALO_CONVERSOES_MIN, false);
      return vazio('parada');
    }
    const credencial = lida.segredo ? (JSON.parse(lida.segredo) as CredencialGuardada) : null;
    if (credencial?.tipo !== 'google') {
      await this.marcar(destino, agora, { texto: 'sem_autorizacao: a conta do Google não está autorizada', tipo: 'permissao' }, 24 * 60, false);
      return vazio('sem_permissao', 'sem autorização do Google');
    }
    if (!credencial.escopos.includes(ESCOPO_DATA_MANAGER)) {
      await this.marcar(destino, agora, { texto: 'sem_permissao: a autorização do Google não inclui o envio de conversões; conecte o Google de novo', tipo: 'permissao' }, 24 * 60, false);
      return vazio('sem_permissao', 'a autorização não inclui o envio de conversões');
    }
    if (!soDigitos(destino.external_id)) {
      await this.marcar(destino, agora, { texto: 'conta_invalida: o id da conta do Google Ads não é numérico', tipo: 'outro' }, 24 * 60, false);
      return vazio('falhou', 'id da conta inválido');
    }

    const resultado = vazio('ok');
    let filaCheia = false;
    const fila = await this.prepararFila(destino, agora);
    resultado.novos = fila.novos;
    resultado.desistiu = fila.desistiu;

    const cliente = new ClienteConector(this.db, { enderecos: enderecosDasPlataformas(this.config.plataformas) });
    const alvo: DestinoGoogle = {
      customerId: destino.external_id,
      loginCustomerId: soDigitos(destino.login_customer_id) ? destino.login_customer_id : null,
      conversionActionId: destino.conversion_action_id,
    };
    try {
      const versao = await versaoRegistrada(this.db, 'google_ads', CAPACIDADE_CONVERSOES);
      const accessToken = await acessoGoogle(this.config, this.config.oauth.google?.tokenUrl ?? '', credencial.refresh_token);
      const acesso = { baseUrl: this.config.plataformas.dataManagerUrl, versao, accessToken };

      // O resultado do que já saiu, antes de mandar mais.
      for (const l of await this.lerFila(destino, sql`u.status = 'enviado' and u.request_id is not null`)) {
        const r = await lerResultado(cliente, { ...acesso, customerId: alvo.customerId, requestId: l.request_id! });
        if (r.situacao === 'processando') {
          await this.atualizar(destino, l.id, sql`checked_at = now()`);
        } else if (r.situacao === 'aceito') {
          await this.atualizar(destino, l.id, sql`status = 'aceito', checked_at = now(), last_error = ${r.motivo}`);
          resultado.aceitos += 1;
        } else {
          await this.atualizar(destino, l.id, sql`status = 'recusado', checked_at = now(), last_error = ${r.motivo}`);
          resultado.recusados += 1;
        }
      }

      // O que espera a vez: valida e, passando, envia.
      const pendentes = await this.lerFila(destino, sql`u.status = 'pendente'`);
      filaCheia = pendentes.length >= POR_PASSAGEM;
      for (const l of pendentes) {
        const clique = this.cliqueValido(l, agora);
        if (typeof clique === 'string') {
          await this.atualizar(destino, l.id, sql`status = 'desistiu', last_error = ${clique}`);
          resultado.desistiu += 1;
          continue;
        }
        const evento = { transactionId: l.order_id, eventTimestamp: new Date(l.event_at).toISOString(), clique, valorMicros: BigInt(l.value_micros), moeda: l.currency };
        try {
          await ingerirVenda(cliente, { ...acesso, destino: { ...alvo, conversionActionId: l.conversion_action_id }, evento, validateOnly: true });
          const enviado = await ingerirVenda(cliente, { ...acesso, destino: { ...alvo, conversionActionId: l.conversion_action_id }, evento, validateOnly: false });
          await this.atualizar(destino, l.id, sql`status = 'enviado', request_id = ${enviado.requestId}, sent_at = now(), attempts = attempts + 1, last_error = null`);
          resultado.enviados += 1;
        } catch (err) {
          if (!(err instanceof ErroConector)) throw err;
          if (err.tipo === 'definitivo') {
            // O Google recusou este pedido (na validação ou no envio): não adianta repetir.
            await this.atualizar(destino, l.id, sql`status = 'recusado', attempts = attempts + 1, last_error = ${motivoDoErro(err)}`);
            resultado.recusados += 1;
            continue;
          }
          if (passageira(err) && l.attempts + 1 >= TENTATIVAS_DO_ENVIO) {
            await this.atualizar(destino, l.id, sql`status = 'recusado', attempts = attempts + 1, last_error = ${motivoDoErro(err)}`);
            resultado.recusados += 1;
          } else {
            await this.atualizar(destino, l.id, sql`attempts = attempts + 1, last_error = ${motivoDoErro(err)}`);
          }
          // Limite, fora do ar, token ou permissão: a passagem para aqui e a conta volta depois.
          throw err;
        }
      }

      // As correções de valor: primeiro o resultado das que já saíram, depois as que esperam.
      for (const l of await this.lerFila(destino, sql`u.correction_status = 'enviado' and u.correction_request_id is not null`)) {
        const r = await lerResultado(cliente, { ...acesso, customerId: alvo.customerId, requestId: l.correction_request_id! });
        if (r.situacao === 'processando') continue;
        if (r.situacao === 'aceito') {
          await this.atualizar(
            destino,
            l.id,
            sql`value_micros = correction_value_micros, corrections = corrections + 1, correction_status = null, correction_value_micros = null, correction_request_id = null, checked_at = now()`,
          );
          resultado.corrigidos += 1;
        } else {
          await this.atualizar(destino, l.id, sql`correction_status = 'recusado', last_error = ${r.motivo}, checked_at = now()`);
        }
      }
      for (const l of await this.lerFila(destino, sql`u.correction_status = 'pendente'`)) {
        const clique = this.cliqueValido(l, agora);
        if (typeof clique === 'string') {
          // Sem o id do clique o Google não aceita o evento: a correção não tem como sair.
          await this.atualizar(destino, l.id, sql`correction_status = 'recusado', last_error = ${clique}`);
          continue;
        }
        const evento = { transactionId: l.order_id, eventTimestamp: new Date(l.event_at).toISOString(), clique, valorMicros: BigInt(l.correction_value_micros!), moeda: l.currency };
        try {
          await ingerirVenda(cliente, { ...acesso, destino: { ...alvo, conversionActionId: l.conversion_action_id }, evento, validateOnly: true });
          const enviado = await ingerirVenda(cliente, { ...acesso, destino: { ...alvo, conversionActionId: l.conversion_action_id }, evento, validateOnly: false });
          await this.atualizar(destino, l.id, sql`correction_status = 'enviado', correction_request_id = ${enviado.requestId}, correction_sent_at = now()`);
        } catch (err) {
          if (!(err instanceof ErroConector)) throw err;
          if (err.tipo === 'definitivo') {
            await this.atualizar(destino, l.id, sql`correction_status = 'recusado', last_error = ${motivoDoErro(err)}`);
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      const e = err instanceof ErroConector ? err : null;
      const texto = e ? motivoDoErro(e) : 'erro interno';
      if (e) this.logger.warn(`conta ${destino.connected_account_id}: ${e.tipo}: ${e.message}`);
      else this.logger.error(`conta ${destino.connected_account_id}: ${err instanceof Error ? err.message : String(err)}`);
      const falhas = destino.failures + 1;
      const semAcesso = e !== null && (e.tipo === 'permissao' || e.tipo === 'autenticacao');
      // Sem permissão ou token recusado: um dia; o resto, o que a plataforma pediu ou 30 minutos dobrando até 12 horas.
      const esperaMs = semAcesso ? DIA_MS : e?.esperarMs && e.esperarMs > 0 ? e.esperarMs : Math.min(30 * MIN_MS * 2 ** (falhas - 1), 12 * 60 * MIN_MS);
      await this.marcar(destino, agora, { texto, tipo: semAcesso ? 'permissao' : e && passageira(e) ? 'esperar' : 'outro' }, Math.ceil(esperaMs / MIN_MS), true);
      return { ...resultado, status: semAcesso ? 'sem_permissao' : 'falhou', erro: texto };
    }
    await this.marcar(destino, agora, null, filaCheia ? COM_FILA_MIN : INTERVALO_CONVERSOES_MIN, false, true);
    return resultado;
  }

  /**
   * Põe na fila os pedidos novos, tira dela o que foi cancelado antes de sair e abre a correção do que mudou de valor
   * depois de informado. Tudo numa transação da empresa.
   */
  private async prepararFila(d: LinhaDestino, agora: Date): Promise<{ novos: number; desistiu: number }> {
    const ate = new Date(agora.getTime() - ESPERA_ANTES_DE_INFORMAR_MIN * MIN_MS).toISOString();
    return withTenant(this.db, d.tenant_id, async (tx) => {
      // O pedido que o Liame atribui ao Google, confirmado desde o começo do destino e há pelo menos duas horas.
      const candidatos = await tx.execute<{ id: string; liquido: string; currency: string; confirmed_at: Date | string; touchpoint_id: string; tipo: TipoDeClique }>(sql`
        select o.id, (o.revenue_micros - o.refunded_micros)::text as liquido, o.currency, o.confirmed_at, r.touchpoint_id,
               case when t.gclid is not null then 'gclid' when t.gbraid is not null then 'gbraid' else 'wbraid' end as tipo
        ${pedidosAInformar(d, { desde: new Date(d.starts_at).toISOString(), ate })}
         order by o.confirmed_at, o.id
         limit ${POR_PASSAGEM}`);
      let novos = 0;
      for (const p of candidatos.rows) {
        const r = await tx.execute(sql`
          insert into liame.conversion_upload (id, tenant_id, brand_id, order_id, connected_account_id, conversion_action_id, touchpoint_id, click_kind, status, value_micros, currency, event_at)
          values (${uuidv7()}, ${d.tenant_id}, ${d.brand_id}, ${p.id}, ${d.connected_account_id}, ${d.conversion_action_id}, ${p.touchpoint_id}, ${p.tipo}, 'pendente',
                  ${p.liquido}::bigint, ${p.currency}, ${new Date(p.confirmed_at).toISOString()}::timestamptz)
          on conflict (order_id, connected_account_id) do nothing`);
        novos += r.rowCount ?? 0;
      }
      // Cancelado antes de sair: nunca é informado.
      const desistiu = await tx.execute(sql`
        update liame.conversion_upload u
           set status = 'desistiu', last_error = 'cancelado antes do envio', updated_at = now()
          from liame.order_fact o
         where o.id = u.order_id and u.connected_account_id = ${d.connected_account_id} and u.status = 'pendente' and o.status = 'cancelado'`);
      // Aceito pelo Google e o valor mudou (cancelado: zero; devolução: o que ficou): abre a correção, uma de cada vez.
      // Só depois do aceite: a correção não pode chegar ao Google antes do evento que ela corrige. A correção recusada
      // só reabre se o valor certo mudou de novo.
      await tx.execute(sql`
        update liame.conversion_upload u
           set correction_status = 'pendente',
               correction_value_micros = case when o.status = 'cancelado' then 0 else o.revenue_micros - o.refunded_micros end,
               correction_request_id = null, correction_sent_at = null, updated_at = now()
          from liame.order_fact o
         where o.id = u.order_id and u.connected_account_id = ${d.connected_account_id} and u.status = 'aceito'
           and (u.correction_status is null or u.correction_status = 'recusado')
           and u.value_micros <> case when o.status = 'cancelado' then 0 else o.revenue_micros - o.refunded_micros end
           and (u.correction_status is null
                or u.correction_value_micros <> case when o.status = 'cancelado' then 0 else o.revenue_micros - o.refunded_micros end)`);
      return { novos, desistiu: desistiu.rowCount ?? 0 };
    });
  }

  /** As linhas da conta que atendem à condição, com o id do clique lido do ponto de contato (que pode já ter saído). */
  private async lerFila(d: LinhaDestino, condicao: SQL): Promise<LinhaEnvio[]> {
    return withTenant(this.db, d.tenant_id, async (tx) => {
      const r = await tx.execute<LinhaEnvio>(sql`
        select u.id, u.order_id, u.status, u.value_micros::text as value_micros, u.currency, u.event_at, u.attempts, u.request_id, u.conversion_action_id,
               u.correction_status, u.correction_value_micros::text as correction_value_micros, u.correction_request_id,
               t.gclid, t.gbraid, t.wbraid, t.occurred_at as touch_at
          from liame.conversion_upload u
          left join liame.touchpoint t on t.id = u.touchpoint_id
         where u.connected_account_id = ${d.connected_account_id} and ${condicao}
         order by u.created_at, u.id
         limit ${POR_PASSAGEM}`);
      return r.rows;
    });
  }

  /** O clique do envio, ou o motivo de não haver: o ponto de contato já saiu (prazo de guarda) ou é velho demais para o Google. */
  private cliqueValido(l: LinhaEnvio, agora: Date): CliqueGoogle | string {
    const clique = cliqueDoEnvio(l);
    if (!clique || !l.touch_at) return 'o clique já não está guardado';
    if (agora.getTime() - new Date(l.touch_at).getTime() > CLIQUE_MAX_DIAS * DIA_MS) return `o clique tem mais de ${CLIQUE_MAX_DIAS} dias`;
    return clique;
  }

  private async atualizar(d: LinhaDestino, id: string, mudanca: SQL): Promise<void> {
    await withTenant(this.db, d.tenant_id, (tx) =>
      tx.execute(sql`update liame.conversion_upload set ${mudanca}, updated_at = now() where id = ${id} and connected_account_id = ${d.connected_account_id}`),
    );
  }

  /** Quando a conta volta para a fila, e como foi esta passagem. `falha` soma na conta das falhas seguidas; `ok` zera. */
  private async marcar(d: LinhaDestino, agora: Date, erro: Falha | null, emMinutos: number, falha: boolean, ok = false): Promise<void> {
    const proxima = new Date(agora.getTime() + emMinutos * MIN_MS).toISOString();
    await withTenant(this.db, d.tenant_id, (tx) =>
      tx.execute(sql`
        update liame.conversion_destination
           set next_run_at = ${proxima}::timestamptz, last_run_at = now(), last_error = ${erro ? erro.texto.slice(0, 300) : null},
               last_error_kind = ${erro ? erro.tipo : null},
               last_ok_at = case when ${ok}::boolean then now() else last_ok_at end,
               failures = case when ${falha}::boolean then failures + 1 when ${ok}::boolean then 0 else failures end,
               updated_at = now()
         where connected_account_id = ${d.connected_account_id}`),
    );
  }
}
