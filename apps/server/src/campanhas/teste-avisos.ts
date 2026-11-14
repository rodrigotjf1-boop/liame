import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import type { LetraDoTeste } from './teste-contas.js';
import { ResultadoDoTesteDeCriativo } from './teste-de-criativo-plano.js';

// Os avisos do teste de criativo (plano da região, R8; D-RG-80, D-RG-93 e D-RG-94). No fim do teste o Liame avisa e não
// mexe sozinho: a campanha de teste continua como está, e quem decide o que fazer é a pessoa. A conta é pura; a leitura
// do banco fica no fim (`avisosDoTesteDasMarcas`), e quem mostra é a Atenção. Nada é gravado: os avisos saem, a cada
// leitura, do teste guardado e do que a leitura da Meta mostra da campanha de teste. Três avisos, um por teste:
//   - um criativo venceu: a campanha de teste continua no ar com os dois, e o que perdeu segue gastando até alguém
//     pedir para pausá-lo. O aviso não tem prazo: sai quando o teste é encerrado, ou quando o conjunto do que perdeu
//     aparece pausado;
//   - o teste foi interrompido: mexeram nele por fora, ou os cupons não saíram, e o Liame parou de medir. Com a campanha
//     de teste no ar, o aviso não tem prazo: fica até alguém encerrar o teste. Sem ela no ar (o teste que nem começou,
//     ou a campanha pausada por fora), vale o prazo;
//   - o teste acabou sem vencedor: os dois criativos ficam como estão (D-RG-80). É só informação, e também não tem
//     prazo: a campanha de teste segue gastando com os dois, e o aviso sai quando o teste é encerrado.
// A regra do prazo: ele nunca cala o aviso de um dinheiro que ainda está sendo gasto sem ninguém ter decidido. Vale só
// para o que não gasta mais: o teste interrompido sem a campanha de teste no ar.

/** Por quantos dias o aviso do que não gasta mais (o teste interrompido sem a campanha de teste no ar) ainda aparece. */
export const DIAS_DO_AVISO_DO_TESTE = 14;

/** O teste como o Liame o guardou e como a leitura da Meta mostra a campanha dele. */
export interface TesteLido {
  id: string;
  /** O pedido do teste em Aprovações. */
  acao: string | null;
  nome: string;
  situacao: 'terminado' | 'interrompido';
  /** O Liame ativou a campanha de teste e ninguém a pausou por ele. */
  ativa: boolean;
  /** O teste chegou a rodar (tem o primeiro dia). */
  comecou: boolean;
  /** Dentro do prazo do aviso, pela hora em que o Liame parou de medir. Só decide no interrompido sem a campanha de teste no ar. */
  noPrazo: boolean;
  /** A situação da campanha de teste e a do conjunto do criativo que perdeu, pela leitura da Meta; nulas sem leitura. */
  campanhaLida: string | null;
  perdedorLido: string | null;
  resultado: unknown;
  motivo: string | null;
}

export type AvisoDoTeste = { teste: string; acao: string | null; nome: string } & (
  | { tipo: 'venceu'; vencedor: LetraDoTeste; pedidos: Record<LetraDoTeste, number>; dias: number }
  | { tipo: 'sem_vencedor'; pedidos: Record<LetraDoTeste, number>; dias: number }
  | { tipo: 'interrompido'; motivo: string | null; noAr: boolean }
);

/** Pela leitura, está no ar? Sem leitura (ou com a situação que a Meta não disse), vale o que o Liame deixou. */
const lidaNoAr = (situacao: string | null) => situacao === null || situacao === 'ativa' || situacao === 'desconhecida';

/** O aviso de um teste terminado ou interrompido; nulo quando não há mais o que avisar. */
export function avisoDoTeste(t: TesteLido): AvisoDoTeste | null {
  const base = { teste: t.id, acao: t.acao, nome: t.nome };
  const noAr = t.ativa && lidaNoAr(t.campanhaLida);
  if (t.situacao === 'interrompido') {
    // O teste que rodou e já foi encerrado (a campanha de teste pausada pelo Liame): a pessoa já viu e já agiu.
    if (t.comecou && !t.ativa) return null;
    // No ar, a campanha de teste segue gastando: o aviso fica até alguém encerrar o teste. Sem ela no ar, vale o prazo.
    if (!noAr && !t.noPrazo) return null;
    return { ...base, tipo: 'interrompido', motivo: t.motivo, noAr };
  }
  // Terminado: o aviso é de quem ainda tem a campanha de teste no ar.
  if (!noAr) return null;
  const guardado = ResultadoDoTesteDeCriativo.safeParse(t.resultado);
  const ultima = guardado.success ? guardado.data.olhadas.at(-1) : undefined;
  if (!guardado.success || !ultima) return null;
  const { veredito, vencedor, criativos } = guardado.data;
  const pedidos = { A: criativos.A.pedidos, B: criativos.B.pedidos };
  if (veredito === 'venceu' && vencedor) {
    // O conjunto do criativo que perdeu já pausado (pelo pedido da tela ou na Meta): não há mais o que decidir. Enquanto
    // ele segue no ar, o aviso fica, sem prazo.
    if (!lidaNoAr(t.perdedorLido)) return null;
    return { ...base, tipo: 'venceu', vencedor, pedidos, dias: ultima.dia };
  }
  // Sem vencedor, os dois conjuntos seguem gastando: a informação fica até alguém encerrar o teste.
  if (veredito === 'sem_vencedor') return { ...base, tipo: 'sem_vencedor', pedidos, dias: ultima.dia };
  return null;
}

// ------------------------------------------------------------------ as frases

export type TipoDoAvisoDoTeste = 'teste_interrompido' | 'teste_com_vencedor' | 'teste_sem_vencedor';

const quantos = (n: number) => `${n} ${n === 1 ? 'pedido' : 'pedidos'}`;

/** O aviso em palavras, no formato da Atenção: o que houve, o motivo e o que fazer. */
export function textoDoAvisoDoTeste(a: AvisoDoTeste): { kind: TipoDoAvisoDoTeste; severity: 'atencao' | 'info'; title: string; detail: string; action: string } {
  if (a.tipo === 'interrompido') {
    const motivo = a.motivo?.trim() || 'O Liame parou de medir este teste.';
    return {
      kind: 'teste_interrompido',
      severity: 'atencao',
      title: `O teste "${a.nome}" foi interrompido`,
      detail: a.noAr ? `${motivo} A campanha de teste continua no ar na Meta, e o Liame não mexe nela sozinho.` : motivo,
      action: a.noAr
        ? 'Veja o teste em Aprovações. Encerrar o teste pausa a campanha de teste.'
        : 'Veja o teste em Aprovações. Para comparar os criativos de novo, peça outro teste em Criativos.',
    };
  }
  if (a.tipo === 'venceu') {
    const perdeu: LetraDoTeste = a.vencedor === 'A' ? 'B' : 'A';
    return {
      kind: 'teste_com_vencedor',
      severity: 'atencao',
      title: `O criativo ${a.vencedor} venceu o teste "${a.nome}"`,
      detail: `Em ${a.dias} dias, o criativo ${a.vencedor} trouxe ${quantos(a.pedidos[a.vencedor])} no caixa e o criativo ${perdeu}, ${quantos(a.pedidos[perdeu])}, com a mesma verba. A campanha de teste continua no ar com os dois: o Liame avisa e não pausa sozinho.`,
      action: `Veja o teste em Aprovações: de lá você pede para pausar o criativo ${perdeu}, ou encerra o teste.`,
    };
  }
  return {
    kind: 'teste_sem_vencedor',
    severity: 'info',
    title: `O teste "${a.nome}" acabou sem vencedor`,
    detail: `Em ${a.dias} dias, o criativo A trouxe ${quantos(a.pedidos.A)} no caixa e o criativo B, ${quantos(a.pedidos.B)}: pelo caixa, os dois vendem parecido. A campanha de teste continua no ar, e os dois criativos ficam como estão.`,
    action: 'Veja o teste em Aprovações. Você pode ficar com os dois, ou encerrar o teste e testar outra coisa (a oferta, o texto).',
  };
}

// ------------------------------------------------------------------ a leitura

export interface AvisoDoTesteDaMarca {
  marca: string;
  /** A conta de anúncios da Meta do teste. */
  conta: string;
  /** A campanha de teste na lista do Liame; nula enquanto a leitura da Meta não a trouxe. */
  campanha: string | null;
  aviso: AvisoDoTeste;
}

/**
 * Os avisos dos testes de criativo das marcas dadas, em `instante`. Lê os testes terminados e interrompidos que ainda
 * têm a campanha de teste ativada pelo Liame (sem prazo: ela segue gastando) e os interrompidos que nem começaram,
 * dentro do prazo, com a campanha de teste e o conjunto do criativo que perdeu como a leitura da Meta os mostra. Uma
 * consulta só, pelo índice da marca.
 *
 * O prazo conta de `updated_at`: é a hora em que o Liame parou de medir, porque depois de interrompido só "Encerrar o
 * teste" grava na linha, e o teste encerrado já não avisa.
 */
export async function avisosDoTesteDasMarcas(tx: Tx, marcas: readonly string[], instante: string): Promise<AvisoDoTesteDaMarca[]> {
  if (!marcas.length) return [];
  const linhas = (
    await tx.execute<{
      id: string;
      brand_id: string;
      conta: string;
      action_id: string | null;
      name: string;
      status: 'terminado' | 'interrompido';
      active: boolean;
      comecou: boolean;
      no_prazo: boolean;
      result: unknown;
      reason: string | null;
      campanha: string | null;
      campanha_lida: string | null;
      perdedor_lido: string | null;
    }>(sql`
      select t.id, t.brand_id, t.ad_account_id as conta, t.action_id, t.name, t.status, t.active, (t.started_on is not null) as comecou, x.no_prazo, t.result, t.reason,
             c.id as campanha, c.status as campanha_lida, p.status as perdedor_lido
        from liame.campaign_test t
        cross join lateral (select t.updated_at >= ${instante}::timestamptz - make_interval(days => ${DIAS_DO_AVISO_DO_TESTE}::int) as no_prazo) x
        left join liame.campaign c on c.tenant_id = t.tenant_id and c.connected_account_id = t.ad_account_id and c.external_id = t.meta_campaign_id
        left join lateral (
          select g.status
            from liame.campaign_test_arm b
            join liame.ad_group g on g.tenant_id = b.tenant_id and g.connected_account_id = t.ad_account_id and g.external_id = b.meta_adset_id
           where b.test_id = t.id and b.tenant_id = t.tenant_id and b.letter <> (t.result->>'vencedor')
           limit 1
        ) p on true
       where t.brand_id in ${marcas} and t.kind = 'criativo' and t.status in ('terminado', 'interrompido')
         and (t.active or (t.status = 'interrompido' and t.started_on is null and x.no_prazo))
       order by t.created_at, t.id`)
  ).rows;
  const resultado: AvisoDoTesteDaMarca[] = [];
  for (const l of linhas) {
    const aviso = avisoDoTeste({
      id: l.id,
      acao: l.action_id,
      nome: l.name,
      situacao: l.status,
      ativa: l.active,
      comecou: l.comecou,
      noPrazo: l.no_prazo,
      campanhaLida: l.campanha_lida,
      perdedorLido: l.perdedor_lido,
      resultado: l.result,
      motivo: l.reason,
    });
    if (aviso) resultado.push({ marca: l.brand_id, conta: l.conta, campanha: l.campanha, aviso });
  }
  return resultado;
}
