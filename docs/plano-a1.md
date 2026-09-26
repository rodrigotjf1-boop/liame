# Liame — Plano da fase A1 · Núcleo seguro

> **Proposta para aprovação · 25/09/2026.** A A1 é a base em que dá para confiar: identidade, tenant, permissões, auditoria, cofre, eventos, ações com trilho, flags e observabilidade. **Não tem funcionalidade de marketing ainda**: nenhum connector real, nenhuma IA. Critério de saída: os 19 testes de `roadmap.md` §4, verdes no CI da `main`.

## 1. Quando começa

A regra do projeto (`CLAUDE.md`) é: funcionalidade de produto só depois da A0 cumprida. Situação da A0 em `andamento.md`.

- **Pode começar já** (é infraestrutura, não produto): a entrega **E1**.
- **Começa com o seu aceite** dos ADRs (A0-1) e dos documentos (A0-2): E2 em diante.
- **Precisam de conta sua:** E3 e E4 (AWS: KMS e conta da âncora, A0-3b) e E8 (Grafana Cloud). E2 precisa do provedor de e-mail (seção 3).

## 2. Entregas

Cada entrega é um PR (um commit), com CI verde antes do merge. **Migrations em negrito**: eu aplico e testo no local e no CI; você aplica na nuvem quando o Supabase existir (A0-8), e a conferência das colunas vem junto (`testes.md` §4).

| # | Entrega | O que fica pronto | Critérios | Migrations | Tamanho |
| --- | --- | --- | --- | --- | --- |
| **E1** | **Base técnica** | Executor de migrations (ADR-018); schema `liame`; `health` com versão, banco e fila; política de erros (RFC 9457, `trace_id`, log de todo 5xx); CI de segurança: gitleaks, osv-scanner, Semgrep CE, zizmor, licenças; contrato OpenAPI no CI: Spectral, oasdiff e SDK que compila | A1-15, A1-16 (parcial: sem imagem), A1-18, A1-19 ✅ | **0001** schema `liame`, papéis e privilégios padrão | M |
| **E2** | **Identidade, tenant e acesso** | Organização, marca e unidade; usuário e sessão (cookie httpOnly); cadastro confirmado por e-mail; senha checada contra vazadas; **app autenticador + 10 códigos de recuperação**; guard global que nega por padrão; `@Permissao` e `@Politica`; papéis como dado; **convite por e-mail com níveis e limites** (ADR-017); remoção imediata; rate limit; telas de entrar, segundo fator e "Pessoas e acessos", portadas do protótipo | A1-1 a A1-5, A1-17 (parte de acesso) | **0002** tenancy · **0003** identidade · **0004** permissões e convites | G |
| **E3** | **Auditoria com âncora** | `audit_event` só de inserção, com hash encadeado e ator tipado; toda rota de mutação audita; job diário da âncora (S3 Object Lock, Rekor, carimbo RFC 3161); verificador da cadeia | A1-6 | **0005** auditoria · **0006** âncora | M |
| **E4** | **Cofre e chave por tenant** | Envelope com KMS (`key_version`, rotação com recifragem); chave por tenant para dado pessoal + índice cego para busca por telefone e e-mail (ADR-014) | A1-13 | **0007** cofre e chaves | M |
| **E5** | **Eventos e idempotência** | Outbox na mesma transação; inbox de webhooks (assinatura → persistir cru → deduplicar → ACK); webhooks de saída (Standard Webhooks, retry, DLQ, reenvio); `Idempotency-Key` | A1-7, A1-8 | **0008** eventos · **0009** idempotência | M |
| **E6** | **Ação com trilho** | Policy Engine determinístico (políticas como dado, versionadas); Action Service com *connector sandbox*; orçamento com reserva no ledger; aprovação amarrada ao hash do plano, com reautenticação pelo app; kill switch em 6 níveis; feature flags (OpenFeature + Postgres, escrita nasce desligada); workflow runtime base (pg-boss + tabelas próprias) | A1-9 a A1-12 | **0010** políticas, planos, ações e orçamento · **0011** workflows · **0012** flags e kill switch | G |
| **E7** | **Ciclo de vida** | `archived_at`, `purge_after`, `legal_hold`; job diário de expurgo por tenant; fim de contrato com 30 dias de exportação, destruição da chave e certificado | ADR-014 | **0013** ciclo de vida | M |
| **E8** | **Observabilidade de ponta a ponta** | Collector com redação de PII; Grafana Cloud (região Brasil); um `trace_id` web → API → worker → sandbox; teste que procura e-mail e telefone nos spans | A1-14 | — | P |
| **E9** | **Blindagem** | Checklist `security-hardening` P0–P7; imagem de contêiner com SBOM e Grype; matriz papel × permissão com teste por papel | A1-16 (completo), A1-17 | — | M |

Ordem: E1 → E2 → (E3, E4, E5 em paralelo) → E6 → E7 → E8 → E9. O critério A1-5 (contexto por transação) já está provado no spike e vira teste permanente na E2.

## 3. Decisões que o plano pede

| # | Decisão | Recomendação | Por quê |
| --- | --- | --- | --- |
| D-A1-1 | **Migrations** (ADR-018, a escrever) | **SQL escrito à mão + executor próprio** (uma transação por arquivo, tabela de controle com checksum, o mesmo executor no local, no CI e na nuvem). O Drizzle continua para as consultas, com um teste que compara o schema TypeScript com o banco | RLS forçada, política e GRANT precisam nascer na mesma migration (ADR-003), o que o gerador do Drizzle não garante; a pasta de migrations do Drizzle muda na 1.0; é a prática que já funciona no Regem |
| D-A1-2 | **Schema do banco** | Schema próprio `liame`, fora do `public` | O `public` é o que a Data API do Supabase expõe; ficar fora dele é uma barreira a mais |
| D-A1-3 | **Senha** | `scrypt` nativo do Node + checagem de senha vazada por k-anonimato (só os 5 primeiros caracteres do hash saem) | Sem dependência nativa nova (menos cadeia de suprimentos); aceito pelo OWASP |
| D-A1-4 | **E-mail do serviço** (confirmação, convite, avisos) | **Amazon SES em São Paulo**, na mesma conta AWS do KMS | Dados no Brasil, um fornecedor a menos; alternativa: Resend |
| D-A1-5 | **App autenticador** | TOTP (RFC 6238) implementado com a criptografia nativa, janela de ±1 passo, segredo no cofre | Algoritmo pequeno e padronizado; sem biblioteca extra |

## 4. O que depende de você

| Para | Preciso de | Critério da A0 |
| --- | --- | --- |
| Começar E2 em diante | Aceite dos ADR-001 a 017 e dos documentos | A0-1, A0-2 |
| Telas de E2 | Aceite do protótipo (Lite e Pro) | A0-4 |
| E2 (e-mails) | Escolha do provedor de e-mail (D-A1-4) e o domínio de envio | — |
| E3 e E4 | Contas AWS: KMS em São Paulo e conta dedicada da âncora | A0-3b |
| Aplicar na nuvem | Projeto Supabase em São Paulo | A0-8 |
| E8 | Conta no Grafana Cloud | — |

## 5. Fora da A1

Connectors reais (Meta, Google, GA4: A2), IA e funcionários (A3), escrita nas plataformas (A4), mensageria (A5), cobrança do Liame e revenda (A7), passkeys (A7), MCP (trilha B).

## 6. Riscos

| Risco | Mitigação |
| --- | --- |
| E2 é grande e mexe em segurança | Dividir em três PRs (tenancy e identidade; segundo fator; convites e permissões), cada um com os seus testes |
| Âncora e cofre dependem da AWS | E5 e E6 avançam sem ela; E3 e E4 entram quando as contas existirem |
| Diferença entre o Postgres local (18) e a nuvem (17) | O CI no 17 é o portão |
| Instrumentação do Nest 12 ainda não publicada | Spans manuais no Action Service e nos workflows; trocar quando sair |
