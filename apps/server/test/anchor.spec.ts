import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { anchorStatement, buildTimeStampRequest, computeRoot, timeStampStatus } from '../src/audit/anchor.js';
import { canonicalJson, genesisHash, hashRecord } from '../src/audit/audit.js';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

describe('âncora da auditoria', () => {
  it('a raiz não depende da ordem das cabeças e muda com qualquer cabeça, com o sal ou com a raiz anterior', () => {
    const heads = [
      { chain_key: 'b', chain_seq: 2, hash: 'h2' },
      { chain_key: 'a', chain_seq: '7', hash: 'h7' },
    ];
    const root = computeRoot('sal', 'anterior', '2026-09-25', heads);
    expect(computeRoot('sal', 'anterior', '2026-09-25', [...heads].reverse())).toBe(root);
    expect(computeRoot('sal', 'anterior', '2026-09-25', [{ ...heads[0]!, hash: 'hX' }, heads[1]!])).not.toBe(root);
    expect(computeRoot('outro', 'anterior', '2026-09-25', heads)).not.toBe(root);
    expect(computeRoot('sal', 'outra', '2026-09-25', heads)).not.toBe(root);
  });

  it('a declaração publicada só tem hashes', () => {
    expect(anchorStatement('2026-09-25', 'r', 'p').toString()).toBe('{"day":"2026-09-25","liame_audit_anchor":1,"prev_root_hash":"p","root_hash":"r"}');
  });

  it('o hash do evento muda com qualquer campo e com o anterior; a ordem das chaves do JSON não importa', () => {
    const e = {
      id: 'x', chain_key: 'k', chain_seq: 1, tenant_id: null, actor_type: 'human' as const, actor_id: 'u', actor_label: 'Ana, Dono',
      actor_role: 'dono', action: 'marca.criar', resource_type: 'brand', resource_id: 'b', before: null, after: { b: 1, a: 'x' },
      reason: null, approval_id: null, trace_id: null, origin: 'api' as const, tool: null, agent: null, model: null,
      occurred_at: '2026-09-26T12:00:00.123Z',
    };
    const h = hashRecord(genesisHash('k'), e);
    expect(hashRecord(genesisHash('k'), { ...e, after: { a: 'x', b: 1 } })).toBe(h);
    expect(hashRecord(genesisHash('k'), { ...e, action: 'marca.apagar' })).not.toBe(h);
    expect(hashRecord(genesisHash('outra'), e)).not.toBe(h);
    expect(canonicalJson({ b: [2, { d: 1, c: null }], a: undefined })).toBe('{"b":[2,{"c":null,"d":1}]}');
  });

  it('lê o status do TimeStampResp', () => {
    expect(timeStampStatus(Buffer.from('3007300302010030 00'.replace(/ /g, ''), 'hex'))).toBe(0);
    expect(timeStampStatus(Buffer.from('30053003020102', 'hex'))).toBe(2);
    expect(() => timeStampStatus(Buffer.from('0400', 'hex'))).toThrow('inválida');
  });

  it.skipIf(!hasOpenssl)('o pedido RFC 3161 em DER é lido pelo OpenSSL como um TimeStampReq válido', () => {
    const statement = anchorStatement('2026-09-25', 'r', 'p');
    const { der } = buildTimeStampRequest(statement, Buffer.from('00ff112233445566', 'hex'));
    const dir = mkdtempSync(join(tmpdir(), 'liame-tsq-'));
    const file = join(dir, 'pedido.tsq');
    writeFileSync(file, der);
    const out = spawnSync('openssl', ['ts', '-query', '-in', file, '-text'], { encoding: 'utf8' });
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/Version: 1/);
    expect(out.stdout).toMatch(/Hash Algorithm: sha256/);
    expect(out.stdout).toMatch(/Nonce: 0xFF112233445566/i);
    expect(out.stdout).toMatch(/Certificate required: yes/);
    // A impressão é o SHA-256 da declaração.
    const digest = createHash('sha256').update(statement).digest('hex');
    const printed = out.stdout.replace(/\s|-/g, '').toLowerCase();
    expect(printed).toContain(digest.slice(0, 16));
  });
});
