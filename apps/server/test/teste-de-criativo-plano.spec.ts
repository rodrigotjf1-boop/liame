import { describe, expect, it } from 'vitest';
import { PlanoRecusado, TOOLS } from '../src/actions/tools.js';
import { parametrosDoConjunto, parametrosDoCriativo } from '../src/campanhas/campanha-nova-plano.js';
import {
  chaveDoPassoDoTeste,
  criativoComoCampanhaNova,
  type EstadoDoTesteDeCriativo,
  linhaDoCupom,
  nomeDaCampanhaDeTeste,
  oQueImpedeOTeste,
  planoDeAtivarOTeste,
  planoDePausarOTeste,
  planoDoTesteDeCriativo,
  recursoDoTesteDeCriativo,
  testeDeCriativoDoRecurso,
  textoDoAnuncioDoTeste,
  verbaDeCadaCriativo,
} from '../src/campanhas/teste-de-criativo-plano.js';
import { chooseMode, PLATFORM_POLICY } from '../src/policy/engine.js';

// Plano da região, R8: o estado e os planos do teste de criativo (D-RG-76 a D-RG-80), sem rede e sem banco.

const TESTE = '0192f0a8-7c2e-7b11-9d3a-5f6e7a8b9c0d';
const DESCONTO = { tipo: 'percentual', percentual: 10, pedido_minimo_centavos: 0, valido_de: '2026-11-13', valido_ate: '2026-12-28' } as const;
const criativo = (letra: 'A' | 'B', peca: string, midia: string, texto: string, cupom: string) => ({
  letra,
  peca: { id: peca, versao: 1, titulo: `Título ${letra}`, texto, botao: 'pedir_agora' as const },
  texto_do_anuncio: textoDoAnuncioDoTeste(texto, cupom, DESCONTO),
  midia: { id: midia, tipo: 'foto' as const, arquivo: `arquivo-${letra}` },
  cupom: { codigo: cupom, situacao: 'a_criar' as const },
});
const estado = (o: Partial<EstadoDoTesteDeCriativo> = {}): EstadoDoTesteDeCriativo => ({
  teste: TESTE,
  marca: '0192f0a8-7c2e-7b11-9d3a-5f6e7a8b9c01',
  nome: 'Smash em dobro',
  objetivo: 'cardapio',
  criativos: [
    criativo('A', '0192f0a8-7c2e-7b11-9d3a-5f6e7a8b9c0a', '0192f0a8-7c2e-7b11-9d3a-5f6e7a8b9c1a', 'Peça o smash pelo cardápio.', 'SMASHFOTO'),
    criativo('B', '0192f0a8-7c2e-7b11-9d3a-5f6e7a8b9c0b', '0192f0a8-7c2e-7b11-9d3a-5f6e7a8b9c1b', 'O smash sai da chapa. Peça pelo cardápio.', 'SMASHVIDEO'),
  ],
  desconto: DESCONTO,
  pagina: { id: '1001', nome: 'Mister Burgers' },
  instagram: null,
  publico: null,
  loja: { id: '0192f0a8-7c2e-7b11-9d3a-5f6e7a8b9c02', nome: 'Loja Centro', latitude: -22.9, longitude: -43.17 },
  raio_km: 3,
  bairros: null,
  verba_diaria_micros: 40_000_000,
  moeda: 'BRL',
  fuso: 'America/Sao_Paulo',
  link: 'https://cardapio.exemplo.com.br/loja',
  dias: { minimo: 7, maximo: 28 },
  situacao: 'pedido',
  ativa: false,
  ...o,
});
const comCupons = (e: EstadoDoTesteDeCriativo, situacoes: [string, string]) =>
  ({ ...e, criativos: e.criativos.map((c, i) => ({ ...c, cupom: { ...c.cupom, situacao: situacoes[i] } })) }) as EstadoDoTesteDeCriativo;

describe('o recurso e as chaves do teste de criativo', () => {
  it('o recurso é `teste_de_criativo:<id>`, e só ele', () => {
    expect(recursoDoTesteDeCriativo(TESTE)).toBe(`teste_de_criativo:${TESTE}`);
    expect(testeDeCriativoDoRecurso(`teste_de_criativo:${TESTE}`)).toBe(TESTE);
    for (const outro of [`campanha_nova:${TESTE}`, `ritmo:${TESTE}`, 'teste_de_criativo:123', `teste_de_criativo:${TESTE}x`, '']) expect(testeDeCriativoDoRecurso(outro)).toBeNull();
  });

  it('a chave de idempotência de cada passo tem o texto literal (mudar o formato faria a Meta criar de novo)', () => {
    expect(chaveDoPassoDoTeste(TESTE, 'campanha')).toBe(`teste:${TESTE}:campanha`);
    expect(chaveDoPassoDoTeste(TESTE, 'conjunto:A')).toBe(`teste:${TESTE}:conjunto:A`);
    expect(chaveDoPassoDoTeste(TESTE, 'criativo:B')).toBe(`teste:${TESTE}:criativo:B`);
    expect(chaveDoPassoDoTeste(TESTE, 'anuncio:B')).toBe(`teste:${TESTE}:anuncio:B`);
  });
});

describe('o texto do anúncio com o cupom', () => {
  it('a linha do cupom diz o código, o desconto e o pedido mínimo, quando há', () => {
    expect(linhaDoCupom('SMASHFOTO', DESCONTO)).toBe('Cupom SMASHFOTO: 10% de desconto.');
    expect(linhaDoCupom('SMASH5', { tipo: 'valor', valor_centavos: 500, pedido_minimo_centavos: 3000, valido_de: '2026-11-13', valido_ate: '2026-12-28' })).toBe('Cupom SMASH5: R$ 5,00 de desconto em pedidos a partir de R$ 30,00.');
  });

  it('o texto é o da peça, uma linha em branco e a linha do cupom, sem cortar nada', () => {
    expect(textoDoAnuncioDoTeste('Peça o smash pelo cardápio.  \n', 'SMASHFOTO', DESCONTO)).toBe('Peça o smash pelo cardápio.\n\nCupom SMASHFOTO: 10% de desconto.');
  });
});

describe('o que impede o teste e os planos das ferramentas', () => {
  it('a metade da verba fecha em centavos, e cada criativo leva pelo menos R$ 10,00 por dia', () => {
    expect(verbaDeCadaCriativo(40_000_000)).toBe(20_000_000);
    expect(verbaDeCadaCriativo(40_010_000)).toBeNull();
    expect(oQueImpedeOTeste(estado())).toBeNull();
    expect(oQueImpedeOTeste(estado({ verba_diaria_micros: 40_010_000 }))).toMatch(/metade exata/);
    expect(oQueImpedeOTeste(estado({ verba_diaria_micros: 18_000_000 }))).toMatch(/R\$ 10,00 por dia/);
  });

  it('os dois criativos são diferentes, cada um com o seu cupom, e o texto do anúncio é o da peça com a linha do cupom', () => {
    const e = estado();
    const [a, b] = e.criativos;
    expect(oQueImpedeOTeste({ ...e, criativos: [a, { ...b, peca: { ...b.peca, id: a.peca.id }, midia: a.midia }] })).toMatch(/são iguais/);
    expect(oQueImpedeOTeste({ ...e, criativos: [a, { ...b, cupom: a.cupom, texto_do_anuncio: textoDoAnuncioDoTeste(b.peca.texto, a.cupom.codigo, DESCONTO) }] })).toMatch(/códigos não podem ser iguais/);
    expect(oQueImpedeOTeste({ ...e, criativos: [a, { ...b, texto_do_anuncio: 'Outro texto.' }] })).toMatch(/linha do cupom/);
    expect(oQueImpedeOTeste(estado({ raio_km: null }))).toMatch(/raio em volta da loja ou os bairros/);
  });

  it('criar: só o teste pedido vira `criando`; o resto não volta a ser pedido', () => {
    expect(planoDoTesteDeCriativo(estado())).toMatchObject({ ok: true, desejado: { situacao: 'criando', ativa: false } });
    for (const situacao of ['criando', 'pronto', 'rodando', 'terminado', 'encerrado', 'interrompido', 'cancelado'] as const) expect(planoDoTesteDeCriativo(estado({ situacao })).ok).toBe(false);
    expect(planoDoTesteDeCriativo({ qualquer: 'coisa' })).toEqual({ ok: false, motivo: 'Esta ferramenta é para um teste de criativo do Liame.' });
  });

  it('ativar: só o teste pronto, com os DOIS cupons criados; pausar: só o que está ativo', () => {
    const pronto = comCupons(estado({ situacao: 'pronto' }), ['criado', 'criado']);
    expect(planoDeAtivarOTeste(pronto)).toMatchObject({ ok: true, desejado: { ativa: true, situacao: 'rodando' } });
    expect(planoDeAtivarOTeste(comCupons(estado({ situacao: 'pronto' }), ['criado', 'pedido']))).toMatchObject({ ok: false, motivo: expect.stringMatching(/dois cupons/) });
    expect(planoDeAtivarOTeste(comCupons(estado({ situacao: 'criando' }), ['criado', 'criado'])).ok).toBe(false);
    expect(planoDeAtivarOTeste({ ...pronto, ativa: true }).ok).toBe(false);
    expect(planoDePausarOTeste({ ...pronto, situacao: 'rodando', ativa: true })).toMatchObject({ ok: true, desejado: { ativa: false } });
    expect(planoDePausarOTeste(pronto).ok).toBe(false);
  });
});

describe('os objetos do teste na Meta', () => {
  it('cada criativo vira um conjunto com a metade da verba e o mesmo público, e o anúncio leva o texto com o cupom', () => {
    const e = estado();
    const [a, b] = [criativoComoCampanhaNova(e, 'A'), criativoComoCampanhaNova(e, 'B')];
    expect([a.nome, b.nome]).toEqual(['Smash em dobro · A', 'Smash em dobro · B']);
    expect([a.verba_diaria_micros, b.verba_diaria_micros, a.fim]).toEqual([20_000_000, 20_000_000, null]);
    const [ca, cb] = [parametrosDoConjunto(a, '1'), parametrosDoConjunto(b, '1')];
    expect([ca.daily_budget, cb.daily_budget, ca.status]).toEqual(['2000', '2000', 'PAUSED']);
    expect(ca.targeting).toBe(cb.targeting);
    expect(parametrosDoCriativo(a, { tipo: 'foto', imagem: 'https://exemplo.test/a.jpg' }).object_story_spec).toContain('Cupom SMASHFOTO: 10% de desconto.');
    expect(nomeDaCampanhaDeTeste('Smash em dobro')).toBe('Teste · Smash em dobro');
  });
});

describe('as ferramentas e a política do teste de criativo', () => {
  it('as três ferramentas: a aprovação, a rota, a função e o que cada uma reserva', () => {
    const [criar, ativar, pausar] = [TOOLS.teste_de_criativo_criar!, TOOLS.teste_de_criativo_ativar!, TOOLS.teste_de_criativo_pausar!];
    expect([criar, ativar, pausar].map((t) => [t.risk, t.providers, t.flag, t.onlyByRoute ?? false, t.alwaysApproval ?? false, t.directByPerson ?? false, t.undo === undefined])).toEqual([
      ['R2', ['meta_ads'], 'teste_de_criativo', true, true, false, true],
      ['R2', ['meta_ads'], 'teste_de_criativo', true, true, false, true],
      ['R1', ['meta_ads'], 'teste_de_criativo', true, false, true, true],
    ]);
    expect(criar.plan(estado(), {})).toMatchObject({ action: 'teste.criar', budgetImpact: 'none', reserveMicros: 0 });
    const pronto = comCupons(estado({ situacao: 'pronto' }), ['criado', 'criado']);
    // Ativar reserva a verba do teste INTEIRO.
    expect(ativar.plan(pronto, {})).toMatchObject({ action: 'teste.ativar', budgetImpact: 'new_spend', valueMicros: 40_000_000, reserveMicros: 40_000_000 });
    expect(() => ativar.plan(comCupons(estado({ situacao: 'pronto' }), ['criado', 'falhou']), {})).toThrow(PlanoRecusado);
    expect(pausar.plan({ ...pronto, situacao: 'rodando', ativa: true }, {})).toMatchObject({ action: 'teste.pausar', budgetImpact: 'decrease', reserveMicros: 0 });
  });

  it('a política da distribuição (versão 17): o teste pede aprovação; pausar sai direto só para uma pessoa, na Meta', () => {
    const proposta = (action: string, actor: 'human' | 'agent', provider = 'meta_ads') => ({ action, provider, actor, riskLevel: 'R2' as const, budgetImpact: 'none' as const, valueMicros: null, currentValueMicros: null });
    expect(PLATFORM_POLICY.version).toBe(17);
    for (const acao of ['teste.criar', 'teste.ativar']) {
      for (const actor of ['human', 'agent'] as const) expect(chooseMode([PLATFORM_POLICY], proposta(acao, actor) as never).mode, `${acao} ${actor}`).toBe('APPROVAL');
    }
    expect(chooseMode([PLATFORM_POLICY], proposta('teste.pausar', 'human') as never).mode).toBe('AUTO');
    expect(chooseMode([PLATFORM_POLICY], proposta('teste.pausar', 'agent') as never).mode).toBe('APPROVAL');
    expect(chooseMode([PLATFORM_POLICY], proposta('teste.pausar', 'human', 'google_ads') as never).mode).toBe('APPROVAL');
  });
});
