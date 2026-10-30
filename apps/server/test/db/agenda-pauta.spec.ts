import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais } from '../helpers/posts-semeados.js';
import { hasDb } from './env.js';

// A6 · Z5d, parte 5: a pauta da semana e as datas comerciais na Agenda (P19, aprovado em 21/10/2026; D-A6-20 e D-A6-56),
// contra o Postgres. O que se prova aqui:
//   - a Agenda traz, em cada dia do período, o item da pauta do plano de pauta APROVADO mais novo da marca que cobre o dia
//     (o plano que espera, o recusado, o de outra marca e o dia fora do período não entram);
//   - as datas do calendário comercial do período, como a tabela do Liame guarda (em ordem de dia);
//   - com a função desligada, nada disso.

const FUSO = 'America/Sao_Paulo';
const DIA_MS = 86_400_000;
const diaNoFuso = (n: number): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + n * DIA_MS));

describe.skipIf(!hasDb)('a pauta e as datas comerciais na Agenda (A6 · Z5d, parte 5)', () => {
  let api: TestApi;

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
  });
  afterAll(async () => {
    await api?.close();
  });

  const agenda = (e: EmpresaComCanais, de = diaNoFuso(-1), ate = diaNoFuso(7)) =>
    api.call('GET', `/v1/posts?brand_id=${e.brandId}&from=${de}&to=${ate}`, { cookie: e.cookie });

  /** Um plano de pauta da marca, com a versão atual e os dias; `ha`: quantos minutos atrás ele foi decidido. */
  async function pauta(e: { tenantId: string; brandId: string }, status: string, dias: Array<{ day: string; item: string }>, ha: number): Promise<string> {
    const id = randomUUID();
    const quando = new Date(Date.now() - ha * 60_000).toISOString();
    await ownerQuery(
      `insert into liame.plan (id, tenant_id, brand_id, kind, title, status, version, expires_at, created_at, updated_at)
       values ($1, $2, $3, 'pauta', 'Pauta da semana', $4, 1, $5::timestamptz + interval '3 days', $5, $5)`,
      [id, e.tenantId, e.brandId, status, quando],
    );
    await ownerQuery(
      `insert into liame.plan_version (id, tenant_id, plan_id, version, content, risk, content_hash, author, created_at)
       values ($1, $2, $3, 1, $4::jsonb, 'baixo', $5, 'estrategista', $6)`,
      [randomUUID(), e.tenantId, id, JSON.stringify({ kind: 'pauta', days: dias }), 'a'.repeat(64), quando],
    );
    return id;
  }

  it('o item da pauta aprovada mais nova em cada dia do período, e as datas comerciais do período', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Pauta');
    const antiga = await pauta(e, 'aprovado', [{ day: diaNoFuso(1), item: 'O combo antigo' }, { day: diaNoFuso(2), item: 'A batata nova, no almoço' }], 120);
    const nova = await pauta(e, 'aprovado', [{ day: diaNoFuso(1), item: 'O combo de sexta, para lembrar do fim de semana' }, { day: diaNoFuso(20), item: 'Fora do período' }], 10);
    // O plano que espera a decisão e o recusado não entram; a pauta de outra marca também não.
    await pauta(e, 'pendente', [{ day: diaNoFuso(3), item: 'Ainda não decidido' }], 5);
    await pauta(e, 'recusado', [{ day: diaNoFuso(4), item: 'Recusado' }], 5);
    const outra = await empresaComCanais(api, 'Outra Casa Pauta');
    await pauta(outra, 'aprovado', [{ day: diaNoFuso(5), item: 'Da outra empresa' }], 5);

    const r = await agenda(e);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.pauta).toEqual([
      { day: diaNoFuso(1), item: 'O combo de sexta, para lembrar do fim de semana', plan_id: nova },
      { day: diaNoFuso(2), item: 'A batata nova, no almoço', plan_id: antiga },
    ]);
    // As datas do calendário comercial do Liame no período, na ordem do dia, como a tabela guarda.
    const esperadas = await ownerQuery<{ day: string; name: string; kind: string }>(
      `select to_char(day, 'YYYY-MM-DD') as day, name, kind from liame.commercial_date where day between $1::date and $2::date order by day, kind, name`,
      [diaNoFuso(-1), diaNoFuso(7)],
    );
    expect(r.body.dates).toEqual(esperadas);
    // Um período com uma data conhecida da tabela (o Natal de 2026) traz a data.
    const natal = await agenda(e, '2026-12-21', '2026-12-27');
    expect(natal.body.dates).toContainEqual({ day: '2026-12-25', name: 'Natal', kind: 'feriado_nacional' });

    // Com a função desligada, nada.
    await ligarFlagDaEmpresa(api, 'social_write', e.tenantId, false);
    expect((await agenda(e)).body).toMatchObject({ enabled: false, pauta: [], dates: [] });
  });
});
