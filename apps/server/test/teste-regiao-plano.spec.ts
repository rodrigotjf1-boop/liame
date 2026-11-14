import { describe, expect, it } from 'vitest';
import { TOOLS } from '../src/actions/tools.js';
import { impressaoDoPublico, nomeDoTesteDeRegiao, planoDoTesteDeRegiao, recursoDoTesteDeRegiao, testeDeRegiaoDoRecurso } from '../src/campanhas/teste-regiao-plano.js';

// R8, o teste de região (D-RG-81), sem rede e sem banco: o recurso no trilho, o nome, o plano da ferramenta (aprovar só
// marca o teste como pronto) e a impressão dos campos do público que o Liame controla (a Meta devolve campos que ninguém
// mandou, e a ordem das chaves não pode mudar a impressão).

const ID = '0190d2b0-0000-7000-8000-0000000000a1';
const estado = (situacao = 'pedido') => ({
  teste: ID,
  marca: ID,
  loja: { id: ID, nome: 'Loja Centro' },
  fuso: 'America/Sao_Paulo',
  bairro: { codigo: '3304557002', nome: 'Lapa', meta: null, latitude: -22.9133, longitude: -43.1825, raio_km: 1.5 },
  dias: 14,
  semanas: { de: '2026-10-17', ate: '2026-11-13', bairros: [{ nome: 'Lapa', pedidos: 120 }] },
  conjuntos: [{ campanha: '120210000000000001', conjunto: '120210000000000101', nome: 'Raio de 3 km', impressao: 'a'.repeat(64) }],
  situacao,
});

describe('o teste de região no trilho (R8)', () => {
  it('o recurso, o nome e a ferramenta', () => {
    expect(recursoDoTesteDeRegiao(ID)).toBe(`teste_de_regiao:${ID}`);
    expect([testeDeRegiaoDoRecurso(`teste_de_regiao:${ID}`), testeDeRegiaoDoRecurso(`teste_de_criativo:${ID}`), testeDeRegiaoDoRecurso('teste_de_regiao:x')]).toEqual([ID, null, null]);
    expect(nomeDoTesteDeRegiao('Lapa')).toBe('Lapa sem anúncio por 14 dias');
    const t = TOOLS.teste_de_regiao!;
    expect([t.risk, t.providers, t.flag, t.alwaysApproval, t.onlyByRoute, t.directByPerson ?? false, t.undo === undefined]).toEqual(['R2', ['meta_ads'], 'teste_de_regiao', true, true, false, true]);
    // Aprovar não muda a verba: nada a reservar.
    expect(t.plan(estado(), {})).toMatchObject({ action: 'teste.regiao', budgetImpact: 'none', reserveMicros: 0, desiredState: { situacao: 'pronto' } });
  });

  it('o plano: só do teste pedido; o aprovado, o cancelado e o que não é teste de região são recusados', () => {
    expect(planoDoTesteDeRegiao(estado())).toMatchObject({ ok: true, desejado: { situacao: 'pronto' } });
    expect(planoDoTesteDeRegiao(estado('pronto'))).toEqual({ ok: false, motivo: 'Este teste já foi aprovado.' });
    expect(planoDoTesteDeRegiao(estado('cancelado'))).toEqual({ ok: false, motivo: 'Este teste foi cancelado.' });
    expect(planoDoTesteDeRegiao({ ...estado(), conjuntos: [] })).toEqual({ ok: false, motivo: 'Esta ferramenta é para um teste de região do Liame.' });
    expect(planoDoTesteDeRegiao({})).toEqual({ ok: false, motivo: 'Esta ferramenta é para um teste de região do Liame.' });
  });

  it('a impressão do público: só os campos que o Liame controla, sem depender da ordem das chaves', () => {
    const escrito = { geo_locations: { custom_locations: [{ latitude: -22.906847, longitude: -43.172897, radius: 3, distance_unit: 'kilometer' }] }, age_min: 18 };
    // Como a Meta devolve: com os tipos de local, os relaxamentos e as chaves em outra ordem.
    const lido = {
      age_min: 18,
      targeting_relaxation_types: { lookalike: 0, custom_audience: 0 },
      geo_locations: { location_types: ['home', 'recent'], custom_locations: [{ distance_unit: 'kilometer', radius: 3, longitude: -43.172897, latitude: -22.906847, country: 'BR' }] },
      brand_safety_content_filter_levels: ['FACEBOOK_STANDARD'],
    };
    expect(impressaoDoPublico(lido)).toBe(impressaoDoPublico(escrito));
    expect(impressaoDoPublico(escrito)).toMatch(/^[0-9a-f]{64}$/);
    // Mudou o que o Liame controla (o raio, a idade, o bairro de fora): muda a impressão.
    expect(impressaoDoPublico({ ...escrito, geo_locations: { custom_locations: [{ latitude: -22.906847, longitude: -43.172897, radius: 4, distance_unit: 'kilometer' }] } })).not.toBe(impressaoDoPublico(escrito));
    expect(impressaoDoPublico({ ...escrito, age_min: 21 })).not.toBe(impressaoDoPublico(escrito));
    expect(impressaoDoPublico({ ...escrito, excluded_geo_locations: { neighborhoods: [{ key: '2523742' }] } })).not.toBe(impressaoDoPublico(escrito));
  });
});
