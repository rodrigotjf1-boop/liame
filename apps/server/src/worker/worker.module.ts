import { Module } from '@nestjs/common';
import { BudgetService } from '../actions/budget.service.js';
import { EscritaRegem } from '../actions/escrita-regem.provider.js';
import { APP_CONFIG, type AppConfig, loadConfig } from '../config.js';
import { DatabaseModule } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { KillSwitchService } from '../kill-switch/kill-switch.service.js';
import { createMailer, Mailer } from '../mail/mailer.js';
import { TelemetryLifecycle } from '../telemetry.lifecycle.js';
import { VaultModule } from '../vault/vault.module.js';
import { ActionExecutor } from './action-executor.js';
import { AuditAnchorService } from './audit-anchor.service.js';
import { ConexaoProcessor } from './conexao-processor.js';
import { SincronizacaoLoop } from './sincronizacao-loop.js';
import { eventoDoRegem, VendasLoop } from './vendas-loop.js';
import { VigiaService } from './vigia.service.js';
import { EventsLoopService } from './events-loop.service.js';
import { INBOX_HANDLERS, type InboxHandler, InboxProcessor } from './inbox-processor.js';
import { LifecyclePurgeService } from './lifecycle-purge.service.js';
import { OutboxPublisher } from './outbox-publisher.js';
import { QueueService } from './queue.service.js';
import { WebhookDeliverer } from './webhook-deliverer.js';

@Module({
  imports: [DatabaseModule, VaultModule],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    { provide: Mailer, inject: [APP_CONFIG], useFactory: (config: AppConfig) => createMailer(config) },
    // Processadores por provedor: o Regem (A2.5) antecipa a leitura das lojas da conexão; os demais só guardam.
    { provide: INBOX_HANDLERS, useValue: new Map<string, InboxHandler>([['regem', eventoDoRegem]]) },
    OutboxPublisher,
    AuditAnchorService,
    FlagService,
    KillSwitchService,
    BudgetService,
    ActionExecutor,
    // O connector de escrita do Regem (criar cupom de campanha) recebe o cofre e o cliente HTTP aqui.
    EscritaRegem,
    LifecyclePurgeService,
    WebhookDeliverer,
    InboxProcessor,
    ConexaoProcessor,
    SincronizacaoLoop,
    VendasLoop,
    VigiaService,
    EventsLoopService,
    QueueService,
    TelemetryLifecycle,
  ],
})
export class WorkerModule {}
