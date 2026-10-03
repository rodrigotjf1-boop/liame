import { BrandDossierContent } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { arrumarDossie, camposComDadoPessoal, DOSSIE_VAZIO, hashDoTexto, MAX_MUDANCAS, mudancas, provaDePedidos, situacaoDasSecoes, textoDoDossie } from '../src/marca/dossie.js';
import { aplicarItens, recusados, sugerirOfertas, sugerirProdutos } from '../src/marca/sugestoes.js';

// A3 · I8, sem banco: as regras do dossiê da marca (arrumar, recusar dado pessoal, o que mudou, o texto que a
// IA lê) e as sugestões do sistema (produtos e ofertas, pelos números, sem IA).

const dossie = (parcial: Record<string, unknown> = {}): BrandDossierContent =>
  BrandDossierContent.parse({
    identity: { summary: 'Hamburgueria de bairro no Centro, com smash e combos para dividir.', audience: 'Famílias e jovens do bairro.', differentiator: 'Pão de fermentação natural.', since: '2019' },
    voice: { traits: ['Descontraída', 'Direta'], rules: ['Frases curtas.', 'Trate o cliente por "você".'], do_example: 'Sexta é dia de combo. Já escolheu o seu?', dont_example: 'PROMOÇÃO IMPERDÍVEL!!!' },
    products: { items: ['Smash duplo', 'Combo sexta: smash, batata e refrigerante', 'Hambúrguer vegano'] },
    offers: { items: ['Combo sexta, com o cupom SEXTA10, exclusivo da campanha, até 31/10'] },
    proof: { stated: [{ text: 'Nota 4,8 no iFood', why: 'informada por Rodrigo em 28/09' }] },
    forbidden: { items: [{ text: 'o melhor hambúrguer do Rio', why: 'não temos como provar' }, { text: 'gourmet', why: 'não combina com a casa' }] },
    competitors: { items: [{ text: 'Brasa Burger', why: 'a 2 quadras' }] },
    region: { area: 'Centro e bairros a até 5 km', pickup: true },
    seasonality: { items: ['Sexta e sábado à noite são os dias fortes'] },
    ...parcial,
  });

describe('dossiê: o vazio, arrumar e dado pessoal', () => {
  it('o dossiê vazio tem todas as partes vazias, menos "o que não pode dizer" (as regras da Liame valem sempre)', () => {
    const s = situacaoDasSecoes(DOSSIE_VAZIO, new Set());
    expect(s.map((x) => [x.section, x.status])).toEqual([
      ['identidade', 'vazia'],
      ['voz', 'vazia'],
      ['produtos', 'vazia'],
      ['ofertas', 'vazia'],
      ['provas', 'vazia'],
      ['proibido', 'confirmada'],
      ['concorrentes', 'vazia'],
      ['regiao', 'vazia'],
      ['datas', 'vazia'],
    ]);
    expect(situacaoDasSecoes(dossie(), new Set(['produtos'])).find((x) => x.section === 'produtos')!.status).toBe('sugestao');
  });

  it('tira repetidos sem olhar acento nem maiúscula, na ordem em que a pessoa escreveu', () => {
    const d = arrumarDossie(dossie({ products: { items: ['Smash duplo', 'SMASH DUPLO', 'Hambúrguer vegano', 'hamburguer  vegano'] }, forbidden: { items: [{ text: 'Gourmet', why: '' }, { text: 'gourmet', why: 'outra' }] } }));
    expect(d.products.items).toEqual(['Smash duplo', 'Hambúrguer vegano']);
    expect(d.forbidden.items).toEqual([{ text: 'Gourmet', why: '' }]);
  });

  it('aponta o campo com telefone, e-mail ou documento; o dossiê limpo passa', () => {
    expect(camposComDadoPessoal(dossie())).toEqual([]);
    const sujo = dossie({ region: { area: 'Pedidos pelo (21) 99876-5432', pickup: false }, competitors: { items: [{ text: 'Brasa Burger', why: 'dono: fulano@exemplo.com' }] } });
    expect(camposComDadoPessoal(sujo).map((e) => e.path)).toEqual(['content.competitors.items[0].why', 'content.region.area']);
  });
});

describe('dossiê: o que mudou entre as versões', () => {
  it('lista o que entrou e saiu de cada parte, o texto que mudou e a retirada no balcão', () => {
    const antes = dossie();
    const depois = dossie({
      products: { items: ['Smash duplo', 'Combo sexta: smash, batata e refrigerante', 'Onion rings'] },
      forbidden: { items: [{ text: 'o melhor hambúrguer do Rio', why: 'não temos como provar' }, { text: 'gourmet', why: 'não é a nossa cara' }, { text: 'entrega em 20 minutos', why: '' }] },
      region: { area: 'Centro e bairros a até 5 km', pickup: false },
      identity: { summary: 'Hamburgueria de bairro no Centro.', audience: 'Famílias e jovens do bairro.', differentiator: 'Pão de fermentação natural.', since: '2019' },
    });
    expect(mudancas(antes, depois)).toEqual([
      'Identidade: o que é',
      'Produtos: + Onion rings',
      'Produtos: − Hambúrguer vegano',
      'O que não pode dizer: + entrega em 20 minutos',
      'O que não pode dizer: o motivo de "gourmet"',
      'Região: não tem retirada no balcão',
    ]);
    expect(mudancas(antes, antes)).toEqual([]);
  });

  it('a primeira versão lista o que entrou; muita mudança vira "e mais N mudanças"', () => {
    const primeira = mudancas(null, dossie({ voice: { traits: [], rules: [], do_example: '', dont_example: '' } }));
    expect(primeira[0]).toBe('Identidade: o que é');
    expect(primeira.length).toBeLessThanOrEqual(MAX_MUDANCAS);
    expect(primeira.at(-1)).toMatch(/^e mais \d+ mudanças$/);
  });
});

describe('dossiê: o texto que os funcionários de IA leem', () => {
  it('sai em ordem fixa, sem parte vazia e sem quem informou; o mesmo dossiê dá o mesmo hash', () => {
    const prova = provaDePedidos(511, '2026-09-22', '2026-09-28')!;
    const texto = textoDoDossie('Mister Burgers', dossie(), [prova]);
    expect(texto.split('\n').map((l) => l.split(':')[0])).toEqual([
      'MARCA',
      'O QUE É',
      'PARA QUEM',
      'O QUE DIFERENCIA',
      'DESDE',
      'VOZ',
      'REGRAS DE ESCRITA',
      'EXEMPLO DE COMO SIM',
      'EXEMPLO DE COMO NÃO',
      'PRODUTOS',
      'OFERTAS EM VIGOR',
      'PROVAS (só estas podem ser citadas)',
      'NUNCA DIZER',
      'CONCORRENTES (não citar pelo nome em anúncio)',
      'ONDE ATENDE',
      'DATAS',
    ]);
    expect(texto).toContain('PROVAS (só estas podem ser citadas): Mais de 500 pedidos por semana; Nota 4,8 no iFood');
    expect(texto).toContain('NUNCA DIZER: "o melhor hambúrguer do Rio"; "gourmet"');
    expect(texto).not.toContain('Rodrigo');
    expect(hashDoTexto(texto)).toBe(hashDoTexto(textoDoDossie('Mister Burgers', dossie(), [prova])));
    expect(hashDoTexto(texto)).not.toBe(hashDoTexto(textoDoDossie('Mister Burgers', dossie({ seasonality: { items: [] } }), [prova])));
    expect(textoDoDossie('Mister Burgers', DOSSIE_VAZIO, [])).toBe('MARCA: Mister Burgers');
  });

  it('a prova de volume arredonda para baixo com folga, e não existe com pouco pedido', () => {
    expect(provaDePedidos(511, '2026-09-22', '2026-09-28')).toEqual({ text: 'Mais de 500 pedidos por semana', source: 'Regem · 511 pedidos de 22/09 a 28/09 · muda sozinha com o caixa' });
    expect(provaDePedidos(500, '2026-09-22', '2026-09-28')!.text).toBe('Mais de 400 pedidos por semana');
    expect(provaDePedidos(100, '2026-09-22', '2026-09-28')!.text).toBe('Mais de 90 pedidos por semana');
    expect(provaDePedidos(73, '2026-09-22', '2026-09-28')!.text).toBe('Mais de 70 pedidos por semana');
    expect(provaDePedidos(49, '2026-09-22', '2026-09-28')).toBeNull();
  });
});

describe('sugestões do sistema (sem IA)', () => {
  const vendidos = [
    { nome: 'Smash Duplo', pedidos: 320 },
    { nome: 'Combo Sexta', pedidos: 260 },
    { nome: 'Batata rústica G', pedidos: 230 },
    { nome: 'Onion rings', pedidos: 212 },
    { nome: 'Milk-shake de doce de leite', pedidos: 140 },
    { nome: 'Refrigerante lata', pedidos: 90 },
  ];

  it('produtos: inclui os mais vendidos que faltam (com a posição) e tira o que não vendeu nada', () => {
    const itens = sugerirProdutos(dossie(), vendidos, 511, new Set());
    expect(itens).toEqual([
      { op: 'incluir', text: 'Batata rústica G', before: null, why: '230 pedidos em 30 dias, o 3º mais vendido' },
      { op: 'incluir', text: 'Onion rings', before: null, why: '212 pedidos em 30 dias, o 4º mais vendido' },
      { op: 'incluir', text: 'Milk-shake de doce de leite', before: null, why: '140 pedidos em 30 dias, o 5º mais vendido' },
      { op: 'tirar', text: 'Hambúrguer vegano', before: null, why: 'nenhum pedido em 30 dias' },
    ]);
    // Com pouco pedido não dá para dizer que um produto não vende; o que foi recusado não volta.
    expect(sugerirProdutos(dossie(), vendidos, 12, new Set()).some((i) => i.op === 'tirar')).toBe(false);
    expect(sugerirProdutos(dossie(), vendidos, 511, new Set(['incluir:onion rings'])).map((i) => i.text)).not.toContain('Onion rings');
    // Nome de produto com telefone não vira sugestão (o dossiê não guarda dado pessoal).
    const comTelefone = [{ nome: 'Combo pelo (21) 99876-5432', pedidos: 400 }, ...vendidos];
    expect(sugerirProdutos(dossie(), comTelefone, 511, new Set()).map((i) => i.text)).not.toContain('Combo pelo (21) 99876-5432');
  });

  it('ofertas: o cupom exclusivo ligado a campanha que o dossiê não cita', () => {
    const cupons = [
      { codigo: 'SEXTA10', campanha: 'Combo sexta', ate: '31/10' },
      { codigo: 'NOITE10', campanha: 'Delivery noite', ate: '06/10' },
    ];
    expect(sugerirOfertas(dossie(), cupons, new Set())).toEqual([
      { op: 'incluir', text: 'Delivery noite, com o cupom NOITE10, exclusivo da campanha, até 06/10', before: null, why: 'cupom exclusivo ligado à campanha no Liame' },
    ]);
  });

  it('recusa: tudo de uma sugestão descartada e o que ficou desmarcado numa sugestão usada', () => {
    const itens = [
      { op: 'incluir' as const, text: 'Onion rings', before: null, why: '' },
      { op: 'tirar' as const, text: 'Hambúrguer vegano', before: null, why: '' },
    ];
    expect([...recusados([{ status: 'descartada', items: itens, used: null }])]).toEqual(['incluir:onion rings', 'tirar:hamburguer vegano']);
    expect([...recusados([{ status: 'usada', items: itens, used: [0] }])]).toEqual(['tirar:hamburguer vegano']);
  });

  it('aplicar: incluir sem repetir, tirar e trocar no lugar', () => {
    const lista = ['Smash duplo', 'Hambúrguer vegano'];
    expect(
      aplicarItens(lista, [
        { op: 'incluir', text: 'Onion rings', before: null, why: '' },
        { op: 'incluir', text: 'SMASH DUPLO', before: null, why: '' },
        { op: 'tirar', text: 'hamburguer vegano', before: null, why: '' },
        { op: 'trocar', text: 'Smash triplo', before: 'Smash duplo', why: '' },
      ]),
    ).toEqual(['Smash triplo', 'Onion rings']);
  });
});
