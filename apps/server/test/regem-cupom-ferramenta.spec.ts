import { describe, expect, it } from 'vitest';
import { codigoDoRecurso } from '../src/actions/regem-cupom.js';
import { PlanoRecusado, TOOLS } from '../src/actions/tools.js';
import { classificar } from '../src/connectors/cliente-http.js';
import { evaluatePolicy, PLATFORM_POLICY } from '../src/policy/engine.js';

// A2.5 · F6 parte 2: a ferramenta `regem_cupom_criar` (plano puro), o recurso `cupom:CODIGO`, a regra da
// plataforma que manda a criação para aprovação e a leitura do tipo do problema que o Regem devolve.

const CAMPANHA = '0199a000-0000-7000-8000-0000000000c1';
const livre = { codigo: 'SEXTA15', existe: false, pode_criar: true };
const base = { codigo: 'SEXTA15', tipo: 'percentual', percentual: 15, valido_de: '2026-10-02', valido_ate: '2026-10-31', campaign_id: CAMPANHA, exclusive: true };

describe('ferramenta regem_cupom_criar', () => {
  const tool = TOOLS.regem_cupom_criar!;
  const planejar = (params: Record<string, unknown>, antes: Record<string, unknown> = livre) => tool.plan(antes, tool.params.parse(params));

  it('registro: risco baixo, só o Regem, com compensação declarada', () => {
    expect([tool.risk, tool.providers, tool.compensation]).toEqual(['R1', ['regem'], 'desativar_cupom']);
  });

  it('percentual: a regra vai como o contrato de cupons pede (texto com duas casas), sem mínimo quando é zero, e nada a reservar no orçamento de mídia', () => {
    const plano = planejar(base);
    expect(plano).toMatchObject({ action: 'cupom.criar', budgetImpact: 'none', valueMicros: null, reserveMicros: 0 });
    expect(plano.desiredState).toEqual({
      codigo: 'SEXTA15',
      existe: true,
      regra: { codigo: 'SEXTA15', nome: 'Campanha · SEXTA15', tipo: 'percentual', percentual: '15.00', valido_de: '2026-10-02', valido_ate: '2026-10-31' },
      campanha: { id: CAMPANHA, exclusivo: true },
    });
  });

  it('valor fixo e entrega grátis: só os campos do tipo; o nome e o pedido mínimo informados entram', () => {
    expect(planejar({ ...base, tipo: 'valor', percentual: undefined, valor_centavos: 1000, pedido_minimo_centavos: 5000, nome: 'Liame · Combo sexta' }).desiredState.regra).toEqual({
      codigo: 'SEXTA15',
      nome: 'Liame · Combo sexta',
      tipo: 'valor',
      valor_centavos: 1000,
      pedido_minimo_centavos: 5000,
      valido_de: '2026-10-02',
      valido_ate: '2026-10-31',
    });
    expect(planejar({ ...base, tipo: 'frete_gratis', percentual: undefined, exclusive: false }).desiredState).toMatchObject({
      regra: { tipo: 'frete_gratis' },
      campanha: { exclusivo: false },
    });
    expect(Object.keys(planejar({ ...base, tipo: 'frete_gratis', percentual: undefined }).desiredState.regra as object)).not.toContain('percentual');
  });

  it('o mesmo pedido dá o mesmo plano (a aprovação é amarrada ao hash dele)', () => {
    expect(planejar(base)).toEqual(planejar({ ...base }));
  });

  it('parâmetros fora da regra não passam', () => {
    const recusa = (over: Record<string, unknown>) => tool.params.safeParse({ ...base, ...over }).success;
    expect(recusa({})).toBe(true);
    expect(recusa({ codigo: 'sexta15' })).toBe(false);
    expect(recusa({ codigo: 'ABC' })).toBe(false);
    expect(recusa({ codigo: 'SEXTA-15' })).toBe(false);
    expect(recusa({ percentual: undefined })).toBe(false);
    expect(recusa({ percentual: 0 })).toBe(false);
    expect(recusa({ percentual: 101 })).toBe(false);
    expect(recusa({ percentual: 12.5 })).toBe(false);
    expect(recusa({ valor_centavos: 500 })).toBe(false);
    expect(recusa({ tipo: 'valor', percentual: undefined })).toBe(false);
    expect(recusa({ tipo: 'valor' })).toBe(false);
    expect(recusa({ tipo: 'frete_gratis' })).toBe(false);
    expect(recusa({ valido_ate: '2026-10-01' })).toBe(false);
    expect(recusa({ valido_de: '02/10/2026' })).toBe(false);
    expect(recusa({ campaign_id: 'c1' })).toBe(false);
    expect(recusa({ teto: 10 })).toBe(false);
  });

  it('recusa o plano quando o código já existe na loja, quando a loja não liberou a criação e quando o código não é o do recurso', () => {
    expect(() => planejar(base, { ...livre, existe: true })).toThrow(PlanoRecusado);
    expect(() => planejar(base, { ...livre, existe: true })).toThrow(/Já existe um cupom com este código/);
    expect(() => planejar(base, { ...livre, pode_criar: false })).toThrow(/Contas conectadas/);
    expect(() => planejar(base, { ...livre, codigo: 'OUTRO10' })).toThrow(PlanoRecusado);
  });
});

describe('recurso do cupom', () => {
  it('`cupom:CODIGO`, de 4 a 20 letras maiúsculas ou números', () => {
    expect(codigoDoRecurso('cupom:SEXTA15')).toBe('SEXTA15');
    expect(codigoDoRecurso('cupom:sexta15')).toBeNull();
    expect(codigoDoRecurso('cupom:ABC')).toBeNull();
    expect(codigoDoRecurso(`cupom:${'A'.repeat(21)}`)).toBeNull();
    expect(codigoDoRecurso('SEXTA15')).toBeNull();
    expect(codigoDoRecurso("cupom:A' OR '1")).toBeNull();
  });
});

describe('política da plataforma para a criação de cupom', () => {
  const proposta = (action: string) => ({
    tool: 'x',
    action,
    brand_id: null,
    provider: 'regem',
    account_id: 'a',
    risk_level: 'R1' as const,
    budget_impact: 'none' as const,
    value_micros: null,
    current_value_micros: null,
    categories: [],
    text: null,
    recent_count: 0,
  });
  const em = { at: new Date('2026-10-01T15:00:00Z'), timezone: 'America/Sao_Paulo' };

  it('`cupom.criar` pede aprovação mesmo sem regra da empresa; o resto continua em sombra', () => {
    // A regra do cupom entrou na versão 2 e segue na 3 (A4, X2), sem depender de quem pede.
    expect(PLATFORM_POLICY.version).toBe(3);
    expect(evaluatePolicy([PLATFORM_POLICY], proposta('cupom.criar'), em)).toMatchObject({ allowed: true, mode: 'APPROVAL', versions: ['plataforma@3'] });
    expect(evaluatePolicy([PLATFORM_POLICY], { ...proposta('cupom.criar'), actor: 'human' }, em)).toMatchObject({ mode: 'APPROVAL' });
    expect(evaluatePolicy([PLATFORM_POLICY], proposta('anuncio.pausar'), em)).toMatchObject({ mode: 'SHADOW' });
  });
});

describe('erro do Regem (RFC 9457)', () => {
  const h = new Headers();
  const problema = (tipo: string, status: number, detail?: string) => ({ type: `https://api.dmsregem.com/problemas/${tipo}`, title: 'x', status, ...(detail ? { detail } : {}) });

  it('o tipo do problema vira o código do provedor e o detalhe vira a mensagem', () => {
    const emUso = classificar('regem', 409, problema('codigo-em-uso', 409, 'O código X já existe'), h, null);
    expect([emUso.tipo, emUso.codigoProvider, emUso.message]).toEqual(['definitivo', 'codigo-em-uso', 'O código X já existe']);
    const regra = classificar('regem', 422, problema('regra-invalida', 422, 'Regra inválida — percentual: até 100.'), h, null);
    expect([regra.tipo, regra.codigoProvider, regra.message]).toEqual(['definitivo', 'regra-invalida', 'Regra inválida — percentual: até 100.']);
    expect(classificar('regem', 403, problema('escopo-insuficiente', 403), h, null)).toMatchObject({ tipo: 'permissao', codigoProvider: 'escopo-insuficiente' });
    expect(classificar('regem', 401, problema('token-invalido', 401), h, null)).toMatchObject({ tipo: 'autenticacao', codigoProvider: 'token-invalido' });
    expect(classificar('regem', 503, { type: 'about:blank', title: 'Indisponível', status: 503 }, h, null).tipo).toBe('transitorio');
  });

  it('o código próprio da Meta e do Google continua valendo antes do tipo do problema', () => {
    expect(classificar('meta_ads', 400, { error: { code: 100, message: 'Invalid parameter' }, type: 'https://x/y/outro' }, h, null).codigoProvider).toBe('100');
  });
});
