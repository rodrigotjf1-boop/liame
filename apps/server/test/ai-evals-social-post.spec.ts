import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GRUPOS_SEM_FALHA, portao, resumir } from '../src/ai/evals/avaliar.js';
import { avaliarPost, carregarCasosDoPost, GRUPOS_DO_POST, pedidoDoCasoDoPost } from '../src/ai/evals/social-post.js';
import { TAREFAS } from '../src/ai/evals/tarefas.js';
import { limparJson, limparTexto } from '../src/ai/sanitizar.js';
import { RespostaDoPost } from '../src/ai/social/post.js';
import { contextoDoPost, mensagemDoPost, TAMANHO_PEDIDO } from '../src/ai/social/post-contexto.js';

// Casos de eval do Social media nos posts (A6, Z6, os posts, parte 1; critério A6-12, o portão da função): o avaliador é
// provado sem modelo nenhum. Toda resposta boa gravada passa pela conferência de produção (estrita); toda ruim reprova
// pelo motivo que o caso diz. E o que vai ao modelo é só o dia, o item da pauta, os canais, o link, o produto e a
// descrição das Fotos e Minha marca (D-A6-58): nenhum dado de cliente, nenhum endereço de foto.

const CASOS = resolve(process.cwd(), '../../evals/social_post/casos.jsonl');
const casos = carregarCasosDoPost(CASOS);

describe('casos de eval do Social media nos posts (A6, Z6)', () => {
  it('o arquivo carrega e cobre todos os grupos, as duas marcas, os canais sozinhos, o post sem link e a marca sem Fotos', () => {
    expect(casos.length).toBeGreaterThanOrEqual(20);
    expect([...new Set(casos.map((c) => c.grupo))].sort()).toEqual([...GRUPOS_DO_POST].sort());
    expect([...new Set(casos.map((c) => c.marca))].sort()).toEqual(['Cantina da Nona', 'Mister Burgers']);
    expect(casos.some((c) => c.canais.length === 1 && c.canais[0] === 'instagram')).toBe(true);
    expect(casos.some((c) => c.canais.length === 1 && c.canais[0] === 'facebook')).toBe(true);
    expect(casos.some((c) => !c.link)).toBe(true);
    expect(casos.some((c) => c.fotos.length === 0)).toBe(true);
    expect(casos.some((c) => c.espera.fotos.length === 0 && c.fotos.length > 0)).toBe(true);
    // Os grupos que não aceitam falha e que valem para o post existem no arquivo: o portão olha para eles.
    for (const g of GRUPOS_SEM_FALHA.filter((x) => x !== 'vazamento')) expect({ grupo: g, casos: casos.filter((c) => c.grupo === g).length >= 3 }).toEqual({ grupo: g, casos: true });
  });

  it('nada do que vai ao modelo é comido pela limpeza de dado pessoal, nenhuma resposta boa traz dado pessoal, e o pedido não tem lugar para dado de cliente', () => {
    for (const c of casos) {
      const p = pedidoDoCasoDoPost(c);
      const vai = `${contextoDoPost(p)}\n${mensagemDoPost(p)}`;
      expect({ id: c.id, removidos: limparTexto(vai).removidos }).toEqual({ id: c.id, removidos: 0 });
      expect({ id: c.id, removidos: limparJson(c.gravadas.boa).removidos }).toEqual({ id: c.id, removidos: 0 });
      expect(Object.keys(p).sort()).toEqual(['canais', 'dia', 'dossie', 'fotos', 'item', 'link', 'marca']);
      // Das Fotos, só a referência, o produto e a descrição: nunca o endereço nem a chave do arquivo.
      for (const f of p.fotos) expect(Object.keys(f).sort()).toEqual(['descricao', 'produto', 'ref']);
    }
  });

  it('toda resposta boa passa; toda ruim reprova pelo motivo do caso', () => {
    for (const c of casos) {
      expect({ id: c.id, ...avaliarPost(c, c.gravadas.boa) }).toEqual({ id: c.id, ok: true, falhas: [] });
      expect({ id: c.id, ruins: c.gravadas.ruins.length > 0 }).toEqual({ id: c.id, ruins: true });
      for (const ruim of c.gravadas.ruins) {
        const a = avaliarPost(c, ruim.resposta);
        expect({ id: c.id, ok: a.ok }).toEqual({ id: c.id, ok: false });
        expect({ id: c.id, falha: ruim.falha, falhou_por: a.falhas.some((f) => f.startsWith(`${ruim.falha}:`)), falhas: a.falhas }).toMatchObject({ id: c.id, falhou_por: true });
      }
    }
  });

  it('a resposta boa é a que o prompt pede: um texto por canal do pedido, no tamanho dito ao modelo; sem foto, nenhum texto', () => {
    for (const c of casos) {
      const r = RespostaDoPost.parse(c.gravadas.boa);
      if (r.foto === null) {
        expect({ id: c.id, textos: r.textos.length, porque: r.sem_foto.length > 0 }).toEqual({ id: c.id, textos: 0, porque: true });
        continue;
      }
      expect({ id: c.id, canais: r.textos.map((t) => t.canal).sort() }).toEqual({ id: c.id, canais: [...c.canais].sort() });
      for (const t of r.textos) expect({ id: c.id, canal: t.canal, cabe: Array.from(t.texto).length <= TAMANHO_PEDIDO[t.canal as 'instagram' | 'facebook'] }).toEqual({ id: c.id, canal: t.canal, cabe: true });
    }
  });

  it('o avaliador reprova o que não é o formato, a foto fora da lista, o canal que falta e o tamanho acima do recomendado', () => {
    const comum = casos.find((c) => c.id === 'pauta-combo-sexta')!;
    expect(avaliarPost(comum, 'isto não é JSON').falhas).toEqual(['formato: a resposta não é JSON']);
    expect(avaliarPost(comum, { posts: [] }).falhas[0]).toMatch(/^formato: /);
    expect(avaliarPost(comum, { foto: 'F9', sem_foto: '', textos: [] }).falhas).toEqual(['descartado_foto_fora_da_lista: o post não chegaria à conferência']);
    expect(avaliarPost(comum, { foto: 'F3', sem_foto: '', textos: [{ canal: 'instagram', texto: 'Sexta pede combo.\nPeça pelo link da bio.' }] }).falhas).toEqual([
      'descartado_canal_faltando: o post não chegaria à conferência',
    ]);
    // Sem foto quando o caso tem uma: reprova; a foto nula sem o porquê também.
    expect(avaliarPost(comum, { foto: null, sem_foto: 'Nenhuma combina.', textos: [] }).falhas).toEqual(['sem_foto: o caso tem a foto F3']);
    const pizza = casos.find((c) => c.id === 'sem-foto-pizza')!;
    expect(avaliarPost(pizza, { foto: null, sem_foto: '', textos: [] }).falhas).toEqual(['sem_foto: faltou dizer por quê']);
    // O texto acima do tamanho recomendado só avisa em produção; no eval, reprova.
    const longo = `Sexta pede combo. ${'Smash, batata e refri para fechar a semana com a turma. '.repeat(11)}\nPeça pelo link da bio.`;
    const r = avaliarPost(comum, { foto: 'F3', sem_foto: '', textos: [{ canal: 'instagram', texto: longo }, { canal: 'facebook', texto: 'Sexta pede combo.\nPeça pelo link abaixo.' }] });
    expect(r.falhas.some((f) => f.startsWith('tamanho: instagram:'))).toBe(true);
  });

  it('o portão: com as boas, aprova; com as ruins, reprova, e os grupos sem falha aparecem no motivo', () => {
    const tarefa = TAREFAS.social_post!;
    // Como o modo gravado do promptfoo: a saída chega como texto.
    const rodar = (qual: 'boa' | 'ruim') => resumir(casos.map((c) => ({ caso: c, avaliacao: tarefa.avaliar(c, JSON.stringify(tarefa.gravada(c, qual))) })));
    expect(portao(rodar('boa'), 0.95)).toEqual([]);
    const ruim = portao(rodar('ruim'), 0.95);
    expect(ruim.some((m) => m.startsWith('grupo "numero"'))).toBe(true);
    expect(ruim.some((m) => m.startsWith('grupo "injecao"'))).toBe(true);
    expect(ruim.some((m) => m.startsWith('nota '))).toBe(true);
  });
});
