import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { SemAuditoria } from '../../src/audit/auditar.js';
import { Publico } from '../../src/auth/access.js';

// Rotas só dos testes (não existem no app): provam a validação por schema e a política de erros
// (RFC 9457) sem depender de uma rota de produto.

const EchoRequest = z.strictObject({
  message: z.string().trim().min(1).max(280),
  tags: z.array(z.string().min(1).max(32)).max(5).default([]),
});
type EchoRequest = z.infer<typeof EchoRequest>;

@Publico()
@Controller('teste')
export class ProbeController {
  @Post('eco')
  @HttpCode(201)
  @SemAuditoria('rota só dos testes, sem estado')
  echo(@Body({ schema: EchoRequest }) body: EchoRequest) {
    return { message: body.message, tags: body.tags, length: body.message.length };
  }

  /** Falha proposital: o 500 não pode mostrar o dado interno da mensagem, e o log precisa ter a causa. */
  @Get('falha')
  fail(): never {
    throw new Error('falha proposital do teste (dado interno: tabela liame.segredo)');
  }
}
