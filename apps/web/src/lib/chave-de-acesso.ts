import type { MeResponse, PasskeyAssertion } from '@liame/contracts';
import {
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration,
  WebAuthnAbortService,
} from '@simplewebauthn/browser';

// A janela do aparelho para as chaves de acesso (A7, W9, parte 9c; P28; D-A7-54 a D-A7-58): o navegador recebe as opções
// do servidor, o aparelho pede a digital, o rosto ou o PIN e devolve o que assinou. Aqui só se traduz o resultado para a
// tela: a resposta, ou o motivo de não ter vindo (a pessoa fechou a janela, o aparelho já tem a chave, o navegador não
// aceita chave). O servidor confere tudo.

/** A confirmação de quem decide (aprovar, apagar, mudar o contrato…; D-A7-56): a chave de acesso ou o código do app. */
export type Prova = { code: string } | { passkey: PasskeyAssertion };

/**
 * Como a pessoa confirma: o app e a chave, pelo `/v1/me` (`mfa_methods`). Sem a lista (resposta antiga), o segundo fator
 * configurado conta como o app, como antes da W9.
 */
export function formasDeConfirmar(me: Pick<MeResponse, 'mfa' | 'mfa_methods'>): { temApp: boolean; temChave: boolean } {
  if (!me.mfa_methods) return { temApp: me.mfa !== 'not_configured', temChave: false };
  return { temApp: me.mfa_methods.includes('totp'), temChave: me.mfa_methods.includes('chave') };
}

export type MotivoDaChave = 'cancelou' | 'ja-tem' | 'sem-suporte' | 'falhou';
export type ResultadoDaChave = { ok: true; resposta: Record<string, unknown> } | { ok: false; motivo: MotivoDaChave };

/** O navegador aceita chave de acesso (WebAuthn). */
export function navegadorAceitaChave(): boolean {
  try {
    return browserSupportsWebAuthn();
  } catch {
    return false;
  }
}

/** O motivo, em palavras da tela: fechar a janela e o tempo esgotado chegam como `NotAllowedError` (ou `AbortError`). */
export function motivoDoErro(err: unknown): MotivoDaChave {
  const e = err as { name?: string; code?: string } | null;
  if (e?.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED' || e?.name === 'InvalidStateError') return 'ja-tem';
  if (e?.name === 'NotAllowedError' || e?.name === 'AbortError' || e?.code === 'ERROR_CEREMONY_ABORTED') return 'cancelou';
  return 'falhou';
}

/** Usar uma chave (entrar ou confirmar): as opções vêm do servidor como estão. */
export async function usarAChave(opcoes: Record<string, unknown>): Promise<ResultadoDaChave> {
  if (!navegadorAceitaChave()) return { ok: false, motivo: 'sem-suporte' };
  try {
    const resposta = await startAuthentication({ optionsJSON: opcoes as unknown as PublicKeyCredentialRequestOptionsJSON });
    return { ok: true, resposta: resposta as unknown as Record<string, unknown> };
  } catch (err) {
    return { ok: false, motivo: motivoDoErro(err) };
  }
}

/**
 * O navegador oferece a chave no próprio campo do e-mail (o preenchimento, "conditional UI"; D-A7-55). O campo precisa
 * de `autocomplete="username webauthn"`.
 */
export async function campoOfereceChave(): Promise<boolean> {
  try {
    return navegadorAceitaChave() && (await browserSupportsWebAuthnAutofill());
  } catch {
    return false;
  }
}

/**
 * Espera a pessoa escolher a chave no preenchimento do campo. Fica pendente até ela escolher; outra cerimônia (o botão
 * "Entrar com chave de acesso") ou `cancelarAJanela` a encerram, e aí volta `cancelou`.
 */
export async function usarAChaveNoCampo(opcoes: Record<string, unknown>): Promise<ResultadoDaChave> {
  try {
    const resposta = await startAuthentication({ optionsJSON: opcoes as unknown as PublicKeyCredentialRequestOptionsJSON, useBrowserAutofill: true });
    return { ok: true, resposta: resposta as unknown as Record<string, unknown> };
  } catch (err) {
    return { ok: false, motivo: motivoDoErro(err) };
  }
}

/** Encerra a cerimônia pendente (ao sair da tela). */
export function cancelarAJanela(): void {
  try {
    WebAuthnAbortService.cancelCeremony();
  } catch {
    /* nada pendente */
  }
}

/** Criar uma chave no aparelho. */
export async function criarAChave(opcoes: Record<string, unknown>): Promise<ResultadoDaChave> {
  if (!navegadorAceitaChave()) return { ok: false, motivo: 'sem-suporte' };
  try {
    const resposta = await startRegistration({ optionsJSON: opcoes as unknown as PublicKeyCredentialCreationOptionsJSON });
    return { ok: true, resposta: resposta as unknown as Record<string, unknown> };
  } catch (err) {
    return { ok: false, motivo: motivoDoErro(err) };
  }
}

/** A frase do motivo, quando a chave não veio. */
export function fraseDoMotivo(motivo: MotivoDaChave, alternativa: string): string {
  switch (motivo) {
    case 'cancelou':
      return `Você fechou a janela da chave. Tente de novo ou ${alternativa}.`;
    case 'ja-tem':
      return 'Este aparelho já tem uma chave do Liame. Use a que já existe.';
    case 'sem-suporte':
      return `Este navegador não aceita chave de acesso. ${alternativa.charAt(0).toUpperCase()}${alternativa.slice(1)}.`;
    default:
      return `O aparelho não conseguiu usar a chave. Tente de novo ou ${alternativa}.`;
  }
}
