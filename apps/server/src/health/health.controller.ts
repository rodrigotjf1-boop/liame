import { HealthResponse, ReadinessResponse } from '@liame/contracts';
import type { Database } from '@liame/database';
import { Controller, Get, Inject, Logger, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { Publico } from '../auth/access.js';
import { DATABASE } from '../database/database.module.js';
import { APP_VERSION } from '../version.js';

const SERVICE = 'liame-api';
const CHECK_TIMEOUT_MS = 3000;

type Check = ReadinessResponse['checks']['database'];

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`sem resposta em ${CHECK_TIMEOUT_MS} ms`)), CHECK_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
    return { value, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

@ApiTags('infra')
@Publico()
@Controller()
export class HealthController {
  private readonly logger = new Logger('health');

  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  /** O processo está de pé. Não toca dependências: serve de sonda de vida. */
  @Get('health')
  @ApiOperation({ summary: 'Sonda de vida', description: 'Responde se o processo está de pé, com a versão do código. Não toca dependências.' })
  @ApiOkResponse({ standardSchema: HealthResponse })
  check(): HealthResponse {
    return { status: 'ok', service: SERVICE, version: APP_VERSION };
  }

  /** O serviço consegue trabalhar: toca o banco e a fila e diz a versão e a última migration (LIC-008). */
  @Get('health/ready')
  @ApiOperation({
    summary: 'Prontidão',
    description: 'Toca o banco e a fila e diz a versão do código e a última migration aplicada. Responde 503 quando alguma dependência falha.',
  })
  @ApiOkResponse({ standardSchema: ReadinessResponse })
  @ApiServiceUnavailableResponse({ standardSchema: ReadinessResponse })
  async ready(@Res({ passthrough: true }) res: { status(code: number): unknown }): Promise<ReadinessResponse> {
    let migration: string | null = null;
    let database: Check = { status: 'falhou' };
    let queue: Check = { status: 'falhou' };

    if (!this.database) {
      this.logger.warn('ready: DATABASE_URL não definida');
    } else {
      const { pool } = this.database;
      try {
        const r = await timed(() =>
          pool.query<{ migration: string | null }>(
            `select case when to_regclass('liame_migrations.applied') is null then null
                         else (select max(name) from liame_migrations.applied) end as migration`,
          ),
        );
        migration = r.value.rows[0]?.migration ?? null;
        database = { status: 'ok', latency_ms: r.ms };
      } catch (err) {
        this.logger.warn(`ready: banco falhou: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (database.status === 'ok') {
        try {
          // A fila existe quando o schema do pg-boss foi instalado (pelo worker). pg_class é legível por todos.
          const schema = process.env.PGBOSS_SCHEMA ?? 'pgboss';
          const r = await timed(() =>
            pool.query<{ ok: boolean }>(
              `select exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                               where n.nspname = $1 and c.relname = 'job') as ok`,
              [schema],
            ),
          );
          if (r.value.rows[0]?.ok) queue = { status: 'ok', latency_ms: r.ms };
          else this.logger.warn(`ready: fila não instalada (schema ${schema})`);
        } catch (err) {
          this.logger.warn(`ready: fila falhou: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const ok = database.status === 'ok' && queue.status === 'ok';
    if (!ok) res.status(503);
    return {
      status: ok ? 'ok' : 'indisponivel',
      service: SERVICE,
      version: APP_VERSION,
      migration,
      checks: { database, queue },
    };
  }
}
