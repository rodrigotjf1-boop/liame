import { BRAND_LOGO_LIMITS, type BrandLogoResponse } from '@liame/contracts';
import { API_URL, type Problema, type Resultado, SEM_CONEXAO } from '@/lib/api';

// A logo do restaurante em Minha marca (A6 · Z15, parte 1; D-A6-138): o envio (`PUT /v1/brands/{id}/logo`, o arquivo cru
// no corpo, como a logo da agência) e a conferência do arquivo antes de mandar (o servidor confere de novo).

const GENERICO: Omit<Problema, 'status'> = { code: 'erro-inesperado', title: 'Algo deu errado', detail: 'Tente de novo em instantes. Se continuar, fale com o suporte.' };

/** O arquivo que dá para mandar: PNG ou JPG, até 1 MB. Nulo quando serve. */
export function problemaDaLogo(arquivo: { type: string; size: number }): string | null {
  if (!['image/png', 'image/jpeg'].includes(arquivo.type)) return 'Mande a logo em PNG ou JPG. SVG não vale: ele pode levar código.';
  if (arquivo.size > BRAND_LOGO_LIMITS.maxBytes) return 'A logo passa de 1 MB. Diminua a imagem e mande de novo.';
  return null;
}

/** Envia a logo; nunca rejeita: devolve o problema. */
export async function enviarLogoDaMarca(brandId: string, arquivo: Blob): Promise<Resultado<BrandLogoResponse>> {
  let resposta: Response;
  try {
    resposta = await fetch(`${API_URL}/v1/brands/${encodeURIComponent(brandId)}/logo`, {
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
  if (resposta.ok && corpo) return { ok: true, data: corpo as BrandLogoResponse };
  if (corpo && typeof corpo === 'object' && 'code' in corpo && 'title' in corpo) return { ok: false, problema: { ...(corpo as Problema), status: resposta.status } };
  return { ok: false, problema: { ...GENERICO, status: resposta.status } };
}
