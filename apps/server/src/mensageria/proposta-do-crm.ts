import { type Tx, uuidv7 } from '@liame/database';
import { sql } from 'drizzle-orm';
import type { ComoPedir, MotivoDaMensagem } from '../ai/crm/mensagem.js';
import type { CupomDaMensagem, PropostaDeMensagem } from './proposta-de-mensagem.js';

// A proposta de mensagem do funcionário de CRM e mensageria (A5, Y6; `plano-a5.md` D-A5-14 e D-A5-15; protótipo P16;
// migration 0062). Entre "ele decidiu propor" e "o pedido de envio está em Aprovações" passa tempo: ele escreve, o
// código confere, o rascunho do modelo nasce no RegemCast, uma pessoa envia o modelo para a análise da Meta e só com o
// modelo aprovado o pedido de envio pode ser montado. Aqui fica o caminho da proposta e cada passo dele no banco.
//
// Todo passo é uma gravação condicional: só acontece se a proposta está na situação de onde o passo parte, e devolve
// se aconteceu. A rotina que roda duas vezes, ou que volta depois de cair no meio, não anda a proposta em dobro nem
// desfaz o que já acabou. Quem chama já está na transação da empresa (a RLS isola a empresa).

export const SITUACOES_DA_PROPOSTA = ['preparando', 'rascunho', 'pedido', 'barrada', 'descartada', 'falhou'] as const;
export type SituacaoDaProposta = (typeof SITUACOES_DA_PROPOSTA)[number];

/**
 * Para onde cada situação pode ir. `preparando`: ele escreve e o código confere; `rascunho`: o rascunho do modelo está
 * no RegemCast e espera a Meta; `pedido`: o pedido de envio foi montado (daqui em diante quem manda é Aprovações);
 * `barrada`: a conferência não deixou o texto passar; `descartada`: não vai virar pedido; `falhou`: a IA ou o
 * RegemCast não responderam, depois das tentativas.
 */
const CAMINHO: Record<SituacaoDaProposta, readonly SituacaoDaProposta[]> = {
  preparando: ['rascunho', 'barrada', 'descartada', 'falhou'],
  rascunho: ['pedido', 'descartada', 'falhou'],
  pedido: [],
  barrada: [],
  descartada: [],
  falhou: [],
};

export const podeIrPara = (de: SituacaoDaProposta, para: SituacaoDaProposta): boolean => CAMINHO[de].includes(para);
/** A proposta que acabou não anda mais: virou pedido, foi barrada, descartada ou falhou. */
export const propostaAcabou = (s: SituacaoDaProposta): boolean => CAMINHO[s].length === 0;
/** As que ainda estão no caminho. A marca tem uma por motivo de cada vez (índice `uq_message_proposal_andamento`). */
export const EM_ANDAMENTO = SITUACOES_DA_PROPOSTA.filter((s) => !propostaAcabou(s));

/**
 * O porquê de uma proposta descartada ou que falhou e o nome de cada item que a conferência barrou são códigos: de 2
 * a 40 letras minúsculas ou sublinhado, o mesmo formato que o banco confere. Conferido letra a letra, sem expressão
 * regular.
 */
const LETRAS_DE_CODIGO = 'abcdefghijklmnopqrstuvwxyz_';
export const ehCodigo = (c: string): boolean => c.length >= 2 && c.length <= 40 && [...c].every((letra) => LETRAS_DE_CODIGO.includes(letra));
const exigirCodigo = (c: string, oQue: string): void => {
  if (!ehCodigo(c)) throw new Error(`proposta do CRM: ${oQue} fora do formato de código`);
};

export type DonoDaProposta = { tenantId: string; id: string };

export type PropostaNova = {
  tenantId: string;
  brandId: string;
  /** A conta do RegemCast conectada (o id no Liame). */
  conta: string;
  /** O funcionário que propõe (a chave dele no registro) e a pessoa em nome de quem. */
  funcionario: string;
  emNomeDe: string | null;
  motivo: MotivoDaMensagem;
  comoPedir: ComoPedir;
  /** A oferta de Minha marca, como está escrita lá, e a versão do dossiê. A promoção sempre tem. */
  oferta: { texto: string; versaoDoDossie: number } | null;
  /** O público do RegemCast: de onde sai, o nome, a regra e quantas pessoas podem receber agora. */
  publico: { origem: PropostaDeMensagem['publico']; nome: string; regra: string | null; pessoas: number };
  /** O cupom da mensagem: dado de entrada, nunca saída do modelo. */
  cupom: CupomDaMensagem | null;
};

/**
 * Abre uma proposta, em `preparando`. Devolve o id, ou nulo quando a marca já tem uma proposta em andamento com o
 * mesmo motivo (ele não propõe duas promoções ao mesmo tempo).
 */
export async function abrirProposta(tx: Tx, p: PropostaNova): Promise<string | null> {
  if (p.motivo === 'promocao' && !p.oferta) throw new Error('proposta do CRM: a promoção parte de uma oferta de Minha marca');
  const id = uuidv7();
  const r = await tx.execute(sql`
    insert into liame.message_proposal (id, tenant_id, brand_id, connected_account_id, motive, destination, offer, dossier_version,
                                        audience, audience_name, audience_rule, people, coupon, agent_key, requested_by)
    values (${id}, ${p.tenantId}, ${p.brandId}, ${p.conta}, ${p.motivo}, ${p.comoPedir}, ${p.oferta?.texto ?? null}, ${p.oferta?.versaoDoDossie ?? null},
            ${JSON.stringify(p.publico.origem)}::jsonb, ${p.publico.nome}, ${p.publico.regra}, ${p.publico.pessoas},
            ${p.cupom ? JSON.stringify(p.cupom) : null}::jsonb, ${p.funcionario}, ${p.emNomeDe})
    on conflict (brand_id, motive) where status in ('preparando', 'rascunho') do nothing
    returning id`);
  return r.rows[0] ? id : null;
}

/**
 * O que ele escreveu, já conferido, fica guardado antes de o rascunho ir para o RegemCast: se a chamada de lá falhar,
 * a rotina tenta o rascunho de novo sem pedir outro texto (e sem gastar IA de novo).
 */
export async function guardarEscrita(tx: Tx, alvo: DonoDaProposta, escrita: { nome: string; corpo: string; usoDeIa: string | null }): Promise<boolean> {
  const r = await tx.execute(sql`
    update liame.message_proposal
       set name = ${escrita.nome}, body = ${escrita.corpo}, usage_id = ${escrita.usoDeIa}, updated_at = now()
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'preparando'
    returning id`);
  return r.rows.length === 1;
}

/**
 * A conferência não deixou o texto passar: a proposta acaba aqui, e nada vai para o RegemCast. Ficam só os nomes do
 * que barrou (os itens e as regras); o texto barrado não é guardado.
 */
export async function barrarProposta(tx: Tx, alvo: DonoDaProposta, oQueBarrou: string[]): Promise<boolean> {
  const itens = [...new Set(oQueBarrou)];
  if (itens.length < 1 || itens.length > 20) throw new Error('proposta do CRM: a proposta barrada diz o que barrou (de 1 a 20 itens)');
  for (const i of itens) exigirCodigo(i, 'o item que barrou');
  const r = await tx.execute(sql`
    update liame.message_proposal
       set status = 'barrada', barred_by = ${`{${itens.join(',')}}`}::text[], name = null, body = null, next_attempt_at = null, finished_at = now(), updated_at = now()
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'preparando'
    returning id`);
  return r.rows.length === 1;
}

/**
 * O rascunho do modelo nasceu no RegemCast: a proposta passa a esperar uma pessoa enviar o modelo para a análise da
 * Meta, e a Meta aprovar. Só vale para a proposta que já tem o texto conferido guardado.
 */
export async function registrarRascunho(tx: Tx, alvo: DonoDaProposta, modelo: { id: string; nome: string; idioma: string; situacao: string }): Promise<boolean> {
  const r = await tx.execute(sql`
    update liame.message_proposal
       set status = 'rascunho', template_id = ${modelo.id}, template_name = ${modelo.nome}, template_language = ${modelo.idioma},
           template_status = ${modelo.situacao}, template_checked_at = now(), drafted_at = now(), next_attempt_at = null, updated_at = now()
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'preparando' and name is not null and body is not null
    returning id`);
  return r.rows.length === 1;
}

/** A rotina olhou o modelo no RegemCast: guarda a situação de agora e a hora, para olhar de novo só no próximo intervalo. */
export async function anotarModelo(tx: Tx, alvo: DonoDaProposta, situacao: string): Promise<boolean> {
  const r = await tx.execute(sql`
    update liame.message_proposal
       set template_status = ${situacao}, template_checked_at = now(), updated_at = now()
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'rascunho'
    returning id`);
  return r.rows.length === 1;
}

/** O modelo foi aprovado e o pedido de envio foi montado: a proposta acaba, e o que vale daqui em diante é o pedido. */
export async function virarPedido(tx: Tx, alvo: DonoDaProposta, pedidoDeMensagem: string): Promise<boolean> {
  const r = await tx.execute(sql`
    update liame.message_proposal
       set status = 'pedido', message_request_id = ${pedidoDeMensagem}, finished_at = now(), updated_at = now()
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'rascunho'
    returning id`);
  return r.rows.length === 1;
}

/**
 * A proposta não vai virar pedido (`descartada`: ele não escreve sobre aquilo, a Meta recusou o modelo, o prazo
 * acabou) ou não deu para seguir (`falhou`: a IA ou o RegemCast não responderam, depois das tentativas). O porquê é um
 * código. Só a que ainda está no caminho pode ser encerrada.
 */
export async function encerrarProposta(tx: Tx, alvo: DonoDaProposta, fim: 'descartada' | 'falhou', motivo: string): Promise<boolean> {
  exigirCodigo(motivo, 'o motivo');
  const r = await tx.execute(sql`
    update liame.message_proposal
       set status = ${fim}, reason = ${motivo}, next_attempt_at = null, finished_at = now(), updated_at = now()
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status in ('preparando', 'rascunho')
    returning id`);
  return r.rows.length === 1;
}

/** Não deu agora (a IA ou o RegemCast fora do ar): conta a tentativa e marca quando tentar de novo. */
export async function adiarProposta(tx: Tx, alvo: DonoDaProposta, ate: Date): Promise<boolean> {
  const r = await tx.execute(sql`
    update liame.message_proposal
       set attempts = attempts + 1, next_attempt_at = ${ate.toISOString()}::timestamptz, updated_at = now()
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId} and status = 'preparando'
    returning id`);
  return r.rows.length === 1;
}

export type PropostaGuardada = {
  id: string;
  brand_id: string;
  connected_account_id: string;
  motive: MotivoDaMensagem;
  destination: ComoPedir;
  offer: string | null;
  dossier_version: number | null;
  audience: PropostaDeMensagem['publico'];
  audience_name: string;
  audience_rule: string | null;
  people: number;
  coupon: CupomDaMensagem | null;
  status: SituacaoDaProposta;
  reason: string | null;
  barred_by: string[] | null;
  name: string | null;
  body: string | null;
  template_id: string | null;
  template_name: string | null;
  template_language: string | null;
  template_status: string | null;
  /** Quando o rascunho do modelo nasceu no RegemCast: a espera pela Meta conta daqui. */
  drafted_at: Date | string | null;
  message_request_id: string | null;
  attempts: number;
  agent_key: string;
  requested_by: string | null;
};

/** A proposta como está guardada, para a rotina retomar de onde parou. Nula se não é desta empresa. */
export async function lerProposta(tx: Tx, alvo: DonoDaProposta): Promise<PropostaGuardada | null> {
  const r = await tx.execute<PropostaGuardada>(sql`
    select id, brand_id, connected_account_id, motive, destination, offer, dossier_version, audience, audience_name, audience_rule, people, coupon,
           status, reason, barred_by, name, body, template_id, template_name, template_language, template_status, drafted_at, message_request_id, attempts,
           agent_key, requested_by
      from liame.message_proposal
     where id = ${alvo.id} and tenant_id = ${alvo.tenantId}`);
  return r.rows[0] ?? null;
}
