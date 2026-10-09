import { describe, expect, it } from 'vitest';
import {
  campanhaDoRascunho,
  chaveDoRascunho,
  citaOCupom,
  conferirVariaveis,
  janelaDaProposta,
  modeloDaProposta,
  PropostaDeMensagem,
  PropostaRecusada,
  publicoDaProposta,
  regraDoCupom,
  textoComVariaveis,
} from '../src/mensageria/proposta-de-mensagem.js';

// A5 · Y5 (parte 4): as regras puras da proposta de mensagem (`plano-a5.md` D-A5-10, D-A5-13 e D-A5-16), sem banco e
// sem RegemCast: o formato da proposta, a janela das 9h às 20h, o modelo aprovado, as variáveis, o cupom citado no
// texto, o público que existe no RegemCast e a chave de idempotência do rascunho.

const MARCA = '11111111-1111-4111-8111-111111111111';
const CONTA = '22222222-2222-4222-8222-222222222222';
const LOJA = '33333333-3333-4333-8333-333333333333';
const TENANT = '44444444-4444-4444-8444-444444444444';

const modelo = (extra: Record<string, unknown> = {}) => ({
  id: 'm1',
  nome: 'combo_domingo_v2',
  idioma: 'pt_BR',
  categoria: 'marketing',
  situacao: 'aprovado',
  podeDisparar: true,
  qualidade: 'alta',
  variaveis: 2,
  cabecalho: null as string | null,
  corpo: 'Oi, {{1}}! Peça com o cupom {{2}} e ganhe 10% de desconto.',
  rodape: 'Responda SAIR para não receber mais.' as string | null,
  botoes: ['Ver o cardápio'],
  alertas: [] as string[],
  ...extra,
});
const proposta = (extra: Record<string, unknown> = {}) => ({
  marca: MARCA,
  conta: CONTA,
  nome: 'Combo família de domingo',
  modelo: { nome: 'combo_domingo_v2' },
  publico: { origem: 'publico', id: 'pediram_30_dias' },
  variaveis: [{ origem: 'primeiro_nome' }, { origem: 'fixo', valor: 'COMBO10' }],
  ...extra,
});
const cupom = (extra: Record<string, unknown> = {}) => ({ loja: LOJA, codigo: 'COMBO10', tipo: 'percentual', percentual: 10, valido_de: '2026-10-10', valido_ate: '2026-10-12', ...extra });
const motivo = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PropostaRecusada);
    return (err as Error).message;
  }
  throw new Error('não recusou');
};
const VARIAVEIS = [{ origem: 'primeiro_nome' as const }, { origem: 'fixo' as const, valor: 'COMBO10' }];

describe('proposta de mensagem: o formato', () => {
  it('a proposta mínima ganha a janela vazia e nenhum cupom; o que sobra é recusado', () => {
    const lida = PropostaDeMensagem.parse(proposta());
    expect(lida).toMatchObject({ janela: {}, cupom: null, variaveis: [{ origem: 'primeiro_nome' }, { origem: 'fixo', valor: 'COMBO10' }] });
    // Não há por onde mandar telefone, lista de números ou a base inteira.
    expect(PropostaDeMensagem.safeParse(proposta({ telefones: ['+5521999990001'] })).success).toBe(false);
    expect(PropostaDeMensagem.safeParse(proposta({ publico: { origem: 'base', id: 'toda' } })).success).toBe(false);
    expect(PropostaDeMensagem.safeParse(proposta({ publico: { origem: 'regiao', id: 'RJ' } })).success).toBe(false);
    expect(PropostaDeMensagem.safeParse(proposta({ publico: { origem: 'publico', id: 'x', numeros: ['1'] } })).success).toBe(false);
  });

  it('a variável fixa precisa do valor, e só ela leva valor: o nome de cada pessoa é o RegemCast que põe', () => {
    expect(PropostaDeMensagem.safeParse(proposta({ variaveis: [{ origem: 'fixo' }] })).success).toBe(false);
    expect(PropostaDeMensagem.safeParse(proposta({ variaveis: [{ origem: 'primeiro_nome', valor: 'Rodrigo' }] })).success).toBe(false);
    expect(PropostaDeMensagem.safeParse(proposta({ variaveis: [{ origem: 'nome' }, { origem: 'cashback_saldo' }] })).success).toBe(true);
  });

  it('o cupom: o código em maiúsculas, o desconto de acordo com o tipo e a validade na ordem', () => {
    expect(PropostaDeMensagem.safeParse(proposta({ cupom: cupom() })).success).toBe(true);
    expect(PropostaDeMensagem.safeParse(proposta({ cupom: cupom({ codigo: 'combo10' }) })).success).toBe(false);
    expect(PropostaDeMensagem.safeParse(proposta({ cupom: cupom({ percentual: undefined }) })).success).toBe(false);
    expect(PropostaDeMensagem.safeParse(proposta({ cupom: cupom({ tipo: 'valor', percentual: undefined, valor_centavos: 500 }) })).success).toBe(true);
    expect(PropostaDeMensagem.safeParse(proposta({ cupom: cupom({ tipo: 'valor' }) })).success).toBe(false);
    expect(PropostaDeMensagem.safeParse(proposta({ cupom: cupom({ tipo: 'frete_gratis', percentual: undefined }) })).success).toBe(true);
    expect(PropostaDeMensagem.safeParse(proposta({ cupom: cupom({ valido_de: '2026-10-13' }) })).success).toBe(false);
    expect(PropostaDeMensagem.safeParse(proposta({ cupom: cupom({ loja: 'loja-centro' }) })).success).toBe(false);
  });
});

describe('proposta de mensagem: a janela das 9h às 20h (D-A5-13)', () => {
  it('sem nada, todos os dias e o horário inteiro; a proposta estreita, com os dias em ordem e sem repetir', () => {
    expect(janelaDaProposta({})).toEqual({ dias: [0, 1, 2, 3, 4, 5, 6], inicio: '09:00', fim: '20:00' });
    expect(janelaDaProposta({ dias: [6, 0, 6], inicio: '11:00', fim: '14:30' })).toEqual({ dias: [0, 6], inicio: '11:00', fim: '14:30' });
    expect(janelaDaProposta({ inicio: '09:00', fim: '20:00' })).toMatchObject({ inicio: '09:00', fim: '20:00' });
  });

  it('nunca alarga: antes das 9h, depois das 20h ou de trás para a frente é recusada', () => {
    const fora = 'O envio de mensagem só acontece entre 9h e 20h, no horário da loja.';
    expect(motivo(() => janelaDaProposta({ inicio: '08:59' }))).toBe(fora);
    expect(motivo(() => janelaDaProposta({ fim: '20:01' }))).toBe(fora);
    expect(motivo(() => janelaDaProposta({ inicio: '00:00', fim: '23:59' }))).toBe(fora);
    expect(motivo(() => janelaDaProposta({ inicio: '15:00', fim: '15:00' }))).toBe('A janela de envio termina antes de começar.');
    expect(motivo(() => janelaDaProposta({ inicio: '19:00', fim: '10:00' }))).toBe('A janela de envio termina antes de começar.');
  });
});

describe('proposta de mensagem: o modelo, as variáveis e o cupom citado', () => {
  it('o modelo precisa existir e estar aprovado; com dois idiomas, vale o pedido, ou o português', () => {
    const modelos = { modelos: [modelo(), modelo({ id: 'm1en', idioma: 'en_US' }), modelo({ id: 'm2', nome: 'em_analise', situacao: 'em_analise', podeDisparar: false })] };
    expect(modeloDaProposta(modelos, { nome: 'combo_domingo_v2' }).idioma).toBe('pt_BR');
    expect(modeloDaProposta(modelos, { nome: 'combo_domingo_v2', idioma: 'en_US' }).id).toBe('m1en');
    expect(motivo(() => modeloDaProposta(modelos, { nome: 'combo_domingo_v2', idioma: 'es_AR' }))).toBe('O modelo "combo_domingo_v2" não existe nesta conta do RegemCast.');
    expect(motivo(() => modeloDaProposta(modelos, { nome: 'outro' }))).toBe('O modelo "outro" não existe nesta conta do RegemCast.');
    expect(motivo(() => modeloDaProposta(modelos, { nome: 'em_analise' }))).toBe('O modelo "em_analise" ainda não foi aprovado pela Meta: só modelo aprovado pode ser enviado.');
  });

  it('cada variável tem valor, na conta certa; o título só leva variável se o modelo tiver; nada de telefone no texto', () => {
    expect(() => conferirVariaveis(modelo(), VARIAVEIS, undefined)).not.toThrow();
    expect(motivo(() => conferirVariaveis(modelo(), [VARIAVEIS[0]!], undefined))).toBe('O modelo "combo_domingo_v2" espera 2 variáveis no texto, e a proposta traz 1.');
    expect(motivo(() => conferirVariaveis(modelo({ variaveis: 1 }), VARIAVEIS, undefined))).toBe('O modelo "combo_domingo_v2" espera 1 variável no texto, e a proposta traz 2.');
    const comTitulo = modelo({ cabecalho: 'Novidade na {{1}}' });
    expect(motivo(() => conferirVariaveis(comTitulo, VARIAVEIS, undefined))).toBe('O título do modelo "combo_domingo_v2" tem uma variável, e a proposta não diz o valor dela.');
    expect(() => conferirVariaveis(comTitulo, VARIAVEIS, { origem: 'fixo', valor: 'Loja Centro' })).not.toThrow();
    expect(motivo(() => conferirVariaveis(modelo(), VARIAVEIS, { origem: 'fixo', valor: 'Loja Centro' }))).toBe('O título do modelo "combo_domingo_v2" não tem variável.');
    // Dez dígitos ou mais é telefone; um preço, uma data e um código de cupom passam.
    for (const valor of ['(21) 99999-0001', '+55 21 99999 0001', '21999990001']) {
      expect(motivo(() => conferirVariaveis(modelo(), [VARIAVEIS[0]!, { origem: 'fixo', valor }], undefined)), valor).toBe('O texto da mensagem não pode levar número de telefone.');
    }
    for (const valor of ['R$ 89,90', 'até 11/10/2026', 'COMBO10', '4 smash e 2 batatas']) expect(() => conferirVariaveis(modelo(), [VARIAVEIS[0]!, { origem: 'fixo', valor }], undefined), valor).not.toThrow();
  });

  it('o texto como a pessoa lê: o valor fixo no lugar, e o nome do que o RegemCast preenche', () => {
    expect(textoComVariaveis(modelo().corpo, VARIAVEIS)).toBe('Oi, [primeiro nome]! Peça com o cupom COMBO10 e ganhe 10% de desconto.');
    expect(textoComVariaveis('Saldo: {{1}}, até {{2}}. {{3}}', [{ origem: 'cashback_saldo' }, { origem: 'cashback_validade' }])).toBe('Saldo: [saldo de cashback], até [validade do cashback]. {{3}}');
    expect(textoComVariaveis('Sem variável.', [])).toBe('Sem variável.');
  });

  it('a mensagem com cupom diz o código em algum lugar que a pessoa lê', () => {
    expect(citaOCupom(modelo(), VARIAVEIS, undefined, 'COMBO10')).toBe(true);
    expect(citaOCupom(modelo(), VARIAVEIS, undefined, 'OUTRO15')).toBe(false);
    // Escrito no próprio modelo (em minúsculas), no rodapé, num botão ou no título.
    expect(citaOCupom(modelo({ variaveis: 0, corpo: 'Use o cupom sexta15 hoje.' }), [], undefined, 'SEXTA15')).toBe(true);
    expect(citaOCupom(modelo({ variaveis: 0, corpo: 'Promoção.', rodape: 'Cupom: SEXTA15' }), [], undefined, 'SEXTA15')).toBe(true);
    expect(citaOCupom(modelo({ variaveis: 0, corpo: 'Promoção.', botoes: ['Copiar SEXTA15'] }), [], undefined, 'SEXTA15')).toBe(true);
    expect(citaOCupom(modelo({ variaveis: 0, corpo: 'Promoção.', cabecalho: 'Cupom {{1}}' }), [], { origem: 'fixo', valor: 'SEXTA15' }, 'SEXTA15')).toBe(true);
  });
});

describe('proposta de mensagem: o público, o cupom e o rascunho', () => {
  const publicos = {
    listas: [{ id: '0a000000-0000-4000-8000-000000000001', nome: 'Clientes de domingo', regra: null, pessoas: 450, usadaEm: null }],
    publicos: [{ id: 'bairro', nome: 'Quem mora no bairro', regra: 'Endereço de entrega no bairro escolhido', pessoas: 120 }],
    perfis: [{ id: 'sumidos', nome: 'Sumidos', regra: 'Sem pedido há 60 a 90 dias', pessoas: 80 }],
  };

  it('o público existe no RegemCast: a lista, o público pronto (com o valor, quando pede) e o perfil', () => {
    expect(publicoDaProposta(publicos, { origem: 'lista', id: '0a000000-0000-4000-8000-000000000001' })).toEqual({ nome: 'Clientes de domingo', regra: null, doRegemcast: { origem: 'lista', origemId: '0a000000-0000-4000-8000-000000000001' } });
    expect(publicoDaProposta(publicos, { origem: 'publico', id: 'bairro', valor: 'Tijuca' })).toEqual({ nome: 'Quem mora no bairro: Tijuca', regra: 'Endereço de entrega no bairro escolhido', doRegemcast: { origem: 'publico', publico: 'bairro', publicoValor: 'Tijuca' } });
    expect(publicoDaProposta(publicos, { origem: 'perfil', id: 'sumidos' })).toEqual({ nome: 'Sumidos', regra: 'Sem pedido há 60 a 90 dias', doRegemcast: { origem: 'perfil', segmento: 'sumidos' } });
    // O id de um grupo não vale em outro.
    expect(motivo(() => publicoDaProposta(publicos, { origem: 'lista', id: 'sumidos' }))).toBe('O público da proposta não existe mais nesta conta do RegemCast.');
  });

  it('a regra do cupom no formato do contrato de cupons do Regem', () => {
    const p = PropostaDeMensagem.parse(proposta({ cupom: cupom({ pedido_minimo_centavos: 4000 }) }));
    expect(regraDoCupom(p.cupom!, p.nome)).toEqual({ codigo: 'COMBO10', nome: 'Mensagem · Combo família de domingo', tipo: 'percentual', percentual: '10.00', pedido_minimo_centavos: 4000, valido_de: '2026-10-10', valido_ate: '2026-10-12' });
    const valor = PropostaDeMensagem.parse(proposta({ cupom: cupom({ tipo: 'valor', percentual: undefined, valor_centavos: 500, nome: 'Cinco reais' }) }));
    expect(regraDoCupom(valor.cupom!, valor.nome)).toEqual({ codigo: 'COMBO10', nome: 'Cinco reais', tipo: 'valor', valor_centavos: 500, valido_de: '2026-10-10', valido_ate: '2026-10-12' });
    // O nome cabe no que o Regem aceita.
    expect(regraDoCupom(p.cupom!, 'x'.repeat(120)).nome).toHaveLength(80);
  });

  it('o rascunho leva a janela e as variáveis; a chave sai da proposta: a mesma dá a mesma, e qualquer mudança dá outra', () => {
    const p = PropostaDeMensagem.parse(proposta());
    const janela = janelaDaProposta(p.janela);
    const campanha = campanhaDoRascunho(p, modelo(), { origem: 'perfil', segmento: 'sumidos' }, janela);
    expect(campanha).toEqual({
      nome: 'Combo família de domingo',
      modeloNome: 'combo_domingo_v2',
      modeloIdioma: 'pt_BR',
      publico: { origem: 'perfil', segmento: 'sumidos' },
      variaveis: [{ origem: 'primeiro_nome' }, { origem: 'fixo', valor: 'COMBO10' }],
      janelaDias: [0, 1, 2, 3, 4, 5, 6],
      janelaInicio: '09:00',
      janelaFim: '20:00',
    });
    const chave = chaveDoRascunho(TENANT, CONTA, campanha);
    expect(chave).toMatch(/^liame:rascunho:[0-9a-f]{48}$/);
    expect(chaveDoRascunho(TENANT, CONTA, { ...campanha })).toBe(chave);
    expect(chaveDoRascunho(TENANT, CONTA, { ...campanha, janelaFim: '18:00' })).not.toBe(chave);
    expect(chaveDoRascunho(TENANT, MARCA, campanha)).not.toBe(chave);
    expect(chaveDoRascunho(MARCA, CONTA, campanha)).not.toBe(chave);
    // Sem variável, o rascunho não leva a lista vazia.
    expect(campanhaDoRascunho(PropostaDeMensagem.parse(proposta({ variaveis: [] })), modelo({ variaveis: 0 }), { origem: 'perfil', segmento: 'sumidos' }, janela)).not.toHaveProperty('variaveis');
  });
});
