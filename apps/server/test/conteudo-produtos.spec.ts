import { describe, expect, it } from 'vitest';
import {
  chavesDoNome,
  type LinhaDoProduto,
  type NomeDoProduto,
  quantidadeLimpa,
  rankingDeProdutos,
  tendencia,
  textoComparavel,
} from '../src/conteudo/produtos.js';

// Plano de conteúdo, PC4, parte 1 (seção 6.2): o ranking dos produtos pelo código do Regem, contas puras. Os nomes de
// canal são os de verdade da Mister Burgers (lidos na nuvem em 28/11/2026, só leitura): o mesmo código aparece como
// "TRIO 08", "Trio 08 - Burguer + Batata + Refri" e "Burger 08 Trio - Burguer + Batata + Refri".

const HOJE = '2026-11-28';
const atual = (codigo: string, pedidos: number, o: Partial<LinhaDoProduto> = {}): LinhaDoProduto => ({
  janela: 'atual',
  codigo,
  pedidos,
  quantidade: `${pedidos}.000`,
  receita: String(pedidos * 30_000_000),
  custo: null,
  custo_conhecido: false,
  ...o,
});
const nome = (codigo: string, n: string, linhas: number, deCanal = false): NomeDoProduto => ({ codigo, nome: n, de_canal: deCanal, linhas });
const semAparicoes = { legendas: [], fotos: [] };
const zero = { pedidos: 0, receita: '0' };

describe('o ranking dos produtos pelo código do Regem (PC4, parte 1)', () => {
  it('o texto comparável tira acento, pontuação e o zero à esquerda; as chaves pegam o nome e o começo dele', () => {
    expect(textoComparavel('TRIO 08 (Batata Frita - Média)')).toBe('trio 8 batata frita media');
    expect(chavesDoNome('Trio 08 - Burguer + Batata + Refri')).toEqual(['trio 8 burguer batata refri', 'trio 8']);
    // O começo curto demais (menos de 4 letras) não vira chave: "X" acharia tudo.
    expect(chavesDoNome('X - Bacon')).toEqual(['x bacon']);
    expect(quantidadeLimpa('478.000')).toBe('478');
    expect(quantidadeLimpa('2.500')).toBe('2.5');
  });

  it('a tendência só sai de "estável" com 20% e 5 pedidos de diferença; sem venda antes, é "novo"', () => {
    expect(tendencia(30, 20)).toEqual({ trend: 'subindo', percent: 50 });
    expect(tendencia(6, 4)).toEqual({ trend: 'estavel', percent: 50 });
    expect(tendencia(10, 20)).toEqual({ trend: 'caindo', percent: -50 });
    expect(tendencia(5, 0)).toEqual({ trend: 'novo', percent: null });
  });

  it('o nome é o dos canais do próprio Regem; os nomes dos outros canais vão em other_names', () => {
    const r = rankingDeProdutos(
      [atual('trio-08', 426)],
      [
        nome('trio-08', 'TRIO 08', 300),
        nome('trio-08', 'Trio 08 - Burguer + Batata + Refri', 500, true),
        nome('trio-08', 'Burger 08 Trio - Burguer + Batata + Refri', 20, true),
      ],
      [],
      zero,
      426,
      semAparicoes,
      HOJE,
    );
    expect(r).toMatchObject({ status: 'pronto', from: '2026-10-31', to: '2026-11-27', previous_from: '2026-10-03', previous_to: '2026-10-30', days: 28 });
    expect(r.products[0]).toMatchObject({
      rank: 1,
      code: 'trio-08',
      name: 'TRIO 08',
      other_names: ['Trio 08 - Burguer + Batata + Refri', 'Burger 08 Trio - Burguer + Batata + Refri'],
      orders: 426,
      quantity: '426',
      trend: 'novo',
      margin_micros: null,
    });
  });

  it('"vende bem e nunca apareceu": entre os mais vendidos, sem legenda de post (D-PC-35: a foto só em Fotos não conta); a legenda "Trio 8" conta para o TRIO 08', () => {
    const linhas = [atual('a', 100), atual('b', 90), atual('c', 80), atual('d', 70), atual('e', 60), atual('f', 50), atual('g', 1)];
    const nomes = [nome('a', 'TRIO 08', 10), nome('b', 'Batata Frita - Grande', 10), nome('c', 'TRIO 09', 10), nome('d', 'TRIO 16', 10), nome('e', 'Numero 07', 10), nome('f', 'TRIO 10', 10), nome('g', 'Coca zero', 1)];
    const r = rankingDeProdutos(
      linhas,
      nomes,
      [],
      zero,
      470,
      {
        legendas: [
          { texto: 'Hoje tem Trio 8 com batata! 🍔', publicado_em: '2026-11-20' },
          { texto: 'O trio 8 de novo', publicado_em: '2026-11-25' },
          // "trio 80" não é o "trio 8": palavra inteira.
          { texto: 'Promo trio 80 anos', publicado_em: '2026-11-21' },
        ],
        fotos: [{ texto: 'Batata frita grande de perto' }],
      },
      HOJE,
    );
    const por = (c: string) => r.products.find((p) => p.code === c)!;
    expect(por('a').seen).toEqual({ instagram_posts: 2, last_post_at: '2026-11-25', photos: 0 });
    expect(por('a').highlights).toEqual([]);
    // A batata tem foto em Fotos (a informação fica em `seen.photos`), mas nunca saiu em post: o destaque vale (D-PC-35).
    expect(por('b').seen.photos).toBe(1);
    expect(por('b').highlights).toEqual(['vende_bem_nunca_apareceu']);
    // Os 5 primeiros (mínimo) sem legenda: b, c, d, e. O f é o 6º (fora dos 20%, que dão 2, e do mínimo de 5).
    expect(por('c').highlights).toEqual(['vende_bem_nunca_apareceu']);
    expect(por('e').highlights).toEqual(['vende_bem_nunca_apareceu']);
    expect(por('f').highlights).toEqual([]);
  });

  it('a margem só com o custo de todas as linhas; "margem boa, pouca venda" acima da mediana da margem e abaixo da dos pedidos', () => {
    const comCusto = (codigo: string, pedidos: number, margemPorcento: number) =>
      atual(codigo, pedidos, { receita: '100000000', custo: String(100_000_000 - margemPorcento * 1_000_000), custo_conhecido: true });
    const r = rankingDeProdutos(
      [comCusto('a', 50, 30), comCusto('b', 40, 35), comCusto('c', 30, 40), comCusto('d', 10, 70), comCusto('e', 5, 60), atual('f', 20, { custo: '1', custo_conhecido: false })],
      [],
      [],
      zero,
      155,
      semAparicoes,
      HOJE,
    );
    const por = (c: string) => r.products.find((p) => p.code === c)!;
    expect(por('d')).toMatchObject({ margin_micros: '70000000', margin_percent: 70 });
    expect(por('f')).toMatchObject({ margin_micros: null, margin_percent: null });
    // Mediana da margem: 40; mediana dos pedidos (todos os 6): 25. O d (70%, 10 pedidos) e o e (60%, 5) entram.
    expect(por('d').highlights).toContain('margem_boa_pouca_venda');
    expect(por('e').highlights).toContain('margem_boa_pouca_venda');
    expect(por('c').highlights).not.toContain('margem_boa_pouca_venda');
  });

  it('com menos de 5 produtos com custo, não compara a margem; poucos pedidos e sem pedidos dizem o status', () => {
    const r = rankingDeProdutos([atual('a', 3, { receita: '10', custo: '5', custo_conhecido: true })], [], [], zero, 3, semAparicoes, HOJE);
    expect(r.status).toBe('poucos_pedidos');
    expect(r.products[0]!.highlights).not.toContain('margem_boa_pouca_venda');
    expect(rankingDeProdutos([], [], [], zero, 0, semAparicoes, HOJE)).toMatchObject({ status: 'sem_pedidos', products: [], products_total: 0 });
  });

  it('as linhas sem código: o total vem pronto (um pedido conta uma vez) e os nomes em ordem', () => {
    const r = rankingDeProdutos(
      [atual('a', 30)],
      [],
      [
        { nome: 'Numero 07', pedidos: 4, receita: '100' },
        { nome: 'Numero 01', pedidos: 9, receita: '200' },
      ],
      { pedidos: 11, receita: '300' },
      41,
      semAparicoes,
      HOJE,
    );
    expect(r.without_code).toEqual({ orders: 11, revenue_micros: '300', names: ['Numero 01', 'Numero 07'] });
  });
});
