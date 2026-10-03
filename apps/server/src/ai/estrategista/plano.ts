import type { ClosedLoopResponse, ExplanationNumber, PlanBudget, PlanContent, PlanKind, PlanMarkedText } from '@liame/contracts';
import { canonicalJson, sha256 } from '../../audit/audit.js';
import { criarMarcador, type Lugar } from '../conversa/fontes.js';
import { dia, dinheiro } from '../registro/formatos.js';

// O que o código sabe de um plano do Estrategista (A3, I11; protótipo P8), sem banco nem modelo: os textos livres e o
// caminho de cada um, o que o plano propõe nos campos, a verba de hoje (calculada aqui, nunca pelo modelo), o dinheiro
// que o plano mexe por mês, o hash que a aprovação assina e os números marcados com a fonte. Funções puras: a geração
// (worker), as rotas de decisão e os testes usam as mesmas.

/** Reais inteiros como a tela mostra: 1400 → "R$ 1.400,00". */
export const reais = (n: number): string => dinheiro((BigInt(n) * 1_000_000n).toString())!;

/** Teto da verba por canal no contrato (`PlanBudget`). */
const VERBA_MAXIMA = 10_000_000;

/**
 * A verba de anúncios de hoje, por mês e por canal: o gasto dos 7 dias completos até ontem levado a 30 dias (× 30 ÷ 7),
 * em reais inteiros arredondados para a dezena. É o "Hoje" da tabela do plano de 90 dias.
 */
export function verbaDeHoje(r: ClosedLoopResponse): PlanBudget['today'] {
  const gasto = (provider: string) => r.platforms.filter((p) => p.provider === provider).reduce((n, p) => n + BigInt(p.platform.spend_micros), 0n);
  const porMes = (micros: bigint): number => Math.min(VERBA_MAXIMA, Number(((micros * 30n) / 7n + 5_000_000n) / 10_000_000n) * 10);
  return { meta: porMes(gasto('meta_ads')), google: porMes(gasto('google_ads')) };
}

/** Quanto o plano muda a verba de anúncios por mês (proposta − hoje), em micros; nulo no plano que não mexe em verba. */
export function dinheiroDoPlano(c: PlanContent): string | null {
  if (c.kind !== 'noventa_dias') return null;
  const { today, proposal } = c.budget;
  return (BigInt(proposal.meta + proposal.google - today.meta - today.google) * 1_000_000n).toString();
}

/** O hash do conteúdo, em JSON canônico (o jsonb reordena as chaves): é o que a aprovação assina. */
export const hashDoConteudo = (c: PlanContent): string => sha256(canonicalJson(c));

/** Os códigos dos cupons ativos que o Estrategista leu (só eles podem entrar numa oferta). A geração e o eval usam a mesma. */
export function cuponsAtivos(leituras: Array<{ ferramenta: string; valor: unknown }>): string[] {
  const codigos = new Set<string>();
  for (const l of leituras) {
    if (l.ferramenta !== 'cupons_campanha') continue;
    const cupons = (l.valor as { cupons?: unknown })?.cupons;
    if (!Array.isArray(cupons)) continue;
    for (const c of cupons as Array<Record<string, unknown>>) {
      if (c && typeof c.codigo === 'string' && c.situacao === 'ativo') codigos.add(c.codigo.toUpperCase());
    }
  }
  return [...codigos];
}

/** O título do plano que a rotina gera sem demanda, e o de reserva quando a demanda não tem um que sirva. */
export const TITULO_DO_TIPO: Record<PlanKind, string> = { noventa_dias: 'Plano de 90 dias', pauta: 'Pauta da semana', oferta: 'Oferta' };

/** Os textos livres do plano, com o caminho de cada um, na ordem em que a tela os mostra (P8). */
export function textosDoPlano(c: PlanContent): Array<{ caminho: string; texto: string }> {
  const t = (caminho: string, texto: string) => ({ caminho, texto });
  const inicio = [t('summary', c.summary), ...c.reasons.map((x, i) => t(`reasons.${i}`, x))];
  const fim = [t('risk_reason', c.risk_reason), ...c.to_do.map((x, i) => t(`to_do.${i}`, x)), t('after', c.after)];
  switch (c.kind) {
    case 'noventa_dias':
      return [
        ...inicio,
        ...c.goals.flatMap((g, i) => [t(`goals.${i}.goal`, g.goal), t(`goals.${i}.how_to_know`, g.how_to_know)]),
        ...c.months.flatMap((m, i) => [t(`months.${i}.month`, m.month), t(`months.${i}.plan`, m.plan)]),
        ...c.dates.flatMap((d, i) => [t(`dates.${i}.name`, d.name), t(`dates.${i}.what`, d.what)]),
        ...fim,
      ];
    case 'pauta':
      return [...inicio, ...c.days.map((d, i) => t(`days.${i}.item`, d.item)), ...fim];
    case 'oferta':
      return [...inicio, t('offer', c.offer), t('where', c.where), t('ad_text', c.ad_text), t('how_to_measure', c.how_to_measure), ...fim];
  }
}

/**
 * O que o próprio plano propõe nos campos (não nos textos), como a pessoa lê: pode aparecer nos textos como está ali.
 * As datas do plano de 90 dias não entram: elas vêm do calendário comercial, que é a fonte delas.
 */
export function propostaDoPlano(c: PlanContent): string[] {
  switch (c.kind) {
    case 'oferta':
      return [dia(c.day)!, c.starts_at, c.ends_at, ...(c.coupon_code ? [c.coupon_code] : [])];
    case 'pauta':
      return c.days.map((d) => dia(d.day)!);
    case 'noventa_dias':
      return [reais(c.budget.proposal.meta), reais(c.budget.proposal.google)];
  }
}

/**
 * As contas da verba que o código faz (e a tela mostra): a de hoje por canal e no total, a proposta no total e quanto
 * muda por canal e no total, sempre sem sinal. Número que o Estrategista escrever e bater com uma delas está certo.
 */
export function contasDaVerba(b: PlanBudget): string[] {
  const hoje = b.today.meta + b.today.google;
  const proposta = b.proposal.meta + b.proposal.google;
  return [b.today.meta, b.today.google, hoje, proposta, b.proposal.meta - b.today.meta, b.proposal.google - b.today.google, proposta - hoje].map((n) => reais(Math.abs(n)));
}

/**
 * Os textos do plano com os números marcados e a lista "De onde vêm os números", na ordem da tela. Na verba de hoje, a
 * fonte é a do cálculo (`fontesDaVerba`); o número que não está em lugar nenhum leva `semLugar` (na versão editada,
 * "Escrito por quem editou"). Só os textos com número entram em `marked`.
 */
export function marcarPlano(
  c: PlanContent,
  lugares: Map<string, Lugar[]>,
  nomes: string[],
  opcoes: { semLugar: string; fontesDaVerba?: { meta: string[]; google: string[] } },
): { numbers: ExplanationNumber[]; marked: PlanMarkedText[] } {
  const { marcar, comFonte, numbers } = criarMarcador(lugares, nomes, opcoes.semLugar);
  const marked: PlanMarkedText[] = [];
  const guardar = (path: string, text: PlanMarkedText['text']) => {
    if (text.some((s) => s.number !== null)) marked.push({ path, text });
  };
  const textos = textosDoPlano(c);
  // A verba de hoje entra depois dos meses, onde a tabela fica na tela.
  const antesDaVerba = c.kind === 'noventa_dias' ? textos.findIndex((x) => x.caminho.startsWith('dates.') || x.caminho === 'risk_reason') : -1;
  textos.forEach((x, i) => {
    if (i === antesDaVerba && c.kind === 'noventa_dias' && opcoes.fontesDaVerba) {
      guardar('budget.today.meta', comFonte(reais(c.budget.today.meta), opcoes.fontesDaVerba.meta));
      guardar('budget.today.google', comFonte(reais(c.budget.today.google), opcoes.fontesDaVerba.google));
    }
    guardar(x.caminho, marcar(x.texto));
  });
  return { numbers, marked };
}
