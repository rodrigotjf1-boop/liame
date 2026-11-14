import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { regraDoCupomDosParametros } from '../actions/tools.js';
import { contaConectada } from '../connections/conectada.js';
import type { FlagService } from '../flags/flag.service.js';
import type { LetraDoTeste } from './teste-contas.js';
import { type DescontoDoTeste, EstadoDoTesteDeCriativo, FLAG_DO_TESTE_DE_CRIATIVO } from './teste-de-criativo-plano.js';

// O portão do cupom de um criativo do teste (plano da região, R8; D-RG-77). O cupom do teste sai sem outro pedido de
// aprovação porque uma pessoa aprovou o teste com o código do app, e o teste que ela aprovou diz o código, o desconto e
// a validade de cada cupom. Por isso, antes de pedir e de novo antes de executar, o Liame confere se essa aprovação vale
// para ESTE cupom:
//   - a função `teste_de_criativo` ligada;
//   - o teste existe, é desta marca, foi aprovado e está em criação, com a campanha de teste inteira na Meta;
//   - o criativo da letra tem exatamente este código, e o cupom dele ainda não foi criado;
//   - a loja é a do teste, no Regem;
//   - a regra (o desconto, o pedido mínimo e a validade) é exatamente a do teste aprovado.
// Devolve nulo quando o cupom pode sair; senão, o porquê.

/** Os parâmetros da ferramenta `cupom_do_teste` para um criativo, tirados do teste aprovado. Função pura. */
export function parametrosDoCupomDoTeste(teste: { id: string; nome: string; desconto: DescontoDoTeste }, letra: LetraDoTeste, codigo: string): Record<string, unknown> {
  const d = teste.desconto;
  return {
    teste: teste.id,
    letra,
    codigo,
    nome: `Teste · ${teste.nome} · ${letra}`.slice(0, 80),
    tipo: d.tipo,
    ...(d.tipo === 'percentual' ? { percentual: d.percentual } : { valor_centavos: d.valor_centavos }),
    pedido_minimo_centavos: d.pedido_minimo_centavos,
    valido_de: d.valido_de,
    valido_ate: d.valido_ate,
  };
}

const igual = (a: unknown, b: unknown): boolean => JSON.stringify(a, Object.keys((a ?? {}) as object).sort()) === JSON.stringify(b, Object.keys((b ?? {}) as object).sort());

export async function oQueSeguraOCupomDoTeste(
  tx: Tx,
  flags: FlagService,
  alvo: { tenantId: string; brandId: string; accountId: string; codigo: string; regra: unknown; teste: string; letra: LetraDoTeste },
): Promise<string | null> {
  if (!(await flags.isEnabled(FLAG_DO_TESTE_DE_CRIATIVO, flags.context({ tenantId: alvo.tenantId, brandId: alvo.brandId })))) return 'funcao_desligada';
  const linha = (
    await tx.execute<{ brand_id: string; unit_id: string; status: string; plan: unknown; meta_campaign_id: string | null; anuncios: number; coupon_code: string; coupon_status: string; da_loja: boolean }>(sql`
      select t.brand_id, t.unit_id, t.status, t.plan, t.meta_campaign_id,
             (select count(*)::int from liame.campaign_test_arm x where x.test_id = t.id and x.meta_ad_id is not null) as anuncios,
             b.coupon_code, b.coupon_status,
             exists (select 1 from liame.connected_account a
                      where a.id::text = ${alvo.accountId} and a.tenant_id = t.tenant_id and a.provider = 'regem' and a.unit_id = t.unit_id and ${contaConectada('a')}) as da_loja
        from liame.campaign_test t
        join liame.campaign_test_arm b on b.test_id = t.id and b.tenant_id = t.tenant_id and b.letter = ${alvo.letra}
       where t.id = ${alvo.teste} and t.tenant_id = ${alvo.tenantId} and t.kind = 'criativo'`)
  ).rows[0];
  if (!linha) return 'teste_desconhecido';
  if (linha.brand_id !== alvo.brandId) return 'teste_de_outra_marca';
  if (linha.status !== 'criando') return 'teste_fora_da_criacao';
  if (!linha.meta_campaign_id || linha.anuncios !== 2) return 'campanha_de_teste_incompleta';
  if (linha.coupon_code !== alvo.codigo) return 'codigo_diferente_do_aprovado';
  if (linha.coupon_status !== 'a_criar' && linha.coupon_status !== 'pedido') return 'cupom_ja_decidido';
  if (!linha.da_loja) return 'loja_diferente_da_do_teste';
  const plano = EstadoDoTesteDeCriativo.omit({ situacao: true, ativa: true }).safeParse(linha.plan);
  if (!plano.success) return 'teste_sem_plano';
  const esperada = regraDoCupomDosParametros(parametrosDoCupomDoTeste({ id: alvo.teste, nome: plano.data.nome, desconto: plano.data.desconto }, alvo.letra, alvo.codigo));
  if (!esperada || !igual(esperada, alvo.regra)) return 'regra_diferente_da_aprovada';
  return null;
}
