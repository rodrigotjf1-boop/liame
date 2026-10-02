import type { Database } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { currentTx } from '../../context/request-context.js';
import { DATABASE } from '../../database/database.module.js';
import { AppProblem } from '../../errors/problems.js';
import { ResultsService } from '../../results/results.service.js';
import { AiError, type AiErrorCode, AiGateway } from '../gateway.js';
import { naTransacaoDaEmpresa } from '../na-empresa.js';
import { funcionarioAtivo } from '../registro/ativacao.js';
import type { ContextoDaLeitura } from '../registro/leituras.js';
import { nomesPoliticos } from '../../policy/texto.js';
import { type ContextoDaExplicacao, contextoDosResultados, nomesDoContexto, periodoAnterior } from './contexto.js';
import { ANALISTA, PROMPT_EXPLICAR_RESULTADOS, TAREFA_EXPLICAR_RESULTADOS } from './prompt.js';
import { conferirExplicacao, Explicacao, type Recusa } from './resposta.js';
import { explicacaoSemIa } from './sem-ia.js';

/** Por que a explicação é a do código e não a da IA. */
export type MotivoSemIa = AiErrorCode | Recusa | 'dado_velho' | 'funcionario_desligado' | 'conteudo_politico';

export interface ExplicacaoDosResultados {
  origem: 'ia' | 'sem_ia';
  motivo_sem_ia: MotivoSemIa | null;
  explicacao: Explicacao;
  periodo: { de: string | null; ate: string | null };
  comparado_com: { de: string | null; ate: string | null } | null;
  fontes_fora_do_dia: ContextoDaExplicacao['fontes_fora_do_dia'];
  /** Linha de `ai_usage` da resposta da IA; nula quando a explicação é a do código. */
  usage_id: string | null;
}

/**
 * "Explicar" dos resultados (A3, I4): o código lê os números (os mesmos da tela Resultados), compara com o
 * período anterior e monta o contexto; a IA só escreve a explicação. Com a IA desligada, fora do ar, no
 * teto, com dado velho, ou se ela citar um número que não está no contexto, vale a explicação do código
 * (A3-5, A3-6). Sempre devolve uma explicação.
 */
@Injectable()
export class ExplicarService {
  private readonly logger = new Logger('explicar');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly gateway: AiGateway,
    private readonly resultados: ResultsService,
  ) {}

  async dosResultados(ctx: ContextoDaLeitura, q: { brand_id: string; unit_id?: string; from: string; to: string }): Promise<ExplicacaoDosResultados> {
    if (!this.database) throw new Error('explicar: sem banco');
    // A mesma permissão da tela Resultados: quem não vê os números não recebe a explicação deles.
    if (ctx.permissions !== 'sistema' && !ctx.permissions.has('vendas.ver')) {
      throw new AppProblem(403, 'sem-permissao', 'Sem permissão', 'Você não tem permissão para ver os resultados de vendas.');
    }

    // Leitura curta, na transação da empresa; a chamada ao modelo vem depois, sem transação aberta.
    const antes = periodoAnterior(q.from, q.to);
    const lido = await naTransacaoDaEmpresa(this.database, ctx, async () => ({
      atual: await this.resultados.closedLoop(q, ctx.agora),
      anterior: await this.resultados.closedLoop({ ...q, ...antes }, ctx.agora),
      ativo: await funcionarioAtivo(currentTx(), { tenantId: ctx.tenantId, brandId: q.brand_id, agentKey: ANALISTA.key, ativoPorPadrao: ANALISTA.ativoPorPadrao }),
    }));
    const contexto = contextoDosResultados(lido.atual, lido.anterior);
    const base = {
      periodo: { de: contexto.resultado.periodo.de ?? null, ate: contexto.resultado.periodo.ate ?? null },
      comparado_com: contexto.comparacao?.periodo_anterior ?? null,
      fontes_fora_do_dia: contexto.fontes_fora_do_dia,
    };
    const semIa = (motivo: MotivoSemIa): ExplicacaoDosResultados => ({ origem: 'sem_ia', motivo_sem_ia: motivo, explicacao: explicacaoSemIa(contexto), ...base, usage_id: null });

    // A IA não explica com dado velho: a explicação seria sobre um número que já mudou.
    if (contexto.fontes_fora_do_dia.length) return semIa('dado_velho');
    if (!lido.ativo) return semIa('funcionario_desligado');
    // Uso político ou eleitoral é proibido nos Termos e bloqueado por regra (A3-15): com campanha ou conta
    // de nome político, a IA nem é chamada. A explicação do código segue, com os números.
    if (nomesPoliticos(nomesDoContexto(contexto)).length) {
      this.logger.warn(`explicação sem IA: campanha ou conta com nome político ou eleitoral (empresa ${ctx.tenantId})`);
      return semIa('conteudo_politico');
    }

    try {
      const r = await this.gateway.structured({
        tenantId: ctx.tenantId,
        brandId: q.brand_id,
        userId: ctx.userId,
        workflow: 'resultados.explicar',
        task: TAREFA_EXPLICAR_RESULTADOS,
        promptVersion: `${PROMPT_EXPLICAR_RESULTADOS.key}@${PROMPT_EXPLICAR_RESULTADOS.version}`,
        instructions: PROMPT_EXPLICAR_RESULTADOS.content,
        messages: [{ role: 'user', content: JSON.stringify(contexto) }],
        schema: Explicacao,
      });
      const recusa = conferirExplicacao(r.object, contexto);
      if (recusa) {
        // O que foi recusado e por quê fica no log (números não são dado pessoal) e no conteúdo guardado da chamada.
        this.logger.warn(`explicação da IA recusada (${recusa.recusa}${recusa.detalhe.length ? `: ${recusa.detalhe.slice(0, 8).join(' | ')}` : ''}); uso ${r.usageId}`);
        return semIa(recusa.recusa);
      }
      return { origem: 'ia', motivo_sem_ia: null, explicacao: r.object, ...base, usage_id: r.usageId };
    } catch (err) {
      if (err instanceof AiError) return semIa(err.code);
      throw err;
    }
  }
}
