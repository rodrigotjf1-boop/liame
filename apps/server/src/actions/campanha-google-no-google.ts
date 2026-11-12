import type { Tx } from '@liame/database';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  campanhaGoogleDoRecurso,
  consultaDaCampanhaCriada,
  EstadoDaCampanhaNovaNoGoogle,
  type IdsNoGoogle,
  idsDaCriacao,
  idsDaProcura,
  operacoesDaCriacao,
} from '../campanhas/campanha-google-plano.js';
import { FotoNaoServe, imagensDoGoogle } from '../campanhas/imagens-do-google.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { type ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { soDigitos } from '../connectors/validacao.js';
import { SemSharp } from '../fotos/processar.js';
import { type ArmazemDeImagens, ArmazemIndisponivel, FalhaDoArmazem } from '../imagens/armazem.js';
import { chaveDaLogoDaMarca } from '../marca/logo-da-marca.service.js';
import type { ApplyOptions, ApplyResult, Connector, ReadResult, ResourceRef } from './connectors.js';
import { comEsperaDoLimiteDiario, recusaDoGoogle } from './google-anuncios.js';
import type { ResourceState } from './tools.js';

// A campanha nova no Google, criada pausada (A5, Y9; P45; D-A5-21 a D-A5-28). O recurso é a campanha nova do Liame no
// Google (`campanha_google:<id>`, a tabela `google_campaign_new`), na conta do Google Ads do pedido. O conector lê o
// estado que a pessoa aprova (a peça e os textos, a foto e as medidas dela, o nome e a logo da loja, a loja e o raio, a
// verba, o fim e o destino) e, depois da aprovação com o código do app, cria a Performance Max (parte 3):
// - numa requisição só (`googleAds:mutate`): o orçamento só desta campanha, a campanha PAUSADA, o raio em volta da loja e
//   o idioma, os textos, os recortes da foto, o nome e a logo da loja, o grupo de recursos com o link e os recursos dele
//   (`operacoesDaCriacao`). O Google cria tudo ou nada;
// - antes, a mesma requisição com `validateOnly`, que não cria nada e só devolve os erros; a recusa do Google (aqui ou
//   na criação) encerra o pedido com o motivo, e nada foi criado no Google;
// - o que é passageiro (o limite, o Google fora do ar, o armazenamento sem responder) sobe: o executor adia. A situação
//   "criando" fica gravada; na tentativa seguinte, antes de criar de novo, o Liame procura a campanha pelo nome (que
//   termina na marca do Liame, única): a criação que deu certo e perdeu a resposta não sai em dobro;
// - os ids do orçamento, da campanha e do grupo de recursos ficam na linha.
// O token sai do cofre só na hora de chamar e nunca vai para log, estado ou auditoria. A função `campanha_google` nasce
// desligada; ativar a campanha criada é outro pedido.

const PROVIDER = 'google_ads';
const FORA_DO_AMBIENTE = 'A criação de campanha no Google não está disponível neste ambiente: nada foi criado no Google.';
const SUMIU = 'Esta campanha nova não está mais aqui (a peça, a foto, a logo ou a conta saiu da marca).';
const IMAGEM_SAIU = 'A foto ou a logo desta campanha não está mais no Liame: nada foi criado no Google. Escolha outra foto e peça de novo.';
const IMAGEM_NAO_ABRE = 'A foto ou a logo desta campanha não abriu para o recorte: nada foi criado no Google. Escolha outra foto e peça de novo.';
const SEM_IDS = 'O Google não devolveu o que criou: confira as campanhas da conta no Google Ads antes de pedir de novo.';

/** Quanto a criação espera o Google: a requisição leva as imagens. */
const TEMPO_DA_CRIACAO_MS = 90_000;

/** O que o conector precisa do resto do app; ligado na subida (API e worker), junto com a escrita no Google. */
export type DependenciasDaCampanhaGoogle = {
  lerSegredo: (tx: Tx, secretId: string) => Promise<string | null>;
  /** O cliente HTTP da escrita, com a cota diária por empresa (a mesma da escrita no Google). */
  cliente: () => ClienteConector;
  googleAdsUrl: string;
  /** Troca o que está no cofre por um token de acesso curto (só na memória de quem vai chamar). */
  acesso: (refreshToken: string) => Promise<string>;
  /** A versão da API registrada para a capacidade (Capability Registry). */
  versao: (capacidade: 'campanha_criar' | 'entity_state') => Promise<string>;
  armazem: Pick<ArmazemDeImagens, 'ler'>;
};

type Linha = {
  id: string;
  status: string;
  active: boolean;
  version: number;
  error: string | null;
  google_campaign_id: string | null;
  foto_chave: string;
  login_customer_id: string | null;
  credential_secret_id: string | null;
};

/** O que a criação usa para falar com o Google: a chave da cota, os cabeçalhos (com o token curto) e a versão. */
type Conexao = { deps: DependenciasDaCampanhaGoogle; chave: string; cabecalhos: Record<string, string> };

/** A criação que não vai adiante, com o motivo para a pessoa (nada foi criado no Google). */
class CriacaoRecusada extends Error {}

const recusado = (mensagem: string): ApplyResult => ({ ok: false, reason: 'recusado', mensagem });

/**
 * A campanha nova do Google (sob a RLS da empresa) e o estado dela, como o pedido guarda. Nulo quando ela não é desta
 * empresa e desta conta, quando a conta foi desconectada, ou quando a foto, a logo ou o ponto da loja não estão mais lá.
 */
export async function lerCampanhaGoogle(tx: Tx, ref: ResourceRef, travar = false): Promise<{ linha: Linha; estado: EstadoDaCampanhaNovaNoGoogle } | null> {
  const id = campanhaGoogleDoRecurso(ref.resourceId);
  if (!id) return null;
  const r = await tx.execute<
    Linha & {
      brand_id: string;
      name: string;
      piece_id: string;
      piece_version: number;
      headlines: string[];
      long_headlines: string[];
      descriptions: string[];
      business_name: string;
      media_id: string;
      media_file: string;
      width: number;
      height: number;
      logo_id: string | null;
      logo_lado: number | null;
      radius_km: string;
      daily_budget_micros: string;
      end_date: string | null;
      link: string;
      unit_id: string;
      unit_nome: string;
      latitude: string | null;
      longitude: string | null;
      conta_externa: string;
      conta_nome: string;
      currency: string | null;
      timezone: string | null;
    }
  >(sql`
    select c.id, c.status, c.active, c.version, c.error, c.google_campaign_id,
           c.brand_id, c.name, c.piece_id, c.piece_version, c.headlines, c.long_headlines, c.descriptions, c.business_name,
           c.media_id, m.sha256 as media_file, m.object_key as foto_chave, m.width, m.height,
           b.logo_id, least(b.logo_width, b.logo_height) as logo_lado,
           c.radius_km::text, c.daily_budget_micros::text, c.end_date::text as end_date, c.link,
           u.id as unit_id, u.name as unit_nome, u.latitude::text, u.longitude::text,
           a.external_id as conta_externa, a.name as conta_nome, a.currency, o.timezone,
           a.provider_attributes->>'login_customer_id' as login_customer_id, a.credential_secret_id
      from liame.google_campaign_new c
      join liame.brand_photo m on m.id = c.media_id and m.tenant_id = c.tenant_id and m.status = 'pronta' and m.removed_at is null
      join liame.brand b on b.id = c.brand_id and b.tenant_id = c.tenant_id
      join liame.unit u on u.id = c.unit_id and u.tenant_id = c.tenant_id
      join liame.connected_account a on a.id = c.ad_account_id and a.tenant_id = c.tenant_id and a.provider = ${PROVIDER} and a.disconnected_at is null
      join liame.organization o on o.id = c.tenant_id
     where c.id = ${id} and c.tenant_id = ${ref.tenantId} and c.ad_account_id = ${ref.accountId}
     ${travar ? sql`for update of c` : sql``}`);
  const l = r.rows[0];
  if (!l || l.latitude === null || l.longitude === null || !l.logo_id || !l.logo_lado) return null;
  const lido = EstadoDaCampanhaNovaNoGoogle.safeParse({
    campanha: l.id,
    marca: l.brand_id,
    nome: l.name,
    peca: { id: l.piece_id, versao: l.piece_version },
    textos: { titulos: l.headlines, titulos_longos: l.long_headlines, descricoes: l.descriptions },
    foto: { id: l.media_id, arquivo: l.media_file, largura: l.width, altura: l.height },
    loja_no_google: { nome: l.business_name, logo: l.logo_id, logo_lado: Number(l.logo_lado) },
    conta: { id: l.conta_externa, nome: l.conta_nome },
    loja: { id: l.unit_id, nome: l.unit_nome, latitude: Number(l.latitude), longitude: Number(l.longitude) },
    raio_km: Number(l.radius_km),
    verba_diaria_micros: Number(l.daily_budget_micros),
    moeda: l.currency ?? 'BRL',
    fim: l.end_date,
    fuso: l.timezone ?? 'America/Sao_Paulo',
    link: l.link,
    situacao: l.status,
    ativa: l.active,
  });
  if (!lido.success) return null;
  return {
    linha: {
      id: l.id,
      status: l.status,
      active: l.active,
      version: Number(l.version),
      error: l.error,
      google_campaign_id: l.google_campaign_id,
      foto_chave: l.foto_chave,
      login_customer_id: l.login_customer_id,
      credential_secret_id: l.credential_secret_id,
    },
    estado: lido.data,
  };
}

export class CampanhaGoogleConnector implements Connector {
  readonly provider = PROVIDER;
  readonly writeFlag = 'google_write';
  // Criar não gasta (nasce pausada); o registro do Google continua pedindo os limites para o que gasta (ativar).
  readonly requiresSpendLimits = true;
  private readonly logger = new Logger('campanha-google');
  private deps: DependenciasDaCampanhaGoogle | null = null;

  ligar(deps: DependenciasDaCampanhaGoogle): void {
    this.deps = deps;
  }

  async read(tx: Tx, ref: ResourceRef): Promise<ReadResult | null> {
    const lida = await lerCampanhaGoogle(tx, ref);
    return lida ? { state: lida.estado as unknown as ResourceState, version: lida.linha.version } : null;
  }

  async apply(tx: Tx, ref: ResourceRef, desired: ResourceState, expectedVersion: number, options: ApplyOptions = {}): Promise<ApplyResult> {
    const lida = await lerCampanhaGoogle(tx, ref, true);
    if (!lida) return recusado(SUMIU);
    const { linha, estado } = lida;
    if (linha.status === 'criada') return { ok: true, state: estado as unknown as ResourceState, version: linha.version };
    if (linha.status === 'cancelada') return recusado('Esta campanha nova foi cancelada: nada foi criado no Google.');
    if (linha.status === 'nao_criada') return recusado(linha.error ?? 'Esta campanha nova não foi criada.');
    // Alguém mudou o pedido desde a aprovação: nada é criado com o que não foi aprovado.
    if (linha.version !== expectedVersion) return { ok: false, reason: 'estado-mudou', current: { state: estado as unknown as ResourceState, version: linha.version } };
    // A conferência do Google (`validateOnly`) é a da criação, com as imagens prontas: aqui só confere o pedido.
    if (options.validateOnly) return { ok: true, state: desired, version: linha.version };
    const deps = this.deps;
    if (!deps) return recusado(FORA_DO_AMBIENTE);

    const tentouAntes = linha.status === 'criando';
    await tx.execute(sql`update liame.google_campaign_new set status = 'criando', updated_at = now() where id = ${linha.id}`);
    try {
      const g = await this.conexao(tx, ref, linha, deps);
      // A tentativa anterior pode ter criado tudo e perdido a resposta: antes de criar de novo, a procura pelo nome.
      const achada = tentouAntes ? await this.procurar(g, estado) : null;
      if (achada) this.logger.warn(`campanha nova ${linha.id}: achada no Google na nova tentativa (a resposta da criação tinha se perdido)`);
      const ids = achada ?? (await this.criar(g, ref, linha, estado));
      await tx.execute(sql`
        update liame.google_campaign_new
           set status = 'criada', error = null, google_budget_id = ${ids.orcamento}, google_campaign_id = ${ids.campanha},
               google_asset_group_id = ${ids.grupo}, updated_at = now()
         where id = ${linha.id}`);
      return { ok: true, state: { ...estado, situacao: 'criada', google: ids } as unknown as ResourceState, version: linha.version };
    } catch (err) {
      if (err instanceof CriacaoRecusada) return this.naoCriou(tx, linha, err.message);
      const motivo = recusaDoGoogle(err);
      if (motivo) return this.naoCriou(tx, linha, motivo);
      // Passageiro: sobe para o executor adiar; a situação "criando" fica, para a procura da próxima tentativa.
      throw comEsperaDoLimiteDiario(err);
    }
  }

  /** O token curto (trocado a partir do cofre), os cabeçalhos com a conta gerente e a chave da cota da escrita. */
  private async conexao(tx: Tx, ref: ResourceRef, linha: Linha, deps: DependenciasDaCampanhaGoogle): Promise<Conexao> {
    const guardada = linha.credential_secret_id ? await deps.lerSegredo(tx, linha.credential_secret_id) : null;
    const credencial = guardada ? (JSON.parse(guardada) as CredencialGuardada) : null;
    if (!credencial || credencial.tipo !== 'google') throw new ErroConector('autenticacao', PROVIDER, 'autorização revogada ou ausente');
    const token = await deps.acesso(credencial.refresh_token);
    return {
      deps,
      chave: `escrita:${ref.tenantId}`,
      cabecalhos: { authorization: `Bearer ${token}`, ...(soDigitos(linha.login_customer_id) ? { 'login-customer-id': linha.login_customer_id! } : {}) },
    };
  }

  /** A campanha que uma tentativa anterior criou, pelo nome com a marca do Liame; nula quando o Google não a tem. */
  private async procurar(g: Conexao, estado: EstadoDaCampanhaNovaNoGoogle): Promise<IdsNoGoogle | null> {
    const versao = await g.deps.versao('entity_state');
    const r = await g.deps.cliente().requisitar<unknown>({
      provider: PROVIDER,
      conta: g.chave,
      url: `${g.deps.googleAdsUrl}/${versao}/customers/${estado.conta.id}/googleAds:searchStream`,
      metodo: 'POST',
      corpo: { query: consultaDaCampanhaCriada(estado.campanha) },
      endpoint: 'entity_state',
      apiVersion: versao,
      cabecalhos: g.cabecalhos,
    });
    return idsDaProcura(r.corpo);
  }

  /** A conferência do Google (`validateOnly`) e, passando, a criação; devolve os ids do que o Google criou. */
  private async criar(g: Conexao, ref: ResourceRef, linha: Linha, estado: EstadoDaCampanhaNovaNoGoogle): Promise<IdsNoGoogle> {
    const operacoes = operacoesDaCriacao(estado, await this.imagens(g.deps, ref, linha, estado));
    const versao = await g.deps.versao('campanha_criar');
    const mutar = (validar: boolean) =>
      g.deps.cliente().requisitar<unknown>({
        provider: PROVIDER,
        conta: g.chave,
        url: `${g.deps.googleAdsUrl}/${versao}/customers/${estado.conta.id}/googleAds:mutate`,
        metodo: 'POST',
        corpo: { mutateOperations: operacoes, validateOnly: validar },
        endpoint: validar ? 'campanha_criar (validação)' : 'campanha_criar',
        apiVersion: versao,
        cabecalhos: g.cabecalhos,
        // O Google conta operações: a requisição única leva todas.
        custo: operacoes.length,
        tempoLimiteMs: TEMPO_DA_CRIACAO_MS,
      });
    await mutar(true);
    const ids = idsDaCriacao((await mutar(false)).corpo);
    if (!ids) throw new CriacaoRecusada(SEM_IDS);
    return ids;
  }

  /** Os recortes da foto e a logo quadrada, lidos do armazenamento. O passageiro sobe como falha passageira. */
  private async imagens(deps: DependenciasDaCampanhaGoogle, ref: ResourceRef, linha: Linha, estado: EstadoDaCampanhaNovaNoGoogle) {
    let foto: Buffer;
    let logo: Buffer;
    try {
      foto = await deps.armazem.ler(linha.foto_chave);
      logo = await deps.armazem.ler(chaveDaLogoDaMarca(ref.tenantId, estado.marca, estado.loja_no_google.logo));
    } catch (err) {
      if (err instanceof FalhaDoArmazem && err.semArquivo) throw new CriacaoRecusada(IMAGEM_SAIU);
      if (err instanceof FalhaDoArmazem || err instanceof ArmazemIndisponivel) throw new ErroConector('transitorio', PROVIDER, 'o armazenamento de imagens não respondeu');
      throw err;
    }
    try {
      return await imagensDoGoogle(foto, logo);
    } catch (err) {
      if (err instanceof FotoNaoServe) throw new CriacaoRecusada(`${err.message.replace(/ Use outra foto\.$/, '')} Nada foi criado no Google.`);
      if (err instanceof SemSharp) throw new ErroConector('transitorio', PROVIDER, 'o recorte das imagens não está disponível agora');
      this.logger.warn(`campanha nova ${linha.id}: a foto ou a logo não abriu (${err instanceof Error ? err.message.slice(0, 200) : 'erro'})`);
      throw new CriacaoRecusada(IMAGEM_NAO_ABRE);
    }
  }

  /** A criação que não vai adiante: a campanha nova fica "não criada", com o motivo; nada foi criado no Google. */
  private async naoCriou(tx: Tx, linha: Linha, motivo: string): Promise<ApplyResult> {
    await tx.execute(sql`update liame.google_campaign_new set status = 'nao_criada', error = ${motivo.slice(0, 2000)}, updated_at = now() where id = ${linha.id}`);
    this.logger.warn(`campanha nova ${linha.id}: não criada (${motivo.slice(0, 200)})`);
    return recusado(motivo);
  }
}

export const campanhaGoogleConnector = new CampanhaGoogleConnector();
