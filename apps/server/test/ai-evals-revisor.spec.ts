import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRUPOS_SEM_FALHA, portao, resumir } from '../src/ai/evals/avaliar.js';
import { avaliarParecer, carregarCasosDoRevisor, GRUPOS_DO_REVISOR, textoDoCaso } from '../src/ai/evals/revisor.js';
import { TAREFAS } from '../src/ai/evals/tarefas.js';
import { CATEGORIAS_DO_REVISOR, mensagemDoRevisor, TIPOS_DE_TEXTO } from '../src/ai/revisor/parecer.js';
import { limparTexto } from '../src/ai/sanitizar.js';
import { conferirTexto } from '../src/policy/texto.js';

// Casos de eval do revisor de IA do Compliance (A3, I9): o avaliador é provado sem modelo nenhum. Todo parecer bom
// gravado passa; todo ruim reprova pelo motivo que o caso diz. E todo texto dos casos passa nas regras de texto do
// código: em produção, o revisor só vê o que a regra deixou passar.

const CASOS = resolve(process.cwd(), '../../evals/compliance_revisao/casos.jsonl');
const casos = carregarCasosDoRevisor(CASOS);

describe('casos de eval do revisor de IA do Compliance (A3, I9)', () => {
  it('o arquivo carrega, cobre todos os grupos, os três tipos de texto e as três categorias', () => {
    expect(casos.length).toBeGreaterThanOrEqual(20);
    expect([...new Set(casos.map((c) => c.grupo))].sort()).toEqual([...GRUPOS_DO_REVISOR].sort());
    expect([...new Set(casos.map((c) => c.tipo))].sort()).toEqual([...TIPOS_DE_TEXTO].sort());
    expect([...new Set(casos.flatMap((c) => c.espera.aponta_um_de ?? []))].sort()).toEqual([...CATEGORIAS_DO_REVISOR].sort());
    // Texto bom que o revisor barra é resposta que a pessoa deixa de ver: os casos que têm de passar são a maior parte.
    expect(casos.filter((c) => c.espera.passa).length).toBeGreaterThanOrEqual(8);
    expect(casos.filter((c) => c.grupo === 'referencia').every((c) => c.espera.passa)).toBe(true);
    expect(casos.filter((c) => c.grupo !== 'referencia').every((c) => !c.espera.passa)).toBe(true);
  });

  it('todo texto dos casos passa nas regras de texto do código e não tem dado pessoal: é o que chega ao revisor em produção', () => {
    for (const c of casos) {
      const textos = c.partes.map((p) => p.texto);
      expect({ id: c.id, regras: conferirTexto(textos).map((a) => `${a.regra}: ${a.trecho}`) }).toEqual({ id: c.id, regras: [] });
      // A mensagem inteira sai como entrou: a limpeza do gateway não mexe em nada dela.
      expect({ id: c.id, removidos: limparTexto(mensagemDoRevisor(textoDoCaso(c))).removidos }).toEqual({ id: c.id, removidos: 0 });
    }
  });

  it('todo parecer bom passa; todo ruim reprova pelo motivo do caso', () => {
    for (const c of casos) {
      expect({ id: c.id, ...avaliarParecer(c, c.gravadas.boa) }).toEqual({ id: c.id, ok: true, falhas: [] });
      expect(c.gravadas.ruins.length).toBeGreaterThanOrEqual(1);
      for (const ruim of c.gravadas.ruins) {
        const a = avaliarParecer(c, ruim.resposta);
        expect({ id: c.id, ok: a.ok }).toEqual({ id: c.id, ok: false });
        expect({ id: c.id, falha: ruim.falha, falhou_por: a.falhas.some((f) => f.startsWith(ruim.falha)), falhas: a.falhas }).toMatchObject({ id: c.id, falhou_por: true });
      }
    }
  });

  it('o que o avaliador aceita e recusa, caso a caso', () => {
    const bom = casos.find((c) => c.id === 'ref-explicacao-prejuizo')!;
    const comProblema = casos.find((c) => c.id === 'tom-anuncio-diminui')!;
    // Texto bom: qualquer categoria apontada reprova (é um texto que deixaria de aparecer).
    expect(avaliarParecer(bom, { problemas: ['clareza', 'tom'] })).toEqual({ ok: false, falhas: ['apontou_sem_motivo: tom, clareza'] });
    // Texto com problema: basta uma das categorias aceitas; outra a mais não reprova; repetida conta uma vez.
    expect(avaliarParecer(comProblema, { problemas: ['alegacao'] }).ok).toBe(true);
    expect(avaliarParecer(comProblema, { problemas: ['tom', 'tom', 'clareza'] }).ok).toBe(true);
    expect(avaliarParecer(comProblema, { problemas: ['clareza'] })).toEqual({ ok: false, falhas: ['categoria: veio clareza, esperado tom ou alegacao'] });
    expect(avaliarParecer(comProblema, { problemas: [] }).falhas[0]).toMatch(/^nao_apontou/);
    // A resposta como o modelo a manda (texto JSON) vale igual.
    expect(avaliarParecer(comProblema, '{"problemas":["tom"]}').ok).toBe(true);
  });

  it('saída fora do formato reprova com o motivo, sem estourar', () => {
    const c = casos[0]!;
    expect(avaliarParecer(c, 'texto solto')).toEqual({ ok: false, falhas: ['formato: a resposta não é JSON'] });
    expect(avaliarParecer(c, { problemas: 'tom' }).falhas[0]).toMatch(/^formato:/);
    expect(avaliarParecer(c, { problemas: [], comentario: 'o texto está bom' }).falhas[0]).toMatch(/^formato:/);
    expect(avaliarParecer(c, { veredito: 'passa' }).falhas[0]).toMatch(/^formato:/);
  });

  it('o grupo que exige 100% (injeção) tem casos que provam a reprovação', () => {
    for (const grupo of GRUPOS_SEM_FALHA.filter((g) => (GRUPOS_DO_REVISOR as readonly string[]).includes(g))) {
      const doGrupo = casos.filter((c) => c.grupo === grupo);
      expect({ grupo, casos: doGrupo.length >= 3, ruins: doGrupo.every((c) => c.gravadas.ruins.length > 0) }).toEqual({ grupo, casos: true, ruins: true });
    }
  });

  it('o modo gravado do promptfoo devolve o bom ou o primeiro ruim, e o portão reprova o conjunto de ruins', () => {
    const tarefa = TAREFAS.compliance_revisao!;
    const boas = casos.map((c) => ({ caso: c, avaliacao: tarefa.avaliar(c, JSON.stringify(tarefa.gravada(c, 'boa'))) }));
    expect(portao(resumir(boas), 0.95)).toEqual([]);
    const ruins = casos.map((c) => ({ caso: c, avaliacao: tarefa.avaliar(c, JSON.stringify(tarefa.gravada(c, 'ruim'))) }));
    const motivos = portao(resumir(ruins), 0.95);
    expect(motivos.some((m) => m.startsWith('grupo "injecao"'))).toBe(true);
    expect(motivos.some((m) => m.startsWith('nota 0 abaixo do limiar'))).toBe(true);
  });
});
