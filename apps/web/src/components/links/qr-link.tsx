import { encode } from 'uqr';

// QR do link com rastreio (o mesmo `tracking_url`, então o pedido feito pelo QR conta para a campanha):
// correção M e margem de 4 módulos, como o do servidor (F5). Desenhado a partir da matriz, sem innerHTML;
// o PNG e o SVG saem daqui, no navegador.

const FUNDO = '#FFFFFF';
const TINTA = '#0B0D17';

function matriz(texto: string) {
  const { data, size } = encode(texto, { ecc: 'M', border: 4 });
  let caminho = '';
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (data[y]?.[x]) caminho += `M${x} ${y}h1v1h-1z`;
  return { data, size, caminho };
}

export function QrLink({ texto, rotulo }: { texto: string; rotulo: string }) {
  const { size, caminho } = matriz(texto);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={rotulo} shapeRendering="crispEdges">
      <rect width={size} height={size} fill={FUNDO} />
      <path d={caminho} fill={TINTA} />
    </svg>
  );
}

/** O QR em SVG, para baixar (só números e as duas cores: nada do texto entra no desenho). */
export function svgDoQr(texto: string): string {
  const { size, caminho } = matriz(texto);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 10}" height="${size * 10}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="${FUNDO}"/><path d="${caminho}" fill="${TINTA}"/></svg>`;
}

/** O QR em PNG (cada módulo com `escala` pixels), desenhado num canvas. */
export function pngDoQr(texto: string, escala = 12): Promise<Blob> {
  const { data, size } = matriz(texto);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * escala;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('canvas indisponível'));
  ctx.fillStyle = FUNDO;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = TINTA;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (data[y]?.[x]) ctx.fillRect(x * escala, y * escala, escala, escala);
  return new Promise((ok, falha) => canvas.toBlob((b) => (b ? ok(b) : falha(new Error('PNG não gerado'))), 'image/png'));
}

/** Baixa o arquivo pelo navegador. */
export function baixar(conteudo: Blob, nome: string) {
  const url = URL.createObjectURL(conteudo);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
