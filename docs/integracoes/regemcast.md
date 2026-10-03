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

O mesmo token pode receber outras permissões, que o F7 não usa: leitura de conta, campanhas, públicos, modelos e orçamento; rascunho de modelo e de campanha (com `chaveIdempotencia` obrigatória); e disparo em dois passos (`campanha_disparo_planejar` → `campanha_disparar` com a confirmação do plano), **só para produto da DMS** e só com o orçamento de disparos da conta definido. A lista e as regras estão em `docs/mcp.md` do RegemCast. Usá-las no Liame é trabalho do Action Service, com plano próprio.
