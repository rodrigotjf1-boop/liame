import { describe, expect, it } from 'vitest';
import { PlanoRecusado, regraDoCupomDosParametros, saiPorDecisaoJaTomada, TOOLS } from '../src/actions/tools.js';
import { parametrosDoCupomDoTeste } from '../src/campanhas/teste-portao.js';
import { chooseMode, PLATFORM_POLICY } from '../src/policy/engine.js';

// Plano da região, R8: o cupom de um criativo do teste de criativo (D-RG-77), sem rede e sem banco. A ferramenta
// `cupom_do_teste` é a irmã do `regem_cupom_criar`: a mesma regra no Regem, sem a campanha, e só pela rotina dos testes,
// pelo teste que uma pessoa aprovou. O caminho inteiro, com o Regem de mentira, está em `test/db/cupom-regem-criar.spec.ts`.

const TESTE = '0192f0a8-7c2e-7b11-9d3a-5f6e7a8b9c0d';
const EM_PORCENTO = { tipo: 'percentual', percentual: 10, pedido_minimo_centavos: 0, valido_de: '2026-11-13', valido_ate: '2026-12-28' } as const;
const EM_VALOR = { tipo: 'valor', valor_centavos: 500, pedido_minimo_centavos: 3000, valido_de: '2026-11-13', valido_ate: '2026-12-28' } as const;
const loja = (o: Record<string, unknown> = {}) => ({ codigo: 'SMASHFOTO', existe: false, pode_criar: true, ...o });

describe('os parâmetros e a regra do cupom do teste', () => {
  it('saem do teste aprovado: o código, o nome com o teste e a letra, o desconto e a validade', () => {
    const p = parametrosDoCupomDoTeste({ id: TESTE, nome: 'Smash em dobro', desconto: EM_PORCENTO }, 'A', 'SMASHFOTO');
    expect(p).toEqual({ teste: TESTE, letra: 'A', codigo: 'SMASHFOTO', nome: 'Teste · Smash em dobro · A', tipo: 'percentual', percentual: 10, pedido_minimo_centavos: 0, valido_de: '2026-11-13', valido_ate: '2026-12-28' });
    // A regra como o Regem recebe: o percentual com duas casas, e sem o pedido mínimo quando ele é zero.
    expect(regraDoCupomDosParametros(p)).toEqual({ codigo: 'SMASHFOTO', nome: 'Teste · Smash em dobro · A', tipo: 'percentual', percentual: '10.00', valido_de: '2026-11-13', valido_ate: '2026-12-28' });
    const emValor = parametrosDoCupomDoTeste({ id: TESTE, nome: 'Smash em dobro', desconto: EM_VALOR }, 'B', 'SMASH5');
    expect(regraDoCupomDosParametros(emValor)).toEqual({ codigo: 'SMASH5', nome: 'Teste · Smash em dobro · B', tipo: 'valor', valor_centavos: 500, pedido_minimo_centavos: 3000, valido_de: '2026-11-13', valido_ate: '2026-12-28' });
  });

  it('o que não é um cupom do teste não tem regra', () => {
    const p = parametrosDoCupomDoTeste({ id: TESTE, nome: 'Smash em dobro', desconto: EM_PORCENTO }, 'A', 'SMASHFOTO');
    expect(regraDoCupomDosParametros({ ...p, percentual: undefined })).toBeNull();
    expect(regraDoCupomDosParametros({ ...p, valor_centavos: 500 })).toBeNull();
    expect(regraDoCupomDosParametros({ ...p, codigo: 'com espaço' })).toBeNull();
    expect(regraDoCupomDosParametros({ ...p, letra: 'C' })).toBeNull();
    expect(regraDoCupomDosParametros({ ...p, campaign_id: TESTE })).toBeNull();
    expect(regraDoCupomDosParametros({ ...p, valido_ate: '2026-11-01' })).toBeNull();
  });
});

describe('a ferramenta `cupom_do_teste` e a política', () => {
  const t = TOOLS.cupom_do_teste!;
  const p = parametrosDoCupomDoTeste({ id: TESTE, nome: 'Smash em dobro', desconto: EM_PORCENTO }, 'A', 'SMASHFOTO');

  it('o registro: no Regem, pela decisão do teste, com a função do teste; o cupom de campanha continua pedindo aprovação', () => {
    expect([t.risk, t.providers, t.compensation, t.decisaoJaTomada, t.flag, t.alwaysApproval ?? false, t.undo === undefined]).toEqual(['R1', ['regem'], 'desativar_cupom', 'teste', 'teste_de_criativo', false, true]);
    expect(saiPorDecisaoJaTomada(t)).toBe(true);
    expect(saiPorDecisaoJaTomada(TOOLS.regem_cupom_criar)).toBe(false);
    expect(Object.values(TOOLS).filter((x) => x.decisaoJaTomada === 'teste').map((x) => x.name)).toEqual(['cupom_do_teste']);
  });

  it('o plano: o cupom nasce sem campanha, com o teste e a letra; as mesmas recusas do cupom de campanha', () => {
    expect(t.plan(loja(), p)).toMatchObject({
      action: 'cupom.criar_do_teste',
      budgetImpact: 'none',
      reserveMicros: 0,
      desiredState: { codigo: 'SMASHFOTO', existe: true, campanha: null, teste: { id: TESTE, letra: 'A' }, regra: { codigo: 'SMASHFOTO', tipo: 'percentual', percentual: '10.00' } },
    });
    expect(() => t.plan(loja({ codigo: 'OUTRO1' }), p)).toThrow(PlanoRecusado);
    expect(() => t.plan(loja({ pode_criar: false }), p)).toThrow(/não liberou/);
    expect(() => t.plan(loja({ existe: true }), p)).toThrow(/Já existe um cupom/);
    // A mesma regra que o cupom de campanha montaria com o mesmo desconto: a escrita no Regem é a mesma.
    const deCampanha = TOOLS.regem_cupom_criar!.plan(loja(), { codigo: 'SMASHFOTO', nome: 'Teste · Smash em dobro · A', tipo: 'percentual', percentual: 10, valido_de: '2026-11-13', valido_ate: '2026-12-28', campaign_id: TESTE, exclusive: true });
    expect((t.plan(loja(), p).desiredState as { regra: unknown }).regra).toEqual((deCampanha.desiredState as { regra: unknown }).regra);
  });

  it('o cupom de campanha continua exigindo a campanha, e os parâmetros dele não aceitam o teste', () => {
    const deCampanha = { codigo: 'SMASHFOTO', tipo: 'percentual', percentual: 10, valido_de: '2026-11-13', valido_ate: '2026-12-28', campaign_id: TESTE, exclusive: true };
    const criar = TOOLS.regem_cupom_criar!;
    expect(criar.params.safeParse(deCampanha).success).toBe(true);
    // Sem a campanha, os parâmetros não passam: o plano nem chega a ser montado.
    const { campaign_id: _campanha, ...semCampanha } = deCampanha;
    expect(criar.params.safeParse(semCampanha).success).toBe(false);
    expect(() => criar.plan(loja(), semCampanha)).toThrow();
    // O esquema é estrito: `teste` e `letra` são de outra ferramenta.
    expect(criar.params.safeParse({ ...deCampanha, teste: TESTE, letra: 'A' }).success).toBe(false);
    // O estado que o plano dele deixa sempre traz a campanha, e nunca o teste.
    const estado = criar.plan(loja(), deCampanha).desiredState as { campanha: unknown; teste?: unknown };
    expect(estado.campanha).toEqual({ id: TESTE, exclusivo: true });
    expect(estado.teste).toBeUndefined();
  });

  it('a política da distribuição (versão 17): automático só para o funcionário, só no Regem; o cupom de campanha segue em Aprovação', () => {
    const proposta = (action: string, actor: 'human' | 'agent', provider = 'regem') => ({ action, provider, actor, riskLevel: 'R1' as const, budgetImpact: 'none' as const, valueMicros: null, currentValueMicros: null });
    expect(PLATFORM_POLICY.version).toBe(17);
    expect(chooseMode([PLATFORM_POLICY], proposta('cupom.criar_do_teste', 'agent') as never).mode).toBe('AUTO');
    expect(chooseMode([PLATFORM_POLICY], proposta('cupom.criar_do_teste', 'human') as never).mode).not.toBe('AUTO');
    expect(chooseMode([PLATFORM_POLICY], proposta('cupom.criar_do_teste', 'agent', 'meta_ads') as never).mode).not.toBe('AUTO');
    for (const actor of ['human', 'agent'] as const) expect(chooseMode([PLATFORM_POLICY], proposta('cupom.criar', actor) as never).mode, actor).toBe('APPROVAL');
  });
});
