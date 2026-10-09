import type { Database } from '@liame/database';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ClienteConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { VaultService } from '../vault/vault.service.js';
import { regemCupomConnector } from './regem-cupom.js';
import { regemcastMensagemConnector } from './regemcast-mensagem.js';

/**
 * Liga o connector do pedido de mensagem (A5, Y5) ao cofre, ao cliente HTTP e ao endereço do RegemCast quando o app
 * sobe: na API (que lê o plano do disparo para montar o pedido) e no worker (que valida e dispara). O connector é um
 * registro simples; é aqui que ele recebe o que precisa.
 * O cupom da mensagem nasce pelo conector de cupom do Regem, e só com a escrita no Regem ligada para a empresa
 * (`regem_write`): sem ela, a mensagem que leva cupom não sai.
 */
@Injectable()
export class EscritaRegemcast implements OnModuleInit {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
    private readonly flags: FlagService,
  ) {}

  onModuleInit(): void {
    const database = this.database;
    if (!database) return;
    regemcastMensagemConnector.ligar({
      lerSegredo: (tx, secretId) => this.vault.readSecret(tx, secretId),
      // Uma tentativa por chamada: quem adia e tenta de novo é o executor, com a mesma chave de idempotência.
      cliente: (tempoLimiteMs) =>
        new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 1, ...(tempoLimiteMs ? { tempoLimiteMs } : {}) }),
      apiUrl: this.config.produtos.regemcastApiUrl,
      cupom: {
        conferir: async (tx, alvo) => {
          const ligada = await this.flags.isEnabled(regemCupomConnector.writeFlag, this.flags.context({ tenantId: alvo.tenantId, accountId: alvo.lojaId }));
          if (!ligada) return 'A criação de cupom no Regem não está ligada para esta empresa.';
          return regemCupomConnector.conferirCupomDaMensagem(tx, alvo);
        },
        criar: (tx, alvo) => regemCupomConnector.criarCupomDaMensagem(tx, alvo),
      },
    });
  }
}
