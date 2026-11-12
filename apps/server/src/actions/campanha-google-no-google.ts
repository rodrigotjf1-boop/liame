import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { campanhaGoogleDoRecurso, EstadoDaCampanhaNovaNoGoogle } from '../campanhas/campanha-google-plano.js';
import type { ApplyOptions, ApplyResult, Connector, ReadResult, ResourceRef } from './connectors.js';
import type { ResourceState } from './tools.js';

// A campanha nova no Google, criada pausada (A5, Y9, parte 2; P45; D-A5-21 a D-A5-26). O recurso é a campanha nova do
// Liame no Google (`campanha_google:<id>`, a tabela `google_campaign_new`), na conta do Google Ads do pedido. Nesta parte,
// o conector lê o estado que a pessoa aprova (a peça e os textos, a foto e as medidas dela, o nome e a logo da loja, a
// loja e o raio, a verba, o fim e o destino) e confere o pedido; a criação no Google (uma requisição só, conferida antes
// com `validate_only`) é a parte 3. Até lá, a aplicação recusa sem ir ao Google, e a função `campanha_google` segue
// desligada.

const PROVIDER = 'google_ads';
const FORA_DO_AMBIENTE = 'A criação de campanha no Google ainda não está disponível no Liame: nada foi criado no Google.';
const SUMIU = 'Esta campanha nova não está mais aqui (a peça, a foto, a logo ou a conta saiu da marca).';

type Linha = {
  id: string;
  status: string;
  active: boolean;
  version: number;
  error: string | null;
  google_campaign_id: string | null;
};

const recusado = (mensagem: string): ApplyResult => ({ ok: false, reason: 'recusado', mensagem });

/**
 * A campanha nova do Google (sob a RLS da empresa) e o estado dela, como o pedido guarda. Nulo quando ela não é desta
 * empresa e desta conta, ou quando a foto, a logo ou o ponto da loja não estão mais lá.
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
           c.media_id, m.sha256 as media_file, m.width, m.height,
           b.logo_id, least(b.logo_width, b.logo_height) as logo_lado,
           c.radius_km::text, c.daily_budget_micros::text, c.end_date::text as end_date, c.link,
           u.id as unit_id, u.name as unit_nome, u.latitude::text, u.longitude::text,
           a.external_id as conta_externa, a.name as conta_nome, a.currency, o.timezone
      from liame.google_campaign_new c
      join liame.brand_photo m on m.id = c.media_id and m.tenant_id = c.tenant_id and m.status = 'pronta' and m.removed_at is null
      join liame.brand b on b.id = c.brand_id and b.tenant_id = c.tenant_id
      join liame.unit u on u.id = c.unit_id and u.tenant_id = c.tenant_id
      join liame.connected_account a on a.id = c.ad_account_id and a.tenant_id = c.tenant_id and a.provider = ${PROVIDER}
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
  return { linha: { id: l.id, status: l.status, active: l.active, version: Number(l.version), error: l.error, google_campaign_id: l.google_campaign_id }, estado: lido.data };
}

export class CampanhaGoogleConnector implements Connector {
  readonly provider = PROVIDER;
  readonly writeFlag = 'google_write';
  // Criar não gasta (nasce pausada); o registro do Google continua pedindo os limites para o que gasta (ativar).
  readonly requiresSpendLimits = true;

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
    // A conferência do Google é na criação (parte 3); aqui só confere o pedido.
    if (options.validateOnly) return { ok: true, state: desired, version: linha.version };
    return recusado(FORA_DO_AMBIENTE);
  }
}

export const campanhaGoogleConnector = new CampanhaGoogleConnector();
