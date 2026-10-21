import { Global, Module } from '@nestjs/common';
import { ARMAZEM_DE_IMAGENS, criarArmazem } from './armazem.js';

/** O armazenamento de imagens (ADR-021), um só por processo: a API grava e lê; o worker limpa e expurga. */
@Global()
@Module({
  providers: [{ provide: ARMAZEM_DE_IMAGENS, useFactory: () => criarArmazem() }],
  exports: [ARMAZEM_DE_IMAGENS],
})
export class ArmazemModule {}
