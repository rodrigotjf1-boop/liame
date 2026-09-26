import { StandardSchemaValidationPipe, type INestApplication } from '@nestjs/common';

export const API_PREFIX = 'v1';

/** Configuração única da API: usada pelo `main.api` e pelos testes, para não divergir. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix(API_PREFIX, { exclude: ['health'] });
  // Valida pelo schema declarado no parâmetro (`@Body({ schema })`) e entrega o valor já transformado.
  app.useGlobalPipes(new StandardSchemaValidationPipe());
}
