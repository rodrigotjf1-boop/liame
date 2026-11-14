// Classe de dado e prazo de cada tabela (ADR-014, security-model §6). A classe é a MAIS ALTA entre as
// colunas; a marcação por coluna chega com as tabelas de contatos e mensagens (A2/A5). Tabela nova
// sem entrada aqui reprova o teste `lifecycle.spec`.

export type DataClass = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'PERSONAL' | 'SENSITIVE' | 'SECRET';

export interface TableClassification {
  class: DataClass;
  /** Prazo em texto, como o dono lê no relatório; o que é automático está em `purge`. */
  retention: string;
  /** Regra do job diário, quando o prazo é automático. */
  purge?: { job: string; days: number };
}

export const DATA_CLASSES: Record<string, TableClassification> = {
  organization: { class: 'CONFIDENTIAL', retention: 'enquanto houver contrato; 30 dias de graça depois do encerramento', purge: { job: 'empresa', days: 30 } },
  app_user: { class: 'PERSONAL', retention: 'enquanto a pessoa tiver conta' },
  membership: { class: 'PERSONAL', retention: 'com a empresa' },
  brand: { class: 'CONFIDENTIAL', retention: 'arquivada: 12 meses', purge: { job: 'marca_arquivada', days: 365 } },
  unit: { class: 'CONFIDENTIAL', retention: 'com a empresa' },
  session: { class: 'PERSONAL', retention: '6 meses depois de encerrada (Marco Civil, art. 15)', purge: { job: 'sessao', days: 180 } },
  user_token: { class: 'SECRET', retention: '30 dias depois de vencido', purge: { job: 'token', days: 30 } },
  rate_limit: { class: 'INTERNAL', retention: '1 dia', purge: { job: 'limite', days: 1 } },
  secret: { class: 'SECRET', retention: 'até revogar; com a empresa ou a pessoa' },
  tenant_key: { class: 'SECRET', retention: 'destruída no expurgo da empresa (crypto-shredding)' },
  recovery_code: { class: 'SECRET', retention: 'enquanto o segundo fator estiver ativo' },
  // As chaves de acesso (A7, W9, migration 0108; D-A7-87): a chave PÚBLICA, o gerenciador, se sincroniza e o último uso
  // (nada da biometria); até a pessoa tirar, ou com a pessoa. O desafio de cada cerimônia vence em 5 minutos e sai no
  // próximo pedido da pessoa.
  passkey: { class: 'PERSONAL', retention: 'até a pessoa tirar; com a pessoa' },
  webauthn_challenge: { class: 'INTERNAL', retention: '5 minutos (sai no próximo pedido da pessoa; o da entrada sem senha, no próximo pedido de entrada)' },
  // Os Termos novos (A7, W14, migration 0111; D-A7-88, D-A7-92): a versão é da distribuição (os endereços, as impressões
  // digitais e o que muda; nada pessoal), e o histórico fica, as retiradas também; o aceite é da pessoa (onde e o
  // aparelho, sem o IP) e sai com ela; o evento do aceite fica na auditoria encadeada (5 anos).
  terms_version: { class: 'INTERNAL', retention: 'para sempre: o histórico das versões, as retiradas também' },
  terms_acceptance: { class: 'PERSONAL', retention: 'com a pessoa; o evento fica na auditoria (5 anos)' },
  // A entrega de cada e-mail dos Termos novos (W14, parte 14c, migration 0112): a versão, o tipo, a pessoa e a situação,
  // sem o endereço nem o texto; sai com a pessoa.
  terms_notice: { class: 'PERSONAL', retention: 'com a pessoa' },
  invitation: { class: 'PERSONAL', retention: 'com a empresa' },
  role: { class: 'PUBLIC', retention: 'do produto' },
  role_permission: { class: 'INTERNAL', retention: 'do produto e da empresa' },
  outbox_event: { class: 'CONFIDENTIAL', retention: '30 dias depois de publicado', purge: { job: 'outbox', days: 30 } },
  webhook_endpoint: { class: 'CONFIDENTIAL', retention: 'com a empresa' },
  webhook_delivery: { class: 'CONFIDENTIAL', retention: 'com o evento (30 dias)' },
  inbox_event: { class: 'PERSONAL', retention: '90 dias (payload bruto)', purge: { job: 'inbox', days: 90 } },
  idempotency_key: { class: 'CONFIDENTIAL', retention: '24 horas', purge: { job: 'idempotencia', days: 0 } },
  audit_chain: { class: 'INTERNAL', retention: '5 anos, com âncora (revisar com o jurídico)' },
  audit_event: { class: 'PERSONAL', retention: '5 anos, com âncora (revisar com o jurídico)' },
  audit_anchor: { class: 'PUBLIC', retention: 'permanente (só hashes)' },
  feature_flag: { class: 'INTERNAL', retention: 'do produto' },
  feature_flag_rule: { class: 'INTERNAL', retention: 'do produto' },
  kill_switch: { class: 'CONFIDENTIAL', retention: 'com a empresa' },
  policy: { class: 'CONFIDENTIAL', retention: 'com a empresa' },
  sandbox_resource: { class: 'INTERNAL', retention: 'com a empresa' },
  action_request: { class: 'CONFIDENTIAL', retention: 'com a empresa' },
  approval: { class: 'PERSONAL', retention: 'com a empresa' },
  budget_policy: { class: 'CONFIDENTIAL', retention: 'com a empresa' },
  budget_ledger_entry: { class: 'CONFIDENTIAL', retention: 'com a empresa' },
  action_execution: { class: 'CONFIDENTIAL', retention: 'com a empresa' },
  action_spend_check: { class: 'CONFIDENTIAL', retention: 'com a empresa, a conta conectada ou o pedido' },
  workflow_run: { class: 'INTERNAL', retention: 'com a empresa' },
  workflow_step: { class: 'INTERNAL', retention: 'com a empresa' },
  purge_certificate: { class: 'CONFIDENTIAL', retention: '5 anos (prova do expurgo)' },
  // Mídia (A2): dados das contas de anúncio e de análise da própria empresa.
  connected_account: { class: 'CONFIDENTIAL', retention: 'com a marca e a empresa' },
  campaign: { class: 'CONFIDENTIAL', retention: 'com a conta conectada' },
  ad_group: { class: 'CONFIDENTIAL', retention: 'com a conta conectada' },
  creative: { class: 'CONFIDENTIAL', retention: 'com a conta conectada' },
  ad: { class: 'CONFIDENTIAL', retention: 'com a conta conectada' },
  metric_observation: { class: 'CONFIDENTIAL', retention: 'com a conta conectada (revisar: 37 meses, como a Meta)' },
  metric_latest: { class: 'CONFIDENTIAL', retention: 'com a conta conectada' },
  metric_mapping: { class: 'PUBLIC', retention: 'do produto' },
  raw_payload: { class: 'CONFIDENTIAL', retention: '30 dias (reprocessamento)', purge: { job: 'payload_bruto', days: 30 } },
  sync_run: { class: 'INTERNAL', retention: '90 dias', purge: { job: 'execucao_sync', days: 90 } },
  sync_state: { class: 'INTERNAL', retention: 'com a conta conectada' },
  // Hub DMS (F2, A3): a comparação das duas credenciais do RegemCast. Da distribuição; só o caminho do que difere.
  credential_comparison_state: { class: 'INTERNAL', retention: 'com a conta conectada' },
  credential_comparison: { class: 'INTERNAL', retention: '90 dias', purge: { job: 'comparacao_credencial', days: 90 } },
  // Conectores (A2, G2): estado técnico da distribuição, sem dado de empresa.
  connector_capability: { class: 'PUBLIC', retention: 'do produto' },
  api_deprecation_notice: { class: 'PUBLIC', retention: 'do produto' },
  quota_bucket: { class: 'INTERNAL', retention: 'do produto (estado de cota)' },
  circuit_state: { class: 'INTERNAL', retention: 'do produto (estado do disjuntor)' },
  // Vigia de integrações (A2, G8): documentação pública das plataformas e alertas técnicos.
  watch_source: { class: 'PUBLIC', retention: 'do produto' },
  watch_snapshot: { class: 'PUBLIC', retention: 'a última leitura de cada fonte' },
  watch_change: { class: 'PUBLIC', retention: 'do produto (histórico das mudanças das plataformas)' },
  watch_alert: { class: 'INTERNAL', retention: 'do produto' },
  // Conexões OAuth (A2, G3): o código fica cifrado só até a troca; o token, no cofre.
  oauth_connection: {
    class: 'CONFIDENTIAL',
    retention: 'com a empresa; a que não virou conexão (expirada, erro, revogada) sai em 90 dias',
    purge: { job: 'conexao_oauth', days: 90 },
  },
  // Vendas (A2.5, F1): pedidos e itens sem dado pessoal; o cliente só como índice cego do telefone.
  customer_ref: { class: 'PERSONAL', retention: 'enquanto houver finalidade; apagado quando a origem anonimiza o cliente (em até 1 dia)' },
  customer_ref_link: { class: 'PERSONAL', retention: 'com o cliente pseudonimizado' },
  order_fact: { class: 'CONFIDENTIAL', retention: 'enquanto durar o contrato (sem dado pessoal)' },
  order_item_fact: { class: 'CONFIDENTIAL', retention: 'com o pedido' },
  // Atribuição (A2.5, F2): ids de clique são dado pessoal (90 dias); o resultado guarda só a evidência.
  tracking_link: { class: 'CONFIDENTIAL', retention: 'com a marca e a empresa' },
  coupon: { class: 'CONFIDENTIAL', retention: 'com a conta conectada (espelho da origem)' },
  campaign_coupon: { class: 'CONFIDENTIAL', retention: 'com a campanha' },
  touchpoint: { class: 'PERSONAL', retention: '90 dias (ids de clique e do anúncio)', purge: { job: 'toque', days: 90 } },
  attribution_model: { class: 'PUBLIC', retention: 'do produto (a versão nunca muda)' },
  attribution_run: { class: 'INTERNAL', retention: '90 dias', purge: { job: 'execucao_atribuicao', days: 90 } },
  attribution_result: { class: 'CONFIDENTIAL', retention: 'com o pedido' },
  // Conversões para o Google (A5, Y1): o destino guarda quem escolheu a ação de conversão; o envio guarda o pedido, o
  // valor e a resposta do Google, sem o id do clique (que fica no ponto de contato, com o prazo de guarda dele).
  conversion_destination: { class: 'PERSONAL', retention: 'com a conta conectada (quem escolheu a ação de conversão fica ligado à linha)' },
  conversion_upload: { class: 'CONFIDENTIAL', retention: 'com a empresa, a conta conectada ou o pedido' },
  // IA (A3, I1): preços e rotas são do produto; o uso é o registro técnico de cada chamada (quem pediu,
  // sem conteúdo); o conteúdo enviado e recebido, já sem dado pessoal, fica 30 dias (Política 7.3).
  ai_model_price: { class: 'PUBLIC', retention: 'do produto' },
  ai_model_route: { class: 'INTERNAL', retention: 'do produto' },
  ai_budget: { class: 'INTERNAL', retention: 'com a empresa' },
  // A escolha do modelo no Pro (A3, I13; migration 0098): o catálogo é do produto; a escolha é uma configuração da
  // empresa, com quem escolheu (a referência some com a pessoa).
  ai_model_option: { class: 'INTERNAL', retention: 'do produto' },
  ai_model_choice: { class: 'INTERNAL', retention: 'com a empresa' },
  // Câmbio de referência (A3, D-A3-14): a PTAX de venda do Banco Central, dado público, uma cotação por dia útil.
  exchange_rate: { class: 'PUBLIC', retention: 'do produto (cotação pública do Banco Central)' },
  // Os números da região (plano da região, R2; migration 0137; padrão da PTAX): dado público do IBGE, sem empresa.
  region_district: { class: 'PUBLIC', retention: 'do produto (bairros do Censo 2022 do IBGE, até o próximo Censo)' },
  region_district_point: { class: 'PUBLIC', retention: 'do produto (o centro de cada bairro pelo OpenStreetMap e o bairro na busca da Meta, com o bairro do IBGE)' },
  region_fact: { class: 'PUBLIC', retention: 'do produto (números públicos do IBGE por lugar e período)' },
  region_source_read: { class: 'INTERNAL', retention: 'do produto (a última leitura de cada fonte pública)' },
  region_food_count: { class: 'PUBLIC', retention: 'do produto (contagens de restaurantes do CNPJ aberto da Receita, só o mês mais novo; sem nome, endereço nem CNPJ)' },
  region_weather: { class: 'PUBLIC', retention: 'do produto (a previsão do tempo por dia do CPTEC, por município; os dias de mais de uma semana atrás saem)' },
  region_food_part: { class: 'INTERNAL', retention: 'até somar o mês (contagens de cada arquivo do CNPJ da Receita em leitura)' },
  // A mídia por região e por hora (plano da região, R4, parte 1; migration 0146): as somas por dia e hora (Meta e
  // Google) e por dia e cidade (Google) de cada conta de anúncio, sem pessoa; a janela lida substitui a guardada, e a
  // conta desligada leva junto o que foi lido dela. O nome dos lugares do Google é dado público, do produto.
  ad_hour_daily: { class: 'CONFIDENTIAL', retention: 'com a conta conectada (as 4 semanas mais novas de cada conta de anúncio)' },
  ad_city_daily: { class: 'CONFIDENTIAL', retention: 'com a conta conectada (as 4 semanas mais novas de cada conta de anúncio)' },
  ad_local_daily: { class: 'CONFIDENTIAL', retention: 'com a conta conectada (as 4 semanas mais novas de cada conta de anúncio)' },
  social_audience: { class: 'CONFIDENTIAL', retention: 'com a conta conectada (a última leitura de cada Instagram e Página)' },
  social_follower_daily: { class: 'CONFIDENTIAL', retention: 'com a conta conectada (400 dias por conta)' },
  region_geo_target: { class: 'PUBLIC', retention: 'do produto (o nome dos lugares do Google Ads, públicos)' },
  // Os pedidos da loja por bairro (plano da região, R3, parte 2; migration 0148): as somas que o Regem manda (bairro com
  // o mínimo de pedidos dele; o resto somado em "outros"), sem cliente, rua, número nem CEP; a leitura substitui a anterior.
  region_order_district: { class: 'CONFIDENTIAL', retention: 'com a conta conectada (as 4 semanas mais novas de cada loja do Regem)' },
  ai_usage: { class: 'PERSONAL', retention: 'com a empresa (registro técnico, sem conteúdo)' },
  ai_exchange: { class: 'CONFIDENTIAL', retention: '30 dias (o que foi enviado ao modelo e o que voltou)', purge: { job: 'conteudo_ia', days: 30 } },
  // O que a conferência recusou (A3, D-A3-15): o funcionário, o fluxo, o porquê e a regra; sem o texto e sem quem pediu.
  ai_refusal: { class: 'INTERNAL', retention: 'com a empresa e a marca (a contagem do que foi recusado, sem conteúdo)' },
  // Retorno da pessoa sobre uma explicação (A3, I4): quem avaliou, o veredito e o motivo. Fica no Liame,
  // nunca vai ao fornecedor do modelo, e o comentário é limpo de dado pessoal antes de gravar.
  ai_feedback: { class: 'PERSONAL', retention: 'com a empresa (some com a linha de uso da explicação)' },
  // Registros da IA (A3, I2): cada versão de ferramenta, prompt e funcionário que foi ao ar (do produto);
  // a ativação diz qual funcionário trabalha para qual empresa.
  tool_registry: { class: 'PUBLIC', retention: 'do produto (histórico das versões)' },
  prompt_version: { class: 'INTERNAL', retention: 'do produto (histórico das versões)' },
  agent_definition: { class: 'INTERNAL', retention: 'do produto (histórico das versões)' },
  agent_activation: { class: 'INTERNAL', retention: 'com a empresa' },
  // Sombra de verdade (A3, I5): o que o Liame recomendaria em anúncio, o que a pessoa fez e o resultado
  // (dados de campanha, sem cliente); o motivo de quem discorda é da pessoa.
  shadow_decision: { class: 'CONFIDENTIAL', retention: 'com a campanha e a conta conectada' },
  shadow_state: { class: 'INTERNAL', retention: 'com a marca' },
  readiness_snapshot: { class: 'CONFIDENTIAL', retention: 'com a conta conectada' },
  human_override: { class: 'PERSONAL', retention: 'com a empresa (quem discordou e o motivo)' },
  // Promoção de autonomia (A3, I13): a proposta do sistema e a decisão da pessoa (quem, quando e a versão da
  // política); o motivo é limpo de dado pessoal antes de gravar.
  autonomy_proposal: { class: 'PERSONAL', retention: 'com a conta conectada (quem decidiu e o motivo)' },
  // Sua equipe (A3, I13b): quem desligou um funcionário numa marca, quando e o motivo (limpo de dado pessoal).
  agent_pause: { class: 'PERSONAL', retention: 'com a marca (quem desligou, quem ligou e o motivo; o histórico fica)' },
  // Revisão da semana (A3, I7): os números da marca numa semana fechada, como foram gerados (sem cliente da
  // loja); quem recebeu o e-mail é dado da pessoa (o endereço não fica aqui, só o vínculo).
  weekly_review: { class: 'CONFIDENTIAL', retention: 'com a marca' },
  weekly_review_delivery: { class: 'PERSONAL', retention: 'com a revisão e com a pessoa (some com qualquer uma das duas)' },
  weekly_review_state: { class: 'INTERNAL', retention: 'com a marca' },
  // Relatório do mês (A3, I7; P24): como a revisão da semana, para o mês fechado da loja.
  monthly_report: { class: 'CONFIDENTIAL', retention: 'com a marca' },
  monthly_report_delivery: { class: 'PERSONAL', retention: 'com o relatório e com a pessoa (some com qualquer um dos dois)' },
  monthly_report_state: { class: 'INTERNAL', retention: 'com a marca' },
  // Minha marca (A3, I8): o dossiê é dado da empresa, sem dado pessoal de cliente (recusado ao salvar); as
  // versões não se apagam enquanto a marca existir. A base da agência é do produto.
  brand_dossier_version: { class: 'CONFIDENTIAL', retention: 'com a marca (as versões não se apagam enquanto ela existir)' },
  brand_dossier_suggestion: { class: 'CONFIDENTIAL', retention: 'com a marca' },
  knowledge_item: { class: 'INTERNAL', retention: 'do produto (histórico das versões)' },
  // Conversa com a LIA (A3, I10): o que a pessoa escreveu (já sem dado pessoal de cliente) e o que a LIA respondeu
  // (D-A3-4: 30 dias). A demanda é o pedido registrado para a equipe: fica com a marca, com quem pediu.
  conversation: { class: 'PERSONAL', retention: '30 dias depois da última mensagem', purge: { job: 'conversa', days: 30 } },
  conversation_message: { class: 'PERSONAL', retention: '30 dias', purge: { job: 'conversa_mensagem', days: 30 } },
  demand: { class: 'PERSONAL', retention: 'com a marca (fica depois que a conversa some)' },
  // Planos do Estrategista (A3, I11): o plano, as versões (o que a IA propôs e o que a pessoa editou, com a fonte de cada
  // número; sem cliente da loja) e as decisões (quem decidiu e o motivo). O calendário comercial é do produto.
  plan: { class: 'PERSONAL', retention: 'com a marca (quem pediu fica ligado ao plano)' },
  plan_version: { class: 'PERSONAL', retention: 'com o plano (as versões não se apagam enquanto ele existir)' },
  plan_decision: { class: 'PERSONAL', retention: 'com o plano (quem decidiu e o motivo)' },
  commercial_date: { class: 'PUBLIC', retention: 'do produto (feriados nacionais e datas do varejo, com a fonte)' },
  // Pesquisador (A3, I12): o pedido de leitura de uma página pública (quem pediu, o endereço, a situação) e os rótulos
  // conferidos (produtos, preços, ofertas). A página não é guardada; o dado pessoal sai antes de ir ao modelo.
  research_request: { class: 'PERSONAL', retention: 'com a marca (o pedido e os rótulos; a página não fica)' },
  // Peças do Criativo (A4, X6): o pedido (quem pediu, a oferta de Minha marca e a instrução, sem dado pessoal), as peças,
  // as versões (o que a IA escreveu e o que uma pessoa editou, com a conferência) e as decisões. Nenhum dado de cliente
  // da loja; a peça com dado pessoal nem é gravada.
  ad_piece_request: { class: 'PERSONAL', retention: 'com a marca (quem pediu fica ligado ao pedido)' },
  ad_piece: { class: 'PERSONAL', retention: 'com a marca (quem decidiu fica ligado à peça)' },
  ad_piece_version: { class: 'PERSONAL', retention: 'com a peça (as versões não se apagam enquanto ela existir)' },
  ad_piece_decision: { class: 'PERSONAL', retention: 'com a peça (quem decidiu e o motivo)' },
  // A campanha nova na Meta (A4, X5): o que a pessoa pediu e o que já foi criado na Meta, passo a passo; quem pediu fica
  // ligado ao pedido.
  ad_campaign_new: { class: 'PERSONAL', retention: 'com a marca (quem pediu fica ligado à campanha nova)' },
  // O ritmo da semana (plano da região, R7; migration 0156): a tabela da semana e os passos de cada dia.
  budget_rhythm: { class: 'PERSONAL', retention: 'com a marca (quem parou fica ligado ao ritmo)' },
  budget_rhythm_step: { class: 'CONFIDENTIAL', retention: 'com o ritmo da semana (a verba de cada dia em cada campanha)' },
  // O teste de criativo (plano da região, R8; migration 0157): o teste que a pessoa pediu e os dois criativos dele, com o
  // que já existe na Meta e o cupom de cada um; o resultado guardado são somas (nunca um pedido nem um cliente).
  campaign_test: { class: 'PERSONAL', retention: 'com a marca (quem pediu e quem encerrou ficam ligados ao teste)' },
  campaign_test_arm: { class: 'CONFIDENTIAL', retention: 'com o teste (a peça, a mídia, o cupom e o anúncio de cada criativo)' },
  // O teste de região (R8; migration 0159): cada conjunto que o bairro deixa, com o público de antes para devolver igual.
  campaign_test_target: { class: 'CONFIDENTIAL', retention: 'com o teste (o público de cada conjunto antes do teste e os pedidos da saída e da volta)' },
  // A campanha nova no Google (A5, Y9; migration 0150): a peça e os textos nos tamanhos do Google, a foto de Fotos, a loja
  // do raio, a verba e o fim, e o que existe no Google; quem pediu fica ligado ao pedido.
  google_campaign_new: { class: 'PERSONAL', retention: 'com a marca (quem pediu fica ligado à campanha nova do Google)' },
  // O vídeo montado pelo Liame (A6, Z15; migration 0143): o pedido (o modelo, as fotos de Fotos, os textos da marca, o
  // formato) e a fila; quem pediu fica ligado ao pedido. O vídeo pronto é uma linha de `brand_photo`.
  video_montage: { class: 'PERSONAL', retention: 'com a marca (quem pediu fica ligado ao pedido; o vídeo pronto segue a regra de Fotos)' },
  // O pedido de mensagem (A5, Y5): o retrato do que o Liame montou no RegemCast antes de pedir a aprovação (o texto do
  // modelo, escrito pela loja; o nome e a regra do público; contagens; a janela; a regra do cupom) e quem propôs.
  // Nenhum telefone, nome de contato ou conteúdo de conversa: os contatos ficam no RegemCast.
  message_request: { class: 'PERSONAL', retention: 'com a marca ou a conta conectada (a pessoa em nome de quem o funcionário propôs fica ligada ao pedido)' },
  // A proposta de mensagem do funcionário de CRM e mensageria (A5, Y6): onde ela está entre "ele decidiu propor" e "o
  // pedido de envio está em Aprovações" (o que recebeu para escrever, o texto já conferido, o rascunho do modelo no
  // RegemCast e o pedido que saiu). O texto que a conferência barrou não fica: só os nomes do que barrou. Do público,
  // só o nome, a regra e a contagem; nenhum telefone nem nome de contato.
  message_proposal: { class: 'PERSONAL', retention: 'com a marca ou a conta conectada (a pessoa em nome de quem o funcionário propôs fica ligada à proposta)' },
  // O desconto padrão do cupom das mensagens (A5, Y6): o que o cupom de cada mensagem dá, o pedido mínimo, a validade
  // em dias e a loja do Regem onde ele nasce, com quem definiu por último (uma pessoa da própria empresa). É regra
  // comercial da empresa; nenhum dado de cliente.
  message_discount: { class: 'CONFIDENTIAL', retention: 'com a marca ou a loja do cupom' },
  // A fila do olhar da rotina do CRM e mensageria (A5, Y6): por marca e por tipo de mensagem, quando ele olha de novo,
  // quando olhou e o que decidiu, em código. Nenhum texto e nenhum dado de pessoa.
  message_routine: { class: 'INTERNAL', retention: 'com a marca' },
  // As avaliações da loja no Perfil da Empresa no Google (A6, Z1): a nota, o texto, as datas e a resposta da empresa.
  // O nome e a foto de quem avaliou não são guardados (critério A6-1), mas o texto é de terceiro e pode trazer dado
  // pessoal de quem escreveu: por isso PERSONAL, com guarda de 12 meses (D-A6-5).
  profile_review: { class: 'PERSONAL', retention: '12 meses depois da última mudança da avaliação no Google', purge: { job: 'avaliacao', days: 365 } },
  // As sugestões de resposta do Social media (A6, Z6, migration 0079): só a situação, o porquê, o que a conferência barrou
  // (os nomes das regras) e o pedido que saiu; nenhum texto (o das sugestões fica no pedido) e nada de quem avaliou.
  review_suggestion: { class: 'INTERNAL', retention: 'com a avaliação (sai com ela, na guarda de 12 meses dela)' },
  // A nota média e o total de avaliações da loja, e os números do perfil por dia (vistas, rotas, ligações, cliques).
  // Contagens da própria empresa; nenhum dado de pessoa.
  profile_summary: { class: 'CONFIDENTIAL', retention: 'com a conta conectada' },
  profile_metric_daily: { class: 'CONFIDENTIAL', retention: 'com a conta conectada' },
  // Search Console (A6, Z3): os números do site por dia são contagens da própria empresa. As buscas da semana são o
  // que as pessoas digitaram no Google: o Google esconde a busca de poucas pessoas, mas o texto pode trazer, raramente,
  // algo pessoal. Por isso PERSONAL, com a mesma guarda do texto das avaliações (12 meses, D-A6-5).
  search_console_daily: { class: 'CONFIDENTIAL', retention: 'com a conta conectada' },
  search_console_query_week: { class: 'PERSONAL', retention: '12 meses contados do começo da semana', purge: { job: 'busca', days: 365 } },
  // Fotos dos produtos (A6, Z4; ADR-021): o registro de cada foto que a empresa envia; o arquivo fica no armazenamento
  // de imagens. É conteúdo da empresa (a tela pede foto sem pessoas que dê para reconhecer). Fica enquanto a marca
  // existir, ou até alguém apagar; a rotina `fotos` do worker e o expurgo tiram o arquivo antes da linha.
  brand_photo: { class: 'CONFIDENTIAL', retention: 'enquanto a marca existir, ou até alguém apagar (o arquivo sai antes da linha)' },
  // "Do seu Instagram" (A6, Z10, parte 5; migration 0122): as publicações mais novas da conta do Instagram ligada à
  // marca, com a legenda, o endereço, a miniatura no endereço da Meta e os números. É o que a própria loja publicou, sem
  // arquivo guardado; a lista espelha a conta a cada leitura (o que sai de lá sai daqui), como os números do Search Console.
  instagram_media: { class: 'CONFIDENTIAL', retention: 'com a conta conectada' },
  // Os comentários dos posts da marca (A6, Z11, parte 1, migration 0123; D-A6-86): o post de onde vêm (a legenda, o
  // endereço e a miniatura no endereço da Meta, sem arquivo) e cada comentário, com o texto, o @ ou o nome de quem
  // comentou, a hora, as curtidas e se está oculto; sem a foto do perfil. O texto é de terceiro: sai 90 dias depois de
  // feito (o expurgo `comentario`), antes se for apagado na rede ou se a conta for desligada. O post sem comentário
  // guardado sai 90 dias depois de publicado (`post_comentado`).
  social_comment_post: { class: 'CONFIDENTIAL', retention: 'com a conta conectada; 90 dias depois de publicado, sem comentário guardado', purge: { job: 'post_comentado', days: 90 } },
  social_comment: { class: 'PERSONAL', retention: '90 dias depois do comentário; antes, se for apagado na rede ou se a conta for desligada', purge: { job: 'comentario', days: 90 } },
  // Os pedidos do Social media para os comentários (A6, Z11, parte 2d-2, migration 0125): só a situação, o porquê, o que
  // a conferência barrou (os nomes das regras) e o pedido que saiu; nenhum texto (o das sugestões fica no pedido) e nada
  // de quem comentou. Sai com o comentário (em cascata), na guarda de 90 dias dele.
  comment_suggestion: { class: 'INTERNAL', retention: 'com o comentário (sai com ele, na guarda de 90 dias dele)' },
  // A vez do tipo pela IA de cada comentário que a regra deixou sem tipo (A6, Z11, parte 2d-4c, migration 0128): a
  // situação, o tipo que saiu (ou "nenhum"), o porquê em código e a marca do texto julgado (o SHA-256, não o texto); nada
  // de quem comentou. Sai com o comentário (em cascata), na guarda de 90 dias dele.
  comment_kind_check: { class: 'INTERNAL', retention: 'com o comentário (sai com ele, na guarda de 90 dias dele)' },
  // O atendimento automático de cada marca (A6, Z11, parte 2e-1; migration 0129; D-A6-92): ligado, os tipos e quem
  // mudou por último. Configuração da empresa, sem comentário nem quem comentou; sai com a marca.
  comment_auto_reply: { class: 'INTERNAL', retention: 'enquanto a marca existir (sai com ela)' },
  // O Direct do Instagram (A6, Z12, parte 1; migration 0130; P39, D-A6-106 a D-A6-115). O ajuste da marca (ligado e a
  // confirmação de que nenhum outro programa responde aquele Direct) é configuração da empresa e sai com a marca. A
  // conversa guarda o id de quem escreveu (o IGSID, para onde a resposta vai) e o @; a mensagem, o texto, por 90 dias
  // contados de quando foi enviada (D-A6-112). A conversa sem mensagem guardada sai junto, no mesmo expurgo. Antes, as
  // duas saem com a conta desligada ou quando o Regem passa a atender o Direct dela (D-A6-107).
  direct_setting: { class: 'INTERNAL', retention: 'enquanto a marca existir (sai com ela)' },
  direct_conversation: { class: 'PERSONAL', retention: 'com a conta conectada; sai quando não sobra mensagem guardada (90 dias depois da última)', purge: { job: 'direct_conversa', days: 90 } },
  // O atendimento aberto de cada pessoa da equipe (A6, Z12, parte 2; migration 0131; D-A6-109): quando abriu, até quando
  // vale (8 horas) e quando fechou. Uma linha por pessoa na empresa, regravada a cada abertura; sai com a pessoa ou a
  // empresa. Cada abertura fica também na auditoria.
  direct_attendance: { class: 'INTERNAL', retention: 'enquanto a pessoa tiver acesso à empresa (sai com ela); regravada a cada abertura' },
  // O atendimento automático do Direct de cada marca (A6, Z12, parte 5a; migration 0133; D-A6-115): ligado, os tipos e
  // quem mudou por último; cada mudança fica também na auditoria. Nada da conversa nem de quem escreveu.
  direct_auto_reply: { class: 'INTERNAL', retention: 'enquanto a marca existir (sai com ela)' },
  // O Messenger da Página de cada marca na caixa do Direct (A6, Z14, parte 1; migration 0134; D-A6-121): ligado e a
  // confirmação de que nenhum outro programa responde aquele Messenger. As conversas ficam em `direct_conversation`.
  messenger_setting: { class: 'INTERNAL', retention: 'enquanto a marca existir (sai com ela)' },
  direct_message: { class: 'PERSONAL', retention: '90 dias depois de enviada; antes, se a conta for desligada ou o Regem passar a atender o Direct dela', purge: { job: 'direct_mensagem', days: 90 } },
  // Os posts da marca (A6, Z5b, migration 0086): a foto (pela referência e o resumo), a hora e cada canal com o texto
  // que a empresa escreveu em nome dela e o que aconteceu na rede. Conteúdo da empresa, sem dado de pessoa. Fica com a
  // marca: é o histórico da Agenda e o que diz o que saiu, onde e quando.
  social_post: { class: 'CONFIDENTIAL', retention: 'enquanto a marca existir' },
  social_post_channel: { class: 'CONFIDENTIAL', retention: 'com o post' },
  // Os posts do Social media (A6, Z6, os posts, migration 0093): a vez de cada dia da pauta, com a situação, o porquê, o
  // que a conferência barrou (os nomes das regras), o post e o pedido que saíram; nenhum texto (o do post fica no post).
  post_suggestion: { class: 'INTERNAL', retention: 'enquanto a marca existir (uma linha por dia proposto)' },
  // Plano e cobrança (A7, W1, migration 0080). Os planos são do produto: o preço e os funcionários de cada versão. A
  // assinatura e as faturas são da empresa: o plano, a forma de pagar, as datas e os valores; nenhum dado de cartão (o
  // cartão fica no meio de pagamento, A7-1). O que a lei manda guardar de uma cobrança paga fica na auditoria e na nota
  // fiscal (W4), não aqui.
  billing_plan: { class: 'PUBLIC', retention: 'do produto' },
  subscription: { class: 'CONFIDENTIAL', retention: 'com a empresa' },
  billing_invoice: { class: 'CONFIDENTIAL', retention: 'com a empresa' },
  // O aviso do atraso por e-mail (A7, W3, parte 2, migration 0095): cada entrega a quem paga, sem o endereço nem o texto.
  billing_notice: { class: 'PERSONAL', retention: 'com a fatura e com a pessoa (some com qualquer uma das duas)' },
  // O resumo da semana do que cada pessoa fez, ao Dono (A7, W8, migration 0097): cada entrega, sem o endereço nem o texto.
  people_digest: { class: 'PERSONAL', retention: 'com a empresa e com a pessoa (some com qualquer uma das duas)' },
  // O vínculo de parceiro (A7, W6, parte 2): o e-mail do Dono a quem a agência pediu.
  partner_link: { class: 'PERSONAL', retention: 'com a agência e com a empresa (some com qualquer uma das duas)' },
  // A marca da agência (A7, W7, parte 3, migration 0102): o logo (no armazenamento de imagens, que sai com o prefixo da
  // agência no expurgo) e o e-mail de resposta, que é o contato de alguém da agência.
  agency_brand: { class: 'PERSONAL', retention: 'com a agência' },
  // O relatório que a agência manda ao cliente (A7, W7, parte 4a, migration 0103): o comentário assinado e o nome de quem
  // mandou; e cada entrega a uma pessoa da empresa, sem o endereço nem o texto.
  agency_report_send: { class: 'PERSONAL', retention: 'com a empresa e com a agência (some com qualquer uma das duas)' },
  agency_report_delivery: { class: 'PERSONAL', retention: 'com o envio e com a pessoa (some com qualquer um dos dois)' },
  // O lembrete do dia 3 ao time da agência (A7, W7, parte 4b, migration 0104): só que saiu e para quantas pessoas.
  agency_report_reminder: { class: 'INTERNAL', retention: 'com o relatório e com a agência (some com qualquer um dos dois)' },
  // A transferência da propriedade da conta (A7, W8, parte 2, migration 0105): quem pediu, para quem e a decisão.
  ownership_transfer: { class: 'PERSONAL', retention: 'com a empresa e com as pessoas (some com qualquer uma delas)' },
  // A recuperação da conta do Dono (A7, W8, partes 4a e 4b, migration 0106; D-A7-62, D-A7-64): o pedido, a conferência da
  // DMS (sem a imagem) e a decisão ficam com a pessoa; o documento com foto, lacrado com a chave pública da DMS, sai 30
  // dias depois da decisão, pela rotina da recuperação no worker (`recuperacao-da-conta.service.ts`, de hora em hora).
  account_recovery: { class: 'PERSONAL', retention: 'com a pessoa' },
  account_recovery_document: {
    class: 'SENSITIVE',
    retention: '30 dias depois da decisão da DMS ou do cancelamento (D-A7-64)',
    purge: { job: 'recuperacao_documento', days: 30 },
  },
  // A propriedade pedida à DMS quando o Dono não está mais (A7, W8, parte 6a, migration 0107; D-A7-63, D-A7-64): o pedido e
  // a decisão ficam com a empresa; os dois documentos, lacrados com a chave pública da DMS, saem 30 dias depois da decisão
  // (e o rascunho esquecido sai em 2 dias), pela rotina do worker (`propriedade-pela-dms.service.ts`).
  ownership_claim: { class: 'PERSONAL', retention: 'com a empresa; o rascunho sem envio, 2 dias' },
  ownership_claim_document: {
    class: 'SENSITIVE',
    retention: '30 dias depois da decisão da DMS ou do cancelamento (D-A7-64)',
    purge: { job: 'propriedade_documento', days: 30 },
  },
  // A empresa como cliente no meio de pagamento (A7, W2a, migration 0081): só o id dela lá (`cus_…`). O nome e o CNPJ
  // que o Asaas guarda são os da empresa, enviados na primeira cobrança.
  billing_customer: { class: 'CONFIDENTIAL', retention: 'com a empresa' },
};
