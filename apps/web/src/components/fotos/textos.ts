import { BRAND_PHOTO_LIMITS as L, BRAND_VIDEO_LIMITS as V, type BrandPhoto } from '@liame/contracts';
import { dia, inteiro, quandoComHora } from '@/lib/formato';

// Fotos (A6 · Z4, parte b; protótipo P20, aprovado em 21/10/2026): as regras e os textos da tela, em funções puras.
// Os limites são os do contrato (os mesmos do servidor): JPEG, PNG ou WebP, até 10 MB; recusa abaixo de 600 px no lado
// menor e acima de 10.000 px no lado maior; até 20 fotos por vez. O aviso de nitidez é pela LARGURA da cópia que o Liame
// guarda (ERR-152), e quem decide é o servidor (`narrow_for_instagram`).

export const TIPOS_ACEITOS = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const ACEITA = TIPOS_ACEITOS.join(',');
export const POR_VEZ = L.perBatch;
export const DESCRICAO_MAX = L.descriptionMax;
/** Envios ao mesmo tempo: o servidor regrava duas fotos por vez em cada processo. */
export const ENVIOS_JUNTOS = 2;

export const INFO_DO_ENVIO = `JPEG, PNG ou WebP, até ${L.maxBytes / (1024 * 1024)} MB. Prefira foto quadrada ou na horizontal. Só fotos que a empresa pode usar, sem pessoas que dê para reconhecer.`;

/** Por que um arquivo não entrou (a mesma regra do servidor; o servidor confere de novo). */
export type Recusa =
  | 'formato'
  | 'heic'
  | 'tamanho'
  | 'nao_abre'
  | 'pequena'
  | 'grande'
  | 'repetida'
  | 'desligada'
  // O vídeo (A6 · Z10, parte 2; os textos do P37 e, nas duas últimas, os do servidor: D-A6-74).
  | 'formato_video'
  | 'tamanho_video'
  | 'nao_abre_video'
  | 'longo'
  | 'curto'
  | 'codec'
  | 'resolucao'
  | 'video_desligado';

export const RECUSA: Record<Recusa, string> = {
  formato: 'Não entrou: só JPEG, PNG ou WebP.',
  heic: 'Não entrou: foto em HEIC. Envie em JPEG.',
  tamanho: `Não entrou: passa de ${L.maxBytes / (1024 * 1024)} MB.`,
  nao_abre: 'Não entrou: o arquivo não abre como foto.',
  pequena: `Não entrou: tem menos de ${inteiro(L.minShortSide)} px no lado menor.`,
  grande: `Não entrou: passa de ${inteiro(L.maxLongSide)} px no lado maior.`,
  repetida: 'Não entrou: essa foto já está aqui.',
  desligada: 'Não entrou: as fotos não estão mais ligadas para esta empresa.',
  formato_video: 'Não entrou: vídeo só em MP4 ou MOV.',
  tamanho_video: `Não entrou: passa de ${V.maxBytes / (1024 * 1024)} MB, o máximo do Reels. Grave em 1080p (não em 4K) ou corte no celular.`,
  nao_abre_video: 'Não entrou: o arquivo não abre como vídeo.',
  longo: `Não entrou: passa de ${V.maxDurationMs / 1000} segundos, o máximo para sair também como Reels na Página do Facebook. Corte no celular e envie de novo.`,
  curto: `Não entrou: tem menos de ${V.minDurationMs / 1000} segundos, o mínimo do Reels.`,
  codec: 'Não entrou: o vídeo precisa estar em H.264 ou HEVC, com o som em AAC, como o celular grava. Envie o arquivo original do celular.',
  resolucao: `Não entrou: passa de 4K (${inteiro(V.maxLongSide)} px no lado maior). Grave em 4K ou menos e envie de novo.`,
  video_desligado: 'Não entrou: o vídeo nas Fotos não está mais ligado para esta empresa.',
};

export const AVISO_DE_NITIDEZ = `Entrou, mas tem menos de ${inteiro(L.instagramWidth)} px de largura: no Instagram, pode sair sem nitidez.`;
export const NOTA_DE_NITIDEZ = `Tem menos de ${inteiro(L.instagramWidth)} px de largura: no Instagram, pode sair sem nitidez.`;
export const FALHA_DE_CONEXAO = 'Não foi: a conexão caiu no meio do envio.';

/** A recusa pelo código do problema que o servidor devolve (fotos.service.ts, conferencia.ts e o leitor da foto). */
export function recusaDoCodigo(codigo: string): Recusa | null {
  switch (codigo) {
    case 'foto-formato':
    case 'formato-nao-suportado':
      return 'formato';
    case 'foto-heic':
      return 'heic';
    case 'grande-demais':
      return 'tamanho';
    case 'foto-nao-abre':
    case 'foto-sem-arquivo':
      return 'nao_abre';
    case 'foto-pequena':
      return 'pequena';
    case 'foto-grande-demais':
      return 'grande';
    case 'foto-repetida':
      return 'repetida';
    case 'funcao-desligada':
      return 'desligada';
    case 'video-formato':
      return 'formato_video';
    case 'video-grande-demais':
      return 'tamanho_video';
    case 'video-nao-abre':
      return 'nao_abre_video';
    case 'video-longo':
      return 'longo';
    case 'video-curto':
      return 'curto';
    case 'video-codec':
      return 'codec';
    case 'video-resolucao':
      return 'resolucao';
    default:
      return null;
  }
}

/** A conferência antes de enviar, pelo que o navegador diz do arquivo (tipo, nome e tamanho). */
export function conferirArquivo(arquivo: { name: string; type: string; size: number }): Recusa | null {
  const nome = arquivo.name.toLowerCase();
  if (arquivo.type === 'image/heic' || arquivo.type === 'image/heif' || nome.endsWith('.heic') || nome.endsWith('.heif')) return 'heic';
  if (!(TIPOS_ACEITOS as readonly string[]).includes(arquivo.type)) return 'formato';
  if (arquivo.size > L.maxBytes) return 'tamanho';
  if (arquivo.size === 0) return 'nao_abre';
  return null;
}

/** A conferência das medidas que a própria imagem tem (0 = o navegador não abriu a imagem). */
export function conferirMedidas(largura: number, altura: number): Recusa | null {
  if (!largura || !altura) return 'nao_abre';
  if (Math.min(largura, altura) < L.minShortSide) return 'pequena';
  if (Math.max(largura, altura) > L.maxLongSide) return 'grande';
  return null;
}

// ------------------------------------------------------------ a lista do envio

/** `na_fila`: espera a vez (vão duas por vez); `conferindo`: o arquivo chegou e o servidor regrava a foto. */
export type Fase = 'na_fila' | 'enviando' | 'conferindo' | 'ok' | 'aviso' | 'recusada' | 'falhou';

export const terminou = (fase: Fase) => fase === 'ok' || fase === 'aviso' || fase === 'recusada' || fase === 'falhou';
const entrou = (fase: Fase) => fase === 'ok' || fase === 'aviso';

/**
 * Como a lista chama o que está nela (P37): fotos; vídeos, quando são todos vídeos; arquivos, quando mistura os dois.
 * `videos[i]` diz se o i-ésimo é vídeo (vazio = todos fotos).
 */
function nomeDoLote(n: number, videos: readonly boolean[]): { nome: (k: number) => string; feminino: boolean; singular: string } {
  const algum = videos.some(Boolean);
  const todos = algum && videos.length === n && videos.every(Boolean);
  if (!algum) return { nome: (k) => (k === 1 ? 'foto' : 'fotos'), feminino: true, singular: 'A foto' };
  if (todos) return { nome: (k) => (k === 1 ? 'vídeo' : 'vídeos'), feminino: false, singular: 'O vídeo' };
  return { nome: (k) => (k === 1 ? 'arquivo' : 'arquivos'), feminino: false, singular: 'O arquivo' };
}

/** O título da lista do envio, enquanto envia e no fim. */
export function tituloDoEnvio(fases: Fase[], videos: readonly boolean[] = []): string {
  const n = fases.length;
  const { nome, feminino, singular } = nomeDoLote(n, videos);
  if (!fases.every(terminou)) return `Enviando ${n} ${nome(n)}`;
  const e = fases.filter(entrou).length;
  if (e === n) return n === 1 ? `${singular} entrou` : `${feminino ? 'As' : 'Os'} ${n} ${nome(n)} entraram`;
  if (e === 0) return n === 1 ? `${singular} não entrou` : `${feminino ? 'Nenhuma das' : 'Nenhum dos'} ${n} ${nome(n)} entrou`;
  return `${e} de ${n} ${nome(n)} ${e === 1 ? 'entrou' : 'entraram'}`;
}

/** O que se anuncia no fim do envio (leitor de tela). */
export function resumoDoEnvio(fases: Fase[], videos: readonly boolean[] = []): string {
  const { nome } = nomeDoLote(fases.length, videos);
  const e = fases.filter(entrou).length;
  const f = fases.length - e;
  return `${e} ${nome(e)} ${e === 1 ? 'entrou' : 'entraram'}${f ? `; ${f} não ${f === 1 ? 'entrou' : 'entraram'}` : ''}.`;
}

/** O aviso de quando passa de 20 fotos por vez. */
export function foraDoLote(sobra: number): string {
  return `Até ${POR_VEZ} fotos por vez: ${sobra} ${sobra === 1 ? 'ficou' : 'ficaram'} de fora.`;
}

// ------------------------------------------------------------ a grade

export const nomeDoProduto = (produto: string | null) => produto ?? 'Sem produto';

/** Quantas fotos tem cada produto ('' = sem produto), e todas. */
export function contagens(fotos: Pick<BrandPhoto, 'product'>[]): Map<string, number> {
  const c = new Map<string, number>([['todas', fotos.length]]);
  for (const f of fotos) c.set(f.product ?? '', (c.get(f.product ?? '') ?? 0) + 1);
  return c;
}

/**
 * Os filtros: os produtos de Minha marca que têm foto, na ordem de lá; depois os que têm foto e saíram de Minha marca;
 * por fim, "Sem produto".
 */
export function grupos(fotos: Pick<BrandPhoto, 'product'>[], produtos: string[]): string[] {
  const c = contagens(fotos);
  const fora = [...new Set(fotos.map((f) => f.product).filter((p): p is string => p !== null && !produtos.includes(p)))];
  return [...produtos.filter((p) => c.get(p)), ...fora, ...(c.get('') ? [''] : [])];
}

export function visiveis<T extends Pick<BrandPhoto, 'product'>>(fotos: T[], filtro: string): T[] {
  return filtro === 'todas' ? fotos : fotos.filter((f) => (f.product ?? '') === filtro);
}

/** O nome da foto na grade para quem usa leitor de tela. */
export function rotuloDoCartao(f: Pick<BrandPhoto, 'product' | 'orientation' | 'uploaded_at' | 'narrow_for_instagram'>, agora: Date): string {
  const d = dia(f.uploaded_at, agora);
  return `Foto: ${nomeDoProduto(f.product)}, ${f.orientation}, enviada ${d === 'hoje' ? 'hoje' : `em ${d}`}${f.narrow_for_instagram ? ', pequena para o Instagram' : ''}`;
}

// ------------------------------------------------------------ a gaveta

/** A nota de recorte: a foto mais alta que 4:5 ou mais larga que 1,91:1 vai precisar de um recorte no Instagram. */
export function notaDoRecorte(recorte: string): string | null {
  if (recorte === 'alta') return 'Muito alta para o Instagram: lá, ela vai precisar de um recorte.';
  if (recorte === 'larga') return 'Muito larga para o Instagram: lá, ela vai precisar de um recorte.';
  return null;
}

export function medidas(f: Pick<BrandPhoto, 'width' | 'height' | 'orientation'>): string {
  return `${inteiro(f.width)} × ${inteiro(f.height)} px, ${f.orientation}`;
}

export function quemEnviou(f: Pick<BrandPhoto, 'uploaded_by' | 'uploaded_at'>, agora: Date): string {
  const q = quandoComHora(f.uploaded_at, agora);
  return f.uploaded_by?.name ? `por ${f.uploaded_by.name}, ${q}` : q;
}

/** O que mudou na gaveta (só vai ao servidor o que mudou); nulo = nada mudou. */
export function mudancas(
  f: Pick<BrandPhoto, 'product' | 'description'>,
  produto: string,
  descricao: string,
): { product?: string | null; description?: string } | null {
  const novo: { product?: string | null; description?: string } = {};
  const p = produto === '' ? null : produto;
  if (p !== f.product) novo.product = p;
  const d = descricao.trim();
  if (d !== f.description) novo.description = d;
  return Object.keys(novo).length ? novo : null;
}

/** Os endereços assinados valem 5 minutos: abrir uma foto perto do fim pede a lista de novo antes. */
export function enderecosVencendo(expiraEm: string, agora: Date, folgaMs = 30_000): boolean {
  return new Date(expiraEm).getTime() - agora.getTime() < folgaMs;
}

// ------------------------------------------------------------ o vídeo (A6 · Z10, parte 2; P37, parte A)
// O vídeo que a loja gravou: MP4 ou MOV, de 3 a 90 segundos, até 300 MB (D-A6-68), conferido pelo servidor pelo
// cabeçalho do arquivo. A tela confere antes o que o navegador sabe dizer (o tipo, o tamanho e, quando consegue abrir o
// vídeo, a duração e as medidas); o que ele não consegue (o codec, ou a duração de um HEVC que o navegador não toca),
// o servidor decide.

export const TIPOS_DE_VIDEO = ['video/mp4', 'video/quicktime'] as const;

/** O que o seletor de arquivos aceita: as fotos e, com o vídeo ligado, os vídeos. */
export function aceita(comVideo: boolean): string {
  return (comVideo ? [...TIPOS_ACEITOS, ...TIPOS_DE_VIDEO] : TIPOS_ACEITOS).join(',');
}

export const INFO_COM_VIDEO = `JPEG, PNG ou WebP, até ${L.maxBytes / (1024 * 1024)} MB. Vídeo em MP4 ou MOV, de ${V.minDurationMs / 1000} a ${V.maxDurationMs / 1000} segundos e até ${V.maxBytes / (1024 * 1024)} MB, de preferência em pé. Só o que a empresa pode usar, sem pessoas que dê para reconhecer.`;

export const ehVideo = (f: Pick<BrandPhoto, 'kind'>) => f.kind === 'video';

/** É vídeo, pelo que o navegador diz do arquivo (o tipo; ou o nome, quando o tipo vem vazio). */
export function ehArquivoDeVideo(arquivo: { name: string; type: string }): boolean {
  return arquivo.type.startsWith('video/') || /\.(mp4|mov|avi|mkv|webm)$/i.test(arquivo.name);
}

/** A conferência antes de enviar, pelo que o navegador diz do arquivo. */
export function conferirArquivoDeVideo(arquivo: { type: string; size: number }): Recusa | null {
  if (!(TIPOS_DE_VIDEO as readonly string[]).includes(arquivo.type)) return 'formato_video';
  if (arquivo.size > V.maxBytes) return 'tamanho_video';
  if (arquivo.size === 0) return 'nao_abre_video';
  return null;
}

/**
 * A conferência pelo próprio vídeo, com a mesma conta do servidor (`conferirVideo`): a duração e o lado maior.
 * `duracaoMs` nulo = o navegador não abriu o vídeo (um HEVC no Windows, por exemplo): a tela não recusa, e o servidor,
 * que lê o cabeçalho sem tocar o vídeo, decide.
 */
export function conferirOVideo(m: { duracaoMs: number | null; largura: number; altura: number }): Recusa | null {
  if (m.duracaoMs === null) return null;
  if (m.duracaoMs < V.minDurationMs) return 'curto';
  if (m.duracaoMs > V.maxDurationMs) return 'longo';
  if (Math.max(m.largura, m.altura) > V.maxLongSide) return 'resolucao';
  return null;
}

/** A duração no canto do cartão: `0:18`, `1:30`. */
export function duracaoCurta(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A duração para ler: "18 segundos", "1 min e 30 s", "1 min". */
export function duracaoPorExtenso(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} segundos`;
  return s % 60 ? `${Math.floor(s / 60)} min e ${s % 60} s` : `${s / 60} min`;
}

/** Deitado (mais largo que alto): o Reels pede em pé (9:16). */
export const deitado = (f: { width: number; height: number }) => f.width > f.height;

export const CONFERINDO_O_VIDEO = 'Conferindo o vídeo: o formato, a duração e se está em pé…';
export const AVISO_DEITADO =
  'Entrou, mas está deitado: o Reels pede vídeo em pé (9:16). No Instagram ele sai assim mesmo; na Página do Facebook, sai como vídeo comum, não como Reels.';
export const NOTA_DEITADO =
  'Está deitado: o Reels pede vídeo em pé (9:16). No Instagram ele sai assim mesmo; na Página do Facebook, como vídeo comum. Para o Reels, prefira gravar em pé.';
export const entrouOVideo = (ms: number) => `Entrou: ${duracaoPorExtenso(ms)}, em pé.`;

/** O nome do vídeo na grade para quem usa leitor de tela (P37). */
export function rotuloDoVideo(f: Pick<BrandPhoto, 'product' | 'uploaded_at' | 'width' | 'height' | 'video' | 'montage_id'>, agora: Date): string {
  const d = dia(f.uploaded_at, agora);
  const ehDeitado = deitado(f);
  const duracao = f.video ? `, ${duracaoPorExtenso(f.video.duration_ms)}` : '';
  // O vídeo montado pelo Liame (A6 · Z15, parte 4): o rótulo diz quem fez.
  const quem = f.montage_id ? `montado pelo Liame ${d === 'hoje' ? 'hoje' : `em ${d}`}` : `enviado ${d === 'hoje' ? 'hoje' : `em ${d}`}`;
  return `Vídeo${f.montage_id ? ' montado' : ''}: ${nomeDoProduto(f.product)}${duracao}, ${ehDeitado ? 'deitado' : 'em pé'}, ${quem}${ehDeitado ? ', deitado para o Reels' : ''}`;
}

/** As medidas do vídeo como a loja gravou (as do bloco `video`; sem ele, as do Reels). */
export function medidasDoVideo(f: Pick<BrandPhoto, 'width' | 'height' | 'video'>): string {
  const largura = f.video?.width ?? f.width;
  const altura = f.video?.height ?? f.height;
  return `${inteiro(largura)} × ${inteiro(altura)} px, ${largura > altura ? 'deitado' : 'em pé'}`;
}

/** Onde o vídeo pode sair (P37, D-A6-69): o Reels nos dois canais da Meta e, no pacote pronto, o TikTok e o Shorts. */
export function canaisDoVideo(ehDeitado: boolean): { tipo: 'ok' | 'voce'; canal: string; detalhe: string }[] {
  return [
    { tipo: 'ok', canal: 'Reels no Instagram', detalhe: ehDeitado ? 'sai deitado: o Reels é feito para vídeo em pé' : 'em tela cheia, em pé; pode aparecer no Feed e na aba Reels' },
    {
      tipo: 'ok',
      canal: ehDeitado ? 'Vídeo na Página do Facebook' : 'Reels na Página do Facebook',
      detalhe: ehDeitado ? 'como vídeo comum: o Reels da Página só aceita vídeo em pé' : 'o mesmo vídeo, com o texto da Página',
    },
    { tipo: 'voce', canal: 'TikTok e YouTube Shorts', detalhe: 'no pacote pronto: o mesmo arquivo serve; o Liame monta, você publica' },
  ];
}

/** O filtro por tipo (P37): tudo, só as fotos ou só os vídeos. */
export type TipoNaGrade = 'tudo' | 'fotos' | 'videos';

export function doTipo<T extends Pick<BrandPhoto, 'kind'>>(fotos: T[], tipo: TipoNaGrade): T[] {
  if (tipo === 'tudo') return fotos;
  return fotos.filter((f) => (tipo === 'videos' ? ehVideo(f) : !ehVideo(f)));
}

/** Quantos a grade mostra, para quem usa leitor de tela: "3 fotos", "1 vídeo", "3 fotos e 1 vídeo". */
export function quantosNaGrade(fotos: Pick<BrandPhoto, 'kind'>[]): string {
  const v = fotos.filter(ehVideo).length;
  const f = fotos.length - v;
  const deFotos = `${f} ${f === 1 ? 'foto' : 'fotos'}`;
  const deVideos = `${v} ${v === 1 ? 'vídeo' : 'vídeos'}`;
  if (!v) return deFotos;
  return f ? `${deFotos} e ${deVideos}` : deVideos;
}

/** Os rótulos do filtro, com a contagem de cada tipo. */
export function rotulosDoTipo(fotos: Pick<BrandPhoto, 'kind'>[]): [TipoNaGrade, string][] {
  const videos = fotos.filter(ehVideo).length;
  return [
    ['tudo', `Tudo (${fotos.length})`],
    ['fotos', `Fotos (${fotos.length - videos})`],
    ['videos', `Vídeos (${videos})`],
  ];
}
