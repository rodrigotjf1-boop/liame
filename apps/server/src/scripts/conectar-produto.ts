import 'reflect-metadata';
import { parseArgs } from 'node:util';
import type { Database } from '@liame/database';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { APP_CONFIG, type AppConfig, loadConfig } from '../config.js';
import { registrarConexaoDaDistribuicao } from '../connections/distribuicao.js';
import { DATABASE, DatabaseModule } from '../database/database.module.js';
import { VaultModule } from '../vault/vault.module.js';
import { VaultService } from '../vault/vault.service.js';

// Piloto da A2.5 (D-A2.5-4): a distribuição grava no cofre do Liame o token que emitiu no Regem para uma
// loja (ou no RegemCast para uma conta, F7), sem passar pelo usuário. Roda no contêiner da API (mesmas
// variáveis de ambiente):
//
//   node dist/scripts/conectar-produto.js --empresa <uuid> --marca <uuid> --produto regem < tokens.txt
//   node dist/scripts/conectar-produto.js --empresa <uuid> --marca <uuid> --produto regemcast < tokens.txt
//
// Os tokens entram pela entrada padrão, um por linha: nunca como argumento (histórico do terminal) nem
// em log. Depois, a pessoa liga a loja na tela "Contas conectadas", e a loja do Liame nasce com o nome dela.

@Module({ imports: [DatabaseModule, VaultModule], providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }] })
class DistribuicaoModule {}

async function lerEntrada(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('mande os tokens pela entrada padrão (um por linha), por exemplo: < tokens.txt');
  const partes: Buffer[] = [];
  for await (const parte of process.stdin) partes.push(parte as Buffer);
  return Buffer.concat(partes).toString('utf8');
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { empresa: { type: 'string' }, marca: { type: 'string' }, produto: { type: 'string', default: 'regem' } } });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!values.empresa || !uuid.test(values.empresa) || !values.marca || !uuid.test(values.marca)) {
    throw new Error('uso: conectar-produto --empresa <uuid da empresa no Liame> --marca <uuid da marca> [--produto regem|regemcast] < tokens.txt');
  }
  if (values.produto !== 'regem' && values.produto !== 'regemcast') throw new Error('produtos suportados: regem e regemcast');
  const produto: 'regem' | 'regemcast' = values.produto;
  const tokens = (await lerEntrada()).split(/\r?\n/);

  const app = await NestFactory.createApplicationContext(DistribuicaoModule, { logger: ['error', 'warn'] });
  try {
    const database = app.get<Database | null>(DATABASE);
    if (!database) throw new Error('DATABASE_URL não definida');
    const r = await registrarConexaoDaDistribuicao(
      { db: database.db, vault: app.get(VaultService), config: app.get<AppConfig>(APP_CONFIG) },
      { tenantId: values.empresa, brandId: values.marca, produto, tokens },
    );
    console.log(`conexão ${r.connectionId} registrada com ${r.lojas.length} loja(s): ${r.lojas.map((l) => l.name).join(', ')}`);
    console.log('próximo passo: no Liame, tela Contas conectadas, ligar cada loja (a loja do Liame é criada com o nome dela).');
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(`[conectar-produto] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
