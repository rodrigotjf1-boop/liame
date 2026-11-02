import { AGENCY_LOGO_LIMITS as L } from '@liame/contracts';
import type SharpDoPacote from 'sharp';
import type { Metadata, OutputInfo } from 'sharp';
import { medidasOrientadas, tipoPeloConteudo } from '../fotos/conferencia.js';
import { carregarSharp } from '../fotos/processar.js';

// O logo da agência (A7, W7, parte 3; D-A7-69): PNG ou JPG, até 1 MB; SVG não, porque pode levar código. O tipo é lido
// do conteúdo; o servidor regrava o logo em JPEG, sobre fundo branco (a placa clara onde ele aparece, nos dois temas e
// no e-mail), cabendo em 384 × 96 px e sem os metadados. Mesmo caminho das Fotos (ADR-021, item 3).

type Sharp = typeof SharpDoPacote;

/** Por que o logo não entrou: o `code` vai no problema (422), e o `detail` é o texto da tela. */
export type MotivoDoLogo = 'formato' | 'nao_abre' | 'pequeno' | 'grande';

export const RECUSAS_DO_LOGO: Record<MotivoDoLogo, { code: string; title: string; detail: string }> = {
  formato: { code: 'logo-formato', title: 'Formato não aceito', detail: 'Só PNG ou JPG. SVG não: ele pode levar código.' },
  nao_abre: { code: 'logo-nao-abre', title: 'O arquivo não abre', detail: 'O arquivo não abre como imagem.' },
  pequeno: { code: 'logo-pequeno', title: 'Logo pequeno demais', detail: `Tem menos de ${L.minShortSide} px no lado menor.` },
  grande: { code: 'logo-grande-demais', title: 'Logo grande demais', detail: `Passa de ${L.maxLongSide.toLocaleString('pt-BR')} px no lado maior.` },
};

export class RecusaDoLogo extends Error {
  constructor(readonly motivo: MotivoDoLogo) {
    super(`logo recusado: ${motivo}`);
  }
}

export interface LogoProcessado {
  bytes: Buffer;
  largura: number;
  altura: number;
}

/** As medidas do arquivo enviado: recusa abaixo de 32 px no lado menor e acima de 4.000 no maior. */
export function conferirMedidasDoLogo(largura: number, altura: number): MotivoDoLogo | null {
  if (!Number.isInteger(largura) || !Number.isInteger(altura) || largura < 1 || altura < 1) return 'nao_abre';
  if (Math.min(largura, altura) < L.minShortSide) return 'pequeno';
  if (Math.max(largura, altura) > L.maxLongSide) return 'grande';
  return null;
}

/** Confere e regrava o logo. Recusa com `RecusaDoLogo` (422); sem o sharp, `SemSharp` (503). */
export async function processarLogo(entrada: Buffer, carregar: () => Promise<Sharp> = carregarSharp): Promise<LogoProcessado> {
  const tipo = tipoPeloConteudo(entrada);
  if (tipo !== 'png' && tipo !== 'jpeg') throw new RecusaDoLogo('formato');
  const sharp = await carregar();
  const abrir = () => sharp(entrada, { failOn: 'error', limitInputPixels: L.maxLongSide * L.maxLongSide });
  let meta: Metadata;
  try {
    meta = await abrir().metadata();
  } catch {
    throw new RecusaDoLogo('nao_abre');
  }
  // O formato que a biblioteca leu tem de ser o mesmo dos primeiros bytes (um PNG com cara de JPEG não passa).
  if (meta.format !== tipo) throw new RecusaDoLogo('nao_abre');
  const { largura, altura } = medidasOrientadas(meta);
  const motivo = conferirMedidasDoLogo(largura, altura);
  if (motivo) throw new RecusaDoLogo(motivo);
  let copia: { data: Buffer; info: OutputInfo };
  try {
    copia = await abrir()
      .rotate()
      .resize({ width: L.storedMaxWidth, height: L.storedMaxHeight, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 90, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new RecusaDoLogo('nao_abre');
  }
  return { bytes: copia.data, largura: copia.info.width, altura: copia.info.height };
}

/** A chave do logo no armazenamento de imagens (`logo_id` muda a cada logo novo). */
export function chaveDoLogo(agenciaId: string, logoId: string): string {
  return `t/${agenciaId}/agencia/logo/${logoId}.jpg`;
}
