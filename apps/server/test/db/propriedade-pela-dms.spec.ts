import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { OwnershipClaimResponse } from '@liame/contracts';
import { createDatabase, type Database, runMigrations, withContext } from '@liame/database';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chavePrivadaDaDms, chavePublicaDaDms, gerarChaves } from '../../src/auth/recuperacao/lacre.js';
import {
  abrirDocumentosDaPropriedade,
  aprovarPropriedade,
  conferirPropriedade,
  listarPropriedades,
  recusarPropriedade,
} from '../../src/auth/recuperacao/propriedade-pela-dms.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { ATENDIMENTO } from '../../src/suporte.js';
import { PropriedadePelaDmsRotina } from '../../src/worker/propriedade-pela-dms.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi, TERMOS, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A propriedade pedida à DMS quando o Dono não está mais (A7, W8, parte 6a; P34; D-A7-63, D-A7-64; D-A7-86), pelo caminho
// inteiro: quem pode pedir; o rascunho, os dois documentos lacrados (o app grava e não lê) e o envio; a DMS confere pelo
// comando; o Dono é avisado e pode responder; a aprovação só depois dos 14 dias, com quem pediu virando a dona e o Dono
// antigo saindo; recusar, desistir, o rascunho esquecido e o expurgo; e as restrições do banco.

const jpg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(700)]);
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(900)]);
const DIA = 86_400_000;

describe.skipIf(!hasDb)('a propriedade pedida à DMS', () => {
  let api: TestApi;
  let database: Database;
  let app: Database;
  let rotina: PropriedadePelaDmsRotina;
  const par = gerarChaves(3072);
  const privada = chavePrivadaDaDms(par.privadaPem);

  type Pessoa = { cookie: string; email: string; userId: string; segredo: string };

  async function convidar(cookie: string, role: string, nome: string, comApp = true): Promise<Pessoa> {
    const email = uniqueEmail(role);
    const inv = await api.call('POST', '/v1/invitations', { cookie, body: { email, role, approve_limit_micros: 100_000_000 } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const r = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: nome, password: PASSWORD, terms_version: TERMOS } });
    return { cookie: r.cookie!, email, userId: r.body.user.id as string, segredo: comApp ? (await enableMfa(api, r.cookie!)).secret : '' };
  }

  async function empresa(nome: string) {
    const s = await signupAndLogin(api, undefined, `Empresa ${nome}`);
    const dono: Pessoa = { cookie: s.cookie, email: s.email, userId: s.me.user.id as string, segredo: (await enableMfa(api, s.cookie)).secret };
    const admin = await convidar(dono.cookie, 'administrador', 'Ana Lima');
    return { dono, admin, tenantId: s.me.active_organization_id as string, nome: `Empresa ${nome}` };
  }

  const ler = async (p: Pessoa) => {
    const r = await api.call('GET', '/v1/ownership/claim', { cookie: p.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return OwnershipClaimResponse.parse(r.body);
  };
  const comecar = (p: Pessoa, o: { reason?: string; note?: string | null; terms_version?: string } = {}) =>
    api.call('POST', '/v1/ownership/claims', { cookie: p.cookie, body: { reason: 'saiu_da_sociedade', note: null, terms_version: TERMOS, ...o } });
  const documento = (p: Pessoa, id: string, kind: string, dados: Buffer, tipo = 'image/jpeg') =>
    api.call('PUT', `/v1/ownership/claims/${id}/documents/${kind}`, { cookie: p.cookie, raw: { data: dados, type: tipo } });
  const enviar = (p: Pessoa, id: string) => api.call('POST', `/v1/ownership/claims/${id}/send`, { cookie: p.cookie });

  /** O pedido inteiro, até o envio. */
  async function pedidoEnviado(e: Awaited<ReturnType<typeof empresa>>): Promise<{ id: string; protocol: string }> {
    const r = await comecar(e.admin);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = OwnershipClaimResponse.parse(r.body).claim!.id;
    expect((await documento(e.admin, id, 'documento_com_foto', jpg())).status).toBe(200);
    expect((await documento(e.admin, id, 'documento_da_empresa', pdf(), 'application/pdf')).status).toBe(200);
    const enviado = await enviar(e.admin, id);
    expect(enviado.status, JSON.stringify(enviado.body)).toBe(200);
    return { id, protocol: OwnershipClaimResponse.parse(enviado.body).claim!.protocol };
  }
  const so = (tenantId: string) => ({ tenantIds: [tenantId] });

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    api.app.get<AppConfig>(APP_CONFIG).recuperacaoChavePublica = chavePublicaDaDms(par.publica);
    database = createDatabase({ connectionString: OWNER_URL, max: 2 });
    app = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    rotina = new PropriedadePelaDmsRotina(app, api.mailer, api.app.get<AppConfig>(APP_CONFIG));
  }, 120_000);

  afterAll(async () => {
    await api?.close();
    await database?.close();
    await app?.close();
  });

  beforeEach(resetIpRateLimits);

  it('quem pode pedir; o rascunho, os dois documentos lacrados (o app grava e não lê) e o envio', async () => {
    const e = await empresa('Pede');
    const gestor = await convidar(e.dono.cookie, 'gestor', 'Caio Gestor');
    const semApp = await convidar(e.dono.cookie, 'administrador', 'Bia Sem App', false);
    expect((await ler(e.admin)).cannot_claim).toBeNull();
    expect((await ler(e.dono)).cannot_claim).toBe('e-o-dono');
    expect((await ler(gestor)).cannot_claim).toBe('nao-e-administrador');
    expect((await comecar(gestor)).body.code).toBe('so-administrador');
    expect((await comecar(e.dono)).body.code).toBe('e-o-dono');
    expect((await comecar(e.admin, { terms_version: 'velha' })).body.code).toBe('termos-desatualizados');
    // Quem não tem o app ainda não entrou com ele (a sessão do convite): o nível exige o app antes das rotas da empresa.
    expect((await api.call('GET', '/v1/ownership/claim', { cookie: semApp.cookie })).status).not.toBe(200);

    // O rascunho: começar de novo atualiza o mesmo.
    const r = await comecar(e.admin, { note: 'O Rodrigo vendeu a parte dele.' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const rascunho = OwnershipClaimResponse.parse(r.body);
    expect(rascunho).toMatchObject({ mine: true, about_me: false, cannot_claim: 'pedido-em-andamento', claim: { status: 'rascunho', documents: [], note: 'O Rodrigo vendeu a parte dele.' } });
    const id = rascunho.claim!.id;
    expect(rascunho.claim!.protocol).toMatch(/^PROP-\d{4}-\d{4,}$/);
    expect(OwnershipClaimResponse.parse((await comecar(e.admin, { reason: 'faleceu' })).body).claim).toMatchObject({ id, reason: 'faleceu', note: null });

    // Os documentos: falta, formato, troca; e o envio só com os dois.
    expect((await enviar(e.admin, id)).body.code).toBe('faltam-documentos');
    const foto = jpg();
    expect((await documento(e.admin, id, 'documento_com_foto', Buffer.from('não é foto'))).body.code).toBe('documento-formato');
    expect(OwnershipClaimResponse.parse((await documento(e.admin, id, 'documento_com_foto', jpg())).body).claim!.documents).toEqual(['documento_com_foto']);
    expect((await documento(e.admin, id, 'documento_com_foto', foto)).status).toBe(200);
    expect((await enviar(e.admin, id)).body.detail).toContain('documento da empresa');
    const contrato = pdf();
    expect(OwnershipClaimResponse.parse((await documento(e.admin, id, 'documento_da_empresa', contrato, 'application/pdf')).body).claim!.documents).toEqual([
      'documento_com_foto',
      'documento_da_empresa',
    ]);
    // O papel do app, no rascunho da empresa, vê qual documento já foi, nunca o conteúdo lacrado.
    const noRascunho = await withContext(app.db, { userId: e.admin.userId, tenantId: e.tenantId }, async (tx) =>
      (await tx.execute<{ kind: string }>(sql`select kind from liame.ownership_claim_document where claim_id = ${id} order by kind`)).rows.map((d) => d.kind),
    );
    expect(noRascunho).toEqual(['documento_com_foto', 'documento_da_empresa']);
    const leitura = await withContext(app.db, { userId: e.admin.userId, tenantId: e.tenantId }, (tx) =>
      tx.execute(sql`select ciphertext from liame.ownership_claim_document where claim_id = ${id}`),
    ).then(
      () => 'leu',
      (err: { code?: string; cause?: { code?: string } }) => err.code ?? err.cause?.code,
    );
    expect(leitura).toBe('42501');

    const desde = api.mailer.sent.length;
    const enviado = await enviar(e.admin, id);
    expect(enviado.status, JSON.stringify(enviado.body)).toBe(200);
    const protocolo = OwnershipClaimResponse.parse(enviado.body).claim!.protocol;
    expect(OwnershipClaimResponse.parse(enviado.body).claim).toMatchObject({ status: 'pedido' });
    expect(api.mailer.sent.slice(desde).map((m) => m.to).sort()).toEqual([ATENDIMENTO.email, e.admin.email].sort());
    expect(api.mailer.sent.slice(desde).find((m) => m.to === ATENDIMENTO.email)?.text).not.toContain(e.admin.email);
    // No envio, o rascunho já não troca documento, e a empresa deixa de ver as linhas dos documentos.
    expect((await documento(e.admin, id, 'documento_com_foto', jpg())).status).toBe(404);
    const depois = await withContext(app.db, { userId: e.admin.userId, tenantId: e.tenantId }, async (tx) => ({
      pedidos: (await tx.execute(sql`select 1 from liame.ownership_claim where id = ${id}`)).rows.length,
      documentos: (await tx.execute(sql`select kind from liame.ownership_claim_document where claim_id = ${id}`)).rows.length,
    }));
    expect(depois).toEqual({ pedidos: 1, documentos: 0 });

    // Só a chave da DMS abre, igual ao enviado; o pedido aparece na lista do comando.
    const aberto = await abrirDocumentosDaPropriedade(database.db, protocolo, privada);
    expect(aberto.arquivos.map((a) => a.kind)).toEqual(['documento_com_foto', 'documento_da_empresa']);
    expect(aberto.arquivos[0]!.bytes.equals(foto)).toBe(true);
    expect(aberto.arquivos[1]!.bytes.equals(contrato)).toBe(true);
    expect((await listarPropriedades(database.db)).some((p) => p.protocol === protocolo && p.status === 'pedido')).toBe(true);
  });

  it('a DMS confere; o Dono é avisado e responde; aprova só depois dos 14 dias; quem pediu vira a dona e o Dono antigo sai', async () => {
    const e = await empresa('Aprova');
    const { id, protocol } = await pedidoEnviado(e);
    await expect(conferirPropriedade(database.db, { protocolo: protocol, por: 'Rodrigo', documento: true, empresa: true, socios: true, videochamada: false })).rejects.toThrow('precisa dos quatro');
    const { decideFrom } = await conferirPropriedade(database.db, { protocolo: protocol, por: 'Rodrigo', documento: true, empresa: true, socios: true, videochamada: true });
    expect(Math.round((decideFrom.getTime() - Date.now()) / DIA)).toBe(14);

    let desde = api.mailer.sent.length;
    expect(await rotina.avisosLote(20, so(e.tenantId))).toEqual([id]);
    const aoDono = api.mailer.sent.slice(desde).find((m) => m.to === e.dono.email);
    expect(aoDono?.subject).toBe(`Liame: Ana Lima pediu à DMS a propriedade da ${e.nome}`);
    expect(aoDono?.text).toContain('Ainda cuido da conta');
    expect(aoDono?.text).not.toContain('faleceu');
    expect(api.mailer.sent.slice(desde).some((m) => m.to === e.admin.email)).toBe(true);
    expect(await rotina.avisosLote(20, so(e.tenantId))).toEqual([]);

    // O Dono vê o pedido sobre ele (sem a nota de quem pediu) e responde.
    expect(await ler(e.dono)).toMatchObject({ mine: false, about_me: true, claim: { id, status: 'conferido', note: null } });
    await expect(aprovarPropriedade(database.db, { protocolo: protocol, por: 'Rodrigo', motivo: 'Cedo demais.' })).rejects.toThrow('ainda não terminou');
    expect((await api.call('POST', `/v1/ownership/claims/${id}/contest`, { cookie: e.admin.cookie })).body.code).toBe('so-o-dono');
    const contestado = await api.call('POST', `/v1/ownership/claims/${id}/contest`, { cookie: e.dono.cookie });
    expect(contestado.status, JSON.stringify(contestado.body)).toBe(200);
    expect(OwnershipClaimResponse.parse(contestado.body).claim).toMatchObject({ status: 'contestado' });
    desde = api.mailer.sent.length;
    await rotina.avisosLote(20, so(e.tenantId));
    expect(api.mailer.sent.slice(desde).map((m) => m.to).sort()).toEqual([ATENDIMENTO.email, e.admin.email].sort());

    // Depois da espera e de falar com os dois, a DMS aprova: quem pediu vira a dona, e o Dono antigo sai.
    await ownerQuery(`update liame.ownership_claim set decide_from = now() - interval '1 minute' where id = $1`, [id]);
    await aprovarPropriedade(database.db, { protocolo: protocol, por: 'Rodrigo', motivo: 'Falei com os dois; o quadro de sócios mudou.' });
    const papeis = await ownerQuery<{ user_id: string; role_key: string; revoked: boolean }>(
      `select user_id, role_key, revoked_at is not null as revoked from liame.membership where tenant_id = $1 and user_id in ($2, $3) order by role_key`,
      [e.tenantId, e.dono.userId, e.admin.userId],
    );
    expect(papeis).toEqual([
      { user_id: e.dono.userId, role_key: 'administrador', revoked: true },
      { user_id: e.admin.userId, role_key: 'dono', revoked: false },
    ]);
    expect((await api.call('GET', '/v1/ownership', { cookie: e.admin.cookie })).body.owner.user_id).toBe(e.admin.userId);
    expect((await api.call('GET', '/v1/ownership', { cookie: e.dono.cookie })).status).not.toBe(200);
    desde = api.mailer.sent.length;
    await rotina.avisosLote(20, so(e.tenantId));
    expect(api.mailer.sent.slice(desde).map((m) => m.subject).sort()).toEqual(
      [`Liame: a propriedade da ${e.nome} passou para Ana Lima`, `Liame: agora a ${e.nome} é sua`].sort(),
    );
    await expect(aprovarPropriedade(database.db, { protocolo: protocol, por: 'Rodrigo', motivo: 'De novo, por engano.' })).rejects.toThrow('só se aprova o conferido');

    const acoes = await ownerQuery<{ action: string }>(`select action from liame.audit_event where tenant_id = $1 and resource_id = $2 order by chain_seq`, [e.tenantId, id]);
    expect(acoes.map((a) => a.action)).toEqual([
      'pessoas.propriedade_dms_comecar',
      'pessoas.propriedade_dms_documento',
      'pessoas.propriedade_dms_documento',
      'pessoas.propriedade_dms_enviar',
      'pessoas.propriedade_dms_conferir',
      'pessoas.propriedade_dms_contestar',
      'pessoas.propriedade_dms_aprovar',
    ]);
  });

  it('recusar com o motivo, desistir antes e depois da conferência, o rascunho esquecido e o expurgo', async () => {
    const e = await empresa('Recusa');
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`propriedade-pela-dms:${e.admin.userId}`]);
    // Desistir do rascunho: ele some.
    const rascunho = OwnershipClaimResponse.parse((await comecar(e.admin)).body).claim!;
    expect((await api.call('DELETE', `/v1/ownership/claims/${rascunho.id}`, { cookie: e.admin.cookie })).status).toBe(200);
    expect(await ownerQuery(`select 1 from liame.ownership_claim where id = $1`, [rascunho.id])).toEqual([]);
    // O rascunho esquecido sai em 2 dias.
    const esquecido = OwnershipClaimResponse.parse((await comecar(e.admin)).body).claim!;
    expect(await rotina.limparRascunhosLote(50, so(e.tenantId))).toBe(0);
    expect(await rotina.limparRascunhosLote(50, so(e.tenantId), new Date(Date.now() + 3 * DIA))).toBe(1);
    expect(await ownerQuery(`select 1 from liame.ownership_claim where id = $1`, [esquecido.id])).toEqual([]);

    // Recusar: o motivo que quem pediu lê.
    const recusado = await pedidoEnviado(e);
    await expect(recusarPropriedade(database.db, { protocolo: recusado.protocol, por: 'Rodrigo', motivo: 'x' })).rejects.toThrow('diga o motivo');
    await recusarPropriedade(database.db, { protocolo: recusado.protocol, por: 'Rodrigo', motivo: 'O contrato social não mostra a Ana como representante.' });
    expect((await ler(e.admin)).claim).toMatchObject({ id: recusado.id, status: 'recusado', refusal_reason: 'O contrato social não mostra a Ana como representante.' });
    let desde = api.mailer.sent.length;
    await rotina.avisosLote(20, so(e.tenantId));
    expect(api.mailer.sent.slice(desde).map((m) => m.to)).toEqual([e.admin.email]);

    // Desistir depois da conferência: o Dono, que tinha sido avisado, é avisado de novo.
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`propriedade-pela-dms:${e.admin.userId}`]);
    const desistido = await pedidoEnviado(e);
    await conferirPropriedade(database.db, { protocolo: desistido.protocol, por: 'Rodrigo', documento: true, empresa: true, socios: true, videochamada: true });
    await rotina.avisosLote(20, so(e.tenantId));
    const cancelado = await api.call('DELETE', `/v1/ownership/claims/${desistido.id}`, { cookie: e.admin.cookie });
    expect(OwnershipClaimResponse.parse(cancelado.body).claim).toMatchObject({ status: 'cancelado' });
    desde = api.mailer.sent.length;
    expect(await rotina.avisosLote(20, so(e.tenantId))).toEqual([desistido.id]);
    expect(api.mailer.sent.slice(desde).map((m) => m.to)).toEqual([e.dono.email]);

    // O expurgo: nada antes dos 30 dias; depois, os documentos dos dois pedidos decididos saem.
    expect(await rotina.expurgarLote(50, so(e.tenantId))).toBe(0);
    expect(await rotina.expurgarLote(50, so(e.tenantId), new Date(Date.now() + 31 * DIA))).toBe(4);
  });

  it('as restrições do banco (V119): cada check recusa o valor errado, pelo nome; um pedido por empresa e um documento de cada', async () => {
    const e = await empresa('Restricoes');
    const id = '0e000000-0000-4000-8000-000000000107';
    await ownerQuery(`delete from liame.ownership_claim where id = $1`, [id]);
    await ownerQuery(
      `insert into liame.ownership_claim (id, tenant_id, requester_user_id, protocol, reason, terms_version) values ($1, $2, $3, 'PROP-2026-9107', 'faleceu', $4)`,
      [id, e.tenantId, e.admin.userId, TERMOS],
    );
    const restricao = async (texto: string, params: unknown[] = []): Promise<string | undefined> => {
      try {
        await ownerQuery(texto, params);
        return undefined;
      } catch (err) {
        return (err as { constraint?: string }).constraint;
      }
    };
    const mudar = (set: string) => restricao(`update liame.ownership_claim set ${set} where id = $1`, [id]);
    expect(await mudar(`protocol = 'PROP-26-1'`)).toBe('ownership_claim_protocol_check');
    expect(await mudar(`reason = 'sumiu'`)).toBe('ownership_claim_reason_check');
    expect(await mudar(`note = ''`)).toBe('ownership_claim_note_check');
    expect(await mudar(`terms_version = ''`)).toBe('ownership_claim_terms_version_check');
    expect(await mudar(`status = 'perdido', sent_at = now()`)).toBe('ownership_claim_status_check');
    expect(await mudar(`documents = array['selfie']`)).toBe('ownership_claim_documents_check');
    expect(await mudar(`checked_by = 'R'`)).toBe('ownership_claim_checked_by_check');
    expect(await mudar(`checks = '[]'::jsonb`)).toBe('ownership_claim_checks_check');
    expect(await mudar(`notified_status = 'lido'`)).toBe('ownership_claim_notified_status_check');
    expect(await mudar(`status = 'pedido'`)).toBe('ownership_claim_enviado');
    expect(await mudar(`status = 'aprovado', sent_at = now()`)).toBe('ownership_claim_fechado');
    expect(await mudar(`status = 'conferido', sent_at = now()`)).toBe('ownership_claim_espera');
    expect(await mudar(`status = 'recusado', sent_at = now(), closed_at = now()`)).toBe('ownership_claim_recusa');
    expect(await mudar(`status = 'recusado', sent_at = now(), closed_at = now(), refusal_reason = 'ab'`)).toBe('ownership_claim_refusal_reason_check');
    // O que vale passa: os dois documentos, e a espera com a data.
    expect(await mudar(`documents = array['documento_com_foto', 'documento_da_empresa']`)).toBeUndefined();
    expect(await mudar(`status = 'conferido', sent_at = now(), checked_at = now(), decide_from = now() + interval '14 days'`)).toBeUndefined();
    expect(
      await restricao(
        `insert into liame.ownership_claim (id, tenant_id, requester_user_id, protocol, reason, terms_version) values (gen_random_uuid(), $1, $2, 'PROP-2026-9108', 'faleceu', $3)`,
        [e.tenantId, e.admin.userId, TERMOS],
      ),
    ).toBe('uq_ownership_claim_aberto');

    const doc = (o: { kind?: string; tipo?: string; tamanho?: number; keyId?: string; iv?: number; tag?: number }) =>
      restricao(
        `insert into liame.ownership_claim_document (id, claim_id, kind, media_type, size_bytes, key_id, wrapped_key, iv, tag, ciphertext)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, '\\x00', $6, $7, '\\x00')`,
        [id, o.kind ?? 'documento_com_foto', o.tipo ?? 'image/png', o.tamanho ?? 10, o.keyId ?? 'ab12cd34ef56ab78', Buffer.alloc(o.iv ?? 12), Buffer.alloc(o.tag ?? 16)],
      );
    expect(await doc({})).toBeUndefined();
    expect(await doc({})).toBe('uq_ownership_claim_document_tipo');
    expect(await doc({ kind: 'selfie' })).toBe('ownership_claim_document_kind_check');
    expect(await doc({ kind: 'documento_da_empresa', tipo: 'image/gif' })).toBe('ownership_claim_document_media_type_check');
    expect(await doc({ kind: 'documento_da_empresa', tamanho: 0 })).toBe('ownership_claim_document_size_bytes_check');
    expect(await doc({ kind: 'documento_da_empresa', keyId: 'XYZ' })).toBe('ownership_claim_document_key_id_check');
    expect(await doc({ kind: 'documento_da_empresa', iv: 11 })).toBe('ownership_claim_document_iv_check');
    expect(await doc({ kind: 'documento_da_empresa', tag: 15 })).toBe('ownership_claim_document_tag_check');
    await ownerQuery(`delete from liame.ownership_claim where id = $1`, [id]);
  });
});
