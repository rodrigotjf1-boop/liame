import { Injectable, Logger, Optional, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { erroDoLaco, FalhasDoLaco, HubDms, PASSAGEIRAS_ATE_ERRO } from '../connectors/dms/hub.js';
import { ActionExecutor } from './action-executor.js';
import { AssinaturasLoop } from './assinaturas-loop.js';
import { AvisoNoAsaasLoop } from './aviso-no-asaas-loop.js';
import { AvisosDeAtrasoService } from './avisos-de-atraso.service.js';
import { AvisosDosTermosService } from './avisos-dos-termos.service.js';
import { CobrancasDoMesService } from './cobrancas-do-mes.service.js';
import { CobrancasPixLoop } from './cobrancas-pix-loop.js';
import { CobrancasReleituraLoop } from './cobrancas-releitura-loop.js';
import { FimDaAssinaturaService } from './fim-da-assinatura.service.js';
import { ResumoDasPessoasService } from './resumo-das-pessoas.service.js';
import { ComparacaoDmsIdLoop } from './comparacao-dms-id.js';
import { ConexaoProcessor } from './conexao-processor.js';
import { ConferenciaDoGasto } from './conferencia-do-gasto.js';
import { ConversasLoop } from './conversas-loop.js';
import { ConversoesLoop } from './conversoes-loop.js';
import { CriativoLoop } from './criativo-loop.js';
import { FotosLoop } from './fotos-loop.js';
import { PostsNumerosLoop } from './posts-numeros-loop.js';
import { DoSeuInstagramLoop } from './do-seu-instagram-loop.js';
import { ComentariosLoop } from './comentarios-loop.js';
import { DirectLoop } from './direct-loop.js';
import { DirectAutomaticoLoop } from './direct-automatico.js';
import { EstrategistaAgenda, MARCAS_POR_VOLTA } from './estrategista-agenda.js';
import { EstrategistaLoop } from './estrategista-loop.js';
import { PedidosNoDestino } from './pedidos-no-destino.js';
import { PedidosQueEsperam } from './pedidos-que-esperam.js';
import { PerfilLoop } from './perfil-loop.js';
import { PesquisaLoop } from './pesquisa-loop.js';
import { RelatorioMensalLoop } from './relatorio-mensal-loop.js';
import { PropriedadePelaDmsRotina } from './propriedade-pela-dms.service.js';
import { RecuperacaoDaContaRotina } from './recuperacao-da-conta.service.js';
import { RelatorioDaAgenciaRotina } from './relatorio-da-agencia.service.js';
import { RevisaoSemanalLoop } from './revisao-semanal-loop.js';
import { SearchConsoleLoop } from './search-console-loop.js';
import { RegiaoCnpjService } from './regiao-cnpj.service.js';
import { RegiaoFontesService } from './regiao-fontes.service.js';
import { RegiaoMidiaLoop } from './regiao-midia.service.js';
import { RegiaoPublicoLoop } from './regiao-publico.service.js';
import { RitmoDaSemanaService } from './ritmo-da-semana.service.js';
import { TestesDeCriativoRotina } from './testes-de-criativo.service.js';
import { RotinaDoCrmLoop } from './rotina-do-crm-loop.js';
import { SincronizacaoLoop } from './sincronizacao-loop.js';
import { SombraLoop } from './sombra-loop.js';
import { PostsSugeridosLoop } from './posts-sugeridos-loop.js';
import { SugestoesDeRespostaLoop } from './sugestoes-de-resposta-loop.js';
import { PedidosDosComentariosLoop } from './pedidos-dos-comentarios-loop.js';
import { TiposDosComentariosLoop } from './tipos-dos-comentarios-loop.js';
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
    private readonly relatorioDaAgencia: RelatorioDaAgenciaRotina,
    private readonly recuperacao: RecuperacaoDaContaRotina,
    private readonly propriedadePelaDms: PropriedadePelaDmsRotina,
    private readonly estrategista: EstrategistaLoop,
    private readonly agenda: EstrategistaAgenda,
    private readonly pesquisa: PesquisaLoop,
    private readonly criativo: CriativoLoop,
    private readonly conferencia: ConferenciaDoGasto,
    private readonly conversoes: ConversoesLoop,
    private readonly esperam: PedidosQueEsperam,
    private readonly noDestino: PedidosNoDestino,
    private readonly rotinaDoCrm: RotinaDoCrmLoop,
    private readonly perfil: PerfilLoop,
    private readonly searchConsole: SearchConsoleLoop,
    private readonly regiaoFontes: RegiaoFontesService,
    private readonly regiaoCnpj: RegiaoCnpjService,
    private readonly regiaoMidia: RegiaoMidiaLoop,
    private readonly regiaoPublico: RegiaoPublicoLoop,
    private readonly ritmoDaSemana: RitmoDaSemanaService,
    private readonly testesDeCriativo: TestesDeCriativoRotina,
    private readonly comparacao: ComparacaoDmsIdLoop,
    private readonly fotos: FotosLoop,
    private readonly numerosDosPosts: PostsNumerosLoop,
    private readonly doSeuInstagram: DoSeuInstagramLoop,
    private readonly comentarios: ComentariosLoop,
    private readonly direct: DirectLoop,
    private readonly directAutomatico: DirectAutomaticoLoop,
    private readonly pedidosDosComentarios: PedidosDosComentariosLoop,
    private readonly tiposDosComentarios: TiposDosComentariosLoop,
    private readonly sugestoes: SugestoesDeRespostaLoop,
    private readonly postsSugeridos: PostsSugeridosLoop,
    private readonly assinaturas: AssinaturasLoop,
    private readonly avisosDeAtraso: AvisosDeAtrasoService,
    private readonly avisosDosTermos: AvisosDosTermosService,
    private readonly cobrancasDoMes: CobrancasDoMesService,
    private readonly fimDaAssinatura: FimDaAssinaturaService,
    private readonly resumoDasPessoas: ResumoDasPessoasService,
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
      // O relatório da agência (A7, W7, parte 4b): o envio sozinho do dia 2 e o lembrete do dia 3; a fila é olhada de 5 em 5 minutos.
      this.loop('relatorio-da-agencia', 20, 300_000, async (n) => (await this.relatorioDaAgencia.enviarSozinhosLote(n)).length),
      this.loop('lembrete-da-agencia', 20, 300_000, async (n) => (await this.relatorioDaAgencia.lembretesLote(n)).length),
      // A recuperação da conta do Dono (A7, W8, parte 4b): os avisos de cada situação olhados a cada minuto; a troca no fim
      // da espera de 5 em 5 minutos; o expurgo dos documentos de hora em hora.
      this.loop('recuperacao-avisos', 20, 60_000, async (n) => (await this.recuperacao.avisosLote(n)).length),
      this.loop('recuperacao-troca', 20, 300_000, async (n) => (await this.recuperacao.aplicarLote(n)).length),
      this.loop('recuperacao-expurgo', 50, 3_600_000, (n) => this.recuperacao.expurgarLote(n)),
      // A propriedade pedida à DMS (A7, W8, parte 6a): os avisos a cada minuto; o expurgo e os rascunhos esquecidos de hora em hora.
      this.loop('propriedade-dms-avisos', 20, 60_000, async (n) => (await this.propriedadePelaDms.avisosLote(n)).length),
      this.loop('propriedade-dms-expurgo', 50, 3_600_000, (n) => this.propriedadePelaDms.expurgarLote(n)),
      this.loop('propriedade-dms-rascunhos', 50, 3_600_000, (n) => this.propriedadePelaDms.limparRascunhosLote(n)),
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
      this.loop('pedidos-no-destino', 20, 60_000, async (n) => (await this.noDestino.executarLote(n)).length),
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
      // Os números da região (plano da região, R2): os bairros do Censo uma vez e, para cada município com loja no mapa,
      // as tabelas do IBGE no prazo de cada uma; a fila é olhada a cada minuto (a loja posta no mapa agora é lida na volta seguinte).
      this.loop('regiao-fontes', 15, 60_000, async (n) => (await this.regiaoFontes.executarLote(n)).length),
      // Os restaurantes ativos pelo CNPJ da Receita (R2, parte 4): um arquivo do mês por volta (horas cada mês, em fluxo);
      // arquivo lido emenda o seguinte, o mês em dia confere de novo em 12 horas; a fila é olhada de 10 em 10 minutos.
      this.loop('regiao-cnpj', 1, 600_000, async () => ((await this.regiaoCnpj.executar()).situacao === 'arquivo_lido' ? 1 : 0)),
      // A mídia por região e por hora (R4, parte 1): as 4 semanas de cada conta de anúncio por hora (Meta e Google) e por
      // cidade (Google), uma vez por dia, só com a função `regiao` ligada; a fila é olhada de 5 em 5 minutos.
      this.loop('regiao-midia', 3, 300_000, async (n) => (await this.regiaoMidia.executarLote(n)).length),
      // O público nas redes (R4, parte 3): os seguidores, os toques no perfil e as visitas do Instagram e da Página, uma vez
      // por dia, e a cidade dos seguidores, uma vez por semana, só com a função `regiao` ligada; a fila é olhada de 5 em 5 minutos.
      this.loop('regiao-publico', 3, 300_000, async (n) => (await this.regiaoPublico.executarLote(n)).length),
      // O ritmo da semana (R7, parte 1b): no domingo, a partir das 16h na loja, o Gestor de tráfego monta o ritmo da semana
      // que vem e pede em Aprovações, só com as funções `regiao` e `ritmo_da_semana` ligadas; a fila é olhada de 10 em 10 minutos.
      // Só os pedidos feitos contam: com o lote cheio a volta seguinte continua na hora; senão, espera os 10 minutos.
      this.loop('ritmo-da-semana', 3, 600_000, async (n) => (await this.ritmoDaSemana.executarLote(n)).filter((r) => r.situacao === 'pedido').length),
      // Os passos do dia do ritmo aprovado (R7, parte 1b-2): a verba de cada campanha no começo do dia, a volta à de antes
      // e o fim do ritmo; de 5 em 5 minutos, e na hora quando o lote de pedidos encheu.
      this.loop('ritmo-do-dia', 20, 300_000, async (n) => (await this.ritmoDaSemana.executarPassos(n)).filter((r) => r.situacao === 'pedido').length),
      // Os testes de criativo (R8): com a campanha de teste criada na Meta, a rotina pede os dois cupons pelo teste aprovado,
      // deixa o teste pronto quando os dois existem e liga cada cupom à campanha de teste; de 2 em 2 minutos, e na hora
      // quando o lote andou. Só com a função `teste_de_criativo` ligada.
      this.loop('testes-de-criativo', 10, 120_000, async (n) => (await this.testesDeCriativo.executarLote(n)).filter((r) => r.situacao === 'cupom_pedido' || r.situacao === 'pronto').length),
      // Hub DMS (F2, A3): as leituras do RegemCast pelas duas credenciais, comparadas; cada conta uma vez por hora, só
      // com a função `comparacao_dms_id` ligada e o aplicativo do Liame no DMS ID configurado; a fila é olhada de 5 em 5 minutos.
      this.loop('comparacao-dms-id', 2, 300_000, async (n) => (await this.comparacao.executarLote(n)).length),
      // As fotos apagadas e os envios que não terminaram (A6, Z4): o arquivo sai do armazenamento e depois a linha; a fila é olhada a cada minuto.
      this.loop('fotos', 20, 60_000, async (n) => (await this.fotos.executarLote(n)).length),
      // Os números de cada post nas redes (A6, Z7, parte c): cada canal publicado uma hora depois de sair e depois uma vez
      // por dia, por 30 dias; a fila é olhada de 5 em 5 minutos, só com a função dos posts ligada.
      this.loop('posts-numeros', 5, 300_000, async (n) => (await this.numerosDosPosts.executarLote(n)).length),
      // "Do seu Instagram" (A6, Z10, parte 5): as publicações de cada conta do Instagram ligada a uma marca, com os
      // números, uma vez por dia; a fila é olhada de 5 em 5 minutos (a conta recém-ligada é lida na volta seguinte), só
      // com as funções `fotos` e `videos` ligadas.
      this.loop('do-seu-instagram', 3, 300_000, async (n) => (await this.doSeuInstagram.executarLote(n)).length),
      // Comentários (A6, Z11, parte 1): os comentários dos posts dos últimos 30 dias de cada Instagram e de cada Página
      // ligados a uma marca, a cada 15 minutos por conta; a fila é olhada a cada minuto (o "Ler agora" sai na volta
      // seguinte), só com a função `comentarios` ligada.
      this.loop('comentarios', 5, 60_000, async (n) => (await this.comentarios.executarLote(n)).length),
      // O Direct do Instagram (A6, Z12, parte 1; D-A6-108): as conversas de cada Instagram ligado a uma marca com o Direct
      // ligado, a cada minuto por conta (por consulta, enquanto o app do Liame estiver em desenvolvimento na Meta), só com
      // a função `direct` ligada e o Regem conferido (D-A6-107); a fila é olhada a cada 20 segundos.
      this.loop('direct', 10, 20_000, async (n) => (await this.direct.executarLote(n)).length),
      // O atendimento automático do Direct (A6, Z12, parte 5a; D-A6-115): a mensagem da pessoa que a leitura trouxe, nas
      // marcas com o automático ligado, vira a resposta pronta pelo trilho (o elogio, a resposta ao story, a menção), com o
      // portão de novo no pedido e na execução; o que não é dele fica com uma pessoa. Olhada a cada 15 segundos.
      this.loop('direct-automatico', 10, 15_000, async (n) => (await this.directAutomatico.executarLote(n)).length),
      // Os pedidos do Social media para os comentários (A6, Z11, parte 2d-2): a leitura dos comentários abre a vez de cada
      // um que pede uma ação da marca (com a função `comentarios_sugeridos` ligada); a fila é olhada a cada 30 segundos.
      // Quem espera a vez (uma chave desligada, sem a rota do modelo, o limite) volta em uma hora.
      this.loop('pedidos-dos-comentarios', 5, 30_000, async (n) => (await this.pedidosDosComentarios.executarLote(n)).length),
      // O tipo do comentário pela IA (A6, Z11, parte 2d-4c): a mesma leitura abre a vez do comentário que a regra deixou
      // sem tipo; com o tipo decidido, a vez do pedido abre junto e entra na fila de cima. Olhada a cada 30 segundos.
      this.loop('tipos-dos-comentarios', 5, 30_000, async (n) => (await this.tiposDosComentarios.executarLote(n)).length),
      // A retirada (A6, Z11, parte 2d-5): o pedido do Social media que espera a decisão sai de Aprovações quando o
      // comentário foi respondido direto na rede, ocultado, editado ou apagado. Só confere o que a leitura trouxe de novo.
      this.loop('retiradas-dos-comentarios', 10, 60_000, async (n) => (await this.pedidosDosComentarios.executarRetiradas(n)).length),
      // Ao ligar o atendimento automático (A6, Z11, parte 2e-1b): o elogio e a marcação que esperavam em Aprovações, das
      // 24 horas antes de ligar, viram a resposta automática. Só anda com a marca ligada; de minuto em minuto.
      this.loop('automatico-ao-ligar', 10, 60_000, async (n) => (await this.pedidosDosComentarios.executarConversoes(n)).length),
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
      // Os e-mails dos Termos novos (A7, W14, parte 14c; D-A7-90): o aviso no dia da versão nova, o lembrete 7 dias antes
      // (só para quem não aceitou) e a retirada; uma vez por versão, tipo e pessoa; olhados de 30 em 30 minutos.
      this.loop('avisos-dos-termos', 100, 1_800_000, async (n) => (await this.avisosDosTermos.executarLote(n)).length),
      // A cobrança do mês por e-mail, com o código do PIX (A7; D-A7-17, D-A7-44): a fatura do período seguinte que já tem a
      // cobrança no Asaas, a quem paga, uma vez por fatura e pessoa; olhada de 30 em 30 minutos.
      this.loop('cobranca-do-mes', 100, 1_800_000, async (n) => (await this.cobrancasDoMes.executarLote(n)).length),
      // O apagamento no fim da assinatura (A7, W3, parte 4a; D-A7-106): a marca que chegou ao dia (o fim + 30 dias, ou o
      // 60º dia de atraso), sem assinatura viva e sem nada pendente no Asaas, sai sozinha ou com a empresa inteira;
      // olhado de hora em hora, a partir da meia-noite do dia no fuso da empresa.
      this.loop('fim-da-assinatura', 20, 3_600_000, async (n) => (await this.fimDaAssinatura.executarLote(n)).length),
      // O resumo da semana do que cada pessoa fez na conta, por e-mail ao Dono (A7, W8; ADR-017; D-A7-53): às segundas,
      // a partir das 8h no fuso da empresa, uma vez por empresa, semana e Dono; olhado de 30 em 30 minutos.
      this.loop('resumo-das-pessoas', 100, 1_800_000, async (n) => (await this.resumoDasPessoas.executarLote(n)).length),
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
