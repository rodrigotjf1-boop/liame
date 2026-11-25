import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { DIAS_DO_TESTE_DE_REGIAO, OUTROS_BAIRROS_MINIMOS } from './teste-regiao-contas.js';
import { ResultadoDoTesteDeRegiao } from './teste-regiao-plano.js';

// O aviso do resultado do teste de região (plano da região, R8; D-RG-102 e D-RG-94). Quando a medida grava o resultado
// no teste terminado, a Atenção avisa, um aviso por teste: o que o teste mostrou (o que o bairro fez sem anúncio, o que
// faria seguindo os outros bairros e a faixa do que o anúncio traz) ou o motivo de não haver conta, com o caminho para o
// teste em Aprovações. É só informação: o teste de região não deixa dinheiro gastando à espera de uma decisão, então o
// prazo vale (a regra da D-RG-94: o prazo só não cala o aviso de um dinheiro que ainda está sendo gasto). O aviso fica
// 14 dias depois da medida. Nada é gravado: o aviso sai, a cada leitura, do resultado guardado. A conta é pura; a leitura
// do banco fica no fim (`avisosDoTesteDeRegiaoDasMarcas`), e quem mostra é a Atenção.

/** Por quantos dias, depois da medida, o resultado do teste de região aparece na Atenção. */
export const DIAS_DO_AVISO_DO_TESTE_DE_REGIAO = 14;

/** O teste de região terminado, com o resultado como a medida o guardou. */
export interface TesteDeRegiaoLido {
  id: string;
  /** O pedido do teste em Aprovações. */
  acao: string | null;
  nome: string;
  resultado: unknown;
}

export type AvisoDoTesteDeRegiao = { teste: string; acao: string | null; nome: string; resultado: ResultadoDoTesteDeRegiao };

/** O aviso do resultado; nulo quando o resultado guardado não tem a forma da medida (não há o que dizer com certeza). */
export function avisoDoTesteDeRegiao(t: TesteDeRegiaoLido): AvisoDoTesteDeRegiao | null {
  const guardado = ResultadoDoTesteDeRegiao.safeParse(t.resultado);
  if (!guardado.success) return null;
  return { teste: t.id, acao: t.acao, nome: t.nome, resultado: guardado.data };
}

// ------------------------------------------------------------------ as frases

export type TipoDoAvisoDoTesteDeRegiao = 'teste_regiao_com_resultado';

/** Até uma casa decimal, só quando o número não é inteiro ("84", "12,5"), como a tela do teste escreve. */
const umaCasa = (n: number): string => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });

const sobraram = (n: number): string => (n === 0 ? 'não sobrou nenhum bairro' : n === 1 ? 'sobrou 1 bairro' : `sobraram ${n} bairros`);

/** Por que não houve conta, na frase da tela do teste em Aprovações. */
function fraseDoMotivo(r: ResultadoDoTesteDeRegiao): string {
  switch (r.motivo) {
    case 'incompleto':
      return `O teste parou antes dos ${DIAS_DO_TESTE_DE_REGIAO} dias: com menos, o Liame não tira conclusão.`;
    case 'poucos_bairros':
      return `Nos dias do teste, ${sobraram(r.bairros.length)} para comparar; a conta pede pelo menos ${OUTROS_BAIRROS_MINIMOS}.`;
    case 'abaixo_do_minimo':
      return `O bairro teve menos pedidos do que o mínimo que o Regem mostra por bairro${r.minimoDoRegem ? ` (${r.minimoDoRegem} nos ${DIAS_DO_TESTE_DE_REGIAO} dias)` : ''}${r.esperadoPorSemana !== null ? `; seguindo os outros bairros, faria ${umaCasa(r.esperadoPorSemana)} pedidos por semana` : ''}.`;
    case 'sem_conta':
      return 'Faltou pedido de um dos lados, antes ou durante o teste: não há conta.';
    case 'sem_leitura':
      return `O Liame não conseguiu ler os pedidos do Regem dos ${DIAS_DO_TESTE_DE_REGIAO} dias: sem eles, não há conta.`;
    default:
      return 'Não deu para fazer a conta deste teste.';
  }
}

/** O aviso em palavras, no formato da Atenção: o que houve, o motivo e o que fazer. */
export function textoDoAvisoDoTesteDeRegiao(a: AvisoDoTesteDeRegiao): {
  kind: TipoDoAvisoDoTesteDeRegiao;
  severity: 'info';
  title: string;
  detail: string;
  action: string;
} {
  const base = { kind: 'teste_regiao_com_resultado' as const, severity: 'info' as const };
  const e = a.resultado.efeito;
  if (e?.provou) {
    return {
      ...base,
      title: `O teste "${a.nome}" mostrou que o anúncio traz pedido no bairro`,
      detail: `Sem anúncio, o bairro fez ${umaCasa(e.feitoPorSemana)} pedidos por semana; seguindo os outros bairros, faria ${umaCasa(e.esperadoPorSemana)}. O anúncio traz de ${umaCasa(e.faixa.de)} a ${umaCasa(e.faixa.ate)} pedidos por semana ali.`,
      action: 'Veja o teste em Aprovações: a faixa do que o anúncio traz e os pedidos de cada bairro, antes e no teste.',
    };
  }
  if (e) {
    return {
      ...base,
      title: `O teste "${a.nome}" não provou que o anúncio traz pedido no bairro`,
      detail: `Não deu para provar que o anúncio traz pedido no bairro: a faixa vai de 0 a ${umaCasa(e.faixa.ate)} por semana.`,
      action: 'Veja o teste em Aprovações: a faixa do que o anúncio traz e os pedidos de cada bairro, antes e no teste.',
    };
  }
  return {
    ...base,
    title: `O teste "${a.nome}" terminou sem conta`,
    detail: fraseDoMotivo(a.resultado),
    action: 'Veja o teste em Aprovações. Para medir de novo, peça outro teste em Minha marca › Região › Sua região.',
  };
}

// ------------------------------------------------------------------ a leitura

export interface AvisoDoTesteDeRegiaoDaMarca {
  marca: string;
  /** A conta de anúncios da Meta do teste. */
  conta: string;
  aviso: AvisoDoTesteDeRegiao;
}

/** O `medido_em` guardado, só quando tem a forma de data e hora (o que não tem não derruba a leitura da Atenção). */
const MEDIDO_EM = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.source;

/**
 * Os avisos do resultado dos testes de região das marcas dadas, em `instante`: os testes terminados com o resultado
 * medido há até 14 dias, na ordem da medida. Uma consulta só, pelo índice da marca. O prazo conta do `medido_em` do
 * resultado, a hora em que a medida gravou (uma vez só: o resultado guardado não muda).
 */
export async function avisosDoTesteDeRegiaoDasMarcas(tx: Tx, marcas: readonly string[], instante: string): Promise<AvisoDoTesteDeRegiaoDaMarca[]> {
  if (!marcas.length) return [];
  const linhas = (
    await tx.execute<{ id: string; brand_id: string; conta: string; action_id: string | null; name: string; result: unknown }>(sql`
      select t.id, t.brand_id, t.ad_account_id as conta, t.action_id, t.name, t.result
        from liame.campaign_test t
        cross join lateral (select case when t.result->>'medido_em' ~ ${MEDIDO_EM} then (t.result->>'medido_em')::timestamptz end as medido_em) m
       where t.brand_id in ${marcas} and t.kind = 'regiao' and t.status = 'terminado' and t.result is not null
         and m.medido_em >= ${instante}::timestamptz - make_interval(days => ${DIAS_DO_AVISO_DO_TESTE_DE_REGIAO}::int)
       order by m.medido_em, t.id`)
  ).rows;
  const resultado: AvisoDoTesteDeRegiaoDaMarca[] = [];
  for (const l of linhas) {
    const aviso = avisoDoTesteDeRegiao({ id: l.id, acao: l.action_id, nome: l.name, resultado: l.result });
    if (aviso) resultado.push({ marca: l.brand_id, conta: l.conta, aviso });
  }
  return resultado;
}
