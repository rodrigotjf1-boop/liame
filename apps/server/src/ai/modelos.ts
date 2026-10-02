import { type AnthropicLanguageModelOptions, createAnthropic } from '@ai-sdk/anthropic';
import { Inject, Injectable } from '@nestjs/common';
import type { JSONValue, LanguageModel } from 'ai';
import { APP_CONFIG, type AppConfig } from '../config.js';

export type Esforco = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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

  /** Onde o modelo roda nesta chamada (entra no custo: `us` é 10% mais caro); nulo = o fornecedor não tem a opção. */
  geo(provider: string): 'us' | 'global' | null {
    return provider === 'anthropic' ? this.config.ai.inferenceGeo : null;
  }

  /** Opções próprias do fornecedor. O `global` é o padrão dele: só o `us` precisa ser pedido. */
  opcoes(provider: string, esforco: Esforco | null): Record<string, Record<string, JSONValue>> | undefined {
    if (provider !== 'anthropic') return undefined;
    const anthropic = {
      ...(this.config.ai.inferenceGeo === 'us' ? { inferenceGeo: 'us' as const } : {}),
      ...(esforco ? { effort: esforco } : {}),
    } satisfies AnthropicLanguageModelOptions;
    return Object.keys(anthropic).length ? { anthropic } : undefined;
  }
}
