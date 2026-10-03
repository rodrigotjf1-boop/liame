import type { ConversationBlock, ConversationMeeting, ExplanationNumber } from '@liame/contracts';
import { valoresDe } from '../explicar/fontes.js';
import type { RespostaDaLia } from './resposta.js';

// De onde vem cada número da resposta da LIA (protótipo P5: "De onde vêm os números"). Quem diz é o código,
// olhando o que a LIA leu nesta resposta: cada leitura é percorrida campo a campo, e cada número ganha o
// caminho em que está, em palavras ("Resultados de 22/09 a 28/09 · campanha "Combo sexta" · confirmado no
// caixa · receita"). Número que a pessoa escreveu é dela ("Você, nesta conversa"); o de uma resposta anterior
// da LIA leva a fonte que ela já tinha. O número é casado pelo valor, pelo que ele mede e pelo sujeito da frase
// (V58): a frase que cita uma campanha (ou conta, loja, cupom) fala dela; a que não cita fala do que não é de
// nenhuma; só na falta das duas valem os lugares das outras. Quando o mesmo valor ainda está em mais de um
// lugar, vão os lugares (até três), do mais próximo para o mais geral, sem adivinhar qual a frase quis dizer.

/** Um lugar de onde os números podem vir. */
export interface OrigemDosNumeros {
  /** "Resultados de 22/09 a 28/09", "Você, nesta conversa", "Minha marca". */
  rotulo: string;
  valor: unknown;
  /** Percorrer o valor e dizer o caminho de cada número (as leituras); sem isso, o rótulo basta. */
  comCaminho: boolean;
  /** Menor = mais perto da pergunta (as leituras desta resposta vêm antes do contexto geral). */
  ordem: number;
}

interface Lugar {
  descricao: string;
  ordem: number;
  /** Os nomes da empresa no caminho (a campanha, a conta, a loja, o cupom): é o que decide se o lugar serve para a frase. */
  nomes: string[];
}

const FONTES_POR_NUMERO = 3;
const SEM_LUGAR = 'Liame · dado lido nesta conversa';
const DESCRICAO_MAXIMA = 220;

/** Palavras para as chaves das leituras (o resto vira a chave sem o sublinhado). */
const PALAVRAS: Record<string, string> = {
  plataforma_informa: 'a plataforma informa',
  caixa_confirma: 'confirmado no caixa',
  com_origem_provada: 'com origem provada',
  sem_origem: 'sem origem',
  canais_sem_clique: 'canais sem clique',
  cancelados_depois: 'cancelados depois',
  pedidos_confirmados: 'pedidos confirmados',
  receita_confirmada: 'receita confirmada',
  roas: 'ROAS',
  custo_por_pedido: 'custo por pedido',
  margem_conhecida: 'margem conhecida',
  parte_da_receita_com_margem_conhecida: 'parte da receita com custo cadastrado',
  parte_dos_pedidos_com_clique: 'parte dos pedidos dos canais com clique',
  valor_de_venda: 'valor de venda',
  custo_por_conversa: 'custo por conversa',
  janela_em_dias: 'janela, em dias',
  ultima_leitura: 'última leitura',
  proxima_leitura: 'próxima leitura',
  usos_em_7_dias: 'usos em 7 dias',
  receita_em_7_dias: 'receita em 7 dias',
  gasto_em_7_dias: 'gasto em 7 dias',
  pedidos_em_7_dias: 'pedidos em 7 dias',
  pedido_minimo: 'pedido mínimo',
  desconto_maximo: 'desconto máximo',
  valido_ate: 'válido até',
  o_que_fazer: 'o que fazer',
};
const palavra = (chave: string): string => PALAVRAS[chave] ?? chave.replace(/_/g, ' ');

/** Como um item de lista aparece no caminho e o nome da empresa que ele carrega (nulo quando não há). */
function nomeDoItem(item: unknown): { rotulo: string; nome: string | null } | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const o = item as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const campanha = s(o.campanha);
  if (campanha) return { rotulo: `campanha "${campanha}"`, nome: campanha };
  const codigo = s(o.codigo);
  if (codigo) return { rotulo: `cupom ${codigo}`, nome: codigo };
  const loja = s(o.loja);
  if (loja) return { rotulo: `loja "${loja}"`, nome: loja };
  const conta = s(o.conta);
  if (conta) return { rotulo: `conta "${conta}"`, nome: conta };
  const nome = s(o.nome);
  if (nome) return { rotulo: `"${nome}"`, nome };
  // Aviso, canal e plataforma descrevem o lugar, mas não são nome da empresa.
  const titulo = s(o.titulo);
  if (titulo) return { rotulo: `aviso "${titulo}"`, nome: null };
  const canal = s(o.canal);
  if (canal) return { rotulo: `canal ${canal}`, nome: null };
  const plataforma = s(o.plataforma);
  if (plataforma) return { rotulo: plataforma, nome: null };
  return null;
}

const cortar = (t: string) => (t.length > DESCRICAO_MAXIMA ? `${t.slice(0, DESCRICAO_MAXIMA - 1)}…` : t);

/** Cada número das origens (chave `medida|forma`), com os lugares em que ele está, do mais próximo para o mais geral. */
export function indiceDasOrigens(origens: OrigemDosNumeros[]): Map<string, Lugar[]> {
  const lugares = new Map<string, Lugar[]>();
  const guardar = (chave: string, lugar: Lugar) => {
    const l = lugares.get(chave) ?? [];
    const igual = l.find((x) => x.descricao === lugar.descricao);
    if (igual) igual.ordem = Math.min(igual.ordem, lugar.ordem);
    else l.push({ ...lugar });
    lugares.set(chave, l);
  };
  const porTexto = (valor: string, lugar: Lugar) => {
    for (const v of valoresDe(valor)) {
      guardar(`${v.medida}|${v.forma}`, lugar);
      // A data com a hora também responde pela data sozinha.
      if (v.medida === 'data' && v.forma.length > 15) guardar(`data|${v.forma.slice(0, 15)}`, lugar);
    }
  };
  for (const o of origens) {
    const andar = (v: unknown, caminho: string[], nomes: string[]) => {
      if (typeof v === 'string' || typeof v === 'number') {
        const descricao = cortar(o.comCaminho && caminho.length ? `${o.rotulo} · ${caminho.join(' · ')}` : o.rotulo);
        porTexto(String(v), { descricao, ordem: o.ordem, nomes });
        return;
      }
      if (Array.isArray(v)) {
        v.forEach((item, i) => {
          const n = o.comCaminho ? nomeDoItem(item) : null;
          // Com nome, o item fala por si ("campanha "Combo sexta""); sem nome, fica a lista e a posição.
          const passo = n ? n.rotulo : caminho.length ? `${caminho[caminho.length - 1]} ${i + 1}` : null;
          const base = caminho.slice(0, -1);
          andar(item, passo ? [...base, passo] : caminho, n?.nome ? [...nomes, n.nome] : nomes);
        });
        return;
      }
      if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) andar(x, o.comCaminho ? [...caminho, palavra(k)] : caminho, nomes);
    };
    andar(o.valor, [], []);
  }
  for (const l of lugares.values()) l.sort((a, b) => a.ordem - b.ordem);
  return lugares;
}

/** Os pedaços do texto ocupados por um nome da empresa: número dentro de nome ("Combo 3") é nome, não valor. */
function faixasDosNomes(texto: string, nomes: string[]): Array<[number, number]> {
  const faixas: Array<[number, number]> = [];
  for (const nome of nomes) {
    if (!/\d/.test(nome)) continue;
    for (let de = texto.indexOf(nome); de >= 0; de = texto.indexOf(nome, de + nome.length)) faixas.push([de, de + nome.length]);
  }
  return faixas;
}

const TIPO: Record<string, string> = { paragrafo: 'paragrafo', item: 'item', risco: 'risco', fazer: 'fazer' };

/** Como a tela chama cada voz da reunião de decisão (protótipo P5) e o papel dela. */
export const VOZES: Record<string, { name: string; role: string }> = {
  analista: { name: 'Analista', role: 'os números' },
  estrategista: { name: 'Estrategista', role: 'o plano' },
  voz_contraria: { name: 'Voz contrária', role: 'discorda de propósito' },
};

/**
 * Os blocos da resposta (e a reunião de decisão, quando houver) com cada número marcado e a lista "De onde vêm
 * os números", na ordem da leitura. O mesmo valor com as mesmas fontes, escrito duas vezes, aponta para a mesma
 * linha. Número de nome da empresa ou colado numa letra ("SMASH10") fica como texto: a conferência vale para
 * ele, só não ganha fonte.
 */
export function marcarResposta(
  r: RespostaDaLia,
  lugares: Map<string, Lugar[]>,
  nomes: string[],
): { blocks: ConversationBlock[]; numbers: ExplanationNumber[]; meeting: ConversationMeeting | null } {
  // Sem lugar com a mesma medida ("960 reais", sem o "R$"), vale o valor em qualquer medida.
  const emQualquerMedida = new Map<string, Lugar[]>();
  for (const [chave, l] of lugares) {
    const forma = chave.slice(chave.indexOf('|') + 1);
    const juntos = emQualquerMedida.get(forma) ?? [];
    for (const x of l) if (!juntos.some((j) => j.descricao === x.descricao)) juntos.push(x);
    emQualquerMedida.set(forma, juntos.sort((a, b) => a.ordem - b.ordem));
  }
  const numbers: ExplanationNumber[] = [];
  const posicao = new Map<string, number>();
  const marcar = (texto: string): ConversationBlock['text'] => {
    const saida: ConversationBlock['text'] = [];
    const faixas = faixasDosNomes(texto, nomes);
    const citados = nomes.filter((n) => texto.includes(n));
    /** Os lugares que servem para esta frase: os do nome que ela cita; senão, os sem nome; só na falta, os outros. */
    const daFrase = (todos: Lugar[]): Lugar[] => {
      const doCitado = todos.filter((l) => l.nomes.some((n) => citados.includes(n)));
      if (doCitado.length) return doCitado;
      const semNome = todos.filter((l) => l.nomes.length === 0);
      return semNome.length ? semNome : todos;
    };
    let fim = 0;
    for (const v of valoresDe(texto)) {
      if (faixas.some(([de, ate]) => v.inicio >= de && v.fim <= ate)) continue;
      if (v.inicio > fim) saida.push({ text: texto.slice(fim, v.inicio), number: null });
      const valor = texto.slice(v.inicio, v.fim);
      const todos = lugares.get(`${v.medida}|${v.forma}`) ?? emQualquerMedida.get(v.forma);
      const sources = todos?.length ? daFrase(todos).slice(0, FONTES_POR_NUMERO).map((l) => l.descricao) : [SEM_LUGAR];
      const chave = `${v.medida}|${v.forma}|${sources.join('|')}`;
      let n = posicao.get(chave);
      if (n === undefined) {
        n = numbers.length;
        posicao.set(chave, n);
        numbers.push({ value: valor, sources });
      }
      saida.push({ text: valor, number: n });
      fim = v.fim;
    }
    if (fim < texto.length) saida.push({ text: texto.slice(fim), number: null });
    return saida;
  };
  // A ordem das chamadas é a da leitura (os blocos, depois a reunião): é ela que numera a lista.
  const blocks = r.blocos.map((b) => ({ kind: TIPO[b.tipo] ?? 'paragrafo', text: marcar(b.texto), risk: b.tipo === 'risco' ? b.risco : null }));
  const reuniao = r.reuniao;
  const meeting = reuniao
    ? {
        topic: marcar(reuniao.pauta),
        voices: reuniao.vozes.map((v) => ({ agent: v.quem, ...(VOZES[v.quem] ?? { name: v.quem, role: '' }), text: marcar(v.texto) })),
        recommendation: marcar(reuniao.recomendacao),
        risk: reuniao.risco,
        risk_reason: marcar(reuniao.risco_motivo),
      }
    : null;
  return { blocks, numbers, meeting };
}
