import type { AttentionItem, ClosedLoopResponse } from '@liame/contracts';
import type { Database } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { currentTx } from '../../context/request-context.js';
import { DATABASE } from '../../database/database.module.js';
import { AppProblem } from '../../errors/problems.js';
import { proibidasDaMarca } from '../../marca/marca.service.js';
import { MediaService } from '../../media/media.service.js';
import { nomesPoliticos } from '../../policy/texto.js';
import { AtencaoCicloService } from '../../results/atencao-ciclo.service.js';
import { diaNoFuso, menosDias } from '../../results/fora-do-normal.js';
import { ResultsService } from '../../results/results.service.js';
import { AiError, type AiErrorCode, type AiErrorDetail, AiGateway } from '../gateway.js';
import { naTransacaoDaEmpresa } from '../na-empresa.js';
import { funcionarioAtivo } from '../registro/ativacao.js';
import type { ContextoDaLeitura } from '../registro/leituras.js';
import { AVISOS_EXPLICAVEIS, avisoNoContexto, DIAS_DO_AVISO, explicacaoDoAvisoSemIa } from './aviso.js';
import { type ContextoComAviso, type ContextoDaExplicacao, type ContextoDoAviso, contextoDosResultados, nomesDoContexto, periodoAnterior } from './contexto.js';
import { type ExplicacaoMarcada, marcarNumeros } from './fontes.js';
import { ANALISTA, PROMPT_EXPLICAR_RESULTADOS, TAREFA_EXPLICAR_RESULTADOS } from './prompt.js';
import { conferirExplicacao, Explicacao, type Recusa } from './resposta.js';
import { explicacaoSemIa } from './sem-ia.js';

/** O nome, em `ai_usage.workflow`, da leitura da revisão da semana: a chamada é do sistema, sem pessoa. */
export const WORKFLOW_DA_REVISAO = 'revisao.semanal';

/** Por que a explicação é a do código e não a da IA. */
export type MotivoSemIa = AiErrorCode | Recusa | 'dado_velho' | 'funcionario_desligado' | 'conteudo_politico';

export interface ExplicacaoPronta {
  origem: 'ia' | 'sem_ia';
  motivo_sem_ia: MotivoSemIa | null;
  explicacao: Explicacao;
  /** A mesma explicação com cada número marcado, e de onde cada um veio (quem diz é o código). */
  marcada: ExplicacaoMarcada;
  periodo: { de: string | null; ate: string | null };
  comparado_com: { de: string | null; ate: string | null } | null;
  fontes_fora_do_dia: ContextoDaExplicacao['fontes_fora_do_dia'];
  /** Linha de `ai_usage` da resposta da IA; nula quando a explicação é a do código. */
  usage_id: string | null;
  /** Com o limite por pessoa: quando a IA volta a responder. */
  volta_em: string | null;
  /** Com o teto de custo: qual deles barrou. */
  teto: 'dia' | 'mes' | null;
  gerada_em: string;
}
/** Nome antigo (I4 sem tela): a explicação dos resultados é uma `ExplicacaoPronta`. */
export type ExplicacaoDosResultados = ExplicacaoPronta;

/** O aviso da tela, pelo que o identifica: os avisos são calculados na hora e não têm id. */
export interface AvisoPedido {
  brand_id: string;
  kind: string;
  connected_account_id: string | null;
  campaign_id: string | null;
  provider: string | null;
}

const pode = (ctx: ContextoDaLeitura, permissao: string) => ctx.permissions === 'sistema' || ctx.permissions.has(permissao);

/**
 * "Explicar" (A3, I4): o código lê os números (os mesmos da tela), monta o contexto e diz de onde vem cada
 * número; a IA só escreve a explicação. Com a IA desligada, fora do ar, no teto, com dado velho, ou se ela
 * citar um número que não está no contexto, vale a explicação do código (A3-5, A3-6). Sempre devolve uma
 * explicação. A leitura é curta e na transação da empresa; a chamada ao modelo vem depois, sem transação
 * aberta (a rota é `@SemTransacao`).
 */
@Injectable()
export class ExplicarService {
  private readonly logger = new Logger('explicar');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly gateway: AiGateway,
    private readonly resultados: ResultsService,
    private readonly media: MediaService,
    private readonly ciclo: AtencaoCicloService,
  ) {}

  /** Os resultados de um período (o número principal da tela Resultados). */
  async dosResultados(ctx: ContextoDaLeitura, q: { brand_id: string; unit_id?: string; from: string; to: string }): Promise<ExplicacaoPronta> {
    if (!this.database) throw new Error('explicar: sem banco');
    this.exigirVendas(ctx);
    const antes = periodoAnterior(q.from, q.to);
    const lido = await naTransacaoDaEmpresa(this.database, ctx, async () => ({
      atual: await this.resultados.closedLoop(q, ctx.agora),
      anterior: await this.resultados.closedLoop({ ...q, ...antes }, ctx.agora),
      ativo: await this.analistaAtivo(ctx, q.brand_id),
      daMarca: await proibidasDaMarca(q.brand_id),
    }));
    const contexto = contextoDosResultados(lido.atual, lido.anterior);
    return this.explicar(ctx, q.brand_id, contexto, 'resultados.explicar', lido, () => explicacaoSemIa(contexto));
  }

  /**
   * A leitura de uma semana fechada, para a revisão da semana (A3, I7). Quem chama é a rotina do worker, que
   * já leu os resultados das duas semanas (os mesmos números vão para a revisão) e se o Analista está ativo;
   * aqui não há transação aberta: é a chamada ao modelo, com a mesma tarefa, o mesmo prompt e a mesma
   * conferência do Explicar. Sem a LIA, a leitura é a do sistema, com o motivo.
   */
  async daSemana(
    ctx: ContextoDaLeitura,
    brandId: string,
    lido: { atual: ClosedLoopResponse; anterior: ClosedLoopResponse | null; ativo: boolean; daMarca?: string[] },
  ): Promise<ExplicacaoPronta> {
    this.exigirVendas(ctx);
    const contexto = contextoDosResultados(lido.atual, lido.anterior);
    return this.explicar(ctx, brandId, contexto, WORKFLOW_DA_REVISAO, lido, () => explicacaoSemIa(contexto, { semana: true }));
  }

  /** O Analista está ativo para esta marca? Roda na transação de quem chama. */
  analistaLigado(ctx: ContextoDaLeitura, brandId: string | null): Promise<boolean> {
    return this.analistaAtivo(ctx, brandId);
  }

  /** Um aviso da Atenção, com os resultados dos últimos 7 dias completos da marca. */
  async doAviso(ctx: ContextoDaLeitura, q: AvisoPedido): Promise<ExplicacaoPronta> {
    if (!this.database) throw new Error('explicar: sem banco');
    this.exigirVendas(ctx);
    if (!AVISOS_EXPLICAVEIS.has(q.kind)) {
      throw new AppProblem(422, 'aviso-sem-explicacao', 'Este aviso não tem explicação', 'A explicação vale para os avisos de campanha, de medição e para o que saiu do normal.');
    }
    const agora = ctx.agora ?? new Date();
    const lido = await naTransacaoDaEmpresa(this.database, ctx, async () => {
      const fuso = await this.resultados.fusoDaMarca(q.brand_id);
      const hoje = diaNoFuso(agora, fuso);
      const janela = { from: menosDias(hoje, DIAS_DO_AVISO), to: menosDias(hoje, 1) };
      // Os avisos de agora, pelos mesmos serviços das rotas: o de mídia, só para quem acompanha as campanhas.
      const avisos: AttentionItem[] = [
        ...(pode(ctx, 'campanhas.ver') ? (await this.media.atencao(q.brand_id, agora)).items : []),
        ...(await this.ciclo.atencao(q.brand_id, agora)).items,
      ];
      const item = avisos.find((i) => i.kind === q.kind && i.connected_account_id === q.connected_account_id && i.campaign_id === q.campaign_id && i.provider === q.provider);
      if (!item) throw new AppProblem(404, 'aviso-nao-encontrado', 'Este aviso não está mais ativo', 'Atualize a tela para ver os avisos de agora.');
      const atual = await this.resultados.closedLoop({ brand_id: q.brand_id, ...janela }, agora);
      const anterior = await this.resultados.closedLoop({ brand_id: q.brand_id, ...periodoAnterior(janela.from, janela.to) }, agora);
      let campanha = item.campaign_id ? (atual.campaigns.find((c) => c.campaign_id === item.campaign_id)?.name ?? null) : null;
      if (item.campaign_id && !campanha) {
        campanha = (await currentTx().execute<{ name: string }>(sql`select name from liame.campaign where id = ${item.campaign_id}`)).rows[0]?.name ?? null;
      }
      return { item, campanha, atual, anterior, ativo: await this.analistaAtivo(ctx, q.brand_id), daMarca: await proibidasDaMarca(q.brand_id) };
    });
    const contexto: ContextoDoAviso = { aviso: avisoNoContexto(lido.item, lido.campanha), ...contextoDosResultados(lido.atual, lido.anterior) };
    return this.explicar({ ...ctx, agora }, q.brand_id, contexto, 'atencao.explicar', lido, () => explicacaoDoAvisoSemIa(contexto));
  }

  /**
   * A LIA responde para esta empresa e esta marca? A flag `ia` é a chave geral; o Analista é quem explica.
   * É o que a tela pergunta antes de oferecer a LIA; não gasta nada. Roda na transação de quem chama.
   */
  async liaLigada(ctx: ContextoDaLeitura, brandId: string | null): Promise<boolean> {
    if (!(await this.gateway.ligada({ tenantId: ctx.tenantId, userId: ctx.userId, brandId }))) return false;
    return this.analistaAtivo(ctx, brandId);
  }

  private exigirVendas(ctx: ContextoDaLeitura): void {
    // A mesma permissão da tela Resultados: quem não vê os números não recebe a explicação deles.
    if (!pode(ctx, 'vendas.ver')) throw new AppProblem(403, 'sem-permissao', 'Sem permissão', 'Você não tem permissão para ver os resultados de vendas.');
  }

  private analistaAtivo(ctx: ContextoDaLeitura, brandId: string | null): Promise<boolean> {
    return funcionarioAtivo(currentTx(), { tenantId: ctx.tenantId, brandId, agentKey: ANALISTA.key, ativoPorPadrao: ANALISTA.ativoPorPadrao });
  }

  /** `lido.daMarca`: o que a marca nunca diz (dossiê, I8), lido na mesma transação curta dos números. */
  private async explicar(
    ctx: ContextoDaLeitura,
    brandId: string,
    contexto: ContextoComAviso,
    workflow: string,
    lido: { ativo: boolean; daMarca?: string[] },
    semIaDe: () => Explicacao,
  ): Promise<ExplicacaoPronta> {
    const ativo = lido.ativo;
    const gerada = (ctx.agora ?? new Date()).toISOString();
    const pronta = (origem: 'ia' | 'sem_ia', motivo: MotivoSemIa | null, explicacao: Explicacao, usageId: string | null, detalhe: AiErrorDetail = {}): ExplicacaoPronta => ({
      origem,
      motivo_sem_ia: motivo,
      explicacao,
      marcada: marcarNumeros(explicacao, contexto),
      periodo: { de: contexto.resultado.periodo.de ?? null, ate: contexto.resultado.periodo.ate ?? null },
      comparado_com: contexto.comparacao?.periodo_anterior ?? null,
      fontes_fora_do_dia: contexto.fontes_fora_do_dia,
      usage_id: usageId,
      volta_em: detalhe.voltaEm ? detalhe.voltaEm.toISOString() : null,
      teto: detalhe.teto ?? null,
      gerada_em: gerada,
    });
    const semIa = (motivo: MotivoSemIa, detalhe?: AiErrorDetail) => pronta('sem_ia', motivo, semIaDe(), null, detalhe);

    // A IA não explica com dado velho: a explicação seria sobre um número que já mudou.
    if (contexto.fontes_fora_do_dia.length) return semIa('dado_velho');
    if (!ativo) return semIa('funcionario_desligado');
    // Uso político ou eleitoral é proibido nos Termos e bloqueado por regra (A3-15): com campanha ou conta
    // de nome político, a IA nem é chamada. A explicação do código segue, com os números.
    if (nomesPoliticos(nomesDoContexto(contexto)).length) {
      this.logger.warn(`explicação sem IA: campanha ou conta com nome político ou eleitoral (empresa ${ctx.tenantId})`);
      return semIa('conteudo_politico');
    }

    try {
      const r = await this.gateway.structured({
        tenantId: ctx.tenantId,
        brandId,
        userId: ctx.userId,
        workflow,
        task: TAREFA_EXPLICAR_RESULTADOS,
        promptVersion: `${PROMPT_EXPLICAR_RESULTADOS.key}@${PROMPT_EXPLICAR_RESULTADOS.version}`,
        instructions: PROMPT_EXPLICAR_RESULTADOS.content,
        messages: [{ role: 'user', content: JSON.stringify(contexto) }],
        schema: Explicacao,
      });
      const recusa = conferirExplicacao(r.object, contexto, { daMarca: lido.daMarca });
      if (recusa) {
        // O que foi recusado e por quê fica no log (números não são dado pessoal) e no conteúdo guardado da chamada.
        this.logger.warn(`explicação da IA recusada (${recusa.recusa}${recusa.detalhe.length ? `: ${recusa.detalhe.slice(0, 8).join(' | ')}` : ''}); uso ${r.usageId}`);
        return semIa(recusa.recusa);
      }
      return pronta('ia', null, r.object, r.usageId);
    } catch (err) {
      if (err instanceof AiError) return semIa(err.code, err.detalhe);
      throw err;
    }
  }
}
