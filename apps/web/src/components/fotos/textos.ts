import { BRAND_PHOTO_LIMITS as L, type BrandPhoto } from '@liame/contracts';
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
export type Recusa = 'formato' | 'heic' | 'tamanho' | 'nao_abre' | 'pequena' | 'grande' | 'repetida' | 'desligada';

export const RECUSA: Record<Recusa, string> = {
  formato: 'Não entrou: só JPEG, PNG ou WebP.',
  heic: 'Não entrou: foto em HEIC. Envie em JPEG.',
  tamanho: `Não entrou: passa de ${L.maxBytes / (1024 * 1024)} MB.`,
  nao_abre: 'Não entrou: o arquivo não abre como foto.',
  pequena: `Não entrou: tem menos de ${inteiro(L.minShortSide)} px no lado menor.`,
  grande: `Não entrou: passa de ${inteiro(L.maxLongSide)} px no lado maior.`,
  repetida: 'Não entrou: essa foto já está aqui.',
  desligada: 'Não entrou: as fotos não estão mais ligadas para esta empresa.',
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

/** O título da lista do envio, enquanto envia e no fim. */
export function tituloDoEnvio(fases: Fase[]): string {
  const n = fases.length;
  if (!fases.every(terminou)) return `Enviando ${n} ${n === 1 ? 'foto' : 'fotos'}`;
  const e = fases.filter(entrou).length;
  if (e === n) return n === 1 ? 'A foto entrou' : `As ${n} fotos entraram`;
  if (e === 0) return n === 1 ? 'A foto não entrou' : `Nenhuma das ${n} fotos entrou`;
  return `${e} de ${n} fotos ${e === 1 ? 'entrou' : 'entraram'}`;
}

/** O que se anuncia no fim do envio (leitor de tela). */
export function resumoDoEnvio(fases: Fase[]): string {
  const e = fases.filter(entrou).length;
  const f = fases.length - e;
  return `${e} ${e === 1 ? 'foto entrou' : 'fotos entraram'}${f ? `; ${f} não ${f === 1 ? 'entrou' : 'entraram'}` : ''}.`;
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
