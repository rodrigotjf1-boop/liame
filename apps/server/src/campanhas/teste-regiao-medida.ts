import { nomeComparavel } from '../regiao/coordenada.js';
import { DIAS_DO_TESTE_DE_REGIAO, efeitoDoBairro, OUTROS_BAIRROS_MINIMOS, type PedidosDoBairro, SEMANAS_DE_ANTES } from './teste-regiao-contas.js';
import type { ResultadoDoTesteDeRegiao } from './teste-regiao-plano.js';

// A medida do teste de região (plano da região, R8; D-RG-81, D-RG-82 e D-RG-102). Depois do fim do teste, o Liame lê no
// Regem da loja os pedidos de entrega por bairro dos 14 dias e compara com as 4 semanas de antes que a pessoa viu no
// pedido: o bairro teria seguido os outros bairros, e a diferença é o que o anúncio traz ali, em faixa. Partes puras, sem
// rede e sem banco: a janela do teste, a soma dos pedidos por bairro (a mesma regra do pedido do teste) e o resultado.
// A medida não encerra o teste: quem devolve o bairro e marca `terminado` é o passo que mexe na Meta.

/** Passados estes dias do fim do teste sem a leitura do Regem, a medida grava o motivo `sem_leitura` e para de tentar. */
export const DIAS_ESPERANDO_A_LEITURA = 7;

const DIA_MS = 86_400_000;
const diaMais = (dia: string, dias: number): string => new Date(Date.parse(`${dia}T12:00:00Z`) + dias * DIA_MS).toISOString().slice(0, 10);
const diasEntre = (de: string, ate: string): number => Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / DIA_MS);

/** A janela da conta: os dias sem anúncio, no fuso da loja; `completa` quando o teste chegou aos 14 dias. */
export type JanelaDoTesteDeRegiao = { de: string; ate: string; completa: boolean };

/**
 * A janela do teste: do primeiro dia sem anúncio (`inicio`) aos 14 dias (`inicio + 13`). O fim depois disso não alonga a
 * janela (o bairro pode ter voltado no dia seguinte); o fim antes dela deixa o teste incompleto, e a janela vai até ele.
 */
export function janelaDoTesteDeRegiao(inicio: string, fim: string): JanelaDoTesteDeRegiao {
  const ultimo = diaMais(inicio, DIAS_DO_TESTE_DE_REGIAO - 1);
  return fim < ultimo ? { de: inicio, ate: fim, completa: false } : { de: inicio, ate: ultimo, completa: true };
}

/** A leitura já esperou demais: hoje (no fuso do teste) passa de 7 dias depois do fim. */
export const leituraVencida = (fim: string, hoje: string): boolean => diasEntre(fim, hoje) > DIAS_ESPERANDO_A_LEITURA;

/** Uma linha dos pedidos de entrega por bairro, como o Regem devolve (o bairro pode vir sem nome: "outros", "sem bairro"). */
export type LinhaDePedidos = { bairro: string | null; cidade: string | null; pedidos: number };

/**
 * Os pedidos de entrega somados por bairro com nome, só do município da loja (o bairro de outra cidade com o mesmo nome
 * fica de fora; a linha sem cidade fica), com os nomes comparados como a tela compara. É a mesma regra no pedido do
 * teste (as 4 semanas de antes) e na medida (os dias do teste): a conta só vale com os dois lados contados igual.
 */
export function pedidosPorBairro(linhas: readonly LinhaDePedidos[], cidadeDaLoja: string | null): PedidosDoBairro[] {
  const doMunicipio = (c: string | null) => !c || !cidadeDaLoja || nomeComparavel(c) === nomeComparavel(cidadeDaLoja);
  const porNome = new Map<string, PedidosDoBairro>();
  for (const l of linhas) {
    if (!l.bairro || !doMunicipio(l.cidade)) continue;
    const k = nomeComparavel(l.bairro);
    const antes = porNome.get(k);
    porNome.set(k, { nome: antes?.nome ?? l.bairro, pedidos: (antes?.pedidos ?? 0) + l.pedidos });
  }
  return [...porNome.values()].sort((x, y) => y.pedidos - x.pedidos);
}

/** A leitura dos dias do teste: o mínimo que o Regem usou para mostrar um bairro pelo nome e os bairros que vieram. */
export type LeituraDoTesteDeRegiao = { minimo: number; bairros: readonly PedidosDoBairro[] };

export type EntradaDaMedida = {
  /** O nome do bairro do teste, como o plano guarda. */
  bairro: string;
  /** Os pedidos por bairro das 4 semanas de antes, como a pessoa viu no pedido (`plan.semanas.bairros`). */
  antes: readonly PedidosDoBairro[];
  janela: JanelaDoTesteDeRegiao;
  /** A leitura dos dias do teste; nula quando o Regem não devolveu (a medida só chama assim depois dos 7 dias). */
  leitura: LeituraDoTesteDeRegiao | null;
  medidoEm: Date;
};

const soma = (lista: readonly PedidosDoBairro[]) => lista.reduce((s, b) => s + b.pedidos, 0);

/**
 * O resultado do teste (D-RG-102). Os bairros de comparar são os das semanas de antes menos o do teste, com pedidos. O de
 * comparar que não veio pelo nome na leitura do teste (abaixo do mínimo do Regem, somado em "outros") sai dos dois lados,
 * para a conta não ficar torta. Sem conta, o motivo: o teste incompleto, sem a leitura, menos de 3 bairros de comparar,
 * o bairro do teste abaixo do mínimo do Regem (com o que ele faria seguindo os outros) ou uma contagem zero.
 */
export function medidaDoTesteDeRegiao(e: EntradaDaMedida): ResultadoDoTesteDeRegiao {
  const alvo = nomeComparavel(e.bairro);
  const doAlvo = (b: PedidosDoBairro) => nomeComparavel(b.nome) === alvo;
  const alvoAntes = soma(e.antes.filter(doAlvo));
  const deComparar = e.antes.filter((b) => !doAlvo(b) && b.pedidos > 0);
  const base = { janela: { de: e.janela.de, ate: e.janela.ate }, medido_em: e.medidoEm.toISOString() };

  if (!e.janela.completa || !e.leitura) {
    return {
      ...base,
      pedidos: { alvoAntes, outrosAntes: soma(deComparar), alvoDurante: null, outrosDurante: null },
      bairros: deComparar.map((b) => b.nome),
      efeito: null,
      motivo: e.janela.completa ? 'sem_leitura' : 'incompleto',
      esperadoPorSemana: null,
      minimoDoRegem: null,
    };
  }

  const durante = new Map<string, number>();
  for (const b of e.leitura.bairros) durante.set(nomeComparavel(b.nome), (durante.get(nomeComparavel(b.nome)) ?? 0) + b.pedidos);
  const ficaram = deComparar.filter((b) => durante.has(nomeComparavel(b.nome)));
  const outrosAntes = soma(ficaram);
  const outrosDurante = ficaram.reduce((s, b) => s + (durante.get(nomeComparavel(b.nome)) ?? 0), 0);
  const alvoDurante = durante.get(alvo) ?? null;
  const comum = { ...base, pedidos: { alvoAntes, outrosAntes, alvoDurante, outrosDurante }, bairros: ficaram.map((b) => b.nome), minimoDoRegem: e.leitura.minimo };

  if (ficaram.length < OUTROS_BAIRROS_MINIMOS) return { ...comum, efeito: null, motivo: 'poucos_bairros', esperadoPorSemana: null };
  if (alvoDurante === null) {
    // Sem o número do bairro, nada de conta com número inventado: só o que ele faria seguindo os outros bairros.
    const semanasDurante = DIAS_DO_TESTE_DE_REGIAO / 7;
    return { ...comum, efeito: null, motivo: 'abaixo_do_minimo', esperadoPorSemana: (alvoAntes * (outrosDurante / outrosAntes)) / semanasDurante };
  }
  const efeito = efeitoDoBairro({ alvoAntes, outrosAntes, alvoDurante, outrosDurante, semanasAntes: SEMANAS_DE_ANTES, diasDurante: DIAS_DO_TESTE_DE_REGIAO });
  if (!efeito) return { ...comum, efeito: null, motivo: 'sem_conta', esperadoPorSemana: null };
  return { ...comum, efeito, motivo: null, esperadoPorSemana: null };
}
