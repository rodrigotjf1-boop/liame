import type { AccountRecoveryReason, MyAccountRecoveryResponse } from '@liame/contracts';
import { API_URL, type Problema, type Resultado, SEM_CONEXAO } from '@/lib/api';

// O pedido de recuperação da conta (`POST /v1/me/account-recovery`, o documento cru no corpo; A7, W8, parte 5). Até 10 MB:
// vai por `fetch`, com o cookie da sessão (`credentials`), como o envio do logo da agência.

const GENERICO: Omit<Problema, 'status'> = { code: 'erro-inesperado', title: 'Algo deu errado', detail: 'Tente de novo em instantes. Se continuar, fale com o suporte.' };

/** Manda o pedido com o documento; nunca rejeita: devolve o problema. */
export async function pedirRecuperacao(motivo: AccountRecoveryReason, documento: Blob): Promise<Resultado<MyAccountRecoveryResponse>> {
  let resposta: Response;
  try {
    resposta = await fetch(`${API_URL}/v1/me/account-recovery?reason=${encodeURIComponent(motivo)}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': documento.type || 'application/octet-stream' },
      body: documento,
    });
  } catch {
    return { ok: false, problema: SEM_CONEXAO };
  }
  let corpo: unknown = null;
  try {
    corpo = await resposta.json();
  } catch {
    // sem corpo JSON: cai no genérico
  }
  if (resposta.ok && corpo) return { ok: true, data: corpo as MyAccountRecoveryResponse };
  if (corpo && typeof corpo === 'object' && 'code' in corpo && 'title' in corpo) return { ok: false, problema: { ...(corpo as Problema), status: resposta.status } };
  return { ok: false, problema: { ...GENERICO, status: resposta.status } };
}
