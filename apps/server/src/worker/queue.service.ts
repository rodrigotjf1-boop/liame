import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { AuditAnchorService } from './audit-anchor.service.js';
import { LifecyclePurgeService } from './lifecycle-purge.service.js';
import { VigiaService } from './vigia.service.js';

/** Âncora diária da auditoria: 03:15 UTC, com o dia anterior fechado (A1-6). */
export const AUDIT_ANCHOR_QUEUE = 'auditoria-ancora';
/** Expurgo diário (04:30 UTC) e relatório mensal ao dono (dia 1, 12:00 UTC), ADR-014. */
export const PURGE_QUEUE = 'ciclo-de-vida';
export const PURGE_REPORT_QUEUE = 'ciclo-de-vida-relatorio';
/** Vigia de integrações (06:10 UTC): fontes oficiais e calendário de versões (A2, G8; ADR-015). */
export const VIGIA_QUEUE = 'vigia-integracoes';

/**
 * Dono do pg-boss no worker. O pg-boss usa conexão direta ou em modo sessão (LISTEN/NOTIFY e
 * manutenção, ADR-005): `DATABASE_URL_JOBS`. A aplicação enfileira pela própria transação.
 */
@Injectable()
export class QueueService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private boss: PgBoss | undefined;

  constructor(
    private readonly anchor: AuditAnchorService,
    private readonly purge: LifecyclePurgeService,
    private readonly vigia: VigiaService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const connectionString = process.env.DATABASE_URL_JOBS;
    if (!connectionString) {
      throw new Error('worker: defina DATABASE_URL_JOBS (conexão direta ou em modo sessão, ADR-005)');
    }
    const boss = new PgBoss({ connectionString, application_name: 'liame-worker' });
    // Sem listener, um 'error' do EventEmitter derruba o processo (LIC-001).
    boss.on('error', (err: Error) => this.logger.error(`pg-boss: ${err.message}`));
    await boss.start();
    await boss.createQueue(AUDIT_ANCHOR_QUEUE);
    // Um agendamento só, mesmo com vários workers (o pg-boss guarda o cron no banco).
    await boss.schedule(AUDIT_ANCHOR_QUEUE, '15 3 * * *', null, { tz: 'UTC' });
    await boss.work(AUDIT_ANCHOR_QUEUE, async () => {
      await this.anchor.runDaily();
    });
    await boss.createQueue(PURGE_QUEUE);
    await boss.schedule(PURGE_QUEUE, '30 4 * * *', null, { tz: 'UTC' });
    await boss.work(PURGE_QUEUE, async () => {
      await this.purge.runDaily();
    });
    await boss.createQueue(PURGE_REPORT_QUEUE);
    await boss.schedule(PURGE_REPORT_QUEUE, '0 12 1 * *', null, { tz: 'UTC' });
    await boss.work(PURGE_REPORT_QUEUE, async () => {
      await this.purge.monthlyReport();
    });
    await boss.createQueue(VIGIA_QUEUE);
    await boss.schedule(VIGIA_QUEUE, '10 6 * * *', null, { tz: 'UTC' });
    await boss.work(VIGIA_QUEUE, async () => {
      const r = await this.vigia.rodar();
      this.logger.log(`vigia: ${r.lidas}/${r.fontes} fontes lidas, ${r.mudancas} trechos mudaram, ${r.alertas} alertas novos`);
    });
    this.boss = boss;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }
}
