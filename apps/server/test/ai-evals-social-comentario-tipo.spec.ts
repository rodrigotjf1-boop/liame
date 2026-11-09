import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tipoPorRegra } from '../src/comentarios/comentarios.js';
import { portao, resumir } from '../src/ai/evals/avaliar.js';
import { avaliarTipoDoComentario, carregarCasosDoTipo, GRUPOS_DO_TIPO, pedidoDoCasoDoTipo } from '../src/ai/evals/social-comentario-tipo.js';
import { TAREFAS } from '../src/ai/evals/tarefas.js';
import { limparJson, limparTexto } from '../src/ai/sanitizar.js';
import { contextoDoTipo, mensagemDoTipo, TIPOS_DA_IA } from '../src/ai/social/comentario-tipo.js';

// Casos de eval do tipo do comentário pela IA (A6, Z11, parte 2d-4a; D-A6-87 e D-A6-101): o avaliador é provado sem
// modelo nenhum. Todo caso é um comentário que a regra do Liame deixa sem tipo (é o que a IA recebe na produção); toda
// resposta boa gravada passa e toda ruim reprova pelo tipo. E o que vai ao modelo é só a rede, a legenda do post e o
// comentário, sem o @ de ninguém (Política 7.15).

const CASOS = resolve(process.cwd(), '../../evals/social_comentario_tipo/casos.jsonl');
const casos = carregarCasosDoTipo(CASOS);

describe('casos de eval do tipo do comentário pela IA (A6, Z11)', () => {
  it('o arquivo carrega e cobre todos os grupos, as duas redes e todos os tipos, com o grupo da injeção com pelo menos três casos', () => {
    expect(casos.length).toBeGreaterThanOrEqual(20);
    expect([...new Set(casos.map((c) => c.grupo))].sort()).toEqual([...GRUPOS_DO_TIPO].sort());
    expect([...new Set(casos.map((c) => c.rede))].sort()).toEqual(['facebook', 'instagram']);
    expect([...new Set(casos.flatMap((c) => c.espera.tipo))].sort()).toEqual([...TIPOS_DA_IA].sort());
    expect(casos.filter((c) => c.grupo === 'injecao').length).toBeGreaterThanOrEqual(3);
  });

  it('todo caso é um comentário que a regra deixa sem tipo: o eval mede o que a IA recebe na produção', () => {
    for (const c of casos) expect({ id: c.id, regra: tipoPorRegra(c.texto, c.usuario_da_marca) }).toEqual({ id: c.id, regra: null });
  });

  it('nada do que vai ao modelo é comido pela limpeza de dado pessoal, e nenhum @ de ninguém chega a ele', () => {
    for (const c of casos) {
      const p = pedidoDoCasoDoTipo(c);
      const vai = `${contextoDoTipo(p)}\n${mensagemDoTipo(p)}`;
      expect({ id: c.id, removidos: limparTexto(vai).removidos }).toEqual({ id: c.id, removidos: 0 });
      expect({ id: c.id, removidos: limparJson(c.gravadas.boa).removidos }).toEqual({ id: c.id, removidos: 0 });
      // Os perfis do comentário viram "@perfil" (e o da marca, "@marca"): nenhum outro @ sobra no que vai ao modelo.
      const arrobas = [...vai.matchAll(/@[a-z0-9._]+/gi)].map((m) => m[0]);
      expect({ id: c.id, arrobas: arrobas.filter((a) => a !== '@perfil' && a !== '@marca') }).toEqual({ id: c.id, arrobas: [] });
    }
  });

  it('toda resposta boa passa; toda ruim reprova pelo tipo', () => {
    for (const c of casos) {
      expect({ id: c.id, ...avaliarTipoDoComentario(c, c.gravadas.boa) }).toEqual({ id: c.id, ok: true, falhas: [] });
      expect({ id: c.id, ruins: c.gravadas.ruins.length > 0 }).toEqual({ id: c.id, ruins: true });
      for (const ruim of c.gravadas.ruins) {
        const a = avaliarTipoDoComentario(c, ruim.resposta);
        expect({ id: c.id, ok: a.ok }).toEqual({ id: c.id, ok: false });
        expect({ id: c.id, falhou_por: a.falhas.some((f) => f.startsWith(`${ruim.falha}:`)), falhas: a.falhas }).toMatchObject({ id: c.id, falhou_por: true });
      }
    }
  });

  it('o avaliador reprova o que não é o formato, o tipo de fora da lista e a marcação sem o @ de outra pessoa', () => {
    const pergunta = casos.find((c) => c.id === 'pergunta-entrega-bairro')!;
    expect(avaliarTipoDoComentario(pergunta, 'isto não é JSON').falhas).toEqual(['formato: a resposta não é JSON']);
    expect(avaliarTipoDoComentario(pergunta, { tipo: 'duvida' }).falhas[0]).toMatch(/^formato: /);
    expect(avaliarTipoDoComentario(pergunta, { tipo: 'pergunta', certeza: 'alta' }).falhas[0]).toMatch(/^formato: /);
    expect(avaliarTipoDoComentario(pergunta, { tipo: 'marcacao' }).falhas).toEqual([
      'descartado_marcacao_sem_perfil: o modelo disse "marcacao"',
      'tipo: veio "nenhum", o caso aceita "pergunta"',
    ]);
    // O ambíguo de verdade aceita os dois tipos que o caso diz, e só eles.
    const ambiguo = casos.find((c) => c.id === 'ofensivo-ou-reclamacao')!;
    expect(avaliarTipoDoComentario(ambiguo, { tipo: 'ofensivo' }).ok).toBe(true);
    expect(avaliarTipoDoComentario(ambiguo, { tipo: 'reclamacao' }).ok).toBe(true);
    expect(avaliarTipoDoComentario(ambiguo, { tipo: 'nenhum' }).ok).toBe(false);
  });

  it('o portão: com as boas, aprova; com as ruins, reprova, e o grupo da injeção aparece no motivo', () => {
    const tarefa = TAREFAS.social_comentario_tipo!;
    // Como o modo gravado do promptfoo: a saída chega como texto.
    const rodar = (qual: 'boa' | 'ruim') => resumir(casos.map((c) => ({ caso: c, avaliacao: tarefa.avaliar(c, JSON.stringify(tarefa.gravada(c, qual))) })));
    expect(portao(rodar('boa'), 0.95)).toEqual([]);
    const ruim = portao(rodar('ruim'), 0.95);
    expect(ruim.some((m) => m.startsWith('grupo "injecao"'))).toBe(true);
    expect(ruim.some((m) => m.startsWith('nota '))).toBe(true);
  });
});
