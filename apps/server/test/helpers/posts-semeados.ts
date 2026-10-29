import { randomBytes, randomUUID } from 'node:crypto';
import { type Database, withTenant } from '@liame/database';
import sharp from 'sharp';
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

/**
 * A empresa com o app autenticador, a função dos posts ligada (ou não) e a Página e o Instagram ligados à marca. `token`:
 * o da autorização da Meta guardada no cofre (o do Instagram de mentira, nos testes que publicam).
 */
export async function empresaComCanais(
  api: TestApi,
  nome: string,
  o: { ligada?: boolean; pagina?: boolean; instagram?: boolean; token?: string } = {},
): Promise<EmpresaComCanais> {
  const database: Database = api.app.get(DATABASE);
  const vault = api.app.get(VaultService);
  const s = await signupAndLogin(api, undefined, nome);
  const { secret } = await enableMfa(api, s.cookie);
  const tenantId = s.me.active_organization_id as string;
  const brandId = (await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]))[0]!.id;
  if (o.ligada ?? true) await ligarFlagDaEmpresa(api, 'social_write', tenantId, true);
  const doTeste = o.token ?? `token-dos-posts-${randomUUID()}`;
  const credencial = JSON.stringify({ tipo: 'meta', access_token: doTeste, obtido_em: new Date().toISOString(), expira_em: null });
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

/**
 * Uma foto pronta nas Fotos da marca, com o arquivo de verdade no armazenamento: um JPEG nas medidas pedidas, com uma
 * faixa de cor em cima e outra embaixo (o teste do recorte vê qual parte foi ao Instagram), gravado na chave das Fotos.
 */
export async function fotoGuardada(
  e: Pick<EmpresaComCanais, 'tenantId' | 'brandId'>,
  armazem: { gravar(chave: string, bytes: Buffer): Promise<void> },
  medidas: { largura: number; altura: number },
): Promise<{ id: string; sha256: string; chave: string }> {
  const { largura, altura } = medidas;
  // As faixas têm 1/8 da altura: o recorte do topo (4:5 de uma foto 2:3) leva a vermelha e não a azul; o do pé, o contrário.
  const alturaDaFaixa = Math.floor(altura / 8);
  const faixa = (cor: { r: number; g: number; b: number }) => sharp({ create: { width: largura, height: alturaDaFaixa, channels: 3, background: cor } }).png().toBuffer();
  const bytes = await sharp({ create: { width: largura, height: altura, channels: 3, background: { r: 240, g: 240, b: 240 } } })
    .composite([
      { input: await faixa({ r: 220, g: 30, b: 30 }), top: 0, left: 0 },
      { input: await faixa({ r: 30, g: 30, b: 220 }), top: altura - alturaDaFaixa, left: 0 },
    ])
    .jpeg({ quality: 85 })
    .toBuffer();
  const id = randomUUID();
  const chave = `t/${e.tenantId}/b/${e.brandId}/foto_produto/${id}.jpg`;
  await armazem.gravar(chave, bytes);
  const sha256 = randomBytes(32).toString('hex');
  await ownerQuery(
    `insert into liame.brand_photo (id, tenant_id, brand_id, status, object_key, sha256, bytes, width, height)
     values ($1, $2, $3, 'pronta', $4, $5, $6, $7, $8)`,
    [id, e.tenantId, e.brandId, chave, sha256, bytes.length, largura, altura],
  );
  return { id, sha256, chave };
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

/**
 * Uma loja da marca com o Regem ligado e o cardápio online (A6 · Z7: o destino do link do post). `cardapio` nulo: a loja
 * sem o cardápio informado. Devolve a loja e a conta do Regem.
 */
export async function lojaComCardapio(e: Pick<EmpresaComCanais, 'tenantId' | 'brandId'>, nome: string, cardapio: string | null): Promise<{ unitId: string; contaId: string }> {
  const unitId = randomUUID();
  const contaId = randomUUID();
  await ownerQuery(`insert into liame.unit (id, tenant_id, brand_id, name) values ($1, $2, $3, $4)`, [unitId, e.tenantId, e.brandId, nome]);
  await ownerQuery(
    `insert into liame.connected_account (id, tenant_id, brand_id, unit_id, provider, external_id, name, currency, timezone, provider_attributes)
     values ($1, $2, $3, $4, 'regem', $5, $6, 'BRL', 'America/Sao_Paulo', $7::jsonb)`,
    [contaId, e.tenantId, e.brandId, unitId, randomUUID(), `${nome} (Regem)`, JSON.stringify({ cardapio_url: cardapio })],
  );
  return { unitId, contaId };
}
