import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { ExplicarService } from '../../src/ai/explicar/explicar.service.js';
import { RevisaoSemanalLoop } from '../../src/worker/revisao-semanal-loop.js';
import { RevisaoSemanalService } from '../../src/worker/revisao-semanal.service.js';
import { SombraLoop } from '../../src/worker/sombra-loop.js';
import { WorkerModule } from '../../src/worker/worker.module.js';
import { hasDb } from './env.js';

// O worker não tem rota: se faltar um provedor no módulo dele, o erro só aparece na subida, em produção.
// Aqui o módulo é montado como na subida (`compile` cria todos os provedores) sem iniciar laço nenhum:
// `onApplicationBootstrap` não é chamado.

describe.skipIf(!hasDb)('módulo do worker: todas as dependências se resolvem', () => {
  it('monta os provedores, com a revisão da semana e o que ela usa (resultados, avisos, Explicar e o gateway de IA)', async () => {
    const modulo = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    try {
      expect(modulo.get(RevisaoSemanalLoop)).toBeInstanceOf(RevisaoSemanalLoop);
      expect(modulo.get(RevisaoSemanalService)).toBeInstanceOf(RevisaoSemanalService);
      expect(modulo.get(ExplicarService)).toBeInstanceOf(ExplicarService);
      expect(modulo.get(SombraLoop)).toBeInstanceOf(SombraLoop);
    } finally {
      await modulo.close();
    }
  });
});
