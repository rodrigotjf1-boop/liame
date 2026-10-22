import { Injectable, Logger, Optional, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { erroDoLaco, HubDms } from '../connectors/dms/hub.js';
import { ActionExecutor } from './action-executor.js';
import { ComparacaoDmsIdLoop } from './comparacao-dms-id.js';
import { ConexaoProcessor } from './conexao-processor.js';
import { ConferenciaDoGasto } from './conferencia-do-gasto.js';
import { ConversasLoop } from './conversas-loop.js';
import { ConversoesLoop } from './conversoes-loop.js';
import { CriativoLoop } from './criativo-loop.js';
import { FotosLoop } from './fotos-loop.js';
import { EstrategistaAgenda, MARCAS_POR_VOLTA } from './estrategista-agenda.js';
import { EstrategistaLoop } from './estrategista-loop.js';
import { PedidosQueEsperam } from './pedidos-que-esperam.js';
import { PerfilLoop } from './perfil-loop.js';
import { PesquisaLoop } from './pesquisa-loop.js';
import { RelatorioMensalLoop } from './relatorio-mensal-loop.js';
import { RevisaoSemanalLoop } from './revisao-semanal-loop.js';
import { SearchConsoleLoop } from './search-console-loop.js';
import { RotinaDoCrmLoop } from './rotina-do-crm-loop.js';
import { SincronizacaoLoop } from './sincronizacao-loop.js';
import { SombraLoop } from './sombra-loop.js';
import { VendasLoop } from './vendas-loop.js';
import { InboxProcessor } from './inbox-processor.js';
import { OutboxPublisher } from './outbox-publisher.js';
import { WebhookDeliverer } from './webhook-deliverer.js';

/**
 * Laços do worker: publicar a outbox, entregar webhooks, processar a inbox, executar as ações aprovadas, concluir as conexões OAuth, sincronizar as contas conectadas, ler as vendas das lojas do Regem, ler as conversas abertas por anúncio das contas do RegemCast, rodar a sombra de cada marca, gerar e enviar a revisão da semana, gerar o relatório do mês, montar os planos do Estrategista, ler as páginas pedidas ao Pesquisador, conferir o gasto de cada mudança feita numa conta de anúncio, conferir de novo os pedidos que esperam aprovação com um impedimento, olhar as marcas pela rotina do CRM e mensageria e ler as lojas do Perfil da Empresa no Google. Cada laço
 * repete na hora se o lote veio cheio e espera um pouco se veio vazio. Erro num lote é registrado e
 * o laço segue (LIC-001).
 */
@Injectable()
export class EventsLoopService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('eventos');
  private stopped = false;
  private readonly loops: Promise<void>[] = [];
  private readonly wakeups = new Set<() => void>();

  constructor(
    private readonly publisher: OutboxPublisher,
    private readonly deliverer: WebhookDeliverer,
    private readonly inbox: InboxProcessor,
    private readonly actions: ActionExecutor,
    private readonly conexoes: ConexaoProcessor,
    private readonly sincronizacao: SincronizacaoLoop,
    private readonly vendas: VendasLoop,
    private readonly sombra: SombraLoop,
    private readonly conversas: ConversasLoop,
    private readonly revisao: RevisaoSemanalLoop,
    private readonly relatorio: RelatorioMensalLoop,
    private readonly estrategista: EstrategistaLoop,
    private readonly agenda: EstrategistaAgenda,
    private readonly pesquisa: PesquisaLoop,
    private readonly criativo: CriativoLoop,
    private readonly conferencia: ConferenciaDoGasto,
    private readonly conversoes: ConversoesLoop,
    private readonly esperam: PedidosQueEsperam,
    private readonly rotinaDoCrm: RotinaDoCrmLoop,
    private readonly perfil: PerfilLoop,
    private readonly searchConsole: SearchConsoleLoop,
    private readonly comparacao: ComparacaoDmsIdLoop,
    private readonly fotos: FotosLoop,
    /** O hub da DMS: a falha de um laço vai também à lista de erros dele (desligado por padrão, `HUB_LIGADO`). */
    @Optional() private readonly hub?: HubDms,
  ) {}

  onApplicationBootstrap(): void {
    this.loops.push(
      this.loop('outbox', 100, 1_000, (n) => this.publisher.publishBatch(n)),
      this.loop('webhooks', 20, 1_000, (n) => this.deliverer.deliverBatch(n)),
      this.loop('inbox', 50, 2_000, (n) => this.inbox.processBatch(n)),
      this.loop('acoes', 20, 1_000, (n) => this.actions.runCycle(n)),
      this.loop('conexoes', 5, 2_000, (n) => this.conexoes.processarLote(n)),
      this.loop('sincronizacao', 3, 30_000, async (n) => (await this.sincronizacao.executarLote(n)).length),
      this.loop('vendas', 3, 30_000, async (n) => (await this.vendas.executarLote(n)).length),
      this.loop('conversas', 3, 30_000, async (n) => (await this.conversas.executarLote(n)).length),
      this.loop('sombra', 3, 60_000, async (n) => (await this.sombra.executarLote(n)).length),
      this.loop('revisao-semanal', 3, 60_000, async (n) => (await this.revisao.executarLote(n)).length),
      this.loop('revisao-email', 3, 60_000, async (n) => (await this.revisao.enviarLote(n)).length),
      this.loop('relatorio-mensal', 3, 60_000, async (n) => (await this.relatorio.executarLote(n)).length),
      this.loop('relatorio-email', 3, 60_000, async (n) => (await this.relatorio.enviarLote(n)).length),
      this.loop('estrategista', 3, 60_000, async (n) => (await this.estrategista.executarLote(n)).length),
      // A rotina de segunda passa por todas as marcas devidas numa volta; repete em 10 minutos.
      this.loop('estrategista-agenda', MARCAS_POR_VOLTA, 600_000, async () => (await this.agenda.agendarLote()).length),
      this.loop('pesquisa', 3, 30_000, async (n) => (await this.pesquisa.executarLote(n)).length),
      // Quem pediu as peças está esperando: a fila do Criativo é olhada a cada 5 segundos.
      this.loop('criativo', 3, 5_000, async (n) => (await this.criativo.executarLote(n)).length),
      // O gasto de cada mudança, conferido depois da leitura da manhã: olha de 5 em 5 minutos o que falta conferir hoje.
      this.loop('conferencia-do-gasto', 100, 300_000, async (n) => (await this.conferencia.executarLote(n)).reduce((s, c) => s + c.conferidas, 0)),
      // As vendas confirmadas para o Google: cada conta com destino passa uma vez por hora; a fila das contas é olhada de 5 em 5 minutos.
      this.loop('conversoes-google', 2, 300_000, async (n) => (await this.conversoes.executarLote(n)).length),
      // Os pedidos que esperam com um impedimento: cada um é conferido de 15 em 15 minutos; a fila é olhada a cada minuto.
      this.loop('pedidos-que-esperam', 20, 60_000, async (n) => (await this.esperam.executarLote(n)).length),
      // A rotina do CRM e mensageria: cada marca é olhada uma vez por dia; a fila das marcas é olhada de 5 em 5 minutos.
      this.loop('rotina-do-crm', 5, 300_000, async (n) => (await this.rotinaDoCrm.olharLote(n)).length),
      // A proposta aberta espera o texto: a fila da escrita é olhada a cada minuto.
      this.loop('escrita-do-crm', 3, 60_000, async (n) => (await this.rotinaDoCrm.escreverLote(n)).length),
      // O texto conferido vira rascunho de modelo no RegemCast; depois, cada rascunho é olhado de 15 em 15 minutos, até a Meta aprovar.
      this.loop('rascunho-do-crm', 3, 60_000, async (n) => (await this.rotinaDoCrm.rascunharLote(n)).length),
      this.loop('modelo-do-crm', 10, 300_000, async (n) => (await this.rotinaDoCrm.acompanharLote(n)).length),
      // O Perfil da Empresa no Google: as avaliações de cada loja a cada hora e os números uma vez por dia; a fila é olhada a cada minuto.
      this.loop('perfil-google', 3, 60_000, async (n) => (await this.perfil.executarLote(n)).length),
      // As lojas do Perfil que a procura não achou (o Google ainda não liberou o acesso, ou falhou): de novo uma vez por dia; a fila é olhada de 10 em 10 minutos.
      this.loop('perfil-lojas', 3, 600_000, (n) => this.conexoes.procurarLojasDeNovo(n)),
      // O Search Console: os números por dia e as buscas das semanas fechadas de cada site, uma vez por dia; a fila é olhada de 5 em 5 minutos.
      this.loop('search-console', 3, 300_000, async (n) => (await this.searchConsole.executarLote(n)).length),
      // Hub DMS (F2, A3): as leituras do RegemCast pelas duas credenciais, comparadas; cada conta uma vez por hora, só
      // com a função `comparacao_dms_id` ligada e o aplicativo do Liame no DMS ID configurado; a fila é olhada de 5 em 5 minutos.
      this.loop('comparacao-dms-id', 2, 300_000, async (n) => (await this.comparacao.executarLote(n)).length),
      // As fotos apagadas e os envios que não terminaram (A6, Z4): o arquivo sai do armazenamento e depois a linha; a fila é olhada a cada minuto.
      this.loop('fotos', 20, 60_000, async (n) => (await this.fotos.executarLote(n)).length),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    for (const wake of this.wakeups) wake();
    await Promise.all(this.loops);
  }

  private async loop(name: string, batch: number, idleMs: number, run: (batch: number) => Promise<number>): Promise<void> {
    while (!this.stopped) {
      let done = 0;
      try {
        done = await run(batch);
      } catch (err) {
        this.logger.error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        this.hub?.erro(erroDoLaco(name, err));
      }
      if (done < batch) await this.sleep(idleMs);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.wakeups.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.wakeups.add(wake);
    });
  }
}
