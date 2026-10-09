import type { ActionResponse, MessagingCampaign, MessagingCampaignDetailResponse } from '@liame/contracts';
import { centavos } from '@/components/mensagens/textos';
import { horaDe, inteiro } from '@/lib/formato';
import type { PedidoApresentado, Risco } from './textos';

// O pedido de mensagem de WhatsApp em Aprovações (mockups/prototipo-mensagens.html, P15 aprovado em 09/10/2026; Y5 da
// A5). O servidor manda a mensagem do pedido (`message`: o texto do modelo, as variáveis, o público, a janela, o cupom e
// o plano do disparo) e, depois do envio, os números lidos do RegemCast. Aqui isso vira o título, as quatro partes à
// vista (a mensagem, quem recebe, quando sai, quanto custa), o que impede a aprovação e o resultado.
// Só números e textos escritos pela loja ou pelo RegemCast: nenhum nome e nenhum telefone de quem recebe.

type Acao = ActionResponse;
export type AcaoDeMensagem = Acao & { message: NonNullable<Acao['message']> };
type Mensagem = AcaoDeMensagem['message'];

/** O pedido é de envio ou de pausa de uma mensagem que o Liame montou? */
export function ehPedidoDeMensagem(a: Acao): a is AcaoDeMensagem {
  return Boolean(a.message) && (a.tool === 'mensagem_disparar' || a.tool === 'mensagem_pausar');
}

const ehPausa = (a: Pick<Acao, 'tool'>): boolean => a.tool === 'mensagem_pausar';
const plural = (n: number, um: string, varios: string) => `${inteiro(n)} ${n === 1 ? um : varios}`;
const ponto = (t: string): string => (/[.!?…]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);
const diaMes = (d: string): string => d.split('-').reverse().slice(0, 2).join('/');

/** Quantas pessoas recebem: as do plano do disparo; sem o plano, as que podiam receber na hora do pedido. */
export function pessoasDaMensagem(m: Mensagem): number {
  return m.plan?.people ?? m.audience.can_receive;
}

// ---------------------------------------------------------------- o texto da mensagem

const ROTULO_DA_VARIAVEL: Record<string, string> = { nome: 'nome', primeiro_nome: 'primeiro nome', cashback_saldo: 'saldo de cashback', cashback_validade: 'validade do cashback' };

export interface Trecho {
  t: string;
  /** O que o RegemCast preenche na hora do envio (o primeiro nome de cada pessoa…): o Liame não vê o valor. */
  variavel?: boolean;
}

/** O texto com cada `{{n}}` no lugar: o valor fixo como texto, e o nome do que o RegemCast preenche como marca. */
export function trechosDoTexto(texto: string, variaveis: Mensagem['variables']): Trecho[] {
  const trechos: Trecho[] = [];
  let resto = texto;
  for (;;) {
    const abre = resto.indexOf('{{');
    const fecha = abre < 0 ? -1 : resto.indexOf('}}', abre);
    if (abre < 0 || fecha < 0) break;
    const n = Number(resto.slice(abre + 2, fecha));
    const v = Number.isInteger(n) && n >= 1 ? variaveis[n - 1] : undefined;
    if (abre > 0) trechos.push({ t: resto.slice(0, abre) });
    if (!v) trechos.push({ t: resto.slice(abre, fecha + 2) });
    else if (v.origin === 'fixo') trechos.push({ t: v.value ?? '' });
    else trechos.push({ t: ROTULO_DA_VARIAVEL[v.origin] ?? 'preenchido pelo RegemCast', variavel: true });
    resto = resto.slice(fecha + 2);
  }
  if (resto) trechos.push({ t: resto });
  return trechos;
}

export interface BolhaDaMensagem {
  titulo: Trecho[] | null;
  corpo: Trecho[];
  rodape: string | null;
  botoes: string[];
  /** A frase embaixo da bolha: a categoria do modelo e quem põe o nome de cada pessoa. */
  nota: string;
}

export function bolhaDaMensagem(m: Mensagem): BolhaDaMensagem {
  const t = m.template;
  const preenchidas = [...m.variables, ...(m.header_variable ? [m.header_variable] : [])].filter((v) => v.origin !== 'fixo').map((v) => ROTULO_DA_VARIAVEL[v.origin] ?? null);
  const quais = [...new Set(preenchidas.filter((x): x is string => x !== null))];
  const categoria = t.category ? `Modelo de ${t.category}` : 'Modelo';
  const nota = quais.length
    ? `${categoria}, aprovado pela Meta. O RegemCast põe ${quais.length === 1 ? `o ${quais[0]}` : `${quais.slice(0, -1).map((q) => `o ${q}`).join(', ')} e o ${quais.at(-1)}`} de cada pessoa na hora do envio; o Liame não vê nome nem telefone.`
    : `${categoria}, aprovado pela Meta. O Liame não vê nome nem telefone de quem recebe.`;
  return { titulo: t.header ? trechosDoTexto(t.header, m.header_variable ? [m.header_variable] : []) : null, corpo: trechosDoTexto(t.body, m.variables), rodape: t.footer, botoes: t.buttons, nota };
}

// ---------------------------------------------------------------- quem recebe, quando sai, quanto custa

export interface QuemRecebe {
  forte: string;
  publico: string;
  conta: { rotulo: string; valor: string }[];
  nota: string;
}

export function quemRecebe(m: Mensagem): QuemRecebe {
  const recebem = pessoasDaMensagem(m);
  const a = m.audience;
  const podem = a.can_receive + a.resting;
  const conta = [{ rotulo: 'Podem receber neste público', valor: inteiro(podem) }];
  if (a.resting > 0) conta.push({ rotulo: a.rest_days ? `Ficam de fora: receberam marketing nos últimos ${plural(a.rest_days, 'dia', 'dias')}` : 'Ficam de fora: receberam marketing há pouco', valor: inteiro(a.resting) });
  conta.push({ rotulo: 'Recebem esta mensagem', valor: inteiro(recebem) });
  return {
    forte: plural(recebem, 'pessoa', 'pessoas'),
    publico: ponto(a.rule ? `${a.name}: ${a.rule}` : a.name),
    conta,
    nota: `Quem pediu para sair ou não tem WhatsApp já não entra ${podem === 1 ? 'nessa conta' : `nos ${inteiro(podem)}`}.`,
  };
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
/** "09:00" → "9h"; "14:30" → "14h30". */
export function horaCurta(hhmm: string): string {
  const [h, m] = hhmm.split(':');
  return `${Number(h)}h${m === '00' ? '' : m}`;
}

/** "todos os dias, das 9h às 20h"; "sábado e domingo, das 11h às 14h30". */
export function janelaEscrita(w: Mensagem['window']): string {
  const dias = [...new Set(w.days)].sort((x, y) => x - y);
  const nomes = dias.map((d) => DIAS[d] ?? '').filter(Boolean);
  const quais = dias.length === 7 ? 'todos os dias' : nomes.length === 1 ? `só ${nomes[0]}` : `${nomes.slice(0, -1).join(', ')} e ${nomes.at(-1)}`;
  return `${quais}, das ${horaCurta(w.start)} às ${horaCurta(w.end)}`;
}

export interface QuantoCusta {
  forte: string;
  texto: string;
  /** O envio não cabe no teto de gasto de mensagens do mês. */
  naoCabe: boolean;
}

export function quantoCusta(m: Mensagem): QuantoCusta {
  const custo = m.plan?.cost_cents ?? null;
  const mes = m.plan?.budget.periods.find((p) => p.period === 'mes') ?? null;
  const base = 'É estimativa e é teto: a Meta só cobra a mensagem entregue.';
  if (custo === null) return { forte: 'Sem preço para estimar', texto: 'O RegemCast não tem preço cadastrado para estimar o custo desta mensagem.', naoCabe: false };
  if (!mes) {
    const semTeto = m.plan && !m.plan.budget.defined ? ' A conta não tem teto de gasto de mensagens definido no RegemCast.' : '';
    return { forte: `até ${centavos(custo)}`, texto: `${base}${semTeto}${m.plan?.budget.notice ? ` ${ponto(m.plan.budget.notice)}` : ''}`, naoCabe: false };
  }
  const sobra = Math.max(0, mes.limit_cents - mes.spent_cents);
  const cabe = custo <= sobra;
  return {
    forte: `até ${centavos(custo)}`,
    texto: `${base} Do seu teto de gasto de ${mes.label.toLowerCase()} (${centavos(mes.limit_cents)}) sobram ${centavos(sobra)}: ${cabe ? 'cabe' : 'não cabe'}.${m.plan?.budget.notice ? ` ${ponto(m.plan.budget.notice)}` : ''}`,
    naoCabe: !cabe,
  };
}

/** "10% de desconto, em pedidos a partir de R$ 40,00, válido de 10/10 a 12/10". */
export function regraDoCupomEscrita(c: NonNullable<Mensagem['coupon']>): string {
  const desconto = c.kind === 'percentual' ? `${c.percent ?? '?'}% de desconto` : c.kind === 'valor' ? `${centavos(c.value_cents ?? 0)} de desconto` : 'entrega grátis';
  const minimo = c.min_order_cents ? `, em pedidos a partir de ${centavos(c.min_order_cents)}` : '';
  return `${desconto}${minimo}, válido de ${diaMes(c.valid_from)} a ${diaMes(c.valid_until)}`;
}

// ---------------------------------------------------------------- o pedido que espera a decisão

export const MOTIVOS_DA_MENSAGEM = ['Não é o momento', 'Quero outro texto', 'Quero outro público', 'Não quero enviar'];

export interface Impedimento {
  tom: 'espera' | 'falha';
  icone: 'clock' | 'wallet';
  forte: string;
  texto: string;
}

/** O que impede a aprovação agora (o servidor recusa aprovar enquanto durar); nulo quando nada impede. */
export function impedimentoDoPedido(a: Pick<Acao, 'blocked_reason' | 'status'>): Impedimento | null {
  if (a.status !== 'aguardando_aprovacao' || !a.blocked_reason) return null;
  const motivo = ponto(a.blocked_reason);
  const doTeto = motivo.startsWith('Não cabe no teto de gasto de mensagens');
  return doTeto
    ? { tom: 'falha', icone: 'wallet', forte: 'Ainda não dá para aprovar: não cabe no teto de gasto de mensagens.', texto: motivo.slice(motivo.indexOf(':') + 1).trim().replace(/^./, (c) => c.toUpperCase()) }
    : { tom: 'espera', icone: 'clock', forte: 'Ainda não dá para aprovar.', texto: `${motivo} Quando isso se resolver, confira de novo: o pedido passa a poder ser aprovado.` };
}

/** Quem propôs, para a frase do modo simples. */
function quemPropoe(a: Pick<Acao, 'agent_key' | 'requested_by'>): string {
  if (!a.agent_key) return `${a.requested_by.name} pediu para enviar`;
  return a.agent_key === 'crm' ? 'O funcionário de CRM e mensageria propõe enviar' : 'Um funcionário de IA propõe enviar';
}

export interface TextosDaMensagem {
  titulo: string;
  risco: Risco;
  /** A frase do modo simples, em trechos (o que vai em negrito). */
  frase: { t: string; b?: boolean }[];
  doRisco: string;
  bolha: BolhaDaMensagem;
  quem: QuemRecebe;
  quando: { forte: string; texto: string };
  custo: QuantoCusta;
  cupom: { codigo: string; texto: string } | null;
}

export function textosDaMensagem(a: AcaoDeMensagem): TextosDaMensagem {
  const m = a.message;
  const pessoas = pessoasDaMensagem(m);
  const custo = quantoCusta(m);
  const janela = janelaEscrita(m.window);
  const impedido = Boolean(impedimentoDoPedido(a));
  const custoDoPlano = m.plan?.cost_cents ?? null;
  const frase: TextosDaMensagem['frase'] = [
    { t: `${quemPropoe(a)} ` },
    { t: `“${m.name}”`, b: true },
    { t: ' por WhatsApp para ' },
    { t: plural(pessoas, 'pessoa', 'pessoas'), b: true },
    { t: ` (${m.audience.name}), ${janela}.` },
  ];
  if (custoDoPlano !== null) frase.push({ t: ' Pode custar ' }, { t: `até ${centavos(custoDoPlano)}`, b: true }, { t: '.' });
  if (!impedido) frase.push({ t: ' Se você aprovar, o RegemCast envia.' });
  const c = m.coupon;
  return {
    titulo: ehPausa(a) ? `Pausar o envio de “${m.name}”` : `Enviar “${m.name}” para ${plural(pessoas, 'pessoa', 'pessoas')}`,
    // Custa dinheiro, fala com clientes da loja e não tem volta: é o risco mais alto do trilho (o servidor diz R3).
    risco: a.risk_level === 'R3' ? 'alto' : a.risk_level === 'R2' ? 'medio' : 'baixo',
    frase,
    doRisco: custoDoPlano !== null ? `Gasta até ${centavos(custoDoPlano)} e fala com ${plural(pessoas, 'cliente', 'clientes')} de uma vez.` : `Fala com ${plural(pessoas, 'cliente', 'clientes')} de uma vez.`,
    bolha: bolhaDaMensagem(m),
    quem: quemRecebe(m),
    quando: { forte: `Depois da aprovação, ${janela}`, texto: `Só dentro da janela das ${horaCurta(m.window.start)} às ${horaCurta(m.window.end)}. O que não sair num dia continua no seguinte, na mesma janela.` },
    custo,
    cupom: c
      ? {
          codigo: c.code,
          texto: `${regraDoCupomEscrita(c)}. ${c.created ? 'Ele já foi criado no Regem, junto com o envio,' : 'Ele é criado no Regem junto com o envio'} e é só desta mensagem: é por ele que os pedidos que vieram dela são contados no caixa.`,
        }
      : null,
  };
}

/** O envio foi para o RegemCast com o cupom criado: os pedidos que usarem o cupom são contados na tela Mensagens. */
export function cupomContaEmMensagens(a: AcaoDeMensagem): boolean {
  return !ehPausa(a) && a.status === 'executada' && Boolean(a.message.coupon?.created);
}

// ---------------------------------------------------------------- a lista

const PREFIXO_RECUSA = 'recusada por ';
function recusa(a: Pick<Acao, 'status' | 'status_reason'>): { quem: string; motivo: string | null } | null {
  if (a.status !== 'cancelada' || !a.status_reason?.startsWith(PREFIXO_RECUSA)) return null;
  const resto = a.status_reason.slice(PREFIXO_RECUSA.length);
  const i = resto.indexOf(': ');
  return i < 0 ? { quem: resto, motivo: null } : { quem: resto.slice(0, i), motivo: resto.slice(i + 2) };
}

/** A segunda linha do pedido de mensagem decidido, na lista. */
export function etiquetaDaMensagem(a: AcaoDeMensagem): string {
  const pausa = ehPausa(a);
  if (recusa(a)) return 'Recusada';
  if (a.status === 'cancelada') return 'Cancelada';
  if (a.status === 'expirada') return 'Expirou';
  if (a.status === 'falhou') return pausa ? 'Não pausada' : 'Não enviada';
  if (a.status !== 'executada') return pausa ? 'Pausando' : 'Indo para o RegemCast';
  if (pausa) return 'Pausada';
  return a.undone_by?.status === 'executada' ? 'Pausada' : 'No RegemCast';
}

/** O pedido de mensagem como a lista e os avisos o escrevem. */
export function mensagemApresentada(a: AcaoDeMensagem): PedidoApresentado {
  const t = textosDaMensagem(a);
  const custo = a.message.plan?.cost_cents ?? null;
  return {
    titulo: t.titulo,
    resumo: t.frase.map((x) => x.t).join(''),
    impacto: ehPausa(a) || custo === null ? null : `até ${centavos(custo)}`,
    mudancas: [],
    desfazer: 'Mensagem enviada não volta. Dá para pausar o que ainda não saiu.',
    depoisDeAprovar: 'O RegemCast começa a enviar dentro da janela.',
  };
}

// ---------------------------------------------------------------- o pedido decidido

export interface ResultadoDaMensagem {
  tom: 'neutro' | 'ok' | 'espera' | 'falha';
  icone: 'check' | 'clock' | 'x' | 'pause';
  forte: string | null;
  texto: string;
  /** O envio está em andamento e uma pessoa pode pausá-lo. */
  podePausar: boolean;
}

/** Quem pausou e quando (o pedido de pausa, quando a tela o tem). */
export type Pausa = { quem: string; quando: string } | null;

function aprovadaPor(a: Acao): string {
  const aprovacao = [...a.approvals].reverse().find((x) => x.current_plan && x.sufficient) ?? a.approvals.at(-1) ?? null;
  return aprovacao ? `Aprovada por ${aprovacao.approver_name} às ${horaDe(aprovacao.created_at)}` : 'Aprovada';
}

/**
 * O que aconteceu com o pedido de envio decidido. `campanha` são os números lidos do RegemCast agora (nulos enquanto a
 * leitura não chegou, ou quando ela não é possível); `custo` é o gasto que ele informa, em centavos.
 */
export function resultadoDoEnvio(a: AcaoDeMensagem, campanha: MessagingCampaign | null, custo: MessagingCampaignDetailResponse['cost'], pausa: Pausa): ResultadoDaMensagem {
  const nada = { podePausar: false };
  const r = recusa(a);
  if (r) return { tom: 'falha', icone: 'x', forte: null, texto: r.motivo ? `Recusada por ${r.quem}: “${r.motivo}”. Nada foi enviado.` : `Recusada por ${r.quem}. Nada foi enviado.`, ...nada };
  if (a.status === 'cancelada') return { tom: 'falha', icone: 'x', forte: null, texto: 'Cancelada por quem pediu. Nada foi enviado.', ...nada };
  if (a.status === 'expirada') return { tom: 'falha', icone: 'x', forte: null, texto: 'Expirou sem aprovação: nada foi enviado.', ...nada };
  const quem = aprovadaPor(a);
  if (a.status === 'falhou') return { tom: 'falha', icone: 'x', forte: `${quem}, mas a mensagem não foi enviada.`, texto: ` ${ponto(a.status_reason ?? 'O envio falhou')}`, ...nada };
  if (a.status !== 'executada') {
    if (a.next_attempt_at) return { tom: 'espera', icone: 'clock', forte: `${quem}.`, texto: ` Ainda não foi para o RegemCast: ${a.status_reason ?? 'ele pediu para esperar'}. O Liame tenta de novo às ${horaDe(a.next_attempt_at)}.`, ...nada };
    return { tom: 'espera', icone: 'clock', forte: `${quem}.`, texto: ' O Liame manda o envio para o RegemCast em instantes.', ...nada };
  }
  const plano = a.message.plan;
  if (!campanha) return { tom: 'espera', icone: 'clock', forte: `${quem}.`, texto: ' O envio está com o RegemCast.', ...nada };
  if (campanha.status === 'pausada') {
    const naoSairam = Math.max(0, campanha.recipients - campanha.sent);
    return {
      tom: 'neutro',
      icone: 'pause',
      forte: pausa ? `Pausada por ${pausa.quem} às ${horaDe(pausa.quando)}.` : 'Pausada.',
      texto: ` ${plural(campanha.sent, 'mensagem já tinha saído e não volta', 'mensagens já tinham saído e não voltam')}; ${plural(naoSairam, 'não saiu', 'não saíram')}. Para retomar o envio, abra a campanha no RegemCast.`,
      ...nada,
    };
  }
  if (campanha.status === 'concluida') {
    const gasto = custo?.spent_cents ?? null;
    const estimativa = plano?.cost_cents ?? null;
    const terminou = campanha.finished_at ? `O RegemCast terminou às ${horaDe(campanha.finished_at)}: ` : '';
    const quanto = gasto === null ? '' : `, e custou ${centavos(gasto)}${estimativa === null ? '' : ` (a estimativa era até ${centavos(estimativa)})`}`;
    return { tom: 'ok', icone: 'check', forte: 'Enviada.', texto: ` ${terminou}${plural(campanha.delivered, 'pessoa recebeu', 'pessoas receberam')}${quanto}.`, ...nada };
  }
  if (campanha.status === 'cancelada') return { tom: 'falha', icone: 'x', forte: `${quem}.`, texto: ` A campanha foi cancelada no RegemCast: ${plural(campanha.sent, 'mensagem saiu', 'mensagens saíram')} antes disso.`, ...nada };
  return {
    tom: 'espera',
    icone: 'clock',
    forte: `${quem}. O RegemCast está enviando:`,
    texto: ` ${inteiro(campanha.sent)} de ${inteiro(campanha.recipients)} já saíram.`,
    podePausar: campanha.status === 'enviando' || campanha.status === 'agendada',
  };
}

/** O que aconteceu com o pedido de pausa (a pausa é direta: quem pede é quem pausa). */
export function resultadoDaPausa(a: AcaoDeMensagem): ResultadoDaMensagem {
  const nada = { podePausar: false };
  const quem = a.requested_by.name;
  if (a.status === 'executada') return { tom: 'neutro', icone: 'pause', forte: `Pausada por ${quem} às ${horaDe(a.updated_at)}.`, texto: ' O que já foi enviado não volta. Para retomar o envio, abra a campanha no RegemCast.', ...nada };
  if (a.status === 'falhou') return { tom: 'falha', icone: 'x', forte: `${quem} pediu a pausa, mas ela não foi feita.`, texto: ` ${ponto(a.status_reason ?? 'A pausa falhou')}`, ...nada };
  if (a.status === 'cancelada' || a.status === 'expirada') return { tom: 'falha', icone: 'x', forte: null, texto: 'A pausa não foi feita: o pedido saiu da fila.', ...nada };
  if (a.status === 'aguardando_aprovacao') return { tom: 'espera', icone: 'clock', forte: `${quem} pediu a pausa.`, texto: ' A política da empresa pede a aprovação de uma pessoa para pausar.', ...nada };
  return { tom: 'espera', icone: 'clock', forte: `${quem} pediu a pausa.`, texto: ' O Liame pausa no RegemCast em instantes.', ...nada };
}
