import { Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from '../config.js';
import { DatabaseModule } from '../database/database.module.js';
import { TelemetryLifecycle } from '../telemetry.lifecycle.js';
import { VaultModule } from '../vault/vault.module.js';
import { AuditAnchorService } from './audit-anchor.service.js';
import { EventsLoopService } from './events-loop.service.js';
import { INBOX_HANDLERS, type InboxHandler, InboxProcessor } from './inbox-processor.js';
import { OutboxPublisher } from './outbox-publisher.js';
import { QueueService } from './queue.service.js';
import { WebhookDeliverer } from './webhook-deliverer.js';

@Module({
  imports: [DatabaseModule, VaultModule],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    // Processadores por provedor entram com os connectors (A2); até lá, a inbox só guarda.
    { provide: INBOX_HANDLERS, useValue: new Map<string, InboxHandler>() },
    OutboxPublisher,
    AuditAnchorService,
    WebhookDeliverer,
    InboxProcessor,
    EventsLoopService,
    QueueService,
    TelemetryLifecycle,
  ],
})
export class WorkerModule {}
