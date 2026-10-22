import { describe, expect, it } from 'vitest';
import { type AppConfig, loadConfig } from '../src/config.js';
import { provedoresDisponiveis } from '../src/connections/connections.service.js';
import { type CredencialGuardada, urlDeAutorizacao } from '../src/connections/oauth.js';
import { type ClienteConector, ErroConector } from '../src/connectors/cliente-http.js';
import {
  AcessoDaExecucao,
  type CredencialDaLoja,
  credenciaisDaConexaoRegem,
  credencialDaLoja,
  ligacaoDoClique,
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
import { revogarNoRegem } from '../src/connectors/regem/conector-regem.js';

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

// Hub DMS (F3, parte C): a loja do Regem ligada pela autorização por clique só tem a ligação (credencial `regem_ligacao`;
// o Regem descarta o segredo do token na troca). O caminho inteiro está em `test/db/regem-loja-so-ligacao.spec.ts`.
describe('a loja do Regem só com a ligação (Hub DMS, F3, parte C)', () => {
  const OUTRA_LIGACAO = `dms_lg_regem_${'B'.repeat(43)}_abcdef`;
  const doClique: CredencialGuardada = {
    tipo: 'regem_ligacao',
    lojas: [
      { loja_id: 'loja-centro', ligacao: LIGACAO, prefixo: 'dms_lg_regem_AAAAA', escopos: ['pedidos.ler', 'cupons.criar'] },
      { loja_id: 'loja-barra', ligacao: OUTRA_LIGACAO, prefixo: 'dms_lg_regem_BBBBB', escopos: ['pedidos.ler'] },
    ],
    obtido_em: '2026-10-21T12:00:00.000Z',
  };
  const doCentro: CredencialDaLoja = { via: 'ligacao', ligacao: LIGACAO, escopos: ['pedidos.ler', 'cupons.criar'], reserva: null };

  it('vai pela ligação dela com a chave REGEM_PELA_LIGACAO ligada ou desligada, sem reserva; a ligação do cofre não conta', () => {
    expect(credencialDaLoja(doClique, 'loja-centro', null, false)).toEqual(doCentro);
    expect(credencialDaLoja(doClique, 'loja-centro', null, true)).toEqual(doCentro);
    // Uma ligação da troca automática no cofre (de um `rgm_it_` de antes do clique) não muda nada.
    expect(credencialDaLoja(doClique, 'loja-centro', ligacaoDe(TOKEN), true)).toEqual(doCentro);
    expect(credencialDaLoja(doClique, 'loja-sumida', null, true)).toBeNull();
    expect(ligacaoDoClique(doClique, 'loja-barra')).toEqual({ via: 'ligacao', ligacao: OUTRA_LIGACAO, escopos: ['pedidos.ler'], reserva: null });
    // A credencial do `rgm_it_` não tem ligação do clique, e a do clique não tem `rgm_it_` (V136).
    expect(ligacaoDoClique(guardada, 'loja-centro')).toBeNull();
    expect(tokenDaLoja(doClique, 'loja-centro')).toBeNull();
  });

  it('sem reserva, a execução não volta para token nenhum: só ligacao-invalida é da loja, e o token do DMS ID recusado é do aplicativo', () => {
    expect(repetirPeloToken(doCentro, erro('autenticacao', 'ligacao-invalida'))).toBe(false);
    expect(recusaDaLoja(doCentro, erro('autenticacao', 'ligacao-invalida'))).toBe(true);
    expect(recusaDaLoja(doCentro, erro('autenticacao', 'token-invalido'))).toBe(false);
  });

  it('as lojas de cada credencial para revogar lá: as do rgm_it_ pelo token, as do clique pela ligação; outra credencial, nenhuma', () => {
    expect(credenciaisDaConexaoRegem(guardada)).toEqual([
      { lojaId: 'loja-centro', credencial: peloToken(TOKEN, ['pedidos.ler', 'cupons.ler']) },
      { lojaId: 'loja-barra', credencial: peloToken(OUTRO_TOKEN, ['pedidos.ler']) },
    ]);
    expect(credenciaisDaConexaoRegem(doClique)).toEqual([
      { lojaId: 'loja-centro', credencial: doCentro },
      { lojaId: 'loja-barra', credencial: { via: 'ligacao', ligacao: OUTRA_LIGACAO, escopos: ['pedidos.ler'], reserva: null } },
    ]);
    expect(credenciaisDaConexaoRegem({ ...guardada, tipo: 'regemcast' })).toEqual([]);
    expect(credenciaisDaConexaoRegem(null)).toEqual([]);
  });

  it('revogar no Regem: pelo rgm_it_, todo 401 é "já revogado"; pela ligação, só ligacao-invalida (o token do DMS ID recusado sobe)', async () => {
    const recusando = (e: ErroConector) => ({ cliente: { requisitar: () => Promise.reject(e) } as unknown as ClienteConector, apiUrl: 'http://127.0.0.1:9/regem' });
    const peloRgmIt = { token: TOKEN, lojaChave: 'loja-centro' };
    const pelaLigacao = { token: 'tok-do-dms-id', lojaChave: 'loja-centro', ligacao: LIGACAO };
    await expect(revogarNoRegem(recusando(erro('autenticacao', 'token-invalido')), peloRgmIt)).resolves.toBeUndefined();
    await expect(revogarNoRegem(recusando(erro('autenticacao')), peloRgmIt)).resolves.toBeUndefined();
    await expect(revogarNoRegem(recusando(erro('autenticacao', 'ligacao-invalida')), pelaLigacao)).resolves.toBeUndefined();
    await expect(revogarNoRegem(recusando(erro('autenticacao', 'token-invalido')), pelaLigacao)).rejects.toMatchObject({ codigoProvider: 'token-invalido' });
    await expect(revogarNoRegem(recusando(erro('autenticacao')), pelaLigacao)).rejects.toMatchObject({ tipo: 'autenticacao' });
    await expect(revogarNoRegem(recusando(erro('transitorio')), peloRgmIt)).rejects.toMatchObject({ tipo: 'transitorio' });
  });
});

// Hub DMS (F3, parte C, PR 4): conectar o Regem por clique, sem rede. O caminho inteiro, com o Regem e o DMS ID de
// mentira, está em `test/db/conexao-regem-clique.spec.ts`.
describe('conectar o Regem por clique (Hub DMS, F3, parte C)', () => {
  /** Valores de mentira com nome neutro (V123). */
  const VALOR_DO_CLIENTE = 'valor-do-cliente-de-teste-0000000000';
  const regemClique = { authUrl: 'https://app.dmsregem.com', apiUrl: 'https://api.dmsregem.com/api/v1/integracao', emissor: 'https://api.dmsregem.com' };
  const c1b = { clientId: 'liame', clientSecret: VALOR_DO_CLIENTE, authUrl: 'https://app.dmsregem.com' };
  const oauth = (o: Partial<AppConfig['oauth']>): AppConfig['oauth'] => ({ meta: null, google: null, regem: null, regemcast: null, regemClique: null, ...o });
  const sem = { regemPorClique: false, regemcastPorClique: false };

  it('o Regem dá para conectar pela C1b ou pelo clique (a configuração E a flag da empresa); só uma das duas não basta', () => {
    expect(provedoresDisponiveis(oauth({}), { ...sem, regemPorClique: true })).toEqual([]);
    expect(provedoresDisponiveis(oauth({ regemClique }), sem)).toEqual([]);
    expect(provedoresDisponiveis(oauth({ regemClique }), { ...sem, regemPorClique: true })).toEqual(['regem']);
    expect(provedoresDisponiveis(oauth({ regem: c1b }), sem)).toEqual(['regem']);
    expect(provedoresDisponiveis(oauth({ regem: c1b, regemClique }), { ...sem, regemPorClique: true })).toEqual(['regem']);
  });

  it('a página do clique leva só o aplicativo e o número do pedido; sem o pedido, a da C1b; sem o aplicativo no DMS ID, nenhuma', () => {
    const config = { dmsId: { emissor: 'http://127.0.0.1:4000/oidc', aplicativo: 'aplicativo-do-liame', segredo: VALOR_DO_CLIENTE }, oauth: oauth({ regem: c1b, regemClique }) };
    const pedidoRegem = `urn:ietf:params:oauth:request_uri:rgm_${'a'.repeat(43)}`;
    const base = { estado: 'e'.repeat(43), redirectUri: 'https://api.agencialiame.com/v1/oauth/callback', verificador: 'v'.repeat(64), versaoMeta: 'v26.0' };
    const clique = new URL(urlDeAutorizacao('regem', config, { ...base, pedidoRegem }));
    expect(`${clique.origin}${clique.pathname}`).toBe('https://app.dmsregem.com/integracoes/autorizar');
    expect(Object.fromEntries(clique.searchParams)).toEqual({ client_id: 'aplicativo-do-liame', request_uri: pedidoRegem });
    const deAntes = new URL(urlDeAutorizacao('regem', config, base));
    expect([deAntes.searchParams.get('cliente'), deAntes.searchParams.get('code_challenge_method'), deAntes.searchParams.get('request_uri')]).toEqual(['liame', 'S256', null]);
    expect(() => urlDeAutorizacao('regem', { ...config, dmsId: null }, { ...base, pedidoRegem })).toThrow(ErroConector);
  });
});
