import { createHash } from 'node:crypto';
import { BrandDossierContent, DOSSIER_SECTIONS, type DossierSection, type SystemProof } from '@liame/contracts';
import { limparTexto } from '../ai/sanitizar.js';
import type { FieldError } from '../errors/problems.js';

// O dossiê da marca (A3, I8; `ai-architecture.md` §5): o que a marca é, como fala, o que vende, o que pode
// provar e o que nunca diz. Aqui ficam as regras puras: arrumar o que a pessoa mandou, recusar dado pessoal,
// dizer o que mudou de uma versão para a outra e montar o texto que os funcionários de IA leem, sempre na
// mesma ordem (o mesmo dossiê dá o mesmo texto, e o mesmo hash: bom para o cache de prompt).

/** O dossiê de quem ainda não salvou nada. */
export const DOSSIE_VAZIO: BrandDossierContent = BrandDossierContent.parse({});

export const ROTULO_DA_SECAO: Record<DossierSection, string> = {
  identidade: 'Identidade',
  voz: 'Voz',
  produtos: 'Produtos',
  ofertas: 'Ofertas',
  provas: 'Provas',
  proibido: 'O que não pode dizer',
  concorrentes: 'Concorrentes',
  regiao: 'Região',
  datas: 'Datas e sazonalidade',
};

/** Para comparar textos: sem acento, minúsculas e espaços simples. */
export function chave(texto: string): string {
  return texto.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function semRepetir<T>(itens: T[], texto: (item: T) => string): T[] {
  const vistos = new Set<string>();
  return itens.filter((i) => {
    const k = chave(texto(i));
    if (!k || vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}
const proprio = (t: string) => t;
const doTexto = (i: { text: string }) => i.text;

/** Tira itens repetidos (sem olhar acento nem maiúscula), mantendo a ordem em que a pessoa escreveu. */
export function arrumarDossie(c: BrandDossierContent): BrandDossierContent {
  return {
    identity: { ...c.identity },
    voice: { ...c.voice, traits: semRepetir(c.voice.traits, proprio), rules: semRepetir(c.voice.rules, proprio) },
    products: { items: semRepetir(c.products.items, proprio) },
    offers: { items: semRepetir(c.offers.items, proprio) },
    proof: { stated: semRepetir(c.proof.stated, doTexto) },
    forbidden: { items: semRepetir(c.forbidden.items, doTexto) },
    competitors: { items: semRepetir(c.competitors.items, doTexto) },
    region: { ...c.region },
    seasonality: { items: semRepetir(c.seasonality.items, proprio) },
  };
}

/** Cada texto do dossiê com o caminho dele no corpo da requisição (para o erro apontar o campo). */
function textosComCaminho(c: BrandDossierContent): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const um = (caminho: string, t: string) => out.push([caminho, t]);
  const lista = (caminho: string, itens: string[]) => itens.forEach((t, i) => um(`${caminho}[${i}]`, t));
  const comMotivo = (caminho: string, itens: Array<{ text: string; why: string }>) =>
    itens.forEach((t, i) => {
      um(`${caminho}[${i}].text`, t.text);
      um(`${caminho}[${i}].why`, t.why);
    });
  um('content.identity.summary', c.identity.summary);
  um('content.identity.audience', c.identity.audience);
  um('content.identity.differentiator', c.identity.differentiator);
  lista('content.voice.traits', c.voice.traits);
  lista('content.voice.rules', c.voice.rules);
  um('content.voice.do_example', c.voice.do_example);
  um('content.voice.dont_example', c.voice.dont_example);
  lista('content.products.items', c.products.items);
  lista('content.offers.items', c.offers.items);
  comMotivo('content.proof.stated', c.proof.stated);
  comMotivo('content.forbidden.items', c.forbidden.items);
  comMotivo('content.competitors.items', c.competitors.items);
  um('content.region.area', c.region.area);
  lista('content.seasonality.items', c.seasonality.items);
  return out.filter(([, t]) => t.length > 0);
}

/**
 * O dossiê vai ao modelo de IA (D-A3-4): nele não entra dado pessoal. Devolve os campos com telefone, e-mail,
 * CPF, CNPJ ou CEP (os mesmos padrões da limpeza antes do envio), para a pessoa tirar; vazio = pode salvar.
 */
export function camposComDadoPessoal(c: BrandDossierContent): FieldError[] {
  return textosComCaminho(c)
    .filter(([, t]) => limparTexto(t).removidos > 0)
    .map(([path]) => ({ path, message: 'Tire o dado pessoal (telefone, e-mail, documento ou CEP): o dossiê vai para os funcionários de IA e não guarda dado de cliente.' }));
}

/** A parte não tem nada preenchido? "O que não pode dizer" nunca está vazia: as regras da Liame valem sempre. */
export function secaoVazia(c: BrandDossierContent, s: DossierSection): boolean {
  switch (s) {
    case 'identidade':
      return !c.identity.summary && !c.identity.audience && !c.identity.differentiator && !c.identity.since;
    case 'voz':
      return !c.voice.traits.length && !c.voice.rules.length && !c.voice.do_example && !c.voice.dont_example;
    case 'produtos':
      return !c.products.items.length;
    case 'ofertas':
      return !c.offers.items.length;
    case 'provas':
      return !c.proof.stated.length;
    case 'proibido':
      return false;
    case 'concorrentes':
      return !c.competitors.items.length;
    case 'regiao':
      return !c.region.area && !c.region.pickup;
    case 'datas':
      return !c.seasonality.items.length;
  }
}

/** Situação de cada parte, na ordem da tela: com sugestão esperando, vazia ou confirmada. */
export function situacaoDasSecoes(c: BrandDossierContent, comSugestao: ReadonlySet<DossierSection>): Array<{ section: DossierSection; status: 'confirmada' | 'vazia' | 'sugestao' }> {
  return DOSSIER_SECTIONS.map((section) => ({ section, status: comSugestao.has(section) ? 'sugestao' : secaoVazia(c, section) ? 'vazia' : 'confirmada' }));
}

/** Teto de linhas do "o que mudou" de uma versão: o resto vira "e mais N mudanças". */
export const MAX_MUDANCAS = 12;

/** O que mudou de uma versão para a outra, em frases curtas ("O que não pode dizer: + gourmet"). */
export function mudancas(antes: BrandDossierContent | null, depois: BrandDossierContent): string[] {
  const a = antes ?? DOSSIE_VAZIO;
  const out: string[] = [];
  const campo = (s: DossierSection, nome: string, x: string, y: string) => {
    if (chave(x) !== chave(y)) out.push(`${ROTULO_DA_SECAO[s]}: ${nome}`);
  };
  const lista = (s: DossierSection, x: string[], y: string[]) => {
    const kx = new Set(x.map(chave));
    const ky = new Set(y.map(chave));
    for (const i of y) if (!kx.has(chave(i))) out.push(`${ROTULO_DA_SECAO[s]}: + ${i}`);
    for (const i of x) if (!ky.has(chave(i))) out.push(`${ROTULO_DA_SECAO[s]}: − ${i}`);
  };
  const comMotivo = (s: DossierSection, x: Array<{ text: string; why: string }>, y: Array<{ text: string; why: string }>) => {
    lista(s, x.map(doTexto), y.map(doTexto));
    const motivoAntes = new Map(x.map((i) => [chave(i.text), chave(i.why)]));
    for (const i of y) {
      const m = motivoAntes.get(chave(i.text));
      if (m !== undefined && m !== chave(i.why)) out.push(`${ROTULO_DA_SECAO[s]}: o motivo de "${i.text}"`);
    }
  };
  campo('identidade', 'o que é', a.identity.summary, depois.identity.summary);
  campo('identidade', 'para quem', a.identity.audience, depois.identity.audience);
  campo('identidade', 'o que diferencia', a.identity.differentiator, depois.identity.differentiator);
  campo('identidade', 'desde quando', a.identity.since, depois.identity.since);
  lista('voz', a.voice.traits, depois.voice.traits);
  lista('voz', a.voice.rules, depois.voice.rules);
  campo('voz', 'o exemplo de como sim', a.voice.do_example, depois.voice.do_example);
  campo('voz', 'o exemplo de como não', a.voice.dont_example, depois.voice.dont_example);
  lista('produtos', a.products.items, depois.products.items);
  lista('ofertas', a.offers.items, depois.offers.items);
  comMotivo('provas', a.proof.stated, depois.proof.stated);
  comMotivo('proibido', a.forbidden.items, depois.forbidden.items);
  comMotivo('concorrentes', a.competitors.items, depois.competitors.items);
  campo('regiao', 'onde entrega', a.region.area, depois.region.area);
  if (a.region.pickup !== depois.region.pickup) out.push(`${ROTULO_DA_SECAO.regiao}: ${depois.region.pickup ? 'tem' : 'não tem'} retirada no balcão`);
  lista('datas', a.seasonality.items, depois.seasonality.items);
  if (out.length <= MAX_MUDANCAS) return out;
  const resto = out.length - (MAX_MUDANCAS - 1);
  return [...out.slice(0, MAX_MUDANCAS - 1), `e mais ${resto} mudanças`];
}

/** O que a marca nunca diz: a lista que o Compliance confere junto com as regras da Liame. */
export function proibidasDoDossie(c: BrandDossierContent): string[] {
  return c.forbidden.items.map(doTexto);
}

/** Os concorrentes que a marca informou: nenhum anúncio os cita pelo nome. */
export function concorrentesDoDossie(c: BrandDossierContent): string[] {
  return c.competitors.items.map(doTexto);
}

/**
 * O texto que os funcionários de IA leem, em ordem fixa e com rótulos fixos; parte vazia não entra. Leva o
 * nome da marca, o que ela é, como fala, o que vende, as provas (as do sistema primeiro), o que nunca diz, os
 * concorrentes, onde atende e as datas. Não leva quem informou cada coisa (nome de pessoa não vai ao modelo).
 */
export function textoDoDossie(marca: string, c: BrandDossierContent, provas: SystemProof[]): string {
  const linhas = [`MARCA: ${marca}`];
  const add = (rotulo: string, valor: string | string[]) => {
    const v = Array.isArray(valor) ? valor.filter(Boolean).join('; ') : valor;
    if (v) linhas.push(`${rotulo}: ${v}`);
  };
  add('O QUE É', c.identity.summary);
  add('PARA QUEM', c.identity.audience);
  add('O QUE DIFERENCIA', c.identity.differentiator);
  add('DESDE', c.identity.since);
  add('VOZ', c.voice.traits.map((t) => t.toLowerCase()));
  add('REGRAS DE ESCRITA', c.voice.rules);
  add('EXEMPLO DE COMO SIM', c.voice.do_example);
  add('EXEMPLO DE COMO NÃO', c.voice.dont_example);
  add('PRODUTOS', c.products.items);
  add('OFERTAS EM VIGOR', c.offers.items);
  add('PROVAS (só estas podem ser citadas)', [...provas.map((p) => p.text), ...c.proof.stated.map(doTexto)]);
  add('NUNCA DIZER', c.forbidden.items.map((r) => `"${r.text}"`));
  add('CONCORRENTES (não citar pelo nome em anúncio)', c.competitors.items.map(doTexto));
  add('ONDE ATENDE', [c.region.area, c.region.pickup ? 'tem retirada no balcão' : ''].filter(Boolean).join('; '));
  add('DATAS', c.seasonality.items);
  return linhas.join('\n');
}

/**
 * O que a marca afirma de si, para conferir o que uma peça de anúncio diz: o mesmo texto do dossiê, sem o que ela
 * nunca diz, sem os concorrentes e sem o exemplo de como não escrever. Um número que só aparece nessas partes (o
 * "entrega em 20 minutos" que a marca proibiu) não autoriza a peça a escrevê-lo.
 */
export function fatosDoDossie(marca: string, c: BrandDossierContent, provas: SystemProof[]): string {
  return textoDoDossie(marca, { ...c, voice: { ...c.voice, dont_example: '' }, forbidden: { items: [] }, competitors: { items: [] } }, provas);
}

export const hashDoTexto = (texto: string): string => createHash('sha256').update(texto, 'utf8').digest('hex');

/**
 * A prova de volume que o sistema calcula (nunca digitada): "Mais de 500 pedidos por semana" para 511. Arredonda
 * para baixo, com folga ("mais de" é sempre verdade); com menos de 50 pedidos na semana, não há prova a citar.
 */
export function provaDePedidos(pedidos: number, de: string, ate: string): SystemProof | null {
  if (!Number.isInteger(pedidos) || pedidos < 50) return null;
  const passo = pedidos > 100 ? 100 : 10;
  const piso = Math.floor((pedidos - 1) / passo) * passo;
  const dia = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  return { text: `Mais de ${piso} pedidos por semana`, source: `Regem · ${pedidos} pedidos de ${dia(de)} a ${dia(ate)} · muda sozinha com o caixa` };
}
