// O build dos modelos do vídeo montado: empacota `src/index.ts` (e as fontes de `public/`) em `build/`, a pasta que o
// serviço `liame-render` abre no Chrome do Remotion (D-A6-139). Empacotar uma vez no build, e não a cada vídeo, deixa o
// serviço leve (o bundler fica só no build).
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';

const raiz = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const saida = resolve(raiz, 'build');
await rm(saida, { recursive: true, force: true });
const pronto = await bundle({
  entryPoint: resolve(raiz, 'src/index.ts'),
  outDir: saida,
  publicDir: resolve(raiz, 'public'),
  onProgress: () => {},
});
console.log(`modelos do vídeo empacotados em ${pronto}`);
