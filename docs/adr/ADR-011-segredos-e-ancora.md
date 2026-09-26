# ADR-011 — Chave mestra fora do banco e âncora externa da auditoria

- **Status:** Aceito · 26/09/2026 (proposto em 24/09/2026; aprovado com o plano completo pelo dono)
- **Decide:** onde vive a KEK do envelope encryption e onde a auditoria é ancorada
- **Base:** base de conhecimento §13.2 e §13.3

## Contexto

Tokens OAuth de Meta, Google, TikTok e WhatsApp dão controle das contas dos clientes. A chave mestra (KEK) não pode ficar no mesmo nível de comprometimento do banco. A cadeia de hash da auditoria pode ser recalculada por quem controla o banco, então precisa de âncora externa.

## Opções: chave mestra

| Opção | Custo/mês | Latência (VPS BR) | Log de uso | Veredito |
| --- | --- | --- | --- | --- |
| **AWS KMS sa-east-1** | ≈ US$1–4 | 5–20 ms | CloudTrail registra Decrypt por padrão | **Escolhido** |
| GCP Cloud KMS | ≈ US$0,4–3 | 5–20 ms | log de decrypt desligado por padrão e pago | Equivalente, mais barato |
| Vault / OpenBao Transit | só infraestrutura | 1–10 ms | fail-closed | Operação alta (unseal, HA) |
| Infisical / Doppler / 1Password | US$0–23 | 120–230 ms | variável | Cofre: a KEK chega em claro ao app |
| **Supabase Vault** | 0 | — | — | **Rejeitado:** quem tem SQL lê `vault.decrypted_secrets` |

## Opções: âncora

| Opção | Custo/ano | Resiste ao dono da credencial? | Detecta equivocação do operador? | Veredito |
| --- | --- | --- | --- | --- |
| **S3 Object Lock (compliance), conta AWS dedicada** | ≈ US$0,003 | ✅ nem o root apaga | Parcial | **Escolhido: armazenamento WORM** |
| **Sigstore Rekor + RFC 3161** | 0 | ✅ | ✅ log público | **Escolhido: prova independente** |
| Backblaze B2 Object Lock | 0 | ✅ | Parcial | Alternativa |
| ACT ICP-Brasil + e-CNPJ | ≈ R$22 | ✅ | Parcial | Quando houver exigência jurídica (presunção de veracidade, MP 2.200-2 art. 10 §1º) |
| Cloudflare R2 Bucket Locks | 0 | ❌ quem tem o token remove a regra | ❌ | **Rejeitado** |
| OpenTimestamps | 0 | ✅ | Parcial | Terceira âncora opcional |

## Decisão

1. **KEK no AWS KMS, sa-east-1.**
   - Chave simétrica com rotação automática.
   - `GenerateDataKey` com **contexto de cifragem** `{tenant_id, provider, token_id}`.
   - IAM mínimo (só `GenerateDataKey` e `Decrypt` nessa chave), com trava pelo IP da VPS.
   - CloudTrail ligado e alarme de volume anormal de `Decrypt`.
   - Cache curto de DEK.
   - A credencial do KMS **nunca** fica no banco.
   - Na escala: IAM Roles Anywhere (sem chave de longa duração) e réplica multi-região.
   - Se precisar de KEK por tenant (crypto-shredding): avaliar GCP com chave em software ou OpenBao Transit.
2. **Âncora da auditoria:**
   - `daily_root_hash` global (não por tenant, com salt interno), **encadeado ao root do dia anterior**.
   - Gravado em **S3 Object Lock compliance mode** numa **conta AWS dedicada**. A credencial do app só grava e lê; a chave do objeto é a data.
   - Registrado também no **Sigstore Rekor** (`hashedrekord` com ECDSA P-256 ou Ed25519ph) + **carimbo RFC 3161** (TSA gratuita no início).
   - Verificador diário: exatamente uma versão por dia, nenhum dia faltando, cadeia válida.
   - ACT ICP-Brasil + e-CNPJ entra quando houver exigência jurídica.

## Consequências

- **Fornecedor novo: AWS**, com duas contas (KMS e âncora). Custo desprezível, domínio de confiança separado do Supabase e da Hostinger. Entra na A0 (criação das contas) e na A1 (critérios A1-6 e A1-13).
- Invadir a VPS permite decifrar só enquanto o acesso durar. Revogar a credencial IAM fecha a porta sem recifrar a base. Os tokens expostos na janela precisam ser revogados nas plataformas: runbook de incidente.
- **Dado publicado no Rekor é público e permanente:** só o hash, nunca conteúdo.

## Implementação do cofre (E4, 26/09/2026)

- `apps/server/src/vault/`: envelope AES-256-GCM; cada segredo tem a própria chave de dados, gerada pela chave mestra (KEK) e **amarrada ao registro** pelo contexto (`purpose`, `secret_id`, `tenant_id`/`user_id`), que também é o *encryption context* do KMS.
- Provedor `aws-kms` (produção: `KEY_PROVIDER=aws-kms`, `AWS_KMS_KEKS="1:alias/..."`, região sa-east-1) e provedor `local` (desenvolvimento e testes: `LIAME_KEK_LOCAL`); em produção o local é recusado na subida.
- **Rotação (A1-13):** `rotateSecrets` recifra por completo os segredos em versão antiga da KEK, em lotes com `for update skip locked`; depois disso, a versão antiga pode sair.
- Tabela `liame.secret` (migration 0003) com RLS: segredo da empresa só no tenant dela; segredo pessoal (app autenticador) só para a própria pessoa.
- A âncora da auditoria (S3 Object Lock, Rekor, RFC 3161) entra na E3.
