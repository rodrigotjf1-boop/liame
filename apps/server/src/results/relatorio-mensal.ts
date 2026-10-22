import type { AttentionItem, ClosedLoopResponse, MonthlyReport, MonthlyReportWeek, SourceFreshness } from '@liame/contracts';
import { dia, dinheiro, inteiro, razao } from '../ai/registro/formatos.js';
import { diaNoFuso, menosDias } from './fora-do-normal.js';
import { campanhasDaSemana, diaIso, maisDias } from './revisao-semanal.js';

// O relatório do mês (A3, I7; protótipo P24, decisões D-A3-18 a D-A3-22), em funções puras: qual é o mês fechado,
// as semanas dele (cortadas no mês), quando ele sai e o que fica para o mês seguinte. Os números são os da tela
// Resultados (`closedLoop`) no mês, no mês anterior e em cada semana; a comparação é a da revisão da semana
// (`revisao-semanal.ts`), e a leitura em texto é do Explicar, pela mesma tarefa.

/** Versão do conteúdo guardado em `monthly_report.content` (contrato `MonthlyReport`). */
export const RELATORIO_VERSAO = 1;
/** O conteúdo guardado em `monthly_report.content`: o relatório sem o id e sem a situação do e-mail (essas moram nas colunas). */
export type ConteudoDoRelatorio = Omit<MonthlyReport, 'id' | 'email'>;
/** O relatório sai no dia 1º, a partir desta hora, no fuso da loja (D-A3-19). */
export const HORA_DE_GERAR = 5;
/** Com a leitura que traz o último dia ainda sem chegar, o relatório espera até esta hora; depois, sai com o que há. */
export const HORA_LIMITE = 9;
/** O e-mail não sai antes desta hora (D-A3-19). */
export const HORA_DO_EMAIL = 7;
/** O relatório de um mês só é gerado (ou enviado) até este dia do mês seguinte: depois, já não é notícia. */
export const DIA_LIMITE = 7;
/** Quantos itens em "Para o mês que vem", no máximo. */
export const DECISOES_MAXIMO = 5;

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export type Mes = { from: string; to: string };

/** O mês de um dia: "2026-10-22" → de "2026-10-01" a "2026-10-31". */
export function mesDe(dia: string): Mes {
  const from = `${dia.slice(0, 7)}-01`;
  const [ano, mes] = [Number(dia.slice(0, 4)), Number(dia.slice(5, 7))];
  const seguinte = mes === 12 ? `${ano + 1}-01-01` : `${ano}-${String(mes + 1).padStart(2, '0')}-01`;
  return { from, to: menosDias(seguinte, 1) };
}

/** O último mês fechado antes do dia dado: em qualquer dia de outubro, setembro. */
export const mesFechado = (hoje: string): Mes => mesDe(menosDias(`${hoje.slice(0, 7)}-01`, 1));

/** O mês logo antes de um mês. */
export const mesAnterior = (mes: Mes): Mes => mesDe(menosDias(mes.from, 1));

/** O dia em que o relatório de um mês sai: o dia 1º do mês seguinte. */
export const diaDoRelatorio = (mes: Mes): string => maisDias(mes.to, 1);

/** O mês pedido pela rota (`2026-09`) como período. */
export const mesPedido = (aaaaMm: string): Mes => mesDe(`${aaaaMm}-01`);

/** Ainda no prazo de gerar ou de enviar o relatório do mês? Do dia 1º ao dia 7 do mês seguinte. */
export const noPrazo = (hoje: string, mes: Mes): boolean => hoje >= diaDoRelatorio(mes) && hoje <= maisDias(diaDoRelatorio(mes), DIA_LIMITE - 1);

/**
 * O dia 1º em que sai o próximo relatório: hoje, se é dia 1º e o do mês que fechou ainda não saiu; senão, o dia 1º
 * do mês seguinte.
 */
export function proximoRelatorio(hoje: string, ultimoMesComRelatorio: string | null): string {
  if (hoje.endsWith('-01') && ultimoMesComRelatorio !== mesFechado(hoje).from) return hoje;
  return diaDoRelatorio(mesDe(hoje));
}

/** "setembro de 2026". */
export const nomeDoMes = (mes: Mes): string => `${MESES[Number(mes.from.slice(5, 7)) - 1]} de ${mes.from.slice(0, 4)}`;
/** "setembro". */
export const mesCurto = (mes: Mes): string => MESES[Number(mes.from.slice(5, 7)) - 1]!;

// ------------------------------------------------------------ as semanas do mês

export type SemanaDoMes = { from: string; to: string; days: number; week: { from: string; to: string } };

const DIA_MS = 86_400_000;
const diasEntre = (de: string, ate: string) => Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / DIA_MS);

/** Cada semana de segunda a domingo que tem dia no mês, cortada no mês: as das pontas ficam com menos dias. */
export function semanasDoMes(mes: Mes): SemanaDoMes[] {
  const semanas: SemanaDoMes[] = [];
  for (let segunda = menosDias(mes.from, diaIso(mes.from) - 1); segunda <= mes.to; segunda = maisDias(segunda, 7)) {
    const domingo = maisDias(segunda, 6);
    const from = segunda < mes.from ? mes.from : segunda;
    const to = domingo > mes.to ? mes.to : domingo;
    semanas.push({ from, to, days: diasEntre(from, to) + 1, week: { from: segunda, to: domingo } });
  }
  return semanas;
}

/** Os números de uma semana do mês: os do ciclo fechado nos dias dela dentro do mês. */
export function semanaComNumeros(s: SemanaDoMes, dados: ClosedLoopResponse, temRevisao: boolean): MonthlyReportWeek {
  const t = dados.totals;
  return {
    from: s.from,
    to: s.to,
    days: s.days,
    week: s.week,
    has_review: temRevisao,
    spend_micros: t.spend_micros,
    orders: t.confirmed.orders,
    revenue_micros: t.confirmed.revenue_micros,
    roas: t.confirmed.roas,
    verdict: t.confirmed.verdict,
  };
}

/**
 * O nome pronto de uma semana, para a leitura do mês (D-A3-21): "a semana de 01/09/2026 a 06/09/2026", nunca "semana
 * 1" (ERR-074). Com o ano: a conferência dos números lê a data inteira como um valor só, e o dia e o mês sem o ano
 * ("01/09") como dois números soltos, que ficariam autorizados em qualquer frase da leitura (ERR-151, V139).
 */
export const nomeDaSemana = (s: { from: string; to: string }): string => `a semana de ${dia(s.from)} a ${dia(s.to)}`;

/** Uma semana como a leitura do mês a recebe: o nome pronto e os números já escritos (a IA não faz conta, A3-5). */
export type SemanaNoContexto = {
  semana: string;
  investimento: string | null;
  pedidos_com_origem: string | null;
  receita_com_origem: string | null;
  roas_confirmado: string | null;
};

export function semanaNoContexto(s: MonthlyReportWeek, moeda: string): SemanaNoContexto {
  return {
    semana: nomeDaSemana(s),
    investimento: dinheiro(s.spend_micros, moeda),
    pedidos_com_origem: inteiro(s.orders),
    receita_com_origem: dinheiro(s.revenue_micros, moeda),
    roas_confirmado: razao(s.roas),
  };
}

// ------------------------------------------------------------ as fontes

/** A conta de anúncio já foi lida depois do fim do mês? Só essa leitura traz o último dia inteiro. */
const lidaDepoisDoMes = (s: SourceFreshness, mes: Mes, fuso: string): boolean => s.last_success_at !== null && diaNoFuso(s.last_success_at, fuso) >= diaDoRelatorio(mes);

/** Os números do mês estão completos? Toda fonte dentro do prazo e, nas contas de anúncio, uma leitura feita depois do fim do mês. */
export function mesEmDia(fontes: SourceFreshness[], mes: Mes, fuso: string): boolean {
  return fontes.length > 0 && fontes.every((s) => s.freshness === 'fresh' && (s.dataset !== 'metricas' || lidaDepoisDoMes(s, mes, fuso)));
}

/**
 * Os mesmos resultados, com a conta de anúncio que ainda não foi lida depois do fim do mês marcada como atrasada:
 * pelo prazo normal ela está "em dia", mas o último dia dela pode estar incompleto. É o que a leitura do mês recebe
 * quando o relatório sai sem esperar mais: com fonte atrasada, a LIA não é chamada, e a leitura do sistema diz qual.
 */
export function comAtrasoMarcadoNoMes(atual: ClosedLoopResponse, mes: Mes, fuso: string): ClosedLoopResponse {
  return {
    ...atual,
    sources: atual.sources.map((s) => (s.dataset === 'metricas' && s.freshness === 'fresh' && !lidaDepoisDoMes(s, mes, fuso) ? { ...s, freshness: 'delayed' } : s)),
  };
}

// ------------------------------------------------------------ para o mês que vem

const GRAVIDADE = ['critica', 'atencao'];

/**
 * "Para o mês que vem": as campanhas que deram prejuízo no mês (pela regra do veredito da tela Resultados), na
 * ordem da lista das campanhas, e os avisos críticos e de atenção que estavam ativos na geração, os mais graves
 * primeiro. O Liame aponta; quem decide é a pessoa.
 */
export function paraOMesQueVem(atual: ClosedLoopResponse, avisos: AttentionItem[], brandId: string, mes: Mes): AttentionItem[] {
  const naOrdem = new Map(campanhasDaSemana(atual).map((c, i) => [c.campaign_id, i]));
  const emPrejuizo = atual.campaigns
    .filter((c) => naOrdem.has(c.campaign_id) && c.confirmed.verdict === 'prejuizo')
    .sort((x, y) => naOrdem.get(x.campaign_id)! - naOrdem.get(y.campaign_id)!)
    .map((c): AttentionItem => {
      // O prejuízo é pela margem, não pela receita (como na revisão da semana): o texto diz quanto faltou.
      const investido = BigInt(c.platform.spend_micros);
      const margem = c.confirmed.margin_known_micros === null ? null : BigInt(c.confirmed.margin_known_micros);
      const valores = `${dinheiro(c.confirmed.revenue_micros, atual.currency)} de receita para ${dinheiro(c.platform.spend_micros, atual.currency)} investidos no mês`;
      return {
        kind: 'prejuizo_no_mes',
        severity: 'atencao',
        title: `${c.name} deu prejuízo em ${mesCurto(mes)}`,
        detail:
          margem !== null && margem < investido
            ? `Faltaram ${dinheiro((investido - margem).toString(), atual.currency)} para a margem dos pedidos pagar o anúncio: ${valores}.`
            : `${valores}.`,
        action: 'Veja a campanha em Resultados e decida se ela continua como está.',
        connected_account_id: null,
        campaign_id: c.campaign_id,
        provider: c.provider,
        brand_id: brandId,
      };
    });
  const ordem = (i: AttentionItem) => GRAVIDADE.indexOf(i.severity);
  const ativos = avisos.filter((i) => GRAVIDADE.includes(i.severity)).sort((a, b) => ordem(a) - ordem(b));
  return [...emPrejuizo, ...ativos].slice(0, DECISOES_MAXIMO);
}
