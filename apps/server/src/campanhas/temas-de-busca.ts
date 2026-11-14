import type { BaseDaPeca } from '../ai/criativo/peca.js';
import { conferirPeca } from '../ai/criativo/peca.js';
import { mensagemDoAchado } from '../criativo/base.js';
import { nomeComparavel } from '../regiao/coordenada.js';

// Os temas de busca da campanha do Google (plano da região, R9; protótipo do Google pela região aprovado pelo dono em
// 13/11/2026; D-RG-85 e D-RG-86). A Performance Max passa a levar temas de busca, montados por regra, sem IA: o que a
// loja vende (a categoria principal do Perfil da Empresa no Google e os "termos de busca da loja" de Minha marca, até 3)
// com "perto de mim", o segundo termo com "delivery", e depois os bairros de quem vê — um tema por bairro primeiro, o
// segundo de cada bairro enquanto couber no limite. A lista nunca corta em silêncio: diz quais bairros ficaram com um
// tema só e quais ficaram sem nenhum. Cada tema passa pela mesma conferência dos títulos e das descrições do Google.
// Partes puras: sem rede e sem banco. O tema é pista para o Google, não garantia.

/**
 * Os limites de partida dos temas: até 25 por grupo de recursos e até 80 caracteres cada. Ficam "a conferir" (D-RG-89):
 * a referência da API fala em 25, a Central de Ajuda do Google Ads diz que o limite subiu para 50, e o tamanho de 80
 * vem da ajuda do Search Ads 360. Vale o menor até um teste que só valida (`validate_only`) na conta real.
 */
export const LIMITE_DE_TEMAS = 25;
export const TAMANHO_DO_TEMA = 80;
/** Até 3 termos escritos por uma pessoa em Minha marca (D-RG-85), além da categoria do perfil. */
export const TERMOS_DA_LOJA_MAXIMOS = 3;

/** Um termo do que a loja vende e de onde veio (a tela diz a fonte). */
export type TermoDaLoja = { termo: string; fonte: 'perfil' | 'minha_marca' };

/**
 * Os termos da loja, na ordem: a categoria principal do perfil (quando ligado) e os de Minha marca (até 3). Sem espaço
 * sobrando, sem repetir (sem diferença de acento e de maiúscula), sem vazio. A lista pode ficar vazia: a gaveta pede os termos.
 */
export function termosDaLoja(categoria: string | null, deMinhaMarca: readonly string[]): TermoDaLoja[] {
  const vistos = new Set<string>();
  const saida: TermoDaLoja[] = [];
  const pegar = (bruto: string | null | undefined, fonte: TermoDaLoja['fonte']) => {
    const termo = (bruto ?? '').replace(/\s+/g, ' ').trim().slice(0, TAMANHO_DO_TEMA);
    if (!termo) return;
    const chave = nomeComparavel(termo);
    if (vistos.has(chave)) return;
    vistos.add(chave);
    saida.push({ termo, fonte });
  };
  pegar(categoria, 'perfil');
  for (const t of deMinhaMarca.slice(0, TERMOS_DA_LOJA_MAXIMOS)) pegar(t, 'minha_marca');
  return saida;
}

export type TemasMontados = {
  temas: string[];
  /**
   * Os bairros que ficaram com um tema só e os que ficaram sem nenhum pelo limite, e os de nome tão longo que o tema
   * passaria do tamanho, para a tela dizer.
   */
  corte: { comUmSo: string[]; semNenhum: string[]; longos: string[] };
};

/**
 * A lista de temas, por regra (D-RG-85, como no protótipo aprovado): cada termo com "perto de mim"; o segundo termo (ou o
 * primeiro, se só há um) com "delivery"; um tema por bairro (o primeiro termo e o bairro) enquanto couber; depois o
 * segundo de cada bairro ("delivery de" o segundo termo e o bairro), enquanto couber. Sem termo, a lista é vazia. O mesmo
 * tema não entra duas vezes, e nenhum passa do tamanho.
 */
export function montarTemas(termos: readonly TermoDaLoja[], bairros: readonly string[], limite = LIMITE_DE_TEMAS): TemasMontados {
  const corte = { comUmSo: [] as string[], semNenhum: [] as string[], longos: [] as string[] };
  if (!termos.length) return { temas: [], corte };
  const a = termos[0]!.termo;
  const b = (termos[1] ?? termos[0]!).termo;
  const temas: string[] = [];
  const vistos = new Set<string>();
  /** Põe o tema na lista: `ok` (entrou, ou já estava), `longo` (passaria do tamanho) ou `cheio` (a lista chegou ao limite). */
  const por = (t: string): 'ok' | 'longo' | 'cheio' => {
    const tema = t.replace(/\s+/g, ' ').trim();
    if ([...tema].length > TAMANHO_DO_TEMA) return 'longo';
    const chave = nomeComparavel(tema);
    if (vistos.has(chave)) return 'ok';
    if (temas.length >= limite) return 'cheio';
    vistos.add(chave);
    temas.push(tema);
    return 'ok';
  };
  for (const t of termos) por(`${t.termo} perto de mim`);
  por(`${b} delivery`);
  const nomes = [...new Set(bairros.map((n) => n.replace(/\s+/g, ' ').trim()).filter(Boolean))];
  for (const n of nomes) {
    const r = por(`${a} ${n}`);
    if (r === 'longo') corte.longos.push(n);
    else if (r === 'cheio') corte.semNenhum.push(n);
  }
  for (const n of nomes) {
    if (corte.semNenhum.includes(n) || corte.longos.includes(n)) continue;
    if (por(`delivery de ${b} ${n}`) !== 'ok') corte.comUmSo.push(n);
  }
  return { temas, corte };
}

const listaEscrita = (n: readonly string[]) => (n.length < 2 ? n.join('') : `${n.slice(0, -1).join(', ')} e ${n.at(-1)}`);

/** A frase de onde a lista parou; vazia quando coube tudo (a lista nunca corta em silêncio). */
export function fraseDoCorte(m: TemasMontados, limite = LIMITE_DE_TEMAS): string {
  const { comUmSo, semNenhum, longos } = m.corte;
  const frases: string[] = [];
  if (comUmSo.length || semNenhum.length) {
    const partes = [
      semNenhum.length ? `${listaEscrita(semNenhum)} ${semNenhum.length === 1 ? 'ficou' : 'ficaram'} sem tema` : '',
      comUmSo.length ? `${listaEscrita(comUmSo)} ${comUmSo.length === 1 ? 'ficou' : 'ficaram'} com um tema só` : '',
    ].filter(Boolean);
    frases.push(`A lista parou em ${limite} temas: ${partes.join('; ')}. Tire um tema para pôr outro.`);
  }
  if (longos.length) frases.push(`${listaEscrita(longos)} ${longos.length === 1 ? 'ficou' : 'ficaram'} sem tema: o nome deixaria o tema com mais de ${TAMANHO_DO_TEMA} caracteres. Escreva um tema mais curto, se quiser.`);
  return frases.join(' ');
}

/** O que impede um tema, nas palavras da conferência dos textos; nulo quando passa. */
export type ProblemaDoTema = { indice: number; tema: string; motivo: string };

/**
 * A conferência dos temas (D-RG-86): a mesma dos títulos e das descrições do Google (sem nome de concorrente, sem dado
 * pessoal, sem promessa que a loja não prova, sem o que a marca não diz), mais o tamanho, a lista vazia, o limite e o
 * tema repetido. O primeiro problema basta para não deixar pedir; a tela diz qual tema e por quê.
 */
export function problemaDosTemas(temas: readonly string[], base: BaseDaPeca, limite = LIMITE_DE_TEMAS): ProblemaDoTema | null {
  if (temas.length > limite) return { indice: limite, tema: temas[limite]!, motivo: `O Google aceita até ${limite} temas por campanha: tire ${temas.length - limite} ${temas.length - limite === 1 ? 'tema' : 'temas'}.` };
  const vistos = new Map<string, number>();
  for (const [indice, bruto] of temas.entries()) {
    const tema = bruto.replace(/\s+/g, ' ').trim();
    if (!tema) return { indice, tema: bruto, motivo: 'O tema está vazio: escreva o tema ou tire a linha.' };
    if ([...tema].length > TAMANHO_DO_TEMA) return { indice, tema, motivo: `O tema passa de ${TAMANHO_DO_TEMA} caracteres.` };
    const chave = nomeComparavel(tema);
    const antes = vistos.get(chave);
    if (antes !== undefined) return { indice, tema, motivo: `O tema repete o tema ${antes + 1}.` };
    vistos.set(chave, indice);
    const c = conferirPeca({ titulo: '', texto: tema }, base, 'pessoa');
    const achado = c.itens.filter((i) => i.item !== 'tamanho' && i.situacao === 'barrou').flatMap((i) => i.achados)[0];
    if (achado) return { indice, tema, motivo: mensagemDoAchado(achado) };
  }
  return null;
}
