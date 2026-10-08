import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withTenant } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ApplyOptions, type ApplyResult, CONNECTORS, type ReadResult } from '../../src/actions/connectors.js';
import { type EstadoDaCampanhaGoogle, googleAnunciosConnector, OPERACOES_DE_ESCRITA_POR_DIA, versaoDaCampanha } from '../../src/actions/google-anuncios.js';
import { TOOLS } from '../../src/actions/tools.js';
import { ErroConector } from '../../src/connectors/cliente-http.js';
import { chaveDe } from '../../src/connectors/cota.js';
import { ownerQuery, startApi, type TestApi } from '../helpers/api.js';
import { ACESSO_DO_GOOGLE, campanhaLida, type CampanhaNoGoogle, type EmpresaComGoogle, empresaComGoogle, GoogleDeMentira, REFRESH_REVOGADO } from '../helpers/google-de-mentira.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A5 · Y2: o conector de escrita do Google Ads contra uma Google Ads API local (`helpers/google-de-mentira.ts`), como o
// app o liga na subida (`EscritaGoogle`). Lê a campanha com o orçamento dela; muda a situação da campanha ou a verba
// diária do orçamento que é só dela; valida antes (`validateOnly`), não sobrescreve mudança de outra pessoa, nunca
// mexe em orçamento compartilhado e adia no limite. Nesta entrega nenhuma ferramenta aceita `google_ads`: o caminho
// pelo pedido, pela aprovação e pelo executor é o da Y3.

const REAL = 1_000_000;

describe.skipIf(!hasDb)('escrita no Google Ads: o conector (A5 · Y2)', () => {
  let api: TestApi;
  let database: Database;
  const google = new GoogleDeMentira();
  const anterior: Record<string, string | undefined> = {};
  let e: EmpresaComGoogle;

  const ref = (emp: EmpresaComGoogle, c: { id: string }, conta = emp.conta) => ({ tenantId: emp.tenantId, accountId: conta, resourceId: `campanha:${c.id}` });
  const ler = (emp: EmpresaComGoogle, c: { id: string }, conta = emp.conta): Promise<ReadResult | null> => withTenant(database.db, emp.tenantId, (tx) => googleAnunciosConnector.read(tx, ref(emp, c, conta)));
  const aplicar = (emp: EmpresaComGoogle, c: { id: string }, desejado: Record<string, unknown>, versao: number, opcoes: ApplyOptions = {}): Promise<ApplyResult> =>
    withTenant(database.db, emp.tenantId, (tx) => googleAnunciosConnector.apply(tx, ref(emp, c), desejado, versao, opcoes));
  /** Uma campanha nova no Google e na lista que o Liame leu da conta. */
  async function campanha(emp: EmpresaComGoogle, extra: Parameters<GoogleDeMentira['novaCampanha']>[1] = {}): Promise<CampanhaNoGoogle> {
    const c = google.novaCampanha(emp.cliente, extra);
    await campanhaLida(emp, c);
    return c;
  }
  const estadoDe = async (emp: EmpresaComGoogle, c: { id: string }) => {
    const lido = await ler(emp, c);
    if (!lido) throw new Error('a campanha não foi lida');
    return { estado: lido.state as EstadoDaCampanhaGoogle, versao: lido.version };
  };

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    await google.subir();
    const ambiente = google.ambiente();
    for (const k of Object.keys(ambiente)) anterior[k] = process.env[k];
    Object.assign(process.env, ambiente);
    api = await startApi();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    e = await empresaComGoogle(api, database);
  }, 120_000);
  beforeEach(() => {
    google.chamadas.length = 0;
    google.defeitos.clear();
    google.renovacoes = 0;
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await google.fechar();
    for (const [k, v] of Object.entries(anterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('nesta entrega nada chega ao conector: ele não está no registro, e nenhuma ferramenta aceita o Google', () => {
    expect(CONNECTORS.google_ads).toBeUndefined();
    expect(Object.values(TOOLS).filter((t) => t.providers.includes('google_ads'))).toEqual([]);
    // Quando entrar (Y3), entra com a flag de escrita e com os limites de gasto, como a Meta.
    expect(googleAnunciosConnector).toMatchObject({ provider: 'google_ads', writeFlag: 'google_write', requiresSpendLimits: true });
  });

  it('lê a campanha no Google com o orçamento dela, pela conta gerente; a que não é da conta ou da empresa não é lida', async () => {
    const c = await campanha(e, { name: 'Busca hambúrguer perto' });
    const lido = await ler(e, c);
    const orcamento = google.orcamentos.get(c.orcamento!)!;
    expect(lido!.state).toEqual({
      tipo: 'campanha',
      id: c.id,
      nome: 'Busca hambúrguer perto',
      status: 'ativo',
      status_efetivo: 'ELIGIBLE',
      daily_budget_micros: 30 * REAL,
      lifetime_budget_micros: null,
      moeda: 'BRL',
      orcamento: { id: orcamento.id, compartilhado: false, campanhas: 1, diario_micros: 30 * REAL },
    });
    expect(lido!.version).toBe(versaoDaCampanha(lido!.state as EstadoDaCampanhaGoogle));
    // Uma troca de token e uma consulta, com o token curto, pela conta gerente, só desta campanha.
    expect(google.renovacoes).toBe(1);
    const [consulta] = google.chamadasDe(e.cliente);
    expect(google.chamadasDe(e.cliente)).toHaveLength(1);
    expect(consulta).toMatchObject({ tipo: 'leitura', autorizacao: `Bearer ${ACESSO_DO_GOOGLE}`, gerente: e.gerente });
    expect(String(consulta!.corpo.query)).toMatch(new RegExp(`campaign_budget\\.explicitly_shared, campaign_budget\\.reference_count, campaign_budget\\.period FROM campaign WHERE campaign\\.id = ${c.id}$`));

    // A leitura em duas partes (o banco, depois o Google) dá o mesmo.
    const preparada = await withTenant(database.db, e.tenantId, (tx) => googleAnunciosConnector.prepareRead(tx, ref(e, c)));
    expect(await googleAnunciosConnector.readPrepared(preparada!)).toEqual(lido);

    // A campanha que o Liame não leu desta conta, a de recurso que não é campanha e a de outra empresa: nada é pedido ao Google.
    google.chamadas.length = 0;
    const naoLida = google.novaCampanha(e.cliente);
    expect(await ler(e, naoLida)).toBeNull();
    expect(await withTenant(database.db, e.tenantId, (tx) => googleAnunciosConnector.read(tx, { tenantId: e.tenantId, accountId: e.conta, resourceId: `conjunto:${c.id}` }))).toBeNull();
    const outra = await empresaComGoogle(api, database, { nome: 'Outra Hamburgueria' });
    expect(await ler(outra, c, e.conta)).toBeNull();
    expect(google.chamadas).toHaveLength(0);
    // A que o Liame leu, mas o Google não tem mais nesta conta: lida como "não existe".
    google.campanhas.delete(c.id);
    expect(await ler(e, c)).toBeNull();
  });

  it('pausar e retomar: valida antes sem mudar nada, escreve só a situação e confere depois', async () => {
    const c = await campanha(e);
    const { estado, versao } = await estadoDe(e, c);
    google.chamadas.length = 0;
    const desejado = { ...estado, status: 'pausado' };

    // A validação: o Google confere e não muda nada.
    expect(await aplicar(e, c, desejado, versao, { validateOnly: true })).toEqual({ ok: true, state: desejado, version: versao });
    expect(google.campanhas.get(c.id)!.status).toBe('ENABLED');
    expect(google.resumo(e.cliente)).toEqual(['leitura', 'validacao:campaigns']);

    // A escrita de verdade: só a situação, pela máscara, e a leitura depois confirma.
    google.chamadas.length = 0;
    const feito = await aplicar(e, c, desejado, versao);
    expect(google.campanhas.get(c.id)!.status).toBe('PAUSED');
    expect(google.resumo(e.cliente)).toEqual(['leitura', 'escrita:campaigns', 'leitura']);
    expect(google.escritasDe(e.cliente)[0]!.corpo).toEqual({
      operations: [{ updateMask: 'status', update: { resourceName: `customers/${e.cliente}/campaigns/${c.id}`, status: 'PAUSED' } }],
      validateOnly: false,
    });
    expect(feito).toMatchObject({ ok: true, state: { status: 'pausado', status_efetivo: 'PAUSED', conferido: true } });
    // A versão em que a ação deixa a campanha é a do estado novo: é com ela que a volta confere se alguém mexeu depois.
    const depois = await estadoDe(e, c);
    expect(feito.ok && feito.version).toBe(depois.versao);
    expect(depois.versao).not.toBe(versao);

    // A volta: retomar, a partir do estado de agora.
    const volta = await aplicar(e, c, { ...depois.estado, status: 'ativo' }, depois.versao);
    expect(volta).toMatchObject({ ok: true, state: { status: 'ativo', conferido: true } });
    expect(google.campanhas.get(c.id)!.status).toBe('ENABLED');
  });

  it('mudar a verba diária: muda o orçamento que é só da campanha, pelo campo certo, em micros', async () => {
    const c = await campanha(e);
    const orcamento = google.orcamentos.get(c.orcamento!)!;
    const { estado, versao } = await estadoDe(e, c);
    google.chamadas.length = 0;
    const desejado = { ...estado, daily_budget_micros: 33 * REAL };

    expect(await aplicar(e, c, desejado, versao, { validateOnly: true })).toMatchObject({ ok: true });
    expect(orcamento.amountMicros).toBe(30 * REAL);
    const feito = await aplicar(e, c, desejado, versao);
    expect(orcamento.amountMicros).toBe(33 * REAL);
    expect(google.resumo(e.cliente)).toEqual(['leitura', 'validacao:campaignBudgets', 'leitura', 'escrita:campaignBudgets', 'leitura']);
    // A máscara vai em snake_case e o campo em camelCase, com o valor inteiro em micros (como texto: é int64).
    expect(google.escritasDe(e.cliente)[0]!.corpo).toEqual({
      operations: [{ updateMask: 'amount_micros', update: { resourceName: `customers/${e.cliente}/campaignBudgets/${orcamento.id}`, amountMicros: '33000000' } }],
      validateOnly: false,
    });
    expect(feito).toMatchObject({ ok: true, state: { daily_budget_micros: 33 * REAL, orcamento: { id: orcamento.id, diario_micros: 33 * REAL, compartilhado: false }, conferido: true } });
    // A situação da campanha não foi tocada.
    expect(google.campanhas.get(c.id)!.status).toBe('ENABLED');

    // Fração de centavo e as duas coisas no mesmo pedido não saem do Liame.
    const agora = await estadoDe(e, c);
    google.chamadas.length = 0;
    expect(await aplicar(e, c, { ...agora.estado, daily_budget_micros: 33 * REAL + 1 }, agora.versao)).toEqual({ ok: false, reason: 'recusado', mensagem: 'A verba diária precisa ser um valor positivo, sem fração de centavo.' });
    expect(await aplicar(e, c, { ...agora.estado, daily_budget_micros: 40 * REAL, status: 'pausado' }, agora.versao)).toMatchObject({ ok: false, reason: 'recusado', mensagem: expect.stringContaining('não as duas de uma vez') });
    expect(google.resumo(e.cliente)).toEqual(['leitura', 'leitura']);
  });

  it('orçamento compartilhado nunca é alterado (A5-6): o estado diz quantas campanhas dividem, e a verba não muda por aqui', async () => {
    // Dividido de fato: duas campanhas no mesmo orçamento, mesmo sem ter sido criado como compartilhado.
    const dividido = google.novoOrcamento(e.cliente, { amountMicros: 80 * REAL });
    const a = await campanha(e, { orcamento: dividido.id, name: 'Busca marca' });
    await campanha(e, { orcamento: dividido.id, name: 'Busca concorrente' });
    const lidaA = await estadoDe(e, a);
    // A verba diária "só dela" não existe; o orçamento diz o que é e quantas dividem.
    expect(lidaA.estado).toMatchObject({ daily_budget_micros: null, orcamento: { id: dividido.id, compartilhado: true, campanhas: 2, diario_micros: 80 * REAL } });
    google.chamadas.length = 0;
    const recusa = await aplicar(e, a, { ...lidaA.estado, daily_budget_micros: 88 * REAL }, lidaA.versao);
    expect(recusa).toEqual({
      ok: false,
      reason: 'recusado',
      mensagem: 'A verba desta campanha vem de um orçamento compartilhado com outra campanha no Google: mudar aqui mudaria a verba dela também. O Liame não muda orçamento compartilhado.',
    });
    expect(await aplicar(e, a, { ...lidaA.estado, daily_budget_micros: 88 * REAL }, lidaA.versao, { validateOnly: true })).toMatchObject({ ok: false, reason: 'recusado' });

    // Criado para ser dividido, hoje com uma campanha só: também não.
    const explicito = google.novoOrcamento(e.cliente, { explicitlyShared: true });
    const b = await campanha(e, { orcamento: explicito.id });
    const lidaB = await estadoDe(e, b);
    expect(lidaB.estado).toMatchObject({ daily_budget_micros: null, orcamento: { compartilhado: true, campanhas: 1 } });
    expect(await aplicar(e, b, { ...lidaB.estado, daily_budget_micros: 33 * REAL }, lidaB.versao)).toMatchObject({ ok: false, reason: 'recusado', mensagem: expect.stringContaining('O Liame não muda orçamento compartilhado.') });

    // Nenhuma escrita nem validação de orçamento chegou ao Google, e os valores seguem os mesmos.
    expect(google.chamadas.filter((x) => x.recurso === 'campaignBudgets')).toHaveLength(0);
    expect([dividido.amountMicros, explicito.amountMicros]).toEqual([80 * REAL, 30 * REAL]);

    // Pausar a campanha de um orçamento compartilhado pode: só ela para.
    const pausa = await aplicar(e, a, { ...lidaA.estado, status: 'pausado' }, lidaA.versao);
    expect(pausa).toMatchObject({ ok: true, state: { status: 'pausado' } });
    expect(google.campanhas.get(a.id)!.status).toBe('PAUSED');
  });

  it('orçamento de período não muda pelo Liame; campanha removida não muda de situação', async () => {
    const periodo = google.novoOrcamento(e.cliente, { amountMicros: null, totalAmountMicros: 900 * REAL, period: 'CUSTOM_PERIOD' });
    const c = await campanha(e, { orcamento: periodo.id });
    const lida = await estadoDe(e, c);
    expect(lida.estado).toMatchObject({ daily_budget_micros: null, lifetime_budget_micros: 900 * REAL, orcamento: { compartilhado: false, diario_micros: null } });
    expect(await aplicar(e, c, { ...lida.estado, daily_budget_micros: 30 * REAL }, lida.versao)).toEqual({ ok: false, reason: 'recusado', mensagem: 'Esta campanha não tem verba diária própria: a verba dela é de período.' });
    expect(await aplicar(e, c, { ...lida.estado, lifetime_budget_micros: 1000 * REAL }, lida.versao)).toEqual({ ok: false, reason: 'recusado', mensagem: 'A verba de período não muda pelo Liame.' });

    const removida = await campanha(e, { status: 'REMOVED', primaryStatus: 'REMOVED' });
    const lidaRemovida = await estadoDe(e, removida);
    expect(lidaRemovida.estado.status).toBe('removido');
    expect(await aplicar(e, removida, { ...lidaRemovida.estado, status: 'ativo' }, lidaRemovida.versao)).toEqual({ ok: false, reason: 'recusado', mensagem: 'A campanha foi removida no Google: não dá para mudar a situação dela.' });
    expect(google.chamadas.filter((x) => x.tipo !== 'leitura')).toHaveLength(0);
  });

  it('não sobrescreve o que outra pessoa mudou; e o que já está como o pedido queria não é escrito de novo', async () => {
    const c = await campanha(e);
    const orcamento = google.orcamentos.get(c.orcamento!)!;
    const pedido = await estadoDe(e, c);

    // Alguém mudou a verba no Google Ads depois do pedido: a mudança da pessoa vence.
    orcamento.amountMicros = 45 * REAL;
    google.chamadas.length = 0;
    const r = await aplicar(e, c, { ...pedido.estado, status: 'pausado' }, pedido.versao);
    expect(r).toMatchObject({ ok: false, reason: 'estado-mudou', current: { state: { status: 'ativo', daily_budget_micros: 45 * REAL } } });
    expect(google.resumo(e.cliente)).toEqual(['leitura']);
    expect(google.campanhas.get(c.id)!.status).toBe('ENABLED');

    // O orçamento passou a ser dividido com outra campanha depois do pedido: também é "o estado mudou".
    const antes = await estadoDe(e, c);
    await campanha(e, { orcamento: orcamento.id });
    expect(await aplicar(e, c, { ...antes.estado, status: 'pausado' }, antes.versao)).toMatchObject({ ok: false, reason: 'estado-mudou', current: { state: { orcamento: { compartilhado: true, campanhas: 2 } } } });

    // Outra campanha, que já está em pausa quando a ação roda (alguém pausou, ou a tentativa anterior caiu depois do
    // aceite): nada a escrever, mesmo com a versão de antes.
    const d = await campanha(e);
    const pedidoD = await estadoDe(e, d);
    google.campanhas.get(d.id)!.status = 'PAUSED';
    google.chamadas.length = 0;
    const ja = await aplicar(e, d, { ...pedidoD.estado, status: 'pausado' }, pedidoD.versao);
    expect(ja).toMatchObject({ ok: true, state: { status: 'pausado', conferido: true, sem_escrita: true } });
    expect(google.resumo(e.cliente)).toEqual(['leitura']);
  });

  it('a recusa do Google na validação vira "recusado", com o motivo dele, e nada é escrito', async () => {
    const c = await campanha(e);
    const orcamento = google.orcamentos.get(c.orcamento!)!;
    const { estado, versao } = await estadoDe(e, c);
    google.chamadas.length = 0;
    const r = await aplicar(e, c, { ...estado, daily_budget_micros: 9_000 * REAL }, versao, { validateOnly: true });
    expect(r).toEqual({ ok: false, reason: 'recusado', mensagem: 'O Google recusou a mudança: A money amount was greater than the maximum allowed (campaignBudgetError.MONEY_AMOUNT_TOO_LARGE).' });
    expect(google.resumo(e.cliente)).toEqual(['leitura', 'validacao:campaignBudgets']);
    expect(orcamento.amountMicros).toBe(30 * REAL);
  });

  it('o limite do Google adia em vez de insistir: o diário espera pelo menos uma hora, o de pouco tempo espera o que ele pedir', async () => {
    const c = await campanha(e);
    const { estado, versao } = await estadoDe(e, c);
    const desejado = { ...estado, status: 'pausado' };
    const limite = async (): Promise<ErroConector> => {
      const erro = await aplicar(e, c, desejado, versao, { validateOnly: true }).then(
        () => null,
        (err: unknown) => err,
      );
      expect(erro).toBeInstanceOf(ErroConector);
      return erro as ErroConector;
    };

    // O limite diário de operações do projeto: o Google pede 15 minutos; o Liame espera pelo menos uma hora.
    google.defeitos.set(e.cliente, (x) =>
      x.tipo === 'leitura' ? null : google.erro(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).', { codigo: { quotaError: 'RESOURCE_EXHAUSTED' }, texto: 'Too many requests. Retry in 900 seconds.', esperar: '900s' }),
    );
    google.chamadas.length = 0;
    const diario = await limite();
    expect(diario).toMatchObject({ tipo: 'limite', subcodigo: 'quotaError.RESOURCE_EXHAUSTED', esperarMs: 3_600_000 });
    // Uma chamada só: não insistiu.
    expect(google.resumo(e.cliente)).toEqual(['leitura', 'validacao:campaigns']);

    // Muitas chamadas em pouco tempo: espera o que o Google pediu.
    google.defeitos.set(e.cliente, (x) =>
      x.tipo === 'leitura' ? null : google.erro(429, 'RESOURCE_EXHAUSTED', 'Resource has been exhausted (e.g. check quota).', { codigo: { quotaError: 'RESOURCE_TEMPORARILY_EXHAUSTED' }, texto: 'Too many requests in a short amount of time.', esperar: '30s' }),
    );
    expect(await limite()).toMatchObject({ tipo: 'limite', subcodigo: 'quotaError.RESOURCE_TEMPORARILY_EXHAUSTED', esperarMs: 30_000 });

    // O Google fora do ar também sobe para quem executa adiar.
    google.defeitos.set(e.cliente, (x) => (x.tipo === 'leitura' ? null : google.erro(503, 'UNAVAILABLE', 'The service is currently unavailable.')));
    expect(await limite()).toMatchObject({ tipo: 'transitorio' });
    expect(google.campanhas.get(c.id)!.status).toBe('ENABLED');
  });

  it('uma empresa não gasta a cota das outras (A5-7): com a cota do dia esgotada, a ação espera sem chamar o Google, e a outra empresa segue', async () => {
    const a = await empresaComGoogle(api, database, { nome: 'Hamburgueria que gastou a cota' });
    const b = await empresaComGoogle(api, database, { nome: 'Hamburgueria ao lado' });
    const ca = google.novaCampanha(a.cliente);
    await campanhaLida(a, ca);
    const cb = google.novaCampanha(b.cliente);
    await campanhaLida(b, cb);
    const lidaA = (await ler(a, ca))!;

    // A cota de escrita da empresa A acabou (o balde dela, vazio agora).
    const balde = await ownerQuery<{ capacidade: number }>(`update liame.quota_bucket set tokens = 0, refilled_at = now() where bucket_key = $1 returning capacity::int as capacidade`, [
      chaveDe('google_ads', `escrita:${a.tenantId}`),
    ]);
    // O balde é o da empresa, com a cota diária da escrita.
    expect(balde).toEqual([{ capacidade: OPERACOES_DE_ESCRITA_POR_DIA }]);
    google.chamadas.length = 0;
    const erro = await aplicar(a, ca, { ...lidaA.state, status: 'pausado' }, lidaA.version).then(
      () => null,
      (err: unknown) => err,
    );
    expect(erro).toBeInstanceOf(ErroConector);
    expect(erro).toMatchObject({ tipo: 'limite' });
    // A espera é a do balde encher uma ficha (o dia dividido pela cota): minutos, não um instante.
    expect((erro as ErroConector).esperarMs).toBeGreaterThan(60_000);
    expect(google.chamadasDe(a.cliente)).toHaveLength(0);
    expect(google.campanhas.get(ca.id)!.status).toBe('ENABLED');

    // A empresa B, na mesma hora, lê e escreve normalmente.
    const lidaB = (await ler(b, cb))!;
    expect(await aplicar(b, cb, { ...lidaB.state, status: 'pausado' }, lidaB.version)).toMatchObject({ ok: true, state: { status: 'pausado' } });
    expect(google.campanhas.get(cb.id)!.status).toBe('PAUSED');
  });

  it('autorização revogada ou sem permissão na conta: a ação é recusada com o que fazer, e nada é escrito', async () => {
    const c = await campanha(e);
    const { estado, versao } = await estadoDe(e, c);
    google.defeitos.set(e.cliente, () => google.erro(403, 'PERMISSION_DENIED', 'The caller does not have permission', { codigo: { authorizationError: 'USER_PERMISSION_DENIED' }, texto: "User doesn't have permission to access customer." }));
    const semPermissao = await aplicar(e, c, { ...estado, status: 'pausado' }, versao);
    expect(semPermissao).toMatchObject({ ok: false, reason: 'recusado', mensagem: expect.stringContaining('não tem permissão para gerenciar as campanhas desta conta') });
    google.defeitos.clear();

    // O Google recusa o refresh token (autorização revogada ou vencida): nem chega à Google Ads API.
    const revogada = await empresaComGoogle(api, database, { nome: 'Hamburgueria desconectada', refresh: REFRESH_REVOGADO });
    const cr = google.novaCampanha(revogada.cliente);
    await campanhaLida(revogada, cr);
    const r = await aplicar(revogada, cr, { tipo: 'campanha', id: cr.id, status: 'pausado', daily_budget_micros: 30 * REAL, lifetime_budget_micros: null }, 1);
    expect(r).toEqual({ ok: false, reason: 'recusado', mensagem: 'O Google recusou o acesso desta conta (a autorização foi revogada ou venceu). Conecte o Google de novo em Contas conectadas.' });
    expect(google.chamadasDe(revogada.cliente)).toHaveLength(0);
    expect(google.campanhas.get(c.id)!.status).toBe('ENABLED');
  });
});
