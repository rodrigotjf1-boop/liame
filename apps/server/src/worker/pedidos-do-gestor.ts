import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ActionService } from '../actions/action.service.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { pessoaPode } from '../auth/pessoa-pode.js';
import { currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { GESTOR_DE_TRAFEGO } from '../equipe/membros.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { carregarPoliticas } from '../policy/policy.service.js';
import { modoDaAcao } from '../sombra/autonomia.js';
import { type MotivoDeNaoPedir, motivoDoProblema, pedidoDaRecomendacao, verbaRecomendada } from '../sombra/pedido.js';
import type { AcaoSombra } from '../sombra/regras.js';

// O pedido do Gestor de tráfego no modo Aprovação (A4, X3 parte 2; proposta D-A4-26). Fica na pasta do worker porque
// grava a tentativa em escopo de sistema (regra `liame-escopo-sistema`). Depois da rodada da manhã da sombra, a
// recomendação NOVA de uma ação que está em Aprovação naquela conta vira um pedido de ação, feito por ele:
//   - o pedido passa pelo Action Service, como o de uma pessoa (trava, flag de escrita, política, limites da empresa,
//     estado lido na plataforma), e espera a aprovação de uma pessoa com o código do app;
//   - quem responde pelo pedido é a pessoa que publicou a regra do modo na política (ela precisa continuar na empresa e
//     podendo pedir ações): o funcionário nunca pode mais do que quem o deixou pedir;
//   - UMA tentativa por recomendação. O que não deu para pedir fica na recomendação, com o motivo, e a Atenção mostra:
//     ele não tenta de novo sozinho.
// Só roda para a empresa com a flag `modo_aprovacao` ligada. Nada é executado aqui.

const ROTULO_DO_GESTOR = 'Gestor de tráfego';

type Candidata = {
  id: string;
  tool: AcaoSombra;
  provider: string;
  connected_account_id: string;
  percent: number | string | null;
  campanha_externa: string;
  verba_de_agora: string | null;
  moeda: string | null;
};

export type ResultadoDosPedidos = { pedidos: number; semPedido: number };

@Injectable()
export class PedidosDoGestor {
  private readonly logger = new Logger('pedidos-do-gestor');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly actions: ActionService,
    private readonly flags: FlagService,
  ) {}

  /** As recomendações de hoje da marca que estão em Aprovação: cada uma vira um pedido, ou fica com o motivo de não ter virado. */
  async pedirAsDeHoje(alvo: { tenantId: string; brandId: string; hoje: string }): Promise<ResultadoDosPedidos> {
    const resultado: ResultadoDosPedidos = { pedidos: 0, semPedido: 0 };
    if (!this.database) return resultado;
    const database = this.database;
    const { tenantId, brandId } = alvo;
    if (!(await this.flags.isEnabled('modo_aprovacao', this.flags.context({ tenantId, brandId })))) return resultado;

    // ---- 1. leitura, como a empresa: as recomendações de hoje sem tentativa e sem pedido, e o modo de cada uma
    const aPedir = await naTransacaoDaEmpresa(database, { tenantId, userId: null }, async () => {
      const tx = currentTx();
      const candidatas = (
        await tx.execute<Candidata>(sql`
          select d.id, d.tool, d.provider, d.connected_account_id, (d.params->>'percent')::numeric::integer as percent,
                 c.external_id as campanha_externa, c.daily_budget_micros::text as verba_de_agora, a.currency as moeda
            from liame.shadow_decision d
            join liame.connected_account a on a.id = d.connected_account_id and a.disconnected_at is null
            join liame.campaign c on c.id = d.campaign_id
           where d.tenant_id = ${tenantId} and d.brand_id = ${brandId} and d.status = 'aberta' and d.decided_on = ${alvo.hoje}::date
             and d.human_action is null and d.request_attempted_at is null
             and not exists (select 1 from liame.action_request r where r.shadow_decision_id = d.id)
           order by d.id`)
      ).rows;
      if (!candidatas.length) return [];
      const { policies } = await carregarPoliticas(tx, tenantId, brandId);
      const emAprovacao: Array<{ c: Candidata; responsavel: string | null }> = [];
      for (const c of candidatas) {
        const percent = c.percent === null ? null : Number(c.percent);
        const atual = c.verba_de_agora === null ? null : BigInt(c.verba_de_agora);
        const nova = c.tool === 'campanha_pausar' ? null : verbaRecomendada(atual, percent, c.tool === 'orcamento_reduzir' ? 'reduzir' : 'aumentar', c.moeda);
        const modo = modoDaAcao(policies, {
          tool: c.tool,
          brandId,
          provider: c.provider,
          accountId: c.connected_account_id,
          valorAtualMicros: atual === null ? null : Number(atual),
          valorMicros: nova === null ? null : Number(nova),
        });
        if (modo.mode !== 'APPROVAL') continue;
        // Quem deixou o funcionário pedir: a pessoa que publicou a versão da política de onde o modo vem.
        const autor =
          modo.source === 'tenant' || modo.source === 'brand'
            ? (
                await tx.execute<{ created_by: string | null }>(sql`
                  select created_by from liame.policy
                   where tenant_id = ${tenantId} and brand_id is not distinct from ${modo.source === 'brand' ? brandId : null}
                     and version = ${modo.version} and status = 'ativa'`)
              ).rows[0]?.created_by
            : null;
        const responsavel = autor && (await pessoaPode(tx, { tenantId, userId: autor, permissao: 'campanhas.operar' })) ? autor : null;
        emAprovacao.push({ c, responsavel });
      }
      return emAprovacao;
    });

    // ---- 2. um pedido por recomendação, cada um na sua transação; a tentativa fica gravada de qualquer jeito
    for (const { c, responsavel } of aPedir) {
      const falha = await this.pedir(database, tenantId, c, responsavel);
      await withSystem(database.db, (tx) =>
        tx.execute(sql`
          update liame.shadow_decision
             set request_attempted_at = now(), request_error = ${falha?.codigo ?? null}, request_error_detail = ${falha?.detalhe ?? null}, updated_at = now()
           where id = ${c.id} and tenant_id = ${tenantId} and request_attempted_at is null`),
      );
      if (falha) {
        resultado.semPedido++;
        this.logger.warn(`recomendação ${c.id}: o pedido não foi feito (${falha.codigo})`);
      } else {
        resultado.pedidos++;
      }
    }
    return resultado;
  }

  /** Faz o pedido de uma recomendação. Devolve nulo se o pedido entrou, ou o motivo de não ter entrado. */
  private async pedir(database: Database, tenantId: string, c: Candidata, responsavel: string | null): Promise<MotivoDeNaoPedir | null> {
    if (!responsavel) {
      return {
        codigo: 'sem-responsavel',
        detalhe: 'Quem liberou o modo Aprovação não está mais na empresa, ou não pode mais pedir ações. Alguém com permissão precisa liberar o modo de novo.',
      };
    }
    const pedido = pedidoDaRecomendacao({
      tool: c.tool,
      provider: c.provider,
      campanhaExterna: c.campanha_externa,
      verbaDiariaMicros: c.verba_de_agora === null ? null : BigInt(c.verba_de_agora),
      percent: c.percent === null ? null : Number(c.percent),
      moeda: c.moeda,
    });
    if (!pedido) {
      return { codigo: 'sem-pedido-possivel', detalhe: 'Não dá para pedir esta mudança pelo Liame: a campanha não tem verba diária própria, ou a plataforma não é mudada por aqui.' };
    }
    try {
      await naTransacaoDaEmpresa(database, { tenantId, userId: null }, () =>
        this.actions.pedirPeloFuncionario(
          { tenantId, agentKey: GESTOR_DE_TRAFEGO, agentLabel: ROTULO_DO_GESTOR, emNomeDe: responsavel },
          { ...pedido, provider: c.provider, account_id: c.connected_account_id, recommendation_id: c.id },
        ),
      );
      return null;
    } catch (err) {
      // O que o trilho recusou (trava, flag, política, limite, a Meta sem resposta, pedido igual na fila): o motivo é o dele.
      if (err instanceof AppProblem) return motivoDoProblema(err);
      // Falha fora do previsto: fica o motivo genérico na recomendação (ele não tenta de novo) e a causa no log (V6).
      this.logger.error(`recomendação ${c.id}: falha ao pedir: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return { codigo: 'erro-interno', detalhe: 'O Liame teve uma falha ao fazer este pedido. Nada foi pedido; se a mudança ainda fizer sentido, peça por aqui.' };
    }
  }
}
