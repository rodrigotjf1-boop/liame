import type { ClosedLoopResponse, DailyResultsResponse } from '@liame/contracts';
import type { NomeIcone } from '@/components/ui/icone';
import { inteiro, reaisDeMicros } from '@/lib/formato';
import {
  type Aviso,
  type Base,
  centesimosDe,
  dataNoFuso,
  decimosDe,
  diaMes,
  ehDeMensagem,
  type Fonte,
  type Frase,
  horaNoFuso,
  nomesDe,
  parte,
  porcentagem,
  quandoNoFuso,
  reaisPorReal,
  situacaoDaCampanha,
  sobraDe,
  somarDias,
  type Trecho,
  vereditoDe,
} from './textos';

// Os desenhos do modo simples de "Resultados" (mockups/prototipo-resultados-graficos.html, aprovado pelo dono em
// 07/10/2026; caminho B, "uma pergunta, um desenho"). Cada cartão responde com um desenho e uma frase curta; o resto
// continua atrás de "Ver detalhes", e o Pro não muda. A conta é do servidor: aqui só se escolhe o que desenhar e em
// que tamanho, com inteiros (micros e centésimos), sem ponto flutuante nas somas. Funções puras.

const reais = (micros: string | bigint) => reaisDeMicros(micros);
const reaisInteiros = (micros: string | bigint) => reaisDeMicros(micros, 0);
const plural = (n: number | bigint, um: string, varios: string) => `${inteiro(n)} ${BigInt(n) === 1n ? um : varios}`;
const n = (t: string): Trecho => ({ t, b: true });
const juntar = (itens: string[]) => (itens.length <= 1 ? (itens[0] ?? '') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`);
/** A parte no todo, em porcentagem com duas casas: serve para largura e posição, não para texto. */
const fracao = (pedaco: bigint, todo: bigint): number => (todo <= 0n ? 0 : Number((pedaco * 10_000n) / todo) / 100);
/** Micros em centavos, como número: só para o tamanho relativo das barras. */
const centavos = (micros: bigint): number => Number(micros / 10_000n);
/** A dica do desenho: o valor em destaque e o que ele é ("título|complemento"). O valor também fica escrito ao lado. */
const dica = (titulo: string, sub = ''): string => (sub ? `${titulo}|${sub}` : titulo);

// ------------------------------------------------------------------ a faixa do topo

export type FaixaDoTopo = {
  tom: 'ok' | 'atencao' | 'acao';
  icone: NomeIcone;
  titulo: string;
  texto: string;
  acao: { rotulo: string; principal: boolean } | null;
  /** O que "Ver detalhes" explica, embaixo da lista das fontes. */
  nota: string;
  /** A linha discreta de "em dia" e o aviso curto do fuso são só do modo simples (no Pro, o fuso tem a faixa completa). */
  soNoSimples: boolean;
};

/** Até quando os números valem: "09:42" (hoje), "ontem, 23:10" ou "26/09" (antes). */
function ateQuando(iso: string, b: Pick<Base, 'fuso' | 'agora'>): string {
  const q = quandoNoFuso(iso, b.fuso, b.agora);
  if (q.startsWith('hoje, ')) return q.slice(6);
  return q.startsWith('ontem, ') ? q : q.split(', ')[0]!;
}

const NOTA_DAS_FONTES = 'A Meta e o Google são lidos uma vez por dia, de manhã. O Regem manda os pedidos ao longo do dia.';

/**
 * Uma faixa só no topo, para o que impede ou data os números: falta conectar, fonte com problema ou sem leitura
 * nova, conta de anúncio em outro fuso. Com tudo em dia, uma linha discreta. Os outros avisos da tela viram o
 * estado ou uma nota do cartão a que pertencem.
 */
export function faixaDe(r: Pick<ClosedLoopResponse, 'sources'>, b: Base, fontes: Fonte[], avisos: Aviso[]): FaixaDoTopo {
  if (b.semRegem) {
    return { tom: 'acao', icone: 'plug', titulo: 'Falta o caixa da loja.', texto: 'Conecte o Regem para ver o que virou pedido.', acao: { rotulo: 'Abrir Contas conectadas', principal: true }, nota: NOTA_DAS_FONTES, soNoSimples: false };
  }
  if (b.semMidia) {
    return { tom: 'acao', icone: 'plug', titulo: 'Falta a conta de anúncios.', texto: 'Conecte a Meta ou o Google para ver quanto os anúncios custaram.', acao: { rotulo: 'Abrir Contas conectadas', principal: true }, nota: NOTA_DAS_FONTES, soNoSimples: false };
  }
  const nomeDa = (f: Fonte) => (f.conta ? `${f.nome} (${f.conta})` : f.nome);
  const comProblema = fontes.filter((f) => f.situacao === 'problema');
  const atrasadas = fontes.filter((f) => f.situacao === 'atraso');
  if (comProblema.length || atrasadas.length) {
    const paradas = [...comProblema, ...atrasadas];
    // A leitura mais antiga entre as paradas é até onde os números valem.
    const leituras = r.sources
      .filter((s) => paradas.some((f) => f.id === s.connected_account_id) && s.last_success_at)
      .map((s) => s.last_success_at!)
      .sort();
    let titulo = 'Fontes sem leitura nova.';
    if (paradas.length === 1 && paradas[0]!.selo) titulo = `${paradas[0]!.selo}.`;
    else if (leituras.length) titulo = `Números até ${ateQuando(leituras[0]!, b)}.`;
    const partes: string[] = [];
    if (comProblema.length) partes.push(`${juntar(comProblema.map(nomeDa))}: a conexão precisa de atenção.`);
    if (atrasadas.length) partes.push(`${juntar(atrasadas.map(nomeDa))} sem leitura nova.`);
    return {
      tom: 'atencao',
      icone: 'clock',
      titulo,
      texto: partes.join(' '),
      acao: { rotulo: 'Ver a conexão', principal: false },
      nota: 'O Liame tenta ler de novo sozinho. Se continuar parado, confira a conexão.',
      soNoSimples: false,
    };
  }
  const fuso = avisos.find((a) => a.id.startsWith('fuso-'));
  if (fuso) {
    return { tom: 'atencao', icone: 'clock', titulo: `${fuso.titulo.split(' usa outro fuso')[0]} fecha o dia em outro fuso.`, texto: 'Em “Hoje”, o gasto e os pedidos não caem no mesmo dia.', acao: null, nota: fuso.texto, soNoSimples: true };
  }
  const semLeitura = fontes.filter((f) => f.situacao === 'sem_leitura');
  if (semLeitura.length) {
    return { tom: 'ok', icone: 'clock', titulo: 'Primeira leitura a caminho.', texto: `${juntar(semLeitura.map(nomeDa))} ainda sem leitura.`, acao: null, nota: NOTA_DAS_FONTES, soNoSimples: true };
  }
  const regem = fontes.find((f) => f.provider === 'regem' && f.ultima);
  return { tom: 'ok', icone: 'check-circle', titulo: 'Números em dia.', texto: regem ? `Caixa lido ${regem.ultima}.` : '', acao: null, nota: NOTA_DAS_FONTES, soNoSimples: true };
}

// ------------------------------------------------------------------ o número principal

export type SeloDoPeriodo = { rotulo: string; classe: 'bom' | 'atencao' | 'ruim' | 'incompleta' | 'neutro' };

export type LinhaDoPar = {
  rotulo: string;
  valor: string;
  /** Largura da barra na régua comum (0 a 100); nula quando o valor ainda não existe. */
  barra: { largura: number; tom: 'foco' | 'gasto'; dica: string } | null;
  /** O que dizer no lugar da barra ("sai amanhã, com o gasto do dia"). */
  vazio: string | null;
};

export type DiaDoGrafico = { x: number; y: number; altura: number; dica: string };

export type GraficoDosDias = {
  dias: DiaDoGrafico[];
  /** Colunas mais finas quando são muitos dias. */
  fino: boolean;
  linha: string;
  area: string;
  marcas: { x: number; texto: string }[];
  ultimo: { valor: string; quando: string; y: number };
  rotulo: string;
};

export type RetornoLite = {
  titulo: string;
  valor: string;
  vazio: boolean;
  selo: SeloDoPeriodo | null;
  sub: Frase | null;
  variacao: { sentido: 'sobe' | 'cai' | 'igual'; frase: Frase } | null;
  par: { rotulo: string; linhas: [LinhaDoPar, LinhaDoPar]; empate: { posicao: number; valor: string; dica: string } | null } | null;
  dias: GraficoDosDias | null;
};

const SELO_DO_PERIODO: Record<string, string> = { bom: 'Deu lucro', atencao: 'Empatou', ruim: 'Deu prejuízo', incompleta: 'Margem incompleta' };
const DIA_DA_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function diaDaSemana(data: string): string {
  const [a, m, d] = data.split('-').map(Number);
  return DIA_DA_SEMANA[new Date(Date.UTC(a!, m! - 1, d!)).getUTCDay()]!;
}

/** O gráfico dos dias: as vendas dos anúncios em linha e o gasto em colunas, na mesma escala em reais. */
export function diasDe(serie: DailyResultsResponse | null, b: Pick<Base, 'fuso' | 'agora'>): GraficoDosDias | null {
  const d = serie?.days ?? [];
  if (d.length < 2) return null;
  const vendas = d.map((x) => centavos(BigInt(x.revenue_micros)));
  const gasto = d.map((x) => centavos(BigInt(x.spend_micros)));
  const max = Math.max(...vendas, ...gasto);
  if (max <= 0) return null;
  const ultimoIndice = d.length - 1;
  const x = (i: number) => Math.round((i / ultimoIndice) * 10_000) / 100;
  const altura = (v: number) => Math.round((v / max) * 9_200) / 100;
  const dias = d.map((dia, i): DiaDoGrafico => ({
    x: x(i),
    y: Math.round((100 - altura(vendas[i]!)) * 100) / 100,
    altura: altura(gasto[i]!),
    dica: dica(`${diaDaSemana(dia.date)}, ${diaMes(dia.date)}`, `vendas ${reaisInteiros(dia.revenue_micros)} · anúncios ${reaisInteiros(dia.spend_micros)}`),
  }));
  const pontos = dias.map((p) => `${p.x} ${p.y}`).join(' L');
  const muitos = d.length > 7;
  const indices = muitos ? [...new Set([0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(f * ultimoIndice)))] : d.map((_, i) => i);
  const ultimo = d[ultimoIndice]!;
  const melhor = d.reduce((a, dia) => (BigInt(dia.revenue_micros) > BigInt(a.revenue_micros) ? dia : a));
  const ontem = somarDias(dataNoFuso(b.agora, b.fuso), -1);
  return {
    dias,
    fino: muitos,
    linha: `M${pontos}`,
    area: `M0 100 L${pontos} L100 100 Z`,
    marcas: indices.map((i) => ({ x: x(i), texto: muitos ? diaMes(d[i]!.date) : diaDaSemana(d[i]!.date) })),
    ultimo: { valor: reaisInteiros(ultimo.revenue_micros), quando: ultimo.date === ontem ? 'ontem' : `em ${diaMes(ultimo.date)}`, y: dias[ultimoIndice]!.y },
    rotulo:
      `Vendas dos anúncios e gasto com anúncios por dia, de ${diaMes(d[0]!.date)} a ${diaMes(ultimo.date)}. ` +
      `O melhor dia foi ${diaDaSemana(melhor.date)}, ${diaMes(melhor.date)}, com ${reaisInteiros(melhor.revenue_micros)} em vendas. ` +
      `O último dia teve ${reaisInteiros(ultimo.revenue_micros)} em vendas e ${reaisInteiros(ultimo.spend_micros)} em anúncios.`,
  };
}

const linhaVazia = (rotulo: string, vazio: string): LinhaDoPar => ({ rotulo, valor: '—', barra: null, vazio });

/** O cartão do número principal no modo simples: quanto voltou para cada R$ 1, com as duas barras na mesma régua. */
export function retornoDe(r: ClosedLoopResponse, b: Base, serie: DailyResultsResponse | null): RetornoLite {
  const t = r.totals.confirmed;
  const gasto = BigInt(r.totals.spend_micros);
  const receita = BigInt(t.revenue_micros);
  const quando = b.hoje ? 'hoje, até agora' : 'no período';
  const base: RetornoLite = { titulo: `Retorno dos anúncios · ${b.rotuloPeriodo}`, valor: '—', vazio: true, selo: null, sub: null, variacao: null, par: null, dias: null };

  if (b.semRegem) {
    if (b.hoje || b.semMidia || gasto <= 0n) return { ...base, sub: [n('Falta o caixa da loja'), { t: ' para saber quanto os anúncios venderam de verdade.' }] };
    return {
      ...base,
      valor: reaisInteiros(gasto),
      vazio: false,
      sub: [{ t: 'investidos em anúncios. Quanto voltou, só o caixa da loja diz.' }],
      par: {
        rotulo: `Você pôs ${reais(gasto)} em anúncios. Quanto voltou depende do Regem, que não está conectado.`,
        linhas: [
          { rotulo: 'Você pôs', valor: reaisInteiros(gasto), barra: { largura: 100, tom: 'gasto', dica: dica(reais(gasto), 'investidos em anúncios') }, vazio: null },
          linhaVazia('Voltou', 'conecte o Regem para ver'),
        ],
        empate: null,
      },
    };
  }
  if (r.totals.orders_confirmed === 0) return { ...base, sub: [n(`Nenhum pedido confirmado ${quando}.`), { t: ' Quando entrar pedido, ele aparece aqui.' }] };
  if (b.semMidia) return { ...base, sub: [n('Falta a conta de anúncios'), { t: ' para saber quanto eles custaram e quanto voltou.' }] };
  if (t.orders === 0 && (b.hoje || t.roas === null)) return { ...base, sub: [n(`Nenhum pedido com prova de anúncio ${quando}.`), { t: ' Os outros pedidos aparecem abaixo, pela origem.' }] };
  if (b.hoje) {
    return {
      ...base,
      titulo: `Vendas dos anúncios · ${b.rotuloPeriodo}`,
      valor: reaisInteiros(receita),
      vazio: false,
      selo: { rotulo: 'O retorno sai amanhã', classe: 'neutro' },
      sub: [{ t: 'em ' }, n(plural(t.orders, 'pedido', 'pedidos')), { t: ` que ${t.orders === 1 ? 'veio' : 'vieram'} de anúncios, até ${horaNoFuso(new Date(r.generated_at), b.fuso)}` }],
      par: {
        rotulo: `Hoje, até agora, ${reais(receita)} em vendas vieram de anúncios. O gasto do dia sai amanhã.`,
        linhas: [
          linhaVazia('Você pôs', 'sai amanhã, com o gasto do dia'),
          { rotulo: 'Voltou', valor: reaisInteiros(receita), barra: { largura: 100, tom: 'foco', dica: dica(reais(receita), `em ${plural(t.orders, 'pedido', 'pedidos')} de anúncios, hoje`) }, vazio: null },
        ],
        empate: null,
      },
    };
  }
  if (t.roas === null) return { ...base, sub: [n('Sem gasto com anúncios no período.'), { t: ` As vendas com prova de anúncio somam ${reais(receita)}.` }] };

  const ver = vereditoDe(t, r.totals.spend_micros, false);
  const roas = centesimosDe(t.roas);
  const margem = t.margin_known_micros === null ? null : BigInt(t.margin_known_micros);
  // O ponto em que a margem das vendas paga o anúncio (a mesma conta do veredito): receita ÷ margem conhecida, em centésimos.
  const empate = ver && ver.classe !== 'incompleta' && margem !== null && margem > 0n ? (receita * 100n + margem / 2n) / margem : null;
  const regua = [100n, roas, empate ?? 0n].reduce((a, v) => (v > a ? v : a));
  const anterior = serie?.previous.roas ?? null;
  let variacao: RetornoLite['variacao'] = null;
  if (anterior !== null && serie) {
    const dias = serie.days.length;
    const periodo = dias === 1 ? 'no dia anterior' : `nos ${dias} dias anteriores`;
    const diferenca = roas - centesimosDe(anterior);
    variacao =
      diferenca === 0n
        ? { sentido: 'igual', frase: [{ t: `Igual ao que voltou ${periodo}.` }] }
        : {
            sentido: diferenca > 0n ? 'sobe' : 'cai',
            frase: [n(`${reaisDeMicros((diferenca < 0n ? -diferenca : diferenca) * 10_000n)} ${diferenca > 0n ? 'a mais' : 'a menos'}`), { t: ` que ${periodo} (${reaisPorReal(anterior)})` }],
          };
  }
  const valorDoEmpate = empate === null ? null : reaisDeMicros(empate * 10_000n);
  return {
    ...base,
    valor: reaisPorReal(t.roas),
    vazio: false,
    selo: ver ? { rotulo: SELO_DO_PERIODO[ver.classe] ?? ver.rotulo, classe: ver.classe } : null,
    sub: t.orders === 0 ? [n('Nenhum pedido com prova de anúncio no período.')] : [{ t: 'de volta para cada R$ 1 em anúncio' }],
    variacao,
    par: {
      rotulo: `Para cada 1 real em anúncio, voltaram ${reaisPorReal(t.roas)} em vendas confirmadas no caixa${valorDoEmpate ? `. O anúncio se paga a partir de ${valorDoEmpate}` : ''}.`,
      linhas: [
        { rotulo: 'Você pôs', valor: 'R$ 1', barra: { largura: fracao(100n, regua), tom: 'gasto', dica: dica(reais(gasto), 'investidos em anúncios') }, vazio: null },
        { rotulo: 'Voltou', valor: reaisPorReal(t.roas), barra: { largura: fracao(roas, regua), tom: 'foco', dica: dica(reais(receita), `em vendas confirmadas no caixa · ${plural(t.orders, 'pedido', 'pedidos')}`) }, vazio: null },
      ],
      empate: empate === null ? null : { posicao: fracao(empate, regua), valor: valorDoEmpate!, dica: dica(`Empata em ${valorDoEmpate}`, 'o que precisa voltar, para cada R$ 1, para pagar o produto e o anúncio') },
    },
    dias: t.orders > 0 ? diasDe(serie, b) : null,
  };
}

// ------------------------------------------------------------------ para onde foi cada real vendido

export type ParteDaBarra = {
  classe: 'foco' | 'c1' | 'c2' | 'falta' | 'semcusto';
  /** Tamanho relativo da parte (centavos ou contagem). */
  peso: number;
  valor: string;
  rotulo: string;
  dica: string;
};

export type BarraDividida = {
  partes: ParteDaBarra[];
  /** Marca sobre a barra: depois de `antes` partes, na fração `posicao` (0 a 1) do comprimento. */
  marca: { posicao: number; antes: number; texto: string } | null;
  rotulo: string;
};

export type RealLite = { tipo: 'vago'; frase: Frase } | { tipo: 'barra'; barra: BarraDividida; frase: Frase };

/** "Para onde foi cada real vendido": custo dos produtos, itens sem custo, anúncios e o que sobrou (ou faltou). */
export function realDe(r: ClosedLoopResponse, b: Base): RealLite {
  const t = r.totals.confirmed;
  const vago = (frase: Frase): RealLite => ({ tipo: 'vago', frase });
  if (b.semRegem) return vago([n('Precisa do caixa da loja.'), { t: ' É o Regem que diz quanto custou cada produto vendido.' }]);
  if (r.totals.orders_confirmed === 0) return vago([n(`Nenhum pedido confirmado ${b.hoje ? 'hoje, até agora' : 'no período'}.`)]);
  if (t.orders === 0) return vago([n(`Nenhum pedido com prova de anúncio ${b.hoje ? 'hoje, até agora' : 'no período'}.`)]);
  if (b.hoje) return vago([n('Fecha amanhã,'), { t: ' com o gasto do dia.' }]);
  if (b.semMidia) return vago([n('Precisa da conta de anúncios.'), { t: ' Sem o gasto, não dá para dizer o que sobrou.' }]);
  const gasto = BigInt(r.totals.spend_micros);
  if (gasto <= 0n) return vago([n('Sem gasto com anúncios no período.')]);

  const receita = BigInt(t.revenue_micros);
  // A receita com margem conhecida vem da rota; resposta guardada de antes não a traz: cai na porcentagem.
  const comCusto =
    t.revenue_with_margin_micros !== undefined ? BigInt(t.revenue_with_margin_micros) : t.margin_coverage_pct === null ? 0n : (receita * BigInt(decimosDe(t.margin_coverage_pct))) / 1000n;
  const semCusto = receita > comCusto ? receita - comCusto : 0n;
  const ver = vereditoDe(t, r.totals.spend_micros, false);
  const sobra = sobraDe(t, r.totals.spend_micros);
  const daReceita = (v: bigint) => parte(v, receita);

  if (!ver || ver.classe === 'incompleta' || sobra === null) {
    const cobertura = t.margin_coverage_pct === null ? '0%' : porcentagem(t.margin_coverage_pct);
    const partes: ParteDaBarra[] = [
      { classe: 'foco', peso: centavos(comCusto), valor: cobertura, rotulo: 'das vendas com custo no Regem', dica: dica(reais(comCusto), `em vendas com custo no Regem (${cobertura})`) },
      { classe: 'semcusto', peso: centavos(semCusto), valor: reaisInteiros(semCusto), rotulo: 'em itens sem custo', dica: dica(reais(semCusto), 'em vendas de itens sem custo') },
    ];
    return {
      tipo: 'barra',
      barra: {
        partes: partes.filter((p) => p.peso > 0),
        marca: { posicao: 0.8, antes: 0, texto: 'precisa de 80%' },
        rotulo: `${cobertura} das vendas têm custo cadastrado no Regem. A partir de 80%, o Liame diz para onde foi cada real.`,
      },
      frase: [n('Ainda não dá para dizer se sobrou.'), { t: ' Falta o custo de alguns itens no Regem.' }],
    };
  }

  const margem = BigInt(t.margin_known_micros!);
  const custo = comCusto > margem ? comCusto - margem : 0n;
  const falta = sobra < 0n ? -sobra : 0n;
  const coberto = gasto < margem ? gasto : margem > 0n ? margem : 0n;
  const partes: ParteDaBarra[] = [
    { classe: 'c2', peso: centavos(custo), valor: reaisInteiros(custo), rotulo: 'custo dos produtos', dica: dica(reais(custo), `custo dos produtos · ${daReceita(custo)} do que foi vendido`) },
    { classe: 'semcusto', peso: centavos(semCusto), valor: reaisInteiros(semCusto), rotulo: 'em itens sem custo no Regem', dica: dica(reais(semCusto), `em itens sem custo no Regem · ${daReceita(semCusto)} do que foi vendido`) },
    // A barra dos anúncios vai até onde a margem cobre; o valor escrito é o gasto inteiro.
    { classe: 'c1', peso: centavos(coberto), valor: reaisInteiros(gasto), rotulo: 'anúncios', dica: dica(reais(gasto), `anúncios · ${daReceita(gasto)} do que foi vendido`) },
    sobra >= 0n
      ? { classe: 'foco', peso: centavos(sobra), valor: reaisInteiros(sobra), rotulo: 'sobrou', dica: dica(reais(sobra), `sobrou · ${daReceita(sobra)} do que foi vendido`) }
      : { classe: 'falta', peso: centavos(falta), valor: reaisInteiros(falta), rotulo: 'faltou', dica: dica(reais(falta), 'faltou para pagar os anúncios') },
  ];
  const visiveis = partes.filter((p) => p.peso > 0);
  const pedidos = plural(t.orders, 'pedido', 'pedidos');
  const frase: Frase =
    sobra < 0n
      ? [n(`De ${reaisInteiros(receita)} vendidos em ${pedidos}, faltaram ${reaisInteiros(falta)} para pagar os anúncios.`), ...(ver.classe === 'atencao' ? [{ t: ' Quase empatou.' }] : [])]
      : [n(`De ${reaisInteiros(receita)} vendidos em ${pedidos}, sobraram ${reaisInteiros(sobra)}.`), ...(ver.classe === 'atencao' ? [{ t: ' O anúncio se pagou, por pouco.' }] : [])];
  const lido = visiveis.map((p) =>
    p.rotulo === 'sobrou' ? `${p.valor} que sobraram` : p.rotulo === 'faltou' ? `${p.valor} que faltaram para pagar os anúncios` : p.rotulo.startsWith('em ') ? `${p.valor} ${p.rotulo}` : `${p.valor} de ${p.rotulo}`,
  );
  return {
    tipo: 'barra',
    barra: {
      partes: visiveis,
      // No prejuízo, o que faltou passa do que foi vendido: a marca fica entre os anúncios e o "faltou".
      marca: falta > 0n ? { posicao: fracao(receita, receita + falta) / 100, antes: visiveis.length - 1, texto: `vendido: ${reaisInteiros(receita)}` } : null,
      rotulo: `Dos ${reais(receita)} vendidos: ${juntar(lido)}.`,
    },
    frase,
  };
}

// ------------------------------------------------------------------ cada campanha

export type BarraDaCampanha =
  | { tipo: 'ganho' | 'perda'; largura: number; valor: string; dica: string }
  | { tipo: 'tamanho'; tom: 'foco' | 'gasto'; largura: number; valor: string; dica: string }
  | { tipo: 'neutro' | 'semcusto'; texto: string; dica: string };

export type LinhaCampanhaLite = { id: string; nome: string; provider: string; sub: string; barra: BarraDaCampanha; selo: SeloDoPeriodo | null; rotulo: string };

export type CampanhasLite = {
  titulo: string;
  /** "sobra": barras para a direita (sobrou) e para a esquerda (faltou); "tamanho": barras de quantidade. */
  modo: 'sobra' | 'tamanho';
  /** Onde fica o zero da régua (0 a 100). */
  zero: number;
  temFalta: boolean;
  temSobra: boolean;
  linhas: LinhaCampanhaLite[];
  rotulo: string;
};

/** Cada campanha no modo simples: sobrou (para a direita) ou faltou (para a esquerda), depois de pagar o anúncio. */
export function campanhasLiteDe(r: ClosedLoopResponse, b: Base): CampanhasLite {
  const sub = (c: ClosedLoopResponse['campaigns'][number]) => `${nomesDe(c.provider).nome} · ${situacaoDaCampanha(c.status)}`;
  if (b.semRegem || b.hoje) {
    // Sem o caixa só há o gasto; em "Hoje" só há os pedidos (o gasto sai amanhã): uma barra de tamanho, sem veredito.
    const porGasto = b.semRegem && !b.hoje;
    const tamanho = (c: ClosedLoopResponse['campaigns'][number]) => (porGasto ? centavos(BigInt(c.platform.spend_micros)) : b.semRegem ? 0 : c.confirmed.orders);
    const max = Math.max(1, ...r.campaigns.map(tamanho));
    return {
      titulo: porGasto ? 'Quanto cada campanha gastou' : b.semRegem ? 'Cada campanha' : 'Pedidos de hoje, por campanha',
      modo: 'tamanho',
      zero: 0,
      temFalta: false,
      temSobra: false,
      rotulo: porGasto ? 'Quanto cada campanha gastou no período' : 'Pedidos de hoje por campanha',
      linhas: r.campaigns.map((c): LinhaCampanhaLite => {
        const v = tamanho(c);
        const largura = Math.round((v / max) * 10_000) / 100;
        let barra: BarraDaCampanha;
        let rotulo: string;
        if (porGasto) {
          barra = v > 0 ? { tipo: 'tamanho', tom: 'gasto', largura, valor: reais(c.platform.spend_micros), dica: dica(reais(c.platform.spend_micros), 'investidos no período') } : { tipo: 'neutro', texto: 'sem gasto no período', dica: 'Sem gasto no período' };
          rotulo = `${c.name}: ${reais(c.platform.spend_micros)} investidos`;
        } else if (b.semRegem) {
          barra = { tipo: 'neutro', texto: 'o gasto de hoje sai amanhã', dica: 'O gasto de hoje sai amanhã' };
          rotulo = `${c.name}: o gasto de hoje sai amanhã`;
        } else if (v > 0) {
          barra = { tipo: 'tamanho', tom: 'foco', largura, valor: plural(v, 'pedido', 'pedidos'), dica: dica(reais(c.confirmed.revenue_micros), `em ${plural(v, 'pedido', 'pedidos')} hoje`) };
          rotulo = `${c.name}: ${plural(v, 'pedido', 'pedidos')} hoje, ${reais(c.confirmed.revenue_micros)}`;
        } else {
          barra = { tipo: 'neutro', texto: 'sem pedido ainda', dica: 'Sem pedido hoje, até agora' };
          rotulo = `${c.name}: sem pedido hoje, até agora`;
        }
        return { id: c.campaign_id, nome: c.name, provider: c.provider, sub: sub(c), barra, selo: null, rotulo };
      }),
    };
  }

  const medida = (c: ClosedLoopResponse['campaigns'][number]) => {
    const ver = vereditoDe(c.confirmed, c.platform.spend_micros, false);
    const sobra = sobraDe(c.confirmed, c.platform.spend_micros);
    return c.confirmed.orders > 0 && ver && ver.classe !== 'incompleta' && sobra !== null ? { ver, sobra } : null;
  };
  const sobras = r.campaigns.map(medida).filter((m) => m !== null).map((m) => m.sobra);
  const maior = (valores: bigint[]) => valores.reduce((a, v) => (v > a ? v : a), 0n);
  const pos = centavos(maior(sobras));
  const neg = centavos(maior(sobras.map((s) => -s)));
  let zero = pos + neg > 0 ? (neg / (pos + neg)) * 100 : 0;
  if (neg > 0) zero = Math.max(zero, 20);
  if (pos > 0) zero = Math.min(zero, 60);
  else if (neg > 0) zero = 60;
  zero = Math.round(zero * 100) / 100;
  // Centavos por ponto percentual: a mesma régua dos dois lados do zero.
  const regua = Math.max(pos / (100 - zero), zero > 0 ? neg / zero : 0) || 1;
  return {
    titulo: 'Cada campanha, depois de pagar o anúncio',
    modo: 'sobra',
    zero,
    temFalta: neg > 0,
    temSobra: pos > 0,
    rotulo: 'Quanto sobrou ou faltou em cada campanha, depois de pagar o anúncio',
    linhas: r.campaigns.map((c): LinhaCampanhaLite => {
      const k = c.confirmed;
      const gasto = c.platform.spend_micros;
      const m = medida(c);
      let barra: BarraDaCampanha;
      let selo: SeloDoPeriodo | null;
      let rotulo: string;
      if (!k.orders) {
        const gastou = BigInt(gasto) > 0n;
        barra = { tipo: 'neutro', texto: gastou ? `gastou ${reaisInteiros(gasto)}` : 'sem gasto', dica: dica('Sem pedido no período', gastou ? `gastou ${reais(gasto)}` : '') };
        selo = { rotulo: 'Sem pedido', classe: 'neutro' };
        rotulo = `${c.name}: sem pedido no período${gastou ? `; gastou ${reais(gasto)}` : ''}`;
      } else if (k.roas === null) {
        barra = { tipo: 'neutro', texto: `${plural(k.orders, 'pedido', 'pedidos')} · sem gasto`, dica: dica(reais(k.revenue_micros), `em ${plural(k.orders, 'pedido', 'pedidos')}, sem gasto no período`) };
        selo = null;
        rotulo = `${c.name}: ${plural(k.orders, 'pedido', 'pedidos')}, ${reais(k.revenue_micros)}, sem gasto no período`;
      } else if (!m) {
        const cobertura = k.margin_coverage_pct === null ? null : porcentagem(k.margin_coverage_pct);
        barra = {
          tipo: 'semcusto',
          texto: cobertura ? `só ${cobertura} com custo` : 'sem custo no Regem',
          dica: dica(cobertura ? `Só ${cobertura} das vendas com custo` : 'Vendas sem custo no Regem', 'com menos de 80%, o Liame não diz se sobrou'),
        };
        selo = { rotulo: 'Margem incompleta', classe: 'incompleta' };
        rotulo = `${c.name}: ${cobertura ? `só ${cobertura} das vendas têm custo no Regem` : 'as vendas não têm custo no Regem'}; não dá para dizer se sobrou`;
      } else {
        const ganho = m.sobra >= 0n;
        const absoluto = ganho ? m.sobra : -m.sobra;
        barra = {
          tipo: ganho ? 'ganho' : 'perda',
          largura: Math.round((centavos(absoluto) / regua) * 100) / 100,
          valor: `${ganho ? '+' : '−'} ${reaisInteiros(absoluto)}`,
          dica: dica(`${ganho ? 'Sobraram' : 'Faltaram'} ${reais(absoluto)}`, `R$ 1 virou ${reaisPorReal(k.roas)} · ${plural(k.orders, 'pedido', 'pedidos')}`),
        };
        selo = { rotulo: m.ver.rotulo, classe: m.ver.classe };
        rotulo = `${c.name}: ${ganho ? 'sobraram' : 'faltaram'} ${reais(absoluto)} depois de pagar o anúncio`;
      }
      return { id: c.campaign_id, nome: c.name, provider: c.provider, sub: sub(c), barra, selo, rotulo };
    }),
  };
}

// ------------------------------------------------------------------ das conversas ao pedido

export type LinhaConversa = { id: string; nome: string; plataforma: string; largura: number; fatia: number; frase: Frase; rotulo: string; dicaConversas: string; dicaPedidos: string };

/** Campanhas de mensagem: os pedidos dentro das conversas abertas pelo anúncio, na mesma régua entre as campanhas. */
export function conversasDe(r: ClosedLoopResponse, b: Base): LinhaConversa[] {
  if (b.hoje || b.semRegem) return [];
  const msgs = r.campaigns.filter((c) => ehDeMensagem(c.platform));
  const max = msgs.reduce((a, c) => (BigInt(c.platform.conversations!) > a ? BigInt(c.platform.conversations!) : a), 0n);
  return msgs.map((c): LinhaConversa => {
    const conversas = BigInt(c.platform.conversations!);
    const pedidos = c.confirmed.orders;
    const porConversa = c.platform.cost_per_conversation_micros ? ` · ${reais(c.platform.cost_per_conversation_micros)} por conversa` : '';
    const porPedido = c.confirmed.cost_per_order_micros ? ` · ${reais(c.confirmed.cost_per_order_micros)} por pedido` : '';
    return {
      id: c.campaign_id,
      nome: c.name,
      plataforma: nomesDe(c.provider).nome,
      largura: fracao(conversas, max),
      fatia: Math.min(100, fracao(BigInt(pedidos), conversas)),
      frase: pedidos
        ? [n(`${inteiro(pedidos)} de ${inteiro(conversas)}`), { t: ` conversas viraram pedido${porConversa}${porPedido}` }]
        : [{ t: 'Nenhuma das ' }, n(inteiro(conversas)), { t: ` conversas virou pedido ainda${porConversa}` }],
      rotulo: `${c.name}: ${inteiro(pedidos)} de ${inteiro(conversas)} conversas viraram pedido`,
      dicaConversas: dica(`${inteiro(conversas)} conversas`, 'abertas pelo anúncio'),
      dicaPedidos: dica(plural(pedidos, 'pedido', 'pedidos'), `${parte(pedidos, conversas)} das conversas`),
    };
  });
}

// ------------------------------------------------------------------ de onde vieram os pedidos

export type OrigemLite = { titulo: string; barra: BarraDividida; cancelados: Frase | null };

/** A origem dos pedidos numa barra só: com prova de anúncio, canais sem clique e cardápio e WhatsApp sem prova. */
export function origemLiteDe(r: ClosedLoopResponse, b: Base): OrigemLite | null {
  const tot = r.totals;
  if (b.semRegem || tot.orders_confirmed === 0) return null;
  const semClique = tot.no_click_channels.reduce((s, c) => s + c.orders, 0);
  const itens: { classe: ParteDaBarra['classe']; n: number; rotulo: string }[] = [
    { classe: 'foco', n: tot.confirmed.orders, rotulo: 'de anúncios, com prova' },
    { classe: 'c1', n: semClique, rotulo: 'de aplicativos de entrega, balcão e outros canais sem clique' },
    { classe: 'c2', n: tot.without_origin.orders, rotulo: 'do cardápio e do WhatsApp, sem prova de anúncio' },
  ];
  const todos = itens.reduce((s, i) => s + i.n, 0);
  const partes = itens
    .filter((i) => i.n > 0)
    .map((i): ParteDaBarra => ({ classe: i.classe, peso: i.n, valor: inteiro(i.n), rotulo: i.rotulo, dica: dica(plural(i.n, 'pedido', 'pedidos'), `${i.rotulo} · ${parte(i.n, todos)}`) }));
  return {
    titulo: `De onde vieram os ${inteiro(todos)} pedidos`,
    barra: { partes, marca: null, rotulo: `Dos ${plural(todos, 'pedido', 'pedidos')} do período: ${juntar(partes.map((p) => `${p.valor} ${p.rotulo}`))}.` },
    cancelados: tot.cancelled.orders ? [{ t: 'Mais ' }, n(plural(tot.cancelled.orders, 'pedido cancelado', 'pedidos cancelados')), { t: ' depois, fora da conta.' }] : null,
  };
}

// ------------------------------------------------------------------ tudo junto

export type GraficosDaTela = {
  faixa: FaixaDoTopo;
  retorno: RetornoLite;
  real: RealLite;
  campanhas: CampanhasLite;
  conversas: LinhaConversa[];
  origem: OrigemLite | null;
};

/** Os desenhos do modo simples, a partir da resposta da API e da série por dia (nula enquanto ela não chega). */
export function montarGraficos(r: ClosedLoopResponse, b: Base, fontes: Fonte[], avisos: Aviso[], serie: DailyResultsResponse | null): GraficosDaTela {
  return {
    faixa: faixaDe(r, b, fontes, avisos),
    retorno: retornoDe(r, b, serie),
    real: realDe(r, b),
    campanhas: campanhasLiteDe(r, b),
    conversas: conversasDe(r, b),
    origem: origemLiteDe(r, b),
  };
}
