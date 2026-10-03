import type { BrandDossierContent, BrandDossierSuggestion, BrandDossierSuggestionItem, BrandDossierVersionMeta, DossierSection, SystemProof } from '@liame/contracts';
import type { NomeIcone } from '@/components/ui/icone';
import { quandoComHora } from '@/lib/formato';

// Regras e frases de Minha marca (A3 · P6, aprovado em 03/10/2026; mockups/prototipo-marca.html): o dossiê que os
// funcionários de IA leem. O conteúdo, as versões, as sugestões e o teste de frase vêm de `/v1/brand-dossier`; a
// tela só os mostra e monta o que a pessoa vai salvar.

// ------------------------------------------------------------------ as nove partes

export type Secao = {
  id: DossierSection;
  icone: NomeIcone;
  titulo: string;
  /** A pergunta do passo, no preenchimento guiado (com o nome da marca). */
  pergunta: (marca: string) => string;
  ajuda: string;
  /** O que falta quando a parte está vazia. */
  vazia: string;
};

export const SECOES: Secao[] = [
  { id: 'identidade', icone: 'target', titulo: 'Identidade', pergunta: (m) => `O que é a ${m}, e para quem?`, ajuda: 'Em poucas palavras, como você explicaria a loja para quem nunca pediu.', vazia: 'Os funcionários não sabem o que a casa é nem para quem.' },
  { id: 'voz', icone: 'megaphone', titulo: 'Voz', pergunta: (m) => `Como a ${m} fala?`, ajuda: 'Até quatro jeitos de falar, as regras de escrita e um exemplo de como sim e de como não.', vazia: 'Sem a voz, os textos saem no jeito padrão da LIA.' },
  { id: 'produtos', icone: 'utensils', titulo: 'Produtos', pergunta: () => 'O que a casa mais vende e quer vender?', ajuda: 'Os carros-chefe. O Liame sugere a partir das vendas do Regem.', vazia: 'Sem os carros-chefe, os funcionários não sabem o que destacar.' },
  { id: 'ofertas', icone: 'ticket', titulo: 'Ofertas', pergunta: () => 'Que ofertas valem hoje?', ajuda: 'Combos e cupons em vigor. O Liame sugere a partir dos cupons ligados às campanhas.', vazia: 'Nenhuma oferta em vigor registrada.' },
  { id: 'provas', icone: 'award', titulo: 'Provas', pergunta: (m) => `O que a ${m} pode provar?`, ajuda: 'Só o que for verdade e der para mostrar: número do caixa, nota em plataforma, prêmio.', vazia: 'Sem prova, os textos não citam número nem nota.' },
  { id: 'proibido', icone: 'ban', titulo: 'O que não pode dizer', pergunta: () => 'O que a marca nunca diz?', ajuda: 'Frases e palavras que os funcionários de IA não podem usar. As regras da Liame valem para todas as marcas e não saem.', vazia: '' },
  { id: 'concorrentes', icone: 'users', titulo: 'Concorrentes', pergunta: (m) => `Com quem a ${m} disputa o cliente?`, ajuda: 'Para entender o mercado. Os funcionários não citam concorrente pelo nome em anúncio.', vazia: 'Nenhum concorrente registrado.' },
  { id: 'regiao', icone: 'map-pin', titulo: 'Região', pergunta: (m) => `Onde a ${m} atende?`, ajuda: 'Onde entrega e se tem retirada no balcão.', vazia: 'Os funcionários não sabem onde a casa entrega.' },
  { id: 'datas', icone: 'calendar', titulo: 'Datas e sazonalidade', pergunta: () => 'Quando a casa vende mais e menos?', ajuda: 'Dias fortes, datas do ano e o que costuma mudar.', vazia: 'Sem as datas, o calendário não sabe quando a casa vende mais.' },
];

export const SECAO: Record<DossierSection, Secao> = Object.fromEntries(SECOES.map((s) => [s.id, s])) as Record<DossierSection, Secao>;

/** Os jeitos de falar que a tela oferece (até quatro). */
export const JEITOS = ['Descontraída', 'Direta', 'Calorosa', 'Brincalhona', 'Acolhedora', 'Ousada', 'Elegante', 'Técnica'];
export const MAX_JEITOS = 4;

/** As regras da Liame, como o servidor as nomeia no teste de frase: valem para todas as marcas e não saem. */
export const REGRAS_LIAME: Array<{ texto: string; motivo: string }> = [
  { texto: 'Conteúdo político ou eleitoral', motivo: 'proibido em campanha, texto e conversa (Termos da Liame)' },
  { texto: 'Promessa de resultado', motivo: 'ninguém garante venda nem lucro (CDC e CONAR)' },
  { texto: 'Categoria que as plataformas proíbem', motivo: 'armas, cigarro e vape, apostas, drogas' },
  { texto: 'Dado pessoal de cliente', motivo: 'telefone, e-mail e documento não entram em texto feito por IA' },
];

// ------------------------------------------------------------------ o conteúdo

export function conteudoVazio(): BrandDossierContent {
  return {
    identity: { summary: '', audience: '', differentiator: '', since: '' },
    voice: { traits: [], rules: [], do_example: '', dont_example: '' },
    products: { items: [] },
    offers: { items: [] },
    proof: { stated: [] },
    forbidden: { items: [] },
    competitors: { items: [] },
    region: { area: '', pickup: false },
    seasonality: { items: [] },
  };
}

export function copiar(c: BrandDossierContent): BrandDossierContent {
  return structuredClone(c);
}

/** Para comparar textos como o servidor: sem acento, minúsculas e espaços simples. */
export function chave(texto: string): string {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Os textos de uma parte (o que conta para "preenchida" e para comparar versões). */
export function itensDe(id: DossierSection, c: BrandDossierContent, provas: SystemProof[] = []): string[] {
  switch (id) {
    case 'identidade':
      return [c.identity.summary, c.identity.audience, c.identity.differentiator, c.identity.since].filter(Boolean);
    case 'voz':
      return [...c.voice.traits, ...c.voice.rules, c.voice.do_example, c.voice.dont_example].filter(Boolean);
    case 'produtos':
      return [...c.products.items];
    case 'ofertas':
      return [...c.offers.items];
    case 'provas':
      return [...provas.map((p) => p.text), ...c.proof.stated.map((p) => p.text)];
    case 'proibido':
      return c.forbidden.items.map((i) => i.text);
    case 'concorrentes':
      return c.competitors.items.map((i) => i.text);
    case 'regiao':
      return [c.region.area, c.region.pickup ? 'Retirada no balcão' : ''].filter(Boolean);
    case 'datas':
      return [...c.seasonality.items];
  }
}

/** A parte está vazia? (As provas do sistema contam: elas valem sozinhas.) */
export function parteVazia(id: DossierSection, c: BrandDossierContent, provas: SystemProof[] = []): boolean {
  return itensDe(id, c, provas).length === 0;
}

/**
 * O que mudou de uma versão para outra, por parte, em frases curtas ("Produtos: + Onion rings"). É o que a lista de
 * versões mostra ao abrir uma versão antiga (a comparação dela com a que está em uso).
 */
export function mudancasEntre(antes: BrandDossierContent, depois: BrandDossierContent): string[] {
  const out: string[] = [];
  for (const s of SECOES) {
    if (s.id === 'provas') {
      lista(out, s.titulo, antes.proof.stated.map((p) => p.text), depois.proof.stated.map((p) => p.text));
      continue;
    }
    const a = itensDe(s.id, antes);
    const b = itensDe(s.id, depois);
    if (s.id === 'identidade' || s.id === 'regiao') {
      if (a.map(chave).join('|') !== b.map(chave).join('|')) out.push(`${s.titulo}: texto alterado`);
      continue;
    }
    lista(out, s.titulo, a, b);
  }
  return out;
}

function lista(out: string[], titulo: string, a: string[], b: string[]) {
  const ka = new Set(a.map(chave));
  const kb = new Set(b.map(chave));
  const mais = b.filter((x) => !ka.has(chave(x)));
  const menos = a.filter((x) => !kb.has(chave(x)));
  if (mais.length || menos.length) out.push(`${titulo}: ${[...mais.map((x) => `+ ${x}`), ...menos.map((x) => `− ${x}`)].join('; ')}`);
}

/** As partes em que duas versões diferem (para juntar o que duas pessoas salvaram ao mesmo tempo). */
export function partesQueMudaram(antes: BrandDossierContent, depois: BrandDossierContent): DossierSection[] {
  // A ordem das partes é a da tela (a mesma do contrato); o web não importa valores do contrato, só tipos.
  return SECOES.map((s) => s.id).filter((s) => JSON.stringify(parteDe(s, antes)) !== JSON.stringify(parteDe(s, depois)));
}

/** O pedaço do conteúdo que pertence a uma parte (com as chaves sempre na mesma ordem). */
export function parteDe(id: DossierSection, c: BrandDossierContent): unknown {
  switch (id) {
    case 'identidade':
      return [c.identity.summary, c.identity.audience, c.identity.differentiator, c.identity.since];
    case 'voz':
      return [c.voice.traits, c.voice.rules, c.voice.do_example, c.voice.dont_example];
    case 'produtos':
      return c.products.items;
    case 'ofertas':
      return c.offers.items;
    case 'provas':
      return c.proof.stated.map((p) => [p.text, p.why]);
    case 'proibido':
      return c.forbidden.items.map((p) => [p.text, p.why]);
    case 'concorrentes':
      return c.competitors.items.map((p) => [p.text, p.why]);
    case 'regiao':
      return [c.region.area, c.region.pickup];
    case 'datas':
      return c.seasonality.items;
  }
}

/** Põe uma parte de `de` em `em` (o resto de `em` fica como está). */
export function comParte(id: DossierSection, em: BrandDossierContent, de: BrandDossierContent): BrandDossierContent {
  const c = copiar(em);
  const d = copiar(de);
  switch (id) {
    case 'identidade':
      c.identity = d.identity;
      break;
    case 'voz':
      c.voice = d.voice;
      break;
    case 'produtos':
      c.products = d.products;
      break;
    case 'ofertas':
      c.offers = d.offers;
      break;
    case 'provas':
      c.proof = d.proof;
      break;
    case 'proibido':
      c.forbidden = d.forbidden;
      break;
    case 'concorrentes':
      c.competitors = d.competitors;
      break;
    case 'regiao':
      c.region = d.region;
      break;
    case 'datas':
      c.seasonality = d.seasonality;
      break;
  }
  return c;
}

// ------------------------------------------------------------------ listas editáveis

/** As listas da tela: só texto, ou texto com o porquê. */
export type ChaveDeLista = 'voice.rules' | 'products.items' | 'offers.items' | 'seasonality.items' | 'proof.stated' | 'forbidden.items' | 'competitors.items';
export type ItemDeLista = { text: string; why?: string };

export function itensDaLista(c: BrandDossierContent, k: ChaveDeLista): ItemDeLista[] {
  switch (k) {
    case 'voice.rules':
      return c.voice.rules.map((text) => ({ text }));
    case 'products.items':
      return c.products.items.map((text) => ({ text }));
    case 'offers.items':
      return c.offers.items.map((text) => ({ text }));
    case 'seasonality.items':
      return c.seasonality.items.map((text) => ({ text }));
    case 'proof.stated':
      return c.proof.stated.map((i) => ({ ...i }));
    case 'forbidden.items':
      return c.forbidden.items.map((i) => ({ ...i }));
    case 'competitors.items':
      return c.competitors.items.map((i) => ({ ...i }));
  }
}

/** O limite de itens de cada lista (o mesmo do contrato). */
export const LIMITE_DA_LISTA: Record<ChaveDeLista, number> = {
  'voice.rules': 10,
  'products.items': 20,
  'offers.items': 20,
  'seasonality.items': 12,
  'proof.stated': 10,
  'forbidden.items': 30,
  'competitors.items': 10,
};

export function comLista(c: BrandDossierContent, k: ChaveDeLista, itens: ItemDeLista[]): BrandDossierContent {
  const n = copiar(c);
  const textos = itens.map((i) => i.text);
  const comMotivo = itens.map((i) => ({ text: i.text, why: i.why ?? '' }));
  if (k === 'voice.rules') n.voice.rules = textos;
  else if (k === 'products.items') n.products.items = textos;
  else if (k === 'offers.items') n.offers.items = textos;
  else if (k === 'seasonality.items') n.seasonality.items = textos;
  else if (k === 'proof.stated') n.proof.stated = comMotivo;
  else if (k === 'forbidden.items') n.forbidden.items = comMotivo;
  else n.competitors.items = comMotivo;
  return n;
}

/** Acrescentar um item: sem repetir (pelo texto, como o servidor) e sem passar do limite. */
export function acrescentar(c: BrandDossierContent, k: ChaveDeLista, item: ItemDeLista): { conteudo: BrandDossierContent; erro: string | null } {
  const texto = item.text.trim();
  if (!texto) return { conteudo: c, erro: 'Escreva o que quer adicionar.' };
  const atuais = itensDaLista(c, k);
  if (atuais.some((i) => chave(i.text) === chave(texto))) return { conteudo: c, erro: 'Este item já está na lista.' };
  if (atuais.length >= LIMITE_DA_LISTA[k]) return { conteudo: c, erro: `A lista aceita até ${LIMITE_DA_LISTA[k]} itens. Tire um antes de adicionar outro.` };
  return { conteudo: comLista(c, k, [...atuais, { text: texto, why: (item.why ?? '').trim() }]), erro: null };
}

export function tirar(c: BrandDossierContent, k: ChaveDeLista, posicao: number): BrandDossierContent {
  return comLista(
    c,
    k,
    itensDaLista(c, k).filter((_, i) => i !== posicao),
  );
}

/** Marca ou desmarca um jeito de falar (até quatro). */
export function alternarJeito(c: BrandDossierContent, jeito: string): { conteudo: BrandDossierContent; erro: string | null } {
  const tem = c.voice.traits.includes(jeito);
  if (!tem && c.voice.traits.length >= MAX_JEITOS) return { conteudo: c, erro: 'Escolha até quatro jeitos. Tire um antes de marcar outro.' };
  const n = copiar(c);
  n.voice.traits = tem ? n.voice.traits.filter((j) => j !== jeito) : [...n.voice.traits, jeito];
  return { conteudo: n, erro: null };
}

// ------------------------------------------------------------------ sugestões

export type Sinal = 'mais' | 'menos' | 'muda';

export function sinalDe(op: BrandDossierSuggestionItem['op']): Sinal {
  return op === 'incluir' ? 'mais' : op === 'tirar' ? 'menos' : 'muda';
}

/** "Incluir "Onion rings"", "Tirar "Hambúrguer vegano"" ou "Combo sexta → Combo sexta com batata G". */
export function textoDoItem(i: BrandDossierSuggestionItem): string {
  if (i.op === 'incluir') return `Incluir “${i.text}”`;
  if (i.op === 'tirar') return `Tirar “${i.text}”`;
  return i.before ? `${i.before} → ${i.text}` : `Trocar por “${i.text}”`;
}

/** Quem sugeriu: o sistema (pelas vendas e cupons, sem IA), a LIA ou o Pesquisador (com IA). */
export function quemSugeriu(source: string): { nome: string; comIa: boolean } {
  if (source === 'lia') return { nome: 'LIA', comIa: true };
  if (source === 'pesquisador') return { nome: 'Pesquisador', comIa: true };
  return { nome: 'Liame', comIa: false };
}

/** Aplica os itens marcados de uma sugestão (para "Editar antes": a pessoa ainda confere antes de salvar). */
export function aplicarSugestao(c: BrandDossierContent, s: Pick<BrandDossierSuggestion, 'section' | 'items'>, marcados: number[]): BrandDossierContent {
  const k: ChaveDeLista | null = s.section === 'produtos' ? 'products.items' : s.section === 'ofertas' ? 'offers.items' : s.section === 'datas' ? 'seasonality.items' : null;
  if (!k) return c;
  let itens = itensDaLista(c, k).map((i) => i.text);
  for (const p of [...new Set(marcados)].sort((a, b) => a - b)) {
    const item = s.items[p];
    if (!item) continue;
    if (item.op === 'incluir' && !itens.some((x) => chave(x) === chave(item.text))) itens.push(item.text);
    else if (item.op === 'tirar') itens = itens.filter((x) => chave(x) !== chave(item.text));
    else if (item.op === 'trocar' && item.before) itens = itens.map((x) => (chave(x) === chave(item.before!) ? item.text : x));
  }
  return comLista(
    c,
    k,
    itens.map((text) => ({ text })),
  );
}

// ------------------------------------------------------------------ versões

/** "Versão 3, confirmada por Ana em hoje, 18:40" (quem saiu da empresa aparece como "uma pessoa que saiu"). */
export function quemConfirmou(v: BrandDossierVersionMeta, agora = new Date()): string {
  return `${v.created_by?.name ?? 'uma pessoa que saiu da empresa'} · ${quandoComHora(v.created_at, agora)}`;
}

/** O jeito como a versão nasceu, quando não foi a pessoa salvando. */
export function origemDaVersao(v: BrandDossierVersionMeta): string | null {
  if (v.source === 'sugestao') return 'com uma sugestão conferida';
  if (v.source === 'restaurada') return v.restored_from ? `volta à versão ${v.restored_from}` : 'volta a uma versão anterior';
  if (v.source === 'mesclada') return 'juntando duas edições';
  return null;
}

// ------------------------------------------------------------------ o resumo da página

export type Andamento = { preenchidas: number; total: number; vazias: Secao[]; sugestoes: number };

export function andamentoDo(c: BrandDossierContent, provas: SystemProof[], sugestoes: BrandDossierSuggestion[]): Andamento {
  // "O que não pode dizer" nunca está vazia: as regras da Liame valem sempre.
  const vazias = SECOES.filter((s) => s.id !== 'proibido' && parteVazia(s.id, c, provas));
  return { preenchidas: SECOES.length - vazias.length, total: SECOES.length, vazias, sugestoes: sugestoes.length };
}

/** "8 de 9 partes preenchidas · 1 sugestão para conferir · Região vazia". */
export function linhaDoAndamento(a: Andamento): string {
  const partes = [`${a.preenchidas} de ${a.total} partes preenchidas`];
  if (a.sugestoes) partes.push(a.sugestoes === 1 ? '1 sugestão para conferir' : `${a.sugestoes} sugestões para conferir`);
  if (a.vazias.length) partes.push(`${juntar(a.vazias.map((s) => s.titulo))} ${a.vazias.length === 1 ? 'vazia' : 'vazias'}`);
  return partes.join(' · ');
}

export function juntar(itens: string[]): string {
  if (itens.length <= 1) return itens.join('');
  return `${itens.slice(0, -1).join(', ')} e ${itens.at(-1)}`;
}

/** O resultado do teste de frase, para quem ouve a tela. */
export function resultadoFalado(hits: number): string {
  return hits ? `Não passa: ${hits} ${hits === 1 ? 'regra' : 'regras'}.` : 'Passa nas regras.';
}
