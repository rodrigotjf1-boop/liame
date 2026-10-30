import type { Database } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ClienteConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { versaoRegistrada } from '../connectors/tipos.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { LeitorDosNumeros, type VezDosNumeros } from './leitor-dos-numeros.js';
import { VaultService } from '../vault/vault.service.js';
import type { JobScope } from './outbox-publisher.js';

/**
 * A leitura dos números de cada post nas redes (A6, Z7, parte c; D-A6-50 a D-A6-52), no worker: liga o leitor ao cofre,
 * ao cliente HTTP dos conectores, ao endereço da Graph API e ao registro de capacidades, como a publicação. A fila é o
 * próprio canal publicado; cada leitura confere a função dos posts na empresa.
 */
@Injectable()
export class PostsNumerosLoop {
  private leitor: LeitorDosNumeros | null = null;

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
    private readonly flags: FlagService,
  ) {}

  async executarLote(limite = 5, scope: JobScope = {}, agora: Date = new Date()): Promise<VezDosNumeros[]> {
    const database = this.database;
    if (!database) return [];
    this.leitor ??= new LeitorDosNumeros(
      database,
      {
        lerSegredo: (tx, secretId) => this.vault.readSecret(tx, secretId),
        // Uma tentativa por chamada: a leitura que falha volta para a fila em uma hora.
        cliente: () => new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas), tentativas: 1 }),
        graphUrl: this.config.plataformas.metaGraphUrl,
        appSecret: this.config.plataformas.metaAppSecret,
        versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
      },
      this.flags,
    );
    return this.leitor.executarLote(limite, scope, agora);
  }
}
