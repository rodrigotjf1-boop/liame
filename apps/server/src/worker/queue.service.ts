import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { AuditAnchorService } from './audit-anchor.service.js';
import { CambioService } from './cambio.service.js';
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
 * Câmbio de referência (A3, D-A3-14): a PTAX de venda do Banco Central. O boletim de fechamento sai pouco depois das
 * 13h de Brasília; a rotina lê às 13:40 e, de novo, às 18:40 (16:40 e 21:40 UTC), para o dia em que a primeira falhar.
 */
export const CAMBIO_QUEUE = 'cambio-ptax';

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
    private readonly cambio: CambioService,
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
    await boss.createQueue(CAMBIO_QUEUE);
    await boss.schedule(CAMBIO_QUEUE, '40 16,21 * * *', null, { tz: 'UTC' });
    await boss.work(CAMBIO_QUEUE, async () => {
      try {
        const r = await this.cambio.atualizar();
        this.logger.log(`câmbio: ${r.lidas} cotações lidas, ${r.novas} novas; a mais recente é de ${r.ultima ?? 'nenhum dia'}`);
      } catch (err) {
        // O motivo fica no log do worker; a falha segue para o pg-boss, que tenta de novo e guarda o erro no job.
        this.logger.error(`câmbio: a leitura da PTAX falhou (${err instanceof Error ? err.message : 'erro desconhecido'}); a cotação guardada continua valendo`);
        throw err;
      }
    });
    this.boss = boss;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }
}
