import { BRAND_PHOTO_LIMITS as L } from '@liame/contracts';

// A conferência da foto que a empresa envia (ADR-021, item 3; protótipo P20). Funções puras: o serviço, a rotina e os
// testes usam as mesmas. Os textos das recusas são os do P20 (a tela mostra "Não entrou: …" com o `detail`).

/** O tipo do arquivo pelo conteúdo (os primeiros bytes), nunca pela extensão nem pelo cabeçalho do pedido. */
export type TipoDoArquivo = 'jpeg' | 'png' | 'webp' | 'heic' | 'outro';

// As marcas da caixa `ftyp` de um arquivo HEIF (a foto do iPhone). O AVIF tem marca própria e cai em `outro`.
const MARCAS_HEIF = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

function texto(b: Uint8Array, de: number, ate: number): string {
  let s = '';
  for (let i = de; i < ate; i++) s += String.fromCharCode(b[i] ?? 0);
  return s;
}

export function tipoPeloConteudo(b: Uint8Array): TipoDoArquivo {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && texto(b, 0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (b.length >= 12 && texto(b, 0, 4) === 'RIFF' && texto(b, 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 12 && texto(b, 4, 8) === 'ftyp' && MARCAS_HEIF.has(texto(b, 8, 12))) return 'heic';
  return 'outro';
}

/** Por que a foto não entrou: o `code` vai no problema (422), e o `detail` é o texto da tela. */
export type MotivoDaRecusa = 'formato' | 'heic' | 'nao_abre' | 'pequena' | 'grande';

export const RECUSAS: Record<MotivoDaRecusa, { code: string; title: string; detail: string }> = {
  formato: { code: 'foto-formato', title: 'Formato não aceito', detail: 'Só JPEG, PNG ou WebP.' },
  heic: { code: 'foto-heic', title: 'Foto em HEIC', detail: 'Foto em HEIC. Envie em JPEG.' },
  nao_abre: { code: 'foto-nao-abre', title: 'O arquivo não abre', detail: 'O arquivo não abre como foto.' },
  pequena: { code: 'foto-pequena', title: 'Foto pequena demais', detail: `Tem menos de ${L.minShortSide} px no lado menor.` },
  grande: { code: 'foto-grande-demais', title: 'Foto grande demais', detail: 'Passa de 10.000 px no lado maior.' },
};

/** As medidas do arquivo enviado (já na orientação da câmera): recusa abaixo de 600 px no lado menor e acima de 10.000 no maior. */
export function conferirMedidas(largura: number, altura: number): MotivoDaRecusa | null {
  if (!Number.isInteger(largura) || !Number.isInteger(altura) || largura < 1 || altura < 1) return 'nao_abre';
  if (Math.min(largura, altura) < L.minShortSide) return 'pequena';
  if (Math.max(largura, altura) > L.maxLongSide) return 'grande';
  return null;
}

/** As medidas na orientação que a câmera gravou (EXIF 5 a 8 giram a foto em 90 graus). */
export function medidasOrientadas(m: { width?: number; height?: number; orientation?: number }): { largura: number; altura: number } {
  const largura = m.width ?? 0, altura = m.height ?? 0;
  return (m.orientation ?? 1) >= 5 ? { largura: altura, altura: largura } : { largura, altura };
}

export function orientacao(largura: number, altura: number): 'quadrada' | 'horizontal' | 'vertical' {
  if (largura === altura) return 'quadrada';
  return largura > altura ? 'horizontal' : 'vertical';
}

/** A largura da cópia fica abaixo da que o Instagram usa: lá, a foto pode sair sem nitidez (ERR-152: pela largura). */
export function estreitaParaOInstagram(largura: number): boolean {
  return largura < L.instagramWidth;
}

/** O Instagram aceita a foto de 4:5 (vertical) a 1,91:1 (horizontal); fora disso, ela precisa de um recorte. */
export function recorteDoInstagram(largura: number, altura: number): 'nenhum' | 'alta' | 'larga' {
  const r = largura / altura;
  if (r < 4 / 5 - 0.001) return 'alta';
  if (r > 1.91 + 0.001) return 'larga';
  return 'nenhum';
}

/** A chave do objeto no armazenamento (ADR-021, item 5): apagar a marca ou a empresa é apagar um prefixo. */
export function chaveDaFoto(tenantId: string, brandId: string, id: string): string {
  return `${prefixoDaMarca(tenantId, brandId)}foto_produto/${id}.jpg`;
}

export function chaveDaMiniatura(chave: string): string {
  return chave.endsWith('.jpg') ? `${chave.slice(0, -'.jpg'.length)}-mini.jpg` : `${chave}-mini`;
}

export function prefixoDaMarca(tenantId: string, brandId: string): string {
  return `${prefixoDaEmpresa(tenantId)}b/${brandId}/`;
}

export function prefixoDaEmpresa(tenantId: string): string {
  return `t/${tenantId}/`;
}
