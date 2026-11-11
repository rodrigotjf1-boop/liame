import { z } from 'zod';
import { localClock } from '../policy/engine.js';

// O post no trilho (A6, Z5b; `plano-a6.md` §3 Z5; D-A6-3, D-A6-6 a D-A6-8, D-A6-21 e D-A6-23; as decisões técnicas
// D-A6-32 a D-A6-37 estão em `decisoes-design.md`). Funções puras: o estado do post que o conector lê do banco, os planos das
// ferramentas `post_publicar`, `post_tentar_de_novo` (a nova tentativa no canal que faltou, Z5d; D-A6-54) e `post_apagar`
// (apagar das redes, Z5d, parte 6; D-A6-57) e a hora em que o pedido aprovado sai. Sem rede e sem banco.
//
// O post é um recurso do Liame (D-A6-32): `post:<id>`. O estado traz a foto (pelo resumo do arquivo), o recorte do
// Instagram, a hora e cada canal com o texto e a situação; é ele que vai para o pedido e entra no hash do plano. A
// aprovação vale para o conjunto (D-A6-7): mudar o texto, a foto ou os canais é um post novo.

export const PREFIXO_DO_POST = 'post:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O recurso do post no trilho, para quem monta o pedido. */
export const recursoDoPost = (id: string): string => `${PREFIXO_DO_POST}${id}`;

/** `post:<id>` → o id do post no Liame; nulo para o que não é um post. */
export function postDoRecurso(resourceId: string): string | null {
  if (!resourceId.startsWith(PREFIXO_DO_POST)) return null;
  const id = resourceId.slice(PREFIXO_DO_POST.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

/** Os canais onde o Liame publica nesta fase (D-A6-12: TikTok e YouTube só no pacote pronto; o Threads, depois). */
export const CANAIS_DO_POST = ['instagram', 'facebook'] as const;
export type CanalDoPost = (typeof CANAIS_DO_POST)[number];

/** O provedor da conta ligada de cada canal (A6 · Z5a): é também o provedor do pedido no trilho. */
export const PROVEDOR_DO_CANAL: Record<CanalDoPost, string> = { instagram: 'instagram', facebook: 'facebook_page' };

/** O nome do canal nas frases, com a preposição dele (V121): "no Instagram", "na Página do Facebook". */
const NO_CANAL: Record<CanalDoPost, string> = { instagram: 'no Instagram', facebook: 'na Página do Facebook' };
const DO_CANAL: Record<CanalDoPost, string> = { instagram: 'do Instagram', facebook: 'da Página do Facebook' };

/**
 * O limite do texto de cada canal: a legenda do Instagram, até 2.200 caracteres (base §2.2, 21/10/2026); a Página do
 * Facebook não escreve limite na referência da foto, e o Liame põe o dele (decisão técnica D-A6-34).
 */
export const LIMITE_DO_TEXTO: Record<CanalDoPost, number> = { instagram: 2200, facebook: 10000 };

/**
 * Os canais do pacote pronto (A6, Z8; D-A6-12 e D-A6-25; P22): o Liame monta o texto, a foto e a hora, e quem publica é a
 * pessoa. Cada rede vira um pacote (`social_post.kind = 'pacote'`), sem pedido em Aprovações e sem conta ligada.
 */
export const CANAIS_DO_PACOTE = ['tiktok', 'youtube'] as const;
export type CanalDoPacote = (typeof CANAIS_DO_PACOTE)[number];
export const ehCanalDoPacote = (c: string): c is CanalDoPacote => (CANAIS_DO_PACOTE as readonly string[]).includes(c);

/**
 * O limite do texto do pacote (decisão técnica D-A6-41): o TikTok, 2.200 caracteres (o que vale em toda conta; a Central do
 * TikTok não publica o número [NC]); o YouTube, os 5.000 da descrição (Central do YouTube, lida em 29/10/2026).
 */
export const LIMITE_DO_PACOTE: Record<CanalDoPacote, number> = { tiktok: 2200, youtube: 5000 };

/** A situação do pacote na Agenda: espera a pessoa (`pronto`), ela marcou "Publiquei", ou foi tirado da Agenda. */
export type SituacaoDoPacote = 'pacote_pronto' | 'pacote_publicado' | 'cancelado';

/** A situação do pacote pelos canais dele (um só, D-A6-40): pronto, publicado ou, tirado, cancelado. */
export function situacaoDoPacote(canais: readonly string[]): SituacaoDoPacote {
  if (canais.some((s) => s === 'pronto')) return 'pacote_pronto';
  if (canais.length > 0 && canais.every((s) => s === 'publicado')) return 'pacote_publicado';
  return 'cancelado';
}

/** A janela da hora do post (D-A6-8): das 8h às 22h, no fuso da empresa, em minutos do dia (22h00 ainda vale). */
export const JANELA_DO_POST = { de: 8 * 60, ate: 22 * 60 } as const;

/** Com quanta antecedência um post pode ser marcado (decisão técnica D-A6-34). */
export const DIAS_DE_ANTECEDENCIA = 60;

/** A situação de cada canal do post. */
export const SituacaoDoCanal = z.enum(['aguardando', 'publicando', 'publicado', 'falhou', 'cancelado', 'apagado']);
export type SituacaoDoCanal = z.infer<typeof SituacaoDoCanal>;

export const CanalNoEstado = z.object({
  canal: z.enum(CANAIS_DO_POST),
  /** A conta ligada do canal (a Página ou o Instagram); nula quando ela foi desligada da marca depois do pedido. */
  conta: z.string().nullable(),
  texto: z.string(),
  situacao: SituacaoDoCanal,
});
export type CanalNoEstado = z.infer<typeof CanalNoEstado>;

/** O post como o conector o lê do banco, na hora do pedido e na da execução. */
export const EstadoDoPost = z.object({
  post: z.string(),
  /** A foto das Fotos (pelo resumo do arquivo guardado); nula quando ela foi apagada depois do pedido, e no post com vídeo. */
  foto: z.object({ id: z.string(), sha256: z.string() }).nullable(),
  /**
   * O vídeo das Fotos e vídeos (A6, Z10, parte 3a; D-A6-69 e D-A6-70), só no post com vídeo: no de foto a chave não
   * existe, e o estado dele é o mesmo de antes (o pedido aprovado não muda de plano). O id e a capa presa na hora do
   * pedido: `capa:<versão>` (a do próprio vídeo), `foto:<id>` (uma das Fotos), `quadro:<ms>` (um quadro do vídeo,
   * escolhido no novo post) ou `meio` (sem capa gravada: o quadro do meio). Nulo quando o vídeo foi apagado; a capa nula
   * quando ela mudou, ou a foto dela foi apagada, depois do pedido.
   */
  video: z.object({ id: z.string(), capa: z.string().nullable() }).nullable().optional(),
  /**
   * O Story (A6, Z13; P41; D-A6-126 e D-A6-127): sem texto em nenhum canal, 24 horas no ar. Só no Story: no post a chave
   * não existe, e o estado dele é o mesmo de antes (o pedido aprovado não muda de plano).
   */
  formato: z.literal('story').optional(),
  /** A posição do recorte do Instagram (D-A6-21), de 0 a 100 ao longo do lado comprido; nula = a foto cabe inteira. */
  recorte: z.number().int().min(0).max(100).nullable(),
  /** A hora marcada, em UTC, e a mesma hora no fuso da empresa (`HH:MM`), que o plano confere com a janela. */
  hora: z.string(),
  hora_local: z.string(),
  canais: z.array(CanalNoEstado).min(1).max(CANAIS_DO_POST.length),
});
export type EstadoDoPost = z.infer<typeof EstadoDoPost>;

/** `HH:MM` dentro da janela das 8h às 22h. */
export function dentroDaJanela(horaLocal: string): boolean {
  if (horaLocal.length !== 5 || horaLocal[2] !== ':') return false;
  const h = Number(horaLocal.slice(0, 2));
  const m = Number(horaLocal.slice(3, 5));
  if (!Number.isInteger(h) || !Number.isInteger(m) || h > 23 || m > 59) return false;
  const minuto = h * 60 + m;
  return minuto >= JANELA_DO_POST.de && minuto <= JANELA_DO_POST.ate;
}

/** A hora local de um instante, `HH:MM`, no fuso da empresa. */
export function horaLocal(instante: Date, fuso: string): string {
  const { minute } = localClock(instante, fuso);
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

export type PlanoDoPost = { ok: true; desejado: EstadoDoPost; texto: string } | { ok: false; motivo: string };

/**
 * O plano de publicar: só um post do Liame, com a foto e as contas ainda lá, com todos os canais esperando, cada texto
 * no limite da rede, e a hora dentro da janela. O estado desejado é o mesmo post, com cada canal publicado; o texto do
 * plano junta o texto dos canais, para as palavras que a empresa ou a marca proíbem valerem (o mesmo da resposta a uma
 * avaliação). Função pura.
 */
export function planoDoPost(before: unknown): PlanoDoPost {
  const lido = EstadoDoPost.safeParse(before);
  if (!lido.success) return { ok: false, motivo: 'Esta ferramenta é para um post do Liame.' };
  const e = lido.data;
  const semMidia = midiaFora(e);
  if (semMidia) return { ok: false, motivo: semMidia };
  if (e.canais.some((c) => c.situacao !== 'aguardando')) return { ok: false, motivo: JA_SAIU };
  for (const c of e.canais) {
    if (!c.conta) return { ok: false, motivo: contaFora(c.canal) };
    const doTexto = recusaDoTexto(e, c);
    if (doTexto) return { ok: false, motivo: doTexto };
  }
  if (!dentroDaJanela(e.hora_local)) return { ok: false, motivo: `${e.formato === 'story' ? 'O Story' : 'O post'} sai entre 8h e 22h. Escolha outra hora.` };
  return {
    ok: true,
    desejado: { ...e, canais: e.canais.map((c) => ({ ...c, situacao: 'publicado' as const })) },
    texto: e.canais.map((c) => c.texto).join('\n\n'),
  };
}

/**
 * O texto do canal: no post, não vazio e no limite da rede; no Story (A6, Z13; D-A6-127), vazio (a Meta não leva legenda
 * no Story). A frase de por que não, ou nula. Função pura.
 */
function recusaDoTexto(e: EstadoDoPost, c: CanalNoEstado): string | null {
  if (e.formato === 'story') return c.texto === '' ? null : 'O Story sai sem texto: a Meta não leva legenda no Story.';
  if (c.texto.trim().length === 0) return `O texto ${NO_CANAL[c.canal]} está vazio.`;
  if (c.texto.length > LIMITE_DO_TEXTO[c.canal]) return `O texto ${NO_CANAL[c.canal]} passa de ${LIMITE_DO_TEXTO[c.canal].toLocaleString('pt-BR')} caracteres.`;
  return null;
}

const FOTO_APAGADA = 'A foto deste post foi apagada nas Fotos: o post não sai. Faça um post novo com outra foto.';
const VIDEO_APAGADO = 'O vídeo deste post foi apagado em Fotos e vídeos: o post não sai. Faça um post novo com outro vídeo.';
const CAPA_MUDOU = 'A capa do vídeo mudou depois da aprovação (ou a foto da capa foi apagada): o post não sai. Faça um post novo com a capa de agora.';
const JA_SAIU = 'Este post já saiu, ou não sai mais: não dá para publicar de novo.';
const SEM_O_QUE_TENTAR = 'Tentar de novo vale para o post que saiu num canal e não no outro: não há canal para tentar agora.';

/**
 * O post ainda tem o que publicar? A foto (no post de foto) ou o vídeo com a capa presa no pedido (no post com vídeo,
 * D-A6-70: a capa que mudou depois da aprovação não sai). A frase de por que não, ou nula.
 */
export function midiaFora(e: EstadoDoPost): string | null {
  if (e.video === undefined) return e.foto ? null : FOTO_APAGADA;
  if (!e.video) return VIDEO_APAGADO;
  return e.video.capa === null ? CAPA_MUDOU : null;
}

/**
 * "Tentar de novo" (A6, Z5d; P19, aprovado pelo dono em 21/10/2026; decisão técnica D-A6-54): o post que saiu num canal e
 * não no outro manda o MESMO post aprovado só no canal que faltou. Vale até este tanto de horas depois de o post sair no
 * outro canal: depois, a hora já mudaria quem vê o post (D-A6-23), e o caminho é um post novo.
 */
export const HORAS_PARA_TENTAR_DE_NOVO = 24;

/**
 * O pedido do post terminou sem sair em todos os canais: falhou (o executor grava assim também a execução barrada por uma
 * trava ou pela função desligada).
 */
const TERMINOU_SEM_SAIR: readonly string[] = ['falhou'];
/** O pedido ainda vai executar (espera a aprovação, a hora, ou está saindo agora). */
export const PEDIDO_AINDA_SAI: readonly string[] = ['sombra', 'aguardando_aprovacao', 'aprovada', 'executando'];
/** O canal que não saiu: falhou, ou ficou esperando ou publicando quando o pedido terminou. */
const CANAL_NAO_SAIU: readonly string[] = ['falhou', 'aguardando', 'publicando'];

/**
 * O canal como a nova tentativa o vê: a situação, quando saiu, se o motivo de não ter saído pede um post novo e, no post
 * com vídeo (A6, Z10), se ele não saiu porque a Meta não terminou de preparar o vídeo a tempo (`semPreparo`), e quando
 * foi a tentativa (`tentadoEm`).
 */
export type CanalParaTentar = { canal: string; situacao: string; publicadoEm: Date | null; pedePostNovo: boolean; semPreparo?: boolean; tentadoEm?: Date | null };

/** Dá para tentar de novo (e em quais canais, o primeiro em `canal`, até quando), ou por que não. */
export type NovaTentativa =
  | { ok: true; canal: string; canais: string[]; ate: Date }
  | { ok: false; motivo: 'ainda_sai' | 'nao_tenta' | 'nao_saiu_em_nenhum' | 'ja_saiu' | 'pede_post_novo' | 'passou_o_prazo' };

/**
 * Dá para "Tentar de novo" (D-A6-54)? Só quando o pedido do post (o de publicar, ou a nova tentativa anterior) terminou
 * sem sair em todos os canais (falhou, inclusive barrado), um canal saiu e o outro não, e o motivo do que não saiu pode passar
 * (a conta, a permissão, a rede fora do ar, uma trava). Vale até 24 horas depois de o post sair no outro canal. O pedido
 * cancelado, recusado ou que expirou não tenta: alguém decidiu que ele não sai.
 * O vídeo que a Meta não terminou de preparar em 5 minutos (A6, Z10; D-A6-69) tenta de novo mesmo sem ter saído em
 * nenhum canal: todos os que faltam, se nenhum deles pede um post novo, até 24 horas depois da tentativa (o preparo da
 * Meta vence em 24 horas). Função pura.
 */
export function novaTentativa(pedido: string | null, canais: readonly CanalParaTentar[], agora: Date): NovaTentativa {
  if (pedido && PEDIDO_AINDA_SAI.includes(pedido)) return { ok: false, motivo: 'ainda_sai' };
  const sairam = canais.filter((c) => c.situacao === 'publicado');
  const faltam = canais.filter((c) => CANAL_NAO_SAIU.includes(c.situacao));
  if (sairam.length > 0 && faltam.length === 0) return { ok: false, motivo: 'ja_saiu' };
  if (!pedido || !TERMINOU_SEM_SAIR.includes(pedido)) return { ok: false, motivo: 'nao_tenta' };
  if (sairam.length === 0) {
    // O vídeo sem preparo a tempo: os canais que faltam, juntos, se ao menos um parou no preparo e nenhum pede post novo.
    if (!faltam.some((c) => c.semPreparo) || faltam.some((c) => c.pedePostNovo)) return { ok: false, motivo: 'nao_saiu_em_nenhum' };
    const tentado = Math.min(...faltam.map((c) => c.tentadoEm?.getTime() ?? agora.getTime()));
    const ate = new Date(tentado + HORAS_PARA_TENTAR_DE_NOVO * 3_600_000);
    if (ate.getTime() <= agora.getTime()) return { ok: false, motivo: 'passou_o_prazo' };
    return { ok: true, canal: faltam[0]!.canal, canais: faltam.map((c) => c.canal), ate };
  }
  // Com dois canais e um no ar, falta um; o motivo dele decide.
  const falta = faltam[0]!;
  if (faltam.length > 1 || falta.pedePostNovo) return { ok: false, motivo: 'pede_post_novo' };
  const saiuEm = Math.min(...sairam.map((c) => c.publicadoEm?.getTime() ?? agora.getTime()));
  const ate = new Date(saiuEm + HORAS_PARA_TENTAR_DE_NOVO * 3_600_000);
  if (ate.getTime() <= agora.getTime()) return { ok: false, motivo: 'passou_o_prazo' };
  return { ok: true, canal: falta.canal, canais: [falta.canal], ate };
}

/**
 * O plano da nova tentativa (a ferramenta `post_tentar_de_novo`): um canal saiu, e o que falta (que a rota pôs de volta na
 * espera) tem a conta conectada e o texto no limite; a foto ainda está nas Fotos. No post com vídeo que a Meta não
 * terminou de preparar (A6, Z10; D-A6-69), também nenhum saiu e todos voltaram à espera. O estado desejado é o post com os
 * canais que faltavam publicados; o texto do plano é o deles (as palavras proibidas da política valem de novo). A hora não
 * é conferida aqui: o pedido sai agora, dentro da janela das 8h às 22h (`quandoSai`). Função pura.
 */
export function planoDeTentarDeNovo(before: unknown): PlanoDoPost {
  const lido = EstadoDoPost.safeParse(before);
  if (!lido.success) return { ok: false, motivo: 'Esta ferramenta é para um post do Liame.' };
  const e = lido.data;
  const semMidia = midiaFora(e);
  if (semMidia) return { ok: false, motivo: semMidia };
  const faltam = e.canais.filter((c) => c.situacao === 'aguardando');
  const sairam = e.canais.filter((c) => c.situacao === 'publicado');
  const umQueFalta = sairam.length > 0 && faltam.length === 1 && sairam.length + faltam.length === e.canais.length;
  const videoSemPreparo = e.video !== undefined && sairam.length === 0 && faltam.length === e.canais.length;
  if (!umQueFalta && !videoSemPreparo) return { ok: false, motivo: SEM_O_QUE_TENTAR };
  for (const c of faltam) {
    if (!c.conta) return { ok: false, motivo: contaFora(c.canal) };
    const doTexto = recusaDoTexto(e, c);
    if (doTexto) return { ok: false, motivo: doTexto };
  }
  return { ok: true, desejado: { ...e, canais: e.canais.map((x) => ({ ...x, situacao: 'publicado' as const })) }, texto: faltam.map((c) => c.texto).join('\n\n') };
}
const contaFora = (canal: CanalDoPost): string =>
  `A conta ${DO_CANAL[canal]} deste post não está conectada à marca agora: o post não sai ${NO_CANAL[canal]}. Confira em Contas conectadas.`;

const NADA_NO_AR = 'Apagar das redes vale para o post que o Liame publicou: este post não está no ar em nenhum canal.';
const contaForaParaApagar = (canal: CanalDoPost): string =>
  `A conta ${DO_CANAL[canal]} deste post não está conectada à marca agora: o Liame não alcança o post ${NO_CANAL[canal]}. Conecte de novo em Contas conectadas, ou apague direto na rede.`;

/**
 * "Apagar das redes" (A6, Z5d, parte 6; P19, aprovado pelo dono em 21/10/2026; decisão técnica D-A6-57): o plano da
 * ferramenta `post_apagar`. Tira o post de cada canal em que ele está no ar (publicado); o que não saiu, ou já foi apagado,
 * fica como está. Cada canal no ar precisa da conta conectada à marca (é por ela que o Liame alcança o post). O estado
 * desejado é o post com esses canais apagados; sem texto (apagar não diz nada em público). Função pura.
 */
export function planoDeApagarOPost(before: unknown): PlanoDoPost {
  const lido = EstadoDoPost.safeParse(before);
  if (!lido.success) return { ok: false, motivo: 'Esta ferramenta é para um post do Liame.' };
  const e = lido.data;
  const motivo = recusaNaHoraDeApagar(e);
  if (motivo) return { ok: false, motivo };
  const sai = new Set(canaisParaTirar(e).map((c) => c.canal));
  return { ok: true, desejado: { ...e, canais: e.canais.map((c) => (sai.has(c.canal) ? { ...c, situacao: 'apagado' as const } : c)) }, texto: '' };
}

/** O Story publicado só na Página não sai pelo Liame (D-A6-132): a Meta não tem como tirar o Story da Página pela API. */
export const STORY_SO_NA_PAGINA =
  'A Meta não deixa tirar o Story da Página do Facebook pela API: tire direto na Página, ou espere, que ele some sozinho depois de 24 horas.';

/**
 * Os canais que "Apagar das redes" tira do ar: os publicados. No Story (A6, Z13, parte 2; D-A6-129 e D-A6-132), só o do
 * Instagram (`DELETE /<IG_MEDIA_ID>` aceita o Story; o Page Stories API não tem como apagar): o da Página fica, e some
 * sozinho depois de 24 horas. Função pura.
 */
export function canaisParaTirar(e: EstadoDoPost): EstadoDoPost['canais'] {
  return e.canais.filter((c) => c.situacao === 'publicado' && (e.formato !== 'story' || c.canal === 'instagram'));
}

/**
 * Na hora de apagar (a do pedido e a da execução), o post ainda pode sair das redes? Algum canal está no ar, e cada um
 * deles tem a conta conectada à marca. No Story, o canal é o do Instagram. Nulo: pode. Função pura.
 */
export function recusaNaHoraDeApagar(e: EstadoDoPost): string | null {
  const noAr = canaisParaTirar(e);
  if (noAr.length === 0) return e.formato === 'story' && e.canais.some((c) => c.situacao === 'publicado') ? STORY_SO_NA_PAGINA : NADA_NO_AR;
  for (const c of noAr) if (!c.conta) return contaForaParaApagar(c.canal);
  return null;
}

/** O pedido de apagar quer tirar algum canal do ar (o estado desejado tem um canal apagado): é o que o conector faz. */
export function querApagar(desejado: unknown): boolean {
  const lido = EstadoDoPost.safeParse(desejado);
  return lido.success && lido.data.canais.some((c) => c.situacao === 'apagado');
}

/**
 * Como foi o pedido de apagar das redes, para a Agenda e Aprovações (o contrato a lista em `PostResponse.removal`):
 * `apagando` (aprovado, executa agora), `apagado` (saiu de todos os canais em que estava no ar), `em_parte` (saiu de um e
 * continua no outro) ou `nao_apagou` (continua no ar). Função pura.
 */
export type SituacaoDoApagar = 'apagando' | 'apagado' | 'em_parte' | 'nao_apagou';

export function situacaoDoApagar(pedido: string, canais: readonly string[]): SituacaoDoApagar {
  if (PEDIDO_AINDA_SAI.includes(pedido)) return 'apagando';
  const apagados = canais.filter((s) => s === 'apagado').length;
  const noAr = canais.filter((s) => s === 'publicado').length;
  if (apagados > 0 && noAr === 0) return 'apagado';
  return apagados > 0 ? 'em_parte' : 'nao_apagou';
}

/**
 * Na hora de sair, o post aprovado ainda pode sair (A6-10)? A foto continua nas Fotos, e cada canal que ainda não saiu
 * (esperando, ou com a publicação começada numa tentativa anterior) tem a conta conectada à marca. O canal já publicado
 * não conta: a tentativa seguinte completa o resto. Nulo: pode sair. Função pura.
 */
export function recusaNaHoraDeSair(e: EstadoDoPost): string | null {
  const faltam = e.canais.filter((c) => c.situacao === 'aguardando' || c.situacao === 'publicando');
  if (faltam.length === 0) return JA_SAIU;
  const semMidia = midiaFora(e);
  if (semMidia) return semMidia;
  for (const c of faltam) if (!c.conta) return contaFora(c.canal);
  return null;
}

/** A situação do post que a Agenda mostra (o contrato a lista em `PostResponse.status`). */
export type SituacaoDoPost =
  | 'esperando_aprovacao'
  | 'agendado'
  | 'publicando'
  | 'publicado'
  | 'em_parte'
  | 'nao_saiu'
  | 'cancelado'
  | 'recusado'
  | 'expirado'
  | 'apagado';

/**
 * A situação do post, pelo pedido em Aprovações e pelos canais: o pedido que espera é "esperando a aprovação"; o aprovado
 * espera a hora ("agendado"); o que executa está "publicando"; o que terminou diz o que saiu (todos os canais, parte deles,
 * nenhum). Recusado e cancelado vêm do pedido (a recusa tem o prefixo dela no motivo). O canal apagado das redes (Z5d,
 * parte 6) saiu: o post que continua no ar nos outros é "publicado", e o que saiu de todos é "apagado". O aprovado com um
 * canal já começado (a Meta preparando o vídeo ou o contêiner, entre uma conferência e outra) também está "publicando",
 * não esperando a hora (ERR-207).
 */
export function situacaoDoPost(pedido: { status: string; status_reason: string | null } | null, canais: readonly string[], prefixoDaRecusa: string): SituacaoDoPost {
  const publicados = canais.filter((s) => s === 'publicado').length;
  const apagados = canais.filter((s) => s === 'apagado').length;
  const deTodos =
    publicados === 0 && apagados > 0 ? 'apagado' : publicados > 0 && publicados + apagados === canais.length ? 'publicado' : publicados > 0 ? 'em_parte' : 'nao_saiu';
  if (!pedido) return 'esperando_aprovacao';
  switch (pedido.status) {
    case 'aguardando_aprovacao':
    case 'sombra':
      return 'esperando_aprovacao';
    case 'aprovada':
      return publicados > 0 || canais.includes('publicando') ? 'publicando' : 'agendado';
    case 'executando':
      return 'publicando';
    case 'cancelada':
      return pedido.status_reason?.startsWith(prefixoDaRecusa) ? 'recusado' : publicados > 0 ? 'em_parte' : 'cancelado';
    case 'expirada':
      return 'expirado';
    default:
      // executada, falhou, bloqueada, estado_mudou: o que saiu é o que os canais dizem.
      return deTodos;
  }
}

/**
 * Quando o pedido aprovado sai (D-A6-8; decisão técnica D-A6-33): na hora marcada; aprovado depois dela, na hora da
 * aprovação; e nunca fora da janela das 8h às 22h no fuso da empresa (o que cairia fora espera as 8h do dia seguinte, ou
 * do mesmo dia, se for de madrugada). Sem hora válida, nulo (o pedido segue o caminho de sempre).
 */
export function quandoSai(horaMarcada: string, agora: Date, fuso: string): Date | null {
  const marcada = new Date(horaMarcada);
  if (Number.isNaN(marcada.getTime())) return null;
  const base = new Date(Math.max(marcada.getTime(), agora.getTime()));
  // O minuto cheio: a janela se confere por minuto, e "8h00" não pode virar "8h00 e 30 segundos".
  base.setUTCSeconds(0, 0);
  const { minute } = localClock(base, fuso);
  if (minute < JANELA_DO_POST.de) return new Date(base.getTime() + (JANELA_DO_POST.de - minute) * 60_000);
  if (minute > JANELA_DO_POST.ate) return new Date(base.getTime() + (24 * 60 - minute + JANELA_DO_POST.de) * 60_000);
  return base;
}
