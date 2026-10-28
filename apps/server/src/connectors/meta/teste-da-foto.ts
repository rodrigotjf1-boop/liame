import { createHmac } from 'node:crypto';
import { setTimeout as esperar } from 'node:timers/promises';
import { type Db, withTenant } from '@liame/database';
import { sql } from 'drizzle-orm';
import { writeAudit } from '../../audit/audit.js';
import { VALIDADE_DO_ENDERECO_S } from '../../fotos/fotos.service.js';
import type { ArmazemDeImagens } from '../../imagens/armazem.js';
import type { VaultService } from '../../vault/vault.service.js';
import { versaoRegistrada } from '../tipos.js';
import { cabeNoInstagram, contaDoInstagram, erroDaMeta, situacaoDoConteiner } from './publicacao.js';

// O teste da D-A6-10 (A6 · Z5, `plano-a6.md` §8), antes do código dos posts: a Meta aceita buscar a foto no endereço
// assinado que vale poucos minutos (ADR-021: o arquivo nunca fica público)? Cria um contêiner do Instagram (o rascunho do
// post) com uma foto da empresa e confere se a Meta baixou a imagem. NUNCA publica (não chama o `media_publish`): o
// contêiner que não é publicado vence sozinho em 24 horas, e ninguém o vê. Quem roda é a distribuição, com a ordem do
// dono (é escrita na conta do cliente), e quem pediu e o porquê ficam na auditoria da empresa
// (`scripts/teste-foto-meta.ts`). Nada de token, nem do endereço assinado, sai no resultado.

/** A permissão que a autorização precisa ter para o teste: a de publicar no Instagram. */
export const PERMISSAO_DE_PUBLICAR = 'instagram_content_publish';
/** Quanto vale o endereço da foto: o mesmo da tela de Fotos. */
export const VALIDADE_DO_ENDERECO_DO_TESTE_S = VALIDADE_DO_ENDERECO_S;
export const LEGENDA_DO_TESTE = 'Teste do Liame: rascunho que não é publicado e vence sozinho em 24 horas.';

export class ErroDoTeste extends Error {}

export type DepsDoTeste = {
  db: Db;
  vault: Pick<VaultService, 'readSecret'>;
  armazem: Pick<ArmazemDeImagens, 'enderecoDeLeitura'>;
  /** A Graph API: o endereço (o oficial em produção) e o segredo do app, para o `appsecret_proof`. */
  meta: { base: string; appSecret: string | null };
  /** Quanto esperar o contêiner sair de "processando", e de quanto em quanto conferir (os testes encurtam). */
  esperaMs?: number;
  intervaloMs?: number;
};

export type PedidoDoTeste = { tenantId: string; fotoId: string | null; por: string; motivo: string };

export type ResultadoDoTeste = {
  /** `pronto` = a Meta baixou a foto; o resto diz onde parou. */
  situacao: 'pronto' | 'recusado_na_criacao' | 'erro_ao_conferir' | 'processando' | ReturnType<typeof situacaoDoConteiner>;
  detalhe: string | null;
  conteiner: string | null;
  instagram: string;
  pagina: string;
  foto: { id: string; largura: number; altura: number };
};

type Graph = { base: string; versao: string; appSecret: string | null; token: string };

/** Uma chamada à Graph API, com o token no cabeçalho e o `appsecret_proof` (como o conector de leitura). */
async function graph(g: Graph, metodo: 'GET' | 'POST', caminho: string, params: Record<string, string>): Promise<{ ok: boolean; corpo: unknown }> {
  const q = new URLSearchParams(params);
  if (g.appSecret) q.set('appsecret_proof', createHmac('sha256', g.appSecret).update(g.token).digest('hex'));
  const url = `${g.base}/${g.versao}/${caminho}`;
  const r = await fetch(metodo === 'GET' ? `${url}?${q.toString()}` : url, {
    method: metodo,
    headers: { authorization: `Bearer ${g.token}`, ...(metodo === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    ...(metodo === 'POST' ? { body: q.toString() } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  let corpo: unknown = null;
  try {
    corpo = await r.json();
  } catch {
    corpo = null;
  }
  return { ok: r.ok, corpo };
}

export async function testarFotoNaMeta(deps: DepsDoTeste, p: PedidoDoTeste): Promise<ResultadoDoTeste> {
  // A autorização mais nova com a permissão de publicar, o token dela e as fotos prontas: na transação da empresa.
  const lido = await withTenant(deps.db, p.tenantId, async (tx) => {
    const c = await tx.execute<{ id: string; credential_secret_id: string }>(sql`
      select id, credential_secret_id from liame.oauth_connection
       where tenant_id = ${p.tenantId} and provider = 'meta' and status in ('ativa', 'aguardando_escolha')
         and credential_secret_id is not null and ${PERMISSAO_DE_PUBLICAR} = any(scopes)
       order by coalesce(completed_at, created_at) desc, id desc
       limit 1`);
    const conexao = c.rows[0];
    if (!conexao) return null;
    const segredo = await deps.vault.readSecret(tx, conexao.credential_secret_id);
    const f = await tx.execute<{ id: string; object_key: string; width: number; height: number }>(sql`
      select id, object_key, width, height from liame.brand_photo
       where tenant_id = ${p.tenantId} and status = 'pronta' and removed_at is null
         ${p.fotoId ? sql`and id = ${p.fotoId}` : sql``}
       order by created_at desc, id desc
       limit 50`);
    return { conexao: conexao.id, segredo, fotos: f.rows };
  });
  if (!lido) throw new ErroDoTeste(`a empresa não tem autorização da Meta com a permissão de publicar no Instagram (${PERMISSAO_DE_PUBLICAR}): autorize a Meta de novo`);
  if (!lido.segredo) throw new ErroDoTeste('a credencial da autorização não está mais no cofre');
  const credencial = JSON.parse(lido.segredo) as { tipo?: string; access_token?: string };
  if (credencial.tipo !== 'meta' || !credencial.access_token) throw new ErroDoTeste('a credencial da autorização não é da Meta');
  const escolhida = lido.fotos.find((f) => cabeNoInstagram(f.width, f.height));
  if (!escolhida) {
    throw new ErroDoTeste(
      p.fotoId ? 'a foto não existe nesta empresa, ou não cabe na proporção do Instagram (de 4:5 a 1,91:1)' : 'a empresa não tem foto pronta na proporção do Instagram (de 4:5 a 1,91:1)',
    );
  }

  const g: Graph = { base: deps.meta.base, versao: await versaoRegistrada(deps.db, 'meta_ads', 'accounts'), appSecret: deps.meta.appSecret, token: credencial.access_token };
  const contas = await graph(g, 'GET', 'me/accounts', { fields: 'id,name,instagram_business_account{id,username}', limit: '100' });
  if (!contas.ok) throw new ErroDoTeste(`a Meta recusou a lista das Páginas: ${erroDaMeta(contas.corpo)}`);
  const ig = contaDoInstagram(contas.corpo);
  if (!ig) throw new ErroDoTeste('nenhuma Página da autorização tem um Instagram profissional ligado: confira os ativos escolhidos na autorização');

  // O endereço assinado, do mesmo jeito que a tela e os posts usam; nunca impresso nem guardado.
  const endereco = await deps.armazem.enderecoDeLeitura(escolhida.object_key, VALIDADE_DO_ENDERECO_DO_TESTE_S);
  const criado = await graph(g, 'POST', `${ig.instagramId}/media`, { image_url: endereco, caption: LEGENDA_DO_TESTE });
  const id = (criado.corpo as { id?: unknown } | null)?.id;
  const conteiner = typeof id === 'string' ? id : null;
  let situacao: ResultadoDoTeste['situacao'];
  let detalhe: string | null = null;
  if (!criado.ok || !conteiner) {
    situacao = 'recusado_na_criacao';
    detalhe = erroDaMeta(criado.corpo);
  } else {
    situacao = 'processando';
    // A situação se consulta uma vez por minuto, por até 5 minutos (content publishing, base §2.2): a primeira, na hora.
    const limite = Date.now() + (deps.esperaMs ?? 5 * 60_000);
    while (Date.now() < limite) {
      const s = await graph(g, 'GET', conteiner, { fields: 'status_code,status' });
      if (!s.ok) {
        situacao = 'erro_ao_conferir';
        detalhe = erroDaMeta(s.corpo);
        break;
      }
      const corpo = s.corpo as { status_code?: unknown; status?: unknown };
      situacao = situacaoDoConteiner(corpo.status_code);
      if (situacao !== 'processando') {
        if (situacao !== 'pronto' && typeof corpo.status === 'string') detalhe = corpo.status.slice(0, 300);
        break;
      }
      await esperar(deps.intervaloMs ?? 60_000);
    }
  }

  await withTenant(deps.db, p.tenantId, (tx) =>
    writeAudit(tx, {
      tenantId: p.tenantId,
      actorType: 'system',
      actorId: null,
      actorLabel: `Distribuição DMS (${p.por})`,
      action: 'meta.teste_da_foto',
      resourceType: 'brand_photo',
      resourceId: escolhida.id,
      after: { conexao: lido.conexao, instagram: ig.usuario ?? ig.instagramId, conteiner, situacao, publicado: false },
      reason: p.motivo,
      origin: 'console',
    }),
  );
  return { situacao, detalhe, conteiner, instagram: ig.usuario ?? ig.instagramId, pagina: ig.pagina, foto: { id: escolhida.id, largura: escolhida.width, altura: escolhida.height } };
}
