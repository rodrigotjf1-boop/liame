import type { Tx } from '@liame/database';
import { ErroConector } from '../connectors/cliente-http.js';
import { type ConjuntoComPublico, ConectorMeta } from '../connectors/meta/conector-meta.js';
import type { DependenciasDoPublico } from './publico-no-raio.js';

// Os conjuntos ativos da conta de anúncios com o público (`targeting`), para o teste de região (plano da região, R8;
// D-RG-82): quais campanhas mostram anúncio no bairro. A leitura é a do conector da Meta
// (`lerPublicoDosConjuntosAtivos`: paginada, com teto de páginas); aqui ela é ligada quando o app sobe
// (`escrita-meta.provider.ts`), com a autorização da conta guardada no cofre, como a estimativa de público da campanha
// nova. Os testes trocam a Graph. Só lê.

const META = 'meta_ads';
/** O teto de páginas de 200 conjuntos: passou dele, o que não foi lido conta como "mostra anúncio no bairro". */
export const PAGINAS_DOS_CONJUNTOS = 5;

export class ConjuntosNaMeta {
  private deps: DependenciasDoPublico | null = null;

  ligar(deps: DependenciasDoPublico): void {
    this.deps = deps;
  }

  /**
   * Os conjuntos ativos da conta, com o público; `completo` falso quando passou do teto. Nulo quando o Liame não está
   * ligado. A falha da Meta (fora do ar, sem permissão, autorização revogada) sobe como `ErroConector`.
   */
  async lerAtivos(tx: Tx, conta: { externalId: string; segredo: string | null }, maxPaginas = PAGINAS_DOS_CONJUNTOS): Promise<{ conjuntos: ConjuntoComPublico[]; completo: boolean } | null> {
    const d = this.deps;
    if (!d) return null;
    const guardada = conta.segredo ? await d.lerSegredo(tx, conta.segredo) : null;
    let credencial: { tipo?: string; access_token?: string } | null = null;
    try {
      credencial = guardada ? (JSON.parse(guardada) as { tipo?: string; access_token?: string }) : null;
    } catch {
      credencial = null;
    }
    if (!credencial || credencial.tipo !== 'meta' || !credencial.access_token) throw new ErroConector('autenticacao', META, 'autorização revogada ou ausente');
    const versao = await d.versao('entities');
    const externalId = conta.externalId.startsWith('act_') ? conta.externalId : `act_${conta.externalId}`;
    return new ConectorMeta(d.cliente(), d.graphUrl, versao, d.appSecret).lerPublicoDosConjuntosAtivos({ externalId, credencial: { accessToken: credencial.access_token } }, maxPaginas);
  }
}

export const conjuntosNaMeta = new ConjuntosNaMeta();
