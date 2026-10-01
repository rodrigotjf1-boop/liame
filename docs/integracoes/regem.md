# Contrato Regem → Liame (vendas da loja)

> **Versão 1 · 29/09/2026**, com as emendas da leitura do código do Regem (plano da trilha C, 29/09/2026): venda `removido`, `faturado_em`, cupom e uso apagados como lápide, estorno só pela situação, `cardapio_url` e o grupo dos canais sem captura de clique. ADR-019 e `plano-a25.md` (C1a, C1b, C1c, C3a, C3b). O Regem é a **autoridade** do pedido, da receita e do custo (Metric Authority Matrix, `data-model.md` §4.1). Este contrato é o que o Regem implementa (rotas só da nuvem) e o que o conector do Liame (F4) consome. As convenções (autorização, cursor, versão, erros, idempotência) são as do [contrato de cupons](cupons.md) §1 e §2; os cupons seguem aquele contrato.

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

- **Token do piloto (decisão do dono, 29/09/2026):** sai sem `clientes.telefone.ler` e sem `custos.ler`, só com os outros 5 escopos. O Liame já trata isso pelo contrato: `cliente` e `custo_centavos` vêm `null`, o caminho B (conversa → pedido) fica desligado, e os Resultados mostram "margem incompleta", sem veredito. Liberar os dois depois é emitir um token novo e revogar o antigo.

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

Quem é a loja do token: `{ "loja_id", "loja_nome", "empresa_nome", "fuso", "moeda", "escopos": [...], "cardapio_url" }`.

- O Liame usa na conexão: nome da loja, fuso e escopos concedidos.
- Depois, relê a rota **uma vez por dia por loja**, na reconciliação, e atualiza o `cardapio_url` quando ele muda (30/09/2026). Campo ausente mantém o endereço gravado; `null` tira o cardápio da loja.
- `cardapio_url` é o endereço público do cardápio online da loja (ou `null` sem cardápio). O construtor de links do Liame (F5) só aceita destino dentro dele (V33).

### 2.2 `GET {base}/pedidos` · `pedidos.ler`

- **Parâmetros:**
  - `cursor`, `limite`;
  - `confirmados_desde` (instante; só na carga inicial de 90 dias, D-A2.5-5).
- **O que entra:**
  - todo pedido **confirmado** da loja, de qualquer origem (cardápio online, WhatsApp, balcão, mesa, totem, marketplaces), e o **cancelado** depois de confirmado;
  - pedido que nunca foi confirmado não entra;
  - a mesma venda aparece uma vez só: a do pedido externo pelo id do pedido; a de balcão, mesa ou totem direto pela comanda sem pedido. É a regra do faturamento do Painel (`comandaEhDeCanal`).
  - A comanda sem pedido só sai depois de 10 minutos sem mudança. Se ela for publicada e depois virar parte de um pedido, sai de novo com **`situacao: "removido"`**: o Liame a tira das contas (não é cancelamento).

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
      "faturado_em": "2026-09-26T22:58:00Z",
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
  - O Liame não recalcula (D-A2.5-6). A soma dos pedidos confirmados de um dia, pelo `faturado_em` no fuso da loja, tem de bater ao centavo com o **"Faturamento" do Painel** da loja (critério A2.5-2). O "Relatório de vendas" do Regem soma de outro jeito e não é a referência.
- **`faturado_em`:** o instante que o Painel usa para pôr a venda no dia (pedido: a criação; comanda: o fechamento). O Liame agrupa a receita por ele. A janela da atribuição continua contando até `confirmado_em`.
- **`desconto_loja_centavos`:** informativo, já descontado da receita.
- **`cupom`:** o código do cupom usado. É o do Regem (cardápio, balcão) ou, no pedido de plataforma de pedidos integrada (Anota AI, CardápioWeb), o código que ela manda no desconto (Regem #594, 30/09/2026). Pedido de marketplace nunca traz cupom. O Liame grava em maiúsculas e compara sem diferenciar maiúsculas e minúsculas (F6).
- **`estornado_centavos`:** na v1 é sempre 0. O Regem não tem estorno parcial: cancelar desfaz a venda inteira, e isso chega pela `situacao`.
- **`situacao`:** `confirmado`, `cancelado` (depois de confirmado) ou `removido` (venda que deixou de existir sozinha, acima).
- **`grupo_canal`** (o Regem mapeia o `canal` dele):

  | Grupo | Canais do Regem |
  | --- | --- |
  | `cardapio` | `cardapio` (o único com captura do clique, C3a) |
  | `whatsapp` | pedido do bot de WhatsApp, quando houver marcador próprio. Hoje o bot manda o link do cardápio, e o pedido entra como `cardapio` |
  | `presencial` | comanda de `balcao`, `mesa` e `totem`; pedido do `totem` e do GoGeM |
  | `marketplace` | `ifood`, `99food`, `keeta`, `open_delivery`, `rappi`, `ubereats` |
  | `outro` | `anotaai`, `cardapio_web`, `delivery_direto`, `manual` e o que aparecer (sem captura de clique: só cupom atribui) |

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
- **`versao`:** cresce a cada mudança do pedido que altere algum campo acima: confirmação, cancelamento, item, cupom, cliente, origem.
- **`atualizado_em`:** vem de uma tabela de versões só da nuvem, carimbada depois que a venda foi gravada de vez, e não do `updated_at` do pedido, que chega com a hora da máquina da loja. É o que mantém o cursor sem buracos.
- **Custo:** o do momento da leitura (o mesmo da Curva ABC). Mudar o custo depois não gera versão nova: para o Liame, vale o custo da primeira leitura da venda.

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
