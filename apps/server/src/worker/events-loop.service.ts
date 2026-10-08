import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ActionExecutor } from './action-executor.js';
import { ConexaoProcessor } from './conexao-processor.js';
import { ConferenciaDoGasto } from './conferencia-do-gasto.js';
import { ConversasLoop } from './conversas-loop.js';
import { ConversoesLoop } from './conversoes-loop.js';
import { CriativoLoop } from './criativo-loop.js';
import { EstrategistaAgenda, MARCAS_POR_VOLTA } from './estrategista-agenda.js';
import { EstrategistaLoop } from './estrategista-loop.js';
import { PesquisaLoop } from './pesquisa-loop.js';
import { RevisaoSemanalLoop } from './revisao-semanal-loop.js';
import { SincronizacaoLoop } from './sincronizacao-loop.js';
import { SombraLoop } from './sombra-loop.js';
import { VendasLoop } from './vendas-loop.js';
import { InboxProcessor } from './inbox-processor.js';
import { OutboxPublisher } from './outbox-publisher.js';
import { WebhookDeliverer } from './webhook-deliverer.js';

/**
 * Laços do worker: publicar a outbox, entregar webhooks, processar a inbox, executar as ações aprovadas, concluir as conexões OAuth, sincronizar as contas conectadas, ler as vendas das lojas do Regem, ler as conversas abertas por anúncio das contas do RegemCast, rodar a sombra de cada marca, gerar e enviar a revisão da semana, montar os planos do Estrategista, ler as páginas pedidas ao Pesquisador e conferir o gasto de cada mudança feita numa conta de anúncio. Cada laço
 * repete na hora se o lote veio cheio e espera um pouco se veio vazio. Erro num lote é registrado e
 * o laço segue (LIC-001).
 */
@Injectable()
export class EventsLoopService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('eventos');
  private stopped = false;
  private readonly loops: Promise<void>[] = [];
  private readonly wakeups = new Set<() => void>();

  constructor(
    private readonly publisher: OutboxPublisher,
    private readonly deliverer: WebhookDeliverer,
    private readonly inbox: InboxProcessor,
    private readonly actions: ActionExecutor,
    private readonly conexoes: ConexaoProcessor,
    private readonly sincronizacao: SincronizacaoLoop,
    private readonly vendas: VendasLoop,
    private readonly sombra: SombraLoop,
    private readonly conversas: ConversasLoop,
    private readonly revisao: RevisaoSemanalLoop,
    private readonly estrategista: EstrategistaLoop,
    private readonly agenda: EstrategistaAgenda,
    private readonly pesquisa: PesquisaLoop,
    private readonly criativo: CriativoLoop,
    private readonly conferencia: ConferenciaDoGasto,
    private readonly conversoes: ConversoesLoop,
  ) {}

  onApplicationBootstrap(): void {
    this.loops.push(
      this.loop('outbox', 100, 1_000, (n) => this.publisher.publishBatch(n)),
      this.loop('webhooks', 20, 1_000, (n) => this.deliverer.deliverBatch(n)),
      this.loop('inbox', 50, 2_000, (n) => this.inbox.processBatch(n)),
      this.loop('acoes', 20, 1_000, (n) => this.actions.runCycle(n)),
      this.loop('conexoes', 5, 2_000, (n) => this.conexoes.processarLote(n)),
      this.loop('sincronizacao', 3, 30_000, async (n) => (await this.sincronizacao.executarLote(n)).length),
      this.loop('vendas', 3, 30_000, async (n) => (await this.vendas.executarLote(n)).length),
      this.loop('conversas', 3, 30_000, async (n) => (await this.conversas.executarLote(n)).length),
      this.loop('sombra', 3, 60_000, async (n) => (await this.sombra.executarLote(n)).length),
      this.loop('revisao-semanal', 3, 60_000, async (n) => (await this.revisao.executarLote(n)).length),
      this.loop('revisao-email', 3, 60_000, async (n) => (await this.revisao.enviarLote(n)).length),
      this.loop('estrategista', 3, 60_000, async (n) => (await this.estrategista.executarLote(n)).length),
      // A rotina de segunda passa por todas as marcas devidas numa volta; repete em 10 minutos.
      this.loop('estrategista-agenda', MARCAS_POR_VOLTA, 600_000, async () => (await this.agenda.agendarLote()).length),
      this.loop('pesquisa', 3, 30_000, async (n) => (await this.pesquisa.executarLote(n)).length),
      // Quem pediu as peças está esperando: a fila do Criativo é olhada a cada 5 segundos.
      this.loop('criativo', 3, 5_000, async (n) => (await this.criativo.executarLote(n)).length),
      // O gasto de cada mudança, conferido depois da leitura da manhã: olha de 5 em 5 minutos o que falta conferir hoje.
      this.loop('conferencia-do-gasto', 100, 300_000, async (n) => (await this.conferencia.executarLote(n)).reduce((s, c) => s + c.conferidas, 0)),
      // As vendas confirmadas para o Google: cada conta com destino passa uma vez por hora; a fila das contas é olhada de 5 em 5 minutos.
      this.loop('conversoes-google', 2, 300_000, async (n) => (await this.conversoes.executarLote(n)).length),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    for (const wake of this.wakeups) wake();
    await Promise.all(this.loops);
  }

  private async loop(name: string, batch: number, idleMs: number, run: (batch: number) => Promise<number>): Promise<void> {
    while (!this.stopped) {
      let done = 0;
      try {
        done = await run(batch);
      } catch (err) {
        this.logger.error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (done < batch) await this.sleep(idleMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.wakeups.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.wakeups.add(wake);
    });
  }
}
