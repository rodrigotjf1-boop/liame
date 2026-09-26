import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller.js';
import { SpikeController } from './spike/spike.controller.js';
import { TelemetryLifecycle } from './telemetry.lifecycle.js';

@Module({
  controllers: [HealthController, SpikeController],
  providers: [TelemetryLifecycle],
})
export class AppModule {}
