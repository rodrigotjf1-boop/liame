import { createHmac } from 'node:crypto';
import { type Database, type Tx, withSystem, withTenant } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { contaConectada } from '../connections/conectada.js';
import { type ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { FLAG_DOS_POSTS, tokenDaPagina } from '../connectors/meta/publicacao.js';
import type { FlagService } from '../flags/flag.service.js';
import { type JobScope, tenantFilter } from '../worker/outbox-publisher.js';
import {
  METRICAS_DA_PAGINA,
  METRICAS_DO_INSTAGRAM,
  NOVA_TENTATIVA_MIN,
  type NumerosDoPost,
  numerosDaPagina,
  numerosDoInstagram,
  proximaLeitura,
} from './numeros-do-post.js';

// A leitura dos números de cada post nas redes (A6, Z7, parte c; D-A6-50 a D-A6-52). A fila é o próprio canal publicado
// (`metrics_next_at`): a reserva é feita com SKIP LOCKED no escopo do sistema, na mesma linha que ela altera (ERR-029),
// e cada leitura roda na empresa, que confere a função dos posts (`social_write`): desligada, o canal sai da fila por um
// dia (V106). No Instagram, o token da autorização lê `GET /{ig-media-id}/insights`; na Página, o token dela (pela lista
// das Páginas da autorização, de quem pode ANALYZE) lê `GET /{page-post-id}/insights`. O que vem fica como o último
// número lido; o que não vem não apaga o que já havia. Os tokens nunca vão para log nem para o banco.

const META = 'meta_ads';
/** Reserva da leitura: se o worker cair no meio, o canal volta para a fila depois disto. */
const RESERVA_MIN = 30;

/** O que a leitura precisa do resto do app (o mesmo que a publicação usa; os testes trocam o endereço da Graph). */
export type DependenciasDosNumeros = {
  lerSegredo: (tx: Tx, secretId: string) => Promise<string | null>;
  cliente: () => ClienteConector;
  graphUrl: string;
  appSecret: string | null;
  versao: (capacidade: 'instagram_insights' | 'pagina_insights' | 'pages') => Promise<string>;
};

/** Como terminou a vez de um canal. */
export type VezDosNumeros = { canal: string; situacao: 'lido' | 'sem_dados' | 'sem_permissao' | 'sem_conta' | 'desligado' | 'adiado' | 'fora' };

type LinhaDoCanal = {
  id: string;
  channel: string;
  status: string;
  external_id: string | null;
  published_at: Date | string | null;
  brand_id: string;
  kind: string;
  conta_externa: string | null;
  segredo: string | null;
  conectada: boolean;
};

export class LeitorDosNumeros {
  private readonly logger = new Logger('posts-numeros');

  constructor(
    private readonly database: Database,
    private readonly deps: DependenciasDosNumeros,
    private readonly flags: FlagService,
  ) {}

  /** Um lote: reserva os canais devidos (o mais atrasado primeiro, de qualquer empresa) e lê cada um. */
  async executarLote(limite = 5, scope: JobScope = {}, agora: Date = new Date()): Promise<VezDosNumeros[]> {
    const db = this.database.db;
    const referencia = sql`${agora.toISOString()}::timestamptz`;
    const reservados = await withSystem(db, async (tx) => {
      const r = await tx.execute<{ id: string; tenant_id: string }>(sql`
        with devidos as materialized (
          select ch.id from liame.social_post_channel ch
           where ch.metrics_next_at is not null and ch.metrics_next_at <= ${referencia} ${tenantFilter(scope, sql`ch.tenant_id`)}
           order by ch.metrics_next_at, ch.id
           limit ${limite}
           for update of ch skip locked
        )
        update liame.social_post_channel ch
           set metrics_next_at = ${referencia} + make_interval(mins => ${RESERVA_MIN})
          from devidos d
         where ch.id = d.id
        returning ch.id, ch.tenant_id`);
      return r.rows;
    });
    const vezes: VezDosNumeros[] = [];
    for (const c of reservados) {
      try {
        vezes.push(await withTenant(db, c.tenant_id, (tx) => this.lerCanal(tx, c.tenant_id, c.id, agora)));
      } catch (err) {
        // Falha fora do previsto (banco): a reserva vence e o canal volta para a fila (LIC-001).
        this.logger.error(`canal ${c.id}: ${err instanceof Error ? err.message : String(err)}`);
        vezes.push({ canal: c.id, situacao: 'adiado' });
      }
    }
    return vezes;
  }

  /** Lê os números de um canal publicado e grava o resultado e a próxima leitura. */
  private async lerCanal(tx: Tx, tenantId: string, id: string, agora: Date): Promise<VezDosNumeros> {
    const c = (
      await tx.execute<LinhaDoCanal>(sql`
        select ch.id, ch.channel, ch.status, ch.external_id, ch.published_at, p.brand_id, p.kind,
               a.external_id as conta_externa, a.credential_secret_id as segredo, coalesce(${contaConectada('a')}, false) as conectada
          from liame.social_post_channel ch
          join liame.social_post p on p.id = ch.post_id and p.tenant_id = ch.tenant_id
          left join liame.connected_account a on a.id = ch.connected_account_id and a.tenant_id = ch.tenant_id
         where ch.id = ${id} and ch.tenant_id = ${tenantId}`)
    ).rows[0];
    // O canal que não está mais publicado (apagado), ou que não é do Liame (o pacote), sai da fila.
    if (!c || c.kind !== 'post' || !['instagram', 'facebook'].includes(c.channel) || c.status !== 'publicado') {
      if (c) await this.gravar(tx, c.id, { proxima: null });
      return { canal: id, situacao: 'fora' };
    }
    const publicadoEm = c.published_at ? new Date(c.published_at) : agora;
    const proxima = proximaLeitura(publicadoEm, agora);
    if (!(await this.flags.isEnabled(FLAG_DOS_POSTS, this.flags.context({ tenantId, brandId: c.brand_id })))) {
      // A função desligada: o canal espera um dia, sem ler (V106).
      await this.gravar(tx, c.id, { proxima: proxima ? new Date(agora.getTime() + 24 * 3_600_000) : null });
      return { canal: id, situacao: 'desligado' };
    }
    if (!c.conectada || !c.segredo || !c.external_id || !c.conta_externa) {
      await this.gravar(tx, c.id, { situacao: 'sem_conta', proxima });
      return { canal: id, situacao: 'sem_conta' };
    }
    try {
      const token = await this.token(tx, c.segredo);
      const numeros = c.channel === 'instagram' ? await this.doInstagram(c, token) : await this.daPagina(c, token);
      if (numeros === 'sem_permissao') {
        await this.gravar(tx, c.id, { situacao: 'sem_permissao', proxima, agora });
        return { canal: id, situacao: 'sem_permissao' };
      }
      await this.gravar(tx, c.id, numeros ? { situacao: 'lido', numeros, proxima, agora } : { situacao: 'sem_dados', proxima, agora });
      return { canal: id, situacao: numeros ? 'lido' : 'sem_dados' };
    } catch (err) {
      if (!(err instanceof ErroConector)) throw err;
      if (err.tipo === 'autenticacao') {
        await this.gravar(tx, c.id, { situacao: 'sem_conta', proxima, agora });
        return { canal: id, situacao: 'sem_conta' };
      }
      if (err.tipo === 'permissao') {
        await this.gravar(tx, c.id, { situacao: 'sem_permissao', proxima, agora });
        return { canal: id, situacao: 'sem_permissao' };
      }
      if (err.tipo === 'definitivo') {
        // A Meta não tem o número deste post (a Página com menos de 100 curtidas, o post que ela não acha): tenta amanhã.
        this.logger.warn(`canal ${c.id}: a Meta não deu os números (HTTP ${err.status ?? '?'}, código ${err.codigoProvider ?? '?'}): ${err.message}`);
        await this.gravar(tx, c.id, { situacao: 'sem_dados', proxima, agora });
        return { canal: id, situacao: 'sem_dados' };
      }
      // Passageiro (limite, fora do ar, circuito aberto): tenta de novo em uma hora, sem mudar o que já foi lido.
      this.logger.warn(`canal ${c.id}: a leitura dos números fica para depois (${err.tipo}): ${err.message}`);
      await this.gravar(tx, c.id, { proxima: proxima ? new Date(agora.getTime() + NOVA_TENTATIVA_MIN * 60_000) : null });
      return { canal: id, situacao: 'adiado' };
    }
  }

  private async doInstagram(c: LinhaDoCanal, token: string): Promise<NumerosDoPost | null | 'sem_permissao'> {
    const versao = await this.deps.versao('instagram_insights');
    const r = await this.chamar(c.conta_externa!, token, versao, `${c.external_id}/insights`, 'instagram_insights', { metric: METRICAS_DO_INSTAGRAM.join(',') });
    return numerosDoInstagram(r);
  }

  private async daPagina(c: LinhaDoCanal, tokenDaAutorizacao: string): Promise<NumerosDoPost | null | 'sem_permissao'> {
    const contas = await this.chamar(c.conta_externa!, tokenDaAutorizacao, await this.deps.versao('pages'), 'me/accounts', 'pages', { fields: 'id,access_token,tasks', limit: '100' });
    const pagina = tokenDaPagina(contas, c.conta_externa!);
    // Ler os números da Página pede o token dela, de quem pode analisar (ANALYZE).
    if (!pagina || !pagina.podeAnalisar) return 'sem_permissao';
    const r = await this.chamar(c.conta_externa!, pagina.token, await this.deps.versao('pagina_insights'), `${c.external_id}/insights`, 'pagina_insights', { metric: METRICAS_DA_PAGINA.join(',') });
    return numerosDaPagina(r);
  }

  private async token(tx: Tx, secretId: string): Promise<string> {
    const guardada = await this.deps.lerSegredo(tx, secretId);
    const credencial = guardada ? (JSON.parse(guardada) as { tipo?: string; access_token?: string }) : null;
    if (!credencial || credencial.tipo !== 'meta' || !credencial.access_token) throw new ErroConector('autenticacao', META, 'autorização revogada ou ausente');
    return credencial.access_token;
  }

  /** Uma leitura na Graph API: o token no cabeçalho e a prova do segredo do app no endereço (nunca o token, V161). */
  private async chamar(conta: string, token: string, versao: string, caminho: string, capacidade: string, params: Record<string, string>): Promise<unknown> {
    const q = new URLSearchParams(params);
    if (this.deps.appSecret) q.set('appsecret_proof', createHmac('sha256', this.deps.appSecret).update(token).digest('hex'));
    const r = await this.deps.cliente().requisitar<unknown>({
      provider: META,
      conta,
      url: `${this.deps.graphUrl}/${versao}/${caminho}?${q.toString()}`,
      metodo: 'GET',
      endpoint: capacidade,
      apiVersion: versao,
      cabecalhos: { authorization: `Bearer ${token}` },
    });
    return r.corpo;
  }

  /** Grava o resultado: os números (o que não veio não apaga o que já havia), a situação, a hora e a próxima leitura. */
  private async gravar(tx: Tx, id: string, o: { situacao?: string; numeros?: NumerosDoPost; proxima: Date | null; agora?: Date }): Promise<void> {
    await tx.execute(sql`
      update liame.social_post_channel
         set metrics = coalesce(${o.numeros ? JSON.stringify(o.numeros) : null}::jsonb, metrics),
             metrics_status = case when ${o.situacao ?? null}::text is null then metrics_status
                                   when ${o.situacao ?? null}::text = 'sem_dados' and metrics is not null then metrics_status
                                   else ${o.situacao ?? null}::text end,
             metrics_read_at = coalesce(${o.agora ? o.agora.toISOString() : null}::timestamptz, metrics_read_at),
             metrics_next_at = ${o.proxima ? o.proxima.toISOString() : null}::timestamptz
       where id = ${id}`);
  }
}
