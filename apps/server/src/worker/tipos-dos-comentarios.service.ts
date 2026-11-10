import type { Database, Tx } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { recursoDoComentario } from '../actions/comentario-na-rede.js';
import { AiError, AiGateway } from '../ai/gateway.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { contextoDoTipo, mensagemDoTipo, type PedidoDeTipoDoComentario, RespostaDoTipo, type TipoDaIa, tipoDaResposta } from '../ai/social/comentario-tipo.js';
import { PROMPT_SOCIAL_COMENTARIO_TIPO, SOCIAL, TAREFA_SOCIAL_COMENTARIO_TIPO, WORKFLOW_DO_SOCIAL_COMENTARIO_TIPO } from '../ai/social/prompt.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { codigoDoMotivo, esperaDaIa, minutosAteATentativa } from '../avaliacoes/sugestoes.js';
import { abrirVezDosPedidos, DIAS_DOS_PEDIDOS, type DonoDaVez, MINUTOS_DE_ESPERA_DOS_PEDIDOS, oQueDesligaOsPedidos, PEDIDO_EM_ANDAMENTO } from '../comentarios/pedidos.js';
import {
  adiarVezDoTipo,
  encerrarVezDoTipo,
  esperarVezDoTipo,
  gravarTipoNoComentario,
  lerVezDoTipo,
  marcaDoTexto,
  marcarTipo,
  TENTATIVAS_DO_TIPO,
} from '../comentarios/tipos.js';
import { contaConectada } from '../connections/conectada.js';
import { PROVEDOR_PAGINA } from '../connectors/meta/publicacao.js';
import { currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';

// A rotina do tipo do comentário pela IA (A6, Z11, parte 2d-4c; D-A6-87 e D-A6-101; migration 0128). Fica na pasta do
// worker: quem chama é o laço. Para o comentário na vez dele, pede o tipo ao Social media (a tarefa
// `social_comentario_tipo`, com o Haiku 5.5, migration 0127), com a rede, a legenda do post e o texto, sem o @ de ninguém
// (Política 7.15). Com um tipo, o comentário o ganha (`kind_source = 'ia'`) e a vez do pedido abre na mesma transação; o
// pedido em Aprovações é a rotina dos pedidos que monta, com a aprovação de uma pessoa, como para o tipo da regra. O
// "nenhum" fica só na vez. Nada sai sozinho daqui.
//
// Três tempos, para não segurar uma transação enquanto o modelo responde (o desenho dos pedidos):
// 1. banco (transação curta da empresa): a vez, o comentário (o mesmo texto julgado, ainda sem tipo), as chaves;
// 2. o modelo, pelo gateway (sem transação): o gateway confere a `ia`, a rota e o teto;
// 3. banco (transação da empresa): o tipo na vez e no comentário, a vez do pedido e a auditoria, juntos.

const MINUTO_MS = 60_000;
const DIA_MS = 24 * 60 * MINUTO_MS;

/** O que a vez fez com o comentário. `pedidos`: quantas vezes de pedido abriram com o tipo (zero no "nenhum"). */
export type VezDoTipo =
  | { status: 'pronta'; tipo: TipoDaIa; pedidos: number }
  | { status: 'descartada'; motivo: string }
  | { status: 'falhou'; motivo: string; deVez: boolean }
  | { status: 'esperando'; motivo: string }
  | { status: 'fora' };

type LinhaDoComentario = {
  brand_id: string;
  provider: string;
  usuario: string | null;
  kind: string | null;
  kind_source: string | null;
  message: string;
  hidden: boolean;
  published_at: Date | string;
  caption: string | null;
  respondido: boolean;
  conectada: boolean;
  marca_viva: boolean;
};

type Lido = { brandId: string; contaId: string; commentId: string; textSha256: string; pedido: PedidoDeTipoDoComentario };

@Injectable()
export class TiposDosComentariosService {
  private readonly logger = new Logger('tipos-dos-comentarios');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly gateway: AiGateway,
  ) {}

  /** Trata o comentário na vez dele. O relógio injetado vale para a operação inteira (V34). */
  async decidir(alvo: DonoDaVez, agora = new Date()): Promise<VezDoTipo> {
    const lido = await naTransacaoDaEmpresa<Lido | VezDoTipo>(this.banco(), { tenantId: alvo.tenantId, userId: null }, () => this.ler(alvo, agora));
    if ('status' in lido) return lido;

    // ---- 2. O Social media: sem ferramenta; o comentário vai na mensagem, entre marcas, sem o @ de ninguém.
    let r: Awaited<ReturnType<AiGateway['structured']>>;
    try {
      r = await this.gateway.structured({
        tenantId: alvo.tenantId,
        brandId: lido.brandId,
        // Ninguém pediu agora: é rotina do sistema, e não entra no limite por pessoa.
        userId: null,
        workflow: WORKFLOW_DO_SOCIAL_COMENTARIO_TIPO,
        task: TAREFA_SOCIAL_COMENTARIO_TIPO,
        promptVersion: `${PROMPT_SOCIAL_COMENTARIO_TIPO.key}@${PROMPT_SOCIAL_COMENTARIO_TIPO.version}`,
        instructions: PROMPT_SOCIAL_COMENTARIO_TIPO.content,
        context: contextoDoTipo(lido.pedido),
        messages: [{ role: 'user', content: mensagemDoTipo(lido.pedido) }],
        schema: RespostaDoTipo,
      });
    } catch (err) {
      if (!(err instanceof AiError)) throw err;
      if (err.code === 'entrada-grande') return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'grande_demais', agora));
      if (err.code === 'indisponivel') return this.falhou(alvo, 'ia_fora_do_ar', agora);
      // A IA desligada, parada, sem a rota do modelo ou no limite: não é falha do comentário. Ele espera, sem contar tentativa.
      const ate = err.detalhe.voltaEm ?? new Date(agora.getTime() + MINUTOS_DE_ESPERA_DOS_PEDIDOS * MINUTO_MS);
      return this.naEmpresa(alvo, (tx) => this.esperar(tx, alvo, esperaDaIa(err.code, err.detalhe.teto), ate, agora));
    }
    const resposta = RespostaDoTipo.safeParse(r.object);
    if (!resposta.success) return this.falhou(alvo, 'formato', agora);
    // A conferência do código por cima: a marcação sem o @ de outra pessoa vira "nenhum", com o porquê.
    const { tipo, descarte } = tipoDaResposta(resposta.data, { texto: lido.pedido.texto, usuarioDaMarca: lido.pedido.usuarioDaMarca });

    // ---- 3. O tipo na vez e no comentário, e a vez do pedido, juntos.
    return this.naEmpresa(alvo, async (tx) => {
      if (!(await marcarTipo(tx, alvo, { tipo, motivo: descarte, usageId: r.usageId }, agora))) return { status: 'fora' };
      let pedidos = 0;
      if (tipo !== 'nenhum') {
        const conta = { tenantId: alvo.tenantId, brandId: lido.brandId, connectedAccountId: lido.contaId };
        const gravou = await gravarTipoNoComentario(tx, { tenantId: alvo.tenantId, connectedAccountId: lido.contaId, commentId: lido.commentId, textSha256: lido.textSha256 }, tipo);
        // O comentário mudou no meio (o texto, ou a regra decidiu): o tipo fica só na vez, e a próxima leitura abre outra.
        if (gravou) pedidos = await abrirVezDosPedidos(tx, conta, agora);
      }
      await this.auditar(tx, alvo, 'comentario.decidir_tipo', { kind: tipo, ...(descarte ? { reason: descarte } : {}), suggestion_turns: pedidos, usage_id: r.usageId });
      return { status: 'pronta', tipo, pedidos };
    });
  }

  /** Uma tentativa que não deu certo: conta, e o comentário tenta de novo mais tarde; na última, fecha como `falhou`. */
  async falhou(alvo: DonoDaVez, motivo: string, agora = new Date()): Promise<VezDoTipo> {
    const codigo = codigoDoMotivo(motivo);
    return this.naEmpresa(alvo, async (tx) => {
      const s = await lerVezDoTipo(tx, alvo);
      if (!s || s.status !== 'esperando') return { status: 'fora' };
      if (s.attempts + 1 >= TENTATIVAS_DO_TIPO) {
        if (!(await encerrarVezDoTipo(tx, alvo, 'falhou', codigo, agora, { contarTentativa: true }))) return { status: 'fora' };
        await this.auditar(tx, alvo, 'comentario.falhar_tipo', { reason: codigo, attempts: s.attempts + 1 });
        return { status: 'falhou', motivo: codigo, deVez: true };
      }
      const ate = new Date(agora.getTime() + minutosAteATentativa(s.attempts) * MINUTO_MS);
      if (!(await adiarVezDoTipo(tx, alvo, codigo, ate, agora))) return { status: 'fora' };
      return { status: 'falhou', motivo: codigo, deVez: false };
    });
  }

  /** O primeiro tempo. Devolve o que a vez já decidiu (e gravou), ou o que o pedido ao modelo precisa. */
  private async ler(alvo: DonoDaVez, agora: Date): Promise<Lido | VezDoTipo> {
    const tx = currentTx();
    const s = await lerVezDoTipo(tx, alvo);
    if (!s || s.status !== 'esperando') return { status: 'fora' };
    const c = (
      await tx.execute<LinhaDoComentario>(sql`
        select c.brand_id, a.provider, a.provider_attributes->>'usuario' as usuario, c.kind, c.kind_source, c.message, c.hidden,
               c.published_at, p.caption,
               exists (select 1 from liame.social_comment r
                        where r.connected_account_id = c.connected_account_id and r.parent_comment_id = c.comment_id and r.by_brand) as respondido,
               coalesce(${contaConectada('a')}, false) as conectada, (b.archived_at is null) as marca_viva
          from liame.social_comment c
          join liame.connected_account a on a.id = c.connected_account_id
          join liame.brand b on b.id = c.brand_id
          left join liame.social_comment_post p on p.connected_account_id = c.connected_account_id and p.post_id = c.post_id
         where c.connected_account_id = ${s.connected_account_id} and c.comment_id = ${s.comment_id} and c.tenant_id = ${alvo.tenantId}`)
    ).rows[0];
    // O comentário sai do Liame com a guarda dele (e a vez sai junto); aqui, só por segurança.
    if (!c) return this.descartar(tx, alvo, 'sumiu', agora);
    // A regra decidiu (o texto mudou para um que ela entende) ou outra volta já pôs o tipo: a IA não é chamada.
    if (c.kind || c.kind_source) return this.descartar(tx, alvo, 'tipo_decidido', agora);
    // O texto mudou desde que a vez abriu: esta vez não serve; a próxima leitura abre a do texto novo.
    if (marcaDoTexto(c.message) !== s.text_sha256) return this.descartar(tx, alvo, 'texto_mudou', agora);
    if (c.hidden) return this.descartar(tx, alvo, 'oculto', agora);
    if (c.respondido) return this.descartar(tx, alvo, 'respondido', agora);
    // A vez que esperou demais (uma chave ficou desligada no meio) não volta semanas depois.
    if (agora.getTime() - new Date(c.published_at).getTime() > DIAS_DOS_PEDIDOS * DIA_MS) return this.descartar(tx, alvo, 'antigo', agora);
    if (!c.marca_viva) return this.descartar(tx, alvo, 'marca_arquivada', agora);
    if (!c.conectada) return this.descartar(tx, alvo, 'conta_desconectada', agora);

    // O tipo só serve ao pedido: com os pedidos desligados nesta conta, a vez espera, sem chamar o modelo.
    const desligado = await oQueDesligaOsPedidos(tx, this.flags, { tenantId: alvo.tenantId, brandId: c.brand_id, connectedAccountId: s.connected_account_id });
    if (desligado) return this.esperar(tx, alvo, desligado, new Date(agora.getTime() + MINUTOS_DE_ESPERA_DOS_PEDIDOS * MINUTO_MS), agora);

    // Uma pessoa já pediu (ou a ação já saiu pelo Liame): o tipo não muda nada.
    const comPedido = (
      await tx.execute<{ tem: boolean }>(sql`
        select exists (
          select 1 from liame.action_request
           where tenant_id = ${alvo.tenantId} and account_id = ${s.connected_account_id}
             and resource_id = ${recursoDoComentario(s.comment_id)} and status in ${[...PEDIDO_EM_ANDAMENTO]}) as tem`)
    ).rows[0];
    if (comPedido?.tem) return this.descartar(tx, alvo, 'ja_tem_pedido', agora);

    const ehPagina = c.provider === PROVEDOR_PAGINA;
    return {
      brandId: c.brand_id,
      contaId: s.connected_account_id,
      commentId: s.comment_id,
      textSha256: s.text_sha256,
      pedido: { rede: ehPagina ? 'facebook' : 'instagram', legenda: c.caption ?? '', texto: c.message, usuarioDaMarca: ehPagina ? null : c.usuario },
    };
  }

  /** O comentário não vai ter tipo pela IA: a vez acaba descartada, com o porquê em código e a auditoria. */
  private async descartar(tx: Tx, alvo: DonoDaVez, motivo: string, agora: Date): Promise<VezDoTipo> {
    if (!(await encerrarVezDoTipo(tx, alvo, 'descartada', motivo, agora))) return { status: 'fora' };
    await this.auditar(tx, alvo, 'comentario.descartar_tipo', { reason: motivo });
    return { status: 'descartada', motivo };
  }

  /** Não é a vez dele agora: olha de novo depois, sem contar tentativa. */
  private async esperar(tx: Tx, alvo: DonoDaVez, motivo: string, ate: Date, agora: Date): Promise<VezDoTipo> {
    if (!(await esperarVezDoTipo(tx, alvo, motivo, ate, agora))) return { status: 'fora' };
    return { status: 'esperando', motivo };
  }

  private auditar(tx: Tx, alvo: DonoDaVez, acao: string, depois: Record<string, unknown>): Promise<string> {
    return writeAudit(tx, {
      tenantId: alvo.tenantId,
      actorType: 'agent',
      actorId: null,
      actorLabel: SOCIAL.name,
      action: acao,
      resourceType: 'comment_kind_check',
      resourceId: alvo.id,
      after: { ...depois, agent_key: SOCIAL.key },
      traceId: activeTraceId(),
      origin: 'worker',
      agent: SOCIAL.key,
    });
  }

  private naEmpresa(alvo: DonoDaVez, fn: (tx: Tx) => Promise<VezDoTipo>): Promise<VezDoTipo> {
    return naTransacaoDaEmpresa<VezDoTipo>(this.banco(), { tenantId: alvo.tenantId, userId: null }, () => fn(currentTx()));
  }

  private banco(): Database {
    if (!this.database) throw new Error('tipo dos comentários: sem banco');
    return this.database;
  }
}
