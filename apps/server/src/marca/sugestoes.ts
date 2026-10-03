import type { BrandDossierContent, BrandDossierSuggestionItem, DossierSection } from '@liame/contracts';
import { limparTexto } from '../ai/sanitizar.js';
import { chave } from './dossie.js';

// Sugestões do sistema para o dossiê (A3, I8): saem dos números, sem IA, e esperam uma pessoa conferir (nada
// entra no dossiê sozinho). Produtos: os mais vendidos no Regem que não estão no dossiê, e o do dossiê que não
// vendeu nada. Ofertas: os cupons exclusivos ligados a campanhas no Liame. O que a pessoa recusou há pouco não
// volta (nem o item que ela deixou desmarcado ao usar uma sugestão). Funções puras.

/** As partes que o sistema sabe sugerir sozinho. */
export const SECOES_DO_SISTEMA = ['produtos', 'ofertas'] as const satisfies readonly DossierSection[];

/** Dias em que uma recusa vale: depois disso, o item pode ser sugerido de novo. */
export const DIAS_DA_RECUSA = 30;
/** Janela das vendas olhadas. */
export const DIAS_DAS_VENDAS = 30;
/** Menos pedidos que isto na janela: não dá para dizer que um produto "não vendeu nada". */
export const PEDIDOS_PARA_TIRAR = 30;
/** Quantos dos mais vendidos o sistema olha. */
export const MAIS_VENDIDOS = 5;

export interface ProdutoVendido {
  nome: string;
  pedidos: number;
}
export interface CupomDeCampanha {
  codigo: string;
  campanha: string;
  /** Até quando vale (DD/MM), quando tem fim. */
  ate: string | null;
}

const MAX_TEXTO = 160;
const cortar = (t: string) => (t.length > MAX_TEXTO ? `${t.slice(0, MAX_TEXTO - 1)}…` : t);
/** Um nome cobre o outro (o dossiê diz "Combo sexta: smash e batata"; a venda, "Combo Sexta")? */
export const cobre = (a: string, b: string) => {
  const x = chave(a);
  const y = chave(b);
  return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
};
export const chaveDoItem = (i: Pick<BrandDossierSuggestionItem, 'op' | 'text'>) => `${i.op}:${chave(i.text)}`;
/** O dossiê não guarda dado pessoal: nome de produto ou de campanha com telefone, e-mail ou documento não vira sugestão. */
const semDadoPessoal = (i: BrandDossierSuggestionItem) => limparTexto(i.text).removidos === 0;

/** Os itens recusados há pouco: os de uma sugestão descartada e os deixados desmarcados numa sugestão usada. */
export function recusados(decididas: Array<{ status: string; items: BrandDossierSuggestionItem[]; used: number[] | null }>): Set<string> {
  const out = new Set<string>();
  for (const d of decididas) {
    d.items.forEach((item, i) => {
      if (d.status === 'descartada' || (d.status === 'usada' && !(d.used ?? []).includes(i))) out.add(chaveDoItem(item));
    });
  }
  return out;
}

/** Produtos: incluir os mais vendidos que faltam; tirar o do dossiê que não vendeu nada (com venda suficiente para dizer). */
export function sugerirProdutos(c: BrandDossierContent, vendidos: ProdutoVendido[], pedidosNaJanela: number, recusa: ReadonlySet<string>): BrandDossierSuggestionItem[] {
  const itens: BrandDossierSuggestionItem[] = [];
  vendidos.slice(0, MAIS_VENDIDOS).forEach((p, i) => {
    if (!c.products.items.some((d) => cobre(d, p.nome))) {
      itens.push({ op: 'incluir', text: cortar(p.nome), before: null, why: `${p.pedidos} ${p.pedidos === 1 ? 'pedido' : 'pedidos'} em ${DIAS_DAS_VENDAS} dias, o ${i + 1}º mais vendido` });
    }
  });
  if (pedidosNaJanela >= PEDIDOS_PARA_TIRAR) {
    for (const d of c.products.items) {
      if (!vendidos.some((p) => cobre(d, p.nome))) itens.push({ op: 'tirar', text: d, before: null, why: `nenhum pedido em ${DIAS_DAS_VENDAS} dias` });
    }
  }
  return itens.filter((i) => !recusa.has(chaveDoItem(i)) && semDadoPessoal(i)).slice(0, 8);
}

/** Ofertas: os cupons exclusivos ligados a campanhas que o dossiê ainda não cita. */
export function sugerirOfertas(c: BrandDossierContent, cupons: CupomDeCampanha[], recusa: ReadonlySet<string>): BrandDossierSuggestionItem[] {
  const noDossie = c.offers.items.map(chave);
  return cupons
    .filter((k) => !noDossie.some((d) => d.includes(chave(k.codigo))))
    .map((k): BrandDossierSuggestionItem => ({
      op: 'incluir',
      text: cortar(`${k.campanha}, com o cupom ${k.codigo}, exclusivo da campanha${k.ate ? `, até ${k.ate}` : ''}`),
      before: null,
      why: 'cupom exclusivo ligado à campanha no Liame',
    }))
    .filter((i) => !recusa.has(chaveDoItem(i)) && semDadoPessoal(i))
    .slice(0, 5);
}

/** Aplica os itens marcados de uma sugestão a uma lista do dossiê (incluir no fim, tirar, trocar no lugar). */
export function aplicarItens(lista: string[], itens: BrandDossierSuggestionItem[]): string[] {
  let out = [...lista];
  for (const item of itens) {
    if (item.op === 'incluir') {
      if (!out.some((d) => chave(d) === chave(item.text))) out.push(item.text);
    } else if (item.op === 'tirar') {
      out = out.filter((d) => chave(d) !== chave(item.text));
    } else {
      const antes = chave(item.before ?? '');
      out = out.map((d) => (chave(d) === antes ? item.text : d));
    }
  }
  return out;
}
