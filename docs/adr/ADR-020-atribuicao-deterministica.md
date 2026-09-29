# ADR-020 — Atribuição determinística e versionada

- **Status:** Aceito · 29/09/2026 (aprovado com o plano da A2.5 pelo dono)
- **Decide:** como um pedido confirmado no caixa ganha (ou não) uma campanha de origem
- **Base:** `plano-a25.md` (D-A2.5-1, D-A2.5-6 a D-A2.5-8, D-A2.5-11) · `data-model.md` §4 · especificação §5.4 e §7 · princípio "a IA assessora, o código decide"

## Contexto

O ROAS confirmado no caixa é o número mais importante do Liame e o mais fácil de inflar. As plataformas atribuem com as próprias regras e janelas: a Meta conta visualização, e o Google tem janela de 30 dias por padrão. Um modelo "provável" ou feito por IA não pode ser conferido nem auditado. Pedido sem evidência que ganha campanha por palpite vira venda inventada.

## Decisão

1. **O modelo é dado, não código espalhado.** `attribution_model` guarda:
   - chave, versão, a hierarquia de evidências, a janela em dias e se visualização conta;
   - a versão é **imutável**: mudar a regra cria uma versão nova.
   - Cada `attribution_result` diz o modelo e a versão que o produziram.
2. **Modelo inicial `ultimo_toque` v1** (D-A2.5-1):
   - hierarquia: **cupom exclusivo da campanha** > **clique com id da campanha ou do anúncio** (parâmetros da URL, `lk` do link do Liame, `gclid` resolvido pela API do Google) > **conversa aberta por anúncio** com o mesmo telefone (índice cego);
   - janela de **7 dias** do toque até a confirmação do pedido; toque depois do pedido não conta;
   - **sem visualização** (não é observável no caixa);
   - um pedido dá crédito a **uma** campanha. Dentro do mesmo nível vence o toque mais recente e, no empate, o de menor id (a mesma entrada dá sempre o mesmo resultado).
3. **Confiança por evidência:**

   | Confiança | Evidências |
   | --- | --- |
   | alta | cupom exclusivo; id da campanha ou do anúncio no clique; `lk`; `gclid` resolvido |
   | média | conversa por anúncio + mesmo telefone na janela |
   | não conta | nome de campanha solto no UTM, clique sem id resolvível |

   - O **ROAS confirmado** usa só alta e média (D-A2.5-8).
   - Pedido sem evidência fica **sem origem**, e a porcentagem de pedidos sem origem aparece ao lado do ROAS.
4. **Plataforma sem campanha.** Clique com `fbclid` (ou `gclid` ainda não resolvido) sem id de campanha prova a plataforma, mas não a campanha. O pedido fica atribuído à **plataforma**, com campanha vazia: entra no total da plataforma e não entra no de nenhuma campanha.
5. **Canais sem clique** (D-A2.5-11): iFood, 99Food, Keeta, Anota Aí e balcão só ganham campanha por cupom exclusivo. O resto aparece como "canais sem clique", fora do ROAS de mídia própria.
6. **Motor em SQL de conjunto, sem IA e idempotente:**
   - uma execução (`attribution_run`) calcula por empresa, em **uma instrução**, todos os pedidos afetados (sem laço de N);
   - recalcula quando o pedido muda de versão (cancelamento, estorno), quando chega toque novo dentro da janela, ou quando o modelo muda (recálculo explícito);
   - o resultado anterior do mesmo pedido e da mesma versão de modelo é substituído na mesma transação;
   - **Cancelado ou estornado** não conta: o pedido sai do ROAS no recálculo, e o resultado fica registrado com o motivo.
7. **Casos de referência no CI:** um conjunto versionado de entradas e resultados esperados (cupom vence clique, fora da janela não atribui, empate, cancelamento, plataforma sem campanha, marketplace) roda contra o motor real no banco. Mudar a regra sem atualizar os casos reprova o CI (A2.5-3).
8. **Explicação sem IA:** cada resultado guarda a evidência usada (tipo, momento, id do toque, janela) para a tela mostrar "por que este pedido é desta campanha". A LIA só passa a explicar os números na A3, e nunca decide a atribuição.

## Consequências

- O número do Liame fica menor que o da plataforma na maioria dos casos. É o diferencial, e a tela mostra os dois com a janela de cada um.
- Vários toques (multi-touch) e incrementalidade ficam para a A8, como modelos novos na mesma tabela, sem refazer o motor.
- Configuração por marca (janela, hierarquia) entra no Pro depois, como versão própria da empresa. O modelo padrão da distribuição continua existindo.
