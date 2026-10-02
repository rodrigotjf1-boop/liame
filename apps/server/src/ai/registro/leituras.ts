import type { AttentionItem } from '@liame/contracts';
import { type Database, withContext } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { currentTx, requestStore } from '../../context/request-context.js';
import { DATABASE } from '../../database/database.module.js';
import { AppProblem } from '../../errors/problems.js';
import { MediaService } from '../../media/media.service.js';
import { AtencaoCicloService } from '../../results/atencao-ciclo.service.js';
import type { FerramentaIa } from '../gateway.js';
import type { FerramentaDef } from './definicoes.js';
import { LEITURAS } from './leituras.defs.js';
import { visaoDoFrescor, visaoDosAvisos } from './leituras.visoes.js';

/** Quem pediu: a empresa, a pessoa e as permissões dela. `sistema` é a rotina sem pessoa (relatório noturno). */
export interface ContextoDaLeitura {
  tenantId: string;
  userId: string | null;
  permissions: ReadonlySet<string> | 'sistema';
  agora?: Date;
}

type Leitor = (ctx: ContextoDaLeitura, input: Record<string, unknown>) => Promise<unknown>;

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
  ) {
    this.leitores = {
      fontes_frescor: async (ctx, input) => visaoDoFrescor(await media.frescor(input.brand_id as string | undefined, ctx.agora), await fuso(ctx)),
      atencao_avisos: async (ctx, input) => {
        const marca = input.brand_id as string | undefined;
        const midia = await media.atencao(marca, ctx.agora);
        // Os avisos de vendas pedem a permissão de vendas, como na rota deles.
        const vendas: AttentionItem[] = pode(ctx, 'vendas.ver') ? (await ciclo.atencao(marca, ctx.agora)).items : [];
        return visaoDosAvisos([...midia.items, ...vendas], midia.generated_at, await fuso(ctx));
      },
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
            requestStore.run({ tx, afterCommit: [] }, () => ler(ctx, input.data as Record<string, unknown>)),
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
