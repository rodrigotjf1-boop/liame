import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { z } from 'zod';
import { nomeComparavel } from './coordenada.js';
import { digitos, HOST_DO_IBGE } from './ibge.js';
import { arquivosDoZip, type CabecalhoDoZip, PrimeiroArquivoDoZip, ZipInvalido } from './zip.js';

// Os restaurantes ativos por município, bairro e CEP (plano da região, R2, parte 4; migration 0141; base §19.5): o
// cadastro aberto de CNPJ da Receita Federal, um retrato por mês em 10 arquivos (`Estabelecimentos0..9.zip`, ≈ 5,4 GB
// zipados). Os arquivos trazem dado pessoal (nome fantasia, endereço de MEI, telefone, e-mail): tudo é lido EM FLUXO,
// linha a linha, e daqui só saem CONTAGENS por lugar. Nenhuma linha, nome, endereço, telefone, e-mail ou CNPJ é guardado
// nem vai para o log. A Receita não recebe nada do Liame (a leitura é só o download dos arquivos públicos).

export const HOST_DA_RECEITA = 'arquivos.receitafederal.gov.br';
export const PASTA_DO_CNPJ = `https://${HOST_DA_RECEITA}/public.php/dav/files/gn672Ad4CF8N6TK/Dados/Cadastros/CNPJ/`;
export const FONTE_DO_CNPJ = 'receita_cnpj';
export const PARTES_DO_CNPJ = 10;
export const ENDERECO_DOS_MUNICIPIOS_DO_IBGE = `https://${HOST_DO_IBGE}/api/v1/localidades/municipios?view=nivelado`;

const AGENTE = 'Liame/1.0 (+https://agencialiame.com)';
/** Arquivo que fica este tempo sem mandar um byte é dado como parado (a leitura cai e tenta de novo). */
const PARADO_MS = 5 * 60_000;
/** O teto de uma leitura: o arquivo maior (2,3 GB) leva ≈ 40 minutos a 1 MB/s. */
const TETO_DA_LEITURA_MS = 8 * 60 * 60_000;

/**
 * Os CNAEs de comida pronta (o CNAE principal do estabelecimento) e a coluna de cada tipo na contagem:
 * 1 restaurante, 2 lanchonete, 3 bar (sem e com entretenimento), 4 comida para casa (marmita, cozinha que só entrega).
 */
export const TIPO_DO_CNAE: Readonly<Record<string, 1 | 2 | 3 | 4>> = {
  '5611201': 1,
  '5611203': 2,
  '5611204': 3,
  '5611205': 3,
  '5620104': 4,
};

/** As colunas do arquivo de estabelecimentos que a contagem usa (o layout da Receita tem 30). */
const COL = { situacao: 5, dataDaSituacao: 6, inicio: 10, cnae: 11, bairro: 17, cep: 18, uf: 19, municipio: 20 } as const;
const COLUNAS_DO_ARQUIVO = 30;
const ATIVA = '02';
const BAIXADA = '08';

/** A contagem de um lugar: [ativos, restaurante, lanchonete, bar, para casa, abertos em 12 meses, baixados em 12 meses]. */
export type Contagem = [number, number, number, number, number, number, number];
export type TipoDaArea = 'municipio' | 'bairro' | 'cep';

export interface LinhaDeContagem {
  municipio: string;
  tipo: TipoDaArea;
  chave: string;
  contagem: Contagem;
}

// ------------------------------------------------------------------------------------------------------------------
// A pasta da Receita (Nextcloud público, WebDAV): os meses e os arquivos de cada mês.

export interface ItemDaPasta {
  nome: string;
  tamanho: number | null;
}

function entre(texto: string, abre: string, fecha: string, desde: number): { valor: string; fim: number } | null {
  const a = texto.indexOf(abre, desde);
  if (a < 0) return null;
  const b = texto.indexOf(fecha, a + abre.length);
  if (b < 0) return null;
  return { valor: texto.slice(a + abre.length, b), fim: b + fecha.length };
}

/** Os itens de uma resposta PROPFIND (o último pedaço do endereço de cada um e o tamanho, quando é arquivo). */
export function itensDaPasta(xml: string): ItemDaPasta[] {
  const itens: ItemDaPasta[] = [];
  let p = 0;
  for (;;) {
    const r = entre(xml, '<d:response>', '</d:response>', p);
    if (!r) break;
    p = r.fim;
    const href = entre(r.valor, '<d:href>', '</d:href>', 0)?.valor;
    if (!href) continue;
    const partes = decodeURIComponent(href).split('/').filter(Boolean);
    const nome = partes[partes.length - 1] ?? '';
    const tamanho = entre(r.valor, '<d:getcontentlength>', '</d:getcontentlength>', 0)?.valor;
    itens.push({ nome, tamanho: tamanho === undefined ? null : Number(tamanho) });
  }
  return itens;
}

/** "AAAA-MM" de verdade (o nome das pastas dos meses). */
export function ehMes(nome: string): boolean {
  return nome.length === 7 && digitos(nome.slice(0, 4), 4) && nome[4] === '-' && digitos(nome.slice(5), 2) && Number(nome.slice(5)) >= 1 && Number(nome.slice(5)) <= 12;
}

/** O mês está inteiro na pasta: os 10 arquivos de estabelecimentos e o de municípios, todos com tamanho. */
export function mesCompleto(itens: readonly ItemDaPasta[]): boolean {
  const tem = (nome: string) => itens.some((i) => i.nome === nome && (i.tamanho ?? 0) > 0);
  if (!tem('Municipios.zip')) return false;
  for (let i = 0; i < PARTES_DO_CNPJ; i++) if (!tem(`Estabelecimentos${i}.zip`)) return false;
  return true;
}

async function listar(url: string, buscar: typeof fetch): Promise<ItemDaPasta[]> {
  if (new URL(url).host !== HOST_DA_RECEITA) throw new Error('endereço fora da Receita');
  const r = await buscar(url, { method: 'PROPFIND', redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'user-agent': AGENTE, depth: '1' } });
  if (r.status !== 207 && !r.ok) throw new Error(`a Receita respondeu ${r.status}`);
  const texto = await r.text();
  if (texto.length > 1024 * 1024) throw new Error('lista da Receita maior que o esperado');
  return itensDaPasta(texto);
}

/** O mês mais novo que já está inteiro na pasta da Receita (olha os 3 mais novos: a Receita sobe aos poucos). */
export async function ultimoMesCompleto(buscar: typeof fetch = fetch): Promise<string> {
  const meses = (await listar(PASTA_DO_CNPJ, buscar))
    .map((i) => i.nome)
    .filter(ehMes)
    .sort()
    .reverse();
  for (const mes of meses.slice(0, 3)) {
    if (mesCompleto(await listar(`${PASTA_DO_CNPJ}${mes}/`, buscar))) return mes;
  }
  throw new Error(meses.length ? 'nenhum dos meses mais novos está inteiro na Receita' : 'a pasta da Receita veio sem meses');
}

export function enderecoDoArquivo(mes: string, parte: number): string {
  return `${PASTA_DO_CNPJ}${mes}/Estabelecimentos${parte}.zip`;
}

/** O primeiro dia dos 12 meses antes do mês dos arquivos, "AAAAMMDD" ("2026-10" → "20251001"). */
export function inicioDaJanela(mes: string): string {
  return `${Number(mes.slice(0, 4)) - 1}${mes.slice(5, 7)}01`;
}

// ------------------------------------------------------------------------------------------------------------------
// O município: a Receita usa um código próprio (o do SIAFI: Rio = 6001) e o arquivo de municípios só traz o nome; a UF
// vem de cada linha. A tradução para o código do IBGE é pelo nome e a UF, sem acento; os 16 que mudaram de nome (ou
// de grafia) e não casam estão abaixo, conferidos na lista do IBGE em 11/11/2026.

export const EQUIVALENCIAS_DA_RECEITA: Readonly<Record<string, string>> = {
  '0315': '1400605', // SAO LUIZ → São Luiz do Anauá (RR)
  '0345': '1708254', // FORTALEZA DO TABOCAO → Tabocão (TO)
  '0377': '1502954', // ELDORADO DOS CARAJAS → Eldorado do Carajás (PA)
  '0529': '1506500', // SANTA ISABEL DO PARA → Santa Izabel do Pará (PA)
  '1623': '2401206', // ARES → Arez (RN)
  '1703': '2405306', // BOA SAUDE → Januário Cicco (RN)
  '3005': '2922250', // MUQUEM DE SAO FRANCISCO → Muquém do São Francisco (BA)
  '3101': '2800100', // AMPARO DE SAO FRANCISCO → Amparo do São Francisco (SE)
  '4049': '3102506', // AMPARO DA SERRA → Amparo do Serra (MG)
  '4177': '3108909', // BRASOPOLIS → Brazópolis (MG)
  '5875': '3303807', // PARATI → Paraty (RJ)
  '8251': '4212809', // BALNEARIO DE PICARRAS → Balneário Piçarras (SC)
  '8845': '4317103', // SANTANA DO LIVRAMENTO → Sant'Ana do Livramento (RS)
  '9155': '5107800', // SANTO ANTONIO DO LEVERGER → Santo Antônio de Leverger (MT)
  '9321': '1706001', // COUTO DE MAGALHAES → Couto Magalhães (TO)
  '9691': '1720499', // SAO VALERIO DA NATIVIDADE → São Valério (TO)
};

/** O nome do município para comparar: sem acento, sem caixa, e hífen, apóstrofo e espaços viram um espaço só. */
export function chaveDoMunicipio(nome: string): string {
  let s = '';
  for (const ch of nomeComparavel(nome)) s += (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') ? ch : ' ';
  return s.split(' ').filter(Boolean).join(' ');
}

function semAspas(campo: string): string {
  const t = campo.trim();
  const a = t.startsWith('"') ? 1 : 0;
  const b = t.length > a && t.endsWith('"') ? t.length - 1 : t.length;
  return t.slice(a, b);
}

/** Os municípios do arquivo da Receita (`"6001";"RIO DE JANEIRO"`), código → nome. */
export function municipiosDaReceita(csv: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const bruta of csv.split('\n')) {
    const linha = bruta.trim();
    if (!linha) continue;
    const [codigo, nome] = linha.split(';').map(semAspas);
    if (codigo && nome && digitos(codigo, 4)) m.set(codigo, nome);
  }
  return m;
}

const ListaDoIbge = z
  .array(z.object({ 'municipio-id': z.number().int(), 'municipio-nome': z.string().min(1).max(200), 'UF-sigla': z.string().length(2) }))
  .min(5000)
  .max(6000);

export type MunicipioDe = (codigoDaReceita: string, uf: string) => string | null;

/** A tradução Receita → IBGE: pela tabela dos 16 e, no resto, pelo nome com a UF. */
export function equivalenciaDeMunicipios(daReceita: ReadonlyMap<string, string>, listaDoIbge: unknown): MunicipioDe {
  const ibge = ListaDoIbge.parse(listaDoIbge);
  const porNome = new Map<string, string>();
  for (const m of ibge) porNome.set(`${m['UF-sigla']}|${chaveDoMunicipio(m['municipio-nome'])}`, String(m['municipio-id']));
  const feitos = new Map<string, string | null>();
  return (codigo, uf) => {
    const k = `${codigo}|${uf}`;
    const visto = feitos.get(k);
    if (visto !== undefined) return visto;
    const fixo = EQUIVALENCIAS_DA_RECEITA[codigo];
    const nome = daReceita.get(codigo);
    const achado = fixo ?? (nome ? (porNome.get(`${uf}|${chaveDoMunicipio(nome)}`) ?? null) : null);
    feitos.set(k, achado);
    return achado;
  };
}

/** O arquivo de municípios da Receita do mês (≈ 43 KB). */
export async function baixarMunicipiosDaReceita(mes: string, buscar: typeof fetch = fetch): Promise<Map<string, string>> {
  const url = `${PASTA_DO_CNPJ}${mes}/Municipios.zip`;
  const r = await buscar(url, { redirect: 'error', signal: AbortSignal.timeout(60_000), headers: { 'user-agent': AGENTE } });
  if (!r.ok) throw new Error(`a Receita respondeu ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 1024 * 1024) throw new Error('arquivo de municípios da Receita maior que o esperado');
  const [arquivo] = arquivosDoZip(buf, 2 * 1024 * 1024);
  if (!arquivo) throw new Error('o arquivo de municípios da Receita veio vazio');
  const m = municipiosDaReceita(arquivo.conteudo.toString('latin1'));
  if (m.size < 5000) throw new Error(`o arquivo de municípios da Receita veio com ${m.size} municípios`);
  return m;
}

// ------------------------------------------------------------------------------------------------------------------
// A contagem: cada pedaço descompactado é procurado pelos CNAEs (busca de bytes, sem converter o arquivo inteiro em
// texto); só a linha que tem um deles é lida, e o CNAE PRINCIPAL é conferido na coluna dele.

const PADROES = [Buffer.from(';"56112', 'latin1'), Buffer.from(';"5620104"', 'latin1')];
const FIM_DE_LINHA = 10;

export type BairroDe = (municipio: string, chaveDoNome: string) => string | null;

export interface EstatisticaDaLeitura {
  /** Linhas com um dos CNAEs como principal. */
  linhas: number;
  /** Linhas achadas pela busca que não têm as 30 colunas (descartadas). */
  foraDoFormato: number;
  /** Linhas contadas cujo município da Receita não tem par no IBGE (descartadas). */
  semMunicipio: number;
  /** Ativos cujo bairro casou com um bairro do Censo. */
  ativosComBairro: number;
  ativos: number;
}

export class ContagemDoCnpj {
  private readonly contas = new Map<string, Contagem>();
  private sobra: Buffer = Buffer.alloc(0);
  readonly estatistica: EstatisticaDaLeitura = { linhas: 0, foraDoFormato: 0, semMunicipio: 0, ativosComBairro: 0, ativos: 0 };

  constructor(
    private readonly desde: string,
    private readonly municipioDe: MunicipioDe,
    private readonly bairroDe: BairroDe,
  ) {}

  /** Um pedaço do .csv descompactado (as linhas podem vir cortadas entre um pedaço e o seguinte). */
  pedaco(buf: Buffer): void {
    const tudo = this.sobra.length ? Buffer.concat([this.sobra, buf]) : buf;
    const ultimo = tudo.lastIndexOf(FIM_DE_LINHA);
    if (ultimo < 0) {
      this.sobra = Buffer.from(tudo);
      return;
    }
    this.procurar(tudo, ultimo + 1);
    this.sobra = Buffer.from(tudo.subarray(ultimo + 1));
  }

  /** O fim do arquivo: a última linha, se não acabou com quebra de linha. */
  fim(): void {
    if (this.sobra.length) this.procurar(this.sobra, this.sobra.length);
    this.sobra = Buffer.alloc(0);
  }

  linhas(): LinhaDeContagem[] {
    return [...this.contas.entries()].map(([k, contagem]) => {
      const [municipio, tipo, chave] = k.split('|') as [string, TipoDaArea, string];
      return { municipio, tipo, chave, contagem };
    });
  }

  private procurar(buf: Buffer, fim: number): void {
    const achados: number[] = [];
    for (const p of PADROES) {
      let i = buf.indexOf(p);
      while (i >= 0 && i < fim) {
        achados.push(i);
        i = buf.indexOf(p, i + 1);
      }
    }
    if (!achados.length) return;
    achados.sort((a, b) => a - b);
    let ultimaLinha = -1;
    for (const i of achados) {
      const a = buf.lastIndexOf(FIM_DE_LINHA, i) + 1;
      if (a === ultimaLinha) continue;
      ultimaLinha = a;
      let b = buf.indexOf(FIM_DE_LINHA, i);
      if (b < 0 || b > fim) b = fim;
      if (b > a && buf[b - 1] === 13) b--;
      this.linha(buf.toString('latin1', a, b));
    }
  }

  private linha(texto: string): void {
    if (texto.length < 2 || texto[0] !== '"' || texto[texto.length - 1] !== '"') {
      this.estatistica.foraDoFormato++;
      return;
    }
    const c = texto.slice(1, -1).split('";"');
    if (c.length !== COLUNAS_DO_ARQUIVO) {
      this.estatistica.foraDoFormato++;
      return;
    }
    const tipo = TIPO_DO_CNAE[c[COL.cnae]!];
    if (!tipo) return;
    this.estatistica.linhas++;
    const situacao = c[COL.situacao]!;
    const ativo = situacao === ATIVA ? 1 : 0;
    const inicio = c[COL.inicio]!;
    const abriu = digitos(inicio, 8) && inicio >= this.desde ? 1 : 0;
    const dataDaSituacao = c[COL.dataDaSituacao]!;
    const baixou = situacao === BAIXADA && digitos(dataDaSituacao, 8) && dataDaSituacao >= this.desde ? 1 : 0;
    if (!ativo && !abriu && !baixou) return;
    const municipio = this.municipioDe(c[COL.municipio]!, c[COL.uf]!);
    if (!municipio) {
      this.estatistica.semMunicipio++;
      return;
    }
    const somar = (area: TipoDaArea, chave: string) => {
      const k = `${municipio}|${area}|${chave}`;
      let v = this.contas.get(k);
      if (!v) {
        v = [0, 0, 0, 0, 0, 0, 0];
        this.contas.set(k, v);
      }
      v[0] += ativo;
      v[tipo] += ativo;
      v[5] += abriu;
      v[6] += baixou;
    };
    somar('municipio', '');
    this.estatistica.ativos += ativo;
    const cep = c[COL.cep]!;
    if (digitos(cep, 8)) somar('cep', cep.slice(0, 5));
    const nomeDoBairro = c[COL.bairro]!.trim();
    const bairro = nomeDoBairro ? this.bairroDe(municipio, nomeComparavel(nomeDoBairro)) : null;
    if (bairro) {
      somar('bairro', bairro);
      this.estatistica.ativosComBairro += ativo;
    }
  }
}

// ------------------------------------------------------------------------------------------------------------------
// A leitura de um arquivo: baixa, tira do .zip e descompacta em fluxo, contando; nada vai para o disco.

export interface OpcoesDaLeitura {
  buscar?: typeof fetch;
  /** Chamado a cada pedaço com os bytes descompactados até ali (a rotina estende a reserva por aqui). */
  aoAvancar?: (bytes: number) => void | Promise<void>;
  paradoMs?: number;
  tetoMs?: number;
}

/** Lê um `Estabelecimentos{n}.zip` inteiro para a contagem; devolve o cabeçalho conferido. */
export async function lerArquivoDoCnpj(url: string, contagem: ContagemDoCnpj, opcoes: OpcoesDaLeitura = {}): Promise<CabecalhoDoZip> {
  if (new URL(url).host !== HOST_DA_RECEITA) throw new Error('endereço fora da Receita');
  const buscar = opcoes.buscar ?? fetch;
  const paradoMs = opcoes.paradoMs ?? PARADO_MS;
  const parada = new AbortController();
  let relogio: NodeJS.Timeout | undefined;
  const vigiar = () => {
    clearTimeout(relogio);
    relogio = setTimeout(() => parada.abort(new Error('a Receita parou de mandar o arquivo')), paradoMs);
  };
  vigiar();
  try {
    const sinal = AbortSignal.any([parada.signal, AbortSignal.timeout(opcoes.tetoMs ?? TETO_DA_LEITURA_MS)]);
    const r = await buscar(url, { redirect: 'error', signal: sinal, headers: { 'user-agent': AGENTE } });
    if (!r.ok || !r.body) throw new Error(`a Receita respondeu ${r.status}`);
    const zip = new PrimeiroArquivoDoZip({ soDeflate: true });
    let bytes = 0;
    const contar = new Writable({
      write(pedaco: Buffer, _codificacao, pronto) {
        vigiar();
        contagem.pedaco(pedaco);
        bytes += pedaco.length;
        if (!opcoes.aoAvancar) return pronto();
        Promise.resolve(opcoes.aoAvancar(bytes)).then(() => pronto(), pronto);
      },
    });
    await pipeline(Readable.fromWeb(r.body as never), zip, createInflateRaw(), contar, { signal: sinal });
    contagem.fim();
    if (!zip.info) throw new ZipInvalido('arquivo sem cabeçalho');
    if (bytes !== zip.info.tamanho) throw new ZipInvalido('tamanho descompactado diferente do anunciado');
    return zip.info;
  } catch (err) {
    if (parada.signal.aborted && parada.signal.reason instanceof Error) throw parada.signal.reason;
    throw err;
  } finally {
    clearTimeout(relogio);
  }
}
