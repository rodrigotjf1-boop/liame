import { limparTexto } from '../ai/sanitizar.js';

// Regras de texto do Compliance (A3, I9; `ai-architecture.md` §1: "o código decide"). Todo texto gerado
// (explicação, relatório, plano) passa por aqui ANTES de aparecer; o revisor de IA, quando entrar, só
// opina sobre tom, clareza e alegações, e nunca aprova sozinho. As regras são conservadoras de propósito:
// o que elas barram cai no texto sem IA, que é sempre seguro. Base: `base-conhecimento.md` §6 (TSE: uso
// político e eleitoral proibido nos Termos; CDC arts. 36 a 38 e CONAR: promessa de resultado; políticas de
// anúncio da Meta e do Google: categorias que derrubam conta). Funções puras.

/** Muda junto com qualquer lista abaixo. */
export const REGRAS_DE_TEXTO_VERSAO = 1;

export type RegraDeTexto = 'politico_eleitoral' | 'promessa_de_resultado' | 'categoria_proibida' | 'dado_pessoal' | 'texto_longo';

export interface AchadoDeTexto {
  regra: RegraDeTexto;
  /** O trecho que casou, já sem acento e em minúsculas; para dado pessoal, nunca o dado em si. */
  trecho: string;
}

/** Texto maior que isto não é conferido palavra a palavra: é recusado (ERR-040: teto antes da regex). */
export const TEXTO_MAXIMO = 20_000;

// As regex abaixo rodam sobre o texto normalizado (minúsculas, sem acento, espaços simples). São de
// alternativas literais, sem repetição aninhada: tempo linear no tamanho do texto.

/** Cargo, eleição, pedido de voto e propaganda eleitoral. */
const POLITICO =
  /(?<![a-z0-9])(eleic(?:ao|oes)|eleitor(?:al|ais|es|a|as)?|candidaturas?|pre-?candidat[oa]s?|candidat[oa]s? (?:a|ao|para) (?:prefeit[oa]|vereadora?|deputad[oa]|senadora?|governadora?|presidente)|vot(?:e|em|ar|o) em|elejam?|propaganda eleitoral|campanha eleitoral|horario eleitoral|partidos? politicos?|coligac(?:ao|oes)|comicios?|santinhos?|urnas? eletronicas?|prefeit[oa]s?|vereador(?:a|es|as)?|deputad[oa]s?|senador(?:a|es|as)?|governador(?:a|es|as)?)(?![a-z0-9])/g;
/** Só para nome curto (campanha, conta): palavra solta já basta para não chamar a IA. */
const POLITICO_EM_NOME = /(?<![a-z0-9])(vot(?:e|em|ar|o|os)|candidat[oa]s?|eleit[oa]s?)(?![a-z0-9])/g;
/** Promessa de resultado: ninguém garante venda nem lucro (CDC art. 37; CONAR). */
const PROMESSA =
  /(?<![a-z0-9])((?:resultados?|retornos?|lucros?|sucesso) garantidos?|vendas garantidas|garantimos|eu garanto|garantia de (?:resultado|retorno|lucro|vendas)|lucro certo|retorno certo|vai (?:dobrar|triplicar)|sem risco nenhum|risco zero)(?![a-z0-9])/g;
/** Categorias que as plataformas de anúncio proíbem ou restringem a quem tem autorização própria. */
const PROIBIDA =
  /(?<![a-z0-9])(armas? de fogo|munic(?:ao|oes)|cigarros?(?: eletronicos?)?|tabaco|vapes?|narguiles?|maconha|cocaina|drogas? ilicitas?|jogo do bicho|cassinos?|casas? de apostas?|apostas? esportivas?|piramide financeira|enriquecimento rapido|dinheiro facil|medicamentos? controlados?)(?![a-z0-9])/g;

/** Minúsculas, sem acento e com espaços simples. */
export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function casar(regra: RegraDeTexto, formato: RegExp, texto: string, achados: Map<string, AchadoDeTexto>): void {
  for (const m of texto.matchAll(formato)) achados.set(`${regra}:${m[1]}`, { regra, trecho: m[1]! });
}

/**
 * O texto pode aparecer? Devolve o que cada regra achou (vazio = pode). `ignorar` são os nomes que vieram
 * dos dados da própria empresa (campanha, conta): citar o nome de uma campanha não é a IA falando de
 * política; para esses nomes existe `nomesPoliticos`, que decide se a IA é chamada.
 */
export function conferirTexto(textos: string | string[], opcoes: { ignorar?: string[] } = {}): AchadoDeTexto[] {
  const achados = new Map<string, AchadoDeTexto>();
  for (const original of Array.isArray(textos) ? textos : [textos]) {
    if (original.length > TEXTO_MAXIMO) {
      achados.set('texto_longo', { regra: 'texto_longo', trecho: 'texto longo demais para conferir' });
      continue;
    }
    // Dado pessoal: os mesmos padrões da limpeza antes do envio (e-mail, telefone, CPF, CNPJ, CEP).
    if (limparTexto(original).removidos > 0) achados.set('dado_pessoal', { regra: 'dado_pessoal', trecho: 'dado pessoal no texto' });
    let texto = normalizar(original);
    for (const nome of opcoes.ignorar ?? []) {
      const n = normalizar(nome).trim();
      if (n.length >= 3) texto = texto.split(n).join(' ');
    }
    casar('politico_eleitoral', POLITICO, texto, achados);
    casar('promessa_de_resultado', PROMESSA, texto, achados);
    casar('categoria_proibida', PROIBIDA, texto, achados);
  }
  return [...achados.values()];
}

/** Os nomes (de campanha, de conta) com conteúdo político ou eleitoral: com algum, a IA não é chamada. */
export function nomesPoliticos(nomes: Array<string | null | undefined>): string[] {
  return nomes.filter((nome): nome is string => {
    if (!nome) return false;
    const texto = normalizar(nome.slice(0, TEXTO_MAXIMO));
    return texto.search(POLITICO) >= 0 || texto.search(POLITICO_EM_NOME) >= 0;
  });
}
