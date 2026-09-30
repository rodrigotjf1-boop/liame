import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CupomRegem } from '../src/connectors/regem/contrato-regem.js';
import { motivoRecusaCupom } from '../src/orders/regem-leitura.js';

// Cupons do Regem (A2.5 · F4): o zod segue o contrato de cupons (§3.1: percentual maior que 0 e até 100; fora
// disso a origem manda `tipo: "outro"`), e o que o banco recusaria (`liame.coupon`) fica de fora na gravação,
// com um motivo que não leva o código nem o nome do cupom.

const FIX = resolve(import.meta.dirname, 'fixtures/regem/v1');
const pagina = JSON.parse(readFileSync(resolve(FIX, 'cupons.json'), 'utf8')) as { itens: Record<string, unknown>[] };
/** O cupom de referência do contrato, com um código e um nome que parecem de gente (não podem ir para o motivo). */
const cru: Record<string, unknown> = { ...pagina.itens[0]!, codigo: 'MARIA10', nome: 'Maria da Silva' };
const cupom = (mudar: Record<string, unknown> = {}) => CupomRegem.parse({ ...cru, ...mudar });

describe('contrato de cupons: percentual (§3.1)', () => {
  it('aceita de 0,01 a 100 com até 2 casas, e o cupom sem percentual', () => {
    for (const p of ['10.00', '100', '100.00', '0.01', '5', '99.99']) {
      expect(CupomRegem.safeParse({ ...cru, percentual: p }).success, p).toBe(true);
    }
    expect(CupomRegem.safeParse({ ...cru, tipo: 'outro', percentual: null }).success).toBe(true);
    const { percentual: _fora, ...semPercentual } = cru;
    expect(CupomRegem.safeParse({ ...semPercentual, tipo: 'frete_gratis' }).success).toBe(true);
  });

  it('recusa zero, acima de 100 e o formato fora do contrato, apontando o campo', () => {
    for (const p of ['0', '0.00', '100.01', '150.00', '999.99', '10.001', '-5', '1e2', '', ' 10']) {
      const r = CupomRegem.safeParse({ ...cru, percentual: p });
      expect(r.success, p).toBe(false);
      expect(r.error?.issues[0]?.path, p).toEqual(['percentual']);
    }
  });
});

describe('cupom que o banco recusaria (liame.coupon)', () => {
  it('o cupom do contrato passa', () => {
    expect(motivoRecusaCupom(cupom())).toBeNull();
  });

  it('cada regra do banco que o zod não cobre vira um motivo, sem o código nem o nome do cupom', () => {
    const casos: [string, ReturnType<typeof cupom>, RegExp][] = [
      ['código só com espaços (vazio depois do trim)', cupom({ codigo: '   ' }), /código vazio/],
      ['código que passa de 60 depois das maiúsculas (ß vira SS)', cupom({ codigo: 'ß'.repeat(31) }), /60 caracteres/],
      // O zod já barra; a triagem confere de novo porque gravarCupons pode receber cupom de outro caminho.
      ['percentual fora de (0, 100]', { ...cupom(), percentual: '150.00' }, /percentual/],
      ['limite de usos acima do integer', cupom({ max_usos: 3_000_000_000 }), /usos/],
      ['contagem de usos acima do integer', cupom({ usos: 2_147_483_648 }), /usos/],
      ['versão acima do bigint', cupom({ versao: '9223372036854775808' }), /versão/],
      ['ano 0000 na validade', cupom({ valido_de: '0000-01-01' }), /data/],
      ['ano 0000 na atualização', cupom({ atualizado_em: '0000-01-01T00:00:00Z' }), /data/],
      ['fuso desconhecido com data de validade', cupom({ fuso: 'Horario/Brasilia' }), /fuso/],
      ['caractere nulo no nome', cupom({ nome: 'Maria\u0000' }), /caractere/],
      ['metade de um par de surrogates nas condições', cupom({ condicoes: { max_por_cliente: 1, obs: 'a\ud800' } }), /caractere/],
      ['caractere nulo numa chave das condições', cupom({ condicoes: { 'x\u0000': 1 } }), /caractere/],
    ];
    for (const [caso, c, motivo] of casos) {
      const m = motivoRecusaCupom(c);
      expect(m, caso).toMatch(motivo);
      expect(m, caso).not.toMatch(/MARIA|Maria/);
    }
  });

  it('o fuso só é conferido quando há data de validade (o banco só usa o fuso para ela)', () => {
    expect(motivoRecusaCupom(cupom({ fuso: 'Horario/Brasilia', valido_de: null, valido_ate: null }))).toBeNull();
    expect(motivoRecusaCupom(cupom({ fuso: 'America/Manaus' }))).toBeNull();
  });

  it('versão no limite do bigint e usos no limite do integer ainda passam', () => {
    expect(motivoRecusaCupom(cupom({ versao: '9223372036854775807', max_usos: 2_147_483_647, usos: 2_147_483_647 }))).toBeNull();
  });
});
