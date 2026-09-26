# Documentos jurídicos do Liame (A0-6)

> **Rascunho 0.1 · 25/09/2026 · para revisão jurídica.** Não é parecer jurídico. Os textos foram escritos a partir das decisões do projeto (ADR-013, 014, 016 e 017; `data-model.md` §5 e §9; `security-model.md`) e da base de conhecimento (§6, §14, §17), com os fatos legais reconferidos nas fontes oficiais (seção 4).

| Documento | Para quem | Onde publicar |
| --- | --- | --- |
| [Termos de Uso](termos-de-uso.md) | Empresas clientes e pessoas convidadas | `agencialiame.com/termos` |
| [Política de Privacidade](politica-de-privacidade.md) | Usuários, visitantes e titulares | `agencialiame.com/privacidade` (link na página inicial: exigência da Meta e do Google) |
| [Contrato de Tratamento de Dados](contrato-de-operador.md) | Empresas clientes (anexo dos Termos) | `agencialiame.com/contrato-de-dados` |

Também serão necessárias: a **página de exclusão de dados** (Meta) e a **lista de suboperadores**, que pode ficar na própria política.

## 1. O que o dono precisa decidir ou informar

| # | Item | Onde aparece |
| --- | --- | --- |
| 1 | **Empresa que presta o Liame:** razão social, CNPJ e endereço. Os sites da DMS usam hoje duas razões sociais ("SISTER TECNOLOGIA LTDA" nos rodapés; "SISTER SOFTWARE E SOLUCOES" na política do GoGeM). Os apps da Meta e do Google precisam estar no nome da mesma empresa (D6) | Os três documentos |
| 2 | **Encarregado de dados:** nome completo (ou empresa + nome da pessoa responsável) e e-mail (sugestão: `privacidade@agencialiame.com`). Recomendo nomear mesmo que a empresa seja de pequeno porte (seção 4) | Política |
| 3 | **E-mail de contato e de suporte**; canais e horário do suporte | Termos |
| 4 | **Reembolso e arrependimento em 7 dias** | Termos 11.1 |
| 5 | **Limite de IA do plano:** pausa, pacote adicional ou cobrança por excedente | Termos 10.2 |
| 6 | **Dias de inadimplência** até a suspensão | Termos 10.4 |
| 7 | **Compromisso quando uma ação for executada fora das regras por falha do Liame** (sugestão: devolver o valor gasto fora da regra, até um teto) | Termos 13.2 |
| 8 | **Teto de responsabilidade** (sugestão: o valor pago nos últimos 12 meses) | Termos 13.3 e Contrato 12 |
| 9 | **Foro** | Termos 16 |
| 10 | **Prazos do Contrato de Dados:** repassar pedido de titular (sugestão: 2 dias úteis) e avisar incidente ao cliente (sugestão: 24 horas) | Contrato 7.1 e 8.1 |
| 11 | **Fornecedores ainda não escolhidos:** e-mail do serviço, processador de pagamento, região do Langfuse | Política 8 e Contrato Anexo III |
| 12 | **Regem e RegemCast:** se são da mesma empresa que presta o Liame, não são suboperadores; se forem de outra empresa do grupo, são | Contrato Anexo III |
| 13 | **Sentry e Langfuse na região da UE?** A UE tem adequação da ANPD; os EUA exigem cláusulas-padrão sem alteração, que fornecedores americanos costumam não aceitar | Política 8.1; Contrato 9 |

## 2. Pontos para o advogado

- **Relação B2B e CDC:** o cliente típico é pequena empresa ou MEI. Avaliar se o CDC pode se aplicar (vulnerabilidade) e o efeito disso na limitação de responsabilidade, no foro e no arrependimento.
- **Papéis na LGPD:** o Liame é operador dos dados dos clientes das empresas e controlador dos dados de cadastro, acesso e cobrança. Conferir a redação e a responsabilidade do operador (art. 42).
- **Pessoas convidadas** agem em nome do cliente (ADR-017): conferir a redação da responsabilidade do cliente pelos atos delas.
- **Conteúdo gerado por IA:** propriedade, ausência de garantia de originalidade, rótulo quando exigido.
- **Transferência internacional para os EUA** (Anthropic, OpenAI, Sentry, Cloudflare): as cláusulas-padrão da ANPD valem só **sem alteração**, e esses fornecedores usam os próprios contratos. Qual mecanismo do art. 33 usar na prática.
- **Agente de pequeno porte:** se a empresa se enquadra e se o uso de IA com larga escala afasta o enquadramento (seção 4).
- **Contrato de adesão empresarial:** cláusulas limitativas à luz dos arts. 421-A, 423 e 424 do Código Civil.
- **Aviso à Meta** em incidente que envolva dados da plataforma (Platform Terms §6.b.i).

## 3. Checagem de verdade antes de publicar

Os documentos descrevem o produto como ele será. **Antes de publicar, cada afirmação abaixo precisa ser verdadeira**, ou o texto muda para "vamos" ou sai:

| Afirmação | Onde | Depende de |
| --- | --- | --- |
| Segundo fator por app autenticador obrigatório para quem mexe em dinheiro | Termos 3.3; Contrato Anexo II | A1 (ADR-013) |
| Convites de uso único, com validade, restritos ao e-mail; remoção imediata | Termos 4; Anexo II | A1 (ADR-017) |
| Dados pessoais cifrados com chave por cliente; chave mestra fora do banco | Política 11; Anexo II | A1 (ADR-011, ADR-014) + conta AWS (A0-3b) |
| Separação entre clientes no banco, com testes | Política 11; Anexo II | ✅ provado no spike; vale para cada tabela nova na A1 (A1-1 a A1-5) |
| Auditoria inalterável com prova diária fora do sistema | Política 11; Anexo II | A1 (ADR-011) + conta AWS dedicada |
| Remoção de dados pessoais antes de enviar à IA | Política 7.1; Contrato 5.3 | A3 (AI Gateway, ADR-006) |
| Fornecedores de IA sem treino com os dados | Termos 6.4; Política 7.2 | Contratos e termos de cada provedor, conferidos antes de ligar cada um (ADR-016) |
| Prazos de retenção e expurgo com certificado | Política 9; Contrato 11 | A1 (ADR-014) |
| Verificação automática de dependências e segredos a cada mudança | Anexo II | Parcial: lockfile e scripts ✅; gitleaks, osv-scanner e Semgrep entram na A1 |
| Botão de parada por cliente, conta e fornecedor | Anexo II; Termos 2.3 | A1 (kill switch) |

Para a **revisão de app da Meta e do Google (A0-5)**, a política precisa estar publicada antes do produto completo. Nesse caso, publicar a versão com as afirmações que dependem de fase futura escritas como compromisso ("o Liame vai…") ou restritas ao que já existe, e trocar quando cada fase for entregue.

## 4. Verificação legal (25/09/2026)

Conferida nas fontes oficiais (Planalto, DOU, gov.br/anpd, Câmara, developers.facebook.com, developers.google.com, whatsappbusiness.com). O site do TSE bloqueou o acesso; a Resolução 23.755/2026 foi lida no DJE. Detalhe e links na base de conhecimento §6.1.

| Tema | O que vale hoje | Efeito nos documentos |
| --- | --- | --- |
| ANPD | Virou **Agência** Nacional de Proteção de Dados (Lei 15.352, de 25/02/2026) | Nome corrigido |
| Encarregado (Res. 18/2024) | Nome **completo** no site, em destaque; se for empresa, também o nome da pessoa responsável. Para o operador, indicar é facultativo | Campo da política |
| Pequeno porte (Res. 2/2022) | IA conta como "tecnologia emergente": com larga escala ou perfil de consumo, o tratamento é de alto risco e **perde a dispensa** de encarregado e os prazos em dobro | Recomendação: nomear encarregado |
| Incidente (Res. 15/2024) | Controlador comunica ANPD e titulares em **3 dias úteis**; registro de todo incidente por **5 anos**; a norma não fixa prazo do operador | Prazo do operador no contrato (sugestão: 24 h); retenção de 5 anos |
| Transferência internacional (Res. 19/2024) | Cláusulas-padrão **integrais e sem alteração**; prazo de adequação já vencido (23/08/2025); **seção de transparência obrigatória** (art. 17 §2º). UE adequada (Res. 32/2026); **EUA, não** | Seção 8.1 da política; cláusula 9 do contrato |
| Marco Civil, art. 15 | Registros de acesso por 6 meses (mínimo) | Confirmado |
| CDC e Decreto 7.962/2013 | No B2B o CDC não se aplica por regra; o STJ aplica caso a caso a empresa que prova vulnerabilidade | Decisão do reembolso em 7 dias |
| ECA Digital (Lei 15.211/2025) | **Em vigor desde 17/03/2026**; proíbe perfilamento para publicidade a crianças e adolescentes (art. 22) | Proibição nos Termos e no contrato |
| PL 2338/2023 (IA) | **Não é lei** (Câmara, aguardando parecer em 02/09/2026) | Aviso de IA mantido como boa prática |
| TSE (Res. 23.755/2026) | Rótulo de IA na propaganda; vedação de conteúdo sintético de candidato 72 h antes e 24 h depois do pleito; **provedor de IA não pode ranquear, recomendar candidato nem indicar voto, mesmo a pedido** | Uso político **proibido** nos Termos |
| Meta (Platform Terms de 03/02/2026) | Política em URL pública informada no painel do app; **como pedir exclusão**; callback ou URL de instruções de exclusão; excluir dados quando não forem mais necessários | Seção "Como pedir a exclusão" |
| Google (User Data Policy) | Escopo do Google Ads é **sensível**, com **Uso Limitado**: dados só para funções visíveis ao usuário; **proibido levar a plataformas de anúncio** ou usar para publicidade; treino de modelo listado como uso proibido; política no domínio verificado, com link na página inicial e igual à da tela de consentimento | Seção 6.4 da política; Termos 5.4 |
| WhatsApp (política de 23/09/2026) | Opt-in obrigatório (por categoria é boa prática); opt-out vale **mesmo pedido fora do WhatsApp**; automação com caminho para humano; **proibido para partidos, candidatos e campanhas**. A regra que proíbe "provedores de IA" está suspensa no Brasil por medida do CADE | Termos 5.5 e 7; contrato 4 e 5 |

### Regras de produto que saem daqui

| Regra | Onde entra |
| --- | --- |
| Dados das APIs do Google **nunca** vão para a Meta nem para outra plataforma de anúncio; não entram em treino | Connectors e AI Gateway (A2, A3), teste que barra a transferência |
| Uso político e eleitoral bloqueado; a IA recusa avaliar, recomendar ou ordenar candidatos e indicar voto | Policy Engine e Compliance (A3) |
| Nenhum público de anúncio com menores de 18 anos; a IA não propõe segmentação por idade abaixo de 18 | Policy Engine (A4) |
| Opt-out registrado vale na hora, inclusive o recebido fora do canal; conversa automática sempre com caminho para humano | Mensageria (A5) |
| Callback ou página de exclusão de dados da Meta, com código de confirmação e página de status | Connector Meta (A2) |
| Registro de incidentes por 5 anos | Plano de incidentes (A1) |
