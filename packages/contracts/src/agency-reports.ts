import { z } from 'zod';
import { MonthlyReport } from './reports.js';

// O relatório do mês que a agência manda ao cliente (A7, W7, parte 4a; P29 aprovado; D-A7-65 a D-A7-68; D-A7-82): a
// lista do mês, um relatório com o que a agência põe por cima (o comentário) e quem pode receber, e o envio.

const Mes = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { error: 'O mês é AAAA-MM' });

/** O mês da lista (`AAAA-MM`); sem ele, o último mês fechado. */
export const AgencyReportsQuery = z.strictObject({ month: Mes.optional() });
export type AgencyReportsQuery = z.infer<typeof AgencyReportsQuery>;

/** Um envio da agência, como a lista e a revisão o mostram. */
export const AgencyReportSendSummary = z.strictObject({
  version: z.int().min(1),
  /** `manual` (quem mandou assina) ou `sozinho` (saiu no dia 2, sem comentário). */
  mode: z.enum(['manual', 'sozinho']),
  sent_at: z.string(),
  sent_by_name: z.string().nullable(),
  has_comment: z.boolean(),
  /** Para quantas pessoas o e-mail saiu. */
  recipients: z.int().min(0),
});
export type AgencyReportSendSummary = z.infer<typeof AgencyReportSendSummary>;

/**
 * Um relatório do mês de uma marca de cliente, na lista da agência. `state` é texto aberto (ERR-015): `esperando` (pronto,
 * a agência ainda não mandou), `mandado`, `suspensa` (a conta do cliente está suspensa: o relatório fica só com o Dono),
 * `sem_relatorio` (o do mês ainda não saiu), `sem_acesso` (o nível da pessoa no cliente não vê os resultados) e
 * `fora_do_time` (quem pede não está no time deste cliente).
 */
export const AgencyReportItem = z.strictObject({
  link_id: z.uuid(),
  organization: z.strictObject({ id: z.uuid(), name: z.string() }),
  brand: z.strictObject({ id: z.uuid(), name: z.string() }).nullable(),
  report_id: z.uuid().nullable(),
  generated_at: z.string().nullable(),
  state: z.string(),
  /** Com a conta suspensa: desde quando e o nome do Dono (com quem falar). */
  suspended_since: z.string().nullable(),
  owner_name: z.string().nullable(),
  /** O último envio da agência deste relatório. */
  last_send: AgencyReportSendSummary.nullable(),
  /** Até quando o e-mail do próprio Liame do mês espera a agência (o dia 3, às 9h, no fuso da loja; D-A7-68). */
  liame_email_waits_until: z.string().nullable(),
});
export type AgencyReportItem = z.infer<typeof AgencyReportItem>;

export const AgencyReportsResponse = z.strictObject({
  month: Mes,
  items: z.array(AgencyReportItem),
});
export type AgencyReportsResponse = z.infer<typeof AgencyReportsResponse>;

/** Quem da empresa pode receber o relatório (D-A7-66): o Dono sempre; os Administradores e "Só relatórios por e-mail". */
export const AgencyReportRecipient = z.strictObject({
  user_id: z.uuid(),
  name: z.string(),
  email: z.string(),
  role: z.enum(['dono', 'administrador', 'so_relatorios']),
  /** O Dono sempre recebe. */
  always: z.boolean(),
});
export type AgencyReportRecipient = z.infer<typeof AgencyReportRecipient>;

/** Um envio, com o comentário e para quem foi (os nomes e os níveis). */
export const AgencyReportSend = AgencyReportSendSummary.extend({
  comment: z.string().nullable(),
  sent_to: z.array(z.strictObject({ name: z.string(), role: z.string() })),
});
export type AgencyReportSend = z.infer<typeof AgencyReportSend>;

/**
 * Um relatório para a agência revisar e mandar: o relatório do mês (o mesmo que o Dono vê, só o que o nível da pessoa
 * no cliente deixa ver), a marca da agência que vai no alto, quem pode receber e os envios anteriores.
 */
export const AgencyReportDetailResponse = z.strictObject({
  item: AgencyReportItem,
  report: MonthlyReport,
  agency: z.strictObject({
    name: z.string(),
    /** O endereço público do logo (o mesmo do e-mail); nulo sem logo. */
    logo_url: z.string().nullable(),
    /** O e-mail de resposta confirmado; nulo = a resposta volta para o Liame. */
    reply_to: z.string().nullable(),
  }),
  recipients: z.array(AgencyReportRecipient),
  sends: z.array(AgencyReportSend),
  /** Quem pede pode mandar (está no time, vê os resultados e a conta não está suspensa). */
  can_send: z.boolean(),
});
export type AgencyReportDetailResponse = z.infer<typeof AgencyReportDetailResponse>;

/** Mandar o relatório: o comentário (opcional, até 1.000 caracteres) e quem recebe além do Dono. */
export const SendAgencyReportRequest = z.strictObject({
  comment: z
    .string()
    .trim()
    .max(1000, { error: 'Até 1.000 caracteres' })
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  recipient_ids: z
    .array(z.uuid())
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, { error: 'Cada pessoa aparece uma vez só' }),
});
export type SendAgencyReportRequest = z.infer<typeof SendAgencyReportRequest>;

/** O envio feito: a versão, quando e para quantas pessoas o e-mail saiu. */
export const AgencyReportSentResponse = z.strictObject({
  version: z.int().min(1),
  sent_at: z.string(),
  recipients: z.int().min(0),
  /** Quantos e-mails não saíram (o servidor tenta de novo depois). */
  failed: z.int().min(0),
});
export type AgencyReportSentResponse = z.infer<typeof AgencyReportSentResponse>;
