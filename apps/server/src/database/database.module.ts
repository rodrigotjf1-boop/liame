import { createDatabase, type Database } from '@liame/database';
import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';

/** Pool da aplicação (papel liame_app, sem BYPASSRLS). `null` quando o processo sobe sem banco. */
export const DATABASE = Symbol('DATABASE');

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  async onApplicationShutdown(): Promise<void> {
    await this.database?.close();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: DATABASE,
      useFactory: (): Database | null => {
        const url = process.env.DATABASE_URL;
        return url ? createDatabase({ connectionString: url, applicationName: 'liame-api' }) : null;
      },
    },
    DatabaseLifecycle,
  ],
  exports: [DATABASE],
})
export class DatabaseModule {}
