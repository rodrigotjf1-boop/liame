import { createHmac } from 'node:crypto';
import { type Database, type Tx, withTenant } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { AppConfig } from '../config.js';
import { contaConectada } from '../connections/conectada.js';
import { type ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { PROVEDOR_INSTAGRAM, PROVEDOR_PAGINA, tokenDaPagina } from '../connectors/meta/publicacao.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { AcessoDaExecucao, credencialDaLoja } from '../connectors/regem/acesso-da-loja.js';
import { lerCanaisAtendidos } from '../connectors/regem/conector-regem.js';
import {
  CAMPOS_DAS_CONVERSAS,
  CAMPOS_DAS_MENSAGENS,
  CAMPOS_DAS_MENSAGENS_DO_MESSENGER,
  type CanalDoDirect,
  CONFERENCIA_DO_REGEM_MIN,
  CONVERSAS_POR_LEITURA,
  type ContaDoDirect,
  type ConversaLida,
  conversasDoDirect,
  DATASET_DO_DIRECT,
  ESCOPO_DOS_CANAIS_DO_REGEM,
  esperaDaFalhaDoDirect,
  INTERVALO_DO_DIRECT_MIN,
  type MensagemLida,
  mensagensDaConversa,
  RELIDAS_POR_LEITURA,
  regemAtende,
} from './direct.js';

// A leitura do Direct (A6, Z12, parte 1; P39, D-A6-107 e D-A6-108). A cada minuto, para cada conta do Instagram ligada
// a uma marca de empresa com a função `direct` ligada e o Direct ligado na marca: (1) a conferência com o Regem, pela
// ligação da loja, no máximo a cada 15 minutos (a Central dele atende este Direct? então o do Liame fica desligado na
// conta, e o que estava guardado sai); (2) as 25 conversas mais recentes e, das que mudaram, as mensagens (só as 20 mais
// novas de cada conversa têm o texto, na Meta). O banco em transações curtas, antes e depois; as chamadas, sem
// transação aberta. O token nunca vai para log nem banco; a prova do segredo do app vai no endereço (V161). A reserva
// da vez é da rotina do worker (V53).
// O Messenger da Página (A6, Z14, parte 1; D-A6-120 e D-A6-121): a conta `facebook_page` da marca segue o mesmo caminho,
// com o ajuste e a função do canal (`messenger_setting`, `messenger`), a consulta com `platform=messenger`, o Regem pela
// Página e o nome de quem escreve (no Messenger não há @).

const META = 'meta_ads';
const MINUTO_MS = 60_000;
const HORA_MS = 60 * MINUTO_MS;

type Capacidade = 'pages' | 'instagram_conversas' | 'messenger_conversas';

/** A conferência com o Regem guardada no cursor (D-A6-107). */
export type SituacaoDoRegem = 'livre' | 'atende' | 'sem_regem' | 'nao_conferido';

/** O que a leitura precisa do resto do app (os testes trocam a Graph e o Regem). */
export type DependenciasDoDirect = {
  lerSegredo: (tx: Tx, secretId: string) => Promise<string | null>;
  cliente: () => ClienteConector;
  graphUrl: string;
  appSecret: string | null;
  versao: (capacidade: Capacidade) => Promise<string>;
  /** A função do canal na empresa (`direct` ou `messenger`), conferida na vez. */
  ligada: (tenantId: string, brandId: string, canal: CanalDoDirect) => Promise<boolean>;
  /** O endereço do Regem e o aplicativo do Liame no DMS ID (a ligação da loja). */
  config: Pick<AppConfig, 'dmsId' | 'produtos'>;
};

/** Como terminou a vez de uma conta. */
export type ResultadoDoDirect = {
  conta: string;
  status: 'ok' | 'desligada' | 'ignorada' | 'regem' | 'nao_conferido' | 'sem_permissao' | 'falhou';
  conversas?: number;
  relidas?: number;
  mensagens?: number;
  erro?: string;
};

/** O que fica no `cursor` do `sync_state`. `lendo`: a reserva do worker, que toda gravação desta leitura tira. */
export type CursorDoDirect = { proxima?: string; falha?: string; falhas_seguidas?: number; lendo?: string; regem?: SituacaoDoRegem; regem_em?: string };

type LinhaDaConta = {
  id: string;
  brand_id: string;
  provider: string;
  external_id: string;
  usuario: string | null;
  pagina_id: string | null;
  segredo: string | null;
  conectada: boolean;
  ligado: boolean;
  cursor: CursorDoDirect | null;
};
type LinhaDoRegem = { id: string; external_id: string; credential_secret_id: string | null; ligacao_secret_id: string | null };
type Guardada = { conversation_id: string; meta_updated_at: Date | string; last_inbound_at: Date | string | null };
type Relida = { conversa: ConversaLida; mensagens: MensagemLida[] };

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();

export class SincronizadorDoDirect {
  private readonly logger = new Logger('direct');

  constructor(
    private readonly database: Database,
    private readonly deps: DependenciasDoDirect,
  ) {}

  async sincronizar(contaId: string, tenantId: string, agora: Date = new Date()): Promise<ResultadoDoDirect> {
    const db = this.database.db;
    const depois = (ms: number) => new Date(agora.getTime() + ms).toISOString();

    // 1. A conta, o cursor, a função, o ajuste da marca, o token, o Regem e as conversas guardadas.
    const inicio = await withTenant(db, tenantId, async (tx) => {
      const conta = (
        await tx.execute<LinhaDaConta>(sql`
          select a.id, a.brand_id, a.provider, a.external_id, a.provider_attributes->>'usuario' as usuario,
                 case when a.provider = ${PROVEDOR_PAGINA} then a.external_id else a.provider_attributes->>'pagina_id' end as pagina_id,
                 a.credential_secret_id as segredo, coalesce(${contaConectada('a')}, false) as conectada,
                 coalesce(case when a.provider = ${PROVEDOR_PAGINA}
                               then (select m.enabled from liame.messenger_setting m where m.brand_id = a.brand_id)
                               else (select d.enabled from liame.direct_setting d where d.brand_id = a.brand_id) end, false) as ligado,
                 s.cursor
            from liame.connected_account a
            left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = ${DATASET_DO_DIRECT}
           where a.id = ${contaId} and a.provider in (${PROVEDOR_INSTAGRAM}, ${PROVEDOR_PAGINA})`)
      ).rows[0];
      if (!conta) return { situacao: 'ignorada' as const };
      const canal: CanalDoDirect = conta.provider === PROVEDOR_PAGINA ? 'messenger' : 'instagram';
      const { lendo: _reserva, ...cursor }: CursorDoDirect = conta.cursor ?? {};
      if (!conta.conectada || !conta.segredo || !conta.pagina_id) {
        await this.adiar(tx, contaId, tenantId, { ...cursor, proxima: depois(24 * HORA_MS) }, agora);
        return { situacao: 'ignorada' as const };
      }
      // A função desligada ou o Direct desligado na marca: a conta espera um dia, sem ler (V106). Ligar na tela traz a
      // vez para agora (`direct.service.ts`).
      if (!conta.ligado || !(await this.deps.ligada(tenantId, conta.brand_id, canal))) {
        await this.adiar(tx, contaId, tenantId, { ...cursor, proxima: depois(24 * HORA_MS) }, agora);
        return { situacao: 'desligada' as const };
      }
      // O Regem da empresa, se houver: o da mesma marca primeiro.
      const regem = (
        await tx.execute<LinhaDoRegem>(sql`
          select a.id, a.external_id, a.credential_secret_id, a.ligacao_secret_id
            from liame.connected_account a
           where a.provider = 'regem' and ${contaConectada('a')}
           order by (a.brand_id = ${conta.brand_id}) desc, a.id
           limit 1`)
      ).rows[0];
      const credencialDoRegem = regem ? await this.credencialDoRegem(tx, regem) : null;
      const token = await this.token(tx, conta.segredo);
      const guardadas = (
        await tx.execute<Guardada>(sql`
          select conversation_id, meta_updated_at, last_inbound_at from liame.direct_conversation where connected_account_id = ${contaId}`)
      ).rows;
      return { situacao: 'ler' as const, conta, canal, cursor, token, regem: regem ?? null, credencialDoRegem, guardadas };
    }).catch(async (err: unknown) => {
      if (!(err instanceof ErroConector)) throw err;
      await withTenant(db, tenantId, (tx) => this.marcarFalha(tx, contaId, tenantId, {}, err, agora));
      return { situacao: 'falhou' as const, erro: err };
    });
    if (inicio.situacao === 'ignorada' || inicio.situacao === 'desligada') return { conta: contaId, status: inicio.situacao };
    if (inicio.situacao === 'falhou') return { conta: contaId, status: inicio.erro.tipo === 'permissao' ? 'sem_permissao' : 'falhou', erro: inicio.erro.message };
    const { conta, canal, cursor, token, regem, credencialDoRegem, guardadas } = inicio;
    // No Messenger, a marca é a Página (o id dela); no Instagram, a conta profissional e o @.
    const daConta: ContaDoDirect = canal === 'messenger' ? { id: conta.pagina_id!, usuario: null } : { id: conta.external_id, usuario: conta.usuario };

    // 2. A conferência com o Regem (D-A6-107), no máximo a cada 15 minutos: só a conta livre segue para a leitura.
    const fresca = cursor.regem_em && agora.getTime() - new Date(cursor.regem_em).getTime() < CONFERENCIA_DO_REGEM_MIN * MINUTO_MS;
    const situacaoDoRegem: SituacaoDoRegem =
      fresca && (cursor.regem === 'livre' || cursor.regem === 'sem_regem') ? cursor.regem : await this.conferirRegem(regem, credencialDoRegem, daConta, canal);
    const conferidoEm = fresca && situacaoDoRegem === cursor.regem ? cursor.regem_em! : agora.toISOString();
    if (situacaoDoRegem === 'atende' || situacaoDoRegem === 'nao_conferido') {
      await withTenant(db, tenantId, async (tx) => {
        // O Regem atende o Direct desta conta: o Liame não guarda nada dela (D-A6-107).
        if (situacaoDoRegem === 'atende') await tx.execute(sql`delete from liame.direct_conversation where connected_account_id = ${contaId}`);
        await this.adiar(tx, contaId, tenantId, { proxima: depois(CONFERENCIA_DO_REGEM_MIN * MINUTO_MS), regem: situacaoDoRegem, regem_em: conferidoEm }, agora);
      });
      return { conta: contaId, status: situacaoDoRegem === 'atende' ? 'regem' : 'nao_conferido' };
    }

    // 3. As conversas e as mensagens das que mudaram, sem transação aberta.
    let lidas: ConversaLida[];
    let relidas: Relida[];
    let vazias: string[];
    try {
      ({ lidas, relidas, vazias } = await this.ler(conta, token, daConta, guardadas, canal));
    } catch (err) {
      if (!(err instanceof ErroConector)) throw err;
      this.logger.warn(`conta ${contaId}: o Direct não veio (${err.tipo}): ${err.message}`);
      await withTenant(db, tenantId, (tx) => this.marcarFalha(tx, contaId, tenantId, { ...cursor, regem: situacaoDoRegem, regem_em: conferidoEm }, err, agora));
      return { conta: contaId, status: err.tipo === 'permissao' ? 'sem_permissao' : 'falhou', erro: err.message };
    }

    // 4. A gravação: as conversas relidas, as mensagens delas e o estado.
    const ultimaDaPessoa = new Map(guardadas.map((g) => [g.conversation_id, g.last_inbound_at ? iso(g.last_inbound_at) : null]));
    await withTenant(db, tenantId, async (tx) => {
      for (const r of relidas) await this.gravarConversa(tx, conta, canal, tenantId, r, ultimaDaPessoa.get(r.conversa.conversation_id) ?? null, agora);
      for (const conversa of vazias) await this.tirarAConversaVazia(tx, contaId, conversa, agora.toISOString());
      await this.marcar(
        tx,
        contaId,
        tenantId,
        { sucesso: true, erro: null, cursor: { proxima: depois(INTERVALO_DO_DIRECT_MIN * MINUTO_MS), falhas_seguidas: 0, regem: situacaoDoRegem, regem_em: conferidoEm } },
        agora,
      );
    });
    return { conta: contaId, status: 'ok', conversas: lidas.length, relidas: relidas.length, mensagens: relidas.reduce((n, r) => n + r.mensagens.length, 0) };
  }

  /**
   * O Regem atende o Direct desta conta? Sem Regem na empresa, `sem_regem`. Com ele, só pela ligação com o escopo próprio
   * (`atendimento.canais.ler`); sem o escopo, ou sem resposta, `nao_conferido` (a leitura espera: na dúvida, o Liame não
   * lê nem responde).
   */
  private async conferirRegem(regem: LinhaDoRegem | null, credencial: ReturnType<typeof credencialDaLoja>, conta: ContaDoDirect, canal: CanalDoDirect): Promise<SituacaoDoRegem> {
    if (!regem) return 'sem_regem';
    if (!credencial || !credencial.escopos.includes(ESCOPO_DOS_CANAIS_DO_REGEM)) return 'nao_conferido';
    const acesso = new AcessoDaExecucao(credencial, this.deps.config, regem.external_id, [ESCOPO_DOS_CANAIS_DO_REGEM]);
    try {
      const canais = await acesso.chamar((a) => lerCanaisAtendidos({ cliente: this.deps.cliente(), apiUrl: this.deps.config.produtos.regemApiUrl }, a));
      return regemAtende({ instagram: canais.instagram.map((c) => ({ ig_user_id: c.ig_user_id, usuario: c.usuario ?? null })), messenger: canais.messenger }, conta, canal) ? 'atende' : 'livre';
    } catch (err) {
      if (!(err instanceof ErroConector)) throw err;
      this.logger.warn(`loja do Regem ${regem.id}: não deu para conferir quem atende o Direct (${err.tipo}${err.codigoProvider ? `:${err.codigoProvider}` : ''})`);
      return 'nao_conferido';
    }
  }

  /** As conversas mais recentes e, das que mudaram (ou que o Liame não tem), as mensagens, até 10 por leitura. */
  private async ler(conta: LinhaDaConta, token: string, daConta: ContaDoDirect, guardadas: Guardada[], canal: CanalDoDirect): Promise<{ lidas: ConversaLida[]; relidas: Relida[]; vazias: string[] }> {
    const pagina = conta.pagina_id!;
    const capacidade: Capacidade = canal === 'messenger' ? 'messenger_conversas' : 'instagram_conversas';
    const contas = await this.chamar(conta.external_id, token, 'pages', 'me/accounts', { fields: 'id,access_token,tasks', limit: '100' });
    const daPagina = tokenDaPagina(contas, pagina);
    // Sem a Página na autorização, ou sem a tarefa de mensagens da Página (a referência das conversas pede MESSAGING;
    // quem pode moderar também passa: D-A6-124).
    if (!daPagina) throw new ErroConector('permissao', META, canal === 'messenger' ? 'a autorização não alcança a Página' : 'a autorização não alcança a Página do Instagram');
    if (!daPagina.podeMandarMensagem && !daPagina.podeModerar) throw new ErroConector('permissao', META, 'quem autorizou não tem a tarefa de mensagens na Página');
    const corpo = await this.chamar(conta.external_id, daPagina.token, capacidade, `${pagina}/conversations`, {
      platform: canal,
      fields: CAMPOS_DAS_CONVERSAS,
      limit: String(CONVERSAS_POR_LEITURA),
    });
    const lidas = conversasDoDirect(corpo, daConta);
    const conhecidas = new Map(guardadas.map((g) => [g.conversation_id, iso(g.meta_updated_at)]));
    const mudaram = lidas.filter((c) => (conhecidas.get(c.conversation_id) ?? '') < c.meta_updated_at).slice(0, RELIDAS_POR_LEITURA);
    const relidas: Relida[] = [];
    // As guardadas que a Meta devolve sem mensagem nenhuma (a pessoa apagou o que tinha escrito): saem do Liame.
    const vazias: string[] = [];
    for (const conversa of mudaram) {
      try {
        const doFio = await this.chamar(conta.external_id, daPagina.token, capacidade, conversa.conversation_id, {
          fields: canal === 'messenger' ? CAMPOS_DAS_MENSAGENS_DO_MESSENGER : CAMPOS_DAS_MENSAGENS,
        });
        const mensagens = mensagensDaConversa(doFio, daConta);
        if (mensagens.length) relidas.push({ conversa, mensagens });
        else if (conhecidas.has(conversa.conversation_id)) vazias.push(conversa.conversation_id);
      } catch (err) {
        if (!(err instanceof ErroConector)) throw err;
        if (err.tipo === 'permissao' || err.tipo === 'autenticacao') throw err;
        if (err.tipo === 'limite' || err.tipo === 'circuito_aberto') {
          this.logger.warn(`conta ${conta.id}: a Meta pediu para esperar; as outras conversas ficam para a próxima vez`);
          break;
        }
        this.logger.warn(`conta ${conta.id}: uma conversa fica para a próxima vez (${err.tipo}, HTTP ${err.status ?? '?'}, código ${err.codigoProvider ?? '?'})`);
      }
    }
    return { lidas, relidas, vazias };
  }

  /**
   * Grava uma conversa relida e as mensagens dela. A última mensagem e a última da pessoa saem das mensagens lidas (as
   * mais novas da conversa), sem voltar no tempo; a mensagem nova da pessoa marca a conversa como não aberta.
   */
  private async gravarConversa(tx: Tx, conta: LinhaDaConta, canal: CanalDoDirect, tenantId: string, r: Relida, ultimaGuardada: string | null, agora: Date): Promise<void> {
    const ultima = r.mensagens[r.mensagens.length - 1]!;
    const daPessoa = r.mensagens.filter((m) => m.direction === 'entrada').map((m) => m.sent_at);
    const ultimaDaPessoa = daPessoa.length ? daPessoa[daPessoa.length - 1]! : null;
    const novaDaPessoa = ultimaDaPessoa !== null && (ultimaGuardada === null || ultimaDaPessoa > ultimaGuardada);
    const quando = agora.toISOString();
    await tx.execute(sql`
      insert into liame.direct_conversation (connected_account_id, tenant_id, brand_id, conversation_id, participant_id, username, display_name, channel,
                                             last_message_at, last_inbound_at, last_direction, unread, meta_updated_at, read_at)
      values (${conta.id}, ${tenantId}, ${conta.brand_id}, ${r.conversa.conversation_id}, ${r.conversa.participant_id}, ${r.conversa.username},
              ${r.conversa.display_name}, ${canal},
              ${ultima.sent_at}::timestamptz, ${ultimaDaPessoa}::timestamptz, ${ultima.direction}, ${novaDaPessoa && ultima.direction === 'entrada'},
              ${r.conversa.meta_updated_at}::timestamptz, ${quando}::timestamptz)
      on conflict (connected_account_id, conversation_id) do update set
        username = coalesce(excluded.username, liame.direct_conversation.username),
        display_name = coalesce(excluded.display_name, liame.direct_conversation.display_name),
        last_message_at = greatest(excluded.last_message_at, liame.direct_conversation.last_message_at),
        last_inbound_at = greatest(excluded.last_inbound_at, liame.direct_conversation.last_inbound_at),
        last_direction = case when excluded.last_message_at >= liame.direct_conversation.last_message_at then excluded.last_direction else liame.direct_conversation.last_direction end,
        unread = case when ${novaDaPessoa} and excluded.last_direction = 'entrada' then true
                      when excluded.last_direction = 'saida' then false
                      else liame.direct_conversation.unread end,
        meta_updated_at = excluded.meta_updated_at,
        read_at = excluded.read_at`);
    await tx.execute(sql`
      insert into liame.direct_message (connected_account_id, tenant_id, brand_id, conversation_id, message_id, direction, kind, body, sent_at, read_at)
      select ${conta.id}, ${tenantId}, ${conta.brand_id}, ${r.conversa.conversation_id}, x.message_id, x.direction, x.kind, x.body, x.sent_at, ${quando}::timestamptz
        from jsonb_to_recordset(${JSON.stringify(r.mensagens)}::jsonb) as x (message_id text, direction text, kind text, body text, sent_at timestamptz)
      on conflict (connected_account_id, message_id) do update set kind = excluded.kind, body = excluded.body, read_at = excluded.read_at`);
    await this.tirarAsApagadas(tx, conta.id, r.conversa.conversation_id, r.mensagens, quando);
  }

  /**
   * A mensagem que a pessoa apagou não volta mais da Meta, e sai do Liame também (D-A6-112; a Meta manda apagar o que a
   * pessoa apagou; ERR-231: a leitura só acrescentava). Dentro do trecho relido (da mais antiga que veio em diante), o que
   * está guardado e não veio sai; o que é mais antigo que o trecho fica até o expurgo dos 90 dias, porque a Meta só
   * devolve as mais novas. A mensagem gravada depois de esta leitura começar (a resposta que o Liame acabou de mandar,
   * `direct-na-rede.ts`) fica: a Meta ainda não a tinha quando respondeu. Saindo alguma, a última mensagem, a última da
   * pessoa e de quem é a última voltam a sair do que ficou guardado.
   */
  private async tirarAsApagadas(tx: Tx, contaId: string, conversa: string, vieram: Relida['mensagens'], quando: string): Promise<void> {
    const lista = JSON.stringify(vieram.map((m) => ({ message_id: m.message_id, sent_at: m.sent_at })));
    const apagadas = await tx.execute(sql`
      delete from liame.direct_message m
       where m.connected_account_id = ${contaId} and m.conversation_id = ${conversa} and m.read_at < ${quando}::timestamptz
         and m.sent_at >= (select min(x.sent_at) from jsonb_to_recordset(${lista}::jsonb) as x (sent_at timestamptz))
         and m.message_id not in (select x.message_id from jsonb_to_recordset(${lista}::jsonb) as x (message_id text))
      returning m.message_id`);
    if (!apagadas.rows.length) return;
    await tx.execute(sql`
      update liame.direct_conversation c
         set last_message_at = s.ultima, last_inbound_at = s.ultima_da_pessoa, last_direction = s.direcao,
             unread = c.unread and s.direcao = 'entrada'
        from (select max(sent_at) as ultima, max(sent_at) filter (where direction = 'entrada') as ultima_da_pessoa,
                     (array_agg(direction order by sent_at desc, message_id desc))[1] as direcao
                from liame.direct_message where connected_account_id = ${contaId} and conversation_id = ${conversa}) s
       where c.connected_account_id = ${contaId} and c.conversation_id = ${conversa} and s.ultima is not null`);
  }

  /**
   * A conversa guardada que a Meta devolve sem mensagem nenhuma: a pessoa apagou tudo o que tinha escrito. Sai do Liame,
   * com as mensagens (em cascata), como a conversa sem mensagem do expurgo.
   */
  private async tirarAConversaVazia(tx: Tx, contaId: string, conversa: string, quando: string): Promise<void> {
    await tx.execute(sql`
      delete from liame.direct_conversation c
       where c.connected_account_id = ${contaId} and c.conversation_id = ${conversa}
         and not exists (select 1 from liame.direct_message m
                          where m.connected_account_id = c.connected_account_id and m.conversation_id = c.conversation_id and m.read_at >= ${quando}::timestamptz)`);
  }

  /** A credencial da loja do Regem, como a leitura das vendas a monta (o token ou a ligação do Hub DMS). */
  private async credencialDoRegem(tx: Tx, regem: LinhaDoRegem): Promise<ReturnType<typeof credencialDaLoja>> {
    const pelaLigacao = this.deps.config.produtos.regemPelaLigacao;
    const guardada = regem.credential_secret_id ? await this.deps.lerSegredo(tx, regem.credential_secret_id) : null;
    const ligacao = pelaLigacao && regem.ligacao_secret_id ? await this.deps.lerSegredo(tx, regem.ligacao_secret_id) : null;
    return credencialDaLoja(guardada ? (JSON.parse(guardada) as CredencialGuardada) : null, regem.external_id, ligacao, pelaLigacao);
  }

  /** Grava a tentativa no `sync_state`: a que deu certo leva a hora do sucesso; a que falhou, o motivo. */
  private async marcar(tx: Tx, contaId: string, tenantId: string, o: { sucesso: boolean; erro: string | null; cursor: CursorDoDirect }, agora: Date): Promise<void> {
    const quando = agora.toISOString();
    await tx.execute(sql`
      insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, last_success_at, last_attempt_at, last_error, cursor, updated_at)
      values (${contaId}, ${DATASET_DO_DIRECT}, ${tenantId}, ${INTERVALO_DO_DIRECT_MIN}, ${o.sucesso ? quando : null}::timestamptz, ${quando}::timestamptz,
              ${o.erro}, ${JSON.stringify(o.cursor)}::jsonb, ${quando}::timestamptz)
      on conflict (connected_account_id, dataset) do update set
        last_success_at = coalesce(excluded.last_success_at, liame.sync_state.last_success_at),
        last_attempt_at = excluded.last_attempt_at,
        last_error = excluded.last_error,
        cursor = excluded.cursor,
        updated_at = excluded.updated_at`);
  }

  /** A falha da leitura: o motivo, a espera pelo tipo e quantas seguidas. */
  private marcarFalha(tx: Tx, contaId: string, tenantId: string, cursor: CursorDoDirect, err: ErroConector, agora: Date): Promise<void> {
    const falhas = (cursor.falhas_seguidas ?? 0) + 1;
    const espera = esperaDaFalhaDoDirect(err.tipo, err.esperarMs);
    const texto = `${err.tipo}: ${err.message}`.slice(0, 500);
    const proximo: CursorDoDirect = {
      proxima: new Date(agora.getTime() + espera).toISOString(),
      falha: err.tipo,
      falhas_seguidas: falhas,
      ...(cursor.regem ? { regem: cursor.regem } : {}),
      ...(cursor.regem_em ? { regem_em: cursor.regem_em } : {}),
    };
    return this.marcar(tx, contaId, tenantId, { sucesso: false, erro: texto, cursor: proximo }, agora);
  }

  /** Muda só a próxima vez (desligada, ignorada ou à espera do Regem): não é tentativa, e o que já havia fica. */
  private async adiar(tx: Tx, contaId: string, tenantId: string, cursor: CursorDoDirect, agora: Date): Promise<void> {
    await tx.execute(sql`
      insert into liame.sync_state (connected_account_id, dataset, tenant_id, expected_every_minutes, cursor, updated_at)
      values (${contaId}, ${DATASET_DO_DIRECT}, ${tenantId}, ${INTERVALO_DO_DIRECT_MIN}, ${JSON.stringify(cursor)}::jsonb, ${agora.toISOString()}::timestamptz)
      on conflict (connected_account_id, dataset) do update set cursor = excluded.cursor, updated_at = excluded.updated_at`);
  }

  private async token(tx: Tx, secretId: string): Promise<string> {
    const guardada = await this.deps.lerSegredo(tx, secretId);
    const credencial = guardada ? (JSON.parse(guardada) as { tipo?: string; access_token?: string }) : null;
    if (!credencial || credencial.tipo !== 'meta' || !credencial.access_token) throw new ErroConector('autenticacao', META, 'autorização revogada ou ausente');
    return credencial.access_token;
  }

  /** Uma leitura na Graph API: o token no cabeçalho e a prova do segredo do app no endereço (nunca o token, V161). */
  private async chamar(conta: string, token: string, capacidade: Capacidade, caminho: string, params: Record<string, string>): Promise<unknown> {
    const versao = await this.deps.versao(capacidade);
    const q = new URLSearchParams(params);
    if (this.deps.appSecret) q.set('appsecret_proof', createHmac('sha256', this.deps.appSecret).update(token).digest('hex'));
    const r = await this.deps.cliente().requisitar<unknown>({
      provider: META,
      conta,
      url: `${this.deps.graphUrl}/${versao}/${caminho}?${q.toString()}`,
      metodo: 'GET',
      endpoint: capacidade,
      apiVersion: versao,
      cabecalhos: { authorization: `Bearer ${token}` },
    });
    return r.corpo;
  }
}
