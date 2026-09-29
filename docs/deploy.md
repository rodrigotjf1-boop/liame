# Deploy do Liame — roteiro de produção

Ordem: **pré-requisitos → Cloudflare → EasyPanel (API, worker, web) → conferência**. Os valores sem
segredo estão aqui; os segredos vão **só** do gerenciador de senhas do dono para o painel (nunca para o
git, o chat ou um arquivo). Variáveis e o que cada uma faz: `docs/configuracao.md`.

## 0. Pré-requisitos

| Item | Situação (28/09/2026) |
| --- | --- |
| Banco: Supabase São Paulo, migrations aplicadas e conferidas | ✅ 0001–0020 (`configuracao.md`, "Banco na nuvem") |
| AWS: chave mestra no KMS, usuário `liame-sistema` com `liame-sistema-kms` e `liame-sistema-ses` | ✅ |
| SES: domínio verificado; saída do sandbox | ✅ domínio · ⏳ resposta da AWS |
| Termos, privacidade e exclusão de dados publicados no site | ⏳ a API não sobe em produção sem `TERMS_VERSION` e os endereços |
| Apps da Meta e do Google (em teste) | ✅ |

**Migration nova sempre antes do merge:** com implantação automática, o merge sobe o código na hora. Uma
migration nova é aplicada e conferida na nuvem **antes** de mesclar o PR que depende dela.

## 1. Onde roda

- **Painel:** `https://painel.dmstecnologias.com` (VPS do Brasil, decisão D3), **projeto `liame`**, separado
  dos projetos das landings e do RegemCast.
- **Serviços** (uma imagem para API e worker, ADR-002):

| Serviço | Dockerfile | Porta | Domínio |
| --- | --- | --- | --- |
| `liame-api` | `apps/server/Dockerfile` | 3001 | `https://api.agencialiame.com` |
| `liame-worker` | `apps/server/Dockerfile` + comando do worker | — (sonda interna na 3001) | nenhum |
| `liame-web` | `apps/web/Dockerfile` | 3000 | `https://app.agencialiame.com` |

O Collector do OpenTelemetry entra quando a conta do Grafana Cloud existir (`infra/otel-collector.yaml`);
até lá os processos não exportam (sem `OTEL_EXPORTER_OTLP_ENDPOINT`).

## 2. Cloudflare (zona `agencialiame.com`, conta própria da Liame)

A zona já existe (landing no ar), com SSL **Full (strict)** e Always Use HTTPS.

| Tipo | Nome | Conteúdo | Proxy |
| --- | --- | --- | --- |
| A | `api` | IP da VPS do Brasil (o mesmo do `@`) | Proxied |
| A | `app` | IP da VPS do Brasil | Proxied |

- Subdomínio de **primeiro nível** (o certificado universal da Cloudflare não cobre `x.y.agencialiame.com`).
- **Nenhum AAAA** para a origem (ela só aceita as faixas IPv4 da Cloudflare no firewall da Hostinger).
- A regra de limite `limite-landing` já filtra por host (`agencialiame.com` e `www`): não pega `api` nem `app`.
  O limite por usuário da API é dela mesma (Postgres); a Cloudflare fica com o grosso.
- Bot Fight Mode **desligado** na zona (ele desafia chamadas de máquina, como a volta do OAuth e os webhooks).

## 3. EasyPanel

Menus em português, como aparecem no painel. Em cada serviço: **Fonte → Github**, repositório
`rodrigotjf1-boop/liame`, ramo `main`, caminho de build `/` (a raiz: o build precisa do monorepo inteiro).

### 3.1 `liame-api`

1. **+ Serviço → App** → `liame-api`.
2. **Fonte**: como acima. **Construção → Dockerfile** → `apps/server/Dockerfile`.
3. **Ambiente** (tabela da seção 4, coluna API).
4. **Domínios** → `https://api.agencialiame.com/` → porta **3001**.
5. **Implantar**. Conferir: `https://api.agencialiame.com/health` responde `{"status":"ok",…,"version":"<commit>"}`
   e `/health/ready` responde 200 com a última migration (`0020_vigia`).

### 3.2 `liame-worker`

1. **+ Serviço → App** → `liame-worker`. Fonte e Dockerfile iguais aos da API.
2. **Implantações** (Deploy) → **comando** (sobrescreve o da imagem): `node --enable-source-maps --import ./dist/telemetry.js dist/main.worker.js`.
   A documentação do EasyPanel põe o comando no painel de implantação; o nome exato do campo em português se confere no print.
3. **Ambiente**: tabela da seção 4, coluna worker. **Sem domínio**.
4. **Implantar**. Conferir nos logs `worker no ar`. A sonda de vida do worker responde `/health` só no
   `127.0.0.1` do contêiner: é o que o HEALTHCHECK da imagem consulta (sem ela, o contêiner ficaria
   "unhealthy" e seria reiniciado em ciclo).

### 3.3 `liame-web`

1. **+ Serviço → App** → `liame-web`. **Construção → Dockerfile** → `apps/web/Dockerfile`.
2. **Ambiente**: `NEXT_PUBLIC_API_URL=https://api.agencialiame.com`. O EasyPanel passa as variáveis do
   serviço ao build (documentação oficial): o endereço da API fica fixado no código do navegador e na CSP.
   Trocar o endereço = implantar de novo.
3. **Domínios** → `https://app.agencialiame.com/` → porta **3000**.
4. **Implantar**. Conferir: `https://app.agencialiame.com/entrar` abre, e o console do navegador não mostra
   bloqueio de CSP nem chamada a `localhost`.

## 4. Variáveis

**S** = segredo (só no painel, vindo do gerenciador de senhas). `—` = não se aplica ao serviço.

| Variável | API | worker | Valor / origem |
| --- | --- | --- | --- |
| `APP_URL` | ✔ | ✔ | `https://app.agencialiame.com` |
| `API_URL` | ✔ | ✔ | `https://api.agencialiame.com` |
| `TRUST_PROXY_HOPS` | ✔ | — | `2` (Cloudflare + proxy do EasyPanel). Conferir depois na tela Segurança da conta: o IP mostrado é o de quem acessou, não o da Cloudflare |
| `DATABASE_URL` **S** | ✔ | ✔ | `liame_app`, pooler em **transação** (6543), `sslmode=verify-full&sslrootcert=/app/certs/supabase-ca.crt` |
| `DATABASE_URL_JOBS` **S** | — | ✔ | `liame_owner`, pooler em **sessão** (5432), mesmo SSL |
| `KEY_PROVIDER` | ✔ | ✔ | `aws-kms` |
| `AWS_REGION` | ✔ | ✔ | `sa-east-1` |
| `AWS_KMS_KEKS` | ✔ | ✔ | `1:alias/liame-kek-v1` |
| `AWS_ACCESS_KEY_ID` · `AWS_SECRET_ACCESS_KEY` **S** | ✔ | ✔ | chave de acesso do `liame-sistema` (uma para os dois serviços; criada na hora, direto no painel) |
| `MAIL_TRANSPORT` | ✔ | ✔ | `ses` |
| `MAIL_FROM` | ✔ | ✔ | `Liame <nao-responda@agencialiame.com>` |
| `AUDIT_ANCHOR_SALT` **S** | ✔ | ✔ | gerado uma vez (seção 5); **não muda depois de ancorar** |
| `AUDIT_ANCHOR_SIGNING_KEY` **S** | ✔ | ✔ | chave ECDSA P-256 numa linha (seção 5) |
| `REKOR_URL` | ✔ | ✔ | `https://log2025-1.rekor.sigstore.dev` (conferir o shard vigente no SigningConfig da Sigstore) |
| `TSA_URL` | ✔ | ✔ | `https://timestamp.sigstore.dev/api/v1/timestamp` |
| `TERMS_VERSION` | ✔ | ✔ | a versão publicada no site (ex.: `2026-09-30`) |
| `TERMS_URL` · `PRIVACY_URL` | ✔ | ✔ | `https://agencialiame.com/termos` · `https://agencialiame.com/privacidade` |
| `META_APP_ID` · `META_LOGIN_CONFIG_ID` | ✔ | ✔ | `1399495602273174` · `1068233099319648` |
| `META_APP_SECRET` **S** | ✔ | ✔ | Configurações do app → Básico → Chave Secreta do app |
| `GOOGLE_OAUTH_CLIENT_ID` | ✔ | ✔ | `285693801008-armp76vqm8543v88bhcd19um2k1vitnq.apps.googleusercontent.com` |
| `GOOGLE_OAUTH_CLIENT_SECRET` **S** | ✔ | ✔ | a chave ativa do cliente "Liame API" (gerenciador de senhas) |

`NODE_ENV=production`, a porta e a versão (`GIT_SHA` do EasyPanel) vêm da imagem. Não definir
`LIAME_KEK_LOCAL`, `COOKIE_SECURE=false`, `WEBHOOK_ALLOW_PRIVATE_NETWORK` nem endereços de plataforma
(a API recusa subir com eles em produção).

## 5. Segredos gerados pelo dono (uma vez, no computador dele)

Em PowerShell (5.1 ou 7), numa pasta temporária; nada aparece na tela, vai direto para a área de
transferência (comandos testados em 28/09/2026 no Windows PowerShell 5.1):

```powershell
# Sal da âncora: 32 bytes aleatórios em base64 → colar no gerenciador de senhas e no painel
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b) | Set-Clipboard

# Chave de assinatura da âncora (precisa do OpenSSL, que vem com o Git para Windows)
& "C:\Program Files\Git\usr\bin\openssl.exe" genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out ancora.pem
((Get-Content ancora.pem -Raw).Trim() -replace '\r?\n', '\n') | Set-Clipboard   # uma linha, com \n literal
& "C:\Program Files\Git\usr\bin\openssl.exe" pkey -in ancora.pem -pubout -out ancora-publica.pem
```

A chave privada vai para o gerenciador de senhas e para o painel; depois, `ancora.pem` é apagado. A
**pública** (`ancora-publica.pem`) não é segredo: entra no repositório junto com a política de auditoria,
para qualquer pessoa conferir as âncoras.

## 6. Depois de no ar

- Conferência de ponta a ponta: cadastro com e-mail real (chega pelo SES), segundo fator, conectar a Meta
  com o perfil testador e o Google com a conta de teste, primeira leitura.
- Implantação automática: webhook do GitHub apontando para `https://painel.dmstecnologias.com/...` (nunca
  o IP cru da VPS). Conferir as entregas com
  `gh api repos/rodrigotjf1-boop/liame/hooks --jq '.[] | "\(.active) \(.config.url)"'`.
