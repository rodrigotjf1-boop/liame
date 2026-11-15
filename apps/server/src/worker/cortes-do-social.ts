import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { AiError, AiGateway } from '../ai/gateway.js';
import { problemaDasImagens } from '../ai/imagens.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { registrarRecusa } from '../ai/recusas.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import {
  contextoDosCortes,
  type CorteConferido,
  cortesDaResposta,
  type DuracaoDosCortes,
  mensagemDosCortes,
  type PedidoDeCortes,
  PROMPT_SOCIAL_CORTES,
  RespostaDosCortes,
  TAREFA_SOCIAL_CORTES,
  type VideoParaOsCortes,
  WORKFLOW_DO_SOCIAL_CORTES,
} from '../ai/social/cortes.js';
import { SOCIAL } from '../ai/social/prompt.js';
import { currentTx } from '../context/request-context.js';
import { marcaDoCriativo } from '../criativo/base.js';
import { DATABASE } from '../database/database.module.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens, chaveDoQuadroDosCortes, QUADROS_DOS_CORTES_MAXIMOS } from '../imagens/armazem.js';
import { REGRAS_DE_TEXTO_VERSAO } from '../policy/texto.js';
import { naOrdemDaFila, vezNaFila } from './ordem-da-fila.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// Os melhores momentos (A6 · Z16, parte 3; P46; D-A6-150 a D-A6-154): a leitura dos quadros pelo Social media. A tabela
// `video_cut_request` é a fila, uma só para todas as marcas (por isso aqui, no escopo do sistema). O serviço de montagem
// (`liame-render`) tira os quadros dos vídeos, grava cada JPEG no armazém e marca `quadros_prontos`; aqui o worker pega os
// pedidos (`for update skip locked`, contando a tentativa), lê os quadros, confere o Social media e a IA, manda os quadros
// ao modelo (a tarefa `social_cortes`), passa a proposta pela régua (`cortesDaResposta`) e grava `pronta` ou `falhou` com
// o motivo. Os quadros saem do armazém no fim da vez, deu ou não deu: só ficam enquanto o pedido espera o Social media.
// A limpeza solta o pedido parado em `lendo` e dá por perdido o que esperou mais de uma hora, levando os quadros junto.

/** A leitura que ficou `lendo` sem terminar por este tempo foi abandonada (o worker caiu no meio). */
export const CORTES_PARADOS_MIN = 10;
/** Quantas vezes o worker pega um pedido antes de desistir. */
export const TENTATIVAS_DOS_CORTES = 3;
/** O pedido que espera os quadros (ou o Social media) há mais que isto não vai mais aparecer para a pessoa. */
export const PEDIDO_DOS_CORTES_ESQUECIDO_MIN = 60;

type Pedido = {
  id: string;
  tenant_id: string;
  brand_id: string;
  media_ids: string[];
  duration_s: number;
  frames: number | null;
  frame_index: unknown;
  attempts: number;
  created_by: string | null;
  /** A marca desta vez (o texto exato de `started_at`): só ela termina o pedido. */
  inicio: string;
  /** A vez na fila (o `created_at` como texto que se ordena), para tratar o lote na ordem da reserva (ERR-135). */
  vez: string;
};

/** Como terminou a vez: a proposta gravada, a falha com o motivo, de volta à fila ou devolvido (outro já cuida dele). */
export type VezDosCortes = { id: string; situacao: 'pronta' | 'falhou' | 'de_novo' | 'devolvido'; motivo: string | null };

type Alvo = { id: string; tenant_id: string; brand_id: string };

function mensagem(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Um item do `frame_index` como o serviço de montagem grava: o vídeo (a posição em `media_ids`) e o tempo; nulo fora disso. */
function itemDoIndice(x: unknown, videos: number): { video: number; tempoMs: number } | null {
  if (!x || typeof x !== 'object') return null;
  const { video, tempo_ms } = x as { video?: unknown; tempo_ms?: unknown };
  if (typeof video !== 'number' || !Number.isInteger(video) || video < 0 || video >= videos) return null;
  if (typeof tempo_ms !== 'number' || !Number.isFinite(tempo_ms) || tempo_ms < 0) return null;
  return { video, tempoMs: Math.round(tempo_ms) };
}

@Injectable()
export class CortesDoSocialLoop {
  private readonly logger = new Logger('cortes-do-social');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(ARMAZEM_DE_IMAGENS) private readonly armazem: ArmazemDeImagens,
    private readonly gateway: AiGateway,
  ) {}

  private banco(): Database {
    if (!this.database) throw new Error('sem banco: o worker precisa do DATABASE_URL');
    return this.database;
  }

  private db() {
    return this.banco().db;
  }

  /** Todas as chaves possíveis dos quadros do pedido (a que não existe não é erro ao apagar). */
  private chaves(p: Alvo): string[] {
    return Array.from({ length: QUADROS_DOS_CORTES_MAXIMOS }, (_, n) => chaveDoQuadroDosCortes(p.tenant_id, p.brand_id, p.id, n));
  }

  /** Os quadros saem do armazém; a falha só fica no log (o pedido já terminou) e devolve `false`. */
  private async apagarQuadros(p: Alvo): Promise<boolean> {
    try {
      await this.armazem.apagar(this.chaves(p));
      return true;
    } catch (err) {
      this.logger.warn(`pedido ${p.id}: os quadros não saíram do armazenamento (${mensagem(err)})`);
      return false;
    }
  }

  /** Dá por perdido o pedido escolhido pela consulta: os quadros saem primeiro; só então ele vira `falhou` (`parado`). */
  private async darPorPerdido(candidatos: Alvo[], condicao: SQL): Promise<string[]> {
    const perdidos: string[] = [];
    for (const p of candidatos) {
      // Sem apagar os quadros, o pedido fica como está e volta na limpeza seguinte (nada fica no armazém para trás).
      if (!(await this.apagarQuadros(p))) continue;
      const r = await withSystem(this.db(), (tx) =>
        tx.execute<{ id: string }>(sql`
          update liame.video_cut_request set status = 'falhou', error = 'parado', started_at = null, updated_at = now()
           where id = ${p.id} and ${condicao}
          returning id`),
      );
      if (r.rows[0]) perdidos.push(p.id);
    }
    return perdidos;
  }

  /**
   * As leituras paradas no meio (`lendo` há mais de 10 minutos): voltam a `quadros_prontos` (os quadros seguem no armazém)
   * até a terceira tentativa; na terceira, `falhou` com o motivo `parado`, e os quadros saem. Devolve os ids mexidos.
   */
  async soltarParados(scope: JobScope = {}, agora: Date = new Date()): Promise<string[]> {
    const limite = sql`${new Date(agora.getTime() - CORTES_PARADOS_MIN * 60_000).toISOString()}::timestamptz`;
    const parado = sql`status = 'lendo' and started_at < ${limite}`;
    const voltaram = await withSystem(this.db(), (tx) =>
      tx.execute<{ id: string }>(sql`
        update liame.video_cut_request set status = 'quadros_prontos', started_at = null, updated_at = now()
         where ${parado} and attempts < ${TENTATIVAS_DOS_CORTES} ${tenantFilter(scope, sql`tenant_id`)}
        returning id`),
    );
    for (const l of voltaram.rows) this.logger.warn(`pedido ${l.id}: a leitura dos cortes parou no meio (sem terminar em ${CORTES_PARADOS_MIN} minutos); volta à fila`);
    const desistir = await withSystem(this.db(), (tx) =>
      tx.execute<Alvo>(sql`
        select id, tenant_id, brand_id from liame.video_cut_request
         where ${parado} and attempts >= ${TENTATIVAS_DOS_CORTES} ${tenantFilter(scope, sql`tenant_id`)}
         order by created_at, id limit 50`),
    );
    const perdidos = await this.darPorPerdido(desistir.rows, sql`${parado} and attempts >= ${TENTATIVAS_DOS_CORTES}`);
    for (const id of perdidos) this.logger.warn(`pedido ${id}: a leitura dos cortes parou ${TENTATIVAS_DOS_CORTES} vezes; falhou`);
    return [...voltaram.rows.map((l) => l.id), ...perdidos];
  }

  /**
   * A limpeza: o pedido que espera os quadros (`pedido`) ou o Social media (`quadros_prontos`) há mais de uma hora vira
   * `falhou` com o motivo `parado`, e os quadros dele saem do armazém (os que o serviço de montagem chegou a gravar).
   */
  async limpar(scope: JobScope = {}, agora: Date = new Date()): Promise<string[]> {
    const limite = sql`${new Date(agora.getTime() - PEDIDO_DOS_CORTES_ESQUECIDO_MIN * 60_000).toISOString()}::timestamptz`;
    const esquecido = sql`status in ('pedido', 'quadros_prontos') and created_at < ${limite}`;
    const r = await withSystem(this.db(), (tx) =>
      tx.execute<Alvo>(sql`
        select id, tenant_id, brand_id from liame.video_cut_request
         where ${esquecido} ${tenantFilter(scope, sql`tenant_id`)}
         order by created_at, id limit 50`),
    );
    const perdidos = await this.darPorPerdido(r.rows, esquecido);
    for (const id of perdidos) this.logger.warn(`pedido ${id}: os cortes esperaram mais de ${PEDIDO_DOS_CORTES_ESQUECIDO_MIN} minutos; falhou`);
    return perdidos;
  }

  /** A limpeza inteira, para o laço do worker: os parados e os esquecidos. */
  async limparLote(scope: JobScope = {}, agora: Date = new Date()): Promise<number> {
    if (!this.database || !this.armazem.disponivel) return 0;
    return (await this.soltarParados(scope, agora)).length + (await this.limpar(scope, agora)).length;
  }

  /** Pega até `limite` pedidos com os quadros prontos, de todas as marcas, conta a tentativa e os marca `lendo`. */
  private async pegar(limite: number, scope: JobScope): Promise<Pedido[]> {
    const r = await withSystem(this.db(), (tx) =>
      tx.execute<Pedido>(sql`
        with proximos as materialized (
          select id from liame.video_cut_request
           where status = 'quadros_prontos' ${tenantFilter(scope, sql`tenant_id`)}
           order by created_at, id
           limit ${limite}
           for update skip locked)
        update liame.video_cut_request v
           set status = 'lendo', attempts = least(v.attempts + 1, 10), started_at = clock_timestamp(), updated_at = now()
          from proximos where v.id = proximos.id
        returning v.id, v.tenant_id, v.brand_id, v.media_ids, v.duration_s, v.frames, v.frame_index, v.attempts, v.created_by,
                  v.started_at::text as inicio, ${vezNaFila(sql`v.created_at`)} as vez`),
    );
    return naOrdemDaFila(r.rows);
  }

  /** Grava o fim desta vez (`pronta` com a proposta, ou `falhou` com o motivo); `false` se a vez já não é desta leitura. */
  private async terminar(p: Pedido, fim: { status: 'pronta'; proposta: { cortes: CorteConferido[]; totalMs: number } } | { status: 'falhou'; motivo: string }): Promise<VezDosCortes> {
    const proposta = fim.status === 'pronta' ? JSON.stringify(fim.proposta) : null;
    const motivo = fim.status === 'falhou' ? fim.motivo : null;
    const r = await withSystem(this.db(), (tx) =>
      tx.execute<{ id: string }>(sql`
        update liame.video_cut_request
           set status = ${fim.status}, proposal = ${proposta}::jsonb, error = ${motivo}, updated_at = now()
         where id = ${p.id} and status = 'lendo' and started_at = ${p.inicio}::timestamptz
        returning id`),
    );
    if (!r.rows[0]) return { id: p.id, situacao: 'devolvido', motivo: null };
    return { id: p.id, situacao: fim.status, motivo };
  }

  /** Falha fora do previsto (banco, armazém): volta à fila até a terceira tentativa; na terceira, `falhou` (`indisponivel`). */
  private async deNovoOuDesiste(p: Pedido): Promise<VezDosCortes> {
    if (p.attempts >= TENTATIVAS_DOS_CORTES) return this.terminar(p, { status: 'falhou', motivo: 'indisponivel' });
    const r = await withSystem(this.db(), (tx) =>
      tx.execute<{ id: string }>(sql`
        update liame.video_cut_request set status = 'quadros_prontos', started_at = null, updated_at = now()
         where id = ${p.id} and status = 'lendo' and started_at = ${p.inicio}::timestamptz
        returning id`),
    );
    return { id: p.id, situacao: r.rows[0] ? 'de_novo' : 'devolvido', motivo: null };
  }

  /** Os quadros do armazém, pelo `frame_index`, agrupados por vídeo e na ordem do tempo. O que não lê, ou não é JPEG válido, fica de fora. */
  private async quadros(p: Pedido): Promise<Array<Array<{ tempoMs: number; jpeg: Uint8Array }>>> {
    const porVideo = p.media_ids.map(() => [] as Array<{ tempoMs: number; jpeg: Uint8Array }>);
    const indice = Array.isArray(p.frame_index) ? p.frame_index : [];
    const total = Math.min(p.frames ?? 0, indice.length, QUADROS_DOS_CORTES_MAXIMOS);
    for (let n = 0; n < total; n++) {
      const item = itemDoIndice(indice[n], p.media_ids.length);
      if (!item) continue;
      let jpeg: Buffer;
      try {
        jpeg = await this.armazem.ler(chaveDoQuadroDosCortes(p.tenant_id, p.brand_id, p.id, n));
      } catch (err) {
        this.logger.warn(`pedido ${p.id}: o quadro ${n} não veio do armazenamento (${mensagem(err)})`);
        continue;
      }
      // Um quadro fora do desenho (não JPEG, grande demais) faria o gateway recusar o pedido inteiro: fica de fora.
      const problema = problemaDasImagens(TAREFA_SOCIAL_CORTES, [{ jpeg }]);
      if (problema) {
        this.logger.warn(`pedido ${p.id}: o quadro ${n} ficou de fora (${problema})`);
        continue;
      }
      porVideo[item.video]!.push({ tempoMs: item.tempoMs, jpeg });
    }
    for (const q of porVideo) q.sort((a, b) => a.tempoMs - b.tempoMs);
    return porVideo;
  }

  /** A leitura do pedido pelo Social media. Toda saída prevista termina o pedido (`pronta` ou `falhou`). */
  private async ler(p: Pedido): Promise<VezDosCortes> {
    const falhou = (motivo: string) => this.terminar(p, { status: 'falhou', motivo });
    const porVideo = await this.quadros(p);
    if (!porVideo.some((q) => q.length)) return falhou('sem_quadros');

    // A leitura da marca numa transação curta da empresa; o modelo, depois, sem transação aberta.
    const lido = await naTransacaoDaEmpresa(this.banco(), { tenantId: p.tenant_id, userId: null }, async () => {
      const tx = currentTx();
      const ativo = await funcionarioAtivo(tx, { tenantId: p.tenant_id, brandId: p.brand_id, agentKey: SOCIAL.key, ativoPorPadrao: SOCIAL.ativoPorPadrao });
      const fuso = (await tx.execute<{ timezone: string | null }>(sql`select timezone from liame.organization where id = ${p.tenant_id}`)).rows[0]?.timezone ?? 'America/Sao_Paulo';
      const nome = (await tx.execute<{ name: string }>(sql`select name from liame.brand where id = ${p.brand_id}`)).rows[0]?.name ?? null;
      const videos = (
        await tx.execute<{ id: string; duration_ms: number | null; product: string | null; description: string | null }>(sql`
          select id, duration_ms, product, description from liame.brand_photo
           where id in ${p.media_ids} and tenant_id = ${p.tenant_id} and brand_id = ${p.brand_id}`)
      ).rows;
      return { ativo, nome, videos, marca: nome === null ? null : await marcaDoCriativo(p.brand_id, fuso, new Date()) };
    });
    if (!lido.ativo) return falhou('funcionario_desligado');
    if (!(await this.gateway.ligada({ tenantId: p.tenant_id, userId: p.created_by, brandId: p.brand_id }))) return falhou('ia_desligada');

    // Cada vídeo com a duração de Fotos; o vídeo que saiu de Fotos de vez (sem a linha) leva os quadros dele junto.
    const porId = new Map(lido.videos.map((v) => [v.id, v]));
    const videos: VideoParaOsCortes[] = [];
    for (const [i, id] of p.media_ids.entries()) {
      const v = porId.get(id);
      if (!v?.duration_ms) return falhou('sem_quadros');
      videos.push({ duracaoMs: v.duration_ms, produto: v.product, descricao: v.description || null, quadros: porVideo[i]! });
    }
    const nome = lido.nome ?? 'a marca';
    const marca = lido.marca;
    const pedido: PedidoDeCortes = {
      marca: nome,
      dossie: marca?.dossie ?? `Marca "${nome}": Minha marca ainda não foi preenchida.`,
      duracaoS: p.duration_s as DuracaoDosCortes,
      ofertas: marca?.conteudo.offers.items ?? [],
      videos,
    };

    let r: Awaited<ReturnType<AiGateway['structured']>>;
    try {
      r = await this.gateway.structured({
        tenantId: p.tenant_id,
        brandId: p.brand_id,
        // Quem pediu: o uso conta para ela, como na rota (o limite da pessoa vale aqui também).
        userId: p.created_by,
        workflow: WORKFLOW_DO_SOCIAL_CORTES,
        task: TAREFA_SOCIAL_CORTES,
        promptVersion: `${PROMPT_SOCIAL_CORTES.key}@${PROMPT_SOCIAL_CORTES.version}`,
        instructions: PROMPT_SOCIAL_CORTES.content,
        context: contextoDosCortes(pedido),
        messages: [{ role: 'user', content: mensagemDosCortes(pedido) }],
        schema: RespostaDosCortes,
      });
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      return falhou(err.code === 'desligada' ? 'ia_desligada' : err.code);
    }

    // A proposta recusada conta em Sua equipe, sem o texto (como os textos do vídeo).
    const recusar = async (kind: string, rules: string[], motivo: string): Promise<VezDosCortes> => {
      await registrarRecusa(this.banco(), {
        tenantId: p.tenant_id,
        brandId: p.brand_id,
        userId: null,
        usageId: r.usageId,
        member: SOCIAL.key,
        workflow: WORKFLOW_DO_SOCIAL_CORTES,
        kind,
        rules,
        rulesVersion: kind === 'compliance' ? REGRAS_DE_TEXTO_VERSAO : null,
      });
      return falhou(motivo);
    };
    const resposta = RespostaDosCortes.safeParse(r.object);
    if (!resposta.success) return recusar('formato', [], 'formato');
    const c = cortesDaResposta(resposta.data, pedido, { fatos: marca?.fatos ?? '', proibidas: marca?.proibidas ?? [], concorrentes: marca?.concorrentes ?? [] });
    if (!c.ok) {
      const doCompliance = c.motivo === 'compliance' || c.motivo === 'dado_pessoal';
      return recusar(doCompliance ? 'compliance' : c.motivo, c.motivo === 'dado_pessoal' ? ['dado_pessoal'] : c.achados.map((a) => a.tipo), c.motivo);
    }
    return this.terminar(p, { status: 'pronta', proposta: { cortes: c.cortes, totalMs: c.totalMs } });
  }

  /** Uma vez de um pedido. Os quadros saem do armazém no fim, a não ser que o pedido tenha voltado à fila (outra vez vai lê-los). */
  private async vez(p: Pedido): Promise<VezDosCortes> {
    let fim: VezDosCortes = { id: p.id, situacao: 'devolvido', motivo: null };
    try {
      fim = await this.ler(p);
      return fim;
    } catch (err) {
      // A causa no log (V6); a tela mostra só a situação.
      this.logger.error(`pedido ${p.id}: a leitura dos cortes falhou na tentativa ${p.attempts} (${mensagem(err)})`);
      fim = await this.deNovoOuDesiste(p).catch((e: unknown) => {
        this.logger.error(`pedido ${p.id}: não deu para marcar a falha da leitura (${mensagem(e)})`);
        return { id: p.id, situacao: 'devolvido' as const, motivo: null };
      });
      return fim;
    } finally {
      if (fim.situacao === 'pronta' || fim.situacao === 'falhou') await this.apagarQuadros(p);
    }
  }

  /** Um lote: pega até `limite` pedidos com os quadros prontos e lê um por um. */
  async executarLote(limite = 3, scope: JobScope = {}): Promise<VezDosCortes[]> {
    // Sem o armazenamento, nada sai da fila (os quadros moram nele).
    if (!this.database || !this.armazem.disponivel) return [];
    const pedidos = await this.pegar(limite, scope);
    const vezes: VezDosCortes[] = [];
    for (const p of pedidos) vezes.push(await this.vez(p));
    return vezes;
  }
}
