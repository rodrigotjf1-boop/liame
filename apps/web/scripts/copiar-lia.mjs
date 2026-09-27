// Monta public/lia/ antes do build e do dev: o kit da LIA 3D (fonte única em lia-agente-3d/, na raiz)
// e o three.js r147 do catálogo. O app serve tudo da própria origem: sem CDN (ux-modelo-interface §6.1,
// V26) e sem cópia do kit no git (public/lia/ fica no .gitignore).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = resolve(WEB, '../../lia-agente-3d');
const DESTINO = join(WEB, 'public/lia');
const require = createRequire(join(WEB, 'package.json'));
// O pacote não exporta o package.json: a raiz sai da entrada principal (build/three.cjs).
const THREE = resolve(dirname(require.resolve('three')), '..');

const versao = JSON.parse(readFileSync(join(THREE, 'package.json'), 'utf8')).version;
if (versao !== '0.147.0') throw new Error(`copiar-lia: o kit da LIA exige o three.js 0.147.0 (encontrado ${versao})`);

const arquivos = [
  [join(THREE, 'build/three.min.js'), 'three.min.js'],
  [join(THREE, 'examples/js/environments/RoomEnvironment.js'), 'RoomEnvironment.js'],
  [join(KIT, 'lia-agent.js'), 'lia-agent.js'],
  [join(KIT, 'lia-avatar.svg'), 'lia-avatar.svg'],
];

mkdirSync(DESTINO, { recursive: true });
for (const [origem, nome] of arquivos) {
  if (!existsSync(origem)) throw new Error(`copiar-lia: não achei ${origem}`);
  copyFileSync(origem, join(DESTINO, nome));
}
console.log(`copiar-lia: ${arquivos.length} arquivos em public/lia (three ${versao})`);
