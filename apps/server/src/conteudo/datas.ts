// As datas e as tendências do plano de conteúdo (plano de conteúdo, PC4, parte 2; seção 6.3; D-PC-10 e D-PC-18). Contas
// puras, sem banco e sem rede. Junta o calendário comercial do Liame (feriados nacionais e datas do varejo, cada uma com
// a lei ou a regra: §16.5) com os eventos do Pulso, o produto da DMS que lê as fontes públicas: os feriados e os pontos
// facultativos do estado e da cidade, os dias de comida (conferidos em calendários do setor e aprovados por uma pessoa da
// DMS), os jogos, as estreias e o dinheiro no bolso. As datas sempre vêm de uma tabela ou de uma fonte com data, nunca da
// memória do modelo. O "Em alta" do Pulso só traz assunto com manchete de portal brasileiro (título, link e fonte).

import { textoComparavel } from './produtos.js';

/** O período máximo que a rota aceita: o plano vai até 31 dias (D-PC-4), com folga para a semana seguinte. */
export const DIAS_NO_PERIODO_MAXIMO = 62;
/** Quantos assuntos em alta a resposta traz. */
export const ASSUNTOS_EM_ALTA = 10;

/** Uma linha do calendário comercial do Liame (`commercial_date`). */
export type DataComercial = { day: string; name: string; kind: string; source: string };

/** Um evento como o Pulso devolve (lido sem confiar: o que vem torto fica de fora antes daqui). */
export type EventoDoPulso = {
  id: string;
  tipo: string;
  nome: string;
  dia_inteiro: boolean;
  inicio: string;
  fim: string | null;
  fuso: string;
  abrangencia: Array<{ nivel: string; valor: string }>;
  detalhes: Record<string, unknown> | null;
  fonte: { nome: string; endereco: string | null };
};

/** Um assunto em alta como o Pulso devolve. */
export type AssuntoDoPulso = {
  titulo: string;
  nota: number;
  faixa: string;
  monte: string;
  onde: { nivel: string; valor: string | null };
  manchetes: Array<{ titulo: string; link: string; fonte: string | null }>;
};

export interface DataDoPlano {
  day: string;
  end_day: string;
  /** A hora (HH:MM, no fuso do evento) do evento com hora, como o jogo; nula no evento do dia inteiro. */
  time: string | null;
  name: string;
  /**
   * `feriado_nacional` e `varejo` (o calendário do Liame); `feriado`, `ponto_facultativo`, `comida`, `comemorativa`,
   * `dinheiro`, `jogo`, `estreia` e `tv` (o Pulso).
   */
  kind: string;
  /** `nacional`, `uf` ou `municipio`. */
  scope: string;
  source: { name: string; url: string | null };
  origin: 'liame' | 'pulso';
  /** O tema do dia de comida (`hamburguer`, `pizza`...); nulo nos outros. */
  food_theme: string | null;
  /** O dia de comida combina com o cardápio da marca (o tema aparece nos nomes dos produtos ou em Minha marca). */
  menu_match: boolean;
}

/**
 * As palavras que mostram o tema de cada dia de comida no cardápio (os temas são os do Pulso, `comida.mjs`). O Dia do
 * Garçom é da equipe, não do cardápio: nunca "combina".
 */
export const PALAVRAS_DO_TEMA: Readonly<Record<string, readonly string[]>> = Object.freeze({
  churrasco: ['churrasco', 'picanha', 'espeto', 'costela'],
  cafe: ['cafe', 'espresso', 'expresso', 'cappuccino', 'capuccino'],
  hamburguer: ['hamburguer', 'hamburger', 'burger', 'burguer', 'smash'],
  batata_frita: ['batata frita', 'fritas', 'batata'],
  chocolate: ['chocolate', 'brownie', 'brigadeiro'],
  pizza: ['pizza'],
  cerveja: ['cerveja', 'chopp', 'chope'],
  pao_de_queijo: ['pao de queijo'],
  sorvete: ['sorvete', 'gelato', 'milkshake', 'milk shake'],
  sushi: ['sushi', 'temaki', 'sashimi', 'uramaki'],
});

/** O texto do cardápio tem a palavra do tema (palavra inteira, sem acento: "hambúrguer" casa com "Hamburguer"). */
export function combinaComOCardapio(tema: string | null, cardapio: string): boolean {
  if (!tema) return false;
  const palavras = PALAVRAS_DO_TEMA[tema];
  if (!palavras) return false;
  const texto = ` ${textoComparavel(cardapio)} `;
  return palavras.some((p) => texto.includes(` ${textoComparavel(p)} `));
}

/** O dia e a hora (no fuso dado) de um instante ISO. */
function diaEHora(instante: string, fuso: string): { dia: string; hora: string } | null {
  const d = new Date(instante);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const partes = new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
    const p = (t: string) => partes.find((x) => x.type === t)?.value ?? '';
    return { dia: `${p('year')}-${p('month')}-${p('day')}`, hora: `${p('hour')}:${p('minute')}` };
  } catch {
    return null;
  }
}

/** O alcance mais estreito do evento (a cidade vence o estado, que vence o país). */
function alcance(e: EventoDoPulso): string {
  const niveis = e.abrangencia.map((a) => a.nivel);
  if (niveis.includes('municipio')) return 'municipio';
  if (niveis.includes('uf')) return 'uf';
  return 'nacional';
}

const ORDEM_DO_TIPO = ['feriado_nacional', 'feriado', 'ponto_facultativo', 'varejo', 'comida', 'comemorativa', 'dinheiro', 'jogo', 'estreia', 'tv'];
const posicao = (k: string) => {
  const i = ORDEM_DO_TIPO.indexOf(k);
  return i < 0 ? ORDEM_DO_TIPO.length : i;
};

/**
 * As datas do período: as do calendário do Liame e as do Pulso, sem repetir. O evento do Pulso que cai no mesmo dia de
 * uma data do Liame com o mesmo nome (sem acento), ou que é feriado nacional no dia de um feriado nacional do Liame, fica
 * de fora (vale a do Liame, com a lei). Em ordem de dia, tipo e nome.
 */
export function datasDoPeriodo(comerciais: readonly DataComercial[], eventos: readonly EventoDoPulso[], de: string, ate: string, cardapio: string): DataDoPlano[] {
  const saida: DataDoPlano[] = comerciais
    .filter((c) => c.day >= de && c.day <= ate)
    .map((c) => ({
      day: c.day,
      end_day: c.day,
      time: null,
      name: c.name,
      kind: c.kind,
      scope: 'nacional',
      source: { name: c.source, url: null },
      origin: 'liame' as const,
      food_theme: null,
      menu_match: false,
    }));
  const doLiame = new Set(saida.map((d) => `${d.day}|${textoComparavel(d.name)}`));
  const feriadosDoLiame = new Set(saida.filter((d) => d.kind === 'feriado_nacional').map((d) => d.day));
  for (const e of eventos) {
    const comHora = !e.dia_inteiro;
    const inicio = comHora ? diaEHora(e.inicio, e.fuso) : { dia: e.inicio, hora: '' };
    const fim = comHora ? (e.fim ? diaEHora(e.fim, e.fuso) : inicio) : { dia: e.fim ?? e.inicio, hora: '' };
    if (!inicio || !fim) continue;
    if (fim.dia < de || inicio.dia > ate) continue;
    const escopo = alcance(e);
    if (doLiame.has(`${inicio.dia}|${textoComparavel(e.nome)}`)) continue;
    if (e.tipo === 'feriado' && escopo === 'nacional' && feriadosDoLiame.has(inicio.dia)) continue;
    const grupo = typeof e.detalhes?.grupo === 'string' ? e.detalhes.grupo : null;
    const tema = grupo === 'comida' && typeof e.detalhes?.tema === 'string' ? e.detalhes.tema : null;
    saida.push({
      day: inicio.dia,
      end_day: fim.dia,
      time: comHora ? inicio.hora : null,
      name: e.nome,
      kind: e.tipo === 'comemorativa' && grupo === 'comida' ? 'comida' : e.tipo,
      scope: escopo,
      source: { name: e.fonte.nome, url: e.fonte.endereco },
      origin: 'pulso',
      food_theme: tema,
      menu_match: combinaComOCardapio(tema, cardapio),
    });
  }
  return saida.sort((a, b) => a.day.localeCompare(b.day) || posicao(a.kind) - posicao(b.kind) || (a.time ?? '').localeCompare(b.time ?? '') || a.name.localeCompare(b.name, 'pt-BR'));
}

export interface AssuntoEmAlta {
  title: string;
  score: number;
  band: string;
  /** `do_tema` (um tema que a DMS vigia) ou `em_alta` (o que o Brasil ou o estado está lendo). */
  pile: string;
  scope: string;
  headlines: Array<{ title: string; url: string; source: string | null }>;
}

/** Os assuntos em alta: só os com manchete de portal (o Pulso já tira os outros), em ordem de nota, até 10. */
export function assuntosEmAlta(assuntos: readonly AssuntoDoPulso[]): AssuntoEmAlta[] {
  return assuntos
    .filter((a) => a.manchetes.length > 0)
    .sort((a, b) => b.nota - a.nota || a.titulo.localeCompare(b.titulo, 'pt-BR'))
    .slice(0, ASSUNTOS_EM_ALTA)
    .map((a) => ({
      title: a.titulo,
      score: a.nota,
      band: a.faixa,
      pile: a.monte,
      scope: a.onde.nivel,
      headlines: a.manchetes.slice(0, 3).map((m) => ({ title: m.titulo, url: m.link, source: m.fonte })),
    }));
}
