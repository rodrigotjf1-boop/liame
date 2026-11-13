import { createHmac } from 'node:crypto';
import type { Tx } from '@liame/database';
import type { MidiaNaMeta, ParametrosDaMeta } from '../campanhas/campanha-nova-plano.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { type ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { VIDEO_EM_PREPARO } from '../connectors/meta/publicacao.js';
import { chaveDaMiniatura } from '../fotos/conferencia.js';
import type { ArmazemDeImagens } from '../imagens/armazem.js';
import { recusaDaMeta } from './meta-anuncios.js';

// Os passos comuns de criar anúncio na Meta (A4, X5; base de conhecimento §2.1), para a campanha nova e para o teste de
// criativo (plano da região, R8). Nada aqui conhece tabela: quem chama guarda o id de cada objeto, marca a espera do
// vídeo e decide o que fazer com a recusa.
// - cada objeto novo passa antes pela validação da Meta (`execution_options=["validate_only"]`) e vai com a chave de
//   idempotência do passo (`X-Client-Idempotent-Key`), que é de quem chama: a mesma chave não cria de novo;
// - a foto e a capa do vídeo vão pelo endereço assinado do armazenamento; o vídeo, pelo `file_url`, e a Meta prepara
//   antes de o criativo poder usá-lo (até 15 minutos);
// - ativar põe os objetos em ACTIVE na ordem dada e pausar em PAUSED: antes, cada um é lido (o apagado ou arquivado no
//   Gerenciador de Anúncios não volta: quem está na Meta manda, D-A4-5) e validado.
// O token da empresa sai do cofre só na hora de chamar e nunca vai para log, estado ou auditoria.

export const PROVEDOR_DA_META = 'meta_ads';

/** Quanto o endereço assinado da mídia vale para a Meta buscar (a validação e a criação buscam de novo). */
const VALIDADE_DA_MIDIA_S = 60 * 60;
/** Quanto a Meta pode levar preparando o vídeo antes de a criação desistir. */
const PREPARO_DO_VIDEO_MS = 15 * 60_000;
/** A espera entre as conferências do vídeo (a Meta recomenda conferir uma vez por minuto). */
const ESPERA_DO_VIDEO_MS = 60_000;

/** O que os passos precisam do resto do app; ligado na subida (API e worker). */
export type DependenciasDaCriacaoNaMeta = {
  lerSegredo: (tx: Tx, secretId: string) => Promise<string | null>;
  cliente: () => ClienteConector;
  graphUrl: string;
  appSecret: string | null;
  versao: (capacidade: 'anuncio_criar' | 'anuncio_video' | 'entity_state' | 'entity_update') => Promise<string>;
  armazem: Pick<ArmazemDeImagens, 'enderecoDeLeitura'>;
};

/** A conta de anúncios (`act_<id>`), o token dela e a versão da Graph API da chamada. */
export type GrafoDaMeta = { deps: DependenciasDaCriacaoNaMeta; conta: string; token: string; versao: string };

/** A recusa que encerra a criação, com a frase para a pessoa. */
export class CriacaoRecusada extends Error {}

/** O id que a Meta devolve: só algarismos, conferidos um a um (sem expressão regular sobre o que vem de fora, V48). */
export const idDaMeta = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= 32 && [...v].every((c) => c >= '0' && c <= '9') ? v : null;

export const SEM_ACESSO = 'A Meta recusou o acesso desta conta (a autorização foi revogada ou venceu). Conecte a Meta de novo em Contas conectadas.';
export const MIDIA_SAIU = 'A foto ou o vídeo desta campanha saiu de Fotos: a campanha não foi criada. Peça de novo com outra mídia.';
export const APAGADA_NA_META = 'A campanha foi apagada ou arquivada no Gerenciador de Anúncios: nada foi mudado.';

/** O token da conta de anúncios, lido do cofre na hora; sem ele (revogado ou ausente), a falha de autenticação. */
export async function tokenDaConta(tx: Tx, credentialSecretId: string | null, deps: Pick<DependenciasDaCriacaoNaMeta, 'lerSegredo'>): Promise<string> {
  const guardada = credentialSecretId ? await deps.lerSegredo(tx, credentialSecretId) : null;
  const credencial = guardada ? (JSON.parse(guardada) as CredencialGuardada) : null;
  if (!credencial || credencial.tipo !== 'meta') throw new ErroConector('autenticacao', PROVEDOR_DA_META, 'autorização revogada ou ausente');
  return credencial.access_token;
}

/** O endereço de uma chamada à Graph API, com a prova do segredo do app (`appsecret_proof`) quando há. */
export function enderecoDaMeta(g: Pick<GrafoDaMeta, 'deps' | 'token'>, versao: string, caminho: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params);
  if (g.deps.appSecret) query.set('appsecret_proof', createHmac('sha256', g.deps.appSecret).update(g.token).digest('hex'));
  return `${g.deps.graphUrl}/${versao}/${caminho}?${query.toString()}`;
}

/**
 * Um objeto novo na conta: primeiro a validação da Meta (que não cria nada), depois a criação com a chave de
 * idempotência do passo. Devolve o id do objeto.
 */
export async function criarNaMeta(g: GrafoDaMeta, aresta: 'campaigns' | 'adsets' | 'adcreatives' | 'ads', params: ParametrosDaMeta, chave: string): Promise<string> {
  const caminho = `${g.conta}/${aresta}`;
  const validacao = await g.deps.cliente().requisitar<{ success?: unknown } | null>({
    provider: PROVEDOR_DA_META,
    conta: g.conta,
    url: enderecoDaMeta(g, g.versao, caminho, { ...params, execution_options: JSON.stringify(['validate_only']) }),
    metodo: 'POST',
    endpoint: 'anuncio_criar',
    apiVersion: g.versao,
    cabecalhos: { authorization: `Bearer ${g.token}` },
    custo: 3,
  });
  if (validacao.corpo?.success !== true) throw new CriacaoRecusada('A Meta não confirmou a conferência da campanha nova: nada mais foi criado.');
  const r = await g.deps.cliente().requisitar<{ id?: unknown } | null>({
    provider: PROVEDOR_DA_META,
    conta: g.conta,
    url: enderecoDaMeta(g, g.versao, caminho, params),
    metodo: 'POST',
    endpoint: 'anuncio_criar',
    apiVersion: g.versao,
    cabecalhos: { authorization: `Bearer ${g.token}`, 'x-client-idempotent-key': chave },
    custo: 3,
  });
  const id = idDaMeta(r.corpo?.id);
  if (!id) throw new CriacaoRecusada('A Meta não devolveu o objeto criado: confira a conta de anúncios antes de pedir de novo.');
  return id;
}

/**
 * A mídia do criativo: a foto pelo endereço assinado; o vídeo enviado pelo `file_url` (uma vez só: `aoEnviarOVideo`
 * guarda o id e marca desde quando a Meta o prepara, na tabela de quem chama), pronto quando a Meta termina de preparar,
 * com a capa guardada pelo endereço assinado.
 */
export async function midiaNaMeta(
  g: GrafoDaMeta,
  midia: { tipo: 'foto' | 'video'; chave: string | null; nome: string; video: string | null; esperandoMs: number | null },
  aoEnviarOVideo: (video: string) => Promise<void>,
): Promise<MidiaNaMeta | 'recusado' | 'sem_preparo'> {
  const chaveDaMidia = midia.chave;
  if (!chaveDaMidia) throw new CriacaoRecusada(MIDIA_SAIU);
  if (midia.tipo === 'foto') return { tipo: 'foto', imagem: await g.deps.armazem.enderecoDeLeitura(chaveDaMidia, VALIDADE_DA_MIDIA_S) };
  const versao = await g.deps.versao('anuncio_video');
  let video = midia.video;
  if (!video) {
    const r = await g.deps.cliente().requisitar<{ id?: unknown } | null>({
      provider: PROVEDOR_DA_META,
      conta: g.conta,
      url: enderecoDaMeta(g, versao, `${g.conta}/advideos`, { file_url: await g.deps.armazem.enderecoDeLeitura(chaveDaMidia, VALIDADE_DA_MIDIA_S), name: midia.nome }),
      metodo: 'POST',
      endpoint: 'anuncio_video',
      apiVersion: versao,
      cabecalhos: { authorization: `Bearer ${g.token}` },
      custo: 3,
    });
    video = idDaMeta(r.corpo?.id);
    if (!video) throw new CriacaoRecusada('A Meta não devolveu o vídeo enviado: a campanha não foi criada.');
    await aoEnviarOVideo(video);
  }
  const situacao = await g.deps.cliente().requisitar<{ status?: { video_status?: unknown } } | null>({
    provider: PROVEDOR_DA_META,
    conta: g.conta,
    url: enderecoDaMeta(g, versao, video, { fields: 'status' }),
    endpoint: 'anuncio_video',
    apiVersion: versao,
    cabecalhos: { authorization: `Bearer ${g.token}` },
  });
  const s = situacao.corpo?.status?.video_status;
  if (s === 'error' || s === 'expired') return 'recusado';
  if (s !== 'ready') {
    if ((midia.esperandoMs ?? 0) >= PREPARO_DO_VIDEO_MS) return 'sem_preparo';
    // A espera fixa do vídeo (como no post): não conta tentativa; quem encerra são os 15 minutos acima.
    throw new ErroConector('limite', PROVEDOR_DA_META, 'a Meta ainda prepara o vídeo da campanha nova', null, ESPERA_DO_VIDEO_MS, VIDEO_EM_PREPARO);
  }
  return { tipo: 'video', videoId: video, capa: await g.deps.armazem.enderecoDeLeitura(chaveDaMiniatura(chaveDaMidia), VALIDADE_DA_MIDIA_S) };
}

/**
 * Ativar ou pausar objetos de anúncio na Meta, na ordem dada (A4, X5, parte 3; D-A4-31): cada objeto é lido antes (o
 * apagado ou arquivado no Gerenciador de Anúncios, ou de outra conta, não volta: quem está na Meta manda, D-A4-5),
 * depois vem a validação da Meta em cada um e só então a mudança. `g.versao` é a da mudança; `leitura`, a da leitura.
 * Devolve nulo quando mudou; senão, a frase da recusa. O que é passageiro (o limite da conta, a Meta fora do ar) sobe.
 */
export async function mudarSituacaoNaMeta(g: GrafoDaMeta, leitura: string, ids: readonly string[], ativar: boolean): Promise<string | null> {
  const alvo = ativar ? 'ACTIVE' : 'PAUSED';
  try {
    for (const id of ids) {
      const r = await g.deps.cliente().requisitar<{ id?: unknown; status?: unknown; account_id?: unknown } | null>({
        provider: PROVEDOR_DA_META,
        conta: g.conta,
        url: enderecoDaMeta(g, leitura, id, { fields: 'id,status,account_id' }),
        endpoint: 'entity_state',
        apiVersion: leitura,
        cabecalhos: { authorization: `Bearer ${g.token}` },
      });
      const s = r.corpo?.status;
      if (`act_${String(r.corpo?.account_id ?? '')}` !== g.conta || s === 'DELETED' || s === 'ARCHIVED') return APAGADA_NA_META;
    }
    for (const passo of ['validar', 'mudar'] as const) {
      for (const id of ids) {
        const r = await g.deps.cliente().requisitar<{ success?: unknown } | null>({
          provider: PROVEDOR_DA_META,
          conta: g.conta,
          url: enderecoDaMeta(g, g.versao, id, passo === 'validar' ? { status: alvo, execution_options: JSON.stringify(['validate_only']) } : { status: alvo }),
          metodo: 'POST',
          endpoint: 'entity_update',
          apiVersion: g.versao,
          cabecalhos: { authorization: `Bearer ${g.token}` },
          custo: 3,
        });
        if (r.corpo?.success !== true) return 'A Meta não confirmou a mudança. Confira a campanha no Gerenciador de Anúncios antes de pedir de novo.';
      }
    }
  } catch (err) {
    if (err instanceof ErroConector && err.tipo === 'definitivo' && err.codigoProvider === '100' && err.subcodigo === '33') return APAGADA_NA_META;
    const motivo = err instanceof ErroConector && err.tipo === 'autenticacao' ? SEM_ACESSO : recusaDaMeta(err);
    if (!motivo) throw err;
    return motivo;
  }
  return null;
}
