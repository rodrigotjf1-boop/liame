# Liame — Decisões de design

> Registro das decisões de produto e design. Decisões técnicas estruturais ficam nos ADRs (`docs/adr/`). Toda decisão nova entra no **changelog** (§4) com data.

## 1. Decisões de produto

| ID | Decisão | Data | Situação |
| --- | --- | --- | --- |
| D1 | Sempre em **modo distribuição** para vários clientes; base de testes = um restaurante em plena operação | 24/09/2026 | Decidida |
| D2 | Login próprio no molde do RegemCast (guard global fail-closed, RLS), preparado para virar cliente OIDC do DMS ID | 24/09/2026 | Decidida (ver ADR-009) |
| D3 | EasyPanel na VPS do Brasil + projeto Supabase próprio em São Paulo | 24/09/2026 | Decidida |
| D4 | ~~30 dias em sombra → sugerir → piloto com teto~~ → **Autonomy Readiness Score** com gates; os 30 dias ficam só como referência | 24/09/2026 | **Revisada** pela revisão arquitetural |
| D5 | Mensal por marca, PIX/cartão, sem % do gasto, sem fidelidade, cancelamento em 1 clique; IA como franquia por plano | 24/09/2026 | Decidida |
| D6 | **Nome definitivo: Liame** (elo, conexão), com logo, kit de mídia e manual da marca v1.0 em `OneDrive\Liame\kit midia\LIAME-Kit`. Sub-marca **LIA** (Liame + IA), a assistente, que assina "LIA · by Liame" e é o funcionário de Atendimento. Assinatura: "Todas as mídias. Uma inteligência." Domínio: **agencialiame.com**. Apps das plataformas no nome da DMS Tecnologia, ou seja, da **SISTER TECNOLOGIA LTDA**, CNPJ 67.748.508/0001-43 (26/09/2026) | 24/09/2026 | Decidida |
| D7 | Experiência de **agência completa**: **cada agente criado, com suas responsabilidades, equivale a um funcionário**. O número não é fixo ("3" foi só um exemplo). O catálogo inicial tem 14 funcionários (vindos das skills) e cresce por fase. Por dentro, os funcionários são **definições versionadas** executadas por motores compartilhados, workflows e políticas | 24/09/2026 | Decidida (esclarecida pelo dono) |
| D8 | **Modos de exibição Lite e Pro.** Lite = **visão do dono**, com página inicial própria (**Resumo**: quanto vendi, quanto sobrou, o que precisa de mim, clientes, canais, orçamento, o que a equipe fez) e botões da LIA que explicam e completam; Pro = **recursos completos da LIA**, com página inicial **Atenção**. Nada some no Lite (o resto está a um clique). Substitui o "modo agência × modo gestor". Modo é preferência, não permissão | 25/09/2026 | Aprovada em 26/09/2026 |
| D10 | **Acesso delegado por e-mail**, como nas contas do Google: o dono convida quem administra por ele, com nível, limite de gasto e remoção na hora; a conta é sempre do dono (ADR-017) | 25/09/2026 | Aprovada em 26/09/2026 |
| D11 | **Uso de IA por estudo de caso:** cada situação de uso tem um estudo de custo e de quem arca com ele; em certos casos o custo é do cliente. O Liame mostra a estimativa antes, sugere a forma mais econômica e só executa com aprovação quando o custo for do cliente (Termos 10.2; AI Usage Ledger) | 26/09/2026 | Decidida pelo dono |
| D9 | **Modelo de IA por finalidade** (conversa, análise, texto criativo, imagem, vídeo), escolhido dentro de um catálogo curado: Lite = automático, Pro = escolhe. Sem chave própria do cliente por enquanto (ADR-016) | 25/09/2026 | Aprovada em 26/09/2026 |

## 2. Design system

**Identidade Liame** (manual da marca v1.0, `07-Cores-e-Fontes/liame-tokens.css`). Os componentes usam só os tokens semânticos abaixo, e as cores da marca entram como valores deles.

| Papel | Token da marca | Valor |
| --- | --- | --- |
| Fundo principal (tema escuro) | Noite | `#0B0D17` |
| Cartão sobre escuro · linha | card · linha | `#151A2E` · `#2B3150` |
| Inteligência (IA, LIA) | Violeta IA | `#7B61FF` |
| Conexão e **ação** (links, botões) | Ciano Link | `#2DD4DE` |
| Fundo claro / texto sobre escuro | Papel | `#F4F2EC` |
| Apoio do M | Lavanda · Lavanda clara · Petróleo | `#A08FFF` · `#CFC6FF` · `#1BA8B8` |
| Acentos | Âmbar (avaliações) · Coral (engajamento) | `#FFC24B` · `#FF6B6B` |
| Texto secundário no escuro | Cinza | `#9AA0B4` |
| Títulos · texto · destaques | Poppins | 700 · 400 · 500 |
| Rótulos, números, dados | JetBrains Mono | caixa alta, espaçamento largo |

- **Logo:** área de proteção = espessura da haste do L; mínimo de **120 px** de largura no digital (abaixo disso, versão sem ícones ou símbolo L; símbolo com mínimo de 32 px). Não distorcer, não trocar cores, não girar, não usar sobre fundo poluído.
- **Web:** hero escuro com a rede de nós, títulos grandes em Poppins Bold, botões em ciano e a LIA sempre presente como chat.
- **Acessibilidade:** o ciano e o violeta da marca entram como fundo e destaque. **Texto** sobre fundo claro usa tons derivados mais escuros (ex.: violeta `#5A43D8`, petróleo `#0E7C86`) para cumprir contraste AA.

**Tokens semânticos (os componentes só usam estes nomes):**

`surface`, `surface-elevated`, `surface-sunken`, `text-primary`, `text-secondary`, `text-muted`, `border-subtle`, `border-strong`, `action`, `action-contrast`, `success`, `warning`, `danger`, `info`, `focus-ring`, `money-positive`, `money-negative`, `freshness-fresh`, `freshness-stale`.

- Tailwind 4 com configuração **CSS-first** (`@theme`): os tokens viram variáveis CSS; tema claro, tema escuro e white-label são só outro conjunto de valores.
- **Proibido** cor crua nos componentes (`bg-blue-500`, `text-gray-700`), com lint que barra.
- Acessibilidade: contraste AA, foco visível, `aria-pressed` e `aria-expanded`, `caption` sr-only em tabelas, `prefers-reduced-motion`.
- Responsivo por padrão (≈375 px); tabelas em `overflow-x-auto`; datas e horas com seletor nativo.
- Textos em pt-BR, sentence case, voz ativa. Toda ação tem feedback e todo estado vazio é desenhado.

## 3. Padrões de interface

- **Home "Atenção":** cartões priorizados por dinheiro envolvido, cada um com motivo, evidência, ação recomendada e freshness.
- **Approval Inbox:** agente, ação, motivo, evidência, antes → depois, risco, impacto financeiro, prazo, `plan_id`; aprovar, editar, rejeitar, pedir nova análise.
- **Ctrl+K:** buscar campanha, abrir cliente, ver alerta, gerar relatório, pausar anúncio (vira Action Request), buscar pedido, perguntar ao Liame.
- **Explicação** em toda recomendação: ação, motivos com números, risco, impacto estimado.
- **Freshness** visível em todo número.
- **Transparência de IA:** os funcionários se identificam como assistentes de IA.

## 4. Changelog

| Data | Mudança |
| --- | --- |
| 26/09/2026 | **Kit da LIA em 3D** (v1.4) no repositório, em `lia-agente-3d/`, como referência de identidade e com uso liberado pelo dono no app (a landing já usa). Onde e como usar em `ux-modelo-interface.md` §6.1: painel da conversa, onboarding, estados vazios e avatar 2D de reserva; three.js e fontes servidos pelo próprio app (sem CDN), 3D carregado sob demanda, visual `executiva` como padrão. |
| 26/09/2026 | **Primeira tela do app (E10a): "Pessoas e acessos"**, portada do protótipo aprovado com o shell (menu lateral, trilho no tablet, gaveta no celular). O navegador fala **direto com a API** (cookie de sessão da API, `SameSite=Lax`; web e API em subdomínios do mesmo site). Fontes do kit servidas pelo próprio app (sem rede no build, ERR-018). Divergências do protótipo, conscientes: menu só com as telas que existem; sem Lite/Pro, busca, LIA, avisos e frescor dos dados na barra do topo (chegam com as suas fases); no celular, botão de menu no topo em vez da barra inferior; botão **Sair** ao lado do tema; seletor de empresa abre a lista das empresas; sem "O que fez" (LIA, A3), "Transferir a propriedade" (fora da A1) e "Desfazer" depois de remover (remover vale na hora; o caminho de volta é convidar de novo); textos ajustados ao comportamento real (a pessoa alterada não recebe e-mail; quem não é o dono lê "o dono também aprova"); estados novos: carregando, erro com nova tentativa, sem permissão, sem empresa, "Falta ativar o app autenticador" e "Ainda não entrou". Entrar, segundo fator e aceite de convite **não têm mockup**: protótipo a aprovar antes do código. |
| 26/09/2026 | **Plano completo aprovado pelo dono** ("o roadmap nosso completo foi aprovado"): ADR-001 a ADR-017 aceitos; especificação, arquitetura, modelo de dados, segurança (com o threat model v1.1), IA, integrações, roadmap, modelo de interface (Lite e Pro) e plano da A1 aprovados. Empresa que presta o Liame: **SISTER TECNOLOGIA LTDA** (DMS Tecnologias), CNPJ 67.748.508/0001-43; encarregado de dados: Rodrigo de Oliveira. **D11** (uso de IA por estudo de caso). |
| 25/09/2026 | **A0-6 e A0-10:** rascunhos dos Termos de Uso, da Política de Privacidade e do Contrato de Tratamento de Dados em `docs/juridico/` (v0.1, com verificação legal nas fontes oficiais, base §6.1), aguardando os dados da empresa, 13 decisões do dono e a revisão jurídica. Uso político e eleitoral passa de "bloqueado por padrão" a **proibido**; dados das APIs do Google **não vão para outras plataformas de anúncio**. Threat model v1.1 (`security-model.md` §2.1). **Plano da A1** para aprovação (`plano-a1.md`). |
| 25/09/2026 | **Implementação iniciada (A0-3, spike):** monorepo pnpm 12 + Turborepo, server Nest 12 **em ESM** (decidido por A/B medido, ADR-001), web Next 16 com os tokens do protótipo, CI pronto. **A0-3 cumprido:** verde localmente (PG 18.4) e no CI (Node 24.21 + Postgres 17), 16/16 testes com banco; repositório privado `rodrigotjf1-boop/liame`. Testes com os papéis da nuvem (`docs/testes.md`). Andamento em `docs/andamento.md`. |
| 25/09/2026 | **Modelo de interface proposto (aguarda aprovação):** B · "Central da agência" (moderno, com a LIA sempre à mão e a equipe ao vivo). Protótipo em `mockups/prototipo-app.html`; decisão, tokens, contraste e divergências em `docs/ux-modelo-interface.md`. |
| 25/09/2026 | Lite refinado como **visão do dono** (página inicial **Resumo**) e Pro como **recursos completos da LIA** (D8); **acesso delegado por e-mail** (D10, ADR-017) com a tela "Pessoas e acessos" no protótipo. Landing **agencialiame.com** no ar; termos de uso e política de privacidade ainda não publicados (A0-6). |
| 25/09/2026 | Pedidos do dono analisados: modos **Lite e Pro** (D8, no protótipo); **segundo fator por app autenticador** e permissão fina por rota (ADR-013); **ciclo de vida e expurgo** (ADR-014); **política de erros** (`arquitetura.md` §14); **Vigia de integrações** (ADR-015); **modelos por finalidade** (D9, ADR-016). RBAC, `@roles`/`@policies` e tenant já estavam cobertos (só a convenção foi fixada). |
| 24/09/2026 | Plano mestre v1–v4 (pesquisa, D1–D7). |
| 24/09/2026 | Domínio **agencialiame.com** criado; pasta do projeto renomeada para `C:\Liame`. |
| 24/09/2026 | **Nome definitivo Liame** + identidade do kit de marca (D6 atualizada; LIA = Atendimento). |
| 24/09/2026 | Revisão arquitetural: tese de plataforma operacional; A2.5 (ciclo fechado) antes da inteligência; D4 → Readiness Score; N0–N3 → 6 modos de autonomia granulares; "desfazer" → compensating action; "CRM vence" → Metric Authority Matrix; Guardião → Policy Engine determinístico + Revisor de IA; AI Gateway provider-agnostic; Tool Registry; MCP só para fora; stack atualizada (ADR-001); monólito modular com um app Nest em dois processos (ADR-002); DMS ID = Logto OSS self-host (ADR-009); KEK no AWS KMS + âncora S3 Object Lock/Rekor/RFC 3161 (ADR-011); AI Gateway sobre Vercel AI SDK 7 (ADR-006); OTel + Collector + Grafana Cloud BR (ADR-010); OpenFeature + Postgres (ADR-012). Base de conhecimento do nicho criada como consulta obrigatória (`CLAUDE.md` §1). |
