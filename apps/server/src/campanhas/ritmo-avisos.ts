import type { Tx } from '@liame/database';
import { sql } from 'drizzle-orm';
import { DIAS_DA_CONFERENCIA } from '../actions/conferencia-do-gasto.js';
import { aoCentavo } from '../actions/verba-do-mes.js';
import { menosDias } from '../results/fora-do-normal.js';
import { DIAS_DA_VOLTA } from './ritmo-passos.js';
import { EstadoDoRitmo } from './ritmo-plano.js';

// Os avisos do ritmo da semana (plano da região, R7, parte 1b-3c; D-RG-63, D-RG-72, D-RG-73 e D-RG-75). As contas são
// puras; a leitura do banco fica no fim (`avisosDoRitmoDasMarcas`), e quem mostra é a Atenção. Nada é gravado: os avisos
// saem, a cada leitura, dos passos guardados, da verba lida hoje e do gasto lido da Meta. Três avisos, por objeto da
// Meta (campanha ou conjunto) que entrou num ritmo:
//   - saiu do ritmo: alguém mexeu por fora (a verba não era a que o Liame deixou, ou o objeto não estava ativo). O Liame
//     não mexe mais nele na semana; o aviso fica até o fim dela;
//   - ainda não voltou: o ritmo acabou ou foi parado, a verba não é a de antes, e nenhum passo saiu ontem nem hoje (a
//     volta não coube nos limites da empresa, ou a função foi desligada). O aviso é da verba que o LIAME deixou: se a
//     leitura de hoje mostra outra verba, alguém já mexeu, a verba é da pessoa e o aviso não sai;
//   - gastou mais do que o ritmo permite: a conferência própria do gasto. A conferência comum (A4, X4) compara uma
//     mudança só e deixa o passo do ritmo de fora (D-RG-72); aqui, 7 dias contra a soma da verba que valia em cada dia.
//     A janela termina no último dia em que o ritmo conduziu o objeto (ontem, na semana do ritmo; depois dela, o dia do
//     último passo feito): os dias seguintes são de quem mexer na verba, e da conferência comum. No dia de uma mudança
//     vale a maior das duas verbas.
// O que o Liame controla é a SOMA DAS VERBAS da semana, não o gasto: a Meta pode gastar até 75% a mais num dia, e o
// limite da semana dela é 7 vezes a verba diária que estiver valendo. Com a verba mudando todo dia (e terminando a
// semana mais alta), a Meta pode passar da soma sem quebrar regra nenhuma dela. Por isso a folga, de partida [S], e a
// medição no piloto.

/** A folga de partida [S] sobre a soma das verbas de cada dia: acima dela, o aviso. */
export const FOLGA_DO_GASTO_DO_RITMO_PCT = 5;

export interface PassoGuardado {
  dia: string;
  tipo: 'ritmo' | 'volta';
  /** `pedido`, `feito`, `fora`, `bloqueado` ou `igual`. */
  situacao: string;
  /** A verba que o Liame esperava encontrar e a que o passo deixa. */
  deMicros: number;
  paraMicros: number;
}

export interface ObjetoNoRitmo {
  recurso: string;
  nome: string;
  /** A verba de antes do ritmo. */
  baseMicros: number;
  /** A verba da véspera da semana (a de antes, ou a que o ritmo anterior deixou). */
  partidaMicros: number;
  /** Os passos deste objeto neste ritmo, do mais antigo ao mais novo. */
  passos: PassoGuardado[];
}

export interface RitmoComPassos {
  id: string;
  acao: string | null;
  situacao: 'aprovado' | 'parado' | 'encerrado';
  semana: { de: string; ate: string };
  objetos: ObjetoNoRitmo[];
}

/** O que a leitura de hoje diz de cada objeto, pelo recurso. */
export interface LeituraDoRitmo {
  /** O gasto por dia. */
  gastoDe: (recurso: string) => ReadonlyMap<string, bigint>;
  /** A verba diária lida hoje (nula: o objeto não tem mais verba diária própria); `null` sem leitura de hoje. */
  verbaLidaDe: (recurso: string) => { micros: number | null } | null;
}

export type AvisoDoRitmo = { ritmo: string; acao: string | null; recurso: string; nome: string } & (
  | { tipo: 'saiu'; dia: string }
  | { tipo: 'nao_voltou'; semana: { de: string; ate: string }; parado: boolean; deixadaMicros: number; baseMicros: number }
  | { tipo: 'gasto_acima'; janela: { de: string; ate: string }; gasto: bigint; permitido: bigint }
);

const feitosDe = (passos: readonly PassoGuardado[]) => passos.filter((p) => p.situacao === 'feito');

/** A verba que valia num dia: a maior entre a do começo e a do fim do dia (no dia da mudança, as duas valeram). */
export function permitidoNoDia(dia: string, feitos: readonly PassoGuardado[]): bigint | null {
  if (!feitos.length) return null;
  const antes = feitos.filter((p) => p.dia < dia).at(-1);
  const ate = feitos.filter((p) => p.dia <= dia).at(-1);
  // Antes do primeiro passo, valia a verba que o Liame encontrou nele.
  const comeco = antes ? antes.paraMicros : feitos[0]!.deMicros;
  const fim = ate ? ate.paraMicros : comeco;
  return BigInt(Math.max(comeco, fim));
}

export interface GastoDoRitmo {
  status: 'confere' | 'acima';
  janela: { de: string; ate: string };
  gasto: bigint;
  /** A soma da verba que valia em cada dia da janela, sem a folga. */
  permitido: bigint;
}

/**
 * A conferência do gasto de um objeto: os 7 dias que terminam em `ate` (o último dia em que o ritmo conduziu o objeto)
 * contra a soma da verba de cada dia. `feitos`: os passos feitos pelo Liame no objeto, em ordem, desde a última vez em
 * que alguém mexeu por fora. Nulo quando nenhum passo feito cai na janela.
 */
export function conferirGastoDoRitmo(feitos: readonly PassoGuardado[], ate: string, gastoPorDia: ReadonlyMap<string, bigint>): GastoDoRitmo | null {
  const dias: string[] = [];
  for (let n = DIAS_DA_CONFERENCIA - 1; n >= 0; n--) dias.push(menosDias(ate, n));
  if (!feitos.some((p) => p.dia >= dias[0]! && p.dia <= ate)) return null;
  const gasto = aoCentavo(dias.reduce((s, d) => s + (gastoPorDia.get(d) ?? 0n), 0n));
  const permitido = dias.reduce((s, d) => s + (permitidoNoDia(d, feitos) ?? 0n), 0n);
  const limite = (permitido * BigInt(100 + FOLGA_DO_GASTO_DO_RITMO_PCT)) / 100n;
  return { status: gasto > limite ? 'acima' : 'confere', janela: { de: dias[0]!, ate }, gasto, permitido };
}

/**
 * Os avisos de uma conta de anúncios de uma marca em `hoje`. `ritmos`: os aprovados, parados e encerrados recentes, do
 * mais antigo ao mais novo (para cada objeto vale o mais novo em que ele entrou).
 */
export function avisosDoRitmo(ritmos: readonly RitmoComPassos[], hoje: string, leitura: LeituraDoRitmo): AvisoDoRitmo[] {
  const avisos: AvisoDoRitmo[] = [];
  const ontem = menosDias(hoje, 1);
  /** Por objeto: o ritmo mais novo em que entrou, a verba deixada e os passos feitos desde a última mexida por fora. */
  const porObjeto = new Map<string, { ritmo: RitmoComPassos; objeto: ObjetoNoRitmo; deixadaMicros: number; feitos: PassoGuardado[] }>();
  for (const ritmo of ritmos) {
    if (ritmo.semana.de > hoje) continue;
    for (const objeto of ritmo.objetos) {
      const anterior = porObjeto.get(objeto.recurso);
      const fora = objeto.passos.findLastIndex((p) => p.situacao === 'fora');
      const meus = feitosDe(objeto.passos.slice(fora + 1));
      const feitos = fora >= 0 ? meus : [...(anterior?.feitos ?? []), ...meus];
      const deixadaMicros = meus.at(-1)?.paraMicros ?? anterior?.deixadaMicros ?? objeto.partidaMicros;
      porObjeto.set(objeto.recurso, { ritmo, objeto, deixadaMicros, feitos });
    }
  }
  for (const { ritmo, objeto, deixadaMicros, feitos } of porObjeto.values()) {
    const base = { ritmo: ritmo.id, acao: ritmo.acao, recurso: objeto.recurso, nome: objeto.nome };
    const fora = objeto.passos.findLast((p) => p.situacao === 'fora');
    if (fora) {
      // Mexido por fora: o Liame não conduz mais, e não há verba dele para conferir. O aviso vale até o fim da semana.
      if (hoje <= ritmo.semana.ate) avisos.push({ ...base, tipo: 'saiu', dia: fora.dia });
      continue;
    }
    const naSemana = ritmo.situacao === 'aprovado' && hoje <= ritmo.semana.ate;
    // A rotina andou: um passo feito (ou que não precisou mudar nada) ontem ou hoje, ou o pedido de hoje ainda na fila.
    const andou = objeto.passos.some((p) => (p.dia >= ontem && (p.situacao === 'feito' || p.situacao === 'igual')) || (p.dia === hoje && p.situacao === 'pedido'));
    const noPrazo = hoje <= menosDias(ritmo.semana.ate, -DIAS_DA_VOLTA);
    // O aviso é da verba que o Liame deixou: a leitura de hoje com outra verba diz que alguém já mexeu (a verba é da pessoa).
    const lida = leitura.verbaLidaDe(objeto.recurso);
    const comoOLiameDeixou = lida === null || lida.micros === deixadaMicros;
    if (!naSemana && noPrazo && deixadaMicros !== objeto.baseMicros && !andou && comoOLiameDeixou) {
      avisos.push({ ...base, tipo: 'nao_voltou', semana: ritmo.semana, parado: ritmo.situacao === 'parado', deixadaMicros, baseMicros: objeto.baseMicros });
    }
    // O gasto: até ontem, na semana do ritmo; depois dela, até o dia do último passo feito (o resto não é do ritmo).
    const ultimoFeito = feitos.at(-1)?.dia;
    const ate = naSemana ? ontem : ultimoFeito !== undefined && ultimoFeito < ontem ? ultimoFeito : ontem;
    if (ate < menosDias(hoje, DIAS_DA_CONFERENCIA)) continue;
    const conferido = conferirGastoDoRitmo(feitos, ate, leitura.gastoDe(objeto.recurso));
    if (conferido?.status === 'acima') avisos.push({ ...base, tipo: 'gasto_acima', janela: conferido.janela, gasto: conferido.gasto, permitido: conferido.permitido });
  }
  return avisos;
}

// ------------------------------------------------------------------ as frases

const ALVO: Record<string, { o: string; ela: string; dela: string }> = {
  campanha: { o: 'A campanha', ela: 'ela', dela: 'dela' },
  conjunto: { o: 'O conjunto', ela: 'ele', dela: 'dele' },
};
const diaMes = (dia: string) => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;

export type TipoDoAvisoDoRitmo = 'ritmo_campanha_saiu' | 'ritmo_sem_volta' | 'ritmo_gasto_acima';

/** O aviso em palavras, no formato da Atenção: o que houve, o motivo e o que fazer. */
export function textoDoAvisoDoRitmo(a: AvisoDoRitmo, reais: (micros: bigint) => string): { kind: TipoDoAvisoDoRitmo; severity: 'atencao' | 'info'; title: string; detail: string; action: string } {
  const alvo = ALVO[a.recurso.split(':')[0] ?? ''] ?? ALVO.campanha!;
  const quem = `${alvo.o} "${a.nome}"`;
  if (a.tipo === 'saiu') {
    return {
      kind: 'ritmo_campanha_saiu',
      severity: 'info',
      title: `${quem} saiu do ritmo da semana`,
      detail: `Em ${diaMes(a.dia)}, a verba ${alvo.dela} na Meta não era a que o Liame tinha deixado, ou ${alvo.ela} não estava ativa: alguém mexeu por fora. O Liame não muda mais a verba ${alvo.dela} nesta semana, e ${alvo.ela} fica como está.`,
      action: `Confira na Meta se a verba ${alvo.dela} está como você quer.`,
    };
  }
  if (a.tipo === 'nao_voltou') {
    return {
      kind: 'ritmo_sem_volta',
      severity: 'atencao',
      title: `${quem} ainda não voltou à verba de antes do ritmo`,
      detail: `O ritmo da semana de ${diaMes(a.semana.de)} a ${diaMes(a.semana.ate)} ${a.parado ? 'foi parado' : 'acabou'}, e ${alvo.ela} está com ${reais(BigInt(a.deixadaMicros))} por dia; antes do ritmo eram ${reais(BigInt(a.baseMicros))}. A volta não saiu ontem nem hoje: não coube nos limites da empresa (a verba do mês, o teto por campanha ou a política), ou a função do ritmo foi desligada.`,
      action: `Veja o ritmo em Aprovações. Para voltar já, peça a mudança da verba ${alvo.dela}.`,
    };
  }
  return {
    kind: 'ritmo_gasto_acima',
    severity: 'atencao',
    title: `${quem} gastou mais do que o ritmo da semana permite`,
    detail: `De ${diaMes(a.janela.de)} a ${diaMes(a.janela.ate)}, ${alvo.ela} gastou ${reais(a.gasto)}. Com a verba de cada dia, esses dias iriam até ${reais(a.permitido)}. A Meta pode passar da verba num dia e compensar em outro; o Liame avisa quando a soma dos 7 dias passa de ${FOLGA_DO_GASTO_DO_RITMO_PCT}%.`,
    action: `Veja na Meta o gasto ${alvo.dela} nesses dias. Se preferir, pare o ritmo em Aprovações.`,
  };
}

// ------------------------------------------------------------------ a leitura

const FUSO_PADRAO = 'America/Sao_Paulo';
const RECURSO = /^(campanha|conjunto):([0-9]{1,25})$/;

export interface AvisoDoRitmoDaMarca {
  marca: string;
  /** A conta de anúncios da Meta do ritmo. */
  conta: string;
  /** A campanha do Liame (a do conjunto, quando o objeto é um conjunto); nula se ela saiu da leitura. */
  campanha: string | null;
  aviso: AvisoDoRitmo;
}

/**
 * Os avisos do ritmo das marcas dadas, em `instante` (o dia é o da loja do ritmo). Lê os ritmos aprovados, parados e
 * encerrados que ainda podem ter o que avisar (a semana corrente e os 35 dias da volta), os passos deles, a verba de
 * cada objeto como a leitura de hoje mostra e, só para os objetos com passo feito nos últimos dias, o gasto por dia.
 * Cada conta de anúncios de cada marca é conferida à parte (o gasto e a campanha são da conta do ritmo). Sem ritmo
 * nenhum, é uma consulta só.
 */
export async function avisosDoRitmoDasMarcas(tx: Tx, marcas: readonly string[], instante: string): Promise<AvisoDoRitmoDaMarca[]> {
  if (!marcas.length) return [];
  const linhas = (
    await tx.execute<{ id: string; brand_id: string; conta: string; action_id: string | null; status: 'aprovado' | 'parado' | 'encerrado'; week_start: string; week_end: string; plan: unknown; hoje: string; fuso: string }>(sql`
      select b.id, b.brand_id, b.ad_account_id as conta, b.action_id, b.status, b.week_start::text as week_start, b.week_end::text as week_end, b.plan,
             x.hoje::text as hoje, coalesce(u.timezone, ${FUSO_PADRAO}) as fuso
        from liame.budget_rhythm b
        join liame.unit u on u.id = b.unit_id and u.tenant_id = b.tenant_id
        cross join lateral (select (${instante}::timestamptz at time zone coalesce(u.timezone, ${FUSO_PADRAO}))::date as hoje) x
       where b.brand_id in ${marcas} and b.status in ('aprovado', 'parado', 'encerrado')
         and b.week_start <= x.hoje and b.week_end >= x.hoje - ${DIAS_DA_VOLTA}::int
       order by b.week_start, b.created_at, b.id`)
  ).rows;
  if (!linhas.length) return [];
  const passos = (
    await tx.execute<{ rhythm_id: string; resource_id: string; dia: string; kind: 'ritmo' | 'volta'; status: string; target_micros: string; expected_micros: string }>(sql`
      select rhythm_id, resource_id, day::text as dia, kind, status, target_micros::text as target_micros, expected_micros::text as expected_micros
        from liame.budget_rhythm_step
       where rhythm_id in ${linhas.map((l) => l.id)}
       order by day, created_at, id`)
  ).rows;

  const resultado: AvisoDoRitmoDaMarca[] = [];
  const grupos = new Map<string, typeof linhas>();
  for (const l of linhas) grupos.set(`${l.brand_id}|${l.conta}`, [...(grupos.get(`${l.brand_id}|${l.conta}`) ?? []), l]);
  for (const doGrupo of grupos.values()) {
    const { brand_id: marca, conta, hoje, fuso } = doGrupo.at(-1)!;
    const ritmos: RitmoComPassos[] = [];
    for (const l of doGrupo) {
      const plano = EstadoDoRitmo.omit({ situacao: true }).safeParse(l.plan);
      if (!plano.success) continue;
      ritmos.push({
        id: l.id,
        acao: l.action_id,
        situacao: l.status,
        semana: { de: l.week_start, ate: l.week_end },
        objetos: plano.data.campanhas.map((c) => ({
          recurso: c.recurso,
          nome: c.nome,
          baseMicros: c.base_micros,
          partidaMicros: c.partida_micros ?? c.base_micros,
          passos: passos
            .filter((p) => p.rhythm_id === l.id && p.resource_id === c.recurso)
            .map((p) => ({ dia: p.dia, tipo: p.kind, situacao: p.status, deMicros: Number(p.expected_micros), paraMicros: Number(p.target_micros) })),
        })),
      });
    }
    if (!ritmos.length) continue;
    const recursos = [...new Set(ritmos.flatMap((r) => r.objetos.map((o) => o.recurso)))];
    const externos = (lista: readonly string[], tipo: string) => lista.flatMap((r) => (RECURSO.exec(r)?.[1] === tipo ? [RECURSO.exec(r)![2]!] : []));

    // Cada objeto como a leitura de hoje mostra: a campanha do Liame e a verba diária (só vale a de hoje).
    const campanhaDe = new Map<string, string>();
    const lidas = new Map<string, { micros: number | null }>();
    const guardar = (recurso: string, l: { campanha: string; verba: string | null; visto: string }) => {
      campanhaDe.set(recurso, l.campanha);
      if (l.visto >= hoje) lidas.set(recurso, { micros: l.verba !== null && Number(l.verba) > 0 ? Number(l.verba) : null });
    };
    const [campanhas, conjuntos] = [externos(recursos, 'campanha'), externos(recursos, 'conjunto')];
    if (campanhas.length) {
      const r = await tx.execute<{ external_id: string; campanha: string; verba: string | null; visto: string }>(sql`
        select external_id, id as campanha, daily_budget_micros::text as verba, (last_seen_at at time zone ${fuso})::date::text as visto
          from liame.campaign where connected_account_id = ${conta} and external_id in ${campanhas}`);
      for (const c of r.rows) guardar(`campanha:${c.external_id}`, c);
    }
    if (conjuntos.length) {
      const r = await tx.execute<{ external_id: string; campanha: string; verba: string | null; visto: string }>(sql`
        select external_id, campaign_id as campanha, daily_budget_micros::text as verba, (last_seen_at at time zone ${fuso})::date::text as visto
          from liame.ad_group where connected_account_id = ${conta} and external_id in ${conjuntos}`);
      for (const g of r.rows) guardar(`conjunto:${g.external_id}`, g);
    }

    // O gasto por dia, só dos objetos com passo feito perto: a janela são 7 dias e pode terminar até 7 dias atrás.
    const desde = menosDias(hoje, DIAS_DA_CONFERENCIA * 2);
    const comPasso = [...new Set(ritmos.flatMap((r) => r.objetos.filter((o) => o.passos.some((p) => p.situacao === 'feito' && p.dia >= desde)).map((o) => o.recurso)))];
    const series = new Map<string, Map<string, bigint>>();
    const [comGasto, comGastoNoConjunto] = [externos(comPasso, 'campanha'), externos(comPasso, 'conjunto')];
    const dosObjetos = [...(comGasto.length ? [sql`c.external_id in ${comGasto}`] : []), ...(comGastoNoConjunto.length ? [sql`g.external_id in ${comGastoNoConjunto}`] : [])];
    if (dosObjetos.length) {
      const gastos = await tx.execute<{ campanha: string; conjunto: string; dia: string; micros: string }>(sql`
        select c.external_id as campanha, g.external_id as conjunto, l.metric_date::text as dia, round(sum(l.metric_value) * 1000000)::bigint::text as micros
          from liame.metric_latest l
          join liame.ad ad on ad.id = l.entity_id
          join liame.ad_group g on g.id = ad.ad_group_id
          join liame.campaign c on c.id = g.campaign_id
         where l.connected_account_id = ${conta} and l.level = 'ad' and l.metric_name = 'spend' and l.attribution_window = ''
           and l.metric_date >= ${desde}::date and l.metric_date < ${hoje}::date
           and (${sql.join(dosObjetos, sql` or `)})
         group by 1, 2, 3`);
      const somar = (chave: string, dia: string, micros: bigint) => {
        const serie = series.get(chave) ?? new Map<string, bigint>();
        serie.set(dia, (serie.get(dia) ?? 0n) + micros);
        series.set(chave, serie);
      };
      for (const g of gastos.rows) {
        somar(`campanha:${g.campanha}`, g.dia, BigInt(g.micros));
        somar(`conjunto:${g.conjunto}`, g.dia, BigInt(g.micros));
      }
    }

    const avisos = avisosDoRitmo(ritmos, hoje, { gastoDe: (recurso) => series.get(recurso) ?? new Map(), verbaLidaDe: (recurso) => lidas.get(recurso) ?? null });
    for (const aviso of avisos) resultado.push({ marca, conta, campanha: campanhaDe.get(aviso.recurso) ?? null, aviso });
  }
  return resultado;
}
