import { cancelRender, continueRender, delayRender, staticFile } from 'remotion';

// As fontes do app (Poppins nos textos e JetBrains Mono no preço), guardadas no pacote (`public/fontes`, licença OFL ao
// lado): o render não busca nada na rede além das fotos. O quadro só é capturado depois de as três carregarem; se uma
// falhar, o render para com o erro (o vídeo não sai com a fonte errada).

const FONTES = [
  { familia: 'Poppins', peso: '600', arquivo: 'fontes/poppins-600.woff2' },
  { familia: 'Poppins', peso: '700', arquivo: 'fontes/poppins-700.woff2' },
  { familia: 'JetBrains Mono', peso: '700', arquivo: 'fontes/jetbrains-mono-700.woff2' },
] as const;

let pedidas = false;

export function carregarFontes(): void {
  if (pedidas || typeof document === 'undefined') return;
  pedidas = true;
  const espera = delayRender('As fontes do vídeo montado');
  Promise.all(
    FONTES.map(async (f) => {
      const face = new FontFace(f.familia, `url('${staticFile(f.arquivo)}') format('woff2')`, { weight: f.peso });
      await face.load();
      document.fonts.add(face);
    }),
  ).then(
    () => continueRender(espera),
    (err: unknown) => cancelRender(err instanceof Error ? err : new Error(String(err))),
  );
}
