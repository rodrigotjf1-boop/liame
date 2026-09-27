import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VigiaService } from '../../src/worker/vigia.service.js';
import { ownerQuery } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A2 · G8: a rotina diária do Vigia com o banco real e as páginas simuladas (nenhuma chamada sai para a
// internet): fonte nova vira base, trecho mudado vira registro e alerta, fonte que falha vira alerta,
// calendário de versões e avisos de descontinuação geram um alerta por etapa, sem repetir.

describe.skipIf(!hasDb)('vigia de integrações', () => {
  let database: Database;
  let vigia: VigiaService;
  const marca = randomUUID().slice(0, 8);
  const PROVIDER = `teste_vigia_${marca}`;
  const fonteBoa = { id: randomUUID(), url: `https://developers.google.com/teste-vigia/${marca}/changelog` };
  const fonteRuim = { id: randomUUID(), url: `https://developers.facebook.com/teste-vigia/${marca}/fora` };
  let paginaBoa = '<h2>v1</h2><p>Primeira versão.</p><h2>Limites</h2><p>100 por hora.</p>';

  const buscar = async (url: string) => {
    if (url === fonteRuim.url) throw new Error('HTTP 503');
    if (url === fonteBoa.url) return paginaBoa;
    // Fontes cadastradas pela migration: conteúdo fixo, sem rede.
    return '<h2>Versões</h2><p>Sem mudança.</p>';
  };
  const alertas = (filtro: string, params: unknown[]) =>
    ownerQuery<{ kind: string; stage: string; api_version: string; message: string; due_date: string | null }>(
      `select kind, stage, api_version, message, due_date::text as due_date from liame.watch_alert where ${filtro} order by kind, stage`,
      params,
    );

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    vigia = new VigiaService(database);
    await ownerQuery(
      `insert into liame.watch_source (id, provider, kind, title, url) values ($1, $3, 'changelog', 'Teste: changelog', $2), ($4, $3, 'changelog', 'Teste: fora do ar', $5)`,
      [fonteBoa.id, fonteBoa.url, PROVIDER, fonteRuim.id, fonteRuim.url],
    );
  });
  afterAll(async () => {
    await ownerQuery(`delete from liame.watch_source where provider = $1`, [PROVIDER]);
    await ownerQuery(`delete from liame.watch_alert where provider = $1`, [PROVIDER]);
    await ownerQuery(`delete from liame.api_deprecation_notice where provider = $1`, [PROVIDER]);
    await ownerQuery(`delete from liame.connector_capability where provider = $1`, [PROVIDER]);
    await database?.close();
  });

  it('fonte nova vira base; trecho mudado vira registro com o texto novo e um alerta por dia', async () => {
    const r1 = await vigia.rodar(new Date('2026-09-26T06:10:00Z'), buscar);
    expect(r1.lidas).toBe(r1.fontes - 1);
    const [base] = await ownerQuery<{ sections: { titulo: string }[] }>(`select sections from liame.watch_snapshot where source_id = $1`, [fonteBoa.id]);
    expect(base!.sections.map((s) => s.titulo)).toEqual(['v1', 'Limites']);
    expect(await ownerQuery(`select 1 from liame.watch_change where source_id = $1`, [fonteBoa.id])).toHaveLength(0);

    paginaBoa = '<h2>v1</h2><p>Primeira versão.</p><h2>Limites</h2><p>60 por hora.</p><h2>v2</h2><p>Nova versão; a v1 termina em 01/12/2026.</p>';
    await vigia.rodar(new Date('2026-09-27T06:10:00Z'), buscar);
    const mudancas = await ownerQuery<{ section_title: string; change: string; excerpt: string }>(
      `select section_title, change, excerpt from liame.watch_change where source_id = $1 order by section_title`,
      [fonteBoa.id],
    );
    expect(mudancas).toEqual([
      { section_title: 'Limites', change: 'alterado', excerpt: '60 por hora.' },
      { section_title: 'v2', change: 'novo', excerpt: 'Nova versão; a v1 termina em 01/12/2026.' },
    ]);
    const mudou = await alertas(`kind = 'fonte_mudou' and api_version = $1`, [fonteBoa.id]);
    expect(mudou).toEqual([expect.objectContaining({ stage: '2026-09-27', message: expect.stringContaining('2 trecho(s) mudaram em "Teste: changelog"') })]);
  });

  it('fonte que falha 3 vezes seguidas vira alerta (um por dia)', async () => {
    // A primeira falha já aconteceu no teste anterior (2 rodadas): esta é a terceira.
    await vigia.rodar(new Date('2026-09-28T06:10:00Z'), buscar);
    await vigia.rodar(new Date('2026-09-28T07:10:00Z'), buscar);
    const [fonte] = await ownerQuery<{ failures: number; last_error: string }>(`select failures, last_error from liame.watch_source where id = $1`, [fonteRuim.id]);
    expect(fonte).toEqual({ failures: 4, last_error: 'HTTP 503' });
    expect(await alertas(`kind = 'fonte_falhou' and api_version = $1`, [fonteRuim.id])).toEqual([
      expect.objectContaining({ stage: '2026-09-28', message: 'O Vigia não conseguiu ler "Teste: fora do ar" 3 vezes seguidas (HTTP 503).' }),
    ]);
  });

  it('calendário de versões: uma etapa por vez, sem repetir; aviso de descontinuação vira alerta', async () => {
    await ownerQuery(
      `insert into liame.connector_capability (provider, capability, api_version, source_url, verified_at, sunset_at)
       values ($1, 'accounts', 'v1', 'https://developers.google.com/teste-vigia', '2026-09-26', '2026-11-20')`,
      [PROVIDER],
    );
    await vigia.rodar(new Date('2026-09-26T06:10:00Z'), buscar);
    await vigia.rodar(new Date('2026-09-26T06:10:00Z'), buscar);
    expect(await alertas(`provider = $1 and kind like 'versao%'`, [PROVIDER])).toEqual([
      expect.objectContaining({ kind: 'versao_expirando', stage: '60d', api_version: 'v1', due_date: '2026-11-20', message: 'A versão v1 da API ' + PROVIDER + ' termina em 20/11/2026 (faltam 55 dias). Migrar o conector antes.' }),
    ]);
    await vigia.rodar(new Date('2026-11-21T06:10:00Z'), buscar);
    expect((await alertas(`provider = $1 and kind like 'versao%'`, [PROVIDER])).map((a) => `${a.kind}:${a.stage}`)).toEqual(['versao_expirada:d+1', 'versao_expirando:60d']);

    // Sunset visto numa resposta, mais cedo que o registro: vale a data mais cedo.
    await ownerQuery(
      `insert into liame.api_deprecation_notice (provider, endpoint, api_version, deprecation, sunset, link)
       values ($1, 'properties.get', 'v1', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 'https://developers.google.com/teste-vigia/aviso')`,
      [PROVIDER],
    );
    await vigia.rodar(new Date('2026-09-26T06:10:00Z'), buscar);
    const agora = await alertas(`provider = $1`, [PROVIDER]);
    expect(agora.find((a) => a.kind === 'depreciacao_vista')).toMatchObject({ stage: 'properties_get', message: expect.stringContaining('descontinuado desde 2026-09-01; sai do ar em 2026-10-01') });
    expect(agora.find((a) => a.stage === '7d')).toMatchObject({ kind: 'versao_expirando', due_date: '2026-10-01' });
  });
});
