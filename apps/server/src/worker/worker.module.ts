import { Module } from '@nestjs/common';
import { ActionService } from '../actions/action.service.js';
import { BudgetService } from '../actions/budget.service.js';
import { EscritaGoogle } from '../actions/escrita-google.provider.js';
import { EscritaPerfil } from '../actions/escrita-perfil.provider.js';
import { EscritaPosts } from '../actions/escrita-posts.provider.js';
import { EscritaRegemcast } from '../actions/escrita-regemcast.provider.js';
import { EscritaMeta } from '../actions/escrita-meta.provider.js';
import { EscritaRegem } from '../actions/escrita-regem.provider.js';
import { FerramentasDeLeitura } from '../ai/registro/leituras.js';
import { MfaService } from '../auth/mfa.service.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { CouponsService } from '../coupons/coupons.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { APP_CONFIG, type AppConfig, loadConfig } from '../config.js';
import { HubDms, MODO_DO_HUB, type ModoDoHub } from '../connectors/dms/hub.js';
import { DatabaseModule } from '../database/database.module.js';
import { EquipeService } from '../equipe/equipe.service.js';
import { FlagService } from '../flags/flag.service.js';
import { ArmazemModule } from '../imagens/armazem.module.js';
import { KillSwitchService } from '../kill-switch/kill-switch.service.js';
import { createMailer, Mailer } from '../mail/mailer.js';
import { TelemetryLifecycle } from '../telemetry.lifecycle.js';
import { VaultModule } from '../vault/vault.module.js';
import { ActionExecutor } from './action-executor.js';
import { MeioAsaas } from '../cobranca/meio-asaas.js';
import { AssinaturasLoop } from './assinaturas-loop.js';
import { AuditAnchorService } from './audit-anchor.service.js';
import { avisoDoAsaas } from './aviso-do-asaas.js';
import { AvisoNoAsaasLoop } from './aviso-no-asaas-loop.js';
import { CobrancasPixLoop } from './cobrancas-pix-loop.js';
import { CobrancasReleituraLoop } from './cobrancas-releitura-loop.js';
import { ConexaoProcessor } from './conexao-processor.js';
import { ConferenciaDoGasto } from './conferencia-do-gasto.js';
import { FotosLoop } from './fotos-loop.js';
import { PostsNumerosLoop } from './posts-numeros-loop.js';
import { SincronizacaoLoop } from './sincronizacao-loop.js';
import { ExplicarService } from '../ai/explicar/explicar.service.js';
import { AiGateway } from '../ai/gateway.js';
import { ModelosIa } from '../ai/modelos.js';
import { RevisorService } from '../ai/revisor/revisor.service.js';
import { LinksService } from '../links/links.service.js';
import { MediaService } from '../media/media.service.js';
import { AtencaoCicloService } from '../results/atencao-ciclo.service.js';
import { ComoTeAchamService } from '../results/como-te-acham.service.js';
import { ResultsService } from '../results/results.service.js';
import { RelatorioMensalLoop } from './relatorio-mensal-loop.js';
import { RelatorioMensalService } from './relatorio-mensal.service.js';
import { RevisaoSemanalLoop } from './revisao-semanal-loop.js';
import { RevisaoSemanalService } from './revisao-semanal.service.js';
import { PedidosDoGestor } from './pedidos-do-gestor.js';
import { PedidosQueEsperam } from './pedidos-que-esperam.js';
import { SombraLoop } from './sombra-loop.js';
import { SombraService } from './sombra.service.js';
import { eventoDoRegem, VendasLoop } from './vendas-loop.js';
import { ConversasLoop } from './conversas-loop.js';
import { ConversoesLoop } from './conversoes-loop.js';
import { EstrategistaAgenda } from './estrategista-agenda.js';
import { EstrategistaLoop } from './estrategista-loop.js';
import { EstrategistaService } from './estrategista.service.js';
import { CustoDasPecasService } from '../criativo/custo.service.js';
import { CriativoLoop } from './criativo-loop.js';
import { CriativoService } from './criativo.service.js';
import { PerfilLoop } from './perfil-loop.js';
import { PesquisaLoop } from './pesquisa-loop.js';
import { PesquisadorService } from './pesquisa.service.js';
import { RotinaDoCrmLoop } from './rotina-do-crm-loop.js';
import { SearchConsoleLoop } from './search-console-loop.js';
import { ComparacaoDmsIdLoop } from './comparacao-dms-id.js';
import { RotinaDoCrmService } from './rotina-do-crm.service.js';
import { SugestoesDeRespostaLoop } from './sugestoes-de-resposta-loop.js';
import { SugestoesDeRespostaService } from './sugestoes-de-resposta.service.js';
import { VigiaService } from './vigia.service.js';
import { CambioService } from './cambio.service.js';
import { EscritaDoCrmService } from './escrita-do-crm.service.js';
import { EventsLoopService } from './events-loop.service.js';
import { INBOX_HANDLERS, type InboxHandler, InboxProcessor } from './inbox-processor.js';
import { PedidoDeMensagemService } from '../mensageria/pedido-de-mensagem.service.js';
import { ModeloDoCrmService } from './modelo-do-crm.service.js';
import { LifecyclePurgeService } from './lifecycle-purge.service.js';
import { OutboxPublisher } from './outbox-publisher.js';
import { QueueService } from './queue.service.js';
import { RegistroIaService } from './registro-ia.service.js';
import { WebhookDeliverer } from './webhook-deliverer.js';

@Module({
  imports: [DatabaseModule, VaultModule, ArmazemModule],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    { provide: Mailer, inject: [APP_CONFIG], useFactory: (config: AppConfig) => createMailer(config) },
    // Processadores por provedor: o Regem (A2.5) antecipa a leitura das lojas da conexão; o Asaas (A7, W2a) marca a
    // fatura da cobrança para reler; os demais só guardam.
    {
      provide: INBOX_HANDLERS,
      useValue: new Map<string, InboxHandler>([
        ['regem', eventoDoRegem],
        ['asaas', avisoDoAsaas],
      ]),
    },
    // O hub da DMS (Hub DMS, A4, etapa 3; desligado por padrão): o worker bate, lê a lista de parada e manda os erros dos laços.
    { provide: MODO_DO_HUB, useValue: 'worker' satisfies ModoDoHub },
    HubDms,
    OutboxPublisher,
    AuditAnchorService,
    FlagService,
    KillSwitchService,
    BudgetService,
    ActionExecutor,
    // O gasto conferido (A4, X4): todo dia, cada mudança executada numa conta de anúncio é conferida com a plataforma.
    ConferenciaDoGasto,
    // O connector de escrita do Regem (criar cupom de campanha) recebe o cofre e o cliente HTTP aqui.
    EscritaRegem,
    // O da Meta (situação e verba de anúncio, A4): o cofre, o cliente HTTP e a versão da API do registro.
    EscritaMeta,
    // O do Google Ads (situação e verba de campanha, A5): o mesmo, mais a troca do token e a cota diária por empresa.
    EscritaGoogle,
    // O do pedido de mensagem pelo RegemCast (A5, Y5): pronto e ainda fora do registro de conectores.
    EscritaRegemcast,
    // O da resposta a avaliações do perfil no Google (A6, Z2): o cofre, a troca do token e o conector do Perfil.
    EscritaPerfil,
    // O do post da marca (A6, Z5b): o cofre, o cliente HTTP, a versão da API do registro e o armazenamento das imagens.
    EscritaPosts,
    LifecyclePurgeService,
    // Grava na subida as versões de ferramenta, prompt e funcionário de IA que este código traz (A3, I2).
    RegistroIaService,
    WebhookDeliverer,
    InboxProcessor,
    ConexaoProcessor,
    SincronizacaoLoop,
    VendasLoop,
    ConversasLoop,
    // Perfil da Empresa no Google (A6, Z1): as avaliações e os números do perfil das lojas ligadas; só com a função `perfil_google` ligada.
    PerfilLoop,
    // Search Console (A6, Z3): os números por dia e as buscas da semana dos sites ligados; só com a função `search_console` ligada.
    SearchConsoleLoop,
    // Hub DMS (F2, A3): compara as leituras do RegemCast pelas duas credenciais; só com a função `comparacao_dms_id` ligada.
    ComparacaoDmsIdLoop,
    // Fotos dos produtos (A6, Z4): tira do armazenamento o arquivo da foto apagada (e do envio que não terminou), e depois a linha.
    FotosLoop,
    // Os números de cada post nas redes (A6, Z7, parte c): a leitura do alcance e das interações, como apoio; só com a função dos posts.
    PostsNumerosLoop,
    // Conversões para o Google (A5, Y1): a venda confirmada que veio de um anúncio do Google volta para ele; nasce desligada.
    ConversoesLoop,
    // Sombra de verdade (A3, I5): lê os resultados como a tela e registra o que o Liame recomendaria.
    ResultsService,
    SombraService,
    SombraLoop,
    // Modo Aprovação (A4, X3): a recomendação nova vira um pedido do Gestor de tráfego, pelo Action Service.
    PedidosDoGestor,
    // Revisão da semana (A3, I7): os números da tela Resultados, os avisos e a leitura do Explicar (a LIA, quando ligada).
    MediaService,
    LinksService,
    AtencaoCicloService,
    ModelosIa,
    AiGateway,
    // O revisor de IA do Compliance (I9): o segundo olhar da leitura da revisão e dos planos, com a flag `revisor`.
    RevisorService,
    ExplicarService,
    RevisaoSemanalService,
    RevisaoSemanalLoop,
    // O relatório do mês (A3, I7; P24): o mesmo desenho da revisão da semana, no dia 1º.
    RelatorioMensalService,
    RelatorioMensalLoop,
    // Estrategista (A3, I11): as leituras da IA pelos mesmos serviços das rotas (os cupons pedem o Action Service, que
    // pede a política e o segundo fator; nada disso escreve aqui) e a fila das demandas e das novas análises.
    PolicyService,
    RateLimitService,
    MfaService,
    ActionService,
    CouponsService,
    // A conferência dos pedidos que esperam (A5, Y5): o pedido de mensagem com impedimento é lido de novo de tempos em
    // tempos, pelo Action Service, e quem pode aprovar é avisado quando o impedimento sai.
    PedidosQueEsperam,
    // As leituras da IA incluem a de Sua equipe (só da conversa): o serviço dela entra aqui pela injeção, sem rota.
    // Ela lê o custo das peças para dizer por que o Criativo não pode escrever (A4, P12).
    CustoDasPecasService,
    EquipeService,
    // E a de "Como te acham no Google" (A6 · Z3), que o Estrategista lê para a pauta: o mesmo serviço da rota do cartão.
    ComoTeAchamService,
    FerramentasDeLeitura,
    EstrategistaService,
    EstrategistaLoop,
    // Os planos agendados (I11b): a pauta de segunda-feira e o plano de 90 dias a cada 12 semanas, como demandas da rotina.
    EstrategistaAgenda,
    // Pesquisador (A3, I12): lê as páginas que a empresa informa (leitor em quarentena) e sugere para Minha marca.
    PesquisadorService,
    PesquisaLoop,
    CriativoService,
    CriativoLoop,
    // A rotina do CRM e mensageria (A5, Y6): olha cada marca com o RegemCast conectado e abre a proposta quando há
    // motivo; depois ele escreve a mensagem da proposta, e o código confere. Só com as flags `crm`, `ia`, `mensageria`
    // e `whatsapp_campaign` ligadas; nenhuma mensagem sai daqui.
    RotinaDoCrmService,
    EscritaDoCrmService,
    // O rascunho do modelo no RegemCast e a espera pela Meta: quem envia o modelo para a análise é uma pessoa, lá.
    // Com o modelo aprovado, o pedido de envio é montado pelo mesmo serviço das propostas (ele espera a aprovação de
    // uma pessoa, com o código do app).
    PedidoDeMensagemService,
    ModeloDoCrmService,
    RotinaDoCrmLoop,
    // As sugestões de resposta às avaliações do Google (A6, Z6): a leitura do Perfil abre a vez da avaliação nova, o
    // Social media escreve, o código confere, e as que passam vão num pedido em Aprovações, pelo Action Service. Só com
    // as flags `respostas_sugeridas`, `ia` e `perfil_google_write` ligadas e ele ativo na marca; nada é publicado daqui.
    SugestoesDeRespostaService,
    SugestoesDeRespostaLoop,
    // Plano e cobrança (A7, W1): a vida de cada assinatura pelo relógio (a fatura do período seguinte, os dias de atraso,
    // o fim do período, o pedido sem o primeiro pagamento). Só com a função `cobranca` ligada; nada é cobrado daqui.
    AssinaturasLoop,
    // O PIX pelo Asaas (A7, W2a): a cobrança de cada fatura que nasce, criada no Asaas. Sem a chave do Asaas, nada roda.
    MeioAsaas,
    CobrancasPixLoop,
    // E a releitura (W2a, parte 2): o aviso do Asaas, a conferência diária, a fatura cancelada ou com o valor mudado.
    CobrancasReleituraLoop,
    // O aviso do Liame no Asaas (W2a, parte 3a): criado pela API e conferido uma vez por dia, com a fila que parou reativada.
    AvisoNoAsaasLoop,
    VigiaService,
    // Câmbio de referência (A3, D-A3-14): a PTAX de venda do Banco Central, para mostrar o custo de IA em reais.
    CambioService,
    EventsLoopService,
    QueueService,
    TelemetryLifecycle,
  ],
})
export class WorkerModule {}
