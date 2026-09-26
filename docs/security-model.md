# Liame — Modelo de segurança

> Status: **aprovado pelo dono em 26/09/2026** (proposta de 24/09/2026) · **threat model revisado em 25/09/2026 (v1.1, §2.1)**. Complementa os ADR-003 (RLS), ADR-007 (política e ações), ADR-008 (MCP), ADR-009 (identidade), ADR-013 (acesso), ADR-014 (ciclo de vida) e ADR-017 (acesso delegado).

## 1. O que protegemos (ativos)

| Ativo | Por que importa |
| --- | --- |
| Dinheiro dos clientes (verba de mídia) | Gasto indevido é prejuízo direto e irreversível |
| Tokens OAuth de Meta, Google, TikTok e WhatsApp | Dão controle das contas de anúncio e das páginas do cliente |
| Dados pessoais dos consumidores dos clientes | LGPD; confiança |
| Isolamento entre tenants | Vazamento entre clientes encerra o produto |
| Reputação das contas de anúncio | Bloqueio pela plataforma para o negócio do cliente |
| Integridade da auditoria | Responder "quem mandou fazer isso?" |

## 2. Ameaças principais (threat model v1)

| Ameaça | Vetor | Controles |
| --- | --- | --- |
| Vazamento entre tenants | Bug de filtro, contexto de sessão no pool, job sem contexto, prompt com dois tenants | Cinco camadas + RLS forçada + testes cross-tenant (ADR-003); gateway de IA nunca mistura tenants |
| Agente gastando demais ou errado | Alucinação, injeção de prompt, bug de política | Policy Engine determinístico, ledger, aprovação amarrada ao hash, kill switch, teto na plataforma, sombra + Readiness |
| Injeção indireta de prompt | Comentário, DM, avaliação, página de concorrente | Untrusted Reader sem ferramentas; rótulos estruturados; evals de ataque |
| Roubo de token de terceiro | Banco vazado, log, resposta de API | Envelope encryption com chave mestra **fora** do banco (§5); tokens nunca em log, front, prompt ou auditoria do cliente |
| Aprovação forjada ou phishing | Link de aprovação interceptado | Uso único, TTL, amarrado ao aparelho; gasto só com login + 2FA |
| Webhook falsificado ou repetido | Chamada direta à rota de webhook | Assinatura verificada, `external_event_id` UNIQUE, janela de timestamp |
| Conta de anúncio bloqueada | Automação agressiva | Limites abaixo dos das plataformas, criação pausada, `validate_only` |
| Supply chain | Dependência comprometida (SDKs de IA, MCP, OAuth, crypto) | Lockfile, versões fixas, scanners no CI, SBOM (§9) |
| Reescrita da auditoria | Acesso total ao banco | Hash encadeado + âncora diária externa (§7) |
| Abuso da API | Força bruta, scraping | Cloudflare + rate limit por tenant, chave e rota; lockout; 2FA |

### 2.1 Revisão v1.1 (25/09/2026): ameaças acrescentadas

Revisão do threat model depois dos ADR-013 a ADR-017 e do spike A0-3. Cada linha diz o controle e **quando** ele entra.

| Ameaça | Vetor | Controles | Entra em |
| --- | --- | --- | --- |
| **Convidado malicioso ou com conta roubada** | Administrador ou gestor convidado (ADR-017) com senha vazada; ex-prestador que ainda tem acesso | Segundo fator obrigatório antes do primeiro acesso; limite por ação com dupla aprovação do dono acima dele; aviso imediato ao dono em pessoa nova, limite alterado, conta conectada trocada e cobrança alterada; remoção que revoga sessões e tokens na hora; data de fim opcional no convite; resumo semanal por pessoa | A1 |
| **Escalada de privilégio pelo convite** | Administrador que convida alguém com mais poder, aumenta o próprio limite ou libera a cobrança | Regra "ninguém concede mais do que tem" no serviço (não só na tela); permissões finas por rota (ADR-013); teste que tenta cada escalada | A1 |
| **Convite interceptado ou reutilizado** | E-mail encaminhado, link vazado | Link de uso único, guardado como hash, que vence em 7 dias e só vale para o e-mail convidado | A1 |
| **Tomada da conta pelo suporte (engenharia social)** | Golpista pede à DMS a "recuperação" da conta do dono | Recuperação só com identidade + CNPJ + canal já cadastrado; espera de segurança antes de valer; aviso ao e-mail antigo; registro na auditoria; nunca pelo WhatsApp da LIA | A1 |
| **Acesso interno da DMS aos dados de um cliente** | Pessoa da distribuição olhando dados sem motivo; credencial do console roubada | Console separado, com segundo fator; sem leitura de dado pessoal de cliente por padrão; acesso de emergência (*break-glass*) com motivo, prazo curto, aviso ao dono e registro na auditoria; revisão mensal dos acessos | A1 (console) |
| **Perda de dados por destruição de chave** | Chave de tenant destruída por engano ou por bug do expurgo (crypto-shredding, ADR-014) | Destruição só pelo job de expurgo do tenant encerrado, depois dos 30 dias de graça; período de espera do KMS antes da exclusão definitiva; alarme de `ScheduleKeyDeletion`; teste do expurgo num tenant de teste | A1 |
| **Expurgo ou job no tenant errado** | Job de sistema que varre todos os tenants sem escopo (LIC-083, LIC-084) | Todo job recebe `tenant_id` e roda sob RLS; o agendador não lê dado de negócio (ADR-003); teste que roda o job num banco com dois tenants | A1 |
| **Custo de IA disparado de fora** (*denial of wallet*) | Conversa pública com a LIA pelo WhatsApp ou pelo site em volume; prompt que força respostas longas | Limite por número e por tenant; teto diário no AI Usage Ledger; modelo barato no primeiro contato; alarme de custo | A3 |
| **Dado pessoal vazando pela telemetria** | Spans com texto de query, logs com corpo de requisição, erro com payload, prompt no painel de IA | `enhancedDatabaseReporting` desligado (verificado no spike); redação de PII no Collector; Sentry sem corpo de requisição; Langfuse só com conteúdo já sanitizado (ADR-010); teste que procura e-mail e telefone nos spans | A1 |
| **Dependência maliciosa ou recém-publicada** | Versão sequestrada no npm; script de instalação | `minimumReleaseAge` com modo estrito (ERR-002); scripts de instalação bloqueados por padrão e revisados no `allowBuilds`; lockfile congelado; versões fixadas no catálogo; actions fixadas por SHA (spike A0-3) | ✅ desde a A0 |
| **Cópia dupla de dependência** | Mistura de CommonJS e ESM que carrega duas instâncias do mesmo pacote (estado e checagens divergentes) | Tudo ESM (ERR-001, ADR-001) | ✅ desde a A0 |
| **Mudança de API da plataforma sem aviso** | Campo depreciado passa a ser ignorado e a ação faz outra coisa | Vigia de integrações (ADR-015); `validate_only` antes de escrever; Capability Registry com `deprecated_at`; teste de contrato por connector | A2 |
| **Mensagem sem consentimento** | Lista importada sem base legal; opt-out ignorado; banimento do número | Consentimento por contato × canal × finalidade com evidência; opt-out vale na hora para envios pendentes; clientes de iFood/99 fora do marketing; limites de envio abaixo dos da Meta | A5 |
| **Dado de plataforma usado fora do permitido** | Dado das APIs do Google (Uso Limitado) levado para público na Meta ou para treino; dado da Meta guardado depois da exclusão pedida | Proveniência por registro (`provider` de origem); o Action Service recusa enviar a uma plataforma de anúncio dado vindo de outra; callback de exclusão da Meta; teste que tenta a transferência (base §6.1) | A2 |
| **Uso político ou eleitoral** | Pedido para a IA recomendar candidato ou criar propaganda; cliente que é campanha | Proibido nos Termos; regra do Policy Engine e recusa da IA (Res. TSE 23.755/2026, art. 28 §1º-C); bloqueio de envio no WhatsApp | A3 |
| **Contrato e realidade divergirem** | A política de privacidade promete o que o sistema ainda não faz | As afirmações dos documentos jurídicos viram checklist de implementação (`docs/juridico/README.md`); nada é publicado como fato antes de existir | A0-6 |

**Riscos aceitos, com revisão marcada:**

- **Postgres local 18 × nuvem 17:** o CI no 17 é o portão (`docs/testes.md`).
- **Repositório privado sem os recursos pagos do GitHub** (secret scanning, CodeQL): compensado com as ferramentas livres da §9 na A1.
- **Provedores de IA nos EUA:** transferência internacional com cláusulas-padrão e dado minimizado antes do envio; revisar se surgir provedor com região no Brasil e qualidade equivalente.

## 3. Identidade e acesso

- Login próprio (D2): e-mail + senha forte, checada contra senhas vazadas; sessão com cookie httpOnly, `SameSite`, rotação.
- **Segundo fator por app autenticador (TOTP)**, obrigatório para Dono, Gestor e Aprovador, com 10 códigos de recuperação. **Código por e-mail não vale como segundo fator** (NIST SP 800-63B-4). Reautenticação com o app ao aprovar gasto. Passkeys na A7 (ADR-013).
- **RBAC + ABAC**: papel + recurso + ação + contexto + política (limites por valor, marca, conta). A rota declara **permissão fina** (`@Permissao`) e **política** (`@Politica`), nunca o nome do papel; papel é dado. O agente age com a interseção entre as permissões de quem o ativou e o modo de autonomia dele. **Lite/Pro é preferência de exibição, não permissão** (ADR-013).
- **Acesso delegado (ADR-017):** o dono convida por e-mail quem administra por ele. Convite de uso único, guardado como hash, que vence em 7 dias e só vale para o e-mail convidado; níveis Dono, Administrador, Gestor, Aprovador, Somente leitura e Só relatórios por e-mail; limite de aprovação por ação com dupla aprovação acima dele; remoção revoga sessões e tokens na hora; ninguém concede mais poder do que tem; a recuperação da conta do dono é pela DMS, com CNPJ.
- API: OAuth `client_credentials` (M2M) e API keys com prefixo visível, guardadas como hash, por tenant, com escopo, expiração e rotação.
- Console da distribuição: login separado, perfis próprios, nunca acessível pela sessão do cliente.
- Futuro DMS ID: ver ADR-009.

## 4. Isolamento de tenant

Ver ADR-003: RLS forçada, role sem `BYPASSRLS`, contexto por transação, `service_role` proibida, worker com contexto por job, guard global fail-closed. Na IA: um prompt ou batch = um tenant; cache, traces e embeddings sempre com `tenant_id`.

## 5. Segredos e chave mestra

- **Envelope encryption AES-256-GCM:** cada segredo tem uma *data key* própria, e a data key é cifrada pela **chave mestra** (KEK).
- **Onde vive a KEK: AWS KMS em sa-east-1** (ADR-011). A KEK **não** fica no banco nem no mesmo nível de comprometimento:
  - `GenerateDataKey` com contexto de cifragem `{tenant_id, provider, token_id}`;
  - IAM mínimo, com trava pelo IP da VPS;
  - CloudTrail ligado, com alarme de volume anormal de `Decrypt`;
  - cache curto de DEK;
  - a credencial do KMS nunca fica no banco.

  **Supabase Vault rejeitado:** quem tem SQL lê `vault.decrypted_secrets`.
- `key_version` em cada segredo; rotação da KEK com recifragem em lote; revogação.
- Tokens OAuth nunca aparecem em: logs, frontend, respostas de API, prompts, auditoria visível ao cliente.
- Segredos da aplicação (chaves de API de IA, apps Meta/Google) ficam no cofre/gerenciador escolhido, não em `.env` versionado.

## 6. Dados pessoais e LGPD

- **Classificação:** `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, `PERSONAL`, `SENSITIVE`, `SECRET` por coluna. Ferramentas e agentes recebem só as classes necessárias.
- **Sem PII desnecessária em prompts:** o AI Gateway sanitiza antes de enviar (pseudonimiza ou remove nome, telefone, e-mail, endereço quando o modelo não precisa deles).
- **Consentimento** por contato × canal × finalidade, com evidência e versão da política (`data-model.md` §5).
- **Papéis:** o cliente é **controlador**; o Liame (DMS) é **operador**, com contrato (art. 39). Transferência internacional para provedores de IA exige cláusulas-padrão (arts. 33–36).
- Encarregado de dados, registro das operações (art. 37) e plano de resposta a incidente (comunicação em 3 dias úteis).
- **Retenção** por classe (`data-model.md` §9); exclusão e exportação a pedido.
- **Ciclo de vida:** ativo → arquivado → expurgado, com job diário e registro na auditoria. Dados pessoais cifrados com a chave do tenant: destruir a chave no fim do contrato torna ilegível o que restar em backup (ADR-014).
- Dado sensível (art. 11) nunca vira critério de segmentação. **Conteúdo político** bloqueado por padrão.

## 7. Auditoria

- `audit_event` append-only (sem UPDATE/DELETE na role da aplicação), **hash encadeado**, com ator tipado (`human`, `agent`, `integration`, `system`, `partner`), `trace_id`, ferramenta, agente, modelo, aprovação, antes e depois.
- **Âncora externa diária** (ADR-011): um `daily_root_hash` global (com salt interno) **encadeado ao do dia anterior**, publicado em três lugares:
  - **S3 Object Lock compliance mode** numa **conta AWS dedicada**. A credencial do app só grava e lê, e o verificador exige exatamente uma versão por dia;
  - **Sigstore Rekor** (só o hash, que fica público e permanente);
  - **carimbo RFC 3161**.

  Carimbo ACT ICP-Brasil + e-CNPJ entra quando houver exigência jurídica. Sem blockchain.
- Verificação periódica da cadeia (job) com alerta.
- **Log operacional ≠ auditoria:** logs expiram em dias; auditoria tem retenção e integridade próprias.

## 8. Borda e aplicação

- Cloudflare: TLS, WAF, regras de rate limit **filtradas por host**, Bot Fight desligado em rotas máquina-a-máquina.
- Firewall da Hostinger nega tudo por padrão (o `ufw` não protege porta de contêiner).
- Helmet/CSP, CORS restrito, JWT e segredos que falham cedo (sem valor padrão), `TRUST_PROXY` correto atrás da Cloudflare.
- Playbook `security-hardening` P0–P7 inteiro na A1.

## 9. Supply chain e CI

Todo PR roda: auditoria de dependências, varredura de segredos, SAST, verificação de licenças e lockfile imutável (`--frozen-lockfile`). Em release: SBOM (CycloneDX) e varredura da imagem de contêiner. Atenção redobrada às dependências críticas: SDK MCP, SDKs de IA, OAuth/OIDC, bibliotecas de webhook, crypto, drivers de banco. Atualização consciente, nunca automática sem revisão.

**Restrição:** repositório privado no plano gratuito do GitHub. Secret scanning, push protection, CodeQL e upload de SARIF exigem plano pago, e a licença do CodeQL CLI proíbe uso em código fechado sem GHAS. Por isso, ferramentas livres que **falham pelo exit code**:

| Quando | Verificação |
| --- | --- |
| Todo PR (meta < 5 min) | **gitleaks** (CLI) nos commits · `pnpm install --frozen-lockfile` com `minimumReleaseAge`, `trustPolicy: no-downgrade`, `blockExoticSubdeps` e `allowBuilds` · **osv-scanner** em modo diff · **Semgrep CE** (container; a action foi arquivada) com regras próprias, ex.: "query sem `tenant_id`" · licenças (osv-scanner com allowlist SPDX) quando o lockfile mudar · **zizmor** quando `.github/**` mudar · **promptfoo** quando prompt, ferramenta, modelo, connector ou policy mudar |
| Agendado e no release | **TruffleHog** no histórico completo (só segredos verificados) · osv-scanner completo · build da imagem + **SBOM** (Syft para a imagem, `pnpm sbom` CycloneDX para o código) · **Grype** `--only-fixed` falhando em crítico · `grype sbom:` noturno para CVE nova sem rebuild · suíte completa de evals |
| Sempre | Actions **fixadas por SHA** · `permissions: contents: read` · Dependabot alerts e security updates (grátis) |

**Ativo no CI desde a E1b (26/09/2026)**, em job próprio, em todo push e PR: gitleaks 8.30.1 no histórico inteiro; osv-scanner 2.6.0 (vulnerabilidades + licenças); zizmor 1.30.1 nos workflows; Semgrep CE 1.178.0 com `p/typescript`, `p/nodejsscan`, `p/secrets` e as regras do Liame (`.semgrep/liame.yml`: contexto de tenant por sessão, query no `connect` do pool, promessa solta). Binários baixados da release oficial e conferidos por SHA-256 fixado no workflow. No job de build: contrato OpenAPI igual ao gerado, Spectral sem aviso e oasdiff barrando quebra (exceção só com o rótulo `contrato-quebrado-aceito` no PR). Faltam SBOM, imagem de contêiner e Grype (E9).

**Licenças permitidas:** MIT, Apache-2.0, ISC, BSD-2/3-Clause, 0BSD, AFL-2.1, BlueOak-1.0.0, CC0-1.0, CC-BY-4.0, Python-2.0, **MPL-2.0** (copyleft por arquivo) e **LGPL-3.0-or-later** (o libvips do sharp, usado como biblioteca). **Proibidas:** GPL, AGPL e SSPL. Exceção só em `osv-scanner.toml`, com motivo e conferência no LICENSE.

**Trivy só fixado por SHA ou digest:** incidente de 19/03/2026 (release maliciosa e tags sequestradas, GHSA-69fq-xp46-6x23).

## 10. Kill switch e resposta a incidente

Níveis: global · provider (escrita) · tenant · marca · conta · ferramenta. Quem aciona: dono (para o próprio tenant) e distribuição (todos os níveis). Todo acionamento é auditado e dispara um job que pausa as entidades criadas pelos agentes no escopo. O exercício de "puxar o freio" é periódico.

## 11. Revisões externas

- Se o DMS ID for construído do zero (ADR-009): **revisão de segurança externa antes de produção**.
- Pentest antes de abrir para clientes fora do piloto (fim da A4/A5).
