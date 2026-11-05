import type { BrandPhoto, BrandVideoUploadResponse } from '@liame/contracts';
import { API_URL, api, chamar, type Problema, type Resultado, SEM_CONEXAO } from '@/lib/api';

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

// ------------------------------------------------------------ o vídeo (A6 · Z10, parte 2)
// O vídeo não passa pela API: a tela pede o envio (`POST /v1/brand-photos/videos`), manda o arquivo direto ao
// armazenamento pelo endereço assinado (com o tipo e o tamanho que foram na assinatura), pede a conferência
// (`POST …/{id}/video`) e, por fim, manda a capa, um quadro do meio do vídeo (`PUT …/{id}/cover`, D-A6-70).

/** A duração e as medidas que o próprio vídeo tem; nulo quando o navegador não abre o vídeo (espera até 4 s). */
export function medirVideo(endereco: string): Promise<{ duracaoMs: number; largura: number; altura: number } | null> {
  return new Promise((resolver) => {
    const v = document.createElement('video');
    let feito = false;
    const fim = (r: { duracaoMs: number; largura: number; altura: number } | null) => {
      if (feito) return;
      feito = true;
      clearTimeout(espera);
      v.removeAttribute('src');
      v.load();
      resolver(r);
    };
    const espera = setTimeout(() => fim(null), 4000);
    v.preload = 'metadata';
    v.muted = true;
    v.onloadedmetadata = () =>
      fim(Number.isFinite(v.duration) && v.duration > 0 && v.videoWidth > 0 ? { duracaoMs: Math.round(v.duration * 1000), largura: v.videoWidth, altura: v.videoHeight } : null);
    v.onerror = () => fim(null);
    v.src = endereco;
  });
}

/** Um quadro do meio do vídeo, em JPEG, com até `ladoMaior` px: a capa. Nulo quando o navegador não consegue tirar. */
export function quadroDoMeio(endereco: string, ladoMaior = 1280): Promise<Blob | null> {
  return new Promise((resolver) => {
    const v = document.createElement('video');
    let feito = false;
    const fim = (b: Blob | null) => {
      if (feito) return;
      feito = true;
      clearTimeout(espera);
      v.removeAttribute('src');
      v.load();
      resolver(b);
    };
    const espera = setTimeout(() => fim(null), 8000);
    v.preload = 'auto';
    v.muted = true;
    v.playsInline = true;
    v.onloadedmetadata = () => {
      if (!Number.isFinite(v.duration) || v.duration <= 0) return fim(null);
      v.currentTime = v.duration / 2;
    };
    v.onseeked = () => {
      const { videoWidth: w, videoHeight: h } = v;
      if (!w || !h) return fim(null);
      const escala = Math.min(1, ladoMaior / Math.max(w, h));
      const tela = document.createElement('canvas');
      tela.width = Math.max(1, Math.round(w * escala));
      tela.height = Math.max(1, Math.round(h * escala));
      const ctx = tela.getContext('2d');
      if (!ctx) return fim(null);
      try {
        ctx.drawImage(v, 0, 0, tela.width, tela.height);
        tela.toBlob((b) => fim(b), 'image/jpeg', 0.85);
      } catch {
        fim(null);
      }
    };
    v.onerror = () => fim(null);
    v.src = endereco;
  });
}

/** Pede o envio: o servidor guarda o pedido e devolve o endereço de envio direto (10 minutos). */
export function pedirEnvioDoVideo(marca: string, arquivo: File): Promise<Resultado<BrandVideoUploadResponse>> {
  return chamar(() =>
    api.POST('/v1/brand-photos/videos', { body: { brand_id: marca, media_type: arquivo.type as 'video/mp4' | 'video/quicktime', bytes: arquivo.size } }),
  );
}

/**
 * Manda o arquivo ao armazenamento pelo endereço assinado. Sem o cookie (é outro endereço) e com o `content-type` da
 * resposta: o tipo e o tamanho estão na assinatura. Nunca rejeita: devolve o problema.
 */
export function subirOVideo(envio: BrandVideoUploadResponse['upload'], arquivo: Blob, aoSubir: (pct: number) => void): Promise<Resultado<null>> {
  return new Promise<Resultado<null>>((resolver) => {
    const xhr = new XMLHttpRequest();
    xhr.open(envio.method, envio.url);
    for (const [nome, valor] of Object.entries(envio.headers)) xhr.setRequestHeader(nome, valor);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) aoSubir(Math.min(100, Math.round((e.loaded / e.total) * 100)));
    };
    xhr.upload.onload = () => aoSubir(100);
    xhr.onload = () =>
      resolver(
        xhr.status >= 200 && xhr.status < 300
          ? { ok: true, data: null }
          : { ok: false, problema: { status: 502, code: 'video-nao-subiu', title: 'O vídeo não subiu', detail: 'O armazenamento não recebeu o vídeo. Tente de novo.' } },
      );
    xhr.onerror = () => resolver({ ok: false, problema: SEM_CONEXAO });
    xhr.onabort = () => resolver({ ok: false, problema: SEM_CONEXAO });
    xhr.send(arquivo);
  });
}

/** Pede a conferência do vídeo que chegou: pronto, o vídeo como a lista mostra; recusado, o motivo. */
export function concluirOVideo(id: string): Promise<Resultado<BrandPhoto>> {
  return chamar(() => api.POST('/v1/brand-photos/{id}/video', { params: { path: { id } } }));
}

/** Manda a capa (a imagem crua no corpo, como a foto). Nunca rejeita: devolve o problema. */
export function enviarCapa(id: string, capa: Blob): Promise<Resultado<BrandPhoto>> {
  return new Promise<Resultado<BrandPhoto>>((resolver) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${API_URL}/v1/brand-photos/${encodeURIComponent(id)}/cover`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', capa.type || 'image/jpeg');
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
    xhr.send(capa);
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
