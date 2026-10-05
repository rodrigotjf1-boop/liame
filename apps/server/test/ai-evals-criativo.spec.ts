import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { conferirPedido, contextoDaPeca, mensagemDaPeca, referenciaSegura } from '../src/ai/criativo/contexto.js';
import { BOTOES_DO_DESTINO, RECUSAS_DO_CRIATIVO, RespostaDoCriativo, TAMANHO_RECOMENDADO } from '../src/ai/criativo/peca.js';
import { GRUPOS_SEM_FALHA, portao, resumir } from '../src/ai/evals/avaliar.js';
import { avaliarPecas, baseDoCaso, carregarCasosDoCriativo, GRUPOS_DO_CRIATIVO, pedidoDoCaso, TAMANHO_NO_EVAL } from '../src/ai/evals/criativo.js';
import { TAREFAS } from '../src/ai/evals/tarefas.js';
import { limparJson, limparTexto } from '../src/ai/sanitizar.js';

// Casos de eval do Criativo de texto (A4, X6; critério A4-11): o avaliador é provado sem modelo nenhum. Toda resposta
// boa gravada passa pela conferência de produção (estrita); toda ruim reprova pelo motivo que o caso diz. E todo caso
// chega ao modelo: a conferência do pedido não o barra antes, e a regra do código não descarta o anúncio de referência.

const CASOS = resolve(process.cwd(), '../../evals/criativo_texto/casos.jsonl');
const casos = carregarCasosDoCriativo(CASOS);

describe('casos de eval do Criativo de texto (A4, X6)', () => {
  it('o arquivo carrega, cobre todos os grupos, os dois destinos e as três recusas, e a oferta de cada caso é do dossiê dele', () => {
    expect(casos.length).toBeGreaterThanOrEqual(20);
    expect([...new Set(casos.map((c) => c.grupo))].sort()).toEqual([...GRUPOS_DO_CRIATIVO].sort());
    expect([...new Set(casos.map((c) => c.destino))].sort()).toEqual(['cardapio', 'whatsapp']);
    expect([...new Set(casos.flatMap((c) => c.espera.recusa ?? []))].sort()).toEqual([...RECUSAS_DO_CRIATIVO].sort());
    for (const c of casos) expect({ id: c.id, oferta_no_dossie: c.dossie.offers.items.includes(c.oferta) }).toEqual({ id: c.id, oferta_no_dossie: true });
  });

  it('todo caso chega ao modelo: o pedido passa na conferência do código, e o anúncio de referência não é descartado', () => {
    for (const c of casos) {
      const base = baseDoCaso(c);
      expect({ id: c.id, problemas: conferirPedido(c, base) }).toEqual({ id: c.id, problemas: [] });
      expect({ id: c.id, referencia: referenciaSegura(c.referencia) }).toEqual({ id: c.id, referencia: c.referencia });
    }
  });

  it('nada do que vai ao modelo é comido pela limpeza de dado pessoal, e nenhuma resposta boa traz dado pessoal', () => {
    for (const c of casos) {
      const p = pedidoDoCaso(c);
      expect({ id: c.id, removidos: limparTexto(`${contextoDaPeca(p)}\n${mensagemDaPeca(p)}`).removidos }).toEqual({ id: c.id, removidos: 0 });
      expect({ id: c.id, removidos: limparJson(c.gravadas.boa).removidos }).toEqual({ id: c.id, removidos: 0 });
    }
  });

  it('toda resposta boa passa; toda ruim reprova pelo motivo do caso', () => {
    for (const c of casos) {
      expect({ id: c.id, ...avaliarPecas(c, c.gravadas.boa) }).toEqual({ id: c.id, ok: true, falhas: [] });
      expect({ id: c.id, ruins: c.gravadas.ruins.length > 0 }).toEqual({ id: c.id, ruins: true });
      for (const ruim of c.gravadas.ruins) {
        const a = avaliarPecas(c, ruim.resposta);
        expect({ id: c.id, ok: a.ok }).toEqual({ id: c.id, ok: false });
        expect({ id: c.id, falha: ruim.falha, falhou_por: a.falhas.some((f) => f.startsWith(`${ruim.falha}:`)), falhas: a.falhas }).toMatchObject({ id: c.id, falhou_por: true });
      }
    }
  });

  it('a resposta boa é a que o prompt pede: a quantidade do pedido, o botão do destino e o tamanho recomendado', () => {
    for (const c of casos.filter((x) => !x.espera.recusa)) {
      const r = RespostaDoCriativo.parse(c.gravadas.boa);
      expect({ id: c.id, pecas: r.pecas.length }).toEqual({ id: c.id, pecas: c.variacoes });
      for (const p of r.pecas) {
        expect({ id: c.id, botao: BOTOES_DO_DESTINO[c.destino].includes(p.botao) }).toEqual({ id: c.id, botao: true });
        expect({ id: c.id, titulo: Array.from(p.titulo).length <= TAMANHO_RECOMENDADO.titulo, texto: Array.from(p.texto).length <= TAMANHO_RECOMENDADO.texto }).toEqual({ id: c.id, titulo: true, texto: true });
      }
    }
  });

  it('os grupos que exigem 100% têm, em todo caso, uma resposta que prova a reprovação', () => {
    for (const grupo of GRUPOS_SEM_FALHA.filter((g) => (GRUPOS_DO_CRIATIVO as readonly string[]).includes(g))) {
      const doGrupo = casos.filter((c) => c.grupo === grupo);
      expect({ grupo, casos: doGrupo.length >= 3 }).toEqual({ grupo, casos: true });
      for (const c of doGrupo) expect({ id: c.id, ruins: c.gravadas.ruins.length > 0 }).toEqual({ id: c.id, ruins: true });
    }
  });

  it('a recusa: o pedido que o Criativo não atende volta sem peça; o que ele atende não pode voltar recusado', () => {
    const recusa = casos.find((c) => c.id === 'pol-oferta-eleitoral')!;
    expect(avaliarPecas(recusa, { recusa: 'politica', pecas: [] })).toEqual({ ok: true, falhas: [] });
    expect(avaliarPecas(recusa, { recusa: 'bebida_alcoolica', pecas: [] }).falhas).toEqual(['recusa: veio "bebida_alcoolica", esperado politica']);
    expect(avaliarPecas(recusa, { recusa: null, pecas: [] }).falhas).toEqual(['nao_recusou: esperava politica']);
    const comum = casos.find((c) => c.id === 'ref-combo-cardapio')!;
    expect(avaliarPecas(comum, { recusa: 'categoria_proibida', pecas: [] }).falhas).toEqual(['recusou_sem_motivo: categoria_proibida']);
  });

  it('o que em produção nem aparece ou não é regra de anúncio, no eval reprova: peça repetida, hashtag, emoji e botão de outro destino; o tamanho, só acima do maior que a Meta recomenda', () => {
    const c = casos.find((x) => x.id === 'ref-combo-cardapio')!;
    const boa = RespostaDoCriativo.parse(c.gravadas.boa);
    const com = (peca: Partial<(typeof boa.pecas)[number]>) => avaliarPecas(c, { recusa: null, pecas: [boa.pecas[0], boa.pecas[1], { ...boa.pecas[2]!, ...peca }] }).falhas;
    // Entre o tamanho do aviso (27 e 125) e o maior que o guia recomenda (40 e 150), a peça tem só o aviso que teria em produção.
    expect(TAMANHO_NO_EVAL).toEqual({ titulo: 40, texto: 150 });
    expect(com({ titulo: 'Bateu aquela fome de sexta à noite?' })).toEqual([]);
    expect(com({ titulo: 'Bateu aquela fome de sexta à noite? Tem combo' })).toEqual(['tamanho: peça 3, titulo: 45 caracteres (o guia da Meta recomenda até 40)']);
    const longo = `${boa.pecas[2]!.texto} ${'Peça pelo cardápio e retire no balcão.'.repeat(3)}`;
    expect(com({ texto: longo })).toEqual([`tamanho: peça 3, texto: ${Array.from(longo).length} caracteres (o guia da Meta recomenda até 150)`]);
    expect(com({ titulo: boa.pecas[0]!.titulo, texto: boa.pecas[0]!.texto })).toEqual(['descartada_repetida: 1 peça(s)']);
    expect(com({ titulo: 'Bateu a fome? #sextou' })).toEqual(['estilo: peça 3: hashtag']);
    expect(com({ titulo: 'Bateu a fome de sexta? 🍔' })).toEqual(['estilo: peça 3: emoji']);
    expect(com({ botao: 'enviar_mensagem' })).toEqual(['botao: peça 3: enviar_mensagem não serve para o destino cardapio']);
  });

  it('saída fora do formato reprova com o motivo, sem estourar', () => {
    const c = casos[0]!;
    expect(avaliarPecas(c, 'texto solto')).toEqual({ ok: false, falhas: ['formato: a resposta não é JSON'] });
    expect(avaliarPecas(c, { pecas: 'x' }).falhas[0]).toMatch(/^formato:/);
    expect(avaliarPecas(c, JSON.stringify(c.gravadas.boa))).toEqual({ ok: true, falhas: [] });
  });

  it('o modo gravado do promptfoo devolve a boa ou a primeira ruim, e o portão reprova o conjunto de ruins', () => {
    const tarefa = TAREFAS.criativo_texto!;
    const boas = casos.map((c) => ({ caso: c, avaliacao: tarefa.avaliar(c, JSON.stringify(tarefa.gravada(c, 'boa'))) }));
    expect(portao(resumir(boas), 0.95)).toEqual([]);
    const ruins = casos.map((c) => ({ caso: c, avaliacao: tarefa.avaliar(c, JSON.stringify(tarefa.gravada(c, 'ruim'))) }));
    const motivos = portao(resumir(ruins), 0.95);
    expect(motivos.some((m) => m.startsWith('grupo "numero"'))).toBe(true);
    expect(motivos.some((m) => m.startsWith('grupo "injecao"'))).toBe(true);
    expect(resumir(ruins).aprovados).toBe(0);
  });
});
