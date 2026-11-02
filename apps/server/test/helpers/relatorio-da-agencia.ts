import { expect } from 'vitest';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import type { FlagService } from '../../src/flags/flag.service.js';
import { RELATORIO_VERSAO } from '../../src/results/relatorio-mensal.js';
import { enableMfa, ownerQuery, PASSWORD, signupAndLogin, type TestApi, TERMOS, tokenFrom, uniqueEmail } from './api.js';

// O cenário do relatório que a agência manda (A7, W7, partes 4a e 4b): a empresa com o Dono, um administrador e um "só
// relatórios"; a agência com a dona (fora do time do cliente) e um membro no time como Gestor; o vínculo aceito; e o
// relatório de janeiro de 2030 já gerado (um mês longe no futuro: as janelas dos dias 2 e 3 continuam no futuro quando
// o teste rodar, e os testes da rotina passam o relógio).

export const SP = 'America/Sao_Paulo';
const REAL = 1_000_000;
export const MES_DO_RELATORIO = '2030-01';
export const GERADO_EM = '2030-02-01T08:10:00.000Z';

export type PessoaDoCenario = { cookie: string; email: string; userId: string; segredo: string };

/** Um relatório do mês com o mínimo que a tela e o e-mail leem. */
export function conteudoDoRelatorio(brandId: string) {
  return {
    brand_id: brandId,
    month: { from: '2030-01-01', to: '2030-01-31' },
    previous_month: { from: '2029-12-01', to: '2029-12-31' },
    timezone: SP,
    currency: 'BRL',
    generated_at: GERADO_EM,
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
      generated_at: GERADO_EM,
    },
  };
}

async function codigo(p: { userId: string; segredo: string }): Promise<string> {
  await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [p.userId]);
  await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${p.userId}`]);
  return totpCode(p.segredo, currentStep());
}

async function convidar(api: TestApi, cookie: string, rota: string, role: string, nome: string, extra: Record<string, unknown> = {}): Promise<PessoaDoCenario> {
  const email = uniqueEmail(role.replace('_', ''));
  const inv = await api.call('POST', rota, { cookie, body: { email, role, ...extra } });
  expect(inv.status, JSON.stringify(inv.body)).toBe(201);
  const r = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: nome, password: PASSWORD, terms_version: TERMOS } });
  return { cookie: r.cookie!, email, userId: r.body.user.id as string, segredo: (await enableMfa(api, r.cookie!)).secret };
}

export async function cenarioDaAgencia(api: TestApi, flags: FlagService, nome: string) {
  const s = await signupAndLogin(api, undefined, `Empresa ${nome}`);
  const segredo = (await enableMfa(api, s.cookie)).secret;
  const tenantId = s.me.active_organization_id as string;
  const marca = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0] as { id: string; name: string };
  const e = { cookie: s.cookie, email: s.email, userId: s.me.user.id as string, segredo, tenantId, brandId: marca.id, marca: marca.name };
  await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [tenantId, SP]);
  const admin = await convidar(api, e.cookie, '/v1/invitations', 'administrador', 'Ana Lima', { approve_limit_micros: 100 * REAL });
  const relatorios = await convidar(api, e.cookie, '/v1/invitations', 'so_relatorios', 'Contabilidade Silva');
  const d = await signupAndLogin(api, undefined, `Empresa da dona ${nome}`);
  const aberta = await api.call('POST', '/v1/agencies', { cookie: d.cookie, body: { name: `Agência ${nome}` } });
  const dona = { cookie: d.cookie, email: d.email, userId: d.me.user.id as string, segredo: (await enableMfa(api, d.cookie)).secret, agencyId: aberta.body.active_organization_id as string };
  const membro = await convidar(api, dona.cookie, '/v1/agency/invitations', 'agencia_membro', 'Juliana Prado');
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
    [tenantId, marca.id, SP, GERADO_EM, JSON.stringify(conteudoDoRelatorio(marca.id)), RELATORIO_VERSAO],
  );
  return { e, admin, relatorios, dona, membro, linkId, reportId: r!.id, agencia: `Agência ${nome}` };
}
