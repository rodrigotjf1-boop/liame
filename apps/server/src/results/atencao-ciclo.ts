// "Atenção do ciclo fechado" (A2.5, F9; plano-a25 §3): regras simples e explicáveis que cruzam a mídia com
// as vendas confirmadas no caixa. Cada aviso diz o que houve, o motivo e o que fazer, no mesmo formato dos
// avisos de mídia (G9). Sem IA. Funções puras: quem lê o banco é o `AtencaoCicloService`.

export type Severidade = 'critica' | 'atencao' | 'info';

export type TipoCiclo =
  | 'conta_desconectada'
  | 'conta_sem_permissao'
  | 'conta_com_erro'
  | 'dado_atrasado'
  | 'vendas_nao_conectadas'
  | 'plataforma_nao_informada'
  | 'anuncio_sem_rastreio'
  | 'campanha_sem_cupom'
  | 'vendas_nao_medidas'
  | 'campanha_sem_pedido'
  | 'cupom_sem_uso'
  | 'margem_desconhecida'
  | 'plataforma_x_caixa'
  // Fora do normal (A3, I6): as regras estão em `fora-do-normal.ts`.
  | 'vendas_fora_do_normal'
  | 'gasto_da_campanha_fora_do_normal'
  | 'custo_por_pedido_fora_do_normal'
  // A conferência do gasto de uma mudança do Liame (A4, X4): o texto está em `actions/conferencia-do-gasto.ts`.
  | 'gasto_acima_da_verba'
  // A recomendação da sombra numa ação em Sugerir (A3, I13): o texto está em `sugestoes-da-sombra.ts`.
  | 'sugestao_pausar_campanha'
  | 'sugestao_reduzir_verba'
  | 'sugestao_aumentar_verba';

export type ItemCiclo = {
  kind: TipoCiclo;
  severity: Severidade;
  title: string;
  detail: string;
  action: string;
  connected_account_id: string | null;
  campaign_id: string | null;
  provider: string | null;
};

/** Limiares de partida [S]: medidos no piloto e ajustados aqui, num lugar só. */
export const LIMIARES = {
  /** Janela dos avisos de venda. */
  dias: 7,
  /** Gasto mínimo da campanha na janela para o aviso valer (R$ 20). */
  gastoMinimoMicros: 20_000_000n,
  /** Leitura dos pedidos (a cada 15 minutos): atrasada depois de 2 horas, parada depois de 1 dia. */
  vendasAtrasadasMin: 120,
  vendasParadasMin: 1440,
  /** Margem desconhecida acima desta parte da receita atribuída. */
  margemDesconhecidaPct: 20,
  /** O cupom exclusivo precisa estar ligado há pelo menos estes dias para "sem uso" virar aviso. */
  diasDoVinculo: 3,
  /** Plataforma × caixa: uma informa o dobro (ou a metade) da outra. */
  distancia: 2,
} as const;

const NOMES: Record<string, string> = { meta_ads: 'Meta', google_ads: 'Google Ads' };
const nomePlataforma = (p: string) => NOMES[p] ?? p;

/** "R$ 152,60" a partir de micros, arredondado ao centavo. */
export function reais(micros: bigint): string {
  const centavos = (micros + (micros >= 0n ? 5_000n : -5_000n)) / 10_000n;
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(centavos) / 100);
}

const plural = (n: number, um: string, varios: string) => (n === 1 ? um : varios);

// ------------------------------------------------------------------ fonte das vendas

export type LojaDoRegem = {
  id: string;
  /** Nome da loja do Liame (ou da loja no Regem). */
  nome: string;
  status: string;
  statusReason: string | null;
  fuso: string | null;
  /** Última leitura dos pedidos com sucesso. */
  pedidosLidosEm: Date | string | null;
};

/** O Regem da loja parado, sem permissão, falhando ou com os pedidos atrasados. */
export function avisosDaFonte(loja: LojaDoRegem, agora: Date): ItemCiclo[] {
  const base = { connected_account_id: loja.id, campaign_id: null, provider: 'regem' };
  if (loja.status === 'desconectada') {
    return [
      {
        ...base,
        kind: 'conta_desconectada',
        severity: 'critica',
        title: `O Regem da ${loja.nome} está desconectado`,
        detail: loja.statusReason ?? 'O Regem recusou a autorização da loja.',
        action: 'Conecte o Regem de novo em Contas conectadas: sem ele, as vendas das campanhas param de chegar.',
      },
    ];
  }
  if (loja.status === 'sem_permissao') {
    return [
      {
        ...base,
        kind: 'conta_sem_permissao',
        severity: 'atencao',
        title: `Sem permissão para ler as vendas da ${loja.nome}`,
        detail: loja.statusReason ?? 'A loja não liberou a leitura dos pedidos.',
        action: 'Libere a leitura dos pedidos para o Liame no Regem da loja.',
      },
    ];
  }
  const itens: ItemCiclo[] = [];
  if (loja.status === 'erro') {
    itens.push({
      ...base,
      kind: 'conta_com_erro',
      severity: 'atencao',
      title: `A leitura das vendas da ${loja.nome} está falhando`,
      detail: loja.statusReason ?? 'A última leitura falhou.',
      action: 'Nada a fazer por enquanto: tentamos de novo sozinhos. Se continuar amanhã, fale com o suporte.',
    });
  }
  const lidos = loja.pedidosLidosEm ? new Date(loja.pedidosLidosEm).getTime() : null;
  const atrasoMin = lidos === null ? null : (agora.getTime() - lidos) / 60_000;
  if (atrasoMin !== null && atrasoMin > LIMIARES.vendasAtrasadasMin) {
    const quando = new Date(lidos!).toLocaleString('pt-BR', { timeZone: loja.fuso ?? 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
    itens.push({
      ...base,
      kind: 'dado_atrasado',
      severity: atrasoMin > LIMIARES.vendasParadasMin ? 'critica' : 'atencao',
      title: `As vendas da ${loja.nome} estão atrasadas`,
      detail: `Última leitura dos pedidos: ${quando}.`,
      action: 'Os números de vendas podem não refletir agora; se continuar, confira a conexão do Regem em Contas conectadas.',
    });
  }
  return itens;
}

/** Marca com conta de anúncio e sem o Regem: só dá para mostrar o que a plataforma informa. */
export function avisoSemRegem(): ItemCiclo {
  return {
    kind: 'vendas_nao_conectadas',
    severity: 'info',
    title: 'O Regem não está conectado',
    detail: 'Sem as vendas da loja, o Liame mostra só o que a plataforma de anúncio informa.',
    action: 'Conecte o Regem em Contas conectadas para ver quais campanhas vendem de verdade.',
    connected_account_id: null,
    campaign_id: null,
    provider: 'regem',
  };
}

// ------------------------------------------------------------------ como medir

const PLATAFORMAS: Record<string, { de: string; a: string; integrada: boolean }> = {
  regem: { de: 'do cardápio do Regem', a: 'ao cardápio do Regem', integrada: true },
  anotaai: { de: 'do Anota AI', a: 'ao Anota AI', integrada: true },
  cardapioweb: { de: 'do CardápioWeb', a: 'ao CardápioWeb', integrada: true },
  brendi: { de: 'da Brendi', a: 'à Brendi', integrada: false },
  outra: { de: 'da outra plataforma de pedidos', a: 'à outra plataforma de pedidos', integrada: false },
};

/** A loja ainda não disse onde recebe os pedidos online: sem isso, o Liame não sabe como medir as campanhas. */
export function avisoPlataformaNaoInformada(loja: { id: string; nome: string }): ItemCiclo {
  return {
    kind: 'plataforma_nao_informada',
    severity: 'info',
    title: `Confirme onde a ${loja.nome} recebe os pedidos online`,
    detail: 'É o que diz ao Liame como medir as vendas de cada campanha: pelo link com rastreio ou pelo cupom exclusivo.',
    action: 'Em Links e cupons, confirme a plataforma de pedidos da loja.',
    connected_account_id: loja.id,
    campaign_id: null,
    provider: 'regem',
  };
}

/** Loja que vende por plataforma que ainda não chega ao Regem (Brendi, outra): essas vendas não são medidas. */
export function avisoVendasNaoMedidas(loja: { id: string; nome: string }, plataforma: string): ItemCiclo {
  const p = PLATAFORMAS[plataforma] ?? PLATAFORMAS.outra!;
  return {
    kind: 'vendas_nao_medidas',
    severity: 'info',
    title: `As vendas ${p.de} da ${loja.nome} ainda não são medidas`,
    detail: 'Os pedidos de lá não chegam ao Regem, então o Liame não sabe quais anúncios vendem.',
    action: 'Por enquanto, acompanhe em Resultados o que a plataforma de anúncio informa.',
    connected_account_id: loja.id,
    campaign_id: null,
    provider: 'regem',
  };
}

/** Anúncios ativos sem os parâmetros do Liame (loja no cardápio do Regem): um aviso só, com a contagem. */
export function avisoAnunciosSemRastreio(semRastreio: number, campanhas: number): ItemCiclo | null {
  if (semRastreio <= 0) return null;
  return {
    kind: 'anuncio_sem_rastreio',
    severity: 'atencao',
    title: `${semRastreio} ${plural(semRastreio, 'anúncio ativo sem', 'anúncios ativos sem')} os parâmetros do Liame`,
    detail: `${plural(semRastreio, 'Ele está', 'Eles estão')} em ${campanhas} ${plural(campanhas, 'campanha', 'campanhas')}: as vendas que vierem ${plural(semRastreio, 'dele', 'deles')} ficam sem origem.`,
    action: 'Em Links e cupons, copie os parâmetros de cada campanha e cole no anúncio.',
    connected_account_id: null,
    campaign_id: null,
    provider: null,
  };
}

/** Campanhas ativas sem cupom exclusivo (loja em plataforma de pedidos integrada): um aviso só, com a contagem. */
export function avisoCampanhasSemCupom(semCupom: number, plataforma: string): ItemCiclo | null {
  if (semCupom <= 0) return null;
  const p = PLATAFORMAS[plataforma] ?? PLATAFORMAS.outra!;
  return {
    kind: 'campanha_sem_cupom',
    severity: 'atencao',
    title: `${semCupom} ${plural(semCupom, 'campanha ativa sem', 'campanhas ativas sem')} cupom exclusivo`,
    detail: `Os anúncios levam ${p.a}, e o clique não chega ao pedido: as vendas ${plural(semCupom, 'dela', 'delas')} ficam sem origem.`,
    action: 'Crie na plataforma de pedidos um cupom para cada campanha e informe o código em Links e cupons.',
    connected_account_id: null,
    campaign_id: null,
    provider: null,
  };
}

// ------------------------------------------------------------------ gasto sem venda

export type CampanhaNaJanela = {
  id: string;
  name: string;
  provider: string;
  connectedAccountId: string;
  /** Gasto na janela. */
  gastoMicros: bigint;
  /** Pedidos confirmados e contados para a campanha na janela. */
  pedidos: number;
  /** Anúncios ativos da campanha com os parâmetros do Liame (a campanha é medida pelo clique). */
  anunciosComRastreio: number;
  /** Tem cupom exclusivo em vigor (o aviso do cupom cobre). */
  temCupomExclusivo: boolean;
};

/** Campanha medida pelo clique, com gasto na janela e nenhum pedido confirmado. */
export function avisoCampanhaSemPedido(c: CampanhaNaJanela): ItemCiclo | null {
  if (c.temCupomExclusivo || c.anunciosComRastreio <= 0 || c.pedidos > 0 || c.gastoMicros < LIMIARES.gastoMinimoMicros) return null;
  return {
    kind: 'campanha_sem_pedido',
    severity: 'atencao',
    title: `A campanha "${c.name}" gastou ${reais(c.gastoMicros)} em ${LIMIARES.dias} dias e não teve pedido confirmado`,
    detail: `Os anúncios levam os parâmetros do Liame, e nenhum pedido chegou por eles no período (${nomePlataforma(c.provider)}).`,
    action: 'Confira em Resultados o que a plataforma informa e reveja a oferta e o destino do anúncio.',
    connected_account_id: c.connectedAccountId,
    campaign_id: c.id,
    provider: c.provider,
  };
}

export type CupomNaJanela = {
  code: string;
  campaignId: string;
  campaignName: string;
  provider: string;
  connectedAccountId: string;
  /** Desde quando o cupom está ligado à campanha. */
  ligadoEm: Date | string;
  usos: number;
  gastoMicros: bigint;
};

/** Cupom exclusivo ligado há dias, sem nenhum uso, com a campanha gastando. */
export function avisoCupomSemUso(c: CupomNaJanela, agora: Date): ItemCiclo | null {
  const ligadoHaDias = (agora.getTime() - new Date(c.ligadoEm).getTime()) / 86_400_000;
  if (c.usos > 0 || ligadoHaDias < LIMIARES.diasDoVinculo || c.gastoMicros < LIMIARES.gastoMinimoMicros) return null;
  return {
    kind: 'cupom_sem_uso',
    severity: 'atencao',
    title: `O cupom ${c.code} não teve nenhum uso em ${LIMIARES.dias} dias`,
    detail: `Ele é o cupom exclusivo da campanha "${c.campaignName}", que gastou ${reais(c.gastoMicros)} no período (${nomePlataforma(c.provider)}).`,
    action: 'Confira se o código aparece no anúncio e na conversa do WhatsApp.',
    connected_account_id: c.connectedAccountId,
    campaign_id: c.campaignId,
    provider: c.provider,
  };
}

// ------------------------------------------------------------------ margem e plataforma × caixa

/** Margem desconhecida em mais de 20% da receita atribuída: o veredito das campanhas fica sem base. */
export function avisoMargemDesconhecida(receitaMicros: bigint, semMargemMicros: bigint, lojaLiberaCusto: boolean): ItemCiclo | null {
  if (receitaMicros <= 0n || semMargemMicros <= 0n) return null;
  const pct = Number((semMargemMicros * 1000n) / receitaMicros) / 10;
  if (pct <= LIMIARES.margemDesconhecidaPct) return null;
  return {
    kind: 'margem_desconhecida',
    severity: 'atencao',
    title: `Margem desconhecida em ${pct.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}% da receita das campanhas`,
    detail: `${reais(semMargemMicros)} de ${reais(receitaMicros)} atribuídos em ${LIMIARES.dias} dias vieram de pedidos com item sem custo.`,
    action: lojaLiberaCusto
      ? 'Cadastre o custo (ficha técnica) dos produtos no Regem: sem ele, o Liame não sabe se a campanha dá lucro.'
      : 'A loja ainda não liberou o custo dos produtos para o Liame: sem ele, não dá para saber se a campanha dá lucro.',
    connected_account_id: null,
    campaign_id: null,
    provider: 'regem',
  };
}

/** A plataforma informa o dobro (ou a metade) do que o caixa confirmou: informativo, com o porquê. */
export function avisoPlataformaCaixa(provider: string, plataformaMicros: bigint, caixaMicros: bigint): ItemCiclo | null {
  if (plataformaMicros <= 0n || caixaMicros <= 0n) return null;
  const d = BigInt(LIMIARES.distancia);
  if (plataformaMicros < caixaMicros * d && caixaMicros < plataformaMicros * d) return null;
  const nome = nomePlataforma(provider);
  return {
    kind: 'plataforma_x_caixa',
    severity: 'info',
    title: `${provider === 'meta_ads' ? 'A Meta' : `O ${nome}`} informa ${reais(plataformaMicros)} em vendas; no caixa, o Liame confirmou ${reais(caixaMicros)}`,
    detail: `Em ${LIMIARES.dias} dias. A plataforma conta pela janela dela; o Liame conta só o pedido com prova (cupom exclusivo, clique ou conversa).`,
    action: 'Use o número confirmado para decidir; a diferença é esperada quando parte das vendas não tem como ser ligada ao anúncio.',
    connected_account_id: null,
    campaign_id: null,
    provider,
  };
}

// ------------------------------------------------------------------ ordem

const ORDEM: Record<Severidade, number> = { critica: 0, atencao: 1, info: 2 };

/** Dentro da mesma gravidade: a fonte parada, as vendas fora do normal, o que impede medir, o dinheiro, depois o resto. */
const PRIORIDADE: TipoCiclo[] = [
  'conta_desconectada',
  'dado_atrasado',
  'conta_sem_permissao',
  'conta_com_erro',
  'vendas_fora_do_normal',
  'anuncio_sem_rastreio',
  'campanha_sem_cupom',
  'campanha_sem_pedido',
  'gasto_acima_da_verba',
  'gasto_da_campanha_fora_do_normal',
  'custo_por_pedido_fora_do_normal',
  'sugestao_pausar_campanha',
  'sugestao_reduzir_verba',
  'sugestao_aumentar_verba',
  'cupom_sem_uso',
  'margem_desconhecida',
  'vendas_nao_conectadas',
  'plataforma_nao_informada',
  'vendas_nao_medidas',
  'plataforma_x_caixa',
];

export function ordenarCiclo(itens: ItemCiclo[]): ItemCiclo[] {
  return itens
    .map((item, i) => ({ item, i }))
    .sort((a, b) => ORDEM[a.item.severity] - ORDEM[b.item.severity] || PRIORIDADE.indexOf(a.item.kind) - PRIORIDADE.indexOf(b.item.kind) || a.i - b.i)
    .map((x) => x.item);
}

/** A plataforma de pedidos chega ao Regem (as vendas dela são medidas pelo cupom). */
export const plataformaIntegrada = (p: string) => p === 'anotaai' || p === 'cardapioweb';
