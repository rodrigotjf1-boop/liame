import type { ActionStatus, CreativeTestResponse } from '@liame/contracts';
import type { Tom } from '@/components/criativos/campanha-nova-textos';
import { reaisDeMicros } from '@/lib/formato';

// O teste de criativo em Aprovações (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026; D-RG-76
// a D-RG-80 e D-RG-91 a D-RG-94): as frases da tela, sem React. Os três pedidos do teste (criar a campanha de teste
// pausada, ativar e encerrar) abrem a mesma tela, que acompanha o teste depois de aprovado: o veredito de cada semana
// inteira, os dois criativos lado a lado, o pedido para pausar o que perdeu e "Encerrar o teste". Quem decide é o caixa.

export const FERRAMENTAS_DO_TESTE = ['teste_de_criativo_criar', 'teste_de_criativo_ativar', 'teste_de_criativo_pausar'] as const;
export const ehPedidoDoTeste = (a: { tool: string }): boolean => (FERRAMENTAS_DO_TESTE as readonly string[]).includes(a.tool);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXO = 'teste_de_criativo:';
/** O id do teste no recurso do pedido (`teste_de_criativo:<id>`), ou nulo quando o recurso é outro. */
export function idDoTeste(recurso: string): string | null {
  const id = recurso.startsWith(PREFIXO) ? recurso.slice(PREFIXO.length) : '';
  return UUID.test(id) ? id : null;
}

type Teste = CreativeTestResponse;
type Letra = 'A' | 'B';
type NumerosDoCriativo = NonNullable<Teste['result']>['arms'][number];
const outra = (l: Letra): Letra => (l === 'A' ? 'B' : 'A');
const reais = (micros: number): string => reaisDeMicros(BigInt(Math.round(micros)));
/** "16/11" de "2026-11-16". */
export const diaMes = (dia: string): string => `${dia.slice(8, 10)}/${dia.slice(5, 7)}`;
const somarDias = (dia: string, n: number): string => new Date(Date.parse(`${dia}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const diasEntre = (de: string, ate: string): number => Math.round((Date.parse(`${ate}T12:00:00Z`) - Date.parse(`${de}T12:00:00Z`)) / 86_400_000);
const quantos = (n: number): string => `${n} ${n === 1 ? 'pedido' : 'pedidos'}`;

/** O limite de acaso de cada olhada (D-RG-91: quatro olhadas, 95% de confiança no teste inteiro), em palavras. */
export const LIMITE_POR_OLHADA = '1,82%';
/** Os dias em que o Liame olha o teste: o fim de cada semana inteira (D-RG-91). */
export const DIAS_DAS_OLHADAS = [7, 14, 21, 28] as const;

/** A chance de acaso em porcentagem, como a tela escreve: "48%", "2,3%", "menos de 0,1%". */
export function pct(v: number): string {
  if (v < 0.001) return 'menos de 0,1%';
  return `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: v < 0.1 ? 1 : 0 })}%`;
}

export const tituloDoTeste = (t: Pick<Teste, 'name'>): string => `Teste de criativo: ${t.name}`;

/** O título do pedido na lista e no detalhe, pela ferramenta. */
export function tituloDoPedidoDoTeste(tool: string, nome: string | null): string {
  const doTeste = nome ? `o teste “${nome}”` : 'o teste de criativo';
  if (tool === 'teste_de_criativo_ativar') return `Ativar ${doTeste}`;
  if (tool === 'teste_de_criativo_pausar') return `Encerrar ${doTeste}`;
  return nome ? `Teste de criativo: ${nome}` : 'Teste de criativo';
}

/** O dia do teste hoje: o dia 1 é o primeiro dia inteiro com os dois criativos no ar. Nulo antes de começar. */
export function diaDoTeste(t: Pick<Teste, 'started_on'>, hoje: string): number | null {
  if (!t.started_on || hoje < t.started_on) return null;
  return diasEntre(t.started_on, hoje) + 1;
}

/**
 * A próxima olhada do teste que roda (o dia e a data dele); nula depois da última. As olhadas saem em ordem, e a do dia
 * N só sai depois de a leitura do caixa cobrir o dia N inteiro: a próxima é a primeira que ainda não saiu.
 */
export function proximaOlhada(t: Pick<Teste, 'started_on' | 'max_days' | 'result'>): { dia: number; data: string } | null {
  if (!t.started_on) return null;
  const feitas = new Set((t.result?.looks ?? []).map((o) => o.day));
  const proxima = DIAS_DAS_OLHADAS.find((d) => d <= t.max_days && !feitas.has(d));
  return proxima === undefined ? null : { dia: proxima, data: diaMes(somarDias(t.started_on, proxima - 1)) };
}

/** A situação do teste na etiqueta, no tom que a tela já tem. */
export function situacaoDoTeste(t: Pick<Teste, 'status' | 'active' | 'pending_action_id' | 'result'>): { rotulo: string; tom: Tom } {
  switch (t.status) {
    case 'pedido':
      return { rotulo: 'Espera a aprovação', tom: 'aguardando' };
    case 'criando':
      return { rotulo: 'Criando na Meta', tom: 'trabalhando' };
    case 'pronto':
      return t.pending_action_id ? { rotulo: 'Ativação pedida', tom: 'aguardando' } : { rotulo: 'Pronto e pausado', tom: 'neutro' };
    case 'rodando':
      return { rotulo: 'Rodando', tom: 'trabalhando' };
    case 'terminado':
      return t.result?.verdict === 'venceu' ? { rotulo: `O criativo ${t.result.winner ?? ''} venceu`, tom: 'concluido' } : { rotulo: 'Acabou sem vencedor', tom: 'concluido' };
    case 'encerrado':
      return { rotulo: 'Encerrado', tom: 'pausado' };
    case 'interrompido':
      return { rotulo: 'Interrompido', tom: 'perigo' };
    default:
      return { rotulo: 'Não criado', tom: 'neutro' };
  }
}

/** Quem vê os dois criativos (o mesmo público nos dois conjuntos). */
export function publicoDoTeste(t: Pick<Teste, 'radius_km' | 'districts'>): string {
  if (t.districts?.length) {
    const nomes = t.districts.map((b) => b.name);
    const lista = nomes.length === 1 ? nomes[0]! : `${nomes.slice(0, -1).join(', ')} e ${nomes.at(-1)}`;
    return `${nomes.length === 1 ? 'o bairro' : `os ${nomes.length} bairros`} ${lista}`;
  }
  const km = (t.radius_km ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
  return `o raio de ${km} km em volta da loja`;
}

/** O desconto dos dois cupons, como o cupom diz (nada de "na primeira compra": o cupom do teste não tem essa regra). */
export function descontoDoTeste(d: Teste['discount']): string {
  const quanto = d.kind === 'percentual' ? `${d.percent ?? 0}% de desconto` : `${reais((d.value_cents ?? 0) * 10_000)} de desconto`;
  const minimo = d.min_order_cents > 0 ? ` em pedidos a partir de ${reais(d.min_order_cents * 10_000)}` : '';
  return `${quanto}${minimo}`;
}

/** A situação do cupom de um criativo no Regem. */
export const SITUACAO_DO_CUPOM: Record<Teste['arms'][number]['coupon_status'], string> = {
  a_criar: 'a criar no Regem, depois da aprovação',
  pedido: 'pedido ao Regem',
  criado: 'criado no Regem',
  falhou: 'não foi criado no Regem',
};

/** A frase do pedido de criar: o que é o teste, em uma frase. */
export function fraseDoTeste(t: Pick<Teste, 'daily_budget_micros' | 'min_days' | 'max_days'>): string {
  return `Dois criativos da mesma oferta rodam lado a lado, com a mesma verba e o mesmo público: só o criativo muda. Cada um tem o seu cupom, e quem decide é o caixa: os pedidos confirmados de cada um. O teste custa ${reais(t.daily_budget_micros)} por dia (${reais(t.daily_budget_micros / 2)} para cada criativo) e dura de ${t.min_days} a ${t.max_days} dias.`;
}

/** A frase do pedido de ativar: o que passa a gastar, e qual é a volta (a ativação não tem "Desfazer"). */
export function fraseDaAtivacao(t: Pick<Teste, 'daily_budget_micros' | 'min_days' | 'max_days'>): string {
  return `Ativada, a campanha de teste gasta ${reais(t.daily_budget_micros)} por dia (${reais(t.daily_budget_micros / 2)} para cada criativo), por ${t.min_days} a ${t.max_days} dias, depois que a Meta revisar os dois anúncios. A volta é “Encerrar o teste”, que pausa a campanha de teste e não pede o código.`;
}

/** O que a pessoa aprova no pedido de criar: o dinheiro e os limites. */
export function riscoDoTeste(t: Pick<Teste, 'daily_budget_micros' | 'max_days'>): string {
  return `É verba nova: ${reais(t.daily_budget_micros)} por dia, até ${reais(t.daily_budget_micros * t.max_days)} se o teste for até o fim. Passa pelo teto por campanha e pela verba do mês, como toda campanha nova; o gasto só começa depois de outra aprovação, a de ativar.`;
}

/** As regras do teste, na ordem do protótipo (com o limite de cada olhada da D-RG-91 e a exposição da D-RG-92). */
export function regrasDoTeste(t: Pick<Teste, 'min_days' | 'max_days'>): Array<{ icone: 'clock' | 'chart' | 'shield' | 'sliders' | 'users' | 'undo'; texto: string }> {
  return [
    { icone: 'clock', texto: `O Liame não espia: olha só no fim de cada semana inteira (os dias ${DIAS_DAS_OLHADAS.filter((d) => d <= t.max_days).join(', ').replace(/, (\d+)$/, ' e $1')}). Antes do dia ${t.min_days}, não há vencedor.` },
    { icone: 'chart', texto: `Vencedor só quando a diferença de pedidos é maior do que o acaso explicaria: abaixo de ${LIMITE_POR_OLHADA} em cada olhada, para valer 95% de confiança no teste inteiro. Com poucos pedidos, o normal é “ainda não dá para dizer”.` },
    { icone: 'shield', texto: `Em ${t.max_days} dias o teste acaba, com ou sem vencedor. O Liame avisa na Atenção e não muda nada sozinho.` },
    { icone: 'sliders', texto: 'Enquanto o teste roda, a campanha de teste fica fora do ritmo da semana: mudar a verba de um lado estragaria a comparação.' },
    { icone: 'users', texto: EXPOSICAO },
    { icone: 'undo', texto: '“Encerrar o teste” para de medir e pausa a campanha de teste. Não precisa do código.' },
  ];
}

/** D-RG-92: não é o teste dividido da Meta. */
export const EXPOSICAO =
  'Não é o teste dividido da Meta: os dois conjuntos disputam o mesmo público, e a mesma pessoa pode ver os dois anúncios. O cupom de cada um diz de qual anúncio veio o pedido, não quem viu.';
/** D-RG-93: como o pedido é ligado ao criativo. */
export const LIGACAO_DO_PEDIDO =
  'O pedido conta para um criativo quando tem o cupom dele, ou quando o clique no anúncio dele chegou pelo cardápio do Regem. Se a loja recebe os pedidos por outra plataforma, só o cupom separa os dois.';

export type Veredito = { titulo: string; texto: string; venceu: boolean };

/** O veredito da última olhada, em palavras; nulo antes de o teste rodar. */
export function vereditoDoTeste(t: Pick<Teste, 'status' | 'started_on' | 'min_days' | 'result' | 'arms'>): Veredito | null {
  const r = t.result;
  if (!r) {
    if (t.status !== 'rodando' || !t.started_on) return null;
    return {
      titulo: 'Ainda não dá para dizer',
      texto: `O Liame olha pela primeira vez no fim do dia ${t.min_days} (${diaMes(somarDias(t.started_on, t.min_days - 1))}), com a semana inteira. Antes disso, não há vencedor.`,
      venceu: false,
    };
  }
  const ultima = r.looks.at(-1);
  if (!ultima) return null;
  const { orders_a: a, orders_b: b, chance, day } = ultima;
  if (r.verdict === 'venceu' && r.winner) {
    const w = r.winner;
    const titulo = t.arms.find((x) => x.letter === w)?.title;
    const [mais, menos] = w === 'A' ? [a, b] : [b, a];
    return {
      titulo: `O criativo ${w} venceu`,
      texto: `${titulo ? `${titulo}: ` : ''}${quantos(mais)} no caixa contra ${menos}, com a mesma verba, em ${day} dias. A chance de uma diferença assim aparecer por acaso é de ${pct(chance)} (o Liame só dá um vencedor abaixo de ${LIMITE_POR_OLHADA} em cada olhada).`,
      venceu: true,
    };
  }
  if (r.verdict === 'sem_vencedor') {
    return {
      titulo: 'O teste acabou sem vencedor',
      texto: `Em ${day} dias, ${quantos(a)} do criativo A contra ${b} do B: uma diferença assim aparece por acaso em ${pct(chance)} das vezes. Pelo caixa, os dois vendem parecido.`,
      venceu: false,
    };
  }
  return {
    titulo: 'Ainda não dá para dizer',
    texto: `Na olhada do dia ${day}: ${quantos(a)} do criativo A contra ${b} do B. Uma diferença assim aparece por acaso em ${pct(chance)} das vezes; o Liame só dá um vencedor quando essa chance fica abaixo de ${LIMITE_POR_OLHADA} numa olhada.`,
    venceu: false,
  };
}

/** Pelo sinal (não é prova): qual criativo traz a visita mais barata, quando os dois já têm gasto e visitas. */
export function sinalDaVisita(t: Pick<Teste, 'result'>): string | null {
  const arms = t.result?.arms;
  if (!arms) return null;
  const custo = (l: Letra) => {
    const x = arms.find((y) => y.letter === l);
    return x?.spend_micros && x.link_clicks ? x.spend_micros / x.link_clicks : null;
  };
  const [a, b] = [custo('A'), custo('B')];
  if (a === null || b === null || a === b) return null;
  const barato: Letra = a < b ? 'A' : 'B';
  return `Pelo sinal (não é prova): o criativo ${barato} traz a visita mais barata, ${reais(Math.min(a, b))} contra ${reais(Math.max(a, b))} por visita. Você pode ficar com os dois, ou testar outra coisa (a oferta, o texto).`;
}

export type LinhaDaTabela = { rotulo: string; sub: string | null; valores: Record<Letra, { texto: string; sub: string | null; forte: boolean }> };

/** As linhas da tabela dos dois criativos (as medidas nas linhas, A e B nas colunas), pelos números da última olhada. */
export function linhasDoTeste(t: Pick<Teste, 'result'>): LinhaDaTabela[] {
  const arms = t.result?.arms;
  if (!arms) return [];
  const de = (l: Letra) => arms.find((x) => x.letter === l)!;
  const celula = (texto: string, sub: string | null = null, forte = false) => ({ texto, sub, forte });
  const linha = (rotulo: string, sub: string | null, valor: (n: NumerosDoCriativo) => ReturnType<typeof celula>): LinhaDaTabela => ({
    rotulo,
    sub,
    valores: { A: valor(de('A')), B: valor(de('B')) },
  });
  const semLeitura = celula('—', 'ainda sem a leitura da Meta');
  return [
    linha('Gasto', null, (n) => (n.spend_micros === null ? semLeitura : celula(reais(n.spend_micros)))),
    linha('Visitas ao cardápio', 'sinal, não prova', (n) =>
      n.link_clicks === null ? semLeitura : celula(String(n.link_clicks), n.spend_micros !== null && n.link_clicks > 0 ? `${reais(n.spend_micros / n.link_clicks)} por visita` : null),
    ),
    linha('Pedidos no caixa', 'pelo cupom e pelo link', (n) => celula(String(n.orders), null, true)),
    linha('Receita no caixa', null, (n) => celula(reais(n.revenue_micros))),
    linha('Custo por pedido', null, (n) => (n.spend_micros === null || n.orders === 0 ? celula('—') : celula(reais(n.spend_micros / n.orders)))),
  ];
}

/** O pedido para pausar o criativo que perdeu, em que pé está (D-RG-80). */
export type PausaDoPerdedor =
  | { tipo: 'pedir'; perdeu: Letra; venceu: Letra; dica: string }
  | { tipo: 'esperando'; perdeu: Letra; actionId: string; texto: string }
  | { tipo: 'feito'; perdeu: Letra; texto: string }
  | { tipo: 'nenhum' };

const EM_ABERTO: readonly ActionStatus[] = ['aguardando_aprovacao', 'aprovada', 'executando', 'sombra'];

/** O que a tela mostra sobre o criativo que perdeu: nada fora do teste terminado com vencedor e com a campanha no ar. */
export function pausaDoPerdedor(t: Pick<Teste, 'status' | 'active' | 'result' | 'loser_pause' | 'daily_budget_micros'>): PausaDoPerdedor {
  const w = t.status === 'terminado' && t.result?.verdict === 'venceu' ? t.result.winner : null;
  if (!w) return { tipo: 'nenhum' };
  const perdeu = outra(w);
  const p = t.loser_pause;
  if (p?.status === 'executada') return { tipo: 'feito', perdeu, texto: `O criativo ${perdeu} foi pausado. O criativo ${w} segue no ar com a verba dele, ${reais(t.daily_budget_micros / 2)} por dia.` };
  if (!t.active) return { tipo: 'nenhum' };
  if (p && EM_ABERTO.includes(p.status)) return { tipo: 'esperando', perdeu, actionId: p.action_id, texto: `O pedido para pausar o criativo ${perdeu} espera a decisão em Aprovações.` };
  const antes = p ? ` O pedido anterior não foi feito (${p.status === 'falhou' ? 'falhou' : p.status === 'expirada' ? 'expirou' : 'foi recusado ou cancelado'}).` : '';
  return {
    tipo: 'pedir',
    perdeu,
    venceu: w,
    dica: `O Liame não pausa sozinho: o pedido segue as regras da empresa, como toda mudança de campanha. O criativo ${w} segue com a verba dele, ${reais(t.daily_budget_micros / 2)} por dia; para mudar a verba, peça em Resultados.${antes}`,
  };
}

/**
 * O que acontece ao encerrar, para a dica do botão (D-RG-80 e D-RG-95): antes da hora, com a campanha de teste no ar, ela
 * é pausada; depois do fim, nada muda na Meta.
 */
export function dicaDoEncerrar(t: Pick<Teste, 'status' | 'active'>): string {
  if (t.status === 'terminado') {
    return t.active
      ? 'O teste já acabou: encerrar não mexe na Meta. A campanha de teste continua no ar e gastando com os dois criativos, como está; o que o teste mostrou fica guardado e o aviso da Atenção sai. Para pausar ou mudar a verba, peça em Resultados.'
      : 'O teste já acabou e a campanha de teste está pausada: encerrar não mexe na Meta.';
  }
  return t.active
    ? 'O Liame para de medir e pausa a campanha de teste: os dois criativos param de gastar. Não precisa do código.'
    : 'O Liame para de medir e o teste fica encerrado. A campanha de teste continua pausada, como está.';
}

/** Os rótulos do botão de encerrar e da confirmação: depois do fim, "sem mudar nada". */
export function rotulosDoEncerrar(t: Pick<Teste, 'status'>): { botao: string; confirmar: string } {
  return t.status === 'terminado' ? { botao: 'Encerrar o teste sem mudar nada', confirmar: 'Encerrar sem mudar nada' } : { botao: 'Encerrar o teste', confirmar: 'Encerrar o teste agora' };
}

/** Dá para encerrar o teste agora? (Antes de existir na Meta, o pedido se recusa em Aprovações.) */
export const podeEncerrar = (t: Pick<Teste, 'status' | 'active'>): boolean => t.status === 'pronto' || t.status === 'rodando' || ((t.status === 'terminado' || t.status === 'interrompido') && t.active);

/** A linha da situação depois da aprovação: o que já aconteceu e o que vem. */
export function andamentoDoTeste(t: Pick<Teste, 'status' | 'active' | 'started_on' | 'max_days' | 'error' | 'reason' | 'pending_action_id'>, hoje: string): string | null {
  switch (t.status) {
    case 'criando':
      return 'O Liame cria a campanha de teste pausada na Meta, com os dois conjuntos e os dois anúncios, e pede os dois cupons ao Regem. O teste começa quando a campanha for ativada.';
    case 'pronto':
      return t.pending_action_id
        ? 'Tudo criado e pausado. O pedido de ativar espera a decisão, com o código do app.'
        : 'Tudo criado e pausado: a campanha de teste, os dois conjuntos, os dois anúncios e os dois cupons. O teste começa quando a campanha for ativada; ativar é outro pedido, com o código do app.';
    case 'rodando': {
      const dia = diaDoTeste(t, hoje);
      if (!t.started_on) return 'A campanha de teste foi ativada. O teste conta do primeiro dia inteiro com os dois criativos no ar.';
      return dia === null
        ? `A campanha de teste foi ativada. O dia 1 do teste é ${diaMes(t.started_on)}, o primeiro dia inteiro com os dois criativos no ar.`
        : `Os dois criativos estão no ar desde ${diaMes(t.started_on)}. Hoje é o dia ${dia} de no máximo ${t.max_days}; o teste segue sozinho, e a Atenção avisa quando ele acabar.`;
    }
    case 'terminado':
      return t.active
        ? 'O teste acabou, e a campanha de teste continua no ar e gastando com os dois criativos: o Liame avisa e não muda nada sozinho.'
        : 'O teste acabou, e a campanha de teste está pausada.';
    case 'encerrado':
      return t.active
        ? 'O teste foi encerrado sem mudar nada na Meta: a campanha de teste segue no ar e gastando com os dois criativos, como uma campanha qualquer (para pausar ou mudar a verba, peça em Resultados). O que o teste mostrou fica guardado.'
        : 'O teste foi encerrado: o Liame parou de medir, e a campanha de teste está pausada. Os dois criativos continuam aprovados em Criativos, e os números até aqui ficam guardados.';
    case 'interrompido':
      return `${t.reason ?? 'O Liame parou de medir este teste.'} ${t.active ? 'A campanha de teste continua no ar na Meta, e o Liame não mexe nela sozinho: para parar o gasto, encerre o teste.' : 'A campanha de teste ficou pausada.'}`;
    case 'cancelado':
      return t.error ? `A campanha de teste não foi criada: ${t.error}` : 'O pedido foi recusado ou expirou: nada foi criado na Meta.';
    default:
      return null;
  }
}
