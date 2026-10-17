import { type SQL, sql } from 'drizzle-orm';

// "Ligada" e "conectada": os dois estados de uma conta de plataforma (achado A2 do Hub DMS, decisão F2-5).
//
// - Ligada: a conta está na lista da marca (`disconnected_at` vazio). É o que as telas, os avisos e o histórico usam
//   para MOSTRAR a conta, inclusive o aviso "está desconectada".
// - Conectada: ligada e sem o status `desconectada`, que o sincronizador grava quando a plataforma recusa a credencial
//   (o 401). É o que vale para AGIR: ler da plataforma, criar cupom, montar link com o cardápio da loja, mandar
//   mensagem, dizer à tela que a conta pode ser usada.
//
// O 401 não grava `disconnected_at` de propósito: a reconexão (`on conflict ... where disconnected_at is null`) acha a
// mesma linha e o histórico segue nela, e os avisos de Atenção e Resultados continuam vendo a conta para mostrar que
// ela caiu. Por isso os dois conceitos, e um critério só para cada um, aqui.
//
// Ler da plataforma pede, além disso, a credencial guardada: os laços de leitura conferem `credential_secret_id`, e
// quem lê o cofre trata o segredo que falta (ou revogado) como "sem autorização".

/** O status que o sincronizador grava quando a plataforma recusa a credencial. */
export const STATUS_DESCONECTADA = 'desconectada';

const APELIDO = /^[a-z_][a-z0-9_]*$/;

/** A conta (pelo apelido da tabela `liame.connected_account` na consulta) está conectada: pode agir. */
export function contaConectada(apelido: string): SQL {
  if (!APELIDO.test(apelido)) throw new Error(`apelido de tabela inválido: ${apelido}`);
  return sql.raw(`(${apelido}.disconnected_at is null and ${apelido}.status <> '${STATUS_DESCONECTADA}')`);
}

/** A mesma regra em código, para a conta já lida do banco. */
export function estaConectada(conta: { disconnected_at: Date | string | null; status: string }): boolean {
  return conta.disconnected_at === null && conta.status !== STATUS_DESCONECTADA;
}
