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
//   - sem a permissão de mensagens, a leitura diz `sem_permissao`.

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
  const ler = (e: EmpresaComCanais, agora = new Date()) => fila.executarLote(10, { tenantIds: [e.tenantId] }, agora);
  const problema = (r: { status: number; body: unknown }) => [r.status, (r.body as { code?: string }).code];
  const emMinutos = (n: number) => new Date(Date.now() + n * 60_000);
  type Lista = { counts: Record<string, number>; items: { id: string; username: string; status: string; unread: boolean; kind: string | null }[] };
  type Sugestao = { kind: string; text: string | null; steps: string[] } | null;

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
});
