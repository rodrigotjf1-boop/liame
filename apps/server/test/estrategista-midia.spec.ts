import { PlanContent } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { indiceDasOrigens } from '../src/ai/conversa/fontes.js';
import { contextoDoPlano, type DadosDoPlano, origensDoPlano, permitidoNoContexto } from '../src/ai/estrategista/contexto.js';
import {
  aneisDoRaio,
  comAVerba,
  dividir,
  HORARIOS_DO_SETOR,
  horariosDaLoja,
  type LojaDaMidia,
  permitidoDaMidia,
  problemaDoFunil,
} from '../src/ai/estrategista/midia.js';
import { marcarPlano, propostaDoPlano, textosDoPlano } from '../src/ai/estrategista/plano.js';
import { conferirEdicao, conferirPlano, conteudoDaResposta, type PermitidosNoPlano, respostaDoConteudo } from '../src/ai/estrategista/resposta.js';
import { demandaDaLoja, type LinhaDaDemanda } from '../src/regiao/demanda.js';

// O plano de mídia por região do Estrategista (plano da região, R5; P45; D-RG-26 a D-RG-31): os anéis, o dinheiro de
// cada anel, os horários e as regras do funil são do código; o modelo escolhe a parte de cada etapa e escreve o criativo.

const HOJE = '2026-11-12';
const VERBA = { meta: 860, google: 0 };
const linha = (dow: number, hora: number, pedidos: number): LinhaDaDemanda => ({ janela: 'atual', dow, hora, pedidos, receita: pedidos * 40_000_000, novos: 0, de_volta: pedidos });

// 42 pedidos: sexta e sábado à noite, o almoço de domingo e um pouco na quarta e na quinta.
const DEMANDA = demandaDaLoja(
  [linha(5, 19, 4), linha(5, 20, 6), linha(5, 21, 4), linha(6, 20, 6), linha(6, 21, 5), linha(6, 22, 3), linha(0, 12, 3), linha(0, 13, 3), linha(3, 20, 3), linha(4, 21, 5)],
  HOJE,
);
const TIJUCA: LojaDaMidia = { unitId: '0195f3a0-0000-7000-8000-000000000001', nome: 'Mister Burgers Tijuca', bairro: 'Tijuca', municipio: 'Rio de Janeiro', raioKm: 3, demanda: DEMANDA };
const PENHA: LojaDaMidia = { unitId: '0195f3a0-0000-7000-8000-000000000002', nome: 'Mister Burgers Penha', bairro: 'Penha', municipio: 'Rio de Janeiro', raioKm: 2, demanda: null };

const etapas = (partes: [number, number, number, number], criativos: Partial<Record<number, string>> = {}) => ({
  etapas: [
    { etapa: 'reconhecimento', parte: partes[0], criativo: criativos[0] ?? 'Vídeo curto do smash na chapa, para quem ainda não conhece a loja.' },
    { etapa: 'seguidores', parte: partes[1], criativo: criativos[1] ?? 'Os bastidores da cozinha e o novo no cardápio.' },
    { etapa: 'cardapio_conversa', parte: partes[2], criativo: criativos[2] ?? 'O combo para dividir, com o botão do cardápio e o do WhatsApp.' },
    { etapa: 'pedido', parte: partes[3], criativo: criativos[3] ?? 'O combo da noite com o cupom da campanha, para quem já visitou o cardápio.' },
  ],
});
const noventa = (extra: Record<string, unknown> = {}) => ({
  resumo: 'Em três meses: anúncios no raio de entrega, com a verba nas noites mais fortes.',
  porques: ['O raio de entrega é de 3 km.'],
  risco: 'medio',
  risco_motivo: 'pede verba nova na Meta.',
  fazer: ['Na Meta, deixe a verba do mês em R$ 1.000,00.'],
  depois: 'A revisão de segunda mostra o que veio no caixa.',
  objetivos: [{ objetivo: 'Mais pedidos no raio', como_saber: 'Os pedidos confirmados na revisão de cada segunda.' }],
  meses: [{ mes: 'Novembro', plano: 'Anúncios no núcleo nas noites de sexta e sábado.' }],
  verba_proposta: { meta: 1000, google: 300 },
  datas: [],
  midia: etapas([15, 10, 30, 45]),
  ...extra,
});
const conteudo = (bruto: unknown, regiao: LojaDaMidia[] | null = [TIJUCA]): Extract<PlanContent, { kind: 'noventa_dias' }> => {
  const r = conteudoDaResposta('noventa_dias', bruto, VERBA, regiao);
  if (!r.ok) throw new Error(`fora do formato: ${r.detalhe.join(' | ')}`);
  if (r.content.kind !== 'noventa_dias') throw new Error('tipo');
  return r.content;
};
const dados = (regiao: LojaDaMidia[] | null, kind: DadosDoPlano['kind'] = 'noventa_dias'): DadosDoPlano => ({
  kind,
  hoje: HOJE,
  marca: { id: '0195f3a0-0000-7000-8000-0000000000aa', nome: 'Mister Burgers', fuso: 'America/Sao_Paulo' },
  dossie: null,
  fatos: null,
  calendario: [],
  verbaDeHoje: VERBA,
  semana: { from: '2026-11-05', to: '2026-11-11' },
  pedido: null,
  anterior: null,
  regiao,
});
const permitidos = (regiao: LojaDaMidia[]): PermitidosNoPlano => ({
  hoje: HOJE,
  calendario: [],
  cupons: [],
  emDia: [permitidoNoContexto(dados(regiao))],
  velhas: [],
  nomes: ['Mister Burgers', ...regiao.map((l) => l.nome)],
});

describe('os anéis, o dinheiro de cada anel e os horários são contas do código (D-RG-27, D-RG-29)', () => {
  it('o raio acima de 2 km vira núcleo (60%) e expansão (40%); até 2 km, um anel só, com tudo', () => {
    expect(aneisDoRaio(3)).toEqual([
      { ring: 'nucleo', from_km: 0, to_km: 2, share: 60 },
      { ring: 'expansao', from_km: 2, to_km: 3, share: 40 },
    ]);
    expect(aneisDoRaio(2)).toEqual([{ ring: 'nucleo', from_km: 0, to_km: 2, share: 100 }]);
    expect(aneisDoRaio(1.5)).toEqual([{ ring: 'nucleo', from_km: 0, to_km: 1.5, share: 100 }]);
  });

  it('a divisão em reais inteiros pelo maior resto soma exatamente o total', () => {
    expect(dividir(1000, [60, 40, 100])).toEqual([300, 200, 500]);
    expect(dividir(1001, [60, 40])).toEqual([601, 400]);
    expect(dividir(7, [1, 1, 1])).toEqual([3, 2, 2]);
    expect(dividir(0, [60, 40])).toEqual([0, 0]);
    for (const total of [1, 99, 1234, 9_999_999]) expect(dividir(total, [60, 40, 60, 40, 100]).reduce((t, n) => t + n, 0)).toBe(total);
  });

  it('os horários saem dos pedidos da loja: os dias acima da média e o bloco de 4 horas, com a parte de cada um', () => {
    expect(horariosDaLoja(DEMANDA)).toEqual({
      source: 'loja',
      // Sexta e sábado (14 pedidos cada) passam da média (42 ÷ 7 = 6); o domingo (6) empata com ela e fica de fora.
      days: [5, 6],
      from: '19:00',
      to: '23:00',
      ads_from: '18:00',
      days_share: 67,
      hours_share: 86,
      orders_from: DEMANDA.from,
      orders_to: DEMANDA.to,
    });
  });

  it('o bloco pode passar da meia-noite, e as pontas sem pedido saem', () => {
    const tarde = demandaDaLoja([linha(5, 23, 10), linha(6, 0, 10), linha(6, 1, 5)], HOJE);
    expect(horariosDaLoja(tarde)).toMatchObject({ from: '23:00', to: '02:00', ads_from: '22:00', hours_share: 100 });
  });

  it('com poucos pedidos ou sem o Regem, vale a referência do setor, sem número da loja', () => {
    expect(horariosDaLoja(demandaDaLoja([linha(5, 20, 10)], HOJE))).toEqual(HORARIOS_DO_SETOR);
    expect(horariosDaLoja(null)).toEqual(HORARIOS_DO_SETOR);
    expect(HORARIOS_DO_SETOR).toMatchObject({ source: 'setor', days_share: null, hours_share: null });
  });
});

describe('as regras do funil (D-RG-28)', () => {
  const funil = (p: [number, number, number, number]) => conteudo(noventa({ midia: etapas(p) })).media_plan!.stages;
  it('passa dentro das regras e cai em cada uma delas', () => {
    expect(problemaDoFunil(funil([15, 10, 30, 45]))).toBeNull();
    expect(problemaDoFunil(funil([0, 0, 40, 60]))).toBeNull();
    expect(problemaDoFunil(funil([15, 10, 30, 44]))).toBe('as etapas do funil não somam 100%');
    expect(problemaDoFunil(funil([20, 10, 30, 40]))).toBe('reconhecimento e seguidores passam de 25% da verba');
    expect(problemaDoFunil(funil([10, 10, 20, 60]))).toBe('cardápio e conversa abaixo de 25% da verba');
    expect(problemaDoFunil(funil([10, 10, 55, 25]))).toBe('pedido abaixo de 30% da verba');
  });

  it('a etapa que falta ou se repete é fora do formato; fora das regras, a conferência recusa como formato', () => {
    const repetida = { etapas: [...etapas([15, 10, 30, 45]).etapas.slice(0, 3), { etapa: 'seguidores', parte: 45, criativo: 'x' }] };
    expect(conteudoDaResposta('noventa_dias', noventa({ midia: repetida }), VERBA, [TIJUCA])).toMatchObject({ ok: false });
    const fora = conteudo(noventa({ midia: etapas([20, 10, 30, 40]) }));
    expect(conferirPlano(fora, permitidos([TIJUCA]))).toMatchObject({ recusa: 'formato' });
    // A versão editada passa pela mesma regra.
    expect(conferirEdicao(fora, { nomes: [] })).toEqual(['reconhecimento e seguidores passam de 25% da verba']);
  });
});

describe('a resposta do modelo vira o plano de mídia do contrato (D-RG-26)', () => {
  it('com as lojas no mapa, o plano de mídia é obrigatório e o dinheiro de cada anel soma a proposta de cada canal', () => {
    expect(conteudoDaResposta('noventa_dias', noventa({ midia: null }), VERBA, [TIJUCA])).toMatchObject({ ok: false });
    const c = conteudo(noventa(), [TIJUCA, PENHA]);
    const m = c.media_plan!;
    expect(m.stores.map((s) => s.rings.map((r) => [r.ring, r.meta, r.google]))).toEqual([
      [
        ['nucleo', 300, 90],
        ['expansao', 200, 60],
      ],
      [['nucleo', 500, 150]],
    ]);
    expect(m.stores[0]).toMatchObject({ store: 'Mister Burgers Tijuca', district: 'Tijuca', city: 'Rio de Janeiro', radius_km: 3 });
    expect(m.stores[1]!.hours.source).toBe('setor');
    expect(PlanContent.parse(c)).toEqual(c);
    // A volta para o modelo (nova análise) tem as chaves dele.
    expect(respostaDoConteudo(c)).toMatchObject({ midia: { etapas: [{ etapa: 'reconhecimento', parte: 15 }, {}, {}, { etapa: 'pedido', parte: 45 }] } });
  });

  it('sem as lojas, o que o modelo manda em midia não entra; a resposta gravada sem midia vale como nula', () => {
    expect(conteudo(noventa(), null).media_plan).toBeUndefined();
    const { midia: _midia, ...antiga } = noventa();
    expect(conteudo(antiga, null).media_plan).toBeUndefined();
    expect(respostaDoConteudo(conteudo(antiga, null))).toMatchObject({ midia: null });
  });

  it('a verba nova (na edição) refaz o dinheiro dos anéis, somando a proposta', () => {
    const m = conteudo(noventa(), [TIJUCA, PENHA]).media_plan!;
    const novo = comAVerba(m, { meta: 2001, google: 0 });
    const soma = (canal: 'meta' | 'google') => novo.stores.flatMap((s) => s.rings).reduce((t, r) => t + r[canal], 0);
    expect([soma('meta'), soma('google')]).toEqual([2001, 0]);
  });
});

describe('a conferência, as fontes e o contexto do plano de mídia', () => {
  it('o criativo pode citar os números do bloco do contexto; número de fora e Compliance derrubam o plano', () => {
    const ok = conteudo(noventa({ midia: etapas([15, 10, 30, 45], { 3: 'O combo da noite, das 19h às 23h, no raio de 2 km da loja.' }) }));
    expect(conferirPlano(ok, permitidos([TIJUCA]))).toBeNull();
    const inventado = conteudo(noventa({ midia: etapas([15, 10, 30, 45], { 3: 'O combo com 70% de desconto.' }) }));
    expect(conferirPlano(inventado, permitidos([TIJUCA]))).toMatchObject({ recusa: 'numero_fora', detalhe: ['70'] });
    const promessa = conteudo(noventa({ midia: etapas([15, 10, 30, 45], { 0: 'O smash com resultado garantido.' }) }));
    expect(conferirPlano(promessa, permitidos([TIJUCA]))).toMatchObject({ recusa: 'compliance' });
    // A parte de cada etapa é proposta do Estrategista: pode aparecer nos textos.
    expect(propostaDoPlano(ok)).toEqual(expect.arrayContaining(['15%', '45%']));
  });

  it('os criativos entram nos textos; as partes dos pedidos levam a fonte do Regem', () => {
    const c = conteudo(noventa());
    expect(textosDoPlano(c).filter((t) => t.caminho.startsWith('media_plan.')).map((t) => t.caminho)).toEqual([0, 1, 2, 3].map((i) => `media_plan.stages.${i}.creative`));
    const d = dados([TIJUCA]);
    const origens = origensDoPlano(d, { leituras: [], content: c, atrasadas: [] });
    const { numbers, marked } = marcarPlano(c, indiceDasOrigens(origens), ['Mister Burgers'], { semLugar: 'sem lugar' });
    const horario = marked.find((x) => x.path === 'media_plan.stores.0.hours.hours_share')!;
    const n = horario.text.find((s) => s.number !== null)!.number!;
    expect(numbers[n]).toMatchObject({ value: '86%' });
    expect(numbers[n]!.sources[0]).toMatch(/^Regem · pedidos confirmados de \d{2}\/\d{2}\/\d{4} a \d{2}\/\d{2}\/\d{4}/);
    expect(marked.some((x) => x.path === 'media_plan.stores.0.hours.days_share')).toBe(true);
  });

  it('o contexto leva o bloco no plano de 90 dias, com o bairro e o município, nunca o endereço', () => {
    const texto = contextoDoPlano(dados([TIJUCA]));
    expect(texto).toContain('Plano de mídia por região');
    expect(texto).toContain('Loja "Mister Burgers Tijuca" (bairro Tijuca, Rio de Janeiro): entrega até 3 km');
    expect(texto).toContain('núcleo até 2 km, com 60% da verba da loja; expansão de 2 km a 3 km, com 40%');
    expect(texto).toContain('das 19h às 23h (86% dos pedidos)');
    expect(contextoDoPlano(dados(null))).toContain('`midia` vai nulo');
    expect(contextoDoPlano(dados([TIJUCA], 'pauta'))).not.toContain('Plano de mídia');
    expect(permitidoDaMidia([TIJUCA])).toEqual(expect.arrayContaining(['60%', '40%', '2 km', '3 km', '19h', '23h', '18h', '86%', '67%']));
    // Sem loja (e na oferta e na pauta), as faixas do funil não liberam número nenhum.
    expect(permitidoDaMidia([])).toEqual([]);
    expect(permitidoNoContexto(dados([TIJUCA], 'pauta'))).toMatchObject({ midia: [] });
  });

  it('a 6ª loja só avisa que há mais: o plano fica com as 5 primeiras', () => {
    const seis = Array.from({ length: 6 }, (_, i) => ({ ...PENHA, unitId: `0195f3a0-0000-7000-8000-00000000001${i}`, nome: `Loja ${i + 1}` }));
    expect(conteudo(noventa(), seis).media_plan!.stores).toHaveLength(5);
    expect(contextoDoPlano(dados(seis))).toContain('só as 5 primeiras lojas no mapa');
  });

  it('a hora dos anúncios (R4) entra no bloco, com os números permitidos e a fonte; sem ela, nada muda', () => {
    const comAnuncios = { ...dados([TIJUCA]), anuncios: { de: 11, ate: 15, parte: 41 } };
    expect(contextoDoPlano(comAnuncios)).toContain('A hora dos anúncios: os anúncios da marca (Meta e Google, nas 4 semanas até ontem) têm o bloco com mais cliques das 11h às 15h (41% dos cliques)');
    expect(contextoDoPlano(dados([TIJUCA]))).not.toContain('A hora dos anúncios');
    // O criativo pode dizer o bloco dos anúncios; sem ele no contexto, o "11h" não vale.
    const criativo = conteudo(noventa({ midia: etapas([15, 10, 30, 45], { 3: 'A verba sai do almoço, das 11h às 15h, e vai para a noite.' }) }));
    expect(conferirPlano(criativo, { ...permitidos([TIJUCA]), emDia: [permitidoNoContexto(comAnuncios)] })).toBeNull();
    expect(conferirPlano(criativo, permitidos([TIJUCA]))).toMatchObject({ recusa: 'numero_fora' });
    const origens = origensDoPlano(comAnuncios, { leituras: [], content: criativo, atrasadas: [] });
    expect(origens.find((o) => o.rotulo.startsWith('Meta e Google · cliques por hora'))?.valor).toEqual(['11h', '15h', '41%']);
  });
});
