import { maskIp, redactAttributes, redactString } from '@liame/telemetry';
import { describe, expect, it } from 'vitest';

describe('redação de dado pessoal nos spans (ADR-010, LGPD)', () => {
  it('tira e-mail, telefone, CPF e CNPJ de qualquer texto', () => {
    expect(redactString('contato ana.souza+promo@restaurante.com.br hoje')).toBe('contato [email] hoje');
    expect(redactString('ligue +55 21 99876-5432 ou (11) 3456-7890')).toBe('ligue [telefone] ou [telefone]');
    expect(redactString('cpf 123.456.789-09 e 12345678909')).toBe('cpf [cpf] e [cpf]');
    expect(redactString('cnpj 67.748.508/0001-43')).toBe('cnpj [cnpj]');
  });

  it('não apaga pedaço de número maior (timestamp, contagem, id)', () => {
    expect(redactString('occurred 1790424000123 ms')).toBe('occurred 1790424000123 ms');
    expect(redactString('/v1/actions/0192f1d4-3c1a-7b2e-9a10-5f1e2d3c4b5a')).toBe('/v1/actions/0192f1d4-3c1a-7b2e-9a10-5f1e2d3c4b5a');
    expect(redactString('SELECT id FROM liame.brand WHERE tenant_id = $1')).toBe('SELECT id FROM liame.brand WHERE tenant_id = $1');
  });

  it('limpa parâmetros sensíveis da URL', () => {
    expect(redactString('/convite?token=abc123&x=1')).toBe('/convite?token=[removido]&x=1');
    expect(redactString('/v1/brands?include_archived=true&email=a%40b.com')).toBe('/v1/brands?include_archived=true&email=[removido]');
  });

  it('mascara o IP de quem chama e descarta cabeçalhos de credencial', () => {
    expect(maskIp('189.40.12.201')).toBe('189.40.12.0');
    expect(maskIp('::ffff:10.1.2.3')).toBe('10.1.2.0');
    expect(
      redactAttributes({
        'client.address': '200.10.20.30',
        'server.address': '127.0.0.1',
        'http.request.header.cookie': 'liame_sessao=segredo',
        'user_agent.original': 'app +55 21 99876-5432',
        'http.response.status_code': 200,
      }),
    ).toEqual({
      'client.address': '200.10.20.0',
      'server.address': '127.0.0.1',
      'user_agent.original': 'app [telefone]',
      'http.response.status_code': 200,
    });
  });
});
