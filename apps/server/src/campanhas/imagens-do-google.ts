import type SharpDoPacote from 'sharp';
import { carregarSharp } from '../fotos/processar.js';
import { areasDosRecortes, type ImagensDoGoogle, LADO_DA_LOGO_NO_GOOGLE, motivoDaFotoPequena } from './campanha-google-plano.js';

// As imagens da campanha nova no Google (A5, Y9, parte 3; D-A5-23): os recortes da foto de Fotos, pelo centro, nas
// proporções da Performance Max (deitada 1,91:1 e quadrada obrigatórias; em pé 4:5 quando cabe), no tamanho recomendado
// quando a foto é maior; e a logo de Minha marca num quadrado branco, inteira (o Google pede a logo 1:1; cortar a logo
// cortaria o nome da loja). Tudo em JPEG. As medidas valem as da própria imagem, não as guardadas na linha.

type Sharp = typeof SharpDoPacote;

/** A foto não serve para os recortes obrigatórios (a guardada mudou, ou a linha mentia): o motivo vai para a pessoa. */
export class FotoNaoServe extends Error {}

export async function imagensDoGoogle(foto: Buffer, logo: Buffer, carregar: () => Promise<Sharp> = carregarSharp): Promise<ImagensDoGoogle> {
  const sharp = await carregar();
  const meta = await sharp(foto, { failOn: 'error' }).metadata();
  const largura = meta.width ?? 0;
  const altura = meta.height ?? 0;
  const motivo = motivoDaFotoPequena(largura, altura);
  if (motivo) throw new FotoNaoServe(motivo);
  const recortes: ImagensDoGoogle['recortes'] = [];
  for (const a of areasDosRecortes(largura, altura)) {
    const bytes = await sharp(foto, { failOn: 'error' })
      .extract({ left: a.left, top: a.top, width: a.width, height: a.height })
      .resize({ width: a.saida.largura, height: a.saida.altura, fit: 'cover' })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer();
    recortes.push({ id: a.id, tipo: a.tipo, base64: bytes.toString('base64') });
  }

  const daLogo = await sharp(logo, { failOn: 'error' }).metadata();
  const lado = Math.min(LADO_DA_LOGO_NO_GOOGLE, Math.max(daLogo.width ?? 0, daLogo.height ?? 0));
  const quadrada = await sharp(logo, { failOn: 'error' })
    .resize({ width: lado, height: lado, fit: 'contain', background: '#ffffff' })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  return { recortes, logo: quadrada.toString('base64') };
}
