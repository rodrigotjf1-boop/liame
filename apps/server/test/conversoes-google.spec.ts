import { describe, expect, it } from 'vitest';
import { ESCOPOS_GOOGLE, escoposDoGoogle, urlDeAutorizacao } from '../src/connections/oauth.js';
import { ErroConector } from '../src/connectors/cliente-http.js';
import { corpoDaIngestao, ESCOPO_DATA_MANAGER, motivoDoErro, motivoSemIdentificador, resultadoDoDestino, valorDaMoeda } from '../src/connectors/google-ads/data-manager.js';
import { cliqueDoEnvio } from '../src/conversoes/conversoes-google.js';
import { situacaoDaConta } from '../src/conversoes/conversoes.service.js';

// A5 · Y1: o que o Liame manda ao Google quando informa uma venda confirmada (Data Manager API), sem banco. O corpo é
// conferido campo a campo: é a prova do critério A5-3 (nenhum telefone, e-mail, margem ou custo no que é enviado).

const DESTINO = { customerId: '4445556667', loginCustomerId: null, conversionActionId: '987654321' };
const GCLID = 'Cj0KCQjw-exemplo_de_id_de_clique_do_google_AbCdEfGh123456';
const EVENTO = { transactionId: '0199f0aa-1111-7222-8333-444455556666', eventTimestamp: '2026-10-08T23:00:00.000Z', clique: { tipo: 'gclid' as const, valor: GCLID }, valorMicros: 34_900_000n, moeda: 'BRL' };

describe('conversões para o Google: o que sai do Liame (A5, Y1)', () => {
  it('o valor vai na moeda, com duas casas, e não em micros', () => {
    expect(valorDaMoeda(34_900_000n)).toBe(34.9);
    expect(valorDaMoeda(0n)).toBe(0);
    expect(valorDaMoeda(1_057_000_000n)).toBe(1057);
    expect(valorDaMoeda(29_995_000n)).toBe(30);
    expect(valorDaMoeda(10_000n)).toBe(0.01);
  });

  it('o corpo do envio leva só o destino, o id do pedido, o instante, o clique, o valor e a moeda', () => {
    expect(corpoDaIngestao(DESTINO, EVENTO, false)).toEqual({
      destinations: [{ operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '4445556667' }, productDestinationId: '987654321' }],
      events: [
        {
          transactionId: EVENTO.transactionId,
          eventTimestamp: '2026-10-08T23:00:00.000Z',
          eventSource: 'WEB',
          adIdentifiers: { gclid: GCLID },
          conversionValue: 34.9,
          currency: 'BRL',
        },
      ],
      validateOnly: false,
    });
    // Nada de dado pessoal nem de consentimento afirmado: o Liame não guarda nenhum dos dois.
    const texto = JSON.stringify(corpoDaIngestao(DESTINO, EVENTO, true));
    for (const proibido of ['userData', 'userIdentifiers', 'emailAddress', 'phoneNumber', 'consent', 'encoding', 'ipAddress', 'cartData', 'margin', 'cost']) expect(texto).not.toContain(proibido);
    expect(JSON.parse(texto).validateOnly).toBe(true);
  });

  it('a conta alcançada por uma gerente leva a conta de login; cada tipo de clique vai no campo dele, um só', () => {
    const comGerente = corpoDaIngestao({ ...DESTINO, loginCustomerId: '1112223334' }, EVENTO, false) as { destinations: Array<Record<string, unknown>> };
    expect(comGerente.destinations[0]).toEqual({
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: '4445556667' },
      loginAccount: { accountType: 'GOOGLE_ADS', accountId: '1112223334' },
      productDestinationId: '987654321',
    });
    for (const tipo of ['gclid', 'gbraid', 'wbraid'] as const) {
      const corpo = corpoDaIngestao(DESTINO, { ...EVENTO, clique: { tipo, valor: 'abc' } }, false) as { events: Array<{ adIdentifiers: Record<string, string> }> };
      expect(corpo.events[0]!.adIdentifiers).toEqual({ [tipo]: 'abc' });
    }
    // Com mais de um id guardado no mesmo clique, vai um só: o gclid primeiro.
    expect(cliqueDoEnvio({ gclid: 'g', gbraid: 'b', wbraid: 'w' })).toEqual({ tipo: 'gclid', valor: 'g' });
    expect(cliqueDoEnvio({ gclid: null, gbraid: 'b', wbraid: 'w' })).toEqual({ tipo: 'gbraid', valor: 'b' });
    expect(cliqueDoEnvio({ gclid: null, gbraid: null, wbraid: 'w' })).toEqual({ tipo: 'wbraid', valor: 'w' });
    expect(cliqueDoEnvio({ gclid: null, gbraid: null, wbraid: null })).toBeNull();
  });

  it('o motivo guardado é curto e não repete o id do clique que o Google devolver na mensagem', () => {
    const motivo = motivoSemIdentificador(`Invalid value for ad_identifiers.gclid: ${GCLID}   (see docs)`);
    expect(motivo).toBe('Invalid value for ad_identifiers.gclid: … (see docs)');
    expect(motivo).not.toContain(GCLID);
    expect(motivoSemIdentificador('   ')).toBe('recusado pelo Google');
    expect(motivoSemIdentificador('x '.repeat(400)).length).toBeLessThanOrEqual(300);
    expect(motivoDoErro(new ErroConector('definitivo', 'google_ads', `Click not found: ${GCLID}`, 400, null, 'INVALID_ARGUMENT'))).toBe('INVALID_ARGUMENT: Click not found: …');
    expect(motivoDoErro(new ErroConector('limite', 'google_ads', 'Quota exceeded', 429))).toBe('limite: Quota exceeded');
  });

  it('o resultado de um envio: aceito, processando ou recusado, com o que o Google disse', () => {
    expect(resultadoDoDestino({ requestStatus: 'SUCCESS' })).toEqual({ situacao: 'aceito', motivo: null });
    // O nome do motivo do Google é comprido e todo em maiúsculas: fica inteiro (não é identificador de ninguém).
    expect(resultadoDoDestino({ requestStatus: 'SUCCESS', warningInfo: { warningCounts: [{ recordCount: '1', reason: 'PROCESSING_WARNING_REASON_KEK_PERMISSION_DENIED' }] } })).toEqual({
      situacao: 'aceito',
      motivo: 'PROCESSING_WARNING_REASON_KEK_PERMISSION_DENIED',
    });
    expect(resultadoDoDestino({ requestStatus: 'SUCCESS', warningInfo: { warningCounts: [{ reason: 'CLICK_TOO_RECENT' }] } })).toEqual({ situacao: 'aceito', motivo: 'CLICK_TOO_RECENT' });
    expect(resultadoDoDestino({ requestStatus: 'PROCESSING' })).toEqual({ situacao: 'processando', motivo: null });
    expect(resultadoDoDestino({ requestStatus: 'REQUEST_STATUS_UNKNOWN' })).toEqual({ situacao: 'processando', motivo: null });
    expect(resultadoDoDestino(undefined)).toEqual({ situacao: 'processando', motivo: null });
    expect(resultadoDoDestino({ requestStatus: 'FAILED', errorInfo: { errorCounts: [{ recordCount: '1', reason: 'INVALID_GCLID' }] } })).toEqual({ situacao: 'recusado', motivo: 'INVALID_GCLID' });
    expect(resultadoDoDestino({ requestStatus: 'FAILED' })).toEqual({ situacao: 'recusado', motivo: 'o Google recusou o registro' });
    // Com um evento por envio, "parte passou" não deveria existir: vale como recusa.
    expect(resultadoDoDestino({ requestStatus: 'PARTIAL_SUCCESS', errorInfo: { errorCounts: [{ reason: 'CLICK_NOT_FOUND' }] } })).toEqual({ situacao: 'recusado', motivo: 'CLICK_NOT_FOUND' });
  });
});

describe('conversões para o Google: a permissão pedida e a situação da conta na tela (A5, Y1)', () => {
  const LEITURA = ['https://www.googleapis.com/auth/adwords', 'https://www.googleapis.com/auth/analytics.readonly'];

  it('a autorização do Google só pede a permissão de informar vendas para a empresa com a função ligada', () => {
    expect(escoposDoGoogle(false)).toEqual(LEITURA);
    expect(escoposDoGoogle(true)).toEqual([...LEITURA, ESCOPO_DATA_MANAGER]);
    // A lista devolvida é uma cópia: quem a recebe não muda a de leitura.
    escoposDoGoogle(false).push('x');
    expect(ESCOPOS_GOOGLE).toEqual(LEITURA);

    const config = { oauth: { meta: null, regem: null, google: { clientId: 'cliente-de-teste.apps.googleusercontent.com', clientSecret: 'segredo-do-cliente-de-teste', authUrl: 'https://accounts.example', tokenUrl: 'https://oauth2.example' } } };
    const p = { estado: 'estado-de-teste', redirectUri: 'https://api.example/v1/oauth/callback', verificador: 'verificador-de-teste', versaoMeta: 'v26.0' };
    const pedido = (url: string) => new URL(url).searchParams.get('scope');
    // Sem dizer nada, é a de sempre.
    expect(pedido(urlDeAutorizacao('google', config, p))).toBe(LEITURA.join(' '));
    expect(pedido(urlDeAutorizacao('google', config, { ...p, escoposGoogle: escoposDoGoogle(true) }))).toBe([...LEITURA, ESCOPO_DATA_MANAGER].join(' '));
  });

  it('a situação da conta: a parada pesa mais, depois a autorização, o destino, a parada da pessoa e a última passagem', () => {
    const normal = { parada: false, autorizada: true, temDestino: true, parado: false, falha: null };
    expect(situacaoDaConta(normal)).toBe('informando');
    expect(situacaoDaConta({ ...normal, falha: 'esperar' })).toBe('esperando_a_plataforma');
    expect(situacaoDaConta({ ...normal, falha: 'outro' })).toBe('esperando_a_plataforma');
    // O Google recusou a autorização na passagem: é autorizar de novo, mesmo com a permissão no papel.
    expect(situacaoDaConta({ ...normal, falha: 'permissao' })).toBe('sem_permissao');
    // A parada registrada por uma passagem antiga não vale: a parada é conferida na hora.
    expect(situacaoDaConta({ ...normal, falha: 'parada' })).toBe('informando');
    expect(situacaoDaConta({ ...normal, parado: true, falha: 'esperar' })).toBe('parado');
    expect(situacaoDaConta({ ...normal, temDestino: false })).toBe('sem_destino');
    expect(situacaoDaConta({ ...normal, autorizada: false, temDestino: false })).toBe('sem_permissao');
    expect(situacaoDaConta({ ...normal, autorizada: false, parado: true })).toBe('sem_permissao');
    expect(situacaoDaConta({ parada: true, autorizada: false, temDestino: false, parado: true, falha: 'permissao' })).toBe('equipe_parada');
  });
});
