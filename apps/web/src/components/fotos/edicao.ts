import type { BrandPhoto, FotoEdicaoOpcoes } from '@liame/contracts';

// A foto editada pelo DMS Graph (F4): o que mudou, em palavras, para a gaveta e para quem aprova o post.

const NOME_DO_QUADRO: Record<FotoEdicaoOpcoes['framing'], string> = { original: 'como está', '1:1': '1:1', '9:16': '9:16', '16:9': '16:9' };

export const ENQUADRAMENTOS: readonly { valor: FotoEdicaoOpcoes['framing']; rotulo: string }[] = [
  { valor: 'original', rotulo: 'Como está' },
  { valor: '1:1', rotulo: 'Quadrada 1:1' },
  { valor: '9:16', rotulo: 'Story 9:16' },
  { valor: '16:9', rotulo: 'Deitada 16:9' },
];

export function oQueMudou(o: FotoEdicaoOpcoes): string {
  const partes = [o.light ? 'luz' : null, o.background ? 'fundo' : null, o.framing !== 'original' ? `enquadramento ${NOME_DO_QUADRO[o.framing]}` : null].filter(
    (p): p is string => p !== null,
  );
  if (!partes.length) return 'só o pedido escrito';
  return partes.length === 1 ? partes[0]! : `${partes.slice(0, -1).join(', ')} e ${partes[partes.length - 1]}`;
}

/** A frase para quem aprova: quem editou, o que mudou e o pedido escrito. */
export function resumoDaEdicao(foto: BrandPhoto): string | null {
  const e = foto.edited;
  if (!e) return null;
  const dia = new Date(e.at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
  const quem = e.by ? ` por ${e.by}` : '';
  const pedido = e.prompt ? ` Pedido: “${e.prompt}”.` : '';
  return `Foto editada com IA${quem} em ${dia}: ${oQueMudou(e.options)}.${pedido} Quem editou conferiu que o produto continua igual.`;
}
