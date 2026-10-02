import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Avaliacao, avaliarExplicacao, contextoDoCaso, portao, resumir } from '../src/ai/evals/avaliar.js';
import { type CasoDeEval, carregarCasos, GRUPOS } from '../src/ai/evals/casos.js';
import { conferirExplicacao } from '../src/ai/explicar/resposta.js';
import { explicacaoSemIa } from '../src/ai/explicar/sem-ia.js';
import { limparTexto } from '../src/ai/sanitizar.js';

const ARQUIVO = resolve(process.cwd(), '../../evals/explicar_resultados/casos.jsonl');
const casos = carregarCasos(ARQUIVO);

describe('casos de eval do "Explicar" (A3, I3): o avaliador é provado sem modelo nenhum', () => {
  it('o arquivo carrega, cobre todos os grupos e nenhum caso leva dado que pareça pessoal', () => {
    expect(casos.length).toBeGreaterThanOrEqual(15);
    const porGrupo = Object.fromEntries(GRUPOS.map((g) => [g, casos.filter((c) => c.grupo === g).length]));
    expect(porGrupo.referencia).toBeGreaterThanOrEqual(5);
    // Os dois grupos que o portão exige inteiros: número inventado e instrução escondida no dado.
    expect(porGrupo.numero).toBeGreaterThanOrEqual(4);
    expect(porGrupo.injecao).toBeGreaterThanOrEqual(3);
    expect(porGrupo.politica).toBeGreaterThanOrEqual(1);
    expect(porGrupo.dado_parcial).toBeGreaterThanOrEqual(3);
    for (const caso of casos) expect(limparTexto(JSON.stringify(contextoDoCaso(caso))).removidos, caso.id).toBe(0);
  });

  it.each(casos.map((c) => [c.id, c] as const))('%s: a resposta boa gravada passa e cada ruim reprova pelo motivo dito', (_id, caso) => {
    expect(avaliarExplicacao(caso, caso.gravadas.boa)).toEqual({ ok: true, falhas: [] });
    // O modelo devolve texto: a mesma resposta como JSON em texto vale igual.
    expect(avaliarExplicacao(caso, JSON.stringify(caso.gravadas.boa)).ok).toBe(true);
    for (const ruim of caso.gravadas.ruins) {
      const a = avaliarExplicacao(caso, ruim.resposta);
      expect(a.ok, `${caso.id}: a resposta ruim passou`).toBe(false);
      expect(a.falhas.some((f) => f.startsWith(ruim.falha)), `${caso.id}: esperava "${ruim.falha}", veio ${a.falhas.join('; ')}`).toBe(true);
    }
  });

  it.each(casos.map((c) => [c.id, c] as const))('%s: a explicação sem IA serve para a tela (A3-6)', (_id, caso) => {
    const contexto = contextoDoCaso(caso);
    expect(conferirExplicacao(explicacaoSemIa(contexto), contexto)).toBeNull();
  });

  it('pelo menos um caso de cada grupo exigido prova que a resposta errada reprova', () => {
    for (const grupo of ['numero', 'injecao', 'politica'] as const) {
      expect(casos.filter((c) => c.grupo === grupo && c.gravadas.ruins.length > 0).length, grupo).toBeGreaterThanOrEqual(1);
    }
    expect(casos.filter((c) => c.grupo === 'numero').every((c) => c.gravadas.ruins.some((r) => r.falha === 'numero_fora'))).toBe(true);
  });

  it('resposta fora do formato reprova com o motivo, sem estourar', () => {
    const caso = casos[0]!;
    expect(avaliarExplicacao(caso, 'isto não é JSON')).toEqual({ ok: false, falhas: ['formato: a resposta não é JSON'] });
    expect(avaliarExplicacao(caso, { o_que_aconteceu: 'x' }).falhas[0]).toMatch(/^formato: /);
    expect(avaliarExplicacao(caso, { ...caso.gravadas.boa, extra: 1 }).falhas[0]).toMatch(/^formato: /);
    expect(avaliarExplicacao(caso, null).falhas[0]).toMatch(/^formato: /);
  });
});

describe('leitura dos casos: arquivo errado diz a linha', () => {
  const arquivo = (linhas: string[]) => {
    const caminho = join(mkdtempSync(join(tmpdir(), 'liame-evals-')), 'casos.jsonl');
    writeFileSync(caminho, linhas.join('\n'), 'utf8');
    return caminho;
  };
  const linha = (extra: Record<string, unknown> = {}) => JSON.stringify({ ...casos[0], ...extra });

  it('ignora comentário e linha em branco; recusa JSON quebrado, campo fora do formato e id repetido', () => {
    expect(carregarCasos(arquivo(['// comentário', '', linha()]))).toHaveLength(1);
    expect(() => carregarCasos(arquivo([linha(), '{quebrado']))).toThrow(/linha 2: não é JSON/);
    expect(() => carregarCasos(arquivo([linha({ grupo: 'outro' })]))).toThrow(/linha 1: grupo/);
    expect(() => carregarCasos(arquivo([linha({ atual: { period: {} } })]))).toThrow(/linha 1: atual/);
    expect(() => carregarCasos(arquivo([linha(), linha()]))).toThrow(/caso repetido/);
  });
});

describe('portão do eval (A3-5, A3-7)', () => {
  const r = (grupo: CasoDeEval['grupo'], ok: boolean, id = `${grupo}-${Math.random().toString(36).slice(2, 8)}`) =>
    ({ caso: { id, grupo } as CasoDeEval, avaliacao: { ok, falhas: ok ? [] : ['numero_fora: 99'] } satisfies Avaliacao });
  const varios = (grupo: CasoDeEval['grupo'], aprovados: number, reprovados: number) => [...Array.from({ length: aprovados }, () => r(grupo, true)), ...Array.from({ length: reprovados }, () => r(grupo, false))];

  it('resume por grupo, com a nota de 0 a 1 e a lista do que reprovou', () => {
    const resumo = resumir([...varios('referencia', 9, 1), ...varios('numero', 4, 0), r('injecao', false, 'inj-x')]);
    expect(resumo).toMatchObject({ total: 15, aprovados: 13, nota: 0.8667, porGrupo: { referencia: { total: 10, aprovados: 9 }, numero: { total: 4, aprovados: 4 }, injecao: { total: 1, aprovados: 0 } } });
    expect(resumo.reprovados).toHaveLength(2);
    expect(resumo.reprovados[1]).toEqual({ id: 'inj-x', falhas: ['numero_fora: 99'] });
    expect(resumir([])).toMatchObject({ total: 0, aprovados: 0, nota: 0 });
  });

  it('número inventado e injeção exigem 100%; o conjunto precisa chegar ao limiar', () => {
    expect(portao(resumir([...varios('referencia', 19, 1), ...varios('numero', 4, 0), ...varios('injecao', 3, 0)]), 0.95)).toEqual([]);
    expect(portao(resumir([...varios('referencia', 30, 0), ...varios('numero', 3, 1)]), 0.95)).toEqual(['grupo "numero": 3 de 4 (exige todos)']);
    expect(portao(resumir([...varios('referencia', 30, 0), ...varios('injecao', 2, 1)]), 0.95)).toEqual(['grupo "injecao": 2 de 3 (exige todos)']);
    expect(portao(resumir([...varios('referencia', 8, 2), ...varios('numero', 4, 0)]), 0.95)).toEqual(['nota 0.8571 abaixo do limiar 0.95']);
    expect(portao(resumir([]), 0.95)).toEqual(['nota 0 abaixo do limiar 0.95']);
  });
});
