import { plataforma } from '@/components/contas/textos';

// Como as frases da Verba do mês chamam cada plataforma de anúncio ("a Meta não foi lida", "o gasto do Google",
// "mudado na Meta", "falta ler a Meta", "a parte dela"). Fica à parte porque as frases (`textos.ts`), a divisão por
// plataforma (`divisao.ts`) e os desenhos (`graficos.ts`) usam os mesmos nomes.

export type NaFrase = { nome: string; a: string; da: string; na: string; lida: string; dela: string };

const NA_FRASE: Record<string, NaFrase> = {
  meta_ads: { nome: 'Meta', a: 'a Meta', da: 'da Meta', na: 'na Meta', lida: 'lida', dela: 'dela' },
  google_ads: { nome: 'Google', a: 'o Google', da: 'do Google', na: 'no Google', lida: 'lido', dela: 'dele' },
};

export function naFrase(provider: string): NaFrase {
  const conhecida = NA_FRASE[provider];
  if (conhecida) return conhecida;
  const nome = plataforma(provider).nome;
  return { nome, a: nome, da: `de ${nome}`, na: `em ${nome}`, lida: 'lida', dela: 'dela' };
}
