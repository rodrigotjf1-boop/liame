import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { type Database, runMigrations, withTenant } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RESPOSTAS_PRONTAS } from '../../src/ai/social/comentario.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { PASSOS_DA_RECLAMACAO, RESPOSTAS_DA_MENCAO } from '../../src/direct/tipo-no-direct.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { DirectLoop } from '../../src/worker/direct-loop.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { InstagramDeMentira, SEGREDO_DO_APP, TOKEN_DO_INSTAGRAM } from '../helpers/instagram-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais } from '../helpers/posts-semeados.js';
import { hasDb, OWNER_URL } from './env.js';

// A6 · Z12, parte 1: o Direct do Instagram, a leitura e o ajuste (migration 0130; P39, D-A6-107 a D-A6-112), contra
// Postgres, a Meta local e um Regem local. O que se prova:
//   - ligar pede o Dono ou um Administrador, a função liberada, a confirmação de que nenhum outro programa responde o
//     Direct e o código do app; desligar é de quem aprova, sem código; a auditoria leva o antes e o depois;
//   - a rotina lê as conversas e as mensagens das que mudaram (a segunda leitura não relê o que não mudou), e a tela
//     lista com as situações, a busca e a conversa; desligado, não lê;
//   - o Regem (D-A6-107): sem o escopo, não confere (não chama o Regem) e a leitura espera; atendendo esta conta, o Liame
//     apaga o que tinha e não lê; livre de novo, lê;
//   - sem a permissão de mensagens, a leitura diz `sem_permissao`;
//   - o Messenger da Página (A6, Z14, parte 1; D-A6-120 a D-A6-124): liga separado, com a função `messenger`; a leitura
//     traz a conversa com o nome, sem @, só com a tarefa MESSAGING na Página; a lista mostra o canal e filtra por ele, a
//     busca olha o nome, o contador soma os dois canais; a Central do Regem atendendo a Página apaga só o Messenger
//     (responder no Messenger: `direct-responder.spec.ts`).

/** O token da loja no Regem de mentira (só deste arquivo). */
const DA_LOJA = `rgm_it_${randomUUID().replace(/-/g, '')}`;

describe.skipIf(!hasDb)('o Direct do Instagram: a leitura e o ajuste (A6 · Z12, parte 1)', () => {
  let api: TestApi;
  let database: Database;
  let vault: VaultService;
  let fila: DirectLoop;
  const meta = new InstagramDeMentira();
  // O Regem de mentira: a porta de integração, só com os canais que a Central atende.
  let canais: { instagram: { ig_user_id: string; usuario: string | null }[]; messenger: { pagina_id: string }[] } = { instagram: [], messenger: [] };
  const pedidosAoRegem: string[] = [];
  let regem: Server;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    await meta.ligar();
    regem = createServer((req, res) => {
      pedidosAoRegem.push(`${req.method} ${req.url}`);
      const ok = req.headers.authorization === `Bearer ${DA_LOJA}` && req.url === '/integracao/atendimento/canais';
      res.writeHead(ok ? 200 : 403, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ok ? canais : { code: 'escopo-insuficiente' }));
    });
    await new Promise<void>((ok) => regem.listen(0, '127.0.0.1', ok));
    const regemUrl = `http://127.0.0.1:${(regem.address() as AddressInfo).port}/integracao`;
    const config: AppConfig = api.app.get(APP_CONFIG);
    database = api.app.get(DATABASE);
    vault = api.app.get(VaultService);
    fila = new DirectLoop(
      database,
      {
        ...config,
        plataformas: { ...config.plataformas, metaGraphUrl: meta.base, metaAppSecret: SEGREDO_DO_APP },
        produtos: { ...config.produtos, regemApiUrl: regemUrl, regemPelaLigacao: false },
      },
      vault,
      api.app.get(FlagService),
    );
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    meta.normalizar();
    canais = { instagram: [], messenger: [] };
    pedidosAoRegem.length = 0;
  });
  afterAll(async () => {
    await meta.desligar();
    await new Promise((ok) => regem?.close(ok));
    await api?.close();
  });

  async function empresa(nome: string, o: { funcao?: boolean } = {}): Promise<EmpresaComCanais> {
    const e = await empresaComCanais(api, nome, { token: TOKEN_DO_INSTAGRAM, instagram: true, pagina: true });
    meta.paginas.set(e.pagina!.externo, ['MODERATE', 'MESSAGING']);
    await ligarFlagDaEmpresa(api, 'direct', e.tenantId, o.funcao ?? true);
    return e;
  }
  async function pessoa(e: EmpresaComCanais, role: string): Promise<{ cookie: string }> {
    const email = uniqueEmail(role);
    expect((await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email, role, approve_limit_micros: 1_000_000 } })).status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: role, password: PASSWORD, terms_version: TERMOS } });
    await enableMfa(api, s.cookie!);
    return { cookie: s.cookie! };
  }
  async function codigo(e: EmpresaComCanais): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [e.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${e.userId}`]);
    return totpCode(e.secret, currentStep());
  }
  /** A loja do Regem da marca, com o token e os escopos da autorização (o cofre como a conexão grava). */
  async function lojaDoRegem(e: EmpresaComCanais, escopos: string[]): Promise<{ contaId: string; externo: string }> {
    const contaId = randomUUID();
    const externo = randomUUID();
    const credencial = JSON.stringify({ tipo: 'regem', lojas: [{ loja_id: externo, loja_nome: 'Centro', token: DA_LOJA, escopos }] });
    const segredo = await withTenant(database.db, e.tenantId, (tx) => vault.putSecret(tx, { tenantId: e.tenantId, purpose: 'oauth_regem', plaintext: credencial }));
    await ownerQuery(
      `insert into liame.connected_account (id, tenant_id, brand_id, provider, external_id, name, currency, timezone, credential_secret_id)
       values ($1, $2, $3, 'regem', $4, 'Centro (Regem)', 'BRL', 'America/Sao_Paulo', $5)`,
      [contaId, e.tenantId, e.brandId, externo, segredo],
    );
    return { contaId, externo };
  }
  async function trocarEscopos(e: EmpresaComCanais, loja: { contaId: string; externo: string }, escopos: string[]): Promise<void> {
    const credencial = JSON.stringify({ tipo: 'regem', lojas: [{ loja_id: loja.externo, loja_nome: 'Centro', token: DA_LOJA, escopos }] });
    const segredo = await withTenant(database.db, e.tenantId, (tx) => vault.putSecret(tx, { tenantId: e.tenantId, purpose: 'oauth_regem', plaintext: credencial }));
    await ownerQuery(`update liame.connected_account set credential_secret_id = $2 where id = $1`, [loja.contaId, segredo]);
  }
  const ver = (e: EmpresaComCanais, cookie = e.cookie) => api.call('GET', `/v1/direct/settings?brand_id=${e.brandId}`, { cookie });
  const mudar = (e: EmpresaComCanais, body: Record<string, unknown>, cookie = e.cookie) => api.call('PUT', '/v1/direct/settings', { cookie, body: { brand_id: e.brandId, ...body } });
  const lista = (e: EmpresaComCanais, status = 'espera', q?: string) =>
    api.call('GET', `/v1/direct/conversations?brand_id=${e.brandId}&status=${status}${q ? `&q=${encodeURIComponent(q)}` : ''}`, { cookie: e.cookie });
  const conversa = (e: EmpresaComCanais, id: string) => api.call('GET', `/v1/direct/conversations/${id}?brand_id=${e.brandId}`, { cookie: e.cookie });
  // A rotina lê a conta do Instagram e a da Página (o Messenger, Z14): `ler` fica com o Instagram; `lerOs`, com os dois.
  const ler = async (e: EmpresaComCanais, agora = new Date()) => (await fila.executarLote(10, { tenantIds: [e.tenantId] }, agora)).filter((r) => r.conta === e.instagram!.id);
  const lerOs = async (e: EmpresaComCanais, agora = new Date()) => {
    const r = await fila.executarLote(10, { tenantIds: [e.tenantId] }, agora);
    return { instagram: r.find((x) => x.conta === e.instagram!.id), messenger: r.find((x) => x.conta === e.pagina!.id) };
  };
  const mudarMessenger = (e: EmpresaComCanais, body: Record<string, unknown>, cookie = e.cookie) =>
    api.call('PUT', '/v1/direct/messenger', { cookie, body: { brand_id: e.brandId, ...body } });
  const problema = (r: { status: number; body: unknown }) => [r.status, (r.body as { code?: string }).code];
  const emMinutos = (n: number) => new Date(Date.now() + n * 60_000);
  type Lista = { counts: Record<string, number>; items: { id: string; username: string; status: string; unread: boolean; kind: string | null }[] };
  type Sugestao = { kind: string; text: string | null; steps: string[] } | null;
  type ListaComCanal = { counts: Record<string, number>; items: { id: string; channel: string; username: string | null; name: string | null; status: string }[] };

  it('liga com o código e a confirmação; a leitura traz as conversas; a tela lista com as situações e a busca; a segunda leitura só relê a que mudou', async () => {
    const e = await empresa('Casa Brasa Direct');
    const pagina = e.pagina!.externo;
    meta.escreveuNoDirect(pagina, { usuario: 'ana.paula_rj', texto: 'Oi! Vocês entregam na Penha?', minutos: 10 });
    const lucas = meta.escreveuNoDirect(pagina, { usuario: 'lucas_fern', texto: 'Tem combo pra 2?', minutos: 40 });
    meta.marcaNoDirect(lucas, 'Tem sim! O Combo duplo serve bem duas pessoas.', 30);

    // Desligado na marca: a rotina não lê.
    expect((await ler(e))[0]).toMatchObject({ status: 'desligada' });
    // Ligar pede a confirmação de que nenhum outro programa responde e o código do app.
    expect(problema(await mudar(e, { enabled: true, no_other_app: false, code: await codigo(e) }))).toEqual([422, 'confirme-outro-programa']);
    expect(problema(await mudar(e, { enabled: true, no_other_app: true }))).toEqual([400, 'confirme-que-e-voce']);
    const ligado = await mudar(e, { enabled: true, no_other_app: true, code: await codigo(e) });
    expect(ligado.status, JSON.stringify(ligado.body)).toBe(200);
    expect(ligado.body).toMatchObject({ available: true, enabled: true, no_other_app: true, account: { username: 'casabrasa' }, regem: 'pendente', reading: 'nunca' });

    // Ligar traz a vez da conta para agora: sem Regem na empresa, a leitura segue.
    expect((await ler(e))[0]).toMatchObject({ status: 'ok', conversas: 2, relidas: 2, mensagens: 3 });
    expect((await ver(e)).body).toMatchObject({ regem: 'sem_regem', reading: 'ok' });
    const todas = (await lista(e, 'todas')).body as Lista;
    expect(todas.counts).toEqual({ espera: 1, fechando: 0, respondida: 1, fora: 0, todas: 2 });
    expect(todas.items.map((i) => [i.username, i.status, i.unread])).toEqual([
      ['ana.paula_rj', 'espera', true],
      ['lucas_fern', 'respondida', false],
    ]);
    const daConversa = await conversa(e, lucas);
    expect(daConversa.status, JSON.stringify(daConversa.body)).toBe(200);
    expect((daConversa.body as { messages: { direction: string; text: string }[] }).messages.map((m) => [m.direction, m.text])).toEqual([
      ['entrada', 'Tem combo pra 2?'],
      ['saida', 'Tem sim! O Combo duplo serve bem duas pessoas.'],
    ]);
    expect(problema(await conversa(e, 'nao-existe'))).toEqual([404, 'nao-encontrado']);

    // A leitura seguinte não relê o que não mudou; a mensagem nova da pessoa traz só a conversa dela.
    expect((await ler(e, emMinutos(2)))[0]).toMatchObject({ status: 'ok', relidas: 0 });
    meta.escreveuNoDirect(pagina, { usuario: 'lucas_fern', texto: 'Valeu! Até sexta.' });
    expect((await ler(e, emMinutos(4)))[0]).toMatchObject({ status: 'ok', relidas: 1 });
    // As duas esperam; a da Ana fecha a janela antes e vem primeiro. A busca olha o @ e o texto.
    expect(((await lista(e)).body as Lista).items.map((i) => i.username)).toEqual(['ana.paula_rj', 'lucas_fern']);
    expect(((await lista(e, 'todas', 'combo')).body as Lista).items.map((i) => i.username)).toEqual(['lucas_fern']);
    expect(((await lista(e, 'todas', 'ana.paula')).body as Lista).items.map((i) => i.username)).toEqual(['ana.paula_rj']);
    expect(meta.defeitos).toEqual([]);
  }, 120_000);

  it('a mensagem que a pessoa apaga sai do Liame na leitura seguinte da conversa; a conversa que fica sem mensagem sai inteira; a resposta gravada no meio da leitura e o que é mais antigo que o trecho relido ficam (D-A6-112; ERR-231)', async () => {
    const e = await empresa('Casa Brasa Direct Apagada');
    const pagina = e.pagina!.externo;
    const bia = meta.escreveuNoDirect(pagina, { usuario: 'bia_m', texto: 'Qual o horário de vocês?', minutos: 30 });
    meta.marcaNoDirect(bia, 'Das 18h às 23h, todo dia.', 25);
    meta.escreveuNoDirect(pagina, { usuario: 'bia_m', texto: 'Anota o meu número, por favor', minutos: 5 });
    const caio = meta.escreveuNoDirect(pagina, { usuario: 'caio.s', texto: 'Mandei errado, desculpa', minutos: 8 });
    expect((await mudar(e, { enabled: true, no_other_app: true, code: await codigo(e) })).status).toBe(200);
    expect((await ler(e))[0]).toMatchObject({ status: 'ok', conversas: 2, relidas: 2, mensagens: 4 });
    const textos = async (id: string) => ((await conversa(e, id)).body as { messages: { text: string }[] }).messages.map((m) => m.text);
    expect(await textos(bia)).toEqual(['Qual o horário de vocês?', 'Das 18h às 23h, todo dia.', 'Anota o meu número, por favor']);
    // As duas esperam; a do Caio fecha a janela antes e vem primeiro.
    expect(((await lista(e, 'todas')).body as Lista).items.map((i) => [i.username, i.status, i.unread])).toEqual([
      ['caio.s', 'espera', true],
      ['bia_m', 'espera', true],
    ]);

    // A Bia apaga a última mensagem e o Caio, a única: na leitura seguinte, a mensagem dela sai (a conversa volta a ser a
    // respondida, sem nada por abrir) e a conversa dele sai inteira. Antes, a leitura só acrescentava.
    expect(meta.apagouNoDirect(bia)).toBe(2);
    expect(meta.apagouNoDirect(caio)).toBe(0);
    expect((await ler(e, emMinutos(2)))[0]).toMatchObject({ status: 'ok', relidas: 1 });
    expect(await textos(bia)).toEqual(['Qual o horário de vocês?', 'Das 18h às 23h, todo dia.']);
    expect(((await lista(e, 'todas')).body as Lista).items.map((i) => [i.username, i.status, i.unread])).toEqual([['bia_m', 'respondida', false]]);
    expect(problema(await conversa(e, caio))).toEqual([404, 'nao-encontrado']);
    expect(await ownerQuery<{ n: number }>(`select count(*)::int as n from liame.direct_message where tenant_id = $1 and body in ('Anota o meu número, por favor', 'Mandei errado, desculpa')`, [e.tenantId])).toEqual([{ n: 0 }]);

    // O que a releitura não tira: (1) a resposta que o Liame gravou depois de a leitura começar (a Meta ainda não a tinha
    // quando respondeu); (2) o que é mais antigo que o trecho que a Meta devolve (fica até o expurgo dos 90 dias). O que
    // está dentro do trecho, foi lido antes e não veio, sai.
    const [c] = await ownerQuery<{ connected_account_id: string; brand_id: string }>(`select connected_account_id, brand_id from liame.direct_conversation where tenant_id = $1 and conversation_id = $2`, [e.tenantId, bia]);
    const guardar = (id: string, texto: string, enviada: string, lida: string) =>
      ownerQuery(
        `insert into liame.direct_message (connected_account_id, tenant_id, brand_id, conversation_id, message_id, direction, kind, body, sent_at, read_at)
         values ($1, $2, $3, $4, $5, 'saida', 'texto', $6, now() + $7::interval, now() + $8::interval)`,
        [c!.connected_account_id, e.tenantId, c!.brand_id, bia, id, texto, enviada, lida],
      );
    await guardar('mid.acabou-de-sair', 'Resposta que acabou de sair', '0 minutes', '1 hour');
    await guardar('mid.antiga', 'Mensagem de dez dias atrás', '-10 days', '-10 days');
    await guardar('mid.sumiu-na-meta', 'Lida antes e apagada na Meta', '-1 minute', '-1 hour');
    meta.escreveuNoDirect(pagina, { usuario: 'bia_m', texto: 'Obrigada!' });
    expect((await ler(e, emMinutos(4)))[0]).toMatchObject({ status: 'ok', relidas: 1 });
    expect((await textos(bia)).sort()).toEqual(['Das 18h às 23h, todo dia.', 'Mensagem de dez dias atrás', 'Obrigada!', 'Qual o horário de vocês?', 'Resposta que acabou de sair'].sort());
    expect(meta.defeitos).toEqual([]);
  }, 120_000);

  it('parte 4a (D-A6-118): o tipo de cada conversa pela regra e a sugestão sem IA; respondida ou concluída, sem tipo nem sugestão; o contador do menu', async () => {
    const e = await empresa('Casa Brasa Direct Tipos');
    const pagina = e.pagina!.externo;
    const carla = meta.escreveuNoDirect(pagina, { usuario: 'carla.m', texto: 'Que delícia esse smash!', minutos: 9 });
    const bia = meta.escreveuNoDirect(pagina, { usuario: 'bia.costa', story: 'mention', minutos: 8 });
    const rui = meta.escreveuNoDirect(pagina, { usuario: 'rui.s', texto: 'Chegou frio e faltou a batata. Pedido 4821.', minutos: 7 });
    const promo = meta.escreveuNoDirect(pagina, { usuario: 'promo_seguidores', texto: 'Ganhe seguidores reais hoje! Clique no link', minutos: 6 });
    const ana = meta.escreveuNoDirect(pagina, { usuario: 'ana.paula_rj', texto: 'Vocês entregam na Penha?', minutos: 5 });
    const lucas = meta.escreveuNoDirect(pagina, { usuario: 'lucas_fern', texto: 'Amei o combo!', minutos: 40 });
    meta.marcaNoDirect(lucas, 'Obrigado pelo carinho!', 30);
    expect((await mudar(e, { enabled: true, no_other_app: true, code: await codigo(e) })).status).toBe(200);
    expect((await ler(e))[0]).toMatchObject({ status: 'ok', conversas: 6 });

    const tipos = Object.fromEntries(((await lista(e, 'todas')).body as Lista).items.map((i) => [i.username, i.kind]));
    expect(tipos).toEqual({ 'carla.m': 'elogio', 'bia.costa': 'mencao', 'rui.s': 'reclamacao', promo_seguidores: 'golpe', 'ana.paula_rj': 'pergunta', lucas_fern: null });
    const sugestao = async (id: string): Promise<Sugestao> => ((await conversa(e, id)).body as { suggestion: Sugestao }).suggestion;
    const doElogio = (await sugestao(carla))!;
    expect(doElogio.kind).toBe('pronta');
    expect(RESPOSTAS_PRONTAS.elogio).toContain(doElogio.text);
    const daMencao = (await sugestao(bia))!;
    expect(daMencao.kind).toBe('pronta');
    expect(RESPOSTAS_DA_MENCAO).toContain(daMencao.text);
    expect(await sugestao(rui)).toEqual({ kind: 'passos', text: null, steps: [...PASSOS_DA_RECLAMACAO] });
    expect(await sugestao(promo)).toEqual({ kind: 'golpe', text: null, steps: [] });
    // A pergunta espera o Social media (parte 4b); a respondida não tem o que sugerir.
    expect(await sugestao(ana)).toBeNull();
    expect(await sugestao(lucas)).toBeNull();

    // O contador do menu: as que esperam resposta (a do Lucas foi respondida), com a mesma regra da lista.
    const esperando = async () => ((await api.call('GET', '/v1/direct/waiting', { cookie: e.cookie })).body as { waiting: number }).waiting;
    expect(await esperando()).toBe(5);
    expect(await esperando()).toBe(((await lista(e)).body as Lista).counts.espera);

    // Concluir sem responder tira o tipo e a sugestão; a mensagem nova da pessoa traz de novo.
    const concluida = await api.call('POST', `/v1/direct/conversations/${promo}/conclude`, { cookie: e.cookie, body: { brand_id: e.brandId } });
    expect(concluida.body).toMatchObject({ conversation: { status: 'respondida', kind: null }, suggestion: null });
    expect(await esperando()).toBe(4);
    meta.escreveuNoDirect(pagina, { usuario: 'promo_seguidores', texto: 'Última chance: ganhe seguidores reais! www.promo-seguidores.shop' });
    expect((await ler(e, emMinutos(2)))[0]).toMatchObject({ status: 'ok', relidas: 1 });
    expect(await sugestao(promo)).toEqual({ kind: 'golpe', text: null, steps: [] });
    expect(await esperando()).toBe(5);
    // Desligado na marca, não conta.
    expect((await mudar(e, { enabled: false, no_other_app: true })).status).toBe(200);
    expect(await esperando()).toBe(0);
    expect(meta.defeitos).toEqual([]);
  }, 120_000);

  it('o Regem (D-A6-107): sem o escopo, não confere e a leitura espera; atendendo esta conta, o Liame apaga o que tinha e não lê; livre, lê', async () => {
    const e = await empresa('Casa Brasa Direct Regem');
    meta.escreveuNoDirect(e.pagina!.externo, { usuario: 'rui.s', texto: 'Pedido 4821 veio frio' });
    await ownerQuery(`insert into liame.direct_setting (brand_id, tenant_id, enabled, sem_outro_programa) values ($1, $2, true, true)`, [e.brandId, e.tenantId]);
    expect((await ler(e))[0]).toMatchObject({ status: 'ok', relidas: 1 });

    // A loja do Regem chega com a autorização sem o escopo: o Liame não chama o Regem, e a leitura espera.
    const loja = await lojaDoRegem(e, ['pedidos.ler', 'cupons.ler']);
    expect((await ler(e, emMinutos(16)))[0]).toMatchObject({ status: 'nao_conferido' });
    expect(pedidosAoRegem).toEqual([]);
    expect((await ver(e)).body).toMatchObject({ regem: 'nao_conferido' });
    expect(((await lista(e, 'todas')).body as Lista).counts.todas).toBe(1);

    // Com o escopo, e a Central atendendo esta conta (pelo @): o Liame apaga o que tinha e não lê.
    await trocarEscopos(e, loja, ['pedidos.ler', 'cupons.ler', 'atendimento.canais.ler']);
    canais = { instagram: [{ ig_user_id: 'outro-id', usuario: 'casabrasa' }], messenger: [] };
    expect((await ler(e, emMinutos(32)))[0]).toMatchObject({ status: 'regem' });
    expect(pedidosAoRegem).toEqual(['GET /integracao/atendimento/canais']);
    expect((await ver(e)).body).toMatchObject({ regem: 'atende' });
    expect((await lista(e, 'todas')).body).toMatchObject({ counts: { todas: 0 }, items: [] });
    expect(Number((await ownerQuery<{ n: string }>(`select count(*) as n from liame.direct_message where tenant_id = $1`, [e.tenantId]))[0]!.n)).toBe(0);

    // A Central deixa de atender: livre, a leitura volta.
    canais = { instagram: [], messenger: [] };
    expect((await ler(e, emMinutos(48)))[0]).toMatchObject({ status: 'ok', relidas: 1 });
    expect((await ver(e)).body).toMatchObject({ regem: 'livre' });
  }, 120_000);

  it('sem a função, não liga; o aprovador não liga, mas desliga sem código; sem a permissão de mensagens, a leitura diz sem_permissao', async () => {
    const e = await empresa('Casa Brasa Direct Chave', { funcao: false });
    expect(problema(await mudar(e, { enabled: true, no_other_app: true, code: await codigo(e) }))).toEqual([409, 'funcao-desligada']);
    await ligarFlagDaEmpresa(api, 'direct', e.tenantId, true);
    const aprovador = await pessoa(e, 'aprovador');
    expect((await ver(e, aprovador.cookie)).body).toMatchObject({ can_enable: false, can_disable: true });
    expect(problema(await mudar(e, { enabled: true, no_other_app: true }, aprovador.cookie))).toEqual([403, 'so-dono-ou-administrador']);
    expect((await mudar(e, { enabled: true, no_other_app: true, code: await codigo(e) })).status).toBe(200);

    meta.escreveuNoDirect(e.pagina!.externo, { usuario: 'bia.costa', texto: 'Oi!' });
    meta.semPermissaoDeMensagens = true;
    expect((await ler(e))[0]).toMatchObject({ status: 'sem_permissao' });
    expect((await ver(e)).body).toMatchObject({ reading: 'sem_permissao' });

    // O aprovador desliga, na hora e sem código; desligado, a rotina não lê.
    const desligado = await mudar(e, { enabled: false, no_other_app: true }, aprovador.cookie);
    expect(desligado.status, JSON.stringify(desligado.body)).toBe(200);
    expect(desligado.body).toMatchObject({ enabled: false, reading: 'desligada' });
    meta.normalizar();
    expect((await ler(e, emMinutos(120)))[0]).toMatchObject({ status: 'desligada' });
    const trilha = await ownerQuery<{ before: { enabled: boolean } | null; after: { enabled: boolean; confirmed: boolean } | null }>(
      `select before, after from liame.audit_event where tenant_id = $1 and resource_id = $2 and action = 'direct.ajuste' and after is not null order by chain_seq`,
      [e.tenantId, e.brandId],
    );
    expect(trilha.map((t) => [t.before?.enabled, t.after?.enabled, t.after?.confirmed])).toEqual([
      [false, true, true],
      [true, false, false],
    ]);
  }, 120_000);
  it('Z14, parte 1 (D-A6-120 a D-A6-124): o Messenger da Página na mesma caixa: liga separado, lê com o nome, o canal na lista e no filtro, o contador e o Regem pela Página', async () => {
    const e = await empresa('Casa Brasa Messenger');
    const pagina = e.pagina!.externo;
    // Só a tarefa de mensagens na Página: lê o Direct e o Messenger (D-A6-124).
    meta.paginas.set(pagina, ['MESSAGING']);
    meta.escreveuNoDirect(pagina, { usuario: 'ana.paula_rj', texto: 'Vocês entregam na Penha?', minutos: 10 });
    const joana = meta.escreveuNoMessenger(pagina, { nome: 'Joana Lima', texto: 'Vocês abrem no feriado?', minutos: 5 });
    expect((await mudar(e, { enabled: true, no_other_app: true, code: await codigo(e) })).status).toBe(200);

    // Sem a função `messenger`, não liga; o Direct segue sozinho e a Página não é lida.
    expect(problema(await mudarMessenger(e, { enabled: true, no_other_app: true, code: await codigo(e) }))).toEqual([409, 'funcao-desligada']);
    const primeira = await lerOs(e);
    expect(primeira.instagram).toMatchObject({ status: 'ok', conversas: 1 });
    expect(primeira.messenger).toMatchObject({ status: 'desligada' });
    expect((await ver(e)).body).toMatchObject({ enabled: true, messenger: { available: false, enabled: false, page: { id: e.pagina!.id }, reading: 'desligada' } });

    // Com a função: ligar pede a confirmação e o código, como o Direct; a auditoria leva o canal.
    await ligarFlagDaEmpresa(api, 'messenger', e.tenantId, true);
    expect(problema(await mudarMessenger(e, { enabled: true, no_other_app: false, code: await codigo(e) }))).toEqual([422, 'confirme-outro-programa']);
    expect(problema(await mudarMessenger(e, { enabled: true, no_other_app: true }))).toEqual([400, 'confirme-que-e-voce']);
    const ligado = await mudarMessenger(e, { enabled: true, no_other_app: true, code: await codigo(e) });
    expect(ligado.status, JSON.stringify(ligado.body)).toBe(200);
    expect(ligado.body).toMatchObject({ enabled: true, messenger: { available: true, enabled: true, no_other_app: true, page: { id: e.pagina!.id }, reading: 'nunca' } });
    const [trilha] = await ownerQuery<{ after: { enabled: boolean; channel: string } }>(
      `select after from liame.audit_event where tenant_id = $1 and action = 'direct.messenger_ajuste' and after is not null order by chain_seq desc limit 1`,
      [e.tenantId],
    );
    expect(trilha?.after).toMatchObject({ enabled: true, channel: 'messenger', confirmed: true });

    // Ligar traz a vez da Página para agora: a conversa vem com o nome, sem @.
    expect((await lerOs(e)).messenger).toMatchObject({ status: 'ok', conversas: 1, relidas: 1, mensagens: 1 });
    expect((await ver(e)).body).toMatchObject({ messenger: { regem: 'sem_regem', reading: 'ok' } });
    const todas = (await lista(e, 'todas')).body as ListaComCanal;
    expect(todas.counts.todas).toBe(2);
    expect(todas.items.map((i) => [i.channel, i.username, i.name, i.status])).toEqual([
      ['instagram', 'ana.paula_rj', null, 'espera'],
      ['messenger', null, 'Joana Lima', 'espera'],
    ]);
    // O filtro de canal (as contagens seguem o canal) e a busca pelo nome.
    const soMessenger = (await api.call('GET', `/v1/direct/conversations?brand_id=${e.brandId}&status=todas&channel=messenger`, { cookie: e.cookie })).body as ListaComCanal;
    expect([soMessenger.counts.todas, soMessenger.items.map((i) => i.id)]).toEqual([1, [joana]]);
    expect(((await lista(e, 'todas', 'joana')).body as ListaComCanal).items.map((i) => i.id)).toEqual([joana]);
    expect((await conversa(e, joana)).body).toMatchObject({
      conversation: { id: joana, channel: 'messenger', name: 'Joana Lima', username: null },
      messages: [{ direction: 'entrada', text: 'Vocês abrem no feriado?' }],
    });
    // O contador do menu soma os dois canais e diz que há Messenger (o menu vira "Direct e Messenger").
    expect((await api.call('GET', '/v1/direct/waiting', { cookie: e.cookie })).body).toEqual({ waiting: 2, messenger: true });

    // A Central do Regem atende o Messenger desta Página: o Liame apaga só as conversas do Messenger e segue com o Direct.
    await lojaDoRegem(e, ['atendimento.canais.ler']);
    canais = { instagram: [], messenger: [{ pagina_id: pagina }] };
    const comRegem = await lerOs(e, emMinutos(20));
    expect(comRegem.messenger).toMatchObject({ status: 'regem' });
    expect(comRegem.instagram).toMatchObject({ status: 'ok' });
    expect(((await lista(e, 'todas')).body as ListaComCanal).items.map((i) => i.channel)).toEqual(['instagram']);
    expect((await ver(e)).body).toMatchObject({ regem: 'livre', messenger: { regem: 'atende' } });
    expect(meta.defeitos).toEqual([]);
  }, 120_000);
});
