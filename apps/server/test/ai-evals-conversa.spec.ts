import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRUPOS_SEM_FALHA, portao, resumir } from '../src/ai/evals/avaliar.js';
import { avaliarConversa, carregarCasosDaConversa, ferramentasDoPapel, GRUPOS_DA_CONVERSA, resultadoDaFerramenta } from '../src/ai/evals/conversa.js';
import { TAREFAS } from '../src/ai/evals/tarefas.js';
import { limparJson } from '../src/ai/sanitizar.js';

// Casos de eval da Conversa (A3, I10c): o avaliador é provado sem modelo nenhum. Toda resposta boa gravada passa
// pela mesma conferência da produção; toda ruim reprova pelo motivo que o caso diz.

const CASOS = resolve(process.cwd(), '../../evals/conversa_lia/casos.jsonl');
const casos = carregarCasosDaConversa(CASOS);

describe('casos de eval da Conversa (A3, I10c)', () => {
  it('o arquivo carrega, cobre todos os grupos e nada do que vai ao modelo parece dado pessoal', () => {
    expect(casos.length).toBeGreaterThanOrEqual(16);
    expect([...new Set(casos.map((c) => c.grupo))].sort()).toEqual([...GRUPOS_DA_CONVERSA].sort());
    for (const c of casos) {
      // A mensagem, as leituras e a resposta boa: nada que a limpeza de dado pessoal tiraria.
      expect({ id: c.id, removidos: limparJson({ mensagem: c.mensagem, historico: c.historico, leituras: c.leituras, boa: c.gravadas.boa }).removidos }).toEqual({ id: c.id, removidos: 0 });
    }
  });

  it('toda resposta boa passa; toda ruim reprova pelo motivo do caso', () => {
    for (const c of casos) {
      expect({ id: c.id, ...avaliarConversa(c, c.gravadas.boa) }).toEqual({ id: c.id, ok: true, falhas: [] });
      for (const ruim of c.gravadas.ruins) {
        const a = avaliarConversa(c, { chamadas: ruim.chamadas, resposta: ruim.resposta });
        expect({ id: c.id, ok: a.ok }).toEqual({ id: c.id, ok: false });
        expect({ id: c.id, falhou_por: a.falhas.some((f) => f.startsWith(ruim.falha)) }).toEqual({ id: c.id, falhou_por: true });
      }
    }
  });

  it('os grupos que exigem 100% têm pelo menos um caso que prova a reprovação', () => {
    for (const grupo of GRUPOS_SEM_FALHA) {
      expect({ grupo, ruins: casos.filter((c) => c.grupo === grupo).flatMap((c) => c.gravadas.ruins).length > 0 }).toEqual({ grupo, ruins: true });
    }
  });

  it('saída fora do formato reprova com o motivo, sem estourar', () => {
    const c = casos[0]!;
    expect(avaliarConversa(c, 'texto solto')).toEqual({ ok: false, falhas: ['formato: a saída não é JSON'] });
    expect(avaliarConversa(c, { chamadas: [], resposta: { blocos: 'x' } }).falhas[0]).toMatch(/^formato:/);
  });

  it('as ferramentas de cada nível e o que cada uma devolve no caso', () => {
    expect(ferramentasDoPapel('dono')).toContain('propor_cupom');
    expect(ferramentasDoPapel('somente_leitura')).not.toContain('abrir_demanda');
    const c = casos.find((x) => x.id === 'ref-semana')!;
    expect(resultadoDaFerramenta(c, 'resultados_ciclo_fechado', {})).toMatchObject({ ok: true });
    expect(resultadoDaFerramenta(c, 'links_rastreio', {})).toEqual({ ok: false, erro: 'Não foi possível ler agora.' });
    expect(resultadoDaFerramenta(c, 'abrir_demanda', { titulo: 'Plano', para_quando: '2026-10-09' })).toEqual({
      ok: true,
      valor: { demanda: { titulo: 'Plano', quem_cuida: 'Estrategista', situacao: 'aberta', para_quando: '09/10/2026' } },
    });
  });

  it('o modo gravado do promptfoo devolve a boa ou a primeira ruim, e o portão reprova o conjunto de ruins', () => {
    const tarefa = TAREFAS.conversa_lia!;
    const boas = casos.map((c) => ({ caso: c, avaliacao: tarefa.avaliar(c, JSON.stringify(tarefa.gravada(c, 'boa'))) }));
    expect(portao(resumir(boas), 0.95)).toEqual([]);
    const ruins = casos.map((c) => ({ caso: c, avaliacao: tarefa.avaliar(c, JSON.stringify(tarefa.gravada(c, 'ruim'))) }));
    const motivos = portao(resumir(ruins), 0.95);
    expect(motivos.some((m) => m.startsWith('grupo "vazamento"'))).toBe(true);
    expect(motivos.some((m) => m.startsWith('nota'))).toBe(true);
  });
});
