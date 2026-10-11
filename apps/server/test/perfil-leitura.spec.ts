import { describe, expect, it } from 'vitest';
import { linhaDaAvaliacao } from '../src/avaliacoes/perfil-store.js';
import {
  DATASETS_DO_PERFIL,
  desdeDasAvaliacoes,
  DIAS_DE_AVALIACOES,
  DIAS_ENTRE_RELEITURAS,
  DIAS_RECONFERIDOS,
  esperaDaFalhaDoPerfil,
  HORAS_ENTRE_RECONFERENCIAS,
  INTERVALO_DO_PERFIL_MIN,
  janelaDosNumeros,
  MAXIMO_NA_PRIMEIRA_LEITURA,
  MAXIMO_NA_RECONFERENCIA,
  MAXIMO_NAS_SEGUINTES,
  planoDaLeitura,
} from '../src/avaliacoes/sincronizador-do-perfil.js';
import { METRICAS_CANONICAS_DO_PERFIL, type AvaliacaoLida } from '../src/connectors/google-business/perfil-google.js';

// A6 · Z1 (parte c), sem rede e sem banco: as regras da leitura do Perfil da Empresa no Google. Quando ler de novo
// depois de uma falha, desde quando ler as avaliações, a janela dos números, e a avaliação lida virando a linha que
// o banco aceita.

const MIN = 60_000;
const HORA = 60 * MIN;
const DIA = 24 * HORA;
const AGORA = new Date('2026-10-11T15:00:00.000Z');

describe('leitura do Perfil da Empresa no Google: as regras (A6 · Z1)', () => {
  it('os dois conjuntos: as avaliações de hora em hora e os números uma vez por dia', () => {
    expect([...DATASETS_DO_PERFIL]).toEqual(['avaliacoes_perfil', 'numeros_perfil']);
    expect(INTERVALO_DO_PERFIL_MIN).toEqual({ avaliacoes_perfil: 60, numeros_perfil: 1440 });
    expect(MAXIMO_NA_PRIMEIRA_LEITURA).toBeGreaterThan(MAXIMO_NAS_SEGUINTES);
    // O banco só aceita as nove métricas que o conector conhece (a restrição da migration 0068).
    expect([...METRICAS_CANONICAS_DO_PERFIL].sort()).toEqual([
      'bookings', 'call_clicks', 'direction_requests', 'menu_clicks', 'profile_views_maps_desktop', 'profile_views_maps_mobile',
      'profile_views_search_desktop', 'profile_views_search_mobile', 'website_clicks',
    ]);
  });

  it('A6-2: no limite, a espera é a que o Google pede, com meia hora no mínimo, dobrando a cada falha seguida, até 12 horas', () => {
    const limite = (esperarMs: number | null, falhas: number) => esperaDaFalhaDoPerfil({ tipo: 'limite', esperarMs }, falhas);
    expect(limite(null, 1)).toBe(30 * MIN);
    expect(limite(60_000, 1)).toBe(30 * MIN);
    expect(limite(2 * HORA, 1)).toBe(2 * HORA);
    expect([limite(null, 2), limite(null, 3), limite(null, 4), limite(null, 5), limite(null, 6), limite(null, 30)]).toEqual([HORA, 2 * HORA, 4 * HORA, 8 * HORA, 12 * HORA, 12 * HORA]);
    // O pedido do Google maior que o teto do Liame vale: quem manda na cota é ele.
    expect(limite(20 * HORA, 1)).toBe(20 * HORA);
    expect(limite(null, 0)).toBe(30 * MIN);
  });

  it('as outras falhas: sem permissão, um dia; defeito do pedido ou nosso, 6 horas no mínimo; a queda passageira, meia hora dobrando', () => {
    expect(esperaDaFalhaDoPerfil({ tipo: 'permissao', esperarMs: null }, 1)).toBe(DIA);
    expect(esperaDaFalhaDoPerfil({ tipo: 'permissao', esperarMs: 5_000 }, 9)).toBe(DIA);
    expect(esperaDaFalhaDoPerfil({ tipo: 'definitivo', esperarMs: null }, 1)).toBe(6 * HORA);
    expect(esperaDaFalhaDoPerfil({ tipo: 'interno', esperarMs: null }, 1)).toBe(6 * HORA);
    expect(esperaDaFalhaDoPerfil({ tipo: 'definitivo', esperarMs: null }, 6)).toBe(12 * HORA);
    expect(esperaDaFalhaDoPerfil({ tipo: 'transitorio', esperarMs: null }, 1)).toBe(30 * MIN);
    expect(esperaDaFalhaDoPerfil({ tipo: 'transitorio', esperarMs: null }, 2)).toBe(HORA);
    expect(esperaDaFalhaDoPerfil({ tipo: 'transitorio', esperarMs: 90_000 }, 1)).toBe(90_000);
    expect(esperaDaFalhaDoPerfil({ tipo: 'circuito_aberto', esperarMs: 45_000 }, 3)).toBe(45_000);
    expect(esperaDaFalhaDoPerfil({ tipo: 'autenticacao', esperarMs: null }, 1)).toBe(30 * MIN);
  });

  it('desde quando ler as avaliações: 12 meses na primeira leitura; depois, o começo da anterior menos uma hora, nunca além dos 12 meses', () => {
    const haUmAno = new Date(AGORA.getTime() - DIAS_DE_AVALIACOES * DIA);
    expect(desdeDasAvaliacoes({}, AGORA)).toEqual(haUmAno);
    // Sem a primeira leitura terminada, vale a janela inteira, mesmo com um corte anotado.
    expect(desdeDasAvaliacoes({ lido_ate: '2026-10-11T14:00:00.000Z' }, AGORA)).toEqual(haUmAno);
    expect(desdeDasAvaliacoes({ primeira_em: '2026-10-01T00:00:00.000Z', lido_ate: '2026-10-11T14:00:00.000Z' }, AGORA)).toEqual(new Date('2026-10-11T13:00:00.000Z'));
    // A loja ficou muito tempo sem ler: a leitura não recua além do que o Liame guarda.
    expect(desdeDasAvaliacoes({ primeira_em: '2024-01-01T00:00:00.000Z', lido_ate: '2024-01-01T00:00:00.000Z' }, AGORA)).toEqual(haUmAno);
    expect(desdeDasAvaliacoes({ primeira_em: '2026-10-01T00:00:00.000Z', lido_ate: 'ontem' }, AGORA)).toEqual(haUmAno);
  });

  // A referência do Google não diz que responder muda a data da AVALIAÇÃO (a resposta tem a data dela), e a leitura de
  // hora em hora para na primeira avaliação que não mudou. Por isso a leitura não depende disso: reconfere 45 dias por
  // dia e relê os 12 meses por semana.
  it('qual leitura fazer: a de hora em hora, a reconferência de 45 dias uma vez por dia e a releitura dos 12 meses uma vez por semana', () => {
    const ha = (ms: number) => new Date(AGORA.getTime() - ms).toISOString();
    const haUmAno = new Date(AGORA.getTime() - DIAS_DE_AVALIACOES * DIA);
    const ha45 = new Date(AGORA.getTime() - DIAS_RECONFERIDOS * DIA);
    expect([DIAS_RECONFERIDOS, HORAS_ENTRE_RECONFERENCIAS, DIAS_ENTRE_RELEITURAS]).toEqual([45, 24, 7]);
    // A reconferência cobre os 30 dias em que a avaliação sem resposta avisa na Atenção, com folga.
    expect(DIAS_RECONFERIDOS).toBeGreaterThan(30);
    expect(MAXIMO_NA_PRIMEIRA_LEITURA).toBeGreaterThan(MAXIMO_NA_RECONFERENCIA);
    expect(MAXIMO_NA_RECONFERENCIA).toBeGreaterThan(MAXIMO_NAS_SEGUINTES);

    expect(planoDaLeitura({}, AGORA)).toEqual({ tipo: 'primeira', desde: haUmAno, maximo: MAXIMO_NA_PRIMEIRA_LEITURA });

    // Uma hora depois da primeira leitura: só o que mudou.
    const lida = { primeira_em: ha(HORA), lido_ate: ha(HORA), reconferido_em: ha(HORA), relido_em: ha(HORA) };
    expect(planoDaLeitura(lida, AGORA)).toEqual({ tipo: 'seguinte', desde: new Date(AGORA.getTime() - 2 * HORA), maximo: MAXIMO_NAS_SEGUINTES });

    // Um minuto antes de fechar o dia ainda é a de hora em hora; no dia fechado, a reconferência.
    const quase = { primeira_em: ha(3 * DIA), lido_ate: ha(HORA), reconferido_em: ha(DIA - MIN), relido_em: ha(3 * DIA) };
    expect(planoDaLeitura(quase, AGORA).tipo).toBe('seguinte');
    expect(planoDaLeitura({ ...quase, reconferido_em: ha(DIA) }, AGORA)).toEqual({ tipo: 'reconferencia', desde: ha45, maximo: MAXIMO_NA_RECONFERENCIA });

    // Na semana fechada, a releitura dos 12 meses (e ela vem antes da reconferência).
    expect(planoDaLeitura({ ...quase, relido_em: ha(7 * DIA - MIN), reconferido_em: ha(HORA) }, AGORA).tipo).toBe('seguinte');
    expect(planoDaLeitura({ ...quase, relido_em: ha(7 * DIA), reconferido_em: ha(2 * DIA) }, AGORA)).toEqual({ tipo: 'releitura', desde: haUmAno, maximo: MAXIMO_NA_PRIMEIRA_LEITURA });

    // A loja ligada antes de as marcas existirem: vale a data da primeira leitura, e ela converge sozinha.
    expect(planoDaLeitura({ primeira_em: ha(2 * HORA), lido_ate: ha(HORA) }, AGORA).tipo).toBe('seguinte');
    expect(planoDaLeitura({ primeira_em: ha(2 * DIA), lido_ate: ha(HORA) }, AGORA).tipo).toBe('reconferencia');
    expect(planoDaLeitura({ primeira_em: ha(10 * DIA), lido_ate: ha(HORA) }, AGORA).tipo).toBe('releitura');

    // A marca que não é data conta como vencida: a leitura maior é devida.
    expect(planoDaLeitura({ ...lida, reconferido_em: 'ontem' }, AGORA).tipo).toBe('reconferencia');
    expect(planoDaLeitura({ ...lida, relido_em: 'semana passada' }, AGORA).tipo).toBe('releitura');

    // A rotina ficou 60 dias parada: a reconferência não lê menos do que a leitura de hora em hora leria.
    const parada = { primeira_em: ha(61 * DIA), lido_ate: ha(60 * DIA), reconferido_em: ha(60 * DIA), relido_em: ha(DIA) };
    expect(planoDaLeitura(parada, AGORA)).toEqual({ tipo: 'reconferencia', desde: new Date(AGORA.getTime() - 60 * DIA - HORA), maximo: MAXIMO_NA_RECONFERENCIA });
  });

  it('a janela dos números vai até ontem: 90 dias na primeira leitura e 10 nas seguintes', () => {
    expect(janelaDosNumeros({}, AGORA)).toEqual({ inicio: '2026-07-13', fim: '2026-10-10' });
    expect(janelaDosNumeros({ primeira_em: '2026-10-01T00:00:00.000Z' }, AGORA)).toEqual({ inicio: '2026-10-01', fim: '2026-10-10' });
    // Na virada do mês e do ano.
    expect(janelaDosNumeros({ primeira_em: 'x' }, new Date('2027-01-01T00:30:00.000Z'))).toEqual({ inicio: '2026-12-22', fim: '2026-12-31' });
  });

  it('a avaliação lida vira a linha que o banco aceita: sem o caractere nulo, com o texto no tamanho, a resposta inteira ou nenhuma, e as datas como datas', () => {
    const nulo = String.fromCharCode(0);
    const base: AvaliacaoLida = { id: 'rev-1', estrelas: 4, texto: 'Bom.', criadaEm: '2026-10-01T12:00:00.000Z', atualizadaEm: '2026-10-02T12:00:00.000Z', resposta: null };
    const semId = (l: ReturnType<typeof linhaDaAvaliacao>) => (l ? { ...l, new_id: 'id' } : null);

    expect(semId(linhaDaAvaliacao(base))).toEqual({
      new_id: 'id', external_id: 'rev-1', stars: 4, comment: 'Bom.', reviewed_at: '2026-10-01T12:00:00.000Z', changed_at: '2026-10-02T12:00:00.000Z',
      reply_text: null, reply_changed_at: null, reply_state: null, reply_violation: null,
    });
    // Cada linha nasce com um id novo.
    expect(linhaDaAvaliacao(base)!.new_id).not.toBe(linhaDaAvaliacao(base)!.new_id);

    const comResposta = linhaDaAvaliacao({ ...base, resposta: { texto: ' Obrigado! ', atualizadaEm: '2026-10-03T09:00:00Z', situacao: 'recusada', violacao: 'OFF_TOPIC' } })!;
    expect([comResposta.reply_text, comResposta.reply_changed_at, comResposta.reply_state, comResposta.reply_violation]).toEqual(['Obrigado!', '2026-10-03T09:00:00.000Z', 'recusada', 'OFF_TOPIC']);
    // A resposta sem texto (só espaço ou caractere nulo) não é uma resposta: nem a situação nem o motivo ficam.
    const semTexto = linhaDaAvaliacao({ ...base, resposta: { texto: ` ${nulo} `, atualizadaEm: '2026-10-03T09:00:00Z', situacao: 'aprovada', violacao: 'SPAM' } })!;
    expect([semTexto.reply_text, semTexto.reply_changed_at, semTexto.reply_state, semTexto.reply_violation]).toEqual([null, null, null, null]);
    // A data da resposta que não é data fica vazia; a resposta fica.
    expect(linhaDaAvaliacao({ ...base, resposta: { texto: 'ok', atualizadaEm: 'ontem', situacao: 'pendente', violacao: null } })).toMatchObject({ reply_text: 'ok', reply_changed_at: null, reply_state: 'pendente' });

    expect(linhaDaAvaliacao({ ...base, texto: `Chegou${nulo} frio${nulo}.` })!.comment).toBe('Chegou frio.');
    expect(linhaDaAvaliacao({ ...base, texto: ` ${nulo} ` })!.comment).toBeNull();
    expect(linhaDaAvaliacao({ ...base, texto: 'x'.repeat(7000) })!.comment).toHaveLength(5000);
    expect(linhaDaAvaliacao({ ...base, id: `a${nulo}b` })!.external_id).toBe('ab');
    expect(linhaDaAvaliacao({ ...base, id: 'i'.repeat(300) })!.external_id).toHaveLength(200);
    // Sem id, ou com data que não é data, a avaliação não entra.
    expect(linhaDaAvaliacao({ ...base, id: ` ${nulo} ` })).toBeNull();
    expect(linhaDaAvaliacao({ ...base, criadaEm: 'ontem' })).toBeNull();
    expect(linhaDaAvaliacao({ ...base, atualizadaEm: '2026-13-01T00:00:00Z' })).toBeNull();
  });
});
