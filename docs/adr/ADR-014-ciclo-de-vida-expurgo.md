# ADR-014 — Ciclo de vida dos dados: ativo, arquivado e expurgado

- **Status:** Aceito · 26/09/2026 (proposto em 25/09/2026; aprovado com o plano completo pelo dono)
- **Base:** `data-model.md` §9 · base de conhecimento §6 (LGPD) e §17.2 · ADR-011 (chaves)

## Contexto

Pergunta do dono (25/09/2026): "dados arquivados vão ser deletados?".

O plano tinha retenção por classe e "exportar e excluir em até 30 dias" no cancelamento. Não dizia o que é arquivar, quando o arquivado vira apagado, nem o que acontece com os backups.

## Decisão

### Três estados

| Estado | O que é | Quem vê |
| --- | --- | --- |
| **Ativo** | uso normal | quem tem permissão |
| **Arquivado** | somente leitura, fora das telas e das buscas, reativável | Dono e Gestor, em "Arquivados" |
| **Expurgado** | apagado de verdade ou anonimizado, sem volta | ninguém |

**Sim: arquivado vira expurgado**, no prazo da classe do dado.

- Colunas `archived_at`, `purge_after` e `purge_reason` nas tabelas de negócio.
- Job diário de expurgo (pg-boss) apaga em lotes e grava na auditoria o que apagou (classe, tenant e contagem, sem conteúdo).
- O Dono recebe um relatório mensal do que foi expurgado.

### Prazos iniciais (revisar com o jurídico)

- **Campanha, criativo e job arquivados:** expurgo em 12 meses. Métricas agregadas sem dado pessoal ficam.
- **Contato e mensagem:** enquanto houver finalidade e consentimento. Opt-out ou pedido do titular → anonimizar ou apagar em até 15 dias.
- **Payload bruto de connector:** 90 dias. **Logs:** 30 dias. **Prompts com conteúdo:** 30 dias (`data-model.md` §9).
- **Registros de acesso à aplicação:** 6 meses (Marco Civil, art. 15).
- **Auditoria:** 5 anos, com âncora.
- **Documentos fiscais** da cobrança do próprio Liame: prazo fiscal.

### Fim de contrato

Conta suspensa → **30 dias de graça** com exportação (CSV/JSON) → expurgo do tenant inteiro → certificado de expurgo por e-mail.

### Backups também

- **Dados pessoais** (classes `PERSONAL` e `SENSITIVE`) são cifrados com a **chave do tenant** (envelope do ADR-011), com índice cego (HMAC) para busca por telefone ou e-mail.
- No expurgo do tenant, a chave é destruída no KMS (**crypto-shredding**). O que ainda existir em backup fica ilegível.
- O restante some com a rotação: backups completos expiram em **35 dias**.

### Exceções

Ordem judicial, investigação em andamento ou obrigação legal suspendem o expurgo (`legal_hold`), com motivo registrado.

## Consequências

- Toda tabela nova nasce com classe de dado e prazo; migration sem isso não passa na revisão.
- A cifra por tenant dos dados pessoais precisa existir **desde a A1**. Acrescentar depois exigiria recifrar tudo.
- Busca exata por telefone ou e-mail usa o índice cego; busca parcial por esses campos deixa de existir.
