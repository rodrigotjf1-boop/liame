import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClienteConector, ErroConector } from '../../src/connectors/cliente-http.js';
import { dispararCampanha, estimarPublico, pausarCampanha, planejarDisparo, rascunharCampanha, rascunharModelo } from '../../src/connectors/regemcast/conector-regemcast.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A5 · Y5 (parte 1): as ferramentas do pedido de mensagem no conector do RegemCast, contra um RegemCast falso que fala o
// MCP 2026-07-28 sem estado, com as entradas e as respostas no formato que o RegemCast declara (`docs/mcp.md`,
// `mcp.escrita.ts`, `mcp.disparo.ts` e `mcp.leitura.ts` de lá, lidos em 09/10/2026): estimar o público, rascunhar o
// modelo e a campanha, planejar o disparo, disparar com a confirmação do plano e pausar. O falso guarda a chave de
// idempotência como o de verdade: o mesmo pedido com a mesma chave devolve a mesma resposta, sem fazer de novo.
// Nenhuma rota, nenhuma ferramenta de ação e nenhuma rotina do Liame usa estas funções ainda.

const TOKEN = `rct_it_${'P'.repeat(43)}`;
const TOKEN_SO_LEITURA = `rct_it_${'L'.repeat(43)}`;
const CAMPANHA = '0199f1aa-2222-7333-8444-555566667777';
const MODELO = '0199f1aa-3333-7444-8555-666677778888';
const CONFIRMACAO = 'c0nf1rmacao-do-plano-0123456789ab';
const PLANO_MUDOU = 'O plano mudou desde a confirmação. Peça um plano novo com campanha_disparo_planejar.';
const ALHEIA = '0199f1aa-9999-7333-8444-555566667777';
const SO_A_PROPRIA = 'Este aplicativo só mexe na campanha que ele mesmo montou.';
const SO_ESCRITA = new Set(['modelo_rascunhar', 'campanha_rascunhar', 'campanha_disparo_planejar', 'campanha_disparar', 'campanha_pausar']);
const COM_CHAVE = new Set(['modelo_rascunhar', 'campanha_rascunhar', 'campanha_disparar', 'campanha_pausar']);

type Chamada = { ferramenta: string; argumentos: Record<string, unknown>; cabecalhos: IncomingHttpHeaders };

const EM_RASCUNHO = {
  id: CAMPANHA,
  nome: 'Sexta em dobro',
  situacao: 'rascunho',
  pausaMotivo: null,
  modelo: 'promo_sexta_v2',
  categoria: 'marketing',
  publico: 'Quem pediu nos últimos 30 dias',
  destinatarios: 412,
  naFila: 412,
  enviadas: 0,
  entregues: 0,
  lidas: 0,
  falhas: 0,
  responderam: 0,
  criadaEm: '2026-09-30T12:12:00.000Z',
  iniciadaEm: null,
  concluidaEm: null,
};
const CUSTO = { moeda: 'BRL', gastoCentavos: 0, aSairCentavos: 13_184, linhas: [{ rotulo: 'Custo estimado na Meta', valor: 'até R$ 131,84', detalhe: '412 mensagens de marketing' }], avisos: [] };
const ORCAMENTO = {
  definido: true,
  periodos: [{ periodo: 'mes', rotulo: 'Outubro', tetoCentavos: 30_000, gastoCentavos: 12_736, texto: 'R$ 127,36 de R$ 300,00 neste mês', sinal: 'ok' }],
  aviso: null,
};
const RESPOSTAS: Record<string, unknown> = {
  publico_estimar: { pessoas: 450, emDescanso: 38, descansoDias: 7, custo: CUSTO },
  modelo_rascunhar: {
    id: MODELO,
    nome: 'promo_sexta_v2',
    idioma: 'pt_BR',
    categoria: 'marketing',
    situacao: 'rascunho',
    problemas: [],
    prontoParaEnviar: true,
    proximoPasso: 'O rascunho está gravado e não foi para a Meta. Uma pessoa da conta confere e envia para aprovação, em Modelos.',
  },
  campanha_rascunhar: { campanha: EM_RASCUNHO, custo: CUSTO, descansoDias: 7, proximoPasso: 'A campanha está em rascunho: nenhuma mensagem saiu. Uma pessoa da conta confere e dispara, em Campanhas.' },
  campanha_disparo_planejar: { campanha: EM_RASCUNHO, custo: CUSTO, orcamento: ORCAMENTO, podeDisparar: true, impedimentos: [], confirmacao: CONFIRMACAO },
  campanha_disparar: { campanha: { ...EM_RASCUNHO, situacao: 'enviando', iniciadaEm: '2026-10-02T14:00:00.000Z' }, custo: CUSTO, proximoPasso: 'A campanha entrou na fila de envio.' },
  campanha_pausar: { campanha: { ...EM_RASCUNHO, situacao: 'pausada', pausaMotivo: 'integracao', naFila: 232, enviadas: 180 }, proximoPasso: 'A campanha está pausada. Quem retoma é uma pessoa da conta, em Campanhas.' },
};

describe.skipIf(!hasDb)('conector do RegemCast: as ferramentas do pedido de mensagem (A5 · Y5)', () => {
  let database: Database;
  let regemcast: Server;
  let base = '';
  const chamadas: Chamada[] = [];
  /** O que o RegemCast falso devolve no lugar da resposta normal de uma ferramenta. */
  const trocas = new Map<string, unknown>();
  /** A ferramenta que responde 503 nesta quantidade de chamadas antes de voltar. */
  const caidas = new Map<string, number>();
  /** A chave de idempotência, como no RegemCast: por ferramenta, guarda o pedido e a resposta. */
  const chaves = new Map<string, { pedido: string; resposta: unknown }>();
  /** Quantas vezes cada ferramenta que grava rodou DE VERDADE (a repetição com a mesma chave não conta). */
  const feitas = new Map<string, number>();
  let serie = 0;
  const ctx = (tentativas = 1) => ({ cliente: new ClienteConector(database.db, { enderecos: { regemcast: [base] }, tentativas }), apiUrl: base });
  /** Cada cenário com a conta dele: a cota e o disjuntor de um não pesam no outro. */
  const acesso = (token = TOKEN) => ({ token, contaChave: `pedido-${++serie}-${Date.now()}` });
  const resultado = (sc: unknown) => ({ result: { content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc, resultType: 'complete' } });
  const recusada = (texto: string) => ({ result: { content: [{ type: 'text', text: texto }], isError: true, resultType: 'complete' } });
  const erro = async (p: Promise<unknown>): Promise<ErroConector> => {
    const e = await p.then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(ErroConector);
    return e as ErroConector;
  };
  const semChamada = async (fn: () => Promise<unknown>, oque: string) => {
    const antes = chamadas.length;
    // A função confere o formato antes de montar a chamada: o erro sai na hora, e nada vai para a rede.
    let e: unknown = null;
    try {
      await fn();
    } catch (err) {
      e = err;
    }
    expect(e).toBeInstanceOf(ErroConector);
    expect(e).toMatchObject({ tipo: 'definitivo', message: `${oque} fora do formato do RegemCast` });
    expect(chamadas.length).toBe(antes);
  };

  function responder(credencial: string, corpo: { id?: unknown; params?: { name?: string; arguments?: Record<string, unknown> } }): { status: number; corpo: unknown } {
    const nome = corpo.params?.name ?? '';
    const args = corpo.params?.arguments ?? {};
    const comId = (r: object) => ({ jsonrpc: '2.0', id: corpo.id, ...r });
    if (credencial !== TOKEN && credencial !== TOKEN_SO_LEITURA) return { status: 401, corpo: { mensagem: 'Token de integração inválido ou revogado.' } };
    // O RegemCast nem lista a ferramenta que o token não pode usar: a chamada direta responde "não encontrada".
    if (!(nome in RESPOSTAS) || (credencial === TOKEN_SO_LEITURA && SO_ESCRITA.has(nome))) return { status: 200, corpo: comId({ error: { code: -32602, message: `Tool ${nome} not found` } }) };
    const restam = caidas.get(nome) ?? 0;
    if (restam > 0) {
      caidas.set(nome, restam - 1);
      return { status: 503, corpo: { mensagem: 'fora do ar' } };
    }
    // Só a campanha que o mesmo aplicativo montou: a de uma pessoa da conta, ou de outro aplicativo, é recusada.
    if (SO_ESCRITA.has(nome) && args.id === ALHEIA) return { status: 200, corpo: comId(recusada(SO_A_PROPRIA)) };
    const fazer = (): unknown => {
      if (nome === 'campanha_disparar' && args.confirmacao !== CONFIRMACAO) return recusada(PLANO_MUDOU);
      feitas.set(nome, (feitas.get(nome) ?? 0) + 1);
      return resultado(trocas.has(nome) ? trocas.get(nome) : RESPOSTAS[nome]);
    };
    if (!COM_CHAVE.has(nome)) return { status: 200, corpo: comId(resultado(trocas.has(nome) ? trocas.get(nome) : RESPOSTAS[nome])) };
    const { chaveIdempotencia, ...pedido } = args;
    if (typeof chaveIdempotencia !== 'string' || !/^[A-Za-z0-9_.:-]{8,100}$/.test(chaveIdempotencia)) return { status: 200, corpo: comId(recusada('Input validation error: chaveIdempotencia')) };
    const chave = `${nome}:${chaveIdempotencia}`;
    const guardada = chaves.get(chave);
    if (guardada) {
      if (guardada.pedido !== JSON.stringify(pedido)) return { status: 200, corpo: comId(recusada('Esta chave já foi usada com outro pedido. Use uma chave nova.')) };
      return { status: 200, corpo: comId(guardada.resposta as object) };
    }
    const resposta = fazer();
    // Como no RegemCast: a chave só fica quando a ação acontece; recusada, o pedido corrigido pode usar a mesma.
    if (!(resposta as { result: { isError?: boolean } }).result.isError) chaves.set(chave, { pedido: JSON.stringify(pedido), resposta });
    return { status: 200, corpo: comId(resposta as object) };
  }

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    regemcast = createServer((req, res) => {
      let texto = '';
      req.on('data', (d: Buffer) => (texto += d.toString('utf8')));
      req.on('end', () => {
        const corpo = JSON.parse(texto) as { id?: unknown; params?: { name?: string; arguments?: Record<string, unknown> } };
        chamadas.push({ ferramenta: corpo.params?.name ?? '', argumentos: corpo.params?.arguments ?? {}, cabecalhos: req.headers });
        const r = responder((req.headers.authorization ?? '').replace(/^Bearer /, ''), corpo);
        res.writeHead(r.status, { 'content-type': 'application/json', ...(r.status === 401 ? { 'www-authenticate': 'Bearer' } : {}) });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => regemcast.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(regemcast.address() as AddressInfo).port}`;
  }, 120_000);
  beforeEach(() => {
    chamadas.length = 0;
    trocas.clear();
    caidas.clear();
    chaves.clear();
    feitas.clear();
  });
  afterAll(async () => {
    await database?.close();
    await new Promise((ok) => regemcast?.close(ok));
  });

  it('estima o público com o custo como teto: só números, e o que vier a mais fica na porta', async () => {
    const a = acesso();
    expect(await estimarPublico(ctx(), { ...a, publico: { origem: 'publico', publico: 'recentes_30' }, categoria: 'marketing' })).toEqual(RESPOSTAS.publico_estimar);
    // Só o que foi informado vai no pedido: nenhum campo vazio.
    expect(chamadas[0]).toMatchObject({ ferramenta: 'publico_estimar', argumentos: { origem: 'publico', publico: 'recentes_30', categoria: 'marketing' } });
    expect(Object.keys(chamadas[0]!.argumentos).sort()).toEqual(['categoria', 'origem', 'publico']);
    expect(chamadas[0]!.cabecalhos).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'mcp-method': 'tools/call', 'mcp-name': 'publico_estimar' });

    trocas.set('publico_estimar', { ...(RESPOSTAS.publico_estimar as object), amostra: [{ nome: 'Maria Souza', telefone: '+5521999990001' }], telefones: ['+5521999990002'] });
    const recebido = JSON.stringify(await estimarPublico(ctx(), { ...a, publico: { origem: 'lista', origemId: '0199f1aa-4444-7555-8666-777788889999' } }));
    for (const proibido of ['+55219', 'telefone', 'Maria', 'amostra']) expect(recebido, proibido).not.toContain(proibido);
    expect(chamadas[1]!.argumentos).toEqual({ origem: 'lista', origemId: '0199f1aa-4444-7555-8666-777788889999' });
  });

  it('rascunha o modelo e a campanha com a chave de idempotência; não há por onde mandar telefone, e o que está fora do formato nem sai do Liame', async () => {
    const a = acesso();
    const modelo = await rascunharModelo(ctx(), {
      ...a,
      chave: 'liame:modelo:5a9e21c7',
      modelo: { nome: 'promo_sexta_v2', categoria: 'marketing', corpo: 'Oi, {{1}}! Sexta tem smash em dobro.', corpoExemplos: ['Ana'], rodape: 'Responda SAIR para não receber mais.', botoes: [{ tipo: 'URL', texto: 'Ver o cardápio', url: 'https://cardapio.example/mister' }] },
    });
    expect(modelo).toEqual(RESPOSTAS.modelo_rascunhar);
    expect(chamadas[0]!.argumentos).toEqual({
      chaveIdempotencia: 'liame:modelo:5a9e21c7',
      nome: 'promo_sexta_v2',
      categoria: 'marketing',
      corpo: 'Oi, {{1}}! Sexta tem smash em dobro.',
      corpoExemplos: ['Ana'],
      rodape: 'Responda SAIR para não receber mais.',
      botoes: [{ tipo: 'URL', texto: 'Ver o cardápio', url: 'https://cardapio.example/mister' }],
    });
    // O rascunho que a Meta recusaria volta com os problemas, e não pronto para enviar.
    trocas.set('modelo_rascunhar', { ...(RESPOSTAS.modelo_rascunhar as object), problemas: [{ campo: 'corpo', mensagem: 'A mensagem não pode começar com uma variável.' }], prontoParaEnviar: false });
    const comProblema = await rascunharModelo(ctx(), { ...a, chave: 'liame:modelo:outra-chave', modelo: { id: MODELO, nome: 'promo_sexta_v2', categoria: 'marketing', corpo: '{{1}}, sexta tem smash em dobro.' } });
    expect(comProblema).toMatchObject({ prontoParaEnviar: false, problemas: [{ campo: 'corpo', mensagem: 'A mensagem não pode começar com uma variável.' }] });

    const campanha = await rascunharCampanha(ctx(), {
      ...a,
      chave: 'liame:campanha:5a9e21c7',
      campanha: {
        nome: 'Sexta em dobro',
        modeloNome: 'promo_sexta_v2',
        publico: { origem: 'publico', publico: 'recentes_30' },
        variaveis: [{ origem: 'primeiro_nome', valor: 'cliente' }],
        janelaDias: [5],
        janelaInicio: '11:00',
        janelaFim: '20:00',
      },
    });
    expect(campanha).toEqual(RESPOSTAS.campanha_rascunhar);
    const pedido = chamadas.at(-1)!.argumentos;
    expect(pedido).toEqual({
      chaveIdempotencia: 'liame:campanha:5a9e21c7',
      nome: 'Sexta em dobro',
      modeloNome: 'promo_sexta_v2',
      publico: { origem: 'publico', publico: 'recentes_30' },
      variaveis: [{ origem: 'primeiro_nome', valor: 'cliente' }],
      janelaDias: [5],
      janelaInicio: '11:00',
      janelaFim: '20:00',
    });
    // O público é sempre um que já existe no RegemCast: o pedido não tem campo de número nem de contato.
    expect(JSON.stringify(pedido)).not.toMatch(/telefone|numero|contato|\+55/i);

    await semChamada(() => rascunharModelo(ctx(), { ...a, chave: 'curta', modelo: { nome: 'x', categoria: 'marketing', corpo: 'y' } }), 'chave de idempotência');
    await semChamada(() => rascunharModelo(ctx(), { ...a, chave: 'liame:modelo:chave-boa', modelo: { id: 'não é um id', nome: 'x', categoria: 'marketing', corpo: 'y' } }), 'id do rascunho');
    await semChamada(() => rascunharCampanha(ctx(), { ...a, chave: 'chave com espaço', campanha: { nome: 'x', modeloNome: 'y', publico: { origem: 'base' } } }), 'chave de idempotência');
  });

  it('o plano traz a confirmação só quando nada impede; o plano torto é erro definitivo e ninguém dispara em cima dele', async () => {
    const a = acesso();
    const plano = await planejarDisparo(ctx(), { ...a, id: CAMPANHA });
    expect(plano).toEqual(RESPOSTAS.campanha_disparo_planejar);
    expect(chamadas[0]).toMatchObject({ ferramenta: 'campanha_disparo_planejar', argumentos: { id: CAMPANHA } });

    // O que impede vem nas frases do RegemCast, sem confirmação.
    const impedido = { ...(RESPOSTAS.campanha_disparo_planejar as object), podeDisparar: false, impedimentos: ['O modelo desta campanha ainda não foi aprovado pela Meta.'], confirmacao: null };
    trocas.set('campanha_disparo_planejar', impedido);
    expect(await planejarDisparo(ctx(), { ...a, id: CAMPANHA })).toMatchObject({ podeDisparar: false, confirmacao: null, impedimentos: ['O modelo desta campanha ainda não foi aprovado pela Meta.'] });
    // Custo maior que o que resta no orçamento não impede: o plano avisa que a campanha sai aos poucos.
    trocas.set('campanha_disparo_planejar', { ...(RESPOSTAS.campanha_disparo_planejar as object), orcamento: { ...ORCAMENTO, aviso: 'O custo estimado passa do que resta no teto do mês: a campanha vai sair aos poucos.' } });
    expect((await planejarDisparo(ctx(), { ...a, id: CAMPANHA })).orcamento.aviso).toContain('aos poucos');

    // "Pode disparar" sem a confirmação, a confirmação com impedimento, ou "não pode" sem dizer por quê: fora do contrato.
    for (const torto of [
      { podeDisparar: true, impedimentos: [], confirmacao: null },
      { podeDisparar: true, impedimentos: ['A conta está sem teto de gasto.'], confirmacao: CONFIRMACAO },
      { podeDisparar: false, impedimentos: [], confirmacao: null },
      { podeDisparar: false, impedimentos: ['A conta está sem teto de gasto.'], confirmacao: CONFIRMACAO },
    ]) {
      trocas.set('campanha_disparo_planejar', { ...(RESPOSTAS.campanha_disparo_planejar as object), ...torto });
      expect(await erro(planejarDisparo(ctx(), { ...a, id: CAMPANHA })), JSON.stringify(torto)).toMatchObject({ tipo: 'definitivo', message: 'resposta fora do contrato em campanha_disparo_planejar (podeDisparar)' });
    }
    await semChamada(() => planejarDisparo(ctx(), { ...a, id: 'campanha-1' }), 'id da campanha');
  });

  it('dispara só com a confirmação do plano, e uma vez só, mesmo quando a chamada é repetida; o plano que mudou é recusado com a frase do RegemCast', async () => {
    const a = acesso();
    // O RegemCast cai na primeira chamada: o cliente tenta de novo com a MESMA chave, e o disparo acontece uma vez.
    caidas.set('campanha_disparar', 1);
    const disparo = await dispararCampanha(ctx(2), { ...a, chave: 'liame:disparo:5a9e21c7', id: CAMPANHA, confirmacao: CONFIRMACAO });
    expect(disparo).toEqual(RESPOSTAS.campanha_disparar);
    const enviadas = chamadas.filter((c) => c.ferramenta === 'campanha_disparar');
    expect(enviadas).toHaveLength(2);
    expect(enviadas.map((c) => c.argumentos)).toEqual([
      { chaveIdempotencia: 'liame:disparo:5a9e21c7', id: CAMPANHA, confirmacao: CONFIRMACAO },
      { chaveIdempotencia: 'liame:disparo:5a9e21c7', id: CAMPANHA, confirmacao: CONFIRMACAO },
    ]);
    expect(feitas.get('campanha_disparar')).toBe(1);
    // Repetir o pedido inteiro com a mesma chave (o worker que rodou de novo) também não dispara outra vez.
    expect(await dispararCampanha(ctx(), { ...a, chave: 'liame:disparo:5a9e21c7', id: CAMPANHA, confirmacao: CONFIRMACAO })).toEqual(RESPOSTAS.campanha_disparar);
    expect(feitas.get('campanha_disparar')).toBe(1);

    // A confirmação de um plano que não vale mais: o RegemCast recusa, e nada sai.
    const mudou = await erro(dispararCampanha(ctx(), { ...a, chave: 'liame:disparo:plano-velho', id: CAMPANHA, confirmacao: 'c0nf1rmacao-de-um-plano-antigo-00' }));
    expect(mudou).toMatchObject({ tipo: 'definitivo', message: `campanha_disparar: ${PLANO_MUDOU}` });
    expect(feitas.get('campanha_disparar')).toBe(1);

    // O token que só lê não dispara: a ferramenta "não existe" para ele.
    expect(await erro(dispararCampanha(ctx(), { ...acesso(TOKEN_SO_LEITURA), chave: 'liame:disparo:sem-escopo', id: CAMPANHA, confirmacao: CONFIRMACAO }))).toMatchObject({
      tipo: 'permissao',
      message: 'campanha_disparar: o token não tem a permissão desta ferramenta',
    });
    expect(await erro(planejarDisparo(ctx(), { ...acesso(TOKEN_SO_LEITURA), id: CAMPANHA }))).toMatchObject({ tipo: 'permissao' });
    expect(feitas.get('campanha_disparar')).toBe(1);

    await semChamada(() => dispararCampanha(ctx(), { ...a, chave: 'liame:disparo:conf-curta', id: CAMPANHA, confirmacao: 'curta' }), 'confirmação do plano');
    await semChamada(() => dispararCampanha(ctx(), { ...a, chave: 'liame:disparo:id-torto', id: 'x', confirmacao: CONFIRMACAO }), 'id da campanha');
    await semChamada(() => dispararCampanha(ctx(), { ...a, chave: 'ruim!', id: CAMPANHA, confirmacao: CONFIRMACAO }), 'chave de idempotência');
  });

  it('pausa a campanha que disparou: segura o que ainda não saiu', async () => {
    const a = acesso();
    const pausa = await pausarCampanha(ctx(), { ...a, chave: 'liame:pausa:5a9e21c7', id: CAMPANHA });
    expect(pausa).toEqual(RESPOSTAS.campanha_pausar);
    expect(pausa.campanha).toMatchObject({ situacao: 'pausada', naFila: 232, enviadas: 180 });
    expect(chamadas[0]).toMatchObject({ ferramenta: 'campanha_pausar', argumentos: { chaveIdempotencia: 'liame:pausa:5a9e21c7', id: CAMPANHA } });
    // A campanha que uma pessoa montou na tela do RegemCast não é do Liame: ele não planeja, não dispara e não pausa.
    expect(await erro(pausarCampanha(ctx(), { ...a, chave: 'liame:pausa:alheia', id: ALHEIA }))).toMatchObject({ tipo: 'definitivo', message: `campanha_pausar: ${SO_A_PROPRIA}` });
    expect(await erro(planejarDisparo(ctx(), { ...a, id: ALHEIA }))).toMatchObject({ tipo: 'definitivo', message: `campanha_disparo_planejar: ${SO_A_PROPRIA}` });
    expect(await erro(dispararCampanha(ctx(), { ...a, chave: 'liame:disparo:alheia', id: ALHEIA, confirmacao: CONFIRMACAO }))).toMatchObject({ tipo: 'definitivo', message: `campanha_disparar: ${SO_A_PROPRIA}` });
    expect(feitas.get('campanha_disparar') ?? 0).toBe(0);
    await semChamada(() => pausarCampanha(ctx(), { ...a, chave: 'liame:pausa:id-torto', id: 'x' }), 'id da campanha');
  });
});
