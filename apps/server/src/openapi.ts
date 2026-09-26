import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

/**
 * Documento OpenAPI do contrato público. O padrão do swagger 12 ainda é 3.0.0:
 * o 3.1 precisa ser pedido (ADR-001). Os schemas vêm dos Zod declarados nas rotas.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Liame API')
    .setDescription('Contrato público da API do Liame (API-first).')
    .setVersion('0.0.0')
    .setOpenAPIVersion('3.1.0')
    .addServer('/', 'Mesma origem do app')
    .addTag('infra', 'Saúde e prontidão do serviço')
    .addTag('auth', 'Cadastro, confirmação de e-mail, sessão e senha')
    .addTag('me', 'A pessoa da sessão, o segundo fator e a empresa ativa')
    .addTag('organization', 'Empresa ativa e marcas')
    .addTag('people', 'Pessoas e acessos: convites, níveis, limites e remoção (ADR-017)')
    .addCookieAuth('liame_sessao', { type: 'apiKey', in: 'cookie', name: 'liame_sessao', description: 'Sessão aberta pelo POST /v1/auth/login (httpOnly)' }, 'liame_sessao')
    .addTag('spike', 'Rotas provisórias do spike de compatibilidade (saem na A1)')
    .build();
  return SwaggerModule.createDocument(app, config);
}
