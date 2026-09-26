import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { AuditAnchorService } from './audit-anchor.service.js';

export const SPIKE_QUEUE = 'spike';
/** Âncora diária da auditoria: 03:15 UTC, com o dia anterior fechado (A1-6). */
export const AUDIT_ANCHOR_QUEUE = 'auditoria-ancora';

/**
 * Dono do pg-boss no worker. O pg-boss usa conexão direta ou em modo sessão (LISTEN/NOTIFY e
 * manutenção, ADR-005): `DATABASE_URL_JOBS`. A aplicação enfileira pela própria transação.
 */
@Injectable()
export class QueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private boss: PgBoss | undefined;

  constructor(private readonly anchor: AuditAnchorService) {}

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
    await boss.createQueue(AUDIT_ANCHOR_QUEUE);
    // Um agendamento só, mesmo com vários workers (o pg-boss guarda o cron no banco).
    await boss.schedule(AUDIT_ANCHOR_QUEUE, '15 3 * * *', null, { tz: 'UTC' });
    await boss.work(AUDIT_ANCHOR_QUEUE, async () => {
      await this.anchor.runDaily();
    });
    this.boss = boss;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }
}
