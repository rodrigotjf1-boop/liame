import type { Database } from '@liame/database';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ClienteConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { versaoRegistrada } from '../connectors/tipos.js';
import { DATABASE } from '../database/database.module.js';
import { VaultService } from '../vault/vault.service.js';
import { metaAnunciosConnector } from './meta-anuncios.js';

/**
 * Liga o connector de escrita da Meta (A4, X1) ao cofre, ao cliente HTTP, ao endereço da Graph API e ao registro de
 * capacidades quando o app sobe: na API (que lê o estado do objeto para montar o pedido) e no worker (que valida e
 * aplica). Como o do Regem, o connector é um registro simples (`CONNECTORS`); é aqui que ele recebe o que precisa.
 */
@Injectable()
export class EscritaMeta implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
  ) {}

  onModuleInit(): void {
    const database = this.database;
    if (!database) return;
    metaAnunciosConnector.ligar({
      lerSegredo: (tx, secretId) => this.vault.readSecret(tx, secretId),
      // Uma tentativa por chamada: mutação não se repete sozinha; quem adia e tenta de novo é o executor.
      cliente: () => new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas), tentativas: 1 }),
      graphUrl: this.config.plataformas.metaGraphUrl,
      appSecret: this.config.plataformas.metaAppSecret,
      versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
    });
  }
}
