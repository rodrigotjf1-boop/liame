import type { RegionNumber, RegionOverviewResponse, RegionSourceStatus } from '@liame/contracts';

// Sua região (protótipo P40, aprovado em 11/11/2026; plano da região, R2, parte 2): os textos e as contas da tela, sem
// React. Todo número leva a fonte e o período (base §19.3); a renda do Censo é de 2022, sem correção (D-RG-20).

/** O catálogo das fontes como a tela escreve (o que é, a fonte, a consulta no Pro e de quanto em quanto renova). */
export const FONTES_DA_REGIAO: Record<string, { dado: string; fonte: string; recorte: string; consulta: string; renova: string }> = {
  ibge_censo_bairro: {
    dado: 'Pessoas, área, densidade e renda do bairro',
    fonte: 'IBGE · Censo 2022, agregados por bairro',
    recorte: 'bairro (todos os bairros do município)',
    consulta: 'arquivos do Censo por bairro: básico (v0001, AREA_KM2) e renda do responsável (V06004 média, V06006 mediana)',
    renova: 'fixo até o próximo Censo',
  },
  ibge_4714: { dado: 'População e densidade do município', fonte: 'IBGE · Censo 2022', recorte: 'município', consulta: 'tabela 4714 · variáveis 93 e 614', renova: 'fixo até o próximo Censo' },
  ibge_6579: { dado: 'População estimada', fonte: 'IBGE · Estimativas de População', recorte: 'município', consulta: 'tabela 6579 · variável 9324', renova: 'uma vez por ano' },
  ibge_10295: {
    dado: 'Renda por pessoa no município',
    fonte: 'IBGE · Censo 2022',
    recorte: 'município',
    consulta: 'tabela 10295 · variáveis 13534 (mediana) e 13431 (média)',
    renova: 'fixo até o próximo Censo',
  },
  ibge_9528: {
    dado: 'Restaurantes e similares',
    fonte: 'IBGE · Cadastro Central de Empresas',
    recorte: 'município',
    consulta: 'tabela 9528 · variável 706 · CNAE 56.11-2 (categoria 117551)',
    renova: 'uma vez por ano',
  },
  ibge_rm: { dado: 'A região metropolitana do município', fonte: 'IBGE · regiões metropolitanas', recorte: 'município', consulta: 'api/v1/localidades/regioes-metropolitanas', renova: 'a cada 6 meses' },
  ibge_1737_censo: { dado: 'IPCA de julho de 2022 (o mês do Censo)', fonte: 'IBGE · IPCA', recorte: 'Brasil', consulta: 'tabela 1737 · variável 2266 (número-índice) · 202207', renova: 'fixo' },
  ibge_1737: { dado: 'IPCA do mês mais novo (corrige a renda de 2022)', fonte: 'IBGE · IPCA', recorte: 'Brasil', consulta: 'tabela 1737 · variável 2266 (número-índice)', renova: 'todo mês' },
  ibge_7531: { dado: 'Renda por pessoa no estado', fonte: 'IBGE · PNAD Contínua anual', recorte: 'UF', consulta: 'tabela 7531 · variável 10824', renova: 'uma vez por ano' },
  ibge_7395: { dado: 'Renda por pessoa na região metropolitana', fonte: 'IBGE · PNAD Contínua anual', recorte: 'região metropolitana', consulta: 'tabela 7395 · variável 4196', renova: 'uma vez por ano' },
  ibge_6472: { dado: 'Renda do trabalho na capital', fonte: 'IBGE · PNAD Contínua trimestral', recorte: 'capital', consulta: 'tabela 6472 · variável 5933 (real, habitual) · média de 4 trimestres', renova: 'todo trimestre' },
  ibge_7060: { dado: 'Inflação de comer fora na região', fonte: 'IBGE · IPCA', recorte: 'região metropolitana ou município', consulta: 'tabela 7060 · variável 2265 (12 meses) · subitens 7432, 7434 e 7435', renova: 'todo mês' },
  ibge_7060_brasil: { dado: 'Inflação de comer fora no Brasil', fonte: 'IBGE · IPCA', recorte: 'Brasil', consulta: 'tabela 7060 · variável 2265 (12 meses) · subitens 7432, 7434 e 7435', renova: 'todo mês' },
  bcb_pix: { dado: 'Pagamentos com Pix no município', fonte: 'Banco Central · dados abertos do Pix', recorte: 'município', consulta: 'TransacoesPixPorMunicipio · QT_PES_PagadorPF e VL_PagadorPF', renova: 'todo mês' },
  receita_cnpj: {
    dado: 'Restaurantes, lanchonetes e bares com CNPJ ativo',
    fonte: 'Receita Federal · CNPJ aberto',
    recorte: 'município, bairro e CEP',
    consulta: 'Estabelecimentos0..9.zip · CNAE principal 5611-2/01, /03, /04, /05 e 5620-1/04 · situação 02 · guarda só contagens',
    renova: 'todo mês (o Brasil inteiro numa leitura)',
  },
  cptec_cidade: { dado: 'A cidade no CPTEC (para a previsão)', fonte: 'CPTEC/INPE, pela BrasilAPI', recorte: 'município', consulta: '/api/cptec/v1/cidade/{nome} · pelo nome e a UF', renova: 'a cada 6 meses' },
  cptec_previsao: { dado: 'Previsão do tempo por dia', fonte: 'CPTEC/INPE, pela BrasilAPI', recorte: 'município', consulta: '/api/cptec/v1/clima/previsao/{cidade}/6', renova: 'a cada 6 horas' },
};

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** O dia "2026-11-13" como a semana que vem escreve: "sex 13/11". */
export function diaCurto(dia: string): string {
  const d = new Date(`${dia}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? dia : `${DIAS[d.getUTCDay()]} ${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
}

/** O ícone da condição do CPTEC: sol, sol com nuvem, nuvem ou chuva. */
export function iconeDoTempo(condicao: string): 'sun' | 'cloud-sun' | 'cloud' | 'cloud-rain' {
  if (condicao === 'cl' || condicao === 'ps') return 'sun';
  if (condicao === 'pn' || condicao === 'vn') return 'cloud-sun';
  if (['e', 'n', 'nv', 'g', 'ne', 'nd'].includes(condicao)) return 'cloud';
  return 'cloud-rain';
}

/** A condição como o CPTEC escreve ("Parcialmente Nublado") em caixa de frase: "Parcialmente nublado". */
export function condicaoEmFrase(texto: string): string {
  const t = texto.trim().toLowerCase();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

/** Quando a previsão foi lida: "hoje às 06:10" ou "em 11/11 às 18:10" (a hora do aparelho de quem vê). */
export function quandoFoiLida(iso: string, agora: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dia = (x: Date) => x.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  return `${dia(d) === dia(agora) ? 'hoje' : `em ${dia(d)}`} às ${hora(iso)}`;
}

/** O tipo de uma data da semana que vem, em palavras. */
export function tipoDaData(kind: string): string {
  if (kind === 'feriado_nacional') return 'feriado nacional';
  if (kind === 'varejo') return 'data do varejo';
  if (kind === 'salario') return 'conta do sistema';
  return kind;
}

/** O mês "2026-09" como a tela escreve: "set/2026". */
export function mesAno(periodo: string): string {
  const m = Number(periodo.slice(5, 7));
  return m >= 1 && m <= 12 ? `${MESES[m - 1]}/${periodo.slice(0, 4)}` : periodo;
}

/** O trimestre pelo mês em que termina ("2026-06" → "2º tri/2026"). */
export function trimestre(periodo: string): string {
  const m = Number(periodo.slice(5, 7));
  return m % 3 === 0 ? `${m / 3}º tri/${periodo.slice(0, 4)}` : periodo;
}

/** Números grandes por extenso curto: "5,1 milhões", "44,2 bilhões". */
export function grande(v: number): string {
  if (v >= 1e9) return `${umaCasa(Math.round(v / 1e8) / 10)} bilhões`;
  if (v >= 1e6) return `${umaCasa(Math.round(v / 1e5) / 10)} milhões`;
  return inteiro(v);
}

/** A variação contra o ano anterior: "+4,3%", "−2,0%"; nula sem o ano anterior. */
export function variacao(agora: number, antes: number | null): string | null {
  if (antes === null || antes <= 0) return null;
  const p = Math.round(((agora - antes) / antes) * 1000) / 10;
  return `${p >= 0 ? '+' : '−'}${umaCasa(Math.abs(p))}%`;
}

/** Porcentagem com uma ou duas casas: "4,31%". */
export function pct(v: number): string {
  return `${v.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}%`;
}

const fmt = (v: number, casas = 0) => v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });

/** Inteiro com ponto de milhar: "142.909". */
export function inteiro(v: number): string {
  return fmt(Math.round(v));
}

/** Com uma casa: "5.174,6". */
export function umaCasa(v: number): string {
  return fmt(v, Number.isInteger(v) ? 0 : 1);
}

/** Reais sem centavos quando é redondo: "R$ 5.500", "R$ 8.056,52". */
export function reais(v: number): string {
  return `R$ ${fmt(v, Number.isInteger(v) ? 0 : 2)}`;
}

/** A hora "15:00" de um instante, no fuso de quem vê. */
export function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

// Os nomes de bairro e de município vêm sem o artigo certo ("na Tijuca", "no Grajaú", "em São Paulo", "no Rio"): as
// frases os escrevem depois de "bairro" e "município", sem preposição colada no nome.

/** A densidade do bairro comparada à do município, em palavras. */
export function comparaDensidade(bairro: number, cidade: number, nomeDaCidade: string): string {
  if (cidade <= 0) return '';
  const r = bairro / cidade;
  const ref = `(${nomeDaCidade}: ${umaCasa(cidade)} por km²)`;
  if (r >= 1.2) return `${umaCasa(Math.round(r * 10) / 10)} vezes a densidade do município ${ref}`;
  if (r <= 0.8) return `menos denso que a média do município ${ref}`;
  return `parecido com a média do município ${ref}`;
}

/** A frase da renda do bairro com a posição dele entre os bairros do município. */
export function fraseDaRenda(r: RegionOverviewResponse): string | null {
  const b = r.district;
  if (!b || b.head_income_median === null) return null;
  const hoje = b.head_income_median_today !== null && r.ipca;
  const base = `é a renda mediana do responsável pelo domicílio no bairro ${b.name}${hoje ? `, a preços de ${mesAno(r.ipca!.to)}` : ''}.`;
  const p = b.income_rank;
  if (!p || !r.city) return base;
  const tipica = hoje ? Math.round(p.typical_median * r.ipca!.factor) : p.typical_median;
  return `${base} O bairro típico do município (${r.city.name}) tem ${reais(tipica)}: este fica acima de ${p.above_pct}% dos ${inteiro(p.districts)} bairros.`;
}

/** A fonte da renda do bairro: corrigida pelo IPCA quando dá, senão "valor de 2022, sem correção" (D-RG-20). */
export function fonteDaRendaDoBairro(r: RegionOverviewResponse): string {
  return r.ipca && r.district?.head_income_median_today !== null ? `IBGE · Censo 2022, corrigido pelo IPCA até ${mesAno(r.ipca.to)}` : 'IBGE · Censo 2022 · valor de 2022, sem correção';
}

/** A fonte curta de um número: "IBGE · Censo 2022", "IBGE · Cadastro Central de Empresas, 2024". */
export function fonteDoNumero(n: RegionNumber): string {
  const f = FONTES_DA_REGIAO[n.source];
  if (!f) return n.period;
  return f.fonte.includes(n.period) ? f.fonte : `${f.fonte}, ${n.period}`;
}

/** A fonte dos restaurantes ativos (o CNPJ da Receita): a falha e o "lendo" dela ficam na Concorrência, não na faixa do IBGE. */
export const FONTE_DO_CNPJ = 'receita_cnpj';
/** A previsão do tempo e a cidade dela no CPTEC: o estado delas fica na semana que vem. */
export const FONTE_DA_PREVISAO = 'cptec_previsao';
export const FONTES_COM_ESTADO_PROPRIO: ReadonlySet<string> = new Set([FONTE_DO_CNPJ, 'cptec_cidade', FONTE_DA_PREVISAO]);

/** As fontes do IBGE e do Banco Central que falharam (nunca deram certo), com a hora da próxima tentativa. */
export function fontesQueFalharam(r: RegionOverviewResponse): RegionSourceStatus[] {
  return r.sources.filter((s) => s.status === 'falhou' && !FONTES_COM_ESTADO_PROPRIO.has(s.source));
}

type Contagem = { active: number; restaurant: number; snack: number; bar: number; home: number; opened_12m: number; closed_12m: number };

/** Os tipos de uma contagem em palavras, só os que têm algum: "300 restaurantes, 250 lanchonetes e 50 de comida para casa". */
export function tiposDaContagem(c: Contagem): string {
  const partes = (
    [
      [c.restaurant, 'restaurante', 'restaurantes'],
      [c.snack, 'lanchonete', 'lanchonetes'],
      [c.bar, 'bar', 'bares'],
      [c.home, 'de comida para casa', 'de comida para casa'],
    ] as Array<[number, string, string]>
  )
    .filter(([n]) => n > 0)
    .map(([n, um, varios]) => `${inteiro(n)} ${n === 1 ? um : varios}`);
  if (partes.length <= 1) return partes[0] ?? 'nenhum ativo';
  return `${partes.slice(0, -1).join(', ')} e ${partes.at(-1)}`;
}

/** O movimento de 12 meses: "90 abriram e 60 deram baixa desde out/2025". */
export function movimentoDaContagem(c: Contagem, desde: string): string {
  return `${inteiro(c.opened_12m)} ${c.opened_12m === 1 ? 'abriu' : 'abriram'} e ${inteiro(c.closed_12m)} ${c.closed_12m === 1 ? 'deu' : 'deram'} baixa no CNPJ desde ${mesAno(desde)}`;
}

/** A linha do frescor no cabeçalho do cartão. */
export function frescor(r: RegionOverviewResponse): string {
  if (r.status === 'lendo') return 'Lendo agora';
  const lidas = r.sources.map((s) => s.read_at).filter((x): x is string => x !== null);
  const ultima = lidas.sort().at(-1);
  const quando = ultima ? `Lida em ${new Date(ultima).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })}` : 'Lida';
  return r.status === 'parcial' ? `${quando} · uma fonte falhou` : quando;
}

/** A situação de uma fonte em palavras (a gaveta das fontes). */
export function situacaoEmPalavras(s: RegionSourceStatus): { texto: string; tipo: 'ok' | 'lendo' | 'falhou' } {
  if (s.status === 'em_dia') return { texto: 'Em dia', tipo: 'ok' };
  if (s.status === 'falhou') return { texto: s.next_try_at ? `Não respondeu · de novo às ${hora(s.next_try_at)}` : 'Não respondeu', tipo: 'falhou' };
  return { texto: 'Lendo', tipo: 'lendo' };
}
