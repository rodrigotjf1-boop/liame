import type { SetTeamModelRequest, TeamModelPurposeState, TeamModelsResponse } from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  estimarCusto,
  ehFinalidade,
  FINALIDADES,
  FLAG_DA_ESCOLHA_DE_MODELO,
  NOME_DA_FINALIDADE,
  nomeDoModelo,
  type Opcao,
  opcoesDaFinalidade,
  quemUsa,
  type TokensDoGrupo,
} from '../ai/escolha-de-modelo.js';
import { type LinhaDoPreco, type PrecoModelo, precoDaLinha } from '../ai/precos.js';
import { ultimaCotacao } from '../cambio/cotacao.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';

type Rota = { task: string; purpose: string; provider: string; model: string };
type Escolha = { purpose: string; provider: string; model: string; chosen_at: Date | string; by_id: string | null; by_name: string | null };
type Grupo = { task: string; geo: string | null; input: string; cache_read: string; cache_write: string; output: string; custo: string; respostas: number };

/**
 * Os modelos de IA da empresa no Pro (A3, I13; protótipo P7, aprovado em 03/10/2026; D-A3-25 a D-A3-28): o automático de
 * cada finalidade, os modelos do catálogo que ela pode escolher, a estimativa de custo de cada um pelos últimos 30 dias
 * completos e a escolha. A escolha vale para a empresa inteira (o teto de IA é da empresa), e só o Dono e o
 * Administrador trocam (`politicas.gerenciar`).
 */
@Injectable()
export class ModelosDaEquipeService {
  constructor(private readonly flags: FlagService) {}

  private empresa(auth: AuthContext): string {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa', 'Sem empresa ativa', 'Escolha uma empresa para continuar.');
    return auth.tenantId;
  }

  async ver(auth: AuthContext, agora = new Date()): Promise<TeamModelsResponse> {
    const tenantId = this.empresa(auth);
    const tx = currentTx();
    const enabled = await this.flags.isEnabled(FLAG_DA_ESCOLHA_DE_MODELO, this.flags.context({ tenantId, userId: auth.userId }));
    // A janela: os 30 dias COMPLETOS antes de hoje, no fuso da empresa (V57).
    const janela = (
      await tx.execute<{ de: string; ate: string; inicio: Date | string; fim: Date | string }>(sql`
        select ((${agora.toISOString()}::timestamptz at time zone o.timezone)::date - 30)::text as de,
               ((${agora.toISOString()}::timestamptz at time zone o.timezone)::date - 1)::text as ate,
               (((${agora.toISOString()}::timestamptz at time zone o.timezone)::date - 30)::timestamp at time zone o.timezone) as inicio,
               (((${agora.toISOString()}::timestamptz at time zone o.timezone)::date)::timestamp at time zone o.timezone) as fim
          from liame.organization o where o.id = ${tenantId}`)
    ).rows[0];
    if (!janela) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'A empresa não foi encontrada.');

    const rotas = (await tx.execute<Rota>(sql`select task, purpose, provider, model from liame.ai_model_route where status = 'ativa' order by task collate "C"`)).rows;
    const catalogo = (
      await tx.execute<Opcao>(sql`select task, provider, model, label, speed, eval_score::text as eval_score from liame.ai_model_option where status = 'oferecida'`)
    ).rows;
    const escolhas = (
      await tx.execute<Escolha>(sql`
        select c.purpose, c.provider, c.model, c.chosen_at, u.id as by_id, u.name as by_name
          from liame.ai_model_choice c left join liame.app_user u on u.id = c.chosen_by
         where c.tenant_id = ${tenantId}`)
    ).rows;
    // O uso da janela por tarefa e região: só as chamadas que chegaram a um modelo (as barradas não têm tokens).
    const grupos = (
      await tx.execute<Grupo>(sql`
        select task, inference_geo as geo, sum(input_tokens)::text as input, sum(cache_read_tokens)::text as cache_read,
               sum(cache_write_tokens)::text as cache_write, sum(output_tokens)::text as output, sum(cost_usd_micros)::text as custo,
               count(*) filter (where answered)::int as respostas
          from liame.ai_usage
         where tenant_id = ${tenantId} and model is not null and occurred_at >= ${janela.inicio} and occurred_at < ${janela.fim}
         group by task, inference_geo`)
    ).rows;

    const purposes: TeamModelPurposeState[] = [];
    const precosPedidos = new Set<string>();
    const porFinalidade = FINALIDADES.map((f) => {
      const tarefas = rotas.filter((r) => r.purpose === f);
      const nomes = tarefas.map((r) => r.task);
      const opcoes = opcoesDaFinalidade(nomes, catalogo);
      const modelos = new Set(tarefas.map((r) => `${r.provider}/${r.model}`));
      const automatico = modelos.size === 1 ? tarefas[0]! : null;
      if (automatico) precosPedidos.add(`${automatico.provider}/${automatico.model}`);
      for (const o of opcoes) precosPedidos.add(`${o.provider}/${o.model}`);
      return { f, tarefas: nomes, opcoes, automatico };
    });
    const precos = await this.precos(precosPedidos);

    for (const { f, tarefas, opcoes, automatico } of porFinalidade) {
      const meus = grupos.filter((g) => tarefas.includes(g.task));
      const tokens: TokensDoGrupo[] = meus.map((g) => ({
        geo: g.geo === 'us' ? 'us' : 'global',
        input: Number(g.input),
        cacheRead: Number(g.cache_read),
        cacheWrite: Number(g.cache_write),
        output: Number(g.output),
      }));
      const escolha = escolhas.find((e) => e.purpose === f) ?? null;
      purposes.push({
        purpose: f,
        label: NOME_DA_FINALIDADE[f],
        tasks: tarefas,
        members: quemUsa(tarefas),
        answered: meus.reduce((n, g) => n + g.respostas, 0),
        automatic: automatico ? { provider: automatico.provider, model: automatico.model, label: nomeDoModelo(automatico.model) } : null,
        spent_usd_micros: meus.reduce((n, g) => n + BigInt(g.custo), 0n).toString(),
        options: opcoes.map((o) => ({
          provider: o.provider,
          model: o.model,
          label: o.label,
          speed: o.speed,
          eval_score: o.evalScore,
          estimated_usd_micros: estimarCusto(precos.get(`${o.provider}/${o.model}`), tokens)?.toString() ?? null,
        })),
        choice: escolha
          ? {
              provider: escolha.provider,
              model: escolha.model,
              label: catalogo.find((o) => o.provider === escolha.provider && o.model === escolha.model)?.label ?? nomeDoModelo(escolha.model),
              by: escolha.by_id ? { id: escolha.by_id, name: escolha.by_name ?? '' } : null,
              at: new Date(escolha.chosen_at).toISOString(),
              offered: opcoes.some((o) => o.provider === escolha.provider && o.model === escolha.model),
            }
          : null,
      });
    }

    return {
      enabled,
      can_change: auth.permissions.has('politicas.gerenciar'),
      window: { from: janela.de, to: janela.ate },
      usd_brl: await ultimaCotacao(tx),
      purposes,
    };
  }

  /** O preço que vale hoje de cada modelo pedido (a mesma leitura do gateway). */
  private async precos(chaves: Set<string>): Promise<Map<string, PrecoModelo>> {
    if (!chaves.size) return new Map();
    const pares = [...chaves].map((k) => k.split('/') as [string, string]);
    const linhas = await currentTx().execute<LinhaDoPreco & { provider: string; model: string }>(sql`
      select distinct on (provider, model) provider, model,
             input_usd_micros_per_mtok::text as input, output_usd_micros_per_mtok::text as output,
             cache_read_usd_micros_per_mtok::text as cache_read, cache_write_5m_usd_micros_per_mtok::text as cache_write_5m,
             cache_write_1h_usd_micros_per_mtok::text as cache_write_1h,
             long_prompt_above_tokens as acima_de, long_input_usd_micros_per_mtok::text as l_input,
             long_output_usd_micros_per_mtok::text as l_output, long_cache_read_usd_micros_per_mtok::text as l_cache_read,
             long_cache_write_5m_usd_micros_per_mtok::text as l_cache_write_5m, long_cache_write_1h_usd_micros_per_mtok::text as l_cache_write_1h
        from liame.ai_model_price
       where provider in ${[...new Set(pares.map((p) => p[0]))]} and model in ${[...new Set(pares.map((p) => p[1]))]}
         and valid_from <= (now() at time zone 'UTC')::date
       order by provider, model, valid_from desc`);
    return new Map(linhas.rows.map((p) => [`${p.provider}/${p.model}`, precoDaLinha(p)]));
  }

  /**
   * Troca o modelo de uma finalidade: um modelo do catálogo dela, ou nulo para voltar ao automático. Vale a partir da
   * próxima resposta; a auditoria guarda o antes e o depois.
   */
  async escolher(auth: AuthContext, finalidade: string, body: SetTeamModelRequest, agora = new Date()): Promise<TeamModelsResponse> {
    const tenantId = this.empresa(auth);
    if (!ehFinalidade(finalidade)) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Esta finalidade não existe.');
    if (!(await this.flags.isEnabled(FLAG_DA_ESCOLHA_DE_MODELO, this.flags.context({ tenantId, userId: auth.userId })))) {
      throw new AppProblem(409, 'funcao-desligada', 'Ainda não disponível', 'A escolha do modelo ainda não está liberada para esta empresa. Tudo segue no automático.');
    }
    const tx = currentTx();
    // Duas trocas ao mesmo tempo na mesma finalidade: com a escolha já gravada, a linha travada faz a segunda esperar a
    // primeira; sem ela, a regra de uma por empresa e finalidade e o `upsert` abaixo deixam uma linha só.
    const antes = (
      await tx.execute<{ provider: string; model: string }>(sql`
        select provider, model from liame.ai_model_choice where tenant_id = ${tenantId} and purpose = ${finalidade} for update`)
    ).rows[0] ?? null;

    if (body.model === null) {
      await tx.execute(sql`delete from liame.ai_model_choice where tenant_id = ${tenantId} and purpose = ${finalidade}`);
    } else {
      const tarefas = (await tx.execute<{ task: string }>(sql`select task from liame.ai_model_route where status = 'ativa' and purpose = ${finalidade}`)).rows.map((r) => r.task);
      const catalogo = (
        await tx.execute<Opcao>(sql`select task, provider, model, label, speed, eval_score::text as eval_score from liame.ai_model_option where status = 'oferecida'`)
      ).rows;
      const pedido = body.model;
      if (!opcoesDaFinalidade(tarefas, catalogo).some((o) => o.provider === pedido.provider && o.model === pedido.model)) {
        throw new AppProblem(422, 'fora-do-catalogo', 'Modelo fora do catálogo', 'Este modelo não está no catálogo desta finalidade. Escolha um da lista ou o automático.');
      }
      await tx.execute(sql`
        insert into liame.ai_model_choice (id, tenant_id, purpose, provider, model, chosen_by, chosen_at)
        values (${uuidv7()}, ${tenantId}, ${finalidade}, ${pedido.provider}, ${pedido.model}, ${auth.userId}, ${agora.toISOString()})
        on conflict (tenant_id, purpose) do update
          set provider = excluded.provider, model = excluded.model, chosen_by = excluded.chosen_by, chosen_at = excluded.chosen_at`);
    }
    auditDetail({ before: { purpose: finalidade, model: antes ? `${antes.provider}/${antes.model}` : 'automatico' }, after: { model: body.model ? `${body.model.provider}/${body.model.model}` : 'automatico' } });
    return this.ver(auth, agora);
  }
}
