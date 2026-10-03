import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { ExplicarService } from '../../src/ai/explicar/explicar.service.js';
import { CambioService } from '../../src/worker/cambio.service.js';
import { EstrategistaAgenda } from '../../src/worker/estrategista-agenda.js';
import { EstrategistaLoop } from '../../src/worker/estrategista-loop.js';
import { EstrategistaService } from '../../src/worker/estrategista.service.js';
import { PesquisaLoop } from '../../src/worker/pesquisa-loop.js';
import { PesquisadorService } from '../../src/worker/pesquisa.service.js';
import { QueueService } from '../../src/worker/queue.service.js';
import { RevisaoSemanalLoop } from '../../src/worker/revisao-semanal-loop.js';
import { RevisaoSemanalService } from '../../src/worker/revisao-semanal.service.js';
import { SombraLoop } from '../../src/worker/sombra-loop.js';
import { WorkerModule } from '../../src/worker/worker.module.js';
import { hasDb } from './env.js';

// O worker não tem rota: se faltar um provedor no módulo dele, o erro só aparece na subida, em produção.
// Aqui o módulo é montado como na subida (`compile` cria todos os provedores) sem iniciar laço nenhum:
// `onApplicationBootstrap` não é chamado.

describe.skipIf(!hasDb)('módulo do worker: todas as dependências se resolvem', () => {
  it('monta os provedores, com a revisão da semana, a fila do Estrategista e o que elas usam (resultados, avisos, leituras da IA e o gateway)', async () => {
    const modulo = await Test.createTestingModule({ imports: [WorkerModule] }).compile();
    try {
      expect(modulo.get(RevisaoSemanalLoop)).toBeInstanceOf(RevisaoSemanalLoop);
      expect(modulo.get(RevisaoSemanalService)).toBeInstanceOf(RevisaoSemanalService);
      expect(modulo.get(ExplicarService)).toBeInstanceOf(ExplicarService);
      expect(modulo.get(SombraLoop)).toBeInstanceOf(SombraLoop);
      expect(modulo.get(EstrategistaLoop)).toBeInstanceOf(EstrategistaLoop);
      expect(modulo.get(EstrategistaService)).toBeInstanceOf(EstrategistaService);
      expect(modulo.get(EstrategistaAgenda)).toBeInstanceOf(EstrategistaAgenda);
      expect(modulo.get(PesquisaLoop)).toBeInstanceOf(PesquisaLoop);
      expect(modulo.get(PesquisadorService)).toBeInstanceOf(PesquisadorService);
      // O câmbio de referência (D-A3-14) roda pela fila agendada: a fila precisa achar o serviço.
      expect(modulo.get(CambioService)).toBeInstanceOf(CambioService);
      expect(modulo.get(QueueService)).toBeInstanceOf(QueueService);
    } finally {
      await modulo.close();
    }
  });
});
