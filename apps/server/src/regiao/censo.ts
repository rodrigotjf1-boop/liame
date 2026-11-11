import { nomeComparavel } from './coordenada.js';
import { arquivosDoZip } from './zip.js';

// Os bairros do Censo 2022 (plano da região, R2; base de conhecimento §19.2): dois arquivos do IBGE, "básico" (pessoas,
// domicílios, área) e "renda do responsável" (média e mediana), um .zip com um .csv cada (latin1, ponto e vírgula,
// aspas, decimal com vírgula, "." quando não há o dado). Entram uma vez e não mudam até o próximo Censo.

const BASE = 'https://ftp.ibge.gov.br/Censos/Censo_Demografico_2022';
export const ARQUIVO_BASICO = `${BASE}/Agregados_por_Setores_Censitarios/Agregados_por_Bairro_csv/Agregados_por_bairros_basico_BR_20260520.zip`;
export const ARQUIVO_RENDA = `${BASE}/Agregados_por_Setores_Censitarios_Rendimento_do_Responsavel/Agregados_por_bairros_renda_responsavel_BR_20260508_csv.zip`;
export const HOST_DO_CENSO = 'ftp.ibge.gov.br';
/** A fonte no catálogo (e na `region_source_read`, com o lugar `0`: vale para o país inteiro). */
export const FONTE_CENSO_BAIRRO = 'ibge_censo_bairro';
/** Os dois .zip têm menos de 1 MB; o .csv de dentro, menos de 6 MB. */
export const LIMITE_DO_ZIP = 4 * 1024 * 1024;
export const LIMITE_DO_CSV = 16 * 1024 * 1024;

export interface BairroDoCenso {
  codigo: string;
  municipio: string;
  nome: string;
  chave: string;
  areaKm2: number | null;
  pessoas: number | null;
  domicilios: number | null;
  rendaMedia: number | null;
  rendaMediana: number | null;
}

/** As linhas de um .csv com ponto e vírgula e aspas ("" é uma aspa dentro do campo). */
export function linhasDoCsv(texto: string): string[][] {
  const linhas: string[][] = [];
  let campo = '';
  let linha: string[] = [];
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]!;
    if (aspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else aspas = false;
      } else campo += c;
      continue;
    }
    if (c === '"') aspas = true;
    else if (c === ';') {
      linha.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      linha.push(campo);
      if (linha.length > 1 || linha[0] !== '') linhas.push(linha);
      linha = [];
      campo = '';
    } else campo += c;
  }
  if (campo !== '' || linha.length) {
    linha.push(campo);
    linhas.push(linha);
  }
  return linhas;
}

/** Um número do Censo: decimal com vírgula; "." ou vazio é "sem o dado". */
export function numeroDoCenso(campo: string | undefined): number | null {
  const t = (campo ?? '').trim();
  if (!t || t === '.' || t === '-' || t === 'X') return null;
  const n = Number(t.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function inteiro(campo: string | undefined): number | null {
  const n = numeroDoCenso(campo);
  return n === null || n < 0 ? null : Math.round(n);
}

/** As colunas pelo nome do cabeçalho (o IBGE pode mudar a ordem entre versões do arquivo). */
function colunas(cabecalho: string[], nomes: string[]): Record<string, number> {
  const pos: Record<string, number> = {};
  for (const nome of nomes) {
    const i = cabecalho.indexOf(nome);
    if (i < 0) throw new Error(`coluna ${nome} fora do arquivo do Censo`);
    pos[nome] = i;
  }
  return pos;
}

/** Os bairros do arquivo "básico", pelo código. */
export function bairrosDoBasico(texto: string): Map<string, BairroDoCenso> {
  const [cabecalho, ...linhas] = linhasDoCsv(texto);
  if (!cabecalho) return new Map();
  const c = colunas(cabecalho, ['CD_BAIRRO', 'NM_BAIRRO', 'CD_MUN', 'AREA_KM2', 'v0001', 'v0002']);
  const bairros = new Map<string, BairroDoCenso>();
  for (const l of linhas) {
    const codigo = (l[c.CD_BAIRRO!] ?? '').trim();
    const municipio = (l[c.CD_MUN!] ?? '').trim();
    const nome = (l[c.NM_BAIRRO!] ?? '').trim().slice(0, 200);
    if (!/^[0-9]{10}$/.test(codigo) || !/^[0-9]{7}$/.test(municipio) || !nome) continue;
    const area = numeroDoCenso(l[c.AREA_KM2!]);
    bairros.set(codigo, {
      codigo,
      municipio,
      nome,
      chave: nomeComparavel(nome).slice(0, 200),
      areaKm2: area === null || area < 0 ? null : Number(area.toFixed(6)),
      pessoas: inteiro(l[c.v0001!]),
      domicilios: inteiro(l[c.v0002!]),
      rendaMedia: null,
      rendaMediana: null,
    });
  }
  return bairros;
}

/** Junta a renda do responsável (média V06004, mediana V06006) aos bairros, pelo código. */
export function juntarRenda(bairros: Map<string, BairroDoCenso>, texto: string): number {
  const [cabecalho, ...linhas] = linhasDoCsv(texto);
  if (!cabecalho) return 0;
  const c = colunas(cabecalho, ['CD_BAIRRO', 'V06004', 'V06006']);
  let juntas = 0;
  for (const l of linhas) {
    const b = bairros.get((l[c.CD_BAIRRO!] ?? '').trim());
    if (!b) continue;
    const media = numeroDoCenso(l[c.V06004!]);
    const mediana = numeroDoCenso(l[c.V06006!]);
    b.rendaMedia = media === null || media < 0 ? null : Number(media.toFixed(2));
    b.rendaMediana = mediana === null || mediana < 0 ? null : Number(mediana.toFixed(2));
    juntas++;
  }
  return juntas;
}

/** O .csv de dentro do .zip do IBGE, em texto (o arquivo vem em latin1). */
export function csvDoZip(zip: Buffer): string {
  const csv = arquivosDoZip(zip, LIMITE_DO_CSV).find((a) => a.nome.toLowerCase().endsWith('.csv'));
  if (!csv) throw new Error('o .zip do Censo não tem o .csv');
  return csv.conteudo.toString('latin1');
}

/** Baixa um arquivo do Censo (só do servidor do IBGE, sem seguir redirecionamento, com teto de tamanho e de tempo). */
export async function baixarDoCenso(url: string, tempoMs = 60_000, buscar: typeof fetch = fetch): Promise<Buffer> {
  if (new URL(url).host !== HOST_DO_CENSO) throw new Error('endereço fora do IBGE');
  const r = await buscar(url, { redirect: 'error', signal: AbortSignal.timeout(tempoMs), headers: { 'user-agent': 'Liame/1.0 (+https://agencialiame.com)' } });
  if (!r.ok) throw new Error(`o IBGE respondeu ${r.status}`);
  const tamanho = Number(r.headers.get('content-length') ?? '0');
  if (tamanho > LIMITE_DO_ZIP) throw new Error('arquivo do Censo maior que o esperado');
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > LIMITE_DO_ZIP) throw new Error('arquivo do Censo maior que o esperado');
  return buf;
}
