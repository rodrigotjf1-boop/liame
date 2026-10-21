import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { CredencialGuardada } from '../src/connections/oauth.js';
import { ErroConector } from '../src/connectors/cliente-http.js';
import {
  AcessoDaExecucao,
  type CredencialDaLoja,
  credencialDaLoja,
  ligacaoDoToken,
  PERMISSOES_DA_ESCRITA,
  PERMISSOES_DA_LEITURA,
  peloToken,
  recursoDoRegem,
  recusaDaLoja,
  repetirPeloToken,
  resumoDoToken,
  tokenDaLoja,
} from '../src/connectors/regem/acesso-da-loja.js';
import { normalizarDoRegem } from '../src/connectors/regem/comparacao.js';

// Hub DMS (F3, parte B): o acesso de cada chamada do Liame ao Regem, sem rede. Quem decide a via (o `rgm_it_` ou a
// ligação) e quem decide se a recusa é da loja (ERR-149: pela ligação, nunca "todo 401"). O caminho inteiro, com o DMS
// ID e o Regem de mentira, está em `test/db/regem-pela-ligacao.spec.ts`.

const TOKEN = `rgm_it_${'L'.repeat(32)}`;
const OUTRO_TOKEN = `rgm_it_${'O'.repeat(32)}`;
const LIGACAO = `dms_lg_regem_${'A'.repeat(43)}_abcdef`;
const guardada: CredencialGuardada = {
  tipo: 'regem',
  lojas: [
    { loja_id: 'loja-centro', token: TOKEN, escopos: ['pedidos.ler', 'cupons.ler'] },
    { loja_id: 'loja-barra', token: OUTRO_TOKEN, escopos: ['pedidos.ler'] },
  ],
  obtido_em: '2026-10-21T12:00:00.000Z',
};
const ligacaoDe = (token: string) => JSON.stringify({ tipo: 'ligacao_regem', ligacao: LIGACAO, prefixo: 'dms_lg_regem_AAAAA', origem: resumoDoToken(token), obtida_em: '2026-10-21T12:00:00.000Z' });
const erro = (tipo: ErroConector['tipo'], codigo: string | null = null) => new ErroConector(tipo, 'regem', 'recusado', null, null, codigo);

describe('o acesso do Liame ao Regem (Hub DMS, F3, parte B)', () => {
  it('o token da loja sai da credencial da conexão do Regem, e só dela', () => {
    expect(tokenDaLoja(guardada, 'loja-centro')).toEqual({ token: TOKEN, escopos: ['pedidos.ler', 'cupons.ler'] });
    expect(tokenDaLoja(guardada, 'loja-sumida')).toBeNull();
    expect(tokenDaLoja(null, 'loja-centro')).toBeNull();
    // A credencial do RegemCast (mesmo formato) nunca vai ao Regem (V136).
    expect(tokenDaLoja({ ...guardada, tipo: 'regemcast' }, 'loja-centro')).toBeNull();
  });

  it('a ligação do cofre só serve se saiu do rgm_it_ de agora', () => {
    expect(ligacaoDoToken(ligacaoDe(TOKEN), TOKEN)?.ligacao).toBe(LIGACAO);
    // A loja reconectou com outro token: a ligação antiga não serve.
    expect(ligacaoDoToken(ligacaoDe(OUTRO_TOKEN), TOKEN)).toBeNull();
    expect(ligacaoDoToken(null, TOKEN)).toBeNull();
    expect(ligacaoDoToken('{não é json', TOKEN)).toBeNull();
    expect(ligacaoDoToken(JSON.stringify({ tipo: 'ligacao_regemcast', ligacao: LIGACAO, origem: resumoDoToken(TOKEN) }), TOKEN)).toBeNull();
  });

  it('a leitura de verdade vai pela ligação só com a chave ligada e a ligação do token de agora, com o token de reserva', () => {
    // Chave desligada: pelo token, mesmo com a ligação guardada.
    expect(credencialDaLoja(guardada, 'loja-centro', ligacaoDe(TOKEN), false)).toEqual(peloToken(TOKEN, ['pedidos.ler', 'cupons.ler']));
    // Ligada e com a ligação deste token: pela ligação, com os escopos da loja e o rgm_it_ de reserva.
    expect(credencialDaLoja(guardada, 'loja-centro', ligacaoDe(TOKEN), true)).toEqual({ via: 'ligacao', ligacao: LIGACAO, escopos: ['pedidos.ler', 'cupons.ler'], reserva: TOKEN });
    // Ligada, mas a ligação é de outro token (ou não há ligação): pelo token.
    expect(credencialDaLoja(guardada, 'loja-centro', ligacaoDe(OUTRO_TOKEN), true)?.via).toBe('token');
    expect(credencialDaLoja(guardada, 'loja-centro', null, true)?.via).toBe('token');
    // O cofre sem o token da loja: sem credencial (a leitura diz "autorização revogada").
    expect(credencialDaLoja(guardada, 'loja-sumida', ligacaoDe(TOKEN), true)).toBeNull();
  });

  it('quem recusa, por via (ERR-149): pelo token, todo 401; pela ligação com reserva, nunca; sem reserva, só ligacao-invalida', () => {
    const peloRgmIt = peloToken(TOKEN, []);
    const comReserva: CredencialDaLoja = { via: 'ligacao', ligacao: LIGACAO, escopos: [], reserva: TOKEN };
    const semReserva: CredencialDaLoja = { via: 'ligacao', ligacao: LIGACAO, escopos: [], reserva: null };
    const casos: [string, CredencialDaLoja, ErroConector, boolean][] = [
      ['token: rgm_it_ recusado (token-invalido)', peloRgmIt, erro('autenticacao', 'token-invalido'), true],
      ['token: 401 sem o nome do problema', peloRgmIt, erro('autenticacao'), true],
      ['token: sem o escopo (403)', peloRgmIt, erro('permissao', 'escopo-insuficiente'), false],
      ['token: fora do ar', peloRgmIt, erro('transitorio'), false],
      ['ligação com reserva: ligacao-invalida (a reserva decide)', comReserva, erro('autenticacao', 'ligacao-invalida'), false],
      ['ligação com reserva: token do DMS ID recusado', comReserva, erro('autenticacao', 'token-invalido'), false],
      ['ligação sem reserva: ligacao-invalida', semReserva, erro('autenticacao', 'ligacao-invalida'), true],
      ['ligação sem reserva: token do DMS ID recusado', semReserva, erro('autenticacao', 'token-invalido'), false],
      ['ligação sem reserva: o DMS ID recusou o aplicativo (sem código)', semReserva, erro('autenticacao'), false],
      ['ligação sem reserva: ligacao-invalida que não é 401', semReserva, erro('definitivo', 'ligacao-invalida'), false],
    ];
    const errados = casos.filter(([, c, e, esperado]) => recusaDaLoja(c, e) !== esperado).map(([nome]) => nome);
    expect(errados).toEqual([]);
  });

  it('pela ligação, só a recusa do acesso ou da permissão é repetida pelo token de reserva', () => {
    const comReserva: CredencialDaLoja = { via: 'ligacao', ligacao: LIGACAO, escopos: [], reserva: TOKEN };
    const semReserva: CredencialDaLoja = { via: 'ligacao', ligacao: LIGACAO, escopos: [], reserva: null };
    expect(repetirPeloToken(comReserva, erro('autenticacao', 'ligacao-invalida'))).toBe(true);
    expect(repetirPeloToken(comReserva, erro('autenticacao', 'token-invalido'))).toBe(true);
    expect(repetirPeloToken(comReserva, erro('permissao', 'escopo-insuficiente'))).toBe(true);
    // O que é passageiro ou do pedido não muda de credencial: o mesmo Regem responderia igual.
    for (const tipo of ['transitorio', 'limite', 'definitivo', 'circuito_aberto'] as const) expect(repetirPeloToken(comReserva, erro(tipo)), tipo).toBe(false);
    expect(repetirPeloToken(semReserva, erro('autenticacao', 'ligacao-invalida'))).toBe(false);
    expect(repetirPeloToken(peloToken(TOKEN, []), erro('autenticacao'))).toBe(false);
  });

  it('o recurso do Regem no DMS ID é o endereço das rotas de integração; o token pede o catálogo do Liame', () => {
    expect(recursoDoRegem('https://api.dmsregem.com/api/v1/integracao/')).toBe('https://api.dmsregem.com/api/v1/integracao');
    expect([...PERMISSOES_DA_LEITURA]).not.toContain('cupons.criar');
    expect([...PERMISSOES_DA_ESCRITA]).toEqual([...PERMISSOES_DA_LEITURA, 'cupons.criar']);
  });

  it('pelo token, o acesso da execução chama direto; pela ligação sem o aplicativo do Liame no DMS ID, recusa sem chamar', async () => {
    const config = { ...loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv), dmsId: null };
    const vistos: unknown[] = [];
    const pelo = new AcessoDaExecucao(peloToken(TOKEN, []), config, 'loja-centro', PERMISSOES_DA_LEITURA);
    expect(await pelo.chamar(async (a) => (vistos.push(a), 'ok'))).toBe('ok');
    expect(vistos).toEqual([{ token: TOKEN, lojaChave: 'loja-centro' }]);
    const pelaLigacao = new AcessoDaExecucao({ via: 'ligacao', ligacao: LIGACAO, escopos: [], reserva: TOKEN }, config, 'loja-centro', PERMISSOES_DA_LEITURA);
    await expect(pelaLigacao.chamar(async () => 'nunca')).rejects.toMatchObject({ tipo: 'definitivo' });
  });

  it('a comparação tira só os escopos da loja (dependem da credencial), nada mais', () => {
    const loja = { loja_id: 'loja-centro', loja_nome: 'Centro', fuso: 'America/Sao_Paulo', moeda: 'BRL', escopos: ['pedidos.ler'], cardapio_url: null };
    const { escopos: _e, ...semEscopos } = loja;
    expect(normalizarDoRegem('regem_loja', loja)).toEqual(semEscopos);
    const pagina = { itens: [{ id: 'p1', escopos: ['x'] }], proximoCursor: null, temMais: false };
    expect(normalizarDoRegem('regem_pedidos', pagina)).toBe(pagina);
  });

  it('a chave REGEM_PELA_LIGACAO nasce desligada e, ligada, pede o aplicativo do Liame no DMS ID', () => {
    const dmsId = { DMS_ID_EMISSOR: 'http://127.0.0.1:4000/oidc', DMS_ID_APLICATIVO: 'aplicativo-do-liame', DMS_ID_SEGREDO: 'valor-do-aplicativo-no-dms-id-0123' };
    expect(loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv).produtos.regemPelaLigacao).toBe(false);
    expect(loadConfig({ NODE_ENV: 'test', ...dmsId } as NodeJS.ProcessEnv).produtos.regemPelaLigacao).toBe(false);
    expect(() => loadConfig({ NODE_ENV: 'test', REGEM_PELA_LIGACAO: 'true' } as NodeJS.ProcessEnv)).toThrow('aplicativo do Liame no DMS ID');
    expect(() => loadConfig({ NODE_ENV: 'test', ...dmsId, REGEM_PELA_LIGACAO: 'sim' } as NodeJS.ProcessEnv)).toThrow();
    expect(loadConfig({ NODE_ENV: 'test', ...dmsId, REGEM_PELA_LIGACAO: 'true' } as NodeJS.ProcessEnv).produtos.regemPelaLigacao).toBe(true);
  });
});
