import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { EstadoDoTesteDeRegiao, testeDeRegiaoDoRecurso } from '../campanhas/teste-regiao-plano.js';
import type { ApplyOptions, ApplyResult, Connector, ReadResult, ResourceRef } from './connectors.js';
import type { ResourceState } from './tools.js';

// O teste de região no trilho de ações (plano da região, R8; D-RG-81): o pedido que a pessoa aprova com o código do app.
// O recurso é do próprio Liame (`teste_de_regiao:<id>`, a linha de `campaign_test` do tipo `regiao`): ler é montar o
// estado que a pessoa vê, e aplicar é só marcar o teste como pronto. NADA vai à Meta aqui: a saída e a volta do bairro
// em cada conjunto saem depois como passos próprios, pelo trilho, com as travas, a validação e a política de sempre. É o
// molde do ritmo da semana (R7). Entra pelo provedor `meta_ads` (a conta do pedido é a de anúncios): a trava e a flag
// de escrita da Meta seguram o teste junto com o resto.

const PROVIDER = 'meta_ads';

type Linha = { id: string; status: string; version: number; plan: unknown };

/** A linha do teste com a situação de agora no estado. Nula quando o recurso não é um teste de região desta conta. */
async function lerTeste(tx: Tx, ref: ResourceRef, travar = false): Promise<{ linha: Linha; estado: EstadoDoTesteDeRegiao } | null> {
  const id = testeDeRegiaoDoRecurso(ref.resourceId);
  if (!id) return null;
  const l = (
    await tx.execute<Linha>(sql`
      select id, status, version, plan from liame.campaign_test
       where id = ${id} and tenant_id = ${ref.tenantId} and ad_account_id = ${ref.accountId} and kind = 'regiao'
       ${travar ? sql`for update` : sql``}`)
  ).rows[0];
  if (!l) return null;
  // A situação mora na coluna; o resto do estado é o plano guardado.
  const estado = EstadoDoTesteDeRegiao.safeParse({ ...(l.plan as Record<string, unknown>), situacao: l.status });
  return estado.success ? { linha: { ...l, version: Number(l.version) }, estado: estado.data } : null;
}

export class TesteDeRegiaoConnector implements Connector {
  readonly provider = PROVIDER;
  readonly writeFlag = 'meta_write';
  // Aprovar o teste não gasta: a verba das campanhas não muda (a Meta mostra os anúncios para os outros bairros).
  readonly requiresSpendLimits = false;
  readonly needsWriteAuthorization = true;

  async read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    const lido = await lerTeste(tx, ref);
    return lido ? { state: lido.estado as unknown as ResourceState, version: lido.linha.version } : null;
  }

  async apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options: ApplyOptions = {}): Promise<ApplyResult> {
    const lido = await lerTeste(tx, ref, true);
    if (!lido) return { ok: false, reason: 'recusado', mensagem: 'O teste de região não está mais aqui.' };
    const { linha, estado } = lido;
    const atual = { state: estado as unknown as ResourceState, version: linha.version };
    // Já aprovado (a aprovação que terminou e a resposta se perdeu): nada a fazer.
    if (linha.status === 'pronto' && desired.situacao === 'pronto') return { ok: true, ...atual };
    if (linha.version !== expectedVersion || linha.status !== 'pedido') return { ok: false, reason: 'estado-mudou', current: atual };
    if (options.validateOnly) return { ok: true, state: desired, version: linha.version };
    const r = await tx.execute<{ version: number }>(sql`
      update liame.campaign_test set status = 'pronto', approved_at = now(), version = version + 1, updated_at = now()
       where id = ${linha.id} and tenant_id = ${ref.tenantId} and version = ${expectedVersion} and status = 'pedido'
       returning version`);
    const novo = r.rows[0];
    if (!novo) return { ok: false, reason: 'estado-mudou', current: atual };
    return { ok: true, state: { ...estado, situacao: 'pronto' } as unknown as ResourceState, version: Number(novo.version) };
  }
}

export const testeDeRegiaoConnector = new TesteDeRegiaoConnector();
