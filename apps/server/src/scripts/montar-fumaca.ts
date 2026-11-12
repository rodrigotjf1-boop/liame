import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { carregarSharp } from '../fotos/processar.js';
import { configDoMontador, MontadorRemotion } from '../video/montador.js';

// Fumaça do serviço de montagem (A6 · Z15 parte 2b; o job `imagem` do CI): dentro da imagem `liame-render`, monta de
// verdade um vídeo de 6 s do "Produto em destaque" sobre uma imagem gerada aqui e confere o MP4 e a capa. Prova que o
// Chrome Headless Shell, as bibliotecas do Linux, as fontes e o modelo empacotado estão na imagem. Sem banco e sem rede.

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><rect width="1080" height="1080" fill="#5a2e14"/>
<ellipse cx="540" cy="430" rx="330" ry="170" fill="#e6a23c"/><rect x="200" y="580" width="680" height="90" rx="40" fill="#3d1f0d"/></svg>`;

async function principal(): Promise<void> {
  const sharp = await carregarSharp();
  const foto = await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
  const pasta = await mkdtemp(join(tmpdir(), 'liame-fumaca-'));
  try {
    const inicio = Date.now();
    let andou = 0;
    const pronto = await new MontadorRemotion(configDoMontador()).montar(
      {
        template: 'destaque',
        format: '9x16',
        duration_s: 6,
        media: [{ url: `data:image/jpeg;base64,${foto.toString('base64')}`, kind: 'foto' }],
        title: 'Smash duplo na chapa',
        price_line: 'R$ 39,90',
        cta: 'Peça pelo link da bio',
        logo_url: null,
        sound: 'sem',
      },
      pasta,
      (a) => {
        andou = a;
      },
    );
    const bytes = (await stat(pronto.arquivo)).size;
    const ok = bytes > 10_000 && pronto.capa.length > 5_000 && pronto.largura === 1080 && pronto.altura === 1920 && pronto.duracaoMs === 6000 && andou > 0.9;
    console.log(`fumaça do vídeo: ${bytes} bytes, capa ${pronto.capa.length} bytes, ${pronto.largura}x${pronto.altura}, ${pronto.duracaoMs} ms, em ${((Date.now() - inicio) / 1000).toFixed(1)} s`);
    if (!ok) throw new Error('o vídeo de fumaça não saiu como esperado');
  } finally {
    await rm(pasta, { recursive: true, force: true });
  }
}

principal().catch((err: unknown) => {
  console.error('[fumaça do vídeo] falhou:', err);
  process.exitCode = 1;
});
