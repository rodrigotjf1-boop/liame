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

## Implementação da chave por empresa (E4, 26/09/2026)

- `liame.tenant_key`: a chave de dados da empresa fica embrulhada pela **chave própria da empresa no KMS** (criada na primeira cifra; `key_ref`). Dado pessoal cifrado com ela (`pii1.`), com **índice cego** (HMAC com chave derivada) para busca exata.
- `destroyTenantKey` marca a linha e agenda a exclusão da chave no KMS (30 dias de espera, com alarme de `ScheduleKeyDeletion` a configurar na conta AWS). Depois disso, a cifra fica ilegível também nos backups. O job de expurgo e o certificado entram na E7.
- **Custo a acompanhar:** uma chave no KMS custa cerca de US$ 1 por mês. Com uma por empresa, o custo cresce com a base; revisar a alternativa (chave da empresa embrulhada pela KEK global, com expurgo completo quando os backups expiram) se passar de algumas centenas de empresas.

## Implementação (E7, 26/09/2026)

- **Classificação:** `apps/server/src/lifecycle/data-classes.ts` dá a classe (a mais alta das colunas) e o prazo de cada tabela; um teste reprova tabela nova sem entrada (a marcação por coluna chega com contatos e mensagens, A2/A5).
- **Expurgo diário** no worker (04:30 UTC, pg-boss), em lotes de 5.000 e transações curtas: outbox publicado há 30 dias (com as entregas), inbox com 90 dias, `Idempotency-Key` vencida, token vencido há 30 dias, sessão encerrada há 6 meses (Marco Civil), limites com 1 dia, marca arquivada há 12 meses. Cada rodada grava na auditoria a classe e a contagem por empresa (sem conteúdo). `legal_hold` na empresa suspende tudo o que é dela.
- **Só o expurgo apaga:** DELETE concedido à aplicação com política **restritiva** de escopo de sistema; nenhuma transação de empresa ou pessoa apaga organização, eventos, sessões ou tokens.
- **Encerrar a conta** (`POST /v1/organization/close`, só o dono): nome da empresa + código do app; cancela pedidos de ação (devolve a reserva) e convites; 30 dias de graça em que as mudanças são recusadas (`empresa-em-encerramento`), mas dá para ver, **exportar** (`GET /v1/export`, JSON sem segredo, senha, token ou sessão, auditado) e **reativar**.
- **Fim da graça:** a chave da empresa é destruída primeiro (crypto-shredding), depois a organização é apagada em cascata (inclusive regras de flag da empresa); o `purge_certificate` guarda nome, CNPJ, contagens e hash, e o certificado vai por e-mail ao dono. A pessoa mantém a própria conta.
- **Auditoria da empresa expurgada:** fica, e a cadeia termina com `empresa.expurgar`, ainda verificável. Guardar os rótulos de quem agiu (nomes) por 5 anos depois do expurgo é **decisão pendente com o jurídico**.
- **Relatório mensal** ao dono (dia 1, 12:00 UTC) com o que foi expurgado no mês anterior.
