import { createHmac } from 'node:crypto';
import type { Tx } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { chaveDoAutor } from '../comentarios/comentarios.js';
import { contaConectada } from '../connections/conectada.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { type ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { FLAG_DOS_POSTS, horaDoInstagram, PROVEDOR_INSTAGRAM, PROVEDOR_PAGINA, tokenDaPagina } from '../connectors/meta/publicacao.js';
import { textoGuardavel } from '../fotos/do-seu-instagram.js';
import { type ContextoDoComentario, EstadoDoComentario, jaComoOPedidoQueria, resumoDoComentario, versaoDoComentario } from './comentario-plano.js';
import type { ApplyOptions, ApplyResult, Connector, ReadResult, ResourceRef } from './connectors.js';
import type { ResourceState } from './tools.js';

// O comentário de um post da marca na rede, pelo Action Service (A6, Z11, parte 2; P38, D-A6-88 e D-A6-89): responder
// com o texto que uma pessoa aprovou, apagar a resposta que o Liame publicou, ocultar e mostrar de novo. Só com a flag
// de escrita dos posts (`social_write`, a do conector) e a da ferramenta (`comentarios_responder`) ligadas.
//
// O recurso é o comentário: `resource_id` = `comentario:<id dele na rede>`; `account_id` é a conta da rede (o Instagram
// ou a Página) ligada à marca. O comentário precisa ser um que o Liame leu (`social_comment`): o pedido não alcança o
// que a rotina da leitura não trouxe.
//
// - O estado é o comentário como a rede o tem na hora (lido de novo a cada pedido e a cada execução), sem o texto dele e
//   sem nada de quem comentou: no pedido vai só o resumo criptográfico do texto. O @ ou o nome de quem comentou é lido
//   junto, só para o plano conferir que a resposta não o cita.
// - A versão sai do estado. Se o comentário mudou entre o pedido e a execução (sumiu, foi ocultado ou mostrado, ganhou
//   ou perdeu a resposta da marca), nada é feito: é "estado mudou".
// - Cada execução manda UMA vez. Se a tentativa cair sem resposta da rede, a seguinte lê o comentário antes: a resposta
//   da marca com o mesmo texto já lá, ou o comentário já oculto, conta como feito (a resposta não sai duas vezes).
// - O que a execução muda na rede fica também em `social_comment`, para a tela Comentários mostrar sem esperar a leitura.
// - O token sai do cofre só na hora de chamar e nunca vai para log, estado ou auditoria; a prova do segredo do app vai
//   no endereço, nunca o token (V161). Na Página, o token é o dela, de quem tem a tarefa de moderar.
//
// Referências (base de conhecimento §2.2, lidas em 07/11/2026): no Instagram, `GET /{ig-comment-id}` (os campos do
// comentário, com `replies`), `POST /{ig-comment-id}/replies` com `message` (só ao comentário de primeiro nível; não ao
// oculto), `POST /{ig-comment-id}` com `hide` e `DELETE /{ig-comment-id}` (só o dono da mídia); na Página,
// `GET /{comment-id}` (com `comments` para as respostas), `POST /{comment-id}/comments` com `message`,
// `POST /{comment-id}` com `is_hidden` e `DELETE /{comment-id}`.

const META = 'meta_ads';
const PREFIXO = 'comentario:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A leitura da hora do pedido não espera a Meta mais que isto: passou, a pessoa recebe "tente de novo". */
const TEMPO_DA_LEITURA_DO_PEDIDO_MS = 10_000;

/** As capacidades da Meta que o comentário usa, no registro (migrations 0123 e 0124). */
export type CapacidadeDoComentario = 'instagram_comments' | 'instagram_comment_moderate' | 'pages' | 'pagina_comments' | 'pagina_comment_moderate';

/** Id da rede no caminho de um endereço: só dígitos e `_`, de 1 a 120 (conferido letra a letra). */
function idDaRede(v: string): string | null {
  if (v.length === 0 || v.length > 120) return null;
  for (const c of v) if ((c < '0' || c > '9') && c !== '_') return null;
  return v;
}

/** `comentario:<id>` → o id do comentário na rede. */
export function comentarioDoRecurso(resourceId: string): string | null {
  return resourceId.startsWith(PREFIXO) ? idDaRede(resourceId.slice(PREFIXO.length)) : null;
}

/** O recurso de um comentário, para quem monta o pedido. */
export const recursoDoComentario = (id: string): string => `${PREFIXO}${id}`;

/** O que o comentário precisa do resto do app; ligado na subida (API e worker). */
export type DependenciasDoComentario = {
  lerSegredo: (tx: Tx, secretId: string) => Promise<string | null>;
  /** O cliente dos conectores, de uma tentativa por chamada (quem tenta de novo é o trilho, que confere antes). */
  cliente: (tempoLimiteMs?: number) => ClienteConector;
  graphUrl: string;
  appSecret: string | null;
  versao: (capacidade: CapacidadeDoComentario) => Promise<string>;
};

type Conta = { id: string; tenant_id: string; brand_id: string; external_id: string; usuario: string | null; credential_secret_id: string | null };
type Guardado = { post_id: string; channel: 'instagram' | 'facebook' };
type Preparado = { conta: Conta; comentario: string; guardado: Guardado; token: string };
type Graph = { conta: string; token: string; tempoLimiteMs?: number };

/** O que a leitura da rede deu: o estado e o @ ou o nome de quem comentou (só para o plano conferir). */
type Lido = { estado: EstadoDoComentario; quem: string | null };

const recusado = (mensagem: string): ApplyResult => ({ ok: false, reason: 'recusado', mensagem });

type Operacao = NonNullable<EstadoDoComentario['operacao']>;
const NADA_FEITO: Record<Operacao, string> = {
  responder: 'Nada foi publicado.',
  apagar_resposta: 'A resposta continua na rede.',
  ocultar: 'O comentário continua à vista.',
  mostrar: 'O comentário continua oculto.',
};
const VERBO: Record<Operacao, string> = { responder: 'responder', apagar_resposta: 'apagar a resposta', ocultar: 'ocultar o comentário', mostrar: 'mostrar o comentário' };
const SEM_ACESSO = 'A Meta recusou a autorização desta conta. Conecte a Meta de novo em Contas conectadas.';
const SEM_PERMISSAO = (op: Operacao) =>
  `A Meta não deixou o Liame ${VERBO[op]}: a autorização da Meta não tem a permissão de comentários, ou quem autorizou não modera mais a Página. Conecte a Meta de novo em Contas conectadas.`;
const SUMIU = 'Este comentário não está mais na rede: quem escreveu apagou, ou a conta restringiu quem fez.';
const SUMIU_A_CONTA = 'A conta deste comentário foi desligada do Liame depois do pedido.';
const FORA_DO_AMBIENTE = 'Responder e ocultar comentários não está disponível neste ambiente.';
const NAO_E_DESTE = 'O pedido não é deste comentário.';
const NAO_ACEITOU: Record<Operacao, string> = {
  responder: 'A Meta não aceitou a resposta.',
  apagar_resposta: 'A Meta não deixou apagar a resposta.',
  ocultar: 'A Meta não deixou ocultar o comentário.',
  mostrar: 'A Meta não deixou mostrar o comentário de novo.',
};

/** O objeto que a Meta não acha (o código 100 com o subcódigo 33, ou o 404): o comentário saiu da rede. */
function naoExiste(err: unknown): boolean {
  return err instanceof ErroConector && err.tipo === 'definitivo' && (err.status === 404 || (err.codigoProvider === '100' && err.subcodigo === '33'));
}

/**
 * A recusa definitiva da Meta em palavras; nulo para o que é passageiro (limite, fora do ar): isso sobe para quem
 * executa adiar. O texto da Meta não vai para a pessoa (vem em inglês e é de quem programa): fica no registro.
 */
export function recusaDoComentario(err: unknown, op: Operacao): string | null {
  if (!(err instanceof ErroConector)) return null;
  if (err.tipo === 'autenticacao') return `${SEM_ACESSO} ${NADA_FEITO[op]}`;
  if (err.tipo === 'permissao') return `${SEM_PERMISSAO(op)} ${NADA_FEITO[op]}`;
  if (err.tipo !== 'definitivo') return null;
  if (naoExiste(err)) return op === 'responder' ? `${SUMIU} ${NADA_FEITO.responder}` : SUMIU;
  return `${NAO_ACEITOU[op]} ${NADA_FEITO[op]}`;
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const objeto = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

export class ComentarioNaRedeConnector implements Connector {
  constructor(readonly provider: typeof PROVEDOR_INSTAGRAM | typeof PROVEDOR_PAGINA) {}
  // A flag do conector registrado (o composto com o do post, `connectors.ts`); a da ferramenta é `comentarios_responder`.
  readonly writeFlag = FLAG_DOS_POSTS;
  // Responder, ocultar e mostrar não gastam verba de mídia.
  readonly requiresSpendLimits = false;
  private readonly logger = new Logger('comentario-na-rede');
  private deps: DependenciasDoComentario | null = null;

  ligar(deps: DependenciasDoComentario): void {
    this.deps = deps;
  }

  private get canal(): 'instagram' | 'facebook' {
    return this.provider === PROVEDOR_PAGINA ? 'facebook' : 'instagram';
  }

  /** A parte do banco: a conta ligada, o comentário que o Liame leu e o token. Nulo quando não é desta empresa. */
  private async preparar(tx: Tx, ref: ResourceRef, deps: DependenciasDoComentario): Promise<Preparado | null> {
    const comentario = comentarioDoRecurso(ref.resourceId);
    if (!comentario || !UUID.test(ref.accountId)) return null;
    const c = await tx.execute<Conta>(sql`
      select a.id, a.tenant_id, a.brand_id, a.external_id, a.provider_attributes ->> 'usuario' as usuario, a.credential_secret_id
        from liame.connected_account a
       where a.id = ${ref.accountId} and a.tenant_id = ${ref.tenantId} and a.provider = ${this.provider} and ${contaConectada('a')}`);
    const conta = c.rows[0];
    if (!conta) return null;
    const g = await tx.execute<Guardado>(sql`
      select post_id, channel from liame.social_comment
       where connected_account_id = ${conta.id} and comment_id = ${comentario} and tenant_id = ${ref.tenantId}`);
    const guardado = g.rows[0];
    if (!guardado) return null;
    const segredo = conta.credential_secret_id ? await deps.lerSegredo(tx, conta.credential_secret_id) : null;
    const credencial = segredo ? (JSON.parse(segredo) as CredencialGuardada) : null;
    if (!credencial || credencial.tipo !== 'meta') throw new ErroConector('autenticacao', META, 'autorização revogada ou ausente');
    return { conta, comentario, guardado, token: credencial.access_token };
  }

  /** Uma chamada à Graph API: o token no cabeçalho e a prova do segredo do app no endereço (nunca o token, V161). */
  private async chamar<T>(
    deps: DependenciasDoComentario,
    g: Graph,
    metodo: 'GET' | 'POST' | 'DELETE',
    caminho: string,
    capacidade: CapacidadeDoComentario,
    o: { params?: Record<string, string>; corpo?: Record<string, string> } = {},
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

  /** O acesso à rede: no Instagram, o token da autorização; na Página, o dela, de quem pode moderar. */
  private async acesso(deps: DependenciasDoComentario, p: Preparado, tempoLimiteMs?: number): Promise<Graph> {
    const daAutorizacao: Graph = { conta: p.conta.external_id, token: p.token, ...(tempoLimiteMs ? { tempoLimiteMs } : {}) };
    if (this.provider !== PROVEDOR_PAGINA) return daAutorizacao;
    const contas = await this.chamar<unknown>(deps, daAutorizacao, 'GET', 'me/accounts', 'pages', { params: { fields: 'id,access_token,tasks', limit: '100' } });
    const daPagina = tokenDaPagina(contas, p.conta.external_id);
    if (!daPagina) throw new ErroConector('permissao', META, 'a autorização não alcança a Página');
    if (!daPagina.podeModerar) throw new ErroConector('permissao', META, 'quem autorizou não tem a tarefa de moderar a Página');
    return { ...daAutorizacao, token: daPagina.token };
  }

  /** O comentário como a rede o tem agora, com a resposta mais nova da marca. Sumiu: o estado sem ele. */
  private async ler(deps: DependenciasDoComentario, p: Preparado, g: Graph): Promise<Lido> {
    const ehPagina = this.provider === PROVEDOR_PAGINA;
    const base = { tipo: 'comentario' as const, canal: this.canal, id: p.comentario, post_id: p.guardado.post_id };
    const sumiu: Lido = { estado: { ...base, existe: false, oculto: false, primeiro_nivel: true, da_marca: false, feito_em: null, texto_resumo: null, resposta: null }, quem: null };
    let corpo: unknown;
    try {
      corpo = await this.chamar<unknown>(deps, g, 'GET', p.comentario, ehPagina ? 'pagina_comments' : 'instagram_comments', {
        params: {
          fields: ehPagina
            ? 'id,message,created_time,from,is_hidden,parent{id},comments.limit(50){id,message,created_time,from}'
            : 'id,text,timestamp,username,from,hidden,parent_id,replies.limit(50){id,text,timestamp,username,from}',
        },
      });
    } catch (err) {
      if (naoExiste(err)) return sumiu;
      throw err;
    }
    const m = objeto(corpo);
    if (texto(m.id) !== p.comentario) return sumiu;
    const de = objeto(m.from);
    const daMarca = (quemId: string | null, usuario: string | null): boolean =>
      (quemId !== null && quemId === p.conta.external_id) || (!ehPagina && usuario !== null && p.conta.usuario !== null && usuario.toLowerCase() === p.conta.usuario.toLowerCase());
    const usuario = ehPagina ? null : (texto(m.username) ?? texto(de.username));
    const quem = ehPagina ? texto(de.name) : usuario;
    const filhas = objeto(ehPagina ? m.comments : m.replies).data;
    let resposta: EstadoDoComentario['resposta'] = null;
    let maisNova = Number.NEGATIVE_INFINITY;
    for (const f of Array.isArray(filhas) ? filhas : []) {
      const r = objeto(f);
      const rDe = objeto(r.from);
      const rUsuario = ehPagina ? null : (texto(r.username) ?? texto(rDe.username));
      const id = texto(r.id);
      const hora = horaDoInstagram(ehPagina ? r.created_time : r.timestamp);
      if (!id || !daMarca(texto(rDe.id), rUsuario)) continue;
      const quando = Number.isNaN(hora) ? 0 : hora;
      if (quando >= maisNova) {
        maisNova = quando;
        resposta = { id, texto: textoGuardavel(ehPagina ? r.message : r.text, 8000) };
      }
    }
    const hora = horaDoInstagram(ehPagina ? m.created_time : m.timestamp);
    const pai = ehPagina ? texto(objeto(m.parent).id) : texto(m.parent_id);
    const estado: EstadoDoComentario = {
      ...base,
      existe: true,
      oculto: (ehPagina ? m.is_hidden : m.hidden) === true,
      primeiro_nivel: pai === null,
      da_marca: daMarca(texto(de.id), usuario),
      feito_em: Number.isNaN(hora) ? null : new Date(hora).toISOString(),
      texto_resumo: resumoDoComentario(textoGuardavel(ehPagina ? m.message : m.text, 8000)),
      resposta,
    };
    return { estado, quem };
  }

  /** A leitura da hora do pedido, com o tempo curto de quem tem uma pessoa esperando. */
  async read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    const deps = this.deps;
    if (!deps) throw new Error('comentário na rede: dependências não ligadas');
    const p = await this.preparar(tx, ref, deps);
    if (!p) return null;
    const g = await this.acesso(deps, p, TEMPO_DA_LEITURA_DO_PEDIDO_MS);
    const lido = await this.ler(deps, p, g);
    // O @ ou o nome de quem comentou vai só para o plano conferir o texto: não entra no estado.
    const contexto: ContextoDoComentario = { quem: lido.quem };
    return { state: lido.estado, version: versaoDoComentario(lido.estado), transient: contexto };
  }

  async apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options: ApplyOptions = {}): Promise<ApplyResult> {
    const deps = this.deps;
    if (!deps) return recusado(FORA_DO_AMBIENTE);
    const quer = EstadoDoComentario.safeParse(desired);
    const op: Operacao = quer.success && quer.data.operacao ? quer.data.operacao : 'responder';
    const nada = NADA_FEITO[op];
    let p: Preparado | null = null;
    let g: Graph | null = null;
    let lido: Lido | null = null;
    try {
      p = await this.preparar(tx, ref, deps);
      if (p) {
        g = await this.acesso(deps, p);
        lido = await this.ler(deps, p, g);
      }
    } catch (err) {
      const motivo = recusaDoComentario(err, op);
      if (motivo) return recusado(motivo);
      throw err;
    }
    if (!p || !g || !lido) return recusado(`${SUMIU_A_CONTA} ${nada}`);
    const atual = lido.estado;
    const versao = versaoDoComentario(atual);
    if (!quer.success || !quer.data.operacao || quer.data.id !== atual.id) return recusado(`${NAO_E_DESTE} ${nada}`);
    // Já está como o pedido queria (a tentativa anterior caiu depois de a rede aceitar): nada a mandar de novo.
    if (jaComoOPedidoQueria(atual, desired)) {
      if (!options.validateOnly) await this.refletir(tx, p, op, atual);
      return { ok: true, state: atual, version: versao };
    }
    // O comentário mudou desde o pedido, sumiu, ou a resposta já não é a mesma: nada é feito.
    if (versao !== expectedVersion) return { ok: false, reason: 'estado-mudou', current: { state: atual, version: versao } };
    if (!atual.existe) return recusado(op === 'responder' ? `${SUMIU} ${nada}` : SUMIU);
    if (options.validateOnly) return { ok: true, state: desired, version: versao };

    const ehPagina = this.provider === PROVEDOR_PAGINA;
    const moderar = ehPagina ? 'pagina_comment_moderate' : 'instagram_comment_moderate';
    try {
      let depois: EstadoDoComentario;
      if (op === 'responder') {
        const texto = quer.data.resposta?.texto ?? '';
        const criada = objeto(await this.chamar<unknown>(deps, g, 'POST', `${atual.id}/${ehPagina ? 'comments' : 'replies'}`, moderar, { corpo: { message: texto } }));
        const id = typeof criada.id === 'string' && idDaRede(criada.id) ? criada.id : null;
        // Sem o id na volta, a resposta saiu (a Meta aceitou), mas o Liame não sabe qual é: a leitura seguinte a traz.
        depois = { ...atual, resposta: id ? { id, texto } : null };
      } else if (op === 'apagar_resposta') {
        const resposta = atual.resposta;
        if (!resposta) return recusado('Este comentário não tem resposta da marca: não há o que apagar.');
        await this.chamar<unknown>(deps, g, 'DELETE', resposta.id, moderar);
        depois = { ...atual, resposta: null };
      } else {
        const oculto = op === 'ocultar';
        await this.chamar<unknown>(deps, g, 'POST', atual.id, moderar, ehPagina ? { corpo: { is_hidden: String(oculto) } } : { params: { hide: String(oculto) } });
        depois = { ...atual, oculto };
      }
      await this.refletir(tx, p, op, depois, atual);
      return { ok: true, state: depois, version: versaoDoComentario(depois) };
    } catch (err) {
      const motivo = recusaDoComentario(err, op);
      if (!motivo) throw err;
      // O que a Meta disse fica no registro, para quem cuida do produto; a pessoa lê a frase em português.
      if (err instanceof ErroConector) this.logger.warn(`conta ${p.conta.id}: a Meta recusou ${VERBO[op]} (${err.tipo}, HTTP ${err.status ?? '?'}, código ${err.codigoProvider ?? '?'}): ${err.message}`);
      return recusado(motivo);
    }
  }

  /**
   * O que a execução mudou na rede fica também em `social_comment`, para a tela mostrar sem esperar a leitura: a
   * visibilidade do comentário, a resposta da marca que entrou ou a que saiu. `antes`: o estado lido antes de mudar (a
   * resposta apagada sai pelo id dele).
   */
  private async refletir(tx: Tx, p: Preparado, op: Operacao, depois: EstadoDoComentario, antes?: EstadoDoComentario): Promise<void> {
    const conta = p.conta.id;
    await tx.execute(sql`
      update liame.social_comment set hidden = ${depois.oculto}, read_at = now()
       where connected_account_id = ${conta} and comment_id = ${depois.id}`);
    if (op === 'responder' && depois.resposta) {
      await tx.execute(sql`
        insert into liame.social_comment (connected_account_id, tenant_id, brand_id, comment_id, post_id, channel, parent_comment_id, author_name,
                                          author_key, by_brand, message, published_at)
        values (${conta}, ${p.conta.tenant_id}, ${p.conta.brand_id}, ${depois.resposta.id}, ${p.guardado.post_id}, ${p.guardado.channel}, ${depois.id},
                ${this.provider === PROVEDOR_PAGINA ? null : p.conta.usuario}, ${chaveDoAutor(this.canal, p.conta.external_id, null)}, true,
                ${textoGuardavel(depois.resposta.texto, 8000)}, now())
        on conflict (connected_account_id, comment_id) do nothing`);
    }
    if (op === 'apagar_resposta' && antes?.resposta) {
      await tx.execute(sql`delete from liame.social_comment where connected_account_id = ${conta} and comment_id = ${antes.resposta.id} and by_brand`);
    }
  }
}

export const comentarioNoInstagramConnector = new ComentarioNaRedeConnector(PROVEDOR_INSTAGRAM);
export const comentarioNaPaginaConnector = new ComentarioNaRedeConnector(PROVEDOR_PAGINA);
