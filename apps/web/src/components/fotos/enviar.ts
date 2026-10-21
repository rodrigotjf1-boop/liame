import type { BrandPhoto } from '@liame/contracts';
import { API_URL, type Problema, type Resultado, SEM_CONEXAO } from '@/lib/api';

// O envio de uma foto (`POST /v1/brand-photos`, o arquivo cru no corpo). Vai por XMLHttpRequest, e não pelo cliente
// do contrato, porque a tela mostra quanto do arquivo já subiu: o `fetch` não conta o envio. O cookie da sessão vai
// junto (`withCredentials`), como nas outras chamadas.

function problemaDe(xhr: XMLHttpRequest): Problema {
  try {
    const corpo: unknown = JSON.parse(xhr.responseText);
    if (corpo && typeof corpo === 'object' && 'code' in corpo && 'title' in corpo) return { ...(corpo as Problema), status: xhr.status };
  } catch {
    // sem corpo problem+json: cai no genérico
  }
  return { status: xhr.status, code: 'erro-inesperado', title: 'Algo deu errado', detail: 'Tente de novo em instantes. Se continuar, fale com o suporte.' };
}

/**
 * Envia o arquivo; `aoSubir` recebe de 0 a 100 enquanto o arquivo sobe. Nunca rejeita: devolve o problema. O envio
 * que já começou vai até o fim mesmo se a pessoa sair da tela (a foto entra do mesmo jeito).
 */
export function enviarFoto(marca: string, arquivo: Blob, aoSubir: (pct: number) => void): Promise<Resultado<BrandPhoto>> {
  return new Promise<Resultado<BrandPhoto>>((resolver) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}/v1/brand-photos?brand_id=${encodeURIComponent(marca)}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', arquivo.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) aoSubir(Math.min(100, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.upload.onload = () => aoSubir(100);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolver({ ok: true, data: JSON.parse(xhr.responseText) as BrandPhoto });
        } catch {
          resolver({ ok: false, problema: problemaDe(xhr) });
        }
        return;
      }
      resolver({ ok: false, problema: problemaDe(xhr) });
    };
    xhr.onerror = () => resolver({ ok: false, problema: SEM_CONEXAO });
    xhr.onabort = () => resolver({ ok: false, problema: SEM_CONEXAO });
    xhr.send(arquivo);
  });
}

/** As medidas que a própria imagem tem (0 × 0 quando o navegador não a abre). */
export function medirImagem(endereco: string): Promise<{ largura: number; altura: number }> {
  return new Promise((resolver) => {
    const img = new Image();
    img.onload = () => resolver({ largura: img.naturalWidth, altura: img.naturalHeight });
    img.onerror = () => resolver({ largura: 0, altura: 0 });
    img.src = endereco;
  });
}

/** O SHA-256 do arquivo, para a mesma foto não ir duas vezes no mesmo envio (nulo sem Web Crypto). */
export async function hashDoArquivo(arquivo: Blob): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const d = await crypto.subtle.digest('SHA-256', await arquivo.arrayBuffer());
    return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}
