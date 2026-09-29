# Contrato RegemCast → Liame (conversas abertas por anúncio)

> **Versão 1 · 29/09/2026.** ADR-019 e `plano-a25.md` (C2a, C2b, F7). As convenções (autorização, cursor, versão, erros) são as do [contrato de cupons](cupons.md) §1 e §2.

## 1. Autorização (C2b)

- **Token:** por conta do RegemCast (o número de WhatsApp da loja), com o prefixo `rct_it_`.
  - Guardado só em hash.
  - Escopo **`conversas.anuncio.ler`**.
  - Revogável.
- **Emissão:** no piloto, pela distribuição, direto no cofre do Liame. No produto, pelo mesmo fluxo de autorização do Regem (código + PKCE).

## 2. Rota

### `GET {base}/conversas-anuncio` · `conversas.anuncio.ler`

Parâmetros: `cursor`, `limite`, `desde` (carga inicial de 90 dias). Devolve **só** as conversas abertas por anúncio de clique para WhatsApp. Em cada uma vêm o `referral` da **primeira mensagem** (C2a) e o telefone de quem escreveu. **Nenhum conteúdo de mensagem**.

```json
{
  "itens": [
    {
      "id": "conv-7f1…",
      "versao": 1,
      "atualizado_em": "2026-09-24T19:12:44Z",
      "numero_loja": "+5521999990000",
      "telefone": "+5521988887777",
      "aberta_em": "2026-09-24T19:12:40Z",
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

- **`telefone`:** em E.164, como o RegemCast normaliza (com o nono dígito). O Liame transforma em índice cego na chegada e não guarda o telefone.
- **`ctwa_clid`:** pode vir `null`, porque a Meta o omite em anúncio no Status do WhatsApp (base §2.4).
- **Coexistência:** a Meta **não garante** o `referral` para número em coexistência (base §2.4, [NC]). O RegemCast grava o que chegar, e a conferência com número real é pré-requisito do caminho B (D-A2.5-9).
- **Endereço:** o endereço base (`{base}`) do RegemCast é configuração da distribuição e se define na C2b.

## 3. Evento (opcional)

`conversa_anuncio.aberta` → `{ "tipo": "conversa_anuncio.aberta", "id": "…", "versao": 1 }`, em Standard Webhooks, só como gatilho.
