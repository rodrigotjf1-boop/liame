import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { ActionService } from './actions/action.service.js';
import { EscritaRegem } from './actions/escrita-regem.provider.js';
import { ActionsController } from './actions/actions.controller.js';
import { BudgetService } from './actions/budget.service.js';
import { ExplicarService } from './ai/explicar/explicar.service.js';
import { AiGateway } from './ai/gateway.js';
import { ModelosIa } from './ai/modelos.js';
import { FerramentasDeLeitura } from './ai/registro/leituras.js';
import { AuditController } from './audit/audit.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { ConnectionsController } from './connections/connections.controller.js';
import { ConnectionsService } from './connections/connections.service.js';
import { DatabaseModule } from './database/database.module.js';
import { FlagService } from './flags/flag.service.js';
import { OfrepController } from './flags/ofrep.controller.js';
import { HealthController } from './health/health.controller.js';
import { LifecycleController } from './lifecycle/lifecycle.controller.js';
import { MediaController } from './media/media.controller.js';
import { MediaService } from './media/media.service.js';
import { LifecycleService } from './lifecycle/lifecycle.service.js';
import { InboxController } from './inbox/inbox.controller.js';
import { InboxService } from './inbox/inbox.service.js';
import { KillSwitchController } from './kill-switch/kill-switch.controller.js';
import { KillSwitchService } from './kill-switch/kill-switch.service.js';
import { CouponsController } from './coupons/coupons.controller.js';
import { CouponsService } from './coupons/coupons.service.js';
import { LinksController } from './links/links.controller.js';
import { LinksService } from './links/links.service.js';
import { PeopleController } from './people/people.controller.js';
import { PolicyController } from './policy/policy.controller.js';
import { AtencaoCicloService } from './results/atencao-ciclo.service.js';
import { ResultsController } from './results/results.controller.js';
import { ResultsService } from './results/results.service.js';
import { PeopleService } from './people/people.service.js';
import { TelemetryLifecycle } from './telemetry.lifecycle.js';
import { TenancyController } from './tenancy/tenancy.controller.js';
import { VaultModule } from './vault/vault.module.js';
import { WebhooksController } from './webhooks/webhooks.controller.js';
import { WebhooksService } from './webhooks/webhooks.service.js';

@Module({
  imports: [DiscoveryModule, DatabaseModule, VaultModule, AuthModule],
  controllers: [HealthController, TenancyController, PeopleController, WebhooksController, InboxController, AuditController, OfrepController, KillSwitchController, PolicyController, ActionsController, LifecycleController, ConnectionsController, MediaController, ResultsController, LinksController, CouponsController],
  providers: [TelemetryLifecycle, PeopleService, WebhooksService, InboxService, FlagService, KillSwitchService, ActionService, EscritaRegem, BudgetService, LifecycleService, ConnectionsService, MediaService, ResultsService, LinksService, CouponsService, AtencaoCicloService, ModelosIa, AiGateway, FerramentasDeLeitura, ExplicarService],
})
export class AppModule {}
