import { type NextRequest, NextResponse } from 'next/server';
import { cspComNonce, ehRotaPublica, hashDeScript } from './lib/csp';
import { SCRIPT_TEMA } from './lib/tema';

// CSP com nonce (decisão do dono em 27/09/2026): toda rota que não é tela de entrada recebe um nonce
// novo por requisição. O Next lê o nonce do cabeçalho Content-Security-Policy da requisição e o aplica
// aos próprios scripts; a página precisa ser renderizada a cada acesso (layout do app: `instant = false`
// e `connection()`). Rota nova fica, por padrão, com a regra rígida.

const isDev = process.env.NODE_ENV !== 'production';
const api = new URL(process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001').origin;
let hashTema: Promise<string> | undefined;

export async function proxy(request: NextRequest) {
  if (ehRotaPublica(request.nextUrl.pathname)) return NextResponse.next();

  const nonce = btoa(crypto.randomUUID());
  hashTema ??= hashDeScript(SCRIPT_TEMA);
  const csp = cspComNonce({ isDev, api, nonce, hashTema: await hashTema });

  const cabecalhos = new Headers(request.headers);
  cabecalhos.set('x-nonce', nonce);
  cabecalhos.set('Content-Security-Policy', csp);
  const resposta = NextResponse.next({ request: { headers: cabecalhos } });
  resposta.headers.set('Content-Security-Policy', csp);
  return resposta;
}

export const config = {
  matcher: [
    {
      // Páginas: fora os arquivos do build, a otimização de imagem, os ícones e os arquivos da LIA.
      source: '/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|lia/).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
