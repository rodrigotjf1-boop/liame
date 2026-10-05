# Configuração do servidor (API e worker)

Variáveis de ambiente lidas por `apps/server`. Valor errado derruba a subida (validação no boot), nunca a requisição. Segredos só pelo painel da hospedagem ou pelo cofre, nunca no git.

Legenda: **P** = obrigatória em produção · **S** = segredo.

## Imagens

- **Servidor** (`apps/server/Dockerfile`): o mesmo para API e worker. API é o padrão; worker: `node --enable-source-maps --import ./dist/telemetry.js dist/main.worker.js` (responde `/health` só no 127.0.0.1 do contêiner, para o HEALTHCHECK da imagem); migrations no release: `node node_modules/@liame/database/dist/cli/migrate.js` com `DATABASE_URL_OWNER`. A versão no `/health` é o `GIT_SHA` que o EasyPanel passa ao build (ou `--build-arg APP_VERSION=<commit>`). Roteiro de produção: `docs/deploy.md`.
- **Web** (`apps/web/Dockerfile`): Next standalone, `node apps/web/server.js`, porta 3000. `--build-arg NEXT_PUBLIC_API_URL=https://<api>` fixa o endereço da API no build (**P**): o navegador fala direto com a API, que guarda a sessão no próprio cookie (httpOnly, `SameSite=Lax`); por isso o web e a API ficam no mesmo site (subdomínios do mesmo domínio) e a origem do web entra em `APP_URL`. Sem o argumento, vale `http://localhost:3001` (desenvolvimento).

## Banco e fila

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `DATABASE_URL` **P S** | Conexão da aplicação (papel `liame_app`, sem BYPASSRLS; pooler em modo transação serve) | — |
| `DATABASE_URL_JOBS` **P S** | Conexão do pg-boss no worker (direta ou pooler em modo **sessão**: LISTEN/NOTIFY, ADR-005) | — |
| `DATABASE_URL_OWNER` **S** | Só no passo de migrations (papel `liame_owner`, pooler em modo **sessão**) | — |
| `PGBOSS_SCHEMA` | Schema do pg-boss conferido no `/health/ready` | `pgboss` |

### Banco na nuvem (Supabase São Paulo)

Projeto `liame` (ref `wzsajknjgcvbmtyonwnn`, `sa-east-1`). Papéis `liame_owner` e `liame_app` criados pelo dono no SQL Editor
(sem superusuário, sem BYPASSRLS; `liame_owner` com `connect, create, temporary` no banco `postgres`, `liame_app` só com `connect`).
A conexão direta do Supabase é só IPv6 sem o complemento de IPv4: tudo passa pelo **pooler compartilhado**, com o usuário no
formato `<papel>.<ref>` (documentação oficial do Supabase, conferida em 27/09/2026). O certificado do Supabase não é de autoridade
pública: as URLs usam `sslmode=verify-full` com o certificado raiz (`infra/supabase/prod-ca-2021.crt`, "Supabase Root 2021 CA",
vence em 26/04/2031), que a imagem do servidor copia para `/app/certs/supabase-ca.crt`. Sem ele, o pg recusa a conexão
(`SELF_SIGNED_CERT_IN_CHAIN`); com ele, a verificação passa (testado em 27/09/2026).

| Variável | Papel | Porta (modo) | Formato |
| --- | --- | --- | --- |
| `DATABASE_URL` | `liame_app` | 6543 (transação) | `postgresql://liame_app.wzsajknjgcvbmtyonwnn:<senha>@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=verify-full&sslrootcert=/app/certs/supabase-ca.crt` |
| `DATABASE_URL_JOBS` | `liame_owner` | 5432 (sessão) | mesmo host, `liame_owner.wzsajknjgcvbmtyonwnn`, porta 5432 |
| `DATABASE_URL_OWNER` | `liame_owner` | 5432 (sessão) | igual ao `DATABASE_URL_JOBS` |

Senhas só alfanuméricas (símbolo exige codificar a URL). Migrations aplicadas pelo dono, do computador dele, com um `.env.nuvem`
temporário (fora do git, apagado depois): `node --env-file=.env.nuvem packages/database/dist/cli/migrate.js --url-env NUVEM_DATABASE_URL_OWNER`
(no computador, `sslrootcert` aponta para o arquivo em `infra/supabase/`). Depois de aplicar, rodar
`packages/database/scripts/conferencia-catalogo.sql` no SQL Editor e no banco local com as mesmas migrations: o resultado precisa
ser idêntico (contagens, RLS forçado em todas as tabelas e as três assinaturas md5). Situação: **0001–0020 aplicadas e conferidas
em 27/09/2026** (55 tabelas, 582 colunas, 78 políticas).

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
| `MAIL_TRANSPORT` **P** | `ses` em produção (Amazon SES v2 em São Paulo, D-A1-4); `memoria` é recusado em produção. SES (28/09/2026): identidade `agencialiame.com` verificada (DKIM 2048 com 3 CNAME na Cloudflare; MAIL FROM `envio.agencialiame.com` com MX e SPF), pedido de saída do sandbox enviado (transacional). No sandbox, só chega a endereço verificado (por exemplo, `@agencialiame.com`) | `memoria` |
| `MAIL_FROM` **P** | Remetente, com ou sem nome, de um domínio verificado no SES. Obrigatória em produção com `ses` | `Liame <nao-responda@agencialiame.com>` |
| `AWS_REGION` | Região do SES e do KMS | `sa-east-1` |
| `SES_CONFIGURATION_SET` | Conjunto de configuração do SES (eventos de entrega, quando existir) | vazio |

## Plataformas de mídia (A2)

Os conectores só chamam estes endereços (o cliente compara a origem, ERR-026). Em produção precisam
ser os oficiais, senão a API não sobe; fora dela, os testes apontam para uma plataforma local.

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `META_GRAPH_URL` | Graph API / Marketing API da Meta | `https://graph.facebook.com` |
| `GOOGLE_ADS_URL` | Google Ads API (REST) | `https://googleads.googleapis.com` |
| `GA4_DATA_URL` · `GA4_ADMIN_URL` | GA4 Data API e Admin API | `https://analyticsdata.googleapis.com` · `https://analyticsadmin.googleapis.com` |
| `META_APP_SECRET` | Segredo do app da Meta (**da distribuição**, só no EasyPanel): assina cada chamada com `appsecret_proof` | vazio (sem assinatura) |

A versão de cada API não é variável: vem do Capability Registry (`connector_capability`, migration 0018).

**Câmbio de referência (A3, D-A3-14):** a PTAX de venda do Banco Central não tem variável nem credencial. O endereço (`olinda.bcb.gov.br`) é fixo no código, e o worker lê duas vezes por dia (fila `cambio-ptax`, 16:40 e 21:40 UTC). Os testes não chamam o Banco Central: a leitura é trocada por uma simulada.

### Apps OAuth (G3, da distribuição)

A empresa não cria app nem manuseia segredo: ela só autoriza. Os apps são do Liame, configurados no EasyPanel.
Sem as peças de um app, a plataforma aparece como "ainda indisponível" (503 `integracao-indisponivel`).

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `API_URL` **P** | Origem pública da API. O endereço de volta registrado nos dois apps é `API_URL` + `/v1/oauth/callback`. Em produção, com algum app configurado, só https | `http://localhost:3001` |
| `META_APP_ID` · `META_APP_SECRET` · `META_LOGIN_CONFIG_ID` | App da Meta e a configuração do Facebook Login for Business do tipo **token de usuário do sistema** (o segredo também assina as chamadas com `appsecret_proof`) | vazio (Meta indisponível) |
| `META_LOGIN_CONFIG_ID_ESCRITA` | **Outra** configuração do mesmo login, que também pede para gerenciar anúncios (`ads_management`; A4). Só a empresa com a flag `meta_write` ligada é mandada autorizar por ela; as outras seguem na de leitura, que não muda | vazio (todas autorizam pela de leitura) |
| `META_DIALOG_URL` | Página de autorização da Meta (oficial em produção) | `https://www.facebook.com` |
| `GOOGLE_OAUTH_CLIENT_ID` · `GOOGLE_OAUTH_CLIENT_SECRET` | Cliente OAuth do tipo "aplicativo da Web" no projeto Google Cloud da distribuição (Google Ads API habilitada; escopos `adwords` e `analytics.readonly`) | vazio (Google indisponível) |
| `GOOGLE_AUTH_URL` · `GOOGLE_TOKEN_URL` | Autorização e token do Google (oficiais em produção) | `https://accounts.google.com` · `https://oauth2.googleapis.com` |

Enquanto o app do Google estiver em **modo de teste**, o refresh token vence em 7 dias [S]: a conexão mostra a data (`refresh_expires_at`) e a tela avisa antes.

**Situação dos apps (28/09/2026, configurados com o dono; os segredos ficam só no gerenciador de senhas dele e no EasyPanel):**

| Plataforma | O que existe | Valores não secretos |
| --- | --- | --- |
| Meta | App **Liame**, tipo Empresa, no portfólio verificado da empresa, em **desenvolvimento**; produtos API de Marketing e Facebook Login for Business; URI de volta `https://api.agencialiame.com/v1/oauth/callback` (modo estrito); configuração "Liame - leitura de anúncios": variação Geral, token de usuário do sistema que **não expira**, ativo Contas de anúncios obrigatório com a tarefa **ANALYZE** (só leitura) e a permissão **`ads_read`** | `META_APP_ID=1399495602273174` · `META_LOGIN_CONFIG_ID=1068233099319648` |
| Google | Projeto `liame-agencia` (duas contas proprietárias); APIs Google Ads, Analytics Data e Analytics Admin ativas; Google Auth Platform "Liame", **Externo, em teste**, escopos `adwords` e `analytics.readonly`; cliente "Liame API" (aplicativo da Web) com a mesma URI de volta; Google Ads API no nível **Explorer** | `GOOGLE_OAUTH_CLIENT_ID=285693801008-armp76vqm8543v88bhcd19um2k1vitnq.apps.googleusercontent.com` |

Falta, nas duas: publicar a política de privacidade, os termos e as instruções de exclusão de dados no site; testadores (contas do restaurante de testes); ir ao vivo (Meta: acesso avançado e análise do app; Google: verificação da marca e do app, nível Básico). Para executar ações (A4), a Meta ganha uma **segunda** configuração, de escrita (`META_LOGIN_CONFIG_ID_ESCRITA`); a de leitura fica como está, porque a análise de `ads_read` usa o login com ela.

## Produtos DMS (A2.5, ADR-019)

Contratos em `docs/integracoes/`. O endereço de cada produto é da distribuição, nunca informado pelo usuário.

| Variável | O que é | Padrão |
| --- | --- | --- |
| `REGEM_API_URL` | Rotas de integração do Regem (só da nuvem); em produção, só o oficial | `https://api.dmsregem.com/api/v1/integracao` |
| `REGEM_AUTH_URL` | Onde o presidente da loja autoriza o Liame (C1b); em produção, só o oficial | `https://app.dmsregem.com` |
| `REGEM_CLIENT_ID` · `REGEM_CLIENT_SECRET` | Credencial do Liame como cliente do Regem, para trocar o código pelo token da loja. Sem elas, "Conectar Regem" responde 503 e só vale o registro pela distribuição. O `REGEM_CLIENT_ID` é `liame`; o segredo (32 caracteres ou mais) é o MESMO valor posto no Regem em `INTEGRACAO_LIAME_CLIENT_SECRET` (ambiente do `regem-api`). Com as duas, `GET /v1/connections` passa a listar `regem` em `available` e a tela oferece "Conectar o Regem". | vazio |
| `REGEMCAST_API_URL` | API do RegemCast: o conector chama `{valor}/mcp` (MCP 2026-07-28, conversas abertas por anúncio, F7; contrato `integracoes/regemcast.md` v2); em produção, só o oficial e com `https`. Vazio = nenhuma conversa é lida | `https://castapi.dmsregem.com/api/v1` |

**Piloto (D-A2.5-4):** a distribuição emite o token da loja no Regem e o grava no cofre do Liame, dentro do contêiner da API. O token entra pela entrada padrão, nunca pela linha de comando:

```bash
node dist/scripts/conectar-produto.js --empresa <uuid da empresa> --marca <uuid da marca> --produto regem < tokens.txt
```

Depois, a pessoa liga a loja em **Contas conectadas**; a loja do Liame dela é criada ali, com o nome e o fuso da loja do Regem (#71, ERR-047). Revogar lá apaga o token do cofre e o revoga no Regem.

**Ligar uma função para uma empresa (ADR-012):** as funções de escrita nascem desligadas (`regem_write`, `meta_write`, `google_write`…). Quem liga é a distribuição, por empresa, com o papel dono do banco (`liame_owner`, o mesmo das migrations): o papel do aplicativo não grava regra de flag. O endereço do banco vem do ambiente, pelo nome da variável, e fica na auditoria da empresa quem decidiu e por quê:

```bash
node --env-file=.env.nuvem apps/server/dist/scripts/ligar-flag.js --url-env NUVEM_DATABASE_URL_OWNER \
  --flag regem_write --empresa <uuid da empresa> --ligar --por "Nome" --motivo "piloto do cupom de campanha"
```

Para desligar, `--desligar` no lugar de `--ligar` (a regra da empresa é apagada e ela volta ao padrão da flag). Vale em até 15 segundos, na API e no worker. Para `regem_write` valer numa loja, a loja também precisa ter liberado "Criar cupom de campanha" na autorização do Regem.

**`meta_write` (A4):** com a flag ligada para a empresa, as ferramentas de anúncio (X2: verba diária, pausar e retomar) passam a aceitar pedidos na Meta; cada pedido espera a aprovação de uma pessoa com o código do app, e aumentar ou retomar pedem o teto por ação e o envelope do mês da empresa. Com ela desligada, o pedido é recusado antes de qualquer leitura na Meta. Para valer numa conta, a autorização da Meta precisa incluir a permissão de gerenciar anúncios (`ads_management`): com a flag ligada e a configuração de escrita definida (`META_LOGIN_CONFIG_ID_ESCRITA`), **Conectar** em Contas conectadas manda a empresa autorizar por essa configuração, e a autorização nova assume as contas que a empresa já tinha (a antiga, sem conta nenhuma, é encerrada). A auditoria do pedido de conexão guarda por qual acesso a empresa foi mandada (`leitura` ou `escrita`). Sem a permissão, a validação da Meta recusa a mudança e o pedido falha com o motivo, sem escrever nada.

**`modo_aprovacao` (A4, X3):** nasce desligada para todos, e sem ela nada muda. Com ela ligada para a empresa (`--flag modo_aprovacao`), a recomendação nova de uma ação que a política põe em Aprovação para o Gestor de tráfego (regra de autonomia com `actor: agent` e `mode: APPROVAL`, por conta) vira um pedido feito por ele na rodada da manhã. O pedido espera a aprovação de uma pessoa com o código do app, e só existe onde a escrita também está ligada (`meta_write`). Com a flag, o sistema também passa a **propor** a passagem de Sugerir para Aprovação (quando os cinco portões da sombra e os dos pedidos passam), e uma pessoa com `politicas.gerenciar` aprova ou recusa; voltar é um passo por vez. **Ligar só depois das telas do P9 e do P11:** a tela de Aprovações de hoje não diz que um pedido veio do funcionário.

## IA (A3, ADR-006)

Os funcionários de IA nascem desligados para todas as empresas (flag `ia`). Sem a chave do fornecedor, a API e o worker sobem normalmente e tudo o que depende de IA cai no caminho sem IA.

**Para a IA funcionar numa empresa, quatro coisas precisam estar certas, nesta ordem:**

1. **A chave do fornecedor** (`ANTHROPIC_API_KEY`) no ambiente do `liame-api` e do `liame-worker`. No painel da Anthropic, a chave é de uma **conta de serviço**, presa a um **workspace só da produção**, com **teto de gasto mensal** no workspace (o workspace padrão não aceita teto). Chave sem workspace exige um cabeçalho a mais em toda chamada e devolve 400 sem ele: a do Liame nasce presa ao workspace. Os evals com modelo de verdade usam **outra** chave, de outro workspace, com teto próprio, e ela nunca vai para o ambiente de produção.
2. **A rota de modelo da tarefa** em `liame.ai_model_route`, publicada por migration com a nota do eval da tarefa (a 0046 publicou as cinco: `explicar_resultados`, `conversa_lia`, `estrategista_plano`, `pesquisador_pagina` e `compliance_revisao`, todas no Sonnet 5.5 com esforço baixo). Sem rota, a tarefa segue no caminho sem IA. Trocar o modelo, o esforço ou o prompt de uma tarefa pede o eval dela de novo e uma versão nova da rota.
3. **O aviso à empresa e os documentos.** A Anthropic é suboperadora "prevista": o Contrato de Tratamento de Dados (cláusula 6.2) pede aviso com 30 dias de antecedência antes de ela tratar dados do cliente, e a Política de Privacidade publicada no site precisa dizer que a IA é ligada empresa por empresa (seção 7) e trazer a Anthropic entre os fornecedores em uso (seção 8). No dia em que a `ia` é ligada para a primeira empresa, os textos de `docs/juridico` mudam no mesmo PR, e o site é publicado com a versão nova (`TERMS_VERSION`).
4. **A flag `ia` da empresa**, ligada pela distribuição (comando `ligar-flag`, com quem decidiu e o motivo na auditoria da empresa). O revisor de IA do Compliance pede também a flag `revisor`.

| Variável | O que é | Padrão |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` **S** | Chave de API da Anthropic, da conta da distribuição (com limite de gasto definido no painel deles). Vai no ambiente do `liame-api` **e** do `liame-worker`. O endereço da API é fixo no código | vazio |
| `AI_INFERENCE_GEO` | Onde o modelo roda: `us` (só Estados Unidos, preço 10% maior) ou `global` (padrão do fornecedor: qualquer região disponível). Decisão D-A3-13 do `plano-a3.md`. Com `us`, o modelo que não aceita a opção (anterior ao Claude 4.6, como o Haiku 4.5) **não é chamado**: a tentativa fica registrada com o erro `fora_da_regiao` e a rota segue para a reserva | `us` |
| `AI_DAILY_LIMIT_USD` · `AI_MONTHLY_LIMIT_USD` | Teto de custo de IA **por empresa**, em dólar, para a empresa que não tem um próprio em `ai_budget`. Em 70% avisa no log, em 80% troca para o modelo econômico da rota, em 100% barra. O do mês não pode ser menor que o do dia | `2` · `20` |
| `AI_USER_HOURLY_CALLS` | Chamadas a modelo que uma pessoa pode disparar por hora. Na Conversa, cada resposta da LIA usa de uma a cinco (uma por rodada de leituras) | `30` |
| `AI_CONVERSATION_MAX_ANSWERS` | Respostas da LIA numa mesma conversa: chegou nisso, a pessoa começa outra (limite por conversa, A3-9). Vai no `liame-api` | `20` |

**Ligar para uma empresa:** o mesmo comando das outras flags, com `--flag ia` (seção Produtos DMS). Além da flag, a tarefa precisa de uma rota ativa em `ai_model_route` (publicada depois do eval, I3) e o modelo, de preço em `ai_model_price`: modelo sem preço cadastrado não roda. **Parar tudo:** kill switch de provider `ai` (distribuição) ou a parada da própria empresa.

**Revisor de IA do Compliance (A3, I9):** a flag `revisor` nasce desligada para todos, e sem ela nada muda: o texto da IA passa pelas regras de texto do código e aparece. Com ela ligada para a empresa (`--flag revisor`), todo texto que a IA escreve passa também por um revisor de IA (tom, clareza e alegações) antes de aparecer, e **o revisor vira obrigatório**: precisa de uma rota ativa para a tarefa `compliance_revisao` (publicada depois do eval dela) e de preço para o modelo; sem isso, ou se ele não responder, a empresa vê o texto do sistema no lugar do da IA. Por isso a ordem é: eval da tarefa aprovado, rota publicada e só então a flag. O `ligar-flag --flag ia` lembra que o revisor é uma flag à parte. Para desligar o revisor sem desligar a IA, `--flag revisor --desligar` (vale em até 15 segundos).

**Sombra de verdade (A3, I5):** a flag `sombra` nasce desligada e não depende da chave do fornecedor (a primeira sombra é por regra, sem modelo). Com ela ligada para a empresa (`--flag sombra`), o worker registra uma vez por dia, depois da leitura da manhã, o que o Liame recomendaria para cada campanha e, depois, compara com o que aconteceu. Nada aparece para a empresa ainda (a tela é a Sua equipe, I13) e nada é executado em plataforma nenhuma.

**Revisão da semana (A3, I7):** o worker gera a revisão de cada marca com as vendas conectadas toda segunda-feira, a partir das 5h no fuso da loja; isso não depende de flag nem da chave do fornecedor (sem a LIA, a leitura é a do sistema). O **envio por e-mail** depende da flag `revisao_email`, que nasce desligada: com ela ligada para a empresa (`--flag revisao_email`), a revisão sai a partir das 7h para o Dono, os Administradores e quem só recebe relatórios. A flag vale para a revisão gerada depois de ligada; a de uma semana já gerada sem o envio não é enviada depois. O endereço do link no e-mail é o `APP_URL`. O e-mail leva duas versões da mesma mensagem, texto e HTML; as duas imagens da versão em HTML (a marca e o rosto da LIA) também vêm do `APP_URL` (`/email/liame-logo.png` e `/email/lia.png`, arquivos do webapp), sem identificador de quem recebe.

**Conferência do custo (A3-2):** o total do mês em `ai_usage.cost_usd_micros` é comparado com a fatura do fornecedor; a diferença esperada vem de chamada cortada pelo prazo (o fornecedor pode cobrar o que já tinha gerado).

## Cofre (ADR-011, ADR-014)

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `KEY_PROVIDER` **P** | `aws-kms` em produção (o `local` é recusado) | `local` |
| `AWS_REGION` | Região do KMS | `sa-east-1` |
| `AWS_KMS_KEKS` **P** | `1:alias/liame-kek-v1,2:alias/liame-kek-v2` | — |
| `LIAME_KEK_VERSION` | Versão da chave mestra usada para cifrar (as outras só decifram) | a maior |
| `LIAME_KEK_LOCAL` **S** | Só desenvolvimento e testes: `1:<32 bytes em base64>` | — |
| `AWS_ACCESS_KEY_ID` · `AWS_SECRET_ACCESS_KEY` **P S** | Chave de acesso do usuário IAM `liame-sistema` (criada no EasyPanel, nunca em arquivo) | — |

**Situação na AWS (28/09/2026):** conta `liame-prod` (472158500701), root com MFA. Chave mestra `alias/liame-kek-v1` em `sa-east-1`, simétrica, rotação anual. Usuário `liame-sistema` sem console, com a política `liame-sistema-kms`: `GenerateDataKey` e `Decrypt` nas chaves da conta (pelo ARN, não pela etiqueta: a etiqueta leva até 5 minutos para valer e o cofre usa a chave da empresa logo depois de criá-la); `CreateKey` só em `sa-east-1`, `SYMMETRIC_DEFAULT`/`ENCRYPT_DECRYPT` e com a etiqueta `liame:tenant`; `ScheduleKeyDeletion` só em chave com essa etiqueta e com 30 dias de espera; **negado** apagar, desativar, etiquetar ou mudar a política da chave mestra. Envio de e-mail: política `liame-sistema-ses` no mesmo usuário, só `ses:SendEmail` pela API v2 e só com o remetente do serviço:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EnviarEmailDoServico",
      "Effect": "Allow",
      "Action": "ses:SendEmail",
      "Resource": "*",
      "Condition": { "StringEquals": { "ses:FromAddress": "nao-responda@agencialiame.com", "ses:ApiVersion": "2" } }
    }
  ]
}
```

Devoluções permanentes e reclamações: a lista de supressão da conta vem ligada para as duas (conta criada depois de 25/11/2019); o SES aceita e não entrega para endereço suprimido. O Gmail não manda reclamação ao SES. Falha de envio não desfaz a operação: fica no log com o motivo.

## Eventos e webhooks (ADR-004)

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `WEBHOOK_ALLOW_PRIVATE_NETWORK` | Webhook de saída para rede privada/loopback. Só desenvolvimento e testes; `true` é recusado em produção (SSRF) | `false` |
| `PESQUISA_ALLOW_PRIVATE_NETWORK` | Página que o Pesquisador lê (I12) em rede privada/loopback ou por `http`. Só desenvolvimento e testes; `true` é recusado em produção (SSRF). Não precisa estar no EasyPanel | `false` |
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
