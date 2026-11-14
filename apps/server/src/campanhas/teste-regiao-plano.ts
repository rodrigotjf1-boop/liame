import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BairroDaCampanha } from './bairros-da-campanha.js';
import { SituacaoDoTesteDeCriativo } from './teste-de-criativo-plano.js';
import { DIAS_DO_TESTE_DE_REGIAO } from './teste-regiao-contas.js';

// O teste de região (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026; D-RG-81 e D-RG-82).
// Uma pessoa pede, em Sua região, que um bairro da área de entrega fique 14 dias sem anúncio nas campanhas que o Liame
// criou. O pedido vai para Aprovações com o código do app; aprovar NÃO muda nada na Meta: marca o teste como pronto, e a
// rotina tira o bairro de cada conjunto no começo e devolve no fim, cada passo pelo trilho de sempre (a peça seguinte).
// Aqui, o estado que a pessoa aprova, o plano da ferramenta e a impressão do público; partes puras.

export const FLAG_DO_TESTE_DE_REGIAO = 'teste_de_regiao';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXO = 'teste_de_regiao:';

/** O recurso do pedido no trilho de ações: o teste do Liame (`campaign_test`, o tipo `regiao`). */
export const recursoDoTesteDeRegiao = (id: string): string => `${PREFIXO}${id}`;

/** O id do teste a partir do recurso; nulo quando o recurso não é um teste de região. */
export function testeDeRegiaoDoRecurso(resourceId: string): string | null {
  if (!resourceId.startsWith(PREFIXO)) return null;
  const id = resourceId.slice(PREFIXO.length);
  return UUID.test(id) ? id : null;
}

/** O nome do teste: o bairro e os dias. */
export const nomeDoTesteDeRegiao = (bairro: string): string => `${bairro} sem anúncio por ${DIAS_DO_TESTE_DE_REGIAO} dias`.slice(0, 80);

const Dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Um conjunto de uma campanha do Liame que mostra anúncio no bairro: é dele que o bairro sai durante o teste. */
export const ConjuntoDoTesteDeRegiao = z.object({
  campanha: z.string().min(1).max(40),
  conjunto: z.string().min(1).max(40),
  nome: z.string().min(1).max(400),
  /** A impressão dos campos do público que o Liame controla, como a Meta mostrava no pedido. */
  impressao: z.string().length(64),
});

/** O estado que a pessoa aprova (o plano guardado em `campaign_test.plan`, com a situação da coluna). */
export const EstadoDoTesteDeRegiao = z.object({
  teste: z.string().regex(UUID),
  marca: z.string().regex(UUID),
  loja: z.object({ id: z.string().regex(UUID), nome: z.string().min(1).max(200) }),
  fuso: z.string().min(1).max(60),
  bairro: BairroDaCampanha,
  dias: z.literal(DIAS_DO_TESTE_DE_REGIAO),
  /** Os pedidos de entrega por bairro nas 4 semanas de antes, como a pessoa viu (o bairro e os de comparar). */
  semanas: z.object({ de: Dia, ate: Dia, bairros: z.array(z.object({ nome: z.string().min(1).max(200), pedidos: z.number().int().min(0) })).max(200) }),
  conjuntos: z.array(ConjuntoDoTesteDeRegiao).min(1).max(50),
  situacao: SituacaoDoTesteDeCriativo,
});
export type EstadoDoTesteDeRegiao = z.infer<typeof EstadoDoTesteDeRegiao>;

export type PlanoDoTesteDeRegiao = { ok: true; desejado: EstadoDoTesteDeRegiao } | { ok: false; motivo: string };

const NAO_E = 'Esta ferramenta é para um teste de região do Liame.';

/** O plano do pedido do teste: aprovar só marca o teste como pronto (nada muda na Meta aqui). Função pura. */
export function planoDoTesteDeRegiao(before: unknown): PlanoDoTesteDeRegiao {
  const lido = EstadoDoTesteDeRegiao.safeParse(before);
  if (!lido.success) return { ok: false, motivo: NAO_E };
  const e = lido.data;
  if (e.situacao === 'cancelado') return { ok: false, motivo: 'Este teste foi cancelado.' };
  if (e.situacao !== 'pedido') return { ok: false, motivo: 'Este teste já foi aprovado.' };
  return { ok: true, desejado: { ...e, situacao: 'pronto' } };
}

// ------------------------------------------------------------ a impressão do público

/** Os campos do público que o Liame escreve na campanha que ele cria (os lugares, a idade, o gênero, os interesses). */
const CAMPOS_DO_LIAME = ['geo_locations', 'excluded_geo_locations', 'age_min', 'age_max', 'genders', 'flexible_spec', 'exclusions'] as const;
/** Dentro dos lugares, só os que o Liame escreve (os círculos e os bairros); o resto (tipos de local etc.) a Meta preenche. */
const LUGARES_DO_LIAME = ['custom_locations', 'neighborhoods'] as const;

/** O valor em ordem estável (as chaves em ordem; as listas como vieram), para a impressão não depender da ordem das chaves. */
function canonico(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonico);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonico((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

/** Um círculo, só com o que define o lugar (o centro, o raio e a unidade), com os números arredondados. */
function circuloCanonico(c: unknown): unknown {
  const x = (c ?? {}) as Record<string, unknown>;
  const n = (v: unknown, casas: number) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(casas)) : null);
  return { latitude: n(x.latitude, 5), longitude: n(x.longitude, 5), radius: n(x.radius, 2), distance_unit: x.distance_unit ?? 'mile' };
}

function lugaresCanonicos(lugares: unknown): unknown {
  if (!lugares || typeof lugares !== 'object') return null;
  const l = lugares as Record<string, unknown>;
  const saida: Record<string, unknown> = {};
  for (const k of LUGARES_DO_LIAME) {
    const v = l[k];
    if (!Array.isArray(v) || !v.length) continue;
    saida[k] = k === 'custom_locations' ? v.map(circuloCanonico) : v.map((b) => String(((b ?? {}) as { key?: unknown }).key ?? ''));
  }
  return saida;
}

/**
 * A impressão dos campos do público que o Liame controla (sha256 em hexadecimal). A Meta devolve o `targeting`
 * normalizado, com campos que ninguém mandou (tipos de local, relaxamentos, filtros); a impressão fica só com os campos
 * que o Liame escreve, para a conferência de "como o Liame deixou" não acusar mudança que não houve. A prova contra uma
 * leitura de verdade da conta do piloto vem antes do passo que escreve na Meta.
 */
export function impressaoDoPublico(targeting: unknown): string {
  const t = targeting && typeof targeting === 'object' ? (targeting as Record<string, unknown>) : {};
  const escolhidos: Record<string, unknown> = {};
  for (const k of CAMPOS_DO_LIAME) {
    if (t[k] === undefined) continue;
    escolhidos[k] = k === 'geo_locations' || k === 'excluded_geo_locations' ? lugaresCanonicos(t[k]) : t[k];
  }
  return createHash('sha256').update(JSON.stringify(canonico(escolhidos))).digest('hex');
}
