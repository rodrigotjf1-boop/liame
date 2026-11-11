import type { Database } from '@liame/database';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ClienteConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { versaoRegistrada } from '../connectors/tipos.js';
import { DATABASE } from '../database/database.module.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens } from '../imagens/armazem.js';
import { KillSwitchService } from '../kill-switch/kill-switch.service.js';
import { VaultService } from '../vault/vault.service.js';
import { comentarioNaPaginaConnector, comentarioNoInstagramConnector, type DependenciasDoComentario } from './comentario-na-rede.js';
import { directNoInstagramConnector } from './direct-na-rede.js';
import { type DependenciasDoPost, postNaPaginaConnector, postNoInstagramConnector } from './post-publicacao.js';

/**
 * Liga o connector do post da marca (A6, Z5b) ao cofre, ao cliente HTTP, ao endereço da Graph API, ao registro de
 * capacidades e ao armazenamento das imagens quando o app sobe: na API (que lê o post para montar o pedido) e no worker
 * (que confere de novo e publica). Como os outros, o connector é um registro simples (`CONNECTORS`), atrás da flag
 * `social_write`; é aqui que ele recebe o que precisa.
 */
@Injectable()
export class EscritaPosts implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
    @Inject(ARMAZEM_DE_IMAGENS) private readonly armazem: ArmazemDeImagens,
    private readonly travas: KillSwitchService,
  ) {}

  onModuleInit(): void {
    const database = this.database;
    if (!database) return;
    const deps: DependenciasDoPost = {
      lerSegredo: (tx, secretId) => this.vault.readSecret(tx, secretId),
      // Uma tentativa por chamada: publicar não se repete sozinho; quem adia e tenta de novo é o executor, que confere
      // antes se o post já saiu.
      cliente: () => new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas), tentativas: 1 }),
      graphUrl: this.config.plataformas.metaGraphUrl,
      ruploadUrl: this.config.plataformas.metaRuploadUrl,
      appSecret: this.config.plataformas.metaAppSecret,
      versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
      armazem: this.armazem,
      // A trava da conta do outro canal do post (a do pedido o executor confere), na ferramenta do pedido (publicar ou
      // apagar das redes), com o mesmo motivo que ele mostra.
      trava: async (tx, alvo) => {
        const t = await this.travas.check(tx, alvo);
        return t ? `${t.level}: ${t.reason}` : null;
      },
    };
    postNoInstagramConnector.ligar(deps);
    postNaPaginaConnector.ligar(deps);
    // O comentário de um post da marca (A6, Z11, parte 2), na mesma conta e pelo mesmo cofre. O tempo limite é o da
    // leitura que tem uma pessoa esperando (o pedido); a execução usa o do cliente.
    const doComentario: DependenciasDoComentario = {
      lerSegredo: deps.lerSegredo,
      cliente: (tempoLimiteMs) =>
        new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas), tentativas: 1, ...(tempoLimiteMs ? { tempoLimiteMs } : {}) }),
      graphUrl: deps.graphUrl,
      appSecret: deps.appSecret,
      versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
    };
    comentarioNoInstagramConnector.ligar(doComentario);
    comentarioNaPaginaConnector.ligar(doComentario);
    // A resposta numa conversa do Direct (A6, Z12, parte 2), na mesma conta do Instagram e pelo mesmo cofre. O id do app
    // do Liame na Meta serve para conferir o dono da conversa (`thread_owner`, D-A6-107).
    directNoInstagramConnector.ligar({
      lerSegredo: deps.lerSegredo,
      cliente: doComentario.cliente,
      graphUrl: deps.graphUrl,
      appSecret: deps.appSecret,
      appId: this.config.oauth.meta?.appId ?? null,
      versao: (capacidade) => versaoRegistrada(database.db, 'meta_ads', capacidade),
    });
  }
}
