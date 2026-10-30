import { randomUUID } from 'node:crypto';
import type { Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ClienteConector } from '../../src/connectors/cliente-http.js';
import { versaoRegistrada } from '../../src/connectors/tipos.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { LeitorDosNumeros } from '../../src/worker/leitor-dos-numeros.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { InstagramDeMentira, SEGREDO_DO_APP, TOKEN_DO_INSTAGRAM } from '../helpers/instagram-de-mentira.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type EmpresaComCanais, empresaComCanais } from '../helpers/posts-semeados.js';
import { hasDb } from './env.js';

// A6 · Z7, parte c: os números de cada post nas redes (migration 0092; D-A6-50 a D-A6-52), contra um Instagram e uma
// Página locais (o simulador da publicação, com `GET /{id}/insights`). O que se prova aqui:
//   - o canal publicado na fila é lido: no Instagram, as vezes vistas, o alcance, as curtidas, os comentários, os salvos e
//     os compartilhamentos; na Página, com o token dela, as vezes vistas, as pessoas, os cliques e as reações somadas; a
//     próxima leitura em 24 horas; a Agenda mostra os números;
//   - a função dos posts desligada: o canal espera um dia, sem chamar a Meta;
//   - sem permissão (a autorização sem ler os números; a Página sem a tarefa ANALYZE) e sem a conta conectada;
//   - o dado que ainda não veio (lista vazia) não apaga o que já havia; a falha passageira tenta em uma hora;
//   - o post com mais de 30 dias é lido uma última vez; o pacote sai da fila.

const DIA_MS = 86_400_000;
const HORA_MS = 3_600_000;
const metrica = (name: string, value: unknown) => ({ name, period: 'lifetime', values: [{ value }], title: name, description: name, id: `x/insights/${name}/lifetime` });

describe.skipIf(!hasDb)('os números de cada post nas redes (A6 · Z7, parte c)', () => {
  let api: TestApi;
  let leitor: LeitorDosNumeros;
  const ig = new InstagramDeMentira();

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    await ig.ligar();
    const database: Database = api.app.get(DATABASE);
    const vault = api.app.get(VaultService);
    leitor = new LeitorDosNumeros(
      database,
      {
        lerSegredo: (tx, id) => vault.readSecret(tx, id),
        cliente: () => new ClienteConector(database.db, { enderecos: { meta_ads: [ig.base] }, tentativas: 1, balde: { capacidade: 10_000, porSegundo: 1_000 } }),
        graphUrl: ig.base,
        appSecret: SEGREDO_DO_APP,
        versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
      },
      api.app.get(FlagService),
    );
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    ig.normalizar();
  });
  afterAll(async () => {
    await ig.desligar();
    await api?.close();
  });

  /** Um post publicado nos dois canais, na fila da leitura (devida), saído `horas` atrás. */
  async function publicado(e: EmpresaComCanais, horas = 2, kind = 'post'): Promise<{ post: string; midia: string; postDaPagina: string; canais: Record<string, string> }> {
    const post = randomUUID();
    const midia = `1790${Date.now()}`.slice(0, 17);
    const postDaPagina = `${e.pagina?.externo ?? '1'}_${Date.now()}`;
    const saiu = new Date(Date.now() - horas * HORA_MS).toISOString();
    await ownerQuery(`insert into liame.social_post (id, tenant_id, brand_id, kind, photo_sha256, publish_at) values ($1, $2, $3, $4, $5, $6)`, [post, e.tenantId, e.brandId, kind, 'c'.repeat(64), saiu]);
    const canais: Record<string, string> = { instagram: randomUUID(), facebook: randomUUID() };
    if (kind === 'post') {
      await ownerQuery(
        `insert into liame.social_post_channel (id, tenant_id, post_id, channel, connected_account_id, body, status, external_id, published_at, metrics_next_at)
         values ($1, $2, $3, 'instagram', $4, 'Combo de sexta.', 'publicado', $5, $6, now() - interval '1 minute'),
                ($7, $2, $3, 'facebook', $8, 'Combo de sexta.', 'publicado', $9, $6, now() - interval '1 minute')`,
        [canais.instagram, e.tenantId, post, e.instagram!.id, midia, saiu, canais.facebook, e.pagina!.id, postDaPagina],
      );
    } else {
      await ownerQuery(
        `insert into liame.social_post_channel (id, tenant_id, post_id, channel, body, status, metrics_next_at) values ($1, $2, $3, 'tiktok', 'Combo.', 'pronto', now() - interval '1 minute')`,
        [canais.instagram, e.tenantId, post],
      );
    }
    return { post, midia, postDaPagina, canais };
  }
  const canal = (id: string) =>
    ownerQuery<{ metrics: Record<string, number | null> | null; metrics_status: string | null; metrics_read_at: Date | null; metrics_next_at: Date | null }>(
      `select metrics, metrics_status, metrics_read_at, metrics_next_at from liame.social_post_channel where id = $1`,
      [id],
    ).then((r) => r[0]!);
  const ler = (e: EmpresaComCanais, agora = new Date()) => leitor.executarLote(20, { tenantIds: [e.tenantId] }, agora);

  it('o canal publicado é lido: o Instagram e a Página (com o token dela), a próxima leitura em 24 horas, e a Agenda mostra os números', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Números', { token: TOKEN_DO_INSTAGRAM });
    ig.paginas.set(e.pagina!.externo, ['ANALYZE', 'CREATE_CONTENT']);
    const p = await publicado(e);
    ig.numeros.set(p.midia, [metrica('views', 1520), metrica('reach', 980), metrica('likes', 87), metrica('comments', 12), metrica('saved', 9), metrica('shares', 4)]);
    ig.numeros.set(p.postDaPagina, [metrica('post_media_view', 640), metrica('post_total_media_view_unique', 410), metrica('post_clicks', 35), metrica('post_reactions_by_type_total', { like: 20, love: 5, wow: 1 })]);
    const agora = new Date();
    const vezes = await ler(e, agora);
    expect(vezes.map((v) => v.situacao).sort()).toEqual(['lido', 'lido']);
    const doIg = await canal(p.canais.instagram!);
    expect(doIg.metrics).toEqual({ views: 1520, reach: 980, likes: 87, comments: 12, shares: 4, saves: 9, clicks: null, reactions: null });
    expect(doIg.metrics_status).toBe('lido');
    expect(new Date(doIg.metrics_read_at!).getTime()).toBe(agora.getTime());
    expect(new Date(doIg.metrics_next_at!).getTime()).toBe(agora.getTime() + DIA_MS);
    expect((await canal(p.canais.facebook!)).metrics).toEqual({ views: 640, reach: 410, likes: null, comments: null, shares: null, saves: null, clicks: 35, reactions: 26 });
    // As métricas pedidas, o token no cabeçalho (o da Página no post dela) e a prova do segredo do app.
    const pedidas = ig.chamadas.filter((c) => c.caminho.endsWith('/insights'));
    expect(pedidas.map((c) => c.params.metric).sort()).toEqual(['post_media_view,post_total_media_view_unique,post_clicks,post_reactions_by_type_total', 'views,reach,likes,comments,saved,shares']);
    expect(ig.defeitos).toEqual([]);
    // De novo agora: nada devido (a próxima leitura é amanhã).
    expect(await ler(e, agora)).toEqual([]);
    // A Agenda mostra os números de cada canal.
    const dia = (n: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(Date.now() + n * DIA_MS));
    const lista = await api.call('GET', `/v1/posts?brand_id=${e.brandId}&from=${dia(-1)}&to=${dia(0)}`, { cookie: e.cookie });
    expect(lista.status, JSON.stringify(lista.body)).toBe(200);
    const doPost = (lista.body.items as Array<{ id: string; channels: Array<{ channel: string; metrics: unknown; metrics_status: string }> }>).find((x) => x.id === p.post)!;
    expect(doPost.channels.find((c) => c.channel === 'instagram')).toMatchObject({ metrics: { views: 1520, reach: 980 }, metrics_status: 'lido' });
  }, 120_000);

  it('a função dos posts desligada: o canal espera um dia, sem chamar a Meta', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Números Desligada', { token: TOKEN_DO_INSTAGRAM });
    const p = await publicado(e);
    await ligarFlagDaEmpresa(api, 'social_write', e.tenantId, false);
    const agora = new Date();
    expect((await ler(e, agora)).map((v) => v.situacao)).toEqual(['desligado', 'desligado']);
    expect(ig.chamadas).toEqual([]);
    const c = await canal(p.canais.instagram!);
    expect([c.metrics, c.metrics_status, new Date(c.metrics_next_at!).getTime()]).toEqual([null, null, agora.getTime() + DIA_MS]);
  }, 120_000);

  it('sem permissão (a autorização sem ler os números; a Página sem a tarefa ANALYZE) e sem a conta conectada', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Números Permissão', { token: TOKEN_DO_INSTAGRAM });
    ig.paginas.set(e.pagina!.externo, ['CREATE_CONTENT']);
    ig.semPermissaoDeNumeros = true;
    const p = await publicado(e);
    const agora = new Date();
    expect((await ler(e, agora)).map((v) => v.situacao)).toEqual(['sem_permissao', 'sem_permissao']);
    // A Página sem ANALYZE nem chega a pedir os números.
    expect(ig.contar('insights')).toBe(1);
    expect((await canal(p.canais.facebook!)).metrics_status).toBe('sem_permissao');
    // A conta que saiu da marca: sem_conta, sem chamar a Meta.
    const p2 = await publicado(e);
    await ownerQuery(`update liame.connected_account set disconnected_at = now() where id = $1`, [e.instagram!.id]);
    ig.normalizar();
    const vezes = await ler(e, new Date(agora.getTime() + 2 * DIA_MS));
    expect(vezes.find((v) => v.canal === p2.canais.instagram)?.situacao).toBe('sem_conta');
    expect(ig.chamadas.filter((c) => c.caminho.includes(p2.midia))).toEqual([]);
  }, 120_000);

  it('o dado que ainda não veio não apaga o que havia; a falha passageira tenta em uma hora; depois de 30 dias, a última leitura; o pacote sai da fila', async () => {
    const e = await empresaComCanais(api, 'Casa Brasa Números Fila', { pagina: false, token: TOKEN_DO_INSTAGRAM });
    // Só o Instagram nesta empresa (sem a Página): o canal da Página do semeado fica sem conta, e é ignorado aqui.
    const p = await publicado({ ...e, pagina: { id: e.instagram!.id, externo: '99' } } as EmpresaComCanais);
    const agora = new Date();
    // A primeira leitura sem dado (lista vazia): sem_dados.
    let vezes = await ler(e, agora);
    expect(vezes.find((v) => v.canal === p.canais.instagram)?.situacao).toBe('sem_dados');
    // Com o dado: lido.
    ig.numeros.set(p.midia, [metrica('views', 300), metrica('reach', 200)]);
    vezes = await ler(e, new Date(agora.getTime() + DIA_MS));
    expect(vezes.find((v) => v.canal === p.canais.instagram)?.situacao).toBe('lido');
    // De novo sem dado: o que havia fica, como lido.
    ig.numeros.set(p.midia, []);
    await ler(e, new Date(agora.getTime() + 2 * DIA_MS));
    let c = await canal(p.canais.instagram!);
    expect([c.metrics_status, c.metrics?.views]).toEqual(['lido', 300]);
    // A falha passageira (503): tenta em uma hora, sem mudar os números.
    ig.falhas.set('insights', [{ status: 503, corpo: { error: { message: 'Service temporarily unavailable', code: 2 } } }]);
    const quando = new Date(agora.getTime() + 3 * DIA_MS);
    vezes = await ler(e, quando);
    expect(vezes.find((v) => v.canal === p.canais.instagram)?.situacao).toBe('adiado');
    c = await canal(p.canais.instagram!);
    expect([c.metrics?.views, new Date(c.metrics_next_at!).getTime()]).toEqual([300, quando.getTime() + HORA_MS]);
    // Depois de 30 dias de saído: a última leitura, e a fila acaba.
    ig.numeros.set(p.midia, [metrica('views', 410)]);
    await ler(e, new Date(agora.getTime() + 31 * DIA_MS));
    c = await canal(p.canais.instagram!);
    expect([c.metrics?.views, c.metrics_next_at]).toEqual([410, null]);
    // O pacote (o Liame não publica) sai da fila sem chamar a Meta.
    const pacote = await publicado(e, 2, 'pacote');
    ig.normalizar();
    vezes = await ler(e, new Date(agora.getTime() + 32 * DIA_MS));
    expect(vezes.find((v) => v.canal === pacote.canais.instagram)?.situacao).toBe('fora');
    expect((await canal(pacote.canais.instagram!)).metrics_next_at).toBeNull();
  }, 120_000);
});
