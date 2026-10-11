import type { Database, Tx } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { baseDoPedidoDoCrm, conferirPedidoDoCrm, contextoDoCrm, mensagemDoCrm, type PedidoDoCrm } from '../ai/crm/contexto.js';
import { type BaseDaMensagem, caracteres, mensagemDaResposta, RespostaDoCrm } from '../ai/crm/mensagem.js';
import { CRM, PROMPT_CRM_MENSAGEM, TAREFA_CRM_MENSAGEM, WORKFLOW_DO_CRM } from '../ai/crm/prompt.js';
import { AiError, AiGateway } from '../ai/gateway.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { registrarRecusa } from '../ai/recusas.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { currentTx } from '../context/request-context.js';
import { marcaDoCriativo } from '../criativo/base.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { FLAG_MENSAGERIA } from '../mensageria/mensageria.service.js';
import { FLAG_DO_ENVIO } from '../mensageria/pedido-de-mensagem.service.js';
import { adiarProposta, barrarProposta, type DonoDaProposta, encerrarProposta, esperarProposta, guardarEscrita, lerProposta } from '../mensageria/proposta-do-crm.js';
import { cupomEmPalavras, itensQueBarraram, MINUTOS_DE_ESPERA_SEM_IA, minutosAteATentativa, prazoDeEscreverAcabou, TENTATIVAS_DA_ESCRITA } from '../mensageria/rotina-do-crm.js';
import { REGRAS_DE_TEXTO_VERSAO } from '../policy/texto.js';
import { ResultsService } from '../results/results.service.js';
import { FLAG_DO_CRM } from './rotina-do-crm.service.js';

// A rotina do funcionário de CRM e mensageria, segundo passo: escrever a mensagem de uma proposta aberta (A5, Y6;
// `plano-a5.md` D-A5-14 e critério A5-11; protótipo P16). Fica na pasta do worker: quem chama é o laço. Ele recebe a
// oferta de Minha marca, o público só com o nome, a regra e a contagem, e o cupom em palavras; escreve o nome da
// mensagem e o corpo do modelo; e o código confere item por item antes de qualquer pessoa ver. O texto que passa fica
// guardado na proposta; o que a conferência barra não é guardado, só os nomes do que barrou. Nada vai para o RegemCast
// aqui, e nenhuma mensagem sai.
//
// Três tempos, para não segurar uma transação enquanto o modelo responde:
// 1. banco (transação curta da empresa): a proposta, as chaves, o funcionário, o dossiê e a conferência do pedido;
// 2. o modelo, pelo gateway (sem transação): o gateway confere a flag `ia`, a rota, o teto e limpa o dado pessoal;
// 3. banco (transação da empresa): o texto guardado, ou a proposta barrada, com a auditoria.

const ROTULO_DO_CRM = 'CRM e mensageria';
const MINUTO_MS = 60_000;

/** As chaves da função, e o que a escrita diz quando uma está desligada. A `ia` quem confere é o gateway. */
const CHAVES: ReadonlyArray<readonly [string, string]> = [
  [FLAG_DO_CRM, 'crm_desligado'],
  [FLAG_MENSAGERIA, 'mensageria_desligada'],
  [FLAG_DO_ENVIO, 'envio_desligado'],
];

/** O código do motivo como a coluna guarda (`sem-rota` vira `sem_rota`). */
const codigo = (motivo: string) => motivo.replace(/[^a-z_]/g, '_').slice(0, 40);

/**
 * O que a vez fez com a proposta. `escrita`: o texto passou (ou passou com aviso) e está guardado. `barrada`: a
 * conferência não deixou passar. `descartada`: não vai virar mensagem (ele recusou, o pedido não pode ir, o prazo
 * acabou). `falhou`: não deu texto desta vez; `deVez` diz se as tentativas acabaram. `esperando`: não é a vez dela
 * agora (a IA desligada ou no teto, ele desligado), sem contar tentativa. `fora`: não está mais esperando a escrita.
 */
export type Escrita =
  | { status: 'escrita'; situacao: 'passou' | 'aviso' }
  | { status: 'barrada'; itens: string[] }
  | { status: 'descartada'; motivo: string }
  | { status: 'falhou'; motivo: string; deVez: boolean }
  | { status: 'esperando'; motivo: string }
  | { status: 'fora' };

type Lido = { brandId: string; pedido: PedidoDoCrm; base: BaseDaMensagem };

@Injectable()
export class EscritaDoCrmService {
  private readonly logger = new Logger('escrita-do-crm');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly gateway: AiGateway,
    private readonly resultados: ResultsService,
  ) {}

  /** Escreve a mensagem de uma proposta em `preparando`. O relógio injetado vale para a operação inteira (V34). */
  async escrever(alvo: DonoDaProposta, agora = new Date()): Promise<Escrita> {
    const database = this.banco();
    const quem = { tenantId: alvo.tenantId, userId: null };

    // ---- 1. O banco: a proposta e tudo de que o pedido parte.
    const lido = await naTransacaoDaEmpresa<Lido | Escrita>(database, quem, () => this.ler(alvo, agora));
    if ('status' in lido) return lido;

    // ---- 2. O funcionário: sem ferramenta; o que vem de fora vai na mensagem, entre marcas.
    let r: Awaited<ReturnType<AiGateway['structured']>>;
    try {
      r = await this.gateway.structured({
        tenantId: alvo.tenantId,
        brandId: lido.brandId,
        // Ninguém pediu esta mensagem agora: é rotina do sistema, e não entra no limite por pessoa.
        userId: null,
        workflow: WORKFLOW_DO_CRM,
        task: TAREFA_CRM_MENSAGEM,
        promptVersion: `${PROMPT_CRM_MENSAGEM.key}@${PROMPT_CRM_MENSAGEM.version}`,
        instructions: PROMPT_CRM_MENSAGEM.content,
        context: contextoDoCrm(lido.pedido),
        messages: [{ role: 'user', content: mensagemDoCrm(lido.pedido) }],
        schema: RespostaDoCrm,
      });
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      if (err.code === 'entrada-grande') return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'grande_demais'));
      if (err.code === 'indisponivel') return this.falhou(alvo, 'ia_fora_do_ar', agora);
      // A IA desligada, parada, sem rota ou no teto: não é falha da proposta. Ela espera, sem contar tentativa.
      const ate = err.detalhe.voltaEm ?? new Date(agora.getTime() + MINUTOS_DE_ESPERA_SEM_IA * MINUTO_MS);
      const semIa = `ia_${codigo(err.code)}`;
      return this.naEmpresa(alvo, (tx) => this.esperar(tx, alvo, semIa, ate));
    }
    const resposta = RespostaDoCrm.safeParse(r.object);
    if (!resposta.success) return this.falhou(alvo, 'formato', agora);

    const { recusa, mensagem, descarte } = mensagemDaResposta(resposta.data, lido.base);
    if (recusa) {
      this.logger.warn(`proposta ${alvo.id}: o funcionário recusou (${recusa}); uso ${r.usageId}`);
      return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, recusa, r.usageId));
    }
    // O texto que nem chegou à conferência (vazio, longo demais, com dado pessoal): conta em Sua equipe, sem o texto,
    // e a proposta tenta de novo. O nome de uma letra só não cabe na fila: é texto vazio.
    if (!mensagem || caracteres(mensagem.nome) < 2) {
      const motivo = descarte ?? 'vazia';
      const doCompliance = motivo === 'dado_pessoal';
      await registrarRecusa(database, {
        tenantId: alvo.tenantId,
        brandId: lido.brandId,
        userId: null,
        usageId: r.usageId,
        member: CRM.key,
        workflow: WORKFLOW_DO_CRM,
        kind: doCompliance ? 'compliance' : motivo,
        rules: doCompliance ? ['dado_pessoal'] : [],
        rulesVersion: doCompliance ? REGRAS_DE_TEXTO_VERSAO : null,
      });
      return this.falhou(alvo, motivo, agora);
    }

    // ---- 3. O banco: o texto conferido fica guardado, ou a proposta acaba barrada.
    const { conferencia } = mensagem;
    return naTransacaoDaEmpresa<Escrita>(database, quem, async () => {
      const tx = currentTx();
      if (conferencia.situacao === 'barrou') {
        const itens = itensQueBarraram(conferencia);
        if (!(await barrarProposta(tx, alvo, itens))) return { status: 'fora' };
        // Na trilha, os nomes dos itens e dos achados; nunca o trecho nem o texto barrado.
        const achados = [...new Set(conferencia.itens.flatMap((i) => (i.situacao === 'barrou' ? i.achados.map((a) => a.tipo) : [])))];
        await this.auditar(tx, alvo, 'mensagem.barrar', { barred_by: itens, findings: achados, usage_id: r.usageId });
        return { status: 'barrada', itens };
      }
      if (!(await guardarEscrita(tx, alvo, { nome: mensagem.nome, corpo: mensagem.corpo, usoDeIa: r.usageId }))) return { status: 'fora' };
      // Só números: o texto fica na proposta, não na trilha.
      await this.auditar(tx, alvo, 'mensagem.escrever', { review: conferencia.situacao, characters: conferencia.caracteres, cites_value: conferencia.cita_valor, usage_id: r.usageId });
      return { status: 'escrita', situacao: conferencia.situacao };
    });
  }

  /**
   * Uma tentativa que não deu texto: conta, e a proposta tenta de novo mais tarde (15, 30 minutos…); na última, fecha
   * como `falhou`, com a auditoria. É também por onde o laço registra a falha fora do previsto.
   */
  async falhou(alvo: DonoDaProposta, motivo: string, agora = new Date()): Promise<Escrita> {
    return this.naEmpresa(alvo, async (tx) => {
      const p = await lerProposta(tx, alvo);
      if (!p || p.status !== 'preparando' || p.body !== null) return { status: 'fora' };
      if (p.attempts + 1 >= TENTATIVAS_DA_ESCRITA) {
        if (!(await encerrarProposta(tx, alvo, 'falhou', codigo(motivo)))) return { status: 'fora' };
        await this.auditar(tx, alvo, 'mensagem.falhar', { reason: codigo(motivo), attempts: p.attempts + 1 });
        return { status: 'falhou', motivo: codigo(motivo), deVez: true };
      }
      const ate = new Date(agora.getTime() + minutosAteATentativa(p.attempts) * MINUTO_MS);
      if (!(await adiarProposta(tx, alvo, ate))) return { status: 'fora' };
      return { status: 'falhou', motivo: codigo(motivo), deVez: false };
    });
  }

  /** O primeiro tempo. Devolve o que a vez já decidiu (e gravou), ou o pedido que vai ao funcionário. */
  private async ler(alvo: DonoDaProposta, agora: Date): Promise<Lido | Escrita> {
    const tx = currentTx();
    const p = await lerProposta(tx, alvo);
    if (!p || p.status !== 'preparando' || p.body !== null) return { status: 'fora' };
    // O prazo vem antes de tudo: a proposta que ficou esperando (a função desligada no meio) não volta dias depois.
    if (prazoDeEscreverAcabou(new Date(p.created_at), agora)) return this.descartar(tx, alvo, 'prazo_de_escrever');
    const marcaViva = await tx.execute(sql`select 1 from liame.brand where id = ${p.brand_id} and tenant_id = ${alvo.tenantId} and archived_at is null`);
    if (!marcaViva.rows[0]) return this.descartar(tx, alvo, 'marca_arquivada');

    const emUmaHora = new Date(agora.getTime() + MINUTOS_DE_ESPERA_SEM_IA * MINUTO_MS);
    const contexto = this.flags.context({ tenantId: alvo.tenantId, brandId: p.brand_id });
    for (const [flag, motivo] of CHAVES) if (!(await this.flags.isEnabled(flag, contexto))) return this.esperar(tx, alvo, motivo, emUmaHora);
    if (!(await funcionarioAtivo(tx, { tenantId: alvo.tenantId, brandId: p.brand_id, agentKey: CRM.key, ativoPorPadrao: CRM.ativoPorPadrao }))) return this.esperar(tx, alvo, 'funcionario_desligado', emUmaHora);

    // A mensagem sempre leva cupom: é por ele que o resultado é medido no caixa (D-A5-16).
    if (!p.coupon) return this.descartar(tx, alvo, 'sem_cupom');
    // O dossiê da versão em que a oferta foi escolhida; no "volte a pedir", sem oferta, o de agora.
    const marca = await marcaDoCriativo(p.brand_id, await this.resultados.fusoDaMarca(p.brand_id), agora, p.dossier_version ?? undefined);
    if (!marca) return this.descartar(tx, alvo, 'sem_dossie');
    const pedido: PedidoDoCrm = {
      marca: marca.nome,
      motivo: p.motive,
      comoPedir: p.destination,
      dossie: marca.dossie,
      oferta: p.offer,
      publico: { nome: p.audience_name, regra: p.audience_rule, pessoas: p.people },
      cupom: cupomEmPalavras(p.coupon),
    };
    // As regras de agora valem de novo: o pedido que elas não deixam ir fecha com o motivo, sem chamar o modelo.
    const problema = conferirPedidoDoCrm(pedido)[0];
    if (problema) return this.descartar(tx, alvo, problema.motivo);
    return { brandId: p.brand_id, pedido, base: baseDoPedidoDoCrm(pedido, marca) };
  }

  /** A proposta não vai virar mensagem: fecha como descartada, com o porquê em código e a auditoria. */
  private async descartar(tx: Tx, alvo: DonoDaProposta, motivo: string, usageId: string | null = null): Promise<Escrita> {
    if (!(await encerrarProposta(tx, alvo, 'descartada', codigo(motivo)))) return { status: 'fora' };
    await this.auditar(tx, alvo, 'mensagem.descartar', { reason: codigo(motivo), usage_id: usageId });
    return { status: 'descartada', motivo: codigo(motivo) };
  }

  /** Não é a vez dela agora: olha de novo depois, sem contar tentativa. */
  private async esperar(tx: Tx, alvo: DonoDaProposta, motivo: string, ate: Date): Promise<Escrita> {
    if (!(await esperarProposta(tx, alvo, ate))) return { status: 'fora' };
    return { status: 'esperando', motivo };
  }

  private auditar(tx: Tx, alvo: DonoDaProposta, acao: string, depois: Record<string, unknown>): Promise<string> {
    return writeAudit(tx, {
      tenantId: alvo.tenantId,
      actorType: 'agent',
      actorId: null,
      actorLabel: ROTULO_DO_CRM,
      action: acao,
      resourceType: 'message_proposal',
      resourceId: alvo.id,
      after: { ...depois, agent_key: CRM.key },
      traceId: activeTraceId(),
      origin: 'worker',
      agent: CRM.key,
    });
  }

  private naEmpresa(alvo: DonoDaProposta, fn: (tx: Tx) => Promise<Escrita>): Promise<Escrita> {
    return naTransacaoDaEmpresa<Escrita>(this.banco(), { tenantId: alvo.tenantId, userId: null }, () => fn(currentTx()));
  }

  private banco(): Database {
    if (!this.database) throw new Error('escrita do CRM: sem banco');
    return this.database;
  }
}
