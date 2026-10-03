import type { AiFeedbackRequest, AiFeedbackResponse } from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { WORKFLOW_DA_REVISAO } from './explicar/explicar.service.js';
import { limparTexto } from './sanitizar.js';

/**
 * O retorno da pessoa sobre uma explicação da LIA (A3, I4; protótipo P4): "Fez sentido" ou "Discordo", com
 * o motivo. Fica no Liame, ligado à chamada que gerou a explicação, e nunca vai para o fornecedor do modelo.
 * O texto livre passa pela mesma limpeza de dado pessoal de tudo o que envolve a IA. Um retorno por pessoa
 * e explicação: mudar de ideia regrava a mesma linha.
 */
@Injectable()
export class RetornoService {
  async gravar(auth: { tenantId: string | null; userId: string }, pedido: AiFeedbackRequest): Promise<AiFeedbackResponse> {
    const tx = currentTx();
    // Só sobre uma explicação que a própria pessoa pediu, nesta empresa (a RLS já corta as de outra), ou
    // sobre a leitura da revisão da semana, que o sistema gera para a empresa inteira (sem pessoa).
    const uso = await tx.execute<{ id: string }>(sql`
      select id from liame.ai_usage
       where id = ${pedido.usage_id} and outcome = 'ok' and model is not null
         and (user_id = ${auth.userId} or (user_id is null and workflow = ${WORKFLOW_DA_REVISAO}))`);
    if (!uso.rows.length) {
      throw new AppProblem(404, 'explicacao-nao-encontrada', 'Não encontramos esta explicação', 'O retorno vale para uma explicação da LIA que você pediu ou para a leitura da revisão da semana.');
    }
    const discordo = pedido.verdict === 'discordo';
    const motivos = discordo ? [...new Set(pedido.reasons)] : [];
    const texto = discordo && pedido.comment ? limparTexto(pedido.comment).texto.trim() : '';
    if (discordo && !motivos.length && !texto) {
      throw new AppProblem(422, 'motivo-obrigatorio', 'Diga o motivo', 'Marque pelo menos um motivo ou escreva o que houve.');
    }
    const r = await tx.execute<{ usage_id: string; verdict: string; reasons: string[]; comment: string | null; updated_at: Date | string }>(sql`
      insert into liame.ai_feedback (id, tenant_id, usage_id, user_id, verdict, reasons, comment)
      values (${uuidv7()}, ${auth.tenantId}, ${pedido.usage_id}, ${auth.userId}, ${pedido.verdict},
              array(select jsonb_array_elements_text(${JSON.stringify(motivos)}::jsonb)), ${texto || null})
      on conflict (usage_id, user_id) do update
         set verdict = excluded.verdict, reasons = excluded.reasons, comment = excluded.comment, updated_at = now()
      returning usage_id, verdict, reasons, comment, updated_at`);
    const linha = r.rows[0]!;
    return { usage_id: linha.usage_id, verdict: linha.verdict, reasons: linha.reasons, comment: linha.comment, updated_at: new Date(linha.updated_at).toISOString() };
  }
}
