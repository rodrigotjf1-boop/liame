import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import { codigoDoErro } from '../src/ai/gateway.js';
import { aceitaGeo, ModelosIa } from '../src/ai/modelos.js';
import { custoMicros, type PrecoModelo, tokensDe } from '../src/ai/precos.js';
import { limparJson, limparTexto } from '../src/ai/sanitizar.js';
import { loadConfig } from '../src/config.js';
import { situacaoDoTeto, virouDeFaixa } from '../src/ai/teto.js';

// US$ 4 de entrada e US$ 20 de saída por milhão de tokens; cache lido a 0,05×, escrito a 1,25× (5 min) e 2× (1 h).
const PRECO: PrecoModelo = { input: 4_000_000n, output: 20_000_000n, cacheRead: 200_000n, cacheWrite5m: 5_000_000n, cacheWrite1h: 8_000_000n };
const tokens = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite, reasoning: 0 });

describe('custo de uma chamada de IA (A3-2)', () => {
  it('sai da tabela de preços × tokens, contando o cache lido e o escrito', () => {
    expect(custoMicros(PRECO, tokens(1000, 500), { geo: 'global' })).toBe(14_000n);
    // 1000 × 4 + 2000 × 0,2 + 300 × 5 + 500 × 20 = 15.900 micros.
    expect(custoMicros(PRECO, tokens(1000, 500, 2000, 300), { geo: 'global' })).toBe(15_900n);
    expect(custoMicros(PRECO, tokens(1000, 500, 2000, 300), { geo: 'global', cache: '1h' })).toBe(16_800n);
    expect(custoMicros(PRECO, tokens(0, 0), { geo: 'us' })).toBe(0n);
  });

  it('rodar só nos Estados Unidos custa 10% a mais; em lote, a metade; e arredonda para cima uma vez', () => {
    expect(custoMicros(PRECO, tokens(1000, 500), { geo: 'us' })).toBe(15_400n);
    expect(custoMicros(PRECO, tokens(1000, 500), { geo: 'global', lote: true })).toBe(7_000n);
    expect(custoMicros(PRECO, tokens(1000, 500), { geo: 'us', lote: true })).toBe(7_700n);
    // 1 token de entrada = 4 micros; com 10% a mais, 4,4 → 5 (nunca registra a menos).
    expect(custoMicros(PRECO, tokens(1, 0), { geo: 'us' })).toBe(5n);
    // Soma grande não perde precisão: 3 bilhões de tokens de saída = US$ 60.000.
    expect(custoMicros(PRECO, tokens(0, 3_000_000_000), { geo: 'global' })).toBe(60_000_000_000n);
  });

  it('lê o uso do SDK: a entrada cheia é o total menos o cache; o raciocínio já está na saída', () => {
    const usage = {
      inputTokens: 3300,
      inputTokenDetails: { noCacheTokens: 1000, cacheReadTokens: 2000, cacheWriteTokens: 300 },
      outputTokens: 500,
      outputTokenDetails: { textTokens: 380, reasoningTokens: 120 },
      totalTokens: 3800,
    };
    expect(tokensDe(usage)).toEqual({ input: 1000, cacheRead: 2000, cacheWrite: 300, output: 500, reasoning: 120 });
    const semDetalhe = { ...usage, inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: 2000, cacheWriteTokens: undefined } };
    expect(tokensDe(semDetalhe)).toMatchObject({ input: 1300, cacheRead: 2000, cacheWrite: 0 });
    const vazio = { inputTokens: undefined, inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined }, outputTokens: undefined, outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined }, totalTokens: undefined };
    expect(tokensDe(vazio)).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 });
  });
});

describe('teto de custo de IA por empresa (D-A3-3)', () => {
  const g = (gastoDia: bigint, gastoMes = 0n) => ({ gastoDia, gastoMes, tetoDia: 100n, tetoMes: 1000n });

  it('70% avisa, 80% vai para o modelo econômico, 100% bloqueia; vale o pior entre o dia e o mês', () => {
    expect([0n, 69n, 70n, 79n, 80n, 99n, 100n, 250n].map((x) => situacaoDoTeto(g(x)))).toEqual(['livre', 'livre', 'alerta', 'alerta', 'economico', 'economico', 'bloqueado', 'bloqueado']);
    expect(situacaoDoTeto(g(10n, 800n))).toBe('economico');
    expect(situacaoDoTeto(g(75n, 1000n))).toBe('bloqueado');
  });

  it('o aviso sai só na chamada que faz a empresa mudar de faixa', () => {
    expect(virouDeFaixa(g(60n), 5n)).toBeNull();
    expect(virouDeFaixa(g(60n), 10n)).toBe('alerta');
    expect(virouDeFaixa(g(70n), 5n)).toBeNull();
    expect(virouDeFaixa(g(78n), 30n)).toBe('bloqueado');
  });
});

describe('remoção de dado pessoal antes do envio ao modelo (A3-3)', () => {
  it('tira e-mail, telefone, CPF, CNPJ e CEP, e conta o que saiu', () => {
    const r = limparTexto('Cliente ana@exemplo.com.br, (21) 99876-5432, CPF 123.456.789-09, CEP 20040-020, loja 67.748.508/0001-43.');
    expect(r.texto).toBe('Cliente [email], [telefone], CPF [cpf], CEP [cep], loja [cnpj].');
    expect(r.removidos).toBe(5);
  });

  it('não mexe em número de resultado já formatado', () => {
    const texto = 'Investimento R$ 12.500,00 · 1.234.567 impressões · ROAS 3,8 · 38 pedidos em 01/10/2026 · CTR 2,15%';
    expect(limparTexto(texto)).toEqual({ texto, removidos: 0 });
  });

  it('o id da marca chega inteiro ao modelo: UUID não vira telefone nem CEP', () => {
    // `4557551391fc` parece telefone; `a1b12345-678c` parece CEP. O CEP de verdade, fora do id, sai.
    const texto = 'Marca (brand_id 01a10077-dc70-7e58-a180-4557551391fc) e loja a1b12345-678c-4d5e-8f90-1a2b3c4d5e6f, CEP 20040-020.';
    expect(limparTexto(texto)).toEqual({
      texto: 'Marca (brand_id 01a10077-dc70-7e58-a180-4557551391fc) e loja a1b12345-678c-4d5e-8f90-1a2b3c4d5e6f, CEP [cep].',
      removidos: 1,
    });
  });

  it('limpa os textos de uma resposta estruturada, em qualquer nível', () => {
    const r = limparJson({ resumo: 'fale com joao@loja.com', itens: [{ nota: 'zap 11 98765-4321' }, { nota: 'ok' }], total: 3, vazio: null });
    expect(r).toEqual({ valor: { resumo: 'fale com [email]', itens: [{ nota: 'zap [telefone]' }, { nota: 'ok' }], total: 3, vazio: null }, removidos: 2 });
  });
});

describe('motivo da falha de uma chamada (sem o texto do fornecedor)', () => {
  it('vira um código curto: o corpo enviado nunca entra no registro', () => {
    const api = (statusCode: number | undefined) => new APICallError({ message: 'recusado: mensagem com o conteúdo', url: 'https://exemplo.test', requestBodyValues: { segredo: 'conteúdo enviado' }, statusCode });
    expect(codigoDoErro(api(429))).toBe('http_429');
    expect(codigoDoErro(api(undefined))).toBe('rede');
    expect(codigoDoErro(new DOMException('tempo', 'TimeoutError'))).toBe('tempo_esgotado');
    expect(codigoDoErro(new TypeError('qualquer coisa'))).toBe('falha_TypeError');
    expect(codigoDoErro('texto solto')).toBe('falha');
  });
});

describe('configuração da IA', () => {
  it('sem chave do fornecedor a API sobe (a IA fica indisponível); o padrão roda nos Estados Unidos, com teto baixo', () => {
    expect(loadConfig({ NODE_ENV: 'test' }).ai).toEqual({
      anthropicApiKey: null,
      inferenceGeo: 'us',
      dailyLimitUsdMicros: 2_000_000,
      monthlyLimitUsdMicros: 20_000_000,
      userHourlyCalls: 30,
      conversationMaxAnswers: 20,
    });
    const c = loadConfig({
      NODE_ENV: 'test',
      ANTHROPIC_API_KEY: ` ${'x'.repeat(40)} `,
      AI_INFERENCE_GEO: 'global',
      AI_DAILY_LIMIT_USD: '0.5',
      AI_MONTHLY_LIMIT_USD: '7.25',
      AI_USER_HOURLY_CALLS: '5',
      AI_CONVERSATION_MAX_ANSWERS: '8',
    });
    expect(c.ai).toEqual({ anthropicApiKey: 'x'.repeat(40), inferenceGeo: 'global', dailyLimitUsdMicros: 500_000, monthlyLimitUsdMicros: 7_250_000, userHourlyCalls: 5, conversationMaxAnswers: 8 });
  });

  it('rodar só nos Estados Unidos só vai ao modelo que aceita a opção: do Claude 4.6 em diante', () => {
    // Os quatro modelos com preço publicado (migration 0028): o Haiku 4.5 é o único anterior ao 4.6.
    expect(aceitaGeo('anthropic', 'claude-haiku-4-5-20251001')).toBe(false);
    expect(aceitaGeo('anthropic', 'claude-sonnet-5-5')).toBe(true);
    expect(aceitaGeo('anthropic', 'claude-opus-5-5')).toBe(true);
    expect(aceitaGeo('anthropic', 'claude-fable-5-1')).toBe(true);
    // A fronteira é o 4.6, com data no fim do id ou sem ela; o que não dá para ler não aceita.
    expect(['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-7', 'claude-opus-5', 'claude-opus-4-6-20260101'].map((m) => aceitaGeo('anthropic', m))).toEqual([true, true, true, true, true]);
    expect(['claude-opus-4-5-20251101', 'claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805', 'claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'modelo-novo', ''].map((m) => aceitaGeo('anthropic', m))).toEqual([
      false, false, false, false, false, false, false,
    ]);
    expect(aceitaGeo('outro', 'claude-opus-5-5')).toBe(false);

    const us = new ModelosIa(loadConfig({ NODE_ENV: 'test' }));
    const global = new ModelosIa(loadConfig({ NODE_ENV: 'test', AI_INFERENCE_GEO: 'global' }));
    // Quem aceita: a opção vai no pedido e a região entra no custo.
    expect(us.atendeARegiao('anthropic', 'claude-sonnet-5-5')).toBe(true);
    expect(us.geo('anthropic', 'claude-sonnet-5-5')).toBe('us');
    expect(us.opcoes('anthropic', 'claude-sonnet-5-5', 'low')).toEqual({ anthropic: { inferenceGeo: 'us', effort: 'low' } });
    // Quem não aceita: com a regra de rodar só nos Estados Unidos, não é chamado; e a opção nunca vai no pedido (daria 400).
    expect(us.atendeARegiao('anthropic', 'claude-haiku-4-5-20251001')).toBe(false);
    expect(us.opcoes('anthropic', 'claude-haiku-4-5-20251001', null)).toBeUndefined();
    expect(global.atendeARegiao('anthropic', 'claude-haiku-4-5-20251001')).toBe(true);
    expect(global.geo('anthropic', 'claude-haiku-4-5-20251001')).toBe('global');
    expect(global.opcoes('anthropic', 'claude-haiku-4-5-20251001', null)).toBeUndefined();
    expect(global.opcoes('anthropic', 'claude-sonnet-5-5', 'medium')).toEqual({ anthropic: { effort: 'medium' } });
    // Outro fornecedor não tem a opção: nada no pedido, nada no custo, e a regra não o barra.
    expect([us.atendeARegiao('teste', 'eco'), us.geo('teste', 'eco'), us.opcoes('teste', 'eco', 'low')]).toEqual([true, null, undefined]);
  });

  it('cache de prompt: a opção só entra quando pedida; as instruções levam o ponto de cache e o contexto vai depois', () => {
    const m = new ModelosIa(loadConfig({ NODE_ENV: 'test' }));
    const PONTO = { anthropic: { cacheControl: { type: 'ephemeral' } } };
    expect(m.opcoes('anthropic', 'claude-sonnet-5-5', 'low', { cache: true })).toEqual({ anthropic: { inferenceGeo: 'us', effort: 'low', cacheControl: { type: 'ephemeral' } } });
    expect(m.opcoes('anthropic', 'claude-sonnet-5-5', 'low')).toEqual({ anthropic: { inferenceGeo: 'us', effort: 'low' } });
    expect(m.opcoes('teste', 'eco', null, { cache: true })).toBeUndefined();
    // Sem cache (ou em fornecedor sem a opção): um texto só, com o contexto depois das instruções.
    expect(m.sistema('anthropic', 'INSTRUÇÕES', 'CONTEXTO', false)).toBe('INSTRUÇÕES\n\nCONTEXTO');
    expect(m.sistema('anthropic', 'INSTRUÇÕES', null, false)).toBe('INSTRUÇÕES');
    expect(m.sistema('teste', 'INSTRUÇÕES', 'CONTEXTO', true)).toBe('INSTRUÇÕES\n\nCONTEXTO');
    // Com cache: as instruções (iguais em todo pedido da tarefa) com o ponto, e o contexto do pedido depois dele.
    expect(m.sistema('anthropic', 'INSTRUÇÕES', 'CONTEXTO', true)).toEqual([
      { role: 'system', content: 'INSTRUÇÕES', providerOptions: PONTO },
      { role: 'system', content: 'CONTEXTO' },
    ]);
    expect(m.sistema('anthropic', 'INSTRUÇÕES', null, true)).toEqual([{ role: 'system', content: 'INSTRUÇÕES', providerOptions: PONTO }]);
  });

  it('recusa subir com teto do mês menor que o do dia, região desconhecida ou limite zerado', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', AI_DAILY_LIMIT_USD: '10', AI_MONTHLY_LIMIT_USD: '5' })).toThrow('AI_MONTHLY_LIMIT_USD');
    expect(() => loadConfig({ NODE_ENV: 'test', AI_INFERENCE_GEO: 'br' })).toThrow();
    expect(() => loadConfig({ NODE_ENV: 'test', AI_DAILY_LIMIT_USD: '0' })).toThrow();
    expect(() => loadConfig({ NODE_ENV: 'test', AI_USER_HOURLY_CALLS: '0' })).toThrow();
    expect(() => loadConfig({ NODE_ENV: 'test', AI_CONVERSATION_MAX_ANSWERS: '0' })).toThrow();
  });
});

describe('A3-1: só o gateway fala com o fornecedor de IA', () => {
  const SRC = resolve(process.cwd(), 'src');
  const arquivos = (dir: string): string[] =>
    readdirSync(dir).flatMap((nome) => {
      const caminho = join(dir, nome);
      return statSync(caminho).isDirectory() ? arquivos(caminho) : caminho.endsWith('.ts') ? [caminho] : [];
    });
  const fontes = arquivos(SRC).map((caminho) => ({ rel: relative(SRC, caminho).replace(/\\/g, '/'), texto: readFileSync(caminho, 'utf8') }));

  it('nenhum módulo importa SDK de fornecedor fora de `src/ai` (a verificação de dependências é a exceção)', () => {
    const SDK = /from '(?:ai|ai\/[a-z-]+|@ai-sdk\/[a-z-]+|@anthropic-ai\/[a-z-]+|openai|@google\/[a-z-]+)'/;
    const fora = fontes.filter((f) => SDK.test(f.texto) && !f.rel.startsWith('ai/') && !f.rel.startsWith('verify/')).map((f) => f.rel);
    expect(fora).toEqual([]);
  });

  it('nenhum id de modelo em texto solto: o modelo vem da rota (`ai_model_route`)', () => {
    const ID = /['"`](?:claude|gpt|gemini|o[1-9])-[a-z0-9.-]+['"`]/i;
    expect(fontes.filter((f) => ID.test(f.texto)).map((f) => f.rel)).toEqual([]);
  });
});
