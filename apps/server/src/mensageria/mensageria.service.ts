import type { MessagingAccount, MessagingCampaign, MessagingCampaignDetailResponse, MessagingCoupon, MessagingResponse } from '@liame/contracts';
import type { Database } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import {
  detalharCampanhaDeMensagens,
  lerCampanhasDeMensagens,
  lerContaDeMensagens,
  lerModelos,
  lerOrcamentoDeMensagens,
  lerPublicos,
} from '../connectors/regemcast/conector-regemcast.js';
import type { CampanhaRegemcast } from '../connectors/regemcast/contrato-regemcast.js';
import { type AuthContext, currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { VaultService } from '../vault/vault.service.js';

// Mensageria pelas rotas (A5, Y4; protótipo P15): o que a tela Mensagens lê. Tudo vem do RegemCast na hora em que a
// pessoa abre a tela, e nada é guardado no Liame: se a conta do WhatsApp pode enviar, o teto de gasto de mensagens,
// quantos modelos aprovados e públicos há (só contagens) e as campanhas com os números. Nenhum telefone e nenhum nome
// de contato chegam aqui: o contrato do conector descarta o que vier a mais (critério A5-9).
//
// As duas rotas falam com o RegemCast e por isso são `@SemTransacao`: o banco numa transação curta da empresa (a
// marca, a flag, as contas e o token no cofre) e o RegemCast depois, sem transação aberta. Nada aqui muda o RegemCast.

export const FLAG_MENSAGERIA = 'mensageria';
/** Há uma pessoa esperando a tela: o RegemCast tem este tempo para responder a cada leitura. */
const TEMPO_DO_REGEMCAST_MS = 15_000;
const ESPERA_PELA_COTA_MS = 2_000;
/** Uma marca tem, na prática, uma conta do RegemCast; o teto evita uma tela que dispare dezenas de leituras. */
const CONTAS_POR_MARCA = 5;
const CAMPANHAS_NA_LISTA = 20;

type Quem = { tenantId: string; userId: string };
type ContaLida = { id: string; brand_id: string; name: string; external_id: string; token: string | null };
type Parte<T> = { status: 'ok'; dado: T } | { status: 'sem_permissao' | 'indisponivel' | 'sem_autorizacao'; dado: null };

const iso = (v: string | null) => (v === null ? null : new Date(v).toISOString());

const contaNaoEncontrada = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Conta do RegemCast não encontrada nesta empresa.');
const desligada = () =>
  new AppProblem(409, 'mensageria-desligada', 'A função não está ligada', 'As mensagens pelo RegemCast ainda não estão ligadas para esta empresa. Quem liga é a Liame, a pedido do dono.');
const semAutorizacao = () =>
  new AppProblem(409, 'regemcast-sem-autorizacao', 'Conecte o RegemCast de novo', 'O RegemCast não aceitou a conexão desta conta (ela foi desligada lá, ou não vale mais). Conecte o RegemCast de novo em Contas conectadas.');
const indisponivel = () =>
  new AppProblem(502, 'plataforma-indisponivel', 'O RegemCast não respondeu', 'Não foi possível ler esta campanha no RegemCast agora. Nada mudou; tente de novo em instantes.');

/** Pedidos e receita são do ciclo fechado: só para quem vê as vendas (ADR-013). */
const veVendas = (auth: AuthContext): boolean => auth.permissions.has('vendas.ver');

function quemPede(auth: AuthContext): Quem {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return { tenantId: auth.tenantId, userId: auth.userId };
}

/** A campanha como a rota a devolve: os mesmos números do RegemCast, com os instantes em UTC. */
export function campanhaDaRota(c: CampanhaRegemcast): MessagingCampaign {
  return {
    id: c.id,
    name: c.nome,
    status: c.situacao,
    pause_reason: c.pausaMotivo,
    template: c.modelo,
    category: c.categoria,
    audience: c.publico,
    recipients: c.destinatarios,
    queued: c.naFila,
    sent: c.enviadas,
    delivered: c.entregues,
    read: c.lidas,
    failed: c.falhas,
    replied: c.responderam,
    created_at: iso(c.criadaEm),
    started_at: iso(c.iniciadaEm),
    finished_at: iso(c.concluidaEm),
  };
}

/**
 * O cupom de uma mensagem como a rota o devolve. O código aparece para quem vê as campanhas; os pedidos e a receita
 * são do ciclo fechado, só para quem vê as vendas (ADR-013). Micros viram centavos sem ponto flutuante (1 centavo são
 * 10.000 micros).
 */
export function cupomDaRota(l: { coupon_code: string; pedidos: number | string; receita_micros: string }, comVendas: boolean): MessagingCoupon {
  return { code: l.coupon_code, orders: comVendas ? Number(l.pedidos) : null, revenue_cents: comVendas ? Number(BigInt(l.receita_micros) / 10_000n) : null };
}

@Injectable()
export class MensageriaService {
  private readonly logger = new Logger('mensageria');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly flags: FlagService,
    private readonly vault: VaultService,
  ) {}

  /**
   * As contas do RegemCast da marca, cada uma com o que o RegemCast responde agora. Uma parte que falha não derruba as
   * outras: cada parte diz como foi a leitura dela. Com a função desligada para a empresa, nada é lido.
   */
  async ver(auth: AuthContext, brandId: string): Promise<MessagingResponse> {
    const quem = quemPede(auth);
    const contas = await naTransacaoDaEmpresa(this.banco(), quem, async () => {
      const marca = await currentTx().execute(sql`select 1 from liame.brand where id = ${brandId} and archived_at is null`);
      if (!marca.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
      if (!(await this.ligada(quem, brandId))) return null;
      return this.contas(sql`a.brand_id = ${brandId}`);
    });
    const base = { brand_id: brandId, read_at: new Date().toISOString() };
    if (contas === null) return { ...base, enabled: false, accounts: [] };
    const lidas = await Promise.all(contas.map((c) => this.lerConta(c)));
    // O cupom de cada mensagem que o Liame montou, e o que ele trouxe no caixa: do banco, numa transação curta.
    const pares = lidas.flatMap((a) => a.campaigns.items.map((c) => ({ conta: a.connected_account_id, campanha: c.id })));
    const cupons = pares.length ? await naTransacaoDaEmpresa(this.banco(), quem, () => this.cuponsDasCampanhas(pares, veVendas(auth))) : new Map<string, MessagingCoupon>();
    const accounts = lidas.map((a) => ({ ...a, campaigns: { ...a.campaigns, items: a.campaigns.items.map((c) => ({ ...c, coupon: cupons.get(`${a.connected_account_id}/${c.id}`) ?? null })) } }));
    return { ...base, enabled: true, accounts };
  }

  /** Uma campanha de perto: por que está pausada ou esperando, as falhas por motivo e o custo. */
  async detalhar(auth: AuthContext, contaId: string, campanhaId: string): Promise<MessagingCampaignDetailResponse> {
    const quem = quemPede(auth);
    const conta = await naTransacaoDaEmpresa(this.banco(), quem, async () => {
      const [c] = await this.contas(sql`a.id = ${contaId}`);
      if (!c) throw contaNaoEncontrada();
      if (!(await this.ligada(quem, c.brand_id))) throw desligada();
      return c;
    });
    if (!conta.token) throw semAutorizacao();
    const apiUrl = this.config.produtos.regemcastApiUrl;
    if (!apiUrl) throw indisponivel();
    try {
      const d = await detalharCampanhaDeMensagens({ cliente: this.cliente(), apiUrl }, { token: conta.token, contaChave: chaveDaTela(conta), id: campanhaId });
      const cupons = await naTransacaoDaEmpresa(this.banco(), quem, () => this.cuponsDasCampanhas([{ conta: conta.id, campanha: d.campanha.id }], veVendas(auth)));
      return {
        connected_account_id: conta.id,
        campaign: { ...campanhaDaRota(d.campanha), coupon: cupons.get(`${conta.id}/${d.campanha.id}`) ?? null },
        pause: d.pausa ? { reason: d.pausa.motivo, explanation: d.pausa.explicacao, resumes_at: iso(d.pausa.voltaEm) } : null,
        waiting: d.espera ? { reason: d.espera.motivo, until: iso(d.espera.ate) } : null,
        failures: d.falhasPorMotivo.map((f) => ({ messages: f.mensagens, title: f.titulo, explanation: f.explicacao, action: f.acao })),
        cost: d.custo
          ? {
              currency: d.custo.moeda,
              spent_cents: d.custo.gastoCentavos,
              to_spend_cents: d.custo.aSairCentavos,
              lines: d.custo.linhas.map((l) => ({ label: l.rotulo, value: l.valor, detail: l.detalhe })),
              notices: d.custo.avisos,
            }
          : null,
        rest_days: d.descansoDias,
      };
    } catch (err) {
      if (!(err instanceof ErroConector)) throw err;
      this.logger.warn(`campanha não lida no RegemCast (conta ${conta.id}): ${err.tipo}: ${err.message}`);
      if (err.tipo === 'autenticacao') throw semAutorizacao();
      if (err.tipo === 'permissao') {
        throw new AppProblem(409, 'regemcast-sem-permissao', 'A conexão não deixa ler as campanhas', 'A conexão com o RegemCast não inclui a leitura das campanhas de mensagens. Quem dá a permissão é o dono da conta, no RegemCast.');
      }
      // A ferramenta recusou o pedido (a campanha não existe nesta conta) ou respondeu fora do contrato.
      if (err.tipo === 'definitivo') throw new AppProblem(422, 'plataforma-recusou', 'O RegemCast não devolveu esta campanha', 'O RegemCast não encontrou esta campanha nesta conta. Leia a lista de novo.');
      throw indisponivel();
    }
  }

  /**
   * O cupom de cada campanha que o Liame montou com um (o retrato do pedido de mensagem), pela chave `conta/campanha`.
   * Só o cupom que já nasceu no Regem (junto com o envio). Para quem vê as vendas, vêm também os pedidos confirmados
   * na loja do cupom, com ele, desde que nasceu, e a receita deles, sem o que foi devolvido.
   */
  private async cuponsDasCampanhas(pares: { conta: string; campanha: string }[], comVendas: boolean): Promise<Map<string, MessagingCoupon>> {
    const contas = [...new Set(pares.map((p) => p.conta))];
    const campanhas = [...new Set(pares.map((p) => p.campanha))];
    const r = await currentTx().execute<{ connected_account_id: string; campaign_id: string; coupon_code: string; pedidos: number; receita_micros: string }>(sql`
      select m.connected_account_id, m.campaign_id, m.coupon_code,
             count(o.id)::int as pedidos, coalesce(sum(o.revenue_micros - o.refunded_micros), 0)::text as receita_micros
        from liame.message_request m
        left join liame.order_fact o
          on o.tenant_id = m.tenant_id and o.connected_account_id = m.coupon_account_id and o.coupon_code = m.coupon_code
         and o.status = 'confirmado' and o.confirmed_at >= m.coupon_created_at
       where m.connected_account_id in ${contas} and m.campaign_id in ${campanhas}
         and m.coupon_code is not null and m.coupon_created_at is not null
       group by m.connected_account_id, m.campaign_id, m.coupon_code`);
    const cupons = new Map<string, MessagingCoupon>();
    for (const l of r.rows) cupons.set(`${l.connected_account_id}/${l.campaign_id}`, cupomDaRota(l, comVendas));
    return cupons;
  }

  private banco(): Database {
    if (!this.database) throw new Error('mensageria: sem banco');
    return this.database;
  }

  private ligada(quem: Quem, brandId: string): Promise<boolean> {
    return this.flags.isEnabled(FLAG_MENSAGERIA, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId }));
  }

  /**
   * Uma tentativa: há uma pessoa esperando, e ela tenta de novo pelo botão. Com a cota da conta esgotada (a tela aberta
   * vezes demais em pouco tempo), a leitura espera pouco pela vez e sai como indisponível, em vez de segurar a tela.
   */
  private cliente(): ClienteConector {
    return new ClienteConector(this.banco().db, {
      enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos),
      tentativas: 1,
      tempoLimiteMs: TEMPO_DO_REGEMCAST_MS,
      esperaMaximaMs: ESPERA_PELA_COTA_MS,
    });
  }

  /** As contas do RegemCast da empresa que passam no filtro, com o token de cada uma lido do cofre. Roda numa transação curta da empresa. */
  private async contas(filtro: ReturnType<typeof sql>): Promise<ContaLida[]> {
    const tx = currentTx();
    const r = await tx.execute<Omit<ContaLida, 'token'> & { credential_secret_id: string | null }>(sql`
      select a.id, a.brand_id, a.name, a.external_id, a.credential_secret_id
        from liame.connected_account a
       where a.provider = 'regemcast' and a.disconnected_at is null and ${filtro}
       order by a.name, a.id
       limit ${CONTAS_POR_MARCA}`);
    const segredos = new Map<string, CredencialGuardada | null>();
    const contas: ContaLida[] = [];
    for (const { credential_secret_id: segredoId, ...conta } of r.rows) {
      if (segredoId && !segredos.has(segredoId)) {
        const texto = await this.vault.readSecret(tx, segredoId);
        segredos.set(segredoId, texto ? (JSON.parse(texto) as CredencialGuardada) : null);
      }
      const credencial = segredoId ? segredos.get(segredoId) : null;
      const entrada = credencial?.tipo === 'regemcast' ? credencial.lojas.find((l) => l.loja_id === conta.external_id) : undefined;
      contas.push({ ...conta, token: entrada?.token ?? null });
    }
    return contas;
  }

  /** As cinco leituras de uma conta, ao mesmo tempo, sem transação aberta. */
  private async lerConta(c: ContaLida): Promise<MessagingAccount> {
    const apiUrl = this.config.produtos.regemcastApiUrl;
    // Sem o token desta conta no cofre, ou sem o endereço do RegemCast na configuração, nada é lido.
    const nada = <T>(): Parte<T> => ({ status: 'indisponivel', dado: null });
    if (!c.token || !apiUrl) return this.montar(c, c.token ? 'indisponivel' : 'sem_autorizacao', nada(), nada(), nada(), nada(), nada());
    const ctx = { cliente: this.cliente(), apiUrl };
    const acesso = { token: c.token, contaChave: chaveDaTela(c) };
    const ler = async <T>(oque: string, fn: () => Promise<T>): Promise<Parte<T>> => {
      try {
        return { status: 'ok', dado: await fn() };
      } catch (err) {
        if (!(err instanceof ErroConector)) throw err;
        // O motivo fica no log (sem token e sem dado pessoal: a mensagem do conector traz só a ferramenta e o campo).
        this.logger.warn(`${oque} não lido no RegemCast (conta ${c.id}): ${err.tipo}: ${err.message}`);
        if (err.tipo === 'autenticacao') return { status: 'sem_autorizacao', dado: null };
        if (err.tipo === 'permissao') return { status: 'sem_permissao', dado: null };
        return { status: 'indisponivel', dado: null };
      }
    };
    const [conta, orcamento, campanhas, publicos, modelos] = await Promise.all([
      ler('a situação da conta', () => lerContaDeMensagens(ctx, acesso)),
      ler('o orçamento', () => lerOrcamentoDeMensagens(ctx, acesso)),
      ler('as campanhas', () => lerCampanhasDeMensagens(ctx, { ...acesso, limite: CAMPANHAS_NA_LISTA })),
      ler('os públicos', () => lerPublicos(ctx, acesso)),
      ler('os modelos', () => lerModelos(ctx, acesso)),
    ]);
    const recusada = [conta, orcamento, campanhas, publicos, modelos].some((p) => p.status === 'sem_autorizacao');
    return this.montar(c, recusada ? 'sem_autorizacao' : 'ok', conta, orcamento, campanhas, publicos, modelos);
  }

  private montar(
    c: ContaLida,
    status: 'ok' | 'sem_autorizacao' | 'indisponivel',
    conta: Parte<Awaited<ReturnType<typeof lerContaDeMensagens>>>,
    orcamento: Parte<Awaited<ReturnType<typeof lerOrcamentoDeMensagens>>>,
    campanhas: Parte<Awaited<ReturnType<typeof lerCampanhasDeMensagens>>>,
    publicos: Parte<Awaited<ReturnType<typeof lerPublicos>>>,
    modelos: Parte<Awaited<ReturnType<typeof lerModelos>>>,
  ): MessagingAccount {
    // Na resposta, a parte só diz `ok`, `sem_permissao` ou `indisponivel`: a recusa do token é da conta inteira.
    const daParte = (p: Parte<unknown>) => (p.status === 'sem_autorizacao' ? 'indisponivel' : p.status);
    const w = conta.dado?.whatsapp ?? null;
    const grupos = publicos.dado ? [...publicos.dado.listas, ...publicos.dado.publicos, ...publicos.dado.perfis] : null;
    return {
      connected_account_id: c.id,
      name: c.name,
      status,
      whatsapp: {
        status: daParte(conta),
        connected: w ? w.conectado : null,
        signal: w?.sinal ?? null,
        title: w?.titulo ?? null,
        summary: w?.resumo ?? null,
        checked_at: iso(w?.lidaEm ?? null),
        problems: (w?.problemas ?? []).map((p) => ({ where: p.onde, title: p.titulo, explanation: p.explicacao, action: p.acao })),
      },
      budget: {
        status: daParte(orcamento),
        currency: orcamento.dado?.moeda ?? null,
        periods: (orcamento.dado?.periodos ?? []).map((p) => ({ period: p.periodo, label: p.rotulo, limit_cents: p.tetoCentavos, spent_cents: p.gastoCentavos, percent: p.percentual, signal: p.sinal })),
        notices: orcamento.dado?.avisos ?? [],
      },
      ready: {
        templates_status: daParte(modelos),
        approved_templates: modelos.dado ? modelos.dado.modelos.filter((m) => m.podeDisparar).length : null,
        templates: modelos.dado ? modelos.dado.modelos.length : null,
        audiences_status: daParte(publicos),
        audiences: grupos ? grupos.length : null,
        largest_audience: grupos ? grupos.reduce((maior, g) => Math.max(maior, g.pessoas), 0) : null,
      },
      campaigns: {
        status: daParte(campanhas),
        total: campanhas.dado ? campanhas.dado.total : null,
        items: (campanhas.dado?.campanhas ?? []).map(campanhaDaRota),
      },
    };
  }
}

/**
 * A chave da cota e do disjuntor destas leituras: separada da chave da sincronização das conversas da mesma conta,
 * para uma tela aberta muitas vezes (ou um RegemCast lento) não segurar a leitura que roda sozinha.
 */
function chaveDaTela(c: { external_id: string }): string {
  return `tela:${c.external_id}`;
}
