import { type BrandPhoto, VIDEO_MONTAGE_LIMITS, VIDEO_TEMPLATE_RULES, type VideoFormat, type VideoMontageResponse, type VideoTemplate, type VideoTextsResponse } from '@liame/contracts';

// Os textos e as regras da tela do vídeo montado pelo Liame (A6 · Z15, parte 4; P43 aprovado em 11/11/2026): os nomes
// dos modelos e dos formatos, as durações, o que cada fase diz (na gaveta e no cartão de Fotos) e o porquê de o
// Social media não ter proposto os textos. Funções puras.

export const MODELOS: Record<VideoTemplate, { nome: string; desc: string }> = {
  destaque: { nome: 'Produto em destaque', desc: 'Uma foto, com zoom lento, o nome e o preço.' },
  combo: { nome: 'Combo com preço', desc: 'De 2 a 4 fotos em sequência, e o preço no fim.' },
  novidade: { nome: 'Novidade da casa', desc: 'Uma foto ou um vídeo, a faixa “Novidade” e a chamada.' },
};
export const ORDEM_DOS_MODELOS: VideoTemplate[] = ['destaque', 'combo', 'novidade'];

export const FORMATOS: Record<VideoFormat, { nome: string; w: number; h: number }> = {
  '9x16': { nome: 'Reels e Story (9:16)', w: 1080, h: 1920 },
  '4x5': { nome: 'Feed (4:5)', w: 1080, h: 1350 },
  '1x1': { nome: 'Quadrado (1:1)', w: 1080, h: 1080 },
};
export const ORDEM_DOS_FORMATOS: VideoFormat[] = ['9x16', '4x5', '1x1'];
export const DURACOES = [6, 10, 15] as const;
export type Duracao = (typeof DURACOES)[number];
export const MAX = { titulo: VIDEO_MONTAGE_LIMITS.title, preco: VIDEO_MONTAGE_LIMITS.priceLine, chamada: VIDEO_MONTAGE_LIMITS.cta } as const;

export const duracaoTxt = (s: number) => `${s} segundos`;
export const contagem = (n: number, max: number) => (n > max ? `${n} de ${max}: passou ${n - max}` : `${n} de ${max}`);
export const ordinal = (n: number) => `${n}º`;

/** As fotos e os vídeos de Fotos que o modelo aceita: prontos, da loja (o vídeo montado não entra de novo). */
export function aceitas(fotos: readonly BrandPhoto[], modelo: VideoTemplate): BrandPhoto[] {
  const regra = VIDEO_TEMPLATE_RULES[modelo];
  return fotos.filter((f) => !f.montage_id && (regra.video || f.kind !== 'video'));
}

/** Quantas o modelo leva, como a tela escreve. */
export function quantasLeva(modelo: VideoTemplate): string {
  const r = VIDEO_TEMPLATE_RULES[modelo];
  if (r.min === r.max) return r.video ? '1 foto ou 1 vídeo' : '1 foto';
  return `de ${r.min} a ${r.max} fotos, na ordem em que entram no vídeo`;
}

/** A frase da fila, a mesma na gaveta e no cartão. */
export function antesDeste(n: number): string {
  if (n <= 0) return 'É o próximo da fila';
  return `${n === 1 ? '1 vídeo' : `${n} vídeos`} antes deste`;
}

export type Fase = 'fila' | 'montando' | 'pronto' | 'nao_deu';
export const faseDe = (m: Pick<VideoMontageResponse, 'status'>): Fase => (m.status === 'na_fila' ? 'fila' : m.status === 'montando' ? 'montando' : m.status === 'pronto' ? 'pronto' : 'nao_deu');

/** O título e a frase de cada fase (P43). */
export function textoDaFase(m: VideoMontageResponse): { t: string; txt: string } {
  const fase = faseDe(m);
  if (fase === 'fila') {
    const n = m.queue_ahead ?? 0;
    return { t: 'Na fila', txt: `Na fila: ${antesDeste(n).toLowerCase()}. Fica pronto em cerca de ${n + 1} ${n + 1 === 1 ? 'minuto' : 'minutos'}; pode fechar, ele aparece em Fotos.` };
  }
  if (fase === 'montando') return { t: 'É a vez deste vídeo', txt: 'Fica pronto em cerca de 1 minuto; pode fechar, ele aparece em Fotos.' };
  if (fase === 'pronto') {
    return m.photo_id
      ? { t: 'O vídeo está pronto', txt: 'Ele entrou em Fotos com a etiqueta “Montado pelo Liame”. Dali, vai para um post, um Story ou uma campanha nova, com a aprovação de sempre.' }
      : { t: 'O vídeo saiu de Fotos', txt: 'Este vídeo ficou pronto, mas alguém o apagou de Fotos.' };
  }
  return { t: 'Não deu para montar este vídeo', txt: m.error ?? 'Peça de novo; este não conta no limite do dia.' };
}

/** Por que a proposta do Social media não veio (a pessoa escreve os textos). */
export function semIaTxt(r: VideoTextsResponse): string {
  switch (r.reason) {
    case 'sem-rota':
      return 'O Social media ainda não escreve os textos do vídeo. Por enquanto, escreva você.';
    case 'ia_desligada':
      return 'A IA está desligada para esta empresa. Escreva os textos você.';
    case 'funcionario_desligado':
      return 'O Social media está desligado em Sua equipe. Escreva os textos você.';
    case 'teto':
      return r.retry_at ? `A IA chegou ao limite de gasto. Ela volta em ${new Date(r.retry_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}; até lá, escreva você.` : 'A IA chegou ao limite de gasto. Escreva os textos você.';
    case 'limite-usuario':
      return 'Você chegou ao limite de pedidos à IA desta hora. Escreva os textos você, ou peça daqui a pouco.';
    case 'barrado':
    case 'formato':
      return 'A proposta do Social media não passou na conferência do Compliance. Peça outros, ou escreva você.';
    case 'indisponivel':
    case 'parada':
    case 'travada':
      return 'A IA não respondeu agora. Tente de novo em instantes, ou escreva você.';
    default:
      return 'O Social media não propôs os textos agora. Escreva você.';
  }
}

/** O rótulo da prévia para quem não vê o quadro. */
export function rotuloDaPrevia(p: { modelo: VideoTemplate; formato: VideoFormat; dur: number; midias: { video: boolean; produto: string }[]; titulo: string; preco: string; chamada: string; logo: boolean; somOriginal: boolean }): string {
  const regra = VIDEO_TEMPLATE_RULES[p.modelo];
  const oque = p.midias.length ? p.midias.map((m, i) => `${p.midias.length > 1 ? `${ordinal(i + 1)} ` : ''}${m.video ? 'o vídeo' : 'a foto'} de ${m.produto}`).join(', ') : 'ainda sem foto';
  const textos = [p.titulo && `o título “${p.titulo}”`, regra.price && p.preco && `o preço “${p.preco}”`, p.chamada && `a chamada “${p.chamada}”`].filter(Boolean);
  return `Prévia do vídeo: ${MODELOS[p.modelo].nome}, ${FORMATOS[p.formato].nome}, ${duracaoTxt(p.dur)}: ${oque}${regra.video ? ', a faixa “Novidade”' : ''}${textos.length ? `, ${textos.join(', ')}` : ''}${p.logo ? ', com a logo' : ''}${p.somOriginal ? ', com o som do vídeo original' : ', sem música'}.`;
}
