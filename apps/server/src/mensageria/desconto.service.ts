import type { MessageDiscount, MessageDiscountRequest, MessageDiscountResponse, MessageDiscountStore } from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { contaConectada } from '../connections/conectada.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem, ValidationProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { conferirDesconto, LIMITES_DO_DESCONTO } from './desconto.js';
import { desligada, FLAG_MENSAGERIA } from './mensageria.service.js';

// O desconto padrão do cupom das mensagens pelas rotas (A5, Y6; decisão do dono em 10/10/2026; protótipo P15, parte D,
// aguardando aprovação: sem tela ainda). Ler é de quem vê as campanhas; definir e mudar, de quem define os limites da
// Verba do mês (`orcamento.gerenciar`). Tudo na transação da requisição, sob a RLS da empresa: nada fala com o Regem
// nem com o RegemCast aqui. Atrás da flag `mensageria`, como a tela Mensagens.

/** A permissão de quem define os limites da Verba do mês: o Dono e o Administrador. */
const PODE_DEFINIR = 'orcamento.gerenciar';

type LinhaDaLoja = { id: string; name: string; pode_criar: boolean };
type LinhaDoDesconto = {
  kind: string;
  percent: number | null;
  value_cents: number | null;
  min_order_cents: number | null;
  valid_days: number;
  coupon_account_id: string;
  loja: string;
  loja_conectada: boolean;
  loja_pode_criar: boolean;
  updated_by: string | null;
  quem: string | null;
  updated_at: Date | string;
};

function tenantDe(auth: AuthContext): string {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return auth.tenantId;
}

const LIMITES = {
  percent_max: LIMITES_DO_DESCONTO.percentMax,
  value_cents_max: LIMITES_DO_DESCONTO.valueCentsMax,
  min_order_cents_max: LIMITES_DO_DESCONTO.minOrderCentsMax,
  valid_days_max: LIMITES_DO_DESCONTO.validDaysMax,
};

@Injectable()
export class DescontoDasMensagensService {
  constructor(private readonly flags: FlagService) {}

  /** O desconto da marca (nulo enquanto ninguém definiu), as lojas do Regem onde o cupom pode nascer e os limites. */
  async ver(auth: AuthContext, brandId: string): Promise<MessageDiscountResponse> {
    const tenantId = tenantDe(auth);
    await this.marca(brandId);
    const vazia = { brand_id: brandId, discount: null, stores: [], limits: LIMITES };
    if (!(await this.ligada(tenantId, auth.userId, brandId))) return { ...vazia, enabled: false, can_edit: false };
    return { ...vazia, enabled: true, discount: await this.desconto(brandId), stores: (await this.lojas(brandId)).map(lojaDaRota), can_edit: auth.permissions.has(PODE_DEFINIR) };
  }

  /**
   * Define ou muda o desconto da marca. Vale para as próximas propostas: o pedido que já espera aprovação e a mensagem
   * enviada seguem com o cupom que tinham (o cupom de cada um está no próprio pedido). A mudança vai para a auditoria,
   * com o antes e o depois.
   */
  async definir(auth: AuthContext, pedido: MessageDiscountRequest): Promise<MessageDiscountResponse> {
    const tx = currentTx();
    const tenantId = tenantDe(auth);
    await this.marca(pedido.brand_id);
    if (!(await this.ligada(tenantId, auth.userId, pedido.brand_id))) throw desligada();
    const erros = conferirDesconto(pedido);
    if (erros.length) throw new ValidationProblem(erros);
    const loja = this.escolherLoja(await this.lojas(pedido.brand_id), pedido.connected_account_id);

    // A linha da marca fica travada até o fim: dois pedidos ao mesmo tempo gravam um depois do outro.
    const antes = await tx.execute<{ kind: string; percent: number | null; value_cents: number | null; min_order_cents: number | null; valid_days: number; coupon_account_id: string }>(sql`
      select kind, percent, value_cents, min_order_cents, valid_days, coupon_account_id
        from liame.message_discount where brand_id = ${pedido.brand_id} for update`);
    const depois = {
      kind: pedido.kind,
      percent: pedido.kind === 'percentual' ? (pedido.percent ?? null) : null,
      value_cents: pedido.kind === 'valor' ? (pedido.value_cents ?? null) : null,
      min_order_cents: pedido.min_order_cents ?? null,
      valid_days: pedido.valid_days,
      coupon_account_id: loja.id,
    };
    await tx.execute(sql`
      insert into liame.message_discount (id, tenant_id, brand_id, coupon_account_id, kind, percent, value_cents, min_order_cents, valid_days, created_by, updated_by)
      values (${uuidv7()}, ${tenantId}, ${pedido.brand_id}, ${depois.coupon_account_id}, ${depois.kind}, ${depois.percent}, ${depois.value_cents}, ${depois.min_order_cents}, ${depois.valid_days}, ${auth.userId}, ${auth.userId})
      on conflict (brand_id) do update
        set coupon_account_id = excluded.coupon_account_id, kind = excluded.kind, percent = excluded.percent, value_cents = excluded.value_cents,
            min_order_cents = excluded.min_order_cents, valid_days = excluded.valid_days, updated_by = excluded.updated_by, updated_at = now()`);
    auditDetail({ resourceId: pedido.brand_id, before: antes.rows[0] ?? null, after: depois });
    return this.ver(auth, pedido.brand_id);
  }

  /**
   * A loja do Regem onde o cupom vai nascer: a pedida, ou a única da marca que cria cupom. Com mais de uma, a pessoa
   * escolhe; sem nenhuma, não há onde o cupom nascer, e o desconto não é gravado.
   */
  private escolherLoja(lojas: LinhaDaLoja[], pedida: string | undefined): LinhaDaLoja {
    const semCupom = (texto: string) => new AppProblem(409, 'loja-sem-cupom', 'A loja não deixa criar cupom', texto);
    if (pedida) {
      const loja = lojas.find((l) => l.id === pedida);
      if (!loja) throw new ValidationProblem([{ path: 'connected_account_id', message: 'Loja do Regem não encontrada nesta marca.' }]);
      if (!loja.pode_criar) throw semCupom('A loja não liberou "criar cupom de campanha" no Regem. Autorize de novo em Contas conectadas e ligue essa chave lá.');
      return loja;
    }
    const criam = lojas.filter((l) => l.pode_criar);
    if (!criam.length) {
      throw semCupom(
        lojas.length
          ? 'Nenhuma loja do Regem desta marca liberou "criar cupom de campanha". Autorize de novo em Contas conectadas e ligue essa chave lá.'
          : 'O cupom de cada mensagem nasce no Regem, e esta marca não tem loja do Regem conectada. Conecte o Regem em Contas conectadas.',
      );
    }
    if (criam.length > 1) throw new ValidationProblem([{ path: 'connected_account_id', message: 'Escolha em qual loja o cupom vale.' }]);
    return criam[0]!;
  }

  private async marca(brandId: string): Promise<void> {
    const r = await currentTx().execute(sql`select 1 from liame.brand where id = ${brandId} and archived_at is null`);
    if (!r.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
  }

  private ligada(tenantId: string, userId: string, brandId: string): Promise<boolean> {
    return this.flags.isEnabled(FLAG_MENSAGERIA, this.flags.context({ tenantId, userId, brandId }));
  }

  /**
   * As lojas do Regem ligadas à marca; a que está conectada e liberou "criar cupom de campanha" na autorização pode
   * receber o cupom (a que o Regem recusou aparece, sem poder: achado A2 do Hub DMS).
   */
  private async lojas(brandId: string): Promise<LinhaDaLoja[]> {
    const r = await currentTx().execute<LinhaDaLoja>(sql`
      select a.id, a.name,
             (coalesce(a.provider_attributes -> 'escopos' @> '["cupons.criar"]'::jsonb, false) and ${contaConectada('a')}) as pode_criar
        from liame.connected_account a
       where a.brand_id = ${brandId} and a.provider = 'regem' and a.disconnected_at is null
       order by a.name, a.id`);
    return r.rows;
  }

  private async desconto(brandId: string): Promise<MessageDiscount | null> {
    const r = await currentTx().execute<LinhaDoDesconto>(sql`
      select d.kind, d.percent, d.value_cents, d.min_order_cents, d.valid_days, d.coupon_account_id, d.updated_by, d.updated_at,
             a.name as loja, ${contaConectada('a')} as loja_conectada,
             coalesce(a.provider_attributes -> 'escopos' @> '["cupons.criar"]'::jsonb, false) as loja_pode_criar,
             u.name as quem
        from liame.message_discount d
        join liame.connected_account a on a.id = d.coupon_account_id
        left join liame.app_user u on u.id = d.updated_by
       where d.brand_id = ${brandId}`);
    const l = r.rows[0];
    if (!l) return null;
    return {
      kind: l.kind,
      percent: l.percent,
      value_cents: l.value_cents,
      min_order_cents: l.min_order_cents,
      valid_days: l.valid_days,
      store: { connected_account_id: l.coupon_account_id, name: l.loja, can_create: l.loja_conectada && l.loja_pode_criar, connected: l.loja_conectada },
      set_by: l.updated_by && l.quem ? { id: l.updated_by, name: l.quem } : null,
      set_at: new Date(l.updated_at).toISOString(),
    };
  }
}

function lojaDaRota(l: LinhaDaLoja): MessageDiscountStore {
  return { connected_account_id: l.id, name: l.name, can_create: l.pode_criar };
}
