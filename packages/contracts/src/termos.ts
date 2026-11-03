import { z } from 'zod';

// Os Termos novos (A7, W14; P35, aprovado em 02/11/2026; D-A7-88 a D-A7-95): a distribuição declara a versão nova dos
// documentos, com o dia em que vale e o que muda; cada pessoa aceita a versão relevante com um clique. Com a função
// `termos_novos` desligada, nada disto aparece: a versão vigente é a do ambiente.

/** Os documentos que uma versão muda. */
export const TermsDocument = z.enum(['termos', 'privacidade', 'operador']);
export type TermsDocument = z.infer<typeof TermsDocument>;

/** Uma mudança, em linguagem simples (uma ou duas frases para cada lado; D-A7-91). */
export const TermsChange = z.strictObject({
  document: TermsDocument,
  /** A seção ("4", "10 e 11"). */
  section: z.string(),
  title: z.string(),
  /** Como é hoje. */
  today: z.string(),
  /** Como fica. */
  becomes: z.string(),
});
export type TermsChange = z.infer<typeof TermsChange>;

/** Uma versão: `relevante` pede o aceite e tem 30 dias de aviso; `redacao` vale na hora, sem aceite (D-A7-89). */
export const TermsVersionInfo = z.strictObject({
  version: z.string(),
  kind: z.enum(['relevante', 'redacao']),
  /** Quando a versão foi avisada. */
  notice_at: z.string(),
  /** O dia em que vale (AAAA-MM-DD, no fuso de Brasília). */
  effective_on: z.string(),
  documents: z.array(z.strictObject({ document: TermsDocument, url: z.url() })),
  changes: z.array(TermsChange),
  /** O motivo do ajuste de redação; nulo na relevante. */
  reason: z.string().nullable(),
  /** A versão foi retirada antes do dia (nada muda, e o aceite dado fica sem efeito). */
  withdrawn: z.boolean(),
});
export type TermsVersionInfo = z.infer<typeof TermsVersionInfo>;

/** Onde a pessoa aceitou (D-A7-92). */
export const TermsAcceptanceVia = z.enum(['aviso', 'tela_do_dia', 'cadastro', 'convite']);
export type TermsAcceptanceVia = z.infer<typeof TermsAcceptanceVia>;

/** Os Termos para a própria pessoa: o que vale, o que ela aceitou, o que vem e o que falta no dia (D-A7-95). */
export const MyTermsResponse = z.strictObject({
  /** A função `termos_novos` está ligada para a pessoa; desligada, só `current` e `base_version` valem. */
  enabled: z.boolean(),
  /** A versão que vale hoje e os endereços dos textos. */
  current: z.strictObject({ version: z.string(), terms_url: z.url(), privacy_url: z.url() }),
  /** A versão do ambiente, a de antes de qualquer versão declarada (a do cadastro de quem entrou antes). */
  base_version: z.string(),
  /** O último aceite da pessoa a uma versão declarada; nulo se ela só aceitou a do cadastro. */
  accepted: z.strictObject({ version: z.string(), accepted_at: z.string(), via: TermsAcceptanceVia }).nullable(),
  /** A versão relevante que vem (avisada, ainda não vale), com o aceite da pessoa, se já aceitou. */
  next: TermsVersionInfo.nullable(),
  next_accepted_at: z.string().nullable(),
  /** No dia: a versão relevante que vale e a pessoa ainda não aceitou. */
  required: TermsVersionInfo.nullable(),
  /** As versões declaradas, da mais nova para a mais antiga. */
  history: z.array(TermsVersionInfo),
});
export type MyTermsResponse = z.infer<typeof MyTermsResponse>;

/** Aceitar a versão que vem (antes do dia) ou a que vale (no dia). Sem o código do app (D-A7-92). */
export const AcceptTermsRequest = z.strictObject({
  version: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]{1,10})?$/, { error: 'Versão inválida' }),
});
export type AcceptTermsRequest = z.infer<typeof AcceptTermsRequest>;
