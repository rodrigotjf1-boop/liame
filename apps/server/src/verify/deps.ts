// Verificação das dependências no sistema de módulos REAL: `node dist/verify/deps.js` depois do build.
// Nasceu no spike A0-3 e ficou: prova Nest, OpenAPI, pg, pg-boss, AI SDK, MCP e OTel carregando juntos.
// Sem Vitest nem transformação: o mesmo caminho de carga da API em produção.
// O span-store liga o OTel; só depois o import dinâmico carrega o Nest, o http e o pg.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { warnings } from './span-store.js';

// Banco local de testes em C:\Liame\.env.local (fora do git). No CI, as variáveis vêm do workflow.
const envLocal = resolve(import.meta.dirname, '../../../../.env.local');
if (existsSync(envLocal)) process.loadEnvFile(envLocal);

const guard = setTimeout(() => {
  console.error('[dependencias] tempo esgotado (60 s): algum recurso ficou aberto');
  process.exit(2);
}, 60_000);
guard.unref();

try {
  const { run } = await import('./deps-run.js');
  const code = await run();
  console.log(warnings.length ? `avisos do Node: ${warnings.join(' | ')}` : 'avisos do Node: nenhum');
  process.exitCode = code;
} catch (err) {
  console.error('[dependencias] falha inesperada:', err);
  process.exitCode = 1;
}
