import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ActionExecutor } from './action-executor.js';
import { ConexaoProcessor } from './conexao-processor.js';
import { SincronizacaoLoop } from './sincronizacao-loop.js';
import { InboxProcessor } from './inbox-processor.js';
import { OutboxPublisher } from './outbox-publisher.js';
import { WebhookDeliverer } from './webhook-deliverer.js';

/**
 * Laços do worker: publicar a outbox, entregar webhooks, processar a inbox, executar as ações aprovadas, concluir as conexões OAuth e sincronizar as contas conectadas. Cada laço
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
  ) {}

  onApplicationBootstrap(): void {
    this.loops.push(
      this.loop('outbox', 100, 1_000, (n) => this.publisher.publishBatch(n)),
      this.loop('webhooks', 20, 1_000, (n) => this.deliverer.deliverBatch(n)),
      this.loop('inbox', 50, 2_000, (n) => this.inbox.processBatch(n)),
      this.loop('acoes', 20, 1_000, (n) => this.actions.runCycle(n)),
      this.loop('conexoes', 5, 2_000, (n) => this.conexoes.processarLote(n)),
      this.loop('sincronizacao', 3, 30_000, async (n) => (await this.sincronizacao.executarLote(n)).length),
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
