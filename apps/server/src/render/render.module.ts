import { type BeforeApplicationShutdown, Injectable, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { ArmazemModule } from '../imagens/armazem.module.js';
import { TelemetryLifecycle } from '../telemetry.lifecycle.js';
import { configDoMontador, MONTADOR, MontadorRemotion } from '../video/montador.js';
import { MontagemDoVideo } from '../worker/montagem-do-video.js';

// O serviço de montagem do vídeo (`liame-render`, A6 · Z15 parte 2b; D-A6-139): só a fila do vídeo montado, num
// processo à parte da API e do worker, com 2 núcleos e 3 GB no EasyPanel. Um vídeo por vez; com a fila vazia, olha de
// novo em 5 segundos (a consulta usa o índice parcial da fila).

/** Com a fila vazia, a próxima olhada. */
const ESPERA_DA_FILA_MS = 5_000;
/** De quanto em quanto tempo os pedidos parados no meio são soltos. */
const SOLTAR_PARADOS_MS = 5 * 60_000;

@Injectable()
export class LacoDaMontagem implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('liame-render');
  private parar = false;
  private acordar: (() => void) | null = null;
  private rodando: Promise<void> | null = null;

  constructor(private readonly montagem: MontagemDoVideo) {}

  onApplicationBootstrap(): void {
    this.rodando = this.rodar();
  }

  private esperar(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.acordar = null;
        resolve();
      }, ms);
      this.acordar = () => {
        clearTimeout(t);
        this.acordar = null;
        resolve();
      };
    });
  }

  private async rodar(): Promise<void> {
    let soltou = 0;
    while (!this.parar) {
      try {
        if (Date.now() - soltou >= SOLTAR_PARADOS_MS) {
          soltou = Date.now();
          await this.montagem.soltarParados();
        }
        const vez = await this.montagem.vez();
        if (vez) {
          this.logger.log(`vídeo ${vez.id}: ${vez.situacao}`);
          continue;
        }
      } catch (err) {
        // A fila não para por uma falha de banco ou de armazenamento: tenta de novo na próxima olhada.
        this.logger.error(`a volta da fila falhou (${err instanceof Error ? err.message : String(err)})`);
      }
      await this.esperar(ESPERA_DA_FILA_MS);
    }
  }

  /** Antes de o banco fechar: o pedido em montagem volta à fila, e o laço para. */
  async beforeApplicationShutdown(): Promise<void> {
    this.parar = true;
    this.acordar?.();
    await this.montagem.devolverAtual().catch((err: unknown) => this.logger.error(`não deu para devolver o pedido à fila (${err instanceof Error ? err.message : String(err)})`));
  }

  /** Para os testes: espera o laço terminar. */
  terminou(): Promise<void> {
    return this.rodando ?? Promise.resolve();
  }
}

@Module({
  imports: [DatabaseModule, ArmazemModule],
  providers: [TelemetryLifecycle, { provide: MONTADOR, useFactory: () => new MontadorRemotion(configDoMontador()) }, MontagemDoVideo, LacoDaMontagem],
})
export class RenderModule {}
