import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module.js';
import { HealthController } from './health/health.controller.js';
import { SpikeController } from './spike/spike.controller.js';
import { TelemetryLifecycle } from './telemetry.lifecycle.js';

@Module({
  imports: [DatabaseModule],
  controllers: [HealthController, SpikeController],
  providers: [TelemetryLifecycle],
})
export class AppModule {}
