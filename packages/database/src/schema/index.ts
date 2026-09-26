import * as identity from './identity.js';

export * from './identity.js';

/** Todas as tabelas espelhadas, para o teste que compara o schema TypeScript com o banco. */
export const allTables = [
  identity.organization,
  identity.appUser,
  identity.membership,
  identity.brand,
  identity.unit,
  identity.session,
  identity.userToken,
  identity.rateLimit,
];
