import type { AttentionItem } from '@liame/contracts';
import { type Database, withContext } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { currentTx, requestStore } from '../../context/request-context.js';
import { CouponsService } from '../../coupons/coupons.service.js';
import { DATABASE } from '../../database/database.module.js';
import { AppProblem } from '../../errors/problems.js';
import { LinksService } from '../../links/links.service.js';
import { MediaService } from '../../media/media.service.js';
import { AtencaoCicloService } from '../../results/atencao-ciclo.service.js';
import { ResultsService } from '../../results/results.service.js';
import type { FerramentaIa } from '../gateway.js';
import type { FerramentaDef } from './definicoes.js';
import { LEITURAS } from './leituras.defs.js';
import { visaoDoFrescor, visaoDosAvisos } from './leituras.visoes.js';
import { visaoDoCicloFechado } from './visoes/ciclo-fechado.js';
import { visaoDosCupons } from './visoes/cupons.js';
import { visaoDosLinks } from './visoes/links.js';
import { visaoDaEntrega } from './visoes/midia.js';

/** Quem pediu: a empresa, a pessoa e as permissões dela. `sistema` é a rotina sem pessoa (relatório noturno). */
export interface ContextoDaLeitura {
  tenantId: string;
  userId: string | null;
  permissions: ReadonlySet<string> | 'sistema';
  agora?: Date;
}

// Os parâmetros chegam aqui já validados pelo schema da definição (`leituras.defs.ts`).
type Leitor = (ctx: ContextoDaLeitura, input: { brand_id?: string; unit_id?: string; from?: string; to?: string }) => Promise<unknown>;

const pode = (ctx: ContextoDaLeitura, permissao: string | null): boolean => !permissao || ctx.permissions === 'sistema' || ctx.permissions.has(permissao);

/**
 * Execução das ferramentas de leitura (A3-4): cada uma chama o MESMO serviço da rota equivalente, dentro
 * de uma transação com a empresa e a pessoa no contexto da RLS. A ferramenta só é oferecida a quem tem a
 * permissão da rota, e a marca de outra empresa não aparece: o banco não a entrega.
 */
@Injectable()
export class FerramentasDeLeitura {
  private readonly leitores: Record<string, Leitor>;

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    media: MediaService,
    ciclo: AtencaoCicloService,
    resultados: ResultsService,
    cupons: CouponsService,
    links: LinksService,
  ) {
    this.leitores = {
      fontes_frescor: async (ctx, input) => visaoDoFrescor(await media.frescor(input.brand_id, ctx.agora), await fuso(ctx)),
      atencao_avisos: async (ctx, input) => {
        const midia = await media.atencao(input.brand_id, ctx.agora);
        // Os avisos de vendas pedem a permissão de vendas, como na rota deles.
        const vendas: AttentionItem[] = pode(ctx, 'vendas.ver') ? (await ciclo.atencao(input.brand_id, ctx.agora)).items : [];
        return visaoDosAvisos([...midia.items, ...vendas], midia.generated_at, await fuso(ctx));
      },
      resultados_ciclo_fechado: async (ctx, input) =>
        visaoDoCicloFechado(
          await resultados.closedLoop({ brand_id: input.brand_id!, from: input.from!, to: input.to!, ...(input.unit_id ? { unit_id: input.unit_id } : {}) }, ctx.agora),
        ),
      midia_entrega: async (_ctx, input) => visaoDaEntrega(await media.entrega({ brand_id: input.brand_id, from: input.from!, to: input.to! })),
      cupons_campanha: async (ctx, input) => visaoDosCupons(await cupons.list({ tenantId: ctx.tenantId, userId: ctx.userId }, input.brand_id!, ctx.agora)),
      links_rastreio: async (ctx, input) =>
        visaoDosLinks(await links.list({ brand_id: input.brand_id! }, ctx.agora), await links.trackingCheck(input.brand_id!, ctx.agora)),
    };
  }

  /** As ferramentas que ESTA pessoa pode usar (todas, ou só as pedidas pelo nome), presas à empresa dela. */
  paraPedido(ctx: ContextoDaLeitura, nomes?: readonly string[]): FerramentaIa[] {
    return LEITURAS.filter((def) => (!nomes || nomes.includes(def.name)) && pode(ctx, def.permission)).map((def) => this.presa(def, ctx));
  }

  private presa(def: FerramentaDef, ctx: ContextoDaLeitura): FerramentaIa {
    const ler = this.leitores[def.name];
    if (!ler) throw new Error(`ferramenta de leitura sem execução: ${def.name}`);
    return {
      name: def.name,
      description: def.description,
      input: def.input,
      executar: async (bruto) => {
        const input = def.input.safeParse(bruto);
        if (!input.success) return { ok: false, erro: 'Parâmetros inválidos para esta ferramenta.' };
        if (!this.database) return { ok: false, erro: 'Não foi possível ler agora.' };
        try {
          // A mesma unidade de trabalho de uma rota: transação da empresa, contexto da RLS e o serviço de domínio.
          const valor = await withContext(this.database.db, { tenantId: ctx.tenantId, userId: ctx.userId }, (tx) =>
            requestStore.run({ tx, afterCommit: [] }, () => ler(ctx, input.data as Parameters<Leitor>[1])),
          );
          return { ok: true, valor };
        } catch (err) {
          // O texto do erro de domínio é feito para o usuário (sem dado interno): serve ao modelo também.
          if (err instanceof AppProblem) return { ok: false, erro: err.detail };
          throw err;
        }
      },
    };
  }
}

/** Fuso da empresa, para as datas saírem como a pessoa lê. */
async function fuso(ctx: ContextoDaLeitura): Promise<string> {
  const r = await currentTx().execute<{ timezone: string }>(sql`select timezone from liame.organization where id = ${ctx.tenantId}`);
  return r.rows[0]?.timezone ?? 'America/Sao_Paulo';
}
