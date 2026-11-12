import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { VideoRenderProps } from '@liame/contracts';
import { carregarSharp } from '../fotos/processar.js';
import { configDoMontador, MontadorRemotion, type VideoMontadoNoDisco } from '../video/montador.js';

// Fumaça do serviço de montagem (A6 · Z15; o job `imagem` do CI): dentro da imagem `liame-render`, monta de verdade os
// três modelos em 6 s: o "Produto em destaque" sobre uma imagem gerada aqui, o "Combo com preço" com três, e a "Novidade
// da casa" com o vídeo que o destaque acabou de montar (servido por um servidor local, como o endereço assinado do
// armazenamento). Confere o MP4, a capa e as medidas. Prova que o Chrome Headless Shell, as bibliotecas do Linux, as
// fontes, o vídeo de entrada e os modelos empacotados estão na imagem. Sem banco e sem rede de fora.

async function imagem(cor: string, forma: string): Promise<string> {
  const sharp = await carregarSharp();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080"><rect width="1080" height="1080" fill="${cor}"/>${forma}</svg>`;
  return `data:image/jpeg;base64,${(await sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer()).toString('base64')}`;
}

function servir(arquivo: string): Promise<{ url: string; servidor: Server }> {
  const servidor = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4' });
    createReadStream(arquivo).pipe(res);
  });
  return new Promise((resolve) => servidor.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(servidor.address() as AddressInfo).port}/video.mp4`, servidor })));
}

async function montar(nome: string, props: VideoRenderProps, pasta: string, medidas: { largura: number; altura: number }): Promise<VideoMontadoNoDisco> {
  const inicio = Date.now();
  let andou = 0;
  const pronto = await new MontadorRemotion(configDoMontador()).montar(props, pasta, (a) => {
    andou = a;
  });
  const bytes = (await stat(pronto.arquivo)).size;
  const ok = bytes > 10_000 && pronto.capa.length > 5_000 && pronto.largura === medidas.largura && pronto.altura === medidas.altura && pronto.duracaoMs === props.duration_s * 1000 && andou > 0.9;
  console.log(`fumaça do vídeo (${nome}): ${bytes} bytes, capa ${pronto.capa.length} bytes, ${pronto.largura}x${pronto.altura}, ${pronto.duracaoMs} ms, em ${((Date.now() - inicio) / 1000).toFixed(1)} s`);
  if (!ok) throw new Error(`o vídeo de fumaça (${nome}) não saiu como esperado`);
  return pronto;
}

async function principal(): Promise<void> {
  const base = { duration_s: 6 as const, logo_url: null, sound: 'sem' as const };
  const foto = await imagem('#5a2e14', '<ellipse cx="540" cy="430" rx="330" ry="170" fill="#e6a23c"/><rect x="200" y="580" width="680" height="90" rx="40" fill="#3d1f0d"/>');
  const pastas: string[] = [];
  const pasta = async () => {
    const p = await mkdtemp(join(tmpdir(), 'liame-fumaca-'));
    pastas.push(p);
    return p;
  };
  let servidor: Server | null = null;
  try {
    const destaque = await montar(
      'destaque',
      { ...base, template: 'destaque', format: '9x16', media: [{ url: foto, kind: 'foto' }], title: 'Smash duplo na chapa', price_line: 'R$ 39,90', cta: 'Peça pelo link da bio' },
      await pasta(),
      { largura: 1080, altura: 1920 },
    );
    const outras = [await imagem('#2b4a1d', '<rect x="380" y="300" width="320" height="480" rx="30" fill="#f2c94c"/>'), await imagem('#1d2b4a', '<rect x="420" y="260" width="240" height="560" rx="60" fill="#c0392b"/>')];
    await montar(
      'combo',
      { ...base, template: 'combo', format: '4x5', media: [foto, ...outras].map((url) => ({ url, kind: 'foto' as const })), title: 'Sexta é dia de combo', price_line: 'R$ 39,90', cta: 'Já escolheu o seu?' },
      await pasta(),
      { largura: 1080, altura: 1350 },
    );
    const servido = await servir(destaque.arquivo);
    servidor = servido.servidor;
    await montar(
      'novidade',
      { ...base, template: 'novidade', format: '1x1', media: [{ url: servido.url, kind: 'video' }], title: 'Smash duplo, direto da chapa', price_line: null, cta: 'Peça pelo link da bio' },
      await pasta(),
      { largura: 1080, altura: 1080 },
    );
  } finally {
    servidor?.close();
    await Promise.all(pastas.map((p) => rm(p, { recursive: true, force: true })));
  }
}

principal().catch((err: unknown) => {
  console.error('[fumaça do vídeo] falhou:', err);
  process.exitCode = 1;
});
