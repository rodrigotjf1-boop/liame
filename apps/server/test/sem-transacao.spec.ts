import { Controller, Get, Post, type Type } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { Auditar, SemAuditoria } from '../src/audit/auditar.js';
import { assertAuditDeclarations, listRoutes } from '../src/auth/routes.js';
import { SemTransacao } from '../src/context/sem-transacao.js';

// A3 · I4: a rota que espera um modelo de IA roda fora da transação da requisição (`@SemTransacao`). É uma
// exceção declarada: a subida recusa a que não diz o motivo e a que pede a auditoria automática (que
// depende da transação que ela não tem).

const MOTIVO = 'espera um modelo de IA por segundos: abre as próprias transações curtas';

@Controller('teste-a')
class SemMotivoController {
  @Post('explicar')
  @SemTransacao('curto')
  @SemAuditoria('rota só dos testes, sem estado')
  explicar() {
    return {};
  }
}

@Controller('teste-b')
class LeituraSemMotivoController {
  @Get('ler')
  @SemTransacao('   ')
  ler() {
    return {};
  }
}

@Controller('teste-c')
class AuditoriaAutomaticaController {
  @Post('fazer')
  @SemTransacao(MOTIVO)
  @Auditar('teste.fazer')
  fazer() {
    return {};
  }
}

@Controller('teste-d')
class CertaController {
  @Post('explicar')
  @SemTransacao(MOTIVO)
  @SemAuditoria('rota só dos testes, sem estado')
  explicar() {
    return {};
  }

  @Post('fazer')
  @SemTransacao(MOTIVO)
  @Auditar('teste.fazer', { manual: true })
  fazer() {
    return {};
  }

  @Get('ler')
  @SemTransacao(MOTIVO)
  ler() {
    return {};
  }

  @Get('comum')
  comum() {
    return {};
  }
}

async function comRotas<T>(controller: Type<unknown>, fn: (app: Awaited<ReturnType<typeof subir>>) => T): Promise<T> {
  const app = await subir(controller);
  try {
    return fn(app);
  } finally {
    await app.close();
  }
}
async function subir(controller: Type<unknown>) {
  const moduleRef = await Test.createTestingModule({ imports: [DiscoveryModule], controllers: [controller] }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  await app.init();
  return app;
}

describe('rota fora da transação da requisição (@SemTransacao)', () => {
  it('a subida recusa a rota que não diz o motivo, seja de leitura ou de mudança', async () => {
    await comRotas(SemMotivoController, (app) => expect(() => assertAuditDeclarations(app)).toThrow('POST /v1/teste-a/explicar: @SemTransacao precisa de um motivo'));
    await comRotas(LeituraSemMotivoController, (app) => expect(() => assertAuditDeclarations(app)).toThrow('GET /v1/teste-b/ler: @SemTransacao precisa de um motivo'));
  });

  it('a subida recusa a auditoria automática numa rota sem transação: o evento não teria onde entrar', async () => {
    await comRotas(AuditoriaAutomaticaController, (app) =>
      expect(() => assertAuditDeclarations(app)).toThrow('POST /v1/teste-c/fazer: rota @SemTransacao só audita com manual: true (não há transação da requisição)'),
    );
  });

  it('com o motivo, e sem auditoria automática, a rota sobe; a lista de rotas diz quais são', async () => {
    await comRotas(CertaController, (app) => {
      expect(() => assertAuditDeclarations(app)).not.toThrow();
      expect(
        listRoutes(app)
          .map((r) => [`${r.method} ${r.path}`, r.semTransacao?.motivo ?? null])
          .sort(),
      ).toEqual([
        ['GET /v1/teste-d/comum', null],
        ['GET /v1/teste-d/ler', MOTIVO],
        ['POST /v1/teste-d/explicar', MOTIVO],
        ['POST /v1/teste-d/fazer', MOTIVO],
      ]);
    });
  });
});
