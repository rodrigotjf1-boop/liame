import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRUPOS_SEM_FALHA, portao, resumir } from '../src/ai/evals/avaliar.js';
import { avaliarSugestoes, carregarCasosDoSocial, GRUPOS_DO_SOCIAL, pedidoDoCasoDoSocial } from '../src/ai/evals/social.js';
import { TAREFAS } from '../src/ai/evals/tarefas.js';
import { limparJson, limparTexto } from '../src/ai/sanitizar.js';
import { contextoDoSocial, mensagemDoSocial, sugestoesPedidas } from '../src/ai/social/contexto.js';
import { RespostaDoSocial } from '../src/ai/social/resposta.js';

// Casos de eval do Social media nas respostas às avaliações (A6, Z6; critério A6-12, o portão da função): o avaliador é
// provado sem modelo nenhum. Toda resposta boa gravada passa pela conferência de produção (estrita); toda ruim reprova
// pelo motivo que o caso diz. E o que vai ao modelo é só a nota, o dia, o texto da avaliação e Minha marca (D-A6-29).

const CASOS = resolve(process.cwd(), '../../evals/social_resposta/casos.jsonl');
const casos = carregarCasosDoSocial(CASOS);

describe('casos de eval do Social media nas respostas (A6, Z6)', () => {
  it('o arquivo carrega e cobre todos os grupos, as cinco notas, as duas marcas, a avaliação só com a nota e a com o canal de Minha marca', () => {
    expect(casos.length).toBeGreaterThanOrEqual(20);
    expect([...new Set(casos.map((c) => c.grupo))].sort()).toEqual([...GRUPOS_DO_SOCIAL].sort());
    expect([...new Set(casos.map((c) => c.estrelas))].sort()).toEqual([1, 2, 3, 4, 5]);
    expect([...new Set(casos.map((c) => c.marca))].sort()).toEqual(['Cantina da Nona', 'Mister Burgers']);
    expect(casos.some((c) => c.texto === null)).toBe(true);
    expect(casos.some((c) => c.canal !== null)).toBe(true);
    // Os grupos que não aceitam falha existem no arquivo: o portão olha para eles.
    for (const g of GRUPOS_SEM_FALHA) expect({ grupo: g, casos: casos.filter((c) => c.grupo === g).length >= 3 }).toEqual({ grupo: g, casos: true });
  });

  it('nada do que vai ao modelo é comido pela limpeza de dado pessoal, nenhuma resposta boa traz dado pessoal, e nenhum caso leva o nome de quem avaliou', () => {
    for (const c of casos) {
      const p = pedidoDoCasoDoSocial(c);
      const vai = `${contextoDoSocial(p)}\n${mensagemDoSocial(p)}`;
      expect({ id: c.id, removidos: limparTexto(vai).removidos }).toEqual({ id: c.id, removidos: 0 });
      expect({ id: c.id, removidos: limparJson(c.gravadas.boa).removidos }).toEqual({ id: c.id, removidos: 0 });
      // O pedido não tem lugar para o nome de quem avaliou (D-A6-29): só a nota, o dia, o texto, o canal, o dossiê e,
      // no "Pedir outras", as sugestões que a pessoa já viu (o texto do próprio Social media).
      expect(Object.keys(p).sort()).toEqual(['anteriores', 'canal', 'dossie', 'estrelas', 'feitaEm', 'marca', 'texto']);
    }
  });

  it('toda resposta boa passa; toda ruim reprova pelo motivo do caso', () => {
    for (const c of casos) {
      expect({ id: c.id, ...avaliarSugestoes(c, c.gravadas.boa) }).toEqual({ id: c.id, ok: true, falhas: [] });
      expect({ id: c.id, ruins: c.gravadas.ruins.length > 0 }).toEqual({ id: c.id, ruins: true });
      for (const ruim of c.gravadas.ruins) {
        const a = avaliarSugestoes(c, ruim.resposta);
        expect({ id: c.id, ok: a.ok }).toEqual({ id: c.id, ok: false });
        expect({ id: c.id, falha: ruim.falha, falhou_por: a.falhas.some((f) => f.startsWith(`${ruim.falha}:`)), falhas: a.falhas }).toMatchObject({ id: c.id, falhou_por: true });
      }
    }
  });

  it('a resposta boa é a que o prompt pede: a quantidade do pedido, enfoques diferentes e o tamanho dito ao modelo', () => {
    for (const c of casos) {
      const r = RespostaDoSocial.parse(c.gravadas.boa);
      expect({ id: c.id, quantas: r.sugestoes.length }).toEqual({ id: c.id, quantas: sugestoesPedidas({ texto: c.texto }) });
      expect({ id: c.id, enfoques: new Set(r.sugestoes.map((s) => s.enfoque)).size }).toEqual({ id: c.id, enfoques: r.sugestoes.length });
      for (const s of r.sugestoes) expect({ id: c.id, enfoque: Array.from(s.enfoque).length <= 40, texto: Array.from(s.texto).length <= 300 }).toEqual({ id: c.id, enfoque: true, texto: true });
    }
  });

  it('o avaliador reprova o que não é o formato, a quantidade errada, o enfoque repetido e o tamanho acima do recomendado', () => {
    const comum = casos.find((c) => c.id === 'boa-combo-entrega')!;
    expect(avaliarSugestoes(comum, 'isto não é JSON').falhas).toEqual(['formato: a resposta não é JSON']);
    expect(avaliarSugestoes(comum, { respostas: [] }).falhas[0]).toMatch(/^formato: /);
    expect(avaliarSugestoes(comum, { sugestoes: [] }).falhas).toEqual(['quantidade: vieram 0, o pedido é de 2']);
    const mesma = { enfoque: 'Curta', texto: 'Obrigado pela visita e pelo combo sexta.' };
    expect(avaliarSugestoes(comum, { sugestoes: [mesma, { enfoque: 'Curta', texto: 'Obrigado por contar como foi.' }] }).falhas).toEqual(['enfoque_repetido: Curta']);
    // A sugestão acima do tamanho recomendado só avisa em produção; no eval, reprova.
    const longa = `Obrigado pela visita! ${'Ficamos muito felizes que o combo chegou quentinho. '.repeat(7)}`.trim();
    expect(avaliarSugestoes(comum, { sugestoes: [mesma, { enfoque: 'Mais calorosa', texto: longa }] }).falhas.some((f) => f.startsWith('tamanho: texto:'))).toBe(true);
    // Três sugestões quando o pedido é de duas: a quantidade reprova, e a terceira não chega à conferência.
    const tres = avaliarSugestoes(comum, { sugestoes: [mesma, { enfoque: 'Outra', texto: 'Obrigado por contar como foi.' }, { enfoque: 'Mais uma', texto: 'Obrigado de novo.' }] });
    expect(tres.falhas).toEqual(['quantidade: vieram 3, o pedido é de 2']);
  });

  it('o portão: com as boas, aprova; com as ruins, reprova, e os grupos sem falha aparecem no motivo', () => {
    const tarefa = TAREFAS.social_resposta!;
    // Como o modo gravado do promptfoo: a saída chega como texto.
    const rodar = (qual: 'boa' | 'ruim') => resumir(casos.map((c) => ({ caso: c, avaliacao: tarefa.avaliar(c, JSON.stringify(tarefa.gravada(c, qual))) })));
    expect(portao(rodar('boa'), 0.95)).toEqual([]);
    const motivos = portao(rodar('ruim'), 0.95);
    for (const g of GRUPOS_SEM_FALHA) expect(motivos.some((m) => m.includes(`grupo "${g}"`))).toBe(true);
  });
});
