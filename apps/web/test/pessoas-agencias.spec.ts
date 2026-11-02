import type { MemberResponse, PartnerRequestResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import {
  aprovaTxt,
  cnpjTxt,
  contagemComAgencias,
  daAgencia,
  detalheDaAgencia,
  efeitosDaMudanca,
  pedeTxt,
  recebidoTxt,
  separarPorAgencia,
  sobe,
} from '../src/components/pessoas/parceiros';

// As agências em Pessoas e acessos (A7, W6, parte 4; P27 aprovado): as frases do pedido e da agência com acesso, a conta
// de "subir" (a mesma do servidor, `vinculo.service.ts`: pede o código do app) e o que muda para o time ao baixar.

const REAL = 1_000_000;
const sp = (s: string) => s.replace(/ /g, ' ');

function pessoa(extra: Partial<MemberResponse> = {}): MemberResponse {
  return {
    id: 'm1',
    user_id: 'u1',
    name: 'Caio Lima',
    email: 'caio@exemplo.com.br',
    role: 'gestor',
    approve_limit_micros: 50 * REAL,
    dual_approval: true,
    billing_access: false,
    expires_at: null,
    invited_by_name: 'Juliana Prado',
    created_at: '2026-11-01T12:00:00Z',
    mfa_enabled: true,
    last_seen_at: null,
    partner: { link_id: 'l1', agency_name: 'Agência Fogo' },
    ...extra,
  };
}

describe('as frases das agências', () => {
  it('o que o máximo aprova', () => {
    expect(sp(aprovaTxt('gestor', 500 * REAL, true))).toBe('aprova sozinho até R$ 500 por ação; acima disso, você também aprova');
    expect(sp(aprovaTxt('gestor', 500 * REAL, false))).toBe('aprova sozinho até R$ 500 por ação');
    expect(aprovaTxt('aprovador', 0, true)).toBe('todo gasto passa também por você');
    expect(aprovaTxt('administrador', null, false)).toBe('aprova sem limite');
    expect(aprovaTxt('somente_leitura', null, true)).toBe('não aprova gasto');
  });

  it('a linha da agência com acesso', () => {
    expect(sp(detalheDaAgencia({ max_role: 'gestor', approve_limit_micros: 500 * REAL, dual_approval: true, ends_at: null }))).toBe(
      'No máximo Gestor · aprova sozinho até R$ 500 por ação; acima disso, você também aprova · sem prazo',
    );
    expect(detalheDaAgencia({ max_role: 'somente_leitura', approve_limit_micros: null, dual_approval: true, ends_at: '2026-12-31T15:00:00Z' })).toBe(
      'No máximo Somente leitura · não aprova gasto · até 31/12/2026',
    );
  });

  it('a preposição pelo nome, o CNPJ e o que a agência pede', () => {
    expect(daAgencia('Agência Fogo')).toBe('da Agência Fogo');
    expect(daAgencia('agencia brasa')).toBe('da agencia brasa');
    expect(daAgencia('Estúdio Norte')).toBe('de Estúdio Norte');
    expect(cnpjTxt('11222333000181')).toBe('11.222.333/0001-81');
    expect(pedeTxt('gestor')).toBe('Gestor: opera campanhas e aprova até o limite');
  });

  it('quando o pedido chegou e até quando vale', () => {
    const p = { created_at: '2026-11-01T15:00:00Z', expires_at: '2026-11-08T15:00:00Z' } as PartnerRequestResponse;
    expect(recebidoTxt(p, new Date('2026-11-01T18:00:00Z'))).toBe('Recebido hoje · vale até 08/11/2026');
    expect(recebidoTxt(p, new Date('2026-11-03T18:00:00Z'))).toBe('Recebido em 01/11 · vale até 08/11/2026');
  });

  it('as pessoas da agência ficam com a agência; a contagem diz quantas, as agências e os pedidos', () => {
    const lista = [pessoa({ id: 'a', partner: null }), pessoa({ id: 'b' }), pessoa({ id: 'c' })];
    const { diretas, porVinculo } = separarPorAgencia(lista);
    expect(diretas.map((m) => m.id)).toEqual(['a']);
    expect(porVinculo.get('l1')?.map((m) => m.id)).toEqual(['b', 'c']);
    expect(contagemComAgencias(1, 0, 0, [{ nome: 'Agência Fogo', pessoas: 2 }])).toBe('3 pessoas, 2 da Agência Fogo, e 1 agência.');
    expect(contagemComAgencias(2, 1, 1, [])).toBe('2 pessoas. 1 convite esperando resposta. 1 pedido de agência esperando você.');
    expect(contagemComAgencias(1, 0, 0, [{ nome: 'Agência Fogo', pessoas: 0 }])).toBe('1 pessoa, e 1 agência.');
  });
});

describe('subir ou baixar o que a agência pode (a mesma conta do servidor)', () => {
  const max = (nivel: 'administrador' | 'gestor' | 'aprovador' | 'somente_leitura', limite: number | null = 50 * REAL, dupla = true) => ({ nivel, limite, dupla });

  it('o nível acima, passar a aprovar, o limite maior, sem limite e tirar o "eu também aprovo" sobem', () => {
    expect(sobe(max('gestor'), max('administrador'))).toBe(true);
    expect(sobe(max('somente_leitura', null), max('aprovador', 1))).toBe(true);
    expect(sobe(max('gestor'), max('gestor', 60 * REAL))).toBe(true);
    expect(sobe(max('gestor'), max('gestor', null))).toBe(true);
    expect(sobe(max('gestor'), max('gestor', 50 * REAL, false))).toBe(true);
  });

  it('o resto baixa (sem o código)', () => {
    expect(sobe(max('gestor'), max('aprovador'))).toBe(false);
    expect(sobe(max('gestor'), max('gestor', 10 * REAL))).toBe(false);
    expect(sobe(max('gestor', 50 * REAL, false), max('gestor', 50 * REAL, true))).toBe(false);
    expect(sobe(max('gestor'), max('somente_leitura', null))).toBe(false);
    expect(sobe(max('gestor'), max('gestor'))).toBe(false);
  });

  it('o que muda para o time ao baixar', () => {
    const time = [pessoa({ name: 'Caio Lima', role: 'gestor' }), pessoa({ id: 'm2', name: 'Bia Souza', role: 'aprovador', approve_limit_micros: 40 * REAL })];
    expect(efeitosDaMudanca(max('gestor'), max('aprovador', 10 * REAL), time).map(sp)).toEqual([
      'Caio Lima desce de Gestor para Aprovador, na hora.',
      'O limite de Bia Souza baixa para R$ 10 por ação.',
      'A agência recebe um aviso do que mudou.',
    ]);
    expect(efeitosDaMudanca(max('gestor'), max('somente_leitura', null), time)).toEqual([
      'Caio Lima desce de Gestor para Somente leitura, na hora.',
      'Bia Souza desce de Aprovador para Somente leitura, na hora.',
      'Ninguém da agência aprova mais gasto.',
      'A agência recebe um aviso do que mudou.',
    ]);
    expect(efeitosDaMudanca(max('gestor'), max('administrador'), time)).toEqual([]);
  });
});
