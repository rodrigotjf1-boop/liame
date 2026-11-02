import type { AgencyBrandResponse } from '@liame/contracts';
import { API_URL, type Problema, type Resultado, SEM_CONEXAO } from '@/lib/api';

// O envio do logo da agência (`PUT /v1/agency/brand/logo`, o arquivo cru no corpo; A7, W7, parte 5a). Até 1 MB: vai por
// `fetch`, sem barra de progresso, com o cookie da sessão (`credentials`), como as outras chamadas.

const GENERICO: Omit<Problema, 'status'> = { code: 'erro-inesperado', title: 'Algo deu errado', detail: 'Tente de novo em instantes. Se continuar, fale com o suporte.' };

/** Envia o logo; nunca rejeita: devolve o problema. */
export async function enviarLogo(arquivo: Blob): Promise<Resultado<AgencyBrandResponse>> {
  let resposta: Response;
  try {
    resposta = await fetch(`${API_URL}/v1/agency/brand/logo`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': arquivo.type || 'application/octet-stream' },
      body: arquivo,
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
  if (resposta.ok && corpo) return { ok: true, data: corpo as AgencyBrandResponse };
  if (corpo && typeof corpo === 'object' && 'code' in corpo && 'title' in corpo) return { ok: false, problema: { ...(corpo as Problema), status: resposta.status } };
  return { ok: false, problema: { ...GENERICO, status: resposta.status } };
}
