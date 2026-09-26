import { z } from 'zod';

// Empresa (tenant) e marcas.

export const OrganizationResponse = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  cnpj: z.string().nullable(),
  timezone: z.string(),
  status: z.enum(['ativa', 'suspensa', 'encerrada']),
});
export type OrganizationResponse = z.infer<typeof OrganizationResponse>;

export const BrandResponse = z.strictObject({ id: z.uuid(), name: z.string() });
export type BrandResponse = z.infer<typeof BrandResponse>;

export const BrandListResponse = z.strictObject({ items: z.array(BrandResponse) });
export type BrandListResponse = z.infer<typeof BrandListResponse>;

export const CreateBrandRequest = z.strictObject({ name: z.string().trim().min(1).max(200) });
export type CreateBrandRequest = z.infer<typeof CreateBrandRequest>;
