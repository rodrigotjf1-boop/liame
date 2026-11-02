import { randomBytes } from 'node:crypto';
import type {
  CreatePasskeyRequest,
  CreatePasskeyResponse,
  Passkey,
  PasskeyAssertion,
  PasskeyCeremony,
  PasskeyRegistrationOptionsRequest,
  PasskeysResponse,
} from '@liame/contracts';
import { type Database, type Tx, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config.js';
import { DATABASE } from '../../database/database.module.js';
import { FlagService } from '../../flags/flag.service.js';
import { afterCommit, auditDetail, type AuthContext, currentTx } from '../../context/request-context.js';
import { AppProblem } from '../../errors/problems.js';
import { Mailer } from '../../mail/mailer.js';
import { descreverAparelho } from '../aparelho.js';
import { MfaService } from '../mfa.service.js';
import { RateLimitService } from '../rate-limit.service.js';
import { cairPorqueEntrou } from '../recuperacao/recuperacao.service.js';
import { hashRecoveryCode, newRecoveryCodes } from '../totp.js';
import { AAGUID_ZERO, nomeDoGerenciador } from './gerenciadores.js';

// As chaves de acesso (passkeys, WebAuthn; A7, W9, parte 9a; ADR-013; P28; D-A7-54 a D-A7-58; D-A7-87; base §17.7). Roda
// na transação da requisição, no contexto da pessoa (a RLS limita às chaves dela). Cadastrar pede antes a confirmação
// (o código do app ou uma chave que a pessoa já tem); a primeira chave de quem não tem segundo fator entra sem
// confirmar, como quem ativa o app, e, sem o app, traz os 10 códigos de recuperação. A chave vale pelo código do app na
// entrada; na parte 9b, também pela senha (entrar sem senha: o desafio sem dono, no escopo de sistema). Cada cerimônia
// tem um desafio de uso único, que vence em 5 minutos; o aparelho precisa confirmar a pessoa (digital, rosto ou PIN:
// `userVerification: required`).

/**
 * A flag que segura o cadastro e a entrada sem senha (A7, W9, parte 9d; D-A7-87, item 13): desligada até o texto da
 * Política sobre as chaves. O que já existe continua valendo (o segundo fator, as confirmações, renomear e tirar).
 */
export const FLAG_CHAVES = 'chaves_de_acesso';

const desligada = () =>
  new AppProblem(409, 'funcao-desligada', 'As chaves de acesso ainda não estão ligadas', 'Em breve. Por enquanto, entre e confirme com o app autenticador.');

/** Até 10 chaves por pessoa (D-A7-54). */
export const MAX_CHAVES = 10;
const MINUTOS_DO_DESAFIO = 5;
/** ES256 e RS256: os que os gerenciadores de hoje usam (base §17.7). */
const ALGORITMOS = [-7, -257];

type Proposito = 'cadastrar' | 'confirmar' | 'segundo_fator' | 'entrar';

/** O que a entrada sem senha achou: a chave que não existe mais, a recusada (com a pessoa, para a auditoria) ou a pessoa. */
export type EntradaComChave =
  | { kind: 'desconhecida' }
  | { kind: 'recusada'; userId: string }
  | { kind: 'ok'; userId: string; email: string; emailVerificado: boolean; chave: string };

type LinhaDaChave = {
  id: string;
  credential_id: string;
  public_key: Buffer;
  counter: string | number;
  transports: string[] | string;
  device_type: 'singleDevice' | 'multiDevice';
  name: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
  last_used_where: string | null;
};

const iso = (v: Date | string | null): string | null => (v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString());
const lista = (v: string[] | string): string[] => (Array.isArray(v) ? v : v.replace(/^\{|\}$/g, '').split(',').filter(Boolean));

function paraResposta(c: LinhaDaChave): Passkey {
  return {
    id: c.id,
    name: c.name,
    synced: c.device_type === 'multiDevice',
    created_at: iso(c.created_at)!,
    last_used_at: iso(c.last_used_at),
    last_used_where: c.last_used_where,
  };
}

const SELECAO = sql`
  select id, credential_id, public_key, counter, transports, device_type, name, created_at, last_used_at, last_used_where
    from liame.passkey`;

const recusada = () => new AppProblem(400, 'chave-recusada', 'A chave não foi aceita', 'O aparelho não confirmou a chave. Tente de novo.');
const desafioVencido = () =>
  new AppProblem(400, 'desafio-vencido', 'Tempo esgotado', 'A janela do aparelho ficou aberta tempo demais, ou já foi usada. Comece de novo.');

@Injectable()
export class ChavesService {
  constructor(
    private readonly mfa: MfaService,
    private readonly rateLimit: RateLimitService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly modulos: ModuleRef,
  ) {}

  /**
   * A flag das chaves para a pessoa (e a empresa ativa), ou só para o ambiente (a entrada, quando ninguém entrou ainda).
   * O FlagService mora no módulo da aplicação (como na guarda de acesso, pelo ModuleRef).
   */
  private async ligada(quem: { tenantId?: string | null; userId?: string | null }): Promise<boolean> {
    const flags = this.modulos.get(FlagService, { strict: false });
    return flags.isEnabled(FLAG_CHAVES, flags.context(quem));
  }

  private get db() {
    if (!this.database) throw new Error('chaves de acesso sem banco');
    return this.database.db;
  }

  /** As chaves da pessoa, o máximo e se ela tem o app. */
  async listar(auth: AuthContext): Promise<PasskeysResponse> {
    const tx = currentTx();
    const chaves = await this.daPessoa(tx, auth.userId);
    return {
      items: chaves.map(paraResposta),
      max: MAX_CHAVES,
      has_totp: await this.temApp(tx, auth.userId),
      can_create: await this.ligada({ tenantId: auth.tenantId, userId: auth.userId }),
    };
  }

  /** As opções para confirmar com uma chave que a pessoa já tem (antes de cadastrar outra, ou de aprovar). */
  async opcoesDeConfirmacao(auth: AuthContext): Promise<PasskeyCeremony> {
    return this.opcoesDeUso(currentTx(), auth.userId, 'confirmar');
  }

  /** As opções do segundo fator na entrada: a sessão da senha confirma com uma chave da pessoa. */
  async opcoesDoSegundoFator(auth: AuthContext): Promise<PasskeyCeremony> {
    if (auth.mfaVerifiedAt) throw new AppProblem(409, 'ja-entrou', 'Você já entrou', 'Esta sessão já passou pelo segundo fator.');
    return this.opcoesDeUso(currentTx(), auth.userId, 'segundo_fator');
  }

  /** O segundo fator com a chave: a sessão fica verificada, como com o código do app. */
  async verificarSegundoFator(auth: AuthContext, body: PasskeyAssertion, userAgent: string | undefined): Promise<void> {
    await this.rateLimit.consume(`segundo-fator:${auth.userId}`, 10, 900);
    const tx = currentTx();
    if (auth.mfaVerifiedAt) throw new AppProblem(409, 'ja-entrou', 'Você já entrou', 'Esta sessão já passou pelo segundo fator.');
    const nome = await this.conferirUso(tx, auth.userId, body, 'segundo_fator', userAgent);
    await tx.execute(sql`update liame.session set mfa_verified_at = now(), mfa_method = 'chave' where id = ${auth.sessionId}`);
    const caiu = await cairPorqueEntrou(tx, auth.userId);
    auditDetail({ after: { metodo: 'chave', chave: nome, ...(caiu ? { recuperacao_cancelada: caiu } : {}) } });
    if (caiu) {
      this.avisar(
        auth.email,
        `Liame: pedido de recuperação cancelado (${caiu})`,
        `Você entrou com uma chave de acesso, e o pedido de recuperação ${caiu} foi cancelado sozinho. Nada mudou na sua conta. Se não foi você quem entrou, troque a senha agora.`,
      );
    }
  }

  /**
   * Confirma com uma chave da pessoa (o "step-up" sem o código do app), para cadastrar outra e, na parte 9b, para aprovar.
   * Devolve o nome da chave usada.
   */
  async confirmarComChave(tx: Tx, userId: string, body: PasskeyAssertion, userAgent?: string): Promise<string> {
    await this.rateLimit.consume(`segundo-fator:${userId}`, 10, 900);
    return this.conferirUso(tx, userId, body, 'confirmar', userAgent);
  }

  /**
   * As opções da entrada sem senha (A7, W9, parte 9b; D-A7-55): sem dizer quais chaves existem; a chave que o aparelho
   * escolher diz quem é. O desafio não tem dono (propósito `entrar`) e fica no escopo de sistema; os vencidos ou usados
   * da entrada saem aqui, porque não têm uma pessoa para limpá-los no pedido seguinte dela.
   */
  async opcoesDaEntrada(ip: string | null): Promise<PasskeyCeremony> {
    // Ninguém entrou ainda: vale a regra do ambiente (para todos). Desligada, nem gasta o limite do IP.
    if (!(await this.ligada({}))) throw desligada();
    await this.rateLimit.consume(`entrar-chave:ip:${ip ?? '-'}`, 30, 900);
    const options = await generateAuthenticationOptions({ rpID: this.config.passkeys.rpId, userVerification: 'required' });
    const id = uuidv7();
    await withSystem(this.db, async (tx) => {
      await tx.execute(sql`delete from liame.webauthn_challenge where user_id is null and (expires_at < now() or used_at is not null)`);
      await tx.execute(sql`
        insert into liame.webauthn_challenge (id, user_id, purpose, challenge, expires_at)
        values (${id}, null, 'entrar', ${options.challenge}, now() + make_interval(mins => ${MINUTOS_DO_DESAFIO}))`);
    });
    return { challenge_id: id, options: options as unknown as Record<string, unknown> };
  }

  /**
   * Confere a entrada sem senha na transação de sistema de quem chama (ainda não se sabe quem é): o desafio da entrada, a
   * chave pelo id que o aparelho mandou e a pessoa pelo identificador que a chave guarda (`userHandle`). A chave que não
   * existe mais devolve `desconhecida`; a assinatura que não confere, o identificador de outra pessoa ou a pessoa
   * desativada devolvem `recusada` com a pessoa, para a falha ficar na auditoria dela.
   */
  async conferirEntrada(tx: Tx, body: PasskeyAssertion, userAgent: string | null): Promise<EntradaComChave> {
    const desafio = await this.consumirDesafio(null, body.challenge_id, 'entrar');
    const credencial = typeof body.response.id === 'string' ? body.response.id : '';
    const r = await tx.execute<LinhaDaChave & { user_id: string; email: string; email_verified_at: string | null; disabled_at: string | null; webauthn_user_id: string | null }>(sql`
      select k.id, k.credential_id, k.public_key, k.counter, k.transports, k.device_type, k.name, k.created_at, k.last_used_at, k.last_used_where,
             k.user_id, u.email, u.email_verified_at, u.disabled_at, u.webauthn_user_id
        from liame.passkey k join liame.app_user u on u.id = k.user_id
       where k.credential_id = ${credencial}
         for update of k`);
    const chave = r.rows[0];
    if (!chave) return { kind: 'desconhecida' };
    const resposta = body.response.response as { userHandle?: unknown } | undefined;
    if (!chave.webauthn_user_id || resposta?.userHandle !== chave.webauthn_user_id) return { kind: 'recusada', userId: chave.user_id };
    const v = await this.verificarAssinatura(chave, body, desafio);
    if (!v || chave.disabled_at) return { kind: 'recusada', userId: chave.user_id };
    await this.gravarUso(tx, chave.id, v, userAgent);
    return { kind: 'ok', userId: chave.user_id, email: chave.email, emailVerificado: chave.email_verified_at !== null, chave: chave.name };
  }

  /** As opções para cadastrar: antes, a pessoa confirma que é ela (o código do app ou uma chave), se já tem segundo fator. */
  async opcoesDeCadastro(auth: AuthContext, body: PasskeyRegistrationOptionsRequest, userAgent?: string): Promise<PasskeyCeremony> {
    if (!(await this.ligada({ tenantId: auth.tenantId, userId: auth.userId }))) throw desligada();
    const tx = currentTx();
    await tx.execute(sql`select id from liame.app_user where id = ${auth.userId} for update`);
    const chaves = await this.daPessoa(tx, auth.userId);
    if (chaves.length >= MAX_CHAVES) throw new AppProblem(409, 'limite-de-chaves', 'Limite de chaves', `Cada pessoa tem até ${MAX_CHAVES} chaves. Tire uma antes.`);
    const temApp = await this.temApp(tx, auth.userId);
    if (temApp || chaves.length) {
      if (body.code) {
        if (!temApp) throw new AppProblem(400, 'sem-app', 'Sem app autenticador', 'Confirme com uma das suas chaves de acesso.');
        await this.mfa.verifyStepUp(tx, auth.userId, body.code);
      } else if (body.passkey) {
        await this.confirmarComChave(tx, auth.userId, body.passkey, userAgent);
      } else {
        throw new AppProblem(400, 'confirme-que-e-voce', 'Confirme que é você', 'Digite o código do app autenticador ou use uma chave que você já tem.');
      }
    }
    const userId = await this.handleDaPessoa(tx, auth.userId);
    const options = await generateRegistrationOptions({
      rpName: this.config.passkeys.rpName,
      rpID: this.config.passkeys.rpId,
      userName: auth.email,
      userDisplayName: auth.name,
      userID: isoBase64URL.toBuffer(userId),
      attestationType: 'none',
      excludeCredentials: chaves.map((c) => ({ id: c.credential_id, transports: lista(c.transports) })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      supportedAlgorithmIDs: ALGORITMOS,
    });
    const challengeId = await this.guardarDesafio(tx, auth.userId, 'cadastrar', options.challenge);
    return { challenge_id: challengeId, options: options as unknown as Record<string, unknown> };
  }

  /** Cadastra a chave que o aparelho criou. A primeira, sem o app, traz os 10 códigos de recuperação (D-A7-57). */
  async cadastrar(auth: AuthContext, body: CreatePasskeyRequest, userAgent: string | undefined): Promise<CreatePasskeyResponse> {
    await this.rateLimit.consume(`chave-cadastrar:${auth.userId}`, 10, 3600);
    const tx = currentTx();
    await tx.execute(sql`select id from liame.app_user where id = ${auth.userId} for update`);
    const desafio = await this.consumirDesafio(auth.userId, body.challenge_id, 'cadastrar');
    let v;
    try {
      v = await verifyRegistrationResponse({
        response: body.response as unknown as RegistrationResponseJSON,
        expectedChallenge: desafio,
        expectedOrigin: this.config.passkeys.origins,
        expectedRPID: this.config.passkeys.rpId,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALGORITMOS,
      });
    } catch {
      throw recusada();
    }
    if (!v.verified) throw recusada();
    const info = v.registrationInfo;
    const chaves = await this.daPessoa(tx, auth.userId);
    if (chaves.length >= MAX_CHAVES) throw new AppProblem(409, 'limite-de-chaves', 'Limite de chaves', `Cada pessoa tem até ${MAX_CHAVES} chaves. Tire uma antes.`);
    const aaguid = info.aaguid.toLowerCase();
    if (aaguid !== AAGUID_ZERO) {
      const mesmo = await tx.execute(sql`select 1 from liame.passkey where user_id = ${auth.userId} and aaguid = ${aaguid}`);
      if (mesmo.rows.length) throw new AppProblem(409, 'mesmo-gerenciador', 'Já há uma chave aí', 'Você já tem uma chave neste gerenciador. Use a que já existe.');
    }
    const sincroniza = info.credentialDeviceType === 'multiDevice';
    const nome = body.name ?? nomeDoGerenciador(aaguid, sincroniza, userAgent);
    const temApp = await this.temApp(tx, auth.userId);
    const id = uuidv7();
    await tx.execute(sql`
      insert into liame.passkey (id, user_id, credential_id, public_key, counter, transports, device_type, backed_up, aaguid, name)
      values (${id}, ${auth.userId}, ${info.credential.id}, ${Buffer.from(info.credential.publicKey)}, ${info.credential.counter},
              ${sql`array[${sql.join((info.credential.transports ?? []).map((t) => sql`${t}`), sql`, `)}]::text[]`},
              ${info.credentialDeviceType}, ${info.credentialBackedUp}, ${aaguid}, ${nome})`);
    // Sem o app, a primeira chave traz os códigos de recuperação: sem eles, perder o aparelho trava a conta.
    let codigos: string[] | null = null;
    if (!temApp && chaves.length === 0) {
      codigos = newRecoveryCodes();
      await tx.execute(sql`delete from liame.recovery_code where user_id = ${auth.userId} and used_at is null`);
      for (const c of codigos) {
        await tx.execute(sql`insert into liame.recovery_code (id, user_id, code_hash) values (${uuidv7()}, ${auth.userId}, ${hashRecoveryCode(c)})`);
      }
      await tx.execute(sql`update liame.app_user set mfa_enabled_at = coalesce(mfa_enabled_at, now()) where id = ${auth.userId}`);
    }
    // Quem cadastrou a primeira forma de segundo fator nesta sessão fica com a sessão verificada, como ao ativar o app.
    if (!auth.mfaVerifiedAt) {
      await tx.execute(sql`update liame.session set mfa_verified_at = now(), mfa_method = 'chave' where id = ${auth.sessionId}`);
    }
    auditDetail({ resourceId: id, after: { chave: nome, sincroniza, codigos_novos: codigos !== null } });
    this.avisar(
      auth.email,
      'Liame: chave de acesso criada',
      `Uma chave de acesso foi criada na sua conta (${nome}). Agora você entra e confirma com ela. Se não foi você, tire a chave em Segurança da conta e troque a senha.`,
    );
    const linha = (await tx.execute<LinhaDaChave>(sql`${SELECAO} where id = ${id}`)).rows[0]!;
    return { passkey: paraResposta(linha), recovery_codes: codigos };
  }

  /** Troca o nome da chave. */
  async renomear(auth: AuthContext, id: string, nome: string): Promise<PasskeysResponse> {
    const tx = currentTx();
    const r = await tx.execute<{ name: string }>(sql`
      update liame.passkey set name = ${nome} where id = ${id} and user_id = ${auth.userId} returning name`);
    if (!r.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Esta chave não existe ou já saiu.');
    auditDetail({ resourceId: id, after: { chave: nome } });
    return this.listar(auth);
  }

  /** Tira a chave. A última não sai sem o app ativo (D-A7-57): sem ela, a conta perderia o segundo fator. */
  async tirar(auth: AuthContext, id: string): Promise<PasskeysResponse> {
    const tx = currentTx();
    await tx.execute(sql`select id from liame.app_user where id = ${auth.userId} for update`);
    const chaves = await this.daPessoa(tx, auth.userId);
    const chave = chaves.find((c) => c.id === id);
    if (!chave) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Esta chave não existe ou já saiu.');
    if (chaves.length === 1 && !(await this.temApp(tx, auth.userId))) {
      throw new AppProblem(409, 'ultima-chave', 'É a sua última chave', 'Ative o app autenticador ou crie outra chave antes de tirar esta: sem nenhuma, a conta fica sem segundo fator.');
    }
    await tx.execute(sql`delete from liame.passkey where id = ${id} and user_id = ${auth.userId}`);
    auditDetail({ resourceId: id, before: { chave: chave.name } });
    this.avisar(
      auth.email,
      'Liame: chave de acesso tirada',
      `A chave de acesso ${chave.name} saiu da sua conta. Ela continua guardada no gerenciador do aparelho até você apagar lá, mas não abre mais o Liame. Se não foi você, troque a senha agora.`,
    );
    return this.listar(auth);
  }

  // ------------------------------------------------------------------ apoio

  private async daPessoa(tx: Tx, userId: string): Promise<LinhaDaChave[]> {
    const r = await tx.execute<LinhaDaChave>(sql`${SELECAO} where user_id = ${userId} order by created_at`);
    return r.rows;
  }

  private async temApp(tx: Tx, userId: string): Promise<boolean> {
    const r = await tx.execute(sql`
      select 1 from liame.secret where owner_user_id = ${userId} and tenant_id is null and purpose = 'totp' and revoked_at is null`);
    return r.rows.length > 0;
  }

  /** O identificador WebAuthn da pessoa: criado na primeira vez, aleatório, sem dado pessoal. */
  private async handleDaPessoa(tx: Tx, userId: string): Promise<string> {
    const r = await tx.execute<{ webauthn_user_id: string | null }>(sql`select webauthn_user_id from liame.app_user where id = ${userId}`);
    const atual = r.rows[0]?.webauthn_user_id;
    if (atual) return atual;
    const novo = isoBase64URL.fromBuffer(randomBytes(32));
    await tx.execute(sql`update liame.app_user set webauthn_user_id = ${novo} where id = ${userId}`);
    return novo;
  }

  private async opcoesDeUso(tx: Tx, userId: string, proposito: Exclude<Proposito, 'cadastrar'>): Promise<PasskeyCeremony> {
    const chaves = await this.daPessoa(tx, userId);
    if (!chaves.length) throw new AppProblem(404, 'sem-chave', 'Sem chave de acesso', 'Você ainda não tem chave de acesso. Use o código do app.');
    const options = await generateAuthenticationOptions({
      rpID: this.config.passkeys.rpId,
      allowCredentials: chaves.map((c) => ({ id: c.credential_id, transports: lista(c.transports) })),
      userVerification: 'required',
    });
    const challengeId = await this.guardarDesafio(tx, userId, proposito, options.challenge);
    return { challenge_id: challengeId, options: options as unknown as Record<string, unknown> };
  }

  /** Confere o que o aparelho assinou com uma chave da pessoa; atualiza o contador e o último uso. Devolve o nome. */
  private async conferirUso(tx: Tx, userId: string, body: PasskeyAssertion, proposito: Exclude<Proposito, 'cadastrar'>, userAgent?: string): Promise<string> {
    const desafio = await this.consumirDesafio(userId, body.challenge_id, proposito);
    const credencial = typeof body.response.id === 'string' ? body.response.id : '';
    const r = await tx.execute<LinhaDaChave>(sql`${SELECAO} where user_id = ${userId} and credential_id = ${credencial} for update`);
    const chave = r.rows[0];
    if (!chave) throw recusada();
    const v = await this.verificarAssinatura(chave, body, desafio);
    if (!v) throw recusada();
    await this.gravarUso(tx, chave.id, v, userAgent ?? null);
    return chave.name;
  }

  /** A assinatura do aparelho, conferida com a chave pública guardada; `null` quando não confere. */
  private async verificarAssinatura(chave: LinhaDaChave, body: PasskeyAssertion, desafio: string): Promise<VerifiedAuthenticationResponse | null> {
    try {
      const v = await verifyAuthenticationResponse({
        response: body.response as unknown as AuthenticationResponseJSON,
        expectedChallenge: desafio,
        expectedOrigin: this.config.passkeys.origins,
        expectedRPID: this.config.passkeys.rpId,
        credential: { id: chave.credential_id, publicKey: new Uint8Array(chave.public_key), counter: Number(chave.counter), transports: lista(chave.transports) },
        requireUserVerification: true,
      });
      return v.verified ? v : null;
    } catch {
      return null;
    }
  }

  /** O uso que conferiu: o contador novo, quando e em que aparelho. */
  private async gravarUso(tx: Tx, chaveId: string, v: VerifiedAuthenticationResponse, userAgent: string | null): Promise<void> {
    await tx.execute(sql`
      update liame.passkey
         set counter = ${v.authenticationInfo.newCounter}, last_used_at = now(), last_used_where = ${descreverAparelho(userAgent).slice(0, 80)},
             device_type = ${v.authenticationInfo.credentialDeviceType}, backed_up = ${v.authenticationInfo.credentialBackedUp}
       where id = ${chaveId}`);
  }

  private async guardarDesafio(tx: Tx, userId: string, proposito: Proposito, challenge: string): Promise<string> {
    // Os desafios vencidos da pessoa saem na hora: não há o que guardar deles.
    await tx.execute(sql`delete from liame.webauthn_challenge where user_id = ${userId} and (expires_at < now() or used_at is not null)`);
    const id = uuidv7();
    await tx.execute(sql`
      insert into liame.webauthn_challenge (id, user_id, purpose, challenge, expires_at)
      values (${id}, ${userId}, ${proposito}, ${challenge}, now() + make_interval(mins => ${MINUTOS_DO_DESAFIO}))`);
    return id;
  }

  /**
   * O desafio vale uma vez, para a pessoa e o propósito dele, por 5 minutos. É gasto numa transação à parte (como o limite
   * de tentativas): a tentativa recusada desfaz a da requisição, mas o desafio continua gasto. `userId` nulo = o desafio
   * da entrada sem senha, que não tem dono.
   */
  private async consumirDesafio(userId: string | null, id: string, proposito: Proposito): Promise<string> {
    const dono = userId === null ? sql`user_id is null` : sql`user_id = ${userId}`;
    const r = await withSystem(this.db, (tx) =>
      tx.execute<{ challenge: string }>(sql`
        update liame.webauthn_challenge set used_at = now()
         where id = ${id} and ${dono} and purpose = ${proposito} and used_at is null and expires_at > now()
         returning challenge`),
    );
    const desafio = r.rows[0]?.challenge;
    if (!desafio) throw desafioVencido();
    return desafio;
  }

  /** O aviso sai depois do commit: se a transação desfizer, ninguém recebe aviso do que não aconteceu. */
  private avisar(to: string, subject: string, text: string): void {
    afterCommit(() => this.mailer.send({ to, subject, text: `${text}\n\n${this.config.appUrl}` }));
  }
}
