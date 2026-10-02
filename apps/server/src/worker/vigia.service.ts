import { type Database, type Tx, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { buscarPagina, comparar, hashDoConteudo, type Trecho, trechos } from '../connectors/vigia-trechos.js';
import { DATABASE } from '../database/database.module.js';

// Vigia de integrações (A2, G8; ADR-015): rotina diária da distribuição. Lê as fontes oficiais e
// registra os trechos que mudaram; gera os alertas do calendário de versões (60/30/7 dias antes do fim,
// na data, D+1 e D+7) a partir do Capability Registry e dos avisos Deprecation/Sunset vistos nas
// respostas. Alertas são idempotentes (um por tipo, provider, versão e etapa).

/** Falhas seguidas de uma fonte até virar alerta. */
const FALHAS_PARA_ALERTA = 3;

export type ResultadoVigia = { fontes: number; lidas: number; mudancas: number; alertas: number };

type Fonte = { id: string; provider: string; title: string; url: string; failures: number; sections: Pick<Trecho, 'titulo' | 'hash'>[] | null };

/** Etapa do calendário para `dias` até o fim da versão (negativo = já passou). */
export function etapaDoCalendario(dias: number): { kind: 'versao_expirando' | 'versao_expirada'; stage: string } | null {
  if (dias > 60) return null;
  if (dias > 30) return { kind: 'versao_expirando', stage: '60d' };
  if (dias > 7) return { kind: 'versao_expirando', stage: '30d' };
  if (dias > 0) return { kind: 'versao_expirando', stage: '7d' };
  if (dias === 0) return { kind: 'versao_expirada', stage: 'd' };
  if (dias > -7) return { kind: 'versao_expirada', stage: 'd+1' };
  return { kind: 'versao_expirada', stage: 'd+7' };
}

const NOMES: Record<string, string> = { meta_ads: 'Meta', google_ads: 'Google Ads', ga4: 'GA4', anthropic: 'Anthropic' };
const nome = (p: string) => NOMES[p] ?? p;
const dataBr = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const DIA_MS = 86_400_000;

@Injectable()
export class VigiaService {
  private readonly logger = new Logger('vigia');

  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  /** A rotina do dia. `buscar` troca a leitura das páginas nos testes. */
  async rodar(agora: Date = new Date(), buscar: (url: string) => Promise<string> = buscarPagina): Promise<ResultadoVigia> {
    if (!this.database) return { fontes: 0, lidas: 0, mudancas: 0, alertas: 0 };
    const db = this.database.db;
    const hoje = agora.toISOString().slice(0, 10);
    const fontes = await withSystem(db, async (tx) =>
      (
        await tx.execute<Fonte>(sql`
          select f.id, f.provider, f.title, f.url, f.failures, s.sections
            from liame.watch_source f left join liame.watch_snapshot s on s.source_id = f.id
           where f.active order by f.url`)
      ).rows,
    );

    let lidas = 0;
    let mudancas = 0;
    let alertas = 0;
    for (const f of fontes) {
      let lidos: Trecho[];
      try {
        lidos = trechos(await buscar(f.url));
      } catch (err) {
        const motivo = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        this.logger.warn(`fonte ${f.url}: ${motivo}`);
        alertas += await withSystem(db, async (tx) => {
          await tx.execute(sql`
            update liame.watch_source set last_checked_at = now(), last_error = ${motivo}, failures = failures + 1 where id = ${f.id}`);
          if (f.failures + 1 < FALHAS_PARA_ALERTA) return 0;
          return this.alertar(tx, {
            kind: 'fonte_falhou',
            provider: f.provider,
            apiVersion: f.id,
            stage: hoje,
            message: `O Vigia não conseguiu ler "${f.title}" ${f.failures + 1} vezes seguidas (${motivo}).`,
            sourceUrl: f.url,
          });
        });
        continue;
      }
      lidas++;
      const diferencas = f.sections ? comparar(f.sections, lidos) : [];
      mudancas += diferencas.length;
      alertas += await withSystem(db, async (tx) => {
        await tx.execute(sql`
          insert into liame.watch_snapshot (source_id, fetched_at, content_hash, sections)
          values (${f.id}, now(), ${hashDoConteudo(lidos)}, ${JSON.stringify(lidos.map((t) => ({ titulo: t.titulo, hash: t.hash })))}::jsonb)
          on conflict (source_id) do update set fetched_at = excluded.fetched_at, content_hash = excluded.content_hash, sections = excluded.sections`);
        await tx.execute(sql`
          update liame.watch_source set last_checked_at = now(), last_ok_at = now(), last_error = null, failures = 0 where id = ${f.id}`);
        if (!diferencas.length) return 0;
        const linhas = diferencas.map((d) => ({
          id: uuidv7(),
          section_title: d.titulo.slice(0, 300),
          change: d.mudanca,
          old_hash: d.hashAntes,
          new_hash: d.hashDepois,
          excerpt: d.texto ? d.texto.slice(0, 4000) : null,
        }));
        await tx.execute(sql`
          insert into liame.watch_change (id, source_id, section_title, change, old_hash, new_hash, excerpt)
          select x.id, ${f.id}, x.section_title, x.change, x.old_hash, x.new_hash, x.excerpt
            from jsonb_to_recordset(${JSON.stringify(linhas)}::jsonb)
                 as x (id uuid, section_title text, change text, old_hash text, new_hash text, excerpt text)`);
        const titulos = diferencas.slice(0, 5).map((d) => `"${d.titulo}"`).join(', ');
        return this.alertar(tx, {
          kind: 'fonte_mudou',
          provider: f.provider,
          apiVersion: f.id,
          stage: hoje,
          message: `${diferencas.length} trecho(s) mudaram em "${f.title}": ${titulos}${diferencas.length > 5 ? '…' : ''}. Revisar o impacto nos conectores.`.slice(0, 1000),
          sourceUrl: f.url,
        });
      });
    }

    alertas += await withSystem(db, (tx) => this.calendario(tx, agora));
    alertas += await withSystem(db, (tx) => this.depreciacoes(tx));
    return { fontes: fontes.length, lidas, mudancas, alertas };
  }

  /** Versões do registro com data de fim (e as datas de Sunset vistas nas respostas) → alerta da etapa. */
  private async calendario(tx: Tx, agora: Date): Promise<number> {
    const r = await tx.execute<{ provider: string; api_version: string; fim: string; source_url: string | null }>(sql`
      select provider, api_version, min(fim)::text as fim, min(source_url) as source_url from (
        select provider, api_version, sunset_at as fim, source_url from liame.connector_capability where sunset_at is not null
        union all
        select n.provider, n.api_version, ((n.sunset::timestamptz) at time zone 'UTC')::date as fim, n.link
          from liame.api_deprecation_notice n
         where n.sunset is not null
           and exists (select 1 from liame.connector_capability c where c.provider = n.provider and c.api_version = n.api_version)
      ) v group by provider, api_version`);
    let criados = 0;
    const hoje = Date.parse(`${agora.toISOString().slice(0, 10)}T00:00:00Z`);
    for (const v of r.rows) {
      const dias = Math.round((Date.parse(`${v.fim}T00:00:00Z`) - hoje) / DIA_MS);
      const etapa = etapaDoCalendario(dias);
      if (!etapa) continue;
      const quando =
        dias > 0 ? `termina em ${dataBr(v.fim)} (faltam ${dias} dias). Migrar o conector antes.` : dias === 0 ? `termina hoje (${dataBr(v.fim)}). Confirmar que o conector já usa a versão nova.` : `terminou em ${dataBr(v.fim)}. Conferir se as leituras seguem sem erro.`;
      criados += await this.alertar(tx, {
        kind: etapa.kind,
        provider: v.provider,
        apiVersion: v.api_version,
        stage: etapa.stage,
        dueDate: v.fim,
        message: `A versão ${v.api_version} da API ${nome(v.provider)} ${quando}`,
        sourceUrl: v.source_url,
      });
    }
    return criados;
  }

  /** Aviso Deprecation/Sunset visto numa resposta de uma versão que o registro ainda usa. */
  private async depreciacoes(tx: Tx): Promise<number> {
    const r = await tx.execute<{ provider: string; endpoint: string; api_version: string; deprecation: string | null; sunset: string | null; link: string | null }>(sql`
      select n.provider, n.endpoint, n.api_version, n.deprecation, n.sunset, n.link
        from liame.api_deprecation_notice n
       where exists (select 1 from liame.connector_capability c where c.provider = n.provider and c.api_version = n.api_version)`);
    let criados = 0;
    for (const n of r.rows) {
      const partes = [n.deprecation ? `descontinuado desde ${n.deprecation.slice(0, 10)}` : null, n.sunset ? `sai do ar em ${n.sunset.slice(0, 10)}` : null].filter(Boolean);
      criados += await this.alertar(tx, {
        kind: 'depreciacao_vista',
        provider: n.provider,
        apiVersion: n.api_version,
        stage: n.endpoint.toLowerCase().replace(/[^a-z0-9_+-]/g, '_').slice(0, 60),
        message: `A ${nome(n.provider)} avisou na resposta de "${n.endpoint}" (${n.api_version}): ${partes.join('; ') || 'recurso descontinuado'}.`,
        sourceUrl: n.link,
      });
    }
    return criados;
  }

  private async alertar(
    tx: Tx,
    a: { kind: string; provider: string; apiVersion: string; stage: string; dueDate?: string; message: string; sourceUrl: string | null },
  ): Promise<number> {
    const r = await tx.execute(sql`
      insert into liame.watch_alert (id, kind, provider, api_version, stage, due_date, message, source_url)
      values (${uuidv7()}, ${a.kind}, ${a.provider}, ${a.apiVersion}, ${a.stage}, ${a.dueDate ?? null}, ${a.message}, ${a.sourceUrl})
      on conflict (kind, provider, api_version, stage) do nothing`);
    return r.rowCount ?? 0;
  }
}
