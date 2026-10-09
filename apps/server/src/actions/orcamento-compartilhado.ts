// O orçamento de uma campanha do Google Ads (A5; base de conhecimento §3.1). No Google, a verba não mora na campanha:
// mora num orçamento que ela aponta e que pode servir a várias campanhas. O Liame nunca muda um orçamento compartilhado
// (D-A5-4): mudar a verba de uma campanha mudaria a das outras sem ninguém pedir. Funções puras, sem dependência: servem
// ao conector do Google (que recusa a escrita) e ao registro de ferramentas (que recusa o plano, antes de virar pedido).

/** O orçamento que a campanha usa no Google. */
export type OrcamentoDaCampanha = {
  /** O id do orçamento no Google. */
  id: string;
  /** Criado para ser dividido, ou usado por mais de uma campanha: o Liame não muda. */
  compartilhado: boolean;
  /** Quantas campanhas usam este orçamento agora. */
  campanhas: number;
  /** A média diária do orçamento, em micros da moeda da conta (também quando é compartilhado); nula no de período. */
  diario_micros: number | null;
};

/** O orçamento compartilhado descrito no estado de um objeto de anúncio, se houver (o estado vem do conector do Google). */
export function orcamentoCompartilhado(estado: Record<string, unknown>): OrcamentoDaCampanha | null {
  const o = estado.orcamento as Partial<OrcamentoDaCampanha> | null | undefined;
  if (!o || typeof o !== 'object' || o.compartilhado !== true || typeof o.id !== 'string') return null;
  return { id: o.id, compartilhado: true, campanhas: typeof o.campanhas === 'number' ? o.campanhas : 1, diario_micros: typeof o.diario_micros === 'number' ? o.diario_micros : null };
}

/** Por que o Liame não muda a verba de um orçamento compartilhado, com quantas campanhas o dividem. */
export function motivoDoCompartilhado(o: Pick<OrcamentoDaCampanha, 'campanhas'>): string {
  const outras = Math.max(0, o.campanhas - 1);
  const quem = outras > 0 ? `com ${outras === 1 ? 'outra campanha' : `outras ${outras} campanhas`}` : 'entre campanhas';
  return `A verba desta campanha vem de um orçamento compartilhado ${quem} no Google: mudar aqui mudaria a verba ${outras === 1 ? 'dela' : 'delas'} também. O Liame não muda orçamento compartilhado.`;
}
