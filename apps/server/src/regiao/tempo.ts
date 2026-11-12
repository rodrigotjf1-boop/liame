import { z } from 'zod';
import { nomeComparavel } from './coordenada.js';
import { digitos } from './ibge.js';

// A semana que vem (plano da região, R2, parte 5; protótipo P40): a previsão do tempo por dia do CPTEC/INPE, pela
// BrasilAPI (base §19.2). Duas leituras por município com loja no mapa: o código da cidade no CPTEC (pelo nome e a UF,
// uma vez a cada 6 meses) e a previsão dos próximos 6 dias (a cada 6 horas). A BrasilAPI recebe só o nome do
// município e o código da cidade do CPTEC, que são públicos; nada da loja.

export const HOST_DA_BRASILAPI = 'brasilapi.com.br';
export const FONTE_DA_CIDADE_DO_CPTEC = 'cptec_cidade';
export const FONTE_DA_PREVISAO = 'cptec_previsao';
/** Quantos dias a previsão traz (o máximo da BrasilAPI). */
export const DIAS_DA_PREVISAO = 6;

export function enderecoDaCidadeDoCptec(nome: string): string {
  return `https://${HOST_DA_BRASILAPI}/api/cptec/v1/cidade/${encodeURIComponent(nome.trim())}`;
}

export function enderecoDaPrevisao(cidade: number): string {
  return `https://${HOST_DA_BRASILAPI}/api/cptec/v1/clima/previsao/${cidade}/${DIAS_DA_PREVISAO}`;
}

const RespostaDaCidade = z
  .array(z.object({ nome: z.string().min(1).max(120), id: z.number().int().positive(), estado: z.string().length(2) }))
  .max(500);

/** O código da cidade no CPTEC: o mesmo nome (sem acento e sem caixa) na mesma UF; nulo se não houver. */
export function cidadeDoCptec(corpo: unknown, nome: string, uf: string): number | null {
  const r = RespostaDaCidade.safeParse(corpo);
  if (!r.success) return null;
  const alvo = nomeComparavel(nome);
  const achada = r.data.find((c) => c.estado.toUpperCase() === uf.toUpperCase() && nomeComparavel(c.nome) === alvo);
  return achada?.id ?? null;
}

export interface DiaDaPrevisao {
  /** "AAAA-MM-DD". */
  dia: string;
  /** O código da condição no CPTEC ("c", "pn", "ps"…). */
  condicao: string;
  /** A condição por extenso, como o CPTEC escreve ("Parcialmente Nublado"). */
  descricao: string;
  min: number;
  max: number;
}

const RespostaDaPrevisao = z.object({
  clima: z
    .array(
      z.object({
        data: z.string().length(10),
        condicao: z.string().min(1).max(4),
        condicao_desc: z.string().min(1).max(80),
        min: z.number().int().min(-30).max(60),
        max: z.number().int().min(-30).max(60),
      }),
    )
    .max(15),
});

function ehDia(texto: string): boolean {
  return texto.length === 10 && digitos(texto.slice(0, 4), 4) && texto[4] === '-' && digitos(texto.slice(5, 7), 2) && texto[7] === '-' && digitos(texto.slice(8), 2);
}

function soLetras(texto: string): boolean {
  for (const c of texto) if (c < 'a' || c > 'z') return false;
  return texto.length > 0;
}

/** Os dias da previsão, conferidos (data de verdade, código só com letras, mínima não maior que a máxima). */
export function previsaoDaResposta(corpo: unknown): DiaDaPrevisao[] {
  const r = RespostaDaPrevisao.safeParse(corpo);
  if (!r.success) return [];
  return r.data.clima
    .filter((d) => ehDia(d.data) && soLetras(d.condicao) && d.min <= d.max)
    .map((d) => ({ dia: d.data, condicao: d.condicao, descricao: d.condicao_desc.trim(), min: d.min, max: d.max }));
}
