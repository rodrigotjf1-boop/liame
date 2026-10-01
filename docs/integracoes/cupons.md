# Contrato de cupons (neutro de produto)

> **Versão 1 · 29/09/2026**, com a emenda de 30/09/2026 (faixa do percentual e cupom que o Liame não guarda, §3.1). Decisão do dono (D-A2.5-3, `plano-a25.md`) e ADR-019. O cupom **vive no sistema de vendas** (Regem hoje; GoGeM e outros depois), onde é resgatado. O Liame lê os cupons e os usos para ligar a campanhas, e cria cupons pelo Action Service. Qualquer sistema que implementar este contrato conecta ao Liame **sem código novo** no Liame: o endereço base de cada produto é configuração da distribuição, nunca informado pelo usuário.
>
> **Hoje por REST.** Quando o hub MCP da DMS existir (ADR-008, trilha B), as mesmas operações saem como ferramentas (`cupons_listar`, `cupons_usos_listar`, `cupom_criar`, `cupom_desativar`), com os mesmos escopos.

## 1. Autorização

- **Token:** `Authorization: Bearer <token>`.
  - É o token da loja, emitido pelo produto (ADR-019 itens 2 e 3): opaco, guardado só em hash no produto, uma loja por token, revogável.
  - O produto responde só com os dados da loja do token. Não existe parâmetro de loja.
- **Escopos:**
  - cada rota confere o seu escopo;
  - o que o token não tem volta **403**;
  - o token revogado ou vencido volta **401**, e o Liame marca a conexão como desconectada.

| Escopo | Libera |
| --- | --- |
| `cupons.ler` | listar cupons com regra e validade |
| `cupons.uso.ler` | listar usos (pedido, momento, valor do desconto), sem dado do cliente |
| `cupons.criar` | criar e desativar cupom |

## 2. Convenções

- JSON em UTF-8, nomes em `snake_case`.
- **Dinheiro:** centavos inteiros (`*_centavos`), nunca ponto flutuante.
- **Instantes:** ISO 8601 com fuso. **Datas:** `AAAA-MM-DD` no fuso da loja, que vai em `fuso`.
- **Erros:** RFC 9457 (`application/problem+json`) com `type`, `title`, `status` e `detail`.
  - Limite de chamadas: **429** com `Retry-After`.
  - 5xx pode repetir com espera.
- **Paginação por cursor opaco:**
  - a ordem é estável por (`atualizado_em`, `id`); a página traz `itens`, `proximo_cursor` e `tem_mais`;
  - o produto só devolve registros com `atualizado_em` de pelo menos 5 segundos atrás: uma transação que confirma tarde não fica para trás do cursor;
  - `limite` padrão 200, máximo 500.
- **Versão do recurso:** `versao` é um inteiro que **só cresce** a cada mudança. O Liame aplica a maior versão e ignora a menor.
- **Idempotência nas escritas:** o cabeçalho `Idempotency-Key` é obrigatório (até 24 h).
  - A mesma chave com o mesmo corpo devolve a mesma resposta.
  - A mesma chave com outro corpo devolve **422** (`chave-reutilizada`).
  - A mesma chave ainda em processamento devolve **409** (`chave-em-uso`).

## 3. Rotas

O endereço base é do produto (Regem: `https://api.dmsregem.com/api/v1/integracao`).

### 3.1 `GET {base}/cupons` · `cupons.ler`

Parâmetros: `cursor`, `limite`. Devolve os cupons que valem para a loja do token, os da loja e os de todas as lojas da empresa.

```json
{
  "itens": [
    {
      "id": "8d9d5c1e-4b0f-4f5e-9a51-2f0a8c6f7a11",
      "versao": 4,
      "atualizado_em": "2026-09-28T14:02:11.382Z",
      "codigo": "COMBOSEXTA",
      "nome": "Combo de sexta",
      "tipo": "percentual",
      "percentual": "10.00",
      "valor_centavos": null,
      "teto_desconto_centavos": 1500,
      "pedido_minimo_centavos": 4000,
      "valido_de": "2026-09-26",
      "valido_ate": "2026-10-31",
      "fuso": "America/Sao_Paulo",
      "ativo": true,
      "max_usos": 300,
      "usos": 42,
      "condicoes": { "somente_novos": false, "max_por_cliente": 1, "min_dias_sem_compra": null },
      "todas_as_lojas": false,
      "removido": false
    }
  ],
  "proximo_cursor": "eyJ0IjoiMjAyNi0wOS0yOFQxNDowMjoxMS4zODJaIiwiaSI6IjhkOWQ1YzFlIn0",
  "tem_mais": false
}
```

- `tipo`: `percentual` (usa `percentual`, texto com 2 casas, **maior que 0 e até 100**), `valor` (usa `valor_centavos`), `frete_gratis`, `outro`.
  - Percentual fora dessa faixa sai como **`tipo: "outro"`, sem `percentual`** (é o que o Regem faz; emenda de 30/09/2026). Percentual fora da faixa é resposta fora do contrato: o Liame recusa a página de cupons e tenta de novo mais tarde, sem parar a leitura dos pedidos.
- `max_usos` e `usos` cabem num inteiro de 32 bits. O cupom que o banco do Liame não guarda (código vazio depois de tirar os espaços, número acima desse limite, data do ano 0000, fuso fora da lista da IANA com data de validade, texto com o caractere nulo) **fica de fora da leitura, com o motivo no registro do Liame**, e o resto da página segue.
- `valido_ate` é o último dia em que o cupom vale. Sem data, o campo vem `null`.
- `codigo` sempre em maiúsculas.
- **Cupom apagado** no sistema de origem sai como lápide: o mesmo `id`, versão nova e `"removido": true`. O Liame tira o cupom da lista e desliga as ligações com campanhas.
- `todas_as_lojas` é informativo: diz se o cupom foi cadastrado para a empresa inteira. Onde o cupom vale de fato é regra do sistema de origem.

### 3.2 `GET {base}/cupons/usos` · `cupons.uso.ler`

Parâmetros: `cursor`, `limite`, `desde` (instante; carga inicial). **Sem dado do cliente**: o uso liga cupom e pedido, e quem comprou fica no pedido, sob o escopo dele.

```json
{
  "itens": [
    { "id": "…", "versao": 1, "atualizado_em": "…", "cupom_id": "8d9d…", "codigo": "COMBOSEXTA", "pedido_id": "…", "usado_em": "2026-09-26T23:00:00Z", "desconto_centavos": 599, "removido": false }
  ],
  "proximo_cursor": "…",
  "tem_mais": false
}
```

### 3.3 `POST {base}/cupons` · `cupons.criar`

O sistema de origem cria o cupom na loja do token e **nunca** atualiza um cupom existente pelo código (409). O Liame chama esta rota **só pelo Action Service**, depois da aprovação e com a flag de escrita do provider ligada (ADR-019 item 6). Cabeçalho `Idempotency-Key` obrigatório.

```json
{
  "codigo": "LIAMEMETA10",
  "nome": "Meta · Combo de sexta",
  "tipo": "percentual",
  "percentual": "10.00",
  "teto_desconto_centavos": 1500,
  "pedido_minimo_centavos": 4000,
  "valido_de": "2026-10-01",
  "valido_ate": "2026-10-31",
  "max_usos": 300,
  "condicoes": { "max_por_cliente": 1 }
}
```

Respostas:

- **201:** o cupom criado, no formato da 3.1.
- **409:** o código já existe, com `type` `…/codigo-em-uso`.
- **422:** regra inválida.

### 3.4 `POST {base}/cupons/{id}/desativar` · `cupons.criar`

Desfaz a criação (compensação, ADR-019 item 6). Cabeçalho `Idempotency-Key` obrigatório. Vale só para cupom **criado pela integração**; outro cupom responde **404**. Devolve **200** com o cupom (`ativo: false`). Cupom já inativo devolve **200** sem mudança.

## 4. Eventos (opcional)

Webhook no padrão **Standard Webhooks** (cabeçalhos `webhook-id`, `webhook-timestamp` e `webhook-signature`), com um segredo por conexão, para o endereço que o Liame informa na conexão (`POST https://api.agencialiame.com/v1/inbox/{provider}/{connection_id}`):

- `cupom.alterado` → `{ "tipo": "cupom.alterado", "id": "<cupom_id>", "versao": 5 }`
- `cupom.usado` → `{ "tipo": "cupom.usado", "id": "<uso_id>", "cupom_id": "…", "pedido_id": "…" }`

O evento é **só gatilho**: o Liame lê pela rota com cursor em seguida. Evento perdido, repetido ou fora de ordem não muda o resultado (ADR-019 item 5).

## 5. Quem implementa

| Sistema | Situação | Onde |
| --- | --- | --- |
| Regem | no ar desde 30/09/2026 (trilha C, C1c); o Liame chama a criação (§3.3) pela ferramenta `regem_cupom_criar` desde 01/10/2026, com a flag `regem_write` desligada | rotas só da nuvem, sob o token por loja (C1a) |
| GoGeM | futuro | — |
