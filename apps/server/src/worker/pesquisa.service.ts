import { BrandDossierContent, type BrandDossierSuggestionItem, type DossierSection } from '@liame/contracts';
import { type Database, uuidv7 } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AiError, type AiErrorCode, AiGateway } from '../ai/gateway.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { conferirLeitura, type DescartesDaLeitura, LeituraDaPagina, mensagemDaPagina, type RotulosConferidos, type TipoDePagina } from '../ai/pesquisador/leitura.js';
import { PESQUISADOR, PROMPT_PESQUISADOR, TAREFA_PESQUISADOR } from '../ai/pesquisador/prompt.js';
import { ITENS_POR_SUGESTAO, juntarItens, type SugestoesDaLeitura, sugestoesDaLeitura } from '../ai/pesquisador/sugestoes.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import { dia } from '../ai/registro/formatos.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { ResponseTooLargeError, safeGet, UnsafeUrlError } from '../events/safe-http.js';
import { DOSSIE_VAZIO } from '../marca/dossie.js';
import { DIAS_DA_RECUSA, recusados } from '../marca/sugestoes.js';
import { decodificarCorpo, ehPagina, pareceInstrucao, TEXTO_MINIMO, textoDaPagina } from '../pesquisa/pagina.js';
import { NOME_DO_ROBO, podeLer, type RegraDoRobots, regrasDoRobots, ROBOTS_MAXIMO } from '../pesquisa/robots.js';
import { diaNoFuso } from '../results/fora-do-normal.js';
import { ResultsService } from '../results/results.service.js';

// A leitura de uma página pelo Pesquisador (A3, I12; base §16.6). Fica na pasta do worker porque é rotina da fila,
// sem pessoa na sessão:
//   1. confere, como a empresa, que o pedido segue na fila, a marca existe e o Pesquisador está ativo; lê o dossiê;
//   2. busca o robots.txt do site (guardado por 24 horas) e respeita o que ele diz para o `Liame`;
//   3. lê a página com o cliente seguro (só https, nada da rede interna, redirecionamento conferido, tamanho e tempo
//      máximos) e tira o texto; recusa a página sem texto e a que tem texto tentando dar ordens a uma IA;
//   4. chama o leitor em quarentena (sem ferramenta nenhuma; a página vai na mensagem, nunca nas instruções);
//   5. confere cada rótulo contra a página e grava o que serve como sugestão em Minha marca, com a auditoria.
// A página não é guardada em lugar nenhum além do registro de 30 dias da chamada ao modelo (Política 7.3).

const USER_AGENT = `${NOME_DO_ROBO}/1.0 (Pesquisador; +https://agencialiame.com)`;
/** Tamanho máximo da página, descomprimida. */
const PAGINA_MAXIMA = 2 * 1024 * 1024;
const TEMPO_DA_PAGINA_MS = 15_000;
const REDIRECIONAMENTOS = 5;
/** O robots.txt guardado vale por isto (RFC 9309: não mais que 24 horas). */
const ROBOTS_VALE_MS = 24 * 3_600_000;
/** Sites guardados no máximo (a memória do worker não cresce sem fim). */
const ROBOTS_GUARDADOS = 1_000;
export const WORKFLOW = 'pesquisador.pagina';
const DIA_MS = 86_400_000;

type Decidida = { section: DossierSection; status: string; items: BrandDossierSuggestionItem[]; used: number[] | null };
/** O que a leitura precisa do banco, ou o motivo de descartar o pedido. */
type Lido =
  | { descartado: string }
  | { descartado?: undefined; ativo: boolean; dossie: BrandDossierContent; base: number; decididas: Decidida[]; fuso: string };

/** O pedido que a fila reservou. */
export interface PedidoDeLeitura {
  id: string;
  tenantId: string;
  brandId: string;
  kind: TipoDePagina;
  url: string;
  requestedBy: string | null;
}

export type ResultadoDaLeitura =
  | { status: 'concluida'; secoes: DossierSection[] }
  /** O site não deixa, a página não serve ou tenta dar ordens: não adianta tentar de novo. */
  | { status: 'recusada'; motivo: string; usageId?: string }
  /** Fora do ar, ou a resposta do modelo fora do formato: tenta de novo mais tarde. */
  | { status: 'falhou'; motivo: string }
  /** A IA não pôde ser chamada (desligada, sem rota, teto): volta para a fila sem contar tentativa. */
  | { status: 'sem_ia'; motivo: AiErrorCode | 'funcionario_desligado'; voltaEm?: Date }
  /** O pedido não está mais na fila (a marca foi arquivada, outro worker terminou). */
  | { status: 'descartado'; motivo: string };

@Injectable()
export class PesquisadorService {
  private readonly logger = new Logger('pesquisador');
  private readonly robots = new Map<string, { regras: RegraDoRobots[]; ate: number }>();

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly gateway: AiGateway,
    private readonly resultados: ResultsService,
  ) {}

  /** Lê a página do pedido. O relógio injetado vale para a operação inteira (V34). */
  async ler(p: PedidoDeLeitura, agora = new Date()): Promise<ResultadoDaLeitura> {
    if (!this.database) throw new Error('pesquisador: sem banco');
    const quem = { tenantId: p.tenantId, userId: null };

    // ---- 1. o pedido, a marca, o Pesquisador e o dossiê, como a empresa
    const lido = await naTransacaoDaEmpresa<Lido>(this.database, quem, async () => {
      const tx = currentTx();
      const marca = (await tx.execute(sql`select 1 from liame.brand where id = ${p.brandId} and archived_at is null`)).rows[0];
      if (!marca) return { descartado: 'a marca foi arquivada' };
      const pedido = (await tx.execute<{ status: string }>(sql`select status from liame.research_request where id = ${p.id}`)).rows[0];
      if (pedido?.status !== 'lendo') return { descartado: 'o pedido não está mais na fila' };
      const versao = (
        await tx.execute<{ content: unknown; version: number }>(sql`
          select content, version from liame.brand_dossier_version where brand_id = ${p.brandId} order by version desc limit 1`)
      ).rows[0];
      const conteudo = versao ? BrandDossierContent.safeParse(versao.content) : null;
      const decididas = await tx.execute<{ section: DossierSection; status: string; items: BrandDossierSuggestionItem[]; used: number[] | null }>(sql`
        select section, status, items, used from liame.brand_dossier_suggestion
         where brand_id = ${p.brandId} and source = 'pesquisador' and status in ('usada', 'descartada')
           and decided_at > ${new Date(agora.getTime() - DIAS_DA_RECUSA * DIA_MS)}`);
      return {
        ativo: await funcionarioAtivo(tx, { tenantId: p.tenantId, brandId: p.brandId, agentKey: PESQUISADOR.key, ativoPorPadrao: PESQUISADOR.ativoPorPadrao }),
        dossie: conteudo?.success ? conteudo.data : DOSSIE_VAZIO,
        base: versao?.version ?? 0,
        decididas: decididas.rows,
        fuso: await this.resultados.fusoDaMarca(p.brandId),
      };
    });
    if (lido.descartado !== undefined) return { status: 'descartado', motivo: lido.descartado };
    if (!lido.ativo) return { status: 'sem_ia', motivo: 'funcionario_desligado' };

    // ---- 2 e 3. o robots.txt e a página
    const url = new URL(p.url);
    const robots = await this.robotsPermite(url, agora.getTime());
    if (robots !== 'sim') return robots === 'nao' ? { status: 'recusada', motivo: 'robots' } : { status: 'falhou', motivo: 'robots_fora_do_ar' };
    let resposta: Awaited<ReturnType<typeof safeGet>>;
    try {
      resposta = await safeGet(p.url, {
        allowPrivateNetwork: this.config.pesquisaAllowPrivateNetwork,
        timeoutMs: TEMPO_DA_PAGINA_MS,
        maxBytes: PAGINA_MAXIMA,
        maxRedirects: REDIRECIONAMENTOS,
        userAgent: USER_AGENT,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
      });
    } catch (err) {
      if (err instanceof UnsafeUrlError) return { status: 'recusada', motivo: 'rede_interna' };
      if (err instanceof ResponseTooLargeError) return { status: 'recusada', motivo: 'grande_demais' };
      return { status: 'falhou', motivo: 'fora_do_ar' };
    }
    if (resposta.status === 404 || resposta.status === 410) return { status: 'recusada', motivo: 'nao_achou' };
    if (resposta.status === 401 || resposta.status === 403) return { status: 'recusada', motivo: 'sem_acesso' };
    if (resposta.status >= 400) return { status: 'falhou', motivo: 'fora_do_ar' };
    // Redirecionou para outro site: o robots.txt dele também vale.
    const final = new URL(resposta.url);
    if (final.origin !== url.origin) {
      const outro = await this.robotsPermite(final, agora.getTime());
      if (outro !== 'sim') return outro === 'nao' ? { status: 'recusada', motivo: 'robots' } : { status: 'falhou', motivo: 'robots_fora_do_ar' };
    }
    if (!ehPagina(resposta.contentType)) return { status: 'recusada', motivo: 'nao_e_pagina' };
    const pagina = textoDaPagina(decodificarCorpo(resposta.body, resposta.contentType));
    if (pagina.texto.length < TEXTO_MINIMO) return { status: 'recusada', motivo: 'sem_texto' };
    const tudo = [pagina.titulo, pagina.descricao, pagina.texto].join('\n');
    if (pareceInstrucao(tudo)) {
      this.logger.warn(`pedido ${p.id}: a página de ${final.hostname} tem texto que tenta dar ordens (regra); nada dela é usado`);
      return { status: 'recusada', motivo: 'instrucao_na_pagina' };
    }

    // ---- 4. o leitor em quarentena: sem ferramenta, a página só na mensagem
    let r: Awaited<ReturnType<AiGateway['structured']>>;
    try {
      r = await this.gateway.structured({
        tenantId: p.tenantId,
        brandId: p.brandId,
        userId: p.requestedBy,
        workflow: WORKFLOW,
        task: TAREFA_PESQUISADOR,
        promptVersion: `${PROMPT_PESQUISADOR.key}@${PROMPT_PESQUISADOR.version}`,
        instructions: PROMPT_PESQUISADOR.content,
        messages: [{ role: 'user', content: mensagemDaPagina({ tipo: p.kind, host: final.hostname, ...pagina }) }],
        schema: LeituraDaPagina,
      });
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      if (err.code === 'entrada-grande') return { status: 'recusada', motivo: 'grande_demais' };
      if (err.code === 'indisponivel') return { status: 'falhou', motivo: 'ia_fora_do_ar' };
      return { status: 'sem_ia', motivo: err.code, voltaEm: err.detalhe.voltaEm };
    }
    const leitura = LeituraDaPagina.safeParse(r.object);
    if (!leitura.success) return { status: 'falhou', motivo: 'formato' };
    if (leitura.data.instrucao_na_pagina) {
      this.logger.warn(`pedido ${p.id}: o leitor marcou texto que tenta dar ordens em ${final.hostname}; nada da página é usado; uso ${r.usageId}`);
      return { status: 'recusada', motivo: 'instrucao_na_pagina', usageId: r.usageId };
    }

    // ---- 5. a conferência e as sugestões
    const { rotulos, descartes } = conferirLeitura(leitura.data, tudo);
    const sugestoes = sugestoesDaLeitura(p.kind, rotulos, lido.dossie, (s) => recusados(lido.decididas.filter((d) => d.section === s)), {
      host: final.hostname,
      dia: dia(diaNoFuso(agora, lido.fuso))!,
    });
    const secoes = await naTransacaoDaEmpresa(this.database, quem, () =>
      this.gravar(p, { rotulos, descartes, sugestoes, base: lido.base, usageId: r.usageId, host: final.hostname, agora }),
    );
    return secoes === null ? { status: 'descartado', motivo: 'o pedido não está mais na fila' } : { status: 'concluida', secoes };
  }

  /**
   * Grava as sugestões (juntas com a do Pesquisador que já espera a pessoa naquela parte) e fecha o pedido, com a
   * auditoria do agente. Nulo quando o pedido já não estava sendo lido (outro worker fechou).
   */
  private async gravar(
    p: PedidoDeLeitura,
    g: { rotulos: RotulosConferidos; descartes: DescartesDaLeitura; sugestoes: SugestoesDaLeitura; base: number; usageId: string; host: string; agora: Date },
  ): Promise<DossierSection[] | null> {
    const tx = currentTx();
    const pedido = (await tx.execute<{ status: string }>(sql`select status from liame.research_request where id = ${p.id} for update`)).rows[0];
    if (pedido?.status !== 'lendo') return null;
    const secoes: DossierSection[] = [];
    for (const [secao, itens] of Object.entries(g.sugestoes) as Array<[DossierSection, BrandDossierSuggestionItem[]]>) {
      const pendente = (
        await tx.execute<{ id: string; items: BrandDossierSuggestionItem[] }>(sql`
          select id, items from liame.brand_dossier_suggestion
           where brand_id = ${p.brandId} and section = ${secao} and source = 'pesquisador' and status = 'pendente'
           for update`)
      ).rows[0];
      const max = (ITENS_POR_SUGESTAO as Record<string, number>)[secao] ?? 8;
      const juntos = juntarItens(pendente?.items ?? [], itens, max);
      secoes.push(secao);
      // Nada novo para a pendente: ela fica como está.
      if (pendente && juntos.length === pendente.items.length) continue;
      if (pendente) await tx.execute(sql`update liame.brand_dossier_suggestion set status = 'substituida', updated_at = now() where id = ${pendente.id}`);
      await tx.execute(sql`
        insert into liame.brand_dossier_suggestion (id, tenant_id, brand_id, section, source, items, based_on_version, status)
        values (${uuidv7()}, ${p.tenantId}, ${p.brandId}, ${secao}, 'pesquisador', ${JSON.stringify(juntos)}::jsonb, ${g.base}, 'pendente')`);
    }
    await tx.execute(sql`
      update liame.research_request
         set status = 'concluida', reason = null, result = ${JSON.stringify({ rotulos: g.rotulos, descartes: g.descartes })}::jsonb,
             sections = ${sql`array[${sql.join(secoes.map((s) => sql`${s}`), sql`, `)}]::text[]`}, usage_id = ${g.usageId},
             next_attempt_at = null, finished_at = ${g.agora.toISOString()}::timestamptz, updated_at = now()
       where id = ${p.id}`);
    await writeAudit(tx, {
      tenantId: p.tenantId,
      actorType: 'agent',
      actorId: null,
      actorLabel: 'Pesquisador',
      action: 'pesquisa.concluir',
      resourceType: 'research_request',
      resourceId: p.id,
      after: {
        kind: p.kind,
        host: g.host,
        sections: secoes.join(','),
        produtos: g.rotulos.produtos.length,
        ofertas: g.rotulos.ofertas.length,
        diferenciais: g.rotulos.diferenciais.length,
        descartados: Object.values(g.descartes).reduce((n, x) => n + x, 0),
      },
      traceId: activeTraceId(),
      origin: 'worker',
      agent: PESQUISADOR.key,
    });
    return secoes;
  }

  /** O robots.txt do site deixa o `Liame` ler este caminho? 4xx = sem arquivo = pode; 5xx ou fora do ar = não sabe. */
  private async robotsPermite(url: URL, agora: number): Promise<'sim' | 'nao' | 'fora_do_ar'> {
    const origem = url.origin;
    const guardado = this.robots.get(origem);
    let regras = guardado && guardado.ate > agora ? guardado.regras : null;
    if (!regras) {
      let r: Awaited<ReturnType<typeof safeGet>>;
      try {
        r = await safeGet(`${origem}/robots.txt`, {
          allowPrivateNetwork: this.config.pesquisaAllowPrivateNetwork,
          timeoutMs: 10_000,
          maxBytes: ROBOTS_MAXIMO,
          maxRedirects: 5,
          userAgent: USER_AGENT,
          accept: 'text/plain',
        });
      } catch {
        return 'fora_do_ar';
      }
      if (r.status >= 500) return 'fora_do_ar';
      regras = r.status >= 200 && r.status < 300 ? regrasDoRobots(decodificarCorpo(r.body, r.contentType)) : [];
      if (this.robots.size >= ROBOTS_GUARDADOS) this.robots.clear();
      this.robots.set(origem, { regras, ate: agora + ROBOTS_VALE_MS });
    }
    return podeLer(regras, `${url.pathname}${url.search}`) ? 'sim' : 'nao';
  }
}
