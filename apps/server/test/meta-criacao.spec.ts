import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { chaveDoPassoDaCampanhaNova } from '../src/actions/campanha-nova-na-meta.js';
import { type DependenciasDaCriacaoNaMeta, enderecoDaMeta, idDaMeta } from '../src/actions/meta-criacao.js';

// Os passos comuns de criar anúncio na Meta (`actions/meta-criacao.ts`), tirados do conector da campanha nova para
// servirem também ao teste de criativo (plano da região, R8). Aqui, o que não pede rede nem banco; a criação inteira e o
// ativar e pausar seguem provados em `test/db/campanha-nova.spec.ts`, que não mudou.

const deps = (appSecret: string | null) => ({ graphUrl: 'https://graph.exemplo.test', appSecret }) as unknown as DependenciasDaCriacaoNaMeta;

describe('a chave de idempotência de cada passo da campanha nova', () => {
  it('é a de sempre: a campanha nova, dois-pontos e o passo', () => {
    // O texto literal: a criação que estiver no meio quando um deploy entrar repete o passo com a mesma chave. Se o
    // formato mudar, a Meta cria o objeto de novo.
    const id = '0192f0a8-7c2e-7b11-9d3a-5f6e7a8b9c0d';
    expect(chaveDoPassoDaCampanhaNova(id, 'campanha')).toBe('0192f0a8-7c2e-7b11-9d3a-5f6e7a8b9c0d:campanha');
    expect(chaveDoPassoDaCampanhaNova(id, 'conjunto')).toBe('0192f0a8-7c2e-7b11-9d3a-5f6e7a8b9c0d:conjunto');
    expect(chaveDoPassoDaCampanhaNova(id, 'criativo')).toBe('0192f0a8-7c2e-7b11-9d3a-5f6e7a8b9c0d:criativo');
    expect(chaveDoPassoDaCampanhaNova(id, 'anuncio')).toBe('0192f0a8-7c2e-7b11-9d3a-5f6e7a8b9c0d:anuncio');
  });
});

describe('o endereço de uma chamada à Graph API', () => {
  it('leva a versão, o caminho e os parâmetros, e a prova do segredo do app quando há', () => {
    const token = 'token-de-exemplo';
    const com = new URL(enderecoDaMeta({ deps: deps('segredo-de-exemplo'), token }, 'v25.0', 'act_123/adsets', { status: 'PAUSED', name: 'Combo · 3 km' }));
    expect(`${com.origin}${com.pathname}`).toBe('https://graph.exemplo.test/v25.0/act_123/adsets');
    expect(com.searchParams.get('status')).toBe('PAUSED');
    expect(com.searchParams.get('name')).toBe('Combo · 3 km');
    expect(com.searchParams.get('appsecret_proof')).toBe(createHmac('sha256', 'segredo-de-exemplo').update(token).digest('hex'));
    // O token nunca vai no endereço: só no cabeçalho.
    expect(com.toString()).not.toContain(token);
    const sem = new URL(enderecoDaMeta({ deps: deps(null), token }, 'v25.0', '120210000000000', { fields: 'status' }));
    expect(sem.searchParams.has('appsecret_proof')).toBe(false);
    expect(sem.pathname).toBe('/v25.0/120210000000000');
  });
});

describe('o id que a Meta devolve', () => {
  it('só algarismos, de 1 a 32; o resto é nulo', () => {
    expect(idDaMeta('120210000000000')).toBe('120210000000000');
    expect(idDaMeta('1'.repeat(32))).toBe('1'.repeat(32));
    for (const ruim of ['', '1'.repeat(33), '12a', ' 12', '12 ', '1.2', '-1', 12, null, undefined, {}]) expect(idDaMeta(ruim)).toBeNull();
  });
});
