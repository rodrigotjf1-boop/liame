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
  // IA (A3, I1): preços e rotas são do produto; o uso é o registro técnico de cada chamada (quem pediu,
  // sem conteúdo); o conteúdo enviado e recebido, já sem dado pessoal, fica 30 dias (Política 7.3).
  ai_model_price: { class: 'PUBLIC', retention: 'do produto' },
  ai_model_route: { class: 'INTERNAL', retention: 'do produto' },
  ai_budget: { class: 'INTERNAL', retention: 'com a empresa' },
  ai_usage: { class: 'PERSONAL', retention: 'com a empresa (registro técnico, sem conteúdo)' },
  ai_exchange: { class: 'CONFIDENTIAL', retention: '30 dias (o que foi enviado ao modelo e o que voltou)', purge: { job: 'conteudo_ia', days: 30 } },
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
  // Revisão da semana (A3, I7): os números da marca numa semana fechada, como foram gerados (sem cliente da
  // loja); quem recebeu o e-mail é dado da pessoa (o endereço não fica aqui, só o vínculo).
  weekly_review: { class: 'CONFIDENTIAL', retention: 'com a marca' },
  weekly_review_delivery: { class: 'PERSONAL', retention: 'com a revisão e com a pessoa (some com qualquer uma das duas)' },
  weekly_review_state: { class: 'INTERNAL', retention: 'com a marca' },
};
