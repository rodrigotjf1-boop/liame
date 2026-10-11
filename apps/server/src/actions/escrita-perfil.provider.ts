import type { Database } from '@liame/database';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { acessoGoogle } from '../connections/oauth.js';
import { ClienteConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { BALDE_DO_PERFIL_GOOGLE, criarConectorPerfilGoogle } from '../connectors/google-business/conector-perfil-google.js';
import { DATABASE } from '../database/database.module.js';
import { VaultService } from '../vault/vault.service.js';
import { perfilAvaliacaoConnector } from './perfil-avaliacao.js';

/** A cota do Perfil é do projeto, para todas as empresas: o pedido espera pouco por uma ficha e, sem ela, sobe como limite. */
const ESPERA_PELA_COTA_MS = 2_000;

/**
 * Liga o connector da resposta a avaliações do perfil da empresa no Google (A6, Z2) ao cofre, à troca do token e ao
 * conector do Perfil quando o app sobe: na API (que lê a avaliação para montar o pedido) e no worker (que confere de
 * novo e publica). Como os outros, o connector é um registro simples (`CONNECTORS`), atrás da flag
 * `perfil_google_write`; é aqui que ele recebe o que precisa.
 */
@Injectable()
export class EscritaPerfil implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
  ) {}

  onModuleInit(): void {
    const database = this.database;
    if (!database) return;
    perfilAvaliacaoConnector.ligar({
      lerSegredo: (tx, secretId) => this.vault.readSecret(tx, secretId),
      acesso: (refreshToken) => acessoGoogle(this.config, this.config.oauth.google?.tokenUrl ?? '', refreshToken),
      // Uma tentativa por chamada: a resposta não se repete sozinha (quem avaliou é avisado pelo Google quando ela sai).
      // Quem adia e tenta de novo é o executor, que lê a avaliação antes de mandar outra vez.
      conector: (tempoLimiteMs) =>
        criarConectorPerfilGoogle(
          database.db,
          new ClienteConector(database.db, {
            enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos),
            balde: BALDE_DO_PERFIL_GOOGLE,
            tentativas: 1,
            esperaMaximaMs: ESPERA_PELA_COTA_MS,
            ...(tempoLimiteMs ? { tempoLimiteMs } : {}),
          }),
          this.config.plataformas,
        ),
    });
  }
}
