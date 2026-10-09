import { z } from 'zod';

// O estado de uma mensagem de WhatsApp montada no RegemCast, como o Action Service o guarda no pedido (A5, Y5), e as
// regras puras em cima dele. Mora aqui, fora do conector, porque o registro de ferramentas (`tools.ts`) usa as mesmas.
//
// O estado é o PLANO DO DISPARO que o RegemCast devolve para a campanha em rascunho que o Liame montou: quantas pessoas
// vão receber, o custo estimado (teto), o orçamento de mensagens da conta, o que impede agora e a confirmação. É esse
// plano que a pessoa aprova; o disparo só roda com a confirmação dele, e só se nada mudou. Só números e frases do
// RegemCast: nenhum telefone e nenhum nome de contato.

const Centavos = z.int().min(0);

export const EstadoDaMensagem = z.strictObject({
  tipo: z.literal('mensagem'),
  /** O id da campanha no RegemCast. */
  id: z.string().min(1).max(100),
  nome: z.string(),
  /** `rascunho`, `agendada`, `enviando`, `pausada`, `concluida` ou `cancelada` (o RegemCast pode ampliar). */
  situacao: z.string(),
  modelo: z.string(),
  categoria: z.string().nullable(),
  publico: z.string().nullable(),
  /** Quantas pessoas a campanha tem ao todo. */
  destinatarios: z.int().min(0),
  /** Quantas ainda vão receber (a fila). No rascunho, são todas. */
  pessoas: z.int().min(0),
  enviadas: z.int().min(0),
  moeda: z.string().nullable(),
  /** O custo estimado do que ainda vai sair, em centavos. É teto: a Meta só cobra a mensagem entregue. Nulo sem preço. */
  custo_centavos: Centavos.nullable(),
  pode_disparar: z.boolean(),
  /** As frases do RegemCast para o que impede o disparo agora. */
  impedimentos: z.array(z.string()),
  /** A impressão digital do plano; o disparo só roda com ela. Nula quando algo impede, ou depois do disparo. */
  confirmacao: z.string().nullable(),
  orcamento: z.strictObject({
    /** A conta tem pelo menos um teto de gasto de mensagens definido pelo dono, no RegemCast. */
    definido: z.boolean(),
    periodos: z.array(z.strictObject({ periodo: z.string(), rotulo: z.string(), teto_centavos: Centavos, gasto_centavos: Centavos, sinal: z.string() })),
    /** Quando o custo passa do que resta num teto: a campanha sai aos poucos. */
    aviso: z.string().nullable(),
  }),
});
export type EstadoDaMensagem = z.infer<typeof EstadoDaMensagem>;

export type FaseDaMensagem = 'rascunho' | 'andamento' | 'pausada' | 'fim';

/**
 * Em que pé a mensagem está, para o que o Liame pode fazer com ela: disparar (só o rascunho), pausar (só o que está em
 * andamento: agendada, esperando a janela, ou enviando) ou nada. A situação que o Liame não conhece conta como fim.
 */
export function faseDaMensagem(situacao: unknown): FaseDaMensagem {
  if (situacao === 'rascunho') return 'rascunho';
  if (situacao === 'agendada' || situacao === 'enviando') return 'andamento';
  if (situacao === 'pausada') return 'pausada';
  return 'fim';
}

/** Sem frase do RegemCast para o que impede. */
export const SEM_MOTIVO_DO_REGEMCAST = 'O RegemCast não deixa enviar esta mensagem agora.';

const emReais = (centavos: number): string => (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * O envio precisa caber no teto de gasto de mensagens DO MÊS que o dono definiu no RegemCast (D-A5-12, critério A5-12).
 * O RegemCast, sozinho, não recusa o que passa do teto: ele espalha o envio. O Liame é mais estrito no teto do mês,
 * porque uma promoção que continua no mês seguinte não é o que a pessoa aprovou. Os tetos do dia e da semana não
 * barram: eles só espalham o envio pelos dias, e o plano avisa. Devolve o motivo, ou nulo quando cabe.
 */
export function motivoDeNaoCaberNoTeto(e: Pick<EstadoDaMensagem, 'custo_centavos' | 'orcamento'>): string | null {
  const mes = e.orcamento.periodos.find((p) => p.periodo === 'mes');
  if (!mes || e.custo_centavos === null) return null;
  const sobra = Math.max(0, mes.teto_centavos - mes.gasto_centavos);
  if (e.custo_centavos <= sobra) return null;
  return `Não cabe no teto de gasto de mensagens do mês: o envio pode custar até ${emReais(e.custo_centavos)}, e sobram ${emReais(sobra)} de ${emReais(mes.teto_centavos)}. Quem muda o teto é o dono da conta, no RegemCast; outra saída é um público menor.`;
}

/**
 * O que impede a aprovação do envio agora, ou nulo (P15, escolha 6; critério A5-12): as frases do RegemCast (o modelo
 * ainda em análise na Meta, a conta sem teto de gasto, sem preço) e o envio que não cabe no teto do mês. Com um
 * impedimento, o pedido entra e ESPERA em Aprovações com o motivo: ninguém aprova enquanto ele durar.
 */
export function impedimentoDaMensagem(e: Pick<EstadoDaMensagem, 'pode_disparar' | 'confirmacao' | 'impedimentos' | 'custo_centavos' | 'orcamento'>): string | null {
  if (!e.pode_disparar || !e.confirmacao) return e.impedimentos.join(' ') || SEM_MOTIVO_DO_REGEMCAST;
  return motivoDeNaoCaberNoTeto(e);
}
