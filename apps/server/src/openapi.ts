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
    .addTag('conversa', 'Conversa com a LIA: a resposta em fluxo de eventos, conferida pelo código antes de aparecer, e as demandas que ela registra para a equipe (A3)')
    .addTag('planos', 'Planos do Estrategista: a oferta, a pauta da semana e o plano de 90 dias, com a fonte de cada número, para aprovar, editar, recusar ou pedir nova análise; nada é executado (A3)')
    .addTag('autonomia', 'Autonomia por conta e ação: a prontidão pelos cinco portões e a promoção de Sombra para Sugerir, que o sistema propõe e uma pessoa aprova; nada é executado (A3)')
    .addTag('equipe', 'Sua equipe: quem trabalha para a marca, a situação, o custo de IA e o que fez no mês; desligar e ligar um funcionário (A3)')
    .addTag('resumo', 'Resumo: a página inicial do Lite, numa chamada, com o dinheiro do marketing nos últimos 7 dias, o veredito, os pedidos e o que precisa de você (A3)')
    .addTag('pecas', 'Peças do Criativo: o pedido de peças de anúncio para uma oferta de Minha marca e as peças, cada uma com a conferência do código, item por item; nada vai para a Meta por aqui (A4)')
    .addTag('conversoes', 'Conversões para o Google: a venda confirmada no caixa, vinda de um clique em anúncio, informada ao Google; a situação de cada conta, as conversões da conta e escolher ou parar o destino (A5)')
    .addCookieAuth('liame_sessao', { type: 'apiKey', in: 'cookie', name: 'liame_sessao', description: 'Sessão aberta pelo POST /v1/auth/login (httpOnly)' }, 'liame_sessao')
    .build();
  return comFluxos(SwaggerModule.createDocument(app, config));
}

/**
 * A rota que responde por fluxo de eventos declara `x-liame-fluxo`: a resposta 200 dela é `text/event-stream`
 * (cada evento com o JSON do schema), e os erros, antes do fluxo, seguem em JSON como em toda rota.
 */
function comFluxos(doc: OpenAPIObject): OpenAPIObject {
  for (const caminho of Object.values(doc.paths)) {
    for (const op of Object.values(caminho) as Array<{ 'x-liame-fluxo'?: unknown; responses?: Record<string, { content?: Record<string, unknown> }> }>) {
      const ok = op?.['x-liame-fluxo'] ? op.responses?.['200'] : undefined;
      const json = ok?.content?.['application/json'];
      if (ok && json) ok.content = { 'text/event-stream': json };
    }
  }
  return doc;
}
