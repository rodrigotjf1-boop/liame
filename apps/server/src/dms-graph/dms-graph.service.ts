import {
  type BrandPhoto,
  type BrandPhotoEditPreview,
  type CreateBrandPhotoEditRequest,
  type DmsGraphCallbackRequest,
  type DmsGraphCallbackResponse,
  type DmsGraphQuota,
  type DmsGraphSituation,
  type DmsGraphStartResponse,
  problemaDoPedidoDaFoto,
} from '@liame/contracts';
import { type Database, uuidv7 } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { activeTraceId, writeAudit } from '../audit/audit.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { clienteDoDmsIdDoProcesso } from '../connectors/dms/dms-id.js';
import { ClienteMcp, montarChaveIdempotencia } from '../connectors/dms/integracao-dms.js';
import { type AuthContext, currentTx } from '../context/request-context.js';
import { actorLabel, actorTypeOf } from '../context/unit-of-work.interceptor.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { chaveDaFoto, chaveDaMiniatura } from '../fotos/conferencia.js';
import { FotosService, quemPede, RECURSO, VALIDADE_DO_ENDERECO_S } from '../fotos/fotos.service.js';
import { processarFoto, RecusaDaFoto } from '../fotos/processar.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens } from '../imagens/armazem.js';
import { VaultService } from '../vault/vault.service.js';
import {
  conferirVolta,
  corpoDoPedido,
  FERRAMENTA_CAPACIDADES,
  FERRAMENTA_EDITAR,
  falhaDoGraph,
  FLAG_DMS_GRAPH_FOTOS,
  formatoDoNumero,
  FOTO_MAX_BYTES,
  franquiaDe,
  gerarPedido,
  hashDoEstado,
  instrucaoDaEdicao,
  ligacaoDaTroca,
  PERMISSAO_EDITAR,
  PERMISSOES_DO_LIAME,
  pedidoLimpo,
  RESULTADO_MAX_BYTES,
  temPedidoDeEdicao,
  urlDaPagina,
  VALIDADE_DO_PEDIDO_MS,
} from './dms-graph.regras.js';

// O DMS Graph no Liame (F4; migration 0164): a ligação da empresa pelo clique e a edição da foto real. Nenhuma chamada ao
// Graph roda com transação aberta: a edição leva até 1 minuto e seguraria uma conexão do banco.

const ACAO_LIGOU = 'dms_graph.ligou';
const ACAO_DESLIGOU = 'dms_graph.desligou';
const ACAO_CNPJ = 'dms_graph.cnpj';
const ACAO_EDITOU = 'fotos.editar_guardar';
const PRAZO_DA_EDICAO_MS = 75_000;
const PRAZO_DA_LEITURA_MS = 8_000;

type Quem = { tenantId: string; userId: string };
type LinhaDaLigacao = {
  id: string;
  secret_id: string | null;
  graph_account_name: string | null;
  permissions: string[];
  created_at: Date | string;
  created_by_name: string | null;
  last_used_at: Date | string | null;
};

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const comece = 'Comece de novo pelo botão “Conectar ao DMS Graph”.';

function naoDisponivel(): AppProblem {
  return new AppProblem(409, 'funcao-desligada', 'Função desligada', 'O DMS Graph não está ligado para esta empresa.');
}

@Injectable()
export class DmsGraphService {
  private readonly logger = new Logger('dms-graph');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ARMAZEM_DE_IMAGENS) private readonly armazem: ArmazemDeImagens,
    private readonly flags: FlagService,
    private readonly vault: VaultService,
    private readonly fotos: FotosService,
  ) {}

  private banco(): Database {
    if (!this.database) throw new AppProblem(503, 'banco-indisponivel', 'Banco indisponível', 'Tente de novo em instantes.');
    return this.database;
  }

  private get origem(): string {
    return new URL(this.config.produtos.dmsGraphUrl).origin;
  }

  private get porta(): string {
    return `${this.origem}/mcp`;
  }

  private get volta(): string {
    return `${this.config.appUrl}/contas/graph/volta`;
  }

  private dmsId(): NonNullable<AppConfig['dmsId']> {
    if (!this.config.dmsId) throw naoDisponivel();
    return this.config.dmsId;
  }

  private ligada(quem: Quem): Promise<boolean> {
    if (!this.config.dmsId) return Promise.resolve(false);
    return this.flags.isEnabled(FLAG_DMS_GRAPH_FOTOS, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId }));
  }

  private async exigirLigada(quem: Quem): Promise<void> {
    if (!(await this.ligada(quem))) throw naoDisponivel();
  }

  /** Só à porta do Graph e sem seguir redirecionamento: o token não vai a outro endereço. */
  private buscarNoGraph: typeof fetch = (entrada, init) => {
    const url = typeof entrada === 'string' ? entrada : entrada instanceof URL ? entrada.href : entrada.url;
    if (new URL(url).origin !== this.origem) return Promise.reject(new Error('endereço fora do DMS Graph'));
    return fetch(url, { ...init, redirect: 'error' });
  };

  private clienteMcp(ligacao: string, prazoMs: number): ClienteMcp {
    return new ClienteMcp({
      endereco: this.porta,
      recurso: this.porta,
      permissoes: PERMISSOES_DO_LIAME,
      dmsId: clienteDoDmsIdDoProcesso(this.dmsId()),
      ligacao,
      cliente: { nome: 'liame', versao: (process.env.APP_VERSION ?? '').trim() || 'desconhecida' },
      buscar: this.buscarNoGraph,
      // Quem repete é a pessoa: a imagem leva até 1 minuto e ela está esperando.
      tentativas: 1,
      tempoLimiteMs: prazoMs,
    });
  }

  private async chamarOClique(caminho: string, corpo: unknown, cabecalhos: Record<string, string> = {}, metodo = 'POST') {
    let token: string;
    try {
      token = await clienteDoDmsIdDoProcesso(this.dmsId()).token(this.porta, PERMISSOES_DO_LIAME);
    } catch (e) {
      this.logger.warn(`o DMS ID não entregou o token do Liame (${e instanceof Error ? e.message : 'erro'})`);
      throw new AppProblem(503, 'graph-indisponivel', 'DMS ID indisponível', 'O DMS ID não respondeu agora. Tente de novo em instantes.');
    }
    let r: Response;
    try {
      r = await this.buscarNoGraph(new URL(caminho, this.origem).href, {
        method: metodo,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', ...cabecalhos },
        body: metodo === 'DELETE' ? undefined : JSON.stringify(corpo),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      this.logger.warn(`sem resposta do DMS Graph em ${caminho} (${e instanceof Error ? e.name : 'erro'})`);
      throw new AppProblem(503, 'graph-indisponivel', 'DMS Graph indisponível', 'O DMS Graph não respondeu agora. Tente de novo em instantes.');
    }
    return { status: r.status, corpo: (await r.json().catch(() => null)) as Record<string, unknown> | null };
  }

  private async ligacaoViva(quem: Quem): Promise<(LinhaDaLigacao & { segredo: string | null }) | null> {
    return naTransacaoDaEmpresa(this.banco(), quem, async () => {
      const tx = currentTx();
      const r = await tx.execute<LinhaDaLigacao>(sql`
        select id, secret_id, graph_account_name, permissions, created_at, created_by_name, last_used_at
          from liame.dms_graph_link where tenant_id = ${quem.tenantId} and revoked_at is null limit 1`);
      const l = r.rows[0];
      if (!l) return null;
      return { ...l, segredo: l.secret_id ? await this.vault.readSecret(tx, l.secret_id) : null };
    });
  }

  /** O que o cartão e a gaveta mostram. Desligado para a empresa: só `enabled: false`. */
  async situacao(auth: AuthContext): Promise<DmsGraphSituation> {
    const quem = quemPede(auth);
    const base: DmsGraphSituation = {
      enabled: false,
      can_connect: auth.permissions.has('contas.conectar'),
      can_edit: auth.permissions.has('fotos.enviar'),
      company_has_cnpj: false,
      link: null,
      revoked_by_graph_at: null,
      quota: null,
    };
    if (!(await this.ligada(quem))) return base;
    const lido = await naTransacaoDaEmpresa(this.banco(), quem, async () => {
      const tx = currentTx();
      const org = await tx.execute<{ cnpj: string | null }>(sql`select cnpj from liame.organization where id = ${quem.tenantId}`);
      const u = await tx.execute<LinhaDaLigacao & { revoked_at: Date | string | null; revoked_source: string | null }>(sql`
        select id, secret_id, graph_account_name, permissions, created_at, created_by_name, last_used_at, revoked_at, revoked_source
          from liame.dms_graph_link where tenant_id = ${quem.tenantId}
         order by (revoked_at is null) desc, created_at desc limit 1`);
      const l = u.rows[0] ?? null;
      return { temCnpj: /^\d{14}$/.test(org.rows[0]?.cnpj ?? ''), l, segredo: l && !l.revoked_at && l.secret_id ? await this.vault.readSecret(tx, l.secret_id) : null };
    });
    const { l, temCnpj, segredo } = lido;
    if (!l || l.revoked_at) {
      return { ...base, enabled: true, company_has_cnpj: temCnpj, revoked_by_graph_at: l?.revoked_at && l.revoked_source === 'graph' ? iso(l.revoked_at) : null };
    }
    return {
      ...base,
      enabled: true,
      company_has_cnpj: temCnpj,
      link: {
        account_name: l.graph_account_name,
        connected_at: iso(l.created_at),
        connected_by: l.created_by_name,
        permissions: l.permissions ?? [],
        last_used_at: l.last_used_at ? iso(l.last_used_at) : null,
      },
      quota: segredo ? await this.franquiaAgora(quem, l.id, segredo) : null,
    };
  }

  /** A franquia pela ferramenta que só lê. Nunca derruba a tela: sem resposta, a franquia vem nula. */
  private async franquiaAgora(quem: Quem, ligacaoId: string, segredo: string): Promise<DmsGraphQuota | null> {
    try {
      const r = await this.clienteMcp(segredo, PRAZO_DA_LEITURA_MS).chamar<{ franquias?: { imagem?: unknown } }>(FERRAMENTA_CAPACIDADES, {}, { leitura: true });
      return franquiaDe(r?.franquias?.imagem);
    } catch (e) {
      const f = falhaDoGraph(e);
      if (f.ligacaoDesfeita) await this.marcarDesfeita(quem, ligacaoId);
      this.logger.warn(`a franquia não veio do DMS Graph (${f.code})`);
      return null;
    }
  }

  private async marcarDesfeita(quem: Quem, ligacaoId: string): Promise<void> {
    await naTransacaoDaEmpresa(this.banco(), quem, () =>
      currentTx().execute(sql`
        update liame.dms_graph_link set revoked_at = clock_timestamp(), revoked_source = 'graph', revoked_by = 'DMS Graph'
         where id = ${ligacaoId} and revoked_at is null`),
    );
  }

  private async auditar(auth: AuthContext, acao: string, recurso: string, id: string, after: Record<string, unknown>): Promise<void> {
    await writeAudit(currentTx(), {
      tenantId: auth.tenantId!,
      actorType: actorTypeOf(auth),
      actorId: auth.userId,
      actorLabel: actorLabel(auth),
      actorRole: auth.roleKey,
      action: acao,
      resourceType: recurso,
      resourceId: id,
      before: null,
      after,
      traceId: activeTraceId(),
      origin: 'api',
    });
  }

  /** A empresa sem CNPJ informa uma vez: a conta dela no Graph nasce por ele. Quem já tem não troca por aqui. */
  async salvarCnpj(auth: AuthContext, cnpj: string): Promise<void> {
    const quem = quemPede(auth);
    await this.exigirLigada(quem);
    if (!cnpjComDigitosCertos(cnpj)) throw new AppProblem(422, 'cnpj-invalido', 'CNPJ inválido', 'Confira o CNPJ: os dígitos verificadores não batem.');
    await naTransacaoDaEmpresa(this.banco(), quem, async () => {
      const r = await currentTx().execute<{ id: string }>(sql`
        update liame.organization set cnpj = ${cnpj} where id = ${quem.tenantId} and cnpj is null returning id`);
      if (!r.rows[0]) throw new AppProblem(409, 'cnpj-ja-informado', 'CNPJ já informado', 'Esta empresa já tem CNPJ. Para trocar, fale com o suporte.');
      await this.auditar(auth, ACAO_CNPJ, 'organization', quem.tenantId, { cnpj_informado: true });
    });
  }

  /** "Conectar ao DMS Graph": abre o pedido lá e devolve a página. Toda recusa vem antes de gravar. */
  async iniciar(auth: AuthContext): Promise<DmsGraphStartResponse> {
    const quem = quemPede(auth);
    await this.exigirLigada(quem);
    const dmsId = this.dmsId();
    const org = await naTransacaoDaEmpresa(this.banco(), quem, async () => {
      const r = await currentTx().execute<{ name: string; cnpj: string | null }>(sql`select name, cnpj from liame.organization where id = ${quem.tenantId}`);
      return r.rows[0] ?? null;
    });
    if (!org) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Empresa não encontrada.');
    if (!/^\d{14}$/.test(org.cnpj ?? '')) {
      throw new AppProblem(422, 'cnpj-faltando', 'Falta o CNPJ', 'Informe o CNPJ da empresa antes de conectar: a conta dela no DMS Graph nasce pelo CNPJ.');
    }
    const p = gerarPedido();
    const r = await this.chamarOClique(
      '/v1/dms-id/autorizacao/pedido',
      corpoDoPedido({ aplicativo: dmsId.aplicativo, volta: this.volta, estado: p.estado, desafio: p.desafio, tenantId: quem.tenantId, empresaNome: org.name, cnpj: org.cnpj!, email: auth.email }),
    );
    const numero = r.corpo?.request_uri;
    if (r.status < 200 || r.status >= 300 || !formatoDoNumero(numero)) {
      this.logger.error(`o DMS Graph recusou o pedido da empresa ${quem.tenantId} (${r.status}): ${String(r.corpo?.type ?? r.corpo?.title ?? '').slice(0, 120)}`);
      if (r.status === 503) throw new AppProblem(503, 'graph-indisponivel', 'Ligações pausadas', 'O DMS Graph pausou novas ligações por enquanto. Tente de novo mais tarde.');
      throw new AppProblem(503, 'graph-indisponivel', 'Conexão indisponível', 'O DMS Graph não aceitou abrir a conexão agora. Fale com o suporte.');
    }
    await naTransacaoDaEmpresa(this.banco(), quem, async () => {
      const tx = currentTx();
      const id = uuidv7();
      const cifrado = await this.vault.encryptForTenant(tx, quem.tenantId, `dms_graph_pkce:${id}`, p.verificador);
      await tx.execute(sql`
        insert into liame.dms_graph_request (id, tenant_id, user_id, state_hash, verifier_enc, expires_at)
        values (${id}, ${quem.tenantId}, ${quem.userId}, ${p.estadoHash}, ${cifrado}, ${new Date(Date.now() + VALIDADE_DO_PEDIDO_MS).toISOString()}::timestamptz)`);
      // Os pedidos velhos da empresa saem aqui (não há rotina para eles).
      await tx.execute(sql`delete from liame.dms_graph_request where tenant_id = ${quem.tenantId} and expires_at < now() - interval '1 day'`);
    });
    return { authorize_url: urlDaPagina(r.corpo?.authorization_endpoint, this.origem, dmsId.aplicativo, numero) };
  }

  /** A volta do Graph: gasta o pedido (uma vez, de quem começou), troca o código e grava a ligação. */
  async concluir(auth: AuthContext, q: DmsGraphCallbackRequest): Promise<DmsGraphCallbackResponse> {
    const quem = quemPede(auth);
    await this.exigirLigada(quem);
    const v = conferirVolta(q, this.origem);
    if (v.tipo === 'invalida') throw new AppProblem(400, 'volta-invalida', 'Não deu para concluir', `Não deu para concluir: ${v.motivo}. ${comece}`);
    const verificador = await naTransacaoDaEmpresa(this.banco(), quem, async () => {
      const tx = currentTx();
      const r = await tx.execute<{ id: string; verifier_enc: string }>(sql`
        update liame.dms_graph_request set used_at = now()
         where state_hash = ${hashDoEstado(v.estado)} and tenant_id = ${quem.tenantId} and user_id = ${quem.userId}
           and used_at is null and expires_at > now()
         returning id, verifier_enc`);
      const p = r.rows[0];
      return p ? this.vault.decryptForTenant(tx, quem.tenantId, `dms_graph_pkce:${p.id}`, p.verifier_enc) : null;
    });
    if (!verificador) throw new AppProblem(400, 'pedido-vencido', 'Pedido vencido', `Este pedido de conexão já foi usado, venceu ou foi aberto por outra pessoa. ${comece}`);
    if (v.tipo === 'recusa') {
      if (v.recusou) return { connected: false, account_name: null };
      throw new AppProblem(400, 'volta-invalida', 'Não deu para concluir', `O DMS Graph não reconheceu o pedido de conexão. ${comece}`);
    }
    const r = await this.chamarOClique('/v1/dms-id/autorizacao/token', {
      grant_type: 'authorization_code',
      client_id: this.dmsId().aplicativo,
      code: v.codigo,
      redirect_uri: this.volta,
      code_verifier: verificador,
    });
    if (r.status !== 200) {
      this.logger.error(`a troca do código da empresa ${quem.tenantId} foi recusada pelo DMS Graph (${r.status})`);
      throw new AppProblem(400, 'volta-invalida', 'Não deu para concluir', `O DMS Graph não aceitou concluir a conexão. ${comece}`);
    }
    const lg = ligacaoDaTroca(r.corpo);
    if (!lg) {
      this.logger.error(`a troca do código da empresa ${quem.tenantId} veio sem a ligação esperada: nada foi guardado`);
      throw new AppProblem(503, 'graph-indisponivel', 'Conexão incompleta', 'O DMS Graph respondeu sem a permissão de editar foto. Nada foi guardado; fale com o suporte.');
    }
    await naTransacaoDaEmpresa(this.banco(), quem, async () => {
      const tx = currentTx();
      // Duas voltas ao mesmo tempo: uma de cada vez, sem travar o que referencia a empresa.
      await tx.execute(sql`select 1 from liame.organization where id = ${quem.tenantId} for no key update`);
      const antigas = await tx.execute<{ secret_id: string | null }>(sql`
        update liame.dms_graph_link set revoked_at = clock_timestamp(), revoked_source = 'troca', revoked_by = ${auth.name.slice(0, 160)}
         where tenant_id = ${quem.tenantId} and revoked_at is null returning secret_id`);
      for (const a of antigas.rows) if (a.secret_id) await this.vault.revokeSecret(tx, a.secret_id);
      const id = uuidv7();
      const secretId = await this.vault.putSecret(tx, { tenantId: quem.tenantId, purpose: 'dms_graph_ligacao', plaintext: lg.ligacao });
      await tx.execute(sql`
        insert into liame.dms_graph_link (id, tenant_id, secret_id, prefix, graph_account_id, graph_account_name, permissions, created_by, created_by_name)
        values (${id}, ${quem.tenantId}, ${secretId}, ${lg.prefixo}, ${lg.contaId}, ${lg.contaNome},
                string_to_array(${lg.permissoes.join(' ')}, ' '), ${quem.userId}, ${auth.name.slice(0, 160)})`);
      await this.auditar(auth, ACAO_LIGOU, 'dms_graph_link', id, { conta: lg.contaNome, permissoes: lg.permissoes, prefixo: lg.prefixo });
    });
    return { connected: true, account_name: lg.contaNome };
  }

  /** Desliga aqui na hora e avisa o Graph; falha lá não segura o desligar. Repetir não dá erro. */
  async desligar(auth: AuthContext): Promise<{ disconnected: boolean }> {
    const quem = quemPede(auth);
    const segredo = await naTransacaoDaEmpresa(this.banco(), quem, async () => {
      const tx = currentTx();
      const r = await tx.execute<{ id: string; secret_id: string | null; prefix: string }>(sql`
        update liame.dms_graph_link set revoked_at = clock_timestamp(), revoked_source = 'pessoa', revoked_by = ${auth.name.slice(0, 160)}
         where tenant_id = ${quem.tenantId} and revoked_at is null returning id, secret_id, prefix`);
      const l = r.rows[0];
      if (!l) return { achou: false, valor: null as string | null };
      const valor = l.secret_id ? await this.vault.readSecret(tx, l.secret_id) : null;
      if (l.secret_id) await this.vault.revokeSecret(tx, l.secret_id);
      await this.auditar(auth, ACAO_DESLIGOU, 'dms_graph_link', l.id, { prefixo: l.prefix });
      return { achou: true, valor };
    });
    if (!segredo.achou) return { disconnected: false };
    if (segredo.valor && this.config.dmsId) {
      try {
        const r = await this.chamarOClique('/v1/dms-id/ligacao', null, { 'dms-ligacao': segredo.valor }, 'DELETE');
        if (r.status >= 300 && r.status !== 401) this.logger.warn(`o DMS Graph não confirmou o desligar (${r.status})`);
      } catch (e) {
        this.logger.warn(`avisar o DMS Graph do desligar falhou (${e instanceof Error ? e.message : 'erro'}); aqui já está desligada`);
      }
    }
    return { disconnected: true };
  }

  /**
   * Edita a foto: uma PRÉVIA, que só vira foto com a conferência da pessoa. A mesma `key` não gasta de novo (o Graph
   * devolve o resultado guardado); "Fazer outra versão" manda outra. A original não muda.
   */
  async editar(auth: AuthContext, fotoId: string, body: CreateBrandPhotoEditRequest): Promise<BrandPhotoEditPreview> {
    const quem = quemPede(auth);
    await this.exigirLigada(quem);
    if (!this.armazem.disponivel) throw new AppProblem(503, 'fotos-indisponiveis', 'Fotos indisponíveis', 'O armazenamento das fotos não está configurado. Tente mais tarde.');
    const opcoes = { light: body.light, background: body.background, framing: body.framing };
    const pedido = pedidoLimpo(body.prompt);
    if (!temPedidoDeEdicao(opcoes, pedido)) throw new AppProblem(400, 'edicao-vazia', 'Diga o que melhorar', 'Escolha a luz, o fundo, o enquadramento ou escreva um pedido.');
    if (pedido) {
      const p = problemaDoPedidoDaFoto(pedido);
      if (p) throw new AppProblem(422, p.code, 'Este pedido não pode ir', p.frase);
    }
    const lig = await this.ligacaoViva(quem);
    if (!lig?.segredo) throw new AppProblem(409, 'graph-desligado', 'DMS Graph desconectado', 'Conecte o DMS Graph em Contas conectadas para editar a foto.');
    if (!lig.permissions.includes(PERMISSAO_EDITAR)) throw new AppProblem(409, 'graph-sem-permissao', 'Edição não liberada', 'A ligação com o DMS Graph não tem a edição de foto. Conecte de novo em Contas conectadas.');

    const origem = await naTransacaoDaEmpresa(this.banco(), quem, async () => {
      const r = await currentTx().execute<{ id: string; brand_id: string; object_key: string; kind: string; product: string | null; description: string; edited_at: Date | null; bytes: number }>(sql`
        select id, brand_id, object_key, kind, product, description, edited_at, bytes from liame.brand_photo
         where id = ${fotoId} and status = 'pronta' and removed_at is null`);
      return r.rows[0] ?? null;
    });
    if (!origem) throw new AppProblem(404, 'foto-nao-encontrada', 'Não encontramos', 'Esta foto não está mais aqui.');
    if (origem.kind !== 'foto_produto') throw new AppProblem(422, 'foto-recusada', 'Só fotos', 'Só dá para editar foto, não vídeo.');
    if (origem.edited_at) throw new AppProblem(422, 'foto-ja-editada', 'Esta foto já foi editada', 'Para editar de novo, abra a foto original.');
    if (Number(origem.bytes) > FOTO_MAX_BYTES) throw new AppProblem(422, 'foto-recusada', 'Foto grande demais', 'A edição aceita foto de até 5 MB.');

    const arquivo = await this.armazem.ler(origem.object_key);
    let bytes: Buffer;
    let quota: DmsGraphQuota | null;
    try {
      const r = await this.clienteMcp(lig.segredo, PRAZO_DA_EDICAO_MS).chamar<{ mimeType?: unknown; imagemBase64?: unknown; franquia?: unknown }>(FERRAMENTA_EDITAR, {
        fotos: [{ mimeType: 'image/jpeg', arquivoBase64: arquivo.toString('base64') }],
        instrucao: instrucaoDaEdicao(opcoes, pedido),
        proporcao: opcoes.framing,
        // O 2K: no 1K, a foto em 9:16 fica abaixo do mínimo do Liame, e a quadrada abaixo do que o Instagram mostra.
        tamanho: '2K',
        formato: 'jpeg',
        chaveIdempotencia: montarChaveIdempotencia('liame-editar-foto', quem.tenantId, fotoId, body.key),
      });
      const base64 = typeof r?.imagemBase64 === 'string' ? r.imagemBase64 : '';
      bytes = Buffer.from(base64, 'base64');
      if ((r?.mimeType !== 'image/jpeg' && r?.mimeType !== 'image/png') || !bytes.length || bytes.length > RESULTADO_MAX_BYTES) {
        this.logger.warn('o DMS Graph respondeu fora do formato em editar_imagem');
        throw new AppProblem(503, 'graph-indisponivel', 'DMS Graph indisponível', 'O DMS Graph respondeu de um jeito inesperado. Tente de novo em instantes.');
      }
      quota = franquiaDe(r.franquia);
    } catch (e) {
      if (e instanceof AppProblem) throw e;
      const f = falhaDoGraph(e);
      this.logger.warn(`o DMS Graph não editou a foto da empresa ${quem.tenantId} (${f.code})`);
      if (f.ligacaoDesfeita) await this.marcarDesfeita(quem, lig.id);
      throw new AppProblem(f.status, f.code, f.title, f.detail);
    }

    let foto;
    try {
      foto = await processarFoto(bytes);
    } catch (e) {
      if (e instanceof RecusaDaFoto) throw new AppProblem(422, 'foto-recusada', 'Não deu para usar o resultado', 'O resultado saiu fora do tamanho aceito. Tente outro enquadramento.');
      throw e;
    }
    const expira = new Date(Date.now() + VALIDADE_DO_ENDERECO_S * 1000);
    const repetida = await naTransacaoDaEmpresa(this.banco(), quem, async () => {
      const r = await currentTx().execute<{ id: string; status: string; object_key: string; width: number; height: number; bytes: number }>(sql`
        select id, status, object_key, width, height, bytes from liame.brand_photo
         where brand_id = ${origem.brand_id} and sha256 = ${foto.sha256} and removed_at is null`);
      return r.rows[0] ?? null;
    });
    if (repetida) {
      // A mesma `key` de novo: a prévia que já existe; o que já foi guardado não vira outra.
      if (repetida.status === 'pronta') throw new AppProblem(409, 'foto-repetida', 'Essa versão já está em Fotos', 'Essa versão já está em Fotos.');
      return { id: repetida.id, source_id: fotoId, url: await this.armazem.enderecoDeLeitura(repetida.object_key, VALIDADE_DO_ENDERECO_S), width: repetida.width, height: repetida.height, bytes: repetida.bytes, urls_expire_at: expira.toISOString(), quota };
    }
    const id = uuidv7();
    const chave = chaveDaFoto(quem.tenantId, origem.brand_id, id);
    await naTransacaoDaEmpresa(this.banco(), quem, () =>
      currentTx().execute(sql`
        insert into liame.brand_photo (id, tenant_id, brand_id, status, object_key, sha256, bytes, width, height, product, description, uploaded_by,
                                       edited_at, edited_from_id, edited_by, edit_options, edit_prompt)
        values (${id}, ${quem.tenantId}, ${origem.brand_id}, 'enviando', ${chave}, ${foto.sha256}, ${foto.copia.bytes.length}, ${foto.copia.largura}, ${foto.copia.altura},
                ${origem.product}, ${origem.description}, ${quem.userId}, now(), ${fotoId}, ${quem.userId}, ${JSON.stringify(opcoes)}::jsonb, ${pedido})`),
    );
    await this.armazem.gravar(chave, foto.copia.bytes);
    await this.armazem.gravar(chaveDaMiniatura(chave), foto.miniatura.bytes);
    await naTransacaoDaEmpresa(this.banco(), quem, () =>
      currentTx().execute(sql`update liame.dms_graph_link set last_used_at = now() where id = ${lig.id} and revoked_at is null`),
    );
    return {
      id,
      source_id: fotoId,
      url: await this.armazem.enderecoDeLeitura(chave, VALIDADE_DO_ENDERECO_S),
      width: foto.copia.largura,
      height: foto.copia.altura,
      bytes: foto.copia.bytes.length,
      urls_expire_at: expira.toISOString(),
      quota,
    };
  }

  /** A pessoa conferiu: a prévia vira uma foto nova em Fotos. Uma vez só. */
  async guardar(auth: AuthContext, edicaoId: string): Promise<BrandPhoto> {
    const quem = quemPede(auth);
    await this.exigirLigada(quem);
    return naTransacaoDaEmpresa(this.banco(), quem, async () => {
      const tx = currentTx();
      const r = await tx.execute<{ id: string; brand_id: string; edited_from_id: string | null; edit_options: unknown }>(sql`
        update liame.brand_photo
           set status = 'pronta', edit_confirmed_at = now(), edit_confirmed_by = ${quem.userId}, updated_at = now()
         where id = ${edicaoId} and status = 'enviando' and edited_at is not null and removed_at is null
         returning id, brand_id, edited_from_id, edit_options`);
      const l = r.rows[0];
      if (!l) throw new AppProblem(409, 'edicao-vencida', 'Esta prévia venceu', 'Esta prévia não está mais disponível. Faça a edição de novo.');
      await this.auditar(auth, ACAO_EDITOU, RECURSO, l.id, { brand_id: l.brand_id, original: l.edited_from_id, opcoes: l.edit_options, conferida: true });
      return this.fotos.fotoNaTransacao(l.id);
    });
  }

  /** Descarta a prévia. O arquivo sai pela rotina `fotos`. Repetir não dá erro. */
  async descartar(auth: AuthContext, edicaoId: string): Promise<void> {
    const quem = quemPede(auth);
    await naTransacaoDaEmpresa(this.banco(), quem, () =>
      currentTx().execute(sql`
        update liame.brand_photo set removed_at = now(), removed_by = ${quem.userId}, updated_at = now()
         where id = ${edicaoId} and status = 'enviando' and edited_at is not null and removed_at is null`),
    );
  }
}

/** Os dois dígitos verificadores do CNPJ (módulo 11). Todos iguais não vale. */
export function cnpjComDigitosCertos(cnpj: string): boolean {
  if (!/^\d{14}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;
  const digito = (base: string): number => {
    let soma = 0;
    let peso = base.length - 7;
    for (const c of base) {
      soma += Number(c) * peso;
      peso = peso === 2 ? 9 : peso - 1;
    }
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = digito(cnpj.slice(0, 12));
  const d2 = digito(cnpj.slice(0, 12) + d1);
  return cnpj.endsWith(`${d1}${d2}`);
}
