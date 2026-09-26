import { StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ProblemDetailsFilter } from './errors/problem.filter.js';
import { issuesToErrors, ValidationProblem } from './errors/problems.js';

export const API_PREFIX = 'v1';

/** Configuração única da API: usada pelo `main.api` e pelos testes, para não divergir. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health', 'health/ready'] });
  // Valida pelo schema declarado no parâmetro (`@Body({ schema })`) e entrega o valor já transformado.
  app.useGlobalPipes(
    new StandardSchemaValidationPipe({ exceptionFactory: (issues) => new ValidationProblem(issuesToErrors(issues)) }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter(app.get(HttpAdapterHost)));
}
