import { Module } from '@nestjs/common';
import { ActionService } from '../actions/action.service.js';
import { BudgetService } from '../actions/budget.service.js';
import { EscritaGoogle } from '../actions/escrita-google.provider.js';
import { EscritaMeta } from '../actions/escrita-meta.provider.js';
import { EscritaRegem } from '../actions/escrita-regem.provider.js';
import { FerramentasDeLeitura } from '../ai/registro/leituras.js';
import { MfaService } from '../auth/mfa.service.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { CouponsService } from '../coupons/coupons.service.js';
import { PolicyService } from '../policy/policy.service.js';
import { APP_CONFIG, type AppConfig, loadConfig } from '../config.js';
import { DatabaseModule } from '../database/database.module.js';
import { EquipeService } from '../equipe/equipe.service.js';
import { FlagService } from '../flags/flag.service.js';
import { KillSwitchService } from '../kill-switch/kill-switch.service.js';
import { createMailer, Mailer } from '../mail/mailer.js';
import { TelemetryLifecycle } from '../telemetry.lifecycle.js';
import { VaultModule } from '../vault/vault.module.js';
import { ActionExecutor } from './action-executor.js';
import { AuditAnchorService } from './audit-anchor.service.js';
import { ConexaoProcessor } from './conexao-processor.js';
import { ConferenciaDoGasto } from './conferencia-do-gasto.js';
import { SincronizacaoLoop } from './sincronizacao-loop.js';
import { ExplicarService } from '../ai/explicar/explicar.service.js';
import { AiGateway } from '../ai/gateway.js';
import { ModelosIa } from '../ai/modelos.js';
import { RevisorService } from '../ai/revisor/revisor.service.js';
import { LinksService } from '../links/links.service.js';
import { MediaService } from '../media/media.service.js';
import { AtencaoCicloService } from '../results/atencao-ciclo.service.js';
import { ResultsService } from '../results/results.service.js';
import { RevisaoSemanalLoop } from './revisao-semanal-loop.js';
import { RevisaoSemanalService } from './revisao-semanal.service.js';
import { PedidosDoGestor } from './pedidos-do-gestor.js';
import { SombraLoop } from './sombra-loop.js';
import { SombraService } from './sombra.service.js';
import { eventoDoRegem, VendasLoop } from './vendas-loop.js';
import { ConversasLoop } from './conversas-loop.js';
import { ConversoesLoop } from './conversoes-loop.js';
import { EstrategistaAgenda } from './estrategista-agenda.js';
import { EstrategistaLoop } from './estrategista-loop.js';
import { EstrategistaService } from './estrategista.service.js';
import { CriativoLoop } from './criativo-loop.js';
import { CriativoService } from './criativo.service.js';
import { PesquisaLoop } from './pesquisa-loop.js';
import { PesquisadorService } from './pesquisa.service.js';
import { VigiaService } from './vigia.service.js';
import { CambioService } from './cambio.service.js';
import { EventsLoopService } from './events-loop.service.js';
import { INBOX_HANDLERS, type InboxHandler, InboxProcessor } from './inbox-processor.js';
import { LifecyclePurgeService } from './lifecycle-purge.service.js';
import { OutboxPublisher } from './outbox-publisher.js';
import { QueueService } from './queue.service.js';
import { RegistroIaService } from './registro-ia.service.js';
import { WebhookDeliverer } from './webhook-deliverer.js';

@Module({
  imports: [DatabaseModule, VaultModule],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    { provide: Mailer, inject: [APP_CONFIG], useFactory: (config: AppConfig) => createMailer(config) },
    // Processadores por provedor: o Regem (A2.5) antecipa a leitura das lojas da conexão; os demais só guardam.
    { provide: INBOX_HANDLERS, useValue: new Map<string, InboxHandler>([['regem', eventoDoRegem]]) },
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
    LifecyclePurgeService,
    // Grava na subida as versões de ferramenta, prompt e funcionário de IA que este código traz (A3, I2).
    RegistroIaService,
    WebhookDeliverer,
    InboxProcessor,
    ConexaoProcessor,
    SincronizacaoLoop,
    VendasLoop,
    ConversasLoop,
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
    // Estrategista (A3, I11): as leituras da IA pelos mesmos serviços das rotas (os cupons pedem o Action Service, que
    // pede a política e o segundo fator; nada disso escreve aqui) e a fila das demandas e das novas análises.
    PolicyService,
    RateLimitService,
    MfaService,
    ActionService,
    CouponsService,
    // As leituras da IA incluem a de Sua equipe (só da conversa): o serviço dela entra aqui pela injeção, sem rota.
    EquipeService,
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
    VigiaService,
    // Câmbio de referência (A3, D-A3-14): a PTAX de venda do Banco Central, para mostrar o custo de IA em reais.
    CambioService,
    EventsLoopService,
    QueueService,
    TelemetryLifecycle,
  ],
})
export class WorkerModule {}
