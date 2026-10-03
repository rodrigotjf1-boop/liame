import type { AiFeedbackResponse, ExplanationResponse } from '@liame/contracts';
import { api, chamar, type Resultado } from '@/lib/api';
import type { MotivoDoDiscordo } from './textos';

// As chamadas do "Explicar" (A3 · I4). A explicação nunca falha por causa da IA: sem ela, a mesma rota
// devolve o resumo do sistema, com o motivo. O que falha aqui é a rede, a permissão ou o aviso que sumiu.

/** O que a tela quer explicado: os resultados de um período, ou um aviso da Atenção (pelo que o identifica). */
export type PedidoDeExplicacao =
  | { de: 'resultados'; brand_id: string; from: string; to: string; unit_id?: string }
  | { de: 'aviso'; brand_id: string; kind: string; connected_account_id: string | null; campaign_id: string | null; provider: string | null };

export function pedirExplicacao(p: PedidoDeExplicacao): Promise<Resultado<ExplanationResponse>> {
  if (p.de === 'resultados') {
    const body = { brand_id: p.brand_id, from: p.from, to: p.to, ...(p.unit_id ? { unit_id: p.unit_id } : {}) };
    return chamar(() => api.POST('/v1/ai/explain/results', { body }));
  }
  const body = { brand_id: p.brand_id, kind: p.kind, connected_account_id: p.connected_account_id, campaign_id: p.campaign_id, provider: p.provider };
  return chamar(() => api.POST('/v1/ai/explain/attention', { body }));
}

/** A LIA responde para esta empresa (e esta marca)? Na dúvida (a leitura falhou), não: o botão fica neutro. */
export async function liaLigada(marca?: string | null): Promise<boolean> {
  const r = await chamar(() => api.GET('/v1/ai/status', { params: { query: marca ? { brand_id: marca } : {} } }));
  return r.ok && r.data.lia;
}

export function mandarRetorno(
  usageId: string,
  retorno: { veredito: 'fez_sentido' } | { veredito: 'discordo'; motivos: MotivoDoDiscordo[]; comentario: string },
): Promise<Resultado<AiFeedbackResponse>> {
  const comentario = retorno.veredito === 'discordo' ? retorno.comentario.trim() : '';
  const body =
    retorno.veredito === 'fez_sentido'
      ? { usage_id: usageId, verdict: 'fez_sentido' as const, reasons: [] }
      : { usage_id: usageId, verdict: 'discordo' as const, reasons: retorno.motivos, ...(comentario ? { comment: comentario } : {}) };
  return chamar(() => api.POST('/v1/ai/feedback', { body }));
}
