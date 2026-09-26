import { randomBytes } from 'node:crypto';

/**
 * UUID v7 (RFC 9562): 48 bits de milissegundos + aleatório. Ordenável pelo tempo, bom para índice
 * (data-model §1). Gerado na aplicação porque o Postgres 17 da nuvem não tem `uuidv7()`.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(now, 0, 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70; // versão 7
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variante RFC
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
