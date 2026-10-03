import type { ConversationCouponProposal, CreateRegemCouponRequest } from '@liame/contracts';
import type { Database } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type ProporCupomInput, reaisParaMicros } from '../ai/conversa/cupom.defs.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { type AuthContext, currentTx, requestStore } from '../context/request-context.js';
import { actorLabel } from '../context/unit-of-work.interceptor.js';
import { CouponsService } from '../coupons/coupons.service.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem, ValidationProblem } from '../errors/problems.js';
import { normalizar } from '../policy/texto.js';

// A proposta de cupom que a LIA monta na conversa (A3, I10b). É o MESMO pedido da aba Cupons
// (`CouponsService.createInRegem`: política, flag `regem_write`, permissão da loja, campanha conferida), feito numa
// transação curta da empresa, com a auditoria escrita aqui (a rota a escreveria): ação do agente, a pedido da
// pessoa. Nada é criado no Regem antes da aprovação. Loja e campanha chegam pelo nome; o código acha os ids na
// marca da conversa e, se o nome não bate ou bate com mais de um, diz quais existem.

/** Quantos nomes a mensagem de "não achei" lista, no máximo. */
const NOMES_NA_MENSAGEM = 8;

/** A falha que volta para a LIA (o texto é para a pessoa ler; sem dado interno). */
export class PropostaRecusada extends Error {}

const igual = (a: string, b: string) => normalizar(a).trim() === normalizar(b).trim();
const lista = (nomes: string[]) => nomes.slice(0, NOMES_NA_MENSAGEM).join(', ') + (nomes.length > NOMES_NA_MENSAGEM ? ' e outras' : '');

@Injectable()
export class PropostaDeCupomService {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly cupons: CouponsService,
  ) {}

  /** Monta o pedido e o entrega ao Action Service, em nome da pessoa. Falha de regra vira `PropostaRecusada`. */
  async propor(auth: AuthContext & { tenantId: string }, origem: { brandId: string; conversationId: string }, input: ProporCupomInput): Promise<ConversationCouponProposal> {
    if (!this.database) throw new Error('proposta de cupom: sem banco');
    try {
      return await naTransacaoDaEmpresa(this.database, auth, async () => {
        const loja = await this.loja(origem.brandId, input.loja);
        const campanha = await this.campanha(origem.brandId, input.campanha);
        const body: CreateRegemCouponRequest = {
          unit_id: loja.id,
          code: input.codigo,
          kind: input.tipo,
          ...(input.percentual !== undefined ? { percent: input.percentual } : {}),
          ...(input.valor !== undefined ? { value_micros: this.reais(input.valor, 'valor') } : {}),
          ...(input.pedido_minimo !== undefined ? { min_order_micros: this.reais(input.pedido_minimo, 'pedido mínimo') } : {}),
          valid_from: input.valido_de,
          valid_until: input.valido_ate,
          campaign_id: campanha.id,
          exclusive: input.exclusivo,
        };
        const { request } = await this.cupons.createInRegem(auth, body);
        // A rota gravaria o evento com o que o serviço anotou; aqui, quem pediu foi a LIA, a pedido da pessoa.
        const anotado = requestStore.getStore()?.audit;
        await writeAudit(currentTx(), {
          tenantId: auth.tenantId,
          actorType: 'agent',
          actorId: null,
          actorLabel: `LIA, a pedido de ${actorLabel(auth)}`,
          action: 'cupom.pedir_criacao',
          resourceType: 'action_request',
          resourceId: anotado?.resourceId ?? request.action_id,
          after: { ...(anotado?.after ?? {}), requested_by: auth.userId, conversation_id: origem.conversationId },
          traceId: activeTraceId(),
          origin: 'api',
          agent: 'lia',
        });
        return { request, store_name: loja.name };
      });
    } catch (err) {
      if (err instanceof PropostaRecusada) throw err;
      // O texto do erro de domínio é feito para a pessoa: serve à LIA também.
      if (err instanceof ValidationProblem) throw new PropostaRecusada(err.errors.map((e) => e.message).join(' '));
      if (err instanceof AppProblem) throw new PropostaRecusada(err.detail);
      throw err;
    }
  }

  /** A loja da marca com o Regem conectado, pelo nome da loja (ou da conta do Regem). */
  private async loja(brandId: string, nome: string): Promise<{ id: string; name: string }> {
    const r = await currentTx().execute<{ id: string; name: string; store: string }>(sql`
      select u.id, u.name, a.name as store
        from liame.unit u
        join liame.connected_account a on a.unit_id = u.id and a.brand_id = u.brand_id and a.provider = 'regem' and a.disconnected_at is null
       where u.brand_id = ${brandId}
       order by u.name, u.id`);
    const lojas = [...new Map(r.rows.map((l) => [l.id, l])).values()];
    if (!lojas.length) throw new PropostaRecusada('Nenhuma loja desta marca tem o Regem conectado: conecte o Regem em Contas conectadas.');
    const achadas = lojas.filter((l) => igual(l.name, nome) || igual(l.store, nome));
    if (achadas.length === 1) return { id: achadas[0]!.id, name: achadas[0]!.name };
    if (!achadas.length) throw new PropostaRecusada(`Não achei a loja "${nome}" nesta marca. Lojas com o Regem: ${lista(lojas.map((l) => l.name))}.`);
    throw new PropostaRecusada(`Mais de uma loja se chama "${nome}". Diga qual: ${lista(achadas.map((l) => l.name))}.`);
  }

  /** A campanha da marca pelo nome (as de anúncio ligadas às contas da marca). */
  private async campanha(brandId: string, nome: string): Promise<{ id: string; name: string }> {
    const r = await currentTx().execute<{ id: string; name: string }>(sql`
      select c.id, c.name
        from liame.campaign c join liame.connected_account a on a.id = c.connected_account_id
       where a.brand_id = ${brandId} and c.status not in ('removida', 'arquivada')
       order by c.name, c.id`);
    const achadas = r.rows.filter((c) => igual(c.name, nome));
    if (achadas.length === 1) return achadas[0]!;
    if (!achadas.length) {
      const nomes = r.rows.map((c) => c.name);
      throw new PropostaRecusada(nomes.length ? `Não achei a campanha "${nome}" nesta marca. Campanhas: ${lista(nomes)}.` : 'Esta marca ainda não tem campanha lida das plataformas.');
    }
    throw new PropostaRecusada(`Mais de uma campanha se chama "${nome}" nesta marca: confira na tela Cupons.`);
  }

  private reais(texto: string, campo: string): string {
    const micros = reaisParaMicros(texto);
    if (micros === null) throw new PropostaRecusada(`O ${campo} "${texto}" não é um valor em reais (escreva como R$ 10,00).`);
    return micros;
  }
}
