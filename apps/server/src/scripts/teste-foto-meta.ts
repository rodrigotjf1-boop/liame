import 'reflect-metadata';
import { parseArgs } from 'node:util';
import type { Database } from '@liame/database';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig, loadConfig } from '../config.js';
import { testarFotoNaMeta, VALIDADE_DO_ENDERECO_DO_TESTE_S } from '../connectors/meta/teste-da-foto.js';
import { DATABASE, DatabaseModule } from '../database/database.module.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens } from '../imagens/armazem.js';
import { ArmazemModule } from '../imagens/armazem.module.js';
import { VaultModule } from '../vault/vault.module.js';
import { VaultService } from '../vault/vault.service.js';

// O teste da D-A6-10 (A6 · Z5), antes do código dos posts: a Meta aceita buscar a foto no endereço assinado que vale
// poucos minutos? Cria o rascunho de um post do Instagram com uma foto da empresa e confere se a Meta baixou a imagem.
// NUNCA publica: o rascunho vence sozinho em 24 horas, e ninguém o vê. Só com a ordem do dono, e com quem pediu e o
// porquê na auditoria da empresa (`connectors/meta/teste-da-foto.ts`). Roda no contêiner da API (as mesmas variáveis:
// o banco, o cofre, o armazenamento e o segredo do app da Meta):
//
//   node dist/scripts/teste-foto-meta.js --empresa <uuid> --por "Nome" --motivo "teste da D-A6-10, pedido pelo dono"
//   (opcional: --foto <uuid da foto>; sem ele, a foto mais nova que cabe na proporção do Instagram)
//
// Saída 0: a Meta baixou a foto. Saída 2: a Meta não aceitou (o motivo dela na tela). Saída 1: o teste não chegou a
// rodar (o porquê na tela).

const USO = 'uso: teste-foto-meta --empresa <uuid da empresa no Liame> [--foto <uuid da foto>] --por "<quem pediu>" --motivo "<por quê>"';

@Module({ imports: [DatabaseModule, VaultModule, ArmazemModule], providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }] })
class TesteDaFotoModule {}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { empresa: { type: 'string' }, foto: { type: 'string' }, por: { type: 'string' }, motivo: { type: 'string' } } });
  const empresa = z.uuid().safeParse(values.empresa);
  const foto = values.foto === undefined ? null : z.uuid().safeParse(values.foto);
  if (!empresa.success || (foto && !foto.success) || !values.por?.trim() || !values.motivo?.trim()) throw new Error(USO);

  const app = await NestFactory.createApplicationContext(TesteDaFotoModule, { logger: ['error', 'warn'] });
  try {
    const database = app.get<Database | null>(DATABASE);
    if (!database) throw new Error('DATABASE_URL não definida');
    const config = app.get<AppConfig>(APP_CONFIG);
    const r = await testarFotoNaMeta(
      {
        db: database.db,
        vault: app.get(VaultService),
        armazem: app.get<ArmazemDeImagens>(ARMAZEM_DE_IMAGENS),
        meta: { base: config.plataformas.metaGraphUrl, appSecret: config.plataformas.metaAppSecret },
      },
      { tenantId: empresa.data, fotoId: foto?.success ? foto.data : null, por: values.por.trim().slice(0, 80), motivo: values.motivo.trim().slice(0, 300) },
    );
    console.log(`Instagram: ${r.instagram} (Página ${r.pagina}); foto ${r.foto.id} (${r.foto.largura} x ${r.foto.altura} px)`);
    if (r.situacao === 'pronto') {
      console.log(
        `RESULTADO: a Meta BAIXOU a foto pelo endereço de ${VALIDADE_DO_ENDERECO_DO_TESTE_S / 60} minutos. Rascunho ${String(r.conteiner)} pronto e NÃO publicado: vence sozinho em 24 horas.`,
      );
    } else {
      console.log(`RESULTADO: a Meta NÃO aceitou (${r.situacao})${r.detalhe ? `: ${r.detalhe}` : ''}. Nada foi publicado.`);
      process.exitCode = 2;
    }
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  // Só a mensagem: o erro do banco pode trazer o endereço da conexão.
  console.error(`[teste-foto-meta] ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  process.exitCode = 1;
});
