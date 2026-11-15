import type { BrandPhoto, VideoCut } from '@liame/contracts';

// "Os melhores momentos" na gaveta "Montar um vídeo" (A6 · Z16; P46): as contas e as frases dos cortes, sem React. A
// régua é a mesma do servidor (a tarefa `social_cortes`, D-A6-152): de 2 a 6 cortes, a legenda até 40 caracteres e o
// total entre 80% da duração e meio segundo acima; o servidor confere de novo ao gerar.

export const REGUA_DOS_CORTES = { minimo: 2, maximo: 6, legenda: 40, pisoDaDuracao: 0.8, folgaS: 0.5, videoMinimoS: 3 } as const;
/** As vezes que dá para pedir outros cortes ao Social media num mesmo vídeo (D-A6-151). */
export const OUTROS_PEDIDOS = 2;
/** Os quadros que vão ao Social media num pedido (o teto do gateway de IA), divididos entre os vídeos. */
export const QUADROS_POR_PEDIDO = 16;

/** Um corte na tela: o do contrato, com uma chave para a lista (a ordem muda). */
export type CorteNaTela = VideoCut & { chave: string };

export const comChave = (cortes: readonly VideoCut[], prefixo: string): CorteNaTela[] => cortes.map((c, i) => ({ ...c, chave: `${prefixo}-${i}` }));
export const semChave = (cortes: readonly CorteNaTela[]): VideoCut[] => cortes.map(({ chave: _, ...c }) => c);

/** A soma dos cortes, em milissegundos. */
export const totalMs = (cortes: readonly Pick<VideoCut, 'start_ms' | 'end_ms'>[]) => cortes.reduce((t, c) => t + Math.max(0, c.end_ms - c.start_ms), 0);
/** O menor total que a duração aceita (80%), em milissegundos. */
export const pisoMs = (duracaoS: number) => Math.round(duracaoS * REGUA_DOS_CORTES.pisoDaDuracao * 1000);

/** Segundos como a tela escreve: "8", "14,5". */
export function segundosTxt(ms: number): string {
  const s = Math.round(ms / 100) / 10;
  return s.toLocaleString('pt-BR', { maximumFractionDigits: 1 });
}

/** Um instante do vídeo como a tela escreve: "0:03", "0:12,5". */
export function tempoTxt(ms: number): string {
  const decimos = Math.round(ms / 100);
  const s = Math.floor(decimos / 10);
  const resto = decimos % 10;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${resto ? `,${resto}` : ''}`;
}

/** A linha do total (P46): fecha a duração, falta chegar aos 80%, passa da duração ou não há corte. */
export function situacaoDoTotal(cortes: readonly CorteNaTela[], duracaoS: number): { tipo: 'ok' | 'aviso' | 'perigo'; total: string; txt: string } {
  const t = totalMs(cortes);
  const total = `Total: ${segundosTxt(t)} de ${duracaoS} s`;
  if (!cortes.length) return { tipo: 'aviso', total, txt: 'nenhum corte' };
  if (t > (duracaoS + REGUA_DOS_CORTES.folgaS) * 1000) return { tipo: 'perigo', total, txt: `passa da duração em ${segundosTxt(t - duracaoS * 1000)} s` };
  const piso = pisoMs(duracaoS);
  if (t < piso) return { tipo: 'aviso', total, txt: `abaixo de 80%: faltam ${segundosTxt(piso - t)} s para chegar a ${segundosTxt(piso)} s` };
  return { tipo: 'ok', total, txt: 'fecha a duração' };
}

/** Sobe (-1) ou desce (+1) o corte `i`. */
export function mover<T>(lista: readonly T[], i: number, passo: -1 | 1): T[] {
  const j = i + passo;
  if (i < 0 || i >= lista.length || j < 0 || j >= lista.length) return [...lista];
  const nova = [...lista];
  [nova[i], nova[j]] = [nova[j]!, nova[i]!];
  return nova;
}

/** A conferência da tela antes de gerar (a do servidor é a que vale): o erro dos cortes e o de cada legenda, por chave. */
export function conferirNaTela(cortes: readonly CorteNaTela[], duracaoS: number, temProposta: boolean): { cortes?: string; legendas: Record<string, string> } {
  const legendas: Record<string, string> = {};
  if (!cortes.length) return { cortes: temProposta ? 'Nenhum corte: todos foram tirados. Peça outros cortes ao Social media.' : 'Peça os cortes ao Social media antes de gerar o vídeo.', legendas };
  for (const c of cortes) {
    const n = [...c.caption.trim()].length;
    if (!n) legendas[c.chave] = 'Escreva a legenda deste corte.';
    else if (n > REGUA_DOS_CORTES.legenda) legendas[c.chave] = `A legenda tem ${n} caracteres: o máximo é ${REGUA_DOS_CORTES.legenda}.`;
  }
  if (cortes.length < REGUA_DOS_CORTES.minimo) return { cortes: `O vídeo leva pelo menos ${REGUA_DOS_CORTES.minimo} cortes. Peça outros cortes ao Social media.`, legendas };
  const s = situacaoDoTotal(cortes, duracaoS);
  if (s.tipo !== 'ok') return { cortes: `${s.total}: ${s.txt}. Tire um corte, escolha outra duração ou peça outros cortes.`, legendas };
  return { legendas };
}

/** Os vídeos de Fotos que este modelo aceita: os da loja (nem foto, nem o vídeo montado pelo Liame). */
export const videosAceitos = (fotos: readonly BrandPhoto[]) => fotos.filter((f) => f.kind === 'video' && !f.montage_id);

/** O vídeo curto demais para cortes (menos de 3 s): a tela avisa ao escolher, e o servidor recusa o pedido. */
export const curtoDemais = (f: Pick<BrandPhoto, 'video'>) => (f.video?.duration_ms ?? 0) < REGUA_DOS_CORTES.videoMinimoS * 1000;

/** Quantos quadros o Social media vê, como o serviço de montagem divide (16 entre os vídeos). */
export function quadrosTxt(videos: number): string {
  if (videos < 1) return '';
  const cada = Math.floor(QUADROS_POR_PEDIDO / videos);
  return videos === 1 ? `${cada} quadros do vídeo` : `${cada * videos} quadros, ${cada} de cada vídeo`;
}

/** Quantas vezes ainda dá para pedir outros cortes. */
export function outrosTxt(restam: number): string {
  if (restam <= 0) return `Já pediu outros cortes ${OUTROS_PEDIDOS} vezes neste vídeo: tire, troque a ordem ou mude as legendas.`;
  return `Dá para pedir outros cortes mais ${restam === 1 ? '1 vez' : `${restam} vezes`} neste vídeo.`;
}

/** Por que a proposta dos cortes não veio (o código do pedido, `reason`, ou o do problema da rota). */
export function motivoDosCortesTxt(codigo: string | null | undefined): string {
  switch (codigo) {
    case 'funcao-desligada':
      return '"Os melhores momentos" não estão ligados para esta empresa.';
    case 'funcionario_desligado':
      return 'O Social media está desligado em Sua equipe. Ligue-o para pedir os cortes.';
    case 'ia_desligada':
    case 'desligada':
      return 'A IA está desligada para esta empresa.';
    case 'sem-rota':
      return 'O Social media ainda não escolhe os cortes. Por enquanto, este modelo espera.';
    case 'teto':
      return 'A IA chegou ao limite de gasto. Peça os cortes de novo mais tarde.';
    case 'limite-usuario':
      return 'Você chegou ao limite de pedidos à IA desta hora. Peça daqui a pouco.';
    case 'limite-do-dia':
      return 'A marca já pediu cortes 10 vezes hoje: o limite volta amanhã às 00:00.';
    case 'outros-acabaram':
      return outrosTxt(0);
    case 'video-curto':
      return 'Um dos vídeos tem menos de 3 segundos: tire-o para pedir os cortes.';
    case 'so-videos':
      return 'Este modelo leva só vídeos de Fotos: tire a foto para pedir os cortes.';
    case 'pedido-anterior-fora':
      return 'O pedido de antes não é desta marca. Peça os cortes de novo.';
    case 'sem_quadros':
      return 'Não deu para ler estes vídeos agora. Escolha outros vídeos, ou peça de novo.';
    case 'parado':
    case 'indisponivel':
    case 'parada':
    case 'travada':
      return 'O Social media não terminou de ver os vídeos. Peça os cortes de novo em instantes.';
    case 'compliance':
    case 'dado_pessoal':
      return 'A proposta do Social media não passou no Compliance. Peça outros cortes.';
    case 'quantidade':
    case 'video_fora':
    case 'tempo_fora':
    case 'corte_curto':
    case 'corte_longo':
    case 'repetido':
    case 'total_fora':
    case 'vazio':
    case 'longo':
    case 'emoji_ou_hashtag':
    case 'formato':
      return 'A proposta do Social media não passou na conferência dos cortes. Peça outros cortes.';
    default:
      return 'O Social media não propôs os cortes agora. Peça de novo em instantes.';
  }
}

/** Em que corte a prévia está no instante `t` (segundos) e se a legenda já entrou (0,15 s depois do começo, como o modelo). */
export function corteNoTempo(cortes: readonly Pick<VideoCut, 'start_ms' | 'end_ms'>[], t: number): { k: number; legenda: boolean; x: number } {
  const total = totalMs(cortes) / 1000;
  if (!cortes.length || total <= 0) return { k: -1, legenda: false, x: 0 };
  let desde = 0;
  for (const [k, c] of cortes.entries()) {
    const dura = (c.end_ms - c.start_ms) / 1000;
    if (t < desde + dura || k === cortes.length - 1) return { k, legenda: t - desde >= 0.15, x: Math.min(1, t / total) };
    desde += dura;
  }
  return { k: cortes.length - 1, legenda: true, x: 1 };
}
