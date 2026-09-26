# ADR-009 — Autenticação do Liame e servidor de autorização do DMS ID

- **Status:** Aceito · 26/09/2026 (proposto em 24/09/2026; aprovado com o plano completo pelo dono)
- **Decide:** (a) como o Liame autentica agora; (b) qual servidor de autorização (AS) o DMS ID usa na trilha B
- **Base:** matriz comparativa de 12 opções (base de conhecimento §13), feita contra a spec MCP 2026-07-28

## Contexto

- **D2:** o Liame nasce com login próprio, sem esperar o DMS ID.
- O plano mestre propunha um AS próprio com `oidc-provider`. As diretrizes pedem comparar antes e só construir se nada atender, com revisão de segurança externa.
- **O que a spec MCP 2026-07-28 pede do AS:**
  - **Obrigatório:** OAuth 2.1 + PKCE; descoberta com `code_challenge_methods_supported`; `redirect_uri` exato; rotação de refresh token de cliente público.
  - **Recomendado:** CIMD; RFC 9207.
  - **Deprecado:** DCR.
  - **Parâmetro `resource` (RFC 8707):** o cliente sempre envia e o servidor MCP valida o `aud`. Com vários produtos atrás de um AS central, **RFC 8707 nativo é o requisito que mais pesa**.
- **LGPD:** identidade hospedada nos EUA exige cláusulas-padrão (Res. ANPD 19/2024); a UE tem adequação (Res. ANPD 32/2026).

## Opções

| Opção | 8707 | 9207 | CIMD | M2M | Região BR | Custo (5 mil MAU + 1.000 M2M) | Situação |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Logto OSS** (MPL-2.0, self-host) | ✅ nativo | ✅ | ✅ | ✅ | ✅ (nossa VPS) | só infraestrutura | **Recomendado** |
| Keycloak 26.7 (Apache-2.0) | ⚠️ experimental | ✅ | ⚠️ experimental | ✅ | ✅ | só infraestrutura (mais RAM) | Alternativa conservadora |
| Descope Growth | ✅ | n/c | ✅ | ✅ | ✅ "SA – Brazil" | US$799–2.000/mês | Se não houver quem opere |
| WorkOS | ✅ | n/c | ✅ | ✅ (preço n/c) | ❌ EUA | US$0–99 + M2M sob consulta | Melhor DX; dados nos EUA |
| Auth0 | ✅ | ✅ | ⚠️ manual | ✅ por token | ❌ | ≈ US$1.400+ | Caro; CIMD manual |
| Clerk | ⚠️ | n/c | ✅ | ❌ proprietário | ❌ | US$55–950 | Descartado (M2M) |
| Stytch | ⚠️ | ✅ | ⚠️ beta | ✅ por token | ❌ | até ≈ US$3.600 | Risco de roadmap (Twilio) |
| Zitadel / Ory / authentik | ❌ | ❌ | ❌ | ✅ | ✅ self-host | — | Descartados para MCP hoje |
| Supabase Auth OAuth Server | ❌ | ❌ | ❌ | ❌ | ✅ | incluso | Descartado (beta, `aud` fixo) |
| Custom `oidc-provider` | ✅ | ✅ | ⚠️ experimental | ✅ | ✅ | infraestrutura + **engenharia contínua** | Não se justifica |

Pelos critérios, o Logto vence em custo, lock-in, DX e compatibilidade MCP, e perde em maturidade e operação para Keycloak e SaaS. Avaliação completa na base §13.

## Decisão

### (a) Liame agora (A1)

Login próprio no molde do RegemCast:
- senha forte + **2FA obrigatório** para Dono e Aprovador;
- sessão em cookie httpOnly;
- API por OAuth `client_credentials` e API keys com escopo.

O Liame é escrito com **fronteira OIDC**: o módulo `auth` expõe `Principal { sub, tenant, roles, scopes }`, e a origem do token é trocável. Na trilha B o Liame vira *relying party* do DMS ID sem reescrever as regras.

### (b) DMS ID (trilha B1)

**Logto open source, hospedado por nós no Brasil**:
- contêiner próprio no EasyPanel, de preferência em VPS separada da aplicação;
- **Postgres dedicado**, fora do banco operacional;
- versão fixada.

Condições obrigatórias:
1. **Allowlist de CIMD:** o Logto não documenta política de admissão. Mitigar com regra na Cloudflare no endpoint de autorização (bloquear `client_id` em formato URL fora da lista) ou contribuir o recurso upstream.
2. **Conferir a matriz de clientes MCP** (Claude, ChatGPT, Cursor…) com suporte a CIMD, porque o Logto não tem DCR (deprecado na spec).
3. **Operação:** backup, rotação das chaves de assinatura, acompanhamento dos avisos de segurança.
4. O hub MCP valida **`aud`, `iss` e escopos** por conta própria (defesa em profundidade).

**Plano B:** Keycloak ≥ 26.8, quando RFC 8707 e CIMD saírem de experimental (reavaliar o guia MCP oficial ao sair a 26.8). **Plano C** (sem capacidade de operar um IdP): Descope Growth na região Brasil, com o DCR desligado.

**`oidc-provider` custom: rejeitado como caminho principal.** O Logto já é esse motor empacotado (login, consentimento, MFA, console, M2M, organizations, token exchange). Construir por cima dependeria de um único mantenedor upstream e de engenharia de segurança contínua. Se um dia for retomado, exige **revisão de segurança externa antes de produção**.

## Consequências

- Mais um serviço para operar na trilha B, e só nela. O MVP não depende disso.
- Os dados de identidade ficam no Brasil, sem cláusula de transferência internacional para o AS.
- Pentest do DMS ID antes de abrir o hub para clientes externos.

## Revisar quando

A spec MCP mudar requisitos de autorização; Keycloak 26.8+ estabilizar 8707 e CIMD; o Logto documentar política de CIMD; ou a operação própria virar gargalo.
