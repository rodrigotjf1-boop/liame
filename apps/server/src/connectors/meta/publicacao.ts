// A publicação na Meta (A6 · Z5; `base-conhecimento.md` §2.2, reconferida em 21/10/2026): as regras puras que o teste
// da D-A6-10 (`scripts/teste-foto-meta.ts`) usa e que o post de verdade vai usar. Sem rede e sem banco.

import { META_INSTAGRAM_PUBLISH_SCOPE, META_PAGE_PUBLISH_SCOPE } from '@liame/contracts';

/**
 * A proporção que o post do feed do Instagram aceita (content publishing, 21/10/2026): de 4:5 (em pé) a 1,91:1 (deitada).
 * Fora disso, a Meta recusa o contêiner pela proporção, e o teste da foto não diria nada sobre o endereço.
 */
export const PROPORCAO_DO_INSTAGRAM = { minima: 4 / 5, maxima: 1.91 } as const;

export function cabeNoInstagram(largura: number, altura: number): boolean {
  if (!(largura > 0) || !(altura > 0)) return false;
  const p = largura / altura;
  return p >= PROPORCAO_DO_INSTAGRAM.minima && p <= PROPORCAO_DO_INSTAGRAM.maxima;
}

export type ContaDoInstagram = { paginaId: string; pagina: string; instagramId: string; usuario: string | null };

const texto = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * A conta do Instagram ligada a uma Página, na resposta de `GET /me/accounts?fields=id,name,instagram_business_account{id,username}`:
 * a primeira Página que tem uma. Sem nenhuma, nulo (a autorização não incluiu o Instagram, ou ele não está ligado à Página).
 */
export function contaDoInstagram(resposta: unknown): ContaDoInstagram | null {
  const data = (resposta as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  for (const p of data as Array<Record<string, unknown>>) {
    const ig = p?.instagram_business_account as Record<string, unknown> | undefined;
    const paginaId = texto(p?.id);
    const instagramId = texto(ig?.id);
    if (paginaId && instagramId) return { paginaId, pagina: texto(p.name) ?? paginaId, instagramId, usuario: texto(ig?.username) };
  }
  return null;
}

/**
 * A permissão está concedida no token? Lê a resposta de `GET /me/permissions` (developers.facebook.com/docs/graph-api/
 * reference/user/permissions, lida em 28/10/2026): `data` com `permission` e `status` (`granted`, `declined` ou
 * `expired`). Só `granted` vale. É a Meta que diz: a troca do código da Meta não grava as permissões na conexão (a coluna
 * `scopes` fica vazia, ERR-179), e a pessoa pode desmarcar uma permissão na hora de autorizar.
 */
export function permissaoConcedida(resposta: unknown, permissao: string): boolean {
  const data = (resposta as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return false;
  return (data as Array<Record<string, unknown> | null>).some((p) => p?.permission === permissao && p?.status === 'granted');
}

/**
 * As permissões concedidas, pela resposta do `me/permissions`: só as `granted`, sem repetir, em ordem. Fora do formato,
 * nulo (não se sabe), nunca a lista vazia: a lista vazia diria que a pessoa não concedeu nada.
 */
export function permissoesConcedidas(resposta: unknown): string[] | null {
  const data = (resposta as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const nomes = (data as Array<Record<string, unknown> | null>).flatMap((p) => (p?.status === 'granted' && typeof p.permission === 'string' && p.permission ? [p.permission] : []));
  return [...new Set(nomes)].sort();
}

/**
 * As permissões do token pela resposta do `debug_token` (a segunda camada, quando o `me/permissions` é recusado): os
 * `scopes`, só com o token válido. Token que não vale, ou resposta fora do formato, nulo.
 */
export function permissoesDoDebug(resposta: unknown): string[] | null {
  const d = (resposta as { data?: Record<string, unknown> | null } | null)?.data;
  if (!d || d.is_valid !== true || !Array.isArray(d.scopes)) return null;
  return [...new Set((d.scopes as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0))].sort();
}

/**
 * A função dos posts (A6 · Z5; `plano-a6.md` §3), por empresa, desligada: é flag de escrita (a parada geral a alcança).
 * Ligada, a autorização da Meta que concedeu a permissão de publicar oferece a Página e o Instagram para ligar à marca, e
 * (nas partes seguintes) o post aprovado sai neles.
 */
export const FLAG_DOS_POSTS = 'social_write';
/** A Página do Facebook como conta ligada à marca (a autorização da Meta a alcança). */
export const PROVEDOR_PAGINA = 'facebook_page';
/** A conta profissional do Instagram como conta ligada à marca (ligada a uma Página). */
export const PROVEDOR_INSTAGRAM = 'instagram';

/** A chave, em `oauth_connection.discovery_notes`, de como terminou a procura da Página e do Instagram. */
export const NOTA_DOS_CANAIS = 'meta_canais';
/**
 * Como terminou a procura da Página e do Instagram numa autorização da Meta, como a das lojas do Perfil: `ok` com
 * quantas de cada uma; `limite`, `sem_permissao` ou `falhou`, sem nenhuma.
 */
export type ProcuraDosCanais = { resultado: 'ok' | 'limite' | 'sem_permissao' | 'falhou'; em: string; paginas: number; instagrams: number };

const RESULTADOS_DOS_CANAIS: readonly string[] = ['ok', 'limite', 'sem_permissao', 'falhou'];
const contagem = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

/**
 * A procura da Página e do Instagram como ficou anotada na conexão (`discovery_notes`, chave `meta_canais`), para a tela
 * de Contas (P19, parte B). Anotação ausente ou fora do formato: nulo (o Liame não procurou). Contagem fora do formato
 * conta zero, como nas lojas do Perfil e nos sites.
 */
export function procuraDosCanaisGuardada(notas: unknown): ProcuraDosCanais | null {
  const n = notas && typeof notas === 'object' ? (notas as Record<string, unknown>)[NOTA_DOS_CANAIS] : null;
  if (!n || typeof n !== 'object') return null;
  const { resultado, em, paginas, instagrams } = n as Record<string, unknown>;
  if (typeof resultado !== 'string' || !RESULTADOS_DOS_CANAIS.includes(resultado)) return null;
  if (typeof em !== 'string' || Number.isNaN(new Date(em).getTime())) return null;
  return { resultado: resultado as ProcuraDosCanais['resultado'], em, paginas: contagem(paginas), instagrams: contagem(instagrams) };
}

/**
 * A permissão de publicar na Página do Facebook (a foto pelo `POST /{page-id}/photos`; base §2.2, 21/10/2026). Vem dos
 * contratos: a tela de Contas confere a mesma.
 */
export const PERMISSAO_DE_PUBLICAR_NA_PAGINA = META_PAGE_PUBLISH_SCOPE;
/** A permissão de publicar no Instagram (o contêiner e o `media_publish`; base §2.2, 21/10/2026). Vem dos contratos. */
export const PERMISSAO_DE_PUBLICAR_NO_INSTAGRAM = META_INSTAGRAM_PUBLISH_SCOPE;

/** A Página do Facebook onde o post sai, como a autorização a alcança. */
export type PaginaDaMeta = { id: string; nome: string; instagramId: string | null };
/** A conta profissional do Instagram ligada a uma Página. */
export type InstagramDaMeta = { id: string; usuario: string | null; paginaId: string; pagina: string };

/** Id da Graph API: só dígitos, até 30 (o que fugir disso não vai para um caminho de endereço). */
function idDaGraph(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > 30) return null;
  for (const c of v) if (c < '0' || c > '9') return null;
  return v;
}

/**
 * As Páginas e as contas do Instagram de uma página da resposta de `GET /me/accounts?fields=id,name,
 * instagram_business_account{id,username}` (a mesma do teste da D-A6-10). A Página sem id válido fica de fora; o
 * Instagram vem só quando a Página tem um. Sem `data`, nada.
 */
export function canaisDaMeta(resposta: unknown): { paginas: PaginaDaMeta[]; instagrams: InstagramDaMeta[] } {
  const data = (resposta as { data?: unknown } | null)?.data;
  const paginas: PaginaDaMeta[] = [];
  const instagrams: InstagramDaMeta[] = [];
  if (!Array.isArray(data)) return { paginas, instagrams };
  for (const p of data as Array<Record<string, unknown> | null>) {
    const id = idDaGraph(p?.id);
    if (!id) continue;
    const nome = (texto(p?.name) ?? id).slice(0, 200);
    const ig = p?.instagram_business_account as Record<string, unknown> | undefined;
    const igId = idDaGraph(ig?.id);
    paginas.push({ id, nome, instagramId: igId });
    if (igId) instagrams.push({ id: igId, usuario: texto(ig?.username)?.slice(0, 100) ?? null, paginaId: id, pagina: nome });
  }
  return { paginas, instagrams };
}

/** O que o `debug_token` diz de uma permissão: concedida, ausente do token, ou o token não vale mais. */
export type PermissaoNoDebug = 'concedida' | 'ausente' | 'token_invalido';

/**
 * A permissão pela resposta de `GET /debug_token?input_token=…` (developers.facebook.com/docs/graph-api/reference/
 * debug_token, lida em 28/10/2026): `data.is_valid` e `data.scopes`, as permissões que a pessoa concedeu ao app no token.
 * É a conferência que a Meta documenta para qualquer token, com o token do app; a do `me/permissions` não diz se serve ao
 * token de usuário do sistema que o Facebook Login for Business entrega, então esta fica para quando aquela é recusada.
 */
export function permissaoNoDebug(resposta: unknown, permissao: string): PermissaoNoDebug {
  const d = (resposta as { data?: Record<string, unknown> | null } | null)?.data;
  if (!d || d.is_valid !== true) return 'token_invalido';
  return Array.isArray(d.scopes) && d.scopes.includes(permissao) ? 'concedida' : 'ausente';
}

/** A situação do contêiner (`status_code`): pronto para publicar, ainda processando, com erro, vencido ou já publicado. */
export type SituacaoDoConteiner = 'pronto' | 'processando' | 'erro' | 'vencido' | 'publicado' | 'desconhecida';

export function situacaoDoConteiner(statusCode: unknown): SituacaoDoConteiner {
  switch (statusCode) {
    case 'FINISHED':
      return 'pronto';
    case 'IN_PROGRESS':
      return 'processando';
    case 'ERROR':
      return 'erro';
    case 'EXPIRED':
      return 'vencido';
    case 'PUBLISHED':
      return 'publicado';
    default:
      return 'desconhecida';
  }
}

/**
 * O erro da Graph API em uma linha, para quem roda o teste: a mensagem, o código, o subcódigo e o texto que a Meta
 * escreve para a pessoa, quando vêm. Nunca leva o token (a Meta não o devolve no erro).
 */
export function erroDaMeta(corpo: unknown): string {
  const e = (corpo as { error?: Record<string, unknown> } | null)?.error;
  if (!e) return 'a Meta respondeu sem dizer o erro';
  const partes = [texto(e.message) ?? 'erro sem mensagem'];
  if (typeof e.code === 'number') partes.push(`código ${e.code}`);
  if (typeof e.error_subcode === 'number') partes.push(`subcódigo ${e.error_subcode}`);
  const paraPessoa = texto(e.error_user_msg);
  if (paraPessoa) partes.push(paraPessoa);
  return partes.join(' · ').slice(0, 500);
}

// O post no Instagram (A6 · Z5b, parte 2; base §2.2, reconferida em 29/10/2026 nas páginas oficiais `…/docs/instagram-
// platform/content-publishing` e `…/instagram-graph-api/reference/ig-user/content_publishing_limit`, v26.0).

/** O código do adiamento enquanto o Instagram prepara a foto do contêiner: o executor diz isso, e não "limite de uso". */
export const CONTEINER_EM_PREPARO = 'conteiner_em_preparo';
/** O código do adiamento quando o Instagram chegou ao limite de posts pela API nas últimas 24 horas. */
export const COTA_DE_POSTS = 'cota_de_posts';
/** De quanto em quanto conferir o contêiner que ainda prepara a foto (a Meta recomenda uma vez por minuto). */
export const ESPERA_DO_CONTEINER_MS = 60_000;

/**
 * O limite de posts pela API, na resposta de `GET /{ig}/content_publishing_limit?fields=quota_usage,config`: quantos o
 * app já publicou nas últimas 24 horas (`quota_usage`) e o máximo (`config.quota_total`; 50 na referência, 100 na página
 * geral: o Liame lê o número, A6-11). A resposta vem na lista `data` (a referência mostra só os campos: aceita os dois
 * jeitos). Fora do formato, nulo: quem chama segue, e a Meta recusa o que passar do limite.
 */
export function limiteDePosts(resposta: unknown): { usados: number; total: number } | null {
  const corpo = resposta as { data?: unknown } | null;
  const item = (Array.isArray(corpo?.data) ? corpo.data[0] : corpo) as { quota_usage?: unknown; config?: { quota_total?: unknown } | null } | null | undefined;
  const usados = item?.quota_usage;
  const total = item?.config?.quota_total;
  if (typeof usados !== 'number' || typeof total !== 'number' || !Number.isFinite(usados) || !Number.isFinite(total) || total <= 0) return null;
  return { usados, total };
}

/** O texto como a comparação o vê: o fim de linha do Windows vira o de sempre, e as pontas saem. */
const legendaComparavel = (t: string): string => t.replace(/\r\n/g, '\n').trim();

/** A data do Instagram (`2026-10-29T19:00:00+0000`, sem os dois-pontos no fuso) em milissegundos; inválida, NaN. */
export function horaDoInstagram(v: unknown): number {
  if (typeof v !== 'string') return Number.NaN;
  return Date.parse(v.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

/**
 * O post que já saiu no Instagram com esta legenda desde `desde` (a criação do post no Liame), na resposta de `GET
 * /{ig}/media?fields=id,caption,timestamp,permalink`: é como a tentativa seguinte sabe que a anterior publicou mesmo
 * sem a resposta dela ter chegado, e não publica de novo (A6-9). `excluir`: os posts que outros canais do Liame já
 * guardaram como seus (o post de outro dia com a mesma legenda não é este; ERR-206). Nulo quando não há.
 */
export function postJaPublicado(resposta: unknown, legenda: string, desde: Date, excluir: ReadonlySet<string> = new Set()): { id: string; permalink: string | null } | null {
  const data = (resposta as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const procurada = legendaComparavel(legenda);
  // A data do Instagram vem em segundos: o post publicado no mesmo segundo da criação conta.
  const aPartirDe = Math.floor(desde.getTime() / 1000) * 1000;
  for (const m of data as Array<Record<string, unknown> | null>) {
    const id = idDaGraph(m?.id);
    if (!id || excluir.has(id) || typeof m?.caption !== 'string' || legendaComparavel(m.caption) !== procurada) continue;
    const quando = horaDoInstagram(m.timestamp);
    if (!Number.isNaN(quando) && quando >= aPartirDe) return { id, permalink: enderecoDoPost(m.permalink) };
  }
  return null;
}

/** O endereço do post publicado (`permalink`): só `https` de um domínio do Instagram; o resto, nulo. */
export function enderecoDoPost(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 500) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && (u.hostname === 'instagram.com' || u.hostname.endsWith('.instagram.com')) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** O id que a Graph API devolve ao criar o contêiner ou publicar (`{"id": "…"}`); fora do formato, nulo. */
export function idDaResposta(corpo: unknown): string | null {
  return idDaGraph((corpo as { id?: unknown } | null)?.id);
}

// A foto na Página do Facebook (A6 · Z5b, parte 3; base §2.2, reconferida em 29/10/2026 nas páginas oficiais
// `…/docs/graph-api/reference/page/photos/`, `…/reference/photo/` e `…/docs/pages-api/getting-started`, v26.0).

/** O maior arquivo que a Página aceita na foto ("no máximo 4 MB"). A cópia guardada (ADR-021) fica bem abaixo. */
export const MAIOR_FOTO_DA_PAGINA_BYTES = 4 * 1024 * 1024;
/** A tarefa que a pessoa precisa ter na Página para o token dela publicar (`CREATE_CONTENT`). */
export const TAREFA_DE_PUBLICAR = 'CREATE_CONTENT';
/** A tarefa que a pessoa precisa ter na Página para o token dela ler os números (`ANALYZE`; A6, Z7). */
export const TAREFA_DE_ANALISAR = 'ANALYZE';

/**
 * O token da Página, na resposta de `GET /me/accounts?fields=id,access_token,tasks` (Pages API, "Get a Page access
 * token": cada Página com o token dela e as tarefas de quem autorizou). Nulo quando a autorização não alcança a Página.
 * `podePublicar`: quem autorizou tem a tarefa de criar conteúdo nela; `podeAnalisar`, a de ler os números dela.
 */
export function tokenDaPagina(resposta: unknown, paginaId: string): { token: string; podePublicar: boolean; podeAnalisar: boolean } | null {
  const data = (resposta as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  for (const p of data as Array<Record<string, unknown> | null>) {
    if (idDaGraph(p?.id) !== paginaId) continue;
    const token = texto(p?.access_token);
    if (!token) return null;
    const tarefas = Array.isArray(p?.tasks) ? (p.tasks as unknown[]) : [];
    return { token, podePublicar: tarefas.includes(TAREFA_DE_PUBLICAR), podeAnalisar: tarefas.includes(TAREFA_DE_ANALISAR) };
  }
  return null;
}

/** O id do post da Página (`{página}_{post}`, como o `post_id` da foto publicada); fora do formato, nulo. */
export function idDoPostDaPagina(v: unknown): string | null {
  return typeof v === 'string' && /^\d{1,30}_\d{1,30}$/.test(v) ? v : null;
}

/** O endereço do post na Página (`permalink_url` do post, ou o `link` da foto): só `https` de um domínio do Facebook. */
export function enderecoNaPagina(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 500) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && (u.hostname === 'facebook.com' || u.hostname.endsWith('.facebook.com')) ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A foto que já saiu na Página com esta legenda desde `desde`, na resposta de `GET /{página}/photos?type=uploaded&fields=
 * id,name,created_time,link,page_story_id` (o `name` da foto é a legenda: "Corresponds to caption when creating
 * photos"; a data vem como a do Instagram, `+0000`). É como a tentativa seguinte sabe que a anterior publicou sem a
 * resposta ter chegado (A6-9). `excluir`: as fotos (ou os posts delas) que outros canais do Liame já guardaram como
 * seus (ERR-206). Nulo quando não há.
 */
export function fotoJaNaPagina(resposta: unknown, legenda: string, desde: Date, excluir: ReadonlySet<string> = new Set()): { id: string; post: string | null; link: string | null } | null {
  const data = (resposta as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const procurada = legendaComparavel(legenda);
  const aPartirDe = Math.floor(desde.getTime() / 1000) * 1000;
  for (const f of data as Array<Record<string, unknown> | null>) {
    const id = idDaGraph(f?.id);
    if (!id || excluir.has(id) || (typeof f?.page_story_id === 'string' && excluir.has(f.page_story_id))) continue;
    if (typeof f?.name !== 'string' || legendaComparavel(f.name) !== procurada) continue;
    const quando = horaDoInstagram(f.created_time);
    if (!Number.isNaN(quando) && quando >= aPartirDe) return { id, post: idDoPostDaPagina(f.page_story_id), link: enderecoNaPagina(f.link) };
  }
  return null;
}

// O vídeo como Reels (A6 · Z10, parte 3a; D-A6-68 e D-A6-69; conferido nas páginas oficiais em 06/11/2026: a referência
// de `/{ig-user-id}/media` do Instagram, com as especificações do Reels, e o "Reels Publishing" da Video API, v27.0).

/**
 * O que o Reels do Instagram aceita do arquivo: até 1.920 colunas (a largura, em px) e até 25 Mbps. O vídeo que passa disso
 * (o 4K do celular) é reduzido pelo servidor antes de sair (D-A6-68), o que ainda não existe: até lá, o post com ele no
 * Instagram é recusado ao montar.
 */
export const REELS_DO_INSTAGRAM = { maiorLargura: 1920, maiorTaxaBps: 25_000_000 } as const;

/**
 * O Reels da Página do Facebook: em pé, a partir de 540 × 960 (o código 1363127 recusa abaixo disso), e até 30 publicados
 * pela API em 24 horas, por Página (janela móvel; a Meta pede que o app também conte). O vídeo deitado, ou menor que isso,
 * sai como vídeo comum (D-A6-69).
 */
export const REELS_DA_PAGINA = { menorLargura: 540, menorAltura: 960, porDia: 30 } as const;

/** Por quanto tempo o Liame espera a Meta preparar o vídeo, conferindo uma vez por minuto (D-A6-69). */
export const PREPARO_DO_VIDEO_MS = 5 * 60_000;

/**
 * O código do adiamento enquanto a Meta prepara (ou publica) o vídeo: o executor confere de novo em 1 minuto, sem dobrar
 * a espera e sem contar como tentativa; quem encerra, em 5 minutos, é a publicação (D-A6-69).
 */
export const VIDEO_EM_PREPARO = 'video_em_preparo';

/** O endereço do envio do vídeo à Página do Facebook (o `rupload`), fora da Graph API. */
export const RUPLOAD_OFICIAL = 'https://rupload.facebook.com';

/** A capa do Reels do Instagram (`cover_url`): JPEG até 8 MB (a especificação da capa, na mesma página). */
export const CAPA_DO_REELS_BYTES = 8 * 1024 * 1024;

/** A taxa média do arquivo, em bits por segundo (o som junto); sem a duração, infinita. */
export function taxaDoVideo(bytes: number, duracaoMs: number): number {
  if (!(duracaoMs > 0)) return Number.POSITIVE_INFINITY;
  return (bytes * 8) / (duracaoMs / 1000);
}

/** O vídeo vai ao Reels do Instagram como está (a largura e a taxa no limite)? */
export function cabeNoReelsDoInstagram(largura: number, bytes: number, duracaoMs: number): boolean {
  return largura > 0 && largura <= REELS_DO_INSTAGRAM.maiorLargura && taxaDoVideo(bytes, duracaoMs) <= REELS_DO_INSTAGRAM.maiorTaxaBps;
}

/** Como o vídeo sai na Página: Reels, em pé e a partir de 540 × 960; vídeo comum, deitado ou menor (D-A6-69). */
export type ComoSaiNaPagina = 'reels' | 'video';

export function comoSaiNaPagina(largura: number, altura: number): ComoSaiNaPagina {
  if (largura > altura) return 'video';
  return largura >= REELS_DA_PAGINA.menorLargura && altura >= REELS_DA_PAGINA.menorAltura ? 'reels' : 'video';
}

/** A situação do vídeo na Página: publicado, a Meta ainda prepara, recusado, vencido ou fora do formato conhecido. */
export type SituacaoDoVideoNaPagina = 'publicado' | 'processando' | 'erro' | 'vencido' | 'desconhecida';

const fase = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);

/**
 * A situação pela resposta de `GET /{video-id}?fields=status`: `video_status` (`uploading`, `upload_complete`,
 * `processing`, `ready`, `error`, `upload_failed`, `expired`) e as fases (`processing_phase`, `publishing_phase`, cada uma
 * com `status`: `not_started`, `in_progress`, `complete` ou `completed`, `error`; a de publicar com `publish_status`:
 * `draft`, `scheduled`, `published` ou `error`). Publicado só com a palavra da Meta; erro em qualquer fase é erro.
 */
export function situacaoDoVideoNaPagina(resposta: unknown): SituacaoDoVideoNaPagina {
  const s = fase((resposta as { status?: unknown } | null)?.status);
  if (!s) return 'desconhecida';
  const video = s.video_status;
  const processando = fase(s.processing_phase);
  const publicando = fase(s.publishing_phase);
  if (video === 'error' || video === 'upload_failed' || processando?.status === 'error' || publicando?.status === 'error' || publicando?.publish_status === 'error') return 'erro';
  if (video === 'expired') return 'vencido';
  if (publicando?.publish_status === 'published') return 'publicado';
  if (typeof video === 'string') return 'processando';
  return 'desconhecida';
}

/** O id do vídeo na Página, na resposta do começo do Reels (`video_id`) ou do vídeo comum (`id`); fora do formato, nulo. */
export function idDoVideoNaPagina(corpo: unknown): string | null {
  const c = corpo as { video_id?: unknown; id?: unknown } | null;
  return idDaGraph(c?.video_id) ?? idDaGraph(c?.id);
}

/**
 * O vídeo comum que já saiu na Página com esta legenda desde `desde`, na resposta de `GET /{página}/videos?fields=id,
 * description,created_time` (a legenda do vídeo é a `description`; a data vem como a do Instagram, `+0000`): é como a
 * tentativa seguinte sabe que a anterior mandou o vídeo sem a resposta ter chegado, e não manda de novo. `excluir`: os
 * vídeos que outros canais do Liame já guardaram como seus (ERR-206). O id, ou nulo.
 */
export function videoJaNaPagina(resposta: unknown, legenda: string, desde: Date, excluir: ReadonlySet<string> = new Set()): string | null {
  const data = (resposta as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  const procurada = legendaComparavel(legenda);
  const aPartirDe = Math.floor(desde.getTime() / 1000) * 1000;
  for (const v of data as Array<Record<string, unknown> | null>) {
    const id = idDaGraph(v?.id);
    if (!id || excluir.has(id) || typeof v?.description !== 'string' || legendaComparavel(v.description) !== procurada) continue;
    const quando = horaDoInstagram(v.created_time);
    if (!Number.isNaN(quando) && quando >= aPartirDe) return id;
  }
  return null;
}

/** Os códigos com que a Página recusa o vídeo do Reels: a proporção, a resolução, a duração e os quadros por segundo. */
export const CODIGOS_DO_VIDEO_RECUSADO: ReadonlySet<string> = new Set(['1363040', '1363127', '1363128', '1363129']);

/**
 * O endereço do envio do Reels da Página (`upload_url` da resposta do começo): só o do envio da Meta, para este vídeo. O
 * que vier fora disso não é seguido; quem chama usa o endereço montado pela base conhecida.
 */
export function enderecoDoEnvioNaPagina(v: unknown, base: string, videoId: string): string {
  const esperado = `${base}/video-upload/`;
  if (typeof v === 'string' && v.length <= 300 && v.startsWith(esperado) && v.endsWith(`/${videoId}`)) {
    const meio = v.slice(esperado.length, v.length - videoId.length);
    // Entre a base e o id, nada ou só a versão da API (`v26.0/`).
    if (meio === '' || /^v\d{1,3}\.\d{1,2}\/$/.test(meio)) return v;
  }
  return `${esperado}${videoId}`;
}
