import { createHmac } from 'node:crypto';
import type { Tx } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { contaConectada } from '../connections/conectada.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { type ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { FLAG_DOS_POSTS, PROVEDOR_INSTAGRAM, PROVEDOR_PAGINA, tokenDaPagina } from '../connectors/meta/publicacao.js';
import { type CanalDoDirect, type ContaDoDirect, mensagensDaConversa } from '../direct/direct.js';
import type { ApplyOptions, ApplyResult, Connector, ReadResult, ResourceRef } from './connectors.js';
import {
  conversaDoRecurso,
  EstadoDaConversaNoDirect,
  FORA_DA_JANELA,
  janelaAberta,
  respostaNoDirectJaSaiu,
  resumoDaResposta,
  versaoDaConversaNoDirect,
} from './direct-plano.js';
import type { ResourceState } from './tools.js';

// A resposta numa conversa do Direct, pelo Action Service (A6, Z12, parte 2; P39, D-A6-107, D-A6-109 e D-A6-111), e no
// Messenger da Página (A6, Z14, parte 2; D-A6-122): o mesmo conector, com o canal (a conta do Instagram ou a da Página). Só
// com a flag de escrita dos posts (`social_write`, a do conector da conta do Instagram) e a da ferramenta
// (`direct_responder`) ligadas.
//
// - O recurso é a conversa (`direct:<id>`) da conta do Instagram ligada à marca, uma que a rotina do Direct leu
//   (`direct_conversation`): de lá vem o IGSID de quem escreveu, para onde a resposta vai.
// - O estado é a conversa como a Meta a tem na hora (lida de novo a cada pedido e a cada execução): a última mensagem da
//   pessoa e o resumo das respostas da marca depois dela. Nada de texto nem de quem é a pessoa no estado.
// - Antes de mandar: a janela de 24 horas (fora dela, a Meta recusa) e o dono da conversa (`thread_owner`: com o
//   Conversation Routing, a conversa de outro app fica com ele; sem resposta da Meta, segue, e a recusa dela no envio
//   vira a frase certa).
// - Cada execução manda UMA vez. Se a tentativa cair sem resposta, a seguinte lê a conversa antes: a resposta da marca
//   com o mesmo texto depois da última mensagem da pessoa conta como feita (não sai duas vezes).
// - O que sai fica também na conversa do Liame (`direct_message`), para a tela mostrar sem esperar a leitura.
// - O token sai do cofre só na hora de chamar e nunca vai para log, estado ou auditoria; a prova do segredo do app vai no
//   endereço (V161). O token é o da Página ligada ao Instagram, de quem tem a tarefa de mensagens.
//
// Referências (base de conhecimento §2.2, lidas em 11/11/2026): `POST /{page-id}/messages` com `recipient.id` (IGSID),
// `message.text` (até 1.000 bytes) e `messaging_type` `RESPONSE`; `GET /{page-id}/thread_owner?recipient=<IGSID>`; os
// erros 10/2534022 (fora da janela), 100/2534037 e 10/2018300 (outro app é dono da conversa) e 551 (a pessoa não aceita).

const META = 'meta_ads';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A leitura da hora do pedido não espera a Meta mais que isto: passou, a pessoa recebe "tente de novo". */
const TEMPO_DA_LEITURA_DO_PEDIDO_MS = 10_000;

/** As capacidades da Meta que a resposta usa, no registro (migrations 0130, 0131 e 0134). */
export type CapacidadeDoDirect = 'pages' | 'instagram_conversas' | 'instagram_mensagem' | 'messenger_conversas' | 'messenger_mensagem';

/** O que a resposta precisa do resto do app; ligado na subida (API e worker). */
export type DependenciasDoDirect = {
  lerSegredo: (tx: Tx, secretId: string) => Promise<string | null>;
  /** O cliente dos conectores, de uma tentativa por chamada (quem tenta de novo é o trilho, que confere antes). */
  cliente: (tempoLimiteMs?: number) => ClienteConector;
  graphUrl: string;
  appSecret: string | null;
  /** O id do app do Liame na Meta, para o dono da conversa; nulo = não confere. */
  appId: string | null;
  versao: (capacidade: CapacidadeDoDirect) => Promise<string>;
};

type Conta = { id: string; tenant_id: string; brand_id: string; external_id: string; usuario: string | null; pagina_id: string | null; credential_secret_id: string | null };
type Preparado = { conta: Conta; conversa: string; pessoa: string; token: string };
type Graph = { conta: string; token: string; tempoLimiteMs?: number };

const recusado = (mensagem: string): ApplyResult => ({ ok: false, reason: 'recusado', mensagem });
const NADA = 'Nada foi enviado.';
const SEM_ACESSO = `A Meta recusou a autorização desta conta. Conecte a Meta de novo em Contas conectadas. ${NADA}`;
const SEM_PERMISSAO = `A Meta não deixou o Liame mandar a mensagem: a autorização não tem a permissão de mensagens, ou quem autorizou não tem a tarefa de mensagens na Página. Conecte a Meta de novo em Contas conectadas. ${NADA}`;
const OUTRO_APP = `Esta conversa está com outro app na Meta (outro programa atende as mensagens desta conta), e a Meta não deixa o Liame responder. ${NADA}`;
const NAO_ACEITA = `A pessoa não aceita mensagens da marca agora (bloqueou, ou não recebe mensagens). ${NADA}`;
const SUMIU = `Esta conversa não está mais no Liame. ${NADA}`;
const FORA_DO_AMBIENTE = 'Responder no Direct não está disponível neste ambiente.';

const objeto = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** A recusa definitiva da Meta em palavras; nulo para o que é passageiro (limite, fora do ar): isso sobe e o trilho adia. */
export function recusaDoDirect(err: unknown): string | null {
  if (!(err instanceof ErroConector)) return null;
  if (err.tipo === 'autenticacao') return SEM_ACESSO;
  const codigo = err.codigoProvider ?? '';
  const sub = err.subcodigo ?? '';
  if (sub === '2534022') return `${FORA_DA_JANELA} ${NADA}`;
  if (sub === '2534037' || sub === '2018300') return OUTRO_APP;
  if (codigo === '551') return NAO_ACEITA;
  if (err.tipo === 'permissao') return SEM_PERMISSAO;
  if (err.tipo !== 'definitivo') return null;
  return `A Meta não aceitou a mensagem. ${NADA}`;
}

export class DirectNaRedeConnector implements Connector {
  readonly provider: string;
  // A flag do conector registrado (o composto com o do post, `connectors.ts`); a da ferramenta é `direct_responder`.
  readonly writeFlag = FLAG_DOS_POSTS;
  // Mandar mensagem não gasta verba de mídia.
  readonly requiresSpendLimits = false;
  private readonly logger = new Logger('direct-na-rede');
  private deps: DependenciasDoDirect | null = null;
  /** As capacidades do canal: as conversas (ler e o dono da conversa) e a mensagem. */
  private readonly conversas: CapacidadeDoDirect;
  private readonly mensagem: CapacidadeDoDirect;

  /** `instagram`: o Direct, na conta do Instagram; `messenger`: o Messenger, na conta da Página (Z14). */
  constructor(private readonly canal: CanalDoDirect = 'instagram') {
    this.provider = canal === 'messenger' ? PROVEDOR_PAGINA : PROVEDOR_INSTAGRAM;
    this.conversas = canal === 'messenger' ? 'messenger_conversas' : 'instagram_conversas';
    this.mensagem = canal === 'messenger' ? 'messenger_mensagem' : 'instagram_mensagem';
  }

  /** A marca na conversa: a Página (pelo id) no Messenger; a conta profissional (o id e o @) no Instagram. */
  private daConta(conta: Conta): ContaDoDirect {
    return this.canal === 'messenger' ? { id: conta.pagina_id!, usuario: null } : { id: conta.external_id, usuario: conta.usuario };
  }

  ligar(deps: DependenciasDoDirect): void {
    this.deps = deps;
  }

  /** A parte do banco: a conta ligada, a conversa que o Liame leu (com o IGSID) e o token. Nulo quando não é desta empresa. */
  private async preparar(tx: Tx, ref: ResourceRef, deps: DependenciasDoDirect): Promise<Preparado | null> {
    const conversa = conversaDoRecurso(ref.resourceId);
    if (!conversa || !UUID.test(ref.accountId)) return null;
    const c = await tx.execute<Conta>(sql`
      select a.id, a.tenant_id, a.brand_id, a.external_id, a.provider_attributes ->> 'usuario' as usuario,
             case when a.provider = ${PROVEDOR_PAGINA} then a.external_id else a.provider_attributes ->> 'pagina_id' end as pagina_id,
             a.credential_secret_id
        from liame.connected_account a
       where a.id = ${ref.accountId} and a.tenant_id = ${ref.tenantId} and a.provider = ${this.provider} and ${contaConectada('a')}`);
    const conta = c.rows[0];
    if (!conta || !conta.pagina_id) return null;
    const g = await tx.execute<{ participant_id: string }>(sql`
      select participant_id from liame.direct_conversation
       where connected_account_id = ${conta.id} and conversation_id = ${conversa} and tenant_id = ${ref.tenantId}`);
    const guardada = g.rows[0];
    if (!guardada) return null;
    const segredo = conta.credential_secret_id ? await deps.lerSegredo(tx, conta.credential_secret_id) : null;
    const credencial = segredo ? (JSON.parse(segredo) as CredencialGuardada) : null;
    if (!credencial || credencial.tipo !== 'meta') throw new ErroConector('autenticacao', META, 'autorização revogada ou ausente');
    return { conta, conversa, pessoa: guardada.participant_id, token: credencial.access_token };
  }

  /** Uma chamada à Graph API: o token no cabeçalho e a prova do segredo do app no endereço (nunca o token, V161). */
  private async chamar<T>(
    deps: DependenciasDoDirect,
    g: Graph,
    metodo: 'GET' | 'POST',
    caminho: string,
    capacidade: CapacidadeDoDirect,
    o: { params?: Record<string, string>; corpo?: Record<string, unknown> } = {},
  ): Promise<T | null> {
    const versao = await deps.versao(capacidade);
    const q = new URLSearchParams(o.params ?? {});
    if (deps.appSecret) q.set('appsecret_proof', createHmac('sha256', deps.appSecret).update(g.token).digest('hex'));
    const consulta = q.toString();
    const r = await deps.cliente(g.tempoLimiteMs).requisitar<T | null>({
      provider: META,
      conta: g.conta,
      url: `${deps.graphUrl}/${versao}/${caminho}${consulta ? `?${consulta}` : ''}`,
      metodo,
      endpoint: capacidade,
      apiVersion: versao,
      cabecalhos: { authorization: `Bearer ${g.token}` },
      ...(o.corpo ? { corpo: o.corpo } : {}),
    });
    return r.corpo;
  }

  /** O token da Página ligada ao Instagram, de quem tem a tarefa de mensagens. */
  private async acesso(deps: DependenciasDoDirect, p: Preparado, tempoLimiteMs?: number): Promise<Graph> {
    const daAutorizacao: Graph = { conta: p.conta.external_id, token: p.token, ...(tempoLimiteMs ? { tempoLimiteMs } : {}) };
    const contas = await this.chamar<unknown>(deps, daAutorizacao, 'GET', 'me/accounts', 'pages', { params: { fields: 'id,access_token,tasks', limit: '100' } });
    const daPagina = tokenDaPagina(contas, p.conta.pagina_id!);
    if (!daPagina) throw new ErroConector('permissao', META, 'a autorização não alcança a Página do Instagram');
    if (!daPagina.podeMandarMensagem && !daPagina.podeModerar) throw new ErroConector('permissao', META, 'quem autorizou não tem a tarefa de mensagens na Página');
    return { ...daAutorizacao, token: daPagina.token };
  }

  /** A conversa como a Meta a tem agora (as 20 mensagens mais novas). Sumiu: o estado sem ela. */
  private async ler(deps: DependenciasDoDirect, p: Preparado, g: Graph): Promise<EstadoDaConversaNoDirect> {
    const sumiu: EstadoDaConversaNoDirect = { tipo: 'direct', id: p.conversa, existe: false, ultima_da_pessoa: null, respostas_resumo: [] };
    let corpo: unknown;
    try {
      corpo = await this.chamar<unknown>(deps, g, 'GET', p.conversa, this.conversas, { params: { fields: 'messages{id,created_time,from,to,message}' } });
    } catch (err) {
      if (err instanceof ErroConector && err.tipo === 'definitivo' && (err.status === 404 || (err.codigoProvider === '100' && err.subcodigo === '33'))) return sumiu;
      throw err;
    }
    if (objeto(corpo).id !== p.conversa) return sumiu;
    const mensagens = mensagensDaConversa(corpo, this.daConta(p.conta));
    const daPessoa = mensagens.filter((m) => m.direction === 'entrada');
    const ultima = daPessoa.length ? daPessoa[daPessoa.length - 1]!.sent_at : null;
    const respostas = mensagens.filter((m) => m.direction === 'saida' && (ultima === null || m.sent_at >= ultima) && m.body).map((m) => resumoDaResposta(m.body));
    return { tipo: 'direct', id: p.conversa, existe: true, ultima_da_pessoa: ultima, respostas_resumo: respostas.slice(-20) };
  }

  /** A leitura da hora do pedido, com o tempo curto de quem tem uma pessoa esperando. */
  async read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    const deps = this.deps;
    if (!deps) throw new Error('Direct na rede: dependências não ligadas');
    const p = await this.preparar(tx, ref, deps);
    if (!p) return null;
    const g = await this.acesso(deps, p, TEMPO_DA_LEITURA_DO_PEDIDO_MS);
    const estado = await this.ler(deps, p, g);
    return { state: estado, version: versaoDaConversaNoDirect(estado) };
  }

  /**
   * O dono da conversa na Meta: com o Conversation Routing, `thread_owner` diz o app dono. Outro app = a conversa fica
   * com ele. Sem o id do app do Liame, sem resposta ou sem dono (conversa parada), segue: a recusa da Meta no envio, se
   * houver, vira a frase certa.
   */
  private async comOutroApp(deps: DependenciasDoDirect, p: Preparado, g: Graph): Promise<boolean> {
    if (!deps.appId) return false;
    try {
      const corpo = objeto(await this.chamar<unknown>(deps, g, 'GET', `${p.conta.pagina_id}/thread_owner`, this.conversas, { params: { recipient: p.pessoa } }));
      const dados = Array.isArray(corpo.data) ? (corpo.data as unknown[]) : [];
      const dono = objeto(objeto(dados[0]).thread_owner).app_id;
      const app = typeof dono === 'string' || typeof dono === 'number' ? String(dono) : null;
      return app !== null && app !== deps.appId;
    } catch (err) {
      if (!(err instanceof ErroConector)) throw err;
      this.logger.warn(`conta ${p.conta.id}: não deu para ler o dono da conversa (${err.tipo}, código ${err.codigoProvider ?? '?'}); segue para o envio`);
      return false;
    }
  }

  async apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options: ApplyOptions = {}): Promise<ApplyResult> {
    const deps = this.deps;
    if (!deps) return recusado(FORA_DO_AMBIENTE);
    const quer = EstadoDaConversaNoDirect.safeParse(desired);
    if (!quer.success || !quer.data.resposta) return recusado(`O pedido não é de uma resposta no Direct. ${NADA}`);
    const texto = quer.data.resposta.texto;
    let p: Preparado | null = null;
    let g: Graph | null = null;
    let atual: EstadoDaConversaNoDirect | null = null;
    try {
      p = await this.preparar(tx, ref, deps);
      if (p) {
        g = await this.acesso(deps, p);
        atual = await this.ler(deps, p, g);
      }
    } catch (err) {
      const motivo = recusaDoDirect(err);
      if (motivo) return recusado(motivo);
      throw err;
    }
    if (!p || !g || !atual) return recusado(SUMIU);
    if (quer.data.id !== atual.id) return recusado(`O pedido não é desta conversa. ${NADA}`);
    // Já saiu (a tentativa anterior caiu depois de a Meta aceitar): nada a mandar de novo.
    if (respostaNoDirectJaSaiu(atual, desired)) {
      return { ok: true, state: atual, version: versaoDaConversaNoDirect(atual) };
    }
    const versao = versaoDaConversaNoDirect(atual);
    // A conversa mudou desde o pedido (a pessoa escreveu de novo, a marca respondeu por fora): nada é feito.
    if (versao !== expectedVersion) return { ok: false, reason: 'estado-mudou', current: { state: atual, version: versao } };
    if (!atual.existe) return recusado(SUMIU);
    if (!janelaAberta(atual.ultima_da_pessoa, new Date())) return recusado(`${FORA_DA_JANELA} ${NADA}`);
    if (options.validateOnly) return { ok: true, state: desired, version: versao };
    if (await this.comOutroApp(deps, p, g)) return recusado(OUTRO_APP);

    try {
      const enviada = objeto(
        await this.chamar<unknown>(deps, g, 'POST', `${p.conta.pagina_id}/messages`, this.mensagem, {
          corpo: { recipient: { id: p.pessoa }, message: { text: texto }, messaging_type: 'RESPONSE' },
        }),
      );
      const id = typeof enviada.message_id === 'string' && enviada.message_id.length <= 300 ? enviada.message_id : null;
      await this.refletir(tx, p, texto, id);
      const depois: EstadoDaConversaNoDirect = { ...atual, respostas_resumo: [...atual.respostas_resumo, resumoDaResposta(texto)].slice(-20) };
      return { ok: true, state: depois, version: versaoDaConversaNoDirect(depois) };
    } catch (err) {
      const motivo = recusaDoDirect(err);
      if (!motivo) throw err;
      // O que a Meta disse fica no registro, para quem cuida do produto; a pessoa lê a frase em português.
      if (err instanceof ErroConector) this.logger.warn(`conta ${p.conta.id}: a Meta recusou a mensagem (${err.tipo}, HTTP ${err.status ?? '?'}, código ${err.codigoProvider ?? '?'}/${err.subcodigo ?? '?'}): ${err.message}`);
      return recusado(motivo);
    }
  }

  /**
   * O que saiu fica também na conversa do Liame, para a tela mostrar sem esperar a leitura: a mensagem da marca (pelo id da
   * Meta; sem ele, a leitura seguinte a traz) e a conversa respondida.
   */
  private async refletir(tx: Tx, p: Preparado, texto: string, id: string | null): Promise<void> {
    if (id) {
      await tx.execute(sql`
        insert into liame.direct_message (connected_account_id, tenant_id, brand_id, conversation_id, message_id, direction, kind, body, sent_at)
        values (${p.conta.id}, ${p.conta.tenant_id}, ${p.conta.brand_id}, ${p.conversa}, ${id}, 'saida', 'texto', ${texto.slice(0, 4000)}, now())
        on conflict (connected_account_id, message_id) do nothing`);
    }
    await tx.execute(sql`
      update liame.direct_conversation
         set last_message_at = greatest(last_message_at, now()), last_direction = 'saida', unread = false, concluded_at = null
       where connected_account_id = ${p.conta.id} and conversation_id = ${p.conversa} and tenant_id = ${p.conta.tenant_id}`);
  }
}

export const directNoInstagramConnector = new DirectNaRedeConnector('instagram');
/** O Messenger da Página (A6, Z14, parte 2): o mesmo conector, na conta da Página. */
export const directNoMessengerConnector = new DirectNaRedeConnector('messenger');
