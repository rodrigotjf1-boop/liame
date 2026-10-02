import { createDatabase, type Database } from '@liame/database';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { from, lastValueFrom } from 'rxjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { afterCommit, currentTx } from '../../src/context/request-context.js';
import { SEM_TRANSACAO_KEY } from '../../src/context/sem-transacao.js';
import { UnitOfWorkInterceptor } from '../../src/context/unit-of-work.interceptor.js';
import { APP_URL, hasDb } from './env.js';

// O e-mail com link e os avisos só saem se a transação da requisição gravar.
describe.skipIf(!hasDb)('unidade de trabalho: efeitos depois do commit', () => {
  let database: Database;
  let interceptor: UnitOfWorkInterceptor;

  const request = { auth: { userId: '0192f1d4-3c1a-7b2e-9a10-5f1e2d3c4b5a', tenantId: null }, method: 'GET', url: '/teste', headers: {} };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ setHeader: () => undefined }) }),
    getHandler: () => function handler() {},
  } as unknown as ExecutionContext;
  const run = (handler: () => Promise<unknown>) =>
    lastValueFrom(interceptor.intercept(ctx, { handle: () => from(handler()) } as CallHandler));

  beforeAll(() => {
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    interceptor = new UnitOfWorkInterceptor(database);
  });
  afterAll(async () => {
    await database?.close();
  });

  it('com commit, o efeito roda depois da transação e a falha dele não muda a resposta', async () => {
    const seen: string[] = [];
    const result = await run(async () => {
      await currentTx().execute(sql`select 1`);
      afterCommit(async () => {
        seen.push('primeiro');
      });
      afterCommit(async () => {
        throw new Error('provedor de e-mail fora do ar');
      });
      afterCommit(async () => {
        seen.push('terceiro');
      });
      expect(seen).toEqual([]);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(seen).toEqual(['primeiro', 'terceiro']);
  });

  it('rota @SemTransacao: a unidade de trabalho não abre transação (quem espera um modelo de IA abre as próprias, curtas)', async () => {
    const handler = function esperaUmModelo() {};
    Reflect.defineMetadata(SEM_TRANSACAO_KEY, { motivo: 'espera um modelo de IA por segundos' }, handler);
    const semTransacao = { ...ctx, getHandler: () => handler } as unknown as ExecutionContext;
    const temTransacao = async () => {
      try {
        currentTx();
        return true;
      } catch {
        return false;
      }
    };
    expect(await lastValueFrom(interceptor.intercept(semTransacao, { handle: () => from(temTransacao()) } as CallHandler))).toBe(false);
    // A rota comum segue dentro da transação da requisição.
    expect(await run(temTransacao)).toBe(true);
  });

  it('com rollback, nenhum efeito roda', async () => {
    const seen: string[] = [];
    await expect(
      run(async () => {
        afterCommit(async () => {
          seen.push('não devia');
        });
        throw new Error('falhou no meio');
      }),
    ).rejects.toThrow('falhou no meio');
    expect(seen).toEqual([]);
  });
});
