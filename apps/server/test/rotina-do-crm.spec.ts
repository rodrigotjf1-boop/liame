import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { conferirPedidoDoCrm } from '../src/ai/crm/contexto.js';
import { type BaseDaMensagem, conferirMensagem, corpoDeExemplo, NOME_DE_EXEMPLO, RODAPE_DE_SAIDA, TAMANHO_DA_META } from '../src/ai/crm/mensagem.js';
import { FORMATO_DA_CHAVE_REGEMCAST } from '../src/connectors/regemcast/conector-regemcast.js';
import { cupomDoDesconto, type DescontoGuardado } from '../src/mensageria/desconto.js';
import { type CupomDaMensagem, PropostaDeMensagem, textoComVariaveis } from '../src/mensageria/proposta-de-mensagem.js';
import { ehCodigo } from '../src/mensageria/proposta-do-crm.js';
import {
  chaveDoModelo,
  codigoDoCupom,
  cupomEmPalavras,
  cupomNoDia,
  DIAS_ENTRE_PROPOSTAS,
  DIAS_PARA_REPETIR_A_OFERTA,
  DIAS_PARA_ESCREVER,
  diasDoCupom,
  fimDoIntervalo,
  HORAS_DEPOIS_DE_FALHA,
  HORAS_ENTRE_OLHADAS,
  IDIOMA_DO_MODELO,
  itensQueBarraram,
  MINUTOS_DE_ESPERA_SEM_IA,
  minutosAteATentativa,
  prazoDeEscreverAcabou,
  TENTATIVAS_DA_ESCRITA,
  LETRAS_DO_CODIGO,
  modeloParaRascunhar,
  nomeDoModelo,
  ofertaDaVez,
  ofertaPodeVirarMensagem,
  passouOIntervalo,
  PERFIS_DO_MOTIVO,
  PESSOAS_NO_MINIMO,
  propostaParaOPedido,
  proximaOlhada,
  publicoDoMotivo,
  RESULTADOS_DO_OLHAR,
  tetoCheio,
  variaveisDaMensagem,
} from '../src/mensageria/rotina-do-crm.js';

// A5 · Y6, partes 6a e 6b: as regras puras da rotina do funcionário de CRM e mensageria, sem banco, sem modelo de IA e
// sem RegemCast. Para quem vai cada mensagem, de quanto em quanto tempo ele propõe, qual oferta divulga, o que ele
// decide ao olhar uma marca e quando olha de novo, o código e as palavras do cupom (a validade em dias, e não em
// data), o modelo que vai como rascunho e a proposta que vira pedido.

const LOJA = '0199a000-0000-7000-8000-00000000000a';
const MARCA = '0199a000-0000-7000-8000-00000000000b';
const CONTA = '0199a000-0000-7000-8000-00000000000c';
const PROPOSTA = '0199a1b2-c3d4-7e5f-8a6b-0123456789ab';
const AGORA = new Date('2026-10-11T15:00:00Z');
const HORA = 3_600_000;
const DIA = 24 * HORA;
const antes = (ms: number) => new Date(AGORA.getTime() - ms);

const migration0064 = readFileSync(resolve(process.cwd(), '../../packages/database/migrations/0064_rotina_do_crm.sql'), 'utf8');

const perfil = (id: string, pessoas: number, nome = id) => ({ id, nome, regra: `Regra de ${nome}`, pessoas });
const padrao: DescontoGuardado = { kind: 'percentual', percent: 10, value_cents: null, min_order_cents: null, valid_days: 2, coupon_account_id: LOJA };
const cupom = (d: Partial<DescontoGuardado> = {}, dia = '2026-10-11', codigo = 'PROMO7K3Q'): CupomDaMensagem => cupomDoDesconto({ ...padrao, ...d }, dia, codigo);

describe('a rotina do CRM: para quem vai cada mensagem', () => {
  it('os padrões: uma promoção por semana, um "volte a pedir" por mês, a mesma oferta só depois de 30 dias', () => {
    expect(DIAS_ENTRE_PROPOSTAS).toEqual({ promocao: 7, volte_a_pedir: 30 });
    expect(DIAS_PARA_REPETIR_A_OFERTA).toBe(30);
    expect(PERFIS_DO_MOTIVO).toEqual({ promocao: ['fieis', 'campeoes', 'promissores', 'novos'], volte_a_pedir: ['em_risco', 'nao_posso_perder'] });
    expect(PESSOAS_NO_MINIMO).toBe(10);
  });

  it('a promoção vai para o perfil de quem compra com mais gente; o "volte a pedir", para quem sumiu', () => {
    // "Perdidos" e "Sem histórico" têm mais gente, e não são de nenhum dos dois motivos.
    const publicos = { perfis: [perfil('perdidos', 900), perfil('fieis', 120, 'Fiéis'), perfil('campeoes', 40), perfil('novos', 310, 'Novos'), perfil('em_risco', 75, 'Em risco'), perfil('nao_posso_perder', 22), perfil('sem_historico', 2000)] };
    expect(publicoDoMotivo(publicos, 'promocao')).toEqual({ origem: { origem: 'perfil', id: 'novos' }, nome: 'Novos', regra: 'Regra de Novos', pessoas: 310 });
    expect(publicoDoMotivo(publicos, 'volte_a_pedir')).toEqual({ origem: { origem: 'perfil', id: 'em_risco' }, nome: 'Em risco', regra: 'Regra de Em risco', pessoas: 75 });
  });

  it('no empate vale a ordem do motivo; abaixo do mínimo, ou sem o perfil, ele não propõe', () => {
    expect(publicoDoMotivo({ perfis: [perfil('novos', 50), perfil('campeoes', 50), perfil('fieis', 50)] }, 'promocao')?.origem).toEqual({ origem: 'perfil', id: 'fieis' });
    expect(publicoDoMotivo({ perfis: [perfil('nao_posso_perder', 10), perfil('em_risco', 9)] }, 'volte_a_pedir')?.origem.id).toBe('nao_posso_perder');
    expect(publicoDoMotivo({ perfis: [perfil('em_risco', 9), perfil('nao_posso_perder', 0)] }, 'volte_a_pedir')).toBeNull();
    // A conta sem base ainda (o RegemCast não devolve perfil nenhum), ou só com perfis do outro motivo.
    expect(publicoDoMotivo({ perfis: [] }, 'promocao')).toBeNull();
    expect(publicoDoMotivo({ perfis: [perfil('fieis', 500)] }, 'volte_a_pedir')).toBeNull();
  });
});

describe('a rotina do CRM: qual oferta e com que frequência', () => {
  const OFERTAS = ['Combo sexta: smash, batata e refri por R$ 34,90', 'Milk-shake de 400 ml por R$ 16,90 na terça', 'Sobremesa da casa em pedidos acima de R$ 60,00'];

  it('a primeira oferta de Minha marca que não virou proposta nos últimos 30 dias', () => {
    expect(ofertaDaVez(OFERTAS, [], AGORA)).toBe(OFERTAS[0]);
    expect(ofertaDaVez(OFERTAS, [{ oferta: OFERTAS[0]!, em: antes(3 * DIA) }], AGORA)).toBe(OFERTAS[1]);
    // A mesma oferta, escrita com outra caixa e com espaço nas pontas, é a mesma.
    expect(ofertaDaVez(OFERTAS, [{ oferta: `  ${OFERTAS[0]!.toUpperCase()} `, em: antes(3 * DIA) }], AGORA)).toBe(OFERTAS[1]);
    // Depois de 30 dias ela volta a ter a vez.
    expect(ofertaDaVez(OFERTAS, [{ oferta: OFERTAS[0]!, em: antes(30 * DIA) }], AGORA)).toBe(OFERTAS[0]);
    expect(ofertaDaVez(OFERTAS, [{ oferta: OFERTAS[0]!, em: antes(30 * DIA - HORA) }], AGORA)).toBe(OFERTAS[1]);
  });

  it('todas usadas há pouco, ou Minha marca sem oferta: não há o que divulgar', () => {
    expect(ofertaDaVez(OFERTAS, OFERTAS.map((oferta, i) => ({ oferta, em: antes((i + 1) * DIA) })), AGORA)).toBeNull();
    expect(ofertaDaVez([], [], AGORA)).toBeNull();
    expect(ofertaDaVez(['   '], [], AGORA)).toBeNull();
  });

  it('a oferta que as regras não deixam divulgar é pulada na escolha, e a seguinte tem a vez', () => {
    const comBebida = ['Chope em dobro na quinta', ...OFERTAS];
    expect(ofertaPodeVirarMensagem(comBebida[0]!)).toBe(false);
    expect(ofertaPodeVirarMensagem(OFERTAS[0]!)).toBe(true);
    expect(ofertaPodeVirarMensagem('')).toBe(false);
    expect(ofertaDaVez(comBebida, [], AGORA)).toBe(OFERTAS[0]);
    // Só a de bebida: nada a divulgar, e ela não entra na fila para ser recusada depois.
    expect(ofertaDaVez(['Chope em dobro na quinta'], [], AGORA)).toBeNull();
    // A que serve passa na conferência do pedido, que é a mesma regra.
    expect(conferirPedidoDoCrm({ motivo: 'promocao', oferta: OFERTAS[0]!, publico: { nome: 'Fiéis', regra: null, pessoas: 120 }, cupom: cupomEmPalavras(cupom()) })).toEqual([]);
  });

  it('o intervalo conta da última proposta do mesmo tipo: 7 dias na promoção, 30 no "volte a pedir"', () => {
    expect(passouOIntervalo('promocao', null, AGORA)).toBe(true);
    expect(passouOIntervalo('promocao', antes(7 * DIA - HORA), AGORA)).toBe(false);
    expect(passouOIntervalo('promocao', antes(7 * DIA), AGORA)).toBe(true);
    expect(passouOIntervalo('volte_a_pedir', null, AGORA)).toBe(true);
    expect(passouOIntervalo('volte_a_pedir', antes(8 * DIA), AGORA)).toBe(false);
    expect(passouOIntervalo('volte_a_pedir', antes(30 * DIA - HORA), AGORA)).toBe(false);
    expect(passouOIntervalo('volte_a_pedir', antes(30 * DIA), AGORA)).toBe(true);
  });
});

describe('a rotina do CRM: o que ele decide ao olhar e quando olha de novo', () => {
  it('cada resultado é um código que o banco aceita, sem repetição, e só um quer dizer que ele propôs', () => {
    for (const r of RESULTADOS_DO_OLHAR) expect(ehCodigo(r), r).toBe(true);
    expect(new Set(RESULTADOS_DO_OLHAR).size).toBe(RESULTADOS_DO_OLHAR.length);
    expect(RESULTADOS_DO_OLHAR[0]).toBe('proposta_aberta');
    // O formato é o que a migration 0064 confere, e os tipos de mensagem da fila são os da proposta.
    expect(migration0064).toContain(`constraint message_routine_resultado check (outcome ~ '^[a-z_]{2,40}$')`);
    expect(migration0064).toContain(`check (motive in ('promocao', 'volte_a_pedir'))`);
    expect(Object.keys(DIAS_ENTRE_PROPOSTAS)).toEqual(['promocao', 'volte_a_pedir']);
  });

  it('uma vez por dia; o que falhou, em 1 hora; e, se só o intervalo impede, quando ele acabar', () => {
    expect([HORAS_ENTRE_OLHADAS, HORAS_DEPOIS_DE_FALHA]).toEqual([24, 1]);
    const em = (ms: number) => new Date(AGORA.getTime() + ms);
    for (const r of ['proposta_aberta', 'crm_desligado', 'sem_oferta', 'sem_publico', 'teto_cheio', 'em_andamento', 'sem_autorizacao'] as const) expect(proximaOlhada(r, AGORA), r).toEqual(em(24 * HORA));
    expect(proximaOlhada('regemcast_fora', AGORA)).toEqual(em(HORA));
    expect(proximaOlhada('erro', AGORA)).toEqual(em(HORA));
    // O intervalo acaba em 5 dias: ele volta em 5 dias, e não todo dia até lá.
    expect(proximaOlhada('intervalo', AGORA, em(5 * DIA))).toEqual(em(5 * DIA));
    // O intervalo acaba em 3 horas, ou não veio a data: amanhã, como os outros.
    expect(proximaOlhada('intervalo', AGORA, em(3 * HORA))).toEqual(em(24 * HORA));
    expect(proximaOlhada('intervalo', AGORA)).toEqual(em(24 * HORA));
    expect(proximaOlhada('intervalo', AGORA, null)).toEqual(em(24 * HORA));
    // A data só vale para o intervalo.
    expect(proximaOlhada('sem_oferta', AGORA, em(5 * DIA))).toEqual(em(24 * HORA));
    // O fim do intervalo é a última proposta mais os dias do tipo, e é quando `passouOIntervalo` passa a dizer sim.
    const ultima = antes(2 * DIA);
    expect(fimDoIntervalo('promocao', ultima)).toEqual(new Date(ultima.getTime() + 7 * DIA));
    expect(fimDoIntervalo('volte_a_pedir', ultima)).toEqual(new Date(ultima.getTime() + 30 * DIA));
    expect(passouOIntervalo('promocao', ultima, fimDoIntervalo('promocao', ultima))).toBe(true);
    expect(passouOIntervalo('promocao', ultima, new Date(fimDoIntervalo('promocao', ultima).getTime() - 1))).toBe(false);
  });

  it('o teto de gasto de mensagens cheio em qualquer período impede a proposta; em atenção, não', () => {
    expect(tetoCheio({ periodos: [] })).toBe(false);
    expect(tetoCheio({ periodos: [{ sinal: 'ok' }, { sinal: 'atencao' }] })).toBe(false);
    expect(tetoCheio({ periodos: [{ sinal: 'ok' }, { sinal: 'cheio' }] })).toBe(true);
  });
});

describe('a rotina do CRM: a escrita da mensagem', () => {
  it('três tentativas, cada uma mais longe da outra; três dias para escrever; uma hora de espera sem IA', () => {
    expect([TENTATIVAS_DA_ESCRITA, DIAS_PARA_ESCREVER, MINUTOS_DE_ESPERA_SEM_IA]).toEqual([3, 3, 60]);
    expect([0, 1, 2, 3].map(minutosAteATentativa)).toEqual([15, 30, 60, 120]);
    // Um valor fora do esperado não vira espera negativa nem sem fim.
    expect(minutosAteATentativa(-2)).toBe(15);
    expect(minutosAteATentativa(40)).toBe(15 * 64);
    const aberta = antes(3 * DIA);
    expect(prazoDeEscreverAcabou(aberta, AGORA)).toBe(true);
    expect(prazoDeEscreverAcabou(new Date(aberta.getTime() + 1), AGORA)).toBe(false);
    expect(prazoDeEscreverAcabou(antes(HORA), AGORA)).toBe(false);
  });

  it('o que barrou vai para a fila pelo nome do item, nunca pelo trecho; o aviso de tamanho não barra', () => {
    const base: BaseDaMensagem = { oferta: 'Combo sexta: smash, batata e refri por R$ 34,90', cupom: cupomEmPalavras(cupom()), fatos: 'Mister Burgers.', proibidas: ['gourmet'], concorrentes: [] };
    const conferida = (corpo: string, nome = 'Combo da sexta') => conferirMensagem({ nome, corpo }, base);
    expect(itensQueBarraram(conferida('Oi, {{1}}! Combo por R$ 34,90. Com o cupom {{2}} você ganha 10% de desconto, válido por 2 dias, contando hoje.'))).toEqual([]);
    // Outro desconto, uma palavra que a marca nunca diz e uma variável a mais: três itens, na ordem da conferência.
    const barrada = conferida('Oi, {{1}}! Combo gourmet com 20% de desconto no cupom {{2}}, para {{3}}.');
    expect(itensQueBarraram(barrada)).toEqual(['oferta', 'regras_da_marca', 'formato']);
    for (const item of itensQueBarraram(barrada)) expect(ehCodigo(item), item).toBe(true);
    // O nome comprido só avisa: a mensagem passa, e nada vai para a fila como barrado.
    const comAviso = conferida('Oi, {{1}}! Combo por R$ 34,90. Use o cupom {{2}}.', 'Combo da sexta com batata e refri para a família toda');
    expect(comAviso.situacao).toBe('aviso');
    expect(itensQueBarraram(comAviso)).toEqual([]);
  });
});

describe('a rotina do CRM: o cupom da mensagem', () => {
  it('o código diz o tipo e termina em quatro letras sem as que se confundem', () => {
    const fixo = (valores: number[]) => {
      let i = 0;
      return () => valores[i++ % valores.length]!;
    };
    expect(codigoDoCupom('promocao', fixo([0, 0, 0, 0]))).toBe('PROMOAAAA');
    expect(codigoDoCupom('volte_a_pedir', fixo([0.999999, 0.5, 0.25, 0]))).toBe('VOLTE9SJA');
    // O sorteio que devolve o limite (1) ou um valor fora não quebra o código.
    expect(codigoDoCupom('promocao', fixo([1, 1.5, -0.2, 0.999999]))).toBe('PROMO99A9');
    expect(LETRAS_DO_CODIGO).toHaveLength(32);
    for (const confunde of ['0', 'O', '1', 'I']) expect(LETRAS_DO_CODIGO).not.toContain(confunde);
    // Todo código cabe no formato que a proposta de mensagem e o contrato de cupons do Regem aceitam.
    const fora: string[] = [];
    for (let n = 0; n < 320; n++) {
      const codigo = codigoDoCupom(n % 2 ? 'promocao' : 'volte_a_pedir', fixo([n / 320, ((n * 7) % 320) / 320, ((n * 13) % 320) / 320, ((n * 29) % 320) / 320]));
      if (!/^(PROMO|VOLTE)[A-HJ-NP-Z2-9]{4}$/.test(codigo)) fora.push(codigo);
    }
    expect(fora).toEqual([]);
  });

  it('o cupom diz por quantos dias vale, e anda para o dia do envio com os mesmos dias', () => {
    expect(diasDoCupom(cupom())).toBe(2);
    expect(diasDoCupom(cupom({ valid_days: 1 }))).toBe(1);
    expect(diasDoCupom(cupom({ valid_days: 14 }, '2026-12-25'))).toBe(14);
    // A proposta nasceu no dia 11; o envio saiu no dia 15: o cupom vale no 15 e no 16.
    expect(cupomNoDia(cupom(), '2026-10-15')).toEqual({ ...cupom(), valido_de: '2026-10-15', valido_ate: '2026-10-16' });
    expect(cupomNoDia(cupom({ valid_days: 1 }), '2026-10-31')).toMatchObject({ valido_de: '2026-10-31', valido_ate: '2026-10-31' });
    expect(cupomNoDia(cupom({ valid_days: 3 }), '2026-12-31')).toMatchObject({ valido_de: '2026-12-31', valido_ate: '2027-01-02' });
    // O mesmo dia: nada muda; e andar duas vezes dá o mesmo que andar uma.
    expect(cupomNoDia(cupom(), '2026-10-11')).toEqual(cupom());
    expect(cupomNoDia(cupomNoDia(cupom({ valid_days: 5 }), '2026-10-20'), '2026-11-02')).toEqual(cupomNoDia(cupom({ valid_days: 5 }), '2026-11-02'));
  });

  it('em palavras: o benefício como preço ou percentual, o pedido mínimo quando há, e a validade em dias', () => {
    expect(cupomEmPalavras(cupom())).toEqual({ beneficio: '10% de desconto', validade: 'válido por 2 dias, contando hoje' });
    expect(cupomEmPalavras(cupom({ min_order_cents: 4000, valid_days: 14 }))).toEqual({ beneficio: '10% de desconto em pedidos a partir de R$ 40,00', validade: 'válido por 14 dias, contando hoje' });
    expect(cupomEmPalavras(cupom({ kind: 'valor', percent: null, value_cents: 1000, min_order_cents: 100_000, valid_days: 3 }))).toEqual({
      beneficio: 'R$ 10,00 de desconto em pedidos a partir de R$ 1.000,00',
      validade: 'válido por 3 dias, contando hoje',
    });
    expect(cupomEmPalavras(cupom({ kind: 'frete_gratis', percent: null, valid_days: 1 }))).toEqual({ beneficio: 'entrega grátis', validade: 'válido por 1 dia: só hoje' });
    // As palavras não dependem do dia em que o cupom começa: só dos dias.
    expect(cupomEmPalavras(cupomNoDia(cupom(), '2027-02-27'))).toEqual(cupomEmPalavras(cupom()));
  });

  it('a conferência da mensagem aceita o que as palavras do cupom dizem, e barra outro desconto e outro prazo', () => {
    const base = (c: CupomDaMensagem, oferta: string | null = 'Combo sexta: smash, batata e refri por R$ 34,90'): BaseDaMensagem => ({ oferta, cupom: cupomEmPalavras(c), fatos: 'Mister Burgers. Hamburgueria de bairro.', proibidas: [], concorrentes: [] });
    const conferir = (corpo: string, c: CupomDaMensagem, oferta?: string | null) => conferirMensagem({ nome: 'Combo da sexta', corpo }, base(c, oferta));
    const achados = (r: ReturnType<typeof conferirMensagem>) => r.itens.flatMap((i) => i.achados.map((a) => `${a.tipo}: ${a.trecho}`));

    const percentual = conferir('Oi, {{1}}! Sexta é dia de combo: smash, batata e refri por R$ 34,90. Com o cupom {{2}} você ganha 10% de desconto, válido por 2 dias, contando hoje. Peça pelo cardápio.', cupom());
    expect(achados(percentual)).toEqual([]);
    expect(percentual.situacao).toBe('passou');

    const valor = cupom({ kind: 'valor', percent: null, value_cents: 1000, min_order_cents: 5000, valid_days: 3 });
    expect(achados(conferir('Oi, {{1}}! Faz um tempo que a gente não se vê. Com o cupom {{2}} você ganha R$ 10,00 de desconto em pedidos a partir de R$ 50,00, válido por 3 dias, contando hoje. Peça pelo cardápio.', valor, null))).toEqual([]);

    const entrega = cupom({ kind: 'frete_gratis', percent: null, valid_days: 1 });
    expect(achados(conferir('Oi, {{1}}! Faz um tempo que a gente não se vê. Com o cupom {{2}} a entrega é grátis, válido por 1 dia: só hoje. Peça pelo cardápio.', entrega, null))).toEqual([]);

    // Outro prazo e outro desconto não passam: o número de dias e o percentual são os do cupom.
    const outroPrazo = conferir('Oi, {{1}}! Com o cupom {{2}} você ganha 10% de desconto, válido por 5 dias. Peça pelo cardápio.', cupom());
    expect(outroPrazo.situacao).toBe('barrou');
    expect(achados(outroPrazo)).toEqual(['numero_fora: 5']);
    const outroDesconto = conferir('Oi, {{1}}! Com o cupom {{2}} você ganha 20% de desconto, válido por 2 dias, contando hoje. Peça pelo cardápio.', cupom());
    expect(outroDesconto.situacao).toBe('barrou');
    expect(outroDesconto.itens.find((i) => i.item === 'oferta')!.achados.map((a) => a.tipo)).toContain('preco_fora');
  });
});

describe('a rotina do CRM: o modelo que vai como rascunho e a proposta que vira pedido', () => {
  const CORPO = 'Oi, {{1}}! Sexta é dia de combo. Com o cupom {{2}} você ganha 10% de desconto, válido por 2 dias, contando hoje. Peça pelo cardápio.';

  it('o modelo tem nome técnico único por proposta, o rodapé de saída e um exemplo para cada variável', () => {
    const modelo = modeloParaRascunhar({ id: PROPOSTA, motivo: 'promocao', corpo: CORPO, codigoDoCupom: 'PROMO7K3Q' });
    expect(modelo).toEqual({
      nome: 'liame_promocao_0199a1b2c3d47e5f8a6b0123456789ab',
      categoria: 'marketing',
      idioma: 'pt_BR',
      corpo: CORPO,
      corpoExemplos: ['Maria', 'PROMO7K3Q'],
      rodape: RODAPE_DE_SAIDA,
    });
    expect(IDIOMA_DO_MODELO).toBe('pt_BR');
    expect(modelo.corpoExemplos![0]).toBe(NOME_DE_EXEMPLO);
    // O nome técnico só tem minúsculas, números e sublinhado, e cabe no que a Meta aceita (512).
    for (const motivo of ['promocao', 'volte_a_pedir'] as const) {
      const nome = nomeDoModelo(motivo, PROPOSTA.toUpperCase());
      expect(nome).toMatch(/^[a-z0-9_]{1,512}$/);
      expect(nome).toBe(nomeDoModelo(motivo, PROPOSTA));
    }
    expect(nomeDoModelo('promocao', PROPOSTA)).not.toBe(nomeDoModelo('promocao', '0199a1b2-c3d4-7e5f-8a6b-0123456789ac'));
    expect(nomeDoModelo('promocao', PROPOSTA)).not.toBe(nomeDoModelo('volte_a_pedir', PROPOSTA));
    // O rodapé cabe no da Meta, e o exemplo é o corpo como a pessoa vai ler.
    expect(Array.from(modelo.rodape!).length).toBeLessThanOrEqual(TAMANHO_DA_META.rodape);
    expect(corpoDeExemplo(modelo.corpo, 'PROMO7K3Q')).toContain('Oi, Maria! Sexta é dia de combo. Com o cupom PROMO7K3Q você ganha');
  });

  it('a chave do rascunho é a da proposta: a rotina que repete não cria dois modelos', () => {
    expect(chaveDoModelo(PROPOSTA)).toBe(`liame:modelo:${PROPOSTA}`);
    expect(chaveDoModelo(PROPOSTA)).toMatch(FORMATO_DA_CHAVE_REGEMCAST);
  });

  it('as variáveis: o primeiro nome é do RegemCast, o código do cupom é fixo', () => {
    expect(variaveisDaMensagem('PROMO7K3Q')).toEqual([{ origem: 'primeiro_nome' }, { origem: 'fixo', valor: 'PROMO7K3Q' }]);
    expect(textoComVariaveis(CORPO, variaveisDaMensagem('PROMO7K3Q'))).toContain('Oi, [primeiro nome]! Sexta é dia de combo. Com o cupom PROMO7K3Q você');
  });

  it('a proposta guardada vira uma proposta de mensagem que o pedido de envio aceita, com o cupom valendo do dia dado', () => {
    const guardada = { brandId: MARCA, conta: CONTA, nome: 'Combo da sexta', modelo: { nome: nomeDoModelo('promocao', PROPOSTA), idioma: 'pt_BR' }, publico: { origem: 'perfil' as const, id: 'fieis' }, cupom: cupom() };
    const lida = PropostaDeMensagem.parse(propostaParaOPedido(guardada, '2026-10-15'));
    expect(lida).toEqual({
      marca: MARCA,
      conta: CONTA,
      nome: 'Combo da sexta',
      modelo: { nome: 'liame_promocao_0199a1b2c3d47e5f8a6b0123456789ab', idioma: 'pt_BR' },
      publico: { origem: 'perfil', id: 'fieis' },
      variaveis: [{ origem: 'primeiro_nome' }, { origem: 'fixo', valor: 'PROMO7K3Q' }],
      janela: {},
      cupom: { loja: LOJA, codigo: 'PROMO7K3Q', tipo: 'percentual', percentual: 10, pedido_minimo_centavos: 0, valido_de: '2026-10-15', valido_ate: '2026-10-16' },
    });
    // Os três tipos de desconto passam pelo formato da proposta.
    for (const d of [{ kind: 'valor' as const, percent: null, value_cents: 1000, min_order_cents: 5000 }, { kind: 'frete_gratis' as const, percent: null, min_order_cents: 4000 }]) {
      expect(PropostaDeMensagem.safeParse(propostaParaOPedido({ ...guardada, cupom: cupom(d, '2026-10-11', codigoDoCupom('volte_a_pedir', () => 0.4)) }, '2026-10-15')).success).toBe(true);
    }
  });
});
