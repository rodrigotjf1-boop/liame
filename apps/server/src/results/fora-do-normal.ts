import { type ItemCiclo, reais } from './atencao-ciclo.js';

// "Fora do normal, com o motivo" (A3, I6): detecção POR CÓDIGO, comparando cada loja e cada campanha com a
// própria série, no mesmo dia da semana (restaurante vende diferente na segunda e no sábado). Cada aviso
// leva a evidência (o número de ontem e o normal), o valor envolvido e a hora da leitura. A IA, quando
// entrar, só explica e sugere em cima destes números. Funções puras: quem lê o banco é o
// `AtencaoCicloService`. Dado velho não gera aviso: quem chama só entrega série lida no próprio dia.

/** Limiares de partida [S]: medidos no piloto e ajustados aqui, num lugar só. */
export const FAIXA = {
  /** Semanas anteriores olhadas, sempre no mesmo dia da semana. */
  semanas: 4,
  /** Com menos semanas de história que isto, não há "normal". */
  semanasMinimas: 3,
  /** Fora da faixa: abaixo da metade ou acima do dobro do normal. */
  abaixoPorMil: 500n,
  acimaPorMil: 2000n,
  /** Queda forte: abaixo de um quarto do normal. */
  quedaFortePorMil: 250n,
  /** Vendas: só compara loja com normal de 5 pedidos ou mais no dia da semana. */
  pedidosMinimos: 5,
  /** Gasto da campanha: só compara com normal de R$ 10 ou mais no dia da semana. */
  gastoDiarioMinimoMicros: 10_000_000n,
  /** Custo por pedido: 50% acima do das 4 semanas anteriores, com 5 pedidos ou mais na história. */
  custoPorPedidoPorMil: 1500n,
  pedidosDaHistoria: 5,
  /** Gasto mínimo da campanha nos 7 dias para o custo por pedido valer (R$ 20). */
  gastoDaSemanaMinimoMicros: 20_000_000n,
} as const;

const DIA_MS = 86_400_000;
/** Dias de série que as regras olham para trás (o dia de ontem, 4 semanas e folga). */
export const DIAS_DA_SERIE = 36;
export const menosDias = (dia: string, n: number) => new Date(Date.parse(`${dia}T00:00:00Z`) - n * DIA_MS).toISOString().slice(0, 10);
/** "2026-10-02" no fuso dado. */
export const diaNoFuso = (quando: Date | string, fuso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(quando));
/** A leitura foi feita no dia de hoje do fuso: só ela traz o dia de ontem inteiro. */
export const lidaHoje = (lidaEm: Date | string | null, agora: Date, fuso: string): boolean => lidaEm !== null && diaNoFuso(lidaEm, fuso) === diaNoFuso(agora, fuso);
/** "quinta-feira", a partir de AAAA-MM-DD. */
export const diaDaSemana = (dia: string) => new Intl.DateTimeFormat('pt-BR', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${dia}T00:00:00Z`));
const plural = (n: number, um: string, varios: string) => (n === 1 ? um : varios);
/** "09:55", no fuso dado. */
const hora = (quando: Date | string, fuso: string) => new Date(quando).toLocaleTimeString('pt-BR', { timeZone: fuso, hour: '2-digit', minute: '2-digit' });

export function medianaMicros(valores: bigint[]): bigint {
  const s = [...valores].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2n;
}

/**
 * Os valores do mesmo dia da semana nas semanas anteriores. Dia sem linha conta como zero, desde que a
 * série já existisse (`desde`): antes do primeiro dia com dado não há o que comparar.
 */
export function mesmoDiaDasSemanasAnteriores<T>(serie: Map<string, T>, dia: string, desde: string | null, zero: T): T[] {
  const valores: T[] = [];
  if (desde === null) return valores;
  for (let s = 1; s <= FAIXA.semanas; s++) {
    const d = menosDias(dia, s * 7);
    if (d >= desde) valores.push(serie.get(d) ?? zero);
  }
  return valores;
}

// ------------------------------------------------------------------ vendas da loja

export type VendasDoDia = { pedidos: number; receitaMicros: bigint };

export type LojaNaSerie = {
  id: string;
  nome: string;
  fuso: string;
  /** Leitura dos pedidos que trouxe o dia de ontem inteiro. */
  lidoEm: Date | string;
  /** Primeiro dia com pedido na série lida. */
  desde: string | null;
  porDia: Map<string, VendasDoDia>;
};

/** Pedidos ou receita de ontem abaixo da metade (ou acima do dobro) do normal do mesmo dia da semana. */
export function avisoVendasForaDoNormal(loja: LojaNaSerie, ontem: string): ItemCiclo | null {
  const historia = mesmoDiaDasSemanasAnteriores(loja.porDia, ontem, loja.desde, { pedidos: 0, receitaMicros: 0n });
  if (historia.length < FAIXA.semanasMinimas) return null;
  const normalPedidos = Number(medianaMicros(historia.map((h) => BigInt(h.pedidos) * 10n))) / 10;
  const normalReceita = medianaMicros(historia.map((h) => h.receitaMicros));
  if (normalPedidos < FAIXA.pedidosMinimos || normalReceita <= 0n) return null;
  const v = loja.porDia.get(ontem) ?? { pedidos: 0, receitaMicros: 0n };
  const pedidos = BigInt(v.pedidos) * 10n;
  const normal = BigInt(Math.round(normalPedidos * 10));
  const abaixo = pedidos * 1000n < normal * FAIXA.abaixoPorMil || v.receitaMicros * 1000n < normalReceita * FAIXA.abaixoPorMil;
  const acima = pedidos * 1000n > normal * FAIXA.acimaPorMil || v.receitaMicros * 1000n > normalReceita * FAIXA.acimaPorMil;
  if (!abaixo && !acima) return null;
  const normalTxt = Math.round(normalPedidos);
  const evidencia = `${v.pedidos} ${plural(v.pedidos, 'pedido', 'pedidos')} e ${reais(v.receitaMicros)} ontem (${diaDaSemana(ontem)}); no mesmo dia das últimas ${historia.length} semanas, o normal foi de ${normalTxt} ${plural(normalTxt, 'pedido', 'pedidos')} e ${reais(normalReceita)}.`;
  const leitura = `Pedidos lidos hoje, às ${hora(loja.lidoEm, loja.fuso)}.`;
  const base = { connected_account_id: loja.id, campaign_id: null, provider: 'regem' };
  if (abaixo) {
    const forte = pedidos * 1000n < normal * FAIXA.quedaFortePorMil;
    return {
      ...base,
      kind: 'vendas_fora_do_normal',
      severity: forte ? 'critica' : 'atencao',
      title: `As vendas de ontem na ${loja.nome} ficaram abaixo do normal`,
      detail: `${evidencia} São ${reais(normalReceita - v.receitaMicros)} a menos. ${leitura}`,
      action: 'Confira se a loja abriu no horário, se o cardápio e os canais de pedido estavam no ar e se alguma campanha parou.',
    };
  }
  return {
    ...base,
    kind: 'vendas_fora_do_normal',
    severity: 'info',
    title: `As vendas de ontem na ${loja.nome} ficaram acima do normal`,
    detail: `${evidencia} São ${reais(v.receitaMicros - normalReceita)} a mais. ${leitura}`,
    action: 'Veja em Resultados de onde vieram os pedidos: vale repetir o que funcionou.',
  };
}

// ------------------------------------------------------------------ gasto e custo por pedido da campanha

export type CampanhaNaSerie = {
  id: string;
  name: string;
  provider: string;
  connectedAccountId: string;
  fuso: string;
  /** Leitura das métricas que trouxe o dia de ontem inteiro. */
  lidoEm: Date | string;
  /** Primeiro dia com gasto na série lida. */
  desde: string | null;
  gastoPorDia: Map<string, bigint>;
};

const NOMES: Record<string, string> = { meta_ads: 'Meta', google_ads: 'Google Ads' };

/** Gasto de ontem acima do dobro do normal da campanha no mesmo dia da semana. */
export function avisoGastoDaCampanha(c: CampanhaNaSerie, ontem: string): ItemCiclo | null {
  const historia = mesmoDiaDasSemanasAnteriores(c.gastoPorDia, ontem, c.desde, 0n);
  if (historia.length < FAIXA.semanasMinimas) return null;
  const normal = medianaMicros(historia);
  const valor = c.gastoPorDia.get(ontem) ?? 0n;
  if (normal < FAIXA.gastoDiarioMinimoMicros || valor * 1000n <= normal * FAIXA.acimaPorMil) return null;
  return {
    kind: 'gasto_da_campanha_fora_do_normal',
    severity: 'atencao',
    title: `A campanha "${c.name}" gastou acima do normal ontem`,
    detail: `${reais(valor)} ontem (${diaDaSemana(ontem)}); no mesmo dia das últimas ${historia.length} semanas, o normal foi de ${reais(normal)}. São ${reais(valor - normal)} a mais (${NOMES[c.provider] ?? c.provider}, lida hoje às ${hora(c.lidoEm, c.fuso)}).`,
    action: 'Confira na plataforma se a verba ou o lance da campanha mudou.',
    connected_account_id: c.connectedAccountId,
    campaign_id: c.id,
    provider: c.provider,
  };
}

export type CustoDaCampanha = {
  id: string;
  name: string;
  provider: string;
  connectedAccountId: string;
  /** Últimos 7 dias. */
  semana: { gastoMicros: bigint; pedidos: number };
  /** As 4 semanas antes desses 7 dias. */
  historia: { gastoMicros: bigint; pedidos: number };
};

/** Custo por pedido confirmado dos últimos 7 dias 50% acima do das 4 semanas anteriores. */
export function avisoCustoPorPedido(c: CustoDaCampanha): ItemCiclo | null {
  if (c.semana.pedidos < 1 || c.semana.gastoMicros < FAIXA.gastoDaSemanaMinimoMicros) return null;
  if (c.historia.pedidos < FAIXA.pedidosDaHistoria || c.historia.gastoMicros <= 0n) return null;
  const agora = c.semana.gastoMicros / BigInt(c.semana.pedidos);
  const normal = c.historia.gastoMicros / BigInt(c.historia.pedidos);
  if (agora * 1000n <= normal * FAIXA.custoPorPedidoPorMil) return null;
  return {
    kind: 'custo_por_pedido_fora_do_normal',
    severity: 'atencao',
    title: `O custo por pedido da campanha "${c.name}" subiu`,
    detail: `${reais(agora)} por pedido confirmado nos últimos 7 dias (${c.semana.pedidos} ${plural(c.semana.pedidos, 'pedido', 'pedidos')}, ${reais(c.semana.gastoMicros)}); nas 4 semanas anteriores era ${reais(normal)}. São ${reais((agora - normal) * BigInt(c.semana.pedidos))} a mais no período (${NOMES[c.provider] ?? c.provider}).`,
    action: 'Veja em Resultados o que mudou na campanha: a verba, o público ou o anúncio.',
    connected_account_id: c.connectedAccountId,
    campaign_id: c.id,
    provider: c.provider,
  };
}
