import { type Database, withContext } from '@liame/database';
import { Logger } from '@nestjs/common';
import { requestStore } from '../context/request-context.js';

const logger = new Logger('na-empresa');

/**
 * Roda uma leitura dos serviços de domínio fora de uma rota, do mesmo jeito que a rota roda: numa
 * transação com a empresa e a pessoa no contexto da RLS, com a "unidade de trabalho" que os serviços
 * esperam (`currentTx()`). É curta de propósito: a chamada ao modelo acontece DEPOIS dela, sem
 * transação aberta. O que o serviço agendou para depois do commit (`afterCommit`: um e-mail, um aviso)
 * roda depois que a transação grava, como na rota; se ela desfizer, não roda. A falha de um efeito só é
 * registrada (LIC-001).
 */
export async function naTransacaoDaEmpresa<T>(database: Database, quem: { tenantId: string; userId: string | null }, fn: () => Promise<T>): Promise<T> {
  const efeitos: Array<() => Promise<void>> = [];
  const valor = await withContext(database.db, { tenantId: quem.tenantId, userId: quem.userId }, (tx) => requestStore.run({ tx, afterCommit: efeitos }, fn));
  for (const efeito of efeitos) {
    try {
      await efeito();
    } catch (err) {
      logger.error(`efeito depois do commit falhou: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return valor;
}
