import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { AccountRecoveryNoticeResponse, MyAccountRecoveryResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { conferirPedido, retomarPedido } from '../../src/auth/recuperacao/distribuicao.js';
import { chavePublicaDaDms, gerarChaves } from '../../src/auth/recuperacao/lacre.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { ATENDIMENTO } from '../../src/suporte.js';
import { RecuperacaoDaContaRotina } from '../../src/worker/recuperacao-da-conta.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi, TERMOS, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A espera da recuperação da conta do Dono (A7, W8, parte 4b; P34; D-A7-62, D-A7-64; D-A7-85): os Administradores da
// própria empresa veem o aviso e param o pedido ("Não reconheço"), e só a DMS retoma; os e-mails de cada situação saem
// pelo worker, uma vez; no fim dos 7 dias, o app antigo, os códigos e as sessões saem, e o Dono cadastra o app novo ao
// entrar; o cancelamento depois da conferência avisa os Administradores; os documentos saem em 30 dias.

const jpg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(512)]);
const DIA = 86_400_000;

describe.skipIf(!hasDb)('a espera da recuperação da conta do Dono', () => {
  let api: TestApi;
  let database: Database;
  let worker: Database;
  let rotina: RecuperacaoDaContaRotina;
  const par = gerarChaves(3072);

  type Pessoa = { cookie: string; email: string; userId: string; segredo: string; codigos: string[] };

  async function convidar(cookie: string, role: string, nome: string): Promise<Pessoa> {
    const email = uniqueEmail(role);
    const inv = await api.call('POST', '/v1/invitations', { cookie, body: { email, role, approve_limit_micros: 100_000_000 } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const r = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: nome, password: PASSWORD, terms_version: TERMOS } });
    const mfa = await enableMfa(api, r.cookie!);
    return { cookie: r.cookie!, email, userId: r.body.user.id as string, segredo: mfa.secret, codigos: mfa.codes };
  }

  async function empresa(nome: string) {
    const nomeDaEmpresa = `Empresa ${nome} ${randomBytes(2).toString('hex')}`;
    const s = await signupAndLogin(api, undefined, nomeDaEmpresa);
    const mfa = await enableMfa(api, s.cookie);
    const dono: Pessoa = { cookie: s.cookie, email: s.email, userId: s.me.user.id as string, segredo: mfa.secret, codigos: mfa.codes };
    const admin = await convidar(dono.cookie, 'administrador', 'Ana Admin');
    const gestor = await convidar(dono.cookie, 'gestor', 'Caio Gestor');
    return { dono, admin, gestor, tenantId: s.me.active_organization_id as string, nome: nomeDaEmpresa };
  }

  async function soASenha(email: string): Promise<string> {
    const r = await api.call('POST', '/v1/auth/login', { body: { email, password: PASSWORD } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.cookie!;
  }

  async function pedir(dono: Pessoa) {
    const cookie = await soASenha(dono.email);
    const r = await api.call('POST', '/v1/me/account-recovery?reason=perdi_celular_e_codigos', { cookie, raw: { data: jpg(), type: 'image/jpeg' } });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return { cookie, pedido: MyAccountRecoveryResponse.parse(r.body).recovery! };
  }

  const aviso = async (p: Pessoa) => {
    const r = await api.call('GET', '/v1/account-recovery/notice', { cookie: p.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return AccountRecoveryNoticeResponse.parse(r.body).notice;
  };
  const emailsPara = (to: string, desde: number) => api.mailer.sent.slice(desde).filter((m) => m.to === to);
  const so = (...userIds: string[]) => ({ userIds });

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    api.app.get<AppConfig>(APP_CONFIG).recuperacaoChavePublica = chavePublicaDaDms(par.publica);
    database = createDatabase({ connectionString: OWNER_URL, max: 2 });
    worker = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    rotina = new RecuperacaoDaContaRotina(worker, api.mailer, api.app.get<AppConfig>(APP_CONFIG));
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await database?.close();
    await worker?.close();
  });

  beforeEach(resetIpRateLimits);

  it('na espera, os Administradores veem o aviso e param; só a DMS retoma; cada e-mail sai uma vez', async () => {
    const e = await empresa('Aviso');
    const outra = await empresa('Outra');
    const { cookie, pedido } = await pedir(e.dono);
    // Antes da conferência, ninguém mais vê o pedido.
    expect(await aviso(e.admin)).toBeNull();

    await conferirPedido(database.db, { protocolo: pedido.protocol, por: 'Rodrigo', documento: true, socios: true, videochamada: true });
    let desde = api.mailer.sent.length;
    expect(await rotina.avisosLote(20, so(e.dono.userId))).toEqual([pedido.id]);
    expect(emailsPara(e.dono.email, desde)[0]?.subject).toBe(`Liame: a DMS conferiu o seu pedido de recuperação (${pedido.protocol})`);
    const doAdmin = emailsPara(e.admin.email, desde);
    expect(doAdmin.map((m) => m.subject)).toEqual([`Liame: Pessoa de Teste pediu para recuperar a entrada na conta da ${e.nome}`]);
    expect(doAdmin[0]!.text).toContain('Não reconheço este pedido');
    expect(emailsPara(e.gestor.email, desde)).toEqual([]);
    expect(await rotina.avisosLote(20, so(e.dono.userId))).toEqual([]);

    // O aviso: o Administrador da empresa vê; o Gestor e a outra empresa, não.
    const visto = await aviso(e.admin);
    expect(visto).toMatchObject({ id: pedido.id, protocol: pedido.protocol, owner_name: 'Pessoa de Teste', status: 'conferido', stopped_at: null, stopped_by_me: false });
    expect(Math.round((new Date(visto!.applies_at!).getTime() - Date.now()) / DIA)).toBe(7);
    expect(await aviso(e.gestor)).toBeNull();
    expect(await aviso(outra.admin)).toBeNull();
    const doGestor = await api.call('POST', `/v1/account-recovery/${pedido.id}/stop`, { cookie: e.gestor.cookie });
    expect([doGestor.status, doGestor.body.code]).toEqual([403, 'so-administrador']);
    expect((await api.call('POST', `/v1/account-recovery/${pedido.id}/stop`, { cookie: outra.admin.cookie })).status).toBe(404);

    // "Não reconheço este pedido": parado, e a troca não acontece nem depois da data.
    const parado = await api.call('POST', `/v1/account-recovery/${pedido.id}/stop`, { cookie: e.admin.cookie });
    expect(parado.status, JSON.stringify(parado.body)).toBe(200);
    expect(AccountRecoveryNoticeResponse.parse(parado.body).notice).toMatchObject({ status: 'parado', applies_at: null, stopped_by_me: true });
    expect((await api.call('POST', `/v1/account-recovery/${pedido.id}/stop`, { cookie: e.admin.cookie })).status).toBe(404);
    expect((await api.call('GET', '/v1/me/account-recovery', { cookie })).body.recovery).toMatchObject({ status: 'parado', applies_at: null });
    desde = api.mailer.sent.length;
    expect(await rotina.avisosLote(20, so(e.dono.userId))).toEqual([pedido.id]);
    expect(emailsPara(e.dono.email, desde).map((m) => m.subject)).toEqual([`Liame: o seu pedido de recuperação foi parado (${pedido.protocol})`]);
    expect(emailsPara(ATENDIMENTO.email, desde).map((m) => m.subject)).toEqual([`Liame: pedido de recuperação parado (${pedido.protocol})`]);
    expect(await rotina.aplicarLote(20, so(e.dono.userId), new Date(Date.now() + 30 * DIA))).toEqual([]);

    // A DMS retoma, depois de falar com o Dono: a espera recomeça, e o aviso sai de novo.
    await expect(retomarPedido(database.db, { protocolo: pedido.protocol, por: 'Rodrigo', motivo: 'ok' })).rejects.toThrow('diga como a DMS confirmou');
    await retomarPedido(database.db, { protocolo: pedido.protocol, por: 'Rodrigo', motivo: 'Confirmado com o Dono por telefone.' });
    await expect(retomarPedido(database.db, { protocolo: pedido.protocol, por: 'Rodrigo', motivo: 'De novo, por engano.' })).rejects.toThrow('só se retoma o que foi parado');
    desde = api.mailer.sent.length;
    expect(await rotina.avisosLote(20, so(e.dono.userId))).toEqual([pedido.id]);
    expect(emailsPara(e.admin.email, desde)).toHaveLength(1);
    expect(await aviso(e.admin)).toMatchObject({ status: 'conferido', stopped_by_me: true });

    const acoes = await ownerQuery<{ action: string; actor_label: string | null }>(
      `select action, actor_label from liame.audit_event where tenant_id = $1 and resource_id = $2 order by chain_seq`,
      [e.tenantId, pedido.id],
    );
    expect(acoes.map((a) => a.action)).toEqual(['segundo_fator.recuperacao_conferir', 'pessoas.recuperacao_parar', 'segundo_fator.recuperacao_retomar']);
  });

  it('no fim da espera, o app antigo, os códigos e as sessões saem; ao entrar com a senha, o Dono cadastra o app novo', async () => {
    const e = await empresa('Troca');
    const { pedido } = await pedir(e.dono);
    await conferirPedido(database.db, { protocolo: pedido.protocol, por: 'Rodrigo', documento: true, socios: true, videochamada: true });
    await rotina.avisosLote(20, so(e.dono.userId));

    // Uma chave de acesso do Dono (A7, W9): a troca também a tira (ela pode estar no aparelho perdido).
    await ownerQuery(
      `insert into liame.passkey (id, user_id, credential_id, public_key, device_type, backed_up, aaguid, name)
       values (gen_random_uuid(), $1, $2, '\\x00', 'multiDevice', true, '00000000-0000-0000-0000-000000000000', 'Chave do celular perdido')`,
      [e.dono.userId, `credencial_${e.dono.userId.replace(/-/g, '')}`],
    );
    // Antes da data, nada; depois dela, a troca.
    expect(await rotina.aplicarLote(20, so(e.dono.userId))).toEqual([]);
    expect(await rotina.aplicarLote(20, so(e.dono.userId), new Date(Date.now() + 7 * DIA + 60_000))).toEqual([pedido.id]);
    expect(await rotina.aplicarLote(20, so(e.dono.userId), new Date(Date.now() + 8 * DIA))).toEqual([]);

    // As sessões fecharam (a do cadastro, com o app, também), o app e os códigos saíram.
    expect((await api.call('GET', '/v1/me', { cookie: e.dono.cookie })).status).toBe(401);
    const [estado] = await ownerQuery<{ app: string; codigos: string; sessoes: string; chaves: string; desde: Date | null }>(
      `select (select count(*) from liame.secret where owner_user_id = $1 and tenant_id is null and purpose in ('totp', 'totp_pendente') and revoked_at is null) as app,
              (select count(*) from liame.recovery_code where user_id = $1 and used_at is null) as codigos,
              (select count(*) from liame.session where user_id = $1 and revoked_at is null) as sessoes,
              (select count(*) from liame.passkey where user_id = $1) as chaves,
              (select mfa_enabled_at from liame.app_user where id = $1) as desde`,
      [e.dono.userId],
    );
    expect(estado).toEqual({ app: '0', codigos: '0', sessoes: '0', chaves: '0', desde: null });

    // Ao entrar: o código do app antigo não vale mais; o app novo se cadastra, com códigos novos.
    const cookie = await soASenha(e.dono.email);
    const antigo = await api.call('POST', '/v1/me/mfa/verify', { cookie, body: { code: totpCode(e.dono.segredo, currentStep()) } });
    expect(antigo.body.code).toBe('segundo-fator-nao-configurado');
    const novo = await enableMfa(api, cookie);
    expect(novo.codes).toHaveLength(10);
    expect((await api.call('GET', '/v1/me/account-recovery', { cookie })).body.recovery).toMatchObject({ id: pedido.id, status: 'aplicado' });

    const desde = api.mailer.sent.length;
    expect(await rotina.avisosLote(20, so(e.dono.userId))).toEqual([pedido.id]);
    expect(emailsPara(e.dono.email, desde)[0]?.subject).toBe(`Liame: o app autenticador da sua conta foi trocado (${pedido.protocol})`);
    expect(emailsPara(e.admin.email, desde).map((m) => m.subject)).toEqual(['Liame: o app autenticador de Pessoa de Teste foi trocado']);
    const [aud] = await ownerQuery<{ actor_label: string }>(
      `select actor_label from liame.audit_event where tenant_id = $1 and action = 'segundo_fator.recuperacao_aplicar' and resource_id = $2`,
      [e.tenantId, pedido.id],
    );
    expect(aud?.actor_label).toBe('Recuperação da conta (rotina)');
  });

  it('o cancelamento depois da conferência avisa os Administradores (antes, não); os documentos saem em 30 dias', async () => {
    const e = await empresa('Cancela');
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`recuperacao:${e.dono.userId}`]);

    // Antes da conferência: o Dono cancela, e o worker não tem o que avisar.
    const antes = await pedir(e.dono);
    expect((await api.call('DELETE', `/v1/me/account-recovery/${antes.pedido.id}`, { cookie: antes.cookie })).status).toBe(200);
    expect(await rotina.avisosLote(20, so(e.dono.userId))).toEqual([]);

    // Depois da conferência: o Dono recebe o e-mail da API, e os Administradores, o do worker.
    const depois = await pedir(e.dono);
    await conferirPedido(database.db, { protocolo: depois.pedido.protocol, por: 'Rodrigo', documento: true, socios: true, videochamada: true });
    await rotina.avisosLote(20, so(e.dono.userId));
    let desde = api.mailer.sent.length;
    expect((await api.call('DELETE', `/v1/me/account-recovery/${depois.pedido.id}`, { cookie: depois.cookie })).status).toBe(200);
    expect(emailsPara(e.dono.email, desde)).toHaveLength(1);
    desde = api.mailer.sent.length;
    expect(await rotina.avisosLote(20, so(e.dono.userId))).toEqual([depois.pedido.id]);
    expect(emailsPara(e.dono.email, desde)).toEqual([]);
    expect(emailsPara(e.admin.email, desde).map((m) => m.subject)).toEqual([`Liame: o pedido de recuperação de Pessoa de Teste foi cancelado (${e.nome})`]);
    expect(await aviso(e.admin)).toBeNull();

    // O expurgo: nada antes dos 30 dias; depois, os dois documentos saem (o pedido fica, sem a imagem).
    expect(await rotina.expurgarLote(50, so(e.dono.userId))).toBe(0);
    expect(await rotina.expurgarLote(50, so(e.dono.userId), new Date(Date.now() + 31 * DIA))).toBe(2);
    const [resto] = await ownerQuery<{ pedidos: string; documentos: string }>(
      `select (select count(*) from liame.account_recovery where user_id = $1) as pedidos,
              (select count(*) from liame.account_recovery_document d join liame.account_recovery r on r.id = d.recovery_id where r.user_id = $1) as documentos`,
      [e.dono.userId],
    );
    expect(resto).toEqual({ pedidos: '2', documentos: '0' });
  });
});
