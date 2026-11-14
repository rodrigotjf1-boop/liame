import type { Tx } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { parametrosDaCampanha, parametrosDoAnuncio, parametrosDoConjunto, parametrosDoCriativo } from '../campanhas/campanha-nova-plano.js';
import type { LetraDoTeste } from '../campanhas/teste-contas.js';
import {
  chaveDoPassoDoTeste,
  criativoComoCampanhaNova,
  EstadoDoTesteDeCriativo,
  nomeDaCampanhaDeTeste,
  type PassoDoTesteDeCriativo,
  testeDeCriativoDoRecurso,
} from '../campanhas/teste-de-criativo-plano.js';
import { ErroConector } from '../connectors/cliente-http.js';
import type { ApplyOptions, ApplyResult, Connector, ReadResult, ResourceRef } from './connectors.js';
import { recusaDaMeta } from './meta-anuncios.js';
import { CriacaoRecusada, criarNaMeta, type DependenciasDaCriacaoNaMeta, type GrafoDaMeta, midiaNaMeta, mudarSituacaoNaMeta, SEM_ACESSO, tokenDaConta } from './meta-criacao.js';
import type { ResourceState } from './tools.js';

// O teste de criativo na Meta (plano da região, R8; D-RG-76 a D-RG-80). O recurso é o teste do Liame
// (`teste_de_criativo:<id>`, a tabela `campaign_test` com os dois criativos em `campaign_test_arm`), na conta de anúncios
// do pedido. Depois da aprovação com o código do app, o conector cria, nesta ordem, a campanha de teste e, para cada
// criativo (A e depois B), o conjunto, o vídeo (quando a mídia é um vídeo), o criativo e o anúncio, tudo pausado, pelos
// passos comuns da criação na Meta (`meta-criacao.ts`): a validação antes de cada objeto, a chave de idempotência do
// passo e o id guardado logo depois, para a tentativa seguinte continuar dali. A recusa da Meta encerra a criação com o
// motivo; o que já foi criado fica na Meta, pausado, e nada se apaga. Os cupons são do Regem: a rotina dos testes os
// pede depois, pelo teste aprovado. Ativar põe os dois anúncios, os dois conjuntos e a campanha no ar; pausar para a
// campanha (os filhos herdam). O token da empresa sai do cofre só na hora de chamar.

const PROVIDER = 'meta_ads';
const LETRAS: readonly LetraDoTeste[] = ['A', 'B'];

type Braco = {
  letter: LetraDoTeste;
  coupon_code: string;
  coupon_status: string;
  meta_adset_id: string | null;
  meta_video_id: string | null;
  meta_creative_id: string | null;
  meta_ad_id: string | null;
  video_esperando_ms: number | null;
  midia_chave: string | null;
  midia_viva: boolean;
};

type Linha = {
  id: string;
  status: string;
  active: boolean;
  version: number;
  error: string | null;
  meta_campaign_id: string | null;
  conta_externa: string;
  credential_secret_id: string | null;
  bracos: Record<LetraDoTeste, Braco>;
};

const recusado = (mensagem: string): ApplyResult => ({ ok: false, reason: 'recusado', mensagem });

const FORA_DO_AMBIENTE = 'A criação de campanha na Meta não está disponível neste ambiente.';
const SUMIU = 'Este teste não está mais aqui (uma peça, uma mídia ou a conta saiu da marca).';
const MIDIA_DO_TESTE_SAIU = 'A foto ou o vídeo de um dos criativos saiu de Fotos: a campanha de teste não foi criada. Peça o teste de novo com outra mídia.';
const VIDEO_SEM_PREPARO = 'A Meta não terminou de preparar o vídeo em 15 minutos: a campanha de teste não foi criada. Peça de novo; se repetir, use outro vídeo.';
const VIDEO_RECUSADO = 'A Meta não aceitou o vídeo: a campanha de teste não foi criada. Use outro vídeo de Fotos.';
const FICOU_PAUSADO = 'O que já foi criado na Meta ficou pausado: nada aparece para ninguém nem gasta.';

/**
 * O teste do pedido (sob a RLS da empresa) e o estado dele: o plano que a pessoa aprovou, com a situação de agora, se
 * está ativo e em que pé está o cupom de cada criativo. Nulo quando o teste não é desta empresa e desta conta, ou quando
 * falta um dos dois criativos.
 */
export async function lerTesteDeCriativo(tx: Tx, ref: ResourceRef, travar = false): Promise<{ linha: Linha; estado: EstadoDoTesteDeCriativo } | null> {
  const id = testeDeCriativoDoRecurso(ref.resourceId);
  if (!id) return null;
  const t = (
    await tx.execute<{
      id: string;
      status: string;
      active: boolean;
      version: number;
      error: string | null;
      meta_campaign_id: string | null;
      plan: unknown;
      conta_externa: string;
      credential_secret_id: string | null;
    }>(sql`
      select t.id, t.status, t.active, t.version, t.error, t.meta_campaign_id, t.plan, a.external_id as conta_externa, a.credential_secret_id
        from liame.campaign_test t
        join liame.connected_account a on a.id = t.ad_account_id and a.tenant_id = t.tenant_id and a.provider = ${PROVIDER}
       where t.id = ${id} and t.tenant_id = ${ref.tenantId} and t.ad_account_id = ${ref.accountId} and t.kind = 'criativo'
       ${travar ? sql`for update of t` : sql``}`)
  ).rows[0];
  if (!t) return null;
  const bracos = (
    await tx.execute<Omit<Braco, 'video_esperando_ms'> & { video_esperando_ms: string | null }>(sql`
      select b.letter, b.coupon_code, b.coupon_status, b.meta_adset_id, b.meta_video_id, b.meta_creative_id, b.meta_ad_id,
             (extract(epoch from now() - b.video_waiting_since) * 1000)::bigint::text as video_esperando_ms,
             m.object_key as midia_chave, coalesce(m.status = 'pronta' and m.removed_at is null, false) as midia_viva
        from liame.campaign_test_arm b
        left join liame.brand_photo m on m.id = b.media_id and m.tenant_id = b.tenant_id
       where b.test_id = ${t.id} and b.tenant_id = ${ref.tenantId}
       order by b.letter
       ${travar ? sql`for update of b` : sql``}`)
  ).rows.map((b) => ({ ...b, video_esperando_ms: b.video_esperando_ms === null ? null : Number(b.video_esperando_ms) }));
  const [a, b] = bracos;
  if (bracos.length !== 2 || !a || !b || a.letter !== 'A' || b.letter !== 'B') return null;
  const plano = EstadoDoTesteDeCriativo.omit({ situacao: true, ativa: true }).safeParse(t.plan);
  if (!plano.success) return null;
  const [pa, pb] = plano.data.criativos;
  const estado = EstadoDoTesteDeCriativo.parse({
    ...plano.data,
    teste: t.id,
    criativos: [
      { ...pa, cupom: { codigo: a.coupon_code, situacao: a.coupon_status } },
      { ...pb, cupom: { codigo: b.coupon_code, situacao: b.coupon_status } },
    ],
    situacao: t.status,
    ativa: t.active,
  });
  return { linha: { ...t, version: Number(t.version), bracos: { A: a, B: b } }, estado };
}

export class TesteDeCriativoNaMetaConnector implements Connector {
  readonly provider = PROVIDER;
  readonly writeFlag = 'meta_write';
  // Criar não gasta (nasce pausada): o pedido não reserva verba. Ativar reserva a verba do teste inteiro.
  readonly requiresSpendLimits = true;
  readonly needsWriteAuthorization = true;
  private readonly logger = new Logger('teste-de-criativo');
  private deps: DependenciasDaCriacaoNaMeta | null = null;

  ligar(deps: DependenciasDaCriacaoNaMeta): void {
    this.deps = deps;
  }

  async read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    const lida = await lerTesteDeCriativo(tx, ref);
    return lida ? { state: lida.estado as unknown as ResourceState, version: lida.linha.version } : null;
  }

  async apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options: ApplyOptions = {}): Promise<ApplyResult> {
    const lida = await lerTesteDeCriativo(tx, ref, true);
    if (!lida) return recusado(SUMIU);
    const { linha, estado } = lida;
    const comoEsta = { state: estado as unknown as ResourceState, version: linha.version };
    // Ativar ou pausar a campanha de teste que já existe. Já como o pedido quer (a resposta que se perdeu): nada a fazer.
    const ativar = desired.ativa === true;
    if (ativar || linha.active) {
      if (ativar === linha.active) return { ok: true, ...comoEsta };
      if (linha.version !== expectedVersion) return { ok: false, reason: 'estado-mudou', current: comoEsta };
      if (options.validateOnly) return { ok: true, state: desired, version: linha.version };
      if (!this.deps) return recusado(FORA_DO_AMBIENTE);
      return this.mudarSituacao(tx, linha, estado, ativar, this.deps);
    }
    // A criação: do pedido aprovado, ou a continuação da que ficou no meio (a Meta mandou esperar, o vídeo em preparo).
    if (linha.status === 'cancelado') return recusado(linha.error ?? 'Este teste foi cancelado: nada foi criado na Meta.');
    if (linha.status !== 'pedido' && linha.status !== 'criando') return { ok: true, ...comoEsta };
    // Alguém mudou o pedido desde a aprovação: nada é criado com o que não foi aprovado.
    if (linha.version !== expectedVersion) return { ok: false, reason: 'estado-mudou', current: comoEsta };
    // A validação de cada objeto é na Meta, passo a passo, com o pai de verdade: aqui só confere o pedido.
    if (options.validateOnly) return { ok: true, state: desired, version: linha.version };
    const deps = this.deps;
    if (!deps) return recusado(FORA_DO_AMBIENTE);
    if (LETRAS.some((letra) => !linha.bracos[letra].midia_viva)) return this.naoCriou(tx, linha, MIDIA_DO_TESTE_SAIU);

    await tx.execute(sql`update liame.campaign_test set status = 'criando', updated_at = now() where id = ${linha.id}`);
    const g: GrafoDaMeta = { deps, conta: linha.conta_externa, token: await tokenDaConta(tx, linha.credential_secret_id, deps), versao: await deps.versao('anuncio_criar') };
    const chave = (passo: PassoDoTesteDeCriativo) => chaveDoPassoDoTeste(linha.id, passo);
    const guardar = (letra: LetraDoTeste, coluna: 'meta_adset_id' | 'meta_video_id' | 'meta_creative_id' | 'meta_ad_id', valor: string) =>
      tx.execute(sql`update liame.campaign_test_arm set ${sql.raw(coluna)} = ${valor}, updated_at = now() where test_id = ${linha.id} and letter = ${letra}`);
    try {
      const daCampanha = { ...criativoComoCampanhaNova(estado, 'A'), nome: nomeDaCampanhaDeTeste(estado.nome) };
      const campanha = linha.meta_campaign_id ?? (await criarNaMeta(g, 'campaigns', parametrosDaCampanha(daCampanha), chave('campanha')));
      if (!linha.meta_campaign_id) await tx.execute(sql`update liame.campaign_test set meta_campaign_id = ${campanha}, updated_at = now() where id = ${linha.id}`);
      const criados: Record<string, string> = { campanha };
      for (const letra of LETRAS) {
        const braco = linha.bracos[letra];
        const criativoDoBraco = criativoComoCampanhaNova(estado, letra);
        const conjunto = braco.meta_adset_id ?? (await criarNaMeta(g, 'adsets', parametrosDoConjunto(criativoDoBraco, campanha), chave(`conjunto:${letra}`)));
        if (!braco.meta_adset_id) await guardar(letra, 'meta_adset_id', conjunto);
        const tipo = estado.criativos[letra === 'A' ? 0 : 1].midia.tipo;
        const midia = await midiaNaMeta(g, { tipo, chave: braco.midia_chave, nome: criativoDoBraco.nome, video: braco.meta_video_id, esperandoMs: braco.video_esperando_ms }, async (video) => {
          await guardar(letra, 'meta_video_id', video);
          await tx.execute(sql`update liame.campaign_test_arm set video_waiting_since = coalesce(video_waiting_since, now()) where test_id = ${linha.id} and letter = ${letra}`);
        });
        if (midia === 'recusado') return this.naoCriou(tx, linha, `${VIDEO_RECUSADO} ${FICOU_PAUSADO}`);
        if (midia === 'sem_preparo') return this.naoCriou(tx, linha, `${VIDEO_SEM_PREPARO} ${FICOU_PAUSADO}`);
        const criativo = braco.meta_creative_id ?? (await criarNaMeta(g, 'adcreatives', parametrosDoCriativo(criativoDoBraco, midia), chave(`criativo:${letra}`)));
        if (!braco.meta_creative_id) await guardar(letra, 'meta_creative_id', criativo);
        const anuncio = braco.meta_ad_id ?? (await criarNaMeta(g, 'ads', parametrosDoAnuncio(criativoDoBraco, conjunto, criativo), chave(`anuncio:${letra}`)));
        if (!braco.meta_ad_id) await guardar(letra, 'meta_ad_id', anuncio);
        Object.assign(criados, { [`conjunto_${letra}`]: conjunto, [`criativo_${letra}`]: criativo, [`anuncio_${letra}`]: anuncio });
      }
      // Tudo criado e pausado. O teste segue `criando` até os dois cupons existirem no Regem (a rotina dos testes).
      await tx.execute(sql`update liame.campaign_test set error = null, updated_at = now() where id = ${linha.id}`);
      return { ok: true, state: { ...estado, situacao: 'criando', meta: criados } as unknown as ResourceState, version: linha.version };
    } catch (err) {
      const motivo = err instanceof CriacaoRecusada ? err.message : err instanceof ErroConector && err.tipo === 'autenticacao' ? SEM_ACESSO : recusaDaMeta(err);
      // O que é passageiro (o limite da conta, a Meta fora do ar, o vídeo em preparo) sobe: o executor adia, e a
      // transação guarda o que já foi criado, para a próxima tentativa continuar dali.
      if (!motivo) throw err;
      return this.naoCriou(tx, linha, `${motivo} ${FICOU_PAUSADO}`);
    }
  }

  /**
   * Ativar ou pausar a campanha de teste. Ativar põe os dois anúncios, os dois conjuntos e a campanha em ACTIVE, nesta
   * ordem (nada roda antes de tudo estar ativo), e o teste passa a rodar: o primeiro dia inteiro é o dia seguinte, no
   * fuso da loja. Pausar põe a campanha em PAUSED (os filhos herdam); o teste que rodava fica encerrado. A versão do
   * teste sobe: a volta confere por ela que ninguém mexeu depois.
   */
  private async mudarSituacao(tx: Tx, linha: Linha, estado: EstadoDoTesteDeCriativo, ativar: boolean, deps: DependenciasDaCriacaoNaMeta): Promise<ApplyResult> {
    const { A, B } = linha.bracos;
    const ids = ativar ? [A.meta_ad_id, B.meta_ad_id, A.meta_adset_id, B.meta_adset_id, linha.meta_campaign_id] : [linha.meta_campaign_id];
    if (ids.some((id) => !id)) return recusado('O Liame não guardou os objetos deste teste na Meta: confira no Gerenciador de Anúncios.');
    const token = await tokenDaConta(tx, linha.credential_secret_id, deps);
    const g: GrafoDaMeta = { deps, conta: linha.conta_externa, token, versao: await deps.versao('entity_update') };
    const leitura = await deps.versao('entity_state');
    const recusa = await mudarSituacaoNaMeta(g, leitura, ids as string[], ativar);
    if (recusa) return recusado(recusa);
    const situacao = ativar ? 'rodando' : linha.status === 'rodando' ? 'encerrado' : linha.status;
    await tx.execute(sql`
      update liame.campaign_test
         set active = ${ativar}, status = ${situacao},
             started_on = case when ${ativar} then (now() at time zone ${estado.fuso})::date + 1 else started_on end,
             stopped_at = case when ${situacao} = 'encerrado' then coalesce(stopped_at, now()) else stopped_at end,
             version = version + 1, updated_at = now()
       where id = ${linha.id}`);
    return { ok: true, state: { ...estado, ativa: ativar, situacao } as unknown as ResourceState, version: linha.version + 1 };
  }

  /** A criação que não vai adiante: o teste fica cancelado, com o motivo; o que existe na Meta fica pausado. */
  private async naoCriou(tx: Tx, linha: Linha, motivo: string): Promise<ApplyResult> {
    await tx.execute(sql`update liame.campaign_test set status = 'cancelado', error = ${motivo.slice(0, 2000)}, updated_at = now() where id = ${linha.id}`);
    this.logger.warn(`teste de criativo ${linha.id}: não criado (${motivo.slice(0, 200)})`);
    return recusado(motivo);
  }
}

export const testeDeCriativoNaMetaConnector = new TesteDeCriativoNaMetaConnector();
