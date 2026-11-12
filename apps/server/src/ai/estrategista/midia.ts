import { MEDIA_STAGES, type MediaHours, type MediaPlan, type MediaRing, type MediaStage, type MediaStageKind, type PlanBudget } from '@liame/contracts';
import type { DemandaDaLoja } from '../../regiao/demanda.js';
import { dia, dinheiro } from '../registro/formatos.js';

/** Reais inteiros como a tela mostra (o mesmo de `plano.ts`, sem importar dele: `plano.ts` importa daqui). */
const reais = (n: number): string => dinheiro((BigInt(n) * 1_000_000n).toString())!;

// O plano de mídia por região do Estrategista (plano da região, R5; revisão P45 do P8; D-RG-26 a D-RG-31), sem banco nem
// modelo: os anéis do raio, o dinheiro de cada anel, os horários da loja, as regras do funil e o que vai no contexto do
// modelo. O código calcula tudo o que é número; o Estrategista escolhe a parte de cada etapa (dentro das regras) e
// escreve o criativo de cada uma. Funções puras: a geração (worker), a edição (planos.service) e os testes usam as mesmas.

/** No máximo 5 lojas no plano; a verba proposta se divide igual entre elas (D-RG-27). */
export const LOJAS_NO_PLANO = 5;
/** O núcleo vai até 2 km da loja e fica com 60% da verba dela; a expansão, do núcleo ao raio, com 40% (D-RG-27). */
export const RAIO_DO_NUCLEO_KM = 2;
export const PARTE_DO_NUCLEO = 60;
/** O raio de partida da loja sem raio salvo (D-RG-15). */
export const RAIO_PADRAO_KM = 3;
/** O bloco mais forte tem até 4 horas; os anúncios começam 1 hora antes dele (plano da região §4.2, jogada 4). */
export const HORAS_NO_BLOCO = 4;
/** Os dias mais fortes: os acima da média da semana, no máximo 3. */
export const DIAS_FORTES = 3;

/** O nome de cada etapa do funil, como a tela e o contexto dizem. */
export const NOME_DA_ETAPA: Record<MediaStageKind, string> = {
  reconhecimento: 'Reconhecimento',
  seguidores: 'Seguidores',
  cardapio_conversa: 'Cardápio e conversa',
  pedido: 'Pedido',
};

/** A parte da verba de partida de cada etapa (plano da região §4.1): vai ao modelo como ponto de partida, não é regra. */
export const FAIXA_DA_ETAPA: Record<MediaStageKind, readonly [number, number]> = {
  reconhecimento: [15, 20],
  seguidores: [10, 15],
  cardapio_conversa: [25, 35],
  pedido: [30, 40],
};

/** As regras do funil que o código confere (D-RG-28; o teto de reconhecimento e seguidores é a D-RG-3). */
export const TETO_DO_TOPO = 25;
export const MINIMO_DA_CONVERSA = 25;
export const MINIMO_DO_PEDIDO = 30;

/** Uma loja no mapa como o plano de mídia a lê: o nome, o bairro, o município, o raio e a demanda (nunca o endereço, D-RG-2). */
export interface LojaDaMidia {
  unitId: string;
  nome: string;
  bairro: string | null;
  municipio: string | null;
  raioKm: number;
  /** A demanda da loja (R3), quando a marca tem o Regem; nula sem ele. */
  demanda: DemandaDaLoja | null;
}

const DIA_DA_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'] as const;
/** A posição do dia na semana que começa na segunda (0 = segunda … 6 = domingo). */
const naSemana = (dow: number): number => (dow + 6) % 7;
const hh = (h: number): string => `${String(((h % 24) + 24) % 24).padStart(2, '0')}:00`;
/** "18:00" → "18h". */
export const horaCurta = (hora: string): string => `${Number(hora.slice(0, 2))}h`;
/** 2.5 → "2,5 km". */
export const km = (n: number): string => `${String(n).replace('.', ',')} km`;
const porcento = (n: number): string => `${n}%`;

/** "sexta, sábado e domingo". */
export function nomesDosDias(dias: readonly number[]): string {
  const nomes = dias.map((d) => DIA_DA_SEMANA[d] ?? '');
  return nomes.length > 1 ? `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}` : (nomes[0] ?? '');
}

/** Os anéis do raio: com o raio até o núcleo, um anel só, com tudo; acima, o núcleo e a expansão (D-RG-27). */
export function aneisDoRaio(raioKm: number): Array<Pick<MediaRing, 'ring' | 'from_km' | 'to_km' | 'share'>> {
  if (raioKm <= RAIO_DO_NUCLEO_KM) return [{ ring: 'nucleo', from_km: 0, to_km: raioKm, share: 100 }];
  return [
    { ring: 'nucleo', from_km: 0, to_km: RAIO_DO_NUCLEO_KM, share: PARTE_DO_NUCLEO },
    { ring: 'expansao', from_km: RAIO_DO_NUCLEO_KM, to_km: raioKm, share: 100 - PARTE_DO_NUCLEO },
  ];
}

/** A parte inteira de `n` sobre o total, em porcento, arredondada. */
const parte = (n: number, total: number): number => (total > 0 ? Math.round((n * 100) / total) : 0);

/** A referência do setor (base §19.2: iFood, imprensa): o jantar, de sexta a domingo. Nunca como número da loja (D-RG-9). */
export const HORARIOS_DO_SETOR: MediaHours = {
  source: 'setor',
  days: [5, 6, 0],
  from: '18:00',
  to: '22:00',
  ads_from: '17:00',
  days_share: null,
  hours_share: null,
  orders_from: null,
  orders_to: null,
};

/**
 * Os horários da loja (D-RG-29), pelos pedidos dela (a demanda pronta, com 20 pedidos ou mais): os dias acima da média
 * da semana (no máximo 3, os de mais pedidos) e o bloco de até 4 horas seguidas com mais pedidos (pode passar da
 * meia-noite; as pontas sem pedido saem), com a parte dos pedidos de cada um. Sem pedidos que bastem, a referência do setor.
 */
export function horariosDaLoja(d: DemandaDaLoja | null): MediaHours {
  if (!d || d.status !== 'pronto' || d.orders <= 0 || d.by_weekday.length !== 7 || d.by_hour.length !== 24) return HORARIOS_DO_SETOR;
  const total = d.orders;
  const media = total / 7;
  const porPedidos = [...d.by_weekday].sort((a, b) => b.orders - a.orders || naSemana(a.weekday) - naSemana(b.weekday));
  const acima = porPedidos.filter((x) => x.orders > media);
  const fortes = (acima.length ? acima : porPedidos.filter((x) => x.orders === porPedidos[0]!.orders)).slice(0, DIAS_FORTES);
  const dias = fortes.map((x) => x.weekday).sort((a, b) => naSemana(a) - naSemana(b));
  const nosDias = fortes.reduce((t, x) => t + x.orders, 0);

  const porHora = (h: number) => d.by_hour[((h % 24) + 24) % 24]!.orders;
  let inicio = 0;
  let melhor = -1;
  for (let s = 0; s < 24; s++) {
    let soma = 0;
    for (let k = 0; k < HORAS_NO_BLOCO; k++) soma += porHora(s + k);
    if (soma > melhor) {
      melhor = soma;
      inicio = s;
    }
  }
  let fim = inicio + HORAS_NO_BLOCO - 1;
  while (inicio < fim && porHora(inicio) === 0) inicio++;
  while (fim > inicio && porHora(fim) === 0) fim--;
  return {
    source: 'loja',
    days: dias,
    from: hh(inicio),
    to: hh(fim + 1),
    ads_from: hh(inicio - 1),
    days_share: parte(nosDias, total),
    hours_share: parte(melhor, total),
    orders_from: d.from,
    orders_to: d.to,
  };
}

/**
 * Reais inteiros divididos pelos pesos, pelo maior resto: a soma das partes é o total, exatamente. Os pesos são inteiros
 * (a parte do anel × 1 por loja); o empate do resto fica com o que vem antes.
 */
export function dividir(total: number, pesos: readonly number[]): number[] {
  const soma = pesos.reduce((t, p) => t + p, 0);
  if (soma <= 0 || total <= 0) return pesos.map(() => 0);
  const base = pesos.map((p) => Math.floor((total * p) / soma));
  const restos = pesos.map((p, i) => ({ i, resto: (total * p) % soma }));
  let falta = total - base.reduce((t, n) => t + n, 0);
  for (const r of restos.sort((a, b) => b.resto - a.resto || a.i - b.i)) {
    if (falta <= 0) break;
    base[r.i]! += 1;
    falta -= 1;
  }
  return base;
}

/** O dinheiro de cada anel de cada loja, por canal, a partir da verba proposta (a loja divide igual; o anel, pela parte dele). */
export function comAVerba(m: MediaPlan, proposta: PlanBudget['proposal']): MediaPlan {
  const pesos = m.stores.flatMap((s) => s.rings.map((r) => r.share));
  const meta = dividir(proposta.meta, pesos);
  const google = dividir(proposta.google, pesos);
  let i = 0;
  return {
    ...m,
    stores: m.stores.map((s) => ({
      ...s,
      rings: s.rings.map((r) => {
        const j = i++;
        return { ...r, meta: meta[j]!, google: google[j]! };
      }),
    })),
  };
}

/** O plano de mídia: as lojas (até 5) com os anéis e os horários do código, as etapas do Estrategista e o dinheiro de cada anel. */
export function planoDeMidia(lojas: readonly LojaDaMidia[], etapas: MediaStage[], proposta: PlanBudget['proposal']): MediaPlan {
  return comAVerba(
    {
      stores: lojas.slice(0, LOJAS_NO_PLANO).map((l) => ({
        unit_id: l.unitId,
        store: l.nome,
        district: l.bairro,
        city: l.municipio,
        radius_km: l.raioKm,
        rings: aneisDoRaio(l.raioKm).map((r) => ({ ...r, meta: 0, google: 0 })),
        hours: horariosDaLoja(l.demanda),
      })),
      stages: etapas,
    },
    proposta,
  );
}

/** O que está errado no funil (D-RG-28), em palavras; nulo quando as regras passam. */
export function problemaDoFunil(etapas: readonly MediaStage[]): string | null {
  if (etapas.length !== MEDIA_STAGES.length || etapas.some((e, i) => e.stage !== MEDIA_STAGES[i])) return 'as etapas do funil fora da ordem ou repetidas';
  const p = Object.fromEntries(etapas.map((e) => [e.stage, e.share])) as Record<MediaStageKind, number>;
  if (etapas.reduce((t, e) => t + e.share, 0) !== 100) return 'as etapas do funil não somam 100%';
  if (p.reconhecimento + p.seguidores > TETO_DO_TOPO) return `reconhecimento e seguidores passam de ${TETO_DO_TOPO}% da verba`;
  if (p.cardapio_conversa < MINIMO_DA_CONVERSA) return `cardápio e conversa abaixo de ${MINIMO_DA_CONVERSA}% da verba`;
  if (p.pedido < MINIMO_DO_PEDIDO) return `pedido abaixo de ${MINIMO_DO_PEDIDO}% da verba`;
  return null;
}

/** De onde vêm os horários da loja, como a fonte do número na tela. */
export function fonteDosHorarios(h: MediaHours): string {
  return h.source === 'loja' && h.orders_from && h.orders_to
    ? `Regem · pedidos confirmados de ${dia(h.orders_from)} a ${dia(h.orders_to)} (as 4 semanas completas até ontem) · calculado pelo Liame`
    : 'Referência do setor (iFood, imprensa; base do Liame §19.2) · não é número da loja';
}

/** Os horários em palavras, como o contexto do modelo e a LIA dizem. */
export function horariosEmPalavras(h: MediaHours): string {
  if (h.source === 'setor') {
    return `pela referência do setor (iFood, imprensa; a loja ainda não tem pedidos que bastem): o jantar, de ${nomesDosDias(h.days)}, das ${horaCurta(h.from)} às ${horaCurta(h.to)}; os anúncios começam às ${horaCurta(h.ads_from)}`;
  }
  return `pelos pedidos da loja de ${dia(h.orders_from!)} a ${dia(h.orders_to!)}: os dias mais fortes são ${nomesDosDias(h.days)} (${porcento(h.days_share!)} dos pedidos); o bloco mais forte é das ${horaCurta(h.from)} às ${horaCurta(h.to)} (${porcento(h.hours_share!)} dos pedidos); os anúncios começam às ${horaCurta(h.ads_from)}`;
}

const aneisEmPalavras = (raioKm: number): string =>
  aneisDoRaio(raioKm)
    .map((r) => (r.ring === 'nucleo' ? `núcleo até ${km(r.to_km)}, com ${porcento(r.share)} da verba da loja` : `expansão de ${km(r.from_km)} a ${km(r.to_km)}, com ${porcento(r.share)}`))
    .join('; ');

/** O bloco do contexto do modelo (D-RG-2: o bairro, o município e os números; nunca o endereço). */
export function contextoDaMidia(lojas: readonly LojaDaMidia[]): string {
  const usadas = lojas.slice(0, LOJAS_NO_PLANO);
  const faixa = (e: MediaStageKind) => `${FAIXA_DA_ETAPA[e][0]}% a ${FAIXA_DA_ETAPA[e][1]}%`;
  return [
    `- Plano de mídia por região (calculado pelo sistema; você escolhe a parte de cada etapa do funil e escreve um criativo por etapa${lojas.length > LOJAS_NO_PLANO ? `; só as ${LOJAS_NO_PLANO} primeiras lojas no mapa` : ''}):`,
    ...usadas.map((l) => {
      const onde = [l.bairro ? `bairro ${l.bairro}` : null, l.municipio].filter(Boolean).join(', ');
      return `  - Loja "${l.nome}"${onde ? ` (${onde})` : ''}: entrega até ${km(l.raioKm)}. Anéis: ${aneisEmPalavras(l.raioKm)}. Horários ${horariosEmPalavras(horariosDaLoja(l.demanda))}.`;
    }),
    `  - A verba proposta se divide igual entre ${usadas.length === 1 ? 'a loja' : `as ${usadas.length} lojas`} e, em cada loja, pela parte de cada anel: o dinheiro de cada anel é conta do sistema, feita depois da sua proposta; não o escreva.`,
    `  - As etapas do funil e a parte da verba de partida: reconhecimento (${faixa('reconhecimento')}), seguidores (${faixa('seguidores')}), cardápio e conversa (${faixa('cardapio_conversa')}) e pedido (${faixa('pedido')}). Regras: as quatro somam 100%; reconhecimento e seguidores juntos até ${TETO_DO_TOPO}%; cardápio e conversa pelo menos ${MINIMO_DA_CONVERSA}%; pedido pelo menos ${MINIMO_DO_PEDIDO}%. Com pouca verba, reconhecimento e seguidores podem ficar em 0% (o orgânico faz o reconhecimento).`,
  ].join('\n');
}

/** Os números e nomes do bloco do contexto: podem aparecer nos textos do plano como estão ali. */
export function permitidoDaMidia(lojas: readonly LojaDaMidia[]): string[] {
  // Sem o bloco no contexto, nada daqui vale: as faixas do funil não podem liberar "15" ou "30" em outro plano.
  if (!lojas.length) return [];
  const usadas = lojas.slice(0, LOJAS_NO_PLANO);
  const faixas = Object.values(FAIXA_DA_ETAPA).flatMap(([a, b]) => [porcento(a), porcento(b)]);
  return [
    ...faixas,
    porcento(TETO_DO_TOPO),
    porcento(MINIMO_DA_CONVERSA),
    porcento(MINIMO_DO_PEDIDO),
    '100%',
    '0%',
    String(usadas.length),
    ...usadas.flatMap((l) => {
      const h = horariosDaLoja(l.demanda);
      return [
        l.nome,
        l.bairro ?? '',
        l.municipio ?? '',
        km(l.raioKm),
        ...aneisDoRaio(l.raioKm).flatMap((r) => [km(r.from_km), km(r.to_km), porcento(r.share)]),
        horaCurta(h.from),
        horaCurta(h.to),
        horaCurta(h.ads_from),
        h.from,
        h.to,
        h.ads_from,
        ...(h.days_share !== null ? [porcento(h.days_share)] : []),
        ...(h.hours_share !== null ? [porcento(h.hours_share)] : []),
        ...(h.orders_from ? [dia(h.orders_from)!] : []),
        ...(h.orders_to ? [dia(h.orders_to)!] : []),
      ];
    }),
  ].filter((x) => x !== '');
}

/** O que o Estrategista propõe no plano de mídia (a parte de cada etapa): pode aparecer nos textos como está ali. */
export function propostaDaMidia(m: MediaPlan): string[] {
  return m.stages.map((e) => porcento(e.share));
}

/** As contas do plano de mídia que o código faz (o dinheiro de cada anel, por canal e no total da loja). */
export function contasDaMidia(m: MediaPlan): string[] {
  return m.stores.flatMap((s) => [
    ...s.rings.flatMap((r) => [reais(r.meta), reais(r.google), reais(r.meta + r.google)]),
    reais(s.rings.reduce((t, r) => t + r.meta + r.google, 0)),
  ]);
}
