import { randomBytes } from 'node:crypto';
import { type Db, uuidv7, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { writeAudit } from '../audit/audit.js';
import type { AppConfig } from '../config.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { lerLoja } from '../connectors/regem/conector-regem.js';
import { lerSituacao } from '../connectors/regemcast/conector-regemcast.js';
import type { VaultService } from '../vault/vault.service.js';
import type { DescobertaGuardada } from './connections.service.js';
import { type CredencialRegem, hashEstado } from './oauth.js';

// Piloto (D-A2.5-4): a distribuição emite o token da loja no produto DMS e o grava direto no cofre do
// Liame, sem passar pelo usuário. A conexão nasce como as da autorização, só que com origem
// `distribuicao` e já com as lojas descobertas: a pessoa liga cada loja na tela "Contas conectadas", como
// faz com as contas da Meta e do Google, e a loja do Regem ganha ali a loja do Liame dela (ERR-047).
//
// RegemCast (F7; contrato v2, emendas da ADR-019 de 02/10/2026): um token por conta (`rct_it_…`), emitido a
// pedido do dono da conta e conferido pela ferramenta `integracao_situacao` do MCP de lá. O identificador
// da conta no Liame é o `contaId` que ela devolve (não muda quando o token é trocado). Só aceita token
// emitido para o Liame.

export type RegistroDistribuicao = {
  tenantId: string;
  brandId: string;
  produto: 'regem' | 'regemcast';
  /** Tokens das lojas (um por loja). Só na memória: vão para o cofre e nunca para log. */
  tokens: string[];
};

export async function registrarConexaoDaDistribuicao(
  deps: { db: Db; vault: VaultService; config: AppConfig },
  p: RegistroDistribuicao,
): Promise<{ connectionId: string; lojas: DescobertaGuardada[] }> {
  const tokens = [...new Set(p.tokens.map((t) => t.trim()).filter(Boolean))];
  if (!tokens.length) throw new Error('nenhum token informado');
  const cliente = new ClienteConector(deps.db, { enderecos: enderecosDasPlataformas(deps.config.plataformas, deps.config.produtos), tentativas: 2 });
  const { credencial, lojas } = p.produto === 'regemcast' ? await contasDoRegemcast(cliente, deps.config, tokens) : await lojasDoRegem(cliente, deps.config, tokens);

  const connectionId = uuidv7();
  await withTenant(deps.db, p.tenantId, async (tx) => {
    const marca = await tx.execute<{ id: string }>(sql`select id from liame.brand where id = ${p.brandId} and archived_at is null`);
    if (!marca.rows[0]) throw new Error('marca não encontrada nesta empresa (ou arquivada)');
    const secretId = await deps.vault.putSecret(tx, { tenantId: p.tenantId, purpose: p.produto === 'regemcast' ? 'oauth_regemcast' : 'oauth_regem', plaintext: JSON.stringify(credencial) });
    const escopos = [...new Set(credencial.lojas.flatMap((l) => l.escopos))].sort();
    // Sem volta de navegador: o estado é aleatório e nunca usado; o endereço de volta fica marcado.
    await tx.execute(sql`
      insert into liame.oauth_connection (id, tenant_id, brand_id, provider, origin, status, state_hash, redirect_uri,
                                          credential_secret_id, scopes, discovered, expires_at)
      values (${connectionId}, ${p.tenantId}, ${p.brandId}, ${p.produto}, 'distribuicao', 'aguardando_escolha',
              ${hashEstado(randomBytes(32).toString('base64url'))}, 'distribuicao', ${secretId},
              array(select jsonb_array_elements_text(${JSON.stringify(escopos)}::jsonb)), ${JSON.stringify(lojas)}::jsonb, now())`);
    await writeAudit(tx, {
      tenantId: p.tenantId,
      actorType: 'system',
      actorId: null,
      actorLabel: 'Distribuição DMS',
      action: 'conexao.registrar_distribuicao',
      resourceType: 'oauth_connection',
      resourceId: connectionId,
      after: { provider: p.produto, lojas: lojas.map((l) => l.name), escopos },
      origin: 'console',
    });
  });
  return { connectionId, lojas };
}

type Descobertas = { credencial: CredencialRegem; lojas: DescobertaGuardada[] };

/** Cada token do Regem diz a loja dele (e prova que vale) antes de qualquer gravação. */
async function lojasDoRegem(cliente: ClienteConector, config: AppConfig, tokens: string[]): Promise<Descobertas> {
  if (tokens.some((t) => !/^rgm_it_[A-Za-z0-9_-]{20,200}$/.test(t))) throw new Error('token fora do formato do Regem (rgm_it_…)');
  const credencial: CredencialRegem = { tipo: 'regem', lojas: [], obtido_em: new Date().toISOString() };
  const lojas: DescobertaGuardada[] = [];
  for (const token of tokens) {
    let loja;
    try {
      loja = await lerLoja({ cliente, apiUrl: config.produtos.regemApiUrl }, token, `distribuicao:${hashEstado(token).slice(0, 12)}`);
    } catch (err) {
      if (err instanceof ErroConector && err.tipo === 'autenticacao') throw new Error('o Regem recusou um dos tokens (revogado ou inválido)');
      throw err;
    }
    if (credencial.lojas.some((l) => l.loja_id === loja.loja_id)) continue;
    credencial.lojas.push({ loja_id: loja.loja_id, token, escopos: loja.escopos });
    lojas.push({
      provider: 'regem',
      external_id: loja.loja_id,
      name: loja.loja_nome,
      currency: loja.moeda,
      timezone: loja.fuso,
      provider_attributes: { escopos: loja.escopos, empresa: loja.empresa_nome ?? null, cardapio_url: loja.cardapio_url ?? null },
    });
  }
  return { credencial, lojas };
}

/**
 * Cada token do RegemCast diz a conta dele pela `integracao_situacao` (e prova que vale) antes de qualquer
 * gravação. Recusa token emitido para outro produto: ele carrega as permissões que a distribuição deu a ESSE
 * produto, e o dono da conta autorizou aquele, não o Liame.
 */
async function contasDoRegemcast(cliente: ClienteConector, config: AppConfig, tokens: string[]): Promise<Descobertas> {
  if (tokens.some((t) => !/^rct_it_[A-Za-z0-9_-]{43}$/.test(t))) throw new Error('token fora do formato do RegemCast (rct_it_…)');
  const apiUrl = config.produtos.regemcastApiUrl;
  if (!apiUrl) throw new Error('REGEMCAST_API_URL não definida: sem o endereço do RegemCast não há como conferir o token');
  const credencial: CredencialRegem = { tipo: 'regemcast', lojas: [], obtido_em: new Date().toISOString() };
  const lojas: DescobertaGuardada[] = [];
  for (const token of tokens) {
    let s;
    try {
      s = await lerSituacao({ cliente, apiUrl }, token, `distribuicao:${hashEstado(token).slice(0, 12)}`);
    } catch (err) {
      if (err instanceof ErroConector && err.tipo === 'autenticacao') throw new Error('o RegemCast recusou um dos tokens (revogado ou inválido)');
      throw err;
    }
    if (s.produto !== 'liame') throw new Error(`um dos tokens foi emitido para o produto "${s.produto}", não para o Liame`);
    if (credencial.lojas.some((l) => l.loja_id === s.contaId)) continue;
    const escopos = s.permissoes.map((x) => x.id);
    credencial.lojas.push({ loja_id: s.contaId, token, escopos });
    lojas.push({
      provider: 'regemcast',
      external_id: s.contaId,
      name: s.conta,
      currency: null,
      timezone: s.fuso,
      provider_attributes: { escopos, classe: s.classe, token_nome: s.token },
    });
  }
  return { credencial, lojas };
}
