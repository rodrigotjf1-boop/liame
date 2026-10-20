import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

// ERR-145: a folha dos gráficos de Resultados vale para o app inteiro (globals.css), e uma regra solta dela (".dias")
// desmontava a lista "Dia a dia" da pauta, em Aprovações, que usa o mesmo nome. Este teste junta as classes de topo da
// folha (a regra começa pela classe, sem um contêiner na frente) e procura cada uma nos componentes de fora de
// Resultados. Fora de Resultados, só podem aparecer as peças de gráfico que o Resumo e a Revisão da semana usam de
// propósito (a lista abaixo); um nome novo que apareça em outra tela é um choque, e a classe ganha um nome próprio.

const RAIZ = join(__dirname, '..');
const FOLHA = join(RAIZ, 'src', 'styles', 'resultados-graficos.css');
const COMPONENTES = join(RAIZ, 'src', 'components');

/** As peças de gráfico compartilhadas de propósito (Resumo e Revisão da semana em gráficos, aprovados em 07/10/2026). */
const COMPARTILHADAS = new Set(['cor-c1', 'cor-foco', 'desenho-b', 'eixo', 'eixo-legenda', 'legenda-b', 'nota-b', 'par', 'par-linha', 'par-valor', 'pilha', 'pilha--vazia', 'trilho']);

function classesDeTopo(css: string): Set<string> {
  const nomes = new Set<string>();
  for (const linha of css.split('\n')) {
    const l = linha.trim();
    if (!l.startsWith('.')) continue;
    for (const parte of l.split('{', 1)[0]!.split(',')) {
      const p = parte.trim();
      if (!p.startsWith('.')) continue;
      let nome = '';
      for (const ch of p.slice(1)) {
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '-' || ch === '_') nome += ch;
        else break;
      }
      if (nome) nomes.add(nome);
    }
  }
  return nomes;
}

function arquivos(pasta: string): string[] {
  return readdirSync(pasta).flatMap((nome) => {
    const caminho = join(pasta, nome);
    return statSync(caminho).isDirectory() ? arquivos(caminho) : caminho.endsWith('.tsx') ? [caminho] : [];
  });
}

/** Os nomes escritos em `className="..."` (e em `className={'...'}`), um por um. */
function classesUsadas(fonte: string): string[] {
  const nomes: string[] = [];
  const marca = 'className=';
  let i = fonte.indexOf(marca);
  while (i >= 0) {
    let j = i + marca.length;
    if (fonte[j] === '{') j += 1;
    const aspa = fonte[j];
    if (aspa === '"' || aspa === "'" || aspa === '`') {
      const fim = fonte.indexOf(aspa, j + 1);
      if (fim > j) nomes.push(...fonte.slice(j + 1, fim).split(/\s+/).filter(Boolean));
    }
    i = fonte.indexOf(marca, i + marca.length);
  }
  return nomes;
}

describe('a folha dos gráficos não desmonta outras telas (ERR-145)', () => {
  const topo = classesDeTopo(readFileSync(FOLHA, 'utf8'));

  it('nenhuma classe solta dela aparece fora de Resultados, além das peças compartilhadas', () => {
    const choques: string[] = [];
    for (const arq of arquivos(COMPONENTES)) {
      const rel = relative(COMPONENTES, arq).split(sep).join('/');
      if (rel.startsWith('resultados/')) continue;
      for (const nome of classesUsadas(readFileSync(arq, 'utf8'))) {
        if (topo.has(nome) && !COMPARTILHADAS.has(nome)) choques.push(`${nome} em ${rel}`);
      }
    }
    expect(choques).toEqual([]);
  });

  it('a régua dos dias do gráfico tem nome próprio, e a lista "Dia a dia" da pauta não é mais tocada', () => {
    expect(topo.has('faisca-dias')).toBe(true);
    expect(topo.has('dias')).toBe(false);
  });
});
