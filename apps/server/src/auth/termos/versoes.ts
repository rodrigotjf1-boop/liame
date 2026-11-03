import type { TermsChange, TermsDocument, TermsVersionInfo } from '@liame/contracts';

// As regras dos Termos novos (A7, W14, parte 14a; D-A7-88 a D-A7-95, D-A7-97 a D-A7-100), em funções puras: qual
// versão vale, qual vem e qual pede o aceite, a partir das versões declaradas pela distribuição.

/** Uma versão como está no banco (`liame.terms_version`). */
export type LinhaDaVersao = {
  version: string;
  kind: 'relevante' | 'redacao';
  notice_at: Date | string;
  effective_at: Date | string;
  documents: { document: TermsDocument; url: string; sha256: string }[];
  changes: TermsChange[];
  reason: string | null;
  withdrawn_at: Date | string | null;
};

const FUSO = 'America/Sao_Paulo';
const instante = (d: Date | string): number => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/** O dia (AAAA-MM-DD) de um instante no fuso de Brasília. */
export function diaEmBrasilia(d: Date | string): string {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(
    d instanceof Date ? d : new Date(d),
  );
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  return `${v('year')}-${v('month')}-${v('day')}`;
}

/** O que vale agora: a vigente (qualquer tipo), a relevante em vigor e a relevante que vem (D-A7-99). */
export function escolher(
  linhas: readonly LinhaDaVersao[],
  agora: Date,
): { vigente: LinhaDaVersao | null; relevanteVigente: LinhaDaVersao | null; aVir: LinhaDaVersao | null } {
  const vivas = linhas.filter((l) => l.withdrawn_at === null);
  const t = agora.getTime();
  const valendo = vivas.filter((l) => instante(l.effective_at) <= t).sort((a, b) => instante(b.effective_at) - instante(a.effective_at));
  const futuras = vivas
    .filter((l) => l.kind === 'relevante' && instante(l.effective_at) > t)
    .sort((a, b) => instante(a.effective_at) - instante(b.effective_at));
  return {
    vigente: valendo[0] ?? null,
    relevanteVigente: valendo.find((l) => l.kind === 'relevante') ?? null,
    aVir: futuras[0] ?? null,
  };
}

/**
 * Os endereços que valem de cada documento: o da versão mais nova em vigor que muda aquele documento (um ajuste de
 * redação pode mudar só a Política); sem nenhuma, o do ambiente.
 */
export function enderecosVigentes(
  linhas: readonly LinhaDaVersao[],
  agora: Date,
  base: { termos: string; privacidade: string },
): { termos: string; privacidade: string } {
  const valendo = linhas
    .filter((l) => l.withdrawn_at === null && instante(l.effective_at) <= agora.getTime())
    .sort((a, b) => instante(b.effective_at) - instante(a.effective_at));
  const url = (doc: TermsDocument) => valendo.flatMap((l) => l.documents).find((d) => d.document === doc)?.url;
  return { termos: url('termos') ?? base.termos, privacidade: url('privacidade') ?? base.privacidade };
}

/** Uma versão no formato do contrato. */
export function paraContrato(l: LinhaDaVersao): TermsVersionInfo {
  return {
    version: l.version,
    kind: l.kind,
    notice_at: new Date(instante(l.notice_at)).toISOString(),
    effective_on: diaEmBrasilia(l.effective_at),
    documents: l.documents.map((d) => ({ document: d.document, url: d.url })),
    changes: l.changes,
    reason: l.reason,
    withdrawn: l.withdrawn_at !== null,
  };
}
