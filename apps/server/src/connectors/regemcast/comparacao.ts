// A comparação das duas credenciais do RegemCast (Hub DMS, F2, etapa A3; decisões F2-3 e F2-7 do dono, 15/10/2026).
//
// A leitura de hoje vai com o `rct_it_` da conta; a nova, com o token do DMS ID do aplicativo do Liame e o segredo da
// ligação (`DMS-Ligacao`). As duas leem a MESMA conta, uma logo depois da outra, e o resultado tem de ser igual campo a
// campo. A via nova só passa a valer depois de 14 dias seguidos sem diferença, com cada uma das 10 ferramentas de
// leitura comparada 50 vezes ou mais (F2-7). Aqui fica só a regra pura; quem chama e grava é a rotina do worker.
//
// O que fica guardado de cada comparação é o caminho dos campos que diferem (`campanhas[2].enviadas`), nunca o valor: a
// lista das conversas abertas por anúncio traz telefone, e o caminho nunca traz.

/** As 10 ferramentas de leitura do RegemCast que o Liame usa (contrato v2 §3, §4, §8 e §9). Nenhuma muda nada lá. */
export const FERRAMENTAS_COMPARADAS = [
  'integracao_situacao',
  'conversas_anuncio_listar',
  'conta_situacao',
  'campanhas_listar',
  'campanha_detalhar',
  'publicos_listar',
  'modelos_listar',
  'orcamento_ler',
  'publico_estimar',
  'campanha_disparo_planejar',
] as const;
export type FerramentaComparada = (typeof FERRAMENTAS_COMPARADAS)[number];

/**
 * As permissões que o token do DMS ID pede para as 10 leituras. O plano do disparo pede `campanhas.disparar` e não
 * muda nada; nenhuma ferramenta de escrita é chamada pela comparação.
 */
export const PERMISSOES_DA_COMPARACAO = ['conta.ler', 'campanhas.ler', 'publicos.ler', 'modelos.ler', 'orcamento.ler', 'conversas.anuncio.ler', 'campanhas.disparar'] as const;

/** Até quantos caminhos diferentes ficam guardados por comparação. */
export const MAX_CAMINHOS = 20;

/** Como terminou a comparação de uma ferramenta. */
export type DesfechoDaComparacao = 'igual' | 'diferente' | 'sem_dado' | 'atual_falhou' | 'nova_falhou';

/**
 * O que depende da credencial, e não da conta, sai antes de comparar: só a lista de permissões da
 * `integracao_situacao` (pela via nova, vêm as que o token do DMS ID E a ligação têm; pela de hoje, as do `rct_it_`).
 */
export function normalizar(ferramenta: FerramentaComparada, dado: unknown): unknown {
  if (ferramenta === 'integracao_situacao' && dado !== null && typeof dado === 'object' && !Array.isArray(dado)) {
    const { permissoes: _permissoes, ...resto } = dado as Record<string, unknown>;
    return resto;
  }
  return dado;
}

type Tipo = 'nulo' | 'lista' | 'objeto' | 'texto' | 'numero' | 'booleano' | 'indefinido' | 'outro';

function tipoDe(v: unknown): Tipo {
  if (v === null) return 'nulo';
  if (Array.isArray(v)) return 'lista';
  switch (typeof v) {
    case 'object':
      return 'objeto';
    case 'string':
      return 'texto';
    case 'number':
      return 'numero';
    case 'boolean':
      return 'booleano';
    case 'undefined':
      return 'indefinido';
    default:
      return 'outro';
  }
}

const NOME_SIMPLES = /^[A-Za-z_][A-Za-z0-9_]*$/;

function juntar(caminho: string, chave: string): string {
  const parte = NOME_SIMPLES.test(chave) ? chave : JSON.stringify(chave);
  return caminho ? `${caminho}.${parte}` : parte;
}

/**
 * Onde os dois resultados diferem: os caminhos, sem os valores, até `max`. Campo a campo, sem depender da ordem das
 * chaves (V69: nada de comparar o texto do JSON); a lista, pela posição, e a de tamanho diferente leva `[#]`. Campo que
 * falta de um lado e é `undefined` do outro não conta como diferença; `null` conta.
 */
export function diferencas(a: unknown, b: unknown, max: number = MAX_CAMINHOS): string[] {
  const saida: string[] = [];
  const visitar = (x: unknown, y: unknown, caminho: string): void => {
    if (saida.length >= max) return;
    const tx = tipoDe(x);
    const ty = tipoDe(y);
    if (tx !== ty) {
      saida.push(caminho || '(raiz)');
      return;
    }
    if (tx === 'lista') {
      const lx = x as unknown[];
      const ly = y as unknown[];
      if (lx.length !== ly.length) saida.push(`${caminho}[#]`);
      for (let i = 0; i < Math.min(lx.length, ly.length) && saida.length < max; i += 1) visitar(lx[i], ly[i], `${caminho}[${i}]`);
      return;
    }
    if (tx === 'objeto') {
      const ox = x as Record<string, unknown>;
      const oy = y as Record<string, unknown>;
      const chaves = [...new Set([...Object.keys(ox), ...Object.keys(oy)])].sort();
      for (const chave of chaves) {
        if (saida.length >= max) return;
        visitar(ox[chave], oy[chave], juntar(caminho, chave));
      }
      return;
    }
    if (tx === 'numero' && Number.isNaN(x) && Number.isNaN(y)) return;
    if (x !== y) saida.push(caminho || '(raiz)');
  };
  visitar(a, b, '');
  return saida;
}
