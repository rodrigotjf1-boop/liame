import { BRAND_LOGO_LIMITS, type BrandLogoResponse } from '@liame/contracts';
import { type Database, type Tx, uuidv7 } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { processarLogo, RECUSAS_DO_LOGO, RecusaDoLogo } from '../agencia/logo-da-agencia.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { afterCommit, auditDetail, type AuthContext, currentTx } from '../context/request-context.js';
import { actorLabel, actorTypeOf } from '../context/unit-of-work.interceptor.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { prefixoDaMarca } from '../fotos/conferencia.js';
import { marcaDaEmpresa, quemPede } from '../fotos/fotos.service.js';
import { carregarSharp, SemSharp } from '../fotos/processar.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens, ArmazemIndisponivel } from '../imagens/armazem.js';

// A logo do restaurante em Minha marca (A6 · Z15, parte 1; P43 aprovado em 11/11/2026; D-A6-138). Como a logo da agência
// (D-A7-69): PNG ou JPG, até 1 MB; o tipo é lido do conteúdo e o servidor regrava em JPEG sobre fundo branco, aqui
// cabendo em 512 × 512 px (o vídeo montado pelo Liame a põe num selo redondo). O arquivo fica no prefixo da marca, no
// armazenamento de imagens: sai junto quando a marca ou a empresa é apagada. Ver: quem vê Minha marca; trocar e tirar:
// quem edita (`dossie.editar`).

/** O endereço de leitura da logo vale 5 minutos (o bucket recusa mais de 10; ADR-021). */
const SEGUNDOS_DA_LOGO = 300;
const CAIXA = { largura: BRAND_LOGO_LIMITS.storedMaxWidth, altura: BRAND_LOGO_LIMITS.storedMaxHeight };

export const ACAO_LOGO_DA_MARCA = 'marca.logo_trocar';

type LinhaDaLogo = { logo_id: string | null; logo_width: number | null; logo_height: number | null; logo_updated_at: Date | string | null };

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

/** A chave da logo no armazenamento (`logo_id` muda a cada logo nova), no prefixo da marca. */
export function chaveDaLogoDaMarca(tenantId: string, brandId: string, logoId: string): string {
  return `${prefixoDaMarca(tenantId, brandId)}logo/${logoId}.jpg`;
}

function logoIndisponivel(): AppProblem {
  return new AppProblem(503, 'logo-indisponivel', 'Logo indisponível', 'Não dá para receber a logo agora. Tente mais tarde.');
}

async function linhaDaLogo(tx: Tx, brandId: string): Promise<LinhaDaLogo> {
  const r = await tx.execute<LinhaDaLogo>(sql`select logo_id, logo_width, logo_height, logo_updated_at from liame.brand where id = ${brandId} and archived_at is null`);
  const l = r.rows[0];
  if (!l) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
  return l;
}

@Injectable()
export class LogoDaMarcaService {
  private readonly logger = new Logger('logo-da-marca');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(ARMAZEM_DE_IMAGENS) private readonly armazem: ArmazemDeImagens,
    private readonly rateLimit: RateLimitService,
  ) {}

  private banco(): Database {
    if (!this.database) throw new Error('logo da marca: sem banco');
    return this.database;
  }

  /** A logo da marca (quem vê Minha marca). */
  async ler(auth: AuthContext, brandId: string): Promise<BrandLogoResponse> {
    const quem = quemPede(auth);
    return this.resposta(quem.tenantId, brandId, await linhaDaLogo(currentTx(), brandId));
  }

  /** Troca a logo: confere e regrava o arquivo, grava no armazenamento e só depois no banco; a anterior sai depois. */
  async enviar(auth: AuthContext, brandId: string, corpo: unknown): Promise<BrandLogoResponse> {
    const database = this.banco();
    if (!Buffer.isBuffer(corpo) || corpo.length === 0) {
      throw new AppProblem(400, 'logo-sem-arquivo', 'Falta a logo', 'Mande o arquivo da logo no corpo do pedido (PNG ou JPG).');
    }
    const quem = quemPede(auth);
    await naTransacaoDaEmpresa(database, quem, async () => {
      await marcaDaEmpresa(brandId);
    });
    if (!this.armazem.disponivel) throw logoIndisponivel();
    await this.rateLimit.consume(`logo:marca:${brandId}`, 30, 86400);

    let logo: Awaited<ReturnType<typeof processarLogo>>;
    try {
      logo = await processarLogo(corpo, carregarSharp, CAIXA);
    } catch (err) {
      if (err instanceof RecusaDoLogo) {
        const r = RECUSAS_DO_LOGO[err.motivo];
        throw new AppProblem(422, r.code, r.title, r.detail);
      }
      if (err instanceof SemSharp) {
        this.logger.error(err.message);
        throw logoIndisponivel();
      }
      throw err;
    }

    const logoId = uuidv7();
    const chave = chaveDaLogoDaMarca(quem.tenantId, brandId, logoId);
    try {
      await this.armazem.gravar(chave, logo.bytes);
    } catch (err) {
      this.logger.warn(`logo da marca ${brandId}: o armazenamento não guardou (${err instanceof Error ? err.message : String(err)})`);
      if (err instanceof ArmazemIndisponivel) throw logoIndisponivel();
      throw new AppProblem(502, 'logo-nao-guardado', 'A logo não foi guardada', 'Não deu para guardar a logo agora. Tente de novo.');
    }

    try {
      const { resposta, anterior } = await naTransacaoDaEmpresa(database, quem, async () => {
        const tx = currentTx();
        const antes = await linhaDaLogo(tx, brandId);
        await tx.execute(sql`
          update liame.brand
             set logo_id = ${logoId}, logo_width = ${logo.largura}, logo_height = ${logo.altura}, logo_updated_at = now(), logo_updated_by = ${auth.userId}
           where id = ${brandId} and archived_at is null`);
        await writeAudit(tx, {
          tenantId: quem.tenantId,
          actorType: actorTypeOf(auth),
          actorId: auth.userId,
          actorLabel: actorLabel(auth),
          actorRole: auth.roleKey,
          action: ACAO_LOGO_DA_MARCA,
          resourceType: 'brand',
          resourceId: brandId,
          before: { logo: antes.logo_id ? 'sim' : 'não' },
          after: { logo: 'sim', width: logo.largura, height: logo.altura },
          traceId: activeTraceId(),
          origin: 'api',
        });
        return { resposta: await this.resposta(quem.tenantId, brandId, await linhaDaLogo(tx, brandId)), anterior: antes.logo_id };
      });
      if (anterior) this.apagarDoArmazem(chaveDaLogoDaMarca(quem.tenantId, brandId, anterior));
      return resposta;
    } catch (err) {
      // O banco não guardou: o arquivo novo sai do armazenamento, e a logo anterior continua.
      this.apagarDoArmazem(chave);
      throw err;
    }
  }

  /** Tira a logo: o vídeo montado deixa de oferecer a opção da logo. */
  async apagar(auth: AuthContext, brandId: string): Promise<void> {
    const quem = quemPede(auth);
    const tx = currentTx();
    await marcaDaEmpresa(brandId);
    const r = await tx.execute<{ logo_id: string }>(sql`
      with antes as (select logo_id from liame.brand where id = ${brandId} and logo_id is not null for update)
      update liame.brand b
         set logo_id = null, logo_width = null, logo_height = null, logo_updated_at = null, logo_updated_by = ${auth.userId}
        from antes
       where b.id = ${brandId}
      returning antes.logo_id`);
    const anterior = r.rows[0]?.logo_id;
    if (!anterior) return;
    auditDetail({ resourceId: brandId, before: { logo: 'sim' }, after: { logo: 'não' } });
    afterCommit(async () => this.apagarDoArmazem(chaveDaLogoDaMarca(quem.tenantId, brandId, anterior)));
  }

  /** Apaga sem esperar e sem derrubar o pedido: o que sobrar sai com a marca (expurgo do prefixo). */
  private apagarDoArmazem(chave: string): void {
    this.armazem.apagar([chave]).catch((err: unknown) => {
      this.logger.warn(`logo da marca: não apagou ${chave} (${err instanceof Error ? err.message : String(err)})`);
    });
  }

  private async resposta(tenantId: string, brandId: string, l: LinhaDaLogo): Promise<BrandLogoResponse> {
    let logo: BrandLogoResponse['logo'] = null;
    if (l.logo_id && l.logo_width && l.logo_height && l.logo_updated_at) {
      let url: string | null = null;
      if (this.armazem.disponivel) {
        try {
          url = await this.armazem.enderecoDeLeitura(chaveDaLogoDaMarca(tenantId, brandId, l.logo_id), SEGUNDOS_DA_LOGO);
        } catch (err) {
          this.logger.warn(`logo da marca ${brandId}: sem o endereço de leitura (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      logo = { url, width: l.logo_width, height: l.logo_height, updated_at: iso(l.logo_updated_at) };
    }
    return { brand_id: brandId, logo, logo_available: this.armazem.disponivel };
  }
}
