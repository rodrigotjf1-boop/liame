// robots.txt pelo protocolo da RFC 9309 (base §16.6): o Pesquisador procura o grupo com o nome dele (`Liame`, sem
// diferenciar maiúsculas) e, sem ele, o grupo `*`; vale a regra mais específica (a de mais caracteres), e, no empate,
// a que permite. `*` casa qualquer sequência e `$` marca o fim do caminho. Funções puras; quem busca o arquivo (e
// decide o que fazer com 4xx e 5xx) é o serviço.

/** O nome do produto do robô do Liame (o que um site põe em `User-agent:` para falar com ele). */
export const NOME_DO_ROBO = 'Liame';
/** Tamanho lido do arquivo (a RFC pede pelo menos 500 KiB). */
export const ROBOTS_MAXIMO = 512 * 1024;

export interface RegraDoRobots {
  permite: boolean;
  caminho: string;
}

/** As regras do grupo que vale para o robô: o do nome dele; sem ele, o `*`; sem os dois, nenhuma (tudo liberado). */
export function regrasDoRobots(texto: string, produto = NOME_DO_ROBO): RegraDoRobots[] {
  const grupos: Array<{ agentes: string[]; regras: RegraDoRobots[] }> = [];
  let atual: { agentes: string[]; regras: RegraDoRobots[] } | null = null;
  let ultimaFoiAgente = false;
  for (const bruta of texto.slice(0, ROBOTS_MAXIMO).split(/\r\n|\r|\n/)) {
    const linha = bruta.replace(/#.*$/, '').trim();
    const doisPontos = linha.indexOf(':');
    if (doisPontos < 0) continue;
    const campo = linha.slice(0, doisPontos).trim().toLowerCase();
    const valor = linha.slice(doisPontos + 1).trim();
    if (campo === 'user-agent') {
      // Agentes seguidos formam um grupo só.
      if (!atual || !ultimaFoiAgente) {
        atual = { agentes: [], regras: [] };
        grupos.push(atual);
      }
      atual.agentes.push(valor.toLowerCase());
      ultimaFoiAgente = true;
      continue;
    }
    ultimaFoiAgente = false;
    if (!atual) continue;
    if (campo === 'allow' || campo === 'disallow') {
      // `Disallow:` vazio não proíbe nada.
      if (campo === 'disallow' && !valor) continue;
      atual.regras.push({ permite: campo === 'allow', caminho: valor });
    }
  }
  const nome = produto.toLowerCase();
  const doRobo = grupos.filter((g) => g.agentes.includes(nome));
  const escolhidos = doRobo.length ? doRobo : grupos.filter((g) => g.agentes.includes('*'));
  return escolhidos.flatMap((g) => g.regras);
}

/** O caminho casa com o padrão da regra (`*` = qualquer sequência; `$` no fim = o caminho termina ali)? */
export function casa(padrao: string, caminho: string): boolean {
  const ancorado = padrao.endsWith('$');
  const partes = (ancorado ? padrao.slice(0, -1) : padrao).split('*');
  if (!caminho.startsWith(partes[0]!)) return false;
  let pos = partes[0]!.length;
  for (let k = 1; k < partes.length; k++) {
    const parte = partes[k]!;
    if (k === partes.length - 1 && ancorado) {
      // O último pedaço precisa estar no fim do caminho (depois de onde o anterior terminou).
      return caminho.length - parte.length >= pos && caminho.endsWith(parte);
    }
    const achado = caminho.indexOf(parte, pos);
    if (achado < 0) return false;
    pos = achado + parte.length;
  }
  return !ancorado || pos === caminho.length;
}

/** O robô pode ler este caminho (com a consulta, como a RFC compara)? Sem regra que case, pode. */
export function podeLer(regras: RegraDoRobots[], caminhoComConsulta: string): boolean {
  let melhor: RegraDoRobots | null = null;
  for (const r of regras) {
    if (!casa(r.caminho, caminhoComConsulta)) continue;
    if (!melhor || r.caminho.length > melhor.caminho.length || (r.caminho.length === melhor.caminho.length && r.permite && !melhor.permite)) melhor = r;
  }
  return melhor ? melhor.permite : true;
}
