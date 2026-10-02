import { SetMetadata } from '@nestjs/common';

// Rota que NÃO roda na transação da requisição (A3, I4). A unidade de trabalho abre uma transação para
// toda rota autenticada, e ela é curta de propósito: chamada a serviço externo não acontece dentro dela.
// A rota que espera um modelo de IA (segundos) declara isto: ela mesma abre transações curtas, antes e
// depois da espera (`naTransacaoDaEmpresa`), e o AI Gateway grava o uso na dele. Sem `currentTx()`, sem
// chave de idempotência e sem auditoria automática: a rota declara `@SemAuditoria` (ou audita à mão).
export const SEM_TRANSACAO_KEY = 'liame:sem-transacao';

export interface SemTransacaoDeclaration {
  motivo: string;
}

export const SemTransacao = (motivo: string) => SetMetadata(SEM_TRANSACAO_KEY, { motivo } satisfies SemTransacaoDeclaration);
