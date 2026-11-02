import { resolve } from 'node:path';
import { AgencyReportsResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { RelatorioDaAgenciaRotina } from '../../src/worker/relatorio-da-agencia.service.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { cenarioDaAgencia, MES_DO_RELATORIO } from '../helpers/relatorio-da-agencia.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// O relatório da agência sem a agência por perto (A7, W7, parte 4b; D-A7-67; D-A7-83), pela rotina do worker com o
// relógio do teste: no dia 2, às 9h em São Paulo (12h UTC), a agência que escolheu "sai sozinho" manda a todos que
// podem receber, sem comentário, uma vez; no dia 3, às 8h (11h UTC), o time da agência que revisa e não mandou recebe
// um lembrete, uma vez; nada depois do dia 7, nada com a função `parceiros` desligada, e nada para quem já mandou.

describe.skipIf(!hasDb)('o envio sozinho do dia 2 e o lembrete do dia 3', () => {
  let api: TestApi;
  let flags: FlagService;
  let database: Database;
  let rotina: RelatorioDaAgenciaRotina;

  const cenario = (nome: string) => cenarioDaAgencia(api, flags, nome);
  const sozinho = async (agencyId: string) =>
    ownerQuery(`insert into liame.agency_brand (tenant_id, report_mode) values ($1, 'sozinho') on conflict (tenant_id) do update set report_mode = 'sozinho'`, [agencyId]);
  const so = (tenantId: string) => ({ tenantIds: [tenantId] });

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    flags = api.app.get(FlagService);
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    rotina = new RelatorioDaAgenciaRotina(database, flags, api.mailer, api.app.get<AppConfig>(APP_CONFIG));
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  it('"sai sozinho": no dia 2, às 9h, a todos que podem receber, sem comentário e uma vez só; nada depois do dia 7', async () => {
    const c = await cenario('Brasa Sozinha');
    await sozinho(c.dona.agencyId);
    expect(await rotina.enviarSozinhosLote(20, so(c.e.tenantId), new Date('2030-02-02T11:59:00Z'))).toEqual([]);
    // Lembrete não é para quem escolheu "sai sozinho".
    expect(await rotina.lembretesLote(20, so(c.e.tenantId), new Date('2030-02-02T11:59:00Z'))).toEqual([]);

    const antes = api.mailer.sent.length;
    expect(await rotina.enviarSozinhosLote(20, so(c.e.tenantId), new Date('2030-02-02T12:00:00Z'))).toEqual([
      { reportId: c.reportId, agencyId: c.dona.agencyId, status: 'mandado', pessoas: 3 },
    ]);
    const emails = api.mailer.sent.slice(antes);
    expect(emails.map((m) => m.to).sort()).toEqual([c.e.email, c.admin.email, c.relatorios.email].sort());
    const doDono = emails.find((m) => m.to === c.e.email)!;
    expect(doDono.subject).toBe(`${c.agencia}: o relatório de janeiro da ${c.e.marca}`);
    expect(doDono.fromName).toBe(`${c.agencia} pelo Liame`);
    expect(doDono.text).not.toContain('—');
    const [envio] = await ownerQuery<{ mode: string; version: number; sent_by: string | null; comment: string | null }>(
      `select mode, version, sent_by, comment from liame.agency_report_send where report_id = $1`,
      [c.reportId],
    );
    expect(envio).toEqual({ mode: 'sozinho', version: 1, sent_by: null, comment: null });
    const [evento] = await ownerQuery<{ action: string; actor_type: string }>(
      `select action, actor_type from liame.audit_event where tenant_id = $1 and action = 'agencia.relatorio_sozinho'`,
      [c.dona.agencyId],
    );
    expect(evento).toEqual({ action: 'agencia.relatorio_sozinho', actor_type: 'system' });

    // Uma vez só; e a lista da agência mostra o envio sozinho.
    expect(await rotina.enviarSozinhosLote(20, so(c.e.tenantId), new Date('2030-02-02T13:00:00Z'))).toEqual([]);
    const lista = AgencyReportsResponse.parse((await api.call('GET', `/v1/agency/reports?month=${MES_DO_RELATORIO}`, { cookie: c.membro.cookie })).body);
    expect(lista.items[0]).toMatchObject({ state: 'mandado', last_send: { version: 1, mode: 'sozinho', sent_by_name: null, recipients: 3 } });

    // Depois do dia 7 (o dia 8 começa às 3h UTC), o relatório já não é notícia.
    const tarde = await cenario('Brasa Atrasada');
    await sozinho(tarde.dona.agencyId);
    expect(await rotina.enviarSozinhosLote(20, so(tarde.e.tenantId), new Date('2030-02-08T03:00:00Z'))).toEqual([]);
    expect(await rotina.enviarSozinhosLote(20, so(tarde.e.tenantId), new Date('2030-02-08T02:59:00Z'))).toMatchObject([{ status: 'mandado' }]);
  });

  it('o lembrete do dia 3, às 8h: ao time da agência no cliente, uma vez; não para quem já mandou nem com a função desligada', async () => {
    const c = await cenario('Brasa Lembrada');
    expect(await rotina.lembretesLote(20, so(c.e.tenantId), new Date('2030-02-03T10:59:00Z'))).toEqual([]);
    const antes = api.mailer.sent.length;
    expect(await rotina.lembretesLote(20, so(c.e.tenantId), new Date('2030-02-03T11:00:00Z'))).toEqual([
      { reportId: c.reportId, agencyId: c.dona.agencyId, status: 'lembrado', pessoas: 1 },
    ]);
    const emails = api.mailer.sent.slice(antes);
    // Só quem está no time do cliente: a dona da agência, fora do time, não recebe.
    expect(emails.map((m) => m.to)).toEqual([c.membro.email]);
    expect(emails[0]!.subject).toBe(`Liame: o relatório de janeiro da ${c.e.marca} espera você`);
    expect(emails[0]!.text).toContain('/agencia/relatorios');
    expect(emails[0]!.text).toContain('sai hoje, às 9h');
    expect(await rotina.lembretesLote(20, so(c.e.tenantId), new Date('2030-02-03T12:00:00Z'))).toEqual([]);
    expect(await ownerQuery(`select recipients from liame.agency_report_reminder where report_id = $1`, [c.reportId])).toEqual([{ recipients: 1 }]);

    // Quem já mandou não recebe lembrete.
    const mandou = await cenario('Brasa Que Mandou');
    const r = await api.call('POST', `/v1/agency/clients/${mandou.linkId}/reports/${mandou.reportId}/send`, { cookie: mandou.membro.cookie, body: { recipient_ids: [] } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await rotina.lembretesLote(20, so(mandou.e.tenantId), new Date('2030-02-03T11:00:00Z'))).toEqual([]);

    // Com a função `parceiros` desligada na empresa, nada sai (nem o envio sozinho).
    const desligada = await cenario('Brasa Desligada');
    await ownerQuery(`update liame.feature_flag_rule set value = 'false'::jsonb where flag_key = 'parceiros' and scope_id = $1`, [desligada.e.tenantId]);
    flags.invalidate();
    expect(await rotina.lembretesLote(20, so(desligada.e.tenantId), new Date('2030-02-03T11:00:00Z'))).toMatchObject([{ status: 'pulado' }]);
    await sozinho(desligada.dona.agencyId);
    expect(await rotina.enviarSozinhosLote(20, so(desligada.e.tenantId), new Date('2030-02-02T12:00:00Z'))).toMatchObject([{ status: 'pulado' }]);
    expect(await ownerQuery(`select 1 from liame.agency_report_send where report_id = $1`, [desligada.reportId])).toEqual([]);
  });
});
