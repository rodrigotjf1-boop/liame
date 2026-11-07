import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../next.config';
import { cspComNonce, cspPublica, ehRotaPublica, hashDeScript, origemDasImagens, ROTAS_PUBLICAS } from '../src/lib/csp';
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

  it('as fotos e os vídeos (ADR-021; A6 · Z10): a origem do bucket entra no img-src, no media-src e no connect-src das telas do app, só com o bucket no ambiente e no formato do S3', async () => {
    const BUCKET = 'liame-imagens-123456789012-sa-east-1-an';
    const origem = origemDasImagens({ IMAGENS_BUCKET: BUCKET });
    expect(origem).toBe(`https://${BUCKET}.s3.sa-east-1.amazonaws.com`);
    expect(origemDasImagens({ IMAGENS_BUCKET: ` ${BUCKET}\n`, AWS_REGION: 'us-east-1' })).toBe(`https://${BUCKET}.s3.us-east-1.amazonaws.com`);
    // Sem o bucket, ou com o que não é nome de bucket (outra origem escondida no valor), nada entra.
    for (const ruim of [undefined, '', 'Liame-Imagens', 'a', 'bucket.com evil.example', 'x;script-src *', `${BUCKET}.evil`]) {
      expect(origemDasImagens({ IMAGENS_BUCKET: ruim })).toBeNull();
    }
    expect(origemDasImagens({ IMAGENS_BUCKET: BUCKET, AWS_REGION: 'sa-east-1; img-src *' })).toBeNull();
    const hashTema = await hashDeScript(SCRIPT_TEMA);
    const d = diretivas(cspComNonce({ ...base, imagens: origem, nonce: 'n', hashTema }));
    essencial({ ...d, 'connect-src': d['connect-src']?.filter((v) => v !== origem) ?? [] });
    // Nas telas do app, a API também entra no img-src: o logo público da agência no relatório do dono (A7, W7, parte 5a);
    // e as miniaturas do Instagram, no endereço da Meta ("Do seu Instagram", A6 · Z10, parte 5b).
    expect(d['img-src']).toEqual(["'self'", 'blob:', 'data:', base.api, 'https://*.cdninstagram.com', 'https://*.fbcdn.net', origem]);
    // O vídeo toca do bucket e, antes do envio, do próprio arquivo; e vai do navegador direto ao bucket.
    expect(d['media-src']).toEqual(["'self'", 'blob:', origem]);
    expect(d['connect-src']).toEqual(["'self'", base.api, origem]);
    // Nenhuma outra diretiva ganha a origem do bucket; e sem ela, as três ficam como eram.
    expect(Object.entries(d).filter(([nome, valores]) => !['img-src', 'media-src', 'connect-src'].includes(nome) && valores.includes(origem ?? ''))).toEqual([]);
    // Os endereços da Meta só no img-src (nenhum script, estilo, mídia ou conexão com eles).
    expect(Object.entries(d).filter(([nome, valores]) => nome !== 'img-src' && valores.some((v) => v.includes('cdninstagram') || v.includes('fbcdn')))).toEqual([]);
    const sem = diretivas(cspComNonce({ ...base, nonce: 'n', hashTema }));
    expect(sem['img-src']).toEqual(["'self'", 'blob:', 'data:', base.api, 'https://*.cdninstagram.com', 'https://*.fbcdn.net']);
    expect(sem['media-src']).toEqual(["'self'", 'blob:']);
    expect(sem['connect-src']).toEqual(["'self'", base.api]);
    // As telas de entrada não mostram imagem da API, do Instagram nem vídeo do bucket.
    expect(diretivas(cspPublica(base))['img-src']).toEqual(["'self'", 'blob:', 'data:']);
    expect(diretivas(cspPublica(base))['media-src']).toEqual(["'self'", 'blob:']);
  });

  it('o S3 local do roteiro do vídeo (A6 · Z10): só com a API nesta máquina e só um endereço desta máquina', () => {
    const local = 'http://localhost:3101';
    expect(origemDasImagens({ IMAGENS_S3_ENDPOINT: 'http://127.0.0.1:5005' }, local)).toBe('http://127.0.0.1:5005');
    expect(origemDasImagens({ IMAGENS_S3_ENDPOINT: 'http://localhost:5005' }, 'http://127.0.0.1:3101')).toBe('http://localhost:5005');
    // Fora do formato, nada entra (e o bucket do ambiente não é usado no lugar).
    for (const ruim of ['https://127.0.0.1:5005', 'http://evil.example:5005', 'http://127.0.0.1:5005 https://evil.example', 'http://127.0.0.1']) {
      expect(origemDasImagens({ IMAGENS_S3_ENDPOINT: ruim, IMAGENS_BUCKET: 'liame-imagens-teste' }, local), ruim).toBeNull();
    }
    // Com a API pública (produção), o endereço local não vale: fica a origem do bucket.
    for (const publica of ['https://api.agencialiame.com', '', 'http://localhost.evil.example:3101']) {
      expect(origemDasImagens({ IMAGENS_S3_ENDPOINT: 'http://127.0.0.1:5005', IMAGENS_BUCKET: 'liame-imagens-teste' }, publica), publica).toBe(
        'https://liame-imagens-teste.s3.sa-east-1.amazonaws.com',
      );
    }
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
