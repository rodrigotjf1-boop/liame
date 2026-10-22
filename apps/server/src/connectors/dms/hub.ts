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

/** Quantas quedas passageiras seguidas do mesmo laço até virar erro (e ir ao hub): uma queda sozinha é aviso. */
export const PASSAGEIRAS_ATE_ERRO = 3;

// Os códigos de uma queda do caminho até o banco: os do Node (conexão recusada, derrubada, sem resposta, nome que não
// resolveu agora) e os do Postgres (a classe 08, a 57P de servidor parando ou subindo e a 53300 de conexões esgotadas).
const CODIGOS_PASSAGEIROS = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', '08000', '08001', '08003', '08004', '08006', '57P01', '57P02', '57P03', '53300']);
// As frases do `pg` quando ele não põe código: a conexão que não abriu a tempo, a que caiu, e a do cliente que já falhou.
const FRASES_PASSAGEIRAS = ['Connection terminated', 'timeout exceeded when trying to connect', 'Client has encountered a connection error'];

/**
 * A falha é do caminho até o banco (a conexão não abriu a tempo, caiu ou foi derrubada pelo servidor), não da regra do
 * laço: passa sozinha numa volta seguinte. Foi o E-0002 do hub (21/10/2026): uma conexão que demorou no laço do
 * Criativo virou "erro novo depois da versão", alerta crítico, sem defeito nenhum.
 */
export function falhaPassageiraDoBanco(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const codigo = (err as { code?: unknown }).code;
  if (typeof codigo === 'string' && CODIGOS_PASSAGEIROS.has(codigo)) return true;
  return FRASES_PASSAGEIRAS.some((frase) => err.message.startsWith(frase));
}

/**
 * As quedas passageiras seguidas de cada laço do worker: até a segunda, é aviso no log; da terceira seguida em diante, é
 * erro e vai ao hub (o banco fora de verdade aparece em segundos nos laços de 5 s). Qualquer outra falha é erro na hora;
 * qualquer volta sem falha zera a conta do laço, e o log diz que o banco voltou (LIC-364: o "voltou" fecha a história). Cada laço roda em sequência, então a conta de um não disputa com outra.
 */
export class FalhasDoLaco {
  private readonly seguidas = new Map<string, number>();

  falhou(laco: string, err: unknown): { nivel: 'aviso' | 'erro'; seguidas: number } {
    if (!falhaPassageiraDoBanco(err)) {
      this.seguidas.delete(laco);
      return { nivel: 'erro', seguidas: 0 };
    }
    const n = (this.seguidas.get(laco) ?? 0) + 1;
    this.seguidas.set(laco, n);
    return { nivel: n >= PASSAGEIRAS_ATE_ERRO ? 'erro' : 'aviso', seguidas: n };
  }

  /** A volta terminou sem falha: zera e devolve quantas quedas seguidas havia (para o log dizer que o banco voltou). */
  passou(laco: string): number {
    const tinha = this.seguidas.get(laco) ?? 0;
    this.seguidas.delete(laco);
    return tinha;
  }
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
