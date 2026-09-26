# Configuração do servidor (API e worker)

Variáveis de ambiente lidas por `apps/server`. Valor errado derruba a subida (validação no boot), nunca a requisição. Segredos só pelo painel da hospedagem ou pelo cofre, nunca no git.

Legenda: **P** = obrigatória em produção · **S** = segredo.

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

## Telemetria (ADR-010)

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `OTEL_SERVICE_NAME` | Nome do serviço nos traces | `liame-api` / `liame-worker` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Coletor OTLP (Grafana Cloud, E8) | sem exportar |
| `OTEL_TRACES_EXPORTER` | `none` desliga | — |
| `APP_VERSION` | Versão exibida no `/health` (a imagem de contêiner define na E9) | `dev` |
