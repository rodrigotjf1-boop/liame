import type { RecoveryCodesResponse, TotpSetupResponse } from '@liame/contracts';
import { type Tx, uuidv7 } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { afterCommit, type AuthContext, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { Mailer } from '../mail/mailer.js';
import { VaultService } from '../vault/vault.service.js';
import { RateLimitService } from './rate-limit.service.js';
import { hashRecoveryCode, newRecoveryCodes, newTotpSecret, otpauthUri, verifyTotp } from './totp.js';
import { newToken } from './tokens.js';

const invalidCode = () => new AppProblem(401, 'codigo-invalido', 'Código inválido', 'Confira o código do app autenticador e tente de novo.');

/** Segundo fator por app autenticador (ADR-013). Roda na transação da requisição (contexto da pessoa). */
@Injectable()
export class MfaService {
  constructor(
    private readonly vault: VaultService,
    private readonly rateLimit: RateLimitService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Começa (ou recomeça) a configuração: segredo pendente até a pessoa confirmar com um código. */
  async setup(auth: AuthContext): Promise<TotpSetupResponse> {
    const tx = currentTx();
    if (auth.mfaConfigured) await this.assertCanChange(tx, auth);
    const pending = await this.vault.findUserSecret(tx, auth.userId, 'totp_pendente');
    if (pending) await this.vault.revokeSecret(tx, pending.id);
    const secret = newTotpSecret();
    await this.vault.putSecret(tx, { ownerUserId: auth.userId, purpose: 'totp_pendente', plaintext: secret });
    return { secret, otpauth_uri: otpauthUri(secret, auth.email) };
  }

  /** Confirma com um código do app: ativa o fator, gera os 10 códigos de recuperação e verifica a sessão. */
  async confirm(auth: AuthContext, code: string): Promise<RecoveryCodesResponse> {
    await this.rateLimit.consume(`segundo-fator:${auth.userId}`, 10, 900);
    const tx = currentTx();
    const pending = await this.vault.findUserSecret(tx, auth.userId, 'totp_pendente');
    if (!pending) throw new AppProblem(400, 'sem-configuracao-pendente', 'Comece de novo', 'Gere um QR novo para configurar o app.');
    const step = verifyTotp(pending.plaintext, code);
    if (step === null) throw invalidCode();

    const current = await this.vault.findUserSecret(tx, auth.userId, 'totp');
    if (current) {
      const resetTokenId = await this.assertCanChange(tx, auth);
      await this.vault.revokeSecret(tx, current.id);
      if (resetTokenId) await tx.execute(sql`update liame.user_token set used_at = now() where id = ${resetTokenId}`);
    }
    await this.vault.revokeSecret(tx, pending.id);
    // A finalidade faz parte do contexto da cifra: o segredo é regravado como 'totp', não renomeado.
    await this.vault.putSecret(tx, { ownerUserId: auth.userId, purpose: 'totp', plaintext: pending.plaintext });
    await tx.execute(sql`update liame.app_user set totp_last_step = ${step} where id = ${auth.userId}`);

    const codes = newRecoveryCodes();
    await tx.execute(sql`delete from liame.recovery_code where user_id = ${auth.userId} and used_at is null`);
    for (const c of codes) {
      await tx.execute(sql`insert into liame.recovery_code (id, user_id, code_hash) values (${uuidv7()}, ${auth.userId}, ${hashRecoveryCode(c)})`);
    }
    await this.markSession(tx, auth, 'totp');
    this.notify(auth.email, current ? 'Liame: seu segundo fator foi trocado' : 'Liame: segundo fator ativado', current
      ? 'O app autenticador da sua conta foi trocado. Se não foi você, troque a senha e fale com o suporte.'
      : 'O app autenticador foi ativado na sua conta. Guarde os códigos de recuperação num lugar seguro.');
    return { recovery_codes: codes };
  }

  /** Verifica a sessão com o código do app ou com um código de recuperação (uso único). */
  async verify(auth: AuthContext, code: string): Promise<void> {
    await this.rateLimit.consume(`segundo-fator:${auth.userId}`, 10, 900);
    const tx = currentTx();
    if (/^\d{6}$/.test(code)) {
      const secret = await this.vault.findUserSecret(tx, auth.userId, 'totp');
      if (!secret) throw new AppProblem(400, 'segundo-fator-nao-configurado', 'Ative o app autenticador', 'Configure o segundo fator primeiro.');
      const r = await tx.execute<{ totp_last_step: string | null }>(sql`select totp_last_step from liame.app_user where id = ${auth.userId}`);
      const lastStep = r.rows[0]?.totp_last_step == null ? null : Number(r.rows[0].totp_last_step);
      const step = verifyTotp(secret.plaintext, code, { lastStep });
      if (step === null) throw invalidCode();
      // Condicional: duas requisições com o mesmo código ao mesmo tempo, só uma passa.
      const upd = await tx.execute(sql`
        update liame.app_user set totp_last_step = ${step}
         where id = ${auth.userId} and (totp_last_step is null or totp_last_step < ${step})`);
      if (upd.rowCount !== 1) throw invalidCode();
      await this.markSession(tx, auth, 'totp');
      return;
    }
    const used = await tx.execute<{ id: string }>(sql`
      update liame.recovery_code set used_at = now()
       where id = (select id from liame.recovery_code
                    where user_id = ${auth.userId} and code_hash = ${hashRecoveryCode(code)} and used_at is null
                    limit 1 for update)
       returning id`);
    if (!used.rows[0]) throw invalidCode();
    await this.markSession(tx, auth, 'recuperacao');
    this.notify(auth.email, 'Liame: código de recuperação usado', 'Um código de recuperação foi usado para entrar na sua conta. Se não foi você, troque a senha agora.');
  }

  /**
   * Confirmação na hora (step-up) para aprovar gasto ou ação de risco (ADR-007): só o código do app,
   * nunca código de recuperação, e o mesmo código não vale duas vezes. Não mexe na sessão.
   */
  async verifyStepUp(tx: Tx, userId: string, code: string): Promise<void> {
    await this.rateLimit.consume(`segundo-fator:${userId}`, 10, 900);
    const secret = await this.vault.findUserSecret(tx, userId, 'totp');
    if (!secret) throw new AppProblem(403, 'segundo-fator-nao-configurado', 'Ative o app autenticador', 'Aprovar exige o app autenticador ativo.');
    const r = await tx.execute<{ totp_last_step: string | null }>(sql`select totp_last_step from liame.app_user where id = ${userId}`);
    const lastStep = r.rows[0]?.totp_last_step == null ? null : Number(r.rows[0].totp_last_step);
    const step = verifyTotp(secret.plaintext, code, { lastStep });
    if (step === null) throw invalidCode();
    const upd = await tx.execute(sql`
      update liame.app_user set totp_last_step = ${step}
       where id = ${userId} and (totp_last_step is null or totp_last_step < ${step})`);
    if (upd.rowCount !== 1) throw invalidCode();
  }

  /**
   * Quem perdeu o aparelho entra com um código de recuperação e pede a troca: o pedido vale depois de
   * 24 horas, com aviso por e-mail (ADR-013). Com o app em mãos, a troca é imediata.
   */
  async requestChange(auth: AuthContext): Promise<void> {
    const tx = currentTx();
    if (auth.mfaMethod !== 'recuperacao') {
      throw new AppProblem(400, 'troca-sem-espera', 'Troca direta', 'Com o app em mãos, configure o novo diretamente.');
    }
    const { hash } = newToken();
    await tx.execute(sql`
      insert into liame.user_token (id, user_id, purpose, token_hash, expires_at, usable_after)
      values (${uuidv7()}, ${auth.userId}, 'trocar_segundo_fator', ${hash}, now() + interval '72 hours', now() + interval '24 hours')`);
    this.notify(
      auth.email,
      'Liame: pedido de troca do segundo fator',
      'Recebemos um pedido para trocar o app autenticador da sua conta. Ele vale em 24 horas. Se não foi você, troque a senha agora: isso cancela o pedido.',
    );
  }

  /** A troca exige a sessão verificada pelo app, ou um pedido de troca que já passou das 24 horas. */
  private async assertCanChange(tx: Tx, auth: AuthContext): Promise<string | null> {
    if (auth.mfaVerifiedAt && auth.mfaMethod === 'totp') return null;
    const r = await tx.execute<{ id: string }>(sql`
      select id from liame.user_token
       where user_id = ${auth.userId} and purpose = 'trocar_segundo_fator' and used_at is null
         and usable_after <= now() and expires_at > now()
       order by created_at desc limit 1`);
    if (r.rows[0]) return r.rows[0].id;
    throw new AppProblem(
      403,
      'troca-do-segundo-fator-bloqueada',
      'Confirme com o app',
      'Para trocar o app autenticador, entre com o código dele. Sem o aparelho, use um código de recuperação e peça a troca (vale em 24 horas).',
    );
  }

  private async markSession(tx: Tx, auth: AuthContext, method: 'totp' | 'recuperacao'): Promise<void> {
    await tx.execute(sql`update liame.session set mfa_verified_at = now(), mfa_method = ${method} where id = ${auth.sessionId}`);
  }

  /** O aviso sai depois do commit: se a transação desfizer, ninguém recebe aviso do que não aconteceu. */
  private notify(to: string, subject: string, text: string): void {
    afterCommit(() => this.mailer.send({ to, subject, text: `${text}\n\n${this.config.appUrl}` }));
  }
}
