import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Banco local de testes em C:\Liame\.env.local (fora do git). No CI, as variáveis vêm do workflow.
const envLocal = resolve(process.cwd(), '../../.env.local');
if (existsSync(envLocal)) process.loadEnvFile(envLocal);
