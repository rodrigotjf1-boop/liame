import { type Database, uuidv7 } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ActionService } from '../actions/action.service.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { estimarPublico, lerModelos, lerPublicos, rascunharCampanha } from '../connectors/regemcast/conector-regemcast.js';
import { currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { VaultService } from '../vault/vault.service.js';
import { FLAG_MENSAGERIA } from './mensageria.service.js';
import { campanhaDoRascunho, chaveDoRascunho, citaOCupom, conferirVariaveis, janelaDaProposta, modeloDaProposta, PropostaDeMensagem, PropostaRecusada, publicoDaProposta, regraDoCupom } from './proposta-de-mensagem.js';

// Montar o pedido de mensagem (A5, Y5, parte 4; `plano-a5.md` D-A5-10 a D-A5-16; protótipo P15). Quem propõe é o
// funcionário de CRM e mensageria (Y6): daqui sai a campanha em RASCUNHO no RegemCast (nenhuma mensagem sai), o retrato
// do pedido (`liame.message_request`) e o pedido de envio no trilho de ação, que espera a aprovação de uma pessoa com o
// código do app. Nada aqui envia mensagem.
//
// Três tempos, para não segurar uma transação enquanto o RegemCast responde:
// 1. banco (transação curta da empresa): a marca, as flags, a conta do RegemCast com o token, e a loja do cupom;
// 2. RegemCast (sem transação): o modelo aprovado, o público, a conta de quem recebe e o rascunho da campanha;
// 3. banco (transação da empresa): o retrato do pedido e o pedido de envio, juntos. O trilho lê o plano do disparo.
//
// Se o terceiro tempo falha, o rascunho fica no RegemCast sem pedido no Liame: é só um rascunho, e a mesma proposta
// repetida devolve a mesma campanha (a chave de idempotência sai da proposta).

export const FLAG_DO_ENVIO = 'whatsapp_campaign';
/** A escrita no Regem: é por ela que o cupom da mensagem nasce, junto com o envio. */
export const FLAG_DO_CUPOM = 'regem_write';
/** A rotina tem este tempo para cada chamada ao RegemCast: ninguém espera na tela, mas uma proposta não trava a fila. */
const TEMPO_DO_REGEMCAST_MS = 20_000;

export type Proponente = { tenantId: string; agentKey: string; agentLabel: string; emNomeDe: string };
export type PedidoMontado = { id: string; action_id: string; campaign_id: string };

type Preparado = { conta: { id: string; external_id: string }; token: string; apiUrl: string };

const recusada = (motivo: string) => new AppProblem(422, 'proposta-recusada', 'A proposta não pode virar pedido', motivo);

@Injectable()
export class PedidoDeMensagemService {
  private readonly logger = new Logger('pedido-de-mensagem');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly flags: FlagService,
    private readonly vault: VaultService,
    private readonly actions: ActionService,
  ) {}

  /**
   * Monta o pedido de envio a partir da proposta do funcionário. Devolve o retrato, o pedido de ação e a campanha em
   * rascunho. O que impede a aprovação agora (o teto de gasto que não cabe, o que o RegemCast aponta) não recusa: o
   * pedido nasce esperando, com o motivo. O que não tem como virar pedido é recusado aqui, com o porquê (422).
   */
  async propor(quem: Proponente, entrada: unknown): Promise<PedidoMontado> {
    const lida = PropostaDeMensagem.safeParse(entrada);
    if (!lida.success) throw recusada(`A proposta veio fora do formato: ${lida.error.issues.map((i) => `${i.path.join('.') || 'proposta'}: ${i.message}`).join('; ')}.`);
    const p = lida.data;
    const alvo = { tenantId: quem.tenantId, userId: quem.emNomeDe };

    // ---- 1. O banco: a marca, as flags, a conta do RegemCast e a loja do cupom.
    const preparado = await naTransacaoDaEmpresa(this.banco(), alvo, () => this.preparar(quem, p));

    // ---- 2. O RegemCast: o modelo, o público, quem recebe e o rascunho. Nenhuma mensagem sai.
    const ctx = { cliente: this.cliente(), apiUrl: preparado.apiUrl };
    const acesso = { token: preparado.token, contaChave: `proposta:${preparado.conta.external_id}` };
    let montado;
    try {
      const janela = janelaDaProposta(p.janela);
      const [modelos, publicos] = await Promise.all([lerModelos(ctx, acesso), lerPublicos(ctx, acesso)]);
      const modelo = modeloDaProposta(modelos, p.modelo);
      conferirVariaveis(modelo, p.variaveis, p.variavel_do_titulo);
      if (p.cupom && !citaOCupom(modelo, p.variaveis, p.variavel_do_titulo, p.cupom.codigo)) {
        throw new PropostaRecusada(`A mensagem não diz o código do cupom (${p.cupom.codigo}): sem ele, quem recebe não tem como usar, e o resultado não é medido.`);
      }
      const publico = publicoDaProposta(publicos, p.publico);
      const categoria = modelo.categoria === 'utilidade' ? 'utilidade' : 'marketing';
      const estimativa = await estimarPublico(ctx, { ...acesso, publico: publico.doRegemcast, categoria });
      if (estimativa.pessoas === 0) throw new PropostaRecusada('Ninguém deste público pode receber esta mensagem agora.');
      const campanha = campanhaDoRascunho(p, modelo, publico.doRegemcast, janela);
      const rascunho = await rascunharCampanha(ctx, { ...acesso, chave: chaveDoRascunho(quem.tenantId, preparado.conta.id, campanha), campanha });
      montado = { janela, modelo, publico, estimativa, rascunho };
    } catch (err) {
      if (err instanceof PropostaRecusada) throw recusada(err.message);
      if (err instanceof ErroConector) throw this.doRegemcast(err, preparado.conta.id);
      throw err;
    }

    // ---- 3. O banco: o retrato do pedido e o pedido de envio, juntos.
    const { janela, modelo, publico, estimativa, rascunho } = montado;
    return naTransacaoDaEmpresa(this.banco(), alvo, async () => {
      const tx = currentTx();
      const id = uuidv7();
      const regra = p.cupom ? regraDoCupom(p.cupom, p.nome) : null;
      try {
        await tx.execute(sql`
          insert into liame.message_request (id, tenant_id, brand_id, connected_account_id, campaign_id, name,
                                             template_name, template_language, template_category, template_header, template_body,
                                             template_footer, template_buttons, variables, header_variable,
                                             audience, audience_name, audience_rule, people_can_receive, people_resting, rest_days,
                                             window_days, window_start, window_end,
                                             coupon_account_id, coupon_code, coupon_rule, actor_type, agent_key, requested_by)
          values (${id}, ${quem.tenantId}, ${p.marca}, ${preparado.conta.id}, ${rascunho.campanha.id}, ${p.nome},
                  ${modelo.nome}, ${modelo.idioma}, ${modelo.categoria}, ${modelo.cabecalho}, ${modelo.corpo},
                  ${modelo.rodape}, ${JSON.stringify(modelo.botoes)}::jsonb, ${JSON.stringify(p.variaveis)}::jsonb,
                  ${p.variavel_do_titulo ? JSON.stringify(p.variavel_do_titulo) : null}::jsonb,
                  ${JSON.stringify(p.publico)}::jsonb, ${publico.nome}, ${publico.regra}, ${estimativa.pessoas}, ${estimativa.emDescanso},
                  ${rascunho.descansoDias ?? estimativa.descansoDias},
                  ${`{${janela.dias.join(',')}}`}::smallint[], ${janela.inicio}, ${janela.fim},
                  ${p.cupom?.loja ?? null}, ${p.cupom?.codigo ?? null}, ${regra ? JSON.stringify(regra) : null}::jsonb,
                  'agent', ${quem.agentKey}, ${quem.emNomeDe})`);
      } catch (err) {
        const causa = (err as { cause?: { code?: string; constraint?: string } }).cause;
        if (causa?.code === '23505' && causa.constraint === 'uq_message_request_cupom') throw recusada(`O cupom ${p.cupom?.codigo ?? ''} já é de outra mensagem desta loja. Proponha outro código.`);
        // A mesma proposta de novo: a campanha em rascunho já tem pedido.
        if (causa?.code === '23505') throw new AppProblem(409, 'pedido-ja-montado', 'Esta mensagem já tem pedido', 'Já existe um pedido de envio para esta campanha em rascunho.');
        throw err;
      }
      const acao = await this.actions.pedirMensagemPeloFuncionario(quem, {
        tool: 'mensagem_disparar',
        brand_id: p.marca,
        provider: 'regemcast',
        account_id: preparado.conta.id,
        resource_id: `mensagem:${rascunho.campanha.id}`,
        params: {},
      });
      await tx.execute(sql`update liame.message_request set action_request_id = ${acao}, updated_at = now() where id = ${id} and tenant_id = ${quem.tenantId}`);
      await writeAudit(tx, {
        tenantId: quem.tenantId,
        actorType: 'agent',
        actorId: null,
        actorLabel: quem.agentLabel,
        action: 'mensagem.propor',
        resourceType: 'message_request',
        resourceId: id,
        // Só números e o que identifica o pedido: o texto da mensagem fica no retrato, não na trilha.
        after: {
          action_request_id: acao,
          campaign_id: rascunho.campanha.id,
          template: modelo.nome,
          audience: p.publico.origem,
          people_can_receive: estimativa.pessoas,
          people_resting: estimativa.emDescanso,
          window: `${janela.inicio}-${janela.fim}`,
          coupon_code: p.cupom?.codigo ?? null,
          agent_key: quem.agentKey,
          on_behalf_of: quem.emNomeDe,
        },
        traceId: activeTraceId(),
        origin: 'worker',
      });
      return { id, action_id: acao, campaign_id: rascunho.campanha.id };
    });
  }

  /** A parte do banco antes do RegemCast: a marca, as duas flags, a conta com o token e a loja do cupom. */
  private async preparar(quem: Proponente, p: PropostaDeMensagem): Promise<Preparado> {
    const tx = currentTx();
    const marca = await tx.execute(sql`select 1 from liame.brand where id = ${p.marca} and archived_at is null`);
    if (!marca.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    const contexto = this.flags.context({ tenantId: quem.tenantId, userId: quem.emNomeDe, brandId: p.marca, accountId: p.conta });
    if (!(await this.flags.isEnabled(FLAG_MENSAGERIA, contexto))) {
      throw new AppProblem(409, 'mensageria-desligada', 'A função não está ligada', 'As mensagens pelo RegemCast ainda não estão ligadas para esta empresa. Quem liga é a Liame, a pedido do dono.');
    }
    if (!(await this.flags.isEnabled(FLAG_DO_ENVIO, contexto))) {
      throw new AppProblem(409, 'envio-desligado', 'O envio de mensagens não está ligado', 'O envio de mensagens pelo Liame ainda não está ligado para esta empresa. Quem liga é a Liame, a pedido do dono.');
    }
    const r = await tx.execute<{ id: string; external_id: string; credential_secret_id: string | null }>(sql`
      select a.id, a.external_id, a.credential_secret_id
        from liame.connected_account a
       where a.id = ${p.conta} and a.tenant_id = ${quem.tenantId} and a.brand_id = ${p.marca} and a.provider = 'regemcast' and a.disconnected_at is null`);
    const conta = r.rows[0];
    if (!conta) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Conta do RegemCast não encontrada nesta marca.');
    const guardada = conta.credential_secret_id ? await this.vault.readSecret(tx, conta.credential_secret_id) : null;
    const credencial = guardada ? (JSON.parse(guardada) as CredencialGuardada) : null;
    const token = credencial?.tipo === 'regemcast' ? credencial.lojas.find((l) => l.loja_id === conta.external_id)?.token : undefined;
    if (!token) throw new AppProblem(409, 'regemcast-sem-autorizacao', 'Conecte o RegemCast de novo', 'O RegemCast não tem mais a conexão desta conta. Conecte o RegemCast de novo em Contas conectadas.');
    const apiUrl = this.config.produtos.regemcastApiUrl;
    if (!apiUrl) throw new AppProblem(502, 'plataforma-indisponivel', 'O RegemCast não está disponível', 'O envio de mensagens pelo RegemCast não está disponível neste ambiente.');
    if (p.cupom) await this.conferirALojaDoCupom(quem.tenantId, p.marca, p.cupom.loja, p.cupom.codigo);
    return { conta: { id: conta.id, external_id: conta.external_id }, token, apiUrl };
  }

  /** O cupom nasce numa loja do Regem da mesma marca, que liberou "criar cupom de campanha", e com um código que ela não tem. */
  private async conferirALojaDoCupom(tenantId: string, brandId: string, lojaId: string, codigo: string): Promise<void> {
    const tx = currentTx();
    const r = await tx.execute<{ pode_criar: boolean }>(sql`
      select coalesce(a.provider_attributes -> 'escopos' @> '["cupons.criar"]'::jsonb, false) as pode_criar
        from liame.connected_account a
       where a.id = ${lojaId} and a.tenant_id = ${tenantId} and a.brand_id = ${brandId} and a.provider = 'regem' and a.disconnected_at is null`);
    const loja = r.rows[0];
    if (!loja) throw recusada('A loja do cupom não é uma loja do Regem conectada a esta marca.');
    if (!loja.pode_criar) throw recusada('A loja não liberou "criar cupom de campanha" no Regem. Autorize de novo em Contas conectadas e ligue essa chave lá.');
    // O cupom nasce junto com o envio, pela escrita no Regem: sem ela ligada, a mensagem com cupom nunca sairia.
    if (!(await this.flags.isEnabled(FLAG_DO_CUPOM, this.flags.context({ tenantId, brandId, accountId: lojaId })))) {
      throw recusada('A criação de cupom no Regem não está ligada para esta empresa: a mensagem com cupom não pode ser enviada. Quem liga é a Liame, a pedido do dono.');
    }
    const existe = await tx.execute(sql`select 1 from liame.coupon where connected_account_id = ${lojaId} and code = ${codigo} and removed_at is null limit 1`);
    if (existe.rows[0]) throw recusada(`Já existe um cupom com o código ${codigo} nesta loja. Proponha outro código.`);
  }

  /** A recusa do RegemCast em palavras, para quem propôs. O que é passageiro vira 502: a rotina tenta de novo depois. */
  private doRegemcast(err: ErroConector, contaId: string): AppProblem {
    this.logger.warn(`proposta de mensagem não montada no RegemCast (conta ${contaId}): ${err.tipo}: ${err.message}`);
    if (err.tipo === 'autenticacao') return new AppProblem(409, 'regemcast-sem-autorizacao', 'Conecte o RegemCast de novo', 'O RegemCast não aceitou a conexão desta conta. Conecte o RegemCast de novo em Contas conectadas.');
    if (err.tipo === 'permissao') {
      return new AppProblem(409, 'regemcast-sem-permissao', 'A conexão não deixa montar mensagens', 'A conexão com o RegemCast não inclui montar campanhas de mensagens. Quem dá a permissão é o dono da conta, no RegemCast.');
    }
    if (err.tipo === 'definitivo') return recusada(`O RegemCast não aceitou montar esta mensagem: ${err.message.replace(/^[a-z_]+:\s*/, '').replace(/[.!?]\s*$/, '')}.`);
    return new AppProblem(502, 'plataforma-indisponivel', 'O RegemCast não respondeu', 'Não foi possível montar a mensagem no RegemCast agora. Nada foi criado; tente de novo em instantes.');
  }

  private banco(): Database {
    if (!this.database) throw new Error('pedido de mensagem: sem banco');
    return this.database;
  }

  private cliente(): ClienteConector {
    return new ClienteConector(this.banco().db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 1, tempoLimiteMs: TEMPO_DO_REGEMCAST_MS });
  }
}
