import type { ConversationStaleSource } from '@liame/contracts';
import { DO_MEMBRO } from '../registro/visoes/equipe.js';
import { FERRAMENTA_ABRIR_DEMANDA, FERRAMENTA_PROPOR_CUPOM } from './prompt.js';

// O que a tela diz de cada ferramenta que a LIA usa (protótipo P5): o passo enquanto ela lê ("Lendo os
// resultados de 22/09 a 28/09") e a lista "A LIA leu". E o que o código tira de cada leitura: as fontes fora
// do dia e os nomes que vieram dos dados da empresa. Tudo escrito pelo código, a partir dos parâmetros que a
// ferramenta aceitou; nada aqui vem do texto do modelo.

const DIA = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "2026-09-22" → "22/09"; o que não é dia, nulo. */
function diaCurto(v: unknown): string | null {
  const m = typeof v === 'string' ? DIA.exec(v) : null;
  return m ? `${m[3]}/${m[2]}` : null;
}

/** " de 22/09 a 28/09", quando os dois dias vieram. */
function doPeriodo(input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as { from?: unknown; to?: unknown };
  const [de, ate] = [diaCurto(i.from), diaCurto(i.to)];
  return de && ate ? (de === ate ? ` de ${de}` : ` de ${de} a ${ate}`) : '';
}

/** O passo, enquanto a ferramenta roda. */
export function rotuloDoPasso(ferramenta: string, input: unknown): string {
  switch (ferramenta) {
    case 'resultados_ciclo_fechado':
      return `Lendo os resultados${doPeriodo(input)}`;
    case 'midia_entrega':
      return `Lendo a entrega dos anúncios${doPeriodo(input)}`;
    case 'atencao_avisos':
      return 'Lendo os avisos da Atenção';
    case 'fontes_frescor':
      return 'Conferindo se as fontes estão em dia';
    case 'cupons_campanha':
      return 'Lendo os cupons da marca';
    case 'links_rastreio':
      return 'Lendo os links e a conferência do rastreio';
    case 'equipe_trabalho': {
      const funcionario = (input && typeof input === 'object' ? (input as { funcionario?: unknown }).funcionario : null) as string | null | undefined;
      const deQuem = typeof funcionario === 'string' ? DO_MEMBRO[funcionario] : undefined;
      return deQuem ? `Lendo o trabalho ${deQuem} em Sua equipe` : 'Lendo o trabalho da equipe';
    }
    case FERRAMENTA_ABRIR_DEMANDA:
      return 'Registrando a demanda';
    case FERRAMENTA_PROPOR_CUPOM:
      return 'Enviando a proposta para Aprovações';
    default:
      return 'Lendo os dados';
  }
}

/** O que a LIA leu, na lista ao fim da resposta; nulo para o que não é leitura (a demanda). */
export function rotuloDaLeitura(ferramenta: string, input: unknown): string | null {
  switch (ferramenta) {
    case 'resultados_ciclo_fechado':
      return `Resultados${doPeriodo(input)}`;
    case 'midia_entrega':
      return `Entrega dos anúncios${doPeriodo(input)}`;
    case 'atencao_avisos':
      return 'Avisos da Atenção';
    case 'fontes_frescor':
      return 'Frescor das fontes';
    case 'cupons_campanha':
      return 'Cupons';
    case 'links_rastreio':
      return 'Links e rastreio';
    case 'equipe_trabalho':
      return 'Sua equipe';
    default:
      return null;
  }
}

const EM_DIA = 'em dia';
const texto = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const lista = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);

/**
 * As fontes fora do dia de uma leitura, pelo que a própria leitura diz: as fontes dos resultados (contas de
 * anúncio e o caixa do Regem) e a leitura dos cupons de cada loja. As outras leituras não trazem frescor; o
 * aviso de conta atrasada já está nos avisos da Atenção.
 */
export function foraDoDia(ferramenta: string, valor: unknown): ConversationStaleSource[] {
  const v = (valor && typeof valor === 'object' ? valor : {}) as Record<string, unknown>;
  if (ferramenta === 'resultados_ciclo_fechado') {
    return lista(v.fontes)
      .filter((f) => texto(f.frescor) !== null && f.frescor !== EM_DIA)
      .map((f) => ({ platform: texto(f.plataforma), name: texto(f.conta) ?? '', freshness: texto(f.frescor)!, last_read: texto(f.ultima_leitura) }));
  }
  if (ferramenta === 'cupons_campanha') {
    return lista(v.lojas)
      .filter((l) => texto(l.leitura_dos_cupons) !== null && l.leitura_dos_cupons !== EM_DIA)
      .map((l) => ({ platform: 'Regem', name: texto(l.loja) ?? '', freshness: texto(l.leitura_dos_cupons)!, last_read: texto(l.ultima_leitura) }));
  }
  return [];
}

/** Campos que guardam um nome vindo dos dados da empresa (não texto do sistema). */
// Na leitura da equipe, o nome do que um funcionário tratou: a conversa, a demanda, o plano e o site (`assunto`, no
// acontecimento que a visão ainda não conhece).
const CAMPOS_DE_NOME = new Set(['campanha', 'conta', 'loja', 'nome', 'codigo', 'conversa', 'demanda', 'plano', 'site', 'assunto']);

/** Os nomes da empresa numa leitura (campanha, conta, loja, cupom), para o Compliance e para não marcar número de nome. */
export function nomesDaLeitura(valor: unknown): string[] {
  const nomes = new Set<string>();
  const andar = (v: unknown, chave: string | null) => {
    if (typeof v === 'string') {
      if (chave && CAMPOS_DE_NOME.has(chave) && v.trim()) nomes.add(v);
      return;
    }
    if (Array.isArray(v)) for (const x of v) andar(x, chave);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) andar(x, k);
  };
  andar(valor, null);
  return [...nomes];
}
