import { type Database, uuidv7, withContext } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';

// O que a conferência recusou (A3, D-A3-15 e D-A3-16; migration 0040). Uma linha por texto que não apareceu, SEM o
// texto: a marca, o funcionário e o fluxo que escreveram, o porquê e, quando foi uma regra de texto (ou o revisor de
// IA), quais. Sua equipe conta daqui os textos barrados pelo Compliance e as respostas retiradas na conferência.

const logger = new Logger('recusas');

/** As recusas que são do Compliance: uma regra de texto do código, ou o revisor de IA. */
export const RECUSAS_DO_COMPLIANCE = ['compliance', 'revisor'] as const;

export interface RecusaDaConferencia {
  tenantId: string;
  brandId: string;
  /** A pessoa que pediu (o contexto da gravação); nula em rotina do sistema. Não fica na linha. */
  userId: string | null;
  /** A linha de `ai_usage` da chamada que escreveu o texto. */
  usageId: string | null;
  /** O funcionário que escreveu: `lia`, `analista`, `relatorios`, `estrategista`, `pesquisador`. */
  member: string;
  workflow: string;
  /** O porquê: `compliance`, `revisor`, `numero_fora`, `dado_velho`, `formato`… */
  kind: string;
  /** As regras de texto que bateram (ou as categorias do revisor). */
  rules?: readonly string[];
  rulesVersion?: number | null;
  /** Quantos textos a linha conta (o Pesquisador descarta vários rótulos numa leitura). */
  items?: number;
}

const SLUG = /^[a-z][a-z0-9_]{1,40}$/;
const MAX_REGRAS = 12;

/** As regras como vão para o banco: só nomes de regra (nunca o trecho), sem repetir, em ordem. */
export function regrasParaGuardar(rules: readonly string[] | undefined): string[] {
  return [...new Set((rules ?? []).filter((r) => SLUG.test(r)))].slice(0, MAX_REGRAS);
}

/**
 * Grava a recusa numa transação curta, com a empresa no contexto da RLS. Nunca rejeita: o texto já não vai aparecer
 * de qualquer jeito (quem chama devolve o texto do sistema), e a falha da contagem só fica no log (LIC-001).
 */
export async function registrarRecusa(database: Database, r: RecusaDaConferencia): Promise<void> {
  try {
    if (!SLUG.test(r.kind) || !SLUG.test(r.member)) throw new Error(`recusa com nome fora do formato (${r.member}, ${r.kind})`);
    const itens = Math.max(1, Math.min(1000, Math.trunc(r.items ?? 1)));
    await withContext(database.db, { tenantId: r.tenantId, userId: r.userId }, (tx) =>
      tx.execute(sql`
        insert into liame.ai_refusal (id, tenant_id, brand_id, usage_id, member, workflow, kind, rules, rules_version, items)
        values (${uuidv7()}, ${r.tenantId}, ${r.brandId}, ${r.usageId}, ${r.member}, ${r.workflow}, ${r.kind},
                ${JSON.stringify(regrasParaGuardar(r.rules))}::jsonb, ${r.rulesVersion ?? null}, ${itens})`),
    );
  } catch (err) {
    logger.error(`recusa da conferência não registrada (${r.workflow}, ${r.kind}): ${err instanceof Error ? err.message : String(err)}`);
  }
}
