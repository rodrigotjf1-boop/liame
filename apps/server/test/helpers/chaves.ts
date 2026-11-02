import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { ownerQuery, type TestApi } from './api.js';

/**
 * A flag das chaves de acesso (`chaves_de_acesso`; A7, W9, parte 9d) num escopo: o ambiente inteiro (a entrada sem
 * senha), uma empresa ou uma pessoa. `null` tira a regra (vale o de cima, ou o padrão: desligada). O cache das flags é
 * esquecido na hora.
 */
export async function flagDasChaves(api: TestApi, escopo: { tipo: 'environment' } | { tipo: 'tenant' | 'user'; id: string }, valor: boolean | null): Promise<void> {
  const id = escopo.tipo === 'environment' ? api.app.get<AppConfig>(APP_CONFIG).env : escopo.id;
  await ownerQuery(`delete from liame.feature_flag_rule where flag_key = 'chaves_de_acesso' and scope_type = $1 and scope_id = $2`, [escopo.tipo, id]);
  if (valor !== null) {
    await ownerQuery(
      `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'chaves_de_acesso', $1, $2, $3::jsonb, 'testes')`,
      [escopo.tipo, id, JSON.stringify(valor)],
    );
  }
  api.app.get(FlagService).invalidate();
}
