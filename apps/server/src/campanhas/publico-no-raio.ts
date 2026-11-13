import { createHmac } from 'node:crypto';
import type { Tx } from '@liame/database';
import { type ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { lugaresDoRaio } from './bairros-da-campanha.js';
import { PUBLICO_MINIMO_NO_RAIO } from './campanha-nova-plano.js';

// A estimativa de público no raio da loja (plano da região, R6, parte 2; revisão R6 da P42 aprovada pelo dono em
// 13/11/2026, D-RG-50). A Meta diz quantas pessoas de 18 anos ou mais há no raio (`GET /act_{id}/reachestimate` com o
// `targeting_spec`; base §19, conferida em 09/11/2026): o mínimo e o máximo, -1 quando ela não estima (o que não quer
// dizer público vazio). Com menos de 1.000 pessoas, o pedido não é criado: a Meta não entrega bem. O mínimo de 100 mil
// da base §7.4 não vale para a campanha com raio. O token vai no cabeçalho, com a prova do segredo do app (V161).

const META = 'meta_ads';

/** A estimativa da Meta: o mínimo e o máximo de pessoas no raio. */
export type PublicoEstimado = { de: number; ate: number };

/** O alvo da estimativa: os mesmos lugares e a mesma idade do conjunto da campanha nova, sem a ampliação da Meta. */
export function alvoDosLugares(lugares: Record<string, unknown>): Record<string, unknown> {
  return { geo_locations: lugares, age_min: 18, targeting_automation: { advantage_audience: 0 } };
}
/** O alvo do raio em volta da loja. */
export const alvoDoRaio = (latitude: number, longitude: number, raioKm: number): Record<string, unknown> => alvoDosLugares(lugaresDoRaio(latitude, longitude, raioKm));

/** O mínimo e o máximo na resposta (`data` como objeto ou como lista de um); nulo sem estimativa (-1 ou fora do formato). */
export function publicoDaEstimativa(corpo: unknown): PublicoEstimado | null {
  const data = (corpo as { data?: unknown } | null)?.data;
  const d = (Array.isArray(data) ? data[0] : data) as { users_lower_bound?: unknown; users_upper_bound?: unknown } | null | undefined;
  const de = typeof d?.users_lower_bound === 'number' ? d.users_lower_bound : Number(d?.users_lower_bound);
  const ate = typeof d?.users_upper_bound === 'number' ? d.users_upper_bound : Number(d?.users_upper_bound);
  if (!Number.isInteger(de) || !Number.isInteger(ate) || de < 0 || ate < de) return null;
  return { de, ate };
}

/** O público estimado dá para a Meta entregar? (o máximo da faixa a partir do mínimo, D-RG-50) */
export const publicoSuficiente = (p: PublicoEstimado): boolean => p.ate >= PUBLICO_MINIMO_NO_RAIO;

export type DependenciasDoPublico = {
  lerSegredo: (tx: Tx, secretId: string) => Promise<string | null>;
  cliente: () => ClienteConector;
  graphUrl: string;
  appSecret: string | null;
  versao: (capacidade: string) => Promise<string>;
};

/** A leitura da estimativa na Meta, ligada quando o app sobe (`escrita-meta.provider.ts`); os testes trocam a Graph. */
export class PublicoNoRaio {
  private deps: DependenciasDoPublico | null = null;

  ligar(deps: DependenciasDoPublico): void {
    this.deps = deps;
  }

  /**
   * A estimativa para a conta de anúncios e o raio em volta do ponto. Nula quando a Meta não estima (ou o Liame não está
   * ligado); a falha da Meta (fora do ar, sem permissão) sobe como `ErroConector`, e quem chama decide.
   */
  async estimar(tx: Tx, conta: { externalId: string; segredo: string | null }, lugares: Record<string, unknown>): Promise<PublicoEstimado | null> {
    const d = this.deps;
    if (!d) return null;
    const { token, versao, prova } = await this.acesso(tx, d, conta.segredo);
    const q = new URLSearchParams({ targeting_spec: JSON.stringify(alvoDosLugares(lugares)) });
    if (prova) q.set('appsecret_proof', prova);
    const conta_ = conta.externalId.startsWith('act_') ? conta.externalId : `act_${conta.externalId}`;
    const r = await d.cliente().requisitar<unknown>({
      provider: META,
      conta: conta.externalId,
      url: `${d.graphUrl}/${versao}/${conta_}/reachestimate?${q.toString()}`,
      metodo: 'GET',
      endpoint: 'entities',
      apiVersion: versao,
      cabecalhos: { authorization: `Bearer ${token}` },
      // Uma pessoa espera na gaveta (ou no pedido): a estimativa que demora vira "indisponível", não trava a tela.
      tempoLimiteMs: 8_000,
    });
    return publicoDaEstimativa(r.corpo);
  }

  /**
   * A busca de um bairro nos lugares da Meta (`GET /search?type=adgeolocation`, tipo bairro, no Brasil; R6, parte 3,
   * D-RG-54): devolve o corpo como veio; quem chama confere o nome e a cidade (`bairroNaBuscaDaMeta`). A falha da Meta
   * sobe como `ErroConector`. Nulo sem o Liame ligado.
   */
  async procurarBairro(tx: Tx, conta: { externalId: string; segredo: string | null }, nome: string): Promise<unknown> {
    const d = this.deps;
    if (!d) return null;
    const { token, versao, prova } = await this.acesso(tx, d, conta.segredo);
    const q = new URLSearchParams({ type: 'adgeolocation', location_types: JSON.stringify(['neighborhood']), q: nome, country_code: 'BR', limit: '25' });
    if (prova) q.set('appsecret_proof', prova);
    const r = await d.cliente().requisitar<unknown>({
      provider: META,
      conta: conta.externalId,
      url: `${d.graphUrl}/${versao}/search?${q.toString()}`,
      metodo: 'GET',
      endpoint: 'entities',
      apiVersion: versao,
      cabecalhos: { authorization: `Bearer ${token}` },
      tempoLimiteMs: 5_000,
    });
    return r.corpo;
  }

  /** O token da autorização guardada, a versão da Graph e a prova do segredo do app (V161). */
  private async acesso(tx: Tx, d: DependenciasDoPublico, segredo: string | null): Promise<{ token: string; versao: string; prova: string | null }> {
    const guardada = segredo ? await d.lerSegredo(tx, segredo) : null;
    let credencial: { tipo?: string; access_token?: string } | null = null;
    try {
      credencial = guardada ? (JSON.parse(guardada) as { tipo?: string; access_token?: string }) : null;
    } catch {
      credencial = null;
    }
    if (!credencial || credencial.tipo !== 'meta' || !credencial.access_token) throw new ErroConector('autenticacao', META, 'autorização revogada ou ausente');
    const token = credencial.access_token;
    const versao = await d.versao('entities');
    return { token, versao, prova: d.appSecret ? createHmac('sha256', d.appSecret).update(token).digest('hex') : null };
  }
}

export const publicoNoRaio = new PublicoNoRaio();
