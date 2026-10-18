import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { toProblem } from '../src/errors/problems.js';

/**
 * O erro do leitor do corpo do Express (http-errors) chega ao filtro sem ser `HttpException`: só o 4xx que ele mesmo
 * marca como do cliente (`expose`) vira 4xx; o resto segue 500 (o teste de ponta a ponta está em api.e2e.spec.ts).
 */
describe('toProblem com o erro do leitor do corpo', () => {
  const erroDoLeitor = (status: unknown, expose: unknown) => Object.assign(new Error('request entity too large'), { status, expose, type: 'entity.too.large' });

  it('413 e 415 marcados como do cliente: o problema do catálogo', () => {
    expect(toProblem(erroDoLeitor(413, true), 'a'.repeat(32), '/v1/x')).toMatchObject({ status: 413, code: 'grande-demais' });
    expect(toProblem(erroDoLeitor(415, true), 'a'.repeat(32), '/v1/x')).toMatchObject({ status: 415, code: 'formato-nao-suportado' });
  });

  it.each([
    ['sem expose', erroDoLeitor(413, false)],
    ['expose que não é verdadeiro', erroDoLeitor(413, 'true')],
    ['status de servidor', erroDoLeitor(503, true)],
    ['status em texto', erroDoLeitor('413', true)],
    ['status quebrado', erroDoLeitor(413.5, true)],
    ['nem objeto', 'texto solto'],
  ])('%s: segue 500', (_, erro) => {
    expect(toProblem(erro, 'a'.repeat(32), '/v1/x')).toMatchObject({ status: 500, code: 'interno' });
  });

  it('a HttpException continua com o status dela', () => {
    expect(toProblem(new HttpException('x', 409), 'a'.repeat(32), '/v1/x')).toMatchObject({ status: 409, code: 'conflito' });
  });
});
