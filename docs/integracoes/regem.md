# Contrato Regem → Liame (vendas da loja)

> **Versão 1 · 29/09/2026.** ADR-019 e `plano-a25.md` (C1a, C1b, C1c, C3a, C3b). O Regem é a **autoridade** do pedido, da receita e do custo (Metric Authority Matrix, `data-model.md` §4.1). Este contrato é o que o Regem implementa (rotas só da nuvem) e o que o conector do Liame (F4) consome. As convenções (autorização, cursor, versão, erros, idempotência) são as do [contrato de cupons](cupons.md) §1 e §2; os cupons seguem aquele contrato.

## 1. Autorização (C1a, C1b)

- **Token por loja:** opaco, com o prefixo `rgm_it_`, guardado no Regem só em hash (SHA-256).
  - Cada token tem uma loja, os escopos, quem autorizou, a data de criação, o último uso e a revogação.
  - **Nunca** reusar o token do `servidor_local` nem outra credencial (ERR-108 do Regem).
- **Filtro:** empresa **e** loja do token em toda consulta das rotas novas. O Regem roda com a RLS desligada (ADR-003 do Liame, §11 do plano).

| Escopo | Libera | Observação |
| --- | --- | --- |
| `pedidos.ler` | pedidos confirmados e cancelados, itens, canal, cupom usado e origem do clique | — |
| `clientes.telefone.ler` | id e telefone do cliente no pedido | sem este escopo, `cliente` vem `null`; o caminho B (conversa → pedido) precisa dele |
| `custos.ler` | custo por item | só se quem autorizou tem permissão financeira no Regem (presidente); sem ele, `custo_centavos` vem `null` |
| `clientes.anonimizacao.ler` | avisos de cliente anonimizado | para o Liame apagar o cliente pseudonimizado |
| `cupons.ler`, `cupons.uso.ler`, `cupons.criar` | contrato de cupons | — |

- **Como o token nasce (produto, C1b):**
  1. No Liame, "Conectar Regem" abre `https://app.dmsregem.com/integracoes/autorizar?cliente=liame&state=…&code_challenge=…&code_challenge_method=S256&redirect_uri=https://api.agencialiame.com/v1/oauth/callback`.
  2. No Regem, o presidente escolhe as lojas e vê os escopos.
  3. O Regem volta com `code` (uso único, 10 minutos) e `state`.
  4. O worker do Liame troca o código por um token por loja, entre servidores, em `POST {base}/autorizacao/token` com `code`, `code_verifier` e a credencial de cliente do Liame (da distribuição).
  5. A resposta traz `[{ "loja_id", "loja_nome", "token", "escopos" }]`.
- **No piloto:** a distribuição emite o token no console do Regem e o grava direto no cofre do Liame, sem passar pelo usuário.
- **Revogação:**
  - `POST {base}/autorizacao/revogar` (com o próprio token) revoga no Regem;
  - token revogado no Regem devolve **401**, e o Liame marca a conta como `desconectada`.

## 2. Rotas (C1c)

Endereço base: `https://api.dmsregem.com/api/v1/integracao`. Rotas **só da nuvem** (`@CloudOnly()`).

### 2.1 `GET {base}/loja` · qualquer escopo

Quem é a loja do token: `{ "loja_id", "loja_nome", "empresa_nome", "fuso", "moeda", "escopos": [...] }`. O Liame usa na conexão (nome da loja, fuso e escopos concedidos).

### 2.2 `GET {base}/pedidos` · `pedidos.ler`

- **Parâmetros:**
  - `cursor`, `limite`;
  - `confirmados_desde` (instante; só na carga inicial de 90 dias, D-A2.5-5).
- **O que entra:**
  - todo pedido **confirmado** da loja, de qualquer origem (cardápio online, WhatsApp, balcão, mesa, totem, marketplaces), e o **cancelado** depois de confirmado;
  - pedido que nunca foi confirmado não entra;
  - a mesma venda aparece uma vez só (comanda de pedido externo não se repete).

```json
{
  "itens": [
    {
      "id": "0b4f…",
      "versao": 17,
      "atualizado_em": "2026-09-26T23:00:01.412Z",
      "canal": "cardapio",
      "grupo_canal": "cardapio",
      "situacao": "confirmado",
      "moeda": "BRL",
      "fuso": "America/Sao_Paulo",
      "receita_centavos": 5990,
      "desconto_loja_centavos": 500,
      "estornado_centavos": 0,
      "cupom": "COMBOSEXTA",
      "cliente": { "id": "5c1e…", "telefone": "+5521999998888", "novo": true },
      "criado_em": "2026-09-26T22:58:00Z",
      "confirmado_em": "2026-09-26T23:00:00Z",
      "cancelado_em": null,
      "itens": [
        { "id": "it-1", "produto_id": "p-9", "nome": "Burger da casa", "quantidade": "2", "receita_centavos": 4000, "custo_centavos": 1600 },
        { "id": "it-2", "produto_id": "p-3", "nome": "Refrigerante lata", "quantidade": "1", "receita_centavos": 990, "custo_centavos": null }
      ],
      "origem": {
        "capturado_em": "2026-09-24T20:41:07Z",
        "lk": "Qx7Lm2Pa",
        "utm_source": "meta", "utm_medium": "paid", "utm_campaign": "Combo sexta", "utm_content": null, "utm_term": null,
        "campaign_id": "120215566778899", "adset_id": "120215566770000", "adgroup_id": null, "ad_id": "120215566771111",
        "gclid": null, "gbraid": null, "wbraid": null, "fbclid": "IwAR0…"
      }
    }
  ],
  "proximo_cursor": "…",
  "tem_mais": true
}
```

- **`receita_centavos`:** a **definição única de faturamento do Regem** (`common/faturamento.ts`).
  - Entra: produto, taxa de entrega quando é da loja, taxas de serviço.
  - Não entra: gorjeta.
  - Reduz: só o desconto bancado pela loja.
  - O Liame não recalcula (D-A2.5-6). A soma dos pedidos confirmados de um dia tem de bater, ao centavo, com o relatório de faturamento do Regem (critério A2.5-2).
- **`desconto_loja_centavos`:** informativo, já descontado da receita. **`estornado_centavos`:** estornos registrados no pedido; o Liame desconta do ROAS.
- **`grupo_canal`** (o Regem mapeia o `canal` dele):

  | Grupo | Canais do Regem |
  | --- | --- |
  | `cardapio` | `cardapio`, `cardapio_web`, `loja`, `delivery_direto` |
  | `whatsapp` | pedidos do bot de WhatsApp |
  | `presencial` | `balcao`, mesa (comanda), `totem` |
  | `marketplace` | `ifood`, `99food`, `keeta`, `open_delivery` |
  | `outro` | `anotaai` e o que não se encaixar |

- **Marketplace:** `cliente` **sempre `null`**, mesmo que o Regem saiba quem é (decisão de 09/09/2026, D-A2.5-11).
- **`cliente`:**
  - vem só com `clientes.telefone.ler`; `telefone` em E.164 ou `null`;
  - o Liame transforma o telefone em índice cego na chegada e **não o guarda** (ADR-019 item 8);
  - `novo`: primeiro pedido do cliente na loja, ou `null` se o Regem não souber.
- **`itens[].custo_centavos`:** custo efetivo da ficha técnica × quantidade. `null` quando não há ficha ou o token não tem `custos.ler`: margem desconhecida ≠ zero.
- **`origem` (C3a):**
  - é o clique captado pelo cardápio online no **primeiro acesso** da sessão e guardado até o checkout;
  - fica numa tabela própria só da nuvem (`pedido_origem`), sem coluna nova no `pedido_externo`;
  - é `null` quando não houve captura;
  - os valores vão **como vieram na URL** (o Liame valida o formato).
- **`versao`:** cresce a cada mudança do pedido que altere algum campo acima: confirmação, cancelamento, estorno, item, cupom, origem.

### 2.3 `GET {base}/clientes/anonimizados` · `clientes.anonimizacao.ler`

Parâmetros: `cursor`, `limite`. Devolve `{ "itens": [{ "id": "<cliente_id>", "anonimizado_em": "…", "versao": 1, "atualizado_em": "…" }], … }`. O Liame apaga o cliente pseudonimizado ligado a esse id **em até 1 dia** (critério A2.5-7; Contrato de dados 7.2).

### 2.4 Cupons

Pelo [contrato de cupons](cupons.md), no mesmo endereço base (`{base}/cupons`, `{base}/cupons/usos`).

## 3. Eventos (C3b, depois do MVP)

Standard Webhooks, um segredo por conexão, a partir da fila de saída do Regem (`aviso_integracao`, mig 289), só da nuvem:

- `pedido.alterado` → `{ "tipo": "pedido.alterado", "id": "<pedido_id>", "versao": 18 }`
- `cliente.anonimizado` → `{ "tipo": "cliente.anonimizado", "id": "<cliente_id>" }`
- `cupom.alterado` e `cupom.usado` (contrato de cupons §4).

Só gatilho de frescor: o Liame lê pela rota com cursor. Sem eventos, a leitura com cursor a cada 15 minutos e a reconciliação diária bastam (D-A2.5-5).

## 4. Captura do clique no cardápio (C3a)

- **Parâmetros lidos no primeiro acesso:** `lk`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`, `campaign_id`, `adset_id`, `adgroup_id`, `ad_id`, `gclid`, `gbraid`, `wbraid` e `fbclid`, com a hora da captura.
- **Onde ficam:** guardados na sessão do pedido (não em cookie de terceiros) até o checkout; vão para `pedido_origem` com o id do pedido.
  - Novo acesso com outros parâmetros **substitui** a captura: vale o último clique antes do pedido.
  - Sem parâmetro nenhum, a captura anterior continua.
- **Formato:** o que chega com formato estranho ou comprimento acima de 1.024 caracteres é descartado.
- **Aviso de privacidade:** entra no cardápio da loja (a loja é controladora). O texto é aprovado pelo dono (A0-6; P-R).
- **Uso:** medir a venda da própria loja é medição. **Enviar à plataforma** (conversões, A5) é outra finalidade e exige consentimento com prova (C3c; base §6).
