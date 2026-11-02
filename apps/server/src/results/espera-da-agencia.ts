import { type SQL, sql } from 'drizzle-orm';

// A espera do e-mail do Liame pela agência (A7, W7, parte 4a; D-A7-68): com uma agência cuidando da empresa, o e-mail do
// relatório do mês do próprio Liame espera até ela mandar ou até o dia 3 do mês seguinte, às 9h, no fuso da loja. Quem
// recebeu o da agência não recebe o do Liame daquele mês. A mesma regra no worker (o envio do Liame) e na tela da agência
// (até quando ele espera).

export const DIA_DA_ESPERA = 3;
export const HORA_DA_ESPERA = 9;
/** Enquanto espera, o worker olha de novo a cada hora (a agência pode mandar a qualquer momento). */
export const OLHAR_DE_NOVO = '1 hour';

/** O instante em que a espera acaba: o dia 3 do mês seguinte ao do relatório (`month_to` + 3), às 9h, no fuso da loja. */
export function fimDaEspera(mesTo: SQL, fuso: SQL): SQL {
  return sql`((((${mesTo})::date + ${DIA_DA_ESPERA}::int) + make_interval(hours => ${HORA_DA_ESPERA}::int)) at time zone ${fuso})`;
}
