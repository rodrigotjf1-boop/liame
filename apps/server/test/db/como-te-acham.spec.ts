import { GoogleVisibilityResponse } from '@liame/contracts';
import { createDatabase, type Database, withTenant } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { gravarNumeros } from '../../src/avaliacoes/perfil-store.js';
import { gravarDias, gravarSemana } from '../../src/buscas/buscas-store.js';
import { loadConfig } from '../../src/config.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ConexaoProcessor } from '../../src/worker/conexao-processor.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComLoja, empresaComLojaDoPerfil, empresaComPerfilAutorizado, empresaComSiteDoSearchConsole, GoogleComPerfil } from '../helpers/perfil-google-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A6 · Z3, parte d: a rota do cartão "Como te acham no Google" (P18), `GET /v1/results/google-visibility`. As contas
// nascem pelo caminho do produto (V46: a pessoa autoriza o Google e escolhe a loja ou o site); os números entram pelas
// mesmas funções de gravação do worker. O que se prova aqui: as funções desligadas (sem cartão), cada parte com a
// função dela, o período que acaba no último dia que o Google informou (e não hoje), os dias de antes do mesmo tamanho,
// a posição pesada pelas vezes, o dia sem número com zero, as buscas da última semana (até 10, em ordem estável), o
// Google que ainda não liberou o perfil, a conta desligada fora e a marca de outra empresa.

type Empresa = { cookie: string; tenantId: string; brandId: string };

describe.skipIf(!hasDb)('Como te acham no Google: a rota (A6 · Z3, parte d)', () => {
  let api: TestApi;
  let database: Database;
  let processador: ConexaoProcessor;
  const google = new GoogleComPerfil();

  beforeAll(async () => {
    await google.subir();
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    processador = new ConexaoProcessor(database, loadConfig(), api.app.get(VaultService), api.app.get(FlagService));
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

  async function ver(e: Empresa, days = '7'): Promise<GoogleVisibilityResponse> {
    const r = await api.call('GET', `/v1/results/google-visibility?brand_id=${e.brandId}&days=${days}`, { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return GoogleVisibilityResponse.parse(r.body);
  }
  const conta = (e: EmpresaComLoja) => ({ tenantId: e.tenantId, brandId: e.brandId, connectedAccountId: e.contaId });
  /** Uma empresa nova, sem o Google; a marca é a que o cadastro cria. */
  async function empresaSemGoogle(nome: string): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const [marca] = await ownerQuery<{ id: string }>(`select id from liame.brand where tenant_id = $1 limit 1`, [tenantId]);
    return { cookie: s.cookie, tenantId, brandId: marca!.id };
  }

  it('sem as duas funções, o cartão não existe; o período fora da lista e a marca de outra empresa são recusados', async () => {
    const e = await empresaSemGoogle('Casa Brasa Sem o Google');

    const r = await ver(e);
    expect(r.enabled).toBe(false);
    expect(r.profile).toMatchObject({ enabled: false, waiting_google: false, accounts: [], period: null, previous_views: null });
    expect(r.site).toMatchObject({ enabled: false, accounts: [], period: null, daily: [], queries: null });

    expect((await api.call('GET', `/v1/results/google-visibility?brand_id=${e.brandId}&days=14`, { cookie: e.cookie })).status).toBe(400);
    const outra = await empresaSemGoogle('Casa Brasa Outra');
    expect((await api.call('GET', `/v1/results/google-visibility?brand_id=${e.brandId}&days=7`, { cookie: outra.cookie })).status).toBe(404);
  }, 60_000);

  it('o site: o período acaba no último dia que o Google informou, com os dias de antes, a posição pesada pelas vezes e o dia sem número com zero', async () => {
    const e = await empresaComSiteDoSearchConsole(api, google, processador, 'Casa Brasa do Site');
    // Ligado agora: a primeira leitura ainda não terminou.
    const antes = await ver(e);
    expect(antes.enabled).toBe(true);
    expect(antes.profile.enabled).toBe(false);
    expect(antes.site).toMatchObject({ enabled: true, period: null, clicks: '0', impressions: '0', position: null, previous_clicks: null, daily: [], queries: null });
    expect(antes.site.accounts).toEqual([expect.objectContaining({ connected_account_id: e.contaId, status: 'ativa', last_success_at: null })]);

    // O último dia lido é 11/10 (o Google atrasa); 08/10 não veio (sem número). 27/09 fica antes dos dois períodos.
    const dia = (d: string, cliques: number, vezes: number, posicao: number | null) => ({ dia: d, cliques, vezes, posicao });
    await withTenant(database.db, e.tenantId, (tx) =>
      gravarDias(
        tx,
        conta(e),
        [
          dia('2026-09-27', 100, 1000, 2),
          dia('2026-09-28', 4, 40, 8),
          dia('2026-10-04', 6, 60, 9),
          dia('2026-10-05', 10, 100, 5),
          dia('2026-10-06', 20, 100, 7),
          dia('2026-10-07', 5, 50, 3),
          dia('2026-10-09', 0, 50, 10),
          dia('2026-10-10', 15, 200, 6),
          dia('2026-10-11', 3, 100, 4),
        ],
        new Date(),
      ),
    );
    const r = await ver(e);
    expect(r.days).toBe(7);
    expect(r.site.period).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(r.site.clicks).toBe('53');
    expect(r.site.impressions).toBe('600');
    // (5·100 + 7·100 + 3·50 + 10·50 + 6·200 + 4·100) / 600 = 5,75: a média de cada dia pesa pelas vezes do dia.
    expect(r.site.position).toBe('5.75');
    expect(r.site.previous_clicks).toBe('10');
    expect(r.site.daily).toEqual([
      { day: '2026-10-05', clicks: '10' },
      { day: '2026-10-06', clicks: '20' },
      { day: '2026-10-07', clicks: '5' },
      { day: '2026-10-08', clicks: '0' },
      { day: '2026-10-09', clicks: '0' },
      { day: '2026-10-10', clicks: '15' },
      { day: '2026-10-11', clicks: '3' },
    ]);
    expect(r.site.queries).toBeNull();

    // 30 dias: de 12/09 a 11/10, com 27/09 dentro; antes disso, nada lido.
    const trinta = await ver(e, '30');
    expect(trinta.site.period).toEqual({ from: '2026-09-12', to: '2026-10-11' });
    expect(trinta.site.clicks).toBe('163');
    expect(trinta.site.previous_clicks).toBeNull();
    expect(trinta.site.daily).toHaveLength(30);
  }, 120_000);

  it('as buscas: as da última semana lida, até 10, mais cliques primeiro e o empate em ordem estável', async () => {
    const e = await empresaComSiteDoSearchConsole(api, google, processador, 'Casa Brasa das Buscas');
    const busca = (texto: string, cliques: number, vezes: number, posicao: number | null = 3) => ({ busca: texto, cliques, vezes, posicao });
    await withTenant(database.db, e.tenantId, async (tx) => {
      // A semana anterior tem uma busca que trouxe mais cliques que todas: não entra.
      await gravarSemana(tx, conta(e), '2026-09-28', [busca('semana passada', 900, 1000)], new Date());
      await gravarSemana(
        tx,
        conta(e),
        '2026-10-05',
        [
          busca('mister burgers', 38, 120, 1.2),
          busca('hamburgueria perto de mim', 21, 640, 6.8),
          // O mesmo número de cliques e de vezes: a ordem é a dos caracteres (o espaço, o hífen, o sublinhado; V126).
          busca('smash_burger', 5, 50),
          busca('smash-burger', 5, 50),
          busca('smash burger', 5, 50),
          // Os mesmos cliques: mais vezes primeiro.
          busca('combo smash', 4, 60),
          busca('lanchonete aberta agora', 4, 280, 11.25),
          busca('onion rings', 2, 75, null),
          busca('burger lapa', 2, 20),
          busca('mister burgers cardapio', 1, 22, 1),
          busca('fora das 10 a', 1, 10),
          busca('fora das 10 b', 0, 30),
        ],
        new Date(),
      );
    });
    const r = await ver(e);
    expect(r.site.queries?.week).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(r.site.queries?.items.map((b) => b.query)).toEqual([
      'mister burgers',
      'hamburgueria perto de mim',
      'smash burger',
      'smash-burger',
      'smash_burger',
      'lanchonete aberta agora',
      'combo smash',
      'onion rings',
      'burger lapa',
      'mister burgers cardapio',
    ]);
    expect(r.site.queries?.items[0]).toEqual({ query: 'mister burgers', clicks: '38', impressions: '120', position: '1.2' });
    expect(r.site.queries?.items.find((b) => b.query === 'lanchonete aberta agora')?.position).toBe('11.25');
    expect(r.site.queries?.items.find((b) => b.query === 'onion rings')?.position).toBeNull();
    expect(r.site.queries?.items.find((b) => b.query === 'mister burgers cardapio')?.position).toBe('1');
    // Sem números por dia ainda, a semana já aparece.
    expect(r.site.period).toBeNull();

    // A conta desligada sai do cartão, com os números dela.
    expect((await api.call('DELETE', `/v1/connected-accounts/${e.contaId}`, { cookie: e.cookie })).status).toBe(204);
    const sem = await ver(e);
    expect(sem.site).toMatchObject({ enabled: true, accounts: [], period: null, queries: null });
  }, 120_000);

  it('o perfil: as vezes na busca e no Maps, o que as pessoas fizeram e as vezes de antes, até o último dia lido', async () => {
    const e = await empresaComLojaDoPerfil(api, google, processador, 'Casa Brasa do Perfil');
    const antes = await ver(e);
    expect(antes.site.enabled).toBe(false);
    expect(antes.profile).toMatchObject({ enabled: true, waiting_google: false, period: null, views_search: '0', previous_views: null });
    expect(antes.profile.accounts).toEqual([expect.objectContaining({ connected_account_id: e.contaId, last_success_at: null })]);

    const ponto = (dia: string, metrica: string, valor: number) => ({ dia, metrica, valor });
    await withTenant(database.db, e.tenantId, (tx) =>
      gravarNumeros(
        tx,
        conta(e),
        [
          ponto('2026-09-27', 'profile_views_search_mobile', 1000),
          ponto('2026-10-01', 'profile_views_search_mobile', 50),
          ponto('2026-10-10', 'profile_views_search_desktop', 10),
          ponto('2026-10-10', 'profile_views_search_mobile', 30),
          ponto('2026-10-10', 'profile_views_maps_desktop', 5),
          ponto('2026-10-11', 'profile_views_maps_mobile', 15),
          ponto('2026-10-11', 'direction_requests', 7),
          ponto('2026-10-11', 'call_clicks', 3),
          ponto('2026-10-09', 'website_clicks', 11),
          ponto('2026-10-09', 'menu_clicks', 4),
          ponto('2026-10-09', 'bookings', 9),
        ],
        new Date(),
      ),
    );
    const r = await ver(e);
    expect(r.profile).toMatchObject({
      enabled: true,
      waiting_google: false,
      period: { from: '2026-10-05', to: '2026-10-11' },
      views_search: '40',
      views_maps: '20',
      previous_views: '50',
      direction_requests: '7',
      call_clicks: '3',
      website_clicks: '11',
      menu_clicks: '4',
    });
    const trinta = await ver(e, '30');
    expect(trinta.profile).toMatchObject({ period: { from: '2026-09-12', to: '2026-10-11' }, views_search: '1090', views_maps: '20', previous_views: null });
  }, 120_000);

  it('o perfil sem loja: esperando o Google liberar o acesso, ou nada ligado ainda', async () => {
    // A função ligada e nenhuma autorização do Google.
    const semLoja = await empresaSemGoogle('Casa Brasa Sem Loja');
    await ligarFlagDaEmpresa(api, 'perfil_google', semLoja.tenantId, true);
    const nada = await ver(semLoja);
    expect(nada.enabled).toBe(true);
    expect(nada.profile).toMatchObject({ enabled: true, waiting_google: false, accounts: [], period: null });

    // Autorizou com a permissão do perfil, e o Google ainda não liberou o acesso do Liame.
    google.lojas = 'sem-cota';
    const esperando = await empresaComPerfilAutorizado(api, google, processador, 'Casa Brasa Esperando');
    const r = await ver(esperando);
    expect(r.profile).toMatchObject({ enabled: true, waiting_google: true, accounts: [], period: null });
  }, 120_000);
});
