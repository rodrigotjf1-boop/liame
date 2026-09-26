// Testes de banco rodam só com as duas conexões: a da aplicação (sem BYPASSRLS, não é dona das
// tabelas) e a do dono (cria fixtures e concede GRANTs). Sem elas, a suíte é pulada.
export const APP_URL = process.env.TEST_DATABASE_URL ?? '';
export const OWNER_URL = process.env.TEST_DATABASE_URL_OWNER ?? '';
export const hasDb = Boolean(APP_URL && OWNER_URL);

export const appRole = (): string => decodeURIComponent(new URL(APP_URL).username);
export const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;
