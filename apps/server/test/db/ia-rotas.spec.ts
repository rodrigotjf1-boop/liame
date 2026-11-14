import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runMigrations } from '@liame/database';
import { beforeAll, describe, expect, it } from 'vitest';
import { TAREFA_CONVERSA } from '../../src/ai/conversa/prompt.js';
import { TAREFA_CRIATIVO_GOOGLE } from '../../src/ai/criativo/google.js';
import { TAREFA_CRIATIVO_TEXTO } from '../../src/ai/criativo/prompt.js';
import { TAREFA_CRM_MENSAGEM } from '../../src/ai/crm/prompt.js';
import { TAREFA_ESTRATEGISTA } from '../../src/ai/estrategista/prompt.js';
import { TAREFA_EXPLICAR_RESULTADOS } from '../../src/ai/explicar/prompt.js';
import { aceitaGeo } from '../../src/ai/modelos.js';
import { TAREFA_PESQUISADOR } from '../../src/ai/pesquisador/prompt.js';
import { TAREFA_REVISAO } from '../../src/ai/revisor/prompt.js';
import { TAREFA_SOCIAL_COMENTARIO, TAREFA_SOCIAL_COMENTARIO_TIPO, TAREFA_SOCIAL_POST, TAREFA_SOCIAL_RESPOSTA } from '../../src/ai/social/prompt.js';
import { TAREFA_SOCIAL_DIRECT } from '../../src/ai/social/direct.js';
import { TAREFA_SOCIAL_VIDEO } from '../../src/ai/social/video.js';
import { ownerQuery } from '../helpers/api.js';
import { hasDb, OWNER_URL } from './env.js';

// As rotas de modelo que a distribuição publica (migration 0046, as cinco tarefas da A3; 0051, o Criativo de texto; 0061, o
// funcionário de CRM e mensageria; 0084, o Social media nas respostas às avaliações; 0113, a versão 2 com o Haiku 5.5 como
// modelo econômico do Compliance, do Pesquisador e do Criativo de texto; 0116, o Social media nos posts; 0126, o Social
// media nas respostas aos comentários; 0127, o tipo do comentário, com o Haiku 5.5 como modelo da rota; 0153, os textos
// da campanha nova no Google e os do vídeo montado; 0158, a sugestão do Social media no Direct e no Messenger): uma
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

// As tarefas em que o Haiku 5.5 passou nas duas rodadas (28/10 e 03/11/2026) e virou o modelo econômico (migration 0113).
const COM_ECONOMICO = new Set([TAREFA_REVISAO, TAREFA_PESQUISADOR, TAREFA_CRIATIVO_TEXTO]);
// O modelo de cada tarefa: o Sonnet 5.5, menos o tipo do comentário, que classifica e roda no Haiku 5.5 (D-A6-87; o mais
// barato que passou nas duas rodadas de 10/11/2026, migration 0127), com a saída de uma palavra.
const MODELO_DA_TAREFA = (task: string): string => (task === TAREFA_SOCIAL_COMENTARIO_TIPO ? 'claude-haiku-5-5' : 'claude-sonnet-5-5');
// A saída da rodada do eval de cada tarefa (os `responder-*` de `ai/evals/`): 1.500 na maioria; 1.200 nos textos do Google;
// 600 nos do vídeo (título, preço e chamada, curtos); 300 no tipo do comentário (uma palavra).
const SAIDA_DA_RODADA: Record<string, number> = { [TAREFA_SOCIAL_COMENTARIO_TIPO]: 300, [TAREFA_SOCIAL_VIDEO]: 600, [TAREFA_CRIATIVO_GOOGLE]: 1200 };
const SAIDA_MINIMA = (task: string): number => SAIDA_DA_RODADA[task] ?? 1500;

describe.skipIf(!hasDb)('rotas de modelo da distribuição (A3, I3; A4, X6; A5, Y6 e Y9; A6, Z6, Z11 e Z15; migrations 0046, 0051, 0061, 0084, 0113, 0116, 0126, 0127, 0153 e 0158) e o preço novo do Sonnet (0083)', () => {
  /** A versão mais nova da distribuição em cada tarefa (a 0113 aposenta a 1 e põe a 2 nas tarefas com o econômico). */
  const rotas = () =>
    ownerQuery<Rota>(
      `select distinct on (task) task, status, version, purpose, provider, model, effort, max_output_tokens, timeout_ms, max_cost_usd_micros::int as max_cost,
              fallback, economy_model, eval_threshold::float8 as eval_threshold, eval_score::float8 as eval_score, deployed_at is not null as publicada
         from liame.ai_model_route where ${DA_DISTRIBUICAO} order by task, version desc`,
    );

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: MIGRATIONS });
  });

  it('cada tarefa de IA do código tem a rota da rodada dos evals: modelo com preço, que aceita rodar só nos Estados Unidos, e a nota acima do limiar', async () => {
    const r = await rotas();
    // As tarefas são as do código: tarefa nova sem rota, ou rota de tarefa que não existe, aparece aqui.
    expect(r.map((x) => x.task)).toEqual(
      [
        TAREFA_REVISAO,
        TAREFA_CONVERSA,
        TAREFA_CRIATIVO_GOOGLE,
        TAREFA_CRIATIVO_TEXTO,
        TAREFA_CRM_MENSAGEM,
        TAREFA_ESTRATEGISTA,
        TAREFA_EXPLICAR_RESULTADOS,
        TAREFA_PESQUISADOR,
        TAREFA_SOCIAL_COMENTARIO,
        TAREFA_SOCIAL_COMENTARIO_TIPO,
        TAREFA_SOCIAL_DIRECT,
        TAREFA_SOCIAL_POST,
        TAREFA_SOCIAL_RESPOSTA,
        TAREFA_SOCIAL_VIDEO,
      ].sort(),
    );
    for (const x of r) {
      expect(x).toMatchObject({ task: x.task, provider: 'anthropic', model: MODELO_DA_TAREFA(x.task), effort: 'low', fallback: [], eval_threshold: 0.95 });
      if (COM_ECONOMICO.has(x.task) && x.version === 2) expect(x.economy_model).toBe('claude-haiku-5-5');
      else expect(x).toMatchObject({ version: 1, economy_model: null });
      // A que entrou valendo tem a data da publicação; o rascunho, não.
      expect(['ativa', 'aposentada', 'rascunho']).toContain(x.status);
      expect(x.publicada).toBe(x.status !== 'rascunho');
      // Regra do produto: modelo só entra numa tarefa depois de passar no eval dela.
      expect(x.eval_score).toBeGreaterThanOrEqual(x.eval_threshold);
      // D-A3-13: só entra em rota o modelo que aceita rodar só nos Estados Unidos (o gateway não chamaria outro).
      expect(aceitaGeo(x.provider, x.model)).toBe(true);
      // O da rodada do eval de cada tarefa: 2.000 nas da A3, A4 e A5; 1.500 nas sugestões de resposta (uma ou duas, curtas),
      // nos posts (o texto de cada canal e a foto) e nas respostas aos comentários (até três, curtas); 300 no tipo do
      // comentário (uma palavra).
      expect({ task: x.task, cabe: x.max_output_tokens >= SAIDA_MINIMA(x.task) }).toEqual({ task: x.task, cabe: true });
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
      // E o Social media: a resposta pública a uma avaliação, na voz da marca.
      [TAREFA_SOCIAL_RESPOSTA]: 'texto',
      // E nos posts: o texto do Instagram e o da Página, na voz da marca (migration 0116, sem modelo econômico: o Haiku 5.5
      // reprovou na segunda rodada).
      [TAREFA_SOCIAL_POST]: 'texto',
      // E nas respostas aos comentários: as sugestões públicas de uma pergunta ou de uma reclamação (migration 0126, sem
      // modelo econômico: o volume é pequeno e o Haiku 5.5 não foi medido nesta tarefa).
      [TAREFA_SOCIAL_COMENTARIO]: 'texto',
      // O tipo do comentário classifica, não escreve (migration 0127).
      [TAREFA_SOCIAL_COMENTARIO_TIPO]: 'analise',
      // Os textos da campanha nova no Google e os do vídeo montado também são texto criativo (migration 0153, sem modelo
      // econômico: o Haiku 5.5 não foi medido nessas tarefas).
      [TAREFA_CRIATIVO_GOOGLE]: 'texto',
      [TAREFA_SOCIAL_VIDEO]: 'texto',
      // E a sugestão do Social media numa conversa do Direct ou do Messenger, a pedido de quem atende (migration 0158, sem
      // modelo econômico: o volume é pequeno e o Haiku 5.5 não foi medido nesta tarefa).
      [TAREFA_SOCIAL_DIRECT]: 'texto',
      [TAREFA_ESTRATEGISTA]: 'analise',
      [TAREFA_EXPLICAR_RESULTADOS]: 'analise',
      [TAREFA_PESQUISADOR]: 'analise',
    });
    // Sem preço cadastrado o gateway não chama o modelo (custo que não se mede não se gasta): cada modelo de rota tem o dele.
    for (const modelo of new Set(r.map((x) => x.model))) {
      const [preco] = await ownerQuery<{ n: number }>(
        `select count(*)::int as n from liame.ai_model_price where provider = 'anthropic' and model = $1 and valid_from <= (now() at time zone 'UTC')::date`,
        [modelo],
      );
      expect({ modelo, n: preco!.n > 0 }).toEqual({ modelo, n: true });
    }
  });

  it('a migration é idempotente: rodar de novo não duplica a rota nem reativa a que saiu do caminho', async () => {
    const antes = await ownerQuery<{ task: string; status: string }>(`select task, status from liame.ai_model_route where ${DA_DISTRIBUICAO} order by task`);
    for (const arquivo of ['0046_rotas_de_modelo.sql', '0051_rota_do_criativo.sql', '0061_rota_do_crm.sql', '0084_rota_do_social.sql', '0113_haiku_economico.sql', '0116_rota_dos_posts.sql', '0126_rota_dos_comentarios.sql', '0127_rota_do_tipo_do_comentario.sql', '0153_rotas_dos_textos_do_google_e_do_video.sql', '0158_rota_da_sugestao_no_direct.sql']) {
      const sql = readFileSync(resolve(MIGRATIONS, arquivo), 'utf8');
      await ownerQuery(sql);
      await ownerQuery(sql);
    }
    const depois = await ownerQuery<{ task: string; status: string }>(`select task, status from liame.ai_model_route where ${DA_DISTRIBUICAO} order by task`);
    expect(depois.map((x) => x.task)).toEqual(antes.map((x) => x.task));
    expect(new Set(depois.map((x) => x.task)).size).toBe(14);
    // Nunca duas ativas na mesma tarefa (o índice único garante; aqui fica dito).
    const ativas = await ownerQuery<{ task: string; n: number }>(`select task, count(*)::int as n from liame.ai_model_route where status = 'ativa' group by task having count(*) > 1`);
    expect(ativas).toEqual([]);
  });

  it('o Haiku 5.5 é o modelo econômico só do Compliance, do Pesquisador e do Criativo de texto, com preço e só nos Estados Unidos (migration 0113)', async () => {
    const versoes = await ownerQuery<{ task: string; version: number; status: string; economy_model: string | null; created_by: string }>(
      `select task, version, status, economy_model, created_by from liame.ai_model_route where ${DA_DISTRIBUICAO} order by task, version`,
    );
    const da = (task: string) => versoes.filter((v) => v.task === task);
    for (const task of new Set(versoes.map((v) => v.task))) {
      const vs = da(task);
      if (!COM_ECONOMICO.has(task)) {
        // As outras tarefas seguem só com a versão 1, sem econômico (o Haiku reprovou nelas em 28/10).
        expect(vs.map((v) => [v.version, v.economy_model])).toEqual([[1, null]]);
        continue;
      }
      const v2 = vs.find((v) => v.version === 2);
      if (!v2) {
        // Banco em que a versão 1 já tinha saído do caminho (um teste a aposentou antes): a 0113 não mexe.
        expect(vs[0]!.status).not.toBe('ativa');
        continue;
      }
      expect(v2).toMatchObject({ economy_model: 'claude-haiku-5-5', created_by: 'distribuição: evals de 28/10 e 03/11/2026 (migration 0113)' });
      // A versão 1 saiu do caminho: nunca duas valendo.
      expect(vs.find((v) => v.version === 1)!.status).toBe('aposentada');
    }
    // O gateway só chama o econômico com preço cadastrado e que rode só nos Estados Unidos (D-A3-13).
    expect(aceitaGeo('anthropic', 'claude-haiku-5-5')).toBe(true);
    const [preco] = await ownerQuery<{ n: number }>(
      `select count(*)::int as n from liame.ai_model_price where provider = 'anthropic' and model = 'claude-haiku-5-5' and valid_from <= (now() at time zone 'UTC')::date`,
    );
    expect(preco!.n).toBeGreaterThan(0);
  });

  it('a flag do funcionário de CRM e mensageria nasce desligada para todos, e não é flag de escrita (migration 0061)', async () => {
    const flag = await ownerQuery<{ default_value: unknown; is_write: boolean; owner: string; regras: number }>(
      `select f.default_value, f.is_write, f.owner, (select count(*)::int from liame.feature_flag_rule r where r.flag_key = f.key and r.created_by <> 'testes') as regras
         from liame.feature_flag f where f.key = 'crm'`,
    );
    expect(flag).toEqual([{ default_value: false, is_write: false, owner: 'mensageria', regras: 0 }]);
  });

  it('o preço do Sonnet 5.5 que vale hoje lê o cache a 0,05× a entrada; o de 01/10/2026 fica como estava, e rodar de novo não duplica (migration 0083)', async () => {
    const sql = readFileSync(resolve(MIGRATIONS, '0083_preco_novo_do_sonnet.sql'), 'utf8');
    await ownerQuery(sql);
    await ownerQuery(sql);
    const linhas = await ownerQuery<{ valid_from: string; input: number; output: number; cache_read: number; write_5m: number; write_1h: number }>(
      `select to_char(valid_from, 'YYYY-MM-DD') as valid_from, input_usd_micros_per_mtok::int as input, output_usd_micros_per_mtok::int as output,
              cache_read_usd_micros_per_mtok::int as cache_read, cache_write_5m_usd_micros_per_mtok::int as write_5m,
              cache_write_1h_usd_micros_per_mtok::int as write_1h
         from liame.ai_model_price where provider = 'anthropic' and model = 'claude-sonnet-5-5' order by valid_from`,
    );
    expect(linhas).toEqual([
      // A da página de 02/10/2026: o custo já registrado com ela não muda.
      { valid_from: '2026-10-01', input: 2_000_000, output: 10_000_000, cache_read: 200_000, write_5m: 2_500_000, write_1h: 4_000_000 },
      // A da página de 28/10/2026: só a leitura do cache mudou.
      { valid_from: '2026-10-28', input: 2_000_000, output: 10_000_000, cache_read: 100_000, write_5m: 2_500_000, write_1h: 4_000_000 },
    ]);
    // A que o gateway usa hoje, pela mesma regra dele: a mais nova que já começou.
    const [hoje] = await ownerQuery<{ cache_read: number }>(
      `select cache_read_usd_micros_per_mtok::int as cache_read from liame.ai_model_price
        where provider = 'anthropic' and model = 'claude-sonnet-5-5' and valid_from <= (now() at time zone 'UTC')::date
        order by valid_from desc limit 1`,
    );
    expect(hoje).toEqual({ cache_read: 100_000 });
  });

  it('o Haiku 5.5 entra com a faixa do prompt longo; a faixa vem inteira ou não vem, e rodar de novo não duplica (migration 0089)', async () => {
    const sql = readFileSync(resolve(MIGRATIONS, '0089_preco_do_haiku_por_faixa.sql'), 'utf8');
    await ownerQuery(sql);
    await ownerQuery(sql);
    const linhas = await ownerQuery<Record<string, number | string>>(
      `select to_char(valid_from, 'YYYY-MM-DD') as valid_from, input_usd_micros_per_mtok::int as input, output_usd_micros_per_mtok::int as output,
              cache_read_usd_micros_per_mtok::int as cache_read, cache_write_5m_usd_micros_per_mtok::int as write_5m,
              cache_write_1h_usd_micros_per_mtok::int as write_1h, long_prompt_above_tokens as acima_de,
              long_input_usd_micros_per_mtok::int as l_input, long_output_usd_micros_per_mtok::int as l_output,
              long_cache_read_usd_micros_per_mtok::int as l_cache_read, long_cache_write_5m_usd_micros_per_mtok::int as l_write_5m,
              long_cache_write_1h_usd_micros_per_mtok::int as l_write_1h
         from liame.ai_model_price where provider = 'anthropic' and model = 'claude-haiku-5-5' order by valid_from`,
    );
    expect(linhas).toEqual([
      {
        valid_from: '2026-10-29', input: 100_000, output: 500_000, cache_read: 10_000, write_5m: 125_000, write_1h: 200_000,
        acima_de: 100_000, l_input: 500_000, l_output: 2_500_000, l_cache_read: 50_000, l_write_5m: 625_000, l_write_1h: 1_000_000,
      },
    ]);
    // Os outros modelos da distribuição seguem sem faixa (o preço é o mesmo em todo o contexto).
    const comFaixa = await ownerQuery<{ model: string }>(
      `select model from liame.ai_model_price where provider = 'anthropic' and long_prompt_above_tokens is not null group by model order by model collate "C"`,
    );
    expect(comFaixa).toEqual([{ model: 'claude-haiku-5-5' }]);

    // A restrição (V119): a faixa pela metade, o limite zerado e o preço negativo não entram; a inteira entra.
    const gravar = (faixa: string) =>
      ownerQuery(
        `select set_config('app.scope', 'sistema', true);
         insert into liame.ai_model_price (id, provider, model, valid_from, input_usd_micros_per_mtok, output_usd_micros_per_mtok,
                cache_read_usd_micros_per_mtok, cache_write_5m_usd_micros_per_mtok, cache_write_1h_usd_micros_per_mtok,
                long_prompt_above_tokens, long_input_usd_micros_per_mtok, long_output_usd_micros_per_mtok,
                long_cache_read_usd_micros_per_mtok, long_cache_write_5m_usd_micros_per_mtok, long_cache_write_1h_usd_micros_per_mtok, source, checked_on)
         values (gen_random_uuid(), 'teste', 'faixa-0089', '2026-10-29', 1, 1, 1, 1, 1, ${faixa}, 'https://exemplo.test/precos', '2026-10-29')`,
      );
    await expect(gravar('100000, 5, 5, 5, 5, null')).rejects.toThrow(/ai_model_price_faixa_check/);
    await expect(gravar('0, 5, 5, 5, 5, 5')).rejects.toThrow(/ai_model_price_faixa_check/);
    await expect(gravar('100000, 5, -1, 5, 5, 5')).rejects.toThrow(/ai_model_price_faixa_check/);
    await gravar('100000, 5, 5, 5, 5, 5');
    await ownerQuery(`select set_config('app.scope', 'sistema', true); delete from liame.ai_model_price where provider = 'teste' and model = 'faixa-0089'`);
  });
});
