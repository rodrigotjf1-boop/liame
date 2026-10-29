import { randomBytes, randomUUID } from 'node:crypto';
import { type Database, withTenant } from '@liame/database';
import { DATABASE } from '../../src/database/database.module.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { enableMfa, ownerQuery, signupAndLogin, type TestApi } from './api.js';
import { ligarFlagDaEmpresa } from './meta-de-mentira.js';

// Os posts da marca (A6, Z5b): a empresa com a Página e o Instagram ligados à marca e uma foto pronta, como o produto os
// deixa. A Página e o Instagram nascem como a Z5a os liga (`ligarContas` a partir do que a autorização da Meta
// descobriu): o provedor do canal, o id da rede, o nome (o Instagram com a arroba), os atributos que a descoberta grava
// e a credencial da autorização (V158). A foto, como as Fotos a guardam (a chave do objeto, o resumo, as medidas da
// cópia). Os ids da rede são números, como os da Meta, e únicos a cada execução (V156).

/** Um id numérico da Meta, único a cada execução (a Página tem 15 dígitos; o Instagram, 17). */
const idDaMeta = (digitos: number): string => {
  const base = `${Date.now()}${Number.parseInt(randomBytes(4).toString('hex'), 16)}`;
  return base.padEnd(digitos, '7').slice(0, digitos);
};

export type EmpresaComCanais = {
  cookie: string;
  userId: string;
  /** O segredo do app autenticador do dono. */
  secret: string;
  tenantId: string;
  brandId: string;
  /** A Página e o Instagram ligados à marca (nulos quando o teste pediu sem). */
  pagina: { id: string; externo: string } | null;
  instagram: { id: string; externo: string } | null;
};

/** A empresa com o app autenticador, a função dos posts ligada (ou não) e a Página e o Instagram ligados à marca. */
export async function empresaComCanais(
  api: TestApi,
  nome: string,
  o: { ligada?: boolean; pagina?: boolean; instagram?: boolean } = {},
): Promise<EmpresaComCanais> {
  const database: Database = api.app.get(DATABASE);
  const vault = api.app.get(VaultService);
  const s = await signupAndLogin(api, undefined, nome);
  const { secret } = await enableMfa(api, s.cookie);
  const tenantId = s.me.active_organization_id as string;
  const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
  if (o.ligada ?? true) await ligarFlagDaEmpresa(api, 'social_write', tenantId, true);
  const credencial = JSON.stringify({ tipo: 'meta', access_token: `token-dos-posts-${randomUUID()}`, obtido_em: new Date().toISOString(), expira_em: null });
  const segredo = await withTenant(database.db, tenantId, (tx) => vault.putSecret(tx, { tenantId, purpose: 'oauth_meta', plaintext: credencial }));
  const paginaExterna = idDaMeta(15);
  const pagina = (o.pagina ?? true) ? { id: randomUUID(), externo: paginaExterna } : null;
  const instagram = (o.instagram ?? true) ? { id: randomUUID(), externo: idDaMeta(17) } : null;
  if (pagina) {
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, credential_secret_id, provider_attributes)
       values ($1, $2, $3, 'facebook_page', $4, 'Casa Brasa', null, null, $5, $6::jsonb)`,
      [pagina.id, tenantId, brandId, pagina.externo, segredo, JSON.stringify({ instagram_id: instagram?.externo ?? null })],
    );
  }
  if (instagram) {
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, credential_secret_id, provider_attributes)
       values ($1, $2, $3, 'instagram', $4, '@casabrasa', null, null, $5, $6::jsonb)`,
      [instagram.id, tenantId, brandId, instagram.externo, segredo, JSON.stringify({ usuario: 'casabrasa', pagina_id: paginaExterna, pagina: 'Casa Brasa' })],
    );
  }
  return { cookie: s.cookie, userId: s.me.user.id as string, secret, tenantId, brandId, pagina, instagram };
}

/** Uma foto pronta nas Fotos da marca, como as Fotos a guardam (a cópia em JPEG, com o lado maior em até 2.048 px). */
export async function fotoPronta(e: Pick<EmpresaComCanais, 'tenantId' | 'brandId'>, medidas: { largura: number; altura: number } = { largura: 2048, altura: 1365 }): Promise<{ id: string; sha256: string }> {
  const id = randomUUID();
  const sha256 = randomBytes(32).toString('hex');
  await ownerQuery(
    `insert into liame.brand_photo (id, tenant_id, brand_id, status, object_key, sha256, bytes, width, height)
     values ($1, $2, $3, 'pronta', $4, $5, 512000, $6, $7)`,
    [id, e.tenantId, e.brandId, `t/${e.tenantId}/b/${e.brandId}/foto_produto/${id}.jpg`, sha256, medidas.largura, medidas.altura],
  );
  return { id, sha256 };
}
