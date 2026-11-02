import { AgencyBrandResponse } from '@liame/contracts';
import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, withContext } from '@liame/database';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chaveDoLogo } from '../../src/agencia/logo-da-agencia.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemNaMemoria } from '../../src/imagens/armazem.js';
import { Mailer } from '../../src/mail/mailer.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { LifecyclePurgeService } from '../../src/worker/lifecycle-purge.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi, TERMOS, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A marca da agência (A7, W7, parte 3; D-A7-69; D-A7-81), pelo caminho inteiro: quem é da agência lê; a dona e o
// administrador mudam o nome, o e-mail de resposta (que só vale depois do link, aberto sem login) e como o relatório
// sai; o logo chega cru, é conferido e regravado em JPEG sobre fundo branco no armazenamento (aqui, o da memória), e o
// anterior sai; a RLS separa as agências; e o expurgo da agência leva o logo junto.

type Pessoa = { cookie: string; email: string; userId: string };
type Agencia = { dona: Pessoa; membro: Pessoa; id: string; nome: string };

function png(largura: number, altura: number, alfa = false): Promise<Buffer> {
  return sharp({ create: { width: largura, height: altura, channels: alfa ? 4 : 3, background: alfa ? { r: 255, g: 122, b: 26, alpha: 0 } : { r: 255, g: 122, b: 26 } } })
    .png()
    .toBuffer();
}

describe.skipIf(!hasDb)('a marca da agência', () => {
  let api: TestApi;
  let database: Database;
  let armazem: ArmazemNaMemoria;
  let purge: LifecyclePurgeService;

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    armazem = api.app.get(ARMAZEM_DE_IMAGENS) as ArmazemNaMemoria;
    purge = new LifecyclePurgeService(database, api.app.get(VaultService), api.app.get(Mailer), armazem);
  }, 120_000);
  beforeEach(async () => {
    await resetIpRateLimits();
    armazem.falhar = {};
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  async function agencia(nome: string): Promise<Agencia> {
    const d = await signupAndLogin(api, undefined, `Empresa da dona ${nome}`);
    const aberta = await api.call('POST', '/v1/agencies', { cookie: d.cookie, body: { name: `Agência ${nome}` } });
    expect(aberta.status, JSON.stringify(aberta.body)).toBe(201);
    await enableMfa(api, d.cookie);
    const dona = { cookie: d.cookie, email: d.email, userId: d.me.user.id as string };
    const email = uniqueEmail('membro');
    expect((await api.call('POST', '/v1/agency/invitations', { cookie: dona.cookie, body: { email, role: 'agencia_membro' } })).status).toBe(201);
    const r = await api.call('POST', '/v1/invitations/signup', {
      body: { token: tokenFrom(api.mailer, email), name: 'Pessoa membro', password: PASSWORD, terms_version: TERMOS },
    });
    await enableMfa(api, r.cookie!);
    return { dona, membro: { cookie: r.cookie!, email, userId: r.body.user.id as string }, id: aberta.body.active_organization_id as string, nome: `Agência ${nome}` };
  }

  const ler = (p: Pessoa) => api.call('GET', '/v1/agency/brand', { cookie: p.cookie });
  const mudar = (p: Pessoa, body: Record<string, unknown>) => api.call('PATCH', '/v1/agency/brand', { cookie: p.cookie, body });
  const logo = (p: Pessoa, data: Uint8Array, type = 'image/png') => api.call('PUT', '/v1/agency/brand/logo', { cookie: p.cookie, raw: { data, type } });
  const confirmar = (token: string) => api.call('POST', '/v1/agency-reply-to/confirm', { body: { token } });
  const acoes = async (id: string) =>
    (await ownerQuery<{ action: string }>(`select action from liame.audit_event where tenant_id = $1 and action like 'agencia.marca%' order by chain_seq`, [id])).map(
      (a) => a.action,
    );

  it('quem é da agência lê; a dona muda o nome e como o relatório sai; o membro não muda', async () => {
    const a = await agencia('Brasa da Marca');
    const inicio = await ler(a.membro);
    expect(inicio.status, JSON.stringify(inicio.body)).toBe(200);
    expect(AgencyBrandResponse.parse(inicio.body)).toEqual({
      name: a.nome,
      logo: null,
      reply_to: null,
      pending_reply_to: null,
      report_mode: 'revisar',
      logo_available: true,
    });

    expect((await mudar(a.membro, { report_mode: 'sozinho' })).status).toBe(403);
    expect((await mudar(a.dona, {})).status).toBe(400);
    expect((await mudar(a.dona, { name: ' ' })).status).toBe(400);
    const mudou = await mudar(a.dona, { name: 'Agência Brasa Nova', report_mode: 'sozinho' });
    expect(mudou.status, JSON.stringify(mudou.body)).toBe(200);
    expect(mudou.body).toMatchObject({ name: 'Agência Brasa Nova', report_mode: 'sozinho' });
    // O nome é o da organização da agência: o time e o seletor mostram o novo.
    expect((await api.call('GET', '/v1/agency/team', { cookie: a.membro.cookie })).body.agency.name).toBe('Agência Brasa Nova');
    expect(await acoes(a.id)).toEqual(['agencia.marca_mudar']);
  });

  it('o e-mail de resposta só vale depois do link, aberto sem login; uso único, vencido não vale; null tira', async () => {
    const a = await agencia('Brasa da Resposta');
    const resposta = uniqueEmail('contato');
    const pediu = await mudar(a.dona, { reply_to_email: resposta.toUpperCase() });
    expect(pediu.status, JSON.stringify(pediu.body)).toBe(200);
    expect(pediu.body.reply_to).toBeNull();
    expect(pediu.body.pending_reply_to).toMatchObject({ email: resposta });
    const carta = api.mailer.lastTo(resposta)!;
    expect(carta.subject).toBe(`Liame: confirme o e-mail de resposta da ${a.nome}`);
    expect(carta.text).toContain('/confirmar-resposta?token=');
    const token = tokenFrom(api.mailer, resposta);

    // A auditoria guarda que o e-mail mudou, não o endereço.
    const [evento] = await ownerQuery<{ after: Record<string, unknown> }>(
      `select after from liame.audit_event where tenant_id = $1 and action = 'agencia.marca_mudar' order by occurred_at desc limit 1`,
      [a.id],
    );
    expect(evento!.after).toEqual({ reply_to: 'pendente' });
    expect(JSON.stringify(evento)).not.toContain(resposta);

    const ok = await confirmar(token);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toEqual({ agency_name: a.nome, email: resposta });
    expect((await ler(a.membro)).body).toMatchObject({ reply_to: { email: resposta }, pending_reply_to: null });
    expect((await confirmar(token)).body.code).toBe('link-invalido');

    // Um e-mail novo fica pendente sem tirar o que vale; o link vencido não vale.
    const outro = uniqueEmail('outro');
    await mudar(a.dona, { reply_to_email: outro });
    expect((await ler(a.dona)).body).toMatchObject({ reply_to: { email: resposta }, pending_reply_to: { email: outro } });
    await ownerQuery(`update liame.agency_brand set pending_expires_at = now() - interval '1 second' where tenant_id = $1`, [a.id]);
    expect((await confirmar(tokenFrom(api.mailer, outro))).body.code).toBe('link-invalido');
    expect((await ler(a.dona)).body).toMatchObject({ reply_to: { email: resposta }, pending_reply_to: null });

    // O mesmo e-mail que já vale não manda link; null tira tudo.
    const antes = api.mailer.sent.length;
    expect((await mudar(a.dona, { reply_to_email: resposta })).status).toBe(200);
    expect(api.mailer.sent.length).toBe(antes);
    expect((await mudar(a.dona, { reply_to_email: null })).body).toMatchObject({ reply_to: null, pending_reply_to: null });
    expect(await acoes(a.id)).toEqual(['agencia.marca_mudar', 'agencia.marca_resposta_confirmada', 'agencia.marca_mudar', 'agencia.marca_mudar', 'agencia.marca_mudar']);
  });

  it('o logo: PNG ou JPG regravado em JPEG sobre fundo branco, até 384 × 96; o anterior sai; as recusas; o membro não troca', async () => {
    const a = await agencia('Brasa do Logo');
    const enviado = await logo(a.dona, await png(800, 400, true));
    expect(enviado.status, JSON.stringify(enviado.body)).toBe(200);
    const primeiro = AgencyBrandResponse.parse(enviado.body).logo!;
    expect(primeiro).toMatchObject({ width: 192, height: 96 });
    expect(primeiro.url).toBeTruthy();
    const [linha] = await ownerQuery<{ logo_id: string }>(`select logo_id from liame.agency_brand where tenant_id = $1`, [a.id]);
    const chave = chaveDoLogo(a.id, linha!.logo_id);
    const bytes = armazem.objetos.get(chave)!;
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    // O fundo transparente virou branco.
    const { data } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(245);

    // O endereço público (o do e-mail, A7 · W7, parte 4a): sem login, o logo de agora, em JPEG, que outro site pode
    // mostrar; outra agência ou um endereço que não é de agência, 404.
    const publico = await fetch(`${api.base}/v1/agency-logos/${a.id}.jpg`);
    expect(publico.status).toBe(200);
    expect(publico.headers.get('content-type')).toBe('image/jpeg');
    expect(publico.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(publico.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(publico.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await publico.arrayBuffer()).equals(bytes)).toBe(true);
    expect((await fetch(`${api.base}/v1/agency-logos/${a.membro.userId}.jpg`)).status).toBe(404);
    expect((await fetch(`${api.base}/v1/agency-logos/nao-e-um-id.jpg`)).status).toBe(404);

    // Trocar: o novo entra e o anterior sai do armazenamento.
    const segundo = await logo(a.dona, await png(120, 60), 'image/png');
    expect(segundo.status).toBe(200);
    expect(segundo.body.logo).toMatchObject({ width: 120, height: 60 });
    await new Promise((r) => setTimeout(r, 50));
    expect(armazem.objetos.has(chave)).toBe(false);

    // As recusas.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="50"><script>alert(1)</script></svg>');
    expect((await logo(a.dona, svg, 'image/svg+xml')).body.code).toBe('logo-formato');
    expect((await logo(a.dona, await png(20, 20))).body.code).toBe('logo-pequeno');
    const pesado = Buffer.concat([await png(64, 64), Buffer.alloc(1024 * 1024)]);
    const grande = await logo(a.dona, pesado);
    expect(grande.status).toBe(413);
    expect(grande.body.code).toBe('grande-demais');
    expect((await logo(a.dona, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))).body.code).toBe('logo-nao-abre');
    expect((await logo(a.membro, await png(200, 50))).status).toBe(403);
    // O armazenamento que falha não muda o logo que vale.
    armazem.falhar = { gravar: true };
    expect((await logo(a.dona, await png(200, 50))).body.code).toBe('logo-nao-guardado');
    armazem.falhar = {};
    expect((await ler(a.dona)).body.logo).toMatchObject({ width: 120, height: 60 });

    // Tirar o logo.
    const [atual] = await ownerQuery<{ logo_id: string }>(`select logo_id from liame.agency_brand where tenant_id = $1`, [a.id]);
    expect((await api.call('DELETE', '/v1/agency/brand/logo', { cookie: a.dona.cookie })).status).toBe(204);
    await new Promise((r) => setTimeout(r, 50));
    expect((await ler(a.dona)).body.logo).toBeNull();
    expect(armazem.objetos.has(chaveDoLogo(a.id, atual!.logo_id))).toBe(false);
    // Sem logo, o endereço público some.
    expect((await fetch(`${api.base}/v1/agency-logos/${a.id}.jpg`)).status).toBe(404);
    expect(await acoes(a.id)).toEqual(['agencia.marca_logo', 'agencia.marca_logo', 'agencia.marca_tirar_logo']);
  });

  it('a empresa não tem marca de agência; a RLS separa as agências; o expurgo da agência leva o logo', async () => {
    const a = await agencia('Brasa Isolada');
    const b = await agencia('Brasa Vizinha');
    expect((await logo(a.dona, await png(200, 50))).status).toBe(200);
    // A empresa da dona (a conta de antes da agência) não é agência.
    const empresa = await signupAndLogin(api, undefined, 'Empresa Sem Agência');
    await enableMfa(api, empresa.cookie);
    expect((await api.call('GET', '/v1/agency/brand', { cookie: empresa.cookie })).status).toBe(403);
    // No banco, com o papel da aplicação, a agência B não lê a marca da A.
    const marcaDaA = (tenantId: string, userId: string) =>
      withContext(database.db, { tenantId, userId }, async (tx) => (await tx.execute(sql`select tenant_id from liame.agency_brand where tenant_id = ${a.id}`)).rows);
    expect(await marcaDaA(b.id, b.dona.userId)).toEqual([]);
    expect(await marcaDaA(a.id, a.dona.userId)).toHaveLength(1);

    const [linha] = await ownerQuery<{ logo_id: string }>(`select logo_id from liame.agency_brand where tenant_id = $1`, [a.id]);
    const chave = chaveDoLogo(a.id, linha!.logo_id);
    expect(armazem.objetos.has(chave)).toBe(true);
    await purge.purgeTenant(a.id);
    expect(armazem.objetos.has(chave)).toBe(false);
    expect(await ownerQuery(`select 1 from liame.agency_brand where tenant_id = $1`, [a.id])).toHaveLength(0);
  });
});
