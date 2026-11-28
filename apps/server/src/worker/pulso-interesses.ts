import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { leitorDoPulso, type LeitorDoPulso } from '../connectors/dms/pulso.js';
import { FLAG_DO_PLANO_DE_CONTEUDO } from '../conteudo/conteudo.service.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';

// Os interesses do Liame no Pulso (plano de conteúdo, PC4, parte 2): a lista SOMADA dos municípios (o código IBGE das lojas
// no mapa) das empresas com a função `plano_conteudo` ligada, e o ramo. O Pulso vigia esses municípios (os diários
// oficiais, o clima, a véspera) e o "Em alta" do estado deles. O PUT substitui a lista inteira, então mandar de novo não
// muda nada: a rotina manda a cada 6 horas (e na subida). Nada de loja, marca, empresa ou pessoa vai junto. Sem a ligação do
// Pulso (`PULSO_LIGACAO`), não faz nada.

/** De quanto em quanto tempo a lista vai ao Pulso. */
export const INTERVALO_DOS_INTERESSES_MS = 6 * 60 * 60 * 1000;

@Injectable()
export class PulsoInteressesLoop {
  private readonly logger = new Logger('pulso-interesses');
  private ultimaLista: string | null = null;

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly flags: FlagService,
  ) {}

  /** Os municípios das lojas no mapa das empresas com a função ligada, sem repetir e em ordem. */
  async municipios(): Promise<string[]> {
    if (!this.database) return [];
    const linhas = await withSystem(this.database.db, async (tx) =>
      (
        await tx.execute<{ tenant_id: string; ibge_city_code: string }>(sql`
          select distinct u.tenant_id, u.ibge_city_code from liame.unit u
            join liame.brand b on b.id = u.brand_id and b.archived_at is null
           where u.ibge_city_code is not null`)
      ).rows,
    );
    const ligadas = new Map<string, boolean>();
    const saida = new Set<string>();
    for (const l of linhas) {
      if (!ligadas.has(l.tenant_id)) {
        ligadas.set(l.tenant_id, await this.flags.isEnabled(FLAG_DO_PLANO_DE_CONTEUDO, this.flags.context({ tenantId: l.tenant_id, userId: null })));
      }
      if (ligadas.get(l.tenant_id)) saida.add(l.ibge_city_code);
    }
    return [...saida].sort();
  }

  /** Manda a lista ao Pulso. Devolve quantos municípios foram (0 sem a ligação). Falha vira log, nunca exceção para o laço. */
  async executar(leitor: LeitorDoPulso | null = leitorDoPulso(this.config)): Promise<number> {
    if (!leitor) return 0;
    const lista = await this.municipios();
    try {
      await leitor.mandarInteresses(lista);
      const chave = lista.join(',');
      if (chave !== this.ultimaLista) this.logger.log(`pulso: ${lista.length} município(s) nos interesses`);
      this.ultimaLista = chave;
      return lista.length;
    } catch (e) {
      this.logger.warn(`pulso: os interesses não foram (${e instanceof Error ? e.message : String(e)})`);
      return 0;
    }
  }
}
