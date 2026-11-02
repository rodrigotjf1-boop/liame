import type { AccountRecovery } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { emAndamento, etapas, MOTIVOS, porQueNaoPode, problemaDoDocumento } from '../src/components/entrada/recuperacao-textos';

// A recuperação da conta do Dono na entrada (A7, W8, parte 5; P34 aprovado; D-A7-62, D-A7-64): o andamento em etapas de
// cada situação, o documento conferido antes de enviar e por que não dá para pedir.

const AGORA = new Date('2026-11-02T15:00:00Z');
const base: AccountRecovery = {
  id: 'r1',
  protocol: 'REC-2026-0042',
  status: 'pedido',
  reason: 'perdi_celular_e_codigos',
  companies: [{ name: 'Mister Burgers', cnpj: '11222333000181' }],
  created_at: '2026-11-02T11:40:00Z',
  checked_at: null,
  applies_at: null,
  refusal_reason: null,
  cancelled_by: null,
  closed_at: null,
};
const situacoes = (r: AccountRecovery) => etapas(r, AGORA).map((e) => `${e.situacao}:${e.titulo}`);

describe('a recuperação da conta na entrada', () => {
  it('o andamento de cada situação, como o P34', () => {
    expect(situacoes(base)).toEqual(['feito:Pedido recebido', 'agora:Conferência da DMS', 'depois:Espera de segurança', 'depois:Cadastrar o app novo']);
    expect(etapas(base, AGORA)[0]!.texto).toMatch(/^hoje, \d{2}:\d{2}$/);
    const conferido = { ...base, status: 'conferido' as const, checked_at: '2026-11-02T12:00:00Z', applies_at: '2026-11-09T12:00:00Z' };
    expect(situacoes(conferido)).toEqual(['feito:Pedido recebido', 'feito:Conferência da DMS', 'agora:Espera de segurança', 'depois:Cadastrar o app novo']);
    expect(etapas(conferido, AGORA)[2]!.texto).toContain('Avisamos o seu e-mail e os Administradores');
    expect(situacoes({ ...conferido, status: 'parado', applies_at: null })).toEqual(['feito:Pedido recebido', 'feito:Conferência da DMS', 'parado:Pedido parado']);
    expect(situacoes({ ...conferido, status: 'aplicado', closed_at: '2026-11-09T12:05:00Z' })).toEqual([
      'feito:Pedido recebido',
      'feito:Conferência da DMS',
      'feito:Espera de segurança',
      'agora:Cadastrar o app novo',
    ]);
    const recusado = etapas({ ...base, status: 'recusado', refusal_reason: 'O nome não está no quadro de sócios.', closed_at: '2026-11-02T14:00:00Z' }, AGORA);
    expect(recusado.map((e) => e.titulo)).toEqual(['Pedido recebido', 'Pedido recusado pela DMS']);
    expect(recusado[1]!.texto).toBe('O nome não está no quadro de sócios.');
    // Cancelado: por você, ou sozinho quando entrou com o app ou com um código.
    const porVoce = etapas({ ...base, status: 'cancelado', cancelled_by: 'voce', closed_at: '2026-11-02T14:00:00Z' }, AGORA);
    expect(porVoce.at(-1)!.texto).toMatch(/^Hoje, \d{2}:\d{2}, por você\. Nada mudou na sua conta\.$/);
    const caiu = etapas({ ...base, status: 'cancelado', cancelled_by: 'entrou', closed_at: '2026-11-02T14:00:00Z' }, AGORA);
    expect(caiu.at(-1)!.texto).toContain('você entrou com o app ou com um código, e o pedido caiu sozinho');
  });

  it('em andamento: pedido, conferido e parado; o resto terminou', () => {
    expect(emAndamento(null)).toBe(false);
    for (const s of ['pedido', 'conferido', 'parado'] as const) expect(emAndamento({ ...base, status: s })).toBe(true);
    for (const s of ['aplicado', 'recusado', 'cancelado'] as const) expect(emAndamento({ ...base, status: s })).toBe(false);
  });

  it('o documento: JPG, PNG ou PDF, de 1 byte a 10 MB', () => {
    expect(problemaDoDocumento(null)).toBe('Mande o seu documento com foto.');
    expect(problemaDoDocumento({ type: 'image/heic', size: 100 })).toBe('Mande o documento em JPG, PNG ou PDF.');
    expect(problemaDoDocumento({ type: 'application/pdf', size: 10 * 1024 * 1024 + 1 })).toContain('passa de 10 MB');
    expect(problemaDoDocumento({ type: 'image/png', size: 0 })).toContain('vazio');
    expect(problemaDoDocumento({ type: 'image/jpeg', size: 2048 })).toBeNull();
    expect(MOTIVOS.map((m) => m.valor)).toEqual(['perdi_celular_e_codigos', 'celular_roubado_ou_quebrado', 'outro']);
  });

  it('por que não dá para pedir, com o suporte quando é o caminho', () => {
    expect(porQueNaoPode(null, 'suporte@exemplo.com')).toBeNull();
    expect(porQueNaoPode('pedido-em-andamento', 'suporte@exemplo.com')).toBeNull();
    expect(porQueNaoPode('nao-e-dono', 'suporte@exemplo.com')?.texto).toBe('Sem o celular e sem os códigos, fale com o suporte: suporte@exemplo.com.');
    expect(porQueNaoPode('indisponivel', 'suporte@exemplo.com')?.texto).toContain('suporte@exemplo.com');
    expect(porQueNaoPode('ja-entrou', 'suporte@exemplo.com')?.texto).toContain('Segurança da conta');
  });
});
