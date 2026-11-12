import type { Database, Tx } from '@liame/database';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { acessoGoogle } from '../connections/oauth.js';
import { ClienteConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { versaoRegistrada } from '../connectors/tipos.js';
import { DATABASE } from '../database/database.module.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens } from '../imagens/armazem.js';
import { VaultService } from '../vault/vault.service.js';
import { campanhaGoogleConnector } from './campanha-google-no-google.js';
import { BALDE_DA_ESCRITA_GOOGLE, googleAnunciosConnector } from './google-anuncios.js';

/**
 * Liga os connectors de escrita do Google Ads ao cofre, ao cliente HTTP, ao endereço da Google Ads API, à troca do token
 * e ao registro de capacidades quando o app sobe: na API (que lê o estado para montar o pedido) e no worker (que valida
 * e aplica). São dois: o das campanhas que já existem (A5, Y2: situação e verba) e o da campanha nova, a Performance
 * Max criada pausada (Y9, parte 3), que também lê a foto e a logo no armazenamento. Como o da Meta, o connector é um
 * registro simples (`CONNECTORS`, atrás da flag `google_write`); é aqui que ele recebe o que precisa.
 */
@Injectable()
export class EscritaGoogle implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
    @Inject(ARMAZEM_DE_IMAGENS) private readonly armazem: ArmazemDeImagens,
  ) {}

  onModuleInit(): void {
    const database = this.database;
    if (!database) return;
    const comum = {
      lerSegredo: (tx: Tx, secretId: string) => this.vault.readSecret(tx, secretId),
      // Uma tentativa por chamada: mutação não se repete sozinha; quem adia e tenta de novo é o executor. A cota diária
      // é por empresa (a chave vai no pedido): sem ficha, a chamada não espera aqui, sobe como limite para a ação adiar.
      cliente: () => new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas), tentativas: 1, balde: BALDE_DA_ESCRITA_GOOGLE, esperaMaximaMs: 0 }),
      googleAdsUrl: this.config.plataformas.googleAdsUrl,
      acesso: (refreshToken: string) => acessoGoogle(this.config, this.config.oauth.google?.tokenUrl ?? '', refreshToken),
    };
    googleAnunciosConnector.ligar({ ...comum, versao: (capacidade) => versaoRegistrada(database.db, 'google_ads', capacidade) });
    campanhaGoogleConnector.ligar({ ...comum, versao: (capacidade) => versaoRegistrada(database.db, 'google_ads', capacidade), armazem: this.armazem });
  }
}
