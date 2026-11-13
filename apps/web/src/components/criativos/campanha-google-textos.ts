import type { AdPieceResponse, BrandPhoto, GoogleCampaignOptionsResponse, GoogleCampaignResponse } from '@liame/contracts';
import { microsDeReais } from '@/components/links/cupons-textos';
import type { Problema } from '@/lib/api';
import { reaisDeMicros } from '@/lib/formato';

// A campanha nova no Google (A5, Y9, parte 5b; P45 pré-aprovado em 12/11/2026, D-A5-21 a D-A5-32): o que a gaveta confere
// antes de mandar (as mesmas regras do servidor, para a pessoa ver o erro no campo certo sem esperar a volta), os
// recortes da foto (os mesmos números do servidor e do P45) e os textos que a gaveta traz da peça. Funções puras.

/** Os limites do grupo de recursos da Performance Max (os mesmos de `campanha-google-plano.ts`). */
export const LIMITES_DO_GOOGLE = {
  titulo: 30,
  titulos: [3, 15],
  tituloLongo: 90,
  titulosLongos: [1, 5],
  descricao: 90,
  descricoes: [2, 5],
  nomeDaLoja: 25,
  logoMinimo: 128,
} as const;

const tamanho = (t: string) => [...t].length;

/** Os recortes da foto: a deitada e a quadrada obrigatórias; a em pé só quando cabe. */
const RECORTES = [
  { id: 'deitada', rotulo: 'Deitada 1,91:1', proporcao: 1.91, minLargura: 600, minAltura: 314, obrigatorio: true },
  { id: 'quadrada', rotulo: 'Quadrada 1:1', proporcao: 1, minLargura: 300, minAltura: 300, obrigatorio: true },
  { id: 'em_pe', rotulo: 'Em pé 4:5', proporcao: 0.8, minLargura: 480, minAltura: 600, obrigatorio: false },
] as const;
export type Recorte = { id: (typeof RECORTES)[number]['id']; rotulo: string; largura: number; altura: number; ok: boolean; obrigatorio: boolean; minLargura: number; minAltura: number };

/** O maior pedaço da foto em cada proporção, pelo centro, e se ele alcança o mínimo do Google. */
export function recortesDaFoto(largura: number, altura: number): Recorte[] {
  return RECORTES.map((r) => {
    const l = Math.min(largura, Math.round(altura * r.proporcao));
    const a = Math.round(l / r.proporcao);
    return { id: r.id, rotulo: r.rotulo, largura: l, altura: a, ok: l >= r.minLargura && a >= r.minAltura, obrigatorio: r.obrigatorio, minLargura: r.minLargura, minAltura: r.minAltura };
  });
}

const NOME_DO_RECORTE: Record<Recorte['id'], string> = { deitada: 'deitado', quadrada: 'quadrado', em_pe: 'em pé' };

/** Por que a foto não serve (pequena para um recorte obrigatório); nulo quando serve. As palavras do servidor. */
export function motivoDaFotoPequena(largura: number, altura: number): string | null {
  const ruim = recortesDaFoto(largura, altura).find((r) => r.obrigatorio && !r.ok);
  if (!ruim) return null;
  return `A foto é pequena para o recorte ${NOME_DO_RECORTE[ruim.id]}: o Google pede pelo menos ${ruim.minLargura} × ${ruim.minAltura}, e o maior recorte desta foto dá ${ruim.largura} × ${ruim.altura}. Use outra foto.`;
}

export type TextosDaGaveta = { titulos: string[]; longo: string; descricoes: string[] };

/** A primeira frase de um texto (até o ponto, a exclamação ou a interrogação), com o sinal dela. */
function primeiraFraseComSinal(t: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(t.trim());
  return (m ? m[1]! : t).trim();
}

const igual = (a: string, b: string): boolean => a.toLocaleLowerCase('pt-BR') === b.toLocaleLowerCase('pt-BR');

/**
 * Os textos que a gaveta traz da peça aprovada (D-A5-22), para a pessoa ajustar ou pedir ao Criativo: os títulos (o
 * título da peça, a primeira frase do texto e o convite ao cardápio), o título longo (o título com a primeira frase) e
 * as descrições (o texto da peça e o convite). **Só entra o que cabe no tamanho do Google** (D-A5-33): a peça foi escrita
 * para a Meta, com 125 caracteres no texto, e a gaveta abria com os campos já em vermelho. O que não cabe dá lugar à
 * versão mais curta que a própria peça tem (a primeira frase, ou o título); sem nenhuma, o campo vem vazio, para a pessoa
 * escrever ou pedir ao Criativo. Nada é cortado no meio: o texto conferido pelo Compliance entra inteiro ou não entra.
 */
export function textosDaPeca(peca: Pick<AdPieceResponse['current'], 'title' | 'body'>): TextosDaGaveta {
  const L = LIMITES_DO_GOOGLE;
  const cabe = (t: string, max: number): boolean => t !== '' && tamanho(t) <= max;
  const titulo = peca.title.trim();
  const corpo = peca.body.trim();
  const fraseComSinal = primeiraFraseComSinal(corpo);
  const frase = fraseComSinal.replace(/[.!?]$/, '').trim();
  const titulos: string[] = [];
  for (const t of [titulo, frase, 'Peça pelo cardápio online']) if (cabe(t, L.titulo) && !titulos.some((x) => igual(x, t))) titulos.push(t);
  while (titulos.length < L.titulos[0]) titulos.push('');
  const comAFrase = frase && !igual(frase, titulo) ? `${titulo}: ${frase}` : titulo;
  const longo = [comAFrase, frase, titulo].find((t) => cabe(t, L.tituloLongo)) ?? '';
  const convite = 'Peça pelo cardápio online.';
  const descricao = [corpo, fraseComSinal].find((t) => cabe(t, L.descricao) && !igual(t, convite)) ?? '';
  return { titulos, longo, descricoes: descricao ? [descricao, convite] : [convite, ''] };
}

export type CampoDoGoogle = 'titulos' | 'longo' | 'descricoes' | 'foto' | 'loja' | 'nome' | 'verba' | 'fim';
export type ErrosDoGoogle = Partial<Record<CampoDoGoogle, string>>;

/** Os textos do Google e o campo da recusa (as mesmas regras e palavras do servidor); nulo quando servem. */
export function motivoDosTextos(t: TextosDaGaveta): { campo: 'titulos' | 'longo' | 'descricoes'; motivo: string } | null {
  const L = LIMITES_DO_GOOGLE;
  const grupos = [
    { campo: 'titulos' as const, itens: t.titulos, faixa: L.titulos, max: L.titulo, nome: ['título', 'títulos'] },
    { campo: 'longo' as const, itens: [t.longo], faixa: L.titulosLongos, max: L.tituloLongo, nome: ['título longo', 'títulos longos'] },
    { campo: 'descricoes' as const, itens: t.descricoes, faixa: L.descricoes, max: L.descricao, nome: ['descrição', 'descrições'] },
  ];
  for (const g of grupos) {
    const itens = g.itens.map((x) => x.trim());
    if (itens.some((x) => !x)) return { campo: g.campo, motivo: `Há ${g.nome[0]} vazio: escreva ou tire.` };
    if (itens.length < g.faixa[0]) return { campo: g.campo, motivo: `O Google pede pelo menos ${g.faixa[0]} ${g.faixa[0] === 1 ? g.nome[0] : g.nome[1]}.` };
    if (itens.length > g.faixa[1]) return { campo: g.campo, motivo: `O Google aceita até ${g.faixa[1]} ${g.nome[1]}.` };
    const longo = itens.find((x) => tamanho(x) > g.max);
    if (longo) return { campo: g.campo, motivo: `“${longo}” tem ${tamanho(longo)} caracteres: ${g.nome[0] === 'descrição' ? 'a descrição vai' : `o ${g.nome[0]} vai`} até ${g.max}.` };
    if (new Set(itens.map((x) => x.toLocaleLowerCase('pt-BR'))).size < itens.length) return { campo: g.campo, motivo: `Há ${g.nome[1]} repetidos: o Google recusa o mesmo texto duas vezes.` };
  }
  return null;
}

export type CamposDoGoogle = TextosDaGaveta & { foto: string | null; loja: string | null; nome: string; raio: number; verba: string; fim: string };

/** Tudo o que o servidor confere e a gaveta já sabe, no campo de cada um (o que depende do banco fica com o servidor). */
export function conferirCampanhaGoogle(c: CamposDoGoogle, opcoes: GoogleCampaignOptionsResponse, fotos: BrandPhoto[], hoje: string): ErrosDoGoogle {
  const e: ErrosDoGoogle = {};
  const textos = motivoDosTextos(c);
  if (textos) e[textos.campo] = textos.motivo;
  const f = fotos.find((x) => x.id === c.foto);
  if (!f) e.foto = 'Escolha uma foto de Fotos.';
  else {
    const pequena = motivoDaFotoPequena(f.width, f.height);
    if (pequena) e.foto = pequena;
  }
  const loja = opcoes.units.find((u) => u.id === c.loja);
  if (!loja) e.loja = 'Escolha a loja.';
  else if (!loja.has_address) e.loja = 'A campanha mostra o anúncio em volta da loja, e o ponto dela ainda não está no endereço. Ajuste o endereço da loja em Minha marca antes.';
  else if (!loja.menu_available) e.loja = loja.menu_block ?? 'A loja não tem o cardápio online ligado ao Liame: no Google, o anúncio leva ao cardápio.';
  if (!c.nome.trim()) e.nome = 'Dê um nome à campanha.';
  else if (tamanho(c.nome.trim()) > 80) e.nome = 'O nome vai até 80 caracteres.';
  const micros = microsDeReais(c.verba);
  if (micros === null || BigInt(micros) < 10_000n) e.verba = 'Digite a verba diária em reais, como 30,00.';
  else if (opcoes.campaign_cap_micros !== null && BigInt(micros) > BigInt(opcoes.campaign_cap_micros)) {
    e.verba = `A verba diária passa do teto por campanha, que é de ${reaisDeMicros(BigInt(opcoes.campaign_cap_micros))} por dia. Quem muda o teto é o Dono ou o Administrador, em Verba do mês.`;
  }
  if (c.fim && c.fim <= hoje) e.fim = 'A data de fim precisa ser depois de hoje.';
  return e;
}

/** A recusa do servidor no campo certo (o `code` e, nos textos, o campo do erro); o resto vai no erro geral da gaveta. */
export function erroDoPedidoGoogle(p: Problema): { campo: CampoDoGoogle | null; texto: string } {
  const texto = p.detail ?? p.title ?? 'Não foi possível pedir a campanha agora.';
  if (p.code === 'textos-do-google') {
    const caminho = (p.errors as { path?: string }[] | undefined)?.[0]?.path;
    const campo = caminho === 'headlines' ? 'titulos' : caminho === 'long_headlines' ? 'longo' : caminho === 'descriptions' ? 'descricoes' : null;
    return { campo, texto };
  }
  const porCodigo: Record<string, CampoDoGoogle> = {
    'midia-fora-das-fotos': 'foto',
    'nao-e-foto': 'foto',
    'foto-pequena': 'foto',
    'loja-nao-encontrada': 'loja',
    'loja-sem-endereco': 'loja',
    'sem-cardapio': 'loja',
    'verba-invalida': 'verba',
    'acima-do-teto': 'verba',
    'fim-no-passado': 'fim',
  };
  return { campo: (p.code && porCodigo[p.code]) || null, texto };
}

/** O nome do lugar do anúncio na prévia: o endereço do cardápio, sem o protocolo. */
export function enderecoDaPrevia(link: string | null): string {
  if (!link) return 'o cardápio online da loja';
  return link.replace(/^https?:\/\//, '').replace(/\/$/, '').replace(/\//g, ' › ');
}

/** As ferramentas da campanha nova no Google, para Aprovações. */
export const FERRAMENTAS_DA_CAMPANHA_GOOGLE = ['campanha_google_criar', 'campanha_google_ativar', 'campanha_google_pausar'] as const;

/** O id da campanha nova no Google no recurso do pedido (`campanha_google:<id>`). */
export function idDaCampanhaGoogle(resourceId: string | null | undefined): string | null {
  const m = /^campanha_google:([0-9a-f-]{36})$/i.exec(resourceId ?? '');
  return m ? m[1]! : null;
}

/** O Google Ads (o mesmo endereço de Resultados): o link direto para uma campanha depende de um id interno do Google. */
export const LINK_DO_GOOGLE_ADS = 'https://ads.google.com/';

/** Em que pé está a campanha nova no Google, para a etiqueta (as mesmas palavras e tons da campanha na Meta). */
export function situacaoDaCampanhaGoogle(c: Pick<GoogleCampaignResponse, 'status' | 'active'>): { rotulo: string; tom: 'aguardando' | 'trabalhando' | 'concluido' | 'pausado' | 'perigo' | 'neutro' } {
  if (c.status === 'criada') return c.active ? { rotulo: 'Ativa no Google', tom: 'concluido' } : { rotulo: 'Criada e pausada', tom: 'neutro' };
  if (c.status === 'criando') return { rotulo: 'Criando no Google', tom: 'trabalhando' };
  if (c.status === 'nao_criada') return { rotulo: 'Não criada', tom: 'perigo' };
  if (c.status === 'cancelada') return { rotulo: 'Cancelada', tom: 'neutro' };
  return { rotulo: 'Espera a aprovação', tom: 'aguardando' };
}
