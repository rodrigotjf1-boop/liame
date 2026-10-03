import { describe, expect, it } from 'vitest';
import { conferirTexto, nomesPoliticos, normalizar, TEXTO_MAXIMO } from '../src/policy/texto.js';

// A3 · I9, sem banco: as regras de texto do Compliance. O código decide antes de qualquer revisor de IA.
// Cada regra tem os casos que barram e os que NÃO podem barrar (frase normal de restaurante e de mídia).

const regras = (texto: string | string[], ignorar?: string[]) => conferirTexto(texto, { ignorar }).map((a) => a.regra);

describe('regras de texto: político e eleitoral (A3-15)', () => {
  it('barra pedido de voto, cargo, eleição e propaganda eleitoral, com ou sem acento e maiúscula', () => {
    for (const texto of [
      'Vote em quem apoia o comércio do bairro.',
      'VOTEM EM quem entende de hambúrguer.',
      'Aproveite a ELEIÇÃO para divulgar a promoção.',
      'A campanha fala com o eleitor da região.',
      'Peça apoio ao vereador do bairro.',
      'Sugiro uma peça de propaganda eleitoral.',
      'É o melhor candidato a prefeito para os lojistas.',
      'O pré-candidato pode aparecer no anúncio.',
      'Eleja o melhor combo: o partido político do sabor.',
    ]) {
      expect(regras(texto), texto).toContain('politico_eleitoral');
    }
    expect(conferirTexto('Vote  em   quem apoia o bairro.')).toEqual([{ regra: 'politico_eleitoral', trecho: 'vote em' }]);
  });

  it('não barra frase normal de restaurante e de mídia', () => {
    for (const texto of [
      'A Combo sexta é candidata a receber mais verba.',
      'A campanha com mais investimento recebeu R$ 700,00.',
      'O primeiro turno da cozinha vendeu mais que o segundo turno.',
      'Confira se o conteúdo desta campanha segue as regras da plataforma para anúncio político.',
      'O pedido foi partido em duas entregas.',
      'O cliente devoto do smash voltou três vezes.',
      'A loja elegeu o combo como carro-chefe.',
    ]) {
      expect(regras(texto), texto).toEqual([]);
    }
  });

  it('o nome de uma campanha da própria empresa pode ser citado; o que a IA escreve em volta é conferido', () => {
    const nome = 'Vote certo | Candidato do bairro';
    expect(regras(`A campanha "${nome}" recebeu R$ 700,00.`, [nome])).toEqual([]);
    expect(regras(`A campanha "${nome}" recebeu R$ 700,00. Vote em quem apoia o bairro.`, [nome])).toEqual(['politico_eleitoral']);
    // Sem dizer que o nome veio dos dados, o trecho é barrado.
    expect(regras(`A campanha "Eleições 2026" recebeu R$ 700,00.`)).toEqual(['politico_eleitoral']);
  });

  it('nome de campanha ou de conta com assunto político: palavra solta já basta', () => {
    expect(nomesPoliticos(['Tráfego | Cardápio', 'Vote certo | Candidato do bairro', null, 'Remarketing | Carrinho', 'Vereador João 12345'])).toEqual(['Vote certo | Candidato do bairro', 'Vereador João 12345']);
    expect(nomesPoliticos(['Eleito o melhor burger', 'Combo do Prefeito'])).toHaveLength(2);
    expect(nomesPoliticos(['Combo sexta', 'Delivery noite', 'Busca "hambúrguer perto"', 'Devotos do smash', undefined])).toEqual([]);
  });
});

describe('regras de texto: promessa de resultado, categoria proibida e dado pessoal', () => {
  it('barra promessa de resultado; falar de risco e de incerteza não é promessa', () => {
    for (const texto of ['Com essa mudança o retorno é garantido? Sim: retorno garantido.', 'Garantimos mais pedidos na sexta.', 'É lucro certo.', 'A verba maior vai dobrar as vendas.', 'Campanha com risco zero.', 'Há garantia de resultado.']) {
      expect(regras(texto), texto).toContain('promessa_de_resultado');
    }
    for (const texto of ['Não dá para dizer com certeza de que campanha vieram.', 'Nada garante que a semana que vem repita o resultado.', 'O risco é médio: a margem cobre o investimento por pouco.', 'A garantia do forno venceu.']) {
      expect(regras(texto), texto).toEqual([]);
    }
  });

  it('barra categoria que a plataforma de anúncio proíbe; o verbo "apostar" e a bebida do cardápio passam', () => {
    for (const texto of ['Anuncie o narguilé na sexta.', 'Uma casa de apostas pode patrocinar.', 'Inclua cigarro eletrônico no combo.', 'Sorteie pelo jogo do bicho.', 'Promoção com apostas esportivas.']) {
      expect(regras(texto), texto).toContain('categoria_proibida');
    }
    for (const texto of ['A loja aposta nos combos de sexta.', 'O chope em dobro vendeu bem.', 'A arma da casa é o smash.', 'O cliente apostou no combo novo.']) {
      expect(regras(texto), texto).toEqual([]);
    }
  });

  it('barra dado pessoal sem repetir o dado; dinheiro, data e contagem não são dado pessoal', () => {
    expect(conferirTexto('Ligue para o cliente no (21) 98888-7777.')).toEqual([{ regra: 'dado_pessoal', trecho: 'dado pessoal no texto' }]);
    expect(regras('Mande o cupom para maria@exemplo.com.')).toEqual(['dado_pessoal']);
    expect(regras('O CPF 123.456.789-09 comprou duas vezes.')).toEqual(['dado_pessoal']);
    expect(regras('De 18/09/2026 a 01/10/2026 o investimento foi de R$ 12.060,00 e o caixa confirmou 1.250 pedidos, com ROAS de 2,60.')).toEqual([]);
  });

  it('confere uma lista de textos de uma vez, sem repetir o achado; texto longo demais é recusado', () => {
    expect(conferirTexto(['Vote em nós.', 'Vote em nós de novo.', 'É lucro certo.'])).toEqual([
      { regra: 'politico_eleitoral', trecho: 'vote em' },
      { regra: 'promessa_de_resultado', trecho: 'lucro certo' },
    ]);
    expect(regras('a'.repeat(TEXTO_MAXIMO + 1))).toEqual(['texto_longo']);
    expect(normalizar('  ELEIÇÕES\n\tMunicipais ')).toBe(' eleicoes municipais ');
  });
});

describe('regras de texto: o que a marca nunca diz (dossiê, I8)', () => {
  const daMarca = (texto: string, lista: string[], ignorar?: string[]) => conferirTexto(texto, { daMarca: lista, ignorar });

  it('barra a frase da marca como palavras inteiras, sem olhar acento nem maiúscula', () => {
    expect(daMarca('O MELHOR HAMBURGUER DO RIO, sexta!', ['o melhor hambúrguer do Rio'])).toEqual([{ regra: 'regra_da_marca', trecho: 'o melhor hamburguer do rio' }]);
    expect(daMarca('Smash gourmet na sexta.', ['Gourmet'])).toEqual([{ regra: 'regra_da_marca', trecho: 'gourmet' }]);
    expect(daMarca('Entrega em 20 minutos no Centro.', ['entrega em 20 minutos'])).toEqual([{ regra: 'regra_da_marca', trecho: 'entrega em 20 minutos' }]);
  });

  it('não barra pedaço de outra palavra, frase curta demais nem o nome de campanha da própria empresa', () => {
    expect(daMarca('Um molho gourmetizado de verdade.', ['gourmet'])).toEqual([]);
    expect(daMarca('Ok, é isso.', ['ok', 'é'])).toEqual([]);
    expect(daMarca('A campanha Burger Gourmet trouxe 27 pedidos.', ['gourmet'], ['Burger Gourmet'])).toEqual([]);
  });

  it('soma com as regras da Liame, sem repetir a mesma frase', () => {
    const achados = daMarca('Resultado garantido: o melhor do Rio, o melhor do Rio!', ['o melhor do Rio', 'O MELHOR DO RIO']);
    expect(achados.map((a) => a.regra).sort()).toEqual(['promessa_de_resultado', 'regra_da_marca']);
  });
});
