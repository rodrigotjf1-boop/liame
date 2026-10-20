import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { contaConectada } from '../connections/conectada.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { type CredencialDaConta, credencialDaConta, podeGravar } from '../connectors/regemcast/credencial-da-conta.js';
import type { VaultService } from '../vault/vault.service.js';
import { ESCOPOS_DE_ESCRITA_NO_REGEMCAST } from './rotina-do-crm.js';

// A conta do RegemCast de uma marca, como a rotina do funcionário de CRM e mensageria a usa (A5, Y6): a conta
// conectada, a credencial dela lida do cofre e se a conexão deixa o Liame gravar rascunhos e pedir o disparo. Roda na
// transação da empresa. A credencial nunca sai daqui para log nem para tela.

export type ContaDoRegemcast = {
  id: string;
  external_id: string;
  /**
   * O `rct_it_` da conta ou a ligação da autorização por clique (Hub DMS, B1). Nula quando o cofre não tem mais a
   * conexão desta conta: é preciso conectar o RegemCast de novo.
   */
  credencial: CredencialDaConta | null;
  /**
   * A conexão tem as três permissões de escrita (rascunhar modelo, rascunhar campanha e disparar) e é pelo token da
   * distribuição: a autorização do dono libera só leitura até a F5 (decisão B1-3).
   */
  escreve: boolean;
};

/**
 * A conta do RegemCast ligada à marca. Com `contaId`, só essa (a da proposta); sem ele, a primeira pelo nome: uma marca
 * tem, na prática, uma conta. Nula quando a marca não tem conta ligada; sem credencial quando o RegemCast recusou a
 * conexão (401) ou o cofre não a tem mais, e quem chama diz "conecte de novo" (achado A2 do Hub DMS).
 */
export async function lerContaDoRegemcast(tx: Tx, vault: VaultService, alvo: { tenantId: string; brandId: string; contaId?: string }): Promise<ContaDoRegemcast | null> {
  const daProposta = alvo.contaId ? sql`and a.id = ${alvo.contaId}` : sql``;
  const linha = (
    await tx.execute<{ id: string; external_id: string; credential_secret_id: string | null; escreve: boolean; conectada: boolean }>(sql`
      select a.id, a.external_id, a.credential_secret_id,
             coalesce(a.provider_attributes -> 'escopos' @> ${JSON.stringify(ESCOPOS_DE_ESCRITA_NO_REGEMCAST)}::jsonb, false) as escreve,
             ${contaConectada('a')} as conectada
        from liame.connected_account a
       where a.tenant_id = ${alvo.tenantId} and a.brand_id = ${alvo.brandId} and a.provider = 'regemcast' and a.disconnected_at is null
             ${daProposta}
       order by a.name, a.id
       limit 1`)
  ).rows[0];
  if (!linha) return null;
  const guardada = linha.credential_secret_id && linha.conectada ? await vault.readSecret(tx, linha.credential_secret_id) : null;
  const credencial = credencialDaConta(guardada ? (JSON.parse(guardada) as CredencialGuardada) : null, linha.external_id);
  return { id: linha.id, external_id: linha.external_id, credencial, escreve: linha.escreve && credencial !== null && podeGravar(credencial) };
}
