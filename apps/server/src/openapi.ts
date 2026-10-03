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
    .addTag('webhooks', 'Webhooks de saída: CloudEvents assinados no padrão Standard Webhooks (ADR-004)')
    .addTag('audit', 'Auditoria da empresa: eventos com hash encadeado e verificação (security-model §7)')
    .addTag('flags', 'Feature flags avaliadas para a sessão, no protocolo OFREP (ADR-012)')
    .addTag('kill-switch', 'Botão de parada: trava a execução em seis níveis (ADR-007)')
    .addTag('policies', 'Políticas versionadas que o motor aplica antes de qualquer ação (ADR-007)')
    .addTag('actions', 'Ações com trilho: política, orçamento com reserva e aprovação amarrada ao plano (ADR-007)')
    .addTag('inbox', 'Webhooks recebidos de parceiros, verificados e deduplicados (ADR-004)')
    .addTag('connections', 'Contas conectadas: autorização da Meta, do Google e dos produtos DMS (Regem, RegemCast), contas e lojas de cada marca (A2, A2.5)')
    .addTag('media', 'Dados de mídia lidos das plataformas, com o frescor de cada fonte (A2)')
    .addTag('results', 'Ciclo fechado: ROAS da plataforma ao lado do ROAS confirmado no caixa e a origem de cada pedido (A2.5)')
    .addTag('links', 'Links de campanha: o link do cardápio da loja com rastreio, os parâmetros para colar no anúncio, o QR e a conferência dos anúncios ativos (A2.5)')
    .addTag('cupons', 'Cupons de campanha: os do Regem e os de outra plataforma de pedidos, ligados a campanhas, e onde cada loja recebe os pedidos online (A2.5)')
    .addTag('ia', 'Inteligência artificial: o "Explicar" dos resultados e de um aviso da Atenção, com a fonte de cada número, e o retorno da pessoa (A3)')
    .addTag('marca', 'Minha marca: o dossiê que os funcionários de IA leem, com versões, o teste de frase e as sugestões do sistema (A3)')
    .addCookieAuth('liame_sessao', { type: 'apiKey', in: 'cookie', name: 'liame_sessao', description: 'Sessão aberta pelo POST /v1/auth/login (httpOnly)' }, 'liame_sessao')
    .build();
  return SwaggerModule.createDocument(app, config);
}
