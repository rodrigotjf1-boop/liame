import { StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { assertAccessDeclarations, assertAuditDeclarations } from './auth/routes.js';
import { ProblemDetailsFilter } from './errors/problem.filter.js';
import { issuesToErrors, ValidationProblem } from './errors/problems.js';
import { API_PREFIX, API_PREFIX_EXCLUDE } from './setup-constants.js';

export { API_PREFIX } from './setup-constants.js';

/** Configuração única da API: usada pelo `main.api` e pelos testes, para não divergir. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX, { exclude: API_PREFIX_EXCLUDE });
  // Valida pelo schema declarado no parâmetro (`@Body({ schema })`) e entrega o valor já transformado.
  app.useGlobalPipes(
    new StandardSchemaValidationPipe({ exceptionFactory: (issues) => new ValidationProblem(issuesToErrors(issues)) }),
  );
  app.useGlobalFilters(new ProblemDetailsFilter(app.get(HttpAdapterHost)));
  // Rota sem declaração de acesso não sobe (guard global que nega por padrão, ADR-003).
  assertAccessDeclarations(app);
  // Rota que muda dado sem declaração de auditoria também não sobe (A1-6).
  assertAuditDeclarations(app);
}
