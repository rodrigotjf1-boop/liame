import type { OwnershipResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import {
  CONTINUA,
  depoisDoAceite,
  fraseDepoisDoAceite,
  motivoDeNaoPoder,
  oQuePassa,
  primeiroNome,
  situacaoDoDono,
} from '../src/components/pessoas/propriedade-textos';

// A propriedade da conta em Pessoas e acessos (A7, W8, parte 3; P34 aprovado): quem pode receber (a mesma regra do
// servidor), a situação do cartão do Dono e as frases do pedido.

const AGORA = new Date('2026-11-02T15:00:00Z');
const base: OwnershipResponse = {
  owner: { user_id: 'u1', name: 'Rodrigo de Oliveira', since: '2026-06-30T12:00:00Z' },
  pending: null,
  addressed_to_me: false,
  candidates: [{ user_id: 'u2', name: 'Ana Lima', email: 'a@x.com' }],
  can_transfer_from: null,
};

describe('a propriedade da conta', () => {
  it('quem pode receber: o Administrador com o app; os outros com o motivo', () => {
    const podem = new Set(['u2']);
    expect(motivoDeNaoPoder({ user_id: 'u2', role: 'administrador', mfa_enabled: true, partner: null }, podem)).toBeNull();
    expect(motivoDeNaoPoder({ user_id: 'u3', role: 'gestor', mfa_enabled: true, partner: null }, podem)).toBe('É Gestor. Só um Administrador recebe: mude o nível em Alterar acesso antes.');
    expect(motivoDeNaoPoder({ user_id: 'u4', role: 'administrador', mfa_enabled: false, partner: null }, podem)).toBe('Ainda não entra com o app autenticador.');
    expect(motivoDeNaoPoder({ user_id: 'u5', role: 'administrador', mfa_enabled: true, partner: { link_id: 'l1', agency_name: 'Agência Fogo' } }, podem)).toBe(
      'Vem de Agência Fogo: a conta é sempre do dono do negócio.',
    );
  });

  it('o cartão do Dono: pode transferir, espera os 7 dias ou tem um pedido esperando', () => {
    expect(situacaoDoDono(base, AGORA)).toBe('pode');
    expect(situacaoDoDono({ ...base, can_transfer_from: '2026-11-08T15:00:00Z' }, AGORA)).toBe('espera');
    expect(situacaoDoDono({ ...base, can_transfer_from: '2026-11-01T15:00:00Z' }, AGORA)).toBe('pode');
    const pedido = {
      id: 'p1',
      from: { user_id: 'u1', name: 'Rodrigo de Oliveira' },
      to: { user_id: 'u2', name: 'Ana Lima', email: 'a@x.com' },
      old_owner_stays: true,
      status: 'pedido' as const,
      created_at: '2026-11-02T12:00:00Z',
      expires_at: '2026-11-09T12:00:00Z',
      decided_at: null,
    };
    expect(situacaoDoDono({ ...base, pending: pedido }, AGORA)).toBe('pedido');
  });

  it('as frases: o que o Dono antigo vira, o primeiro nome e as listas do que muda', () => {
    expect(depoisDoAceite(true, 'Mister Burgers')).toBe('Administrador, sem a cobrança');
    expect(depoisDoAceite(false, 'Mister Burgers')).toBe('Sai da Mister Burgers');
    expect(fraseDepoisDoAceite('você', true, 'Mister Burgers')).toBe('você fica como Administrador, sem a cobrança');
    expect(fraseDepoisDoAceite('Paulo', false, 'Mister Burgers')).toBe('Paulo sai da Mister Burgers');
    expect(primeiroNome('Ana Lima')).toBe('Ana');
    expect(oQuePassa('Ana')[0]).toBe('transferir a propriedade e encerrar a conta');
    // Ao Dono, pelo nome de quem recebe; a quem recebe, "o seu e-mail" e sem o "inclusive você".
    expect(oQuePassa('Ana')[1]).toContain('passam a ir para o e-mail de Ana');
    expect(oQuePassa('Ana')[2]).toBe('quem tem acesso: convidar, mudar o nível e tirar qualquer pessoa, inclusive você');
    expect(oQuePassa(null)[1]).toContain('passam a ir para o seu e-mail');
    expect(oQuePassa(null)[2]).toBe('quem tem acesso: convidar, mudar o nível e tirar qualquer pessoa');
    expect(CONTINUA).toContain('as aprovações em andamento');
  });
});
