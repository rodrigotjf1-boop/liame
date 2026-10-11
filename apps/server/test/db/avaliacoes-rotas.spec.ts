import { ReviewAuthorsResponse, ReviewsResponse } from '@liame/contracts';
import { createDatabase, type Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { ESCOPOS_GOOGLE } from '../../src/connections/oauth.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ConexaoProcessor } from '../../src/worker/conexao-processor.js';
import { PerfilLoop } from '../../src/worker/perfil-loop.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import {
  ACESSO_RENOVADO,
  type AvaliacaoNoGoogle,
  type EmpresaAutorizada,
  empresaComPerfilAutorizado,
  GoogleComPerfil,
  ligarLojaDoPerfil,
  nomeDeQuemAvaliou,
} from '../helpers/perfil-google-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A6 · Z1 (parte e): as duas rotas da tela Avaliações, de ponta a ponta contra um Google local. O que se prova aqui:
//   - o estado que a tela recebe em cada situação (a função desligada, sem perfil, sem a permissão, esperando o
//     Google, pronta), como no protótipo P17;
//   - a lista (as sem resposta primeiro, das notas mais baixas para as mais altas) e o resumo;
//   - o nome de quem avaliou chega à tela lido do Google na hora, e NÃO é guardado em lugar nenhum (critério A6-1);
//     quando o Google não responde, a tela fica sem os nomes, e não sem as avaliações.

const MIN_MS = 60_000;
const DIA_MS = 86_400_000;

type Corpo = ReturnType<typeof ReviewsResponse.parse>;

describe.skipIf(!hasDb)('as rotas da tela Avaliações (A6 · Z1)', () => {
  let api: TestApi;
  let database: Database;
  let processador: ConexaoProcessor;
  let loop: PerfilLoop;
  const google = new GoogleComPerfil();
  const AGORA = new Date();
  const ha = (dias: number) => new Date(AGORA.getTime() - dias * DIA_MS).toISOString();

  beforeAll(async () => {
    await google.subir();
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 6, applicationName: 'liame-test' });
    const vault = api.app.get(VaultService);
    const flags = api.app.get(FlagService);
    processador = new ConexaoProcessor(database, loadConfig(), vault, flags);
    loop = new PerfilLoop(database, loadConfig(), vault, flags);
  }, 120_000);
  beforeEach(async () => {
    google.limpar();
    await resetIpRateLimits();
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await google.fechar();
  });

  const empresa = (nome: string) => empresaComPerfilAutorizado(api, google, processador, nome);
  /** A resposta da rota, conferida contra o contrato (um campo a mais ou a menos reprova). */
  const ver = async (e: { cookie: string; brandId: string }): Promise<Corpo> => {
    const r = await api.call('GET', `/v1/reviews?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return ReviewsResponse.parse(r.body);
  };
  const nomes = async (e: { cookie: string; brandId: string }) => {
    const r = await api.call('GET', `/v1/reviews/authors?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return ReviewAuthorsResponse.parse(r.body);
  };
  const ler = (e: EmpresaAutorizada, quando: Date) => loop.executarLote(10, { tenantIds: [e.tenantId] }, quando);
  const avaliacao = (id: string, estrelas: AvaliacaoNoGoogle['starRating'], feitaHaDias: number, extra: Partial<AvaliacaoNoGoogle> = {}): AvaliacaoNoGoogle => ({
    reviewId: id,
    starRating: estrelas,
    comment: `Texto da avaliação ${id}`,
    createTime: ha(feitaHaDias),
    updateTime: ha(Math.min(feitaHaDias, 1)),
    ...extra,
  });
  const vazia = { stores: [], summary: null, reviews: [], has_more: false };

  it('sem loja ligada, a rota diz o que falta: a função, o perfil, a permissão ou o Google liberar', async () => {
    // A função desligada para a empresa: nada é lido, e os nomes nem são pedidos ao Google.
    const s = await signupAndLogin(api, undefined, 'Casa Brasa Sem a Função');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    const semFuncao = { cookie: s.cookie, brandId: marca!.id };
    expect(await ver(semFuncao)).toMatchObject({ brand_id: marca!.id, state: 'desligada', ...vazia });
    google.vistos.length = 0;
    expect(await nomes(semFuncao)).toEqual({ status: 'desligada', items: [] });
    expect(google.vistos).toEqual([]);

    // A função ligada, e nenhuma autorização do Google: falta conectar.
    await ligarFlagDaEmpresa(api, 'perfil_google', tenantId, true);
    expect(await ver(semFuncao)).toMatchObject({ state: 'sem_perfil', ...vazia });
    expect(await nomes(semFuncao)).toEqual({ status: 'ok', items: [] });

    // O Google conectado, mas a pessoa não concedeu a permissão do perfil.
    google.concedidos = [...ESCOPOS_GOOGLE];
    const semPermissao = await empresa('Casa Brasa Sem a Permissão');
    expect(await ver(semPermissao)).toMatchObject({ state: 'sem_permissao', ...vazia });

    // Autorizou com a permissão, e o Google ainda não liberou o acesso do Liame ao perfil.
    google.limpar();
    google.lojas = 'sem-cota';
    const esperando = await empresa('Casa Brasa Esperando o Google');
    expect(await ver(esperando)).toMatchObject({ state: 'esperando_google', ...vazia });

    // O Google respondeu e há loja para escolher: o caminho é Contas conectadas.
    google.limpar();
    const porLigar = await empresa('Casa Brasa Por Ligar');
    expect(await ver(porLigar)).toMatchObject({ state: 'sem_perfil', ...vazia });

    // Marca de outra empresa, ou que não existe: 404, sem dizer qual dos dois.
    expect((await api.call('GET', `/v1/reviews?brand_id=${porLigar.brandId}`, { cookie: esperando.cookie })).status).toBe(404);
    expect((await api.call('GET', `/v1/reviews/authors?brand_id=${porLigar.brandId}`, { cookie: esperando.cookie })).status).toBe(404);
    // Sem a marca no pedido, pedido inválido; sem sessão, 401.
    expect((await api.call('GET', '/v1/reviews', { cookie: esperando.cookie })).status).toBe(400);
    expect((await api.call('GET', `/v1/reviews?brand_id=${esperando.brandId}`, {})).status).toBe(401);
    expect((await api.call('GET', `/v1/reviews/authors?brand_id=${esperando.brandId}`, {})).status).toBe(401);
  });

  it('com a loja ligada: antes da primeira leitura a tela já sabe da loja; depois, a lista vem com as sem resposta primeiro e o resumo', async () => {
    const e = await empresa('Mister Burgers Avaliações');
    const contaId = await ligarLojaDoPerfil(api, e);

    const antes = await ver(e);
    expect(antes.state).toBe('pronta');
    expect(antes.stores).toEqual([{ id: contaId, name: 'Mister Burgers — Centro', status: 'ativa', status_reason: null, rating: null, review_count: null, read_at: null, waiting_until: null }]);
    expect(antes.summary).toEqual({ rating: null, review_count: null, unanswered: 0, oldest_unanswered_at: null, last_30_days: { count: 0, average: null } });
    expect(antes.reviews).toEqual([]);

    google.lista = [
      avaliacao('respondida-5', 'FIVE', 6, { reviewReply: { comment: 'Obrigado!', updateTime: ha(5), reviewReplyState: 'APPROVED' } }),
      avaliacao('conferindo-3', 'THREE', 9, { reviewReply: { comment: 'Vamos rever a batata.', reviewReplyState: 'PENDING' } }),
      avaliacao('recusada-4', 'FOUR', 12, { reviewReply: { comment: 'Texto que o Google barrou.', reviewReplyState: 'REJECTED', policyViolation: 'OFF_TOPIC' } }),
      avaliacao('sem-resposta-4', 'FOUR', 2, { comment: undefined }),
      avaliacao('sem-resposta-1', 'ONE', 4),
      avaliacao('sem-resposta-1-antiga', 'ONE', 45),
      avaliacao('sem-resposta-2', 'TWO', 3),
    ];
    expect((await ler(e, AGORA)).map((r) => r.status)).toEqual(['ok', 'ok']);

    const depois = await ver(e);
    expect(depois.state).toBe('pronta');
    expect(depois.stores[0]).toMatchObject({ id: contaId, rating: 4.6, review_count: 128, read_at: AGORA.toISOString(), waiting_until: null });
    // As sem resposta primeiro (das notas mais baixas para as mais altas; na mesma nota, a mais recente antes); depois a
    // que o Google recusou, a que ele confere e a respondida.
    const guardadas = await ownerQuery<{ id: string; external_id: string }>(`select id, external_id from liame.profile_review where connected_account_id = $1`, [contaId]);
    const noGoogle = new Map(guardadas.map((g) => [g.id, g.external_id]));
    expect(depois.reviews.map((r) => noGoogle.get(r.id))).toEqual(['sem-resposta-1', 'sem-resposta-1-antiga', 'sem-resposta-2', 'sem-resposta-4', 'recusada-4', 'conferindo-3', 'respondida-5']);
    expect(depois.reviews[0]).toEqual({ id: depois.reviews[0]!.id, store_id: contaId, stars: 1, text: 'Texto da avaliação sem-resposta-1', reviewed_at: ha(4), changed_at: ha(1), reply: null });
    expect(depois.reviews[3]).toMatchObject({ stars: 4, text: null, reply: null });
    expect(depois.reviews[4]!.reply).toEqual({ text: 'Texto que o Google barrou.', state: 'recusada', changed_at: null, violation: 'OFF_TOPIC' });
    expect(depois.reviews[5]!.reply).toMatchObject({ state: 'pendente', violation: null });
    expect(depois.reviews[6]!.reply).toEqual({ text: 'Obrigado!', state: 'aprovada', changed_at: ha(5), violation: null });
    // O resumo: a nota e o total são os do Google; as sem resposta e as dos últimos 30 dias saem do que o Liame guardou.
    expect(depois.summary).toEqual({
      rating: 4.6,
      review_count: 128,
      unanswered: 4,
      oldest_unanswered_at: ha(45),
      // Feitas nos últimos 30 dias: seis (a de 45 dias fica fora); a média delas: (5 + 3 + 4 + 4 + 1 + 2) / 6 = 3,2.
      last_30_days: { count: 6, average: 3.2 },
    });
    expect(depois.has_more).toBe(false);
    // Nada de quem avaliou nesta rota.
    expect(JSON.stringify(depois)).not.toContain('Pessoa Número');
  });

  it('a leitura que espera o Google aparece na loja; a loja sem permissão segue na tela com a situação dela', async () => {
    const e = await empresa('Mister Burgers Espera');
    await ligarLojaDoPerfil(api, e);
    google.lista = [avaliacao('uma', 'FIVE', 2)];
    google.avaliacoes = 'sem-cota';
    await ler(e, AGORA);
    const esperando = await ver(e);
    expect(esperando.state).toBe('pronta');
    // Sem leitura boa ainda, e esperando meia hora (o relógio da rota é o de agora: a espera ainda não venceu).
    expect(esperando.stores[0]).toMatchObject({ status: 'ativa', read_at: null, waiting_until: new Date(AGORA.getTime() + 30 * MIN_MS).toISOString() });
    expect(esperando.reviews).toEqual([]);

    google.avaliacoes = 'recusa';
    await ler(e, new Date(AGORA.getTime() + 31 * MIN_MS));
    const recusada = await ver(e);
    expect(recusada.stores[0]).toMatchObject({ status: 'sem_permissao', waiting_until: null });
    expect(recusada.stores[0]!.status_reason).toContain('O Google recusou a leitura do perfil desta loja');
  });

  it('A6-1: o nome de quem avaliou chega à tela lido do Google na hora, e não é guardado em lugar nenhum', async () => {
    const e = await empresa('Mister Burgers Nomes');
    const contaId = await ligarLojaDoPerfil(api, e);
    google.lista = [avaliacao('rev-1', 'ONE', 2), avaliacao('rev-2', 'FIVE', 3), avaliacao('rev-anonima', 'FOUR', 4, { anonima: true })];
    expect((await ler(e, AGORA)).map((r) => r.status)).toEqual(['ok', 'ok']);
    const guardadas = await ownerQuery<{ id: string; external_id: string }>(`select id, external_id from liame.profile_review where connected_account_id = $1`, [contaId]);
    const idDe = (externo: string) => guardadas.find((g) => g.external_id === externo)!.id;

    google.vistos.length = 0;
    const lidos = await nomes(e);
    expect(lidos.status).toBe('ok');
    // A avaliação anônima fica sem nome.
    expect([...lidos.items].sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { review_id: idDe('rev-1'), name: nomeDeQuemAvaliou('rev-1') },
      { review_id: idDe('rev-2'), name: nomeDeQuemAvaliou('rev-2') },
    ]);
    expect(JSON.stringify(lidos)).not.toContain('anônima');
    expect(JSON.stringify(lidos)).not.toContain('googleusercontent');
    // Uma chamada ao Google, com o acesso renovado da autorização.
    const chamadas = google.de('avaliacoes');
    expect(chamadas).toHaveLength(1);
    expect([chamadas[0]!.autorizacao, chamadas[0]!.busca.get('orderBy')]).toEqual([`Bearer ${ACESSO_RENOVADO}`, 'updateTime desc']);

    // Depois de a tela ler os nomes, nada deles ficou no Liame: nem nas avaliações, nem no estado e nas execuções da
    // leitura, nem na conta, nem na auditoria da empresa.
    const [tudo] = await ownerQuery<{ texto: string }>(
      `select coalesce((select string_agg(to_jsonb(r)::text, ' ') from liame.profile_review r where r.connected_account_id = $1), '')
           || coalesce((select string_agg(to_jsonb(s)::text, ' ') from liame.sync_state s where s.connected_account_id = $1), '')
           || coalesce((select string_agg(to_jsonb(x)::text, ' ') from liame.sync_run x where x.connected_account_id = $1), '')
           || coalesce((select to_jsonb(a)::text from liame.connected_account a where a.id = $1), '')
           || coalesce((select string_agg(to_jsonb(u)::text, ' ') from liame.audit_event u where u.tenant_id = $2), '') as texto`,
      [contaId, e.tenantId],
    );
    expect(tudo!.texto).toContain('rev-1');
    expect(tudo!.texto).not.toContain('Pessoa Número');

    // O Google não responde (a cota acabou): a tela fica sem os nomes, e as avaliações seguem lá.
    google.avaliacoes = 'sem-cota';
    expect(await nomes(e)).toEqual({ status: 'indisponivel', items: [] });
    expect((await ver(e)).reviews).toHaveLength(3);
    // A autorização recusada no Google: o mesmo, sem derrubar a rota.
    google.avaliacoes = 'ok';
    google.renovacaoRecusada = true;
    expect(await nomes(e)).toEqual({ status: 'indisponivel', items: [] });
  });
});
