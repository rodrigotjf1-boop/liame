import { z } from 'zod';

// Empresa (tenant) e marcas.

export const OrganizationResponse = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  cnpj: z.string().nullable(),
  timezone: z.string(),
  status: z.enum(['ativa', 'suspensa', 'encerrada']),
  /** Em encerramento: quando começou e quando os dados serão expurgados (ADR-014). */
  suspended_at: z.string().nullable(),
  purge_after: z.string().nullable(),
});
export type OrganizationResponse = z.infer<typeof OrganizationResponse>;

export const BrandResponse = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  /** Arquivada: só leitura e fora das telas; expurgo em 12 meses (ADR-014). */
  archived_at: z.string().nullable(),
  purge_after: z.string().nullable(),
});
export type BrandResponse = z.infer<typeof BrandResponse>;

export const BrandListResponse = z.strictObject({ items: z.array(BrandResponse) });
export type BrandListResponse = z.infer<typeof BrandListResponse>;

export const CreateBrandRequest = z.strictObject({ name: z.string().trim().min(1).max(200) });
export type CreateBrandRequest = z.infer<typeof CreateBrandRequest>;

export const BrandListQuery = z.strictObject({ include_archived: z.enum(['true', 'false']).default('false') });
export type BrandListQuery = z.infer<typeof BrandListQuery>;

/** Encerrar a conta: só o dono, com o código do app e o nome da empresa digitado (ADR-014, ADR-017). */
export const CloseOrganizationRequest = z.strictObject({
  confirm_name: z.string().trim().min(1).max(200),
  code: z.string().regex(/^\d{6}$/, { error: 'Digite os 6 números do app' }),
});
export type CloseOrganizationRequest = z.infer<typeof CloseOrganizationRequest>;

/** Exportação dos dados da empresa (JSON), durante o uso ou nos 30 dias de graça. */
export const ExportResponse = z.object({
  format: z.literal('liame-export'),
  version: z.literal(1),
  generated_at: z.string(),
  organization: z.record(z.string(), z.unknown()),
  data: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
});
export type ExportResponse = z.infer<typeof ExportResponse>;
