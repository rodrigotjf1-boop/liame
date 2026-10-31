import { createDatabase, type Database, withSystem } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeAudit } from '../../src/audit/audit.js';
import { diaNoFuso, somarDias } from '../../src/cobranca/vida.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { Mailer, type MailMessage } from '../../src/mail/mailer.js';
import { ResumoDasPessoasService } from '../../src/worker/resumo-das-pessoas.service.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, signupAndLogin, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// O resumo da semana do que cada pessoa fez na conta, por e-mail ao Dono (A7, W8; ADR-017; migration 0097; D-A7-53).
// As ações saem das rotas de verdade (convidar e remover, que a auditoria grava) e, para os grupos que pedem telas
// longas de montar (aprovar, recusar, verba), da própria função que grava a auditoria. O relógio da rotina é a
// segunda-feira seguinte a hoje, às 9h em São Paulo: a semana do resumo é sempre a de hoje, em qualquer dia e hora que
// o teste rode (V166).

const SP = 'America/Sao_Paulo';
/** A segunda-feira seguinte a hoje (no calendário de São Paulo), à hora UTC dada. */
function proximaSegunda(horaUtc: string): Date {
  const hoje = diaNoFuso(new Date(), SP);
  const dow = new Date(`${hoje}T12:00:00Z`).getUTCDay() || 7;
  return new Date(`${somarDias(hoje, 8 - dow)}T${horaUtc}Z`);
}

class CarteiroDeTeste extends Mailer {
  readonly enviados: MailMessage[] = [];
  readonly falhar = new Set<string>();
  async send(m: MailMessage): Promise<void> {
    if (this.falhar.has(m.to)) {
      const erro = new Error('caixa cheia');
      erro.name = 'SesRecusou';
      throw erro;
    }
    this.enviados.push(m);
  }
}

type Empresa = { cookie: string; email: string; tenantId: string; userId: string };

describe.skipIf(!hasDb)('o resumo da semana do que cada pessoa fez, ao Dono (A7, W8; D-A7-53)', () => {
  let api: TestApi;
  let database: Database;
  let carteiro: CarteiroDeTeste;
  let rotina: ResumoDasPessoasService;

  beforeAll(async () => {
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 4, applicationName: 'liame-test' });
    carteiro = new CarteiroDeTeste();
    rotina = new ResumoDasPessoasService(database, api.app.get(FlagService), carteiro, api.app.get<AppConfig>(APP_CONFIG));
  }, 120_000);
  beforeEach(resetIpRateLimits);
  afterAll(async () => {
    await api?.close();
    await database?.close();
  });

  async function empresa(nome: string, { ligada = true } = {}): Promise<Empresa> {
    const s = await signupAndLogin(api, undefined, nome);
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const [u] = await ownerQuery<{ id: string }>(`select id from liame.app_user where email = $1`, [s.email]);
    await ownerQuery(`update liame.organization set timezone = $2 where id = $1`, [tenantId, SP]);
    if (ligada) await ligarFlagDaEmpresa(api, 'resumo_das_pessoas', tenantId, true);
    return { cookie: s.cookie, email: s.email as string, tenantId, userId: u!.id };
  }
  /** Convida, cria o login pelo convite e ativa o app; devolve a sessão, o id da pessoa e o do vínculo. */
  async function convidado(por: { cookie: string }, dono: Empresa, papel: string, nome: string) {
    const email = uniqueEmail(papel);
    const inv = await api.call('POST', '/v1/invitations', { cookie: por.cookie, body: { email, role: papel, approve_limit_micros: 100_000_000 } });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: nome, password: PASSWORD, terms_version: TERMOS } });
    expect(s.status).toBe(200);
    await enableMfa(api, s.cookie!);
    const [u] = await ownerQuery<{ id: string }>(`select id from liame.app_user where email = $1`, [email]);
    const pessoas = await api.call('GET', '/v1/people', { cookie: dono.cookie });
    const vinculo = pessoas.body.members.find((m: { email: string }) => m.email === email);
    return { email, cookie: s.cookie!, userId: u!.id, memberId: vinculo.id as string };
  }
  /** Grava na auditoria, pela função de sempre, ações de uma pessoa na empresa. */
  async function agiu(e: Empresa, quem: { userId: string; rotulo: string; papel: string }, acoes: string[]) {
    await withSystem(database.db, async (tx) => {
      for (const action of acoes) {
        await writeAudit(tx, { tenantId: e.tenantId, actorType: 'human', actorId: quem.userId, actorLabel: quem.rotulo, actorRole: quem.papel, action, origin: 'api' });
      }
    });
  }
  const entregas = (e: Empresa) =>
    ownerQuery<{ week_start: string; status: string; attempts: number; error: string | null }>(
      `select week_start::text as week_start, status, attempts, error from liame.people_digest where tenant_id = $1 order by created_at`,
      [e.tenantId],
    );
  const doDono = (e: Empresa, desde: number) => carteiro.enviados.slice(desde).filter((m) => m.to === e.email);

  it('na segunda, a partir das 8h, o Dono recebe o que o Administrador e o Gestor fizeram (o Gestor que saiu também), uma vez só', async () => {
    const e = await empresa('Casa Brasa Resumo');
    const adm = await convidado(e, e, 'administrador', 'Ana Lima');
    // O Dono convida também, e isso não entra: o resumo é do que os outros fizeram.
    // A Administradora convida o Gestor e, depois, tira o acesso dele: duas mudanças em Pessoas e acessos.
    const gestor = await convidado(adm, e, 'gestor', 'Carlos Souza');
    await agiu(e, { userId: adm.userId, rotulo: 'Ana Lima, Administrador', papel: 'administrador' }, ['acao.aprovar', 'acao.aprovar', 'peca.recusar', 'orcamento.definir', 'post.publicar']);
    await agiu(e, { userId: gestor.userId, rotulo: 'Carlos Souza, Gestor', papel: 'gestor' }, ['acao.aprovar', 'sessao.encerrar']);
    expect((await api.call('DELETE', `/v1/members/${gestor.memberId}`, { cookie: adm.cookie })).status).toBe(204);
    // O Dono também age, e nada disso aparece.
    await agiu(e, { userId: e.userId, rotulo: 'Pessoa de Teste, Dono', papel: 'dono' }, ['orcamento.definir', 'acao.aprovar']);

    // Antes das 8h da segunda, nada.
    expect((await rotina.executarLote(100, { tenantIds: [e.tenantId] }, proximaSegunda('10:59:00'))).map((r) => r.resultado)).toEqual(['cedo']);
    const antes = carteiro.enviados.length;
    const agora = proximaSegunda('12:00:00');
    expect((await rotina.executarLote(100, { tenantIds: [e.tenantId] }, agora)).map((r) => [r.enviados, r.resultado])).toEqual([[1, 'enviado']]);
    const [m] = doDono(e, antes);
    expect(carteiro.enviados.length).toBe(antes + 1);
    const segunda = diaNoFuso(agora, SP);
    const de = somarDias(segunda, -7), ate = somarDias(segunda, -1);
    const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
    expect(m!.subject).toBe(`Liame: o que cada pessoa fez na Casa Brasa Resumo (${ddmm(de)} a ${ddmm(ate)})`);
    expect(m!.text).toContain('Ana Lima (Administrador)\n- aprovou 2 pedidos e recusou 1;\n- mudou a verba 1 vez;\n- fez 2 mudanças em Pessoas e acessos;\n- e mais 1 ação.');
    expect(m!.text).toContain(`Carlos Souza (Gestor, sem acesso desde ${ddmm(diaNoFuso(new Date(), SP))})\n- aprovou 1 pedido.`);
    expect(m!.text).not.toContain('Pessoa de Teste');
    expect(m!.text).toContain('/pessoas');
    expect(await entregas(e)).toEqual([{ week_start: de, status: 'enviado', attempts: 1, error: null }]);

    // De novo, e na terça: nada em dobro.
    expect((await rotina.executarLote(100, { tenantIds: [e.tenantId] }, agora)).map((r) => r.resultado)).toEqual(['ja_mandado']);
    expect((await rotina.executarLote(100, { tenantIds: [e.tenantId] }, new Date(agora.getTime() + 86_400_000))).map((r) => r.resultado)).toEqual(['ja_mandado']);
    expect(carteiro.enviados.length).toBe(antes + 1);
  }, 120_000);

  it('a semana em que só o Dono mexeu fica marcada, sem e-mail', async () => {
    const e = await empresa('Casa Brasa Resumo Só Dono');
    await agiu(e, { userId: e.userId, rotulo: 'Pessoa de Teste, Dono', papel: 'dono' }, ['orcamento.definir']);
    const antes = carteiro.enviados.length;
    const agora = proximaSegunda('12:00:00');
    expect((await rotina.executarLote(100, { tenantIds: [e.tenantId] }, agora)).map((r) => r.resultado)).toEqual(['sem_atividade']);
    expect(await entregas(e)).toEqual([{ week_start: somarDias(diaNoFuso(agora, SP), -7), status: 'sem_atividade', attempts: 1, error: null }]);
    expect((await rotina.executarLote(100, { tenantIds: [e.tenantId] }, agora)).map((r) => r.resultado)).toEqual(['ja_mandado']);
    expect(carteiro.enviados.length).toBe(antes);
  });

  it('a falha do envio tenta de novo; a função desligada segura o resumo', async () => {
    const e = await empresa('Casa Brasa Resumo Falha');
    const adm = await convidado(e, e, 'administrador', 'Ana Lima');
    await agiu(e, { userId: adm.userId, rotulo: 'Ana Lima, Administrador', papel: 'administrador' }, ['parada.acionar']);
    const agora = proximaSegunda('12:00:00');

    await ligarFlagDaEmpresa(api, 'resumo_das_pessoas', e.tenantId, false);
    expect((await rotina.executarLote(100, { tenantIds: [e.tenantId] }, agora)).map((r) => r.resultado)).toEqual(['desligada']);
    expect(await entregas(e)).toEqual([]);
    await ligarFlagDaEmpresa(api, 'resumo_das_pessoas', e.tenantId, true);

    carteiro.falhar.add(e.email);
    expect((await rotina.executarLote(100, { tenantIds: [e.tenantId] }, agora)).map((r) => [r.falhas, r.resultado])).toEqual([[1, 'enviado']]);
    expect((await entregas(e)).map((x) => [x.status, x.attempts, x.error])).toEqual([['falhou', 1, 'SesRecusou']]);
    carteiro.falhar.delete(e.email);
    const antes = carteiro.enviados.length;
    expect((await rotina.executarLote(100, { tenantIds: [e.tenantId] }, agora)).map((r) => [r.enviados, r.resultado])).toEqual([[1, 'enviado']]);
    expect(doDono(e, antes)[0]!.text).toContain('Ana Lima (Administrador)\n- mexeu na parada de emergência 1 vez.');
    expect((await entregas(e)).map((x) => [x.status, x.attempts, x.error])).toEqual([['enviado', 2, null]]);
  }, 120_000);

  it('V119: a tabela das entregas recusa a semana que não começa na segunda, a situação fora da lista e a entrega repetida', async () => {
    const e = await empresa('Casa Brasa Resumo Regra', { ligada: false });
    const inserir = (dia: string, status = 'enviando') =>
      ownerQuery(
        `insert into liame.people_digest (id, tenant_id, week_start, user_id, status, attempts, claimed_at) values (gen_random_uuid(), $1, $2::date, $3, $4, 1, now())`,
        [e.tenantId, dia, e.userId, status],
      );
    await expect(inserir('2026-10-26')).resolves.toBeDefined();
    await expect(inserir('2026-10-27')).rejects.toThrow(/people_digest_segunda/);
    await expect(inserir('2026-11-02', 'lido')).rejects.toThrow(/people_digest_status_check/);
    await expect(inserir('2026-10-26')).rejects.toThrow(/people_digest_uma_vez/);
  });
});
