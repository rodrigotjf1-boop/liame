import type { AttentionItem } from '@liame/contracts';
import { api, chamar, type Problema, type Resultado } from '@/lib/api';
import { juntarAvisos } from './textos';

// A Atenção junta duas leituras: os avisos de mídia (`campanhas.ver`) e, para quem vê as vendas, os do ciclo
// fechado (`vendas.ver`, F9). Se só os do ciclo falharem, os de mídia seguem na tela, com a falha à vista.

export type Avisos = { items: AttentionItem[]; generated_at: string; erroCiclo: Problema | null };

export async function buscarAvisos(comVendas: boolean): Promise<Resultado<Avisos>> {
  const [midia, ciclo] = await Promise.all([
    chamar(() => api.GET('/v1/media/attention')),
    comVendas ? chamar(() => api.GET('/v1/results/attention')) : Promise.resolve(null),
  ]);
  if (!midia.ok) return midia;
  return {
    ok: true,
    data: {
      items: juntarAvisos(midia.data.items, ciclo?.ok ? ciclo.data.items : []),
      generated_at: midia.data.generated_at,
      erroCiclo: ciclo && !ciclo.ok ? ciclo.problema : null,
    },
  };
}
