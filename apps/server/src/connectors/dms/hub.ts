import { HttpException, Inject, Injectable, Logger, Optional, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config.js';
import { reasonOf } from '../../errors/problems.js';
import { APP_VERSION } from '../../version.js';
import { clienteDoDmsId } from './dms-id.js';
import { ClienteHub, type ErroDoProduto } from './integracao-dms.js';

// O hub da DMS do lado do Liame (Hub DMS, F2, A4, etapa 3): os erros inesperados e a notícia de funcionamento (a
// batida) vão ao hub, com o token do aplicativo do Liame no DMS ID (`dms-id.ts`). O cliente é o do pacote comum
// (`ClienteHub`, seção 9 da 0.3.0): só anota na memória e manda em lote a cada 5 s; nada espera o hub nem falha por
// ele. Nasce desligado (`HUB_LIGADO`).
//
// Quem bate (e lê a lista de parada, que o Liame ainda não usa: ele não recebe chamada de outro produto) é o worker,
// onde mora o aplicativo do Liame no DMS ID. A API só manda os erros dela, e só se o dono puser lá também o
// aplicativo; por padrão, o segredo fica só no worker.

/** O papel do processo: o worker bate; a API só manda os erros. */
export const MODO_DO_HUB = Symbol('MODO_DO_HUB');
export type ModoDoHub = 'worker' | 'api';

/** O mesmo motivo de falha só volta ao log depois deste tempo: o hub fora não pode afogar o log a cada 5 s. */
const SILENCIO_DO_MESMO_AVISO_MS = 5 * 60_000;
const ENVIO_DA_API_MS = 5_000;

/**
 * A requisição que deu 5xx, na forma do hub: o tipo (o nome do erro, ou o status e o código do problema), o lugar (o
 * método e o caminho, sem a consulta) e o `trace_id` como código, para seguir o caso entre o log e o hub.
 */
export function erroDaRequisicao(exception: unknown, problema: { status: number; code: string }, metodo: string, caminho: string, traceId: string): ErroDoProduto {
  const tipo = exception instanceof HttpException ? `HTTP ${problema.status} ${problema.code}` : exception instanceof Error ? exception.name : 'Erro';
  return { origem: 'backend', tipo, mensagem: reasonOf(exception), lugar: `${metodo} ${caminho}`, codigo: traceId };
}

/** A falha de um laço do worker (o lote inteiro caiu), na forma do hub. */
export function erroDoLaco(nome: string, err: unknown): ErroDoProduto {
  return { origem: 'rotina', tipo: err instanceof Error ? err.name : 'Erro', mensagem: err instanceof Error ? err.message : String(err), lugar: `laço ${nome}` };
}

/** O `fetch` do cliente do hub, preso às rotas do hub e sem seguir redirecionamento: o token não vai a outro lugar (V33). */
export function buscarSoNoHub(base: string): typeof fetch {
  const origem = new URL(base).origin;
  return (entrada, init) => {
    const texto = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    const alvo = new URL(texto);
    if (alvo.origin !== origem || !alvo.pathname.startsWith('/api/v1/')) return Promise.reject(new Error('endereço fora do hub'));
    return fetch(alvo, { ...init, redirect: 'error' });
  };
}

@Injectable()
export class HubDms implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger('hub-dms');
  private cliente: ClienteHub | null = null;
  private relogio: ReturnType<typeof setInterval> | null = null;
  private ultimoAviso: { motivo: string; em: number } | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Optional() @Inject(MODO_DO_HUB) private readonly modo: ModoDoHub = 'api',
  ) {}

  /** Mandando ao hub (`HUB_LIGADO`, com o aplicativo do Liame no DMS ID). */
  get ligado(): boolean {
    return this.cliente !== null;
  }

  onModuleInit(): void {
    const { hub, dmsId } = this.config;
    if (!hub || !dmsId) return;
    const cliente = new ClienteHub({
      url: hub.url,
      recurso: hub.recurso,
      dmsId: clienteDoDmsId(dmsId),
      produto: 'liame',
      versao: APP_VERSION,
      buscar: buscarSoNoHub(hub.url),
      aoFalhar: (motivo) => this.avisar(motivo),
    });
    this.cliente = cliente;
    if (this.modo === 'worker') {
      cliente.iniciar();
    } else {
      this.relogio = setInterval(() => {
        cliente.enviar().catch((erro: unknown) => this.avisar(erro instanceof Error ? erro.message : String(erro)));
      }, ENVIO_DA_API_MS);
      this.relogio.unref();
    }
    this.logger.log(`ligado (${hub.url}), ${this.modo === 'worker' ? 'com a batida' : 'só os erros da API'}`);
  }

  /** No desligamento: para os relógios e manda o que falta, uma vez. */
  async onApplicationShutdown(): Promise<void> {
    if (this.relogio) clearInterval(this.relogio);
    this.relogio = null;
    const cliente = this.cliente;
    this.cliente = null;
    if (cliente) await cliente.parar();
  }

  /** Anota um erro inesperado (o pacote limpa o dado pessoal da mensagem antes de sair). Desligado: nada. */
  erro(erro: ErroDoProduto): void {
    if (this.cliente) this.cliente.erro(erro);
  }

  private avisar(motivo: string): void {
    const agora = Date.now();
    if (this.ultimoAviso && this.ultimoAviso.motivo === motivo && agora - this.ultimoAviso.em < SILENCIO_DO_MESMO_AVISO_MS) return;
    this.ultimoAviso = { motivo, em: agora };
    this.logger.warn(`hub: ${motivo}`);
  }
}
