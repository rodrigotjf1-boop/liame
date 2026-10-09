import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ActionService, type ConferenciaDoSistema } from '../actions/action.service.js';
import { TOOLS } from '../actions/tools.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { DATABASE } from '../database/database.module.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// A conferência dos pedidos que esperam (A5, Y5; P15: "o Liame avisa quando a Meta responder"). Fica na pasta do
// worker porque procura o que conferir em todas as empresas, em escopo de sistema (regra `liame-escopo-sistema`).
//
// O pedido de envio de mensagem com um impedimento (o modelo ainda em análise na Meta, o custo acima do teto de gasto
// de mensagens) espera em Aprovações, e ninguém aprova enquanto ele durar. Esta rotina olha cada um deles de tempos em
// tempos: lê o plano de agora na plataforma, pelo Action Service, e guarda no pedido. Quando o impedimento sai, quem
// pode aprovar recebe um e-mail; quando só o motivo muda, o motivo novo fica no pedido. Ela não aprova, não recusa e
// não cancela nada: a decisão continua sendo de uma pessoa, com o código do app.
//
// Só o pedido COM impedimento lê a plataforma. O que espera sem impedimento só ganha a marca de "olhado": a aprovação
// já confere o plano de agora (`conferirOPlanoDeAgora`), e ler a plataforma por ele a cada volta seria gasto à toa.

/** De quanto em quanto tempo cada pedido com impedimento é conferido de novo. */
export const MINUTOS_ENTRE_CONFERENCIAS = 15;
/** As ferramentas cujo plano muda sozinho na plataforma e que sabem dizer o que impede a aprovação. */
const FERRAMENTAS = Object.values(TOOLS)
  .filter((t) => t.revalidateOnApproval && t.blockedBy)
  .map((t) => t.name);

type Candidato = { id: string; tenant_id: string; tool: string; before_state: Record<string, unknown> | null };

export type PedidoConferido = { tenantId: string; id: string } & ConferenciaDoSistema;

@Injectable()
export class PedidosQueEsperam {
  private readonly logger = new Logger('pedidos-que-esperam');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly actions: ActionService,
  ) {}

  /**
   * Um lote: até `limite` pedidos que esperam aprovação e que não foram olhados no último intervalo, do que espera há
   * mais tempo para o mais recente. Cada pedido com impedimento é conferido na sua transação, sob a RLS da empresa, e
   * a falha de um não para os outros. Várias instâncias do worker podem rodar juntas: o pedido é travado na
   * conferência, e quem chega depois já o encontra sem impedimento ou com a marca de olhado. O relógio injetado vale
   * para a operação inteira (V34). Devolve o que foi conferido na plataforma.
   */
  async executarLote(limite = 20, scope: JobScope = {}, agora?: Date): Promise<PedidoConferido[]> {
    if (!this.database || !FERRAMENTAS.length) return [];
    const database = this.database;
    const referencia = agora ? sql`${agora.toISOString()}::timestamptz` : sql`now()`;
    const candidatos = (
      await withSystem(database.db, (tx) =>
        tx.execute<Candidato>(sql`
          select r.id, r.tenant_id, r.tool, r.before_state
            from liame.action_request r
           where r.status = 'aguardando_aprovacao' and r.tool in ${FERRAMENTAS} ${tenantFilter(scope, sql`r.tenant_id`)}
             -- O pedido vencido sai da fila pelo executor: não há o que conferir nele.
             and r.expires_at > ${referencia}
             -- O pedido novo, ou o que alguém acabou de conferir pelo botão, também espera um intervalo.
             and coalesce(r.plan_checked_at, r.updated_at) <= ${referencia} - make_interval(mins => ${MINUTOS_ENTRE_CONFERENCIAS})
           order by coalesce(r.plan_checked_at, r.updated_at), r.id
           limit ${limite}`),
      )
    ).rows;
    if (!candidatos.length) return [];

    const impedido = (c: Candidato) => Boolean(c.before_state && TOOLS[c.tool]?.blockedBy?.(c.before_state));
    const livres = candidatos.filter((c) => !impedido(c)).map((c) => c.id);
    if (livres.length) {
      // Uma gravação para todos (não uma por pedido): só a marca, para eles não voltarem a cada volta.
      await withSystem(database.db, (tx) => tx.execute(sql`update liame.action_request set plan_checked_at = ${referencia} where id in ${livres} and status = 'aguardando_aprovacao'`));
    }

    const conferidos: PedidoConferido[] = [];
    for (const c of candidatos.filter(impedido)) {
      try {
        const r = await naTransacaoDaEmpresa(database, { tenantId: c.tenant_id, userId: null }, () => this.actions.conferirPeloSistema(c.tenant_id, c.id, agora));
        conferidos.push({ tenantId: c.tenant_id, id: c.id, ...r });
        if (r.resultado === 'liberou') this.logger.log(`pedido ${c.id}: o impedimento saiu; ${r.avisados} pessoa(s) avisada(s)`);
        // O motivo esperado de não conferir (a plataforma fora do ar, a autorização caída) fica no log (V6).
        else if (r.resultado === 'sem-leitura') this.logger.warn(`pedido ${c.id}: não deu para conferir agora (${r.motivo})`);
      } catch (err) {
        // Falha fora do previsto: a causa vai para o log, e o pedido ganha a marca para não segurar a fila das voltas
        // seguintes (LIC-001). Ele volta no próximo intervalo.
        this.logger.error(`pedido ${c.id}: falha ao conferir: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        await withSystem(database.db, (tx) => tx.execute(sql`update liame.action_request set plan_checked_at = ${referencia} where id = ${c.id} and tenant_id = ${c.tenant_id}`));
      }
    }
    return conferidos;
  }
}
