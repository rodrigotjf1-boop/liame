# Configuração do servidor (API e worker)

Variáveis de ambiente lidas por `apps/server`. Valor errado derruba a subida (validação no boot), nunca a requisição. Segredos só pelo painel da hospedagem ou pelo cofre, nunca no git.

Legenda: **P** = obrigatória em produção · **S** = segredo.

## Imagens

- **Servidor** (`apps/server/Dockerfile`): o mesmo para API e worker. API é o padrão; worker: `node --enable-source-maps --import ./dist/telemetry.js dist/main.worker.js`; migrations no release: `node node_modules/@liame/database/dist/cli/migrate.js` com `DATABASE_URL_OWNER`. `--build-arg APP_VERSION=<commit>` aparece no `/health`.
- **Web** (`apps/web/Dockerfile`): Next standalone, `node apps/web/server.js`, porta 3000. `--build-arg NEXT_PUBLIC_API_URL=https://<api>` fixa o endereço da API no build (**P**): o navegador fala direto com a API, que guarda a sessão no próprio cookie (httpOnly, `SameSite=Lax`); por isso o web e a API ficam no mesmo site (subdomínios do mesmo domínio) e a origem do web entra em `APP_URL`. Sem o argumento, vale `http://localhost:3001` (desenvolvimento).

## Banco e fila

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `DATABASE_URL` **P S** | Conexão da aplicação (papel `liame_app`, sem BYPASSRLS; pooler em modo transação serve) | — |
| `DATABASE_URL_JOBS` **P S** | Conexão do pg-boss no worker (direta ou pooler em modo **sessão**: LISTEN/NOTIFY, ADR-005) | — |
| `PGBOSS_SCHEMA` | Schema do pg-boss conferido no `/health/ready` | `pgboss` |

## Aplicação

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `NODE_ENV` **P** | `production` liga as travas de produção abaixo | `development` |
| `PORT` | Porta da API | `3001` |
| `TRUST_PROXY_HOPS` **P** | Quantos proxies confiar para achar o IP real (Cloudflare + EasyPanel) | `0` |
| `APP_URL` **P** | Origem do webapp: links dos e-mails e checagem de origem das mutações | `http://localhost:3000` |
| `ALLOWED_ORIGINS` | Outras origens aceitas em mutações, separadas por vírgula | vazio |
| `COOKIE_SECURE` | Cookie só por HTTPS | `true` em produção |
| `BREACHED_PASSWORD_CHECK` | Checagem de senha vazada (HIBP, k-anonimato) | `on` |
| `TERMS_VERSION` **P** | Versão **publicada** dos Termos de Uso e da Política de Privacidade; o cadastro e o convite gravam a que a pessoa aceitou (migration 0016). Em produção, sem ela a API não sobe (A0-6) | `rascunho-2026-09-25` fora de produção |
| `TERMS_URL` · `PRIVACY_URL` **P** | Endereços públicos dos termos e da política (links das telas de cadastro) | `https://agencialiame.com/termos` · `/privacidade` |
| `MAIL_TRANSPORT` **P** | `ses` em produção (Amazon SES São Paulo, D-A1-4); `memoria` é recusado em produção | `memoria` |

## Cofre (ADR-011, ADR-014)

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `KEY_PROVIDER` **P** | `aws-kms` em produção (o `local` é recusado) | `local` |
| `AWS_REGION` | Região do KMS | `sa-east-1` |
| `AWS_KMS_KEKS` **P** | `1:alias/liame-kek-v1,2:alias/liame-kek-v2` | — |
| `LIAME_KEK_VERSION` | Versão da chave mestra usada para cifrar (as outras só decifram) | a maior |
| `LIAME_KEK_LOCAL` **S** | Só desenvolvimento e testes: `1:<32 bytes em base64>` | — |

## Eventos e webhooks (ADR-004)

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `WEBHOOK_ALLOW_PRIVATE_NETWORK` | Webhook de saída para rede privada/loopback. Só desenvolvimento e testes; `true` é recusado em produção (SSRF) | `false` |
| `INBOX_SECRETS` **S** | Provedores da inbox e seus segredos Standard Webhooks: `regem:whsec_...,regemcast:whsec_...`. Provedor fora da lista recebe 404 | vazio |

## Auditoria e âncora (ADR-011, security-model §7)

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `AUDIT_ANCHOR_SALT` **P S** | Sal interno da raiz diária (16+ caracteres). Não muda depois de ancorar: a verificação dos dias passados depende dele | fixo e público fora de produção |
| `AUDIT_ANCHOR_SIGNING_KEY` **P S** | Chave ECDSA P-256 (PEM PKCS#8; numa linha, com `\n`) que assina a declaração publicada no Rekor | — |
| `REKOR_URL` **P** | Log Rekor v2. O shard muda: conferir o `SigningConfig` da Sigstore (base §13.3). Hoje: `https://log2025-1.rekor.sigstore.dev` | — |
| `TSA_URL` **P** | Carimbo RFC 3161. Ex.: `https://timestamp.sigstore.dev/api/v1/timestamp` | — |

Gerar a chave de assinatura: `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ancora.pem` (guardar fora do git; publicar a chave pública junto com a política de auditoria).

## Collector (ADR-010)

`infra/otel-collector.yaml` roda no contêiner do OpenTelemetry Collector (contrib). A API e o worker exportam para ele (`OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318`).

| Variável (no contêiner do Collector) | Para quê |
| --- | --- |
| `GRAFANA_OTLP_ENDPOINT` **P** | Gateway OTLP do Grafana Cloud da região escolhida |
| `GRAFANA_OTLP_AUTH` **P S** | `base64(instance_id:token)` do Grafana Cloud |

Depois de mudar o arquivo: `otelcol-contrib validate --config infra/otel-collector.yaml`.

## Telemetria (ADR-010)

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `OTEL_SERVICE_NAME` | Nome do serviço nos traces | `liame-api` / `liame-worker` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Coletor OTLP (Grafana Cloud, E8) | sem exportar |
| `OTEL_TRACES_EXPORTER` | `none` desliga | — |
| `APP_VERSION` | Versão exibida no `/health` (a imagem de contêiner define na E9) | `dev` |
