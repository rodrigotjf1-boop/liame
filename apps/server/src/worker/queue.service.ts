import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PgBoss } from 'pg-boss';

export const SPIKE_QUEUE = 'spike';

/**
 * Dono do pg-boss no worker. O pg-boss usa conexão direta ou em modo sessão (LISTEN/NOTIFY e
 * manutenção, ADR-005): `DATABASE_URL_JOBS`. A aplicação enfileira pela própria transação.
 */
@Injectable()
export class QueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private boss: PgBoss | undefined;

  async onApplicationBootstrap(): Promise<void> {
    const connectionString = process.env.DATABASE_URL_JOBS;
    if (!connectionString) {
      throw new Error('worker: defina DATABASE_URL_JOBS (conexão direta ou em modo sessão, ADR-005)');
    }
    const boss = new PgBoss({ connectionString, application_name: 'liame-worker' });
    // Sem listener, um 'error' do EventEmitter derruba o processo (LIC-001).
    boss.on('error', (err: Error) => this.logger.error(`pg-boss: ${err.message}`));
    await boss.start();
    await boss.createQueue(SPIKE_QUEUE);
    await boss.work(SPIKE_QUEUE, async (jobs) => {
      for (const job of jobs) this.logger.log(`job ${job.id} processado`);
    });
    this.boss = boss;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }
}
