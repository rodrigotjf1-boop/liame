import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { LegalTermsResponse, MyTermsResponse } from '@liame/contracts';
import { createDatabase, runMigrations } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { declararVersao, type DeclaracaoDeVersao, retirarVersao } from '../../src/auth/termos/distribuicao.js';
import { TermosService } from '../../src/auth/termos/termos.service.js';
import { diaEmBrasilia } from '../../src/auth/termos/versoes.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, type TestApi, TERMOS, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { apagarVersoes, flagDosTermos, versaoDeTeste } from '../helpers/termos.js';
import { hasDb, OWNER_URL } from './env.js';

// Os Termos novos (A7, W14, parte 14a; P35; D-A7-88 a D-A7-95, D-A7-97 a D-A7-100): com a função desligada, nada muda;
// ligada, a versão que vem, o aceite antes do dia (pelo aviso) e no dia (pela tela do aceite), o cadastro e o convite no
// meio do aviso, a versão vigente nas trocas de dono, e o lado da distribuição (declarar, com a impressão digital e os 30
// dias, e retirar). As versões valem para o banco de teste inteiro: a função liga só para as pessoas do teste, e o
// ambiente só com uma versão que ainda não vale (ver `helpers/termos.ts`).

const CHROME_WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

describe.skipIf(!hasDb)('os Termos novos', () => {
  let api: TestApi;
  const criadas: string[] = [];
  const versao = async (daqui: number, o: { kind?: 'relevante' | 'redacao' } = {}) => {
    const v = await versaoDeTeste(daqui, o);
    criadas.push(v);
    return v;
  };
  const chamar = (metodo: string, caminho: string, cookie: string, body?: unknown) =>
    api.call(metodo, caminho, { cookie, body, headers: { 'user-agent': CHROME_WINDOWS } });
  const meus = async (cookie: string) => MyTermsResponse.parse((await chamar('GET', '/v1/me/terms', cookie)).body);

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
  });
  afterAll(async () => {
    await apagarVersoes(criadas);
    if (api) await flagDosTermos(api, { tipo: 'environment' }, null);
    await api?.close();
  });
  beforeEach(resetIpRateLimits);

  it('desligada: a rota pública não diz a versão que vem, a pessoa vê só a do ambiente, e aceitar recusa', async () => {
    const vem = await versao(40);
    const s = await signupAndLogin(api, undefined, 'Empresa Termos Desligados');
    const publico = LegalTermsResponse.parse((await api.call('GET', '/v1/legal/terms')).body);
    expect(publico.version).toBe(TERMOS);
    // Outro arquivo pode ligar o ambiente com uma versão a caminho; esta, desligada para a pessoa, não aparece para ela.
    await flagDosTermos(api, { tipo: 'user', id: s.me.user.id }, false);
    const eu = await meus(s.cookie);
    expect(eu).toMatchObject({ enabled: false, current: { version: TERMOS }, next: null, required: null, history: [] });
    const r = await chamar('POST', '/v1/me/terms/accept', s.cookie, { version: vem });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('funcao-desligada');
  });

  it('a versão que vem: a pessoa vê o que muda, aceita antes do dia pelo aviso, uma vez só, com a auditoria; outra versão recusa', async () => {
    const vem = await versao(35);
    const s = await signupAndLogin(api, undefined, 'Empresa Termos Antes do Dia');
    await flagDosTermos(api, { tipo: 'user', id: s.me.user.id }, true);
    const antes = await meus(s.cookie);
    expect(antes.enabled).toBe(true);
    expect(antes.next?.version).toBe(vem);
    expect(antes.next?.changes[0]).toMatchObject({ document: 'termos', section: '4', title: 'Agências parceiras' });
    expect(antes.next_accepted_at).toBeNull();
    expect(antes.required).toBeNull();
    expect(antes.history.map((h) => h.version)).toContain(vem);

    const outra = await chamar('POST', '/v1/me/terms/accept', s.cookie, { version: '2001-01-01' });
    expect(outra.status).toBe(409);
    expect(outra.body.code).toBe('versao-sem-aceite');

    const aceitou = await chamar('POST', '/v1/me/terms/accept', s.cookie, { version: vem });
    expect(aceitou.status, JSON.stringify(aceitou.body)).toBe(200);
    const depois = MyTermsResponse.parse(aceitou.body);
    expect(depois.next_accepted_at).not.toBeNull();
    expect(depois.accepted).toMatchObject({ version: vem, via: 'aviso' });
    expect((await chamar('POST', '/v1/me/terms/accept', s.cookie, { version: vem })).status).toBe(200);
    const linhas = await ownerQuery<{ via: string; device: string }>(`select via, device from liame.terms_acceptance where user_id = $1`, [s.me.user.id]);
    expect(linhas).toEqual([{ via: 'aviso', device: 'Chrome no Windows' }]);
    const eventos = await ownerQuery<{ after: { versao: string; onde: string; ja_aceita?: boolean } }>(
      `select after from liame.audit_event where action = 'termos.aceitar' and resource_id = $1 and actor_id = $2 order by occurred_at`,
      [vem, s.me.user.id],
    );
    expect(eventos.map((e) => e.after)).toEqual([{ versao: vem, onde: 'aviso' }, { versao: vem, onde: 'aviso', ja_aceita: true }]);
  });

  it('no dia: a versão que vale pede o aceite (a tela do dia); a vigente muda para a pessoa e para as trocas de dono; o aceite tira a pendência', async () => {
    const vale = await versao(-3);
    const s = await signupAndLogin(api, undefined, 'Empresa Termos No Dia');
    const termos = api.app.get(TermosService);
    // Desligada para a pessoa, a versão do ambiente.
    expect((await termos.vigente({ userId: s.me.user.id })).version).toBe(TERMOS);
    await flagDosTermos(api, { tipo: 'user', id: s.me.user.id }, true);
    expect((await termos.vigente({ userId: s.me.user.id })).version).toBe(vale);
    expect((await termos.vigente({ userId: s.me.user.id })).termsUrl).toBe(`https://agencialiame.com/termos/${vale}`);

    const antes = await meus(s.cookie);
    expect(antes.current.version).toBe(vale);
    expect(antes.required?.version).toBe(vale);
    expect(antes.required?.effective_on).toBe(diaEmBrasilia(new Date(Date.now() - 3 * 86_400_000)));

    const aceitou = MyTermsResponse.parse((await chamar('POST', '/v1/me/terms/accept', s.cookie, { version: vale })).body);
    expect(aceitou.required).toBeNull();
    expect(aceitou.accepted).toMatchObject({ version: vale, via: 'tela_do_dia' });
  });

  it('um ajuste de redação vale na hora, sem pedir aceite, e muda só o endereço do documento que ele muda', async () => {
    const ajuste = await versao(-1, { kind: 'redacao' });
    const s = await signupAndLogin(api, undefined, 'Empresa Termos Redação');
    await flagDosTermos(api, { tipo: 'user', id: s.me.user.id }, true);
    const eu = await meus(s.cookie);
    expect(eu.current.version).toBe(ajuste);
    expect(eu.required?.version ?? null).not.toBe(ajuste);
    expect(eu.history.find((h) => h.version === ajuste)).toMatchObject({ kind: 'redacao', reason: 'Ajuste de redação de teste.' });
    expect((await chamar('POST', '/v1/me/terms/accept', s.cookie, { version: ajuste })).body.code).toBe('versao-sem-aceite');
    await apagarVersoes([ajuste]);
  });

  it('a trava do dia (14b): quem não aceitou só lê e aceita, troca de empresa, e o Dono vê a cobrança e exporta; o resto, 403; o aceite destrava', async () => {
    const vale = await versao(-2);
    const s = await signupAndLogin(api, undefined, 'Empresa Termos Trava');
    await enableMfa(api, s.cookie);
    // Desligada para a pessoa (a regra dela), a versão pendente não trava nada.
    await flagDosTermos(api, { tipo: 'user', id: s.me.user.id }, false);
    expect((await chamar('GET', '/v1/brands', s.cookie)).status).toBe(200);

    await flagDosTermos(api, { tipo: 'user', id: s.me.user.id }, true);
    const travada = await chamar('GET', '/v1/brands', s.cookie);
    expect(travada.status).toBe(403);
    expect(travada.body.code).toBe('aceite-os-termos');
    expect((await chamar('POST', '/v1/brands', s.cookie, { name: 'Outra marca' })).body.code).toBe('aceite-os-termos');
    // Liberadas: quem sou, os Termos, a cobrança, exportar.
    for (const [metodo, caminho] of [['GET', '/v1/me'], ['GET', '/v1/me/terms'], ['GET', '/v1/billing'], ['GET', '/v1/billing/contacts'], ['GET', '/v1/export']] as const) {
      const r = await chamar(metodo, caminho, s.cookie);
      expect(r.body?.code, `${metodo} ${caminho}`).not.toBe('aceite-os-termos');
    }
    expect((await meus(s.cookie)).required?.version).toBe(vale);

    expect((await chamar('POST', '/v1/me/terms/accept', s.cookie, { version: vale })).status).toBe(200);
    expect((await chamar('GET', '/v1/brands', s.cookie)).status).toBe(200);
    await apagarVersoes([vale]);
  });

  it('o cadastro e o convite no meio do aviso aceitam as duas versões; a que vem errada recusa; sem ela, só a de hoje', async () => {
    // Antes de ligar o ambiente, só versões que ainda não valem: a vigente dos outros arquivos continua a do ambiente.
    await apagarVersoes(criadas.splice(0));
    const vem = await versao(45);
    await flagDosTermos(api, { tipo: 'environment' }, true);
    try {
      const publico = LegalTermsResponse.parse((await api.call('GET', '/v1/legal/terms')).body);
      expect(publico.version).toBe(TERMOS);
      expect(publico.next?.version).toBe(vem);

      const corpo = (email: string) => ({ name: 'Marina', email, password: PASSWORD, company: { name: 'Cantina da Marina' }, terms_version: TERMOS });
      const errada = await api.call('POST', '/v1/auth/signup', { body: { ...corpo(uniqueEmail('termos')), next_terms_version: '2001-01-01' } });
      expect(errada.status).toBe(409);
      expect(errada.body.code).toBe('termos-desatualizados');

      const comAsDuas = uniqueEmail('termos');
      const r = await api.call('POST', '/v1/auth/signup', { body: { ...corpo(comAsDuas), next_terms_version: vem }, headers: { 'user-agent': CHROME_WINDOWS } });
      expect(r.status).toBe(202);
      expect(
        await ownerQuery(`select a.version, a.via from liame.terms_acceptance a join liame.app_user u on u.id = a.user_id where u.email = $1`, [comAsDuas]),
      ).toEqual([{ version: vem, via: 'cadastro' }]);

      const soHoje = uniqueEmail('termos');
      expect((await api.call('POST', '/v1/auth/signup', { body: corpo(soHoje) })).status).toBe(202);
      expect(await ownerQuery(`select 1 from liame.terms_acceptance a join liame.app_user u on u.id = a.user_id where u.email = $1`, [soHoje])).toEqual([]);

      // O convite: quem cria o login pelo convite aceita as duas também.
      const dono = await signupAndLogin(api, undefined, 'Empresa Termos Convite');
      await enableMfa(api, dono.cookie);
      const convidado = uniqueEmail('termos-convite');
      expect((await api.call('POST', '/v1/invitations', { cookie: dono.cookie, body: { email: convidado, role: 'somente_leitura' } })).status).toBe(201);
      const pelo = await api.call('POST', '/v1/invitations/signup', {
        body: { token: tokenFrom(api.mailer, convidado), name: 'Caio', password: PASSWORD, terms_version: TERMOS, next_terms_version: vem },
      });
      expect(pelo.status, JSON.stringify(pelo.body)).toBe(200);
      expect(
        await ownerQuery(`select a.version, a.via from liame.terms_acceptance a join liame.app_user u on u.id = a.user_id where u.email = $1`, [convidado]),
      ).toEqual([{ version: vem, via: 'convite' }]);
    } finally {
      await flagDosTermos(api, { tipo: 'environment' }, null);
    }
  });

  it('a distribuição declara (o texto baixado vira a impressão digital; 30 dias de aviso; uma relevante esperando por vez) e retira', async () => {
    const texto = `Termos de Uso do Liame — versão de teste. ${'Cláusula de teste. '.repeat(20)}`;
    const baixar = async (url: string) => (url.includes('curto') ? 'pouco' : texto);
    await apagarVersoes(criadas.splice(0));
    // Como o comando: o papel dono do banco (o aplicativo só lê as versões).
    const dono = createDatabase({ connectionString: OWNER_URL, max: 1, applicationName: 'liame-test-termos' });
    const db = dono.db;
    const dia = (dias: number) => diaEmBrasilia(new Date(Date.now() + dias * 86_400_000));
    const nome = (dias: number) => `${dia(dias)}-d${Math.random().toString(36).slice(2, 8)}`;
    const relevante = (v: string, valeEm: string, url = `https://agencialiame.com/termos/${v}`): DeclaracaoDeVersao => ({
      versao: v,
      tipo: 'relevante',
      vale_em: valeEm,
      documentos: [{ documento: 'termos', url }],
      mudancas: [{ documento: 'termos', secao: '4', titulo: 'Agências parceiras', hoje: 'Só as pessoas da empresa.', fica: 'A agência aceita pelo Dono.' }],
      motivo: null,
    });
    try {
      const cedo = nome(10);
      await expect(declararVersao(db, relevante(cedo, dia(10)), { por: 'Teste', baixar })).rejects.toThrow(/no mínimo 30 dias/);
      const curto = nome(40);
      await expect(declararVersao(db, relevante(curto, dia(40), 'https://agencialiame.com/curto'), { por: 'Teste', baixar })).rejects.toThrow(/curto demais/);

      const v = nome(40);
      criadas.push(v);
      await expect(declararVersao(db, relevante(v, dia(40)), { por: 'Teste', baixar })).resolves.toEqual({ effectiveOn: dia(40) });
      const [linha] = await ownerQuery<{ documents: { sha256: string }[]; created_by: string }>(`select documents, created_by from liame.terms_version where version = $1`, [v]);
      expect(linha?.documents[0]?.sha256).toBe(createHash('sha256').update(texto, 'utf8').digest('hex'));
      expect(linha?.created_by).toBe('Teste');

      const outra = nome(50);
      await expect(declararVersao(db, relevante(outra, dia(50)), { por: 'Teste', baixar })).rejects.toThrow(/ainda espera o dia/);
      await expect(declararVersao(db, relevante(v, dia(40)), { por: 'Teste', baixar })).rejects.toThrow();

      await retirarVersao(db, { versao: v, por: 'Teste', motivo: 'O advogado pediu outra redação.' });
      await expect(retirarVersao(db, { versao: v, por: 'Teste', motivo: 'De novo.' })).rejects.toThrow(/já foi retirada/);
      const auditoria = await ownerQuery<{ action: string }>(`select action from liame.audit_event where resource_type = 'terms_version' and resource_id = $1 order by occurred_at`, [v]);
      expect(auditoria.map((a) => a.action)).toEqual(['termos.declarar', 'termos.retirar']);
    } finally {
      await dono.close();
    }
  });

  it('o banco recusa a versão relevante sem os 30 dias, sem o que muda, e o ajuste de redação sem o motivo', async () => {
    const tentar = async (sql: string) => {
      try {
        await ownerQuery(sql);
        return 'gravou';
      } catch (e) {
        return String((e as { constraint?: string }).constraint ?? e);
      }
    };
    const docs = `'[{"document":"termos","url":"https://agencialiame.com/termos","sha256":"${'b'.repeat(64)}"}]'::jsonb`;
    expect(
      await tentar(`insert into liame.terms_version (version, kind, effective_at, documents, changes, created_by)
                    values ('2099-01-01-x1', 'relevante', now() + interval '10 days', ${docs}, '[{"document":"termos"}]'::jsonb, 'testes')`),
    ).toBe('terms_version_aviso');
    expect(
      await tentar(`insert into liame.terms_version (version, kind, effective_at, documents, changes, created_by)
                    values ('2099-01-01-x2', 'relevante', now() + interval '40 days', ${docs}, '[]'::jsonb, 'testes')`),
    ).toBe('terms_version_mudancas');
    expect(
      await tentar(`insert into liame.terms_version (version, kind, effective_at, documents, created_by)
                    values ('2099-01-01-x3', 'redacao', now(), ${docs}, 'testes')`),
    ).toBe('terms_version_motivo');
  });
});
