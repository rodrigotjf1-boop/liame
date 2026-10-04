import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { esperaDaVirada } from './helpers/virada.js';

// Banco local de testes em C:\Liame\.env.local (fora do git). No CI, as variáveis vêm do workflow.
const envLocal = resolve(process.cwd(), '../../.env.local');
if (existsSync(envLocal)) process.loadEnvFile(envLocal);

// A checagem de senha vazada chama um serviço externo: tem teste próprio com fetch simulado.
process.env.BREACHED_PASSWORD_CHECK ??= 'off';

// O receptor de webhooks e as páginas que o Pesquisador lê nos testes rodam em 127.0.0.1; em produção a rede privada
// é recusada.
process.env.WEBHOOK_ALLOW_PRIVATE_NETWORK ??= 'true';
process.env.PESQUISA_ALLOW_PRIVATE_NETWORK ??= 'true';
if (!process.env.INBOX_SECRETS) {
  const { randomBytes } = await import('node:crypto');
  process.env.INBOX_SECRETS = `teste:whsec_${randomBytes(32).toString('base64')}`;
}

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

// Perto da virada do dia, o arquivo espera ela passar antes de carregar (V89, ERR-092): quem guarda "hoje" na carga
// para semear e conferir termina no mesmo dia em que começou. Longe da meia-noite, não espera nada.
const espera = esperaDaVirada(new Date());
if (espera > 0) {
  console.log(`[testes] a ${Math.round(espera / 1000)} s da virada do dia: este arquivo espera a meia-noite antes de carregar`);
  await new Promise((pronto) => setTimeout(pronto, espera));
}
