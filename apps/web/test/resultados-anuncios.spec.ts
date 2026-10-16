import type { AdDeliveryAccount, AdDeliveryCampaign, AdDeliveryResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  andamentoDaLeitura,
  avisoDoFim,
  type CartaoDosAnuncios,
  type EntradaDoCartao,
  falharamNoPrazo,
  type LerAgora,
  marcasDe,
  montarCartaoDosAnuncios,
  quandoLido,
  resultadoDe,
  taxa,
  tipoDaCampanha,
  umaCasa,
  valorDoResultado,
} from '@/components/resultados/anuncios';
import { VistaDosAnuncios } from '@/components/resultados/cartao-anuncios';
import { textoDe } from '@/components/resultados/textos';

// "Como os anúncios rodaram" (mockups/prototipo-desempenho-anuncios.html, P23 aprovado em 16/10/2026): as frases da
// leitura, os números e o andamento do "Ler agora". Datas fixas em Brasília (LIC-006): 16/10/2026 09:41 = 12:41 UTC.
// O dinheiro tem o espaço fixo depois do "R$" (V63).

const NB = String.fromCharCode(160);
const FUSO = 'America/Sao_Paulo';
const AGORA = new Date('2026-10-16T12:41:00.000Z');
const PEDIDO = '2026-10-16T12:41:00.000Z';

const META: AdDeliveryAccount = {
  connected_account_id: '00000000-0000-4000-8000-000000000001',
  provider: 'meta_ads',
  name: 'Mister Burgers',
  status: 'ativa',
  last_success_at: '2026-10-16T09:12:00.000Z',
  last_attempt_at: '2026-10-16T09:12:00.000Z',
  last_error: null,
};
const GOOGLE: AdDeliveryAccount = {
  ...META,
  connected_account_id: '00000000-0000-4000-8000-000000000002',
  provider: 'google_ads',
  name: 'Mister Burgers Ads',
  last_success_at: '2026-10-16T09:14:00.000Z',
  last_attempt_at: '2026-10-16T09:14:00.000Z',
};
const COMBO: AdDeliveryCampaign = {
  campaign_id: '00000000-0000-4000-8000-0000000000c1',
  provider: 'meta_ads',
  name: 'Combo sexta',
  status: 'ativa',
  objective: 'OUTCOME_TRAFFIC',
  impressions: '38947',
  reach: '21518',
  clicks: '1036',
  link_clicks: '812',
  spend_micros: '412500000',
  result: { kind: 'purchases', value: '36', window: '7d_click' },
};
const BUSCA: AdDeliveryCampaign = {
  campaign_id: '00000000-0000-4000-8000-0000000000c2',
  provider: 'google_ads',
  name: 'Busca marca',
  status: 'ativa',
  objective: 'SEARCH',
  impressions: '1970',
  reach: null,
  clicks: '120',
  link_clicks: null,
  spend_micros: '153000000',
  result: { kind: 'conversions', value: '7.5', window: 'padrao' },
};
const resposta = (over: Partial<AdDeliveryResponse> = {}): AdDeliveryResponse => ({
  enabled: true,
  period: { from: '2026-10-09', to: '2026-10-15' },
  accounts: [META, GOOGLE],
  totals: { impressions: '40917', clicks: '1156', spend_micros: '565500000', meta_reach: '39860' },
  campaigns: [COMBO, BUSCA],
  refresh: { available: true, next_at: null },
  ...over,
});
const entrada = (over: Partial<EntradaDoCartao> = {}): EntradaDoCartao => ({
  resposta: resposta(),
  periodo: '7',
  fuso: FUSO,
  agora: AGORA,
  leitura: { tipo: 'parado' },
  podeVerContas: true,
  ...over,
});
type ComNumeros = Extract<CartaoDosAnuncios, { tipo: 'numeros' }>;
function numeros(e: EntradaDoCartao): ComNumeros {
  const c = montarCartaoDosAnuncios(e);
  if (c.tipo !== 'numeros') throw new Error(`esperava os números, veio ${c.tipo}`);
  return c;
}
const linha = (e: EntradaDoCartao) => textoDe(numeros(e).leitura.frase);
const terminou = (falharam: ('meta_ads' | 'google_ads')[] = []): LerAgora => ({ tipo: 'terminou', pedidoEm: PEDIDO, falharam });
/** A leitura que acabou de terminar: as duas contas lidas às 09:41 e o botão de volta às 09:45. */
const lidasAgora = (over: Partial<AdDeliveryResponse> = {}) =>
  resposta({
    accounts: [
      { ...META, last_success_at: '2026-10-16T12:41:20.000Z', last_attempt_at: '2026-10-16T12:41:20.000Z' },
      { ...GOOGLE, last_success_at: '2026-10-16T12:41:30.000Z', last_attempt_at: '2026-10-16T12:41:30.000Z' },
    ],
    refresh: { available: false, next_at: '2026-10-16T12:45:00.000Z' },
    ...over,
  });

describe('as contas e os números', () => {
  it('a taxa de clique com uma casa abaixo de 10%, sem ponto flutuante', () => {
    expect(taxa(1036n, 38947n)).toBe('2,7%');
    expect(taxa(1156n, 40917n)).toBe('2,8%');
    expect(taxa(4n, 1000n)).toBe('0,4%');
    expect(taxa(150n, 1000n)).toBe('15%');
    expect(taxa(0n, 1000n)).toBe('0,0%');
    expect(taxa(3n, 0n)).toBe('—');
  });

  it('vezes por pessoa, o resultado da plataforma e o tipo da campanha', () => {
    expect(umaCasa(38947n, 21518n)).toBe('1,8');
    expect(umaCasa(5n, 0n)).toBe('—');
    expect(valorDoResultado('36')).toBe('36');
    expect(valorDoResultado('7.50')).toBe('7,5');
    expect(valorDoResultado('1234.00')).toBe('1.234');
    expect(resultadoDe(COMBO)).toEqual({ valor: '36', rotulo: 'compras' });
    expect(resultadoDe({ ...COMBO, result: { kind: 'conversations', value: '1', window: '7d_click' } })).toEqual({ valor: '1', rotulo: 'conversa iniciada' });
    expect(resultadoDe(BUSCA)).toEqual({ valor: '7,5', rotulo: 'conversões' });
    expect(resultadoDe({ ...BUSCA, result: null })).toEqual({ valor: '—', rotulo: 'resultado (a plataforma não informou)' });
    expect(tipoDaCampanha('OUTCOME_TRAFFIC')).toBe('tráfego');
    expect(tipoDaCampanha('SEARCH')).toBe('rede de pesquisa');
    expect(tipoDaCampanha('ALGO_NOVO')).toBeNull();
    expect(tipoDaCampanha(null)).toBeNull();
  });

  it('a hora da leitura: hoje, ontem, outro dia e outro ano, no fuso da loja', () => {
    expect(quandoLido('2026-10-16T09:12:00.000Z', FUSO, AGORA)).toBe('hoje às 06:12');
    // 01:30 UTC de 16/10 ainda é 15/10 em Brasília.
    expect(quandoLido('2026-10-16T01:30:00.000Z', FUSO, AGORA)).toBe('ontem às 22:30');
    expect(quandoLido('2026-10-13T09:12:00.000Z', FUSO, AGORA)).toBe('em 13/10 às 06:12');
    expect(quandoLido('2025-12-30T12:00:00.000Z', FUSO, AGORA)).toBe('em 30/12/2025 às 09:00');
  });
});

describe('o cartão', () => {
  it('com a função desligada para a empresa, nada aparece', () => {
    expect(montarCartaoDosAnuncios(entrada({ resposta: resposta({ enabled: false, accounts: [], campaigns: [] }) })).tipo).toBe('desligado');
  });

  it('sem plataforma de anúncio: o caminho para Contas conectadas, só para quem pode abrir', () => {
    const vazio = resposta({ accounts: [], campaigns: [], totals: { impressions: '0', clicks: '0', spend_micros: '0', meta_reach: null } });
    expect(montarCartaoDosAnuncios(entrada({ resposta: vazio }))).toEqual({
      tipo: 'sem-plataforma',
      texto: 'Nenhuma plataforma de anúncio está conectada. Conecte a Meta ou o Google para ver aqui quantas vezes os anúncios apareceram, os cliques e o gasto.',
      contas: true,
    });
    const semContas = montarCartaoDosAnuncios(entrada({ resposta: vazio, podeVerContas: false }));
    expect(semContas).toMatchObject({ tipo: 'sem-plataforma', contas: false });
    expect(semContas.tipo === 'sem-plataforma' && semContas.texto).not.toContain('Conecte');
  });

  it('lido de manhã: a hora de cada plataforma e os quatro números do período', () => {
    const c = numeros(entrada());
    expect(textoDe(c.leitura.frase)).toBe('Lido da Meta hoje às 06:12 e do Google às 06:14. A leitura de todo dia traz o dia anterior.');
    expect(c.leitura.frase.filter((t) => t.b).map((t) => t.t)).toEqual(['06:12', '06:14']);
    expect(c.leitura).toMatchObject({ falha: false, botao: { tipo: 'ler', rotulo: 'Ler agora', desligado: false, ocupado: false } });
    expect(c.caixas).toEqual([
      { valor: '40.917', rotulo: 'vezes que os anúncios apareceram', nota: 'impressões' },
      { valor: '39.860', rotulo: 'pessoas alcançadas na Meta', nota: 'cada pessoa conta uma vez no período' },
      { valor: '1.156', rotulo: 'cliques nos anúncios', nota: '2,8% de quem viu clicou' },
      { valor: `R$${NB}565,50`, rotulo: 'gastos nas plataformas', nota: `R$${NB}0,49 por clique` },
    ]);
    expect(c.notas).toEqual([]);
    expect(c.vazio).toBeNull();
  });

  it('cada campanha: a barra das vezes que apareceu, o resumo e as nove caixas do Pro', () => {
    const [combo, busca] = numeros(entrada()).campanhas;
    expect(combo).toMatchObject({ nome: 'Combo sexta', plataforma: 'Meta Ads', plataformaETipo: 'Meta Ads · tráfego', barra: 100, rotuloDaBarra: 'Combo sexta: apareceu 38.947 vezes' });
    expect(textoDe(combo!.resumo)).toBe(`38.947 vezes · 1.036 cliques (2,7%) · R$${NB}412,50`);
    expect(combo!.caixas.map((x) => [x.valor, x.rotulo, x.nota])).toEqual([
      ['38.947', 'impressões', null],
      ['21.518', 'pessoas alcançadas', null],
      ['1,8', 'vezes por pessoa', null],
      ['1.036', 'cliques', '812 no link'],
      ['2,7%', 'clicaram (CTR)', null],
      [`R$${NB}0,40`, 'por clique (CPC)', null],
      [`R$${NB}10,59`, 'por mil impressões (CPM)', null],
      [`R$${NB}412,50`, 'gastos', null],
      ['36', 'compras', null],
    ]);
    // O Google não informa o alcance: o traço, com o porquê; e a conversão dividida aparece com a casa.
    expect(busca).toMatchObject({ plataformaETipo: 'Google Ads · rede de pesquisa', barra: 5.05 });
    expect(textoDe(busca!.resumo)).toBe(`1.970 vezes · 120 cliques (6,1%) · R$${NB}153,00`);
    expect(busca!.caixas.slice(1, 4).map((x) => [x.valor, x.rotulo, x.nota])).toEqual([
      ['—', 'alcance (o Google não informa)', null],
      ['—', 'vezes por pessoa', null],
      ['120', 'cliques', null],
    ]);
    expect(busca!.caixas[8]).toEqual({ valor: '7,5', rotulo: 'conversões', nota: null });
    expect(numeros(entrada()).notaDoPro).toBe(
      'O alcance não se soma entre campanhas: a mesma pessoa pode ver mais de uma. O total é o que a Meta informa para a conta no período. O resultado é o que cada plataforma conta, na janela dela (a Meta, 7 dias depois do clique; o Google, a janela de cada conversão).',
    );
  });

  it('o alcance da Meta que ainda não foi lido no período fica com o traço e o porquê', () => {
    const r = resposta({ totals: { impressions: '40917', clicks: '1156', spend_micros: '565500000', meta_reach: null }, campaigns: [{ ...COMBO, reach: null }, BUSCA] });
    const c = numeros(entrada({ resposta: r }));
    expect(c.caixas![1]).toEqual({ valor: '—', rotulo: 'pessoas alcançadas na Meta', nota: 'a Meta ainda não informou o alcance deste período' });
    expect(c.campanhas[0]!.caixas[1]).toEqual({ valor: '—', rotulo: 'alcance (a Meta ainda não informou)', nota: null });
  });

  it('só a Meta conectada; só o Google (três números, sem o alcance)', () => {
    const soMeta = numeros(entrada({ resposta: resposta({ accounts: [META], campaigns: [COMBO] }) }));
    expect(soMeta.notas).toEqual(['O Google Ads não está conectado: aqui entram só as campanhas da Meta.']);
    expect(textoDe(soMeta.leitura.frase)).toBe('Lido da Meta hoje às 06:12. A leitura de todo dia traz o dia anterior.');
    const soGoogle = numeros(entrada({ resposta: resposta({ accounts: [GOOGLE], campaigns: [BUSCA], totals: { impressions: '1970', clicks: '120', spend_micros: '153000000', meta_reach: null } }) }));
    expect(soGoogle.notas).toEqual(['A Meta não está conectada: aqui entram só as campanhas do Google.']);
    expect(soGoogle.caixas!.map((x) => x.rotulo)).toEqual(['vezes que os anúncios apareceram', 'cliques nos anúncios', 'gastos nas plataformas']);
    expect(soGoogle.notaDoPro).toBe('O resultado é o que cada plataforma conta, na janela dela (o Google, a janela de cada conversão).');
    // A Meta desligada que ainda traz campanhas: "só as do Google" seria falso, então a nota não aparece.
    const comAntiga = numeros(entrada({ resposta: resposta({ accounts: [GOOGLE] }) }));
    expect(comAntiga.notas).toEqual([]);
  });

  it('a conta que nunca foi lida e a leitura de outro dia', () => {
    const nova = { ...GOOGLE, last_success_at: null, last_attempt_at: null };
    expect(linha(entrada({ resposta: resposta({ accounts: [META, nova] }) }))).toBe(
      'Lido da Meta hoje às 06:12. A primeira leitura do Google ainda não terminou. A leitura de todo dia traz o dia anterior.',
    );
    const antiga = { ...META, last_success_at: '2026-10-15T09:12:00.000Z' };
    expect(linha(entrada({ resposta: resposta({ accounts: [antiga, GOOGLE] }) }))).toBe(
      'Lido da Meta ontem às 06:12 e do Google hoje às 06:14. A leitura de todo dia traz o dia anterior.',
    );
    // Duas contas da Meta: vale a leitura mais antiga (os números estão completos até ela).
    const outra = { ...META, connected_account_id: '00000000-0000-4000-8000-000000000003', last_success_at: '2026-10-16T08:00:00.000Z' };
    expect(linha(entrada({ resposta: resposta({ accounts: [META, outra, GOOGLE] }) }))).toBe(
      'Lido da Meta hoje às 05:00 e do Google às 06:14. A leitura de todo dia traz o dia anterior.',
    );
  });
});

describe('o "Ler agora" na tela', () => {
  it('lendo: o botão desligado e ocupado', () => {
    for (const leitura of [{ tipo: 'pedindo' }, { tipo: 'lendo', pedidoEm: PEDIDO, desde: 0, antes: {}, vistas: {} }] as LerAgora[]) {
      const c = numeros(entrada({ leitura }));
      expect(textoDe(c.leitura.frase)).toBe('Lendo da Meta e do Google agora…');
      expect(c.leitura.botao).toEqual({ tipo: 'ler', rotulo: 'Lendo…', desligado: true, ocupado: true });
    }
  });

  it('lido agora: a hora e quando dá para ler de novo (a janela fixa de 15 minutos)', () => {
    const c = numeros(entrada({ resposta: lidasAgora(), leitura: terminou() }));
    expect(textoDe(c.leitura.frase)).toBe('Lido da Meta e do Google agora, às 09:41. Dá para ler de novo às 09:45.');
    expect(c.leitura.botao).toEqual({ tipo: 'ler', rotulo: 'Ler agora', desligado: true, ocupado: false });
    // Passada a janela, volta a linha de todo dia, com as horas novas, e o botão liga.
    const depois = numeros(entrada({ resposta: lidasAgora(), leitura: terminou(), agora: new Date('2026-10-16T12:45:10.000Z') }));
    expect(textoDe(depois.leitura.frase)).toBe('Lido da Meta hoje às 09:41 e do Google às 09:41. A leitura de todo dia traz o dia anterior.');
    expect(depois.leitura.botao).toMatchObject({ desligado: false });
  });

  it('outra pessoa leu há pouco: o botão espera a janela e a linha diz até quando', () => {
    const c = numeros(entrada({ resposta: resposta({ refresh: { available: false, next_at: '2026-10-16T12:45:00.000Z' } }) }));
    expect(textoDe(c.leitura.frase)).toBe('Lido da Meta hoje às 06:12 e do Google às 06:14. A leitura de todo dia traz o dia anterior. Dá para ler de novo às 09:45.');
    expect(c.leitura.botao).toMatchObject({ rotulo: 'Ler agora', desligado: true });
  });

  it('a Meta não respondeu: os números dela são os da leitura de manhã, os do Google são os de agora', () => {
    const r = lidasAgora({ accounts: [{ ...META, last_attempt_at: '2026-10-16T12:41:40.000Z', last_error: 'Meta 503' }, { ...GOOGLE, last_success_at: '2026-10-16T12:41:30.000Z' }] });
    const c = numeros(entrada({ resposta: r, leitura: terminou(['meta_ads']) }));
    expect(textoDe(c.leitura.frase)).toBe(
      'A Meta não respondeu agora (às 09:41). Os números da Meta abaixo são os da leitura de hoje às 06:12; os do Google foram lidos às 09:41. Dá para tentar de novo às 09:45.',
    );
    expect(c.leitura).toMatchObject({ falha: true, botao: { tipo: 'ler', rotulo: 'Tentar de novo', desligado: true } });
    // As duas falharam; e só a Meta conectada.
    const duas = numeros(entrada({ resposta: resposta({ refresh: { available: true, next_at: null } }), leitura: terminou(['meta_ads', 'google_ads']) }));
    expect(textoDe(duas.leitura.frase)).toBe('A Meta e o Google não responderam agora (às 09:41). Os números abaixo são os das últimas leituras: da Meta hoje às 06:12 e do Google às 06:14.');
    expect(duas.leitura.botao).toMatchObject({ rotulo: 'Tentar de novo', desligado: false });
    const so = numeros(entrada({ resposta: resposta({ accounts: [META], campaigns: [COMBO] }), leitura: terminou(['meta_ads']) }));
    expect(textoDe(so.leitura.frase)).toBe('A Meta não respondeu agora (às 09:41). Os números abaixo são os da leitura de hoje às 06:12.');
  });

  it('a leitura que passou do prazo sem terminar', () => {
    const c = numeros(entrada({ leitura: { tipo: 'demorou', pedidoEm: PEDIDO }, resposta: resposta({ refresh: { available: false, next_at: '2026-10-16T12:45:00.000Z' } }) }));
    expect(textoDe(c.leitura.frase)).toBe(
      'A leitura pedida às 09:41 ainda não terminou. Os números abaixo são os da leitura anterior: da Meta hoje às 06:12 e do Google às 06:14. Abra a tela de novo em alguns minutos. Dá para ler de novo às 09:45.',
    );
  });

  it('a Meta recusou a autorização: o caminho é Contas conectadas (ler de novo não resolve)', () => {
    const recusada = { ...META, status: 'desconectada' };
    const c = numeros(entrada({ resposta: resposta({ accounts: [recusada, GOOGLE] }) }));
    expect(textoDe(c.leitura.frase)).toBe(
      'A Meta recusou a autorização do Liame. Os números da Meta abaixo são os da última leitura, hoje às 06:12. Conecte a Meta de novo para voltar a ler.',
    );
    expect(c.leitura).toMatchObject({ falha: true, botao: { tipo: 'contas' } });
    // Quem não abre Contas conectadas não ganha o botão, e a frase diz a quem pedir.
    const sem = numeros(entrada({ resposta: resposta({ accounts: [recusada, GOOGLE] }), podeVerContas: false }));
    expect(textoDe(sem.leitura.frase)).toBe('A Meta recusou a autorização do Liame. Os números da Meta abaixo são os da última leitura, hoje às 06:12. Peça a quem cuida das contas para conectar a Meta de novo.');
    expect(sem.leitura.botao).toEqual({ tipo: 'nenhum' });
    const semPermissao = numeros(entrada({ resposta: resposta({ accounts: [META, { ...GOOGLE, status: 'sem_permissao', last_success_at: null }] }) }));
    expect(textoDe(semPermissao.leitura.frase)).toBe('Falta a permissão de leitura no Google. Os números do Google ainda não foram lidos. Confira a permissão da conta em Contas conectadas.');
  });
});

describe('o período "Hoje"', () => {
  const hoje = (over: Partial<EntradaDoCartao> = {}) =>
    entrada({ periodo: 'hoje', resposta: resposta({ period: { from: '2026-10-16', to: '2026-10-16' }, campaigns: [], totals: { impressions: '0', clicks: '0', spend_micros: '0', meta_reach: null } }), ...over });

  it('antes de ler o dia: diz que ainda não foi lido e o que o "Ler agora" traz', () => {
    const ontem = resposta({ period: { from: '2026-10-16', to: '2026-10-16' }, campaigns: [], accounts: [{ ...META, last_success_at: '2026-10-15T09:12:00.000Z' }, GOOGLE] });
    const c = numeros(hoje({ resposta: ontem }));
    expect(c.vazio).toBe('O dia de hoje ainda não foi lido: a leitura de todo dia traz o dia anterior. “Ler agora” traz os números de hoje até agora.');
    expect(c.caixas).toBeNull();
    expect(numeros(hoje({ resposta: ontem, leitura: { tipo: 'pedindo' } })).vazio).toBe('Lendo os números de hoje até agora…');
  });

  it('lido hoje e nenhum anúncio apareceu: diz até que hora (não que o dia não foi lido)', () => {
    expect(numeros(hoje()).vazio).toBe('Nenhum anúncio apareceu hoje até 06:12 (a última leitura).');
  });

  it('com números: até que hora o dia foi lido', () => {
    const c = numeros(entrada({ periodo: 'hoje', resposta: lidasAgora({ period: { from: '2026-10-16', to: '2026-10-16' } }), leitura: terminou() }));
    expect(c.notas).toEqual(['Hoje até 09:41: o dia ainda não terminou.']);
    expect(c.caixas).not.toBeNull();
  });

  it('7 e 30 dias sem nenhuma campanha: lido e vazio, ou esperando a primeira leitura', () => {
    const vazio = resposta({ campaigns: [], totals: { impressions: '0', clicks: '0', spend_micros: '0', meta_reach: null } });
    expect(numeros(entrada({ resposta: vazio })).vazio).toBe('Nenhum anúncio apareceu nos últimos 7 dias.');
    expect(numeros(entrada({ resposta: vazio, periodo: '30' })).vazio).toBe('Nenhum anúncio apareceu nos últimos 30 dias.');
    expect(numeros(entrada({ resposta: { ...vazio, accounts: [{ ...META, last_success_at: null }] } })).vazio).toBe('Os números aparecem aqui depois da primeira leitura.');
  });
});

describe('o andamento da leitura pedida', () => {
  const antes = marcasDe([META, GOOGLE]);

  it('terminou bem quando cada conta foi lida depois do pedido', () => {
    expect(andamentoDaLeitura([META, GOOGLE], PEDIDO, antes, {})).toEqual({ pendentes: 2, falharam: [] });
    const lidas = lidasAgora().accounts;
    expect(andamentoDaLeitura(lidas, PEDIDO, antes, {})).toEqual({ pendentes: 0, falharam: [] });
  });

  it('no meio da leitura, o erro antigo não conta como falha (o worker grava a hora no começo)', () => {
    const comErroAntigo = { ...META, last_error: 'Meta 503' };
    const marcas = marcasDe([comErroAntigo, GOOGLE]);
    const lendo = { ...comErroAntigo, last_attempt_at: '2026-10-16T12:41:10.000Z' };
    expect(andamentoDaLeitura([lendo, GOOGLE], PEDIDO, marcas, {})).toEqual({ pendentes: 2, falharam: [] });
    // A hora da tentativa parada entre duas consultas: ainda lendo.
    expect(andamentoDaLeitura([lendo, GOOGLE], PEDIDO, marcas, { [META.connected_account_id]: '2026-10-16T12:41:10.000Z' })).toEqual({ pendentes: 2, falharam: [] });
    // A hora mudou de novo (o fim da tentativa) e o erro ficou: terminou mal, mesmo com o mesmo texto de erro.
    const fim = { ...lendo, last_attempt_at: '2026-10-16T12:42:05.000Z' };
    expect(andamentoDaLeitura([fim, GOOGLE], PEDIDO, marcas, { [META.connected_account_id]: '2026-10-16T12:41:10.000Z' })).toEqual({ pendentes: 1, falharam: ['meta_ads'] });
  });

  it('um erro novo depois do pedido é falha logo; a conta que espera Contas conectadas não conta', () => {
    const falhou = { ...META, last_attempt_at: '2026-10-16T12:41:40.000Z', last_error: 'Meta 503' };
    const google = { ...GOOGLE, last_success_at: '2026-10-16T12:41:30.000Z', last_attempt_at: '2026-10-16T12:41:30.000Z' };
    expect(andamentoDaLeitura([falhou, google], PEDIDO, antes, {})).toEqual({ pendentes: 0, falharam: ['meta_ads'] });
    expect(andamentoDaLeitura([{ ...META, status: 'desconectada' }, google], PEDIDO, antes, {})).toEqual({ pendentes: 0, falharam: [] });
  });

  it('no fim do prazo, quem tentou depois do pedido e ficou com erro conta como falha', () => {
    const tentou = { ...META, last_attempt_at: '2026-10-16T12:41:10.000Z', last_error: 'Meta 503' };
    expect(falharamNoPrazo([tentou, GOOGLE], PEDIDO)).toEqual(['meta_ads']);
    expect(falharamNoPrazo([META, GOOGLE], PEDIDO)).toEqual([]);
  });

  it('o aviso do fim', () => {
    expect(avisoDoFim(terminou(), lidasAgora().accounts, FUSO)).toBe('Números lidos agora da Meta e do Google, às 09:41.');
    expect(avisoDoFim(terminou(['meta_ads']), [META, GOOGLE], FUSO)).toBe('A Meta não respondeu agora: os números dela são os da leitura anterior.');
    expect(avisoDoFim(terminou(['google_ads']), [META, GOOGLE], FUSO)).toBe('O Google não respondeu agora: os números dele são os da leitura anterior.');
    expect(avisoDoFim(terminou(['meta_ads', 'google_ads']), [META, GOOGLE], FUSO)).toBe('A Meta e o Google não responderam agora: os números deles são os da leitura anterior.');
    expect(avisoDoFim({ tipo: 'demorou', pedidoEm: PEDIDO }, [META], FUSO)).toBe('A leitura ainda não terminou. Abra a tela de novo em alguns minutos.');
    expect(avisoDoFim({ tipo: 'parado' }, [META], FUSO)).toBeNull();
  });
});

describe('o cartão desenhado', () => {
  const desenhar = (e: EntradaDoCartao, pro = false, aberto = false) => {
    const cartao = montarCartaoDosAnuncios(e);
    if (cartao.tipo === 'desligado') throw new Error('desligado');
    return renderToStaticMarkup(createElement(VistaDosAnuncios, { cartao, pro, aberto, aoAlternar: () => {}, aoLer: () => {} }));
  };

  it('no modo simples: o título, a lista curta e o "Ver os números de cada campanha" com o alvo sempre na página', () => {
    const html = desenhar(entrada());
    expect(html).toContain('<h2 id="t-anuncios">Como os anúncios rodaram</h2>');
    expect(html).toContain('aria-controls="anuncios-pro"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Ver os números de cada campanha');
    expect(html).toMatch(/<div class="an-pro" id="anuncios-pro" hidden="">/);
    expect(html).toContain('role="img" aria-label="Combo sexta: apareceu 38.947 vezes"');
    expect(html).toContain('style="width:100%"');
  });

  it('aberto no modo simples: as caixas entram no lugar da lista curta', () => {
    const html = desenhar(entrada(), false, true);
    expect(html).not.toContain('funil-trilho');
    expect(html).toContain('Ocultar os números de cada campanha');
    expect(html).toMatch(/<div class="an-pro" id="anuncios-pro">/);
  });

  it('no Pro: o título do Pro, as nove caixas e a nota, sem o botão de detalhes', () => {
    const html = desenhar(entrada(), true);
    expect(html).toContain('Desempenho nas plataformas');
    expect(html).not.toContain('detalhes-bt');
    expect(html.match(/<ul class="an-met">/g)).toHaveLength(2);
    expect(html).toContain('O alcance não se soma entre campanhas');
  });

  it('o botão da linha da leitura: ler, lendo e Contas conectadas', () => {
    expect(desenhar(entrada())).toMatch(/<button class="btn btn--sm" type="button">.*Ler agora<\/button>/);
    expect(desenhar(entrada({ leitura: { tipo: 'pedindo' } }))).toMatch(/<button class="btn btn--sm" type="button" disabled="" aria-busy="true">.*Lendo…<\/button>/);
    const recusada = desenhar(entrada({ resposta: resposta({ accounts: [{ ...META, status: 'desconectada' }, GOOGLE] }) }));
    expect(recusada).toContain('<p id="an-status" tabindex="-1" class="an-falha">');
    expect(recusada).toMatch(/<a class="btn btn--sm" href="\/contas">.*Abrir Contas conectadas<\/a>/);
  });
});
