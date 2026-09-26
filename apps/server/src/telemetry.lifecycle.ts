import { shutdownTelemetry } from '@liame/telemetry';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';

/** Envia os spans pendentes quando o Nest desliga (sem listener próprio de sinal). */
@Injectable()
export class TelemetryLifecycle implements OnApplicationShutdown {
  async onApplicationShutdown(): Promise<void> {
    await shutdownTelemetry();
  }
}
