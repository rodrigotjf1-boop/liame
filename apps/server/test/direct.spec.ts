import { describe, expect, it } from 'vitest';
import { RESPOSTAS_PRONTAS } from '../src/ai/social/comentario.js';
import { conversasDoDirect, mensagensDaConversa, regemAtende, situacaoDaConversa, tipoDaMensagem } from '../src/direct/direct.js';
import { PASSOS_DA_RECLAMACAO, RESPOSTAS_DA_MENCAO, sugestaoNoDirect, tipoNoDirect } from '../src/direct/tipo-no-direct.js';

// O Direct do Instagram (A6, Z12, parte 1; P39, D-A6-107, D-A6-111 e D-A6-112), sem banco e sem rede: o que a leitura
// entende das respostas da Meta (a pessoa da conversa, de quem é cada mensagem, o tipo), a situação de cada conversa
// pela janela de 24 horas e a comparação com o que a Central do Regem atende.

const CONTA = { id: '17841400000000001', usuario: 'casabrasa' };

describe('o que a leitura entende da Meta', () => {
  it('a conversa: a pessoa é o participante que não é a marca (pelo id ou pelo @); sem pessoa ou sem data, fica de fora', () => {
    const r = conversasDoDirect(
      {
        data: [
          { id: 'c1', updated_time: '2026-11-11T13:58:00+0000', participants: { data: [{ id: CONTA.id, username: 'casabrasa' }, { id: '991', username: 'ana.paula_rj' }] } },
          // A marca com outro id (o login do Instagram e o do Facebook podem dar ids diferentes): conta pelo @.
          { id: 'c2', updated_time: '2026-11-11T12:00:00+0000', participants: { data: [{ id: 'outro', username: 'CasaBrasa' }, { id: '992' }] } },
          { id: 'c3', updated_time: '2026-11-11T12:00:00+0000', participants: { data: [{ id: CONTA.id, username: 'casabrasa' }] } },
          { id: 'c4', participants: { data: [{ id: '993' }] } },
        ],
      },
      CONTA,
    );
    expect(r).toEqual([
      { conversation_id: 'c1', meta_updated_at: '2026-11-11T13:58:00.000Z', participant_id: '991', username: 'ana.paula_rj' },
      { conversation_id: 'c2', meta_updated_at: '2026-11-11T12:00:00.000Z', participant_id: '992', username: null },
    ]);
  });

  it('as mensagens: de quem é, o tipo e o texto, da mais velha para a mais nova; sem id ou sem data, fica de fora', () => {
    const r = mensagensDaConversa(
      {
        messages: {
          data: [
            { id: 'm3', created_time: '2026-11-11T13:10:00+0000', from: { id: CONTA.id }, message: 'Tem sim!' },
            { id: 'm2', created_time: '2026-11-11T13:05:00+0000', from: { id: '991' }, attachments: { data: [{ type: 'image' }] } },
            { id: 'm1', created_time: '2026-11-11T13:00:00+0000', from: { id: '991' }, message: 'Tem combo pra 2?' },
            { created_time: '2026-11-11T13:00:00+0000', from: { id: '991' }, message: 'sem id' },
          ],
        },
      },
      CONTA,
    );
    expect(r.map((m) => [m.message_id, m.direction, m.kind, m.body])).toEqual([
      ['m1', 'entrada', 'texto', 'Tem combo pra 2?'],
      ['m2', 'entrada', 'imagem', ''],
      ['m3', 'saida', 'texto', 'Tem sim!'],
    ]);
    expect(mensagensDaConversa({ messages: { data: [{ id: 'x', created_time: '2026-11-11T13:00:00+0000', from: { id: '9' }, message: 'a'.repeat(5000) }] } }, CONTA)[0]!.body).toHaveLength(4000);
  });

  it('o tipo: o story (resposta e menção), cada anexo, o que a API não mostra e o texto', () => {
    expect(tipoDaMensagem({ story: { reply_to: { id: '1' } }, message: 'Que delícia' })).toBe('story_resposta');
    expect(tipoDaMensagem({ story: { mention: { id: '1' } } })).toBe('story_mencao');
    expect(['image', 'video', 'audio', 'file', 'share', 'ig_reel'].map((type) => tipoDaMensagem({ attachments: { data: [{ type }] } }))).toEqual([
      'imagem',
      'video',
      'audio',
      'arquivo',
      'compartilhamento',
      'reel',
    ]);
    expect(tipoDaMensagem({ is_unsupported: true })).toBe('sem_suporte');
    expect(tipoDaMensagem({ attachments: { data: [{ type: 'algo_novo' }] } })).toBe('sem_suporte');
    expect(tipoDaMensagem({ message: 'oi' })).toBe('texto');
  });
});

describe('a situação da conversa pela janela da Meta (D-A6-111)', () => {
  const agora = new Date('2026-11-11T14:05:00Z');

  it('espera resposta até 24 horas depois da última mensagem da pessoa; fechando nas 2 últimas horas; depois, fora da janela', () => {
    expect(situacaoDaConversa({ last_direction: 'entrada', last_inbound_at: '2026-11-11T13:58:00Z', concluded_at: null }, agora)).toEqual({
      situacao: 'espera',
      janelaAte: '2026-11-12T13:58:00.000Z',
      fechando: false,
    });
    expect(situacaoDaConversa({ last_direction: 'entrada', last_inbound_at: '2026-11-10T14:45:00Z', concluded_at: null }, agora)).toMatchObject({ situacao: 'espera', fechando: true });
    expect(situacaoDaConversa({ last_direction: 'entrada', last_inbound_at: '2026-11-10T11:00:00Z', concluded_at: null }, agora)).toMatchObject({ situacao: 'fora' });
  });

  it('respondida: a última é da marca, ou a conversa foi concluída depois da última mensagem da pessoa (a nova reabre)', () => {
    expect(situacaoDaConversa({ last_direction: 'saida', last_inbound_at: '2026-11-11T09:40:00Z', concluded_at: null }, agora).situacao).toBe('respondida');
    expect(situacaoDaConversa({ last_direction: 'entrada', last_inbound_at: '2026-11-11T08:12:00Z', concluded_at: '2026-11-11T09:00:00Z' }, agora).situacao).toBe('respondida');
    expect(situacaoDaConversa({ last_direction: 'entrada', last_inbound_at: '2026-11-11T10:00:00Z', concluded_at: '2026-11-11T09:00:00Z' }, agora).situacao).toBe('espera');
  });
});

describe('o Regem atende o Direct desta conta? (D-A6-107)', () => {
  it('pelo id da conta profissional ou, se ele não bater, pelo @ (sem diferença de maiúscula nem do "@")', () => {
    expect(regemAtende({ instagram: [{ ig_user_id: CONTA.id, usuario: null }], messenger: [] }, CONTA)).toBe(true);
    expect(regemAtende({ instagram: [{ ig_user_id: 'outro-id', usuario: '@CasaBrasa' }], messenger: [] }, CONTA)).toBe(true);
    expect(regemAtende({ instagram: [{ ig_user_id: 'outro-id', usuario: 'outra.loja' }], messenger: [{ pagina_id: '1' }] }, CONTA)).toBe(false);
    expect(regemAtende({ instagram: [], messenger: [] }, CONTA)).toBe(false);
  });
});

// A6 · Z12, parte 4a (D-A6-118): o tipo da conversa pela regra dos comentários e a sugestão sem IA.
describe('o tipo da conversa e a sugestão sem IA (parte 4a)', () => {
  const t = (body: string, kind = 'texto') => ({ kind, body });
  it('o tipo junta o que a pessoa mandou desde a última resposta da marca; a marcação de amigo não vale no Direct; a menção no story sem texto é "menção"', () => {
    expect(tipoNoDirect([t('Oi!'), t('Vocês entregam na Penha?')], CONTA.usuario)).toBe('pergunta');
    // A reclamação vence a pergunta, como nos comentários.
    expect(tipoNoDirect([t('Chegou frio e faltou a batata.'), t('Vão devolver o dinheiro?')], CONTA.usuario)).toBe('reclamacao');
    expect(tipoNoDirect([t('Que delícia esse smash!', 'story_resposta')], CONTA.usuario)).toBe('elogio');
    expect(tipoNoDirect([t('Ganhe seguidores reais hoje! Clique no link')], CONTA.usuario)).toBe('golpe');
    expect(tipoNoDirect([t('', 'story_mencao')], CONTA.usuario)).toBe('mencao');
    // O texto decide antes da menção: a menção com uma pergunta é pergunta.
    expect(tipoNoDirect([t('', 'story_mencao'), t('Vocês abrem domingo?')], CONTA.usuario)).toBe('pergunta');
    expect(tipoNoDirect([t('@amigo olha isso')], CONTA.usuario)).toBeNull();
    expect(tipoNoDirect([t('', 'imagem')], CONTA.usuario)).toBeNull();
    expect(tipoNoDirect([], CONTA.usuario)).toBeNull();
  });

  it('a sugestão: o agradecimento pronto do elogio e da menção (o mesmo para a mesma mensagem), os passos da reclamação, o golpe; a pergunta espera o Social media', () => {
    const elogio = sugestaoNoDirect('elogio', 'mid.1')!;
    expect(elogio.kind).toBe('pronta');
    expect(RESPOSTAS_PRONTAS.elogio).toContain(elogio.text);
    expect(sugestaoNoDirect('elogio', 'mid.1')).toEqual(elogio);
    const mencao = sugestaoNoDirect('mencao', 'mid.2')!;
    expect(mencao.kind).toBe('pronta');
    expect(RESPOSTAS_DA_MENCAO).toContain(mencao.text);
    // As respostas prontas variam entre as mensagens.
    expect(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => sugestaoNoDirect('mencao', s)!.text)).size).toBeGreaterThan(1);
    expect(sugestaoNoDirect('reclamacao', 'mid.3')).toEqual({ kind: 'passos', text: null, steps: [...PASSOS_DA_RECLAMACAO] });
    expect(sugestaoNoDirect('golpe', 'mid.4')).toEqual({ kind: 'golpe', text: null, steps: [] });
    for (const tipo of ['pergunta', 'ofensivo', null] as const) expect(sugestaoNoDirect(tipo, 'mid.5'), String(tipo)).toBeNull();
    // Nenhuma resposta pronta passa do espaço da Meta nem promete nada.
    for (const r of RESPOSTAS_DA_MENCAO) {
      expect(new TextEncoder().encode(r).length).toBeLessThan(1000);
      expect(r).not.toMatch(/R\$|\d|desconto|brinde|reembolso|cupom/i);
    }
  });
});
