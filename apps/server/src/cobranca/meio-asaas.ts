import type { Database } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ApiAsaas, PROVIDER_ASAAS } from '../connectors/asaas/api-asaas.js';
import { ClienteConector } from '../connectors/cliente-http.js';
import { DATABASE } from '../database/database.module.js';

/**
 * A cota do Liame no Asaas, para todos os processos (o balde fica no banco): 0,5 chamada por segundo, 21.600 a cada 12
 * horas, abaixo das 25.000 que o Asaas permite (base §18.5). Sem esperar ficha: a rota responde na hora, e o worker tenta
 * de novo mais tarde.
 */
export const BALDE_DO_ASAAS = { capacidade: 30, porSegundo: 0.5 };

/**
 * O Asaas como meio de pagamento (A7, W2a; D-A7-2, D-A7-27): monta a API dele pela configuração da distribuição (a chave,
 * o endereço do ambiente). Sem a chave, `api()` é nula e o pagamento fica indisponível. O cliente HTTP vem com uma
 * tentativa só: repetir uma criação é de quem chama, depois de procurar pelo id do Liame (a API não tem idempotência).
 */
@Injectable()
export class MeioAsaas {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  api(): ApiAsaas | null {
    const cfg = this.config.asaas;
    if (!cfg || !this.database) return null;
    const cliente = new ClienteConector(this.database.db, { enderecos: { [PROVIDER_ASAAS]: [cfg.apiUrl] }, tentativas: 1, balde: BALDE_DO_ASAAS, esperaMaximaMs: 0 });
    return new ApiAsaas(cliente, { url: cfg.apiUrl, chave: cfg.apiKey });
  }
}
