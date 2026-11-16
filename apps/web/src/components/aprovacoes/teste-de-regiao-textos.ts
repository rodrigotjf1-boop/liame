import { REGION_TEST_DAYS, REGION_TEST_MIN_OTHER_DISTRICTS, REGION_TEST_WEEKS_BEFORE, type RegionTestResponse } from '@liame/contracts';

// O teste de região em Aprovações (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026; D-RG-81 e
// D-RG-82): as regras puras do detalhe. Por enquanto, aprovar só marca o teste como pronto: os passos que tiram o bairro
// das campanhas e o devolvem entram depois da prova na conta real (D-RG-89), e a tela diz isso sem prometer o que não faz.

const PREFIXO = 'teste_de_regiao:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O pedido é o do teste de região (a ferramenta `teste_de_regiao`)? */
export const ehPedidoDoTesteDeRegiao = (a: { tool: string }): boolean => a.tool === 'teste_de_regiao';

/** O id do teste no recurso do pedido (`teste_de_regiao:<id>`), ou nulo quando o recurso é outro. */
export function idDoTesteDeRegiao(recurso: string): string | null {
  if (!recurso.startsWith(PREFIXO)) return null;
  const id = recurso.slice(PREFIXO.length);
  return UUID.test(id) ? id : null;
}

/** "Teste de região: Lapa sem anúncio por 14 dias" (o nome do teste já diz o bairro e os dias). */
export const tituloDoTesteDeRegiao = (nome: string | null): string => (nome ? `Teste de região: ${nome}` : 'Teste de região');

/** Os pedidos por semana, com uma casa quando não é inteiro ("12,5"). */
const porSemana = (pedidos: number): string => {
  const n = pedidos / REGION_TEST_WEEKS_BEFORE;
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace('.', ',');
};

/** A tabela dos bairros nas semanas de antes: o do teste primeiro, depois os de comparar, como o servidor guardou. */
export function bairrosDoTeste(t: RegionTestResponse): Array<{ nome: string; porSemana: string; alvo: boolean }> {
  const alvo = t.weeks.districts.filter((d) => d.target);
  const outros = t.weeks.districts.filter((d) => !d.target);
  return [...alvo, ...outros].map((d) => ({ nome: d.name, porSemana: porSemana(d.orders), alvo: d.target }));
}

/** "de 12/10 a 08/11": as 4 semanas que entram na conta. */
export const semanasDoTeste = (t: RegionTestResponse): string => `de ${t.weeks.from.slice(8, 10)}/${t.weeks.from.slice(5, 7)} a ${t.weeks.to.slice(8, 10)}/${t.weeks.to.slice(5, 7)}`;

export function situacaoDoTesteDeRegiao(t: RegionTestResponse): { rotulo: string; tom: 'espera' | 'trabalhando' | 'concluido' | 'perigo' | 'neutro' } {
  switch (t.status) {
    case 'pedido':
      return { rotulo: 'Espera a aprovação', tom: 'espera' };
    case 'criando':
    case 'pronto':
      return { rotulo: 'Pronto', tom: 'espera' };
    case 'rodando':
      return { rotulo: 'Rodando', tom: 'trabalhando' };
    case 'terminado':
      return { rotulo: 'Terminado', tom: 'concluido' };
    case 'encerrado':
      return { rotulo: 'Encerrado antes do fim', tom: 'neutro' };
    case 'interrompido':
      return { rotulo: 'Interrompido', tom: 'perigo' };
    case 'cancelado':
      return { rotulo: 'Não foi pedido', tom: 'neutro' };
  }
}

/** O que aconteceu depois do pedido, em uma frase; nulo enquanto espera a aprovação. */
export function andamentoDoTesteDeRegiao(t: RegionTestResponse): string | null {
  switch (t.status) {
    case 'pedido':
      return null;
    case 'criando':
    case 'pronto':
      return `Aprovado: o teste está pronto. Tirar ${t.district.name} dos anúncios ainda não está ligado no Liame, e nada mudou na Meta.`;
    case 'rodando':
      return t.started_on ? `Desde ${t.started_on.slice(8, 10)}/${t.started_on.slice(5, 7)}, ${t.district.name} está sem anúncio nas campanhas do Liame.` : `${t.district.name} está sem anúncio nas campanhas do Liame.`;
    case 'terminado':
      return `O teste terminou. ${t.district.name} voltou a receber os anúncios das campanhas do Liame.`;
    case 'encerrado':
      return `O teste foi encerrado antes do fim. ${t.district.name} voltou a receber os anúncios.`;
    case 'interrompido':
      return t.reason ?? 'O teste foi interrompido: o Liame não conclui.';
    case 'cancelado':
      return t.error ?? 'O pedido foi recusado ou expirou em Aprovações: nada mudou na Meta.';
  }
}

// ------------------------------------------------------------ o resultado (a medida, D-RG-102)

/** Pedidos por semana com uma casa decimal, como a tela escreve ("12,5", "84,0"). */
/** Até uma casa decimal, só quando o número não é inteiro ("84", "123,4"), como a tabela das semanas de antes. */
const umaCasa = (n: number): string => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });

const sobraram = (n: number): string => (n === 0 ? 'não sobrou nenhum bairro' : n === 1 ? 'sobrou 1 bairro' : `sobraram ${n} bairros`);

/**
 * O que o teste mostrou, em uma frase: com a conta (o que o bairro fez, o que faria seguindo os outros e a faixa do que o
 * anúncio traz) ou o motivo de não haver conta. Enquanto o teste terminado espera a medida, a frase diz quando ela sai.
 * Nulo nas outras situações.
 */
export function resultadoDoTesteDeRegiao(t: Pick<RegionTestResponse, 'status' | 'days' | 'result'>): string | null {
  const r = t.result;
  if (!r) return t.status === 'terminado' ? `O resultado sai depois que a leitura dos pedidos do Regem cobrir os ${t.days} dias.` : null;
  const e = r.effect;
  if (e) {
    if (e.proven) {
      return `Sem anúncio, o bairro fez ${umaCasa(e.actual_per_week)} pedidos por semana; seguindo os outros bairros, faria ${umaCasa(e.expected_per_week)}. O anúncio traz de ${umaCasa(e.range.from)} a ${umaCasa(e.range.to)} pedidos por semana ali.`;
    }
    return `Não deu para provar que o anúncio traz pedido no bairro: a faixa vai de 0 a ${umaCasa(e.range.to)} por semana.`;
  }
  switch (r.reason) {
    case 'incompleto':
      return `O teste parou antes dos ${t.days} dias: com menos, o Liame não tira conclusão.`;
    case 'poucos_bairros':
      return `Nos dias do teste, ${sobraram(r.districts.length)} para comparar; a conta pede pelo menos ${REGION_TEST_MIN_OTHER_DISTRICTS}.`;
    case 'abaixo_do_minimo':
      return `O bairro teve menos pedidos do que o mínimo que o Regem mostra por bairro${r.regem_minimum ? ` (${r.regem_minimum} nos ${t.days} dias)` : ''}${typeof r.expected_per_week === 'number' ? `; seguindo os outros bairros, faria ${umaCasa(r.expected_per_week)} pedidos por semana` : ''}.`;
    case 'sem_conta':
      return 'Faltou pedido de um dos lados, antes ou durante o teste: não há conta.';
    case 'sem_leitura':
      return `O Liame não conseguiu ler os pedidos do Regem dos ${t.days} dias: sem eles, não há conta.`;
    default:
      return 'Não deu para fazer a conta deste teste.';
  }
}

/** O resultado no detalhe: um título curto e a frase; `provou` pinta o quadro de sucesso. Nulo quando não há o que mostrar. */
export function vereditoDoTesteDeRegiao(t: Pick<RegionTestResponse, 'status' | 'days' | 'result'>): { titulo: string; texto: string; provou: boolean } | null {
  const texto = resultadoDoTesteDeRegiao(t);
  if (!texto) return null;
  const e = t.result?.effect;
  if (!t.result) return { titulo: 'Ainda medindo', texto, provou: false };
  if (e?.proven) return { titulo: 'O anúncio traz pedido no bairro', texto, provou: true };
  return { titulo: e ? 'Não deu para provar' : 'Sem conta neste teste', texto, provou: false };
}

type Efeito = NonNullable<NonNullable<RegionTestResponse['result']>['effect']>;

/** Os números redondos da escala da régua, vezes uma potência de 10. */
const REDONDOS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;

/**
 * O fim da escala da régua: o primeiro número redondo (1; 1,5; 2; 2,5; 3; 4; 5; 6; 8 ou 10, vezes uma potência de 10) que
 * cobre o fim da faixa com folga (25% acima), nunca abaixo de 5. Fica sempre acima do fim da faixa: ela não encosta no fim.
 */
export function fimDaEscala(ate: number): number {
  const alvo = Math.max(5, (Number.isFinite(ate) ? ate : 0) * 1.25);
  const potencia = 10 ** Math.floor(Math.log10(alvo));
  const redondo = REDONDOS.find((r) => r * potencia >= alvo) ?? 10;
  return redondo * potencia;
}

/** A régua da faixa: a frase para o leitor de tela, as posições e a largura da faixa (em % da escala) e os rótulos de baixo. */
export type Regua = { rotulo: string; de: number; ate: number; largura: number; ponto: number; meio: string; fim: string };

/**
 * A régua do resultado (protótipo, "O resultado: quanto o anúncio traz no bairro"): de 0 ao fim da escala, a faixa (de X a
 * Y pedidos por semana) e o ponto mais provável (Z, o que o anúncio traz). Os números com uma casa decimal, como a frase.
 */
export function reguaDaFaixa(e: Efeito): Regua {
  const fim = fimDaEscala(e.range.to);
  const duasCasas = (n: number) => Math.round(n * 100) / 100;
  const pos = (v: number) => duasCasas(Math.min(100, Math.max(0, (v / fim) * 100)));
  const [de, ate] = [umaCasa(e.range.from), umaCasa(e.range.to)];
  return {
    rotulo: `A conta fica entre ${de} e ${ate} pedidos por semana; o ponto mais provável é ${umaCasa(e.brings_per_week)}.`,
    de: pos(e.range.from),
    ate: pos(e.range.to),
    largura: duasCasas(Math.max(0, pos(e.range.to) - pos(e.range.from))),
    ponto: pos(e.brings_per_week),
    meio: `entre ${de} e ${ate} por semana`,
    fim: fim.toLocaleString('pt-BR'),
  };
}

/** Uma linha da tabela dos bairros: os pedidos por semana já escritos; `noTeste` e `obs` só na tabela do resultado. */
export type LinhaDosBairros = { nome: string; alvo: boolean; antes: string; noTeste?: string; obs?: string };

/** A tabela "Os pedidos por bairro, antes e no teste": as linhas (o bairro do teste primeiro) e os outros bairros somados. */
export type AntesENoTeste = { linhas: LinhaDosBairros[]; outros: { antes: string; noTeste: string } };

const SEMANAS_NO_TESTE = REGION_TEST_DAYS / 7;
const antesPorSemana = (pedidos: number) => umaCasa(pedidos / REGION_TEST_WEEKS_BEFORE);
const noTestePorSemana = (pedidos: number | null) => (pedidos === null ? '—' : umaCasa(pedidos / SEMANAS_NO_TESTE));

/**
 * Os pedidos por semana de cada bairro, nas 4 semanas de antes (÷ 4) e nos 14 dias do teste (÷ 2), quando a medida leu
 * os dias do teste; nulo sem a leitura. Primeiro o bairro do teste; depois os de comparar que ficaram na conta; embaixo, os
 * outros bairros somados. O bairro do teste que o Regem não mostrou pelo nome diz "menos de N" (o mínimo dele, nos 14 dias).
 */
export function bairrosAntesENoTeste(t: Pick<RegionTestResponse, 'district' | 'weeks' | 'days' | 'result'>): AntesENoTeste | null {
  const r = t.result;
  if (!r || !r.districts.some((d) => d.orders_during !== null)) return null;
  const nome = t.weeks.districts.find((d) => d.target)?.name ?? t.district.name;
  const doAlvo: LinhaDosBairros =
    r.orders.target_during !== null
      ? { nome, alvo: true, antes: antesPorSemana(r.orders.target_before), noTeste: noTestePorSemana(r.orders.target_during) }
      : r.regem_minimum !== null
        ? { nome, alvo: true, antes: antesPorSemana(r.orders.target_before), noTeste: `menos de ${r.regem_minimum.toLocaleString('pt-BR')}`, obs: `nos ${t.days} dias` }
        : { nome, alvo: true, antes: antesPorSemana(r.orders.target_before), noTeste: '—' };
  return {
    linhas: [doAlvo, ...r.districts.map((d) => ({ nome: d.name, alvo: false, antes: antesPorSemana(d.orders_before), noTeste: noTestePorSemana(d.orders_during) }))],
    outros: { antes: antesPorSemana(r.orders.others_before), noTeste: noTestePorSemana(r.orders.others_during) },
  };
}

/** "as 4 semanas de antes (de 12/10 a 08/11) e os 14 dias do teste (de 01/11 a 14/11)": de onde vêm os números da tabela. */
export function periodosDoResultado(t: Pick<RegionTestResponse, 'weeks' | 'days' | 'result'>): string {
  const dia = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
  const antes = `as ${REGION_TEST_WEEKS_BEFORE} semanas de antes (de ${dia(t.weeks.from)} a ${dia(t.weeks.to)})`;
  return t.result ? `${antes} e os ${t.days} dias do teste (de ${dia(t.result.window.from)} a ${dia(t.result.window.to)})` : antes;
}

/** Os conjuntos das campanhas do Liame que mostram anúncio no bairro, numa frase (de onde o bairro sai no teste). */
export function conjuntosDoTesteDeRegiao(t: RegionTestResponse): string {
  const n = t.ad_sets.length;
  if (!n) return `Nenhum conjunto das campanhas do Liame mostra anúncio em ${t.district.name} agora.`;
  const campanhas = new Set(t.ad_sets.map((a) => a.campaign_id)).size;
  return `${n === 1 ? 'Um conjunto' : `${n} conjuntos`} de ${campanhas === 1 ? 'uma campanha' : `${campanhas} campanhas`} do Liame ${n === 1 ? 'mostra' : 'mostram'} anúncio em ${t.district.name}: é deles que o bairro sai no teste, por ${t.days} dias. A verba de cada campanha fica como está.`;
}
