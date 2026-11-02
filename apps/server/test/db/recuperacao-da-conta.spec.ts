import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { MyAccountRecoveryResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations, withContext } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { abrirDocumentos, conferirPedido, listarPedidos, recusarPedido } from '../../src/auth/recuperacao/distribuicao.js';
import { chavePrivadaDaDms, chavePublicaDaDms, gerarChaves } from '../../src/auth/recuperacao/lacre.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { ATENDIMENTO } from '../../src/suporte.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi, TERMOS, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A recuperação da conta do Dono (A7, W8, parte 4a; P34; D-A7-62, D-A7-64; D-A7-85), pelo caminho inteiro: o Dono pede na
// entrada, depois da senha e antes do app, com o documento lacrado pela chave pública da DMS (o app grava e não lê; só a
// chave privada abre); quem não pode pedir; cancelar; o pedido que cai sozinho quando o Dono entra com o app ou com um
// código; a DMS confere ou recusa pelo comando, com a auditoria nas empresas; e a RLS entre as pessoas e as empresas.

/** Um JPG de mentira: o começo de um JPG e bytes ao acaso (o servidor lê o tipo pelo começo e não abre a imagem). */
const jpg = (tamanho = 2048) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(tamanho)]);
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(1024)]);

describe.skipIf(!hasDb)('a recuperação da conta do Dono', () => {
  let api: TestApi;
  let database: Database;
  let app: Database;
  const par = gerarChaves(3072);
  const privada = chavePrivadaDaDms(par.privadaPem);

  type Dono = { email: string; userId: string; segredo: string; codigos: string[]; tenantId: string; empresa: string };

  async function dono(nome: string): Promise<Dono> {
    const empresa = `Empresa ${nome} ${randomBytes(2).toString('hex')}`;
    const s = await signupAndLogin(api, undefined, empresa);
    const mfa = await enableMfa(api, s.cookie);
    return { email: s.email, userId: s.me.user.id as string, segredo: mfa.secret, codigos: mfa.codes, tenantId: s.me.active_organization_id as string, empresa };
  }

  /** Entra só com a senha: a sessão fica antes do app. */
  async function soASenha(email: string): Promise<string> {
    const r = await api.call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.cookie!;
  }

  const pedir = (cookie: string, arquivo: Buffer, tipo = 'image/jpeg', motivo = 'perdi_celular_e_codigos') =>
    api.call('POST', `/v1/me/account-recovery?reason=${motivo}`, { cookie, raw: { data: arquivo, type: tipo } });
  const minha = async (cookie: string) => {
    const r = await api.call('GET', '/v1/me/account-recovery', { cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return MyAccountRecoveryResponse.parse(r.body);
  };
  /** O código do app agora (o do mesmo intervalo já foi usado na ativação: o servidor não aceita o mesmo duas vezes). */
  async function codigoDoApp(d: Dono): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [d.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${d.userId}`]);
    return totpCode(d.segredo, currentStep());
  }
  const config = () => api.app.get<AppConfig>(APP_CONFIG);
  const limparLimite = (userId: string) => ownerQuery(`delete from liame.rate_limit where key = $1`, [`recuperacao:${userId}`]);

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    // A chave pública da DMS, como a variável RECUPERACAO_CHAVE_PUBLICA traria.
    config().recuperacaoChavePublica = chavePublicaDaDms(par.publica);
    database = createDatabase({ connectionString: OWNER_URL, max: 2 });
    app = createDatabase({ connectionString: APP_URL, max: 2 });
  });

  afterAll(async () => {
    await api?.close();
    await database?.close();
    await app?.close();
  });

  beforeEach(async () => {
    await resetIpRateLimits();
  });

  it('o Dono, depois da senha e antes do app, pede com o documento lacrado; o app grava e não lê; só a chave da DMS abre', async () => {
    const d = await dono('Lacre');
    const cookie = await soASenha(d.email);
    const antes = await minha(cookie);
    expect(antes).toEqual({ recovery: null, owner_of: [{ name: d.empresa, cnpj: null }], cannot_request: null });

    const original = jpg();
    const r = await pedir(cookie, original);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const corpo = MyAccountRecoveryResponse.parse(r.body);
    expect(corpo.cannot_request).toBe('pedido-em-andamento');
    expect(corpo.recovery).toMatchObject({ status: 'pedido', reason: 'perdi_celular_e_codigos', companies: [{ name: d.empresa, cnpj: null }], checked_at: null, applies_at: null });
    const protocolo = corpo.recovery!.protocol;
    expect(protocolo).toMatch(/^REC-\d{4}-\d{4,}$/);

    // Os avisos: o protocolo à pessoa e o pedido à DMS (sem dado pessoal no e-mail da DMS).
    expect(api.mailer.sent.find((m) => m.to === d.email && m.subject.includes(protocolo))?.text).toContain('A DMS nunca pede documento por e-mail');
    const daDms = api.mailer.sent.find((m) => m.to === ATENDIMENTO.email && m.subject.includes(protocolo));
    expect(daDms?.text).toContain(`recuperacao-da-conta --ver ${protocolo}`);
    expect(daDms?.text).not.toContain(d.email);

    // No banco: o documento lacrado (não aparece em claro), com o tipo e o tamanho.
    const [doc] = await ownerQuery<{ media_type: string; size_bytes: number; key_id: string; ciphertext: Buffer }>(
      `select d.media_type, d.size_bytes, d.key_id, d.ciphertext from liame.account_recovery_document d
         join liame.account_recovery r on r.id = d.recovery_id where r.protocol = $1`,
      [protocolo],
    );
    expect(doc).toMatchObject({ media_type: 'image/jpeg', size_bytes: original.length, key_id: par.keyId });
    expect(doc!.ciphertext.includes(original.subarray(0, 64))).toBe(false);

    // O papel do app, no contexto da própria pessoa, vê o pedido e não lê o documento.
    const visto = await withContext(app.db, { userId: d.userId }, async (tx) => ({
      pedidos: (await tx.execute(sql`select 1 from liame.account_recovery`)).rows.length,
      documentos: (await tx.execute(sql`select 1 from liame.account_recovery_document`)).rows.length,
    }));
    expect(visto).toEqual({ pedidos: 1, documentos: 0 });

    // Só a chave privada da DMS abre, e devolve o arquivo igual; outra chave é recusada.
    const aberto = await abrirDocumentos(database.db, protocolo, privada);
    expect(aberto.pedido).toMatchObject({ protocol: protocolo, status: 'pedido', pessoa: { email: d.email } });
    expect(aberto.arquivos).toHaveLength(1);
    expect(aberto.arquivos[0]!.bytes.equals(original)).toBe(true);
    const outra = chavePrivadaDaDms(gerarChaves(3072).privadaPem);
    await expect(abrirDocumentos(database.db, protocolo, outra)).rejects.toThrow('não é a que lacrou');

    // Um pedido por vez; e na cadeia da própria pessoa, a auditoria do pedido.
    expect((await pedir(cookie, pdf(), 'application/pdf')).body.code).toBe('pedido-em-andamento');
    const [aud] = await ownerQuery<{ n: string }>(
      `select count(*) as n from liame.audit_event where action = 'segundo_fator.recuperacao_pedir' and actor_id = $1 and tenant_id is null`,
      [d.userId],
    );
    expect(Number(aud!.n)).toBe(1);
  });

  it('quem não pode pedir, o documento fora do formato e a recuperação sem a chave', async () => {
    const d = await dono('Recusas');
    // A sessão que já passou pelo app (a do cadastro) troca o app em Segurança da conta.
    const entrou = await api.call('POST', '/v1/auth/login', { body: { email: d.email, password: PASSWORD } });
    const verificado = await api.call('POST', '/v1/me/mfa/verify', { cookie: entrou.cookie!, body: { code: await codigoDoApp(d) } });
    expect(verificado.status, JSON.stringify(verificado.body)).toBe(204);
    expect((await minha(entrou.cookie!)).cannot_request).toBe('ja-entrou');
    expect((await pedir(entrou.cookie!, jpg())).body.code).toBe('ja-entrou');

    // Quem não tem app não tem o que recuperar.
    const semApp = await signupAndLogin(api, undefined, 'Empresa Sem App');
    expect((await pedir(semApp.cookie, jpg())).body.code).toBe('sem-segundo-fator');

    // Um Administrador (não o Dono) com app, só com a senha: fala com o Dono.
    const email = uniqueEmail('admin');
    const cookieDoDono = (await signupAndLogin(api, undefined, 'Empresa Com Admin')).cookie;
    await enableMfa(api, cookieDoDono);
    const inv = await api.call('POST', '/v1/invitations', { cookie: cookieDoDono, body: { email, role: 'administrador', approve_limit_micros: 100_000_000 } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const novo = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: 'Ana Admin', password: PASSWORD, terms_version: TERMOS } });
    await enableMfa(api, novo.cookie!);
    const adminSoSenha = await soASenha(email);
    expect((await minha(adminSoSenha)).cannot_request).toBe('nao-e-dono');
    const r403 = await pedir(adminSoSenha, jpg());
    expect([r403.status, r403.body.code]).toEqual([403, 'nao-e-dono']);

    // O documento: sem arquivo, fora do formato (o tipo vem do conteúdo, não do cabeçalho) e grande demais.
    const cookie = await soASenha(d.email);
    expect((await api.call('POST', '/v1/me/account-recovery?reason=outro', { cookie, body: {} })).body.code).toBe('falta-o-documento');
    const texto = await pedir(cookie, Buffer.from('não é um documento'), 'image/jpeg');
    expect([texto.status, texto.body.code]).toEqual([422, 'documento-formato']);
    const grande = await pedir(cookie, jpg(10 * 1024 * 1024));
    expect([grande.status, grande.body.code]).toEqual([413, 'grande-demais']);
    expect((await api.call('POST', '/v1/me/account-recovery?reason=sumiu', { cookie, raw: { data: jpg(), type: 'image/jpeg' } })).status).toBe(400);

    // Sem a chave pública da DMS: indisponível, e nada é gravado.
    const chave = config().recuperacaoChavePublica;
    config().recuperacaoChavePublica = null;
    try {
      expect((await minha(cookie)).cannot_request).toBe('indisponivel');
      const r503 = await pedir(cookie, jpg());
      expect([r503.status, r503.body.code]).toEqual([503, 'recuperacao-indisponivel']);
    } finally {
      config().recuperacaoChavePublica = chave;
    }
    expect(await ownerQuery(`select 1 from liame.account_recovery where user_id = $1`, [d.userId])).toEqual([]);
  });

  it('o Dono cancela; o pedido cai sozinho quando ele entra com o app ou com um código; e até 3 pedidos por dia', async () => {
    const d = await dono('Cancela');
    await limparLimite(d.userId);
    let cookie = await soASenha(d.email);

    // Cancelar: o app antigo continua valendo.
    const primeiro = MyAccountRecoveryResponse.parse((await pedir(cookie, jpg())).body).recovery!;
    const cancelado = await api.call('DELETE', `/v1/me/account-recovery/${primeiro.id}`, { cookie });
    expect(cancelado.status, JSON.stringify(cancelado.body)).toBe(200);
    expect(MyAccountRecoveryResponse.parse(cancelado.body)).toMatchObject({ cannot_request: null, recovery: { status: 'cancelado', cancelled_by: 'voce' } });
    expect((await api.call('DELETE', `/v1/me/account-recovery/${primeiro.id}`, { cookie })).status).toBe(404);
    expect(api.mailer.sent.some((m) => m.to === d.email && m.subject === `Liame: pedido de recuperação cancelado (${primeiro.protocol})`)).toBe(true);
    const [vence] = await ownerQuery<{ dias: number }>(
      `select round(extract(epoch from documents_expire_at - closed_at) / 86400) as dias from liame.account_recovery where id = $1`,
      [primeiro.id],
    );
    expect(Number(vence!.dias)).toBe(30);

    // Achou o celular: entrar com o app derruba o pedido em andamento.
    const segundo = MyAccountRecoveryResponse.parse((await pedir(cookie, jpg())).body).recovery!;
    const comApp = await api.call('POST', '/v1/me/mfa/verify', { cookie, body: { code: await codigoDoApp(d) } });
    expect(comApp.status, JSON.stringify(comApp.body)).toBe(204);
    expect((await minha(cookie)).recovery).toMatchObject({ id: segundo.id, status: 'cancelado', cancelled_by: 'entrou' });
    expect(api.mailer.sent.some((m) => m.to === d.email && m.text.includes(`o pedido de recuperação ${segundo.protocol} foi cancelado sozinho`))).toBe(true);

    // Achou os códigos: entrar com um código de recuperação também.
    cookie = await soASenha(d.email);
    const terceiro = MyAccountRecoveryResponse.parse((await pedir(cookie, pdf(), 'application/pdf', 'celular_roubado_ou_quebrado')).body).recovery!;
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${d.userId}`]);
    const comCodigo = await api.call('POST', '/v1/me/mfa/verify', { cookie, body: { code: d.codigos[0] } });
    expect(comCodigo.status, JSON.stringify(comCodigo.body)).toBe(204);
    expect((await minha(cookie)).recovery).toMatchObject({ id: terceiro.id, status: 'cancelado', cancelled_by: 'entrou' });

    // O quarto pedido do dia passa do limite.
    cookie = await soASenha(d.email);
    expect((await pedir(cookie, jpg())).status).toBe(429);
  });

  it('as restrições do banco (V119): cada check recusa o valor errado, pelo nome; um pedido em andamento por pessoa', async () => {
    const d = await dono('Restricoes');
    const id = '0e000000-0000-4000-8000-000000000106';
    await ownerQuery(`delete from liame.account_recovery where id = $1`, [id]);
    await ownerQuery(
      `insert into liame.account_recovery (id, user_id, protocol, reason, companies) values ($1, $2, 'REC-2026-9106', 'outro', '[]'::jsonb)`,
      [id, d.userId],
    );
    const restricao = async (texto: string, params: unknown[] = []): Promise<string | undefined> => {
      try {
        await ownerQuery(texto, params);
        return undefined;
      } catch (e) {
        return (e as { constraint?: string }).constraint;
      }
    };
    const mudar = (set: string) => restricao(`update liame.account_recovery set ${set} where id = $1`, [id]);
    expect(await mudar(`protocol = 'REC-26-1'`)).toBe('account_recovery_protocol_check');
    expect(await mudar(`reason = 'sumiu'`)).toBe('account_recovery_reason_check');
    expect(await mudar(`status = 'perdido'`)).toBe('account_recovery_status_check');
    expect(await mudar(`companies = '{}'::jsonb`)).toBe('account_recovery_companies_check');
    expect(await mudar(`checked_by = 'R'`)).toBe('account_recovery_checked_by_check');
    expect(await mudar(`checks = '[]'::jsonb`)).toBe('account_recovery_checks_check');
    expect(await mudar(`notified_status = 'lido'`)).toBe('account_recovery_notified_status_check');
    expect(await mudar(`status = 'aplicado'`)).toBe('account_recovery_fechado');
    expect(await mudar(`status = 'conferido'`)).toBe('account_recovery_espera');
    expect(await mudar(`status = 'recusado', closed_at = now()`)).toBe('account_recovery_recusa');
    expect(await mudar(`status = 'recusado', closed_at = now(), refusal_reason = 'ab'`)).toBe('account_recovery_refusal_reason_check');
    expect(await mudar(`status = 'cancelado', closed_at = now()`)).toBe('account_recovery_cancelamento');
    expect(await mudar(`status = 'cancelado', closed_at = now(), cancelled_by = 'dms'`)).toBe('account_recovery_cancelled_by_check');
    // O que vale passa: a espera com a data, e os opcionais nulos.
    expect(await mudar(`status = 'conferido', checked_at = now(), applies_at = now() + interval '7 days', checked_by = 'Rodrigo', checks = '{}'::jsonb`)).toBeUndefined();
    // Um pedido em andamento por pessoa: o segundo bate no índice único.
    expect(
      await restricao(`insert into liame.account_recovery (id, user_id, protocol, reason) values (gen_random_uuid(), $1, 'REC-2026-9107', 'outro')`, [d.userId]),
    ).toBe('uq_account_recovery_aberto');

    // O documento: o tipo, o tamanho, a impressão digital e o tamanho do iv e da etiqueta.
    const doc = (o: { kind?: string; tipo?: string; tamanho?: number; keyId?: string; iv?: number; tag?: number }) =>
      restricao(
        `insert into liame.account_recovery_document (id, recovery_id, kind, media_type, size_bytes, key_id, wrapped_key, iv, tag, ciphertext)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, '\\x00', $6, $7, '\\x00')`,
        [id, o.kind ?? 'documento_com_foto', o.tipo ?? 'image/png', o.tamanho ?? 10, o.keyId ?? 'ab12cd34ef56ab78', Buffer.alloc(o.iv ?? 12), Buffer.alloc(o.tag ?? 16)],
      );
    expect(await doc({})).toBeUndefined();
    expect(await doc({ kind: 'selfie' })).toBe('account_recovery_document_kind_check');
    expect(await doc({ tipo: 'image/gif' })).toBe('account_recovery_document_media_type_check');
    expect(await doc({ tamanho: 0 })).toBe('account_recovery_document_size_bytes_check');
    expect(await doc({ tamanho: 10 * 1024 * 1024 + 1 })).toBe('account_recovery_document_size_bytes_check');
    expect(await doc({ keyId: 'AB12CD34EF56AB78' })).toBe('account_recovery_document_key_id_check');
    expect(await doc({ iv: 11 })).toBe('account_recovery_document_iv_check');
    expect(await doc({ tag: 15 })).toBe('account_recovery_document_tag_check');
    await ownerQuery(`delete from liame.account_recovery where id = $1`, [id]);
  });

  it('a DMS confere (os três) ou recusa pelo comando; a auditoria fica nas empresas; a RLS separa pessoas e empresas', async () => {
    const d = await dono('Confere');
    const cookie = await soASenha(d.email);
    const pedido = MyAccountRecoveryResponse.parse((await pedir(cookie, jpg())).body).recovery!;

    await expect(conferirPedido(database.db, { protocolo: pedido.protocol, por: 'Rodrigo', documento: true, socios: true, videochamada: false })).rejects.toThrow('precisa dos três');
    const { appliesAt } = await conferirPedido(database.db, { protocolo: pedido.protocol, por: 'Rodrigo', documento: true, socios: true, videochamada: true });
    expect(Math.round((appliesAt.getTime() - Date.now()) / 86_400_000)).toBe(7);
    await expect(conferirPedido(database.db, { protocolo: pedido.protocol, por: 'Rodrigo', documento: true, socios: true, videochamada: true })).rejects.toThrow('só se confere o que está pedido');
    const visto = (await minha(cookie)).recovery!;
    expect(visto).toMatchObject({ status: 'conferido', applies_at: appliesAt.toISOString() });
    expect(visto.checked_at).not.toBeNull();

    // A auditoria da empresa: quem decidiu e o que conferiu, sem imagem.
    const [aud] = await ownerQuery<{ actor_label: string; after: Record<string, unknown> }>(
      `select actor_label, after from liame.audit_event where tenant_id = $1 and action = 'segundo_fator.recuperacao_conferir'`,
      [d.tenantId],
    );
    expect(aud).toMatchObject({ actor_label: 'Distribuição DMS (Rodrigo)', after: { protocolo: pedido.protocol, documento: true, socios: true, videochamada: true } });
    expect((await listarPedidos(database.db)).some((p) => p.protocol === pedido.protocol && p.status === 'conferido')).toBe(true);

    // Recusar: o motivo que a pessoa lê.
    const outro = await dono('Recusa');
    const cookieOutro = await soASenha(outro.email);
    const pedidoOutro = MyAccountRecoveryResponse.parse((await pedir(cookieOutro, jpg())).body).recovery!;
    await expect(recusarPedido(database.db, { protocolo: pedidoOutro.protocol, por: 'Rodrigo', motivo: 'x' })).rejects.toThrow('diga o motivo');
    await recusarPedido(database.db, { protocolo: pedidoOutro.protocol, por: 'Rodrigo', motivo: 'O nome do documento não está no quadro de sócios.' });
    expect((await minha(cookieOutro)).recovery).toMatchObject({ status: 'recusado', refusal_reason: 'O nome do documento não está no quadro de sócios.' });
    expect((await minha(cookieOutro)).cannot_request).toBeNull();
    expect((await listarPedidos(database.db)).some((p) => p.protocol === pedidoOutro.protocol)).toBe(false);
    expect((await listarPedidos(database.db, { todos: true })).some((p) => p.protocol === pedidoOutro.protocol)).toBe(true);

    // A RLS: outra pessoa não vê o pedido; a empresa do Dono vê (para o aviso aos Administradores, parte 4b); outra empresa não.
    const contar = (ctx: { userId: string; tenantId?: string }) =>
      withContext(app.db, ctx, async (tx) => (await tx.execute(sql`select 1 from liame.account_recovery where id = ${pedido.id}`)).rows.length);
    expect(await contar({ userId: outro.userId })).toBe(0);
    expect(await contar({ userId: outro.userId, tenantId: d.tenantId })).toBe(1);
    expect(await contar({ userId: d.userId, tenantId: outro.tenantId })).toBe(1);
    expect(await contar({ userId: outro.userId, tenantId: outro.tenantId })).toBe(0);
  });
});
