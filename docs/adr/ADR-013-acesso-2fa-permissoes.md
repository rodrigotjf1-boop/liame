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
