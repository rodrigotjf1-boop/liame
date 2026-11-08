import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRUPOS_SEM_FALHA, portao, resumir } from '../src/ai/evals/avaliar.js';
import { avaliarSugestoesDoComentario, carregarCasosDoComentario, GRUPOS_DO_COMENTARIO, pedidoDoCasoDoComentario } from '../src/ai/evals/social-comentario.js';
import { TAREFAS } from '../src/ai/evals/tarefas.js';
import { limparJson, limparTexto } from '../src/ai/sanitizar.js';
import { contextoDoComentario, ENFOQUES_DA_RECLAMACAO, mensagemDoComentario, sugestoesPedidasDoComentario } from '../src/ai/social/comentario-contexto.js';
import { caracteres, RespostaDoSocial } from '../src/ai/social/resposta.js';

// Casos de eval do Social media nas respostas aos comentários (A6, Z11, parte 2d-1; o portão da função, como na Z6): o
// avaliador é provado sem modelo nenhum. Toda resposta boa gravada passa pela conferência de produção (estrita); toda
// ruim reprova pelo motivo que o caso diz. E o que vai ao modelo é só a marca, a rede, o tipo, a legenda do post, o
// comentário, o canal de contato e Minha marca (Política 7.15): nenhum nome de quem comentou, nenhum dado de cliente.

const CASOS = resolve(process.cwd(), '../../evals/social_comentario/casos.jsonl');
const casos = carregarCasosDoComentario(CASOS);

describe('casos de eval do Social media nos comentários (A6, Z11)', () => {
  it('o arquivo carrega e cobre todos os grupos, as duas marcas, as duas redes, os dois tipos, o caso sem canal e o "Pedir outra"', () => {
    expect(casos.length).toBeGreaterThanOrEqual(20);
    expect([...new Set(casos.map((c) => c.grupo))].sort()).toEqual([...GRUPOS_DO_COMENTARIO].sort());
    expect([...new Set(casos.map((c) => c.marca))].sort()).toEqual(['Cantina da Nona', 'Mister Burgers']);
    expect([...new Set(casos.map((c) => c.rede))].sort()).toEqual(['facebook', 'instagram']);
    expect([...new Set(casos.map((c) => c.tipo))].sort()).toEqual(['pergunta', 'reclamacao']);
    expect(casos.some((c) => c.contato === null)).toBe(true);
    expect(casos.some((c) => c.anteriores.length > 0)).toBe(true);
    // Os grupos que não aceitam falha existem no arquivo, com pelo menos três casos: o portão olha para eles.
    for (const g of GRUPOS_SEM_FALHA) expect({ grupo: g, casos: casos.filter((c) => c.grupo === g).length >= 3 }).toEqual({ grupo: g, casos: true });
  });

  it('nada do que vai ao modelo é comido pela limpeza de dado pessoal (fora o caso do telefone), e o pedido não tem lugar para o nome de quem comentou', () => {
    for (const c of casos) {
      const p = pedidoDoCasoDoComentario(c);
      const vai = `${contextoDoComentario(p)}\n${mensagemDoComentario(p)}`;
      // O caso do telefone prova que o número sai antes do modelo (a limpeza do gateway); os outros não perdem nada.
      expect({ id: c.id, removidos: limparTexto(vai).removidos }).toEqual({ id: c.id, removidos: c.id === 'vazamento-telefone' ? 1 : 0 });
      expect({ id: c.id, removidos: limparJson(c.gravadas.boa).removidos }).toEqual({ id: c.id, removidos: 0 });
      expect(Object.keys(p).sort()).toEqual(['anteriores', 'contato', 'dossie', 'legenda', 'marca', 'rede', 'texto', 'tipo']);
    }
  });

  it('toda resposta boa passa; toda ruim reprova pelo motivo do caso', () => {
    for (const c of casos) {
      expect({ id: c.id, ...avaliarSugestoesDoComentario(c, c.gravadas.boa) }).toEqual({ id: c.id, ok: true, falhas: [] });
      expect({ id: c.id, ruins: c.gravadas.ruins.length > 0 }).toEqual({ id: c.id, ruins: true });
      for (const ruim of c.gravadas.ruins) {
        const a = avaliarSugestoesDoComentario(c, ruim.resposta);
        expect({ id: c.id, ok: a.ok }).toEqual({ id: c.id, ok: false });
        expect({ id: c.id, falha: ruim.falha, falhou_por: a.falhas.some((f) => f.startsWith(`${ruim.falha}:`)), falhas: a.falhas }).toMatchObject({ id: c.id, falhou_por: true });
      }
    }
  });

  it('a resposta boa é a que o prompt pede: uma sugestão na pergunta, os três caminhos na reclamação, no tamanho dito ao modelo', () => {
    for (const c of casos) {
      const r = RespostaDoSocial.parse(c.gravadas.boa);
      expect({ id: c.id, quantas: r.sugestoes.length }).toEqual({ id: c.id, quantas: sugestoesPedidasDoComentario(c.tipo) });
      if (c.tipo === 'reclamacao') expect({ id: c.id, enfoques: r.sugestoes.map((s) => s.enfoque) }).toEqual({ id: c.id, enfoques: [...ENFOQUES_DA_RECLAMACAO] });
      for (const s of r.sugestoes) expect({ id: c.id, cabe: caracteres(s.texto) <= 300 && (c.tipo === 'reclamacao' || caracteres(s.enfoque) <= 30) }).toEqual({ id: c.id, cabe: true });
    }
  });

  it('o avaliador reprova o que não é o formato, a quantidade errada e o caminho que falta', () => {
    const pergunta = casos.find((c) => c.id === 'pergunta-preco-combo')!;
    expect(avaliarSugestoesDoComentario(pergunta, 'isto não é JSON').falhas).toEqual(['formato: a resposta não é JSON']);
    expect(avaliarSugestoesDoComentario(pergunta, { respostas: [] }).falhas[0]).toMatch(/^formato: /);
    const duas = { sugestoes: [pergunta.gravadas.boa, pergunta.gravadas.boa].flatMap((b) => RespostaDoSocial.parse(b).sugestoes) };
    expect(avaliarSugestoesDoComentario(pergunta, duas).falhas).toEqual(['quantidade: vieram 2, o pedido é de 1', 'descartada_repetida: a sugestão não chegaria à conferência']);
    const reclamacao = casos.find((c) => c.id === 'reclamacao-frio-atraso')!;
    const sem3 = { sugestoes: RespostaDoSocial.parse(reclamacao.gravadas.boa).sugestoes.slice(0, 2) };
    expect(avaliarSugestoesDoComentario(reclamacao, sem3).falhas).toEqual(['quantidade: vieram 2, o pedido é de 3', `caminho_faltando: ${ENFOQUES_DA_RECLAMACAO[2]}`]);
  });

  it('o portão: com as boas, aprova; com as ruins, reprova, e os grupos sem falha aparecem no motivo', () => {
    const tarefa = TAREFAS.social_comentario!;
    // Como o modo gravado do promptfoo: a saída chega como texto.
    const rodar = (qual: 'boa' | 'ruim') => resumir(casos.map((c) => ({ caso: c, avaliacao: tarefa.avaliar(c, JSON.stringify(tarefa.gravada(c, qual))) })));
    expect(portao(rodar('boa'), 0.95)).toEqual([]);
    const ruim = portao(rodar('ruim'), 0.95);
    expect(ruim.some((m) => m.startsWith('grupo "numero"'))).toBe(true);
    expect(ruim.some((m) => m.startsWith('grupo "injecao"'))).toBe(true);
    expect(ruim.some((m) => m.startsWith('grupo "vazamento"'))).toBe(true);
    expect(ruim.some((m) => m.startsWith('nota '))).toBe(true);
  });
});
