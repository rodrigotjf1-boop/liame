import type { Database, Tx } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { CRM } from '../ai/crm/prompt.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { funcionarioAtivo } from '../ai/registro/ativacao.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { pessoaPode } from '../auth/pessoa-pode.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { lerModelos, rascunharModelo } from '../connectors/regemcast/conector-regemcast.js';
import { podeGravar } from '../connectors/regemcast/credencial-da-conta.js';
import { currentTx } from '../context/request-context.js';
import { marcaDoCriativo } from '../criativo/base.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { type ContaDoRegemcast, lerContaDoRegemcast } from '../mensageria/conta-do-regemcast.js';
import { FLAG_MENSAGERIA } from '../mensageria/mensageria.service.js';
import { FLAG_DO_ENVIO, PedidoDeMensagemService, type PedidoMontado } from '../mensageria/pedido-de-mensagem.service.js';
import type { CupomDaMensagem } from '../mensageria/proposta-de-mensagem.js';
import {
  adiarProposta,
  anotarModelo,
  type DonoDaProposta,
  encerrarProposta,
  esperarProposta,
  lerProposta,
  MODELO_SEM_ENVIO,
  type PropostaGuardada,
  registrarRascunho,
  virarPedido,
} from '../mensageria/proposta-do-crm.js';
import {
  chaveDoModelo,
  IDIOMA_DO_MODELO,
  MINUTOS_DE_ESPERA_SEM_IA,
  minutosAteATentativa,
  modeloParaRascunhar,
  nomeDoModelo,
  passoDoModelo,
  prazoDoModeloAcabou,
  propostaParaOPedido,
  TENTATIVAS_DO_RASCUNHO,
} from '../mensageria/rotina-do-crm.js';
import { ResultsService } from '../results/results.service.js';
import { VaultService } from '../vault/vault.service.js';
import { FLAG_DO_CRM } from './rotina-do-crm.service.js';

// A rotina do funcionário de CRM e mensageria, terceiro passo: o modelo da mensagem (A5, Y6; `plano-a5.md` D-A5-15;
// protótipo P16). Fica na pasta do worker: quem chama é o laço. São duas vezes:
//
// - `rascunhar`: o texto conferido vira um RASCUNHO de modelo no RegemCast, com o rodapé de saída e um exemplo para
//   cada variável. O rascunho não vai para a Meta: quem o envia para a análise é uma pessoa, lá (D-A5-15);
// - `acompanhar`: de tempos em tempos, ele lê no RegemCast como está o modelo. Enquanto ninguém envia, ou a Meta
//   analisa, a proposta espera; recusado, ou fora do prazo, ela é descartada; aprovado, é hora do pedido de envio.
//
// Nenhuma mensagem sai daqui, e nada é enviado à Meta pelo Liame.

const ROTULO_DO_CRM = 'CRM e mensageria';
const MINUTO_MS = 60_000;
/** A rotina tem este tempo para cada chamada ao RegemCast: ninguém espera na tela, mas uma proposta não trava a fila. */
const TEMPO_DO_REGEMCAST_MS = 20_000;
/** A situação que a proposta guarda quando o RegemCast diz que o modelo foi aprovado e pode ser disparado. */
export const MODELO_APROVADO = 'aprovado';

/** As chaves da função, e o que a vez diz quando uma está desligada. */
const CHAVES: ReadonlyArray<readonly [string, string]> = [
  [FLAG_DO_CRM, 'crm_desligado'],
  [FLAG_MENSAGERIA, 'mensageria_desligada'],
  [FLAG_DO_ENVIO, 'envio_desligado'],
];

/** Um id como o RegemCast devolve para o rascunho: é o que a fila aceita guardar. */
const FORMATO_DE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ehUuid = (id: string): boolean => id.length === 36 && FORMATO_DE_UUID.test(id);

/**
 * O que a vez do rascunho fez. `rascunhado`: o rascunho do modelo está no RegemCast, e a proposta passa a esperar a
 * Meta. `descartada`: não vai virar mensagem. `falhou`: o RegemCast não respondeu (`deVez`: as tentativas acabaram)
 * ou não aceitou o rascunho. `esperando`: a função ou ele estão desligados. `fora`: não está mais esperando o rascunho.
 */
export type Rascunho =
  | { status: 'rascunhado'; modelo: string; problemas: number }
  | { status: 'descartada'; motivo: string }
  | { status: 'falhou'; motivo: string; deVez: boolean }
  | { status: 'esperando'; motivo: string }
  | { status: 'fora' };

/**
 * O que a vez do acompanhamento viu. `esperando`: ninguém enviou o modelo ainda (`rascunho`), ou a Meta analisa.
 * `pedido`: a Meta aprovou, e o pedido de envio foi montado (está em Aprovações). `descartada`: a Meta recusou, o
 * prazo acabou, ou as regras de agora não deixam mais pedir. `sem_leitura`: não deu para ler ou pedir agora (a função
 * desligada, o RegemCast fora do ar); olha de novo no próximo intervalo.
 */
export type Acompanhamento =
  | { status: 'esperando'; situacao: string }
  | { status: 'pedido'; pedido: string }
  | { status: 'descartada'; motivo: string }
  | { status: 'sem_leitura'; motivo: string }
  | { status: 'fora' };

type Acesso = { conta: ContaDoRegemcast; token: string; apiUrl: string };
type ParaRascunhar = Acesso & { p: PropostaGuardada; corpo: string; codigoDoCupom: string };
type ParaAcompanhar = Acesso & { p: PropostaGuardada; nome: string; idioma: string };
type ParaPedir = { responsavel: string; hoje: string; nome: string; cupom: CupomDaMensagem; modelo: string };
/** Quem define o desconto das mensagens responde pelas propostas: a mesma permissão de quando ele propôs. */
const PODE_RESPONDER = 'orcamento.gerenciar';

@Injectable()
export class ModeloDoCrmService {
  private readonly logger = new Logger('modelo-do-crm');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly flags: FlagService,
    private readonly vault: VaultService,
    private readonly resultados: ResultsService,
    private readonly pedidos: PedidoDeMensagemService,
  ) {}

  /** Grava no RegemCast o rascunho do modelo de uma proposta que já tem o texto conferido. O relógio injetado vale para a operação inteira (V34). */
  async rascunhar(alvo: DonoDaProposta, agora = new Date()): Promise<Rascunho> {
    const database = this.banco();
    // ---- 1. O banco: a proposta, as chaves e a conta do RegemCast.
    const lido = await this.naEmpresa<ParaRascunhar | Rascunho>(alvo, (tx) => this.lerParaRascunhar(tx, alvo, agora));
    if ('status' in lido) return lido;

    // ---- 2. O RegemCast: o rascunho. A mesma proposta repete a mesma chave e o mesmo pedido: não nascem dois.
    const modelo = modeloParaRascunhar({ id: lido.p.id, motivo: lido.p.motive, corpo: lido.corpo, codigoDoCupom: lido.codigoDoCupom });
    let r: Awaited<ReturnType<typeof rascunharModelo>>;
    try {
      r = await rascunharModelo({ cliente: this.cliente(database), apiUrl: lido.apiUrl }, { token: lido.token, contaChave: `rotina:${lido.conta.external_id}`, chave: chaveDoModelo(lido.p.id), modelo });
    } catch (err) {
      if (!(err instanceof ErroConector)) throw err;
      // O motivo fica no log (sem token e sem dado pessoal: a mensagem do conector traz só a ferramenta e o campo).
      this.logger.warn(`proposta ${alvo.id}: o rascunho do modelo não foi gravado no RegemCast (conta ${lido.conta.id}): ${err.tipo}: ${err.message}`);
      // O que o RegemCast não aceita (um texto que a Meta recusaria de cara) não muda tentando de novo.
      if (err.tipo === 'definitivo') return this.naEmpresa(alvo, (tx) => this.encerrar(tx, alvo, 'falhou', 'modelo_nao_aceito'));
      return this.falhou(alvo, 'regemcast_fora_do_ar', agora);
    }
    if (!ehUuid(r.id)) {
      this.logger.error(`proposta ${alvo.id}: o RegemCast devolveu um rascunho com id fora do formato`);
      return this.naEmpresa(alvo, (tx) => this.encerrar(tx, alvo, 'falhou', 'resposta_do_regemcast'));
    }

    // ---- 3. O banco: a proposta passa a esperar a Meta.
    return this.naEmpresa<Rascunho>(alvo, async (tx) => {
      if (!(await registrarRascunho(tx, alvo, { id: r.id, nome: modelo.nome, idioma: IDIOMA_DO_MODELO, situacao: MODELO_SEM_ENVIO }))) return { status: 'fora' };
      // Na trilha, o nome técnico do modelo e o que o RegemCast apontou, em número: o texto fica na proposta.
      await this.auditar(tx, alvo, 'mensagem.rascunhar_modelo', { template_id: r.id, template_name: modelo.nome, template_language: IDIOMA_DO_MODELO, problems: r.problemas.length, ready_to_send: r.prontoParaEnviar });
      return { status: 'rascunhado', modelo: modelo.nome, problemas: r.problemas.length };
    });
  }

  /**
   * Uma tentativa de rascunho em que o RegemCast não respondeu: conta, e a proposta tenta de novo mais tarde; na
   * última, fecha como `falhou`. É também por onde o laço registra a falha fora do previsto.
   */
  async falhou(alvo: DonoDaProposta, motivo: string, agora = new Date()): Promise<Rascunho> {
    return this.naEmpresa<Rascunho>(alvo, async (tx) => {
      const p = await lerProposta(tx, alvo);
      if (!p || p.status !== 'preparando' || p.body === null) return { status: 'fora' };
      if (p.attempts + 1 >= TENTATIVAS_DO_RASCUNHO) return this.encerrar(tx, alvo, 'falhou', motivo, { attempts: p.attempts + 1 }, true);
      const ate = new Date(agora.getTime() + minutosAteATentativa(p.attempts) * MINUTO_MS);
      if (!(await adiarProposta(tx, alvo, ate))) return { status: 'fora' };
      return { status: 'falhou', motivo, deVez: false };
    });
  }

  /** Olha, no RegemCast, como está o modelo de uma proposta em `rascunho`, e anda a proposta pelo que viu. */
  async acompanhar(alvo: DonoDaProposta, agora = new Date()): Promise<Acompanhamento> {
    const database = this.banco();
    const lido = await this.naEmpresa<ParaAcompanhar | Acompanhamento>(alvo, (tx) => this.lerParaAcompanhar(tx, alvo, agora));
    if ('status' in lido) return lido;
    const rascunhoEm = new Date(lido.p.drafted_at ?? lido.p.created_at);

    let modelos: Awaited<ReturnType<typeof lerModelos>>;
    try {
      modelos = await lerModelos({ cliente: this.cliente(database), apiUrl: lido.apiUrl }, { token: lido.token, contaChave: `rotina:${lido.conta.external_id}` });
    } catch (err) {
      if (!(err instanceof ErroConector)) throw err;
      this.logger.warn(`proposta ${alvo.id}: os modelos não foram lidos no RegemCast (conta ${lido.conta.id}): ${err.tipo}: ${err.message}`);
      const motivo = err.tipo === 'autenticacao' ? 'sem_autorizacao' : err.tipo === 'permissao' ? 'sem_permissao' : 'regemcast_fora_do_ar';
      return this.naEmpresa(alvo, (tx) => this.semLeitura(tx, alvo, lido.p, motivo, agora));
    }

    const passo = passoDoModelo(modelos, { nome: lido.nome, idioma: lido.idioma, semEnvio: MODELO_SEM_ENVIO }, rascunhoEm, agora);
    // A Meta aprovou o modelo: é hora do pedido de envio.
    if (passo.passo === 'pedir') return this.pedir(alvo, lido.p, rascunhoEm, agora);
    return this.naEmpresa<Acompanhamento>(alvo, async (tx) => {
      if (passo.passo === 'descartar') return this.descartar(tx, alvo, passo.motivo);
      if (!(await anotarModelo(tx, alvo, passo.situacao, agora))) return { status: 'fora' };
      return { status: 'esperando', situacao: passo.situacao };
    });
  }

  /**
   * Com o modelo aprovado, monta o pedido de envio (a campanha em rascunho no RegemCast e o pedido que espera a
   * aprovação de uma pessoa, com o código do app), e a proposta acaba: daqui em diante quem manda é Aprovações.
   * Antes, as regras de agora valem de novo: quem responde pela proposta e a oferta de Minha marca.
   */
  private async pedir(alvo: DonoDaProposta, p: PropostaGuardada, rascunhoEm: Date, agora: Date): Promise<Acompanhamento> {
    // ---- 1. O banco: o modelo fica anotado como aprovado; quem responde, a oferta e o dia de hoje na marca.
    const lido = await this.naEmpresa<ParaPedir | Acompanhamento>(alvo, async (tx) => {
      if (!(await anotarModelo(tx, alvo, MODELO_APROVADO, agora))) return { status: 'fora' };
      if (!p.name || !p.coupon || !p.template_name) return this.descartar(tx, alvo, 'proposta_incompleta');
      // A rotina caiu entre montar o pedido e anotar na proposta: o pedido com o cupom desta proposta já existe.
      const jaMontado = (
        await tx.execute<{ id: string }>(sql`
          select id from liame.message_request
           where tenant_id = ${alvo.tenantId} and brand_id = ${p.brand_id} and agent_key = ${CRM.key}
             and coupon_account_id = ${p.coupon.loja} and coupon_code = ${p.coupon.codigo}
           limit 1`)
      ).rows[0];
      if (jaMontado) return (await virarPedido(tx, alvo, jaMontado.id)) ? { status: 'pedido', pedido: jaMontado.id } : { status: 'fora' };
      // O funcionário nunca pode mais do que quem o deixou propor (ADR-017): a pessoa segue na empresa, podendo definir o desconto?
      if (!p.requested_by || !(await pessoaPode(tx, { tenantId: alvo.tenantId, userId: p.requested_by, permissao: PODE_RESPONDER }))) return this.descartar(tx, alvo, 'sem_responsavel');
      const fuso = await this.resultados.fusoDaMarca(p.brand_id);
      // A oferta saiu de Minha marca enquanto o modelo esperava a Meta: a mensagem divulgaria o que a empresa já tirou.
      if (p.offer !== null) {
        const marca = await marcaDoCriativo(p.brand_id, fuso, agora);
        if (!marca || !marca.conteudo.offers.items.includes(p.offer)) return this.descartar(tx, alvo, 'oferta_mudou');
      }
      const hoje = (await tx.execute<{ dia: string }>(sql`select (${agora.toISOString()}::timestamptz at time zone ${fuso})::date::text as dia`)).rows[0]!.dia;
      return { responsavel: p.requested_by, hoje, nome: p.name, cupom: p.coupon, modelo: p.template_name };
    });
    if ('status' in lido) return lido;

    // ---- 2. O pedido de envio. O serviço abre as transações dele e fala com o RegemCast; nenhuma mensagem sai.
    let montado: PedidoMontado;
    try {
      montado = await this.pedidos.propor(
        { tenantId: alvo.tenantId, agentKey: CRM.key, agentLabel: ROTULO_DO_CRM, emNomeDe: lido.responsavel },
        propostaParaOPedido({ brandId: p.brand_id, conta: p.connected_account_id, nome: lido.nome, modelo: { nome: lido.modelo, idioma: p.template_language ?? IDIOMA_DO_MODELO }, publico: p.audience, cupom: lido.cupom }, lido.hoje),
      );
    } catch (err) {
      if (!(err instanceof AppProblem)) throw err;
      this.logger.warn(`proposta ${alvo.id}: o pedido de envio não foi montado (${err.code}): ${err.detail}`);
      // O que a proposta tem de errado não muda tentando de novo. O resto (uma chave desligada no meio, o RegemCast
      // fora do ar) espera a próxima olhada, até o prazo do modelo.
      if (err.code === 'proposta-recusada' || err.code === 'nao-encontrado') return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'pedido_recusado'));
      if (prazoDoModeloAcabou(rascunhoEm, agora)) return this.naEmpresa(alvo, (tx) => this.descartar(tx, alvo, 'prazo'));
      return { status: 'sem_leitura', motivo: err.code.replace(/[^a-z_]/g, '_').slice(0, 40) };
    }

    // ---- 3. A proposta acaba: o que vale daqui em diante é o pedido, em Aprovações.
    return this.naEmpresa<Acompanhamento>(alvo, async (tx) => ((await virarPedido(tx, alvo, montado.id)) ? { status: 'pedido', pedido: montado.id } : { status: 'fora' }));
  }

  private async lerParaRascunhar(tx: Tx, alvo: DonoDaProposta, agora: Date): Promise<ParaRascunhar | Rascunho> {
    const p = await lerProposta(tx, alvo);
    if (!p || p.status !== 'preparando' || p.body === null || p.name === null) return { status: 'fora' };
    if (!(await this.marcaViva(tx, alvo, p))) return this.encerrar(tx, alvo, 'descartada', 'marca_arquivada');
    const desligado = await this.desligado(tx, alvo, p);
    if (desligado) {
      if (!(await esperarProposta(tx, alvo, new Date(agora.getTime() + MINUTOS_DE_ESPERA_SEM_IA * MINUTO_MS)))) return { status: 'fora' };
      return { status: 'esperando', motivo: desligado };
    }
    // A mensagem sempre leva cupom: o exemplo da variável do modelo é o código dele.
    if (!p.coupon) return this.encerrar(tx, alvo, 'descartada', 'sem_cupom');
    // A conta do RegemCast da proposta foi desconectada: a mensagem não tem por onde sair.
    const conta = await lerContaDoRegemcast(tx, this.vault, { tenantId: alvo.tenantId, brandId: p.brand_id, contaId: p.connected_account_id });
    if (!conta) return this.encerrar(tx, alvo, 'descartada', 'sem_regemcast');
    const apiUrl = this.config.produtos.regemcastApiUrl;
    // Sem a autorização no cofre, ou sem o endereço do RegemCast: conta como tentativa, como o RegemCast fora do ar.
    if (!conta.credencial || !apiUrl) {
      if (p.attempts + 1 >= TENTATIVAS_DO_RASCUNHO) return this.encerrar(tx, alvo, 'falhou', 'regemcast_fora_do_ar', { attempts: p.attempts + 1 }, true);
      if (!(await adiarProposta(tx, alvo, new Date(agora.getTime() + minutosAteATentativa(p.attempts) * MINUTO_MS)))) return { status: 'fora' };
      return { status: 'falhou', motivo: 'regemcast_fora_do_ar', deVez: false };
    }
    // A conta passou a ser lida pela autorização do dono (Hub DMS, B1), que só libera leitura até a F5: o rascunho e o
    // pedido não têm por onde ser gravados, e a proposta para aqui (o mesmo motivo da rotina quando a conta não grava).
    if (!podeGravar(conta.credencial)) return this.encerrar(tx, alvo, 'descartada', 'sem_permissao');
    return { p, conta, token: conta.credencial.token, apiUrl, corpo: p.body, codigoDoCupom: p.coupon.codigo };
  }

  private async lerParaAcompanhar(tx: Tx, alvo: DonoDaProposta, agora: Date): Promise<ParaAcompanhar | Acompanhamento> {
    const p = await lerProposta(tx, alvo);
    if (!p || p.status !== 'rascunho' || p.template_name === null) return { status: 'fora' };
    if (!(await this.marcaViva(tx, alvo, p))) return this.descartar(tx, alvo, 'marca_arquivada');
    const conta = await lerContaDoRegemcast(tx, this.vault, { tenantId: alvo.tenantId, brandId: p.brand_id, contaId: p.connected_account_id });
    if (!conta) return this.descartar(tx, alvo, 'sem_regemcast');
    // Com a função ou ele desligados, a rotina não chama o RegemCast; o prazo do modelo segue contando.
    const desligado = await this.desligado(tx, alvo, p);
    if (desligado) return this.semLeitura(tx, alvo, p, desligado, agora);
    const apiUrl = this.config.produtos.regemcastApiUrl;
    if (!conta.credencial || !apiUrl) return this.semLeitura(tx, alvo, p, conta.credencial ? 'regemcast_fora_do_ar' : 'sem_autorizacao', agora);
    // Lida pela autorização do dono, a conta não deixa montar o pedido de envio no fim: a proposta para aqui.
    if (!podeGravar(conta.credencial)) return this.descartar(tx, alvo, 'sem_permissao');
    return { p, conta, token: conta.credencial.token, apiUrl, nome: p.template_name, idioma: p.template_language ?? IDIOMA_DO_MODELO };
  }

  /** Não deu para ler o modelo agora: passado o prazo, a proposta é descartada; senão, olha de novo no próximo intervalo. */
  private async semLeitura(tx: Tx, alvo: DonoDaProposta, p: PropostaGuardada, motivo: string, agora: Date): Promise<Acompanhamento> {
    const passo = passoDoModelo({ modelos: [] }, { nome: p.template_name ?? nomeDoModelo(p.motive, p.id), idioma: p.template_language ?? IDIOMA_DO_MODELO, semEnvio: MODELO_SEM_ENVIO }, new Date(p.drafted_at ?? p.created_at), agora);
    if (passo.passo === 'descartar') return this.descartar(tx, alvo, passo.motivo);
    // A situação que a proposta já tinha fica: só a hora da olhada anda.
    if (!(await anotarModelo(tx, alvo, p.template_status ?? MODELO_SEM_ENVIO, agora))) return { status: 'fora' };
    return { status: 'sem_leitura', motivo };
  }

  private async marcaViva(tx: Tx, alvo: DonoDaProposta, p: PropostaGuardada): Promise<boolean> {
    const r = await tx.execute(sql`select 1 from liame.brand where id = ${p.brand_id} and tenant_id = ${alvo.tenantId} and archived_at is null`);
    return r.rows.length === 1;
  }

  /** A chave desligada, ou ele desligado em Sua equipe: devolve o porquê, ou nulo quando ele pode trabalhar. */
  private async desligado(tx: Tx, alvo: DonoDaProposta, p: PropostaGuardada): Promise<string | null> {
    const contexto = this.flags.context({ tenantId: alvo.tenantId, brandId: p.brand_id });
    for (const [flag, motivo] of CHAVES) if (!(await this.flags.isEnabled(flag, contexto))) return motivo;
    const ativo = await funcionarioAtivo(tx, { tenantId: alvo.tenantId, brandId: p.brand_id, agentKey: CRM.key, ativoPorPadrao: CRM.ativoPorPadrao });
    return ativo ? null : 'funcionario_desligado';
  }

  /** Fecha a proposta que esperava o rascunho, com o porquê em código e a auditoria. */
  private async encerrar(tx: Tx, alvo: DonoDaProposta, fim: 'descartada' | 'falhou', motivo: string, extra: Record<string, unknown> = {}, deVez = true): Promise<Rascunho> {
    if (!(await encerrarProposta(tx, alvo, fim, motivo))) return { status: 'fora' };
    await this.auditar(tx, alvo, fim === 'descartada' ? 'mensagem.descartar' : 'mensagem.falhar', { reason: motivo, ...extra });
    return fim === 'descartada' ? { status: 'descartada', motivo } : { status: 'falhou', motivo, deVez };
  }

  /** Fecha a proposta que esperava a Meta: a Meta recusou o modelo, o prazo acabou, ou não há mais por onde enviar. */
  private async descartar(tx: Tx, alvo: DonoDaProposta, motivo: string): Promise<Acompanhamento> {
    if (!(await encerrarProposta(tx, alvo, 'descartada', motivo))) return { status: 'fora' };
    await this.auditar(tx, alvo, 'mensagem.descartar', { reason: motivo });
    return { status: 'descartada', motivo };
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

  private naEmpresa<T>(alvo: DonoDaProposta, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return naTransacaoDaEmpresa<T>(this.banco(), { tenantId: alvo.tenantId, userId: null }, () => fn(currentTx()));
  }

  private cliente(database: Database): ClienteConector {
    return new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos), tentativas: 1, tempoLimiteMs: TEMPO_DO_REGEMCAST_MS });
  }

  private banco(): Database {
    if (!this.database) throw new Error('modelo do CRM: sem banco');
    return this.database;
  }
}
