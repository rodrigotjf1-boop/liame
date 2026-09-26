import { describe, expect, it } from 'vitest';
import { contagem, detalhesDe, envioDe } from '@/components/pessoas/textos';
import { diasAte, fimDoDia, iniciais, moeda, paraSeletor, quando, vencimento } from '@/lib/formato';

// Regras puras da tela "Pessoas e acessos": dinheiro em micros, datas relativas e frases do protótipo.

const agora = new Date(2026, 8, 26, 15, 0, 0); // 26/09/2026 15:00, fuso local
const local = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString();

describe('formatos pt-BR', () => {
  it('dinheiro chega em micros e sai em reais, sem centavos', () => {
    expect(moeda(500_000_000)).toBe('R$ 500');
    expect(moeda(1_250_000_000)).toBe('R$ 1.250');
  });

  it('último acesso: agora, hoje, ontem ou a data', () => {
    expect(quando(local(26, 14, 58), agora)).toBe('agora');
    expect(quando(local(26, 8, 10), agora)).toBe('hoje, 08:10');
    expect(quando(local(25, 21, 40), agora)).toBe('ontem, 21:40');
    expect(quando(local(20, 9, 0), agora)).toBe('20/09');
    expect(quando(new Date(2025, 11, 31, 9).toISOString(), agora)).toBe('31/12/2025');
  });

  it('vencimento do convite em dias de calendário', () => {
    expect(vencimento(local(26, 23), agora)).toBe('vence hoje');
    expect(vencimento(local(27, 1), agora)).toBe('vence amanhã');
    expect(vencimento(local(3 + 30, 12), agora)).toBe('vence em 7 dias');
    expect(diasAte(local(24, 12), agora)).toBe(-2);
  });

  it('data do seletor nativo vira o fim daquele dia no fuso de quem usa, e volta igual', () => {
    const iso = fimDoDia('2026-10-30');
    const d = new Date(iso);
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 30, 23, 59]);
    expect(paraSeletor(iso)).toBe('2026-10-30');
  });

  it('iniciais do nome ou do e-mail', () => {
    expect(iniciais('Juliana Prado')).toBe('JP');
    expect(iniciais('Rodrigo')).toBe('R');
    expect(iniciais('sofia.luz@example.com')).toBe('SL');
  });
});

describe('frases de "Pessoas e acessos"', () => {
  const base = {
    id: '0',
    user_id: '1',
    name: 'Juliana Prado',
    email: 'juliana@example.com',
    role: 'administrador' as const,
    approve_limit_micros: 500_000_000,
    dual_approval: true,
    billing_access: false,
    expires_at: null,
    invited_by_name: 'Rodrigo',
    created_at: local(20, 9),
    mfa_enabled: true,
    last_seen_at: null,
  };

  it('limite, aprovação dupla, cobrança e prazo, do ponto de vista do dono', () => {
    expect(detalhesDe(base, true)).toBe('aprova sozinho até R$ 500 por ação; acima disso, você também aprova · sem prazo');
    expect(detalhesDe({ ...base, approve_limit_micros: 0 }, true)).toBe('todo gasto passa também por você · sem prazo');
    expect(detalhesDe({ ...base, billing_access: true, expires_at: fimDoDia('2026-10-30') }, true)).toBe(
      'aprova sozinho até R$ 500 por ação; acima disso, você também aprova · vê e paga a cobrança · acesso até 30/10/2026',
    );
    expect(detalhesDe({ ...base, approve_limit_micros: null }, true)).toBe('aprova sem limite · sem prazo');
  });

  it('para quem não é o dono, "você" vira "o dono"', () => {
    expect(detalhesDe(base, false)).toBe('aprova sozinho até R$ 500 por ação; acima disso, o dono também aprova · sem prazo');
    expect(detalhesDe({ ...base, approve_limit_micros: 0 }, false)).toBe('todo gasto passa também pelo dono · sem prazo');
  });

  it('quem não aprova não mostra limite', () => {
    expect(detalhesDe({ ...base, role: 'somente_leitura', approve_limit_micros: null }, true)).toBe('sem prazo');
  });

  it('convite e contagem', () => {
    const convite = {
      id: '2',
      email: 'sofia@example.com',
      role: 'so_relatorios' as const,
      approve_limit_micros: null,
      dual_approval: true,
      billing_access: false,
      access_expires_at: null,
      expires_at: new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString(),
      invited_by_name: 'Rodrigo',
      created_at: new Date().toISOString(),
    };
    expect(envioDe(convite)).toBe('Convite enviado hoje · vence em 5 dias');
    expect(contagem(1, 0)).toBe('1 pessoa.');
    expect(contagem(3, 1)).toBe('3 pessoas e 1 convite esperando resposta.');
    expect(contagem(2, 2)).toBe('2 pessoas e 2 convites esperando resposta.');
  });
});
