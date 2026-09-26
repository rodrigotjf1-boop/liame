import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { PeopleController } from './people/people.controller.js';
import { PeopleService } from './people/people.service.js';
import { SpikeController } from './spike/spike.controller.js';
import { TelemetryLifecycle } from './telemetry.lifecycle.js';
import { TenancyController } from './tenancy/tenancy.controller.js';
import { VaultModule } from './vault/vault.module.js';

@Module({
  imports: [DiscoveryModule, DatabaseModule, VaultModule, AuthModule],
  controllers: [HealthController, SpikeController, TenancyController, PeopleController],
  providers: [TelemetryLifecycle, PeopleService],
})
export class AppModule {}
