import { z } from 'zod';
import { BairroDaCampanha, MAXIMO_DE_BAIRROS } from './bairros-da-campanha.js';
import type { EstadoDaCampanhaNova } from './campanha-nova-plano.js';
import { DIAS_DO_TESTE_DE_CRIATIVO, type LetraDoTeste } from './teste-contas.js';

// O teste de criativo (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026; D-RG-76 a D-RG-80).
// Uma pessoa pede, em Criativos, o teste de duas peças aprovadas. O Liame cria na Meta uma campanha de teste pausada,
// com dois conjuntos iguais (o mesmo público, a mesma verba, o mesmo objetivo) e um anúncio em cada um; cada criativo
// tem o seu cupom no Regem, com o mesmo desconto, e o código vai escrito no fim do texto do anúncio dele. Quem decide
// é o caixa (`teste-contas.ts`). Aqui, o estado que a pessoa aprova e os planos das ferramentas; partes puras.

export const FLAG_DO_TESTE_DE_CRIATIVO = 'teste_de_criativo';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXO = 'teste_de_criativo:';

/** O recurso do pedido no trilho de ações: o teste do Liame (`campaign_test`). */
export const recursoDoTesteDeCriativo = (id: string): string => `${PREFIXO}${id}`;

/** O id do teste a partir do recurso; nulo quando o recurso não é um teste de criativo. */
export function testeDeCriativoDoRecurso(resourceId: string): string | null {
  if (!resourceId.startsWith(PREFIXO)) return null;
  const id = resourceId.slice(PREFIXO.length);
  return UUID.test(id) ? id : null;
}

/** A verba mínima de cada criativo: R$ 10,00 por dia (D-RG-78). O teste inteiro pede o dobro. */
export const VERBA_MINIMA_POR_CRIATIVO_MICROS = 10_000_000;
/**
 * Quantos dias os dois cupons do teste valem, a partir do dia do pedido: cobre a espera até ativar e os 28 dias do teste
 * (ativar confere que eles valem até o fim). O Liame não desativa os cupons ao encerrar: foram anunciados.
 */
export const VALIDADE_DOS_CUPONS_DO_TESTE_DIAS = 45;
/** O texto principal do anúncio, com a linha do cupom: o mesmo limite do texto da peça. */
export const LIMITE_DO_TEXTO_DO_ANUNCIO = 400;

export const SituacaoDoTesteDeCriativo = z.enum(['pedido', 'criando', 'pronto', 'rodando', 'terminado', 'encerrado', 'interrompido', 'cancelado']);
export type SituacaoDoTesteDeCriativo = z.infer<typeof SituacaoDoTesteDeCriativo>;

const Dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** O desconto dos dois cupons do teste (o mesmo nos dois, D-RG-77): em % ou em valor, o pedido mínimo e até quando vale. */
export const DescontoDoTeste = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('percentual'), percentual: z.int().min(1).max(100), pedido_minimo_centavos: z.int().min(0).max(100_000_000), valido_de: Dia, valido_ate: Dia }),
  z.object({ tipo: z.literal('valor'), valor_centavos: z.int().min(1).max(100_000_000), pedido_minimo_centavos: z.int().min(0).max(100_000_000), valido_de: Dia, valido_ate: Dia }),
]);
export type DescontoDoTeste = z.infer<typeof DescontoDoTeste>;

export const SituacaoDoCupomDoTeste = z.enum(['a_criar', 'pedido', 'criado', 'falhou']);

const CriativoDoTeste = z.object({
  letra: z.enum(['A', 'B']),
  /** A peça aprovada, como está em Criativos. */
  peca: z.object({
    id: z.string().regex(UUID),
    versao: z.number().int().min(1),
    titulo: z.string().min(1).max(60),
    texto: z.string().min(1).max(400),
    botao: z.enum(['pedir_agora', 'ver_cardapio']),
  }),
  /** O texto que sai no anúncio: o da peça com a linha do cupom no fim. É o que a pessoa aprova. */
  texto_do_anuncio: z.string().min(1).max(LIMITE_DO_TEXTO_DO_ANUNCIO),
  midia: z.object({ id: z.string().regex(UUID), tipo: z.enum(['foto', 'video']), arquivo: z.string().min(1) }),
  cupom: z.object({ codigo: z.string().regex(/^[A-Z0-9]{4,20}$/), situacao: SituacaoDoCupomDoTeste }),
});
export type CriativoDoTeste = z.infer<typeof CriativoDoTeste>;

/**
 * O estado do pedido: o que a pessoa vê e aprova (os dois criativos com o texto que sai e o cupom de cada um, o
 * desconto, quem assina, a loja e quem vê, a verba do teste inteiro e os dias). O que o Liame já criou na Meta fica na
 * linha do teste e dos criativos, fora do estado.
 */
export const EstadoDoTesteDeCriativo = z.object({
  teste: z.string().regex(UUID),
  marca: z.string().regex(UUID),
  nome: z.string().min(1).max(80),
  /** Só pedidos pelo cardápio nesta entrega: quem decide é o caixa, e é o cardápio que liga o pedido ao anúncio. */
  objetivo: z.literal('cardapio'),
  criativos: z.tuple([CriativoDoTeste, CriativoDoTeste]),
  desconto: DescontoDoTeste,
  pagina: z.object({ id: z.string().min(1), nome: z.string() }),
  instagram: z.object({ id: z.string().min(1), nome: z.string() }).nullable(),
  publico: z.object({ de: z.number().int().nonnegative(), ate: z.number().int().nonnegative() }).nullable().optional(),
  loja: z.object({ id: z.string().regex(UUID), nome: z.string(), latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
  /** Quem vê: o raio em volta da loja ou os bairros, um ou outro, o mesmo nos dois conjuntos. */
  raio_km: z.number().min(1).max(15).nullable(),
  bairros: z.array(BairroDaCampanha).min(1).max(MAXIMO_DE_BAIRROS).nullable().optional(),
  /** A verba diária do teste inteiro; cada conjunto leva a metade. */
  verba_diaria_micros: z.number().int().positive(),
  moeda: z.string().min(3).max(3),
  fuso: z.string().min(1),
  link: z.string().url(),
  dias: z.object({ minimo: z.literal(DIAS_DO_TESTE_DE_CRIATIVO.minimo), maximo: z.literal(DIAS_DO_TESTE_DE_CRIATIVO.maximo) }),
  situacao: SituacaoDoTesteDeCriativo,
  /** Ativada pelo Liame: os dois anúncios, os dois conjuntos e a campanha rodando na Meta. */
  ativa: z.boolean(),
});
export type EstadoDoTesteDeCriativo = z.infer<typeof EstadoDoTesteDeCriativo>;

// ------------------------------------------------------------ o resultado guardado

const NumerosGuardados = z.object({ pedidos: z.number().int().nonnegative(), receita_micros: z.number().nonnegative(), gasto_micros: z.number().nonnegative().nullable(), visitas: z.number().int().nonnegative().nullable() });

/**
 * O que a rotina guarda do teste rodando (`campaign_test.result`): cada olhada (o dia, os pedidos de cada criativo até
 * ele e a chance de acaso), o veredito da última, quem venceu e os números de cada criativo até a última olhada. São
 * somas: nunca um pedido nem um cliente. A olhada guardada não é refeita (D-RG-91).
 */
export const ResultadoDoTesteDeCriativo = z.object({
  olhadas: z.array(z.object({ dia: z.number().int().min(1), a: z.number().int().nonnegative(), b: z.number().int().nonnegative(), acaso: z.number().min(0).max(1) })).max(10),
  veredito: z.enum(['ainda_nao', 'venceu', 'sem_vencedor']),
  vencedor: z.enum(['A', 'B']).nullable(),
  criativos: z.object({ A: NumerosGuardados, B: NumerosGuardados }),
});
export type ResultadoDoTesteDeCriativo = z.infer<typeof ResultadoDoTesteDeCriativo>;

// ------------------------------------------------------------ o texto com o cupom

const reais = (centavos: number): string => `R$ ${(centavos / 100).toFixed(2).replace('.', ',')}`;

/**
 * A linha do cupom no fim do texto do anúncio: o código, o desconto e o pedido mínimo, quando há. Diz só o que o cupom
 * faz no Regem (nada de "na primeira compra": o cupom do teste não tem essa regra).
 */
export function linhaDoCupom(codigo: string, desconto: DescontoDoTeste): string {
  const quanto = desconto.tipo === 'percentual' ? `${desconto.percentual}% de desconto` : `${reais(desconto.valor_centavos)} de desconto`;
  const minimo = desconto.pedido_minimo_centavos > 0 ? ` em pedidos a partir de ${reais(desconto.pedido_minimo_centavos)}` : '';
  return `Cupom ${codigo}: ${quanto}${minimo}.`;
}

/** O texto que sai no anúncio: o da peça e, depois de uma linha em branco, a linha do cupom. Nada é cortado. */
export function textoDoAnuncioDoTeste(textoDaPeca: string, codigo: string, desconto: DescontoDoTeste): string {
  return `${textoDaPeca.trimEnd()}\n\n${linhaDoCupom(codigo, desconto)}`;
}

// ------------------------------------------------------------ os planos das ferramentas

export type PlanoDoTesteDeCriativo = { ok: true; desejado: EstadoDoTesteDeCriativo } | { ok: false; motivo: string };

const NAO_E = 'Esta ferramenta é para um teste de criativo do Liame.';

/** A verba de cada conjunto: a metade exata da verba do teste, em micros; nula quando a metade não fecha em centavos. */
export function verbaDeCadaCriativo(verbaDoTesteMicros: number): number | null {
  const metade = verbaDoTesteMicros / 2;
  return Number.isInteger(metade) && metade % 10_000 === 0 ? metade : null;
}

/** O que impede o teste de ser pedido com este estado; nulo quando pode. As mesmas regras para a rota e para o plano. */
export function oQueImpedeOTeste(e: EstadoDoTesteDeCriativo): string | null {
  const [a, b] = e.criativos;
  if (a.letra !== 'A' || b.letra !== 'B') return 'O teste tem o criativo A e o criativo B, nesta ordem.';
  if (a.peca.id === b.peca.id && a.midia.id === b.midia.id) return 'Os dois criativos do teste são iguais: escolha outra peça ou outra foto para o segundo.';
  if (a.cupom.codigo === b.cupom.codigo) return 'Cada criativo tem o seu cupom: os dois códigos não podem ser iguais.';
  if ((e.raio_km === null) === !e.bairros?.length) return 'Quem vê o teste é o raio em volta da loja ou os bairros: um dos dois.';
  const cada = verbaDeCadaCriativo(e.verba_diaria_micros);
  if (cada === null) return 'A verba do teste é dividida ao meio: escolha um valor que dê a metade exata em centavos.';
  if (cada < VERBA_MINIMA_POR_CRIATIVO_MICROS) return 'Cada criativo precisa de pelo menos R$ 10,00 por dia: o teste inteiro, de R$ 20,00 por dia.';
  for (const c of e.criativos) {
    if (c.texto_do_anuncio !== textoDoAnuncioDoTeste(c.peca.texto, c.cupom.codigo, e.desconto)) return 'O texto do anúncio não é o da peça com a linha do cupom.';
  }
  if (e.desconto.valido_ate < e.desconto.valido_de) return 'A validade do cupom termina antes de começar.';
  return null;
}

/**
 * O plano da ferramenta `teste_de_criativo_criar`: o teste pedido vira criado na Meta, pausado (`criando`: faltam os
 * cupons, que a rotina pede em seguida). O que já passou do pedido não volta a ser pedido. Função pura.
 */
export function planoDoTesteDeCriativo(before: unknown): PlanoDoTesteDeCriativo {
  const lido = EstadoDoTesteDeCriativo.safeParse(before);
  if (!lido.success) return { ok: false, motivo: NAO_E };
  const e = lido.data;
  if (e.situacao === 'cancelado') return { ok: false, motivo: 'Este teste foi cancelado.' };
  if (e.situacao !== 'pedido') return { ok: false, motivo: 'Este teste já foi aprovado: a campanha de teste já existe na Meta ou está sendo criada.' };
  const impede = oQueImpedeOTeste(e);
  if (impede) return { ok: false, motivo: impede };
  return { ok: true, desejado: { ...e, situacao: 'criando' } };
}

/**
 * O plano de ativar: a campanha de teste criada e pausada passa a rodar, com os dois conjuntos. Só com os dois cupons
 * criados no Regem: sem um deles, um criativo rodaria sem como o caixa dizer de onde veio o pedido. Função pura.
 */
export function planoDeAtivarOTeste(before: unknown): PlanoDoTesteDeCriativo {
  const lido = EstadoDoTesteDeCriativo.safeParse(before);
  if (!lido.success) return { ok: false, motivo: NAO_E };
  const e = lido.data;
  if (e.ativa) return { ok: false, motivo: 'Este teste já está ativo.' };
  if (e.criativos.some((c) => c.cupom.situacao !== 'criado')) return { ok: false, motivo: 'Os dois cupons do teste ainda não existem no Regem: ative depois que os dois forem criados.' };
  if (e.situacao !== 'pronto') return { ok: false, motivo: 'A campanha de teste ainda não está pronta na Meta: ative depois que ela existir, pausada.' };
  return { ok: true, desejado: { ...e, ativa: true, situacao: 'rodando' } };
}

/** O plano de pausar (a volta de ativar, e o que "Encerrar o teste" pede): a campanha de teste para de rodar. Função pura. */
export function planoDePausarOTeste(before: unknown): PlanoDoTesteDeCriativo {
  const lido = EstadoDoTesteDeCriativo.safeParse(before);
  if (!lido.success) return { ok: false, motivo: NAO_E };
  const e = lido.data;
  if (!e.ativa) return { ok: false, motivo: 'Este teste não está ativo: não há o que pausar.' };
  return { ok: true, desejado: { ...e, ativa: false } };
}

// ------------------------------------------------------------ os objetos na Meta

/** O nome da campanha de teste na Meta. */
export const nomeDaCampanhaDeTeste = (nome: string): string => `Teste · ${nome}`.slice(0, 80);

/**
 * Um criativo do teste visto como uma campanha nova, para os mesmos parâmetros da Meta (`parametrosDoConjunto`,
 * `parametrosDoCriativo`, `parametrosDoAnuncio`): o nome com a letra, a peça com o texto que sai no anúncio (com o
 * cupom), a mídia dele, a metade da verba e o mesmo público. Sem data de fim: quem encerra o teste é o Liame, e o
 * criativo que vencer pode seguir rodando.
 */
export function criativoComoCampanhaNova(e: EstadoDoTesteDeCriativo, letra: LetraDoTeste): EstadoDaCampanhaNova {
  const c = e.criativos[letra === 'A' ? 0 : 1];
  const verba = verbaDeCadaCriativo(e.verba_diaria_micros);
  if (verba === null) throw new Error('a verba do teste sem a metade exata em centavos');
  return {
    campanha: e.teste,
    marca: e.marca,
    nome: `${e.nome} · ${letra}`.slice(0, 80),
    objetivo: e.objetivo,
    peca: { id: c.peca.id, versao: c.peca.versao, titulo: c.peca.titulo, texto: c.texto_do_anuncio, botao: c.peca.botao },
    midia: c.midia,
    pagina: e.pagina,
    instagram: e.instagram,
    publico: e.publico ?? null,
    loja: e.loja,
    raio_km: e.raio_km,
    bairros: e.bairros ?? null,
    verba_diaria_micros: verba,
    moeda: e.moeda,
    fim: null,
    fuso: e.fuso,
    link: e.link,
    situacao: 'pedida',
    ativa: false,
  };
}

/** Os passos da criação do teste que levam chave de idempotência (o vídeo não leva: o id dele fica guardado). */
export type PassoDoTesteDeCriativo = 'campanha' | `${'conjunto' | 'criativo' | 'anuncio'}:${LetraDoTeste}`;

/** A chave de idempotência de um passo da criação do teste: o teste e o passo. NÃO mude o formato (como na campanha nova). */
export const chaveDoPassoDoTeste = (teste: string, passo: PassoDoTesteDeCriativo): string => `teste:${teste}:${passo}`;
