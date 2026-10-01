import type { LinkCouponRequest } from '@liame/contracts';
import { type Tx, uuidv7 } from '@liame/database';
import { sql } from 'drizzle-orm';
import { atribuirPedidos, pedidosDoCupomDeCampanha } from '../attribution/motor.js';
import { AppProblem } from '../errors/problems.js';
import { diaNoFuso, periodoDoVinculo } from './plataforma.js';

// O vínculo cupom ↔ campanha (A2.5, F6), com a transação por parâmetro: quem liga é a pessoa, na requisição
// (`CouponsService`), ou o Action Service, no worker, logo depois de criar o cupom no Regem
// (`regem_cupom_criar`). As regras são as mesmas nos dois caminhos.

export const FUSO_PADRAO = 'America/Sao_Paulo';

const naoEncontrado = (detail: string) => new AppProblem(404, 'nao-encontrado', 'Não encontramos', detail);

export type CupomTravado = { id: string; tenant_id: string; brand_id: string; code: string; removed_at: Date | string | null; valid_until: Date | string | null; active: boolean; fuso: string };

export type Ligacao = { id: string; campaign_id: string; exclusive: boolean; linked_at: Date | string; unlinked_at: Date | string | null };

export type VinculoFeito = { ligacaoId: string; inicio: string; fim: string | null; reatribuidos: number; repetido: boolean };

/** O cupom, travado para a transação (duas ligações ao mesmo tempo: uma espera a outra). */
export async function travarCupom(tx: Tx, couponId: string): Promise<CupomTravado> {
  const r = await tx.execute<CupomTravado>(sql`
    select cp.id, cp.tenant_id, cp.brand_id, cp.code, cp.removed_at, cp.valid_until, cp.active,
           coalesce(u.timezone, a.timezone, ${FUSO_PADRAO}) as fuso
      from liame.coupon cp
      join liame.connected_account a on a.id = cp.connected_account_id
      left join liame.unit u on u.id = a.unit_id
     where cp.id = ${couponId}
       for update of cp`);
  if (!r.rows[0]) throw naoEncontrado('Cupom não encontrado nesta empresa.');
  return r.rows[0];
}

export async function ligacaoEmVigor(tx: Tx, couponId: string): Promise<Ligacao | null> {
  const r = await tx.execute<Ligacao>(sql`
    select id, campaign_id, exclusive, linked_at, unlinked_at from liame.campaign_coupon
     where coupon_id = ${couponId} and (unlinked_at is null or unlinked_at > now())
     order by linked_at desc limit 1`);
  return r.rows[0] ?? null;
}

/** Os pedidos com o código do cupom desde o início do vínculo passam de novo pelo motor. */
export async function reatribuirLigacao(tx: Tx, tenantId: string, ligacaoId: string): Promise<number> {
  const pedidos = await pedidosDoCupomDeCampanha(tx, tenantId, [ligacaoId]);
  if (!pedidos.length) return 0;
  const r = await atribuirPedidos(tx, { tenantId, orderIds: pedidos, gatilho: 'cupons' });
  return r.considerados;
}

export type CampanhaDoVinculo = { id: string; name: string; provider: string; status: string; brand_id: string };

/**
 * A campanha a que um cupom da marca pode ser ligado: da mesma marca, da Meta ou do Google Ads, e ainda de pé
 * na plataforma. Quem pede a criação do cupom no Regem confere por aqui antes de criar.
 */
export async function campanhaDoVinculo(tx: Tx, campaignId: string, brandId: string): Promise<CampanhaDoVinculo> {
  const campanha = (
    await tx.execute<CampanhaDoVinculo>(sql`
      select c.id, c.name, c.provider, c.status, a.brand_id
        from liame.campaign c join liame.connected_account a on a.id = c.connected_account_id
       where c.id = ${campaignId}`)
  ).rows[0];
  if (!campanha) throw naoEncontrado('Campanha não encontrada nesta empresa.');
  if (campanha.brand_id !== brandId) throw new AppProblem(422, 'campanha-fora-da-marca', 'Campanha de outra marca', 'Escolha uma campanha da mesma marca da loja do cupom.');
  if (campanha.provider !== 'meta_ads' && campanha.provider !== 'google_ads') {
    throw new AppProblem(422, 'plataforma-sem-cupom', 'Plataforma sem cupom de campanha', 'O cupom de campanha vale para as campanhas da Meta e do Google Ads.');
  }
  if (campanha.status === 'removida' || campanha.status === 'arquivada') {
    throw new AppProblem(422, 'campanha-encerrada', 'Campanha encerrada', 'Esta campanha foi removida ou arquivada na plataforma.');
  }
  return campanha;
}

/** Grava o vínculo (com o cupom já travado) e refaz a atribuição dos pedidos com o código, se ele for exclusivo. */
export async function ligarCupom(tx: Tx, p: { userId: string | null; cupom: CupomTravado; body: LinkCouponRequest; agora: Date }): Promise<VinculoFeito> {
  const { cupom, body, agora } = p;
  const campanha = await campanhaDoVinculo(tx, body.campaign_id, cupom.brand_id);

  const hoje = diaNoFuso(agora, cupom.fuso);
  const periodo = periodoDoVinculo(hoje, body.starts_on, body.ends_on);
  if (!periodo.ok) {
    throw new AppProblem(
      422,
      periodo.motivo === 'inicio_no_passado' ? 'inicio-no-passado' : periodo.motivo === 'fim_antes_do_inicio' ? 'fim-antes-do-inicio' : 'dia-invalido',
      'Período não aceito',
      periodo.motivo === 'inicio_no_passado'
        ? 'O vínculo começa hoje ou depois.'
        : periodo.motivo === 'fim_antes_do_inicio'
          ? 'O fim do vínculo não pode ser antes do início.'
          : 'Informe as datas do vínculo no formato de calendário.',
    );
  }

  const atual = await ligacaoEmVigor(tx, cupom.id);
  if (atual) {
    if (atual.campaign_id === campanha.id && atual.exclusive === body.exclusive && body.starts_on === undefined && body.ends_on == null && atual.unlinked_at === null) {
      return { ligacaoId: atual.id, inicio: periodo.inicio, fim: null, reatribuidos: 0, repetido: true };
    }
    const nome = (await tx.execute<{ name: string }>(sql`select name from liame.campaign where id = ${atual.campaign_id}`)).rows[0]?.name ?? 'outra campanha';
    throw new AppProblem(409, 'cupom-ja-ligado', 'Cupom já ligado', `O cupom já está ligado à campanha ${nome}. Desligue antes de ligar a outra.`);
  }

  const id = uuidv7();
  await tx.execute(sql`
    insert into liame.campaign_coupon (id, tenant_id, brand_id, coupon_id, campaign_id, exclusive, linked_at, unlinked_at, created_by)
    select ${id}, ${cupom.tenant_id}, ${cupom.brand_id}, ${cupom.id}, ${campanha.id}, ${body.exclusive},
           greatest((${periodo.inicio}::date)::timestamp at time zone ${cupom.fuso},
                    coalesce((select max(cc.unlinked_at) from liame.campaign_coupon cc where cc.coupon_id = ${cupom.id}), '-infinity'::timestamptz)),
           case when ${periodo.fim}::date is null then null else ((${periodo.fim}::date + 1)::timestamp at time zone ${cupom.fuso}) end,
           ${p.userId}`);
  const reatribuidos = body.exclusive ? await reatribuirLigacao(tx, cupom.tenant_id, id) : 0;
  return { ligacaoId: id, inicio: periodo.inicio, fim: periodo.fim, reatribuidos, repetido: false };
}
