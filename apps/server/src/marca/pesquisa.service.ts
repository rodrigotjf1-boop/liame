import type { CreateResearchRequest, ResearchListResponse, ResearchResponse } from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { AiGateway } from '../ai/gateway.js';
import { PESQUISADOR } from '../ai/pesquisador/prompt.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { assertSafeUrl, UnsafeUrlError } from '../events/safe-http.js';

// O pedido de leitura de uma página pelo Pesquisador (A3, I12; protótipo P6, aguardando aprovação; sem tela ainda). A
// rota só confere e enfileira: a leitura (robots.txt, página, leitor em quarentena, sugestões) é do worker
// (`worker/pesquisa.service.ts`). Pedir: quem edita o dossiê; ver os pedidos: quem vê o dossiê.

/** Leituras por marca por dia (cada uma vai a um site de fora e chama a IA). */
export const LEITURAS_POR_DIA = 20;

type LinhaPedido = {
  id: string;
  brand_id: string;
  kind: string;
  url: string;
  host: string;
  status: string;
  reason: string | null;
  sections: string[];
  requested_by: string | null;
  requester: string | null;
  created_at: Date | string;
  finished_at: Date | string | null;
};

const iso = (v: Date | string) => new Date(v).toISOString();
const COLUNAS = sql`r.id, r.brand_id, r.kind, r.url, r.host, r.status, r.reason, r.sections, r.requested_by, u.name as requester, r.created_at, r.finished_at`;

export function respostaDoPedido(l: LinhaPedido): ResearchResponse {
  return {
    id: l.id,
    brand_id: l.brand_id,
    kind: l.kind,
    url: l.url,
    host: l.host,
    status: l.status,
    reason: l.reason,
    sections: l.sections ?? [],
    requested_by: l.requested_by ? { id: l.requested_by, name: l.requester ?? 'Pessoa removida' } : null,
    created_at: iso(l.created_at),
    finished_at: l.finished_at ? iso(l.finished_at) : null,
  };
}

/** O motivo da recusa do endereço, em palavras para a tela. */
const MOTIVO_DO_ENDERECO: Record<string, string> = {
  'URL inválida': 'Cole o endereço completo da página, como aparece no navegador.',
  'use uma URL https': 'Use o endereço seguro da página, que começa com https://.',
  'a URL não pode ter usuário e senha': 'O endereço não pode ter usuário e senha.',
  'a URL aponta para a rede interna': 'O endereço não é de uma página pública da internet.',
};

@Injectable()
export class PesquisaService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly gateway: AiGateway,
    private readonly limite: RateLimitService,
  ) {}

  /** Põe a página na fila do Pesquisador. O mesmo endereço já na fila desta marca devolve o pedido que está lá. */
  async pedir(auth: AuthContext, body: CreateResearchRequest): Promise<ResearchResponse> {
    const tenantId = this.empresa(auth);
    const tx = currentTx();
    await this.exigirMarca(body.brand_id);
    let url: URL;
    try {
      url = assertSafeUrl(body.url, this.config.pesquisaAllowPrivateNetwork);
    } catch (err) {
      if (err instanceof UnsafeUrlError) {
        throw new AppProblem(422, 'endereco-recusado', 'Este endereço não pode ser lido', MOTIVO_DO_ENDERECO[err.message] ?? 'Confira o endereço da página.');
      }
      throw err;
    }
    // O pedaço depois do "#" não vai ao site: fica fora do pedido.
    url.hash = '';
    const ligada = await this.gateway.ligada({ tenantId, userId: auth.userId, brandId: body.brand_id });
    const ativo = ligada && (await funcionarioAtivo(tx, { tenantId, brandId: body.brand_id, agentKey: PESQUISADOR.key, ativoPorPadrao: PESQUISADOR.ativoPorPadrao }));
    if (!ativo) {
      throw new AppProblem(409, 'pesquisador-desligado', 'O Pesquisador não está ligado', 'A leitura de páginas depende da IA ligada para a empresa e do Pesquisador ativo.');
    }
    await this.limite.consume(`pesquisa:${body.brand_id}`, LEITURAS_POR_DIA, 86_400);
    const endereco = url.toString();
    const id = uuidv7();
    const novo = await tx.execute<{ id: string }>(sql`
      insert into liame.research_request (id, tenant_id, brand_id, kind, url, host, requested_by)
      values (${id}, ${tenantId}, ${body.brand_id}, ${body.kind}, ${endereco}, ${url.hostname}, ${auth.userId})
      on conflict (brand_id, url) where status in ('pendente', 'lendo') do nothing
      returning id`);
    const alvo =
      novo.rows[0]?.id ??
      (await tx.execute<{ id: string }>(sql`select id from liame.research_request where brand_id = ${body.brand_id} and url = ${endereco} and status in ('pendente', 'lendo')`)).rows[0]!.id;
    // Na auditoria vai o site, não o endereço inteiro (a consulta do endereço pode ter dado de quem copiou).
    auditDetail({ resourceId: alvo, after: { kind: body.kind, host: url.hostname, nova: novo.rows.length > 0 } });
    return this.porId(alvo);
  }

  /** Os pedidos de leitura da marca, os mais novos primeiro (até 50). */
  async lista(auth: AuthContext, brandId: string): Promise<ResearchListResponse> {
    this.empresa(auth);
    await this.exigirMarca(brandId);
    const r = await currentTx().execute<LinhaPedido>(sql`
      select ${COLUNAS} from liame.research_request r left join liame.app_user u on u.id = r.requested_by
       where r.brand_id = ${brandId}
       order by r.created_at desc, r.id desc
       limit 50`);
    return { items: r.rows.map(respostaDoPedido) };
  }

  private async porId(id: string): Promise<ResearchResponse> {
    const r = await currentTx().execute<LinhaPedido>(sql`
      select ${COLUNAS} from liame.research_request r left join liame.app_user u on u.id = r.requested_by where r.id = ${id}`);
    return respostaDoPedido(r.rows[0]!);
  }

  private empresa(auth: AuthContext): string {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa', 'Sem empresa ativa', 'Escolha uma empresa para continuar.');
    return auth.tenantId;
  }

  private async exigirMarca(brandId: string): Promise<void> {
    const r = await currentTx().execute(sql`select 1 from liame.brand where id = ${brandId} and archived_at is null`);
    if (!r.rows.length) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Esta marca não existe nesta empresa.');
  }
}
