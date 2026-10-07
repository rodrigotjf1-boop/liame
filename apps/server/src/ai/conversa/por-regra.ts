import { normalizar } from '../../policy/texto.js';
import { dinheiro } from '../registro/formatos.js';
import type { RespostaDaLia } from './resposta.js';

// O que a Conversa responde sem IA (decisão do dono, 07/10/2026): quando o pedido é de um tipo que o sistema conhece e
// a resposta está inteira nos dados que o Liame já leu, ela é montada por código, com as mesmas leituras que a LIA
// faria e a fonte de cada número. A IA fica para o que o sistema não reconhece ou não tem como resumir.
//
// O reconhecimento é de vocabulário fechado: o pedido só é conhecido quando TODAS as palavras dele estão na lista do
// tipo. Uma palavra de fora (o nome de uma campanha, "pausar", "mês", "vale", "analise") manda o pedido para a IA.
// Errar para o lado da IA custa uma chamada; errar para o lado da regra daria uma resposta que não é a da pergunta.
// Funções puras: a conversa (`conversa/conversa.service.ts`) só as chama.

/** `semana` (o dinheiro do marketing na semana), `campanhas` (cada campanha) e `avisos` (o que pede alguém agora). */
export type PedidoPorRegra = 'semana' | 'campanhas' | 'avisos';

/** A leitura que responde cada pedido: a mesma ferramenta que a LIA usaria, com a permissão de quem pergunta. */
export const LEITURA_DO_PEDIDO: Record<PedidoPorRegra, 'resultados_ciclo_fechado' | 'atencao_avisos'> = {
  semana: 'resultados_ciclo_fechado',
  campanhas: 'resultados_ciclo_fechado',
  avisos: 'atencao_avisos',
};

/** Pedido mais comprido que isto não é uma pergunta direta: vai para a IA. */
const PALAVRAS_MAXIMO = 16;

const palavras = (lista: string): Set<string> => new Set(lista.split(/\s+/).filter(Boolean));

/** O que pode estar em qualquer pedido conhecido: cumprimento, jeito de pedir, artigos e "a semana" (os 7 dias). */
const COMUNS = palavras(`
  lia liame por favor pf pfv me diz diga fala fale conta conte mostra mostre manda mande ver quero queria gostaria saber sabe pode poderia consegue informa passa
  a o as os um uma da do das dos de na no nas nos em e que qual quais como quanto quanta quantos quantas
  foi foram esta estao ta tao anda andam vai vao ficou ficaram deu deram dao teve tive tivemos temos tem houve fez fizemos sao eh
  minha meu meus minhas nossa nosso nossos nossas esse essa esses essas este estes estas isso
  semana ultimos ultimas 7 sete dias loja empresa marca negocio entao agora`);

/** Do que fala o pedido da semana (precisa de ao menos uma) e o que mais pode vir junto. */
const DA_SEMANA = palavras(`
  semana marketing resultado resultados numeros desempenho balanco resumo anuncios anuncio trafego midia
  vendas venda vendi vendemos vendeu venderam faturei faturamos faturamento faturou receita
  gastei gastamos gasto gastos gastou investi investimos investimento investido
  sobrou sobraram sobra lucro lucrei lucramos prejuizo retorno roas voltou pedidos pedido pagou pagaram empatou`);
const JUNTO_DA_SEMANA = palavras('com pelos pelas trouxe trouxeram vieram veio se nao pouco muito tanto porque pq geral total tudo estamos fomos indo eu dinheiro reais valor');

const DAS_CAMPANHAS = palavras('campanha campanhas');
const JUNTO_DAS_CAMPANHAS = palavras('melhor pior melhores piores mais menos vende vendem cada lista listar ativa ativas rodando tenho');

const DOS_AVISOS = palavras('aviso avisos alerta alertas problema problemas errado errada pendencia pendencias urgente urgentes precisa faco fazer');
const JUNTO_DOS_AVISOS = palavras('eu mim algum alguma alguns algumas algo coisa ha existe primeiro antes hoje atencao resolver olhar cuidar');

const CUMPRIMENTOS = [['bom', 'dia'], ['boa', 'tarde'], ['boa', 'noite'], ['e', 'ai'], ['oi'], ['ola'], ['opa']];

/** As palavras do pedido, sem acento, sem pontuação e sem o cumprimento do começo. */
function palavrasDoPedido(texto: string): string[] {
  let p = normalizar(texto).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const cumprimento = CUMPRIMENTOS.find((c) => c.every((x, i) => p[i] === x));
  if (cumprimento) p = p.slice(cumprimento.length);
  if (p[0] === 'lia') p = p.slice(1);
  return p;
}

/**
 * O tipo do pedido, quando o sistema o conhece; nulo manda o pedido para a IA. Conhecido é o pedido curto em que
 * todas as palavras são do tipo e ao menos uma diz do que ele fala. O que começa por "e" ("E a campanha?") continua
 * a conversa de antes e depende dela: vai para a IA.
 */
export function reconhecerPedido(texto: string): PedidoPorRegra | null {
  const p = palavrasDoPedido(texto);
  if (!p.length || p.length > PALAVRAS_MAXIMO || p[0] === 'e') return null;
  const todas = (...listas: Array<Set<string>>) => p.every((x) => listas.some((l) => l.has(x)));
  const alguma = (lista: Set<string>) => p.some((x) => lista.has(x));
  if (alguma(DAS_CAMPANHAS)) return todas(COMUNS, DAS_CAMPANHAS, JUNTO_DAS_CAMPANHAS, DA_SEMANA, JUNTO_DA_SEMANA) ? 'campanhas' : null;
  if (alguma(DOS_AVISOS)) return todas(COMUNS, DOS_AVISOS, JUNTO_DOS_AVISOS) ? 'avisos' : null;
  if (alguma(DA_SEMANA)) return todas(COMUNS, DA_SEMANA, JUNTO_DA_SEMANA) ? 'semana' : null;
  return null;
}

// ------------------------------------------------------------------ a resposta, a partir da leitura

/** A resposta montada e os números que o código calculou para ela (cada um com a fonte que a tela mostra). */
export interface RespostaPorRegra {
  resposta: RespostaDaLia;
  calculados: Array<{ rotulo: string; valor: string }>;
}

/** Campanhas e avisos listados numa resposta; o resto fica na tela de cada um. */
export const ITENS_POR_REGRA = { campanhas: 6, avisos: 5, lado: 3 } as const;
/** Tamanho de um item de aviso (o limite de um bloco da resposta é maior). */
const AVISO_MAXIMO = 600;
/** A cobertura mínima da margem para o Liame dizer se deu lucro (a mesma do veredito de Resultados). */
const COBERTURA_MINIMA = '80%';

type Registro = Record<string, unknown>;
const obj = (v: unknown): Registro => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Registro) : {});
const lst = (v: unknown): Registro[] => (Array.isArray(v) ? v.map(obj) : []);
const txt = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

const DINHEIRO = /^(-)?R\$ ([\d.]+),(\d{2})$/;
/** "R$ 1.298,71" → 129871 (centavos); o que não é dinheiro em reais, nulo. */
function centavos(v: unknown): bigint | null {
  const m = typeof v === 'string' ? DINHEIRO.exec(v) : null;
  if (!m) return null;
  const n = BigInt(`${m[2]!.replace(/\./g, '')}${m[3]!}`);
  return m[1] ? -n : n;
}
const reais = (c: bigint): string => dinheiro(((c < 0n ? -c : c) * 10_000n).toString())!;
/** "1.234" → 1234; o que não é contagem, zero. */
const contagem = (v: unknown): number => (typeof v === 'string' && /^[\d.]+$/.test(v) ? Number(v.replace(/\./g, '')) : 0);
const juntar = (itens: string[]): string => (itens.length <= 1 ? (itens[0] ?? '') : `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`);
const pedidosEscritos = (texto: string, n: number): string => `${texto} ${n === 1 ? 'pedido confirmado' : 'pedidos confirmados'}`;

function montador() {
  const blocos: RespostaDaLia['blocos'] = [];
  const calculados: RespostaPorRegra['calculados'] = [];
  return {
    p: (texto: string): void => {
      blocos.push({ tipo: 'paragrafo', texto, risco: null });
    },
    item: (texto: string): void => {
      blocos.push({ tipo: 'item', texto, risco: null });
    },
    /** Um número que o código calculou (não está na leitura): entra na resposta com a fonte dele. */
    calculado: (rotulo: string, valor: string) => {
      calculados.push({ rotulo, valor });
      return valor;
    },
    pronto: (): RespostaPorRegra => ({ resposta: { blocos, reuniao: null }, calculados }),
  };
}

/** O período da leitura, como ela o escreve; nulo se a leitura não o trouxe (aí a regra não responde). */
function periodoDe(v: Registro): { de: string; ate: string } | null {
  const periodo = obj(v.periodo);
  const [de, ate] = [txt(periodo.de), txt(periodo.ate)];
  return de && ate ? { de, ate } : null;
}

/** O dinheiro do marketing na semana: o que custou, o que voltou, se sobrou e as campanhas de cada lado. */
function daSemana(v: Registro): RespostaPorRegra | null {
  const periodo = periodoDe(v);
  const totais = obj(v.totais);
  const provada = obj(totais.com_origem_provada);
  const investimento = txt(totais.investimento);
  const gasto = centavos(investimento);
  if (!periodo || !investimento || gasto === null) return null;
  const { de, ate } = periodo;
  const m = montador();
  const pedidos = txt(provada.pedidos) ?? '0';
  const n = contagem(pedidos);
  const receita = txt(provada.receita);

  if (!n || !receita) {
    m.p(
      gasto === 0n
        ? `De ${de} a ${ate}, não houve gasto com anúncios nem pedido com prova de anúncio.`
        : `De ${de} a ${ate}, os anúncios custaram ${investimento}, e nenhum pedido confirmado no caixa veio com prova de anúncio.`,
    );
  } else if (gasto === 0n) {
    m.p(`De ${de} a ${ate}, não houve gasto com anúncios. Mesmo assim, ${pedidosEscritos(pedidos, n)} no caixa ${n === 1 ? 'veio' : 'vieram'} com prova de anúncio, somando ${receita}.`);
  } else {
    m.p(`De ${de} a ${ate}, os anúncios custaram ${investimento} e trouxeram ${receita} em ${pedidosEscritos(pedidos, n)} no caixa.`);
    const resultado = txt(provada.resultado);
    const margemEscrita = txt(provada.margem_conhecida);
    const margem = centavos(margemEscrita);
    const cobertura = txt(provada.parte_da_receita_com_margem_conhecida);
    if (resultado && margemEscrita && margem !== null) {
      const sobra = margem - gasto;
      const valor = m.calculado('Liame · margem conhecida − investimento · calculado pelo sistema', reais(sobra));
      if (resultado === 'lucro') m.p(`O marketing deu lucro: a margem conhecida desses pedidos foi de ${margemEscrita} e, depois de pagar os anúncios, sobraram ${valor}.`);
      else if (resultado === 'prejuízo') m.p(`O marketing não se pagou: a margem conhecida desses pedidos foi de ${margemEscrita}, e faltaram ${valor} para pagar os anúncios.`);
      else m.p(`O marketing se pagou, mas por pouco: a margem conhecida desses pedidos foi de ${margemEscrita} e, depois de pagar os anúncios, ${sobra < 0n ? 'faltaram' : 'sobraram'} ${valor}.`);
    } else if (cobertura) {
      const minima = m.calculado('Liame · parte mínima da receita com custo cadastrado para dizer se deu lucro', COBERTURA_MINIMA);
      m.p(`Ainda não dá para dizer se sobrou: só ${cobertura} da receita tem o custo dos produtos cadastrado no Regem, e o Liame só diz se deu lucro a partir de ${minima}.`);
    } else {
      m.p('Ainda não dá para dizer se sobrou: nenhuma dessas vendas tem o custo dos produtos cadastrado no Regem.');
    }
    // As campanhas de cada lado, as de maior gasto primeiro (a leitura já vem nessa ordem).
    const campanhas = lst(v.campanhas).map((c) => ({ nome: txt(c.campanha), resultado: txt(obj(c.caixa_confirma).resultado) }));
    const lado = (r: string) => campanhas.filter((c) => c.nome && c.resultado === r).slice(0, ITENS_POR_REGRA.lado).map((c) => c.nome!);
    const [lucro, empata, prejuizo] = [lado('lucro'), lado('empata'), lado('prejuízo')];
    if (lucro.length) m.item(`Dá lucro: ${juntar(lucro)}.`);
    if (empata.length) m.item(`Empata: ${juntar(empata)}.`);
    if (prejuizo.length) m.item(`Dá prejuízo: ${juntar(prejuizo)}.`);
  }

  const total = txt(totais.pedidos_confirmados);
  const semOrigem = txt(obj(totais.sem_origem).pedidos);
  const [nTotal, nSem] = [contagem(total), contagem(semOrigem)];
  if (total && nTotal > n) {
    const sem = semOrigem && nSem > 0 ? `; ${semOrigem} ${nSem === 1 ? 'deles, do cardápio ou do WhatsApp, veio' : 'deles, do cardápio e do WhatsApp, vieram'} sem prova de anúncio` : '';
    m.p(`Somando todos os canais, a loja teve ${pedidosEscritos(total, nTotal)} no período${sem}.`);
  }
  return m.pronto();
}

/** Cada campanha do período, da que mais gastou para a que menos gastou. */
function dasCampanhas(v: Registro): RespostaPorRegra | null {
  const periodo = periodoDe(v);
  if (!periodo) return null;
  const { de, ate } = periodo;
  const m = montador();
  const campanhas = lst(v.campanhas).filter((c) => txt(c.campanha));
  if (!campanhas.length) {
    m.p(`De ${de} a ${ate}, nenhuma campanha gastou nem teve pedido confirmado no caixa.`);
    return m.pronto();
  }
  m.p(`De ${de} a ${ate}, por campanha, da que mais gastou para a que menos gastou:`);
  for (const c of campanhas.slice(0, ITENS_POR_REGRA.campanhas)) {
    const nome = txt(c.campanha)!;
    const onde = txt(c.plataforma) ? ` (${txt(c.plataforma)})` : '';
    const investimento = txt(obj(c.plataforma_informa).investimento) ?? dinheiro('0')!;
    const caixa = obj(c.caixa_confirma);
    const pedidos = txt(caixa.pedidos) ?? '0';
    const n = contagem(pedidos);
    const receita = txt(caixa.receita);
    if (!n || !receita) {
      m.item(`${nome}${onde}: ${investimento} de anúncio, sem pedido confirmado no caixa.`);
      continue;
    }
    const resultado = txt(caixa.resultado);
    const estado = resultado === 'lucro' ? 'deu lucro' : resultado === 'prejuízo' ? 'deu prejuízo' : resultado === 'empata' ? 'empatou' : 'sem margem conhecida bastante para dizer se deu lucro';
    m.item(`${nome}${onde}: ${investimento} de anúncio e ${receita} em ${pedidosEscritos(pedidos, n)}; ${estado}.`);
  }
  const fora = campanhas.length - ITENS_POR_REGRA.campanhas + contagem(String(v.campanhas_fora_da_lista ?? ''));
  if (fora > 0) {
    const quantas = m.calculado('Liame · campanhas além das listadas · contadas pelo sistema', String(fora));
    m.p(fora === 1 ? 'Há mais uma campanha, com gasto menor; a lista inteira está em Resultados.' : `Há mais ${quantas} campanhas, com gasto menor; a lista inteira está em Resultados.`);
  }
  return m.pronto();
}

/** O que pede alguém agora: os avisos críticos e os de atenção, do mais grave para o menos grave. */
function dosAvisos(v: Registro): RespostaPorRegra | null {
  if (!Array.isArray(v.avisos)) return null;
  const m = montador();
  const avisos = lst(v.avisos).filter((a) => (a.gravidade === 'critica' || a.gravidade === 'atencao') && txt(a.titulo));
  if (!avisos.length) {
    m.p('Nada precisa de você agora: o sistema não tem aviso crítico nem de atenção para esta marca.');
    return m.pronto();
  }
  if (avisos.length === 1) m.p('Um aviso pede você agora:');
  else m.p(`${m.calculado('Liame · avisos críticos e de atenção · contados pelo sistema', String(avisos.length))} avisos pedem você agora, do mais grave para o menos grave:`);
  for (const a of avisos.slice(0, ITENS_POR_REGRA.avisos)) {
    const titulo = txt(a.titulo)!;
    const detalhe = txt(a.detalhe);
    const texto = `${a.gravidade === 'critica' ? 'Urgente' : 'Atenção'}: ${titulo}${/[.!?]$/.test(titulo) ? '' : '.'}${detalhe ? ` ${detalhe}` : ''}`;
    m.item(texto.length > AVISO_MAXIMO ? `${texto.slice(0, AVISO_MAXIMO - 1)}…` : texto);
  }
  if (avisos.length > ITENS_POR_REGRA.avisos) m.p('Os outros estão na Atenção.');
  return m.pronto();
}

/**
 * A resposta do pedido, montada com a leitura dele (a visão que a LIA também receberia). Nulo quando a leitura não
 * traz o que a resposta precisa: aí o pedido segue para a IA.
 */
export function respostaPorRegra(pedido: PedidoPorRegra, leitura: unknown): RespostaPorRegra | null {
  const v = obj(leitura);
  if (pedido === 'semana') return daSemana(v);
  if (pedido === 'campanhas') return dasCampanhas(v);
  return dosAvisos(v);
}
