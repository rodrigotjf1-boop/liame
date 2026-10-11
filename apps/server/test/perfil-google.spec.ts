import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ErroConector } from '../src/connectors/cliente-http.js';
import { dataValida } from '../src/connectors/janela.js';
import {
  avaliacaoDoGoogle,
  BYTES_DA_RESPOSTA_NO_GOOGLE,
  idDaAvaliacao,
  METRICAS_CANONICAS_DO_PERFIL,
  METRICAS_DO_PERFIL,
  notaMedia,
  numerosDoPerfil,
  respostaDoGoogle,
  SITUACOES_DA_RESPOSTA,
  TAMANHO_DA_RESPOSTA,
  TAMANHO_DO_TEXTO,
  textoDaResposta,
  totalDeAvaliacoes,
} from '../src/connectors/google-business/perfil-google.js';

// A6 · Z1 (parte a), sem rede e sem banco: o que o Liame tira das respostas da API do Perfil da Empresa no Google. A
// avaliação sai sem o nome e sem a foto de quem avaliou (critério A6-1: o tipo não tem campo para eles), e os números
// do perfil saem por dia, sem inventar zero no dia que o Google ainda não fechou.

const AVALIACAO = {
  name: 'accounts/111/locations/222/reviews/AbCdEf',
  reviewId: 'AbCdEf',
  reviewer: { displayName: 'Fulana de Tal', profilePhotoUrl: 'https://lh3.googleusercontent.com/a/foto-da-fulana', isAnonymous: false },
  starRating: 'TWO',
  comment: '  O lanche chegou frio.  ',
  createTime: '2026-10-08T22:15:03.123456Z',
  updateTime: '2026-10-09T01:02:03Z',
  reviewMediaItems: [{ name: 'accounts/111/locations/222/media/x', googleUrl: 'https://lh3.googleusercontent.com/p/foto-do-prato' }],
  reviewReplyUrl: 'https://business.google.com/reviews/l/222/r/AbCdEf',
};

describe('Perfil no Google: a avaliação que o Liame guarda (A6 · Z1)', () => {
  it('a nota, as datas e o texto; nenhum campo para o nome nem para a foto de quem avaliou', () => {
    const a = avaliacaoDoGoogle(AVALIACAO);
    expect(a).toEqual({ id: 'AbCdEf', estrelas: 2, texto: 'O lanche chegou frio.', criadaEm: '2026-10-08T22:15:03.123Z', atualizadaEm: '2026-10-09T01:02:03.000Z', resposta: null });
    // Critério A6-1: nada do que identifica quem avaliou, nem a foto anexada, sobra no que sai.
    const tudo = JSON.stringify(a);
    for (const proibido of ['Fulana', 'foto-da-fulana', 'foto-do-prato', 'googleusercontent', 'reviewer', 'displayName', 'profilePhotoUrl']) expect(tudo, proibido).not.toContain(proibido);
    expect(Object.keys(a!).sort()).toEqual(['atualizadaEm', 'criadaEm', 'estrelas', 'id', 'resposta', 'texto']);
  });

  it('cada nota de 1 a 5; a avaliação só com a nota; a que não dá para classificar fica de fora', () => {
    expect(['ONE', 'TWO', 'THREE', 'FOUR', 'FIVE'].map((starRating) => avaliacaoDoGoogle({ ...AVALIACAO, starRating })!.estrelas)).toEqual([1, 2, 3, 4, 5]);
    expect(avaliacaoDoGoogle({ ...AVALIACAO, comment: undefined })).toMatchObject({ texto: null, estrelas: 2 });
    expect(avaliacaoDoGoogle({ ...AVALIACAO, comment: '   ' })!.texto).toBeNull();
    // Sem a data de mudança, vale a de criação.
    expect(avaliacaoDoGoogle({ ...AVALIACAO, updateTime: undefined })!.atualizadaEm).toBe('2026-10-08T22:15:03.123Z');
    for (const ruim of [null, 'texto', {}, { ...AVALIACAO, reviewId: '' }, { ...AVALIACAO, starRating: 'STAR_RATING_UNSPECIFIED' }, { ...AVALIACAO, starRating: 6 }, { ...AVALIACAO, createTime: 'ontem' }, { ...AVALIACAO, reviewId: 'x'.repeat(201) }]) {
      expect(avaliacaoDoGoogle(ruim), JSON.stringify(ruim)?.slice(0, 60)).toBeNull();
    }
    // O texto muito longo é cortado no que o Liame aceita guardar.
    expect(avaliacaoDoGoogle({ ...AVALIACAO, comment: 'a'.repeat(TAMANHO_DO_TEXTO + 50) })!.texto).toHaveLength(TAMANHO_DO_TEXTO);
  });

  it('a resposta, com a situação que o Google diz: pendente, aprovada, recusada (com o motivo dele) ou desconhecida', () => {
    const com = (reviewReply: unknown) => avaliacaoDoGoogle({ ...AVALIACAO, reviewReply })!.resposta;
    expect(com({ comment: 'Sentimos muito. Vamos rever a entrega.', updateTime: '2026-10-09T12:00:00Z', reviewReplyState: 'APPROVED' })).toEqual({
      texto: 'Sentimos muito. Vamos rever a entrega.',
      atualizadaEm: '2026-10-09T12:00:00.000Z',
      situacao: 'aprovada',
      violacao: null,
    });
    expect(com({ comment: 'Obrigado!', reviewReplyState: 'PENDING' })).toMatchObject({ situacao: 'pendente', atualizadaEm: null });
    // O motivo é um código do Google; o teste usa um código de exemplo, não um valor da lista dele.
    expect(com({ comment: 'Ligue para nós.', reviewReplyState: 'REJECTED', policyViolation: 'CODIGO_DE_EXEMPLO' })).toMatchObject({ situacao: 'recusada', violacao: 'CODIGO_DE_EXEMPLO' });
    // Situação nova ou ausente não vira "aprovada" por engano; o motivo que não é um código não é guardado.
    expect(com({ comment: 'Obrigado!', reviewReplyState: 'ALGO_NOVO' })!.situacao).toBe('desconhecida');
    expect(com({ comment: 'Obrigado!' })!.situacao).toBe('desconhecida');
    expect(com({ comment: 'Obrigado!', reviewReplyState: 'REJECTED', policyViolation: 'texto livre com espaço' })!.violacao).toBeNull();
    // Resposta sem texto não é resposta.
    expect(com({ comment: '  ', reviewReplyState: 'APPROVED' })).toBeNull();
    expect(com('texto')).toBeNull();
    expect(SITUACOES_DA_RESPOSTA).toEqual(['pendente', 'aprovada', 'recusada', 'desconhecida']);
  });

  it('Z2: a resposta como o Google a devolve ao gravar; sem o texto, não há o que ler', () => {
    expect(respostaDoGoogle({ comment: ' Obrigado pela visita! ', updateTime: '2026-10-11T12:00:00Z', reviewReplyState: 'PENDING' })).toEqual({
      texto: 'Obrigado pela visita!',
      atualizadaEm: '2026-10-11T12:00:00.000Z',
      situacao: 'pendente',
      violacao: null,
    });
    expect(respostaDoGoogle({ comment: 'Ligue para nós.', reviewReplyState: 'REJECTED', policyViolation: 'CODIGO_DE_EXEMPLO' })).toMatchObject({ situacao: 'recusada', violacao: 'CODIGO_DE_EXEMPLO' });
    for (const ruim of [null, undefined, 'texto', {}, { comment: '   ' }, { reviewReplyState: 'APPROVED' }]) expect(respostaDoGoogle(ruim), JSON.stringify(ruim)).toBeNull();
  });

  it('Z2: o texto que o Liame publica vai inteiro ou não vai: 1.500 caracteres no máximo, dentro dos 4.096 bytes do Google', () => {
    expect([TAMANHO_DA_RESPOSTA, BYTES_DA_RESPOSTA_NO_GOOGLE]).toEqual([1500, 4096]);
    expect(textoDaResposta('  Obrigado pela visita!  ')).toBe('Obrigado pela visita!');
    // O caractere nulo sai; as quebras de linha do meio ficam.
    expect(textoDaResposta(`Obri${String.fromCharCode(0)}gado.\nVolte sempre.`)).toBe('Obrigado.\nVolte sempre.');
    expect(textoDaResposta('x'.repeat(1500))).toHaveLength(1500);
    // Com acento, 1.500 caracteres são 3.000 bytes: cabem.
    expect(textoDaResposta('ç'.repeat(1500))).not.toBeNull();
    // O emoji conta como um caractere e pesa 4 bytes: 1.000 cabem (4.000 bytes), 1.100 não (4.400).
    expect(textoDaResposta('😀'.repeat(1000))).not.toBeNull();
    expect(textoDaResposta('😀'.repeat(1100))).toBeNull();
    for (const ruim of ['', '   ', String.fromCharCode(0), 'x'.repeat(1501), null, undefined, 42, { comment: 'x' }]) expect(textoDaResposta(ruim), String(ruim).slice(0, 20)).toBeNull();
  });

  it('Z2: o id da avaliação só entra num endereço com letras, dígitos, hífen e sublinhado', () => {
    for (const bom of ['AbCdEf', 'rev-8', 'A_b-9', 'a', 'a'.repeat(200)]) expect(idDaAvaliacao(bom), bom).toBe(true);
    for (const ruim of ['', 'a'.repeat(201), 'rev/8', '..', '.', 'rev 8', 'rev?x=1', 'rev#1', 'rev.8', 'rév', 'rev%2F8', 'rev\n8', null, undefined, 8, ['rev-8']]) expect(idDaAvaliacao(ruim), String(ruim)).toBe(false);
  });

  it('a nota média e o total da loja, só quando fazem sentido', () => {
    expect([notaMedia(4.6349998), notaMedia(5), notaMedia(1)]).toEqual([4.63, 5, 1]);
    for (const ruim of [0, 5.1, '4.6', null, undefined, Number.NaN]) expect(notaMedia(ruim)).toBeNull();
    expect([totalDeAvaliacoes(0), totalDeAvaliacoes(1284)]).toEqual([0, 1284]);
    for (const ruim of [-1, 12.5, '12', null, undefined]) expect(totalDeAvaliacoes(ruim)).toBeNull();
  });
});

describe('a janela dos conectores: só data de verdade vai para o endereço', () => {
  it('fora do formato, impossível no calendário e fora da faixa: sempre o erro do conector, nunca outro', () => {
    expect(dataValida('google_business', '2026-10-01')).toBe('2026-10-01');
    expect(dataValida('google_business', '2028-02-29')).toBe('2028-02-29');
    for (const ruim of ['2026-10-1', '01/10/2026', "2026-10-01' or 1=1", '', '2026-02-30', '2027-02-29', '2026-13-01', '2026-10-32', '2026-00-10']) {
      let erro: unknown = null;
      try {
        dataValida('google_business', ruim);
      } catch (err) {
        erro = err;
      }
      // ERR-130: o mês 13 estourava um RangeError, que quem chama não sabe classificar.
      expect(erro, ruim).toBeInstanceOf(ErroConector);
      expect((erro as ErroConector).tipo, ruim).toBe('definitivo');
    }
  });
});

describe('Perfil no Google: os números do perfil por dia (A6 · Z1)', () => {
  const JANELA = { inicio: '2026-10-01', fim: '2026-10-07' };
  const dia = (day: number, value?: string) => ({ date: { year: 2026, month: 10, day }, ...(value === undefined ? {} : { value }) });
  const resposta = (linhas: unknown[]) => ({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: linhas }] });

  it('as nove métricas que o Liame lê são as da referência, sem as descontinuadas, e cada uma tem um nome só', () => {
    expect(METRICAS_DO_PERFIL.map(([doGoogle]) => doGoogle)).toEqual([
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
      'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
      'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
      'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
      'BUSINESS_DIRECTION_REQUESTS',
      'CALL_CLICKS',
      'WEBSITE_CLICKS',
      'BUSINESS_BOOKINGS',
      'BUSINESS_FOOD_MENU_CLICKS',
    ]);
    expect(new Set(METRICAS_CANONICAS_DO_PERFIL).size).toBe(9);
    for (const nome of METRICAS_CANONICAS_DO_PERFIL) expect(nome).toMatch(/^[a-z_]{3,40}$/);
    // O registro de capacidades (migration 0066) tem as quatro leituras, todas com a permissão do Perfil.
    const migration = readFileSync(resolve(process.cwd(), '../../packages/database/migrations/0066_perfil_no_google.sql'), 'utf8');
    for (const capacidade of ['accounts', 'locations', 'reviews', 'performance_daily']) expect(migration).toContain(`('google_business', '${capacidade}',`);
    expect(migration.split('https://www.googleapis.com/auth/business.manage')).toHaveLength(5);
    // A Z2 (migration 0069) acrescenta a leitura de uma avaliação e a única escrita, com a flag de escrita dela.
    const escrita = readFileSync(resolve(process.cwd(), '../../packages/database/migrations/0069_resposta_a_avaliacao.sql'), 'utf8');
    expect(escrita).toContain(`('google_business', 'review_state', 'v4', true, false,`);
    expect(escrita).toContain(`('google_business', 'review_reply', 'v4', false, true,`);
    expect(escrita).toContain(`('perfil_google_write', 'boolean', 'false',`);
    // É flag de escrita (o último campo): nasce desligada, e a parada geral a alcança.
    expect(escrita).toContain(`'social', true)`);
  });

  it('o dia sem valor é zero; o dia que não veio não é inventado; o valor chega como texto', () => {
    const pontos = numerosDoPerfil(
      resposta([
        { dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [dia(1, '12'), dia(2), dia(3, '7')] } },
        { dailyMetric: 'CALL_CLICKS', timeSeries: { datedValues: [dia(1), dia(2, '3')] } },
      ]),
      JANELA,
    );
    expect(pontos).toEqual([
      { dia: '2026-10-01', metrica: 'call_clicks', valor: 0 },
      { dia: '2026-10-01', metrica: 'website_clicks', valor: 12 },
      { dia: '2026-10-02', metrica: 'call_clicks', valor: 3 },
      { dia: '2026-10-02', metrica: 'website_clicks', valor: 0 },
      { dia: '2026-10-03', metrica: 'website_clicks', valor: 7 },
    ]);
    // Os dias 4 a 7 não vieram (o Google ainda não os fechou): não viram zero.
    expect(pontos.some((p) => p.dia > '2026-10-03')).toBe(false);
  });

  it('fica de fora: a métrica desconhecida ou descontinuada, o recorte por subtipo, o dia fora da janela e o valor que não é número', () => {
    const pontos = numerosDoPerfil(
      resposta([
        { dailyMetric: 'BUSINESS_FOOD_ORDERS', timeSeries: { datedValues: [dia(1, '9')] } },
        { dailyMetric: 'METRICA_NOVA', timeSeries: { datedValues: [dia(1, '9')] } },
        { dailyMetric: 'CALL_CLICKS', dailySubEntityType: { dayOfWeek: 'MONDAY' }, timeSeries: { datedValues: [dia(1, '5')] } },
        { dailyMetric: 'BUSINESS_DIRECTION_REQUESTS', timeSeries: { datedValues: [dia(1, '4'), dia(8, '4'), { date: { year: 2026, month: 9, day: 30 }, value: '4' }, dia(2, 'muitos'), dia(3, '-2'), { date: { year: 2026, month: 10 }, value: '40' }, { date: { year: 2026, month: 2, day: 30 }, value: '1' }] } },
        { dailyMetric: 'BUSINESS_BOOKINGS' },
        null,
      ]),
      JANELA,
    );
    expect(pontos).toEqual([{ dia: '2026-10-01', metrica: 'direction_requests', valor: 4 }]);
    // Resposta vazia ou de outro formato: nenhum ponto, e nenhum erro.
    for (const vazia of [null, {}, { multiDailyMetricTimeSeries: 'x' }, { multiDailyMetricTimeSeries: [null, { dailyMetricTimeSeries: 'y' }] }]) expect(numerosDoPerfil(vazia, JANELA)).toEqual([]);
  });

  it('o mesmo dia e a mesma métrica em dois grupos da resposta contam uma vez (vale o último)', () => {
    const duas = { multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [dia(1, '12')] } }] }, { dailyMetricTimeSeries: [{ dailyMetric: 'WEBSITE_CLICKS', timeSeries: { datedValues: [dia(1, '15')] } }] }] };
    expect(numerosDoPerfil(duas, JANELA)).toEqual([{ dia: '2026-10-01', metrica: 'website_clicks', valor: 15 }]);
  });
});
