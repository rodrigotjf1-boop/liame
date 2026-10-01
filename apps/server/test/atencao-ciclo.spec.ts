import { describe, expect, it } from 'vitest';
import {
  avisoAnunciosSemRastreio,
  avisoCampanhaSemPedido,
  avisoCampanhasSemCupom,
  avisoCupomSemUso,
  avisoMargemDesconhecida,
  avisoPlataformaCaixa,
  avisosDaFonte,
  avisoVendasNaoMedidas,
  type CampanhaNaJanela,
  type ItemCiclo,
  ordenarCiclo,
  reais,
} from '../src/results/atencao-ciclo.js';

// A2.5 · F9: as regras da Atenção do ciclo fechado, sem banco. Cada aviso tem o que houve, o motivo e o que
// fazer; os limiares de partida ficam num lugar só (`LIMIARES`).

const agora = new Date('2026-10-01T15:00:00Z');
const minutos = (n: number) => new Date(agora.getTime() - n * 60_000);
const loja = { id: 'l1', nome: 'Loja Centro', status: 'ativa', statusReason: null, fuso: 'America/Sao_Paulo', pedidosLidosEm: minutos(10) };
const nbsp = (s: string) => s.replace(/R\$ /g, 'R$ ');

describe('fonte das vendas', () => {
  it('em dia não avisa; pedidos lidos há mais de 2 horas é atenção e há mais de um dia é crítico', () => {
    expect(avisosDaFonte(loja, agora)).toEqual([]);
    expect(avisosDaFonte({ ...loja, pedidosLidosEm: minutos(119) }, agora)).toEqual([]);
    const atrasada = avisosDaFonte({ ...loja, pedidosLidosEm: minutos(121) }, agora);
    expect(atrasada.map((i) => [i.kind, i.severity, i.provider])).toEqual([['dado_atrasado', 'atencao', 'regem']]);
    expect(atrasada[0]!.title).toBe('As vendas da Loja Centro estão atrasadas');
    // 01/10 15:00 UTC menos 121 minutos = 09:59 em São Paulo.
    expect(atrasada[0]!.detail).toBe('Última leitura dos pedidos: 01/10/2026, 09:59.');
    expect(avisosDaFonte({ ...loja, pedidosLidosEm: minutos(1441) }, agora)[0]!.severity).toBe('critica');
    // Nunca leu (conexão nova): ainda não é atraso.
    expect(avisosDaFonte({ ...loja, pedidosLidosEm: null }, agora)).toEqual([]);
  });

  it('desconectada é crítico e basta; sem permissão é atenção; erro soma com o atraso', () => {
    const fora = avisosDaFonte({ ...loja, status: 'desconectada', statusReason: null, pedidosLidosEm: minutos(5000) }, agora);
    expect(fora.map((i) => [i.kind, i.severity])).toEqual([['conta_desconectada', 'critica']]);
    expect(fora[0]!.action).toContain('Contas conectadas');
    expect(avisosDaFonte({ ...loja, status: 'sem_permissao' }, agora).map((i) => i.kind)).toEqual(['conta_sem_permissao']);
    expect(avisosDaFonte({ ...loja, status: 'erro', statusReason: 'O Regem não respondeu.', pedidosLidosEm: minutos(300) }, agora).map((i) => [i.kind, i.detail.slice(0, 22)])).toEqual([
      ['conta_com_erro', 'O Regem não respondeu.'],
      ['dado_atrasado', 'Última leitura dos ped'],
    ]);
  });
});

describe('como medir', () => {
  it('anúncios sem rastreio e campanhas sem cupom: um aviso com a contagem, no singular e no plural', () => {
    expect(avisoAnunciosSemRastreio(0, 0)).toBeNull();
    expect(avisoAnunciosSemRastreio(1, 1)).toMatchObject({
      kind: 'anuncio_sem_rastreio',
      severity: 'atencao',
      title: '1 anúncio ativo sem os parâmetros do Liame',
      detail: 'Ele está em 1 campanha: as vendas que vierem dele ficam sem origem.',
    });
    expect(avisoAnunciosSemRastreio(4, 2)!.title).toBe('4 anúncios ativos sem os parâmetros do Liame');
    expect(avisoAnunciosSemRastreio(4, 2)!.detail).toBe('Eles estão em 2 campanhas: as vendas que vierem deles ficam sem origem.');
    expect(avisoCampanhasSemCupom(0, 'anotaai')).toBeNull();
    expect(avisoCampanhasSemCupom(1, 'anotaai')).toMatchObject({
      kind: 'campanha_sem_cupom',
      title: '1 campanha ativa sem cupom exclusivo',
      detail: 'Os anúncios levam ao Anota AI, e o clique não chega ao pedido: as vendas dela ficam sem origem.',
    });
    expect(avisoCampanhasSemCupom(6, 'cardapioweb')!.detail).toBe('Os anúncios levam ao CardápioWeb, e o clique não chega ao pedido: as vendas delas ficam sem origem.');
    expect(avisoVendasNaoMedidas({ id: 'l1', nome: 'Loja Centro' }, 'brendi')).toMatchObject({ kind: 'vendas_nao_medidas', severity: 'info', title: 'As vendas da Brendi da Loja Centro ainda não são medidas' });
  });
});

describe('gasto sem venda', () => {
  const campanha: CampanhaNaJanela = { id: 'c1', name: 'Combo sexta', provider: 'meta_ads', connectedAccountId: 'a1', gastoMicros: 152_600_000n, pedidos: 0, anunciosComRastreio: 2, temCupomExclusivo: false };

  it('campanha medida pelo clique, com gasto e sem pedido confirmado', () => {
    expect(avisoCampanhaSemPedido(campanha)).toMatchObject({
      kind: 'campanha_sem_pedido',
      severity: 'atencao',
      campaign_id: 'c1',
      title: nbsp('A campanha "Combo sexta" gastou R$ 152,60 em 7 dias e não teve pedido confirmado'),
    });
    // Com pedido, sem anúncio com rastreio (não há como medir), com cupom exclusivo (o aviso do cupom cobre) ou
    // com gasto abaixo do mínimo: não avisa.
    expect(avisoCampanhaSemPedido({ ...campanha, pedidos: 1 })).toBeNull();
    expect(avisoCampanhaSemPedido({ ...campanha, anunciosComRastreio: 0 })).toBeNull();
    expect(avisoCampanhaSemPedido({ ...campanha, temCupomExclusivo: true })).toBeNull();
    expect(avisoCampanhaSemPedido({ ...campanha, gastoMicros: 19_990_000n })).toBeNull();
    expect(avisoCampanhaSemPedido({ ...campanha, gastoMicros: 20_000_000n })).not.toBeNull();
  });

  it('cupom exclusivo sem uso só avisa com o vínculo de pelo menos 3 dias e a campanha gastando', () => {
    const cupom = { code: 'SEXTA10', campaignId: 'c1', campaignName: 'Combo sexta', provider: 'meta_ads', connectedAccountId: 'a1', ligadoEm: minutos(4 * 1440), usos: 0, gastoMicros: 80_000_000n };
    expect(avisoCupomSemUso(cupom, agora)).toMatchObject({
      kind: 'cupom_sem_uso',
      title: 'O cupom SEXTA10 não teve nenhum uso em 7 dias',
      detail: nbsp('Ele é o cupom exclusivo da campanha "Combo sexta", que gastou R$ 80,00 no período (Meta).'),
    });
    expect(avisoCupomSemUso({ ...cupom, usos: 1 }, agora)).toBeNull();
    expect(avisoCupomSemUso({ ...cupom, ligadoEm: minutos(2 * 1440) }, agora)).toBeNull();
    expect(avisoCupomSemUso({ ...cupom, gastoMicros: 0n }, agora)).toBeNull();
  });
});

describe('margem e plataforma × caixa', () => {
  it('margem desconhecida acima de 20% da receita atribuída; a ação muda quando a loja não libera o custo', () => {
    expect(avisoMargemDesconhecida(0n, 0n, true)).toBeNull();
    expect(avisoMargemDesconhecida(1_000_000_000n, 200_000_000n, true)).toBeNull();
    const aviso = avisoMargemDesconhecida(1_000_000_000n, 350_000_000n, true)!;
    expect(aviso).toMatchObject({ kind: 'margem_desconhecida', severity: 'atencao', title: 'Margem desconhecida em 35% da receita das campanhas' });
    expect(aviso.detail).toBe(nbsp('R$ 350,00 de R$ 1.000,00 atribuídos em 7 dias vieram de pedidos com item sem custo.'));
    expect(aviso.action).toContain('ficha técnica');
    expect(avisoMargemDesconhecida(1_000_000_000n, 1_000_000_000n, false)!.action).toContain('ainda não liberou o custo');
  });

  it('plataforma × caixa: só quando as duas têm valor e uma é o dobro (ou a metade) da outra', () => {
    expect(avisoPlataformaCaixa('meta_ads', 0n, 500_000_000n)).toBeNull();
    expect(avisoPlataformaCaixa('meta_ads', 500_000_000n, 0n)).toBeNull();
    expect(avisoPlataformaCaixa('meta_ads', 900_000_000n, 500_000_000n)).toBeNull();
    expect(avisoPlataformaCaixa('meta_ads', 1_000_000_000n, 500_000_000n)).toMatchObject({
      kind: 'plataforma_x_caixa',
      severity: 'info',
      title: nbsp('A Meta informa R$ 1.000,00 em vendas; no caixa, o Liame confirmou R$ 500,00'),
    });
    expect(avisoPlataformaCaixa('google_ads', 200_000_000n, 500_000_000n)!.title).toBe(nbsp('O Google Ads informa R$ 200,00 em vendas; no caixa, o Liame confirmou R$ 500,00'));
  });

  it('dinheiro em reais a partir de micros, arredondado ao centavo', () => {
    expect(reais(152_600_000n)).toBe(nbsp('R$ 152,60'));
    expect(reais(1_234_565_000n)).toBe(nbsp('R$ 1.234,57'));
    expect(reais(0n)).toBe(nbsp('R$ 0,00'));
  });
});

describe('ordem', () => {
  it('mais grave primeiro; na mesma gravidade, a fonte parada, o que impede medir, o dinheiro e o resto', () => {
    const item = (kind: ItemCiclo['kind'], severity: ItemCiclo['severity']): ItemCiclo => ({ kind, severity, title: kind, detail: '', action: '', connected_account_id: null, campaign_id: null, provider: null });
    const ordenados = ordenarCiclo([
      item('plataforma_x_caixa', 'info'),
      item('cupom_sem_uso', 'atencao'),
      item('campanha_sem_cupom', 'atencao'),
      item('vendas_nao_conectadas', 'info'),
      item('dado_atrasado', 'atencao'),
      item('conta_desconectada', 'critica'),
      item('margem_desconhecida', 'atencao'),
    ]);
    expect(ordenados.map((i) => i.kind)).toEqual(['conta_desconectada', 'dado_atrasado', 'campanha_sem_cupom', 'cupom_sem_uso', 'margem_desconhecida', 'vendas_nao_conectadas', 'plataforma_x_caixa']);
  });
});
