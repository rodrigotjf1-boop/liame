import { Module } from '@nestjs/common';
import { TelemetryLifecycle } from '../telemetry.lifecycle.js';
import { QueueService } from './queue.service.js';

@Module({
  providers: [QueueService, TelemetryLifecycle],
})
export class WorkerModule {}
