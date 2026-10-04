import { type Database, withContext } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../../database/database.module.js';
import { FlagService } from '../../flags/flag.service.js';
import { AiError, AiGateway } from '../gateway.js';
import { registrarRecusa } from '../recusas.js';
import { type CategoriaDoRevisor, categoriasDoParecer, mensagemDoRevisor, Parecer, type TextoParaRevisar } from './parecer.js';
import { PROMPT_REVISOR, TAREFA_REVISAO, WORKFLOW_DO_REVISOR } from './prompt.js';

// O revisor de IA do Compliance (A3, I9; D-A3-16 e D-A3-17). É um portão DEPOIS das regras de texto do código: quem
// chama só o consulta com o texto que já passou na conferência (formato, regras, números), então ele nunca libera o que
// uma regra barrou e nunca aprova sozinho. Se aponta tom, clareza ou alegação, o texto não aparece: a tela mostra o que
// o sistema escreve, e o caso entra nos textos barrados com a categoria, sem o texto (D-A3-15).
//
// Nasce desligado para todos (flag `revisor`, migration 0043): com ela desligada, nada muda. Ligada, o portão é
// obrigatório: sem rota de modelo publicada para o revisor, ou se ele não responder, o texto da IA não aparece (um
// portão que abre quando quebra pode ser aberto pelo próprio texto que ele confere). Para não pagar por um texto que
// não vai aparecer, quem chama pergunta a `situacao` antes de chamar a IA que escreve.

export const FLAG_DO_REVISOR = 'revisor';
/** O porquê, em `ai_refusal.kind` e na resposta das rotas, do texto que o revisor de IA não deixou aparecer. */
export const RECUSA_DO_REVISOR = 'revisor';
/**
 * O porquê, em `ai_refusal.kind`, do texto que não apareceu porque o revisor não respondeu. Não é texto barrado pelo
 * Compliance (ninguém apontou problema nele): entra só nas respostas retiradas de quem escreveu, para a conta de Sua
 * equipe fechar (toda resposta escrita ou chegou à pessoa, ou tem aqui o porquê de não ter chegado).
 */
export const RECUSA_SEM_REVISOR = 'revisor_sem_resposta';

/** `desligado`: a empresa não tem o revisor. `pronto`: tem, com rota publicada. `sem_rota`: tem, e ele não pode responder. */
export type SituacaoDoRevisor = 'desligado' | 'pronto' | 'sem_rota';

/** De quem é o texto: o que a linha da recusa guarda (nunca o texto). */
export interface TextoDe {
  tenantId: string;
  brandId: string;
  /** Quem pediu o texto (o contexto da gravação da recusa); nulo em rotina do sistema. */
  userId: string | null;
  /** O funcionário que escreveu: `lia`, `analista`, `relatorios`, `estrategista`. */
  member: string;
  workflow: string;
  /** A linha de `ai_usage` da chamada que escreveu o texto. */
  usageId: string;
}

export type Revisao =
  | { situacao: 'passou' }
  | { situacao: 'apontou'; categorias: CategoriaDoRevisor[] }
  /** O revisor não respondeu (sem rota, teto, parada, fornecedor fora, resposta fora do formato): o texto não aparece. */
  | { situacao: 'indisponivel'; erro: AiError };

@Injectable()
export class RevisorService {
  private readonly logger = new Logger('revisor');
  /** A tarefa (rota de modelo) do revisor. Num campo para o teste poder apontar para uma tarefa sem rota: a rota de verdade é do produto, uma só para todos. */
  protected readonly tarefa: string = TAREFA_REVISAO;

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly gateway: AiGateway,
    private readonly flags: FlagService,
  ) {}

  /**
   * O revisor vale para esta empresa e esta marca, e pode responder? Não gasta nada; abre uma transação curta própria.
   * Com a IA desligada para a empresa não há texto para revisar: quem chama segue, e o gateway diz `desligada`.
   */
  async situacao(quem: { tenantId: string; brandId: string | null; userId?: string | null }): Promise<SituacaoDoRevisor> {
    const contexto = { tenantId: quem.tenantId, userId: quem.userId ?? null, brandId: quem.brandId };
    if (!(await this.flags.isEnabled(FLAG_DO_REVISOR, this.flags.context(contexto)))) return 'desligado';
    if (!(await this.gateway.ligada(contexto))) return 'desligado';
    if (!this.database) return 'sem_rota';
    const rota = await withContext(this.database.db, { tenantId: quem.tenantId, userId: null }, (tx) =>
      tx.execute(sql`select 1 from liame.ai_model_route where task = ${this.tarefa} and status = 'ativa' limit 1`),
    );
    return rota.rows.length ? 'pronto' : 'sem_rota';
  }

  /**
   * Revisa um texto que já passou na conferência do código. A chamada é do sistema (não conta no limite por hora de
   * quem pediu o texto) e o custo aparece no Compliance, em Sua equipe. Quando aponta, grava a recusa (sem o texto) e
   * devolve as categorias; nunca rejeita por falha da IA: devolve `indisponivel`, e quem chama cai no texto do sistema.
   */
  async revisar(texto: TextoParaRevisar, de: TextoDe): Promise<Revisao> {
    let categorias: CategoriaDoRevisor[];
    try {
      const r = await this.gateway.structured({
        tenantId: de.tenantId,
        brandId: de.brandId,
        userId: null,
        workflow: WORKFLOW_DO_REVISOR,
        task: this.tarefa,
        promptVersion: `${PROMPT_REVISOR.key}@${PROMPT_REVISOR.version}`,
        instructions: PROMPT_REVISOR.content,
        messages: [{ role: 'user', content: mensagemDoRevisor(texto) }],
        schema: Parecer,
      });
      const parecer = Parecer.safeParse(r.object);
      if (!parecer.success) throw new AiError('indisponivel', 'revisor: parecer fora do formato');
      categorias = categoriasDoParecer(parecer.data);
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      this.logger.warn(`revisor de IA sem resposta (${err.code}): o texto de ${de.member} (${de.workflow}) não aparece; uso ${de.usageId}`);
      await this.anotar(de, RECUSA_SEM_REVISOR, [], null);
      return { situacao: 'indisponivel', erro: err };
    }
    if (!categorias.length) return { situacao: 'passou' };
    // Só a categoria vai para o log e para o banco: o texto fica no conteúdo guardado da chamada, por 30 dias.
    this.logger.warn(`texto de ${de.member} (${de.workflow}) apontado pelo revisor de IA: ${categorias.join(', ')}; uso ${de.usageId}`);
    // A versão que barrou é a do prompt do revisor (as regras de texto têm a delas, `REGRAS_DE_TEXTO_VERSAO`).
    await this.anotar(de, RECUSA_DO_REVISOR, categorias, PROMPT_REVISOR.version);
    return { situacao: 'apontou', categorias };
  }

  /** O texto que não apareceu entra na contagem de Sua equipe, sem o texto (D-A3-15). Nunca rejeita. */
  private async anotar(de: TextoDe, kind: string, rules: readonly string[], rulesVersion: number | null): Promise<void> {
    if (!this.database) return;
    await registrarRecusa(this.database, { tenantId: de.tenantId, brandId: de.brandId, userId: de.userId, usageId: de.usageId, member: de.member, workflow: de.workflow, kind, rules, rulesVersion });
  }
}
