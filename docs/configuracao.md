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
| `GOOGLE_DATA_MANAGER_URL` | Data Manager API do Google: as vendas confirmadas (A5 · Y1) | `https://datamanager.googleapis.com` |
| `GOOGLE_BUSINESS_ACCOUNTS_URL` · `GOOGLE_BUSINESS_LOCATIONS_URL` · `GOOGLE_BUSINESS_REVIEWS_URL` · `GOOGLE_BUSINESS_PERFORMANCE_URL` | Perfil da Empresa no Google (A6 · Z1): as contas, as lojas, as avaliações e os números do perfil, cada um numa API. Em produção, só os endereços oficiais | `https://mybusinessaccountmanagement.googleapis.com` · `https://mybusinessbusinessinformation.googleapis.com` · `https://mybusiness.googleapis.com` · `https://businessprofileperformance.googleapis.com` |
| `SEARCH_CONSOLE_URL` | Search Console (A6 · Z3): os sites e as buscas que levaram a eles (`/webmasters/v3`). Em produção, só o endereço oficial | `https://searchconsole.googleapis.com` |
| `META_APP_SECRET` | Segredo do app da Meta (**da distribuição**, só no EasyPanel): assina cada chamada com `appsecret_proof` | vazio (sem assinatura) |

A versão de cada API não é variável: vem do Capability Registry (`connector_capability`, migration 0018).

**Câmbio de referência (A3, D-A3-14):** a PTAX de venda do Banco Central não tem variável nem credencial. O endereço (`olinda.bcb.gov.br`) é fixo no código, e o worker lê duas vezes por dia (fila `cambio-ptax`, 16:40 e 21:40 UTC). Os testes não chamam o Banco Central: a leitura é trocada por uma simulada.

### Apps OAuth (G3, da distribuição)

A empresa não cria app nem manuseia segredo: ela só autoriza. Os apps são do Liame, configurados no EasyPanel.
Sem as peças de um app, a plataforma aparece como "ainda indisponível" (503 `integracao-indisponivel`).

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `API_URL` **P** | Origem pública da API. O endereço de volta registrado nos dois apps é `API_URL` + `/v1/oauth/callback`, e o do aviso do Asaas, que o worker cria, é `API_URL` + `/v1/billing/asaas/webhook`. Em produção, com algum app configurado ou com o Asaas, só https | `http://localhost:3001` |
| `META_APP_ID` · `META_APP_SECRET` · `META_LOGIN_CONFIG_ID` | App da Meta e a configuração do Facebook Login for Business do tipo **token de usuário do sistema** (o segredo também assina as chamadas com `appsecret_proof`) | vazio (Meta indisponível) |
| `META_LOGIN_CONFIG_ID_ESCRITA` | **Outra** configuração do mesmo login, que também pede para gerenciar anúncios (`ads_management`; A4) e, desde 28/10/2026, publicar na Página e no Instagram (A6, Z5). Só a empresa com a flag `meta_write` ou a `social_write` (os posts; D-A6-63) ligada é mandada autorizar por ela; as outras seguem na de leitura, que não muda. Mudar campanha continua só com a `meta_write`. A conexão guarda por qual das duas a empresa autorizou (`oauth_connection.requested_access`): quem autorizou pela de leitura precisa conectar de novo para o Liame escrever | vazio (todas autorizam pela de leitura) |
| `META_DIALOG_URL` | Página de autorização da Meta (oficial em produção) | `https://www.facebook.com` |
| `GOOGLE_OAUTH_CLIENT_ID` · `GOOGLE_OAUTH_CLIENT_SECRET` | Cliente OAuth do tipo "aplicativo da Web" no projeto Google Cloud da distribuição (Google Ads API habilitada; escopos `adwords` e `analytics.readonly`; para a empresa com a flag `conversoes_google`, a autorização pede também `datamanager`, e o projeto precisa da Data Manager API ativa; para a empresa com a flag `perfil_google`, pede também `business.manage`, e o projeto precisa das APIs do Perfil da Empresa ativas e do acesso liberado pelo Google, que é por pedido) | vazio (Google indisponível) |
| `GOOGLE_AUTH_URL` · `GOOGLE_TOKEN_URL` | Autorização e token do Google (oficiais em produção) | `https://accounts.google.com` · `https://oauth2.googleapis.com` |

Enquanto o app do Google estiver em **modo de teste**, o refresh token vence em 7 dias [S]: a conexão mostra a data (`refresh_expires_at`) e a tela avisa antes. O app foi publicado em 07/10/2026: a autorização dada depois disso não tem esse prazo (`refresh_expires_at` nulo), e a tela diz "sem prazo de validade".

**Situação dos apps (28/09/2026, configurados com o dono; os segredos ficam só no gerenciador de senhas dele e no EasyPanel):**

| Plataforma | O que existe | Valores não secretos |
| --- | --- | --- |
| Meta | App **Liame**, tipo Empresa, no portfólio verificado da empresa, em **desenvolvimento**; produtos API de Marketing e Facebook Login for Business; URI de volta `https://api.agencialiame.com/v1/oauth/callback` (modo estrito); configuração "Liame - leitura de anúncios": variação Geral, token de usuário do sistema que **não expira**, ativo Contas de anúncios obrigatório com a tarefa **ANALYZE** (só leitura) e a permissão **`ads_read`**; configuração **"Liame - gestão de anúncios"** (de escrita, criada em 15/10/2026 e editada em 28/10/2026 para os posts, Z5): variação Geral, token de usuário do sistema que **não expira** (o Liame não renova o token da Meta), ativos Contas de anúncios **obrigatório** com as tarefas **ADVERTISE, ANALYZE e DRAFT, sem MANAGE** (sem tarefa marcada, a Meta dá MANAGE: finanças e permissões da conta), Páginas opcional (a campanha nova sai em nome de uma Página, D-A4-35) e Contas do Instagram opcional (desde 28/10/2026), permissões `ads_read`, `ads_management`, `pages_manage_ads`, `pages_show_list`, `pages_read_engagement` e, para os posts e os números deles, `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `pages_manage_posts` e `read_insights` (10). **Ao editar a configuração** (Login do Facebook para Empresas → o segundo "Configurações" do menu → Editar), a etapa Ativos traz as tarefas da conta de anúncios **vazias**: remarcar ADVERTISE, ANALYZE e DRAFT antes de salvar, senão vale MANAGE | `META_APP_ID=1399495602273174` · `META_LOGIN_CONFIG_ID=1068233099319648` · `META_LOGIN_CONFIG_ID_ESCRITA=3101769066695621` |
| Google | Projeto `liame-agencia` (duas contas proprietárias); APIs Google Ads, Analytics Data e Analytics Admin ativas; Google Auth Platform "Liame", **Externo, em produção desde 07/10/2026** (ainda sem a verificação do Google: quem autoriza vê o aviso de app não verificado, e vale o teto de 100 usuários; no branding, a página inicial, a Política de Privacidade e os Termos do site, sem logotipo, que exigiria a verificação), escopos `adwords` e `analytics.readonly`; cliente "Liame API" (aplicativo da Web) com a mesma URI de volta; Google Ads API no nível **Explorer** | `GOOGLE_OAUTH_CLIENT_ID=285693801008-armp76vqm8543v88bhcd19um2k1vitnq.apps.googleusercontent.com` |

Falta, nas duas: publicar a política de privacidade, os termos e as instruções de exclusão de dados no site; testadores (contas do restaurante de testes); ir ao vivo (Meta: o `ads_read` foi **aprovado na análise em 20/10/2026**; falta a análise do `ads_management` e ir ao vivo; Google: a marca foi verificada em 17/10/2026, falta a verificação do app e o nível Básico). Para executar ações (A4), a Meta ganha uma **segunda** configuração, de escrita (`META_LOGIN_CONFIG_ID_ESCRITA`, no ar desde 15/10/2026); a de leitura fica como está. O vídeo aprovado do `ads_read` foi gravado com a empresa do piloto, pelo login de escrita (que pede também `ads_management`), e as instruções ao analista dizem isso. Quem já estava conectado passa à escrita conectando a Meta de novo e confirmando a conta em "Escolher contas" (ERR-138).

## Cobrança pelo Asaas (A7, W2; D-A7-33)

As três vão na API e no worker. A chave e o token são da distribuição: só no painel da hospedagem, nunca no git nem no chat.

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `ASAAS_API_KEY` | A chave da conta do Liame no Asaas, do mesmo ambiente do `ASAAS_API_URL` (`$aact_hmlg_` no Sandbox, `$aact_prod_` na produção; a de outro ambiente não sobe). O Asaas a mostra uma vez só. Sem ela, o pagamento fica indisponível e o resto segue | vazio |
| `ASAAS_API_URL` | O ambiente do Asaas; em produção, só os dois oficiais (`https://api-sandbox.asaas.com/v3` e `https://api.asaas.com/v3`) | `https://api-sandbox.asaas.com/v3` |
| `ASAAS_WEBHOOK_TOKEN` | O token do aviso, de 32 a 255 letras, sem espaço, gerado pela distribuição; em produção, obrigatório com a chave. O worker cria o aviso do Liame no Asaas com ele (o próprio Liame cria o webhook pela API, W2a, parte 3a), e a API confere o que chega no cabeçalho `asaas-access-token`. Para trocar, mudar nos dois serviços: na subida, o worker leva o novo ao aviso do Asaas | vazio |

Com a chave e o token, o worker cria o aviso do Liame no Asaas (nome `Liame`, envio em sequência) e o confere na subida e depois uma vez por dia: a fila que parou volta a andar e chama a distribuição (o log de erro e o hub da DMS), e o que mudarem no painel do Asaas volta ao certo. Nada a configurar na tela do Asaas.

## Produtos DMS (A2.5, ADR-019)

Contratos em `docs/integracoes/`. O endereço de cada produto é da distribuição, nunca informado pelo usuário.

| Variável | O que é | Padrão |
| --- | --- | --- |
| `REGEM_API_URL` | Rotas de integração do Regem (só da nuvem); em produção, só o oficial | `https://api.dmsregem.com/api/v1/integracao` |
| `REGEM_AUTH_URL` | Onde o presidente da loja autoriza o Liame (C1b; e, desde a F3 parte C do Hub DMS, a página da autorização por clique, `{valor}/integracoes/autorizar` com o número do pedido empurrado); em produção, só o oficial e com `https` | `https://app.dmsregem.com` |
| `REGEM_CLIENT_ID` · `REGEM_CLIENT_SECRET` | Credencial do Liame como cliente do Regem, para trocar o código pelo token da loja. Sem elas, "Conectar Regem" responde 503 e só vale o registro pela distribuição. O `REGEM_CLIENT_ID` é `liame`; o segredo (32 caracteres ou mais) é o MESMO valor posto no Regem em `INTEGRACAO_LIAME_CLIENT_SECRET` (ambiente do `regem-api`). Com as duas, `GET /v1/connections` passa a listar `regem` em `available` e a tela oferece "Conectar o Regem". | vazio |
| `REGEM_PELA_LIGACAO` | Hub DMS (F3, parte B): a leitura do Regem (vendas, cupons, avisos de cliente esquecido, o registro do aviso) e a criação do cupom vão pelo token do DMS ID do aplicativo do Liame com a ligação da loja, a que a comparação trocou e guardou no cofre; o `rgm_it_` fica de reserva (a recusa pela ligação repete pelo token, e só a recusa do `rgm_it_` desconecta a loja). **Desligado por padrão:** liga depois do critério da comparação (decisão F3-6). Ligado (`true`), pede as três do DMS ID (sem elas, o serviço não sobe). **Onde ligar:** só no `liame-worker`, o único com o aplicativo do Liame no DMS ID (a revogação e o registro pela distribuição, na API, seguem pelo `rgm_it_`). Não é segredo. | `false` |
| `REGEMCAST_API_URL` | API do RegemCast: o conector chama `{valor}/mcp` (MCP 2026-07-28, conversas abertas por anúncio, F7; contrato `integracoes/regemcast.md` v2); em produção, só o oficial e com `https`. Vazio = nenhuma conversa é lida | `https://castapi.dmsregem.com/api/v1` |
| `REGEMCAST_AUTH_URL` | O site do RegemCast, onde fica a página da autorização por clique (Hub DMS, B1): o Liame leva a pessoa para `{valor}/integracoes/autorizar`. Em produção, só com `https`. Com ele, o `REGEMCAST_API_URL` e o aplicativo do Liame no DMS ID, conectar o RegemCast por clique fica possível para a empresa com a flag `regemcast_por_clique`; vazio = só pelo token emitido pela distribuição. Vai no `liame-api` (a página) e no `liame-worker` (a troca) | vazio (produção: `https://cast.dmsregem.com`) |
| `DMS_ID_EMISSOR` · `DMS_ID_APLICATIVO` · `DMS_ID_SEGREDO` | O aplicativo do Liame no DMS ID do Hub DMS (F2): o emissor (o `iss` dos tokens; em produção, só o oficial, `https://id.dmstecnologias.com/oidc`), o `client_id` e o segredo do aplicativo. Vão juntos (faltando um, o serviço não sobe). O `liame-worker` usa para a comparação das credenciais e para a troca do código da autorização por clique; **com a autorização por clique (Hub DMS, B1 no RegemCast e F3 parte C no Regem), o `liame-api` também precisa dos três** (o pedido empurrado sai da API antes de a pessoa ir, e desligar uma loja do Regem ligada pelo clique revoga a ligação dela lá; decisão do dono, 20/10/2026); sem ela, ficam vazios no `liame-api`, para o segredo estar no menor número de lugares. **Conectar o Regem por clique** (a flag `regem_por_clique` da empresa, desligada para todos) usa os três, o `REGEM_API_URL` e o `REGEM_AUTH_URL`; sem os três, "Conectar Regem" segue pela autorização de 01/10 (C1b). **O segredo é da distribuição:** vai só no painel da hospedagem, nunca no git nem no chat. Sem os três (ou sem o `REGEMCAST_API_URL`), a comparação das credenciais do RegemCast não roda. Em produção no worker desde 17/10/2026. | vazio |
| `HUB_LIGADO` · `HUB_URL` · `HUB_RECURSO` | O hub da DMS (Hub DMS, A4, etapa 3): os erros inesperados (5xx da API e a falha de um laço do worker, com o dado pessoal limpo antes de sair; a queda passageira do banco num laço fica como aviso no log e só vai ao hub da terceira seguida em diante) e a batida (a versão no ar) vão ao hub, com o token do aplicativo do Liame no DMS ID. **Desligado por padrão.** Ligado (`true`), pede `HUB_URL` e `HUB_RECURSO` e as três do DMS ID (sem elas, o serviço não sobe); em produção, só o hub oficial (`https://hub.dmstecnologias.com` e `https://hub.dmstecnologias.com/api/v1`). **Onde ligar:** no `liame-worker`, que já tem o aplicativo do DMS ID: ele bate e manda os erros dos laços. Os erros da API só vão se o `liame-api` também ganhar as três do DMS ID (hoje elas ficam só no worker, de propósito). Antes de ligar: o aplicativo do Liame no DMS ID com as permissões `registro.enviar` e `parada.ler` do recurso do hub, o `liame` em `HUB_PRODUTOS` no hub e o prazo dos erros no hub na Política 9 (README jurídico, 17/10/2026). Nenhuma é segredo. | `false` · vazio · vazio |

**Piloto (D-A2.5-4):** a distribuição emite o token da loja no Regem e o grava no cofre do Liame, dentro do contêiner da API. O token entra pela entrada padrão, nunca pela linha de comando:

```bash
node dist/scripts/conectar-produto.js --empresa <uuid da empresa> --marca <uuid da marca> --produto regem < tokens.txt
```

Depois, a pessoa liga a loja em **Contas conectadas**; a loja do Liame dela é criada ali, com o nome e o fuso da loja do Regem (#71, ERR-047). Revogar lá apaga o token do cofre e o revoga no Regem.

**Comparação das credenciais do RegemCast (Hub DMS, F2, A3):** com as três variáveis do DMS ID e a flag `comparacao_dms_id` ligada para a empresa (pelo `ligar-flag`, como abaixo), a rotina `comparacao-dms-id` do worker lê, uma vez por hora, as 10 ferramentas de leitura de cada conta do RegemCast conectada pela credencial de hoje (`rct_it_`) e pela nova (o token do DMS ID do aplicativo e o segredo da ligação, que o RegemCast entrega em troca do `rct_it_` e o Liame guarda no cofre), e grava em `credential_comparison` se deu igual, só com o caminho do que difere. Do lado do RegemCast, a via precisa estar ligada (`DMS_ID_LIGADO` e as variáveis dele, com o `client_id` deste aplicativo em `DMS_ID_APLICATIVOS`).

**Comparação das credenciais do Regem (Hub DMS, F3, parte B):** a mesma rotina e a mesma flag comparam, uma vez por hora, as 4 leituras de cada loja do Regem conectada (`regem_loja`, `regem_pedidos`, `regem_cupons` e `regem_clientes_anonimizados`), pelo `rgm_it_` e pelo token do DMS ID com a ligação (o Regem entrega a ligação em troca do `rgm_it_`; o Liame guarda no cofre e só a rotina troca). A loja que não liberou uma das rotas fica "sem dado" nela. Do lado do DMS ID, o recurso do Regem (`https://api.dmsregem.com/api/v1/integracao`) com as permissões do Liame na função dele; do lado do Regem, a via ligada (`DMS_ID_LIGADO` e as variáveis dele, com o `client_id` deste aplicativo em `DMS_ID_APLICATIVOS`). Enquanto falta alguma dessas peças, a loja volta no dia seguinte, com o motivo em `credential_comparison_state.last_error`. O critério (F3-6) é 7 dias seguidos sem diferença e 30 leituras ou mais por rota; cumprido, `REGEM_PELA_LIGACAO=true` no `liame-worker`. Para ver como está, a mesma consulta abaixo (as linhas do Regem começam com `regem_`):

```sql
select tool, outcome, count(*) as vezes, max(compared_at) as ultima
  from liame.credential_comparison
 where compared_at > now() - interval '14 days'
 group by tool, outcome order by tool, outcome;
```

A via nova só passa a valer com 14 dias seguidos sem `diferente` nem `nova_falhou` e 50 comparações ou mais por ferramenta (decisão F2-7).

**Ligar uma função para uma empresa (ADR-012):** as funções de escrita nascem desligadas (`regem_write`, `meta_write`, `google_write`…). Quem liga é a distribuição, por empresa, com o papel dono do banco (`liame_owner`, o mesmo das migrations): o papel do aplicativo não grava regra de flag. O endereço do banco vem do ambiente, pelo nome da variável, e fica na auditoria da empresa quem decidiu e por quê:

```bash
node --env-file=.env.nuvem apps/server/dist/scripts/ligar-flag.js --url-env NUVEM_DATABASE_URL_OWNER \
  --flag regem_write --empresa <uuid da empresa> --ligar --por "Nome" --motivo "piloto do cupom de campanha"
```

Para desligar, `--desligar` no lugar de `--ligar` (a regra da empresa é apagada e ela volta ao padrão da flag). Vale em até 15 segundos, na API e no worker. Para `regem_write` valer numa loja, a loja também precisa ter liberado "Criar cupom de campanha" na autorização do Regem.

**`meta_write` (A4):** com a flag ligada para a empresa, as ferramentas de anúncio (X2: verba diária, pausar e retomar) passam a aceitar pedidos na Meta; cada pedido espera a aprovação de uma pessoa com o código do app, e aumentar ou retomar pedem o teto por campanha e o teto do mês da empresa (definidos juntos em `PUT /v1/budget/limits`, pelo Dono ou pelo Administrador) e precisam caber na verba do mês (`GET /v1/budget/month`: o gasto das contas conectadas, o ritmo e o que já foi pedido hoje). Com ela desligada, o pedido é recusado antes de qualquer leitura na Meta. Para valer numa conta, a autorização da Meta precisa incluir a permissão de gerenciar anúncios (`ads_management`): com a flag ligada e a configuração de escrita definida (`META_LOGIN_CONFIG_ID_ESCRITA`), **Conectar** em Contas conectadas manda a empresa autorizar por essa configuração, e a autorização nova assume as contas que a empresa já tinha (a antiga, sem conta nenhuma, é encerrada). A auditoria do pedido de conexão guarda por qual acesso a empresa foi mandada (`leitura` ou `escrita`). Sem a permissão, a validação da Meta recusa a mudança e o pedido falha com o motivo, sem escrever nada.

**`modo_aprovacao` (A4, X3):** nasce desligada para todos, e sem ela nada muda. Com ela ligada para a empresa (`--flag modo_aprovacao`), a recomendação nova de uma ação que a política põe em Aprovação para o Gestor de tráfego (regra de autonomia com `actor: agent` e `mode: APPROVAL`, por conta) vira um pedido feito por ele na rodada da manhã. O pedido espera a aprovação de uma pessoa com o código do app, e só existe onde a escrita também está ligada (`meta_write`). Com a flag, o sistema também passa a **propor** a passagem de Sugerir para Aprovação (quando os cinco portões da sombra e os dos pedidos passam), e uma pessoa com `politicas.gerenciar` aprova ou recusa; voltar é um passo por vez. **Ligar só depois das telas do P9 e do P11:** a tela de Aprovações de hoje não diz que um pedido veio do funcionário.

**`criativo` (A4, X6):** nasce desligada para todos, e sem ela nada muda. Com ela ligada para a empresa (`--flag criativo`), quem opera campanhas pode pedir peças de anúncio ao Criativo para uma oferta de Minha marca, e as peças aparecem conferidas para decidir. Ela depende da flag `ia` (é o gateway que chama o modelo), da rota de modelo da tarefa `criativo_texto` (publicada na migration 0051, depois do eval com modelo de verdade) e do Criativo ativo na empresa. O pedido de peças que não cabe no que resta do limite de uso de IA da empresa (o teto dela em `ai_budget` ou, sem linha, `AI_DAILY_LIMIT_USD` e `AI_MONTHLY_LIMIT_USD`) é negado na hora, com o que resta. Não escreve em plataforma nenhuma: a campanha nova tem a flag dela (`meta_write`).

**`desempenho_anuncios` (P23):** nasce desligada para todos, e sem ela nada muda: Resultados não mostra o cartão e "Ler agora" responde 409. Com ela ligada para a empresa (`--flag desempenho_anuncios`), aparece em Resultados o cartão "Como os anúncios rodaram" (no Pro, "Desempenho nas plataformas"): impressões, alcance, cliques, gasto e o resultado que a Meta e o Google contam, com a hora de cada leitura e o botão "Ler agora" (uma vez a cada 15 minutos por empresa, para quem vê Resultados). Só lê: não escreve em plataforma nenhuma. O alcance do período aparece depois da primeira leitura diária da Meta com o servidor do P23 (migration 0073).

**`fotos` (A6, Z4; P20):** nasce desligada para todos, e sem ela nada muda: a lista das fotos vem vazia, e enviar ou mudar uma foto responde 409. Com ela ligada para a empresa (`--flag fotos`), o Dono, o Administrador e o Gestor enviam as fotos dos produtos, mudam o produto e apagam (D-A6-19); quem tem acesso à empresa vê. Ligar só com `IMAGENS_BUCKET` no ar na API, no worker e no web (seção "Imagens"): sem o bucket, a lista e o envio respondem 503, e sem ele no web as imagens não aparecem. A tela Fotos (no menu, abaixo de Minha marca) existe para todos com `fotos.ver`; com a função desligada, ela diz que as fotos ainda não estão ligadas e não envia nada. Não publica em nenhuma rede.

**`escolha_de_modelo` (A3, I13; D-A3-12, D-A3-25 a D-A3-28):** nasce desligada para todos. Com ela ligada para a empresa (`--flag escolha_de_modelo`), o Dono e o Administrador escolhem, no Pro, o modelo de cada finalidade entre os do catálogo do Liame (`ai_model_option`), e as chamadas passam a usar o escolhido, com o modelo da rota como reserva. O catálogo é gravado só por migration da distribuição, depois da rodada de confirmação de cada modelo; vazio, ligar a função não muda nenhuma chamada.

**`resumo_das_pessoas` (A7, W8; D-A7-53):** nasce desligada para todos, e sem ela nada sai. Com ela ligada para a empresa (`--flag resumo_das_pessoas`), o Dono recebe toda segunda-feira, a partir das 8h no fuso da empresa, o e-mail com as contagens do que cada pessoa além dele fez na conta na semana que fechou no domingo (o que Pessoas e acessos promete: "você recebe um resumo por semana"). A semana em que só o Dono mexeu não manda nada. Não depende de outra função nem de variável: usa o e-mail do serviço, como os convites.

## Imagens (ADR-021)

| Variável | Para quê | Padrão |
| --- | --- | --- |
| `IMAGENS_ARMAZEM` | `s3` em produção (outro valor recusa subir), `disco` no desenvolvimento, `memoria` nos testes | pelo `NODE_ENV` |
| `IMAGENS_BUCKET` **P** | O bucket privado em `sa-east-1` (o nome leva o número da conta: fica só no ambiente, nunca no repositório). Sem ele, em produção, a função de imagem fica indisponível e o resto não muda | — |
| `IMAGENS_PASTA_LOCAL` | Só desenvolvimento: a pasta das imagens (fora do git) | `.liame-imagens-locais` |

A credencial é a do usuário `liame-sistema` (`AWS_ACCESS_KEY_ID` e `AWS_SECRET_ACCESS_KEY`, seção "Cofre") e a região, `AWS_REGION`. A API grava e assina a leitura (5 minutos); o worker apaga (a rotina `fotos` e o expurgo).

**No web (A6 · Z4, parte b):** a mesma `IMAGENS_BUCKET` vai no `liame-web`. O servidor do web lê a variável na subida (não no build: o objeto `process.env` inteiro chega ao proxy, que o build não troca por valor fixo) e põe a origem `https://<bucket>.s3.<região>.amazonaws.com` no `img-src` da CSP das telas do app, só nelas (as telas de entrada ficam como estão). A região vem de `AWS_REGION`, ou São Paulo. Nome fora do formato de bucket = nenhuma origem a mais. O formato do endereço assinado é conferido por teste com o SDK de verdade (`test/fotos-conferencia.spec.ts`). Sem a variável no web, a tela Fotos abre com a grade e as imagens bloqueadas.

**Situação na AWS (21/10/2026):** o bucket `liame-imagens-<conta>-sa-east-1-an`, criado com o dono no console, no namespace regional da conta (nenhuma outra conta cria um bucket com esse nome), de propósito geral, com as ACLs desabilitadas, todo o acesso público bloqueado, a criptografia padrão (SSE-S3) e **o versionamento desativado** (com versões, a foto apagada continuaria guardada, e o expurgo precisa apagar de verdade). A política do bucket só recusa: o pedido sem conexão segura (`aws:SecureTransport`) e a assinatura com mais de 10 minutos (`s3:signatureAge` acima de 600000). No usuário `liame-sistema`, a política `liame-sistema-s3-imagens`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ImagensDoLiame",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::liame-imagens-<conta>-sa-east-1-an/t/*"
    },
    {
      "Sid": "ListarSoAsImagensDoLiame",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::liame-imagens-<conta>-sa-east-1-an",
      "Condition": { "StringLike": { "s3:prefix": "t/*" } }
    }
  ]
}
```

## IA (A3, ADR-006)

Os funcionários de IA nascem desligados para todas as empresas (flag `ia`). Sem a chave do fornecedor, a API e o worker sobem normalmente e tudo o que depende de IA cai no caminho sem IA.

**Para a IA funcionar numa empresa, quatro coisas precisam estar certas, nesta ordem:**

1. **A chave do fornecedor** (`ANTHROPIC_API_KEY`) no ambiente do `liame-api` e do `liame-worker`. No painel da Anthropic, a chave é de uma **conta de serviço**, presa a um **workspace só da produção**, com **teto de gasto mensal** no workspace (o workspace padrão não aceita teto). Chave sem workspace exige um cabeçalho a mais em toda chamada e devolve 400 sem ele: a do Liame nasce presa ao workspace. Os evals com modelo de verdade usam **outra** chave, de outro workspace, com teto próprio, e ela nunca vai para o ambiente de produção.
2. **A rota de modelo da tarefa** em `liame.ai_model_route`, publicada por migration com a nota do eval da tarefa (a 0046 publicou as cinco da A3: `explicar_resultados`, `conversa_lia`, `estrategista_plano`, `pesquisador_pagina` e `compliance_revisao`; a 0051, a do Criativo de texto, `criativo_texto`; todas no Sonnet 5.5 com esforço baixo). Sem rota, a tarefa segue no caminho sem IA. Trocar o modelo, o esforço ou o prompt de uma tarefa pede o eval dela de novo e uma versão nova da rota.
3. **O aviso à empresa e os documentos.** A Anthropic é suboperadora "prevista": o Contrato de Tratamento de Dados (cláusula 6.2) pede aviso com 30 dias de antecedência antes de ela tratar dados do cliente, e a Política de Privacidade publicada no site precisa dizer que a IA é ligada empresa por empresa (seção 7) e trazer a Anthropic entre os fornecedores em uso (seção 8). No dia em que a `ia` é ligada para a primeira empresa, os textos de `docs/juridico` mudam no mesmo PR, e o site é publicado com a versão nova (`TERMS_VERSION`).
4. **A flag `ia` da empresa**, ligada pela distribuição (comando `ligar-flag`, com quem decidiu e o motivo na auditoria da empresa). O revisor de IA do Compliance pede também a flag `revisor`, e o Criativo, a flag `criativo`.

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

**Relatório do mês (A3, I7):** o worker gera o relatório de cada marca com as vendas conectadas no dia 1º, a partir das 5h no fuso da loja (espera até as 9h a leitura da conta de anúncio que traz o último dia), sem depender de flag. O **envio por e-mail** depende da flag `relatorio_email`, desligada para todos (ligada no piloto desde 21/10/2026): com ela ligada para a empresa (`--flag relatorio_email`), o relatório sai a partir das 7h do dia 1º para o Dono, os Administradores e quem só recebe relatórios, até o dia 7 do mês seguinte. A flag vale para o relatório gerado depois de ligada. O link e as imagens vêm do `APP_URL`, como na revisão.

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
