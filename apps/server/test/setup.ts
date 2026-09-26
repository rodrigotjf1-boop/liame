import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Banco local de testes em C:\Liame\.env.local (fora do git). No CI, as variáveis vêm do workflow.
const envLocal = resolve(process.cwd(), '../../.env.local');
if (existsSync(envLocal)) process.loadEnvFile(envLocal);

// A checagem de senha vazada chama um serviço externo: tem teste próprio com fetch simulado.
process.env.BREACHED_PASSWORD_CHECK ??= 'off';

// Chave mestra local só para testes (o CI gera outra a cada execução).
if (!process.env.LIAME_KEK_LOCAL) {
  const { randomBytes } = await import('node:crypto');
  process.env.LIAME_KEK_LOCAL = `1:${randomBytes(32).toString('base64')}`;
}

// Nos testes, a API usa sempre o banco de testes (nunca o liame_dev).
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.DATABASE_URL_JOBS = process.env.TEST_DATABASE_URL_OWNER;
} else {
  delete process.env.DATABASE_URL;
  delete process.env.DATABASE_URL_JOBS;
}
