import { Injectable, Logger, Optional, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { erroDoLaco, FalhasDoLaco, HubDms, PASSAGEIRAS_ATE_ERRO } from '../connectors/dms/hub.js';
import { ActionExecutor } from './action-executor.js';
import { AssinaturasLoop } from './assinaturas-loop.js';
import { AvisoNoAsaasLoop } from './aviso-no-asaas-loop.js';
import { AvisosDeAtrasoService } from './avisos-de-atraso.service.js';
import { CobrancasPixLoop } from './cobrancas-pix-loop.js';
import { CobrancasReleituraLoop } from './cobrancas-releitura-loop.js';
import { ComparacaoDmsIdLoop } from './comparacao-dms-id.js';
import { ConexaoProcessor } from './conexao-processor.js';
import { ConferenciaDoGasto } from './conferencia-do-gasto.js';
import { ConversasLoop } from './conversas-loop.js';
import { ConversoesLoop } from './conversoes-loop.js';
import { CriativoLoop } from './criativo-loop.js';
import { FotosLoop } from './fotos-loop.js';
import { PostsNumerosLoop } from './posts-numeros-loop.js';
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
import { PostsSugeridosLoop } from './posts-sugeridos-loop.js';
import { SugestoesDeRespostaLoop } from './sugestoes-de-resposta-loop.js';
import { VendasLoop } from './vendas-loop.js';
import { InboxProcessor } from './inbox-processor.js';
import { OutboxPublisher } from './outbox-publisher.js';
import { WebhookDeliverer } from './webhook-deliverer.js';

/**
 * Laços do worker: publicar a outbox, entregar webhooks, processar a inbox, executar as ações aprovadas, concluir as conexões OAuth, sincronizar as contas conectadas, ler as vendas das lojas do Regem, ler as conversas abertas por anúncio das contas do RegemCast, rodar a sombra de cada marca, gerar e enviar a revisão da semana, gerar o relatório do mês, montar os planos do Estrategista, ler as páginas pedidas ao Pesquisador, conferir o gasto de cada mudança feita numa conta de anúncio, conferir de novo os pedidos que esperam aprovação com um impedimento, olhar as marcas pela rotina do CRM e mensageria, ler as lojas do Perfil da Empresa no Google, pedir ao Social media as sugestões de resposta às avaliações novas e levar cada assinatura pelos dias da cobrança. Cada laço
 * repete na hora se o lote veio cheio e espera um pouco se veio vazio. Erro num lote é registrado e
 * o laço segue (LIC-001).
 */
@Injectable()
export class EventsLoopService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('eventos');
  private stopped = false;
  private readonly loops: Promise<void>[] = [];
  private readonly wakeups = new Set<() => void>();

  /** As quedas passageiras do banco: aviso no log; da terceira seguida do mesmo laço, erro e o hub (E-0002 do hub). */
  private readonly falhas = new FalhasDoLaco();

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
    private readonly numerosDosPosts: PostsNumerosLoop,
    private readonly sugestoes: SugestoesDeRespostaLoop,
    private readonly postsSugeridos: PostsSugeridosLoop,
    private readonly assinaturas: AssinaturasLoop,
    private readonly avisosDeAtraso: AvisosDeAtrasoService,
    private readonly cobrancasPix: CobrancasPixLoop,
    private readonly releitura: CobrancasReleituraLoop,
    private readonly avisoNoAsaas: AvisoNoAsaasLoop,
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
      // Os números de cada post nas redes (A6, Z7, parte c): cada canal publicado uma hora depois de sair e depois uma vez
      // por dia, por 30 dias; a fila é olhada de 5 em 5 minutos, só com a função dos posts ligada.
      this.loop('posts-numeros', 5, 300_000, async (n) => (await this.numerosDosPosts.executarLote(n)).length),
      // As sugestões de resposta do Social media (A6, Z6): a avaliação nova entra na fila na leitura do Perfil que a
      // trouxe, e o "Pedir outras" entra quando a pessoa pede, com ela esperando na tela de Aprovações (P31): por isso a
      // fila é olhada de 15 em 15 segundos (a do "Pedir outras" primeiro). Quem espera a vez (a IA desligada, o limite)
      // volta em uma hora.
      this.loop('sugestoes-de-resposta', 3, 15_000, async (n) => (await this.sugestoes.executarLote(n)).length),
      // O pedido do Social media cuja avaliação mudou ou foi respondida direto no Google sai de Aprovações (P31); a
      // avaliação chega pela leitura do Perfil, de hora em hora: a fila é olhada de 5 em 5 minutos.
      this.loop('sugestoes-retirada', 20, 300_000, async (n) => (await this.sugestoes.retirarLote(n)).length),
      // Os posts do Social media (A6, Z6, os posts; D-A6-60): de hora em hora, a vez dos dias de amanhã e de depois de
      // amanhã que têm item na pauta aprovada abre (com a função ligada para a marca); a fila é olhada a cada minuto.
      // Quem espera a vez (a IA desligada, sem rede, sem Fotos, o limite) volta em uma hora.
      this.loop('posts-sugeridos-abrir', 200, 3_600_000, (n) => this.postsSugeridos.abrir(n)),
      this.loop('posts-sugeridos', 3, 60_000, async (n) => (await this.postsSugeridos.executarLote(n)).length),
      // Plano e cobrança (A7, W1): cada assinatura passa uma vez por dia, no começo do dia da empresa; a fila é olhada
      // de 5 em 5 minutos. Com a função `cobranca` desligada, a assinatura espera parada.
      this.loop('assinaturas', 20, 300_000, async (n) => (await this.assinaturas.executarLote(n)).length),
      // O aviso do atraso por e-mail (A7, W3, parte 2): no 1º, no 7º, no 10º e no 30º dia, a quem paga, uma vez por
      // fatura, dia e pessoa; olhado de 30 em 30 minutos, em páginas por todas as assinaturas em atraso.
      this.loop('avisos-de-atraso', 100, 1_800_000, async (n) => (await this.avisosDeAtraso.executarLote(n)).length),
      // O PIX pelo Asaas (A7, W2a): a fatura que nasce ganha a cobrança no Asaas; a fila é olhada a cada 30 segundos
      // (a primeira mensalidade nasce com a pessoa assinando, e o QR Code também pode ser pedido por ela na hora).
      this.loop('cobrancas-pix', 10, 30_000, async (n) => (await this.cobrancasPix.executarLote(n)).length),
      // A releitura (W2a, parte 2): o aviso do Asaas marca a fatura para reler na hora, e a pessoa que pagou espera ver
      // a fatura paga; a fila é olhada a cada 15 segundos. Sem aviso, cada cobrança é relida uma vez por dia.
      this.loop('cobrancas-releitura', 10, 15_000, async (n) => (await this.releitura.executarLote(n)).length),
      // O aviso do Liame no Asaas (W2a, parte 3a): conferido na subida do worker e depois uma vez por dia; a vez é olhada
      // de 10 em 10 minutos. Sem a chave e o token do Asaas, não faz nada.
      this.loop('aviso-no-asaas', 1, 600_000, async () => ((await this.avisoNoAsaas.executar()) ? 1 : 0)),
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
        const quedas = this.falhas.passou(name);
        if (quedas) this.logger.log(`${name}: o banco voltou, depois de ${quedas} queda(s) seguida(s)`);
      } catch (err) {
        const mensagem = err instanceof Error ? err.message : String(err);
        const { nivel, seguidas } = this.falhas.falhou(name, err);
        if (nivel === 'aviso') {
          this.logger.warn(`${name}: queda passageira do banco (${seguidas}ª seguida; vira erro na ${PASSAGEIRAS_ATE_ERRO}ª): ${mensagem}`);
        } else {
          this.logger.error(seguidas ? `${name}: o banco falhou ${seguidas} vezes seguidas: ${mensagem}` : `${name}: ${mensagem}`);
          this.hub?.erro(erroDoLaco(name, err));
        }
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
