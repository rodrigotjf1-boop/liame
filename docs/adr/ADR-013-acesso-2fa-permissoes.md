# ADR-013 — Acesso: e-mail para entrar, app autenticador como segundo fator e permissão fina por rota

- **Status:** Aceito · 26/09/2026 (proposto em 25/09/2026; aprovado com o plano completo pelo dono)
- **Base:** base de conhecimento §17.1 · `security-model.md` §3 · complementa o ADR-009 (DMS ID) e o ADR-003 (tenant)

## Contexto

Pedido do dono (25/09/2026): autenticação por e-mail e app autenticador; RBAC, `@roles` e `@policies`; tenant.

O plano já tinha RBAC + ABAC, guard global que nega por padrão, RLS forçada e "2FA obrigatório para Dono e Aprovador". Faltava dizer **qual** segundo fator e **como** a rota declara o que exige.

Fato que muda o desenho: o **NIST SP 800-63B-4** proíbe e-mail como autenticador fora de banda ("Email SHALL NOT be used for out-of-band authentication") e classifica SMS como autenticador restrito. Código por e-mail não serve como segundo fator de quem mexe em dinheiro.

## Decisão

### Autenticação

- **E-mail é a identidade e o canal de recuperação:** cadastro confirmado por e-mail, login com e-mail + senha (checada contra senhas vazadas) e avisos de segurança (login novo, segundo fator trocado).
- **Segundo fator = app autenticador (TOTP, RFC 6238):** Google Authenticator, Microsoft Authenticator, 1Password e outros. **Obrigatório** para Dono, Gestor e Aprovador; recomendado para os demais.
- **10 códigos de recuperação** de uso único, gerados ao ativar o app.
- **Trocar o segundo fator** exige o fator atual, ou um código de recuperação + confirmação por e-mail + 24 h de espera com aviso.
- **Reautenticação na hora do dinheiro:** aprovar ação com gasto (risco ≥ R2 ou `budget_impact > 0`) pede o código do app de novo, fora do chat (ADR-007).
- **Passkeys (WebAuthn)** entram na A7, porque resistem a phishing.
- Código por e-mail **não** é segundo fator. SMS fica fora.
- Quando o DMS ID (Logto) entrar, os mesmos fatores existem lá. O Logto também oferece código por e-mail e SMS, que ficam **desligados** para os papéis que mexem em dinheiro.

### Autorização

- **Nada liberado por padrão:** o guard global nega toda rota sem declaração.
- **A rota declara permissão fina, não papel:** `@Permissao('campanha.orcamento.alterar')`. O papel (Dono, Gestor, Analista, Criador, Aprovador, Cliente) é **dado**: um conjunto de permissões editável por tenant.
- **Política (ABAC) para limites de contexto:** `@Politica('orcamento.limite')` avalia marca, conta, valor e horário. Exemplo: "Gestor aumenta até 15%, até R$ 500 por ação, só nas contas X e Y".
- **Agente ≤ quem delegou:** um funcionário de IA age com a interseção entre as permissões de quem o ativou e o modo de autonomia dele. Nunca tem mais poder que o humano responsável.
- **Modo Lite/Pro não é permissão:** é preferência de exibição. O que alguém pode ver e fazer vem só do servidor.
- **Tenant:** continua o ADR-003 (RLS forçada, contexto por transação, sem `BYPASSRLS`). A permissão é a segunda camada; a RLS é a última.
- A matriz papel × permissão sai na A1, em `security-model.md`, com teste automático por papel.

## Consequências

- O onboarding ganha um passo (ativar o app). Mitigação: tela guiada com QR e os códigos de recuperação para guardar.
- Permissão fina dá mais trabalho no começo, mas deixa mudar papéis sem mexer em código e explica cada "não pode" pelo nome da permissão.

## Implementação (E2a, 26/09/2026)

- **Senha:** 15 caracteres ou mais, sem regra de composição (NIST SP 800-63B-4 exige 15 quando a senha é o único fator; vale para todos, porque nem todo nível tem app autenticador); checada contra senhas vazadas (Have I Been Pwned por k-anonimato, só os 5 primeiros caracteres do hash saem; fora do ar, deixa passar e registra). Guardada com **scrypt** nativo (N = 2^17, r = 8, p = 1), com os parâmetros no próprio hash.
- **Sessão no banco:** cookie opaco `liame_sessao` (httpOnly, SameSite=Lax, Secure em produção); o banco guarda só o SHA-256 do token. Validade de 30 dias, com 7 dias de inatividade. Revogação imediata; troca de senha derruba todas as sessões.
- **Contexto da RLS por transação:** `app.tenant_id`, `app.user_id` e `app.scope`. O **escopo de sistema** só existe para o que precisa enxergar antes do tenant (login, sessão, convite, agendador) e é restrito por regra do Semgrep (`liame-escopo-sistema`).
- **Guard global** (`AccessGuard`): toda rota declara `@Publico`, `@Autenticado` ou `@Permissao`, e o app **não sobe** se alguma não declarar ou pedir permissão inexistente. Toda rota autenticada roda numa **transação da requisição** (unidade de trabalho).
- **Limites de tentativa** (Postgres, valem entre réplicas): entrar 10 por e-mail e 30 por IP a cada 15 min; cadastro 10 por IP por hora; esqueci a senha 5 por e-mail por hora. Resposta 429 com `Retry-After`.
- **Origem:** mutação com cabeçalho `Origin` fora da lista do app é recusada (defesa contra CSRF, além do SameSite).
- **Nada revela quem tem conta:** cadastro e "esqueci a senha" respondem igual; login com e-mail inexistente gasta o mesmo tempo e dá o mesmo erro.

## Implementação (E2b, 26/09/2026)

- **App autenticador (TOTP, RFC 6238):** implementação nativa (HMAC-SHA1, 6 dígitos, 30 s, janela de ±1 passo). O segredo fica no cofre (ADR-011/014), primeiro como `totp_pendente` e, depois do código de confirmação, regravado como `totp` (a finalidade faz parte do contexto da cifra). O último passo aceito fica em `app_user.totp_last_step`: o mesmo código não vale duas vezes, nem em duas requisições simultâneas (update condicional).
- **Códigos de recuperação:** 10, mostrados uma única vez, guardados só como SHA-256, uso único; usar um avisa por e-mail.
- **Sessão:** `session.mfa_verified_at` e `session.mfa_method` (`totp` ou `recuperacao`). Quem tem o app ativo só usa `GET /v1/me`, `POST /v1/me/mfa/verify` e sair antes de digitar o código (401 `segundo-fator-necessario`).
- **Obrigatório por nível:** Dono, Administrador, Gestor e Aprovador recebem 403 `segundo-fator-nao-configurado` em rota de permissão enquanto não ativam o app; `/me` devolve `mfa_enrollment_required` para a tela levar direto à configuração.
- **Troca do app:** imediata com a sessão verificada pelo app. Sem o aparelho: entrar com código de recuperação, pedir a troca (`POST /v1/me/mfa/change-request`), aviso por e-mail, vale depois de 24 horas e expira em 72; senha nova cancela o pedido. A pessoa só enxerga os próprios pedidos de troca (política própria na RLS de `user_token`).
- **Limite:** 10 tentativas de código por pessoa a cada 15 minutos.
