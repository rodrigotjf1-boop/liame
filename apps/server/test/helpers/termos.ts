import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { ownerQuery, type TestApi } from './api.js';

// Os Termos novos nos testes (A7, W14). As versões declaradas valem para todo o banco de teste, e no CI os arquivos
// rodam juntos: por isso cada teste liga a função só para as próprias pessoas (escopo `user`), a não ser quando precisa da
// rota pública ou do cadastro (o ambiente), e então só com uma versão que AINDA NÃO VALE (a vigente dos outros arquivos
// continua a do ambiente). Cada teste apaga as versões que criou.

/** A função `termos_novos` num escopo; `null` tira a regra. O cache das funções é esquecido na hora. */
export async function flagDosTermos(api: TestApi, escopo: { tipo: 'environment' } | { tipo: 'user'; id: string }, valor: boolean | null): Promise<void> {
  const id = escopo.tipo === 'environment' ? api.app.get<AppConfig>(APP_CONFIG).env : escopo.id;
  await ownerQuery(`delete from liame.feature_flag_rule where flag_key = 'termos_novos' and scope_type = $1 and scope_id = $2`, [escopo.tipo, id]);
  if (valor !== null) {
    await ownerQuery(
      `insert into liame.feature_flag_rule (id, flag_key, scope_type, scope_id, value, created_by) values (gen_random_uuid(), 'termos_novos', $1, $2, $3::jsonb, 'testes')`,
      [escopo.tipo, id, JSON.stringify(valor)],
    );
  }
  api.app.get(FlagService).invalidate();
}

const MUDANCA = { document: 'termos', section: '4', title: 'Agências parceiras', today: 'Só as pessoas da empresa usam o Liame.', becomes: 'Uma agência aceita pelo Dono age em nome da empresa.' };

/**
 * Uma versão de teste, gravada direto no banco: `daqui` é quantos dias até valer (negativo = já vale). O aviso fica 40 dias
 * antes do dia, para passar na regra dos 30 dias. Devolve o nome da versão (único por chamada).
 */
export async function versaoDeTeste(daqui: number, o: { kind?: 'relevante' | 'redacao' } = {}): Promise<string> {
  const kind = o.kind ?? 'relevante';
  const dia = new Date(Date.now() + daqui * 86_400_000).toISOString().slice(0, 10);
  const versao = `${dia}-t${Math.random().toString(36).slice(2, 9)}`;
  await ownerQuery(
    `insert into liame.terms_version (version, kind, notice_at, effective_at, documents, changes, reason, created_by)
     values ($1, $2, now() + make_interval(days => $3::int - 40), now() + make_interval(days => $3::int), $4::jsonb, $5::jsonb, $6, 'testes')`,
    [
      versao,
      kind,
      daqui,
      JSON.stringify([{ document: 'termos', url: `https://agencialiame.com/termos/${versao}`, sha256: 'a'.repeat(64) }]),
      JSON.stringify(kind === 'relevante' ? [MUDANCA] : []),
      kind === 'redacao' ? 'Ajuste de redação de teste.' : null,
    ],
  );
  return versao;
}

/** Apaga as versões de teste e os aceites delas. */
export async function apagarVersoes(versoes: readonly string[]): Promise<void> {
  if (!versoes.length) return;
  await ownerQuery(`delete from liame.terms_acceptance where version = any($1::text[])`, [versoes]);
  await ownerQuery(`delete from liame.terms_version where version = any($1::text[])`, [versoes]);
}
