import type { InstagramMedia, InstagramMediaResponse } from '@liame/contracts';
import { dia, diaHora, inteiro, quandoComHora } from '@/lib/formato';

// "Do seu Instagram" (A6 · Z10, parte 5b; mockups/prototipo-video-fotos.html, P37 parte A, aprovado em 04/11/2026;
// D-A6-71 e D-A6-83): as regras e os textos da aba, em funções puras. O que a loja já publicou no Instagram, lido pelo
// Liame uma vez por dia, a que mais rendeu primeiro (a ordem vem do servidor). Nada aqui foi enviado para o Liame: a
// miniatura é a do próprio Instagram, no endereço da Meta. A gaveta só mostra: as ações que o protótipo desenhou além da
// leitura ("Usar num post de novo", "Pôr um texto no vídeo", "Usar como base de um anúncio") ficam para depois.

export type AbaDasFotos = 'enviados' | 'instagram';
export type TipoNoInstagram = 'tudo' | 'reels' | 'posts';

export const ROTULOS_DAS_ABAS: [AbaDasFotos, string][] = [
  ['enviados', 'Enviados por vocês'],
  ['instagram', 'Do seu Instagram'],
];
export const ROTULOS_DO_TIPO_NO_INSTAGRAM: [TipoNoInstagram, string][] = [
  ['tudo', 'Tudo'],
  ['reels', 'Reels'],
  ['posts', 'Posts'],
];

export const ehReels = (p: Pick<InstagramMedia, 'kind'>) => p.kind === 'reels';

/** O Reels sem o arquivo: a Meta não entrega o vídeo com música do Instagram. */
export const comMusicaDoInstagram = (p: Pick<InstagramMedia, 'kind' | 'has_file'>) => ehReels(p) && !p.has_file;

export function doTipoNoInstagram<T extends Pick<InstagramMedia, 'kind'>>(itens: T[], tipo: TipoNoInstagram): T[] {
  if (tipo === 'tudo') return itens;
  return itens.filter((p) => (tipo === 'reels' ? ehReels(p) : !ehReels(p)));
}

const umaCasa = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

/** O número curto do cartão: "512", "8,4 mil", "1,2 mi"; sem o número, um travessão. */
export function numeroCurto(n: number | null): string {
  if (n === null) return '—';
  if (n < 1000) return inteiro(n);
  if (n < 1_000_000) return `${umaCasa.format(Math.floor(n / 100) / 10)} mil`;
  return `${umaCasa.format(Math.floor(n / 100_000) / 10)} mi`;
}

/** O número inteiro da gaveta; sem ele, "ainda sem número". */
export const numeroDaGaveta = (n: number | null): string => (n === null ? 'ainda sem número' : inteiro(n));

/** "Reels de 12/10" ou "Post de hoje" (a foto, o carrossel e o vídeo do feed são "Post", como no protótipo). */
export function nomeDaPublicacao(p: Pick<InstagramMedia, 'kind' | 'published_at'>, agora: Date): string {
  return `${ehReels(p) ? 'Reels' : 'Post'} de ${dia(p.published_at, agora)}`;
}

/** O nome do cartão para quem usa leitor de tela: o que é, a música, os números que vieram e a posição. */
export function rotuloDoCartaoDoInstagram(p: InstagramMedia, posicao: number, agora: Date): string {
  const m = p.metrics;
  const numeros = (
    [
      [m.views, 'visualizações'],
      [m.likes, 'curtidas'],
      [m.comments, 'comentários'],
      [m.saved, 'salvamentos'],
    ] as const
  )
    .filter(([n]) => n !== null)
    .map(([n, nome]) => `${inteiro(n!)} ${nome}`);
  const musica = comMusicaDoInstagram(p) ? ', com música do Instagram' : '';
  return `${nomeDaPublicacao(p, agora)}${musica}: ${numeros.length ? numeros.join(', ') : 'ainda sem os números'}; ${posicao}º que mais rendeu`;
}

/** Os fatos da gaveta: a data e cada número, com o nome por extenso. */
export function fatosDaPublicacao(p: InstagramMedia, agora: Date): [string, string][] {
  const m = p.metrics;
  return [
    ['Publicado', diaHora(p.published_at, agora)],
    ['Visualizações', numeroDaGaveta(m.views)],
    ['Alcance', numeroDaGaveta(m.reach)],
    ['Curtidas', numeroDaGaveta(m.likes)],
    ['Comentários', numeroDaGaveta(m.comments)],
    ['Salvamentos', numeroDaGaveta(m.saved)],
    ['Compartilhamentos', numeroDaGaveta(m.shares)],
  ];
}

export const NOTA_DA_MUSICA = 'Este Reels usa música do Instagram: a Meta não entrega o arquivo do vídeo. Para usar o vídeo num post, envie o original em “Enviados por vocês”.';

/** A nota do alto da aba (P37), com a conta e a última leitura. */
export function notaDaLeitura(r: Pick<InstagramMediaResponse, 'account' | 'read_at'>, agora: Date): string {
  const conta = r.account ? `Lido da conta ${r.account.name}, conectada em Contas conectadas` : 'Lido da conta conectada em Contas conectadas';
  const quando = r.read_at ? ` (última leitura: ${quandoComHora(r.read_at, agora)})` : '';
  return `${conta}${quando}. O que mais rendeu primeiro, pelas visualizações. Nada aqui foi enviado para o Liame: é o que já está no Instagram. O Liame lê a conta uma vez por dia, e os números chegam com até 48 horas de atraso.`;
}

/** O que a aba diz em cada situação sem lista (ou com a lista e um aviso). */
export type EstadoDaAba = { titulo: string; texto: string; contas?: boolean; deNovo?: boolean; faixa?: 'atencao' | 'perigo' };

export function estadoDaAba(r: Pick<InstagramMediaResponse, 'situation' | 'account'>): EstadoDaAba | null {
  const conta = r.account?.name ?? 'a conta';
  switch (r.situation) {
    case 'desligada':
      return { titulo: '“Do seu Instagram” ainda não está ligado para esta empresa', texto: 'Ele vem com os vídeos nas Fotos. Quem liga é a Liame, a pedido do dono.' };
    case 'sem_conta':
      return { titulo: 'Nenhum Instagram ligado a esta marca', texto: 'Ligue o Instagram da marca em Contas conectadas: o Liame passa a ler o que a loja já publicou, uma vez por dia.', contas: true };
    case 'duas_contas':
      return { titulo: 'Há duas contas do Instagram ligadas a esta marca', texto: 'Deixe uma só ligada em Contas conectadas para ver o que a loja já publicou.', contas: true };
    case 'primeira_leitura':
      return { titulo: 'O Liame ainda está lendo o Instagram', texto: `A primeira leitura de ${conta} sai em poucos minutos. Depois, o Liame lê a conta uma vez por dia.`, deNovo: true };
    case 'sem_permissao':
      return {
        titulo: 'A autorização da Meta não deixa ler o Instagram',
        texto: 'Conecte a Meta de novo em Contas conectadas, com a permissão de ler o Instagram. O que já tinha sido lido continua aqui.',
        contas: true,
        faixa: 'atencao',
      };
    case 'falhou':
      return { titulo: 'Não deu para ler o Instagram agora', texto: 'O Liame tenta de novo sozinho em até 1 hora.', deNovo: true, faixa: 'perigo' };
    default:
      return null;
  }
}

/** Quantas publicações a grade mostra (o título escondido da grade e o anúncio do filtro). */
export function quantasNoInstagram(itens: Pick<InstagramMedia, 'kind'>[]): string {
  if (itens.length === 0) return 'Nenhuma publicação';
  return itens.length === 1 ? '1 publicação do Instagram' : `${inteiro(itens.length)} publicações do Instagram`;
}
