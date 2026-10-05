import type { AdPieceDecision, AdPieceRequestResponse, AdPieceResponse, AdPieceReview, AdPieceVersion } from '@liame/contracts';
import { type ConferenciaDaPeca, type Peca, TAMANHO_RECOMENDADO } from '../ai/criativo/peca.js';
import { canonicalJson, sha256 } from '../audit/audit.js';
import { REGRAS_DE_ANUNCIO_VERSAO } from '../policy/anuncio.js';
import { REGRAS_DE_TEXTO_VERSAO } from '../policy/texto.js';

// Como o pedido de peças e a peça aparecem na API (A4, X6), e o que é gravado de cada versão: a conferência no formato
// do contrato, o hash do que a pessoa vê e a versão das regras que conferiram. Funções puras: a rota e o worker usam as
// mesmas.

/** A conferência no formato do contrato (é o que fica gravado com a versão). */
export function revisaoDaConferencia(c: ConferenciaDaPeca): AdPieceReview {
  return {
    status: c.situacao,
    items: c.itens.map((i) => ({ item: i.item, status: i.situacao, findings: i.achados.map((a) => ({ kind: a.tipo, field: a.campo, excerpt: a.trecho })) })),
    cites_value: c.cita_valor,
    characters: { title: c.caracteres.titulo, body: c.caracteres.texto },
    recommended: { title: TAMANHO_RECOMENDADO.titulo, body: TAMANHO_RECOMENDADO.texto },
  };
}

/** O hash do que a pessoa vê e decide: o título, o texto e o botão, em JSON canônico. */
export const hashDaPeca = (p: Peca): string => sha256(canonicalJson({ title: p.titulo, body: p.texto, button: p.botao }));

/** As versões das regras que fizeram a conferência: regra que muda não reescreve a conferência antiga. */
export const regrasDaConferencia = (): { texto: number; anuncio: number } => ({ texto: REGRAS_DE_TEXTO_VERSAO, anuncio: REGRAS_DE_ANUNCIO_VERSAO });

const iso = (v: Date | string) => new Date(v).toISOString();
const pessoa = (id: string | null, nome: string | null) => (id ? { id, name: nome ?? 'Pessoa removida' } : null);

export type LinhaDoPedido = {
  id: string;
  brand_id: string;
  kind: string;
  offer: string;
  dossier_version: number;
  destination: string;
  variations: number;
  instruction: string | null;
  reference_ad_id: string | null;
  reference_name: string | null;
  piece_id: string | null;
  status: string;
  reason: string | null;
  pieces: number;
  requested_by: string | null;
  requester: string | null;
  created_at: Date | string;
  finished_at: Date | string | null;
};

export function respostaDoPedido(l: LinhaDoPedido): AdPieceRequestResponse {
  return {
    id: l.id,
    brand_id: l.brand_id,
    kind: l.kind,
    offer: l.offer,
    dossier_version: l.dossier_version,
    destination: l.destination,
    variations: l.variations,
    instruction: l.instruction,
    reference: l.reference_name ? { ad_id: l.reference_ad_id, name: l.reference_name } : null,
    piece_id: l.piece_id,
    status: l.status,
    reason: l.reason,
    pieces: l.pieces,
    requested_by: pessoa(l.requested_by, l.requester),
    created_at: iso(l.created_at),
    finished_at: l.finished_at ? iso(l.finished_at) : null,
  };
}

export type LinhaDaVersao = {
  version: number;
  title: string;
  body: string;
  button: string;
  review: AdPieceReview;
  content_hash: string;
  author: string;
  created_by: string | null;
  creator: string | null;
  created_at: Date | string;
};

export function versaoDaLinha(l: LinhaDaVersao): AdPieceVersion {
  return {
    version: l.version,
    title: l.title,
    body: l.body,
    button: l.button,
    review: l.review,
    content_hash: l.content_hash,
    author: l.author,
    created_by: pessoa(l.created_by, l.creator),
    created_at: iso(l.created_at),
  };
}

export type LinhaDaPeca = {
  id: string;
  brand_id: string;
  request_id: string;
  status: string;
  offer: string;
  destination: string;
  ai_generated: boolean;
  redoing: boolean;
  decided_by: string | null;
  decider: string | null;
  decided_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

export type LinhaDaDecisao = {
  decision: string;
  version: number;
  reason: string | null;
  comment: string | null;
  decided_by: string | null;
  decider: string | null;
  created_at: Date | string;
};

export function decisaoDaLinha(l: LinhaDaDecisao): AdPieceDecision {
  return { decision: l.decision, version: l.version, reason: l.reason, comment: l.comment, decided_by: pessoa(l.decided_by, l.decider), created_at: iso(l.created_at) };
}

/** A peça com a versão atual; com o histórico (as versões e as decisões), é o detalhe. */
export function respostaDaPeca(l: LinhaDaPeca, atual: LinhaDaVersao, historico?: { versoes: LinhaDaVersao[]; decisoes: LinhaDaDecisao[] }): AdPieceResponse {
  return {
    id: l.id,
    brand_id: l.brand_id,
    request_id: l.request_id,
    status: l.status,
    offer: l.offer,
    destination: l.destination,
    ai_generated: l.ai_generated,
    redoing: l.redoing,
    current: versaoDaLinha(atual),
    ...(historico ? { versions: historico.versoes.map(versaoDaLinha), decisions: historico.decisoes.map(decisaoDaLinha) } : {}),
    decided_by: pessoa(l.decided_by, l.decider),
    decided_at: l.decided_at ? iso(l.decided_at) : null,
    created_at: iso(l.created_at),
    updated_at: iso(l.updated_at),
  };
}
