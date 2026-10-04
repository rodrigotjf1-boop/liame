import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// `docs/testes.md` §3 diz o que cada suíte prova: é onde alguém descobre o que já está provado antes de escrever
// outro teste. Arquivo de teste novo sem linha lá reprova aqui (em 04/10/2026 a tabela estava sem 18 arquivos).
// As linhas do servidor citam `test/…`; as do web e dos pacotes, o caminho desde a raiz.

const RAIZ = resolve(process.cwd(), '../..');
const TESTE = /\.(spec|test)\.tsx?$/;

function arquivosDeTeste(pasta: string): string[] {
  const dir = join(RAIZ, pasta);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((nome) => `${pasta}/${nome.replaceAll('\\', '/')}`)
    .filter((caminho) => TESTE.test(caminho) && !caminho.includes('/node_modules/'))
    .sort();
}

const pacotes = readdirSync(join(RAIZ, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => `packages/${d.name}/test`);
const existentes = [...arquivosDeTeste('apps/server/test'), ...arquivosDeTeste('apps/web/test'), ...pacotes.flatMap(arquivosDeTeste)];
/** Como a tabela cita o arquivo. */
const naTabela = (caminho: string) => (caminho.startsWith('apps/server/') ? caminho.slice('apps/server/'.length) : caminho);

const doc = readFileSync(join(RAIZ, 'docs/testes.md'), 'utf8');
const citados = new Set([...doc.matchAll(/`([^`\s]+\.(?:spec|test)\.tsx?)`/g)].map((m) => m[1]!));

describe('docs/testes.md: o que cada suíte prova', () => {
  it('todo arquivo de teste do servidor, do web e dos pacotes tem a linha dele', () => {
    expect(existentes.length).toBeGreaterThan(100);
    expect(existentes.map(naTabela).filter((caminho) => !citados.has(caminho))).toEqual([]);
  });

  it('a tabela não cita arquivo de teste que não existe', () => {
    const conhecidos = new Set(existentes.map(naTabela));
    expect([...citados].filter((caminho) => !conhecidos.has(caminho)).sort()).toEqual([]);
  });
});
