import { createLiameClient } from '@liame/sdk';

/**
 * Endereço da API, fixado no build do web (`NEXT_PUBLIC_API_URL`); sem ele, a API local do desenvolvimento.
 * O navegador fala direto com a API: o cookie de sessão é dela (httpOnly, ADR-013) e vai em toda chamada.
 */
// `||` e não `??`: o argumento de build vazio (imagem sem --build-arg) também cai no padrão local.
export const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

/** Cliente tipado pelo contrato OpenAPI: se a API mudar de forma incompatível, o web não compila. */
export const api = createLiameClient({ baseUrl: API_URL, credentials: 'include' });

/** Erro da API no formato RFC 9457 (arquitetura §14). `status` 0 = sem resposta (rede). */
export type Problema = {
  status: number;
  code: string;
  title: string;
  detail?: string;
  trace_id?: string;
  errors?: { path: string; message: string }[];
};

/** Falha de rede é diferente de erro da API (security-hardening P7): a mensagem diz o que fazer. */
export const SEM_CONEXAO: Problema = {
  status: 0,
  code: 'sem-conexao',
  title: 'Sem conexão',
  detail: 'Não conseguimos falar com o Liame. Confira a internet e tente de novo.',
};

export type Resultado<T> = { ok: true; data: T } | { ok: false; problema: Problema };

function comoProblema(error: unknown, response: Response): Problema {
  if (error && typeof error === 'object' && 'code' in error && 'title' in error) return error as Problema;
  return {
    status: response.status,
    code: 'erro-inesperado',
    title: 'Algo deu errado',
    detail: 'Tente de novo em instantes. Se continuar, fale com o suporte.',
  };
}

/** Faz a chamada e devolve os dados ou o problema, sem lançar: toda tela trata os dois caminhos. */
export async function chamar<T>(fn: () => Promise<{ data?: T; error?: unknown; response: Response }>): Promise<Resultado<T>> {
  try {
    const r = await fn();
    if (r.response.ok) return { ok: true, data: r.data as T };
    return { ok: false, problema: comoProblema(r.error, r.response) };
  } catch {
    return { ok: false, problema: SEM_CONEXAO };
  }
}

/**
 * Texto para a pessoa: o primeiro campo inválido, senão o detalhe, senão o título. No erro do nosso lado
 * (5xx) vai junto o código de rastreio: o texto da API pede para informá-lo ao suporte, e é com ele que o
 * suporte acha o que houve.
 */
export function mensagemDe(p: Problema): string {
  const texto = p.errors?.[0]?.message ?? p.detail ?? p.title;
  return p.status >= 500 && p.trace_id ? `${texto} Código de rastreio: ${p.trace_id}` : texto;
}

/** Chave de idempotência por tentativa de envio: repetir o mesmo clique não duplica o convite. */
export function novaChave(): string {
  return crypto.randomUUID();
}
