// A mídia por região e por hora (plano da região, R4, parte 1; base §19.7): o que as plataformas de anúncio dizem da
// hora em que o anúncio rendeu (Meta e Google) e da cidade de quem viu e clicou (só o Google: a Meta dá só o estado,
// que não serve a um restaurante). Contas puras, sem banco nem rede: o conector traz as linhas da plataforma, e a
// rotina do worker (`worker/regiao-midia.service.ts`) grava. Nada de pessoa: só somas por dia, hora e lugar.

/** O conjunto do `sync_state` desta leitura (uma linha por conta de anúncio). */
export const DATASET_DA_MIDIA = 'regiao_midia';
/** Uma leitura por dia: os números de anúncio mudam até 28 dias depois (a Meta fecha em 28 dias). */
export const INTERVALO_DA_MIDIA_MIN = 24 * 60;
/** As 4 semanas completas até ontem, no fuso da conta: a mesma janela da demanda da loja (R3, D-RG-21). */
export const DIAS_DA_MIDIA = 28;
/** Ids de lugar do Google traduzidos por consulta (a API aceita até 20.000; o Liame pede pouco). */
export const LUGARES_POR_CONSULTA = 500;

/** Uma hora de um dia, na conta (no fuso da conta de anúncio). */
export type HoraLida = { dia: string; hora: number; impressoes: number; cliques: number; gasto: string; conversoes: string | null };
/** Um lugar de um dia (o id do lugar no Google). */
export type CidadeLida = { dia: string; lugar: string; impressoes: number; cliques: number; gasto: string; conversoes: string | null };
/** O nome de um lugar do Google (`geo_target_constant`). */
export type LugarLido = { id: string; nome: string; nomeCompleto: string; tipo: string; pais: string | null };

const DIA = /^\d{4}-\d{2}-\d{2}$/;

/** O dia "AAAA-MM-DD" `n` dias antes. */
function diasAntes(dia: string, n: number): string {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** As 4 semanas completas até ontem, a partir de hoje no fuso da conta. */
export function janelaDaMidia(hoje: string): { inicio: string; fim: string } {
  return { inicio: diasAntes(hoje, DIAS_DA_MIDIA), fim: diasAntes(hoje, 1) };
}

/** A hora da faixa da Meta ("13:00:00 - 13:59:59" → 13); nula fora do formato. */
export function horaDaMeta(faixa: unknown): number | null {
  if (typeof faixa !== 'string' || faixa.length < 2) return null;
  const h = Number(faixa.slice(0, 2));
  return Number.isInteger(h) && h >= 0 && h <= 23 && faixa.charAt(2) === ':' ? h : null;
}

/** O id do lugar no nome do recurso do Google ("geoTargetConstants/1001773" → "1001773"); nulo fora do formato. */
export function idDoLugar(recurso: unknown): string | null {
  if (typeof recurso !== 'string') return null;
  const id = recurso.startsWith('geoTargetConstants/') ? recurso.slice('geoTargetConstants/'.length) : recurso;
  return id.length >= 1 && id.length <= 20 && [...id].every((c) => c >= '0' && c <= '9') ? id : null;
}

/** Inteiro não negativo de uma contagem da plataforma (vem como texto ou número); 0 fora do formato. */
export function contagem(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

/** Valor decimal não negativo em texto ("12.34"), com até 6 casas; "0" fora do formato. */
export function decimal(v: unknown): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN;
  return Number.isFinite(n) && n >= 0 ? String(Math.round(n * 1_000_000) / 1_000_000) : '0';
}

/** Micros do Google (texto ou número) em unidades da moeda, com 6 casas, em texto. */
export function deMicros(v: unknown): string {
  const s = typeof v === 'number' ? String(Math.trunc(v)) : typeof v === 'string' ? v : '';
  if (!s || ![...s].every((c) => c >= '0' && c <= '9')) return '0';
  const n = BigInt(s);
  const inteiro = n / 1_000_000n;
  let fracao = (n % 1_000_000n).toString().padStart(6, '0');
  while (fracao.endsWith('0')) fracao = fracao.slice(0, -1);
  return fracao ? `${inteiro}.${fracao}` : String(inteiro);
}

/** As linhas da hora com dia e hora válidos, sem repetir (a última vence: a plataforma não manda duas). */
export function horasValidas(linhas: readonly HoraLida[]): HoraLida[] {
  const porChave = new Map<string, HoraLida>();
  for (const l of linhas) if (DIA.test(l.dia) && Number.isInteger(l.hora) && l.hora >= 0 && l.hora <= 23) porChave.set(`${l.dia}|${l.hora}`, l);
  return [...porChave.values()];
}

/** As linhas da cidade com dia e lugar válidos, somadas por dia e lugar (o Google pode repetir o lugar no dia). */
export function cidadesValidas(linhas: readonly CidadeLida[]): CidadeLida[] {
  const porChave = new Map<string, CidadeLida>();
  for (const l of linhas) {
    if (!DIA.test(l.dia) || !idDoLugar(l.lugar)) continue;
    const k = `${l.dia}|${l.lugar}`;
    const antes = porChave.get(k);
    porChave.set(
      k,
      antes
        ? {
            ...antes,
            impressoes: antes.impressoes + l.impressoes,
            cliques: antes.cliques + l.cliques,
            gasto: decimal(Number(antes.gasto) + Number(l.gasto)),
            conversoes: antes.conversoes === null && l.conversoes === null ? null : decimal(Number(antes.conversoes ?? 0) + Number(l.conversoes ?? 0)),
          }
        : l,
    );
  }
  return [...porChave.values()];
}

/** A espera depois de uma falha, pelo tipo (a mesma régua das outras leituras da Meta e do Google). */
export function esperaDaFalhaDaMidia(tipo: string, esperarMs: number | null): number {
  const HORA = 3_600_000;
  if (tipo === 'permissao' || tipo === 'autenticacao') return 24 * HORA;
  if (tipo === 'limite') return Math.max(esperarMs ?? 0, HORA);
  if (tipo === 'definitivo') return 6 * HORA;
  return HORA;
}
