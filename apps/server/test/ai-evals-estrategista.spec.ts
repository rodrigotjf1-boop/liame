import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRUPOS_SEM_FALHA, portao, resumir } from '../src/ai/evals/avaliar.js';
import { avaliarPlano, carregarCasosDoPlano, dadosDoCaso, GRUPOS_DO_PLANO, leituraDoCaso } from '../src/ai/evals/plano.js';
import { TAREFAS } from '../src/ai/evals/tarefas.js';
import { contextoDoPlano } from '../src/ai/estrategista/contexto.js';
import { limparJson } from '../src/ai/sanitizar.js';

// Casos de eval do Estrategista (A3, I11c): o avaliador é provado sem modelo nenhum. Toda resposta boa gravada passa
// pela mesma conferência da produção; toda ruim reprova pelo motivo que o caso diz.

const CASOS = resolve(process.cwd(), '../../evals/estrategista_plano/casos.jsonl');
const casos = carregarCasosDoPlano(CASOS);

describe('casos de eval do Estrategista (A3, I11c)', () => {
  it('o arquivo carrega, cobre todos os grupos e os três tipos, e nada do que vai ao modelo parece dado pessoal', () => {
    expect(casos.length).toBeGreaterThanOrEqual(14);
    expect([...new Set(casos.map((c) => c.grupo))].sort()).toEqual([...GRUPOS_DO_PLANO].sort());
    expect([...new Set(casos.map((c) => c.tipo))].sort()).toEqual(['noventa_dias', 'oferta', 'pauta']);
    for (const c of casos) {
      expect({ id: c.id, removidos: limparJson({ pedido: c.pedido, leituras: c.leituras, boa: c.gravadas.boa }).removidos }).toEqual({ id: c.id, removidos: 0 });
    }
  });

  it('toda resposta boa passa; toda ruim reprova pelo motivo do caso', () => {
    for (const c of casos) {
      expect({ id: c.id, ...avaliarPlano(c, c.gravadas.boa) }).toEqual({ id: c.id, ok: true, falhas: [] });
      for (const ruim of c.gravadas.ruins) {
        const a = avaliarPlano(c, { chamadas: ruim.chamadas, resposta: ruim.resposta });
        expect({ id: c.id, ok: a.ok }).toEqual({ id: c.id, ok: false });
        expect({ id: c.id, falha: ruim.falha, falhou_por: a.falhas.some((f) => f.startsWith(ruim.falha)), falhas: a.falhas }).toMatchObject({ id: c.id, falhou_por: true });
      }
    }
  });

  it('os grupos que exigem 100% têm pelo menos um caso que prova a reprovação', () => {
    for (const grupo of GRUPOS_SEM_FALHA.filter((g) => (GRUPOS_DO_PLANO as readonly string[]).includes(g))) {
      expect({ grupo, ruins: casos.filter((c) => c.grupo === grupo).flatMap((c) => c.gravadas.ruins).length > 0 }).toEqual({ grupo, ruins: true });
    }
  });

  it('saída fora do formato reprova com o motivo, sem estourar', () => {
    const c = casos[0]!;
    expect(avaliarPlano(c, 'texto solto')).toEqual({ ok: false, falhas: ['formato: a saída não é JSON'] });
    expect(avaliarPlano(c, { chamadas: [], resposta: { resumo: 'só isso' } }).falhas[0]).toMatch(/^formato:/);
    // Ferramenta de escrita não existe para o Estrategista.
    const boa = c.gravadas.boa;
    expect(avaliarPlano(c, { ...boa, chamadas: [...boa.chamadas, { ferramenta: 'propor_cupom', input: {} }] }).falhas).toContain('ferramenta_indisponivel: propor_cupom');
  });

  it('a leitura do caso e o contexto montado pelo código de produção, com o dia do caso', () => {
    const c = casos.find((x) => x.id === 'ref-oferta-sexta')!;
    expect(leituraDoCaso(c, 'resultados_ciclo_fechado')).toMatchObject({ ok: true });
    expect(leituraDoCaso(c, 'links_rastreio')).toEqual({ ok: false, erro: 'Não foi possível ler agora.' });
    const contexto = contextoDoPlano(dadosDoCaso(c));
    expect(contexto).toContain('Hoje é segunda-feira, 05/10/2026');
    expect(contexto).toContain('Meta R$ 4.110,00; Google R$ 0,00');
    expect(contexto).toContain('27/11/2026, sexta-feira (2026-11-27): Black Friday (data do varejo)');
  });

  it('o modo gravado do promptfoo devolve a boa ou a primeira ruim, e o portão reprova o conjunto de ruins', () => {
    const tarefa = TAREFAS.estrategista_plano!;
    const boas = casos.map((c) => ({ caso: c, avaliacao: tarefa.avaliar(c, JSON.stringify(tarefa.gravada(c, 'boa'))) }));
    expect(portao(resumir(boas), 0.95)).toEqual([]);
    const ruins = casos.map((c) => ({ caso: c, avaliacao: tarefa.avaliar(c, JSON.stringify(tarefa.gravada(c, 'ruim'))) }));
    const motivos = portao(resumir(ruins), 0.95);
    expect(motivos.some((m) => m.startsWith('grupo "numero"'))).toBe(true);
    expect(motivos.some((m) => m.startsWith('grupo "injecao"'))).toBe(true);
    expect(motivos.some((m) => m.startsWith('nota'))).toBe(true);
  });
});
