import type { ActionOpenRequest, ActionOptionsQuery, ActionOptionsResponse, ActionStatus, ActionTargetsResponse, AdObject } from '@liame/contracts';
import type { Database, Tx } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { type AuthContext, currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { KillSwitchService } from '../kill-switch/kill-switch.service.js';
import { situacaoDaLeitura, verbaDaLeitura } from './conferencia-do-gasto.js';
import { CONNECTORS, type Connector, type PreparedRead, type ReadResult } from './connectors.js';
import { PLATAFORMA, problemaDaLeitura, recursoNaoEncontrado } from './leitura-na-plataforma.js';
import { TOOLS } from './tools.js';

// O pedido de mudança (A4, X8; D-A4-20): o que a tela precisa saber ANTES de a pessoa pedir.
//
// - `alvos`: em quais campanhas de uma marca dá para pedir (as das contas com a escrita ligada), com os pedidos em
//   aberto de cada uma. É o que faz o botão "Pedir mudança" aparecer em Resultados.
// - `daCampanha`: as opções do pedido numa campanha. O objeto escolhido é lido NA PLATAFORMA na hora, para o pedido
//   partir do que está valendo, e não da leitura da manhã. A parte do banco roda numa transação curta; a chamada à
//   plataforma vem depois, sem transação aberta (a rota é `@SemTransacao`).
//
// Nada aqui cria pedido nem muda coisa alguma: quem decide se o pedido entra é `POST /v1/actions`, com a política, os
// limites da empresa e a leitura dele. As recusas que dá para antecipar (escrita desligada, trava, conexão que só lê)
// saem com as mesmas palavras do pedido.

const ABERTOS: ActionStatus[] = ['aguardando_aprovacao', 'aprovada', 'executando'];
/** Os provedores em que o Liame muda anúncios: os conectores de plataforma (os que leem o objeto na hora). */
const PROVEDORES_COM_PEDIDO = Object.values(CONNECTORS)
  .filter((c) => c.requiresSpendLimits && c.prepareRead)
  .map((c) => c.provider);

type TipoDeObjeto = 'campanha' | 'conjunto' | 'anuncio';
const ehTipo = (v: unknown): v is TipoDeObjeto => v === 'campanha' || v === 'conjunto' || v === 'anuncio';

/**
 * As ferramentas que a tela oferece num objeto de anúncio como ele está agora, na ordem dela (protótipo P9): mudar a
 * verba (só onde ela mora) e pausar, ou retomar o que está em pausa. O que foi arquivado ou removido na plataforma não
 * muda mais. Tudo o que sai daqui a ferramenta aceita planejar (`tools.ts`); em pausa, a tela só oferece retomar,
 * embora a ferramenta de verba também aceitasse: muda-se a verba depois, com o objeto rodando.
 */
export function ferramentasPara(provider: string, estado: { tipo: TipoDeObjeto; status: string; daily_budget_micros: number | null }): string[] {
  const cabe = (nome: string) => TOOLS[nome]?.providers.includes(provider) === true;
  if (estado.status === 'pausado') return [`${estado.tipo}_retomar`].filter(cabe);
  if (estado.status !== 'ativo') return [];
  const verba = estado.tipo !== 'anuncio' && estado.daily_budget_micros !== null ? ['orcamento_ajustar'] : [];
  return [...verba, `${estado.tipo}_pausar`].filter(cabe);
}

/** A conexão com a plataforma só deixa ler: a autorização desta conta não pediu para gerenciar anúncios. */
function conexaoSoLeitura(provider: string): AppProblem {
  const quem = (PLATAFORMA[provider] ?? 'A plataforma').replace(/^[AO] /, (artigo) => artigo.toLowerCase());
  return new AppProblem(
    409,
    'conexao-so-leitura',
    'Conecte a plataforma de novo',
    `A conexão com ${quem} ainda não deixa o Liame mudar anúncios: hoje ela só deixa ler. Conecte de novo em Contas conectadas: a plataforma vai pedir a permissão de gerenciar anúncios, e as contas que já estão ligadas continuam as mesmas.`,
  );
}

type LinhaAberta = { id: string; tool: string; action: string; resource_id: string; status: ActionStatus; value_micros: string | null; created_at: Date | string; campaign_id?: string | null };

const aberto = (l: LinhaAberta): ActionOpenRequest => ({
  id: l.id,
  tool: l.tool,
  action: l.action,
  resource_id: l.resource_id,
  status: l.status,
  value_micros: l.value_micros === null ? null : Number(l.value_micros),
  created_at: new Date(l.created_at).toISOString(),
});

type LinhaDeObjeto = { external_id: string; name: string; status: string; verba: string | null; visto: Date | string | null; conjunto?: string | null };

const objeto = (tipo: TipoDeObjeto, l: LinhaDeObjeto): AdObject => {
  const verba = tipo === 'anuncio' ? null : verbaDaLeitura(l.verba);
  return { resource_id: `${tipo}:${l.external_id}`, kind: tipo, name: l.name, status: situacaoDaLeitura(l.status), daily_micros: verba === null ? null : Number(verba) };
};

/** O que a parte do banco deixa pronto para a leitura na plataforma. */
type Preparado = {
  conector: Connector;
  preparada: PreparedRead;
  resposta: Omit<ActionOptionsResponse, 'target' | 'read_at' | 'tools'>;
};

function quemPede(auth: AuthContext): { tenantId: string; userId: string } {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return { tenantId: auth.tenantId, userId: auth.userId };
}

@Injectable()
export class OpcoesDoPedidoService {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly switches: KillSwitchService,
  ) {}

  /** Onde dá para pedir uma mudança numa marca. Roda na transação da rota. */
  async alvos(auth: AuthContext, brandId: string): Promise<ActionTargetsResponse> {
    const quem = quemPede(auth);
    if (!PROVEDORES_COM_PEDIDO.length) return { campaigns: [] };
    const tx = currentTx();
    const contas = await tx.execute<{ id: string; provider: string; requested_access: string | null }>(sql`
      select a.id, a.provider, o.requested_access
        from liame.connected_account a left join liame.oauth_connection o on o.id = a.connection_id
       where a.tenant_id = ${quem.tenantId} and a.brand_id = ${brandId} and a.disconnected_at is null and a.provider in ${PROVEDORES_COM_PEDIDO}`);
    // A flag de escrita é conferida conta a conta, como no pedido (ela pode valer só para uma conta).
    const ligadas = new Map<string, 'ligada' | 'so_leitura'>();
    for (const c of contas.rows) {
      const flag = CONNECTORS[c.provider]?.writeFlag;
      const on = !flag || (await this.flags.isEnabled(flag, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId, accountId: c.id })));
      // Só a plataforma que pede uma autorização própria para mudar (a Meta) pode estar "só leitura".
      if (on) ligadas.set(c.id, !CONNECTORS[c.provider]?.needsWriteAuthorization || c.requested_access === 'escrita' ? 'ligada' : 'so_leitura');
    }
    if (!ligadas.size) return { campaigns: [] };

    const ids = [...ligadas.keys()];
    const campanhas = await tx.execute<{ id: string; connected_account_id: string }>(sql`
      select c.id, c.connected_account_id from liame.campaign c
       where c.tenant_id = ${quem.tenantId} and c.connected_account_id in ${ids} and c.status in ('ativa', 'pausada')
       order by c.name, c.id`);
    const abertos = await this.abertos(tx, quem.tenantId, sql`r.account_id in ${ids}`);
    const porCampanha = new Map<string, ActionOpenRequest[]>();
    for (const l of abertos) if (l.campaign_id) porCampanha.set(l.campaign_id, [...(porCampanha.get(l.campaign_id) ?? []), aberto(l)]);
    return { campaigns: campanhas.rows.map((c) => ({ campaign_id: c.id, write: ligadas.get(c.connected_account_id)!, open: porCampanha.get(c.id) ?? [] })) };
  }

  /**
   * Os pedidos em aberto nas contas dadas, cada um com a campanha do objeto dele (a própria, a do conjunto ou a do
   * conjunto do anúncio), do mais novo para o mais antigo. O pedido de um objeto que saiu da lista fica sem campanha.
   */
  private async abertos(tx: Tx, tenantId: string, onde: SQL): Promise<LinhaAberta[]> {
    const r = await tx.execute<LinhaAberta>(sql`
      select r.id, r.tool, r.action, r.resource_id, r.status, r.value_micros::text as value_micros, r.created_at,
             coalesce(c.id, g.campaign_id, ga.campaign_id) as campaign_id
        from liame.action_request r
        left join liame.campaign c on split_part(r.resource_id, ':', 1) = 'campanha' and c.tenant_id = r.tenant_id
                                  and c.connected_account_id::text = r.account_id and c.external_id = split_part(r.resource_id, ':', 2)
        left join liame.ad_group g on split_part(r.resource_id, ':', 1) = 'conjunto' and g.tenant_id = r.tenant_id
                                  and g.connected_account_id::text = r.account_id and g.external_id = split_part(r.resource_id, ':', 2)
        left join liame.ad d on split_part(r.resource_id, ':', 1) = 'anuncio' and d.tenant_id = r.tenant_id
                            and d.connected_account_id::text = r.account_id and d.external_id = split_part(r.resource_id, ':', 2)
        left join liame.ad_group ga on ga.id = d.ad_group_id
       where r.tenant_id = ${tenantId} and r.status in ${ABERTOS} and ${onde}
       order by r.created_at desc, r.id desc
       limit 500`);
    return r.rows;
  }

  /**
   * As opções do pedido numa campanha. Fora da transação da requisição: o banco numa transação curta (com a empresa e
   * a pessoa no contexto da RLS), a plataforma depois.
   */
  async daCampanha(auth: AuthContext, q: ActionOptionsQuery): Promise<ActionOptionsResponse> {
    const quem = quemPede(auth);
    if (!this.database) throw new Error('opções do pedido: sem banco');
    const pronto = await naTransacaoDaEmpresa(this.database, quem, () => this.preparar(quem, q));
    let lido: ReadResult | null;
    try {
      lido = await pronto.conector.readPrepared!(pronto.preparada);
    } catch (err) {
      throw problemaDaLeitura(pronto.conector.provider, err) ?? err;
    }
    if (!lido) throw recursoNaoEncontrado();
    const s = lido.state;
    if (!ehTipo(s.tipo) || typeof s.id !== 'string') throw new Error('opções do pedido: o conector devolveu um estado sem tipo');
    const verba = typeof s.daily_budget_micros === 'number' && s.daily_budget_micros > 0 ? s.daily_budget_micros : null;
    const status = typeof s.status === 'string' ? s.status : 'desconhecido';
    return {
      ...pronto.resposta,
      target: {
        resource_id: `${s.tipo}:${s.id}`,
        kind: s.tipo,
        name: typeof s.nome === 'string' && s.nome ? s.nome : pronto.resposta.campaign.name,
        status,
        effective_status: typeof s.status_efetivo === 'string' ? s.status_efetivo : null,
        daily_micros: verba,
      },
      read_at: new Date().toISOString(),
      tools: ferramentasPara(pronto.conector.provider, { tipo: s.tipo, status, daily_budget_micros: verba }),
    };
  }

  /** A parte do banco: a campanha, o que dá para antecipar de recusa, as listas, os pedidos em aberto e a leitura preparada. */
  private async preparar(quem: { tenantId: string; userId: string }, q: ActionOptionsQuery): Promise<Preparado> {
    const tx = currentTx();
    const c = await tx.execute<{
      id: string;
      name: string;
      external_id: string;
      provider: string;
      visto: Date | string | null;
      conta: string;
      conta_nome: string;
      brand_id: string;
      requested_access: string | null;
    }>(sql`
      select c.id, c.name, c.external_id, c.provider, c.last_seen_at as visto, a.id as conta, a.name as conta_nome, a.brand_id, o.requested_access
        from liame.campaign c
        join liame.connected_account a on a.id = c.connected_account_id and a.disconnected_at is null
        left join liame.oauth_connection o on o.id = a.connection_id
       where c.id = ${q.campaign_id} and c.tenant_id = ${quem.tenantId}`);
    const campanha = c.rows[0];
    if (!campanha) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Campanha não encontrada nesta empresa.');

    const conector = CONNECTORS[campanha.provider];
    if (!conector?.prepareRead || !conector.readPrepared) {
      throw new AppProblem(422, 'plataforma-so-leitura', 'O Liame só lê esta plataforma', 'O Liame ainda não faz mudanças nas campanhas desta plataforma: por enquanto ele só lê os números dela.');
    }
    // As mesmas barreiras do pedido, na mesma ordem: a trava, a flag de escrita e, antes de gastar a leitura, a conexão.
    const trava = await this.switches.check(tx, { tenantId: quem.tenantId, provider: campanha.provider, brandId: campanha.brand_id, accountId: campanha.conta });
    if (trava) throw new AppProblem(423, 'parada-acionada', 'Execução parada', `Há uma trava ativa (nível ${trava.level}): ${trava.reason}`);
    if (conector.writeFlag) {
      const on = await this.flags.isEnabled(conector.writeFlag, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId: campanha.brand_id, accountId: campanha.conta }));
      if (!on) throw new AppProblem(403, 'escrita-desligada', 'Escrita desligada', `A escrita em ${conector.provider} não está liberada para esta conta.`);
    }
    if (conector.needsWriteAuthorization && campanha.requested_access !== 'escrita') throw conexaoSoLeitura(campanha.provider);

    // Os conjuntos e os anúncios da campanha, pela leitura diária (o que saiu da lista da conta não aparece).
    const conjuntos = await tx.execute<LinhaDeObjeto>(sql`
      select g.external_id, g.name, g.status, g.daily_budget_micros::text as verba, g.last_seen_at as visto
        from liame.ad_group g
       where g.tenant_id = ${quem.tenantId} and g.connected_account_id = ${campanha.conta} and g.campaign_id = ${campanha.id} and g.status in ('ativa', 'pausada')
       order by g.name, g.external_id limit 200`);
    const anuncios = await tx.execute<LinhaDeObjeto>(sql`
      select d.external_id, d.name, d.status, null::text as verba, d.last_seen_at as visto, g.external_id as conjunto
        from liame.ad d join liame.ad_group g on g.id = d.ad_group_id
       where d.tenant_id = ${quem.tenantId} and d.connected_account_id = ${campanha.conta} and g.campaign_id = ${campanha.id} and d.status in ('ativa', 'pausada')
       order by d.name, d.external_id limit 500`);

    const daCampanha = `campanha:${campanha.external_id}`;
    const adSets = conjuntos.rows.map((l) => objeto('conjunto', l));
    const ads = anuncios.rows.map((l) => ({ ...objeto('anuncio', l), ad_set: l.conjunto ? `conjunto:${l.conjunto}` : null }));
    const conhecidos = new Set([daCampanha, ...adSets.map((o) => o.resource_id), ...ads.map((o) => o.resource_id)]);
    const alvo = q.target ?? daCampanha;
    if (!conhecidos.has(alvo)) throw new AppProblem(422, 'alvo-nao-e-da-campanha', 'O objeto não é desta campanha', 'O conjunto ou o anúncio escolhido não está na lista desta campanha.');

    const abertos = (await this.abertos(tx, quem.tenantId, sql`r.account_id = ${campanha.conta} and r.resource_id in ${[...conhecidos]}`)).map(aberto);
    const vistos = [campanha.visto, ...conjuntos.rows.map((l) => l.visto), ...anuncios.rows.map((l) => l.visto)].flatMap((v) => (v ? [new Date(v).getTime()] : []));

    let preparada: PreparedRead | null;
    try {
      preparada = await conector.prepareRead(tx, { tenantId: quem.tenantId, accountId: campanha.conta, resourceId: alvo });
    } catch (err) {
      // Sem a autorização guardada, a conta não lê: é o mesmo "conecte de novo" do pedido.
      throw problemaDaLeitura(conector.provider, err) ?? err;
    }
    if (!preparada) throw recursoNaoEncontrado();
    return {
      conector,
      preparada,
      resposta: {
        campaign: { id: campanha.id, name: campanha.name, provider: campanha.provider, brand_id: campanha.brand_id, account_id: campanha.conta, account_name: campanha.conta_nome },
        ad_sets: adSets,
        ads,
        // A leitura mais antiga entre os objetos da lista: é até onde a lista inteira vale.
        listed_at: vistos.length ? new Date(Math.min(...vistos)).toISOString() : null,
        open: abertos,
      },
    };
  }
}
