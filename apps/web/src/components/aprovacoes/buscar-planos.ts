import type { BrandResponse, PlanSummary } from '@liame/contracts';
import { api, chamar, type Resultado } from '@/lib/api';

// Os planos do Estrategista são por marca (`GET /v1/plans?brand_id=`), e a fila de quem decide é uma só: a tela e o
// número do menu leem os planos de cada marca ativa e juntam.

/** Marcas lidas de uma vez (empresa com mais do que isso é exceção; as primeiras bastam para a fila). */
const MARCAS_MAXIMAS = 20;

export async function marcasAtivas(): Promise<Resultado<BrandResponse[]>> {
  const r = await chamar(() => api.GET('/v1/brands'));
  return r.ok ? { ok: true, data: r.data.items.filter((b) => !b.archived_at).slice(0, MARCAS_MAXIMAS) } : r;
}

/** Os planos das marcas (com `pendente`, só os que esperam decisão). Se uma marca falhar, a leitura inteira falha. */
export async function planosDasMarcas(marcas: BrandResponse[], status?: 'pendente'): Promise<Resultado<PlanSummary[]>> {
  const partes = await Promise.all(marcas.map((m) => chamar(() => api.GET('/v1/plans', { params: { query: { brand_id: m.id, ...(status ? { status } : {}) } } }))));
  const itens: PlanSummary[] = [];
  for (const p of partes) {
    if (!p.ok) return p;
    itens.push(...p.data.items);
  }
  return { ok: true, data: itens };
}
