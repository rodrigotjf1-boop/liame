import { Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { AuthModule } from './auth/auth.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { SpikeController } from './spike/spike.controller.js';
import { TelemetryLifecycle } from './telemetry.lifecycle.js';
import { VaultModule } from './vault/vault.module.js';

@Module({
  imports: [DiscoveryModule, DatabaseModule, VaultModule, AuthModule],
  controllers: [HealthController, SpikeController],
  providers: [TelemetryLifecycle],
})
export class AppModule {}
