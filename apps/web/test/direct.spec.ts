import type { DirectConversation, DirectSettingsResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import {
  anexoDaMensagem,
  avisoDaLeitura,
  bytesDoTexto,
  erroDaResposta,
  estadoDoDirect,
  falta,
  FILTROS_DO_DIRECT,
  iniciaisDoArroba,
  janelaDaConversa,
  lidoDoDirect,
  previaDaConversa,
  quemEscreveu,
  recusaDaResposta,
  seloDaSituacao,
  situacaoDoEnvio,
  textoDoAtendimento,
  vazioDoDirect,
} from '@/components/direct/textos';
import { NAVEGACAO } from '@/components/shell/navegacao';
import { horaDe } from '@/lib/formato';

// A tela Direct (A6 · Z12, parte 3; mockups/prototipo-direct.html, P39 aprovado em 11/11/2026): o item do menu, o
// estado pelo ajuste da marca, as faixas da leitura, a janela da Meta de cada conversa, o que só o Instagram guarda, o
// espaço da resposta (1.000 bytes) e o envio pelo trilho. As horas saem pelo mesmo formatador da tela (o fuso local).

const agora = new Date('2026-11-11T17:05:00Z');
const daqui = (min: number) => new Date(agora.getTime() + min * 60_000).toISOString();
const ajuste = (o: Partial<DirectSettingsResponse> = {}): DirectSettingsResponse => ({
  brand_id: '00000000-0000-4000-8000-000000000001',
  available: true,
  enabled: true,
  no_other_app: true,
  can_enable: true,
  can_disable: true,
  account: { id: '00000000-0000-4000-8000-000000000002', username: 'misterburgers' },
  regem: 'livre',
  regem_checked_at: daqui(-3),
  reading: 'ok',
  read_at: daqui(-1),
  updated_at: null,
  updated_by: null,
  ...o,
});
const conversa = (o: Partial<DirectConversation> = {}): DirectConversation => ({
  id: 'aWdfAbc',
  username: 'ana.paula_rj',
  status: 'espera',
  closing: false,
  window_until: daqui(23 * 60 + 53),
  unread: true,
  last_message_at: daqui(-7),
  last_message: { direction: 'entrada', kind: 'texto', text: 'Oi! Vocês entregam na Penha?' },
  ...o,
});

describe('a tela Direct (A6 · Z12, parte 3)', () => {
  it('o item do menu fica logo depois de Comentários, para quem acompanha as campanhas, uma tela só nos dois modos', () => {
    const itens = NAVEGACAO.find((g) => g.id === 'agencia')!.itens;
    const i = itens.findIndex((x) => x.href === '/direct');
    expect(itens[i]).toEqual({ href: '/direct', rotulo: 'Direct', icone: 'instagram', permissao: 'campanhas.ver' });
    expect(itens[i - 1]!.href).toBe('/comentarios');
  });

  it('o estado vem do ajuste da marca, na ordem do protótipo', () => {
    expect(estadoDoDirect(ajuste({ available: false, account: null, enabled: false }))).toBe('desligada');
    expect(estadoDoDirect(ajuste({ account: null }))).toBe('sem_instagram');
    // O Regem atende: o Direct do Liame fica desligado nesta conta, mesmo ligado na marca (D-A6-107).
    expect(estadoDoDirect(ajuste({ regem: 'atende' }))).toBe('regem');
    expect(estadoDoDirect(ajuste({ enabled: false }))).toBe('ligar');
    expect(estadoDoDirect(ajuste({ reading: 'nunca', read_at: null }))).toBe('primeira');
    expect(estadoDoDirect(ajuste())).toBe('caixa');
    expect(estadoDoDirect(ajuste({ reading: 'falhou' }))).toBe('caixa');
  });

  it('as faixas da leitura: o Regem que não deu para conferir vem antes; sem permissão; a leitura que falhou; tudo certo, nenhuma', () => {
    const regem = avisoDaLeitura(ajuste({ regem: 'nao_conferido', reading: 'falhou' }), '@misterburgers', agora)!;
    expect(regem).toMatchObject({ tipo: 'atencao', titulo: 'Não deu para conferir com o Regem', contas: true });
    expect(regem.texto).toContain('o Liame não lê até conferir');
    const permissao = avisoDaLeitura(ajuste({ reading: 'sem_permissao' }), '@misterburgers', agora)!;
    expect(permissao).toMatchObject({ tipo: 'atencao', titulo: 'Falta a permissão de mensagens', contas: true });
    expect(permissao.texto).toContain('Direct do @misterburgers');
    const falhou = avisoDaLeitura(ajuste({ reading: 'falhou', read_at: daqui(-15) }), '@misterburgers', agora)!;
    expect(falhou).toMatchObject({ tipo: 'perigo', titulo: 'A Meta não respondeu na última leitura', contas: false });
    expect(falhou.texto).toBe(`As conversas abaixo são as da leitura de hoje, ${horaDe(daqui(-15))}. O Liame tenta de novo sozinho em alguns minutos.`);
    expect(avisoDaLeitura(ajuste({ reading: 'falhou', read_at: null }), '@x', agora)!.texto).toBe('O Liame tenta de novo sozinho em alguns minutos.');
    expect(avisoDaLeitura(ajuste(), '@misterburgers', agora)).toBeNull();
    expect(lidoDoDirect(daqui(-1), agora)).toBe('Lido há 1 min: o Liame lê a cada minuto');
    expect(lidoDoDirect(daqui(0), agora)).toBe('Lido agora há pouco: o Liame lê a cada minuto');
    expect(lidoDoDirect(null, agora)).toBe('Ainda não lido');
  });

  it('as situações que filtram, na ordem do protótipo, e o vazio de cada uma', () => {
    expect(FILTROS_DO_DIRECT).toEqual([
      ['espera', 'Esperam resposta'],
      ['fechando', 'Janela fechando'],
      ['respondida', 'Respondidas'],
      ['fora', 'Fora da janela'],
      ['todas', 'Todas'],
    ]);
    expect(vazioDoDirect('espera', '').titulo).toBe('Tudo respondido');
    expect(vazioDoDirect('fora', '').titulo).toBe('Nenhuma conversa aqui');
    expect(vazioDoDirect('todas', 'penha')).toEqual({ titulo: 'Nada com essa busca', texto: 'Nenhuma conversa com "penha" nesta situação.' });
  });

  it('a janela da Meta: até quando dá para responder, fechando, fechada, respondida e sem mensagem da pessoa; o selo da lista', () => {
    expect(janelaDaConversa(conversa(), agora)).toEqual({ nivel: 'ok', texto: `Dá para responder até amanhã, às ${horaDe(daqui(23 * 60 + 53))} (faltam 23 h 53 min).` });
    const fechando = conversa({ closing: true, window_until: daqui(40) });
    expect(janelaDaConversa(fechando, agora).nivel).toBe('atencao');
    expect(janelaDaConversa(fechando, agora).texto).toContain('(faltam 40 min). Depois, só quando a pessoa escrever de novo.');
    expect(seloDaSituacao(fechando, agora)).toEqual({ texto: 'Janela fecha em 40 min', classe: 'st--perigo' });
    const fora = conversa({ status: 'fora', window_until: daqui(-60) });
    expect(janelaDaConversa(fora, agora).nivel).toBe('fechada');
    expect(janelaDaConversa(fora, agora).texto).toContain(': 24 horas depois da última mensagem da pessoa.');
    expect(seloDaSituacao(fora, agora)).toEqual({ texto: 'Fora da janela', classe: 'st--espera' });
    expect(janelaDaConversa(conversa({ status: 'respondida' }), agora)).toEqual({ nivel: 'ok', texto: 'Respondida. Se a pessoa escrever de novo, a janela abre outra vez.' });
    expect(seloDaSituacao(conversa({ status: 'respondida' }), agora)).toEqual({ texto: 'Respondida', classe: 'st--espera' });
    expect(janelaDaConversa(conversa({ window_until: null }), agora).texto).toContain('o Instagram só deixa a marca responder depois');
    expect(seloDaSituacao(conversa(), agora)).toBeNull();
    expect(falta(daqui(120), agora)).toBe('faltam 2 h');
    expect(falta(daqui(-5), agora)).toBe('faltam 0 min');
  });

  it('quem escreveu, as iniciais e a prévia (a resposta da marca, o que só o Instagram guarda)', () => {
    expect(quemEscreveu('ana.paula_rj')).toBe('@ana.paula_rj');
    expect(quemEscreveu(null)).toBe('Quem escreveu');
    expect(iniciaisDoArroba('ana.paula_rj')).toBe('AP');
    expect(iniciaisDoArroba('pedroh')).toBe('PE');
    expect(iniciaisDoArroba(null)).toBe('?');
    expect(previaDaConversa(conversa())).toBe('Oi! Vocês entregam na Penha?');
    expect(previaDaConversa(conversa({ last_message: { direction: 'saida', kind: 'texto', text: 'Entregamos sim!' } }))).toBe('Você: Entregamos sim!');
    expect(previaDaConversa(conversa({ last_message: { direction: 'entrada', kind: 'imagem', text: '' } }))).toBe('Foto');
    expect(previaDaConversa(conversa({ last_message: { direction: 'entrada', kind: 'story_resposta', text: 'Que delícia!' } }))).toBe('Respondeu ao seu story: Que delícia!');
    expect(previaDaConversa(conversa({ last_message: null }))).toBe('Sem mensagem guardada');
    expect(anexoDaMensagem({ kind: 'texto' })).toBeNull();
    expect(anexoDaMensagem({ kind: 'story_mencao' })).toEqual({ texto: 'Marcou a marca no story', story: true });
    expect(anexoDaMensagem({ kind: 'algo_novo' })).toEqual({ texto: 'Uma mensagem que só o Instagram mostra', story: false });
  });

  it('o espaço da resposta é o da Meta, em bytes (a letra com acento conta 2), e a resposta vazia não sai', () => {
    expect(bytesDoTexto('Penha')).toBe(5);
    expect(bytesDoTexto('Você')).toBe(5);
    expect(recusaDaResposta('   ')).toBe('Escreva a resposta.');
    expect(recusaDaResposta('a'.repeat(1000))).toBeNull();
    expect(recusaDaResposta('é'.repeat(501))).toBe('A resposta passou do espaço da Meta (1.000). Encurte o texto.');
  });

  it('o atendimento aberto, a recusa de mandar e a situação do envio pelo trilho', () => {
    expect(textoDoAtendimento(null, agora)).toBe('Atendimento fechado: mandar pede a sua confirmação uma vez');
    expect(textoDoAtendimento(daqui(60), agora)).toMatch(/^Atendimento aberto até (\d{2}:\d{2}|amanhã, às \d{2}:\d{2})$/);
    expect(erroDaResposta({ status: 409, code: 'direct-desligado', title: 'x' })).toBe('O Direct está desligado nesta marca. Ligue de novo para responder.');
    const motivo = 'A janela da Meta fechou: a marca só responde até 24 horas depois da última mensagem da pessoa.';
    expect(erroDaResposta({ status: 422, code: 'plano-recusado', title: 'Não dá para pedir isto', detail: motivo })).toBe(motivo);
    expect(erroDaResposta({ status: 404, code: 'nao-encontrado', title: 'x' })).toBe('A conversa não está mais no Liame. A lista foi lida de novo.');
    expect(erroDaResposta({ status: 403, code: 'proibido', title: 'x' })).toBe('Responder no Direct é do Dono, dos Administradores e de quem aprova.');
    expect(situacaoDoEnvio('aprovada', null)).toEqual({ fim: false, ok: false, texto: 'enviando…' });
    expect(situacaoDoEnvio('executando', null).fim).toBe(false);
    expect(situacaoDoEnvio('executada', null)).toEqual({ fim: true, ok: true, texto: 'enviada' });
    expect(situacaoDoEnvio('falhou', 'Esta conversa está com outro app na Meta')).toEqual({ fim: true, ok: false, texto: 'Não saiu: Esta conversa está com outro app na Meta' });
    expect(situacaoDoEnvio('expirada', null)).toEqual({ fim: true, ok: false, texto: 'Não saiu. Tente de novo.' });
  });
});
