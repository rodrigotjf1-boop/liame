import { comDe, comEm } from '../registro/leituras.visoes.js';
import { trechosDe } from '../verificador-numeros.js';
import { type ContextoComAviso, type ContextoDaExplicacao, nomesDoContexto } from './contexto.js';
import type { Explicacao } from './resposta.js';

// De onde vem cada número da explicação (A3, I4; protótipo P4: "De onde vêm os números"). Quem diz é o
// código, olhando o contexto que ele mesmo montou: a IA não escreve fonte nenhuma. O mesmo vale para o
// resumo do sistema. O número é procurado pelo valor E pelo que ele mede (dinheiro, porcentagem, dias,
// data, número com casas, contagem): "7 dias" não ganha a fonte de "7 pedidos", nem "7 pedidos" a de um
// ROAS de 7,00. A frase que cita uma campanha fala dela; a que não cita, não fala de campanha nenhuma. O
// número que está no texto do aviso é do aviso: não ganha a fonte de um parâmetro geral que só tem o mesmo
// valor (o "7 dias" do aviso não é a janela de 7 dias do modelo de atribuição). Quando o mesmo valor ainda
// está em mais de um lugar, a lista leva os lugares, do mais específico para o mais geral, sem adivinhar
// qual deles a frase quis dizer. Cada fato entra uma vez só: o "agora" da comparação é o total do período.

/** Um trecho do texto: comum, ou um número com a posição dele na lista de fontes. */
export interface TrechoMarcado {
  texto: string;
  numero: number | null;
}

export interface NumeroComFonte {
  /** Como aparece no texto: "R$ 3.605,00", "17,5%", "22/09/2026". */
  valor: string;
  fontes: string[];
}

export interface ExplicacaoMarcada {
  o_que_aconteceu: TrechoMarcado[];
  motivos: TrechoMarcado[][];
  risco: Explicacao['risco'];
  risco_motivo: TrechoMarcado[];
  o_que_fazer: TrechoMarcado[][];
  numeros: NumeroComFonte[];
}

/** Quantas fontes um número mostra, no máximo (o resto seria ruído). */
const FONTES_POR_NUMERO = 3;
const SEM_LUGAR = 'Liame · dado do período desta tela';

/**
 * O que o número mede, pelo que está escrito em volta dele. `decimal` é o número com casas ("2,60": ROAS,
 * conversões fracionárias); `numero`, a contagem ("38").
 */
export type Medida = 'dinheiro' | 'porcento' | 'dias' | 'data' | 'decimal' | 'numero';

export interface Valor {
  /** A forma em que o número é comparado (a do verificador de números). */
  forma: string;
  medida: Medida;
  /** Onde o valor começa e termina no texto, com o "R$" de antes e o "%" de depois. */
  inicio: number;
  fim: number;
}

const LETRA = /\p{L}/u;
const DIGITO = /\d/;
/** "R$" antes do número, com o espaço comum ou o que não quebra. */
const MOEDA = /R\$\s$/;
const DIAS = /^\sdias?(?!\p{L})/u;

/**
 * Os valores de um texto, na ordem da leitura. Ficam de fora o número colado numa letra, que é parte de um
 * código ou de uma palavra ("SMASH10", "2x1"), e a hora solta ("06:12"). A Conversa (I10) usa o mesmo.
 */
export function valoresDe(texto: string): Valor[] {
  const valores: Valor[] = [];
  let fim = 0;
  for (const t of trechosDe(texto)) {
    const inicio = fim;
    fim += t.texto.length;
    if (t.forma === null) continue;
    if (LETRA.test(texto[inicio - 1] ?? '') || LETRA.test(texto[fim] ?? '')) continue;
    // A hora solta ("lidos hoje, às 06:12") não é um valor: fica como texto.
    if ((texto[fim] === ':' && DIGITO.test(texto[fim + 1] ?? '')) || (texto[inicio - 1] === ':' && DIGITO.test(texto[inicio - 2] ?? ''))) continue;
    const moeda = MOEDA.test(texto.slice(Math.max(0, inicio - 3), inicio));
    const porcento = texto[fim] === '%';
    const medida: Medida = t.forma.startsWith('data:')
      ? 'data'
      : moeda
        ? 'dinheiro'
        : porcento
          ? 'porcento'
          : DIAS.test(texto.slice(fim, fim + 6))
            ? 'dias'
            : t.texto.includes(',')
              ? 'decimal'
              : 'numero';
    valores.push({ forma: t.forma, medida, inicio: moeda ? inicio - 3 : inicio, fim: porcento ? fim + 1 : fim });
  }
  return valores;
}

/** A ordem das fontes de um mesmo número: da mais específica para a mais geral. */
const ORDEM = { aviso: 0, campanha: 1, plataforma: 2, total: 3, comparacao: 4, geral: 5 } as const;

/** Um lugar do contexto em que o número está. */
interface Lugar {
  descricao: string;
  ordem: number;
  /** A campanha, quando o número é de uma: é o que decide se ele serve para a frase. */
  campanha?: string;
}

type Confirmado = ContextoDaExplicacao['resultado']['totais']['com_origem_provada'];
type Informado = ContextoDaExplicacao['resultado']['plataformas'][number]['plataforma_informa'];

/** ", na janela de 7 dias depois do clique" / ", na janela de cada conversão (padrão da plataforma)". */
const naJanela = (janela: string | undefined): string => (!janela ? '' : janela.startsWith('a janela ') ? `, na ${janela.slice(2)}` : `, na janela de ${janela}`);

/** Cada número do contexto (chave `medida|forma`) com os lugares em que ele está, do mais específico para o mais geral. */
function lugaresDoContexto(c: ContextoComAviso): Map<string, Lugar[]> {
  const lugares = new Map<string, Lugar[]>();
  const guardar = (chave: string, lugar: Lugar) => {
    const lista = lugares.get(chave) ?? [];
    const igual = lista.find((l) => l.descricao === lugar.descricao);
    if (igual) igual.ordem = Math.min(igual.ordem, lugar.ordem);
    else lista.push({ ...lugar });
    lugares.set(chave, lista);
  };
  const por = (valor: string | number | null | undefined, descricao: string, ordem: number, extra: { medida?: Medida; campanha?: string } = {}) => {
    if (valor === null || valor === undefined) return;
    const lugar: Lugar = { descricao, ordem, ...(extra.campanha ? { campanha: extra.campanha } : {}) };
    for (const v of valoresDe(String(valor))) {
      guardar(`${extra.medida ?? v.medida}|${v.forma}`, lugar);
      // A data com a hora também responde pela data sozinha.
      if (v.medida === 'data' && v.forma.length > 15) guardar(`data|${v.forma.slice(0, 15)}`, lugar);
    }
  };

  const r = c.resultado;
  const periodo = r.periodo.de && r.periodo.ate ? ` · ${r.periodo.de} a ${r.periodo.ate}` : '';
  /** "· lido em 02/10/2026 14:05" quando a plataforma tem uma fonte só (com várias contas, cada uma tem a sua hora). */
  const lido = (plataforma: string) => {
    const fontes = r.fontes.filter((f) => f.plataforma === plataforma && f.ultima_leitura);
    return fontes.length === 1 ? ` · lido em ${fontes[0]!.ultima_leitura}` : '';
  };
  const doCaixa = (oque: string) => `Regem · ${oque}${periodo}${lido('Regem')}`;
  const naFonte = (nome: string, oque: string) => `${nome} · ${oque}${periodo}${lido(nome)}`;
  const doLiame = (oque: string) => `Liame · ${oque} · calculado pelo sistema`;
  const anuncios = r.plataformas.map((p) => p.plataforma).filter((n): n is string => !!n);
  const asPlataformas = anuncios.length ? anuncios.join(' e ') : 'Plataformas de anúncio';

  const confirmado = (x: Confirmado, de: string, ordem: number, campanha?: string) => {
    const extra = campanha ? { campanha } : {};
    por(x.pedidos, doCaixa(`pedidos confirmados ${de}`), ordem, extra);
    por(x.receita, doCaixa(`receita confirmada ${de}`), ordem, extra);
    por(x.roas, doLiame(`ROAS confirmado no caixa ${de} (receita confirmada ÷ investimento)`), ordem, extra);
    por(x.custo_por_pedido, doLiame(`custo por pedido confirmado ${de} (investimento ÷ pedidos)`), ordem, extra);
    por(x.margem_conhecida, doCaixa(`margem conhecida ${de} (preço menos custo cadastrado)`), ordem, extra);
    por(x.parte_da_receita_com_margem_conhecida, doCaixa(`parte da receita ${de} com custo cadastrado`), ordem, extra);
  };
  const informado = (x: Informado, nome: string, de: string, ordem: number, campanha?: string) => {
    const extra = campanha ? { campanha } : {};
    const janela = naJanela(x.janela);
    por(x.investimento, naFonte(nome, `investimento ${de}`), ordem, extra);
    por(x.valor_de_venda, naFonte(nome, `valor de venda que a plataforma informa ${de}${janela}`), ordem, extra);
    por(x.roas, naFonte(nome, `ROAS que a plataforma informa ${de}${janela}`), ordem, extra);
    por(x.conversoes, naFonte(nome, `conversões que a plataforma informa ${de}${janela}`), ordem, extra);
    por(x.conversas, naFonte(nome, `conversas iniciadas ${de}`), ordem, extra);
    por(x.custo_por_conversa, naFonte(nome, `custo por conversa ${de}`), ordem, extra);
    por(x.janela, `${nome} · janela de atribuição da plataforma`, ORDEM.geral);
  };

  // O aviso que está sendo explicado: o número está no próprio texto do aviso. De quando são os resultados
  // que o acompanham é um parâmetro geral, como o período e a janela do modelo.
  if (c.aviso) {
    for (const texto of [c.aviso.titulo, c.aviso.detalhe, c.aviso.o_que_fazer]) por(texto, 'Aviso da Atenção · o número está no texto do aviso', ORDEM.aviso);
    por(c.aviso.resultados_de, `Liame · os resultados que acompanham o aviso são dos ${c.aviso.resultados_de}`, ORDEM.geral);
  }

  // Período e modelo.
  por(r.periodo.de, 'Período desta explicação', ORDEM.geral);
  por(r.periodo.ate, 'Período desta explicação', ORDEM.geral);
  por(r.atribuicao.janela_em_dias, 'Liame · janela do modelo de atribuição, em dias', ORDEM.geral, { medida: 'dias' });

  // Totais.
  const t = r.totais;
  por(t.investimento, `${asPlataformas} · investimento em anúncios${periodo}`, ORDEM.total);
  confirmado(t.com_origem_provada, 'com origem provada em campanha', ORDEM.total);
  por(t.pedidos_confirmados, doCaixa('todos os pedidos confirmados no caixa'), ORDEM.total);
  por(t.receita_confirmada, doCaixa('receita de todos os pedidos confirmados no caixa'), ORDEM.total);
  por(t.sem_origem.pedidos, doCaixa('pedidos do cardápio e do WhatsApp sem origem provada'), ORDEM.total);
  por(t.sem_origem.receita, doCaixa('receita dos pedidos sem origem provada'), ORDEM.total);
  por(t.sem_origem.parte_dos_pedidos_com_clique, doLiame('parte dos pedidos dos canais com clique que ficou sem origem'), ORDEM.total);
  for (const canal of t.canais_sem_clique) {
    por(canal.pedidos, doCaixa(`pedidos do canal ${canal.canal} (sem clique)`), ORDEM.total);
    por(canal.receita, doCaixa(`receita do canal ${canal.canal} (sem clique)`), ORDEM.total);
  }
  por(t.cancelados_depois.pedidos, doCaixa('pedidos cancelados depois de confirmados'), ORDEM.total);
  por(t.cancelados_depois.receita, doCaixa('receita dos pedidos cancelados depois'), ORDEM.total);

  // Por plataforma e por campanha.
  for (const p of r.plataformas) {
    const nome = p.plataforma ?? 'plataforma';
    informado(p.plataforma_informa, nome, comDe(nome), ORDEM.plataforma);
    confirmado(p.caixa_confirma, `com origem ${comEm(nome)}`, ORDEM.plataforma);
    por(p.pedidos_provados_so_na_plataforma, doCaixa(`pedidos provados só na plataforma (${nome}), sem campanha`), ORDEM.plataforma);
  }
  for (const k of r.campanhas) {
    const nome = k.plataforma ?? 'plataforma';
    informado(k.plataforma_informa, nome, `da campanha "${k.campanha}"`, ORDEM.campanha, k.campanha);
    confirmado(k.caixa_confirma, `da campanha "${k.campanha}"`, ORDEM.campanha, k.campanha);
  }
  por(r.campanhas_fora_da_lista, doLiame('campanhas com investimento que ficaram fora desta lista'), ORDEM.geral);

  // Leitura de cada fonte.
  for (const f of r.fontes) por(f.ultima_leitura, `${f.plataforma ?? 'Fonte'} · última leitura da conta "${f.conta ?? ''}"`, ORDEM.geral);

  // Comparação com o período anterior.
  if (c.comparacao) {
    const a = c.comparacao.periodo_anterior;
    const antes = a.de && a.ate ? `${a.de} a ${a.ate}` : 'período anterior';
    por(a.de, 'Período anterior, usado na comparação', ORDEM.geral);
    por(a.ate, 'Período anterior, usado na comparação', ORDEM.geral);
    // O "agora" de cada comparação é o próprio total do período, que já tem o lugar dele (acima, com a
    // origem e a hora da leitura): repetir aqui daria duas linhas para o mesmo fato.
    const comparado = (x: { antes: string | null; variacao: string | null }, origem: string, oque: string) => {
      por(x.antes, `${origem} · ${oque} no período anterior · ${antes}`, ORDEM.comparacao);
      por(x.variacao, doLiame(`variação de ${oque} sobre o período anterior (${antes})`), ORDEM.comparacao);
    };
    comparado(c.comparacao.investimento, asPlataformas, 'investimento em anúncios');
    comparado(c.comparacao.pedidos_confirmados, 'Regem', 'todos os pedidos confirmados');
    comparado(c.comparacao.receita_confirmada, 'Regem', 'receita de todos os pedidos');
    comparado(c.comparacao.pedidos_com_origem, 'Regem', 'pedidos com origem provada');
    comparado(c.comparacao.receita_com_origem, 'Regem', 'receita com origem provada');
    comparado(c.comparacao.roas_confirmado, 'Liame', 'ROAS confirmado no caixa');
  }

  // A ordenação é estável: na mesma ordem, vale a de chegada.
  for (const lista of lugares.values()) lista.sort((x, y) => x.ordem - y.ordem);
  return lugares;
}

/**
 * Cada número do contexto com a descrição de onde ele está. A chave é `medida|forma` ("dinheiro|960",
 * "porcento|22.4", "decimal|2.6", "data|data:25/09/2026"); as descrições vêm da mais específica para a mais
 * geral, sem olhar para a frase em que o número aparece (isso é do `marcarNumeros`).
 */
export function indiceDasFontes(c: ContextoComAviso): Map<string, string[]> {
  return new Map([...lugaresDoContexto(c)].map(([chave, lista]) => [chave, lista.map((l) => l.descricao)]));
}

/**
 * Os pedaços do texto ocupados por um nome que veio dos dados da empresa (campanha, conta). Número dentro
 * de nome é nome ("Combo 3", "Black Friday 2026"): não é valor, e não ganha fonte.
 */
function faixasDosNomes(texto: string, nomes: string[]): Array<[number, number]> {
  const faixas: Array<[number, number]> = [];
  for (const nome of nomes) {
    if (!/\d/.test(nome)) continue;
    for (let de = texto.indexOf(nome); de >= 0; de = texto.indexOf(nome, de + nome.length)) faixas.push([de, de + nome.length]);
  }
  return faixas;
}

/**
 * A explicação com cada número marcado e a lista "De onde vêm os números", na ordem de leitura. O mesmo
 * valor, com as mesmas fontes, escrito duas vezes aponta para a mesma linha da lista. Fica como texto comum
 * o número que é parte de um nome da empresa ou que está colado numa letra (código de cupom "SMASH10",
 * "2x1"): a conferência dos números continua valendo para ele, só não vira um valor com fonte na tela.
 */
export function marcarNumeros(e: Explicacao, contexto: ContextoComAviso): ExplicacaoMarcada {
  const lugares = lugaresDoContexto(contexto);
  // Sem lugar com a mesma medida (a frase escreveu "960 reais", sem o "R$"), vale o valor em qualquer medida.
  const emQualquerMedida = new Map<string, Lugar[]>();
  for (const [chave, lista] of lugares) {
    const forma = chave.slice(chave.indexOf('|') + 1);
    const juntos = emQualquerMedida.get(forma) ?? [];
    for (const l of lista) if (!juntos.some((j) => j.descricao === l.descricao)) juntos.push(l);
    emQualquerMedida.set(forma, juntos);
  }
  const nomes = nomesDoContexto(contexto);
  const campanhas = [...new Set([...contexto.resultado.campanhas.map((k) => k.campanha), contexto.aviso?.campanha].filter((n): n is string => !!n))];
  const numeros: NumeroComFonte[] = [];
  const posicao = new Map<string, number>();

  const marcar = (texto: string): TrechoMarcado[] => {
    const saida: TrechoMarcado[] = [];
    const faixas = faixasDosNomes(texto, nomes);
    const citadas = campanhas.filter((nome) => texto.includes(nome));
    /**
     * As fontes de um número nesta frase. Com o número entre os da campanha que a frase cita, são as dela
     * (a frase fala da campanha). Senão, as que não são de campanha nenhuma (o total, a plataforma, a
     * comparação, o aviso). Só na falta das duas valem os lugares de outras campanhas. E o número que está
     * no texto do aviso não leva o parâmetro geral de mesmo valor (período, janela do modelo, hora da
     * leitura): aí é coincidência, não fonte.
     */
    const fontesDe = (todos: Lugar[] | undefined): string[] => {
      if (!todos?.length) return [SEM_LUGAR];
      const daCampanhaCitada = todos.filter((l) => l.campanha !== undefined && citadas.includes(l.campanha));
      const semCampanha = todos.filter((l) => l.campanha === undefined);
      const doAviso = semCampanha.some((l) => l.ordem === ORDEM.aviso);
      const foraDeCampanha = doAviso ? semCampanha.filter((l) => l.ordem !== ORDEM.geral) : semCampanha;
      const daFrase = daCampanhaCitada.length ? daCampanhaCitada : foraDeCampanha.length ? foraDeCampanha : todos;
      return daFrase.slice(0, FONTES_POR_NUMERO).map((l) => l.descricao);
    };
    let fim = 0;
    for (const v of valoresDe(texto)) {
      if (faixas.some(([de, ate]) => v.inicio >= de && v.fim <= ate)) continue;
      if (v.inicio > fim) saida.push({ texto: texto.slice(fim, v.inicio), numero: null });
      const valor = texto.slice(v.inicio, v.fim);
      const fontes = fontesDe(lugares.get(`${v.medida}|${v.forma}`) ?? emQualquerMedida.get(v.forma));
      // Uma linha por valor, medida e fontes: "R$ 960,00" escrito duas vezes (ou com outro espaço) é a mesma
      // linha; o mesmo "7" de duas campanhas diferentes são duas.
      const chave = `${v.medida}|${v.forma}|${fontes.join('|')}`;
      let n = posicao.get(chave);
      if (n === undefined) {
        n = numeros.length;
        posicao.set(chave, n);
        numeros.push({ valor, fontes });
      }
      saida.push({ texto: valor, numero: n });
      fim = v.fim;
    }
    if (fim < texto.length) saida.push({ texto: texto.slice(fim), numero: null });
    return saida;
  };

  // A ordem das chamadas é a ordem da leitura: é ela que numera a lista.
  const o_que_aconteceu = marcar(e.o_que_aconteceu);
  const motivos = e.motivos.map(marcar);
  const risco_motivo = marcar(e.risco_motivo);
  const o_que_fazer = e.o_que_fazer.map(marcar);
  return { o_que_aconteceu, motivos, risco: e.risco, risco_motivo, o_que_fazer, numeros };
}
