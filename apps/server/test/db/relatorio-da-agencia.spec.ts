import { resolve } from 'node:path';
import { AgencyReportDetailResponse, AgencyReportsResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations, withSystem } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { ExplicarService } from '../../src/ai/explicar/explicar.service.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { criarAssinatura, pagarFatura } from '../../src/cobranca/assinatura.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { EquipeService } from '../../src/equipe/equipe.service.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { remetenteComNome } from '../../src/mail/mailer.js';
import { MediaService } from '../../src/media/media.service.js';
import { AtencaoCicloService } from '../../src/results/atencao-ciclo.service.js';
import { RELATORIO_VERSAO } from '../../src/results/relatorio-mensal.js';
import { ResultsService } from '../../src/results/results.service.js';
import { AssinaturasLoop } from '../../src/worker/assinaturas-loop.js';
import { RelatorioMensalService } from '../../src/worker/relatorio-mensal.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi, TERMOS, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// O relatório do mês que a agência manda ao cliente (A7, W7, parte 4a; P29; D-A7-65 a D-A7-68; D-A7-82), pelo caminho
// inteiro: a lista do mês para quem está no time (e "fora do time" para a dona que não está), a revisão com quem pode
// receber, o envio com o nome da agência no remetente, o "Responder" para ela, o comentário assinado e a versão
// corrigida; o Dono vê o que a agência mandou; e o e-mail do Liame espera a agência até o dia 3, às 9h, e não vai a quem
// já recebeu o da agência.

const SP = 'America/Sao_Paulo';
const REAL = 1_000_000;
// Um mês longe no futuro: a espera do e-mail do Liame (dia 3, às 9h) continua no futuro quando o teste rodar.
const MES = '2030-01';
const GERADO = '2030-02-01T08:10:00.000Z';
const meioDia = (dia: string) => new Date(`${dia}T15:00:00Z`);

type Pessoa = { cookie: string; email: string; userId: string; segredo: string };

function conteudo(brandId: string) {
  return {
    brand_id: brandId,
    month: { from: '2030-01-01', to: '2030-01-31' },
    previous_month: { from: '2029-12-01', to: '2029-12-31' },
    timezone: SP,
    currency: 'BRL',
    generated_at: GERADO,
    totals: [
      { kind: 'investimento', campaign: null, unit: 'dinheiro', before: String(100 * REAL), now: String(120 * REAL), change_pct: '+20.0' },
      { kind: 'pedidos_de_anuncios', campaign: null, unit: 'contagem', before: '10', now: '14', change_pct: '+40.0' },
      { kind: 'receita_confirmada', campaign: null, unit: 'dinheiro', before: String(300 * REAL), now: String(390 * REAL), change_pct: '+30.0' },
      { kind: 'roas_confirmado', campaign: null, unit: 'razao', before: '3.00', now: '3.25', change_pct: '+8.3' },
    ],
    verdict: 'lucro',
    weeks: [],
    campaigns: [],
    platform_only: [],
    improved: [],
    worsened: [],
    decisions: [],
    reading: {
      source: 'sistema',
      reason: 'desligada',
      explanation: {
        what_happened: [{ text: 'Janeiro vendeu mais com menos verba.', number: null }],
        reasons: [],
        risk: 'baixo',
        risk_reason: [{ text: 'os números estão em dia.', number: null }],
        what_to_do: [],
      },
      numbers: [],
      period: { from: '01/01/2030', to: '31/01/2030' },
      compared_to: null,
      stale_sources: [],
      usage_id: null,
      retry_at: null,
      budget_window: null,
      generated_at: GERADO,
    },
  };
}

describe.skipIf(!hasDb)('o relatório do mês que a agência manda ao cliente', () => {
  let api: TestApi;
  let flags: FlagService;
  let database: Database;
  let relatorio: RelatorioMensalService;

  async function codigo(p: { userId: string; segredo: string }): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [p.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${p.userId}`]);
    return totpCode(p.segredo, currentStep());
  }

  async function convidar(cookie: string, rota: string, role: string, nome: string, extra: Record<string, unknown> = {}): Promise<Pessoa> {
    const email = uniqueEmail(role.replace('_', ''));
    const inv = await api.call('POST', rota, { cookie, body: { email, role, ...extra } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const r = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: nome, password: PASSWORD, terms_version: TERMOS } });
    return { cookie: r.cookie!, email, userId: r.body.user.id as string, segredo: (await enableMfa(api, r.cookie!)).secret };
  }

  /** A empresa (Dono, administrador e "só relatórios"), a agência (a dona fora do time e o membro gestor), o vínculo e o relatório de janeiro. */
  async function cenario(nome: string) {
    const s = await signupAndLogin(api, undefined, `Empresa ${nome}`);
    const segredo = (await enableMfa(api, s.cookie)).secret;
    const tenantId = s.me.active_organization_id as string;
    const marca = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0] as { id: string; name: string };
    const e = { cookie: s.cookie, email: s.email, userId: s.me.user.id as string, segredo, tenantId, brandId: marca.id, marca: marca.name };
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [tenantId, SP]);
    const admin = await convidar(e.cookie, '/v1/invitations', 'administrador', 'Ana Lima', { approve_limit_micros: 100 * REAL });
    const relatorios = await convidar(e.cookie, '/v1/invitations', 'so_relatorios', 'Contabilidade Silva');
    const d = await signupAndLogin(api, undefined, `Empresa da dona ${nome}`);
    const aberta = await api.call('POST', '/v1/agencies', { cookie: d.cookie, body: { name: `Agência ${nome}` } });
    const dona = { cookie: d.cookie, email: d.email, userId: d.me.user.id as string, segredo: (await enableMfa(api, d.cookie)).secret, agencyId: aberta.body.active_organization_id as string };
    const membro = await convidar(dona.cookie, '/v1/agency/invitations', 'agencia_membro', 'Juliana Prado');
    await ownerQuery(
      `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'parceiros', 'tenant', $1, 'true'::jsonb, 'testes'),
              (gen_random_uuid(), 'relatorio_email', 'tenant', $1, 'true'::jsonb, 'testes')`,
      [tenantId],
    );
    flags.invalidate();
    const pedido = await api.call('POST', '/v1/agency/requests', { cookie: dona.cookie, body: { owner_email: e.email, requested_role: 'gestor' } });
    const aceito = await api.call('POST', `/v1/partners/requests/${pedido.body.id}/accept`, { cookie: e.cookie, body: { max_role: 'gestor', approve_limit_micros: 50 * REAL, code: await codigo(e) } });
    expect(aceito.status, JSON.stringify(aceito.body)).toBe(200);
    const linkId = pedido.body.id as string;
    expect((await api.call('PUT', `/v1/agency/clients/${linkId}/team`, { cookie: dona.cookie, body: { members: [{ user_id: membro.userId, role: 'gestor' }] } })).status).toBe(200);
    const [r] = await ownerQuery<{ id: string }>(
      `insert into liame.monthly_report (id, tenant_id, brand_id, month_from, month_to, timezone, generated_at, reading_source, reading_reason, content, content_version, email_status, email_next_at)
       values (gen_random_uuid(), $1, $2, '2030-01-01', '2030-01-31', $3, $4::timestamptz, 'sistema', 'desligada', $5::jsonb, $6, 'pendente', '2030-02-01T12:00:00Z')
       returning id`,
      [tenantId, marca.id, SP, GERADO, JSON.stringify(conteudo(marca.id)), RELATORIO_VERSAO],
    );
    return { e, admin, relatorios, dona, membro, linkId, reportId: r!.id, agencia: `Agência ${nome}` };
  }

  const lista = (p: { cookie: string }) => api.call('GET', `/v1/agency/reports?month=${MES}`, { cookie: p.cookie });
  const detalhe = (p: { cookie: string }, linkId: string, reportId: string) => api.call('GET', `/v1/agency/clients/${linkId}/reports/${reportId}`, { cookie: p.cookie });
  const mandar = (p: { cookie: string }, linkId: string, reportId: string, body: Record<string, unknown>) =>
    api.call('POST', `/v1/agency/clients/${linkId}/reports/${reportId}/send`, { cookie: p.cookie, body });

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    flags = api.app.get(FlagService);
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    relatorio = new RelatorioMensalService(
      database,
      api.app.get(ResultsService),
      api.app.get(MediaService),
      api.app.get(AtencaoCicloService),
      api.app.get(ExplicarService),
      flags,
      api.app.get(BudgetService),
      api.app.get(EquipeService),
      api.app.get<AppConfig>(APP_CONFIG),
      api.mailer,
    );
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  it('a lista do mês e a revisão: quem está no time vê o relatório esperando; a dona fora do time, não; quem pode receber', async () => {
    const c = await cenario('Brasa da Lista');
    const doMembro = await lista(c.membro);
    expect(doMembro.status, JSON.stringify(doMembro.body)).toBe(200);
    const corpo = AgencyReportsResponse.parse(doMembro.body);
    expect(corpo.month).toBe(MES);
    expect(corpo.items).toEqual([
      expect.objectContaining({
        link_id: c.linkId,
        brand: { id: c.e.brandId, name: c.e.marca },
        report_id: c.reportId,
        state: 'esperando',
        last_send: null,
        // O dia 3 de fevereiro, às 9h em São Paulo (12h UTC).
        liame_email_waits_until: '2030-02-03T12:00:00.000Z',
      }),
    ]);
    const daDona = AgencyReportsResponse.parse((await lista(c.dona)).body);
    expect(daDona.items).toEqual([expect.objectContaining({ link_id: c.linkId, state: 'fora_do_time', brand: null, report_id: null })]);
    expect((await detalhe(c.dona, c.linkId, c.reportId)).body.code).toBe('sem-acesso-ao-relatorio');

    const rev = await detalhe(c.membro, c.linkId, c.reportId);
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
    const d = AgencyReportDetailResponse.parse(rev.body);
    expect(d.can_send).toBe(true);
    expect(d.agency).toEqual({ name: c.agencia, logo_url: null, reply_to: null });
    expect(d.report.id).toBe(c.reportId);
    expect(d.recipients.map((p) => [p.name, p.role, p.always])).toEqual([
      [expect.any(String), 'dono', true],
      ['Ana Lima', 'administrador', false],
      ['Contabilidade Silva', 'so_relatorios', false],
    ]);
    // Ninguém da agência entra na lista de quem recebe.
    expect(d.recipients.some((p) => p.user_id === c.membro.userId)).toBe(false);
  });

  it('mandar: o Dono e quem a agência escolhe recebem, com o nome da agência e o "Responder" para ela; mandar de novo é a versão corrigida', async () => {
    const c = await cenario('Brasa do Envio');
    const resposta = uniqueEmail('contato');
    await ownerQuery(`insert into liame.agency_brand (tenant_id, reply_to_email, reply_to_confirmed_at) values ($1, $2, now())`, [c.dona.agencyId, resposta]);

    expect((await mandar(c.membro, c.linkId, c.reportId, { recipient_ids: [c.membro.userId] })).body.code).toBe('destinatario-fora');
    const antes = api.mailer.sent.length;
    const enviado = await mandar(c.membro, c.linkId, c.reportId, { comment: '  Janeiro foi o melhor mês.\nEm fevereiro, o Google.  ', recipient_ids: [c.admin.userId] });
    expect(enviado.status, JSON.stringify(enviado.body)).toBe(200);
    expect(enviado.body).toMatchObject({ version: 1, recipients: 2, failed: 0 });
    const emails = api.mailer.sent.slice(antes);
    expect(emails.map((m) => m.to).sort()).toEqual([c.e.email, c.admin.email].sort());
    const doDono = emails.find((m) => m.to === c.e.email)!;
    expect(doDono.subject).toBe(`${c.agencia}: o relatório de janeiro da ${c.e.marca}`);
    expect(doDono.fromName).toBe(`${c.agencia} pelo Liame`);
    expect(doDono.replyTo).toBe(resposta);
    expect(doDono.text).toContain(`preparado por ${c.agencia}, com o Liame`);
    expect(doDono.text).toContain('Janeiro foi o melhor mês.\nEm fevereiro, o Google.');
    expect(doDono.text).toContain(`— Juliana Prado, ${c.agencia}`);
    expect(doDono.text).toContain('a resposta vai para a agência');
    expect(doDono.html).toContain('preparado por');
    expect(doDono.html).toContain('Juliana Prado');
    // A auditoria da agência guarda o envio, sem o comentário.
    const [evento] = await ownerQuery<{ after: Record<string, unknown> }>(
      `select after from liame.audit_event where tenant_id = $1 and action = 'agencia.relatorio_mandar' order by chain_seq desc limit 1`,
      [c.dona.agencyId],
    );
    expect(evento!.after).toMatchObject({ version: 1, recipients: 2, comment: true });

    // O mesmo clique duas vezes não manda duas.
    expect((await mandar(c.membro, c.linkId, c.reportId, { recipient_ids: [] })).body.code).toBe('acabou-de-mandar');
    await ownerQuery(`update liame.agency_report_send set created_at = now() - interval '2 minutes' where report_id = $1`, [c.reportId]);
    const denovo = await mandar(c.membro, c.linkId, c.reportId, { recipient_ids: [] });
    expect(denovo.body).toMatchObject({ version: 2, recipients: 1 });
    expect(api.mailer.lastTo(c.e.email)!.subject).toBe(`${c.agencia}: o relatório de janeiro da ${c.e.marca} (versão corrigida)`);
    expect(api.mailer.lastTo(c.e.email)!.text).toContain('Esta é uma versão corrigida');

    // A revisão mostra os envios; a lista, o último.
    const rev = AgencyReportDetailResponse.parse((await detalhe(c.membro, c.linkId, c.reportId)).body);
    expect(rev.sends.map((s) => [s.version, s.sent_by_name, s.sent_to.length, s.comment !== null])).toEqual([
      [2, 'Juliana Prado', 1, false],
      [1, 'Juliana Prado', 2, true],
    ]);
    expect(AgencyReportsResponse.parse((await lista(c.membro)).body).items[0]).toMatchObject({ state: 'mandado', last_send: { version: 2 }, liame_email_waits_until: null });

    // O Dono vê o que a agência mandou no relatório do mês.
    const doDonoNaTela = await api.call('GET', `/v1/results/monthly-report?brand_id=${c.e.brandId}&month=${MES}`, { cookie: c.e.cookie });
    expect(doDonoNaTela.status, JSON.stringify(doDonoNaTela.body)).toBe(200);
    expect(doDonoNaTela.body.from_agency).toMatchObject({ agency_name: c.agencia, version: 2, sent_by_name: 'Juliana Prado', comment: null, logo_url: null });
  });

  it('o e-mail do Liame espera a agência até o dia 3, às 9h, e não vai a quem recebeu o dela', async () => {
    const c = await cenario('Brasa da Espera');
    // Dia 2, meio-dia: a agência ainda não mandou; o e-mail do Liame espera e olha de novo em uma hora.
    expect(await relatorio.enviar(c.reportId, new Date('2030-02-02T15:00:00Z'))).toEqual({ status: 'pendente', enviados: 0 });
    const [m] = await ownerQuery<{ email_next_at: Date }>(`select email_next_at from liame.monthly_report where id = $1`, [c.reportId]);
    expect(new Date(m!.email_next_at).toISOString()).toBe('2030-02-02T16:00:00.000Z');

    // A agência manda ao Dono e ao administrador; o do Liame vai só a quem não recebeu o dela.
    expect((await mandar(c.membro, c.linkId, c.reportId, { recipient_ids: [c.admin.userId] })).status).toBe(200);
    const antes = api.mailer.sent.length;
    expect(await relatorio.enviar(c.reportId, new Date('2030-02-02T16:00:00Z'))).toMatchObject({ status: 'enviado', enviados: 1 });
    expect(api.mailer.sent.slice(antes).map((x) => x.to)).toEqual([c.relatorios.email]);

    // Sem a agência mandar, no dia 3 às 9h a espera acaba e o do Liame vai a todos.
    const s = await cenario('Brasa Sem Envio');
    expect(await relatorio.enviar(s.reportId, new Date('2030-02-03T11:59:00Z'))).toEqual({ status: 'pendente', enviados: 0 });
    const [n] = await ownerQuery<{ email_next_at: Date }>(`select email_next_at from liame.monthly_report where id = $1`, [s.reportId]);
    expect(new Date(n!.email_next_at).toISOString()).toBe('2030-02-03T12:00:00.000Z');
    const antes2 = api.mailer.sent.length;
    expect(await relatorio.enviar(s.reportId, new Date('2030-02-03T12:00:00Z'))).toMatchObject({ status: 'enviado', enviados: 3 });
    expect(api.mailer.sent.slice(antes2).map((x) => x.to).sort()).toEqual([s.e.email, s.admin.email, s.relatorios.email].sort());
  });

  it('com a marca suspensa, o relatório fica só com o Dono: a agência não manda', async () => {
    const c = await cenario('Brasa Suspensa');
    await ownerQuery(
      `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'cobranca', 'tenant', $1, 'true'::jsonb, 'testes')`,
      [c.e.tenantId],
    );
    flags.invalidate();
    // Assinada em 21/10/2026, paga a primeira e, sem pagar a de 22/11, suspensa no 30º dia (22/12), pela rotina.
    const [plano] = await ownerQuery<{ id: string }>(`select id from liame.billing_plan where key = 'essencial' and offered`);
    await withSystem(database.db, (tx) =>
      criarAssinatura(tx, { tenantId: c.e.tenantId, brandId: c.e.brandId, planoId: plano!.id, forma: 'pix', quem: c.e.userId, agora: meioDia('2026-10-21') }),
    );
    const [f] = await ownerQuery<{ id: string }>(`select id from liame.billing_invoice where brand_id = $1 and status = 'aberta' order by due_date limit 1`, [c.e.brandId]);
    await withSystem(database.db, (tx) => pagarFatura(tx, { faturaId: f!.id, pagoEm: meioDia('2026-10-22'), forma: 'pix', agora: meioDia('2026-10-22') }));
    const rotina = new AssinaturasLoop(database, flags);
    for (const dia of ['2026-11-17', '2026-12-22']) {
      await ownerQuery(`update liame.subscription set next_check_at = $2 where tenant_id = $1 and status <> 'encerrada'`, [c.e.tenantId, meioDia(dia).toISOString()]);
      await rotina.executarLote(20, { tenantIds: [c.e.tenantId] }, meioDia(dia));
    }
    const item = AgencyReportsResponse.parse((await lista(c.membro)).body).items[0]!;
    expect(item).toMatchObject({ state: 'suspensa', suspended_since: '2026-12-22', owner_name: expect.any(String) });
    expect((await detalhe(c.membro, c.linkId, c.reportId)).body.can_send).toBe(false);
    expect((await mandar(c.membro, c.linkId, c.reportId, { recipient_ids: [] })).body.code).toBe('conta-suspensa');
  });

  it('o remetente com o nome da agência: acento em MIME, sem quebrar o cabeçalho', () => {
    expect(remetenteComNome('Liame <nao-responda@agencialiame.com>', 'Agência Fogo pelo Liame')).toBe(
      `=?UTF-8?B?${Buffer.from('Agência Fogo pelo Liame').toString('base64')}?= <nao-responda@agencialiame.com>`,
    );
    expect(remetenteComNome('nao-responda@agencialiame.com', 'X\r\nBcc: alguem@x.com <y>')).toBe(
      `=?UTF-8?B?${Buffer.from('X Bcc: alguem@x.com y').toString('base64')}?= <nao-responda@agencialiame.com>`,
    );
  });
});
