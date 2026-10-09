import type { Database } from '@liame/database';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { acessoGoogle } from '../connections/oauth.js';
import { ClienteConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { versaoRegistrada } from '../connectors/tipos.js';
import { DATABASE } from '../database/database.module.js';
import { VaultService } from '../vault/vault.service.js';
import { BALDE_DA_ESCRITA_GOOGLE, googleAnunciosConnector } from './google-anuncios.js';

/**
 * Liga o connector de escrita do Google Ads (A5, Y2) ao cofre, ao cliente HTTP, ao endereço da Google Ads API, à troca
 * do token e ao registro de capacidades quando o app sobe: na API (que lê o estado da campanha para montar o pedido) e
 * no worker (que valida e aplica). Como o da Meta, o connector é um registro simples (`CONNECTORS`); é aqui que ele
 * recebe o que precisa.
 */
@Injectable()
export class EscritaGoogle implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
  ) {}

  onModuleInit(): void {
    const database = this.database;
    if (!database) return;
    googleAnunciosConnector.ligar({
      lerSegredo: (tx, secretId) => this.vault.readSecret(tx, secretId),
      // Uma tentativa por chamada: mutação não se repete sozinha; quem adia e tenta de novo é o executor. A cota diária
      // é por empresa (a chave vai no pedido): sem ficha, a chamada não espera aqui, sobe como limite para a ação adiar.
      cliente: () => new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas), tentativas: 1, balde: BALDE_DA_ESCRITA_GOOGLE, esperaMaximaMs: 0 }),
      googleAdsUrl: this.config.plataformas.googleAdsUrl,
      acesso: (refreshToken) => acessoGoogle(this.config, this.config.oauth.google?.tokenUrl ?? '', refreshToken),
      versao: (capacidade) => versaoRegistrada(database.db, 'google_ads', capacidade),
    });
  }
}
