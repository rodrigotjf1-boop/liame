import { type Database, uuidv7 } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { baseDoPedido, conferirPedido, contextoDaPeca, mensagemDaPeca, type PedidoDePeca, referenciaSegura } from '../ai/criativo/contexto.js';
import { type DescartesDasPecas, type DestinoDaPeca, type PecaConferida, pecasDaResposta, RespostaDoCriativo, type TextoDaPeca } from '../ai/criativo/peca.js';
import { CRIATIVO, PROMPT_CRIATIVO_TEXTO, TAREFA_CRIATIVO_TEXTO } from '../ai/criativo/prompt.js';
import { AiError, type AiErrorCode, AiGateway } from '../ai/gateway.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { registrarRecusa } from '../ai/recusas.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { currentTx } from '../context/request-context.js';
import { hashDaPeca, regrasDaConferencia, revisaoDaConferencia } from '../criativo/apresentacao.js';
import { type MarcaDoCriativo, marcaDoCriativo } from '../criativo/base.js';
import { DATABASE } from '../database/database.module.js';
import { REGRAS_DE_TEXTO_VERSAO } from '../policy/texto.js';
import { ResultsService } from '../results/results.service.js';

// A geração das peças de um pedido pelo Criativo (A4, X6). Fica na pasta do worker porque é rotina da fila, sem pessoa
// na sessão:
//   1. confere, como a empresa, que o pedido segue na fila, a marca existe e o Criativo está ativo; lê o dossiê da
//      versão do pedido (a oferta é a que a pessoa viu) e confere o pedido de novo, pelas regras de agora; no "pedir
//      outra", lê a versão atual da peça, que precisa estar esperando decisão;
//   2. chama o Criativo (sem ferramenta nenhuma; a oferta, a versão anterior, a referência e a instrução vão na
//      mensagem, entre marcas);
//   3. confere cada peça, item por item, e grava as que servem, cada uma com a conferência dela: peças novas no pedido
//      de peças, ou a versão seguinte da mesma peça no "pedir outra". A peça barrada é gravada e aparece com o motivo;
//      a vazia, a longa demais, a com dado pessoal e a repetida nem são gravadas.
// Nada vai para a Meta: a peça espera a decisão de uma pessoa.

export const WORKFLOW_DO_CRIATIVO = 'criativo.peca';

/** O pedido que a fila reservou. */
export interface PedidoNaFila {
  id: string;
  tenantId: string;
  brandId: string;
  offer: string;
  dossierVersion: number;
  destination: DestinoDaPeca;
  variations: number;
  instruction: string | null;
  referenceName: string | null;
  /** "Pedir outra": a peça que o pedido refaz; nulo no pedido de peças novas. */
  pieceId: string | null;
  requestedBy: string | null;
}

export type ResultadoDaGeracao =
  | { status: 'concluido'; pecas: number }
  /** O Criativo não escreve sobre aquilo, o pedido não passa mais nas regras, nenhuma peça serviu ou a peça a refazer já foi decidida: tentar de novo não muda nada. */
  | { status: 'recusado'; motivo: string; usageId?: string }
  /** O modelo fora do ar, ou a resposta fora do formato: tenta de novo mais tarde. */
  | { status: 'falhou'; motivo: string }
  /** A IA não pôde ser chamada (desligada, sem rota, teto): o pedido fecha com o motivo, e a pessoa pede de novo quando der. */
  | { status: 'sem_ia'; motivo: AiErrorCode | 'funcionario_desligado'; voltaEm?: Date }
  /** O pedido não está mais na fila (a marca foi arquivada, outro worker terminou). */
  | { status: 'descartado'; motivo: string };

type Lido =
  | { descartado: string }
  | { descartado?: undefined; ativo: boolean; marca: MarcaDoCriativo | null; /** No "pedir outra": a versão atual da peça, ou `decidida` quando ela já não espera decisão. */ anterior: TextoDaPeca | 'decidida' | null };

/** O que a gravação fez: quantas peças (ou a versão nova) entraram, ou por que o pedido fecha sem nenhuma. */
type Gravado = { pecas: number } | { fechar: 'sem_peca' | 'peca_decidida' } | null;

@Injectable()
export class CriativoService {
  private readonly logger = new Logger('criativo');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly gateway: AiGateway,
    private readonly resultados: ResultsService,
  ) {}

  /** Gera as peças do pedido. O relógio injetado vale para a operação inteira (V34). */
  async gerar(p: PedidoNaFila, agora = new Date()): Promise<ResultadoDaGeracao> {
    if (!this.database) throw new Error('criativo: sem banco');
    const quem = { tenantId: p.tenantId, userId: null };

    // ---- 1. o pedido, a marca, o Criativo, o dossiê da versão do pedido e a peça a refazer, como a empresa
    const lido = await naTransacaoDaEmpresa<Lido>(this.database, quem, async () => {
      const tx = currentTx();
      const marca = (await tx.execute(sql`select 1 from liame.brand where id = ${p.brandId} and archived_at is null`)).rows[0];
      if (!marca) return { descartado: 'a marca foi arquivada' };
      const pedido = (await tx.execute<{ status: string }>(sql`select status from liame.ad_piece_request where id = ${p.id}`)).rows[0];
      if (pedido?.status !== 'gerando') return { descartado: 'o pedido não está mais na fila' };
      let anterior: TextoDaPeca | 'decidida' | null = null;
      if (p.pieceId) {
        const peca = (
          await tx.execute<{ status: string; title: string; body: string }>(sql`
            select x.status, v.title, v.body
              from liame.ad_piece x join liame.ad_piece_version v on v.piece_id = x.id and v.version = x.version
             where x.id = ${p.pieceId}`)
        ).rows[0];
        anterior = peca?.status === 'decidir' ? { titulo: peca.title, texto: peca.body } : 'decidida';
      }
      return {
        ativo: await funcionarioAtivo(tx, { tenantId: p.tenantId, brandId: p.brandId, agentKey: CRIATIVO.key, ativoPorPadrao: CRIATIVO.ativoPorPadrao }),
        marca: await marcaDoCriativo(p.brandId, await this.resultados.fusoDaMarca(p.brandId), agora, p.dossierVersion),
        anterior,
      };
    });
    if (lido.descartado !== undefined) return { status: 'descartado', motivo: lido.descartado };
    if (lido.anterior === 'decidida') return { status: 'recusado', motivo: 'peca_decidida' };
    if (!lido.ativo) return { status: 'sem_ia', motivo: 'funcionario_desligado' };
    if (!lido.marca) return { status: 'recusado', motivo: 'sem_dossie' };
    const { marca, anterior } = lido;
    // As regras de agora valem de novo: o pedido que elas não deixam mais ir fecha com o motivo, sem chamar o modelo.
    const problema = conferirPedido({ oferta: p.offer, instrucao: p.instruction, variacoes: p.variations }, marca)[0];
    if (problema) return { status: 'recusado', motivo: problema.motivo };

    const pedido: PedidoDePeca = {
      marca: marca.nome,
      destino: p.destination,
      variacoes: p.variations,
      dossie: marca.dossie,
      oferta: p.offer,
      referencia: referenciaSegura(p.referenceName ? { anuncio: p.referenceName, titulo: null, texto: null } : null),
      instrucao: p.instruction,
      anterior,
    };

    // ---- 2. o Criativo: sem ferramenta; o que vem de fora vai na mensagem, entre marcas
    let r: Awaited<ReturnType<AiGateway['structured']>>;
    try {
      r = await this.gateway.structured({
        tenantId: p.tenantId,
        brandId: p.brandId,
        userId: p.requestedBy,
        workflow: WORKFLOW_DO_CRIATIVO,
        task: TAREFA_CRIATIVO_TEXTO,
        promptVersion: `${PROMPT_CRIATIVO_TEXTO.key}@${PROMPT_CRIATIVO_TEXTO.version}`,
        instructions: PROMPT_CRIATIVO_TEXTO.content,
        context: contextoDaPeca(pedido),
        messages: [{ role: 'user', content: mensagemDaPeca(pedido) }],
        schema: RespostaDoCriativo,
      });
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      if (err.code === 'entrada-grande') return { status: 'recusado', motivo: 'grande_demais' };
      if (err.code === 'indisponivel') return { status: 'falhou', motivo: 'ia_fora_do_ar' };
      return { status: 'sem_ia', motivo: err.code, voltaEm: err.detalhe.voltaEm };
    }
    const resposta = RespostaDoCriativo.safeParse(r.object);
    if (!resposta.success) return { status: 'falhou', motivo: 'formato' };

    // ---- 3. a conferência de cada peça e a gravação
    const { recusa, pecas, descartes } = pecasDaResposta(resposta.data, baseDoPedido({ oferta: p.offer, instrucao: p.instruction }, marca), p.variations, anterior);
    if (recusa) {
      this.logger.warn(`pedido ${p.id}: o Criativo recusou (${recusa}); uso ${r.usageId}`);
      return { status: 'recusado', motivo: recusa, usageId: r.usageId };
    }
    // As peças que nem aparecem entram na contagem de Sua equipe, sem o texto (D-A3-15): uma linha por motivo. A que
    // veio a mais não é recusa: é sobra.
    for (const [motivo, n] of Object.entries(descartes)) {
      if (!n || motivo === 'a_mais' || motivo === 'com_recusa') continue;
      const doCompliance = motivo === 'dado_pessoal';
      await registrarRecusa(this.database, {
        tenantId: p.tenantId,
        brandId: p.brandId,
        userId: p.requestedBy,
        usageId: r.usageId,
        member: CRIATIVO.key,
        workflow: WORKFLOW_DO_CRIATIVO,
        kind: doCompliance ? 'compliance' : motivo,
        rules: doCompliance ? ['dado_pessoal'] : [],
        rulesVersion: doCompliance ? REGRAS_DE_TEXTO_VERSAO : null,
        items: n,
      });
    }
    const gravado = await naTransacaoDaEmpresa(this.database, quem, () => this.gravar(p, { pecas, descartes, usageId: r.usageId, agora }));
    if (gravado === null) return { status: 'descartado', motivo: 'o pedido não está mais na fila' };
    return 'fechar' in gravado ? { status: 'recusado', motivo: gravado.fechar, usageId: r.usageId } : { status: 'concluido', pecas: gravado.pecas };
  }

  /**
   * Grava o que o Criativo fez e fecha o pedido, com a auditoria do agente: no pedido de peças, cada peça com a versão 1
   * e a conferência dela; no "pedir outra", a versão seguinte da mesma peça (travada: se alguém a decidiu no meio, nada
   * entra). Sem peça que sirva, não fecha nada (quem chama fecha como recusado). Nulo quando o pedido já não estava
   * sendo feito.
   */
  private async gravar(p: PedidoNaFila, g: { pecas: PecaConferida[]; descartes: DescartesDasPecas; usageId: string; agora: Date }): Promise<Gravado> {
    const tx = currentTx();
    const pedido = (await tx.execute<{ status: string }>(sql`select status from liame.ad_piece_request where id = ${p.id} for update`)).rows[0];
    if (pedido?.status !== 'gerando') return null;
    if (!g.pecas.length) return { fechar: 'sem_peca' };
    const regras = JSON.stringify(regrasDaConferencia());
    const versao = (peca: PecaConferida, pieceId: string, numero: number) =>
      tx.execute(sql`
        insert into liame.ad_piece_version (id, tenant_id, piece_id, version, title, body, button, review, review_status, rules_version, content_hash, author, request_id, usage_id)
        values (${uuidv7()}, ${p.tenantId}, ${pieceId}, ${numero}, ${peca.titulo}, ${peca.texto}, ${peca.botao}, ${JSON.stringify(revisaoDaConferencia(peca.conferencia))}::jsonb,
                ${peca.conferencia.situacao}, ${regras}::jsonb, ${hashDaPeca(peca)}, 'criativo', ${p.id}, ${g.usageId})`);
    let gravadas = g.pecas;
    if (p.pieceId) {
      const peca = (await tx.execute<{ status: string; version: number }>(sql`select status, version from liame.ad_piece where id = ${p.pieceId} for update`)).rows[0];
      if (peca?.status !== 'decidir') return { fechar: 'peca_decidida' };
      const nova = g.pecas[0]!;
      gravadas = [nova];
      await versao(nova, p.pieceId, peca.version + 1);
      await tx.execute(sql`update liame.ad_piece set version = ${peca.version + 1}, review_status = ${nova.conferencia.situacao}, updated_at = now() where id = ${p.pieceId}`);
    } else {
      for (const peca of g.pecas) {
        const id = uuidv7();
        await tx.execute(sql`
          insert into liame.ad_piece (id, tenant_id, brand_id, request_id, status, version, review_status)
          values (${id}, ${p.tenantId}, ${p.brandId}, ${p.id}, 'decidir', 1, ${peca.conferencia.situacao})`);
        await versao(peca, id, 1);
      }
    }
    await tx.execute(sql`
      update liame.ad_piece_request
         set status = 'concluido', reason = null, pieces = ${gravadas.length}, discards = ${JSON.stringify(g.descartes)}::jsonb, usage_id = ${g.usageId},
             next_attempt_at = null, finished_at = ${g.agora.toISOString()}::timestamptz, updated_at = now()
       where id = ${p.id}`);
    await writeAudit(tx, {
      tenantId: p.tenantId,
      actorType: 'agent',
      actorId: null,
      actorLabel: 'Criativo',
      action: p.pieceId ? 'peca.refazer' : 'peca.gerar',
      resourceType: 'ad_piece_request',
      resourceId: p.id,
      after: {
        pedidas: p.variations,
        pecas: gravadas.length,
        barradas: gravadas.filter((x) => x.conferencia.situacao === 'barrou').length,
        com_aviso: gravadas.filter((x) => x.conferencia.situacao === 'aviso').length,
        descartadas: Object.values(g.descartes).reduce((n, x) => n + x, 0),
        ...(p.pieceId ? { piece_id: p.pieceId } : {}),
      },
      traceId: activeTraceId(),
      origin: 'worker',
      agent: CRIATIVO.key,
    });
    return { pecas: gravadas.length };
  }
}
