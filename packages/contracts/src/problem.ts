import { z } from 'zod';

/**
 * Erro no formato RFC 9457 (`application/problem+json`), o único da API (arquitetura §14).
 * `code` é estável (vira a URL do `type`); `trace_id` vai em toda resposta, para o suporte.
 */
export const ProblemDetails = z.object({
  type: z.url(),
  title: z.string(),
  status: z.int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string(),
  trace_id: z.string(),
  errors: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional()
    .describe('Campos inválidos, quando o erro é de validação'),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;

export const PROBLEM_TYPE_BASE = 'https://agencialiame.com/erros/';
