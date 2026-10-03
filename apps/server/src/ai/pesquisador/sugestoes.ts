import type { BrandDossierContent, BrandDossierSuggestionItem, DossierSection } from '@liame/contracts';
import { chaveDoItem, cobre } from '../../marca/sugestoes.js';
import { limparTexto } from '../sanitizar.js';
import type { RotulosConferidos, TipoDePagina } from './leitura.js';

// O que o Pesquisador sugere para o dossiê (A3, I12; protótipo P6, aguardando aprovação), a partir dos rótulos que
// passaram na conferência. Da página da própria marca: os produtos (com o preço da página) e as ofertas que o dossiê
// ainda não tem. Da página de um concorrente: o concorrente, com o que ele diz de si e uma oferta dele. Nada entra no
// dossiê sozinho: é sugestão, e o que a pessoa recusou há pouco não volta. Funções puras.

const MAX_TEXTO = 160;
const MAX_MOTIVO = 200;
const cortar = (t: string, max = MAX_TEXTO) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);
/** Máximo de itens por sugestão. */
export const ITENS_POR_SUGESTAO = { produtos: 8, ofertas: 5, concorrentes: 1 } as const;

export type SugestoesDaLeitura = Partial<Record<DossierSection, BrandDossierSuggestionItem[]>>;

/**
 * As sugestões de uma leitura: por parte do dossiê, só os itens novos (o dossiê ainda não cobre), sem dado pessoal e
 * sem o que a pessoa recusou nos últimos 30 dias. `origem` diz de onde e quando (vai no "por quê" de cada item).
 */
export function sugestoesDaLeitura(
  tipo: TipoDePagina,
  r: RotulosConferidos,
  dossie: BrandDossierContent,
  recusa: (secao: DossierSection) => ReadonlySet<string>,
  origem: { host: string; dia: string },
): SugestoesDaLeitura {
  const porque = cortar(`escrito em ${origem.host}, lido em ${origem.dia}`, MAX_MOTIVO);
  const filtrar = (secao: DossierSection, itens: BrandDossierSuggestionItem[], max: number) =>
    itens.filter((i) => !recusa(secao).has(chaveDoItem(i)) && limparTexto(i.text).removidos === 0).slice(0, max);
  if (tipo === 'concorrente') {
    const nome = r.negocio ?? origem.host;
    if (dossie.competitors.items.some((c) => cobre(c.text, nome))) return {};
    const sobre = [r.diferenciais[0], r.ofertas[0]].filter((x): x is string => !!x);
    const item: BrandDossierSuggestionItem = { op: 'incluir', text: cortar(sobre.length ? `${nome}: ${sobre.join('; ')}` : nome), before: null, why: porque };
    const itens = filtrar('concorrentes', [item], ITENS_POR_SUGESTAO.concorrentes);
    return itens.length ? { concorrentes: itens } : {};
  }
  const produtos = filtrar(
    'produtos',
    r.produtos
      .filter((p) => !dossie.products.items.some((d) => cobre(d, p.nome)))
      .map((p): BrandDossierSuggestionItem => ({ op: 'incluir', text: cortar(p.preco ? `${p.nome}, ${p.preco}` : p.nome), before: null, why: porque })),
    ITENS_POR_SUGESTAO.produtos,
  );
  const ofertas = filtrar(
    'ofertas',
    r.ofertas.filter((o) => !dossie.offers.items.some((d) => cobre(d, o))).map((o): BrandDossierSuggestionItem => ({ op: 'incluir', text: cortar(o), before: null, why: porque })),
    ITENS_POR_SUGESTAO.ofertas,
  );
  return { ...(produtos.length ? { produtos } : {}), ...(ofertas.length ? { ofertas } : {}) };
}

/** Junta a sugestão que já espera a pessoa com os itens novos (sem repetir), até o máximo da parte. */
export function juntarItens(pendente: BrandDossierSuggestionItem[], novos: BrandDossierSuggestionItem[], max: number): BrandDossierSuggestionItem[] {
  const vistos = new Set(pendente.map(chaveDoItem));
  return [...pendente, ...novos.filter((n) => !vistos.has(chaveDoItem(n)))].slice(0, max);
}
