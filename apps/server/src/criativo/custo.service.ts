import type { AdPieceAiUsage } from '@liame/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TAREFA_CRIATIVO_TEXTO, WORKFLOW_DO_CRIATIVO } from '../ai/criativo/prompt.js';
import { type UsoDeIa, usoDeIaDaEmpresa } from '../ai/uso.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';

// O custo das peças do Criativo à vista (A4, X6; `plano-a4.md` D-A4-32, proposta; protótipo P10, aguardando aprovação):
// antes de pedir, quanto do limite de uso de IA a empresa já usou e a estimativa de um pedido; o pedido que não cabe no
// que resta é negado na hora (o gateway só barra depois de o limite estourar). Tudo em micros de dólar, que é como o
// custo é medido e limitado; quem mostra em reais é a tela, com a cotação de referência.
//
// A estimativa não é chute: é a média do que os pedidos da própria empresa custaram. Sem histórico, vale o teto de
// custo da rota de modelo da tarefa, que é o máximo que um pedido deve custar. O custo de um pedido de texto quase não
// muda com a quantidade de peças: a maior parte é a leitura das instruções e de Minha marca.

/** Quantos pedidos atendidos entram na média, e de quantos dias para cá. */
const AMOSTRA = 20;
const DIAS_DA_AMOSTRA = 30;
/** Com menos pedidos que isto a média ainda não diz nada: vale o teto da rota. */
const AMOSTRA_MINIMA = 3;

export interface EstimativaDoPedido {
  usdMicros: bigint;
  /** `historico`: a média dos pedidos atendidos da empresa; `teto_da_rota`: o máximo que um pedido deve custar. */
  base: 'historico' | 'teto_da_rota';
  /** Quantos pedidos entraram na média (zero no teto da rota). */
  amostra: number;
}

export interface CustoDasPecas {
  uso: UsoDeIa;
  /** O que as peças desta marca custaram hoje. */
  pecasHoje: bigint;
  /** Nula quando a tarefa não tem rota de modelo ativa (sem ela, o Criativo não trabalha). */
  estimativa: EstimativaDoPedido | null;
  /** O pedido cabe no que resta do limite? Sem estimativa, basta sobrar alguma coisa. */
  cabe: boolean;
}

/** A estimativa de um pedido: a média do histórico quando ele basta; senão, o teto da rota; sem rota, nada. */
export function estimativaDoPedido(historico: { media: bigint | null; amostra: number }, tetoDaRota: bigint | null): EstimativaDoPedido | null {
  if (historico.media !== null && historico.amostra >= AMOSTRA_MINIMA) return { usdMicros: historico.media, base: 'historico', amostra: historico.amostra };
  return tetoDaRota === null ? null : { usdMicros: tetoDaRota, base: 'teto_da_rota', amostra: 0 };
}

/** O custo no formato do contrato. */
export function respostaDoCusto(c: CustoDasPecas): AdPieceAiUsage {
  return {
    band: c.uso.situacao,
    day: { spent_usd_micros: c.uso.gastoDia.toString(), ceiling_usd_micros: c.uso.tetoDia.toString() },
    month: { spent_usd_micros: c.uso.gastoMes.toString(), ceiling_usd_micros: c.uso.tetoMes.toString() },
    remaining_usd_micros: c.uso.resta.toString(),
    binding: c.uso.aperta,
    pieces_today_usd_micros: c.pecasHoje.toString(),
    request_estimate: c.estimativa ? { usd_micros: c.estimativa.usdMicros.toString(), basis: c.estimativa.base, sample: c.estimativa.amostra } : null,
    fits: c.cabe,
  };
}

/** US$ com duas casas, para a mensagem do erro (a tela mostra em reais, com a cotação). */
const emDolar = (micros: bigint): string => `US$ ${(Number(micros) / 1_000_000).toFixed(2).replace('.', ',')}`;

@Injectable()
export class CustoDasPecasService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** O uso de IA da empresa agora, o que as peças da marca custaram hoje e a estimativa de um pedido de texto. */
  async ler(tenantId: string, brandId: string, agora: Date): Promise<CustoDasPecas> {
    const tx = currentTx();
    const uso = await usoDeIaDaEmpresa(tx, tenantId, { dailyLimitUsdMicros: this.config.ai.dailyLimitUsdMicros, monthlyLimitUsdMicros: this.config.ai.monthlyLimitUsdMicros }, agora);
    const desde = new Date(agora.getTime() - DIAS_DA_AMOSTRA * 86_400_000).toISOString();
    // O histórico é o da empresa (todas as marcas): o pedido custa pelo tamanho das instruções e do dossiê, e a média
    // de poucos pedidos de uma marca só diria menos. Só a chamada que entregou resposta entra (V88).
    const l = (
      await tx.execute<{ pecas_hoje: string; media: string | null; amostra: number; teto_da_rota: string | null }>(sql`
        with ultimos as (
          select u.cost_usd_micros as custo
            from liame.ai_usage u
           where u.tenant_id = ${tenantId} and u.workflow = ${WORKFLOW_DO_CRIATIVO} and u.answered and u.occurred_at >= ${desde}::timestamptz
           order by u.occurred_at desc
           limit ${AMOSTRA})
        select (select coalesce(sum(u.cost_usd_micros), 0)::text from liame.ai_usage u
                 where u.tenant_id = ${tenantId} and u.brand_id = ${brandId} and u.workflow = ${WORKFLOW_DO_CRIATIVO}
                   and u.occurred_at >= ${uso.inicioDoDia}::timestamptz) as pecas_hoje,
               (select round(avg(custo))::bigint::text from ultimos) as media,
               (select count(*)::int from ultimos) as amostra,
               (select r.max_cost_usd_micros::text from liame.ai_model_route r where r.task = ${TAREFA_CRIATIVO_TEXTO} and r.status = 'ativa') as teto_da_rota`)
    ).rows[0]!;
    const estimativa = estimativaDoPedido({ media: l.media === null ? null : BigInt(l.media), amostra: Number(l.amostra) }, l.teto_da_rota === null ? null : BigInt(l.teto_da_rota));
    return { uso, pecasHoje: BigInt(l.pecas_hoje), estimativa, cabe: estimativa ? estimativa.usdMicros <= uso.resta : uso.resta > 0n };
  }

  /** Nega na hora o pedido à IA que não cabe no que resta do limite de uso de IA da empresa (D-A4-32). */
  async exigirQueCaiba(tenantId: string, brandId: string, agora: Date): Promise<void> {
    const c = await this.ler(tenantId, brandId, agora);
    if (c.cabe) return;
    const limite = c.uso.aperta === 'mes' ? 'do mês' : 'de hoje';
    const custa = c.estimativa ? `O pedido custa ${c.estimativa.base === 'historico' ? 'cerca de' : 'até'} ${emDolar(c.estimativa.usdMicros)}, e restam ${emDolar(c.uso.resta)}.` : 'Não resta nada do limite.';
    throw new AppProblem(
      409,
      'limite-de-ia',
      `O pedido não cabe no limite de uso de IA ${limite}`,
      `${custa} Dá para aprovar, editar e recusar as peças que já existem. Pedir peça nova volta ${c.uso.aperta === 'mes' ? 'no mês que vem' : 'amanhã'}, ou quando o limite da empresa for revisto.`,
    );
  }
}
