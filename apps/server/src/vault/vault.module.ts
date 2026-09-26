import { resolve } from 'node:path';
import { Global, Module } from '@nestjs/common';
import { z } from 'zod';
import { AwsKmsKeyProvider, type KeyProvider, LocalKeyProvider, parseLocalKeks } from './key-provider.js';
import { KEY_PROVIDER, VaultService } from './vault.service.js';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  KEY_PROVIDER: z.enum(['local', 'aws-kms']).default('local'),
  LIAME_KEK_LOCAL: z.string().optional(),
  LIAME_KEK_VERSION: z.coerce.number().int().positive().optional(),
  AWS_REGION: z.string().default('sa-east-1'),
  /** `"1:alias/liame-kek-v1,2:alias/liame-kek-v2"` */
  AWS_KMS_KEKS: z.string().optional(),
});

/** Monta o provedor de chaves a partir do ambiente. Em produção, só o KMS. */
export async function createKeyProvider(source: NodeJS.ProcessEnv = process.env): Promise<KeyProvider> {
  const env = Env.parse(source);
  if (env.KEY_PROVIDER === 'aws-kms') {
    const keks = new Map<number, string>();
    for (const part of (env.AWS_KMS_KEKS ?? '').split(',').map((p) => p.trim()).filter(Boolean)) {
      const i = part.indexOf(':');
      keks.set(Number(part.slice(0, i)), part.slice(i + 1));
    }
    return AwsKmsKeyProvider.create(env.AWS_REGION, keks, env.LIAME_KEK_VERSION ?? Math.max(...keks.keys()));
  }
  if (env.NODE_ENV === 'production') throw new Error('config: em produção, KEY_PROVIDER precisa ser aws-kms (ADR-011)');
  const keks = parseLocalKeks(env.LIAME_KEK_LOCAL);
  if (!keks.size) throw new Error('config: defina LIAME_KEK_LOCAL (o bootstrap do banco local gera uma)');
  // No desenvolvimento, as chaves das empresas ficam num arquivo fora do git; nos testes, só em memória.
  const file = env.NODE_ENV === 'development' ? resolve(process.cwd(), '.liame-chaves-locais.json') : undefined;
  return new LocalKeyProvider(keks, env.LIAME_KEK_VERSION ?? Math.max(...keks.keys()), file);
}

@Global()
@Module({
  providers: [{ provide: KEY_PROVIDER, useFactory: () => createKeyProvider() }, VaultService],
  exports: [VaultService, KEY_PROVIDER],
})
export class VaultModule {}
