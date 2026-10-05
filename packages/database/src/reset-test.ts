import pg from 'pg';

// Zera o banco de TESTE local: apaga os schemas `liame` e `liame_migrations` para as migrations recriarem tudo do zero,
// como no CI. Os testes não apagam o que criam (cada arquivo cria as próprias empresas), então o banco de teste local
// cresce a cada rodada da suíte; com centenas de megabytes a suíte fica lenta, e o teste que varre todas as colunas de
// texto estoura o prazo (`docs/testes.md`, "Banco de teste local"). Só vale em host local e em banco cujo nome termina
// em `_test`: o banco de desenvolvimento, o da nuvem e o schema `public` nunca são tocados.

const HOSTS_LOCAIS = ['localhost', '127.0.0.1', '::1', '[::1]'];
/** Os schemas que as migrations criam: o do produto e o de controle do executor. */
const SCHEMAS = ['liame', 'liame_migrations'] as const;

export class ResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResetError';
  }
}

/** Por que o banco desta URL não pode ser zerado; nulo quando pode (host local e nome terminado em `_test`). */
export function motivoParaNaoZerar(connectionString: string): string | null {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return 'a URL do banco não é válida';
  }
  if (!HOSTS_LOCAIS.includes(url.hostname)) return `o host ${url.hostname} não é local: este comando só zera banco de teste local`;
  const banco = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z_][a-z0-9_]*_test$/.test(banco)) return `o banco "${banco}" não termina em _test: este comando só zera banco de teste`;
  return null;
}

/**
 * Apaga os schemas do Liame no banco de teste local. Recusa a URL que não é de teste local e o banco com outra conexão
 * aberta (uma suíte rodando). Devolve o tamanho do banco antes e depois. Depois dele, rode as migrations.
 */
export async function resetTestDatabase(connectionString: string): Promise<{ database: string; before: string; after: string }> {
  const motivo = motivoParaNaoZerar(connectionString);
  if (motivo) throw new ResetError(motivo);
  const esperado = decodeURIComponent(new URL(connectionString).pathname.slice(1));
  const client = new pg.Client({ connectionString, application_name: 'liame-reset-test' });
  await client.connect();
  try {
    const database = (await client.query<{ banco: string }>('select current_database() as banco')).rows[0]!.banco;
    if (database !== esperado) throw new ResetError(`conectado em "${database}", e não em "${esperado}"`);
    const outras = (await client.query<{ n: number }>('select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()')).rows[0]!.n;
    if (outras > 0) throw new ResetError(`há ${outras} conexão(ões) aberta(s) em ${database}: espere a suíte terminar`);
    const tamanho = async () => (await client.query<{ t: string }>('select pg_size_pretty(pg_database_size(current_database())) as t')).rows[0]!.t;
    const before = await tamanho();
    for (const schema of SCHEMAS) await client.query(`drop schema if exists ${schema} cascade`);
    return { database, before, after: await tamanho() };
  } finally {
    await client.end();
  }
}
