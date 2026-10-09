import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runMigrations } from '@liame/database';
import { beforeAll, describe, expect, it } from 'vitest';
import { TAREFA_CONVERSA } from '../../src/ai/conversa/prompt.js';
import { TAREFA_CRIATIVO_TEXTO } from '../../src/ai/criativo/prompt.js';
import { TAREFA_CRM_MENSAGEM } from '../../src/ai/crm/prompt.js';
import { TAREFA_ESTRATEGISTA } from '../../src/ai/estrategista/prompt.js';
import { TAREFA_EXPLICAR_RESULTADOS } from '../../src/ai/explicar/prompt.js';
import { aceitaGeo } from '../../src/ai/modelos.js';
import { TAREFA_PESQUISADOR } from '../../src/ai/pesquisador/prompt.js';
import { TAREFA_REVISAO } from '../../src/ai/revisor/prompt.js';
import { ownerQuery } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

// As rotas de modelo que a distribuição publica (migration 0046, as cinco tarefas da A3; 0051, o Criativo de texto; 0061, o
// funcionário de CRM e mensageria): uma
// por tarefa de IA do código, com o modelo que passou no eval da tarefa. No banco de teste a linha da distribuição pode
// estar em três situações: ativa (banco novo), aposentada (outro arquivo a tirou do caminho para usar o modelo simulado)
// ou rascunho (a migration achou uma rota de teste ativa na tarefa e não a derrubou). Em produção não há rota de teste:
// todas entram ativas.

const MIGRATIONS = resolve(process.cwd(), '../../packages/database/migrations');
const DA_DISTRIBUICAO = `created_by like 'distribuição:%'`;

type Rota = {
  task: string;
  status: string;
  version: number;
  purpose: string;
  provider: string;
  model: string;
  effort: string | null;
  max_output_tokens: number;
  timeout_ms: number;
  max_cost: number;
  fallback: unknown[];
  economy_model: string | null;
  eval_threshold: number;
  eval_score: number;
  publicada: boolean;
};

describe.skipIf(!hasDb)('rotas de modelo da distribuição (A3, I3; A4, X6; A5, Y6; migrations 0046, 0051 e 0061)', () => {
  const rotas = () =>
    ownerQuery<Rota>(
      `select task, status, version, purpose, provider, model, effort, max_output_tokens, timeout_ms, max_cost_usd_micros::int as max_cost, fallback, economy_model,
              eval_threshold::float8 as eval_threshold, eval_score::float8 as eval_score, deployed_at is not null as publicada
         from liame.ai_model_route where ${DA_DISTRIBUICAO} order by task`,
    );

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: MIGRATIONS });
  });

  it('cada tarefa de IA do código tem a rota da rodada dos evals: modelo com preço, que aceita rodar só nos Estados Unidos, e a nota acima do limiar', async () => {
    const r = await rotas();
    // As tarefas são as do código: tarefa nova sem rota, ou rota de tarefa que não existe, aparece aqui.
    expect(r.map((x) => x.task)).toEqual([TAREFA_REVISAO, TAREFA_CONVERSA, TAREFA_CRIATIVO_TEXTO, TAREFA_CRM_MENSAGEM, TAREFA_ESTRATEGISTA, TAREFA_EXPLICAR_RESULTADOS, TAREFA_PESQUISADOR].sort());
    for (const x of r) {
      expect(x).toMatchObject({ version: 1, provider: 'anthropic', model: 'claude-sonnet-5-5', effort: 'low', fallback: [], economy_model: null, eval_threshold: 0.95 });
      // A que entrou valendo tem a data da publicação; o rascunho, não.
      expect(['ativa', 'aposentada', 'rascunho']).toContain(x.status);
      expect(x.publicada).toBe(x.status !== 'rascunho');
      // Regra do produto: modelo só entra numa tarefa depois de passar no eval dela.
      expect(x.eval_score).toBeGreaterThanOrEqual(x.eval_threshold);
      // D-A3-13: só entra em rota o modelo que aceita rodar só nos Estados Unidos (o gateway não chamaria outro).
      expect(aceitaGeo(x.provider, x.model)).toBe(true);
      expect(x.max_output_tokens).toBeGreaterThanOrEqual(2000);
      expect(x.timeout_ms).toBeGreaterThanOrEqual(30_000);
      expect(x.max_cost).toBeGreaterThan(0);
    }
    expect(Object.fromEntries(r.map((x) => [x.task, x.purpose]))).toEqual({
      [TAREFA_REVISAO]: 'analise',
      [TAREFA_CONVERSA]: 'conversa',
      // O Criativo escreve: a finalidade dele é texto criativo (ADR-016).
      [TAREFA_CRIATIVO_TEXTO]: 'texto',
      // O funcionário de CRM também escreve: a mensagem de WhatsApp é texto criativo.
      [TAREFA_CRM_MENSAGEM]: 'texto',
      [TAREFA_ESTRATEGISTA]: 'analise',
      [TAREFA_EXPLICAR_RESULTADOS]: 'analise',
      [TAREFA_PESQUISADOR]: 'analise',
    });
    // Sem preço cadastrado o gateway não chama o modelo (custo que não se mede não se gasta).
    const [preco] = await ownerQuery<{ n: number }>(
      `select count(*)::int as n from liame.ai_model_price where provider = 'anthropic' and model = 'claude-sonnet-5-5' and valid_from <= (now() at time zone 'UTC')::date`,
    );
    expect(preco!.n).toBeGreaterThan(0);
  });

  it('a migration é idempotente: rodar de novo não duplica a rota nem reativa a que saiu do caminho', async () => {
    const antes = await ownerQuery<{ task: string; status: string }>(`select task, status from liame.ai_model_route where ${DA_DISTRIBUICAO} order by task`);
    for (const arquivo of ['0046_rotas_de_modelo.sql', '0051_rota_do_criativo.sql', '0061_rota_do_crm.sql']) {
      const sql = readFileSync(resolve(MIGRATIONS, arquivo), 'utf8');
      await ownerQuery(sql);
      await ownerQuery(sql);
    }
    const depois = await ownerQuery<{ task: string; status: string }>(`select task, status from liame.ai_model_route where ${DA_DISTRIBUICAO} order by task`);
    expect(depois.map((x) => x.task)).toEqual(antes.map((x) => x.task));
    expect(depois).toHaveLength(7);
    // Nunca duas ativas na mesma tarefa (o índice único garante; aqui fica dito).
    const ativas = await ownerQuery<{ task: string; n: number }>(`select task, count(*)::int as n from liame.ai_model_route where status = 'ativa' group by task having count(*) > 1`);
    expect(ativas).toEqual([]);
  });

  it('a flag do funcionário de CRM e mensageria nasce desligada para todos, e não é flag de escrita (migration 0061)', async () => {
    const flag = await ownerQuery<{ default_value: unknown; is_write: boolean; owner: string; regras: number }>(
      `select f.default_value, f.is_write, f.owner, (select count(*)::int from liame.feature_flag_rule r where r.flag_key = f.key and r.created_by <> 'testes') as regras
         from liame.feature_flag f where f.key = 'crm'`,
    );
    expect(flag).toEqual([{ default_value: false, is_write: false, owner: 'mensageria', regras: 0 }]);
  });
});
