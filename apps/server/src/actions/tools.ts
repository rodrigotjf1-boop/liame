import type { BudgetImpact, RiskLevel } from '@liame/contracts';
import { z } from 'zod';
import { emMenorUnidade } from '../connectors/meta/verba.js';
import { motivoDoCompartilhado, orcamentoCompartilhado } from './orcamento-compartilhado.js';

// Registro de ferramentas (arquitetura §6, ADR-007): cada ferramenta declara risco, impacto financeiro,
// estratégia de compensação e o formato dos parâmetros. Ferramenta nova só entra com isso e com testes.

export type ResourceState = Record<string, unknown>;

export interface ToolPlan {
  /** Código da ação para a política: `orcamento.aumentar`, `anuncio.pausar`. */
  action: string;
  budgetImpact: BudgetImpact;
  valueMicros: number | null;
  currentValueMicros: number | null;
  /** Quanto reservar no envelope do mês. */
  reserveMicros: number;
  desiredState: ResourceState;
}

export interface ToolDefinition {
  name: string;
  /** Sobe a cada mudança de descrição, parâmetros ou risco: o registro (`tool_registry`) guarda cada versão. */
  version: number;
  /** Área responsável pela ferramenta. */
  owner: string;
  description: string;
  risk: RiskLevel;
  providers: readonly string[];
  compensation: string;
  params: z.ZodType<Record<string, unknown>>;
  /** Do estado atual e dos parâmetros, o plano. Função pura: a mesma entrada dá o mesmo plano. */
  plan(before: ResourceState, params: Record<string, unknown>): ToolPlan;
  /**
   * A volta (A4, X2): a ferramenta e os parâmetros que desfazem a ação, a partir do estado de ANTES dela. A volta é um
   * pedido novo, pelo mesmo trilho (política, aprovação, validação), e só é aceita se ninguém mexeu no objeto depois.
   * Sem esta função, a ação não tem volta pelo Liame.
   */
  undo?(before: ResourceState): { tool: string; params: Record<string, unknown> };
}

/** O plano não pode ser montado com este estado (cupom que já existe, loja sem permissão): vira 422 no pedido. */
export class PlanoRecusado extends Error {}

const Dia = z.iso.date();
/**
 * Cupom de campanha no Regem (contrato de cupons §3.3). O código é o do recurso (`cupom:CODIGO`); a campanha e
 * "exclusivo" são do Liame: o cupom nasce ligado à campanha, e só o exclusivo prova de onde veio o pedido.
 */
const CupomParams = z
  .strictObject({
    codigo: z.string().regex(/^[A-Z0-9]{4,20}$/, { error: 'De 4 a 20 letras maiúsculas ou números, sem espaço' }),
    nome: z.string().trim().min(1).max(80).optional(),
    tipo: z.enum(['percentual', 'valor', 'frete_gratis']),
    /** Só no percentual: de 1 a 100, inteiro (o Regem recebe com duas casas). */
    percentual: z.int().min(1).max(100).optional(),
    /** Só no valor fixo. */
    valor_centavos: z.int().min(1).max(100_000_000).optional(),
    pedido_minimo_centavos: z.int().min(0).max(100_000_000).default(0),
    valido_de: Dia,
    valido_ate: Dia,
    campaign_id: z.uuid(),
    exclusive: z.boolean(),
  })
  .superRefine((p, ctx) => {
    if (p.tipo === 'percentual' && p.percentual === undefined) ctx.addIssue({ code: 'custom', path: ['percentual'], message: 'Informe o desconto em %' });
    if (p.tipo !== 'percentual' && p.percentual !== undefined) ctx.addIssue({ code: 'custom', path: ['percentual'], message: 'O percentual só vale no cupom percentual' });
    if (p.tipo === 'valor' && p.valor_centavos === undefined) ctx.addIssue({ code: 'custom', path: ['valor_centavos'], message: 'Informe o valor do desconto' });
    if (p.tipo !== 'valor' && p.valor_centavos !== undefined) ctx.addIssue({ code: 'custom', path: ['valor_centavos'], message: 'O valor só vale no cupom de valor fixo' });
    if (p.valido_ate < p.valido_de) ctx.addIssue({ code: 'custom', path: ['valido_ate'], message: 'O fim não pode ser antes do início' });
  });

const BudgetParams = z.strictObject({ daily_budget_micros: z.int().min(1_000_000).max(Number.MAX_SAFE_INTEGER) });
const NoParams = z.strictObject({});

const budgetOf = (s: ResourceState): number => {
  const v = s.daily_budget_micros;
  if (typeof v !== 'number') throw new Error('o recurso não tem daily_budget_micros');
  return v;
};

// ---- objetos de anúncio (A4, X2): o estado vem do conector da plataforma (`actions/meta-anuncios.ts`), com o tipo do
// objeto (`campanha`, `conjunto` ou `anuncio`) e a situação (`ativo`, `pausado`, `arquivado`…). O estado do sandbox não
// tem tipo: para ele, as ferramentas seguem como eram.

type TipoDeAnuncio = 'campanha' | 'conjunto' | 'anuncio';
const NOME: Record<TipoDeAnuncio, { o: string; um: string; a: 'a' | 'o' }> = {
  campanha: { o: 'a campanha', um: 'campanha', a: 'a' },
  conjunto: { o: 'o conjunto', um: 'conjunto de anúncios', a: 'o' },
  anuncio: { o: 'o anúncio', um: 'anúncio', a: 'o' },
};
const tipoDe = (s: ResourceState): TipoDeAnuncio | null => (s.tipo === 'campanha' || s.tipo === 'conjunto' || s.tipo === 'anuncio' ? s.tipo : null);

/** A ferramenta vale para um tipo de objeto: pedir com outro é engano de quem pede. */
function exigirTipo(before: ResourceState, aceitos: TipoDeAnuncio[]): TipoDeAnuncio | null {
  const tipo = tipoDe(before);
  if (tipo && !aceitos.includes(tipo)) {
    throw new PlanoRecusado(`Esta ferramenta é para ${aceitos.map((t) => NOME[t].um).join(' ou ')}; o pedido aponta para ${NOME[tipo].um}.`);
  }
  return tipo;
}

/** O objeto de anúncio que foi arquivado ou removido na plataforma não muda mais. */
function exigirVivo(before: ResourceState, tipo: TipoDeAnuncio): void {
  const { o, a } = NOME[tipo];
  if (before.status !== 'ativo' && before.status !== 'pausado') throw new PlanoRecusado(`${maiuscula(o)} foi arquivad${a} ou removid${a} na plataforma: não dá para mudar.`);
}
const maiuscula = (s: string) => s.charAt(0).toLocaleUpperCase('pt-BR') + s.slice(1);

/** A verba diária do objeto, quando ela mora nele (em micros); nula em anúncio e em quem tem a verba em outro nível. */
const verbaDiaria = (s: ResourceState): number | null => (typeof s.daily_budget_micros === 'number' && s.daily_budget_micros > 0 ? s.daily_budget_micros : null);

/** Pausar: o objeto ativo passa a pausado. Reduz gasto: nada a reservar. */
function planoDePausa(before: ResourceState, alvo: TipoDeAnuncio): ToolPlan {
  const tipo = exigirTipo(before, [alvo]);
  if (tipo) {
    exigirVivo(before, tipo);
    if (before.status === 'pausado') throw new PlanoRecusado(`${maiuscula(NOME[tipo].o)} já está em pausa.`);
  }
  return { action: `${alvo}.pausar`, budgetImpact: 'decrease', valueMicros: null, currentValueMicros: null, reserveMicros: 0, desiredState: { ...before, status: 'pausado' } };
}

/** Retomar: o objeto pausado volta a ativo. Volta a gastar: reserva um dia da verba dele, quando a verba mora nele. */
function planoDeRetomada(before: ResourceState, alvo: TipoDeAnuncio): ToolPlan {
  const tipo = exigirTipo(before, [alvo]);
  if (!tipo) throw new PlanoRecusado('Retomar vale para campanha, conjunto e anúncio de uma plataforma conectada.');
  exigirVivo(before, tipo);
  if (before.status !== 'pausado') throw new PlanoRecusado(`Só dá para retomar o que está em pausa, e ${NOME[tipo].o} está ativ${NOME[tipo].a}.`);
  const verba = verbaDiaria(before);
  return { action: `${alvo}.retomar`, budgetImpact: 'new_spend', valueMicros: verba, currentValueMicros: null, reserveMicros: verba ?? 0, desiredState: { ...before, status: 'ativo' } };
}

const pausa = (alvo: TipoDeAnuncio, providers: readonly string[], version = 1): ToolDefinition => ({
  name: `${alvo}_pausar`,
  version,
  owner: 'midia',
  description: alvo === 'anuncio' ? 'Pausa um anúncio (reversível).' : alvo === 'conjunto' ? 'Pausa um conjunto de anúncios; os anúncios dele param de rodar (reversível).' : 'Pausa uma campanha; os conjuntos e anúncios dela param de rodar (reversível).',
  risk: 'R1',
  providers,
  compensation: 'reativar_se_inalterado',
  params: NoParams,
  plan: (before) => planoDePausa(before, alvo),
  undo: () => ({ tool: `${alvo}_retomar`, params: {} }),
});

const retomada = (alvo: TipoDeAnuncio, providers: readonly string[]): ToolDefinition => ({
  name: `${alvo}_retomar`,
  version: 1,
  owner: 'midia',
  description:
    alvo === 'anuncio'
      ? 'Retoma um anúncio em pausa: ele volta a rodar e a gastar.'
      : alvo === 'conjunto'
        ? 'Retoma um conjunto de anúncios em pausa: os anúncios ativos dele voltam a rodar e a gastar.'
        : 'Retoma uma campanha em pausa: os conjuntos e anúncios ativos dela voltam a rodar e a gastar.',
  // Volta a gastar: exige a aprovação de uma pessoa, como ativar o que nasceu pausado (D-A4-3).
  risk: 'R2',
  providers,
  compensation: 'pausar_se_inalterado',
  params: NoParams,
  plan: (before) => planoDeRetomada(before, alvo),
  undo: () => ({ tool: `${alvo}_pausar`, params: {} }),
});

export const TOOLS: Record<string, ToolDefinition> = {
  orcamento_ajustar: {
    name: 'orcamento_ajustar',
    version: 1,
    owner: 'midia',
    description: 'Muda o orçamento diário de uma campanha ou conjunto.',
    risk: 'R3',
    // No Google (A5, Y3) a verba é a do orçamento que é só da campanha; grupo de anúncios e anúncio ficam fora.
    providers: ['sandbox', 'meta_ads', 'google_ads'],
    compensation: 'restaurar_orcamento_anterior_se_inalterado',
    params: BudgetParams,
    plan(before, params) {
      const { daily_budget_micros: value } = BudgetParams.parse(params);
      // Na plataforma de anúncio, a verba diária mora na campanha (orçamento de campanha) ou no conjunto, nunca no anúncio.
      const tipo = exigirTipo(before, ['campanha', 'conjunto']);
      if (tipo) {
        exigirVivo(before, tipo);
        // No Google, a verba dividida entre campanhas nunca é alterada (D-A5-4): o pedido nem nasce.
        const dividido = orcamentoCompartilhado(before);
        if (dividido) throw new PlanoRecusado(motivoDoCompartilhado(dividido));
        const verba = verbaDiaria(before);
        if (verba === null) throw new PlanoRecusado(`${maiuscula(NOME[tipo].o)} não tem verba diária própria: a verba fica em outro nível, ou é de período.`);
        if (value === verba) throw new PlanoRecusado('A verba pedida é igual à de agora.');
        if (emMenorUnidade(value, typeof before.moeda === 'string' ? before.moeda : null) === null) throw new PlanoRecusado('A verba diária não pode ter fração de centavo.');
      }
      const current = budgetOf(before);
      const increase = value > current;
      return {
        action: increase ? 'orcamento.aumentar' : 'orcamento.reduzir',
        budgetImpact: value === current ? 'none' : increase ? 'increase' : 'decrease',
        valueMicros: value,
        currentValueMicros: current,
        // Reserva a diferença de um dia a mais de gasto; redução não reserva.
        reserveMicros: increase ? value - current : 0,
        desiredState: { ...before, daily_budget_micros: value },
      };
    },
    // A volta devolve a verba de antes (se ninguém mexeu depois).
    undo: (before) => ({ tool: 'orcamento_ajustar', params: { daily_budget_micros: budgetOf(before) } }),
  },
  regem_cupom_criar: {
    name: 'regem_cupom_criar',
    version: 1,
    owner: 'vendas',
    description: 'Cria um cupom de campanha na loja do Regem e liga à campanha.',
    risk: 'R1',
    providers: ['regem'],
    compensation: 'desativar_cupom',
    params: CupomParams,
    plan(before, params) {
      const p = CupomParams.parse(params);
      if (before.codigo !== p.codigo) throw new PlanoRecusado('O código do cupom não confere com o recurso do pedido.');
      if (before.pode_criar !== true) throw new PlanoRecusado('A loja não liberou "criar cupom de campanha" no Regem. Autorize de novo em Contas conectadas e ligue essa chave lá.');
      if (before.existe === true) throw new PlanoRecusado('Já existe um cupom com este código nesta loja. Escolha outro código.');
      const regra = {
        codigo: p.codigo,
        nome: p.nome ?? `Campanha · ${p.codigo}`,
        tipo: p.tipo,
        ...(p.tipo === 'percentual' ? { percentual: `${p.percentual}.00` } : {}),
        ...(p.tipo === 'valor' ? { valor_centavos: p.valor_centavos } : {}),
        ...(p.pedido_minimo_centavos > 0 ? { pedido_minimo_centavos: p.pedido_minimo_centavos } : {}),
        valido_de: p.valido_de,
        valido_ate: p.valido_ate,
      };
      return {
        action: 'cupom.criar',
        // O desconto sai do caixa da loja, não do orçamento de mídia: nada a reservar no envelope.
        budgetImpact: 'none',
        valueMicros: null,
        currentValueMicros: null,
        reserveMicros: 0,
        desiredState: { codigo: p.codigo, existe: true, regra, campanha: { id: p.campaign_id, exclusivo: p.exclusive } },
      };
    },
  },
  // Pausar e retomar (A4, X2): uma ferramenta por tipo de objeto, para o pedido dizer o que vai parar. Pausar a campanha
  // para os conjuntos e os anúncios dela; pausar o conjunto para os anúncios dele (base §2.1). No Google (A5, Y3), só a
  // campanha: o Liame não mexe em grupo de anúncios nem em anúncio do Google nesta fase (D-A5-3).
  anuncio_pausar: pausa('anuncio', ['sandbox', 'meta_ads']),
  conjunto_pausar: pausa('conjunto', ['meta_ads']),
  campanha_pausar: pausa('campanha', ['meta_ads', 'google_ads']),
  anuncio_retomar: retomada('anuncio', ['meta_ads']),
  conjunto_retomar: retomada('conjunto', ['meta_ads']),
  campanha_retomar: retomada('campanha', ['meta_ads', 'google_ads']),
};
