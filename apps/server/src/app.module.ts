import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AuditController } from './audit/audit.controller.js';
import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { FlagService } from './flags/flag.service.js';
import { OfrepController } from './flags/ofrep.controller.js';
import { HealthController } from './health/health.controller.js';
import { InboxController } from './inbox/inbox.controller.js';
import { InboxService } from './inbox/inbox.service.js';
import { KillSwitchController } from './kill-switch/kill-switch.controller.js';
import { KillSwitchService } from './kill-switch/kill-switch.service.js';
import { PeopleController } from './people/people.controller.js';
import { PolicyController } from './policy/policy.controller.js';
import { PeopleService } from './people/people.service.js';
import { SpikeController } from './spike/spike.controller.js';
import { TelemetryLifecycle } from './telemetry.lifecycle.js';
import { TenancyController } from './tenancy/tenancy.controller.js';
import { VaultModule } from './vault/vault.module.js';
import { WebhooksController } from './webhooks/webhooks.controller.js';
import { WebhooksService } from './webhooks/webhooks.service.js';

@Module({
  imports: [DiscoveryModule, DatabaseModule, VaultModule, AuthModule],
  controllers: [HealthController, SpikeController, TenancyController, PeopleController, WebhooksController, InboxController, AuditController, OfrepController, KillSwitchController, PolicyController],
  providers: [TelemetryLifecycle, PeopleService, WebhooksService, InboxService, FlagService, KillSwitchService],
})
export class AppModule {}
