import { randomBytes } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { SpanKind } from '@opentelemetry/api';
import type { InMemorySpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { BudgetService } from '../actions/budget.service.js';
import { AppModule } from '../app.module.js';
import { currentStep, totpCode } from '../auth/totp.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { KillSwitchService } from '../kill-switch/kill-switch.service.js';
import { Mailer, type MemoryMailer } from '../mail/mailer.js';
import { configureApp } from '../setup.js';
import { ActionExecutor } from '../worker/action-executor.js';

// Dado pessoal plantado onde o OTel captura (query string e User-Agent): não pode sair nos spans.
const PHONE = '+55 21 99876-5432';
const PII = [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, /99876-?5432/];
/** Endereço de quem chamou (pessoa): sai mascarado. O do servidor chamado (`server.address`) não é dado pessoal. */
const PERSON_IP_KEYS = ['client.address', 'net.peer.ip', 'http.client_ip', 'network.peer.address', 'net.sock.peer.addr'];

export async function run(exporter: InMemorySpanExporter): Promise<number> {
  const results: Array<{ item: string; ok: boolean; detail: string }> = [];
  const check = (item: string, ok: boolean, detail: string) => results.push({ item, ok, detail });

  const app = await NestFactory.create(AppModule, { logger: ['error'], rawBody: true });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const mailer = app.get(Mailer) as MemoryMailer;
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie, 'user-agent': `verificacao ${PHONE}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0]!;
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  try {
    const email = `rastreio.${randomBytes(4).toString('hex')}@teste.liame.dev`;
    const password = 'uma frase longa de verificação';
    await call('POST', '/v1/auth/signup', { name: 'Pessoa do Rastreio', email, password, company: { name: 'Empresa do Rastreio' } });
    const token = /token=([A-Za-z0-9_-]+)/.exec(mailer.lastTo(email)?.text ?? '')?.[1];
    await call('POST', '/v1/auth/verify-email', { token });
    const login = await call('POST', '/v1/auth/login', { email, password });
    const tenantId = login.body.active_organization_id as string;
    const setup = await call('POST', '/v1/me/mfa/totp/setup');
    await call('POST', '/v1/me/mfa/totp/confirm', { code: totpCode(setup.body.secret, currentStep()) });
    // E-mail na query string: a redação tem de tirar.
    await call('GET', `/v1/brands?include_archived=false&email=${encodeURIComponent(email)}`);
    await call('PUT', '/v1/sandbox/resources', { account_id: 'act_1', resource_id: 'camp_1', state: { daily_budget_micros: 100_000_000 } });
    await call('POST', '/v1/policies', { document: { rules: [{ type: 'autonomy', mode: 'APPROVAL' }] } });
    const pedido = await call('POST', '/v1/actions', {
      tool: 'orcamento_ajustar',
      provider: 'sandbox',
      account_id: 'act_1',
      resource_id: 'camp_1',
      params: { daily_budget_micros: 110_000_000 },
    });
    const aprovado = await call('POST', `/v1/actions/${pedido.body.id}/approve`, { plan_hash: pedido.body.plan_hash, code: totpCode(setup.body.secret, currentStep() + 1) });
    check('fluxo da ação pela API', aprovado.body?.status === 'aprovada', `pedido ${pedido.status}, aprovação ${aprovado.body?.status}`);

    // O worker, fora de qualquer span ativo: o trace só continua se o traceparent veio pelo banco.
    const executor = new ActionExecutor(app.get(DATABASE), app.get(BudgetService), app.get(KillSwitchService), app.get(FlagService));
    await executor.executeBatch(5, { tenantIds: [tenantId] });

    const spans = exporter.getFinishedSpans();
    const api = spans.find((s) => s.kind === SpanKind.SERVER && s.attributes['http.route'] === '/v1/actions' && s.attributes['http.request.method'] === 'POST')
      ?? spans.find((s) => s.kind === SpanKind.SERVER && String(s.attributes['http.target'] ?? s.attributes['url.path'] ?? '').startsWith('/v1/actions') && String(s.attributes['http.method'] ?? s.attributes['http.request.method']) === 'POST');
    const exec = spans.find((s) => s.name === 'acao.executar');
    const applied = spans.find((s) => s.name === 'conector.aplicar');
    const policy = spans.find((s) => s.name === 'politica.avaliar');
    const traceOf = (s?: ReadableSpan) => s?.spanContext().traceId;
    check('span da requisição que pediu a ação', Boolean(api), api ? `trace ${traceOf(api)}` : 'não achei o span POST /v1/actions');
    check('política no mesmo trace da requisição', Boolean(policy) && traceOf(policy) === traceOf(api), `${traceOf(policy)}`);
    check('execução no worker continua o trace da requisição', Boolean(exec) && traceOf(exec) === traceOf(api), `${traceOf(exec)}`);
    check('conector no mesmo trace e filho da execução', Boolean(applied) && traceOf(applied) === traceOf(api) && hasAncestor(spans, applied!, exec!), `${traceOf(applied)}`);
    const pgInWorker = spans.filter((s) => traceOf(s) === traceOf(exec) && String(s.name).startsWith('pg'));
    check('consultas do worker no mesmo trace', pgInWorker.length > 0, `${pgInWorker.length} spans do pg`);

    const leaks: string[] = [];
    for (const s of spans) {
      const text = JSON.stringify({ name: s.name, attributes: s.attributes, events: s.events.map((e) => ({ n: e.name, a: e.attributes })) });
      for (const re of PII) {
        if (!re.test(text)) continue;
        const keys = Object.entries(s.attributes).filter(([, v]) => typeof v === 'string' && re.test(v)).map(([k]) => k);
        leaks.push(`${s.name} (${SpanKind[s.kind]}): ${keys.join(',') || 'nome/eventos'}`);
      }
    }
    const servers = spans.filter((s) => s.kind === SpanKind.SERVER);
    for (const s of servers) {
      for (const key of PERSON_IP_KEYS) {
        const v = s.attributes[key];
        if (typeof v === 'string' && /\b127\.0\.0\.1\b/.test(v)) leaks.push(`${s.name}: ${key} sem máscara`);
      }
    }
    const masked = servers.some((s) => PERSON_IP_KEYS.some((k) => s.attributes[k] === '127.0.0.0'));
    check(
      'nenhum e-mail, telefone ou IP de pessoa nos spans exportados',
      leaks.length === 0 && masked,
      leaks.length ? leaks.slice(0, 5).join(' | ') : `${spans.length} spans conferidos; IP de quem chamou mascarado: ${masked}`,
    );
  } finally {
    await app.close();
  }

  const width = Math.max(...results.map((r) => r.item.length));
  for (const r of results) console.log(`${r.ok ? 'ok     ' : 'FALHOU '} ${r.item.padEnd(width)}  ${r.detail}`);
  return results.every((r) => r.ok) ? 0 : 1;
}

function hasAncestor(spans: ReadableSpan[], child: ReadableSpan, ancestor: ReadableSpan): boolean {
  const byId = new Map(spans.map((s) => [s.spanContext().spanId, s]));
  let parent = child.parentSpanContext?.spanId;
  for (let depth = 0; parent && depth < 20; depth++) {
    if (parent === ancestor.spanContext().spanId) return true;
    parent = byId.get(parent)?.parentSpanContext?.spanId;
  }
  return false;
}
