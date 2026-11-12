// A semana que vem e a referência do setor (plano da região, R2, parte 5; protótipo P40): as contas puras, sem banco e
// sem rede. As datas vêm da tabela do calendário comercial do Liame (`commercial_date`: os feriados nacionais pela lei e
// as datas do varejo, cada uma com a fonte; §16.5 da base); o prazo do salário é conta do sistema.

/** Quantos dias à frente a lista de datas olha, e quantas datas mostra. */
export const DIAS_DAS_DATAS = 45;
export const DATAS_NA_LISTA = 6;

export type DataGuardada = { day: string; name: string; kind: string; source: string };

export interface DataDaSemana {
  day: string;
  name: string;
  /** `feriado_nacional`, `varejo` ou `salario` (conta do sistema). */
  kind: string;
  source: string;
}

/** O dia de hoje em Brasília, "AAAA-MM-DD". */
export function diaEmBrasilia(agora: Date): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(agora);
  const v = (t: string) => p.find((x) => x.type === t)!.value;
  return `${v('year')}-${v('month')}-${v('day')}`;
}

/** O dia "AAAA-MM-DD" `n` dias depois. */
export function diasDepois(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * O 5º dia útil do mês ("AAAA-MM"): o prazo do salário mensal (CLT, art. 459, §1º). Na contagem da fiscalização do
 * trabalho o sábado conta como dia útil; o domingo e o feriado, não (base §19.6). Só os feriados nacionais entram: os
 * do estado e do município não têm fonte pública gratuita (§19.4).
 */
export function quintoDiaUtil(anoMes: string, feriados: ReadonlySet<string>): string {
  let dia = `${anoMes}-01`;
  let uteis = 0;
  for (;;) {
    const domingo = new Date(`${dia}T12:00:00Z`).getUTCDay() === 0;
    if (!domingo && !feriados.has(dia)) uteis++;
    if (uteis === 5) return dia;
    dia = diasDepois(dia, 1);
  }
}

function proximoMes(anoMes: string): string {
  const total = Number(anoMes.slice(0, 4)) * 12 + Number(anoMes.slice(5, 7));
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/**
 * As datas dos próximos 45 dias (até 6): os feriados nacionais e as datas do varejo da tabela e o próximo prazo do
 * salário (o deste mês, se ainda não passou; senão, o do mês seguinte), na ordem.
 */
export function datasDaSemana(guardadas: readonly DataGuardada[], hoje: string): DataDaSemana[] {
  const feriados = new Set(guardadas.filter((d) => d.kind === 'feriado_nacional').map((d) => d.day));
  const fim = diasDepois(hoje, DIAS_DAS_DATAS);
  const esteMes = hoje.slice(0, 7);
  let salario = quintoDiaUtil(esteMes, feriados);
  if (salario < hoje) salario = quintoDiaUtil(proximoMes(esteMes), feriados);
  const lista: DataDaSemana[] = guardadas
    .filter((d) => d.day >= hoje && d.day <= fim)
    .map((d) => ({ day: d.day, name: d.name, kind: d.kind, source: d.source }));
  if (salario <= fim) {
    const doMes = Number(salario.slice(5, 7)) === 1 ? 12 : Number(salario.slice(5, 7)) - 1;
    const nomes = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    lista.push({
      day: salario,
      name: `Prazo do salário de ${nomes[doMes - 1]} (5º dia útil)`,
      kind: 'salario',
      source: 'Conta do sistema: CLT, art. 459, §1º; o sábado conta como dia útil, o domingo e o feriado nacional não',
    });
  }
  return lista.sort((a, b) => (a.day === b.day ? a.name.localeCompare(b.name) : a.day < b.day ? -1 : 1)).slice(0, DATAS_NA_LISTA);
}

/**
 * A referência do setor (D-RG-9: rotulada "Referência do setor (imprensa)", nunca como número da loja): os números
 * divulgados à imprensa que a base guarda com a fonte (§19.2), revistos a cada 90 dias com a base.
 */
export const REFERENCIAS_DO_SETOR: ReadonlyArray<{ text: string; source: string; extra: string | null; as_of: string }> = [
  {
    text: 'R$ 46,70 de tíquete médio no Brasil em mar/2026, 2,9% acima de 12 meses antes.',
    source: 'Instituto Foodservice Brasil (IFB), divulgado à imprensa (Mercado & Consumo, 11/05/2026).',
    extra: 'Em jun/2026, R$ 44,70 (mesma fonte, outra divulgação).',
    as_of: '2026-11-09',
  },
  {
    text: 'Em 2025, o jantar teve 487,7 milhões de pedidos no iFood e o almoço, 278 milhões; de sexta a domingo, cerca de 37% acima dos outros dias; no hambúrguer, o pico da tarde fica perto das 17h.',
    source: 'iFood, retrospectivas e notícias divulgadas à imprensa; os números variam entre as notícias.',
    extra: 'Vale até haver o dado da sua loja.',
    as_of: '2026-11-09',
  },
];
