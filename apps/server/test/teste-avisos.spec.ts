import { describe, expect, it } from 'vitest';
import { avisoDoTeste, DIAS_DO_AVISO_DO_TESTE, type TesteLido, textoDoAvisoDoTeste } from '../src/campanhas/teste-avisos.js';

// R8 (D-RG-80, D-RG-93 e D-RG-94), sem rede e sem banco: os três avisos do teste de criativo na Atenção. O teste que
// terminou com vencedor avisa enquanto a campanha de teste segue no ar e o criativo que perdeu não foi pausado, sem
// prazo; o que acabou sem vencedor só informa, pelo prazo; o interrompido avisa até alguém encerrar o teste (ou pelo
// prazo, se a campanha de teste não está no ar). O prazo nunca cala o aviso de um dinheiro que ainda está sendo gasto.
// E as frases.

const ID = '0190d2b0-0000-7000-8000-0000000000a1';
const ACAO = '0190d2b0-0000-7000-8000-0000000000b2';
const numeros = (pedidos: number) => ({ pedidos, receita_micros: pedidos * 42_000_000, gasto_micros: 280_000_000, visitas: 400 });
const resultado = (veredito: 'ainda_nao' | 'venceu' | 'sem_vencedor', vencedor: 'A' | 'B' | null, a: number, b: number, dia: number) => ({
  olhadas: [{ dia, a, b, acaso: 0.01 }],
  veredito,
  vencedor,
  criativos: { A: numeros(a), B: numeros(b) },
});
const teste = (o: Partial<TesteLido> = {}): TesteLido => ({
  id: ID,
  acao: ACAO,
  nome: 'Teste · Combo sexta',
  situacao: 'terminado',
  ativa: true,
  comecou: true,
  noPrazo: true,
  campanhaLida: 'ativa',
  perdedorLido: 'ativa',
  resultado: resultado('venceu', 'B', 9, 45, 14),
  motivo: null,
  ...o,
});

describe('os avisos do teste de criativo (R8)', () => {
  it('o prazo é de duas semanas, e nunca cala o aviso do que ainda está gastando', () => {
    expect(DIAS_DO_AVISO_DO_TESTE).toBe(14);
    const fora = { noPrazo: false };
    // No dia 20 depois do fim: o criativo que perdeu segue no ar, e o aviso fica até alguém pausá-lo ou encerrar o teste.
    expect(avisoDoTeste(teste(fora))).toMatchObject({ tipo: 'venceu' });
    expect(avisoDoTeste(teste({ ...fora, perdedorLido: 'pausada' }))).toBeNull();
    expect(avisoDoTeste(teste({ ...fora, ativa: false }))).toBeNull();
    // O interrompido com a campanha de teste no ar: fica até alguém encerrar o teste.
    expect(avisoDoTeste(teste({ ...fora, situacao: 'interrompido', resultado: null, motivo: 'Mexeram.' }))).toMatchObject({ tipo: 'interrompido', noAr: true });
    // O que não gasta mais sai no prazo: o interrompido que nem começou e o que teve a campanha pausada por fora.
    expect(avisoDoTeste(teste({ ...fora, situacao: 'interrompido', ativa: false, comecou: false, resultado: null }))).toBeNull();
    expect(avisoDoTeste(teste({ ...fora, situacao: 'interrompido', campanhaLida: 'pausada', resultado: null }))).toBeNull();
    // O teste sem vencedor é informação (os dois ficam como estão, de propósito): sai no prazo.
    expect(avisoDoTeste(teste({ ...fora, resultado: resultado('sem_vencedor', null, 31, 27, 28) }))).toBeNull();
  });

  it('com vencedor: avisa enquanto a campanha de teste segue no ar e o criativo que perdeu não foi pausado', () => {
    const comum = { teste: ID, acao: ACAO, nome: 'Teste · Combo sexta' };
    expect(avisoDoTeste(teste())).toEqual({ ...comum, tipo: 'venceu', vencedor: 'B', pedidos: { A: 9, B: 45 }, dias: 14 });
    // Sem a leitura da Meta (a campanha de teste ainda não está na lista), vale o que o Liame deixou.
    expect(avisoDoTeste(teste({ campanhaLida: null, perdedorLido: null }))).toMatchObject({ tipo: 'venceu' });
    expect(avisoDoTeste(teste({ perdedorLido: 'desconhecida' }))).toMatchObject({ tipo: 'venceu' });
    // O conjunto do que perdeu pausado ou apagado: não há mais o que decidir.
    expect(avisoDoTeste(teste({ perdedorLido: 'pausada' }))).toBeNull();
    expect(avisoDoTeste(teste({ perdedorLido: 'removida' }))).toBeNull();
    // O teste encerrado (a campanha de teste pausada pelo Liame) ou a campanha pausada por fora: nada a avisar.
    expect(avisoDoTeste(teste({ ativa: false }))).toBeNull();
    expect(avisoDoTeste(teste({ campanhaLida: 'pausada' }))).toBeNull();
    expect(avisoDoTeste(teste({ campanhaLida: 'arquivada' }))).toBeNull();
  });

  it('sem vencedor: só informa, e sai quando o teste é encerrado', () => {
    const sem = teste({ resultado: resultado('sem_vencedor', null, 31, 27, 28), perdedorLido: null });
    expect(avisoDoTeste(sem)).toEqual({ teste: ID, acao: ACAO, nome: 'Teste · Combo sexta', tipo: 'sem_vencedor', pedidos: { A: 31, B: 27 }, dias: 28 });
    expect(avisoDoTeste({ ...sem, ativa: false })).toBeNull();
  });

  it('o resultado que não diz o fim (ou que não pôde ser lido) não vira aviso', () => {
    expect(avisoDoTeste(teste({ resultado: resultado('ainda_nao', null, 11, 7, 7) }))).toBeNull();
    expect(avisoDoTeste(teste({ resultado: null }))).toBeNull();
    expect(avisoDoTeste(teste({ resultado: { olhadas: [], veredito: 'venceu', vencedor: 'A', criativos: { A: numeros(1), B: numeros(0) } } }))).toBeNull();
    expect(avisoDoTeste(teste({ resultado: { veredito: 'venceu' } }))).toBeNull();
  });

  it('interrompido: avisa até alguém encerrar o teste; o que nem começou avisa pelo prazo', () => {
    const motivo = 'A verba do conjunto do criativo B foi mudada fora do Liame. O Liame parou de medir: com um lado diferente do outro, a comparação não vale.';
    const rodando = teste({ situacao: 'interrompido', motivo, resultado: null });
    expect(avisoDoTeste(rodando)).toEqual({ teste: ID, acao: ACAO, nome: 'Teste · Combo sexta', tipo: 'interrompido', motivo, noAr: true });
    // A campanha de teste pausada por fora: o aviso fica (o teste ainda consta como ativado pelo Liame), sem dizer que está no ar.
    expect(avisoDoTeste({ ...rodando, campanhaLida: 'pausada' })).toMatchObject({ tipo: 'interrompido', noAr: false });
    // Encerrado pela pessoa (a campanha de teste pausada pelo Liame): já foi visto.
    expect(avisoDoTeste({ ...rodando, ativa: false })).toBeNull();
    // Os cupons não saíram: o teste nem começou, e a campanha de teste nunca foi ativada.
    const semCupom = teste({ situacao: 'interrompido', ativa: false, comecou: false, campanhaLida: 'pausada', resultado: null, motivo: 'O cupom SEXTAFOTO, do criativo A, não foi criado no Regem. A campanha de teste ficou pausada: peça o teste de novo.' });
    expect(avisoDoTeste(semCupom)).toMatchObject({ tipo: 'interrompido', noAr: false });
  });

  it('as frases: o que houve, o motivo e o que fazer', () => {
    expect(textoDoAvisoDoTeste(avisoDoTeste(teste())!)).toEqual({
      kind: 'teste_com_vencedor',
      severity: 'atencao',
      title: 'O criativo B venceu o teste "Teste · Combo sexta"',
      detail: 'Em 14 dias, o criativo B trouxe 45 pedidos no caixa e o criativo A, 9 pedidos, com a mesma verba. A campanha de teste continua no ar com os dois: o Liame avisa e não pausa sozinho.',
      action: 'Veja o teste em Aprovações: de lá você pede para pausar o criativo A, ou encerra o teste.',
    });
    expect(textoDoAvisoDoTeste(avisoDoTeste(teste({ resultado: resultado('sem_vencedor', null, 1, 0, 28) }))!)).toEqual({
      kind: 'teste_sem_vencedor',
      severity: 'info',
      title: 'O teste "Teste · Combo sexta" acabou sem vencedor',
      detail: 'Em 28 dias, o criativo A trouxe 1 pedido no caixa e o criativo B, 0 pedidos: pelo caixa, os dois vendem parecido. A campanha de teste continua no ar, e os dois criativos ficam como estão.',
      action: 'Veja o teste em Aprovações. Você pode ficar com os dois, ou encerrar o teste e testar outra coisa (a oferta, o texto).',
    });
    const motivo = 'A campanha de teste foi pausada fora do Liame. O Liame parou de medir: com um lado diferente do outro, a comparação não vale.';
    expect(textoDoAvisoDoTeste({ teste: ID, acao: ACAO, nome: 'Teste · Combo sexta', tipo: 'interrompido', motivo, noAr: true })).toEqual({
      kind: 'teste_interrompido',
      severity: 'atencao',
      title: 'O teste "Teste · Combo sexta" foi interrompido',
      detail: `${motivo} A campanha de teste continua no ar na Meta, e o Liame não mexe nela sozinho.`,
      action: 'Veja o teste em Aprovações. Encerrar o teste pausa a campanha de teste.',
    });
    // Sem a campanha de teste no ar, fica só o motivo; sem motivo guardado, a frase curta.
    expect(textoDoAvisoDoTeste({ teste: ID, acao: null, nome: 'Teste · Combo sexta', tipo: 'interrompido', motivo: null, noAr: false })).toMatchObject({
      detail: 'O Liame parou de medir este teste.',
      action: 'Veja o teste em Aprovações. Para comparar os criativos de novo, peça outro teste em Criativos.',
    });
  });
});
