import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDatabase } from '@liame/database';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { NestFactory } from '@nestjs/core';
import { SpanKind } from '@opentelemetry/api';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { sql } from 'drizzle-orm';
import { PgBoss, fromDrizzle } from 'pg-boss';
import { z } from 'zod';
import { AppModule } from '../app.module.js';
import { buildOpenApiDocument } from '../openapi.js';
import { configureApp } from '../setup.js';
import { memoryExporter } from './span-store.js';

type Status = 'ok' | 'FALHOU' | 'parcial' | 'pulado';
interface Item {
  item: string;
  status: Status;
  detail: string;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export async function run(): Promise<number> {
  const items: Item[] = [];
  const check = async (item: string, fn: () => Promise<{ status?: Status; detail: string }>) => {
    try {
      const r = await fn();
      items.push({ item, status: r.status ?? 'ok', detail: r.detail });
    } catch (err) {
      items.push({ item, status: 'FALHOU', detail: err instanceof Error ? err.message : String(err) });
    }
  };

  const features = process.features as unknown as Record<string, unknown>;
  items.push({
    item: 'runtime',
    status: 'ok',
    detail: `node ${process.versions.node}; server em ${typeof module === 'object' ? 'CommonJS' : 'ESM'}; require(esm) ${features.require_module ? 'ligado' : 'desligado'}`,
  });

  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  items.push({ item: 'Nest 12 carregado', status: 'ok', detail: `API de pé em ${base}` });

  await check('Standard Schema (Zod) na validação', async () => {
    const ok = await fetch(`${base}/v1/auth/password/forgot`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: '  Ninguem.Aqui@Teste.Liame.dev ' }),
    });
    const body = (await ok.json()) as Record<string, unknown>;
    if (ok.status !== 202 || body.status !== 'accepted') {
      throw new Error(`corpo válido: ${ok.status} ${JSON.stringify(body)}`);
    }
    const bad = await fetch(`${base}/v1/auth/password/forgot`, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: 'nao-e-email', extra: 1 }),
    });
    const badBody = (await bad.json()) as { code?: string; errors?: Array<{ path: string }> };
    if (bad.status !== 400) throw new Error(`corpo inválido deveria dar 400, deu ${bad.status}`);
    if (!bad.headers.get('content-type')?.startsWith('application/problem+json') || badBody.code !== 'validacao') {
      throw new Error(`erro fora do RFC 9457: ${JSON.stringify(badBody)}`);
    }
    return { detail: `202 com o corpo válido; 400 RFC 9457 nos campos ${badBody.errors?.map((e) => e.path).join(', ')}` };
  });

  await check('OpenAPI 3.1 com os schemas do Zod', async () => {
    const doc = buildOpenApiDocument(app);
    writeFileSync(join(import.meta.dirname, '..', 'openapi.json'), `${JSON.stringify(doc, null, 2)}\n`);
    if (doc.openapi !== '3.1.0') throw new Error(`versão ${doc.openapi}`);
    const media = doc.paths['/v1/auth/password/forgot']?.post?.requestBody;
    const schema = resolveSchema(doc, media && 'content' in media ? media.content['application/json']?.schema : undefined);
    const props = Object.keys((schema?.properties as Record<string, unknown> | undefined) ?? {});
    if (!props.includes('email')) throw new Error(`requestBody sem "email": ${JSON.stringify(schema)}`);
    if (!doc.paths['/health']) throw new Error('/health fora do documento');
    return { detail: `openapi ${doc.openapi}; corpo com ${props.join(', ')}; gravado em dist/openapi.json` };
  });

  const dbUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  await check('pg + Drizzle 0.45', async () => {
    if (!dbUrl) {
      // Sem banco, a tentativa de conexão ainda mostra se o pg foi instrumentado.
      const { pool, close } = createDatabase({ connectionString: 'postgresql://verificacao:verificacao@127.0.0.1:1/verificacao', max: 1 });
      await pool.query('select 1').catch(() => undefined);
      await close();
      return { status: 'parcial', detail: 'sem TEST_DATABASE_URL: só a tentativa de conexão' };
    }
    const { db, close } = createDatabase({ connectionString: dbUrl, max: 2, applicationName: 'liame-verificacao' });
    try {
      const r = await db.execute(sql`select current_user as usuario`);
      return { detail: `consulta pelo Drizzle como ${String(r.rows[0]?.usuario)}` };
    } finally {
      await close();
    }
  });

  await check('pg-boss 12 carregado', async () => {
    if (typeof PgBoss !== 'function' || typeof fromDrizzle !== 'function') throw new Error('exports ausentes');
    return { detail: 'PgBoss e fromDrizzle disponíveis (o envio transacional roda no teste de banco)' };
  });

  await check('AI SDK 7 (só ESM)', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: 'olá do modelo simulado' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 4, text: 4, reasoning: 0 },
        },
        warnings: [],
      },
    });
    const r = await generateText({ model, prompt: 'oi' });
    if (r.text !== 'olá do modelo simulado') throw new Error(`texto inesperado: ${r.text}`);
    return { detail: 'generateText com modelo simulado' };
  });

  await check('SDK MCP 2.1 (ferramenta com Zod, HTTP sem estado)', async () => {
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'liame-verificacao', version: '0.0.0' });
      server.registerTool(
        'echo',
        { description: 'Devolve o texto recebido', inputSchema: z.object({ text: z.string() }) },
        async ({ text }) => ({ content: [{ type: 'text', text }] }),
      );
      return server;
    });
    try {
      const call = async (id: number, method: string, params: object) => {
        const res = await handler.fetch(
          new Request('http://127.0.0.1/mcp', {
            method: 'POST',
            headers: {
              ...JSON_HEADERS,
              accept: 'application/json, text/event-stream',
              'mcp-protocol-version': '2025-06-18',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
          }),
        );
        return { status: res.status, text: await res.text() };
      };
      const list = await call(1, 'tools/list', {});
      if (!list.text.includes('"echo"')) throw new Error(`tools/list: ${list.status} ${list.text.slice(0, 300)}`);
      const res = await call(2, 'tools/call', { name: 'echo', arguments: { text: 'liame-mcp' } });
      if (!res.text.includes('liame-mcp')) throw new Error(`tools/call: ${res.status} ${res.text.slice(0, 300)}`);
      return { detail: 'tools/list e tools/call pelo createMcpHandler' };
    } finally {
      await handler.close();
    }
  });

  // Ler os spans ANTES de fechar o app: o close desliga o OTel, e o desligamento limpa o exportador.
  const spans = [...memoryExporter.getFinishedSpans()];
  await app.close();

  await check('traces de http, undici e pg', async () => {
    const by = (scope: string) => spans.filter((s) => s.instrumentationScope.name === scope);
    const server = by('@opentelemetry/instrumentation-http').filter((s) => s.kind === SpanKind.SERVER);
    const undici = by('@opentelemetry/instrumentation-undici');
    const pg = by('@opentelemetry/instrumentation-pg');
    const pgNames = [...new Set(pg.map((s) => s.name))].join(', ');
    const detail = `http servidor ${server.length}, undici ${undici.length}, pg ${pg.length} (${pgNames || '—'})`;
    const missing = [server.length ? '' : 'http', undici.length ? '' : 'undici', pg.length ? '' : 'pg'].filter(Boolean);
    if (missing.length) throw new Error(`sem spans de ${missing.join(', ')}; ${detail}`);
    const traces = new Set(undici.map((s) => s.spanContext().traceId));
    const linked = server.some((s) => traces.has(s.spanContext().traceId));
    return { status: linked ? 'ok' : 'parcial', detail: `${detail}; cliente e servidor no mesmo trace: ${linked ? 'sim' : 'não'}` };
  });

  for (const i of items) console.log(`[${i.status}] ${i.item}: ${i.detail}`);
  return items.some((i) => i.status === 'FALHOU') ? 1 : 0;
}

type SchemaLike = { $ref?: string; properties?: unknown } | undefined;

function resolveSchema(doc: { components?: { schemas?: Record<string, unknown> } }, schema: unknown): SchemaLike {
  const s = schema as SchemaLike;
  if (s?.$ref) {
    const name = s.$ref.split('/').pop() ?? '';
    return doc.components?.schemas?.[name] as SchemaLike;
  }
  return s;
}
