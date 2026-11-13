import type { Database } from '@liame/database';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ClienteConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { versaoRegistrada } from '../connectors/tipos.js';
import { DATABASE } from '../database/database.module.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens } from '../imagens/armazem.js';
import { VaultService } from '../vault/vault.service.js';
import { publicoNoRaio } from '../campanhas/publico-no-raio.js';
import { centrosDosBairros } from '../worker/centros-dos-bairros.js';
import { campanhaNovaNaMetaConnector } from './campanha-nova-na-meta.js';
import { metaAnunciosConnector } from './meta-anuncios.js';

/**
 * Liga o connector de escrita da Meta (A4, X1) ao cofre, ao cliente HTTP, ao endereço da Graph API e ao registro de
 * capacidades quando o app sobe: na API (que lê o estado do objeto para montar o pedido) e no worker (que valida e
 * aplica). Como o do Regem, o connector é um registro simples (`CONNECTORS`); é aqui que ele recebe o que precisa. A
 * campanha nova (X5) usa o mesmo, mais o armazenamento (o endereço assinado da foto e do vídeo da loja).
 */
@Injectable()
export class EscritaMeta implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
    @Inject(ARMAZEM_DE_IMAGENS) private readonly armazem: ArmazemDeImagens,
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
    campanhaNovaNaMetaConnector.ligar({
      lerSegredo: (tx, secretId) => this.vault.readSecret(tx, secretId),
      cliente: () => new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas), tentativas: 1 }),
      graphUrl: this.config.plataformas.metaGraphUrl,
      appSecret: this.config.plataformas.metaAppSecret,
      versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
      armazem: this.armazem,
    });
    // A estimativa de público no raio da campanha nova (R6, parte 2): leitura, uma tentativa, na hora da gaveta e do pedido.
    publicoNoRaio.ligar({
      lerSegredo: (tx, secretId) => this.vault.readSecret(tx, secretId),
      cliente: () => new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas), tentativas: 1 }),
      graphUrl: this.config.plataformas.metaGraphUrl,
      appSecret: this.config.plataformas.metaAppSecret,
      versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
    });
    // O cache dos bairros da campanha (R6, parte 3): o centro pelo OpenStreetMap e o bairro na Meta, gravados pelo sistema.
    centrosDosBairros.ligar({ db: database.db });
  }
}
