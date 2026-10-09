import type { ActionResponse } from '@liame/contracts';
import { diasAte, horaDe, quandoComHora, reaisDeMicros } from '@/lib/formato';

// Regras e textos da tela Aprovações (mockups/prototipo-app.html, vista "aprovacoes"). O servidor manda os
// dados do pedido (ferramenta, parâmetros, quem pediu, loja, campanha, política); aqui eles viram o título, o
// "antes e depois" e as frases de cada tipo de pedido. Ferramenta que a tela ainda não conhece aparece pelo
// nome dela e pelos parâmetros, sem inventar frase.

type Mudanca = [item: string, antes: string, depois: string];

export type PedidoApresentado = {
  titulo: string;
  /** A frase do modo Lite: o que acontece se a pessoa aprovar. */
  resumo: string;
  /** O que pesa na lista, ao lado do risco (o valor do pedido); nulo quando não há número a mostrar. */
  impacto: string | null;
  mudancas: Mudanca[];
  /** Como se desfaz depois de executado. */
  desfazer: string;
  /** O aviso logo depois de aprovar. */
  depoisDeAprovar: string;
};

const CENTAVO_EM_MICROS = 10_000n;
/** Centavos (número inteiro dos parâmetros) em reais, sem ponto flutuante; redondo sai sem centavos. */
function reaisDeCentavos(centavos: unknown): string {
  const c = typeof centavos === 'number' && Number.isSafeInteger(centavos) ? BigInt(centavos) : 0n;
  return reaisDeMicros(c * CENTAVO_EM_MICROS, c % 100n === 0n ? 0 : 2);
}
const diaMes = (d: unknown) => (typeof d === 'string' ? d.split('-').reverse().slice(0, 2).join('/') : '—');
const texto = (v: unknown, reserva = '—') => (typeof v === 'string' && v ? v : reserva);

/** "15% · mín. R$ 50", como na aba Cupons. */
function regraDoCupom(p: Record<string, unknown>): string {
  const base = p.tipo === 'percentual' ? `${texto(String(p.percentual ?? ''), '?')}%` : p.tipo === 'valor' ? `${reaisDeCentavos(p.valor_centavos)} de desconto` : 'Entrega grátis';
  const minimo = typeof p.pedido_minimo_centavos === 'number' && p.pedido_minimo_centavos > 0 ? `mín. ${reaisDeCentavos(p.pedido_minimo_centavos)}` : 'sem mínimo';
  return `${base} · ${minimo}`;
}

function cupom(a: ActionResponse): PedidoApresentado {
  const p = a.params;
  const codigo = texto(p.codigo, 'sem código');
  const loja = a.account_name ?? 'loja do Regem';
  const regra = regraDoCupom(p);
  const validade = `${diaMes(p.valido_de)} a ${diaMes(p.valido_ate)}`;
  const exclusivo = p.exclusive === true;
  const campanha = a.campaign?.name ?? null;
  return {
    titulo: `Criar o cupom ${codigo} na ${loja}`,
    resumo: `${a.requested_by.name} pediu um cupom de ${regra}, válido de ${validade}${campanha ? `, para a campanha ${campanha}` : ''}. Se você aprovar, o Liame cria o cupom no Regem${campanha ? ' e liga à campanha' : ''}.`,
    impacto: regra,
    mudancas: [
      ['Cupom no Regem', 'não existe', codigo],
      ['Desconto', '—', regra],
      ['Validade', '—', validade],
      ['Campanha', '—', campanha ? `${campanha} · ${exclusivo ? 'exclusivo, prova a origem' : 'não exclusivo, só acompanha'}` : 'a campanha saiu da lista'],
    ],
    desfazer: 'O cupom pode ser desativado depois, no Regem. Os pedidos já feitos com ele continuam valendo.',
    depoisDeAprovar: 'O Liame cria o cupom no Regem em instantes.',
  };
}

function orcamento(a: ActionResponse): PedidoApresentado {
  const antes = a.current_value_micros === null ? '—' : `${reaisDeMicros(String(a.current_value_micros))}/dia`;
  const depois = a.value_micros === null ? '—' : `${reaisDeMicros(String(a.value_micros))}/dia`;
  const diferenca = a.value_micros !== null && a.current_value_micros !== null ? a.value_micros - a.current_value_micros : null;
  const sinal = diferenca !== null && diferenca < 0 ? '−' : '+';
  return {
    titulo: `Mudar o orçamento diário de ${a.resource_id}`,
    resumo: `${a.requested_by.name} pediu para o orçamento diário passar de ${antes} para ${depois}. Se você aprovar, o Liame faz a mudança na plataforma.`,
    impacto: diferenca === null ? null : `${sinal}${reaisDeMicros(String(Math.abs(diferenca)))}/dia`,
    mudancas: [['Orçamento diário', antes, depois]],
    desfazer: 'Se ninguém mexer depois, dá para voltar ao valor anterior. Se alguém mexer, o Liame não sobrescreve: avisa.',
    depoisDeAprovar: 'O Liame faz a mudança em instantes.',
  };
}

function pausar(a: ActionResponse): PedidoApresentado {
  return {
    titulo: `Pausar o anúncio ${a.resource_id}`,
    resumo: `${a.requested_by.name} pediu para pausar o anúncio. Se você aprovar, ele para de rodar.`,
    impacto: null,
    mudancas: [['Situação', 'ativo', 'pausado']],
    desfazer: 'O anúncio fica pausado, não apagado: dá para reativar.',
    depoisDeAprovar: 'O Liame pausa o anúncio em instantes.',
  };
}

function desconhecido(a: ActionResponse): PedidoApresentado {
  return {
    titulo: `${a.action} (${a.tool})`,
    resumo: `${a.requested_by.name} pediu a ação ${a.action}. Confira os detalhes antes de aprovar.`,
    impacto: null,
    mudancas: Object.entries(a.params).map(([k, v]): Mudanca => [k, '—', typeof v === 'object' ? JSON.stringify(v) : String(v)]),
    desfazer: 'Confira com quem pediu como esta ação se desfaz.',
    depoisDeAprovar: 'O Liame executa em instantes.',
  };
}

const POR_FERRAMENTA: Record<string, (a: ActionResponse) => PedidoApresentado> = { regem_cupom_criar: cupom, orcamento_ajustar: orcamento, anuncio_pausar: pausar };

export function apresentar(a: ActionResponse): PedidoApresentado {
  return (Object.hasOwn(POR_FERRAMENTA, a.tool) ? POR_FERRAMENTA[a.tool]! : desconhecido)(a);
}

// ─────────────────────────── risco, política e prazo ───────────────────────────

export type Risco = 'baixo' | 'medio' | 'alto';
export const ROTULO_RISCO: Record<Risco, string> = { baixo: 'Risco baixo', medio: 'Risco médio', alto: 'Risco alto' };

export function riscoDe(a: Pick<ActionResponse, 'risk_level'>): Risco {
  if (a.risk_level === 'R3') return 'alto';
  return a.risk_level === 'R2' ? 'medio' : 'baixo';
}

/** Por que o pedido precisa de alguém: a regra que a política aplicou. */
export function politicaDe(a: Pick<ActionResponse, 'mode' | 'policy'>): string {
  const frase = a.mode === 'ESCALATE' ? 'A política pede a decisão do dono para esta ação.' : 'A política pede aprovação para esta ação: nada é executado antes do seu ok.';
  return a.policy.versions.length ? `${frase} Regras em vigor: ${a.policy.versions.join(', ')}.` : frase;
}

/** "expira em 2 dias", "expira em 5 h", "expira em 20 min" ou "expirou". */
export function prazoDe(a: Pick<ActionResponse, 'expires_at'>, agora: Date): string {
  const ms = new Date(a.expires_at).getTime() - agora.getTime();
  if (ms <= 0) return 'expirou';
  const minutos = Math.ceil(ms / 60_000);
  if (minutos < 60) return `expira em ${minutos} min`;
  const horas = Math.round(minutos / 60);
  if (horas < 24) return `expira em ${horas} h`;
  const dias = Math.round(horas / 24);
  return `expira em ${dias} ${dias === 1 ? 'dia' : 'dias'}`;
}

/** "Plano 01a0f8d3 · hash a1b2…c3d4": a aprovação vale só para este plano. */
export function identidadeDoPlano(a: Pick<ActionResponse, 'id' | 'plan_hash'>): { plano: string; hash: string } {
  return { plano: a.id.slice(0, 8), hash: `${a.plan_hash.slice(0, 4)}…${a.plan_hash.slice(-4)}` };
}

// ─────────────────────────── grupos da lista ───────────────────────────

export type Grupo = 'pendente' | 'auto' | 'feito';
export const ROTULO_GRUPO: Record<Grupo, string> = { pendente: 'Precisa de você', auto: 'Feito sozinho, dentro dos limites', feito: 'Decididas hoje' };

const PREFIXO_RECUSA = 'recusada por ';

/** Recusado por quem aprova (a ação fica cancelada, com o motivo). */
export function recusaDe(a: Pick<ActionResponse, 'status' | 'status_reason'>): { quem: string; motivo: string | null } | null {
  if (a.status !== 'cancelada' || !a.status_reason?.startsWith(PREFIXO_RECUSA)) return null;
  const resto = a.status_reason.slice(PREFIXO_RECUSA.length);
  const i = resto.indexOf(': ');
  return i < 0 ? { quem: resto, motivo: null } : { quem: resto.slice(0, i), motivo: resto.slice(i + 2) };
}

/**
 * Onde o pedido entra na lista: o que espera aprovação; o que a política executou sozinha hoje; e o que foi
 * decidido hoje (aprovado, recusado, cancelado ou expirado). O resto (sombra, decisões de outros dias) fica de fora.
 */
export function grupoDe(a: ActionResponse, agora: Date): Grupo | null {
  if (a.status === 'aguardando_aprovacao') return 'pendente';
  if (a.status === 'sombra' || diasAte(a.updated_at, agora) !== 0) return null;
  // A pausa de um envio de mensagem é pedida e feita por uma pessoa, direto (sem aprovação): não é "feito sozinho".
  const direta = a.tool === 'mensagem_pausar' && !a.agent_key;
  const sozinho = (a.mode === 'AUTO' || a.mode === 'LIMITED_AUTO') && !a.approvals.length && !direta;
  return sozinho && a.status === 'executada' ? 'auto' : 'feito';
}

export function agrupar(itens: ActionResponse[], agora: Date): Record<Grupo, ActionResponse[]> {
  const grupos: Record<Grupo, ActionResponse[]> = { pendente: [], auto: [], feito: [] };
  for (const a of itens) {
    const g = grupoDe(a, agora);
    if (g) grupos[g].push(a);
  }
  // Na fila, o que expira primeiro vem primeiro; nas decididas, a mais recente.
  grupos.pendente.sort((x, y) => x.expires_at.localeCompare(y.expires_at));
  for (const g of ['auto', 'feito'] as const) grupos[g].sort((x, y) => y.updated_at.localeCompare(x.updated_at));
  return grupos;
}

/** A segunda linha do item decidido na lista. */
export function etiquetaDoDecidido(a: ActionResponse): string {
  if (recusaDe(a)) return 'Recusado';
  if (a.status === 'cancelada') return 'Cancelado';
  if (a.status === 'expirada') return 'Expirou';
  if (a.status === 'falhou') return 'Não executado';
  return a.status === 'executada' ? 'Executado' : 'Aprovado';
}

/** O que aconteceu com o pedido decidido, no detalhe. */
export function resultadoDe(a: ActionResponse): { ok: boolean; texto: string } {
  const recusa = recusaDe(a);
  if (recusa) return { ok: false, texto: recusa.motivo ? `Recusado por ${recusa.quem}: “${recusa.motivo}”. Nada foi executado.` : `Recusado por ${recusa.quem}. Nada foi executado.` };
  if (a.status === 'cancelada') return { ok: false, texto: 'Cancelado por quem pediu. Nada foi executado.' };
  if (a.status === 'expirada') return { ok: false, texto: 'Expirou sem aprovação: nada foi feito.' };
  const aprovacao = [...a.approvals].reverse().find((x) => x.current_plan && x.sufficient) ?? a.approvals.at(-1) ?? null;
  const quem = aprovacao ? `Aprovado por ${aprovacao.approver_name} às ${horaDe(aprovacao.created_at)}` : 'Aprovado pela política (dentro dos limites)';
  if (a.status === 'falhou') return { ok: false, texto: `${quem}, mas não foi executado: ${a.status_reason ?? 'a execução falhou'}.`.replace('..', '.') };
  if (a.status === 'executada') return { ok: true, texto: `${quem} e executado às ${horaDe(a.updated_at)}.` };
  // A plataforma mandou esperar (limite de uso da conta, fora do ar): o Liame adia, em vez de insistir.
  if (a.next_attempt_at) {
    return { ok: true, texto: `${quem}. Ainda não foi executado: ${a.status_reason ?? 'a plataforma pediu para esperar'}. O Liame tenta de novo às ${horaDe(a.next_attempt_at)}.` };
  }
  return { ok: true, texto: `${quem}. O Liame executa em instantes.` };
}

/** A aprovação que já existe mas não basta (falta o dono): aparece no pedido que continua na fila. */
export function aprovacaoParcial(a: ActionResponse): string | null {
  const parcial = a.approvals.filter((x) => x.current_plan && !x.sufficient);
  if (a.status !== 'aguardando_aprovacao' || !parcial.length) return null;
  return `${parcial.map((x) => x.approver_name).join(' e ')} já ${parcial.length === 1 ? 'aprovou' : 'aprovaram'}. Falta a aprovação do dono: o valor passa do limite de quem aprovou, ou a política pede a decisão dele.`;
}

/** "Rodrigo pediu · hoje, 09:41". */
export function cabecalhoDe(a: ActionResponse, agora: Date): { quem: string; verbo: string; quando: string } {
  const sozinho = grupoDe(a, agora) === 'auto';
  return { quem: sozinho ? 'Liame' : a.requested_by.name, verbo: sozinho ? 'fez sozinho' : 'pediu', quando: quandoComHora(a.created_at, agora) };
}

// ─────────────────────────── aprovar e recusar ───────────────────────────

/** Motivos prontos da recusa (os do protótipo, para um pedido feito por uma pessoa). */
export const MOTIVOS_DA_RECUSA = ['Não é o momento', 'Quero outro valor', 'Não concordo com o pedido'];

/** Confere o código do app antes de enviar: 6 números. */
export function erroDoCodigo(codigo: string): string | null {
  const c = codigo.trim();
  return c.length === 6 && [...c].every((d) => d >= '0' && d <= '9') ? null : 'Digite os 6 números do app autenticador.';
}

/** A recusa do servidor ao aprovar ou recusar, em palavras de gente; `recarregar`: a lista mudou por baixo. */
export function erroDaDecisao(p: { code: string; detail?: string; title: string }): { texto: string; noCodigo: boolean; recarregar: boolean } {
  if (p.code === 'codigo-invalido') return { texto: 'Código incorreto ou já usado. Espere o próximo código do app e tente de novo.', noCodigo: true, recarregar: false };
  if (p.code === 'segundo-fator-nao-configurado') return { texto: 'Para aprovar, ative o app autenticador em Segurança da conta.', noCodigo: false, recarregar: false };
  if (p.code === 'plano-mudou') return { texto: 'O pedido foi alterado depois que você abriu. Confira o plano novo antes de decidir.', noCodigo: false, recarregar: true };
  if (p.code === 'acao-nao-aguarda') return { texto: 'Este pedido não espera mais aprovação: alguém já decidiu, ou ele expirou.', noCodigo: false, recarregar: true };
  if (p.code === 'ja-aprovou') return { texto: 'A sua aprovação para este plano já está registrada.', noCodigo: false, recarregar: true };
  return { texto: p.detail ?? p.title, noCodigo: false, recarregar: false };
}

/** O aviso depois de aprovar: executa em instantes, ou ainda falta o dono. */
export function avisoDepoisDeAprovar(antes: PedidoApresentado, depois: ActionResponse): string {
  return depois.status === 'aguardando_aprovacao' ? 'Sua aprovação foi registrada. Falta a do dono para o pedido seguir.' : `Aprovado. ${antes.depoisDeAprovar}`;
}

/** O endereço da tela já aberta num pedido (o link do e-mail e o da aba Cupons). */
export function enderecoDoPedido(id: string): string {
  return `/aprovacoes?pedido=${id}`;
}

/** O id que veio em `?pedido`: só passa o que tem cara de id (36 caracteres, letras de a a f, números e hífen). */
export function pedidoDaUrl(valor: string | null): string | undefined {
  if (!valor || valor.length !== 36) return undefined;
  const ok = [...valor.toLowerCase()].every((c) => c === '-' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));
  return ok ? valor.toLowerCase() : undefined;
}

/** "Aprovações, 2 pendentes" (rótulo falado do item do menu). */
export function pendentesFalados(n: number): string {
  return n === 1 ? ', 1 pedido esperando' : `, ${n} pedidos esperando`;
}
