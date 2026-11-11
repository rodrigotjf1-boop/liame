import { COMMENT_AUTO_REPLY_NOTICE, type CommentAutoReplyResponse, type CommentsResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import {
  autorDoComentario,
  avisoAoLigar,
  avisosDasContas,
  botaoDoAutomatico,
  comentariosFalados,
  erroDoAutomatico,
  erroDoPedido,
  estadoDoAutomatico,
  FILTROS,
  legendaDoPost,
  lerAgora,
  lidoHa,
  pedeConfirmacao,
  pedidoDoComentario,
  respondidoSozinho,
  resumoDoAutomatico,
  ROTULO_DA_SITUACAO,
  TIPOS_DO_AUTOMATICO,
  vazioDoFiltro,
} from '@/components/comentarios/textos';
import { NAVEGACAO } from '@/components/shell/navegacao';

// A tela Comentários (A6 · Z11, parte 3b; mockups/prototipo-comentarios.html, P38): o item do menu, as situações que
// filtram, quem comentou, o pedido em Aprovações, a legenda do post, a leitura, os avisos das contas e a lista vazia.

const agora = new Date('2026-11-10T15:00:00Z');
const conta = (o: Partial<CommentsResponse['accounts'][number]> = {}): CommentsResponse['accounts'][number] => ({ channel: 'instagram', name: '@misterburgers', situation: 'lido', read_at: '2026-11-10T14:48:00Z', ...o });

describe('a tela Comentários (A6 · Z11, parte 3b)', () => {
  it('o item do menu fica logo depois de Avaliações, para quem acompanha as campanhas, uma tela só nos dois modos, com o contador dos que pedem resposta', () => {
    const itens = NAVEGACAO.find((g) => g.id === 'agencia')!.itens;
    const i = itens.findIndex((x) => x.href === '/comentarios');
    expect(itens[i]).toEqual({ href: '/comentarios', rotulo: 'Comentários', icone: 'reply', permissao: 'campanhas.ver', contador: 'comentarios' });
    expect(itens[i - 1]!.href).toBe('/avaliacoes');
    // O leitor de tela ouve o número com o que ele conta (P38).
    expect(comentariosFalados(1)).toBe(', 1 pede resposta');
    expect(comentariosFalados(3)).toBe(', 3 pedem resposta');
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

  it('a recusa do pedido de uma pessoa (parte 3c): o pedido repetido, a escrita desligada e a permissão da Meta nas palavras da tela', () => {
    expect(erroDoPedido({ code: 'acao-duplicada', title: 'x' })).toContain('Já há um pedido em aberto para este comentário');
    expect(erroDoPedido({ code: 'escrita-desligada', title: 'x' })).toBe('Responder e ocultar comentários pelo Liame ainda não estão ligados para esta empresa.');
    expect(erroDoPedido({ code: 'sem-permissao-na-plataforma', title: 'x' })).toContain('Conecte a Meta de novo');
    expect(erroDoPedido({ code: 'outro', title: 'Título', detail: 'O detalhe.' })).toBe('O detalhe.');
  });

  it('o atendimento automático (parte 2e-2): a linha do topo, o botão de cada um, o estado, o que pede a confirmação, as recusas e o "Respondido sozinho"', () => {
    const r = (o: Partial<CommentAutoReplyResponse> = {}): CommentAutoReplyResponse => ({
      brand_id: 'b0000000-0000-4000-8000-000000000001',
      available: true,
      enabled: false,
      kinds: [],
      can_enable: true,
      can_disable: true,
      updated_at: null,
      updated_by: null,
      last_hour: 0,
      hourly_limit: 30,
      ...o,
    });
    expect(TIPOS_DO_AUTOMATICO.map((t) => t.id)).toEqual(['elogio', 'marcacao', 'pergunta']);
    expect(resumoDoAutomatico(r())).toContain('Desligado: nenhuma resposta sai sem a aprovação de uma pessoa.');
    expect(resumoDoAutomatico(r({ enabled: true, kinds: ['elogio'], last_hour: 1 }))).toBe('1 resposta sozinho nesta hora (no máximo 30). Reclamações e perguntas esperam você.');
    // Com "Perguntas" marcado, só as que ele não sabe com certeza esperam (parte 2e-3), no resumo e no aviso ao ligar.
    expect(avisoAoLigar(['elogio'])).toContain('reclamações e perguntas esperam você');
    expect(avisoAoLigar(['elogio', 'pergunta'])).toContain('a pergunta só quando ele sabe responder com certeza; reclamações esperam você');
    expect(resumoDoAutomatico(r({ enabled: true, kinds: ['elogio', 'pergunta'], last_hour: 2 }))).toBe('2 respostas sozinho nesta hora (no máximo 30). Reclamações e as perguntas sem certeza esperam você.');
    expect(resumoDoAutomatico(r({ enabled: true, kinds: ['elogio'], last_hour: 30 }))).toContain('o teto: o resto espera a hora seguinte');
    // O botão: ajustar (ligado), ver e ligar (quem liga), ver como funciona (quem só aprova).
    expect([botaoDoAutomatico(r({ enabled: true })), botaoDoAutomatico(r()), botaoDoAutomatico(r({ can_enable: false }))]).toEqual(['Ajustar', 'Ver e ligar', 'Ver como funciona']);
    expect(estadoDoAutomatico(r({ enabled: true, updated_by: { id: 'u', name: 'Rodrigo' }, updated_at: '2026-11-10T15:00:00Z' }))).toMatch(/^Ligado por Rodrigo em \d{2}\/\d{2}\/2026, às \d{2}:\d{2}\. Desligar vale na hora/);
    // Ligar e somar pedem a confirmação; desligar e tirar, não.
    const antes = { enabled: true, kinds: ['elogio'] };
    expect(pedeConfirmacao({ enabled: false, kinds: [] }, { enabled: true, kinds: ['elogio'] })).toBe(true);
    expect(pedeConfirmacao(antes, { enabled: true, kinds: ['elogio', 'marcacao'] })).toBe(true);
    expect(pedeConfirmacao(antes, { enabled: true, kinds: [] })).toBe(false);
    expect(pedeConfirmacao(antes, { enabled: false, kinds: ['elogio', 'marcacao'] })).toBe(false);
    expect(erroDoAutomatico({ code: 'so-dono-ou-administrador', title: 'x' })).toContain('Só o Dono ou um Administrador');
    expect(erroDoAutomatico({ code: 'outro', title: 'T', detail: 'D' })).toBe('D');
    // A resposta da marca que termina com o aviso é a automática.
    const resposta = (message: string, by_brand = true) => ({ id: 'r', author: 'misterburgers', by_brand, message, published_at: '2026-11-10T15:00:00Z', hidden: false });
    expect(respondidoSozinho({ replies: [resposta(`Obrigado!${COMMENT_AUTO_REPLY_NOTICE}`)] })).toBe(true);
    expect(respondidoSozinho({ replies: [resposta('Obrigado!')] })).toBe(false);
    expect(respondidoSozinho({ replies: [resposta(`Copiei${COMMENT_AUTO_REPLY_NOTICE}`, false)] })).toBe(false);
  });

  it('a lista vazia diz o que aparece em cada filtro; com a busca, a frase é a da busca', () => {
    expect(vazioDoFiltro('pedem', '').titulo).toBe('Nenhum comentário pede resposta agora');
    expect(vazioDoFiltro('todos', '').titulo).toBe('Nenhum comentário nos posts dos últimos 30 dias');
    expect(vazioDoFiltro('pedem', 'batata').titulo).toBe('Nenhum comentário com essa busca');
  });
});
