# Contrato RegemCast → Liame (conversas abertas por anúncio)

> **Versão 2 · 02/10/2026.** Muda o transporte: a leitura é a ferramenta `conversas_anuncio_listar` do **MCP do RegemCast**, e não uma rota REST (decisão do dono de 02/10/2026; emendas da ADR-008 e da ADR-019). A resposta é a mesma da versão 1. ADR-019 e `plano-a25.md` (C2a, C2b, F7). As convenções de cursor e versão são as do [contrato de cupons](cupons.md) §2.
>
> **Versão 1 · 29/09/2026:** rota `GET {base}/conversas-anuncio`, que não chegou a existir.

## 1. Autorização (C2b)

- **Token:** por conta do RegemCast (o número de WhatsApp da loja), com o prefixo `rct_it_` e 43 caracteres depois dele.
  - Guardado só em hash no RegemCast e cifrado no cofre do Liame.
  - Escopos explícitos; o F7 precisa só de **`conversas.anuncio.ler`**.
- **Emissão (piloto):** a distribuição emite o token no console do RegemCast, aba "Integrações (MCP)", **a pedido do dono da conta** (política de privacidade do RegemCast, §14, desde 02/10/2026), e grava direto no cofre do Liame com `conectar-produto --produto regemcast`, sem passar pelo usuário.
- **Revogação dos dois lados:**
  - desligar ou revogar no Liame tira o token do cofre e chama `integracao_revogar` no RegemCast (depois do commit; falhar lá não desfaz o desligamento aqui);
  - revogado no RegemCast (console ou "Aplicativos conectados" do dono), a próxima chamada volta 401 e a conta fica "desconectada" no Liame.
- **Endereço:** `https://castapi.dmsregem.com/api/v1/mcp` em produção. É configuração da distribuição (`REGEMCAST_API_URL`, comparado pela origem, V33), nunca informado pelo usuário.

## 2. O protocolo

MCP na especificação **2026-07-28**, **sem estado**: cada chamada é um `POST` com um pedido JSON-RPC, e a resposta vem em JSON (`application/json`). Sem sessão, sem `initialize`. O Liame faz a chamada pelo próprio cliente de conectores (cota, disjuntor, endereço liberado), sem o SDK.

```http
POST /api/v1/mcp
Authorization: Bearer rct_it_…
Content-Type: application/json
Accept: application/json, text/event-stream
Mcp-Method: tools/call
Mcp-Name: conversas_anuncio_listar
MCP-Protocol-Version: 2026-07-28
```

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "conversas_anuncio_listar",
    "arguments": { "limite": 200, "cursor": "…" },
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { "name": "liame", "version": "…" },
      "io.modelcontextprotocol/clientCapabilities": {}
    }
  }
}
```

Os cabeçalhos `Mcp-Method` e `Mcp-Name` repetem o que está no corpo (a especificação manda conferir; base §8.1). A resposta da ferramenta vem em `result.structuredContent`, no esquema que a própria ferramenta declara:

```json
{ "jsonrpc": "2.0", "id": 1, "result": { "structuredContent": { "…": "…" }, "content": [ { "type": "text", "text": "…" } ], "resultType": "complete" } }
```

### Erros

| O que volta | Quando | O Liame faz |
| --- | --- | --- |
| HTTP **401** com `WWW-Authenticate: Bearer` | token inexistente, revogado ou fora do formato | conta "desconectada" |
| HTTP **403** | conta suspensa ou cancelada no RegemCast | espera um dia, conta com erro |
| HTTP **429** com `Retry-After` | mais de 120 chamadas por minuto no token | espera o que foi pedido |
| HTTP 5xx | erro do RegemCast | tenta de novo com espera |
| `result.isError: true` | a ferramenta recusou (cursor ou `desde` que não vale) ou deu erro interno ("Erro interno…") | recusa: erro definitivo; erro interno: passageiro |
| `error` do JSON-RPC | ferramenta que o token não pode usar ("não encontrada") ou argumento fora do esquema | escopo que falta: permissão; o resto: definitivo |

## 3. `integracao_situacao` · qualquer token

Sem argumentos. Diz de quem é o token: é com ela que a distribuição confere o token antes de gravar e descobre a conta. **`contaId` é o identificador da conta no Liame** (`connected_account.external_id`): não muda quando o token é trocado.

```json
{
  "contaId": "3f1c2a9e-7b4d-4c1a-9e2f-8a6b5c4d3e21",
  "conta": "MISTER BURGERS",
  "fuso": "America/Sao_Paulo",
  "produto": "liame",
  "classe": "dms",
  "token": "Liame — piloto",
  "permissoes": [ { "id": "conversas.anuncio.ler", "rotulo": "Conversas abertas por anúncio", "descricao": "…" } ],
  "limitePorMinuto": 120
}
```

## 4. `conversas_anuncio_listar` · `conversas.anuncio.ler`

Argumentos: `cursor` (o `proximo_cursor` da leitura anterior), `limite` (padrão 200, máximo 500) e `desde` (instante ISO 8601 com fuso; filtra pela hora da mensagem, para a carga inicial de 90 dias). Devolve **só** as conversas abertas por anúncio de clique para WhatsApp. Em cada uma vêm a origem que chegou com a **primeira mensagem** (C2a) e o telefone de quem escreveu. **Nenhum conteúdo de mensagem.**

```json
{
  "itens": [
    {
      "id": "8d9d5c1e-4b0f-4f5e-9a51-2f0a8c6f7a11",
      "versao": 1,
      "atualizado_em": "2026-09-24T19:12:44.382911Z",
      "numero_loja": "+5521900000000",
      "telefone": "+5521988887777",
      "aberta_em": "2026-09-24T19:12:40.000Z",
      "anuncio_id": "120215566771111",
      "tipo_origem": "ad",
      "ctwa_clid": "ARAkLkA…",
      "url_origem": "https://fb.me/…"
    }
  ],
  "proximo_cursor": "…",
  "tem_mais": false
}
```

- **Ordem** estável por (`atualizado_em`, `id`); **cursor** opaco, devolvido também na última página (sem nada novo, volta o mesmo); só sai o que entrou há pelo menos 5 segundos.
- **`versao`:** sempre 1 (a linha não muda depois de entrar).
- **`telefone`:** em E.164, com o nono dígito, como o RegemCast normaliza. O Liame transforma em índice cego na chegada e não guarda o telefone.
- **`tipo_origem`:** `ad` (anúncio) ou `post` (publicação); diz o que é `anuncio_id`.
- **`ctwa_clid`** e **`url_origem`:** podem vir `null`. A Meta omite o `ctwa_clid` em anúncio no Status do WhatsApp (base §2.4).
- **O que existe:** o RegemCast só guarda a origem enquanto a conta tem um aplicativo conectado com esta permissão, e por 180 dias. O que chegou antes da conexão não existe: a carga inicial alcança só o que entrou depois.
- **Coexistência:** a Meta **não garante** o `referral` para número em coexistência (base §2.4, [NC]). O RegemCast grava o que chegar, e a conferência com número real é pré-requisito do caminho B (D-A2.5-9).

## 5. `integracao_revogar` · qualquer token

Argumento `confirmar: true`. Desliga o **próprio** token: a chamada seguinte volta 401. Devolve `{ "revogado": true, "revogadoEm": "…" }`. Na trilha do RegemCast sai com o autor `integracao`.

## 6. Sem evento

O RegemCast não manda aviso (webhook) de conversa nova. A leitura é só pelo cursor, a cada 15 minutos.

## 7. O resto da porta (fora do F7)

O mesmo token pode receber outras permissões, que o F7 não usa. As de **leitura** (conta, campanhas, públicos, modelos e orçamento) o conector do Liame já sabe chamar desde a A5 · Y4 (seção 8). As de **escrita** seguem fora: rascunho de modelo e de campanha (com `chaveIdempotencia` obrigatória) e disparo em dois passos (`campanha_disparo_planejar` → `campanha_disparar` com a confirmação do plano), **só para produto da DMS** e só com o orçamento de disparos da conta definido. A lista e as regras estão em `docs/mcp.md` do RegemCast. Usar as de escrita no Liame é trabalho do Action Service (A5 · Y5).

## 8. As leituras da mensageria (A5 · Y4)

Conferidas em 08/10/2026 em `docs/mcp.md` e em `backend/src/modules/integracao/mcp.leitura.ts` do RegemCast (commit `e88ae59`). O conector as chama pelo mesmo protocolo da seção 2 e confere cada resposta campo a campo (`connectors/regemcast/contrato-regemcast.ts`); o que vier a mais do que está na tabela é descartado, e o que vier torto é erro definitivo. **Nenhuma traz telefone, nome de contato ou conteúdo de conversa.** Nenhuma muda nada no RegemCast.

| Ferramenta | Permissão | Entrada | O que o Liame recebe |
| --- | --- | --- | --- |
| `conta_situacao` | `conta.ler` | nada | `conta`, `fuso`; `whatsapp` (`conectado`, `sinal`: `pode_enviar`, `com_restricao`, `bloqueado` ou `desconhecido`, `titulo`, `resumo`, `lidaEm`, `problemas[]` com `onde`, `titulo`, `explicacao`, `acao`); `plano` (`nome`, `assinatura`, `gratisPeloRegem`, `disparosNoCiclo`, `tetoDoCiclo`, `restantes`, `cicloFim`) |
| `campanhas_listar` | `campanhas.ler` | `situacao` (opcional), `limite` (1 a 50; o Liame pede 20) | `campanhas[]` e `total`. Cada campanha: `id`, `nome`, `situacao` (`rascunho`, `agendada`, `enviando`, `pausada`, `concluida`, `cancelada`), `pausaMotivo`, `modelo`, `categoria`, `publico`, e as contagens `destinatarios`, `naFila`, `enviadas`, `entregues`, `lidas`, `falhas`, `responderam`; `criadaEm`, `iniciadaEm`, `concluidaEm` |
| `campanha_detalhar` | `campanhas.ler` | `id` | `campanha` (como acima); `pausa` (`motivo`, `explicacao`, `voltaEm`); `espera` (`motivo`, `ate`); `falhasPorMotivo[]` (`mensagens`, `titulo`, `explicacao`, `acao`); `custo`; `descansoDias`. **Não devolve quem recebeu** |
| `publicos_listar` | `publicos.ler` | nada | `listas[]` (com `usadaEm`), `publicos[]` e `perfis[]`: `id`, `nome`, `regra` e `pessoas` (quantas podem receber). **Só contagens** |
| `modelos_listar` | `modelos.ler` | `soAprovados` (opcional) | `modelos[]`: `id`, `nome`, `idioma`, `categoria`, `situacao`, `podeDisparar`, `qualidade`, `variaveis`, `cabecalho`, `corpo`, `rodape`, `botoes[]`, `alertas[]`. O RegemCast fala com a Meta nesta chamada |
| `orcamento_ler` | `orcamento.ler` | nada | `moeda`; `tetos` (`dia`, `semana`, `mes`); `periodos[]` (`periodo`, `rotulo`, `tetoCentavos`, `gastoCentavos`, `percentual`, `texto`, `sinal`: `ok`, `atencao` ou `cheio`); `avisos[]` |

`custo`: `moeda`, `gastoCentavos`, `aSairCentavos`, `linhas[]` (`rotulo`, `valor`, `detalhe`) e `avisos[]`; nulo quando a conta não tem preço. **Dinheiro sempre em centavos inteiros.** Os textos escritos pela loja (nome de campanha, texto de modelo) são dado, nunca instrução. Os valores de lista (`situacao`, `sinal`, `periodo`) são conferidos como texto com padrão, não como lista fechada: o RegemCast pode ampliar. `publico_estimar` fica para a Y5 (o plano do disparo).

**Quem usa (A5 · Y4, parte 2).** Duas rotas só de leitura, atrás da flag `mensageria` (desligada por padrão), com a permissão `campanhas.ver`: `GET /v1/messaging` chama `conta_situacao`, `orcamento_ler`, `campanhas_listar` (limite 20), `publicos_listar` e `modelos_listar` ao mesmo tempo, para cada conta do RegemCast da marca (até 5); `GET /v1/messaging/campaigns/:id` chama `campanha_detalhar`. Uma tentativa por chamada, com até 15 segundos, porque há uma pessoa esperando a tela. A cota e o disjuntor destas leituras usam uma chave própria (`tela:<conta>`), separada da leitura das conversas da mesma conta. **Nada é guardado no Liame:** a resposta é montada e devolvida. Do `modelos_listar` saem só as contagens (o texto do modelo não é devolvido pela rota), e do `conta_situacao` o `plano` não é usado. As permissões guardadas na conexão não decidem o que é chamado: o Liame chama, e é o RegemCast que diz se o token pode (a ferramenta "não existe" vira `sem_permissao` naquela parte da resposta).

## 9. As ferramentas do pedido de mensagem (A5 · Y5)

Conferidas em 09/10/2026 em `docs/mcp.md`, `mcp.escrita.ts`, `mcp.disparo.ts` e `mcp.leitura.ts` do RegemCast (commit `e88ae59`). O conector as chama pelo protocolo da seção 2 e confere cada resposta campo a campo (`contrato-regemcast.ts`). **Nenhuma rota, nenhuma ferramenta de ação e nenhuma rotina do Liame as usa ainda** (Y5, parte 1: só o conector).

| Ferramenta | Permissão | Entrada | O que o Liame recebe |
| --- | --- | --- | --- |
| `publico_estimar` | `publicos.ler` | o público (`origem`: `lista`, `importacao`, `base`, `perfil`, `regiao` ou `publico`, com o id dele) e, opcional, a `categoria` do modelo | `pessoas` (quantas podem receber), `emDescanso`, `descansoDias` e `custo` (teto). Não cria nada |
| `modelo_rascunhar` | `modelos.rascunhar` | `chaveIdempotencia`; `nome`, `categoria` (`marketing` ou `utilidade`), `corpo` e, opcionais, `id` (para alterar um rascunho do Liame), `idioma`, `titulo`, `tituloExemplo`, `corpoExemplos[]`, `rodape`, `botoes[]` | `id`, `nome`, `idioma`, `categoria`, `situacao`, `problemas[]` (`campo`, `mensagem`), `prontoParaEnviar`, `proximoPasso`. **O rascunho fica no RegemCast e não vai para a Meta:** quem envia é uma pessoa, na tela de lá (D-A5-15) |
| `campanha_rascunhar` | `campanhas.rascunhar` | `chaveIdempotencia`; `nome`, `modeloNome` (aprovado), `publico` e, opcionais, `modeloIdioma`, `variaveis[]` e `variavelDoTitulo` (`origem`: `fixo`, `nome`, `primeiro_nome`, `cashback_saldo`, `cashback_validade`; `valor`), `janelaDias[]` (0 = domingo), `janelaInicio`, `janelaFim` (HH:MM, no fuso da conta), `pausaSegundos`, `maxPorDia`, `maxPorSemana`, `maxPorMes` | `campanha` (como na seção 8), `custo`, `descansoDias`, `proximoPasso`. **Nenhuma mensagem sai** |
| `campanha_disparo_planejar` | `campanhas.disparar` (só produto da DMS) | `id` da campanha em rascunho | `campanha`, `custo`, `orcamento` (`definido`, `periodos[]`, `aviso`), `podeDisparar`, `impedimentos[]` (frases do RegemCast) e `confirmacao`. Não muda nada |
| `campanha_disparar` | `campanhas.disparar` | `chaveIdempotencia`, `id`, `confirmacao` | `campanha`, `custo`, `proximoPasso`. **As mensagens saem e a Meta cobra.** O dono da conta é avisado no RegemCast |
| `campanha_pausar` | `campanhas.disparar` | `chaveIdempotencia`, `id` | `campanha`, `proximoPasso`. Segura o que ainda não saiu |

**A chave de idempotência** (8 a 100 caracteres: letras, números, ponto, dois-pontos, hífen e sublinhado) vale por ferramenta e por token, por 24 horas: o mesmo pedido com a mesma chave devolve a resposta guardada, sem fazer de novo; outro pedido com a mesma chave é recusado. É o que deixa segura a nova tentativa do cliente dos conectores e a execução repetida de um job. O conector confere o formato da chave, do id e da confirmação **antes** de chamar: o que está fora do formato nem sai do Liame.

**O plano e a confirmação.** `podeDisparar` vem com a `confirmacao` e sem impedimentos, ou vem falso, sem confirmação e com as frases do que impede. Qualquer outra combinação é resposta fora do contrato (erro definitivo): o Liame não dispara em cima de um plano torto. O disparo só roda se **nada mudou** desde o plano (o público, o custo, o orçamento, a situação); senão, o RegemCast recusa com a frase dele e pede um plano novo.

**Quem usa (A5 · Y5, parte 2).** O conector de ação `actions/regemcast-mensagem.ts` (provedor `regemcast`, flag de escrita `whatsapp_campaign`), **ainda fora do registro de conectores**: nenhum pedido chega a ele. O recurso é `mensagem:<id da campanha>`. Ler o recurso é chamar `campanha_disparo_planejar`; o estado do pedido é esse plano (pessoas, custo, orçamento, o que impede, a confirmação), e a versão muda quando o plano muda. Executar `mensagem_disparar` é ler o plano de novo e, se ele é o mesmo que a pessoa aprovou, chamar `campanha_disparar` com a confirmação dele; executar `mensagem_pausar` é chamar `campanha_pausar`. As chaves de idempotência saem do próprio pedido (`liame:disparo:…` da conta, da campanha e da confirmação; `liame:pausa:…` da conta, da campanha e do tamanho da fila). `campanha_rascunhar`, `modelo_rascunhar` e `publico_estimar` ainda não têm quem os chame: são da parte que monta o pedido. **Desde a parte 3 (09/10/2026):** o plano com `podeDisparar` falso não recusa mais o pedido: ele nasce esperando, com as frases do RegemCast como motivo. Aprovar chama `campanha_disparo_planejar` de novo, antes do código do app: impedido, a aprovação é recusada; com a confirmação diferente da que o pedido guardou, a pessoa confere o plano de agora (mais uma chamada a `campanha_disparo_planejar`) e aprova de novo. **Desde a parte 4 (09/10/2026):** `modelos_listar`, `publicos_listar`, `publico_estimar` e `campanha_rascunhar` têm quem os chame: o serviço que monta o pedido a partir da proposta do funcionário (`mensageria/pedido-de-mensagem.service.ts`), ainda sem rota. O rascunho leva sempre `janelaInicio` e `janelaFim` dentro de 09:00 a 20:00 e os dias; a chave de idempotência é `liame:rascunho:…` (da empresa, da conta e da campanha pedida). O público do rascunho é só `lista`, `publico` ou `perfil`. **Desde a parte 6 (09/10/2026):** o conector está no registro de conectores; sem a flag de escrita `whatsapp_campaign` ligada para a empresa, nenhum pedido chega a ele. `campanha_pausar` é chamada pelo pedido de pausa que uma pessoa faz, direto, sem aprovação com o código do app.

**As travas do RegemCast para o disparo:** só produto da DMS; só a campanha que o próprio Liame montou (a que uma pessoa fez na tela, ou outro aplicativo, é recusada, também para planejar e pausar); e só com pelo menos um teto de gasto definido pelo dono da conta e com preço para as mensagens da campanha.

**O que a porta não faz, de propósito ou por desenho, e a Y5 precisa respeitar:**

- **Não recebe número de telefone:** o público sai sempre de uma lista ou da base do RegemCast, onde o consentimento está registrado. As funções do conector não têm campo para isso.
- **Não envia para quem está em descanso:** é decisão do dono, na tela do RegemCast.
- **Não agenda o começo:** a campanha começa a sair quando `campanha_disparar` é chamada, dentro da janela (dias da semana e horário) e do ritmo dela. Para "sair no sábado às 11h", ou a janela da campanha diz isso, ou o Liame só chama o disparo na hora. A janela por dia da semana vale para as semanas seguintes se a campanha não terminar no dia.
- **Não retoma:** pausada, quem retoma é uma pessoa, na tela do RegemCast.
- **Modelo sem imagem, vídeo, documento, carrossel ou oferta por tempo limitado,** e só nas categorias marketing e utilidade.
