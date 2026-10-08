import type { BrandDossierContent, BrandDossierSuggestion, BrandDossierVersionMeta, SystemProof } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CartaoSecao } from '@/components/minha-marca/cartao-secao';
import {
  acrescentar,
  alternarJeito,
  andamentoDo,
  aplicarSugestao,
  comParte,
  conteudoVazio,
  itensDaLista,
  itensDe,
  linhaDoAndamento,
  mudancasEntre,
  origemDaVersao,
  parteVazia,
  partesQueMudaram,
  quemConfirmou,
  quemSugeriu,
  resultadoFalado,
  SECOES,
  sinalDe,
  textoDoItem,
  tirar,
} from '@/components/minha-marca/textos';
import { itensVisiveis, NAVEGACAO, temModos, tituloDa } from '@/components/shell/navegacao';

// "Minha marca" (A3 · P6, aprovado em 03/10/2026; mockups/prototipo-marca.html): as regras da tela sobre o dossiê
// que a API guarda (`/v1/brand-dossier`) e o desenho de cada parte pelo mesmo componente do navegador.

const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function dossie(): BrandDossierContent {
  return {
    identity: { summary: 'Hamburgueria de bairro no Centro, com smash burger e combos para dividir.', audience: 'Famílias e jovens do bairro.', differentiator: 'Pão de fermentação natural.', since: '2019' },
    voice: { traits: ['Descontraída', 'Direta', 'Calorosa'], rules: ['Frases curtas.', 'Trate o cliente por "você".'], do_example: 'Sexta é dia de combo. Já escolheu o seu?', dont_example: 'PROMOÇÃO IMPERDÍVEL!!!' },
    products: { items: ['Smash duplo', 'Combo sexta', 'Hambúrguer vegano'] },
    offers: { items: ['Combo sexta, com o cupom SEXTA10'] },
    proof: { stated: [{ text: 'Nota 4,8 no iFood', why: 'informada por Rodrigo em 28/09' }] },
    forbidden: { items: [{ text: 'o melhor hambúrguer do Rio', why: 'não temos como provar' }] },
    competitors: { items: [{ text: 'Brasa Burger', why: 'a 2 quadras' }] },
    region: { area: '', pickup: false },
    seasonality: { items: ['Sexta e sábado à noite são os dias fortes'] },
  };
}
const PROVAS: SystemProof[] = [{ text: 'Mais de 500 pedidos por semana', source: 'Regem · 511 pedidos de 22/09 a 28/09' }];
const sugestao = (over: Partial<BrandDossierSuggestion> = {}): BrandDossierSuggestion => ({
  id: uuid(1),
  section: 'produtos',
  source: 'sistema',
  items: [
    { op: 'incluir', text: 'Onion rings', before: null, why: '212 pedidos em 30 dias: o 4º item mais pedido.' },
    { op: 'tirar', text: 'Hambúrguer vegano', before: null, why: 'Nenhum pedido em 30 dias.' },
    { op: 'trocar', text: 'Combo sexta com batata G', before: 'Combo sexta', why: 'O combo mudou no cardápio.' },
  ],
  based_on_version: 3,
  created_at: '2026-09-29T09:30:00.000Z',
  ...over,
});
const versao = (over: Partial<BrandDossierVersionMeta> = {}): BrandDossierVersionMeta => ({
  version: 3,
  source: 'pessoa',
  restored_from: null,
  created_by: { id: uuid(9), name: 'Ana' },
  created_at: '2026-09-28T21:40:00.000Z',
  changes: ['O que não pode dizer: + gourmet'],
  ...over,
});

describe('Minha marca: as nove partes', () => {
  it('na ordem do contrato, e o que conta como preenchido em cada uma', () => {
    expect(SECOES.map((s) => s.id)).toEqual(['identidade', 'voz', 'produtos', 'ofertas', 'provas', 'proibido', 'concorrentes', 'regiao', 'datas']);
    const d = dossie();
    expect(itensDe('identidade', d)).toHaveLength(4);
    expect(itensDe('voz', d)).toHaveLength(7);
    expect(itensDe('provas', d, PROVAS)).toEqual(['Mais de 500 pedidos por semana', 'Nota 4,8 no iFood']);
    expect(parteVazia('regiao', d)).toBe(true);
    expect(parteVazia('provas', conteudoVazio(), PROVAS)).toBe(false);
    expect(parteVazia('provas', conteudoVazio())).toBe(true);
    const comBalcao = dossie();
    comBalcao.region.pickup = true;
    expect(itensDe('regiao', comBalcao)).toEqual(['Retirada no balcão']);
  });

  it('o andamento: "O que não pode dizer" nunca conta como vazia, e a linha diz o que falta', () => {
    const a = andamentoDo(dossie(), PROVAS, [sugestao()]);
    expect(a).toMatchObject({ preenchidas: 8, total: 9, sugestoes: 1 });
    expect(a.vazias.map((s) => s.id)).toEqual(['regiao']);
    expect(linhaDoAndamento(a)).toBe('8 de 9 partes preenchidas · 1 sugestão para conferir · Região vazia');
    const vazio = andamentoDo(conteudoVazio(), [], []);
    expect(vazio.preenchidas).toBe(1);
    expect(linhaDoAndamento(vazio)).toBe('1 de 9 partes preenchidas · Identidade, Voz, Produtos, Ofertas, Provas, Concorrentes, Região e Datas e sazonalidade vazias');
  });
});

describe('Minha marca: listas e jeitos', () => {
  it('acrescentar: sem texto, repetido (pelo texto, sem acento nem caixa) e lista cheia são recusados', () => {
    const d = dossie();
    expect(acrescentar(d, 'products.items', { text: '  ' }).erro).toBe('Escreva o que quer adicionar.');
    expect(acrescentar(d, 'products.items', { text: 'smash  DUPLO' }).erro).toBe('Este item já está na lista.');
    const r = acrescentar(d, 'forbidden.items', { text: ' gourmet ', why: ' não combina com a casa ' });
    expect(r.erro).toBeNull();
    expect(r.conteudo.forbidden.items.at(-1)).toEqual({ text: 'gourmet', why: 'não combina com a casa' });
    // O original não muda: a tela trabalha num rascunho novo a cada passo.
    expect(d.forbidden.items).toHaveLength(1);
    let cheia = dossie();
    cheia.voice.rules = Array.from({ length: 10 }, (_, i) => `Regra ${i}`);
    expect(acrescentar(cheia, 'voice.rules', { text: 'Mais uma' }).erro).toBe('A lista aceita até 10 itens. Tire um antes de adicionar outro.');
    cheia = tirar(cheia, 'voice.rules', 0);
    expect(itensDaLista(cheia, 'voice.rules')).toHaveLength(9);
    expect(itensDaLista(cheia, 'voice.rules')[0]).toEqual({ text: 'Regra 1' });
  });

  it('até quatro jeitos de falar', () => {
    let d = dossie();
    const mais = alternarJeito(d, 'Ousada');
    expect(mais.conteudo.voice.traits).toEqual(['Descontraída', 'Direta', 'Calorosa', 'Ousada']);
    d = mais.conteudo;
    expect(alternarJeito(d, 'Elegante').erro).toBe('Escolha até quatro jeitos. Tire um antes de marcar outro.');
    expect(alternarJeito(d, 'Direta').conteudo.voice.traits).toEqual(['Descontraída', 'Calorosa', 'Ousada']);
  });
});

describe('Minha marca: versões', () => {
  it('o que mudou de uma versão para outra, por parte', () => {
    const antes = dossie();
    const depois = dossie();
    depois.products.items = ['Smash duplo', 'Combo sexta', 'Onion rings'];
    depois.forbidden.items.push({ text: 'gourmet', why: '' });
    depois.identity.summary = 'Hamburgueria do Centro.';
    depois.region.pickup = true;
    expect(mudancasEntre(antes, depois)).toEqual(['Identidade: texto alterado', 'Produtos: + Onion rings; − Hambúrguer vegano', 'O que não pode dizer: + gourmet', 'Região: texto alterado']);
    expect(mudancasEntre(antes, dossie())).toEqual([]);
    expect(partesQueMudaram(antes, depois)).toEqual(['identidade', 'produtos', 'proibido', 'regiao']);
  });

  it('juntar duas edições: a parte de uma pessoa por cima da versão da outra', () => {
    const dela = dossie();
    dela.forbidden.items.push({ text: 'comida caseira', why: 'a cozinha é de lanchonete' });
    const meu = dossie();
    meu.voice.rules.push('Pode usar "a gente".');
    const junto = comParte('voz', dela, meu);
    expect(junto.voice.rules).toContain('Pode usar "a gente".');
    expect(junto.forbidden.items.map((i) => i.text)).toContain('comida caseira');
    // Nenhum dos dois é mexido.
    expect(dela.voice.rules).toHaveLength(2);
  });

  it('quem confirmou, quando e como a versão nasceu', () => {
    const agora = new Date('2026-09-29T17:40:00Z');
    expect(quemConfirmou(versao(), agora)).toMatch(/^Ana · ontem, \d{2}:\d{2}$/);
    expect(quemConfirmou(versao({ created_by: null }), agora)).toMatch(/^uma pessoa que saiu da empresa · /);
    expect(origemDaVersao(versao())).toBeNull();
    expect(origemDaVersao(versao({ source: 'sugestao' }))).toBe('com uma sugestão conferida');
    expect(origemDaVersao(versao({ source: 'restaurada', restored_from: 2 }))).toBe('volta à versão 2');
    expect(origemDaVersao(versao({ source: 'mesclada' }))).toBe('juntando duas edições');
  });
});

describe('Minha marca: sugestões', () => {
  it('o sinal e o texto de cada item; quem sugeriu diz se teve IA', () => {
    const s = sugestao();
    expect(s.items.map((i) => sinalDe(i.op))).toEqual(['mais', 'menos', 'muda']);
    expect(s.items.map(textoDoItem)).toEqual(['Incluir “Onion rings”', 'Tirar “Hambúrguer vegano”', 'Combo sexta → Combo sexta com batata G']);
    expect(quemSugeriu('sistema')).toEqual({ nome: 'Liame', comIa: false });
    expect(quemSugeriu('lia')).toEqual({ nome: 'LIA', comIa: true });
    expect(quemSugeriu('pesquisador')).toEqual({ nome: 'Pesquisador', comIa: true });
  });

  it('"Editar antes": só os itens marcados entram no rascunho', () => {
    const d = dossie();
    expect(aplicarSugestao(d, sugestao(), [0, 1, 2]).products.items).toEqual(['Smash duplo', 'Combo sexta com batata G', 'Onion rings']);
    expect(aplicarSugestao(d, sugestao(), [1]).products.items).toEqual(['Smash duplo', 'Combo sexta']);
    // Item que já está não entra duas vezes; parte que a tela não sabe aplicar fica como está.
    expect(aplicarSugestao(d, sugestao({ items: [{ op: 'incluir', text: 'smash duplo', before: null, why: '' }] }), [0]).products.items).toHaveLength(3);
    expect(aplicarSugestao(d, sugestao({ section: 'voz' }), [0])).toBe(d);
  });

  it('o resultado do teste de frase, para quem ouve a tela', () => {
    expect(resultadoFalado(0)).toBe('Passa nas regras.');
    expect(resultadoFalado(1)).toBe('Não passa: 1 regra.');
    expect(resultadoFalado(2)).toBe('Não passa: 2 regras.');
  });
});

describe('Minha marca: cada parte na página', () => {
  const desenhar = (secao: Parameters<typeof CartaoSecao>[0]['secao'], situacao: 'confirmada' | 'vazia' | 'sugestao', c = dossie()) =>
    renderToStaticMarkup(createElement(CartaoSecao, { secao, conteudo: c, provas: PROVAS, situacao, nomeDaMarca: 'Mister Burgers', acoes: null }));

  it('a voz com os jeitos, as regras e os exemplos; a situação no selo', () => {
    const html = desenhar('voz', 'confirmada');
    expect(html).toContain('Confirmada');
    expect(html).toContain('Descontraída');
    expect(html).toContain('Assim sim');
    expect(html).toContain('Assim não');
    expect(html).toContain('id="mk-t-voz"');
  });

  it('as provas do sistema vêm com a fonte; as informadas, com o porquê', () => {
    const html = desenhar('provas', 'confirmada');
    expect(html).toContain('Mais de 500 pedidos por semana');
    expect(html).toContain('Regem · 511 pedidos de 22/09 a 28/09');
    expect(html).toContain('informada por Rodrigo em 28/09');
  });

  it('"O que não pode dizer": as regras da Liame sempre, e as da marca', () => {
    const html = desenhar('proibido', 'confirmada');
    expect(html).toContain('Regras da Liame · valem para todas as marcas');
    expect(html).toContain('Conteúdo político ou eleitoral');
    expect(html).toContain('Regras da Mister Burgers');
    expect(html).toContain('“o melhor hambúrguer do Rio”');
    expect(html).toContain('mk-secao--largo');
    expect(desenhar('proibido', 'confirmada', conteudoVazio())).toContain('Nenhuma regra própria ainda.');
  });

  it('parte vazia diz o que falta; com sugestão, o cartão avisa', () => {
    const vazia = desenhar('regiao', 'vazia');
    expect(vazia).toContain('Ainda não preenchida. Os funcionários não sabem onde a casa entrega.');
    expect(vazia).toContain('mk-secao--vazia');
    const sug = desenhar('produtos', 'sugestao');
    expect(sug).toContain('Sugestão para conferir');
    expect(sug).toContain('mk-secao--sugestao');
  });
});

describe('menu: "Minha marca" abaixo de Resultados e de Sua equipe, para quem tem dossie.ver, sem Lite/Pro', () => {
  const agencia = NAVEGACAO.find((g) => g.id === 'agencia')!;

  it('o item, a permissão e o título', () => {
    const i = agencia.itens.findIndex((x) => x.href === '/marca');
    // A ordem do protótipo geral aprovado: Resultados, Sua equipe, Minha marca (a Verba do mês entrou depois de Resultados, no P9).
    expect(agencia.itens.slice(i - 4, i).map((x) => x.href)).toEqual(['/resultados', '/verba', '/criativos', '/equipe']);
    expect(agencia.itens[i]).toEqual({ href: '/marca', rotulo: 'Minha marca', icone: 'palette', permissao: 'dossie.ver' });
    expect(itensVisiveis(agencia, (p) => p !== 'dossie.ver', 'lite').map((x) => x.href)).not.toContain('/marca');
    expect(tituloDa('/marca')).toBe('Minha marca');
    expect(temModos('/marca', () => true)).toBe(false);
  });
});
