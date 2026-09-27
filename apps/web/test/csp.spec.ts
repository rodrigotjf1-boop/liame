import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../next.config';
import { cspComNonce, cspPublica, ehRotaPublica, hashDeScript, ROTAS_PUBLICAS } from '../src/lib/csp';
import { SCRIPT_TEMA } from '../src/lib/tema';

// Blindagem do web: duas CSPs (telas de entrada pré-renderizadas × resto com nonce). Afrouxar qualquer uma
// exige mudar este teste junto.
const base = { isDev: false, api: 'https://api.liame.test' };

function diretivas(csp: string): Record<string, string[]> {
  return Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([nome, ...valores]) => [nome, valores]));
}

function essencial(d: Record<string, string[]>) {
  expect(d['default-src']).toEqual(["'self'"]);
  expect(d['object-src']).toEqual(["'none'"]);
  expect(d['base-uri']).toEqual(["'self'"]);
  expect(d['form-action']).toEqual(["'self'"]);
  expect(d['frame-ancestors']).toEqual(["'none'"]);
  expect(d['connect-src']).toEqual(["'self'", base.api]);
  // Script só do próprio app: nenhuma outra origem.
  expect(d['script-src']?.filter((v) => !v.startsWith("'"))).toEqual([]);
  expect(d['upgrade-insecure-requests']).toBeDefined();
}

function rotasDeEntrada(): string[] {
  const raiz = fileURLToPath(new URL('../src/app/(entrada)', import.meta.url));
  return readdirSync(raiz, { recursive: true, encoding: 'utf8' })
    .filter((f) => path.basename(f) === 'page.tsx')
    .map((f) => `/${path.dirname(f).split(path.sep).join('/')}`)
    .sort();
}

describe('CSP do web', () => {
  it('telas de entrada: CSP fixa no next.config, só nelas', async () => {
    const regras = await config.headers!();
    const comCsp = regras.filter((r) => r.headers.some((h) => h.key === 'Content-Security-Policy'));
    expect(comCsp.map((r) => r.source).sort()).toEqual([...ROTAS_PUBLICAS].sort());
    const valores = new Set(comCsp.map((r) => r.headers.find((h) => h.key === 'Content-Security-Policy')?.value));
    expect(valores.size).toBe(1);
    const d = diretivas([...valores][0] ?? '');
    expect(d['script-src']).toContain("'unsafe-inline'");
    expect(d['script-src']?.some((v) => v.startsWith("'nonce-"))).toBe(false);
    // Nenhuma CSP genérica ('/:path*'): nas demais rotas ela vem do proxy, com nonce.
    expect(regras.find((r) => r.source === '/:path*')?.headers.some((h) => h.key === 'Content-Security-Policy')).toBe(false);
    expect(config.experimental?.sri).toEqual({ algorithm: 'sha256' });
  });

  it('a lista de rotas públicas é exatamente o grupo (entrada)', () => {
    expect([...ROTAS_PUBLICAS].sort()).toEqual(rotasDeEntrada());
  });

  it('CSP pública: o essencial, sem eval em produção', () => {
    const d = diretivas(cspPublica(base));
    essencial(d);
    expect(d['script-src']).toEqual(["'self'", "'unsafe-inline'"]);
  });

  it('CSP com nonce: sem unsafe-inline nos scripts, nonce + strict-dynamic + hash do tema', async () => {
    const hashTema = await hashDeScript(SCRIPT_TEMA);
    const d = diretivas(cspComNonce({ ...base, nonce: 'abc123', hashTema }));
    essencial(d);
    expect(d['script-src']).toEqual(["'self'", "'nonce-abc123'", "'strict-dynamic'", hashTema]);
    expect(d['script-src']).not.toContain("'unsafe-inline'");
    expect(d['script-src']).not.toContain("'unsafe-eval'");
  });

  it('no desenvolvimento: eval liberado (erros do React) e ws do recarregamento', () => {
    const d = diretivas(cspComNonce({ isDev: true, api: base.api, nonce: 'n', hashTema: "'sha256-x'" }));
    expect(d['script-src']).toContain("'unsafe-eval'");
    expect(d['connect-src']).toContain('ws:');
    expect(d['upgrade-insecure-requests']).toBeUndefined();
  });

  it('hash do script do tema confere com o sha256 do texto', async () => {
    const { createHash } = await import('node:crypto');
    const esperado = `'sha256-${createHash('sha256').update(SCRIPT_TEMA).digest('base64')}'`;
    expect(await hashDeScript(SCRIPT_TEMA)).toBe(esperado);
  });

  it('rota pública: exata, com ou sem barra no fim; o resto cai na regra com nonce', () => {
    expect(ehRotaPublica('/entrar')).toBe(true);
    expect(ehRotaPublica('/entrar/')).toBe(true);
    expect(ehRotaPublica('/segundo-fator/ativar')).toBe(true);
    expect(ehRotaPublica('/')).toBe(false);
    expect(ehRotaPublica('/pessoas')).toBe(false);
    expect(ehRotaPublica('/entrar/../pessoas')).toBe(false);
    expect(ehRotaPublica('/entrarx')).toBe(false);
    expect(ehRotaPublica('/Entrar')).toBe(false);
    expect(ehRotaPublica('/qualquer-rota-nova')).toBe(false);
  });
});
