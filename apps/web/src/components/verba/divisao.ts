import type { BudgetMonthResponse } from '@liame/contracts';
import { plataforma } from '@/components/contas/textos';
import { somarDias } from '@/components/resultados/textos';
import { reaisDeMicros } from '@/lib/formato';
import { naFrase } from './nomes';

// A verba do mês dividida por plataforma (A4 · X9; P36, aprovado em 04/11/2026; D-A4-36 a D-A4-39). O teto do mês
// continua; com a função `verba_por_plataforma` ligada, a empresa pode dividir o teto entre as plataformas de anúncio
// conectadas, e o teto passa a ser a soma das partes. A conta é do servidor (`GET /v1/budget/month`: a parte de cada
// plataforma, o que pesa hoje nela e o que sobra); aqui ela vira a situação, as frases, os avisos e o bloco do cartão
// dos limites. Funções puras, sem depender de `textos.ts` (que usa estas).

type Verba = BudgetMonthResponse;
type Plataforma = Verba['platforms'][number];

const reais = (micros: number): string => reaisDeMicros(BigInt(Math.round(micros)));
const maiuscula = (t: string): string => t.charAt(0).toLocaleUpperCase('pt-BR') + t.slice(1);
const juntar = (itens: string[]): string => (itens.length <= 1 ? itens.join('') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`);
/** A régua do "perto": sobra menor que 2% da parte (a mesma do "perto do teto"). */
const PERTO = 0.02;

export type SituacaoDaParte = 'cabe' | 'perto' | 'passa' | 'passou';

const SELO: Record<SituacaoDaParte, { classe: string; rotulo: string }> = {
  cabe: { classe: 'concluido', rotulo: 'Cabe na parte' },
  perto: { classe: 'aguardando', rotulo: 'Perto da parte' },
  passa: { classe: 'perigo', rotulo: 'Passa da parte' },
  passou: { classe: 'perigo', rotulo: 'Já passou da parte' },
};

export type ParteDaPlataforma = {
  provider: string;
  nome: string;
  classe: string;
  parteMicros: number;
  /** "R$ 3.700,00". */
  parte: string;
  /** A previsão de fechamento com o que pesa hoje nela (parte − o que sobra). */
  fimMicros: number;
  sobraMicros: number;
  situacao: SituacaoDaParte;
  selo: { classe: string; rotulo: string };
  /** Passa ou já passou da parte. */
  acima: boolean;
  /** O Liame muda campanhas nela (a trava vale); sem isso, a parte é só acompanhada. */
  escreve: boolean;
  /** A frase curta (também no modo simples): "No ritmo atual, fecha em R$ 3.400,00: sobram R$ 300,00." */
  frase: string;
};

const escreveNela = (p: Plataforma): boolean => p.writes ?? p.provider === 'meta_ads';

/** A situação da plataforma contra a parte dela. */
export function situacaoDaParte(gasto: number, parte: number, sobra: number): SituacaoDaParte {
  if (gasto > parte) return 'passou';
  if (sobra < 0) return 'passa';
  return sobra < parte * PERTO ? 'perto' : 'cabe';
}

function parteDe(p: Plataforma): ParteDaPlataforma | null {
  if (!p.part) return null;
  const f = naFrase(p.provider);
  const { nome, classe } = plataforma(p.provider);
  const parte = p.part.micros;
  const sobra = p.part.remaining_micros;
  const fim = parte - sobra;
  const situacao = situacaoDaParte(p.spend_micros, parte, sobra);
  const acima = situacao === 'passa' || situacao === 'passou';
  const escreve = escreveNela(p);
  const conta =
    situacao === 'passou'
      ? `Já gastou ${reais(p.spend_micros - parte)} além da parte.`
      : `No ritmo atual, fecha em ${reais(fim)}: ${acima ? `${reais(-sobra)} além da parte` : `sobram ${reais(sobra)}`}.`;
  const consequencia = !acima ? '' : escreve ? ` Aumentar e retomar ${f.na} ficam negados.` : ` O Liame só acompanha ${f.a}.`;
  return {
    provider: p.provider,
    nome,
    classe,
    parteMicros: parte,
    parte: reais(parte),
    fimMicros: fim,
    sobraMicros: sobra,
    situacao,
    selo: SELO[situacao],
    acima,
    escreve,
    frase: conta + consequencia,
  };
}

/** A divisão está valendo: a função ligada e a empresa dividiu o teto. */
export const temDivisao = (v: Verba): boolean => v.limits.platform_parts_enabled === true && !!v.limits.platform_parts?.length;

/** A parte de cada plataforma que tem uma, na ordem da resposta; nulo sem divisão. */
export function partesDaVerba(v: Verba): ParteDaPlataforma[] | null {
  if (!temDivisao(v)) return null;
  const partes = v.platforms.map(parteDe).filter((x): x is ParteDaPlataforma => x !== null);
  return partes.length ? partes : null;
}

/**
 * O dia do mês em que a previsão da plataforma passa da parte, no ritmo de agora (com o que pesa hoje nela). Nulo
 * quando as contas dela foram lidas até dias diferentes ou quando, ao centavo, não passa em dia nenhum.
 */
export function diaQuePassaDaParte(v: Verba, p: Plataforma): number | null {
  if (!p.part || p.forecast_days !== v.days_left) return null;
  const porDia = p.daily_micros + p.part.pending_micros / v.days_left;
  for (let k = 1; k <= v.days_left; k++) {
    if (p.spend_micros + porDia * k > p.part.micros) return Number(somarDias(v.through, k).slice(8, 10));
  }
  return null;
}

export type AvisoDaDivisao = {
  chave: string;
  tipo: 'atencao' | 'perigo';
  icone: 'alert';
  titulo: string;
  texto: string;
  acao: 'divisao';
};

/**
 * A faixa de cada plataforma que passa da parte (D-A4-39): vermelha onde o Liame trava o aumento (a Meta), amarela
 * onde ele só acompanha (o Google). `nomeDoMes`: "novembro".
 */
export function avisosDaDivisao(v: Verba, nomeDoMes: string): AvisoDaDivisao[] {
  const partes = partesDaVerba(v);
  if (!partes) return [];
  const cabeNoTotal = v.remaining_micros !== null && v.remaining_micros >= 0 ? ' O total do mês ainda cabe no teto.' : '';
  return partes
    .filter((x) => x.acima)
    .map((x) => {
      const f = naFrase(x.provider);
      const p = v.platforms.find((y) => y.provider === x.provider)!;
      const dia = diaQuePassaDaParte(v, p);
      const titulo =
        x.situacao === 'passou' ? `${maiuscula(f.a)} já passou da parte ${f.dela} em ${nomeDoMes}` : `No ritmo atual, ${f.a} passa da parte ${f.dela}${dia === null ? '' : ` no dia ${dia}`}`;
      const conta = `${maiuscula(f.a)} fecha ${nomeDoMes} em ${reais(x.fimMicros)}, e a parte ${f.dela} é de ${x.parte}.`;
      const texto = x.escreve
        ? `${conta} Aumentar e retomar campanhas ${f.da} ficam negados; reduzir e pausar, o Liame sempre aceita.${cabeNoTotal}`
        : `${conta} O Liame ainda não muda campanhas ${f.da}: para gastar menos lá, ajuste ${f.na}, ou mude a divisão.${cabeNoTotal}`;
      return { chave: `parte-${x.provider}`, tipo: x.escreve ? 'perigo' : 'atencao', icone: 'alert', titulo, texto, acao: 'divisao' } satisfies AvisoDaDivisao;
    });
}

export type DivisaoNosLimites =
  | { dividida: false; texto: string; podeDividir: boolean }
  | { dividida: true; linhas: Array<{ provider: string; nome: string; classe: string; parte: string; selo: { classe: string; rotulo: string } }>; notas: string[] };

/**
 * O bloco "Divisão por plataforma" do cartão dos limites (D-A4-36), com a função ligada; nulo com ela desligada.
 * `podeDefinir`: quem muda os limites (o convite "Dividir por plataforma" só aparece para ele, com o teto definido).
 */
export function divisaoNosLimites(v: Verba, podeDefinir: boolean): DivisaoNosLimites | null {
  if (v.limits.platform_parts_enabled !== true) return null;
  const partes = partesDaVerba(v);
  const nomes = v.platforms.map((p) => naFrase(p.provider).a);
  if (!partes) {
    const juntas = nomes.length > 1 ? `vale para ${juntar(nomes)} juntos` : 'vale para todas as plataformas juntas';
    return {
      dividida: false,
      texto: `O teto do mês ${juntas}. Se quiser, diga quanto vai para cada plataforma: o Liame passa a negar o aumento que fizer uma delas passar da parte dela.`,
      podeDividir: podeDefinir && v.limits.month_micros !== null && v.platforms.length > 0,
    };
  }
  const notas = ['A soma é o teto do mês. Aumentar ou retomar numa plataforma que passaria da parte dela fica negado, mesmo com o total cabendo.'];
  for (const x of partes.filter((y) => !y.escreve)) {
    const f = naFrase(x.provider);
    notas.push(`O Liame ainda não muda campanhas ${f.da}: a parte ${f.dela} é acompanhada.`);
  }
  for (const p of v.platforms.filter((y) => !y.part)) {
    const f = naFrase(p.provider);
    notas.push(`${maiuscula(f.a)} foi conectad${f.dela === 'dele' ? 'o' : 'a'} depois da divisão e ainda não tem parte: mude a divisão para incluir.`);
  }
  notas.push('As plataformas que você conectar depois, como o TikTok Ads, entram aqui quando o Liame passar a ler o gasto delas.');
  return { dividida: true, linhas: partes.map((x) => ({ provider: x.provider, nome: x.nome, classe: x.classe, parte: x.parte, selo: x.selo })), notas };
}

// ------------------------------------------------------------------ o formulário

export type PlataformaDoForm = { provider: string; nome: string; classe: string; dica: string; gastoMicros: number; escreve: boolean };

/** As plataformas que ganham um campo no formulário: as de anúncio conectadas, com o gasto e a previsão delas. */
export function plataformasDoForm(v: Verba, nomeDoMes: string, ate: string): PlataformaDoForm[] {
  return v.platforms.map((p) => {
    const { nome, classe } = plataforma(p.provider);
    return {
      provider: p.provider,
      nome,
      classe,
      dica: `Gastou ${reais(p.spend_micros)} até ${ate}; no ritmo atual, fecha ${nomeDoMes} em ${reais(p.forecast_micros)}.`,
      gastoMicros: p.spend_micros,
      escreve: escreveNela(p),
    };
  });
}

const CEM_REAIS = 100_000_000;

/**
 * A divisão com que o formulário abre: a de agora, se a empresa já dividiu; senão, o teto de hoje (ou a previsão,
 * sem teto) dividido como o gasto do mês, em centenas de reais, com o resto na última plataforma. Em micros.
 */
export function divisaoInicial(v: Verba): Record<string, number> {
  const agora = v.limits.platform_parts;
  if (temDivisao(v) && agora) return Object.fromEntries(agora.map((p) => [p.provider, p.micros]));
  const ps = v.platforms;
  if (!ps.length) return {};
  const total = v.limits.month_micros ?? Math.max(CEM_REAIS, Math.ceil(v.forecast_micros / CEM_REAIS) * CEM_REAIS);
  const gasto = ps.reduce((s, p) => s + p.spend_micros, 0);
  const valores: Record<string, number> = {};
  let usado = 0;
  ps.forEach((p, i) => {
    if (i === ps.length - 1) {
      valores[p.provider] = Math.max(0, total - usado);
      return;
    }
    const peso = gasto > 0 ? p.spend_micros / gasto : 1 / ps.length;
    const v100 = Math.round((total * peso) / CEM_REAIS) * CEM_REAIS;
    valores[p.provider] = v100;
    usado += v100;
  });
  return valores;
}

/** O aviso do campo abaixo do que a plataforma já gastou (não impede salvar, D-A4-36). */
export function abaixoDoGasto(p: Pick<PlataformaDoForm, 'provider' | 'gastoMicros' | 'escreve'>, micros: number | null, nomeDoMes: string): string | null {
  if (micros === null || micros <= 0 || micros >= p.gastoMicros) return null;
  const f = naFrase(p.provider);
  const trava = p.escreve ? `, e aumentar e retomar ${f.na} ficam negados` : '';
  return `Abaixo do que ${f.a} já gastou em ${nomeDoMes}: até o fim do mês, fica acima da parte ${f.dela}${trava}.`;
}

/** A frase da soma, ao vivo: a soma é o teto do mês. */
export function textoDaSoma(soma: number | null, tetoDeHoje: number | null): { valor: string | null; resto: string } {
  if (soma === null) return { valor: null, resto: 'Soma: digite a parte de cada plataforma.' };
  return { valor: reais(soma), resto: `É o teto do mês${tetoDeHoje !== null && tetoDeHoje !== soma ? ` (hoje, ${reais(tetoDeHoje)})` : ''}.` };
}

export type SugestaoDoPlano = { texto: string; valores: Record<string, number> };

/** A divisão do plano do trimestre aprovado (D-A4-38), para "Usar a divisão do plano"; nula sem ela. */
export function sugestaoDoPlano(v: Verba): SugestaoDoPlano | null {
  const plano = v.limits.plan_parts;
  if (!plano?.length) return null;
  const conectadas = new Set(v.platforms.map((p) => p.provider));
  const usadas = plano.filter((p) => conectadas.has(p.provider));
  if (!usadas.length) return null;
  const partes = usadas.map((p) => `${reais(p.micros)} para ${naFrase(p.provider).a}`);
  return {
    texto: `O plano do trimestre que você aprovou sugere ${juntar(partes)}, por mês.`,
    valores: Object.fromEntries(usadas.map((p) => [p.provider, p.micros])),
  };
}
