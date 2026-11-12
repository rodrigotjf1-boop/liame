import { type Database, type Tx, withSystem, withTenant } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { regemCupomConnector } from '../actions/regem-cupom.js';
import { motivoDoPedido } from '../actions/regemcast-mensagem.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { contaConectada } from '../connections/conectada.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { lerPedidoDeAcao, PERMISSOES_DA_ESCRITA_PELO_CLIQUE } from '../connectors/regemcast/conector-regemcast.js';
import { PEDIDO_EM_ABERTO, type SituacaoDoPedido } from '../connectors/regemcast/contrato-regemcast.js';
import { comAcessoDaConta, credencialDaConta } from '../connectors/regemcast/credencial-da-conta.js';
import { DATABASE } from '../database/database.module.js';
import { VaultService } from '../vault/vault.service.js';
import type { InboxRow } from './inbox-processor.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// O acompanhamento do pedido de envio que espera o destino (Hub DMS F5, parte D; decisões F5-5, F5-7 e F5-9). Fica na
// pasta do worker porque procura o que ler em todas as empresas, em escopo de sistema (regra `liame-escopo-sistema`).
//
// Na mensagem que a pessoa aprova no RegemCast, o Liame pediu o disparo (`campanha_disparo_pedir`) e guardou o pedido
// em `message_request.destination_*`. Esta rotina lê cada pedido aberto de tempos em tempos (`acao_pedido_ler`) e guarda
// a situação, o prazo, o link e o motivo, que a tela mostra ("esperando o destino"). O aviso assinado do RegemCast
// (`acao.alterada`, PR seguinte) só adianta a próxima leitura: a leitura é a verdade, e cobre o aviso que não chegou.
//
// Quando o pedido termina sem envio (recusado, vencido, cancelado ou falhou), o cupom que nasceu para a mensagem é
// desativado no Regem (F5-5): mensagem que não saiu não deixa cupom valendo. Executado: o cupom fica, e o envio segue no
// RegemCast. A rotina não aprova, não recusa e não cancela nada: a decisão é de uma pessoa, no destino.

/** De quanto em quanto tempo o pedido aberto é lido de novo (o aviso do destino adianta). */
export const MINUTOS_ENTRE_LEITURAS = 5;
/** Quando a leitura ou a desativação falhou de um jeito passageiro (o RegemCast ou o Regem fora do ar). */
export const MINUTOS_DEPOIS_DA_FALHA = 15;
/** Quando a conta não deixou ler (desconectada, sem a permissão): espera mais, e a tela segue com o último lido. */
export const MINUTOS_SEM_ACESSO = 60;

/** Os finais em que nada foi enviado: o cupom da mensagem não pode ficar valendo. */
export const FINAIS_SEM_ENVIO: readonly SituacaoDoPedido[] = ['recusado', 'vencido', 'cancelado', 'falhou'];

/**
 * O aviso assinado do RegemCast (`acao.alterada`, RegemCast #131; Padrão DMS §9), já conferido pela caixa de entrada com
 * o segredo da conexão: só gatilho, `{ "tipo": "acao.alterada", "id": "<pedido>" }`. O pedido do aviso, desta conexão e
 * ainda aberto, fica devido agora, e a rotina lê o pedido na próxima volta (a leitura é a verdade). O resto se ignora.
 */
export async function avisoDoRegemcast(tx: Tx, evento: InboxRow): Promise<void> {
  if (!evento.connection_id || !evento.tenant_id) return;
  let corpo: { tipo?: unknown; id?: unknown };
  try {
    corpo = JSON.parse(evento.body) as { tipo?: unknown; id?: unknown };
  } catch {
    return;
  }
  if (corpo.tipo !== 'acao.alterada' || typeof corpo.id !== 'string' || corpo.id.length > 100) return;
  await tx.execute(sql`
    update liame.message_request m
       set destination_next_check_at = now(), updated_at = now()
      from liame.connected_account a
     where m.tenant_id = ${evento.tenant_id} and m.destination_request_id = ${corpo.id}
       and m.destination_status in ${PEDIDO_EM_ABERTO}
       and a.id = m.connected_account_id and a.tenant_id = m.tenant_id and a.connection_id = ${evento.connection_id}`);
}

type Candidato = { id: string; tenant_id: string };
type Linha = {
  id: string;
  tenant_id: string;
  connected_account_id: string;
  destination_request_id: string;
  destination_status: SituacaoDoPedido;
  coupon_id: string | null;
  coupon_deactivated_at: string | Date | null;
};

export type PedidoNoDestinoLido = { tenantId: string; id: string; situacao: SituacaoDoPedido | null; cupomDesativado: boolean; problema: string | null };

@Injectable()
export class PedidosNoDestino {
  private readonly logger = new Logger('pedidos-no-destino');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
  ) {}

  /**
   * Um lote: até `limite` mensagens cujo pedido no destino está na hora de ler (aberto) ou de tratar o cupom (final sem
   * envio, com cupom ainda valendo), da mais atrasada para a mais nova. Cada uma na sua transação, sob a RLS da empresa,
   * travada (`skip locked`: duas instâncias do worker não leem a mesma); a falha de uma não para as outras. O relógio
   * injetado vale para a operação inteira (V34).
   */
  async executarLote(limite = 20, scope: JobScope = {}, agora?: Date): Promise<PedidoNoDestinoLido[]> {
    if (!this.database) return [];
    const database = this.database;
    const referencia = agora ? sql`${agora.toISOString()}::timestamptz` : sql`now()`;
    const candidatos = (
      await withSystem(database.db, (tx) =>
        tx.execute<Candidato>(sql`
          select m.id, m.tenant_id
            from liame.message_request m
           where m.destination_next_check_at <= ${referencia} ${tenantFilter(scope, sql`m.tenant_id`)}
             and (m.destination_status in ${PEDIDO_EM_ABERTO}
                  or (m.destination_status in ${FINAIS_SEM_ENVIO} and m.coupon_id is not null and m.coupon_deactivated_at is null))
           order by m.destination_next_check_at, m.id
           limit ${limite}`),
      )
    ).rows;

    const lidos: PedidoNoDestinoLido[] = [];
    for (const c of candidatos) {
      try {
        const r = await withTenant(database.db, c.tenant_id, (tx) => this.tratar(tx, c, referencia));
        if (r) lidos.push(r);
      } catch (err) {
        // Fora do previsto: a causa vai para o log, e a mensagem volta depois, sem segurar a fila (LIC-001, V6).
        this.logger.error(`mensagem ${c.id}: falha ao acompanhar o pedido no destino: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        await withSystem(database.db, (tx) =>
          tx.execute(sql`update liame.message_request set destination_next_check_at = ${referencia} + make_interval(mins => ${MINUTOS_DEPOIS_DA_FALHA}) where id = ${c.id} and tenant_id = ${c.tenant_id}`),
        );
      }
    }
    return lidos;
  }

  private async tratar(tx: Tx, c: Candidato, referencia: ReturnType<typeof sql>): Promise<PedidoNoDestinoLido | null> {
    const r = await tx.execute<Linha>(sql`
      select id, tenant_id, connected_account_id, destination_request_id, destination_status, coupon_id, coupon_deactivated_at
        from liame.message_request
       where id = ${c.id} and tenant_id = ${c.tenant_id} and destination_next_check_at <= ${referencia}
       for update skip locked`);
    const m = r.rows[0];
    if (!m) return null;
    const depois = (minutos: number) => sql`${referencia} + make_interval(mins => ${minutos})`;
    let situacao = m.destination_status;

    if (PEDIDO_EM_ABERTO.includes(situacao)) {
      const lido = await this.lerNoDestino(tx, m);
      if ('problema' in lido) {
        await tx.execute(sql`update liame.message_request set destination_next_check_at = ${depois(lido.esperar)}, updated_at = now() where id = ${m.id} and tenant_id = ${m.tenant_id}`);
        this.logger.warn(`mensagem ${m.id}: não deu para ler o pedido no destino agora (${lido.problema})`);
        return { tenantId: m.tenant_id, id: m.id, situacao, cupomDesativado: false, problema: lido.problema };
      }
      const d = lido.pedido;
      situacao = d.situacao;
      const aberto = PEDIDO_EM_ABERTO.includes(situacao);
      await tx.execute(sql`
        update liame.message_request
           set destination_status = ${d.situacao}, destination_expires_at = ${d.vence_em}::timestamptz, destination_url = ${d.tela ?? null},
               destination_reason = ${motivoDoPedido(d)}, destination_checked_at = ${referencia},
               destination_next_check_at = ${aberto ? depois(MINUTOS_ENTRE_LEITURAS) : referencia}, updated_at = now()
         where id = ${m.id} and tenant_id = ${m.tenant_id}`);
    }

    // O final sem envio: o cupom que nasceu para a mensagem é desativado no Regem (F5-5).
    let cupomDesativado = false;
    let problema: string | null = null;
    if (FINAIS_SEM_ENVIO.includes(situacao) && m.coupon_id && !m.coupon_deactivated_at) {
      const feito = await regemCupomConnector.desativarCupomDaMensagem(tx, { tenantId: m.tenant_id, cupomId: m.coupon_id });
      if (feito.ok) {
        cupomDesativado = true;
        await tx.execute(sql`update liame.message_request set coupon_deactivated_at = ${referencia}, destination_next_check_at = null, updated_at = now() where id = ${m.id} and tenant_id = ${m.tenant_id}`);
      } else {
        // A recusa definitiva do Regem (a loja desconectada, sem a permissão): não adianta repetir a cada volta. Fica no
        // log com o motivo, e a mensagem continua mostrando o cupom como criado.
        problema = feito.mensagem;
        this.logger.warn(`mensagem ${m.id}: o cupom não foi desativado no Regem (${feito.mensagem})`);
        await tx.execute(sql`update liame.message_request set destination_next_check_at = null, updated_at = now() where id = ${m.id} and tenant_id = ${m.tenant_id}`);
      }
    } else if (!PEDIDO_EM_ABERTO.includes(situacao)) {
      await tx.execute(sql`update liame.message_request set destination_next_check_at = null, updated_at = now() where id = ${m.id} and tenant_id = ${m.tenant_id}`);
    }
    return { tenantId: m.tenant_id, id: m.id, situacao, cupomDesativado, problema };
  }

  /** O pedido como está no RegemCast, pela credencial da conta (o token, ou a ligação com o token do DMS ID). */
  private async lerNoDestino(
    tx: Tx,
    m: Linha,
  ): Promise<{ pedido: Awaited<ReturnType<typeof lerPedidoDeAcao>>['pedido'] } | { problema: string; esperar: number }> {
    const apiUrl = this.config.produtos.regemcastApiUrl;
    if (!apiUrl || !this.database) return { problema: 'o endereço do RegemCast não está configurado', esperar: MINUTOS_SEM_ACESSO };
    const r = await tx.execute<{ external_id: string; credential_secret_id: string | null; conectada: boolean }>(sql`
      select a.external_id, a.credential_secret_id, ${contaConectada('a')} as conectada
        from liame.connected_account a
       where a.id = ${m.connected_account_id} and a.tenant_id = ${m.tenant_id} and a.provider = 'regemcast' and a.disconnected_at is null`);
    const conta = r.rows[0];
    const guardada = conta?.credential_secret_id && conta.conectada ? await this.vault.readSecret(tx, conta.credential_secret_id) : null;
    const credencial = conta ? credencialDaConta(guardada ? (JSON.parse(guardada) as CredencialGuardada) : null, conta.external_id) : null;
    if (!conta || !credencial) return { problema: 'a conta do RegemCast foi desconectada', esperar: MINUTOS_SEM_ACESSO };
    const cliente = new ClienteConector(this.database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 1 });
    try {
      const lido = await comAcessoDaConta(
        credencial,
        this.config,
        `pedido:${conta.external_id}`,
        (a) => lerPedidoDeAcao({ cliente, apiUrl }, { ...a, id: m.destination_request_id }),
        PERMISSOES_DA_ESCRITA_PELO_CLIQUE,
      );
      return { pedido: lido.pedido };
    } catch (err) {
      if (!(err instanceof ErroConector)) throw err;
      const semAcesso = err.tipo === 'autenticacao' || err.tipo === 'permissao' || err.tipo === 'definitivo';
      return { problema: `${err.tipo}${err.codigoProvider ? `:${err.codigoProvider}` : ''}`, esperar: semAcesso ? MINUTOS_SEM_ACESSO : MINUTOS_DEPOIS_DA_FALHA };
    }
  }
}
