import { randomBytes } from 'node:crypto';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { ModelosIa } from '../../src/ai/modelos.js';
import type { AppConfig } from '../../src/config.js';
import type { FlagService } from '../../src/flags/flag.service.js';
import { ownerQuery } from './api.js';

// Apoio dos testes de IA: nenhum teste chama um fornecedor de verdade. O modelo é o simulado do AI SDK
// (`ai/test`), com o uso de tokens que o teste escolhe, e entra no lugar do adapter pelo `ModelosDeTeste`.

/** Os modelos do teste: simulados, por `fornecedor/modelo`; o que não está aqui fica "sem credencial". */
export class ModelosDeTeste extends ModelosIa {
  constructor(
    config: AppConfig,
    readonly porChave = new Map<string, MockLanguageModelV4>(),
  ) {
    super(config);
  }
  override modelo(provider: string, model: string) {
    return this.porChave.get(`${provider}/${model}`) ?? null;
  }
}

export const uso = (input: number, output: number, cacheRead?: number, cacheWrite?: number) => ({
  inputTokens: { total: input + (cacheRead ?? 0) + (cacheWrite ?? 0), noCache: input, cacheRead, cacheWrite },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

/** Modelo que responde sempre o mesmo texto (1.000 tokens de entrada e 500 de saída, se o teste não disser outro uso). */
export const responde = (text: string, u = uso(1000, 500)) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({ content: [{ type: 'text' as const, text }], finishReason: { unified: 'stop' as const, raw: undefined }, usage: u, warnings: [] }),
  });

/** Modelo que o fornecedor recusa com o status dado, sem nova tentativa. */
export const recusa = (statusCode: number) =>
  new MockLanguageModelV4({
    doGenerate: async () => {
      throw new APICallError({ message: 'recusado', url: 'https://fornecedor.test', requestBodyValues: {}, statusCode, isRetryable: false });
    },
  });

/** Liga a flag `ia` para uma empresa (ela nasce desligada para todos). */
export async function ligarIa(flags: FlagService, tenantId: string): Promise<void> {
  await ownerQuery(
    `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'ia', 'tenant', $1, 'true'::jsonb, 'testes')`,
    [tenantId],
  );
  flags.invalidate();
}

/**
 * Liga a flag `revisor` para UMA empresa (o revisor de IA do Compliance nasce desligado para todos). A rota da tarefa
 * dele é do produto e compartilhada entre os arquivos (`rotaCompartilhada`): é a flag, por empresa, que decide quem
 * passa pelo revisor, e o teste de um arquivo não muda o dos outros (V36, V76).
 */
export async function ligarRevisor(flags: FlagService, tenantId: string): Promise<void> {
  await ownerQuery(
    `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'revisor', 'tenant', $1, 'true'::jsonb, 'testes')`,
    [tenantId],
  );
  flags.invalidate();
}

/** O parecer do revisor de IA como o modelo o devolve: sem categorias, o texto passa. */
export const parecer = (...problemas: string[]) => responde(JSON.stringify({ problemas }), uso(400, 20));

/** Modelo simulado com preço na tabela (US$ por milhão: 4 de entrada, 20 de saída; o econômico, 1 e 5). */
export async function modeloComPreco(modelos: ModelosDeTeste, rodada: string, mock: MockLanguageModelV4, barato = false, provider = 'teste') {
  const model = `${rodada}_${randomBytes(3).toString('hex')}`;
  await ownerQuery(
    `insert into liame.ai_model_price (id, provider, model, valid_from, input_usd_micros_per_mtok, output_usd_micros_per_mtok, cache_read_usd_micros_per_mtok,
                                       cache_write_5m_usd_micros_per_mtok, cache_write_1h_usd_micros_per_mtok, source, checked_on)
     values (gen_random_uuid(), $1, $2, current_date - 1, $3, $4, $5, $6, $7, 'teste automatizado', current_date)`,
    barato ? [provider, model, 1_000_000, 5_000_000, 100_000, 1_250_000, 2_000_000] : [provider, model, 4_000_000, 20_000_000, 200_000, 5_000_000, 8_000_000],
  );
  modelos.porChave.set(`${provider}/${model}`, mock);
  return { provider, model, mock };
}

/**
 * Rota de teste COMPARTILHADA de uma tarefa, para quando dois arquivos de teste usam a mesma tarefa. Cada arquivo roda
 * no seu processo, com o seu modelo simulado, mas a tabela de rotas é uma só (do produto, sem empresa): se cada um
 * apaga e cria a rota, um derruba a do outro no meio do teste (`sem-rota`, ou o modelo que só o outro processo conhece).
 * Aqui os arquivos usam o MESMO nome de modelo, fixo por tarefa: a rota e o preço entram uma vez e ninguém apaga; cada
 * processo liga esse nome ao próprio simulado. Rota que sobrou de uma rodada antiga é apontada para o nome fixo.
 */
export async function rotaCompartilhada(modelos: ModelosDeTeste, task: string, mock: MockLanguageModelV4, maxCost = 1_000_000) {
  const provider = 'teste';
  const model = `compartilhado_${task}`;
  await aposentarRotaDaDistribuicao(task);
  await ownerQuery(
    `insert into liame.ai_model_price (id, provider, model, valid_from, input_usd_micros_per_mtok, output_usd_micros_per_mtok, cache_read_usd_micros_per_mtok,
                                       cache_write_5m_usd_micros_per_mtok, cache_write_1h_usd_micros_per_mtok, source, checked_on)
     values (gen_random_uuid(), $1, $2, date '2026-01-01', 4000000, 20000000, 200000, 5000000, 8000000, 'teste automatizado', current_date)
     on conflict (provider, model, valid_from) do nothing`,
    [provider, model],
  );
  // Dois passos, porque a tabela tem duas chaves únicas (tarefa ativa; tarefa e versão): com `do nothing` sem alvo,
  // dois arquivos chegando juntos não se derrubam (um insere, o outro não faz nada); depois, a rota fica igual.
  await ownerQuery(
    `insert into liame.ai_model_route (id, task, version, status, purpose, provider, model, max_output_tokens, timeout_ms, max_cost_usd_micros, created_by, deployed_at)
     values (gen_random_uuid(), $1, 3, 'ativa', 'analise', $2, $3, 4000, 30000, $4, 'testes', now())
     on conflict do nothing`,
    [task, provider, model, maxCost],
  );
  await ownerQuery(
    `update liame.ai_model_route
        set provider = $2, model = $3, max_cost_usd_micros = $4, timeout_ms = 30000, fallback = '[]'::jsonb, economy_provider = null, economy_model = null, effort = null
      where task = $1 and status = 'ativa' and created_by = 'testes'
        and (provider, model, max_cost_usd_micros, timeout_ms) is distinct from ($2::text, $3::text, $4::bigint, 30000)`,
    [task, provider, model, maxCost],
  );
  modelos.porChave.set(`${provider}/${model}`, mock);
  return { provider, model, mock };
}

export type RefDeModelo = { provider: string; model: string };

/**
 * A rota que a distribuição publicou para a tarefa (migration 0046) sai do caminho no banco de TESTE: só pode haver uma
 * ativa por tarefa, e o teste usa a dele, com o modelo simulado. A linha fica (aposentada), para o teste que confere o
 * que a migration publicou. Sem rota da distribuição ativa, não faz nada.
 */
export async function aposentarRotaDaDistribuicao(task: string): Promise<void> {
  await ownerQuery(`update liame.ai_model_route set status = 'aposentada' where task = $1 and status = 'ativa' and created_by <> 'testes'`, [task]);
}

/** Rota ativa para a tarefa (a versão é 3 para o teste conferir que ela chega ao registro de uso). */
export async function rotaAtiva(
  task: string,
  principal: RefDeModelo,
  extra: { reserva?: RefDeModelo[]; economico?: RefDeModelo; timeoutMs?: number; effort?: string; maxCost?: number } = {},
): Promise<string> {
  await aposentarRotaDaDistribuicao(task);
  await ownerQuery(
    `insert into liame.ai_model_route (id, task, version, status, purpose, provider, model, effort, max_output_tokens, timeout_ms, max_cost_usd_micros, fallback,
                                       economy_provider, economy_model, created_by, deployed_at)
     values (gen_random_uuid(), $1, 3, 'ativa', 'analise', $2, $3, $4, 4000, $5, $6, $7::jsonb, $8, $9, 'testes', now())`,
    [task, principal.provider, principal.model, extra.effort ?? null, extra.timeoutMs ?? 30_000, extra.maxCost ?? 200_000, JSON.stringify(extra.reserva ?? []), extra.economico?.provider ?? null, extra.economico?.model ?? null],
  );
  return task;
}
