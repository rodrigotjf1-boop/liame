import { describe, expect, it } from 'vitest';
import config from '../next.config';

// Blindagem do web: a CSP sai em toda rota com o essencial; afrouxar exige mudar este teste junto.
describe('CSP do web', () => {
  it('toda rota leva a CSP com o que não pode faltar', async () => {
    const regras = await config.headers!();
    const toda = regras.find((r) => r.source === '/:path*');
    const csp = toda?.headers.find((h) => h.key === 'Content-Security-Policy')?.value ?? '';
    const diretivas: Record<string, string[]> = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).map(([nome, ...valores]) => [nome, valores]));
    expect(diretivas['default-src']).toEqual(["'self'"]);
    expect(diretivas['object-src']).toEqual(["'none'"]);
    expect(diretivas['base-uri']).toEqual(["'self'"]);
    expect(diretivas['form-action']).toEqual(["'self'"]);
    expect(diretivas['frame-ancestors']).toEqual(["'none'"]);
    // Script só do próprio app: nenhuma outra origem.
    expect(diretivas['script-src']?.filter((v) => !v.startsWith("'"))).toEqual([]);
    expect(diretivas['connect-src']).toContain("'self'");
    expect(config.experimental?.sri).toEqual({ algorithm: 'sha256' });
  });
});
