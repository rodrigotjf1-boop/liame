import { z } from 'zod';

// O CEP pelo ViaCEP (plano da região, R1; base de conhecimento §19.2): do CEP saem a rua, o bairro, o município, a UF e
// o código IBGE do município, que é a chave das fontes públicas da região. Sem credencial; endereço fixo, sem
// redirecionamento, com prazo e limite de tamanho (o mesmo cuidado da PTAX, D-A3-14). Nada aqui grava.

/** O único site de onde o CEP vem. */
export const HOST_DO_CEP = 'viacep.com.br';
const LIMITE_BYTES = 8_000;
/** Identifica o Liame para quem responde (o nome não leva "user": V101). */
export const IDENTIFICACAO_DO_LIAME = 'Liame/1.0 (+https://agencialiame.com)';

/** O CEP só com os 8 dígitos ("21615-000" → "21615000"), ou nulo fora do formato. */
export function cepNormalizado(texto: string): string | null {
  const t = texto.trim();
  if (t.length === 9 && t[5] === '-') return cepNormalizado(t.slice(0, 5) + t.slice(6));
  if (t.length !== 8) return null;
  for (const c of t) if (c < '0' || c > '9') return null;
  // "00000000" não é CEP de ninguém.
  return t === '00000000' ? null : t;
}

export function enderecoDoCep(cep: string): string {
  return `https://${HOST_DO_CEP}/ws/${cep}/json/`;
}

export interface EnderecoDoCep {
  cep: string;
  /** Nula quando o CEP é geral do município (o ViaCEP não dá a rua). */
  rua: string | null;
  bairro: string | null;
  cidade: string;
  uf: string;
  codigoIbge: string;
}

const textoOuNulo = (v: string | undefined): string | null => {
  const t = (v ?? '').trim();
  return t ? t.slice(0, 200) : null;
};

const RespostaDoViaCep = z.object({
  cep: z.string().max(9),
  logradouro: z.string().max(300).optional(),
  bairro: z.string().max(300).optional(),
  localidade: z.string().min(1).max(200),
  uf: z.string().regex(/^[A-Z]{2}$/),
  ibge: z.string().regex(/^[0-9]{7}$/),
});

export type LeituraDoCep = { situacao: 'achado'; endereco: EnderecoDoCep } | { situacao: 'nao_achado' } | { situacao: 'fora_do_ar' };

/** O que o ViaCEP respondeu, já conferido: o CEP que não existe volta `{ "erro": true }` (ou `"true"`). */
export function lerRespostaDoCep(cep: string, json: unknown): LeituraDoCep {
  if (json && typeof json === 'object' && 'erro' in json) return { situacao: 'nao_achado' };
  const r = RespostaDoViaCep.safeParse(json);
  if (!r.success) return { situacao: 'fora_do_ar' };
  if (cepNormalizado(r.data.cep) !== cep) return { situacao: 'fora_do_ar' };
  return {
    situacao: 'achado',
    endereco: { cep, rua: textoOuNulo(r.data.logradouro), bairro: textoOuNulo(r.data.bairro), cidade: r.data.localidade.trim(), uf: r.data.uf, codigoIbge: r.data.ibge },
  };
}

/** Lê um CEP no ViaCEP. Falha de rede, resposta fora do formato ou HTTP de erro voltam `fora_do_ar` (a pessoa tenta de novo). */
export async function buscarCep(cep: string, tempoLimiteMs = 6_000): Promise<LeituraDoCep> {
  try {
    const r = await fetch(enderecoDoCep(cep), { redirect: 'error', signal: AbortSignal.timeout(tempoLimiteMs), headers: { accept: 'application/json', 'user-agent': IDENTIFICACAO_DO_LIAME } });
    if (!r.ok) {
      await r.body?.cancel();
      // O ViaCEP responde 400 ao CEP fora do formato; aqui ele já chega conferido, então 400 é CEP que não existe.
      return r.status === 400 ? { situacao: 'nao_achado' } : { situacao: 'fora_do_ar' };
    }
    const texto = await r.text();
    if (texto.length > LIMITE_BYTES) return { situacao: 'fora_do_ar' };
    return lerRespostaDoCep(cep, JSON.parse(texto) as unknown);
  } catch {
    return { situacao: 'fora_do_ar' };
  }
}
