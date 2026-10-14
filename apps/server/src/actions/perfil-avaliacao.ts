import type { Tx } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { gravarAvaliacoes } from '../avaliacoes/perfil-store.js';
import { DATASET_AVALIACOES } from '../avaliacoes/sincronizador-do-perfil.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { ErroConector } from '../connectors/cliente-http.js';
import type { AlvoDaAvaliacao, ConectorPerfilGoogle } from '../connectors/google-business/conector-perfil-google.js';
import { type AvaliacaoLida, FLAG_PERFIL_GOOGLE_ESCRITA } from '../connectors/google-business/perfil-google.js';
import { type ContextoDaAvaliacao, EstadoDaAvaliacao, estadoDaAvaliacao, respostaJaApagada, respostaJaPublicada, versaoDaAvaliacao } from './avaliacao-plano.js';
import type { ApplyOptions, ApplyResult, Connector, ReadResult, ResourceRef } from './connectors.js';
import type { ResourceState } from './tools.js';

// A resposta da empresa a uma avaliação do perfil no Google, pelo Action Service (A6, Z2; `plano-a6.md` D-A6-3 a
// D-A6-5): publicar o texto que uma pessoa aprovou com o código do app. Só com a flag de escrita `perfil_google_write`
// ligada, que nasce desligada: sem ela, nenhum pedido passa do trilho.
//
// O recurso é a avaliação: `resource_id` = `avaliacao:<id dela no Liame>`; `account_id` é a loja do perfil ligada.
//
// - O estado é a avaliação como o Google a tem na hora, sem o texto dela e sem nada de quem avaliou (o texto fica em
//   `profile_review`; no pedido vai só um resumo criptográfico). A leitura da hora do pedido também deixa o que o Liame
//   guarda da avaliação como o Google a tem agora: é de lá que a tela do pedido tira o texto.
// - O nome de quem avaliou é lido junto, só para o plano conferir que a resposta não o cita. Ele não entra no estado,
//   no pedido, na auditoria nem em registro (D-A6-5).
// - A versão sai do estado. Se a avaliação mudou entre o pedido e a execução (a pessoa editou o texto ou a nota, apagou
//   a avaliação, ou alguém respondeu direto no Google), nada é publicado: é "estado mudou" (critério A6-4).
// - Cada execução manda a resposta UMA vez. Se a tentativa cair sem resposta do Google, a seguinte lê a avaliação
//   antes: com a resposta já lá, não manda de novo (quem avaliou é avisado pelo Google quando a resposta sai).
// - Apagar a resposta (a volta, `avaliacao_apagar_resposta`) é o mesmo caminho com o estado desejado sem resposta: só
//   apaga se a resposta que está no Google ainda é a que o Liame publicou (a versão), e a que já saiu conta como feita.
// - O token da loja sai do cofre só na hora de chamar e nunca vai para log, estado ou auditoria.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER = 'google_business';
const PREFIXO = 'avaliacao:';

/** A leitura da hora do pedido não espera o Google mais que isto: passou, a pessoa recebe "tente de novo". */
const TEMPO_DA_LEITURA_DO_PEDIDO_MS = 10_000;
/** Depois de publicar uma resposta, em quanto tempo a loja é lida de novo (o Google costuma conferir em até 10 minutos). */
export const MINUTOS_ATE_A_CONFERENCIA = 10;

/** `avaliacao:<id>` → o id da avaliação no Liame. */
export function avaliacaoDoRecurso(resourceId: string): string | null {
  if (!resourceId.startsWith(PREFIXO)) return null;
  const id = resourceId.slice(PREFIXO.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

/** O recurso de uma avaliação, para quem monta o pedido. */
export const recursoDaAvaliacao = (id: string): string => `${PREFIXO}${id}`;

/** O que a resposta precisa do resto do app; ligado na subida (API e worker). */
export type DependenciasDaRespostaNoPerfil = {
  lerSegredo: (tx: Tx, secretId: string) => Promise<string | null>;
  /** O acesso do Google a partir da autorização guardada da loja. */
  acesso: (refreshToken: string) => Promise<string>;
  /** O conector do Perfil, com um cliente HTTP de uma tentativa por chamada. Com o tempo limite, é o da leitura que tem uma pessoa esperando. */
  conector: (tempoLimiteMs?: number) => Promise<ConectorPerfilGoogle>;
};

type Conta = { id: string; tenant_id: string; brand_id: string; external_id: string; conta: string | null; credential_secret_id: string | null };
type Preparada = { conta: Conta; alvo: AlvoDaAvaliacao; avaliacao: { id: string; googleId: string }; refreshToken: string };

const recusado = (mensagem: string): ApplyResult => ({ ok: false, reason: 'recusado', mensagem });

/** O que o pedido faz no Google: publicar a resposta, ou apagar a que o Liame publicou. */
export type EscritaNoPerfil = 'publicar' | 'apagar';
/** Como termina a frase da recusa: o que NÃO aconteceu. */
const NADA_FEITO: Record<EscritaNoPerfil, string> = { publicar: 'Nada foi publicado.', apagar: 'A resposta continua no perfil.' };

const SEM_ACESSO = 'O Google recusou a autorização desta loja. Conecte o Google de novo em Contas conectadas.';
const SEM_PERMISSAO =
  'O Google não deixou o Liame responder por esta loja: a conta do Google que autorizou não cuida mais do perfil, ou o perfil não está verificado. Autorize de novo em Contas conectadas, com a conta que cuida do perfil.';
const SUMIU_A_LOJA = 'A loja desta avaliação foi desligada do Liame depois do pedido.';
const SUMIU_A_AVALIACAO = 'Esta avaliação não está mais no Google: quem escreveu apagou, ou o Google tirou.';
const FORA_DO_AMBIENTE = 'A resposta a avaliações do Google não está disponível neste ambiente.';
const NAO_E_DESTA = 'O pedido não é desta avaliação.';
const NAO_ACEITOU: Record<EscritaNoPerfil, string> = { publicar: 'O Google não aceitou a resposta.', apagar: 'O Google não deixou apagar a resposta.' };

/**
 * A recusa definitiva do Google em palavras; nulo para o que é passageiro (limite, fora do ar): isso sobe para quem
 * executa adiar. O texto do Google não vai para a pessoa (vem em inglês e é de quem programa): fica no registro.
 * A avaliação que sumiu levou a resposta junto: ao apagar, a frase não diz que a resposta continua lá.
 */
export function recusaDoPerfil(err: unknown, escrita: EscritaNoPerfil = 'publicar'): string | null {
  if (!(err instanceof ErroConector)) return null;
  if (err.tipo === 'autenticacao') return `${SEM_ACESSO} ${NADA_FEITO[escrita]}`;
  if (err.tipo === 'permissao') return `${SEM_PERMISSAO} ${NADA_FEITO[escrita]}`;
  if (err.tipo !== 'definitivo') return null;
  if (err.status === 404) return escrita === 'publicar' ? `${SUMIU_A_AVALIACAO} ${NADA_FEITO.publicar}` : SUMIU_A_AVALIACAO;
  return `${NAO_ACEITOU[escrita]} ${NADA_FEITO[escrita]}`;
}

export class PerfilAvaliacaoConnector implements Connector {
  readonly provider = PROVIDER;
  readonly writeFlag = FLAG_PERFIL_GOOGLE_ESCRITA;
  // Responder a uma avaliação não gasta verba de mídia.
  readonly requiresSpendLimits = false;
  private readonly logger = new Logger('resposta-no-perfil');
  private deps: DependenciasDaRespostaNoPerfil | null = null;

  ligar(deps: DependenciasDaRespostaNoPerfil): void {
    this.deps = deps;
  }

  /** A parte do banco: a loja do perfil da empresa, a avaliação guardada e a autorização. Nulo quando não é desta empresa. */
  private async preparar(tx: Tx, ref: ResourceRef, deps: DependenciasDaRespostaNoPerfil): Promise<Preparada | null> {
    const id = avaliacaoDoRecurso(ref.resourceId);
    if (!id || !UUID.test(ref.accountId)) return null;
    const c = await tx.execute<Conta>(sql`
      select a.id, a.tenant_id, a.brand_id, a.external_id, a.provider_attributes ->> 'conta' as conta, a.credential_secret_id
        from liame.connected_account a
       where a.id = ${ref.accountId} and a.tenant_id = ${ref.tenantId} and a.provider = ${PROVIDER} and a.disconnected_at is null`);
    const conta = c.rows[0];
    if (!conta) return null;
    const r = await tx.execute<{ external_id: string }>(sql`
      select external_id from liame.profile_review where id = ${id} and connected_account_id = ${conta.id} and tenant_id = ${ref.tenantId}`);
    const guardadaNoLiame = r.rows[0];
    if (!guardadaNoLiame) return null;
    if (!conta.conta) throw new ErroConector('definitivo', PROVIDER, 'a loja não tem a conta do Perfil guardada: ligue a loja de novo');
    const guardada = conta.credential_secret_id ? await deps.lerSegredo(tx, conta.credential_secret_id) : null;
    const credencial = guardada ? (JSON.parse(guardada) as CredencialGuardada) : null;
    if (credencial?.tipo !== 'google') throw new ErroConector('autenticacao', PROVIDER, 'autorização revogada ou ausente');
    return {
      conta,
      alvo: { conta: conta.conta, loja: conta.external_id, avaliacao: guardadaNoLiame.external_id },
      avaliacao: { id, googleId: guardadaNoLiame.external_id },
      refreshToken: credencial.refresh_token,
    };
  }

  /** O que o Liame guarda da avaliação fica como o Google a tem agora (a mesma gravação da leitura de hora em hora). */
  private async guardar(tx: Tx, p: Preparada, lida: AvaliacaoLida): Promise<void> {
    await gravarAvaliacoes(tx, { tenantId: p.conta.tenant_id, brandId: p.conta.brand_id, connectedAccountId: p.conta.id }, [lida], new Date());
  }

  /**
   * Depois de publicar, a leitura das avaliações desta loja vem em dez minutos, e não só na hora cheia: é ela que traz
   * a conferência do Google (`conferirRespostas`, no sincronizador). Só adianta a vez; a loja que espera depois de uma
   * falha (o limite de cota, a autorização) continua esperando. Mexe só na chave `proxima` do cursor: se a leitura
   * estiver no meio e gravar o cursor dela por cima, a conferência fica para a volta seguinte, e nada se perde.
   */
  private async apressarALeitura(tx: Tx, p: Preparada): Promise<void> {
    const quando = new Date(Date.now() + MINUTOS_ATE_A_CONFERENCIA * 60_000).toISOString();
    await tx.execute(sql`
      update liame.sync_state s
         set cursor = s.cursor || jsonb_build_object('proxima', ${quando}::text)
       where s.connected_account_id = ${p.conta.id} and s.dataset = ${DATASET_AVALIACOES}
         and s.cursor ->> 'espera_ate' is null
         and (s.cursor ->> 'proxima')::timestamptz > ${quando}::timestamptz`);
  }

  /** A leitura da hora do pedido, com o tempo curto de quem tem uma pessoa esperando. */
  async read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    if (!this.deps) throw new Error('resposta no Perfil do Google: dependências não ligadas');
    const p = await this.preparar(tx, ref, this.deps);
    if (!p) return null;
    const accessToken = await this.deps.acesso(p.refreshToken);
    const conector = await this.deps.conector(TEMPO_DA_LEITURA_DO_PEDIDO_MS);
    const lida = await conector.lerAvaliacaoComQuem({ accessToken }, p.alvo, { tempoLimiteMs: TEMPO_DA_LEITURA_DO_PEDIDO_MS });
    if (lida) await this.guardar(tx, p, lida.avaliacao);
    const estado = estadoDaAvaliacao(p.avaliacao, lida?.avaliacao ?? null);
    // O nome de quem avaliou vai só para o plano conferir o texto: não entra no estado.
    const contexto: ContextoDaAvaliacao = { quem: lida?.quem ?? null };
    return { state: estado, version: versaoDaAvaliacao(estado), transient: contexto };
  }

  async apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options: ApplyOptions = {}): Promise<ApplyResult> {
    const deps = this.deps;
    if (!deps) return recusado(FORA_DO_AMBIENTE);
    const quer = EstadoDaAvaliacao.safeParse(desired);
    // O estado desejado sem resposta é o pedido de apagar a que o Liame publicou.
    const escrita: EscritaNoPerfil = quer.success && quer.data.resposta === null ? 'apagar' : 'publicar';
    const nada = NADA_FEITO[escrita];
    let p: Preparada | null;
    let lida: AvaliacaoLida | null = null;
    let accessToken = '';
    let conector: ConectorPerfilGoogle | null = null;
    try {
      p = await this.preparar(tx, ref, deps);
      if (p) {
        accessToken = await deps.acesso(p.refreshToken);
        conector = await deps.conector();
        lida = await conector.lerAvaliacao({ accessToken }, p.alvo);
      }
    } catch (err) {
      const motivo = recusaDoPerfil(err, escrita);
      if (motivo) return recusado(motivo);
      throw err;
    }
    if (!p || !conector) return recusado(`${SUMIU_A_LOJA} ${nada}`);

    const atual = estadoDaAvaliacao(p.avaliacao, lida);
    const versao = versaoDaAvaliacao(atual);
    // Já está como o pedido queria (a tentativa anterior caiu depois de o Google aceitar): nada a mandar de novo.
    if (lida && (respostaJaPublicada(atual, desired) || respostaJaApagada(atual, desired))) {
      if (!options.validateOnly) {
        await this.guardar(tx, p, lida);
        if (escrita === 'publicar') await this.apressarALeitura(tx, p);
      }
      return { ok: true, state: atual, version: versao };
    }
    // A avaliação mudou desde o pedido, sumiu, ou a resposta já não é a mesma: nada é publicado nem apagado (A6-4).
    if (versao !== expectedVersion) return { ok: false, reason: 'estado-mudou', current: { state: atual, version: versao } };
    if (!quer.success || quer.data.id !== atual.id) return recusado(`${NAO_E_DESTA} ${nada}`);
    if (!lida) return recusado(escrita === 'publicar' ? `${SUMIU_A_AVALIACAO} ${nada}` : SUMIU_A_AVALIACAO);
    if (options.validateOnly) return { ok: true, state: desired, version: versao };

    try {
      if (quer.data.resposta === null) {
        await conector.apagarResposta({ accessToken }, p.alvo);
        await this.guardar(tx, p, { ...lida, resposta: null });
        const semResposta: EstadoDaAvaliacao = { ...atual, resposta: null };
        return { ok: true, state: semResposta, version: versaoDaAvaliacao(semResposta) };
      }
      const gravada = await conector.responderAvaliacao({ accessToken }, p.alvo, quer.data.resposta.texto);
      await this.guardar(tx, p, { ...lida, resposta: gravada });
      await this.apressarALeitura(tx, p);
      const estado: EstadoDaAvaliacao = { ...atual, resposta: { situacao: gravada.situacao, texto: gravada.texto, violacao: gravada.violacao } };
      return { ok: true, state: estado, version: versaoDaAvaliacao(estado) };
    } catch (err) {
      const motivo = recusaDoPerfil(err, escrita);
      if (!motivo) throw err;
      // O que o Google disse fica no registro, para quem cuida do produto; a pessoa lê a frase em português.
      if (err instanceof ErroConector) this.logger.warn(`loja ${p.conta.id}: o Google recusou ${escrita} a resposta (${err.tipo}, HTTP ${err.status ?? '?'}): ${err.message}`);
      return recusado(motivo);
    }
  }
}

export const perfilAvaliacaoConnector = new PerfilAvaliacaoConnector();
