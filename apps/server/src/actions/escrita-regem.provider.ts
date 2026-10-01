import type { Database } from '@liame/database';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { sha256 } from '../audit/audit.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ClienteConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { DATABASE } from '../database/database.module.js';
import { VaultService } from '../vault/vault.service.js';
import { regemCupomConnector } from './regem-cupom.js';

/**
 * Liga o connector de escrita do Regem (A2.5, F6 parte 2) ao cofre, ao cliente HTTP e ao endereço do Regem
 * quando o app sobe — na API (que só lê o estado do cupom para montar o pedido) e no worker (que cria).
 * Os connectors são um registro simples (`CONNECTORS`); é aqui que o do Regem recebe o que precisa.
 */
@Injectable()
export class EscritaRegem implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
  ) {}

  onModuleInit(): void {
    const database = this.database;
    if (!database) return;
    regemCupomConnector.ligar({
      lerSegredo: (tx, secretId) => this.vault.readSecret(tx, secretId),
      // Uma tentativa por chamada: a repetição é do worker, com a mesma chave de idempotência.
      cliente: () => new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 1 }),
      apiUrl: this.config.produtos.regemApiUrl,
      sha256,
    });
  }
}
