import type { PasskeyAssertion } from '@liame/contracts';
import type { Tx } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { aparelhoDaRequisicao } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { ChavesService } from './chaves/chaves.service.js';
import { MfaService } from './mfa.service.js';

/** O que a pessoa manda para confirmar que é ela: o código do app ou a chave de acesso (com o desafio de confirmação). */
export interface ProvaDaPessoa {
  code?: string | null;
  passkey?: PasskeyAssertion | null;
}

/**
 * A confirmação na hora (step-up) de quem aprova ou muda algo de risco (ADR-007; A7, W9, parte 9b2; D-A7-56): uma chave
 * de acesso da pessoa (o que o aparelho assinou, com o desafio de `/v1/me/passkeys/confirmation-options`) ou o código do
 * app. A chave vem primeiro na tela; o código fica ao lado. Código de recuperação nunca vale aqui. As duas formas dividem
 * o limite de tentativas da pessoa (`segundo-fator`).
 */
@Injectable()
export class ConfirmacaoService {
  constructor(
    private readonly mfa: MfaService,
    private readonly chaves: ChavesService,
  ) {}

  /** Confere a prova na transação de quem chama; devolve como a pessoa confirmou. Com as duas, vale a chave. */
  async confirmar(tx: Tx, userId: string, prova: ProvaDaPessoa): Promise<'chave' | 'totp'> {
    if (prova.passkey) {
      await this.chaves.confirmarComChave(tx, userId, prova.passkey, aparelhoDaRequisicao() ?? undefined);
      return 'chave';
    }
    if (prova.code) {
      await this.mfa.verifyStepUp(tx, userId, prova.code);
      return 'totp';
    }
    throw new AppProblem(400, 'confirme-que-e-voce', 'Confirme que é você', 'Use a sua chave de acesso ou digite os 6 números do app autenticador.');
  }
}
