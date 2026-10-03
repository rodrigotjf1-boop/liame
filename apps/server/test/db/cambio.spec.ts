import { resolve } from 'node:path';
import { TeamResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations, withContext, withSystem } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ultimaCotacao } from '../../src/cambio/cotacao.js';
import type { Cotacao } from '../../src/cambio/ptax.js';
import { CambioService } from '../../src/worker/cambio.service.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A3 · D-A3-14 com o banco real e o Banco Central simulado (nenhuma chamada sai para a internet): a rotina guarda uma
// cotação por dia útil, sem repetir; só o sistema grava; e Sua equipe devolve a mais recente para a tela mostrar o
// custo em reais. A tabela é do produto (sem empresa): o teste usa dias de 2099, que ninguém mais usa, e limpa no fim.

const DIAS = ['2099-03-02', '2099-03-03', '2099-03-04'];

describe.skipIf(!hasDb)('câmbio de referência: a PTAX guardada e a cotação em Sua equipe (A3, D-A3-14)', () => {
  let api: TestApi;
  let database: Database;
  let cambio: CambioService;
  const agora = new Date('2099-03-04T20:00:00Z');
  let pedidos: Array<[string, string]> = [];
  let resposta: Cotacao[] = [];
  const buscar = async (de: string, ate: string) => {
    pedidos.push([de, ate]);
    return resposta;
  };
  const guardadas = () => ownerQuery<{ dia: string; taxa: string; source: string }>(`select rate_date::text as dia, rate::text as taxa, source from liame.exchange_rate where rate_date = any($1::date[]) order by rate_date`, [DIAS]);

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    cambio = new CambioService(database);
    await ownerQuery(`delete from liame.exchange_rate where rate_date = any($1::date[])`, [DIAS]);
  });

  afterAll(async () => {
    await ownerQuery(`delete from liame.exchange_rate where rate_date = any($1::date[])`, [DIAS]);
    await database?.close();
    await api?.close();
  });

  it('a rotina pede os últimos 10 dias até hoje (dia de Brasília) e guarda cada cotação uma vez', async () => {
    resposta = [
      { dia: DIAS[0]!, taxa: '5.2079', publicadaEm: '2099-03-02T16:10:35.000Z' },
      { dia: DIAS[1]!, taxa: '5.2238', publicadaEm: '2099-03-03T16:03:16.000Z' },
    ];
    expect(await cambio.atualizar(agora, buscar)).toMatchObject({ lidas: 2, novas: 2 });
    // 20:00 UTC de 04/03 ainda é 04/03 em Brasília.
    expect(pedidos).toEqual([['2099-02-22', '2099-03-04']]);
    expect(await guardadas()).toEqual([
      { dia: DIAS[0], taxa: '5.207900', source: 'bcb_ptax_venda' },
      { dia: DIAS[1], taxa: '5.223800', source: 'bcb_ptax_venda' },
    ]);

    // A segunda leitura traz os mesmos dias e mais um: só o novo entra, e a cotação já guardada não muda.
    resposta = [...resposta.map((c) => ({ ...c, taxa: '9.9999' })), { dia: DIAS[2]!, taxa: '5.1809', publicadaEm: '2099-03-04T16:11:44.000Z' }];
    expect(await cambio.atualizar(agora, buscar)).toMatchObject({ lidas: 3, novas: 1 });
    expect((await guardadas()).map((g) => g.taxa)).toEqual(['5.207900', '5.223800', '5.180900']);
  });

  it('o Banco Central fora do ar: a rotina falha (o agendador registra) e nada do que estava guardado se perde', async () => {
    const antes = await guardadas();
    await expect(
      cambio.atualizar(agora, async () => {
        throw new Error('PTAX: HTTP 503');
      }),
    ).rejects.toThrow('PTAX: HTTP 503');
    expect(await guardadas()).toEqual(antes);
  });

  it('todos leem a cotação; só o sistema grava', async () => {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria do Câmbio');
    const quem = { tenantId: s.me.active_organization_id as string, userId: s.me.user.id as string };
    const lida = await withContext(database.db, quem, (tx) => ultimaCotacao(tx));
    expect(lida).toEqual({ rate: '5.1809', date: DIAS[2], source: 'bcb_ptax_venda' });
    const gravar = sql`insert into liame.exchange_rate (base, quote, rate_date, rate, source, published_at) values ('USD', 'BRL', '2099-03-05', 1, 'bcb_ptax_venda', now())`;
    await expect(withContext(database.db, quem, (tx) => tx.execute(gravar))).rejects.toThrow();
    // E nem o sistema altera uma cotação publicada: a aplicação só lê e insere.
    await expect(withSystem(database.db, (tx) => tx.execute(sql`update liame.exchange_rate set rate = 1 where rate_date = ${DIAS[2]}::date`))).rejects.toThrow();
  });

  it('Sua equipe devolve a cotação mais recente, com o dia do boletim; o custo e o teto seguem em dólar', async () => {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria do Câmbio 2');
    await enableMfa(api, s.cookie);
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    const r = await api.call('GET', `/v1/team?brand_id=${brandId}`, { cookie: s.cookie });
    expect(r.status).toBe(200);
    const t = TeamResponse.parse(r.body);
    expect(t.usd_brl).toEqual({ rate: '5.1809', date: DIAS[2], source: 'bcb_ptax_venda' });
    expect(t.ai.ceiling_usd_micros).toMatch(/^\d+$/);
  });
});
