import type { CommentsResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { autorDoComentario, avisosDasContas, FILTROS, legendaDoPost, lerAgora, lidoHa, pedidoDoComentario, ROTULO_DA_SITUACAO, vazioDoFiltro } from '@/components/comentarios/textos';
import { NAVEGACAO } from '@/components/shell/navegacao';

// A tela Comentários (A6 · Z11, parte 3b; mockups/prototipo-comentarios.html, P38): o item do menu, as situações que
// filtram, quem comentou, o pedido em Aprovações, a legenda do post, a leitura, os avisos das contas e a lista vazia.

const agora = new Date('2026-11-10T15:00:00Z');
const conta = (o: Partial<CommentsResponse['accounts'][number]> = {}): CommentsResponse['accounts'][number] => ({ channel: 'instagram', name: '@misterburgers', situation: 'lido', read_at: '2026-11-10T14:48:00Z', ...o });

describe('a tela Comentários (A6 · Z11, parte 3b)', () => {
  it('o item do menu fica logo depois de Avaliações, para quem acompanha as campanhas, uma tela só nos dois modos', () => {
    const itens = NAVEGACAO.find((g) => g.id === 'agencia')!.itens;
    const i = itens.findIndex((x) => x.href === '/comentarios');
    expect(itens[i]).toEqual({ href: '/comentarios', rotulo: 'Comentários', icone: 'reply', permissao: 'campanhas.ver' });
    expect(itens[i - 1]!.href).toBe('/avaliacoes');
  });

  it('as situações que filtram são as do servidor, na ordem da tela, e cada comentário tem o rótulo da situação', () => {
    expect(FILTROS.map(([id]) => id)).toEqual(['pedem', 'ocultar', 'respondidos', 'ocultos', 'todos']);
    expect(Object.keys(ROTULO_DA_SITUACAO).sort()).toEqual(['oculto', 'para_ocultar', 'pede_resposta', 'respondido', 'sem_resposta']);
  });

  it('quem comentou: o @ no Instagram, o nome na Página; e o pedido em Aprovações leva até ele', () => {
    expect(autorDoComentario({ author: 'duda.come.bem', channel: 'instagram' })).toBe('@duda.come.bem');
    expect(autorDoComentario({ author: 'Duda Lima', channel: 'facebook' })).toBe('Duda Lima');
    expect(autorDoComentario({ author: null, channel: 'instagram' })).toBeNull();
    const id = 'c0000000-0000-4000-8000-000000000001';
    expect(pedidoDoComentario({ request: { id, tool: 'comentario_responder', status: 'aguardando_aprovacao' } })).toEqual({ rotulo: 'Resposta espera aprovação', href: `/aprovacoes?pedido=${id}` });
    expect(pedidoDoComentario({ request: { id, tool: 'comentario_ocultar', status: 'executando' } })?.rotulo).toBe('Ocultar saindo');
    expect(pedidoDoComentario({ request: null })).toBeNull();
  });

  it('a legenda do post, curta; a leitura pela conta lida há mais tempo; e o "Ler agora"', () => {
    const posts = [{ id: 'p1', channel: 'instagram', kind: 'foto', caption: 'a'.repeat(200), permalink: null, thumbnail_url: null, published_at: '2026-11-09T12:00:00Z', comment_count: 3 }];
    expect([...legendaDoPost(posts, { post_id: 'p1', channel: 'instagram' })!].length).toBe(120);
    expect(legendaDoPost(posts, { post_id: 'outro', channel: 'instagram' })).toBeNull();
    expect(lidoHa([conta(), conta({ channel: 'facebook', read_at: '2026-11-10T14:30:00Z' })], agora)).toBe('Lido há 30 min');
    expect(lidoHa([conta({ read_at: null })], agora)).toBeNull();
    expect(lerAgora({ available: true, next_at: null })).toEqual({ pode: true, dica: null });
    expect(lerAgora({ available: false, next_at: null }).dica).toBe('O Liame já está lendo os comentários.');
  });

  it('os avisos das contas que não leram: a permissão leva a Contas conectadas; a que leu não avisa', () => {
    const avisos = avisosDasContas([conta({ situation: 'sem_permissao' }), conta({ situation: 'falhou', name: 'Mister Burgers' }), conta()]);
    expect(avisos.map((a) => [a.tom, a.contas])).toEqual([
      ['perigo', true],
      ['aviso', false],
    ]);
    expect(avisos[0]!.texto).toContain('Conecte a Meta de novo em Contas conectadas');
  });

  it('a lista vazia diz o que aparece em cada filtro; com a busca, a frase é a da busca', () => {
    expect(vazioDoFiltro('pedem', '').titulo).toBe('Nenhum comentário pede resposta agora');
    expect(vazioDoFiltro('todos', '').titulo).toBe('Nenhum comentário nos posts dos últimos 30 dias');
    expect(vazioDoFiltro('pedem', 'batata').titulo).toBe('Nenhum comentário com essa busca');
  });
});
