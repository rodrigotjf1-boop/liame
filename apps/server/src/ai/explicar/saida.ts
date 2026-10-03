import type { ExplanationResponse } from '@liame/contracts';
import type { ExplicacaoPronta } from './explicar.service.js';
import type { TrechoMarcado } from './fontes.js';

// A explicação como a rota a entrega (contrato `ExplanationResponse`): o texto em trechos, com cada número
// apontando para a linha dele em "De onde vêm os números".

const trechos = (t: TrechoMarcado[]) => t.map((x) => ({ text: x.texto, number: x.numero }));

export function respostaDaExplicacao(r: ExplicacaoPronta): ExplanationResponse {
  return {
    source: r.origem === 'ia' ? 'lia' : 'sistema',
    // Os códigos do gateway usam hífen (`sem-rota`); na resposta, tudo com sublinhado.
    reason: r.motivo_sem_ia ? r.motivo_sem_ia.replaceAll('-', '_') : null,
    explanation: {
      what_happened: trechos(r.marcada.o_que_aconteceu),
      reasons: r.marcada.motivos.map(trechos),
      risk: r.marcada.risco,
      risk_reason: trechos(r.marcada.risco_motivo),
      what_to_do: r.marcada.o_que_fazer.map(trechos),
    },
    numbers: r.marcada.numeros.map((n) => ({ value: n.valor, sources: n.fontes })),
    period: { from: r.periodo.de, to: r.periodo.ate },
    compared_to: r.comparado_com ? { from: r.comparado_com.de, to: r.comparado_com.ate } : null,
    stale_sources: r.fontes_fora_do_dia.map((f) => ({ platform: f.plataforma, name: f.conta, freshness: f.frescor, last_read: f.ultima_leitura })),
    usage_id: r.usage_id,
    retry_at: r.volta_em,
    budget_window: r.teto,
    generated_at: r.gerada_em,
  };
}
