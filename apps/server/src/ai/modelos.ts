import { type AnthropicLanguageModelOptions, createAnthropic } from '@ai-sdk/anthropic';
import { Inject, Injectable } from '@nestjs/common';
import type { JSONValue, LanguageModel } from 'ai';
import { APP_CONFIG, type AppConfig } from '../config.js';

export type Esforco = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/**
 * O modelo aceita a opção de rodar só nos Estados Unidos (`inference_geo`)? Na Anthropic ela existe do Claude 4.6
 * em diante; mandá-la ao Opus 4.5, ao Sonnet 4.5, ao Haiku 4.5 ou a um anterior devolve 400 (base de conhecimento
 * §10.2; documentação oficial e chamada de verdade em 04/10/2026). O id novo é `claude-<família>-<maior>-<menor>`,
 * com data no fim ou não. O que não der para ler conta como "não aceita": com a regra de rodar só nos Estados
 * Unidos, modelo sem essa garantia não é chamado, e o erro aparece na hora de avaliar a rota, não em produção.
 */
export function aceitaGeo(provider: string, model: string): boolean {
  if (provider !== 'anthropic') return false;
  const m = /^claude-[a-z]+-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(model);
  if (!m) return false;
  const maior = Number(m[1]);
  const menor = Number(m[2] ?? 0);
  return maior > 4 || (maior === 4 && menor >= 6);
}

/**
 * Adapters dos fornecedores (ADR-006): o único lugar que cria um modelo e que conhece as opções de
 * cada fornecedor. O id do modelo vem sempre da rota (`ai_model_route`), nunca de texto solto no
 * código. Nos testes, uma subclasse com modelo simulado entra no lugar desta.
 */
@Injectable()
export class ModelosIa {
  private readonly anthropic: ReturnType<typeof createAnthropic> | null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    // Endereço fixo: variável de ambiente nenhuma desvia o envio para outro servidor.
    this.anthropic = config.ai.anthropicApiKey
      ? createAnthropic({ apiKey: config.ai.anthropicApiKey, baseURL: 'https://api.anthropic.com/v1' })
      : null;
  }

  /** Nulo = fornecedor desconhecido ou ainda sem credencial neste ambiente. */
  modelo(provider: string, model: string): LanguageModel | null {
    if (provider === 'anthropic') return this.anthropic ? this.anthropic(model) : null;
    return null;
  }

  /**
   * Falso quando a regra do ambiente é rodar só nos Estados Unidos (`AI_INFERENCE_GEO=us`, D-A3-13) e o modelo não
   * aceita a opção: ele rodaria em qualquer região, então não é chamado (o gateway registra `fora_da_regiao`).
   */
  atendeARegiao(provider: string, model: string): boolean {
    return provider !== 'anthropic' || this.config.ai.inferenceGeo !== 'us' || aceitaGeo(provider, model);
  }

  /** Onde o modelo roda nesta chamada (entra no custo: `us` é 10% mais caro); nulo = o fornecedor não tem a opção. */
  geo(provider: string, model: string): 'us' | 'global' | null {
    if (provider !== 'anthropic') return null;
    return this.config.ai.inferenceGeo === 'us' && aceitaGeo(provider, model) ? 'us' : 'global';
  }

  /** Opções próprias do fornecedor. O `global` é o padrão dele: só o `us` precisa ser pedido, e só a quem o aceita. */
  opcoes(provider: string, model: string, esforco: Esforco | null): Record<string, Record<string, JSONValue>> | undefined {
    if (provider !== 'anthropic') return undefined;
    const anthropic = {
      ...(this.geo(provider, model) === 'us' ? { inferenceGeo: 'us' as const } : {}),
      ...(esforco ? { effort: esforco } : {}),
    } satisfies AnthropicLanguageModelOptions;
    return Object.keys(anthropic).length ? { anthropic } : undefined;
  }
}
