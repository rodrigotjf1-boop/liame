import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/actions/tools.js';
import { type EstadoDoRitmo, planoDoRitmo, recursoDoRitmo, ritmoDoRecurso, somasDoRitmo } from '../src/campanhas/ritmo-plano.js';
import { PLATFORM_POLICY } from '../src/policy/engine.js';

// R7, parte 1b (D-RG-58, D-RG-60 e D-RG-62), sem rede e sem banco: o recurso do pedido semanal, o plano da ferramenta
// `ritmo_da_semana` (o pedido vira aprovado; o que já foi decidido não volta; a tabela fora dos limites não vira plano),
// a ferramenta no registro (sempre com uma pessoa, sem reservar verba) e as regras novas da política da distribuição.

const ID = '0190d2b0-0000-7000-8000-0000000000a1';
const estado = (o: Partial<EstadoDoRitmo> = {}): EstadoDoRitmo => ({
  ritmo: ID,
  marca: '0190d2b0-0000-7000-8000-0000000000b1',
  loja: { id: '0190d2b0-0000-7000-8000-0000000000c1', nome: 'Loja Centro' },
  semana: { de: '2026-10-05', ate: '2026-10-11' },
  fonte: 'loja',
  dias: ['05', '06', '07', '08', '09', '10', '11'].map((d, i) => ({
    dia: `2026-10-${d}`,
    dia_da_semana: (i + 1) % 7,
    peso: [0.9, 0.84, 0.92, 1, 1.09, 1.18, 1.07][i]!,
    porques: [{ kind: 'pedidos' as const, share_pct: 14, text: null, min: null, max: null, eve: null }],
  })),
  campanhas: [
    { recurso: 'campanha:120210000000001', nome: 'Combo sexta', base_micros: 60_000_000, dias_micros: [54_000_000, 50_400_000, 55_200_000, 60_000_000, 65_400_000, 70_800_000, 64_200_000] },
    { recurso: 'conjunto:120210000000002', nome: 'Delivery noite · raio de 3 km', base_micros: 18_000_000, dias_micros: [16_200_000, 15_120_000, 16_560_000, 18_000_000, 19_620_000, 21_240_000, 19_260_000] },
  ],
  fora: [{ nome: 'Campanha pequena', motivo: 'verba_pequena' }],
  teto_micros: 80_000_000,
  moeda: 'BRL',
  situacao: 'pedido',
  ...o,
});

describe('o ritmo da semana como pedido (R7, parte 1b)', () => {
  it('o recurso do pedido: `ritmo:<id>`, e só ele', () => {
    expect(recursoDoRitmo(ID)).toBe(`ritmo:${ID}`);
    expect(ritmoDoRecurso(`ritmo:${ID}`)).toBe(ID);
    expect(ritmoDoRecurso(`campanha_nova:${ID}`)).toBeNull();
    expect(ritmoDoRecurso('ritmo:123')).toBeNull();
    expect(ritmoDoRecurso('campanha:120210000000001')).toBeNull();
  });

  it('o plano: o pedido vira aprovado; o que já foi decidido não volta a ser pedido', () => {
    const p = planoDoRitmo(estado());
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.desejado).toEqual({ ...estado(), situacao: 'aprovado' });
    expect(planoDoRitmo(estado({ situacao: 'aprovado' }))).toEqual({ ok: false, motivo: 'Este ritmo já foi aprovado.' });
    expect(planoDoRitmo(estado({ situacao: 'parado' })).ok).toBe(false);
    expect(planoDoRitmo(estado({ situacao: 'encerrado' })).ok).toBe(false);
    expect(planoDoRitmo(estado({ situacao: 'cancelado' })).ok).toBe(false);
    expect(planoDoRitmo({ qualquer: 'coisa' })).toEqual({ ok: false, motivo: 'Esta ferramenta é para um ritmo da semana do Liame.' });
  });

  it('a tabela fora dos limites do dinheiro não vira plano: mais de 10% num dia, acima do teto, a semana gastando mais', () => {
    const [c1, c2] = estado().campanhas as [EstadoDoRitmo['campanhas'][number], EstadoDoRitmo['campanhas'][number]];
    const com = (dias: number[]) => estado({ campanhas: [{ ...c1, dias_micros: dias }, c2] });
    const salto = planoDoRitmo(com([54_000_000, 50_400_000, 55_200_000, 60_000_000, 68_000_000, 70_800_000, 64_200_000]));
    expect(salto).toEqual({ ok: false, motivo: 'A verba da campanha "Combo sexta" sai dos limites do ritmo (dia 5: muda mais de 10%).' });
    expect(planoDoRitmo(estado({ teto_micros: 70_000_000 })).ok).toBe(false);
    expect(planoDoRitmo(com([60_000_000, 60_000_000, 60_000_000, 60_000_000, 62_000_000, 62_000_000, 60_000_000])).ok).toBe(false);
    // Sete dias e de 1 a 30 campanhas: o estado fora do formato não é um ritmo.
    expect(planoDoRitmo({ ...estado(), campanhas: [] }).ok).toBe(false);
    expect(planoDoRitmo({ ...estado(), dias: estado().dias.slice(0, 6) }).ok).toBe(false);
    expect(planoDoRitmo({ ...estado(), campanhas: [{ ...c1, recurso: 'anuncio:1' }] }).ok).toBe(false);
  });

  it('as somas: a semana com o ritmo não passa da semana sem ele', () => {
    expect(somasDoRitmo(estado())).toEqual({ comRitmo: 546_000_000, semRitmo: 546_000_000 });
  });

  it('a ferramenta: só na Meta, sempre com uma pessoa, sem reservar verba e com a função própria', () => {
    const t = TOOLS.ritmo_da_semana!;
    expect([t.risk, t.providers, t.alwaysApproval, t.flag, t.compensation]).toEqual(['R2', ['meta_ads'], true, 'ritmo_da_semana', 'parar_o_ritmo']);
    // Só a rotina do Gestor de tráfego pede (uma pessoa aprova ou recusa); é a única ferramenta assim.
    expect(Object.values(TOOLS).filter((x) => x.onlyByAgent).map((x) => x.name)).toEqual(['ritmo_da_semana']);
    expect(t.plan(estado() as never, {})).toMatchObject({ action: 'ritmo.aprovar', budgetImpact: 'none', reserveMicros: 0, valueMicros: null });
    expect(() => t.plan(estado({ situacao: 'aprovado' }) as never, {})).toThrow('Este ritmo já foi aprovado.');
  });

  it('a política da distribuição (v15): o ritmo sempre em Aprovação; o automático só nas ações próprias do passo, e só para o funcionário de IA', () => {
    expect(PLATFORM_POLICY.version).toBe(15);
    const autonomia = PLATFORM_POLICY.document.rules.filter((r) => r.type === 'autonomy');
    expect(autonomia.filter((r) => r.action === 'ritmo.*')).toEqual([{ type: 'autonomy', action: 'ritmo.*', mode: 'APPROVAL' }]);
    expect(autonomia.filter((r) => r.action?.startsWith('orcamento.'))).toEqual([
      { type: 'autonomy', action: 'orcamento.ritmo_aumentar', actor: 'agent', mode: 'AUTO' },
      { type: 'autonomy', action: 'orcamento.ritmo_reduzir', actor: 'agent', mode: 'AUTO' },
    ]);
    // O que a regra nova NÃO liga (D-A7-11): nenhuma regra automática alcança o pedido de verba comum.
    expect(autonomia.some((r) => (r.mode === 'AUTO' || r.mode === 'LIMITED_AUTO') && ['orcamento.*', 'orcamento.aumentar', 'orcamento.reduzir'].includes(r.action ?? ''))).toBe(false);
  });
});
