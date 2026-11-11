import { z } from 'zod';
import { IDENTIFICACAO_DO_LIAME } from './cep.js';

// A coordenada da loja pelo OpenStreetMap (Nominatim; plano da região, R1; base de conhecimento §19.2). O Perfil da
// Empresa no Google quase nunca dá a coordenada (só a que foi digitada ao criar o perfil), e a da BrasilAPI é o centro
// da cidade: por isso o endereço vira coordenada aqui, em até três tentativas, da mais precisa para a menos (o
// endereço, o bairro, a cidade), e a resposta só vale se cair no município do CEP.
// As regras de uso do Nominatim (operations.osmfoundation.org/policies/nominatim, lidas em 09/11/2026): no máximo uma
// consulta por segundo, com a identificação do aplicativo, e cache das respostas; o acesso pode ser retirado. A
// coordenada leva a atribuição "© OpenStreetMap" (licença ODbL) onde aparecer.

/** O único site de onde a coordenada vem. */
export const HOST_DA_COORDENADA = 'nominatim.openstreetmap.org';
const LIMITE_BYTES = 64_000;
/** Uma consulta por segundo, com folga. */
const INTERVALO_MS = 1_100;
const CACHE_MAX = 500;
const CACHE_VALIDADE_MS = 24 * 60 * 60 * 1000;

export const NOME_DA_UF: Readonly<Record<string, string>> = {
  AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo',
  GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba',
  PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul',
  RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins',
};

export type PrecisaoDaCoordenada = 'endereco' | 'bairro' | 'cidade';
export interface Coordenada {
  latitude: number;
  longitude: number;
  precisao: PrecisaoDaCoordenada;
}

export interface EnderecoParaProcurar {
  rua: string | null;
  numero: string | null;
  bairro: string | null;
  cidade: string;
  uf: string;
}

/** Sem acento, sem caixa e sem espaço sobrando: é assim que o nome da cidade da resposta se compara com o do CEP. */
export function nomeComparavel(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** As consultas, da mais precisa para a menos; a do endereço só existe com a rua. */
export function consultasDoEndereco(e: EnderecoParaProcurar): Array<{ precisao: PrecisaoDaCoordenada; params: Record<string, string> }> {
  const base = { city: e.cidade, state: NOME_DA_UF[e.uf] ?? e.uf, country: 'Brasil' };
  const lista: Array<{ precisao: PrecisaoDaCoordenada; params: Record<string, string> }> = [];
  if (e.rua) lista.push({ precisao: 'endereco', params: { ...base, street: e.numero ? `${e.numero} ${e.rua}` : e.rua } });
  // O bairro vai como texto livre junto da cidade: o Nominatim não tem campo de bairro na consulta estruturada.
  if (e.bairro) lista.push({ precisao: 'bairro', params: { q: `${e.bairro}, ${e.cidade}, ${NOME_DA_UF[e.uf] ?? e.uf}, Brasil` } });
  lista.push({ precisao: 'cidade', params: base });
  return lista;
}

export function enderecoDaConsulta(params: Record<string, string>): string {
  const u = new URL(`https://${HOST_DA_COORDENADA}/search`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('addressdetails', '1');
  u.searchParams.set('limit', '1');
  u.searchParams.set('countrycodes', 'br');
  return u.toString();
}

const RespostaDoNominatim = z
  .array(
    z.object({
      lat: z.string().max(30),
      lon: z.string().max(30),
      address: z.record(z.string(), z.string().max(300)).optional(),
    }),
  )
  .max(5);

/** A coordenada de uma resposta, se ela cair no Brasil e no município esperado; senão, nula. */
export function coordenadaDaResposta(json: unknown, cidade: string, precisao: PrecisaoDaCoordenada): Coordenada | null {
  const r = RespostaDoNominatim.safeParse(json);
  if (!r.success || !r.data[0]) return null;
  const { lat, lon, address } = r.data[0];
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -34 || latitude > 6 || longitude < -75 || longitude > -28) return null;
  const esperada = nomeComparavel(cidade);
  const nomes = ['city', 'town', 'municipality', 'village', 'city_district'].map((k) => address?.[k]).filter((v): v is string => !!v).map(nomeComparavel);
  if (!nomes.includes(esperada)) return null;
  return { latitude: Number(latitude.toFixed(6)), longitude: Number(longitude.toFixed(6)), precisao };
}

/**
 * A fila das consultas ao Nominatim neste processo: uma por segundo, e a mesma consulta respondida pelo cache por um
 * dia. A API do Liame roda num processo só; o volume é baixo (uma conferência quando a loja informa ou muda o endereço).
 */
export class ProcuraDeCoordenada {
  private ultima = 0;
  private fila: Promise<void> = Promise.resolve();
  private readonly cache = new Map<string, { em: number; valor: unknown }>();

  constructor(private readonly buscar: (url: string) => Promise<unknown> = buscarNoNominatim) {}

  private async naVez(): Promise<void> {
    const minha = this.fila.then(async () => {
      const espera = this.ultima + INTERVALO_MS - Date.now();
      if (espera > 0) await new Promise((ok) => setTimeout(ok, espera));
      this.ultima = Date.now();
    });
    this.fila = minha.catch(() => undefined);
    await minha;
  }

  private async consultar(url: string): Promise<unknown> {
    const guardada = this.cache.get(url);
    if (guardada && Date.now() - guardada.em < CACHE_VALIDADE_MS) return guardada.valor;
    await this.naVez();
    const valor = await this.buscar(url);
    if (this.cache.size >= CACHE_MAX) {
      const maisVelha = this.cache.keys().next().value;
      if (maisVelha !== undefined) this.cache.delete(maisVelha);
    }
    this.cache.set(url, { em: Date.now(), valor });
    return valor;
  }

  /** A coordenada mais precisa que o OpenStreetMap acha para o endereço; nula se nenhuma tentativa achou ou ele não respondeu. */
  async procurar(e: EnderecoParaProcurar): Promise<Coordenada | null> {
    for (const c of consultasDoEndereco(e)) {
      let json: unknown;
      try {
        json = await this.consultar(enderecoDaConsulta(c.params));
      } catch {
        // Fora do ar ou lento: as outras tentativas iriam ao mesmo lugar.
        return null;
      }
      const achada = coordenadaDaResposta(json, e.cidade, c.precisao);
      if (achada) return achada;
    }
    return null;
  }
}

/** Uma consulta ao Nominatim: endereço fixo, sem redirecionamento, com prazo e limite de tamanho. */
export async function buscarNoNominatim(url: string, tempoLimiteMs = 6_000): Promise<unknown> {
  if (new URL(url).host !== HOST_DA_COORDENADA) throw new Error('coordenada: endereço fora do Nominatim');
  const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(tempoLimiteMs), headers: { accept: 'application/json', 'user-agent': IDENTIFICACAO_DO_LIAME, 'accept-language': 'pt-BR' } });
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error(`coordenada: HTTP ${r.status}`);
  }
  const texto = await r.text();
  if (texto.length > LIMITE_BYTES) throw new Error('coordenada: resposta grande demais');
  return JSON.parse(texto) as unknown;
}
