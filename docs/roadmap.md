# Liame — Roadmap revisado

> Status: **aprovado pelo dono em 26/09/2026** (proposta de 24/09/2026). Sem datas: o ritmo é ditado pelas aprovações externas (Meta, Google, TikTok, GBP) e pelos critérios de saída. Cada fase só termina quando o critério é cumprido, não quando o prazo vence.

## 1. Trilhas

| Trilha | Conteúdo | Relação com o MVP |
| --- | --- | --- |
| **A · Liame** | O produto: A0 → A8 | Caminho crítico |
| **B · MCP central** | B1 DMS ID · B2 MCP Hub · B3 Regem + RegemCast via MCP · B4 Liame + demais produtos · B5 A2A se necessário | **Paralela; nunca bloqueia o MVP** |
| **C · Ajustes nos produtos DMS** | C1 token por loja do Regem · C2 API de serviço do RegemCast · C3 eventos, UTM e consentimento no Regem | **Começa com a A1**: a A2.5 depende dela |
| **D · Trâmites** | Meta, Google, TikTok, GBP, jurídico | Começa na A0; tempo de espera externo |

## 2. Fases da trilha A

| Fase | Objetivo | Entregas principais | Depende de |
| --- | --- | --- | --- |
| **A0 · Fundação e decisões** | Decidir e desbloquear | Stack confirmada, ADRs, docs, mockups, domínio **agencialiame.com** na Cloudflare (**landing no ar desde 25/09/2026**; termos e privacidade ainda por publicar nele), Supabase, pedidos às plataformas, jurídico, spike de compatibilidade | — |
| **A1 · Núcleo seguro** | Base em que dá para confiar | Auth com e-mail + app autenticador (ADR-013), convite por e-mail com níveis e limites (ADR-017), tenant, RBAC + ABAC com permissão fina, RLS, ciclo de vida e expurgo com chave por tenant (ADR-014), política de erros, calendário de versões das APIs, OpenAPI, idempotência, auditoria + âncora, cofre, Action Service base, Policy Engine base, outbox, pg-boss, workflow runtime base, OpenTelemetry, feature flags, kill switch, CI com segurança e supply chain | A0 |
| **A2 · Dados de mídia** | Ler Meta, Google e GA4 corretamente | Connectors de leitura, modelo canônico, sync incremental, histórico temporal, Capability Registry, **Vigia de integrações** (ADR-015), freshness, painel inicial orientado a atenção | A1 · D (leitura funciona com o restaurante como testador) |
| **A2.5 · Ciclo fechado** ⭐ | **O diferencial** | Regem (pedido, item, receita, margem), RegemCast (conversas, referral), UTM/click id no cardápio, cupom por campanha, atribuição, tela "ROAS plataforma × ROAS confirmado no caixa" | A2 · **C1 · C2 · C3** |
| **A3 · Camada de inteligência** | Os funcionários pensam | AI Gateway, model routing com perfis por finalidade (ADR-016), motores, workflows (relatório, anomalias), Atendimento, Estratégia, Analista, Pesquisador, Compliance, evals, sombra real, Readiness Score, AI Usage Ledger | A2.5 |
| **A4 · Escrita Meta** | A agência executa com trilho | Action Service completo, Approval Inbox, geração de imagem pelo catálogo curado, ledger de orçamento, Meta write (pausado, `validate_only`), compensating actions, piloto Shadow → Suggest → Approval | A3 · acesso avançado Meta (ou testador) |
| **A5 · Google + CRM** | Segundo canal e mensageria | Google write, Data Manager, CAPI, RegemCast disparos, réguas WhatsApp/e-mail, públicos com consentimento, conversões offline | A4 · Google Basic/Standard |
| **A6 · Expansão** | Mais canais | Vídeo curto (quando o provedor sair do experimental), TikTok, social orgânico (IG/FB/Threads), criativos, YouTube, GBP, Search Console, pacote pronto para canais sem API | A5 |
| **A7 · Escala comercial** | Vender fora do piloto | Agência com várias marcas-clientes, parceiros com vínculo aceito pelo dono (ADR-017), passkeys, franquia, white-label, billing, revenda, LIMITED_AUTO (envelope), autonomia granular | A6 |
| **A8 · Especializações** | Só depois | SEO, AI-SEO, CRO, SDR, experimentação avançada, canais adicionais, A2A com parceiro real | A7 |

> **Pendências finais do roadmap** (decisões do dono; entram depois da última fase em curso, antes de dar o roadmap por concluído):
>
> 1. **Armazenamento de fotos e mídias** (ADR-021: AWS S3 em São Paulo, aceito em 05/10/2026, com a ordem de não construir agora). Com ele vêm a imagem do Criativo (A4 · X7) e a campanha nova, criada pausada (A4 · X5), que dependem das fotos guardadas.
> 2. **Quem paga a IA** (05/10/2026): a distribuição, com teto por empresa, ou cada empresa cliente com a própria conta de IA, ligada pelo front. Decide-se com a conta mensal medida nos testes (`ai-architecture.md` §10).

## 3. Critérios objetivos de saída da A0

A A0 termina quando **todos** os itens abaixo estiverem cumpridos e registrados:

| # | Critério | Evidência |
| --- | --- | --- |
| A0-1 | ADR-001 a ADR-010 com status **Aceito** pelo dono | Status no arquivo + data |
| A0-2 | Os 8 docs aprovados (`especificacao`, `arquitetura`, `decisoes-design`, `security-model`, `ai-architecture`, `data-model`, `integrations`, `roadmap`) | Registro no changelog |
| A0-3 | **Spike de compatibilidade** verde, buildando e testando no CI em checkout limpo, com: Node 24 + pnpm 12 + Turborepo + Nest 12.1 + Next 16.3 + TS 6.0.3 + Drizzle 0.45 + pg-boss 12 + OTel. O spike decide **ESM × CJS** no server, prova o `StandardSchemaValidationPipe` com Zod, gera OpenAPI **3.1**, faz envio transacional do pg-boss com conexão em sessão, gera trace de http/pg/undici, e importa o AI SDK 7 e o SDK MCP 2.1 | Link da execução do CI + nota no ADR-001. **✅ Cumprido em 25/09/2026:** [CI verde](https://github.com/rodrigotjf1-boop/liame/actions/runs/36203403949) (Node 24.21, Postgres 17); ESM decidido (nota no ADR-001) |
| A0-3b | Contas AWS criadas: **KMS sa-east-1** (IAM mínimo, trava de IP, CloudTrail) e **conta dedicada da âncora** (S3 Object Lock compliance) | IDs das contas (sem segredos) |
| A0-4 | **Mockups aprovados:** Resumo (visão do dono), Atenção, Approval Inbox, Conversa, Resultados (ciclo fechado), Sua equipe, Pessoas e acessos, Contas conectadas, Ctrl+K, **nos modos Lite e Pro** (protótipo em `mockups/prototipo-app.html`) | Arquivos em `mockups/` |
| A0-5 | Pedidos protocolados: app Meta (Business, no nome da DMS Tecnologia) com acesso avançado solicitado; projeto Google Cloud com verificação de marca e acesso à Ads API; cadastro TikTok; formulário GBP | IDs e prints em `integrations.md` |
| A0-6 | Termos de uso, política de privacidade e contrato de operador (LGPD, art. 39) publicados em URL. **Pendente:** a landing está no ar (25/09/2026) sem essas páginas; os termos precisam cobrir o acesso delegado (ADR-017) | URLs |
| A0-7 | Restaurante de testes confirmado: aceite do tratamento de dados, inventário de contas (anúncios, IG, GBP, **número de WhatsApp na API oficial?**, tenant no Regem) | Checklist assinado |
| A0-8 | Projeto Supabase em São Paulo criado (vazio); serviços reservados no EasyPanel; zona na Cloudflare | Prints |
| A0-9 | Trilha C: plano de recuperação do token por loja (C1) aprovado | Issue/plano no Regem |
| A0-10 | Threat model v1 revisado (`security-model.md`) | Registro |

## 4. Critérios objetivos de saída da A1

A A1 termina quando o CI da `main` estiver verde com **todos** os testes abaixo:

| # | Critério | Como é verificado |
| --- | --- | --- |
| A1-1 | **100% das tabelas com `tenant_id`** têm `ENABLE` + `FORCE ROW LEVEL SECURITY` + política | Teste que enumera `pg_class`/`pg_policies` e falha se faltar alguma |
| A1-2 | Role da aplicação **sem `BYPASSRLS`** e sem ser dona das tabelas; `service_role` do Supabase ausente da configuração do app | Teste de catálogo + teste de configuração |
| A1-3 | **Suíte cross-tenant:** para cada recurso, o tenant B não lê, não altera e não lista dados do tenant A (API, repositório e SQL direto sob RLS) | Teste gerado por tabela e rota |
| A1-4 | **Guard global fail-closed:** toda rota sem `@Publico()` explícito responde 401 sem credencial | Teste que enumera as rotas registradas |
| A1-5 | Contexto de tenant por transação (`set_config(..., true)`), nunca por sessão | Teste com duas transações concorrentes no mesmo pool |
| A1-6 | **Auditoria:** toda rota de mutação gera `audit_event`; a verificação da cadeia de hash passa; **1 âncora diária** publicada fora do banco | Teste + job de verificação + registro da âncora |
| A1-7 | **Outbox:** mutação e evento atômicos (teste com falha simulada entre commit e publicação); webhook de saída assinado e validado por um receptor de referência; retry e DLQ | Testes de integração |
| A1-8 | **Idempotência:** mesma chave + mesmo corpo → mesma resposta; corpo diferente → 422; `action_fingerprint` impede ação duplicada concorrente | Testes |
| A1-9 | **Action Service base:** uma ação num *connector sandbox* passa política → orçamento (reserva) → aprovação amarrada ao hash → execução → auditoria; plano alterado invalida a aprovação | Teste ponta a ponta |
| A1-10 | **Kill switch** em cada nível (global, provider, tenant, marca, conta, ferramenta) bloqueia a execução | Testes |
| A1-11 | **Policy Engine** determinístico com políticas versionadas e testes unitários (teto, % máximo, horário, conta permitida, escopo, categorias proibidas) | Testes |
| A1-12 | **Feature flags** avaliadas por ambiente, tenant, marca, conta e usuário; as de escrita nascem desligadas | Testes |
| A1-13 | **Cofre:** token cifrado com envelope; chave mestra fora do banco; rotação para `key_version` 2 com recifragem | Teste |
| A1-14 | **OpenTelemetry:** um `trace_id` visível de web → API → worker → connector sandbox no backend escolhido | Print do trace + teste de propagação |
| A1-15 | **Contrato:** OpenAPI 3.1 gerado dos schemas; Spectral sem erro; oasdiff ativo; SDK gerado compila | CI |
| A1-16 | **Supply chain no CI:** dependências, segredos, SAST, SBOM, licenças e imagem de contêiner verificados (ferramentas no ADR-001) | CI |
| A1-17 | **Segurança:** checklist security-hardening P0–P7 completo; rate limit ativo; segundo fator por app autenticador para Dono, Gestor e Aprovador | Checklist + testes |
| A1-18 | Health com versão do código, tocando banco e fila (LIC-008); 5xx com log e id da requisição (LIC-003) | Testes |
| A1-19 | `ERROS-CONHECIDOS.md` criado e o projeto registrado no mapa do `errei` | Arquivo |

## 5. Critério de sucesso do MVP (fim da A2.5)

Uma cadeia real completa no restaurante de testes, `campanha → clique → WhatsApp/cardápio → pedido → receita`, e a tela comparando **atribuição da plataforma × atribuição confirmada no caixa**.
