import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { enderecoDoAviso, EVENTOS_DO_AVISO, type MotivoDoAviso, NOME_DO_AVISO, planoDoAviso } from '../cobranca/aviso-no-asaas.js';
import { MeioAsaas } from '../cobranca/meio-asaas.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ErroConector } from '../connectors/cliente-http.js';
import { HubDms } from '../connectors/dms/hub.js';
import { ATENDIMENTO } from '../suporte.js';

/** A conferência do aviso, uma vez por dia: também mantém a chave em uso (sem uso por 3 meses, o Asaas a desliga, D-A7-33). */
export const CONFERENCIA_DO_AVISO_MS = 24 * 3_600_000;
/** Depois de uma falha (o Asaas fora do ar, a cota), a próxima tentativa. */
export const ESPERA_DEPOIS_DA_FALHA_MS = 3_600_000;

export type ConferenciaDoAviso =
  /** Sem a chave ou sem o token do aviso na configuração: nada a conferir. */
  | { situacao: 'sem_asaas' }
  | { situacao: 'criado'; id: string; removidos: number }
  | { situacao: 'em_dia'; id: string; removidos: number }
  | { situacao: 'corrigido'; id: string; motivos: MotivoDoAviso[]; removidos: number }
  | { situacao: 'falhou'; falha: string };

/**
 * O aviso do Liame no Asaas (A7, W2a, parte 3a; D-A7-28 e D-A7-33): o próprio Liame cria o webhook dele pela API, sem nada
 * a configurar na tela do Asaas, e o confere na subida do worker e depois uma vez por dia (`planoDoAviso`). A fila que parou
 * (15 falhas seguidas; os eventos esperam até 14 dias) volta a andar na conferência, e a distribuição é chamada (o log de
 * erro e o hub da DMS): se a causa seguir, a fila para de novo, e o chamado se repete no dia seguinte. Enquanto isso, a
 * releitura diária de cada cobrança acha os pagamentos. Não grava no banco: o Asaas é a fonte do que está configurado.
 * A vez fica na memória do processo: com dois workers, cada um confere, e o aviso repetido que dois criarem juntos sai na
 * conferência seguinte.
 */
@Injectable()
export class AvisoNoAsaasLoop {
  private readonly logger = new Logger('aviso-no-asaas');
  private proximaEm = 0;
  /** O token da configuração já foi ao Asaas nesta subida (na criação, numa correção ou na primeira conferência). */
  private segredoEnviado = false;

  constructor(
    private readonly meio: MeioAsaas,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() private readonly hub?: HubDms,
  ) {}

  /** A volta do laço: só confere quando chega a vez. Devolve o que a conferência fez, ou nulo fora da vez. */
  async executar(agora: Date = new Date()): Promise<ConferenciaDoAviso | null> {
    if (agora.getTime() < this.proximaEm) return null;
    const r = await this.conferir();
    this.proximaEm = agora.getTime() + (r.situacao === 'falhou' ? ESPERA_DEPOIS_DA_FALHA_MS : CONFERENCIA_DO_AVISO_MS);
    return r;
  }

  /** Confere o aviso agora, fora da vez (os testes; a vez seguinte não muda). */
  async conferir(): Promise<ConferenciaDoAviso> {
    const api = this.meio.api();
    const segredo = this.config.asaas?.webhookToken ?? null;
    if (!api || !segredo) return { situacao: 'sem_asaas' };
    const url = enderecoDoAviso(this.config.apiUrl);
    try {
      const plano = planoDoAviso(await api.listarAvisos(), url);
      for (const id of plano.remover) await api.removerAviso(id);
      if (plano.remover.length) this.logger.warn(`${plano.remover.length} aviso(s) do Liame a mais no Asaas: removido(s), e ficou um só`);
      if (plano.acao === 'criar') {
        const criado = await api.criarAviso({ nome: NOME_DO_AVISO, url, email: ATENDIMENTO.email, segredo, eventos: EVENTOS_DO_AVISO });
        this.segredoEnviado = true;
        this.logger.log(`o aviso do Liame foi criado no Asaas (${criado.id}), para ${url}, com o envio em sequência`);
        return { situacao: 'criado', id: criado.id, removidos: plano.remover.length };
      }
      if (plano.acao === 'em_dia') {
        // Na primeira conferência de cada subida, o token vai ao Asaas mesmo com o aviso em dia: o Asaas não devolve o dele,
        // e trocar a variável é subir o worker de novo. Sem isto, o aviso seguiria com o token velho até a fila parar.
        if (!this.segredoEnviado) {
          await api.atualizarAviso(plano.id, {}, segredo);
          this.segredoEnviado = true;
        }
        return { situacao: 'em_dia', id: plano.id, removidos: plano.remover.length };
      }
      await api.atualizarAviso(plano.id, plano.correcao, segredo);
      this.segredoEnviado = true;
      if (plano.motivos.includes('fila_parada')) {
        const mensagem =
          `a fila do aviso do Asaas tinha parado (15 falhas seguidas; os eventos esperam até 14 dias) e voltou a andar, ` +
          `com o token da configuração. Se parar de novo, a causa segue: conferir os logs do webhook no Asaas e a rota ` +
          `${url}. A releitura diária de cada cobrança segue achando os pagamentos.`;
        this.logger.error(mensagem);
        this.hub?.erro({ origem: 'rotina', tipo: 'FilaDoAvisoParada', mensagem, lugar: 'laço aviso-no-asaas' });
      } else {
        this.logger.warn(`o aviso do Liame no Asaas foi corrigido (${plano.motivos.join(', ')})`);
      }
      return { situacao: 'corrigido', id: plano.id, motivos: plano.motivos, removidos: plano.remover.length };
    } catch (err) {
      if (!(err instanceof ErroConector)) throw err;
      // A chave recusada e o pedido recusado são da distribuição (a chave no EasyPanel; o que o Asaas não aceitou); o Asaas
      // fora do ar e a cota passam sozinhos na próxima vez.
      if (err.tipo === 'autenticacao' || err.tipo === 'permissao' || err.tipo === 'definitivo') {
        this.logger.error(`o Asaas recusou a conferência do aviso (${err.tipo}: ${err.message}); de novo em uma hora`);
      } else {
        this.logger.warn(`a conferência do aviso no Asaas falhou (${err.tipo}: ${err.message}); de novo em uma hora`);
      }
      return { situacao: 'falhou', falha: err.tipo };
    }
  }
}
