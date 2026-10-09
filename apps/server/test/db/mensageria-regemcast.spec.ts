import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClienteConector, ErroConector } from '../../src/connectors/cliente-http.js';
import {
  detalharCampanhaDeMensagens,
  lerCampanhasDeMensagens,
  lerContaDeMensagens,
  lerModelos,
  lerOrcamentoDeMensagens,
  lerPublicos,
} from '../../src/connectors/regemcast/conector-regemcast.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A5 · Y4 (parte 1): as leituras da mensageria no conector do RegemCast, contra um RegemCast falso que fala o MCP
// 2026-07-28 sem estado, com as respostas no formato que o RegemCast declara (`docs/mcp.md` e `mcp.leitura.ts` de lá,
// lidos em 08/10/2026): a situação da conta, as campanhas com os números e o custo, os públicos (só contagens), os
// modelos e o orçamento de disparos. Nenhuma rota e nenhuma rotina do Liame usa estas leituras ainda.

const TOKEN = `rct_it_${'M'.repeat(43)}`;
const TOKEN_SEM_ESCOPO = `rct_it_${'S'.repeat(43)}`;
const CAMPANHA = '0199f1aa-1111-7222-8333-444455556666';

type Chamada = { ferramenta: string; argumentos: Record<string, unknown>; cabecalhos: IncomingHttpHeaders };

const CAMPANHA_FEITA = {
  id: CAMPANHA,
  nome: 'Sexta em dobro',
  situacao: 'concluida',
  pausaMotivo: null,
  modelo: 'promo_sexta_v2',
  categoria: 'marketing',
  publico: 'Quem pediu nos últimos 30 dias',
  destinatarios: 412,
  naFila: 0,
  enviadas: 405,
  entregues: 398,
  lidas: 301,
  falhas: 7,
  responderam: 22,
  criadaEm: '2026-10-02T14:00:00.000Z',
  iniciadaEm: '2026-10-02T21:00:00.000Z',
  concluidaEm: '2026-10-02T21:19:00.000Z',
};
const CUSTO = { moeda: 'BRL', gastoCentavos: 12_736, aSairCentavos: 0, linhas: [{ rotulo: 'Gasto na Meta', valor: 'R$ 127,36', detalhe: '398 mensagens entregues' }], avisos: [] };
const RESPOSTAS: Record<string, unknown> = {
  conta_situacao: {
    conta: 'Mister Burgers',
    fuso: 'America/Sao_Paulo',
    whatsapp: { conectado: true, sinal: 'pode_enviar', titulo: 'Tudo certo para enviar', resumo: 'A conta do WhatsApp está saudável na Meta.', lidaEm: '2026-10-08T12:00:00.000Z', problemas: [] },
    plano: { nome: 'Essencial', assinatura: 'ativa', gratisPeloRegem: true, disparosNoCiclo: 412, tetoDoCiclo: 5000, restantes: 4588, cicloFim: '2026-10-31' },
  },
  campanhas_listar: { campanhas: [CAMPANHA_FEITA], total: 1 },
  campanha_detalhar: {
    campanha: CAMPANHA_FEITA,
    pausa: null,
    espera: null,
    falhasPorMotivo: [{ mensagens: 7, titulo: 'Número sem WhatsApp', explicacao: 'O número não tem conta no WhatsApp.', acao: 'Confira o número no cadastro.' }],
    custo: CUSTO,
    descansoDias: 7,
  },
  publicos_listar: {
    listas: [{ id: 'l1', nome: 'Clientes do salão', regra: null, pessoas: 180, usadaEm: '2026-09-20T15:00:00.000Z' }],
    publicos: [{ id: 'recentes_30', nome: 'Quem pediu nos últimos 30 dias', regra: 'Pedido confirmado nos últimos 30 dias', pessoas: 412 }],
    perfis: [{ id: 'fieis', nome: 'Fiéis', regra: '3 pedidos ou mais em 60 dias', pessoas: 96 }],
  },
  modelos_listar: {
    modelos: [
      {
        id: 'm1',
        nome: 'promo_sexta_v2',
        idioma: 'pt_BR',
        categoria: 'marketing',
        situacao: 'aprovado',
        podeDisparar: true,
        qualidade: 'alta',
        variaveis: 1,
        cabecalho: null,
        corpo: 'Oi, {{1}}! Sexta tem smash em dobro. Peça pelo cardápio.',
        rodape: 'Responda SAIR para não receber mais.',
        botoes: ['Ver o cardápio'],
        alertas: [],
      },
    ],
  },
  orcamento_ler: {
    moeda: 'BRL',
    tetos: { dia: null, semana: null, mes: 30_000 },
    periodos: [{ periodo: 'mes', rotulo: 'Outubro', tetoCentavos: 30_000, gastoCentavos: 12_736, percentual: 42.45, texto: 'R$ 127,36 de R$ 300,00 neste mês', sinal: 'ok' }],
    avisos: [],
  },
};

describe.skipIf(!hasDb)('conector do RegemCast: as leituras da mensageria (A5 · Y4)', () => {
  let database: Database;
  let regemcast: Server;
  let base = '';
  const chamadas: Chamada[] = [];
  /** O que o RegemCast falso devolve no lugar da resposta normal de uma ferramenta. */
  const trocas = new Map<string, unknown>();
  let status: number | null = null;
  const ctx = () => ({ cliente: new ClienteConector(database.db, { enderecos: { regemcast: [base] }, tentativas: 1 }), apiUrl: base });
  const acesso = (token = TOKEN) => ({ token, contaChave: `teste-${token.slice(7, 10)}` });
  const resultado = (sc: unknown) => ({ result: { content: [{ type: 'text', text: JSON.stringify(sc) }], structuredContent: sc, resultType: 'complete' } });
  const erro = async (p: Promise<unknown>): Promise<ErroConector> => {
    const e = await p.then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(ErroConector);
    return e as ErroConector;
  };

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    regemcast = createServer((req, res) => {
      let texto = '';
      req.on('data', (d: Buffer) => (texto += d.toString('utf8')));
      req.on('end', () => {
        const corpo = JSON.parse(texto) as { id?: unknown; params?: { name?: string; arguments?: Record<string, unknown> } };
        const nome = corpo.params?.name ?? '';
        chamadas.push({ ferramenta: nome, argumentos: corpo.params?.arguments ?? {}, cabecalhos: req.headers });
        const comId = (r: object) => ({ jsonrpc: '2.0', id: corpo.id, ...r });
        const credencial = (req.headers.authorization ?? '').replace(/^Bearer /, '');
        let r: { status: number; corpo: unknown };
        if (status) r = { status, corpo: { mensagem: 'recusado' } };
        else if (credencial !== TOKEN && credencial !== TOKEN_SEM_ESCOPO) r = { status: 401, corpo: { mensagem: 'Token de integração inválido ou revogado.' } };
        // O RegemCast nem lista a ferramenta que o token não pode usar: a chamada direta responde "não encontrada".
        else if (credencial === TOKEN_SEM_ESCOPO || !(nome in RESPOSTAS)) r = { status: 200, corpo: comId({ error: { code: -32602, message: `Tool ${nome} not found` } }) };
        else r = { status: 200, corpo: comId(resultado(trocas.has(nome) ? trocas.get(nome) : RESPOSTAS[nome])) };
        res.writeHead(r.status, { 'content-type': 'application/json', ...(r.status === 429 ? { 'retry-after': '30' } : {}), ...(r.status === 401 ? { 'www-authenticate': 'Bearer' } : {}) });
        res.end(JSON.stringify(r.corpo));
      });
    });
    await new Promise<void>((ok) => regemcast.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(regemcast.address() as AddressInfo).port}`;
  }, 120_000);
  beforeEach(() => {
    chamadas.length = 0;
    trocas.clear();
    status = null;
  });
  afterAll(async () => {
    await database?.close();
    await new Promise((ok) => regemcast?.close(ok));
  });

  it('lê a situação da conta, as campanhas com os números e o custo, os públicos, os modelos e o orçamento, cada um pela ferramenta dele', async () => {
    expect(await lerContaDeMensagens(ctx(), acesso())).toEqual(RESPOSTAS.conta_situacao);
    expect(await lerCampanhasDeMensagens(ctx(), { ...acesso(), situacao: 'concluida', limite: 10 })).toEqual(RESPOSTAS.campanhas_listar);
    expect(await detalharCampanhaDeMensagens(ctx(), { ...acesso(), id: CAMPANHA })).toEqual(RESPOSTAS.campanha_detalhar);
    expect(await lerPublicos(ctx(), acesso())).toEqual(RESPOSTAS.publicos_listar);
    expect(await lerModelos(ctx(), { ...acesso(), soAprovados: true })).toEqual(RESPOSTAS.modelos_listar);
    expect(await lerOrcamentoDeMensagens(ctx(), acesso())).toEqual(RESPOSTAS.orcamento_ler);

    expect(chamadas.map((c) => [c.ferramenta, c.argumentos])).toEqual([
      ['conta_situacao', {}],
      ['campanhas_listar', { limite: 10, situacao: 'concluida' }],
      ['campanha_detalhar', { id: CAMPANHA }],
      ['publicos_listar', {}],
      ['modelos_listar', { soAprovados: true }],
      ['orcamento_ler', {}],
    ]);
    // O token vai só no cabeçalho, com o nome da ferramenta que o servidor confere contra o corpo.
    for (const c of chamadas) expect(c.cabecalhos).toMatchObject({ authorization: `Bearer ${TOKEN}`, 'mcp-method': 'tools/call', 'mcp-name': c.ferramenta });
    // Sem filtro, a lista de campanhas pede 20; o limite nunca passa de 50 (o teto da ferramenta).
    chamadas.length = 0;
    await lerCampanhasDeMensagens(ctx(), acesso());
    await lerCampanhasDeMensagens(ctx(), { ...acesso(), limite: 500 });
    await lerModelos(ctx(), acesso());
    expect(chamadas.map((c) => c.argumentos)).toEqual([{ limite: 20 }, { limite: 50 }, {}]);
  });

  it('A5-9: nenhum telefone, nome de contato ou outro campo fora do contrato passa para o Liame', async () => {
    // Se o RegemCast um dia mandar mais do que o contrato diz, o que não foi pedido fica na porta.
    trocas.set('publicos_listar', {
      listas: [{ id: 'l1', nome: 'Clientes do salão', regra: null, pessoas: 2, usadaEm: null, contatos: [{ nome: 'Maria Souza', telefone: '+5521999990001' }] }],
      publicos: [{ id: 'recentes_30', nome: 'Quem pediu nos últimos 30 dias', regra: null, pessoas: 1, telefones: ['+5521999990002'] }],
      perfis: [],
      amostra: [{ nome: 'João', telefone: '+5521999990003' }],
    });
    trocas.set('campanha_detalhar', { ...(RESPOSTAS.campanha_detalhar as object), destinatarios: [{ telefone: '+5521999990004', status: 'lida' }], campanha: { ...CAMPANHA_FEITA, criadaPor: 'maria@misterburgers.example' } });
    const publicos = await lerPublicos(ctx(), acesso());
    const campanha = await detalharCampanhaDeMensagens(ctx(), { ...acesso(), id: CAMPANHA });
    const recebido = JSON.stringify({ publicos, campanha });
    for (const proibido of ['+55219', 'telefone', 'Maria', 'João', 'contatos', 'amostra', 'destinatarios":[', 'criadaPor', '@misterburgers']) expect(recebido, proibido).not.toContain(proibido);
    // As contagens que o Liame pediu chegam inteiras.
    expect(publicos).toEqual({ listas: [{ id: 'l1', nome: 'Clientes do salão', regra: null, pessoas: 2, usadaEm: null }], publicos: [{ id: 'recentes_30', nome: 'Quem pediu nos últimos 30 dias', regra: null, pessoas: 1 }], perfis: [] });
    expect(campanha.campanha.destinatarios).toBe(412);
  });

  it('resposta fora do contrato é erro definitivo, sem repetir o conteúdo; sem a permissão, sem token e no limite, cada falha tem o tipo dela', async () => {
    trocas.set('orcamento_ler', { moeda: 'BRL', tetos: { dia: null, semana: null, mes: 'trezentos' }, periodos: [], avisos: [] });
    const torta = await erro(lerOrcamentoDeMensagens(ctx(), acesso()));
    expect(torta).toMatchObject({ tipo: 'definitivo', message: 'resposta fora do contrato em orcamento_ler (tetos.mes)' });
    expect(torta.message).not.toContain('trezentos');
    // Centavos com fração ou negativos não são dinheiro do contrato.
    trocas.set('orcamento_ler', { ...(RESPOSTAS.orcamento_ler as object), tetos: { dia: 10.5, semana: null, mes: null } });
    expect(await erro(lerOrcamentoDeMensagens(ctx(), acesso()))).toMatchObject({ tipo: 'definitivo' });

    // O token sem a permissão da ferramenta: o RegemCast diz "não encontrada", e o Liame lê como falta de permissão.
    expect(await erro(lerPublicos(ctx(), acesso(TOKEN_SEM_ESCOPO)))).toMatchObject({ tipo: 'permissao', message: 'publicos_listar: o token não tem a permissão desta ferramenta' });
    expect(await erro(lerModelos(ctx(), acesso(`rct_it_${'X'.repeat(43)}`)))).toMatchObject({ tipo: 'autenticacao', status: 401 });
    status = 403;
    expect(await erro(lerContaDeMensagens(ctx(), acesso()))).toMatchObject({ tipo: 'permissao', status: 403 });
    status = 429;
    expect(await erro(lerCampanhasDeMensagens(ctx(), acesso()))).toMatchObject({ tipo: 'limite', status: 429, esperarMs: 30_000 });
  });
});
