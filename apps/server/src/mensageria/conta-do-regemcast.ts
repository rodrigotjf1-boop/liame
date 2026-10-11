import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import type { CredencialGuardada } from '../connections/oauth.js';
import type { VaultService } from '../vault/vault.service.js';
import { ESCOPOS_DE_ESCRITA_NO_REGEMCAST } from './rotina-do-crm.js';

// A conta do RegemCast de uma marca, como a rotina do funcionário de CRM e mensageria a usa (A5, Y6): a conta
// conectada, o token dela lido do cofre e se a conexão deixa o Liame gravar rascunhos e pedir o disparo. Roda na
// transação da empresa. O token nunca sai daqui para log nem para tela.

export type ContaDoRegemcast = {
  id: string;
  external_id: string;
  /** Nulo quando o cofre não tem mais a conexão desta conta: é preciso conectar o RegemCast de novo. */
  token: string | null;
  /** A conexão tem as três permissões de escrita (rascunhar modelo, rascunhar campanha e disparar). */
  escreve: boolean;
};

/**
 * A conta do RegemCast da marca que está conectada. Com `contaId`, só essa (a da proposta); sem ele, a primeira pelo
 * nome: uma marca tem, na prática, uma conta. Nula quando a marca não tem conta conectada.
 */
export async function lerContaDoRegemcast(tx: Tx, vault: VaultService, alvo: { tenantId: string; brandId: string; contaId?: string }): Promise<ContaDoRegemcast | null> {
  const daProposta = alvo.contaId ? sql`and a.id = ${alvo.contaId}` : sql``;
  const linha = (
    await tx.execute<{ id: string; external_id: string; credential_secret_id: string | null; escreve: boolean }>(sql`
      select a.id, a.external_id, a.credential_secret_id,
             coalesce(a.provider_attributes -> 'escopos' @> ${JSON.stringify(ESCOPOS_DE_ESCRITA_NO_REGEMCAST)}::jsonb, false) as escreve
        from liame.connected_account a
       where a.tenant_id = ${alvo.tenantId} and a.brand_id = ${alvo.brandId} and a.provider = 'regemcast' and a.disconnected_at is null
             ${daProposta}
       order by a.name, a.id
       limit 1`)
  ).rows[0];
  if (!linha) return null;
  const guardada = linha.credential_secret_id ? await vault.readSecret(tx, linha.credential_secret_id) : null;
  const credencial = guardada ? (JSON.parse(guardada) as CredencialGuardada) : null;
  const doCofre = credencial?.tipo === 'regemcast' ? credencial.lojas.find((l) => l.loja_id === linha.external_id)?.token : undefined;
  return { id: linha.id, external_id: linha.external_id, token: doCofre ?? null, escreve: linha.escreve };
}
