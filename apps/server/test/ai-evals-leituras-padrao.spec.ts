import { describe, expect, it } from 'vitest';
import { foraDoDia } from '../src/ai/conversa/leituras.js';
import { leituraPadrao } from '../src/ai/evals/leituras-padrao.js';
import { visaoDoFrescor, visaoDosAvisos } from '../src/ai/registro/leituras.visoes.js';
import { visaoDosCupons } from '../src/ai/registro/visoes/cupons.js';
import { visaoDosLinks } from '../src/ai/registro/visoes/links.js';

// A leitura que um caso de eval não gravou: a visão neutra, no formato da visão de produção e coerente com o caso.

const FUSO = 'America/Sao_Paulo';
const caso = (leituras: Record<string, unknown> = {}) => ({ hoje: '2026-10-02', marca: 'Mister Burgers', leituras });
const resultados = (fontes: unknown[]) => ({ campanhas: [{ campanha: 'Combo sexta' }, { campanha: 'Delivery noite' }], fontes });
const chaves = (v: unknown): string[] => Object.keys(v as object).sort();

describe('leituras neutras dos evals (A3, evals com modelo de verdade)', () => {
  it('sem resultados gravados, o frescor mostra a conta de anúncios e o caixa em dia, lidos no dia do caso; e tem o formato da visão de produção', () => {
    const v = leituraPadrao(caso(), 'fontes_frescor') as { fuso: string; contas: Array<Record<string, unknown>> };
    expect(v).toEqual({
      fuso: FUSO,
      contas: [
        { plataforma: 'Meta', conta: 'CA Mister Burgers', situacao: 'ativa', dados: [{ conjunto: 'metricas', frescor: 'em dia', ultima_leitura: '02/10/2026 06:12', proxima_leitura: null }] },
        { plataforma: 'Regem', conta: 'Loja Centro', situacao: 'ativa', dados: [{ conjunto: 'pedidos', frescor: 'em dia', ultima_leitura: '02/10/2026 06:20', proxima_leitura: null }] },
      ],
    });
    // As mesmas chaves que a visão de produção monta para uma conta em dia.
    const producao = visaoDoFrescor(
      {
        items: [
          {
            connected_account_id: '0199a300-0000-7000-8000-00000000c001',
            brand_id: '0199a300-0000-7000-8000-00000000b001',
            provider: 'meta_ads',
            name: 'CA Mister Burgers',
            status: 'ativa',
            status_reason: null,
            datasets: [{ dataset: 'metricas', freshness: 'fresh', last_success_at: '2026-10-02T09:12:00.000Z', last_attempt_at: '2026-10-02T09:12:00.000Z', last_error: null, next_at: null }],
          },
        ],
      },
      FUSO,
    );
    expect(producao.contas[0]).toEqual(v.contas[0]);
    expect(chaves(v)).toEqual(chaves(producao));
  });

  it('com resultados gravados, o frescor repete as fontes deles: a fonte parada do caso aparece parada, com a mesma hora', () => {
    const c = caso({
      resultados_ciclo_fechado: resultados([
        { plataforma: 'Meta', conta: 'CA Mister Burgers', dados: 'metricas', frescor: 'em dia', ultima_leitura: '02/10/2026 06:12' },
        { plataforma: 'Regem', conta: 'Loja Centro', dados: 'pedidos', frescor: 'parado', ultima_leitura: '30/09/2026 09:42' },
      ]),
    });
    const frescor = leituraPadrao(c, 'fontes_frescor') as { contas: Array<{ plataforma: string; dados: Array<Record<string, unknown>> }> };
    expect(frescor.contas.map((x) => [x.plataforma, x.dados[0]!.frescor, x.dados[0]!.ultima_leitura])).toEqual([
      ['Meta', 'em dia', '02/10/2026 06:12'],
      ['Regem', 'parado', '30/09/2026 09:42'],
    ]);
    // Os cupons vêm do caixa: parado lá, parado aqui, e a conferência da conversa vê a fonte fora do dia.
    const cupons = leituraPadrao(c, 'cupons_campanha');
    expect(cupons).toMatchObject({ lojas: [{ loja: 'Loja Centro', leitura_dos_cupons: 'parado', ultima_leitura: '30/09/2026 09:42' }], total_de_cupons: 0, cupons: [] });
    expect(foraDoDia('cupons_campanha', cupons)).toHaveLength(1);
    expect(foraDoDia('cupons_campanha', leituraPadrao(caso(), 'cupons_campanha'))).toEqual([]);
  });

  it('avisos, cupons e links neutros têm as chaves das visões de produção: nenhum aviso, nenhum cupom, nada para arrumar', () => {
    expect(leituraPadrao(caso(), 'atencao_avisos')).toEqual(visaoDosAvisos([], '2026-10-02T09:25:00.000Z', FUSO));
    expect(leituraPadrao(caso(), 'atencao_avisos')).toEqual({ gerado_em: '02/10/2026 06:25', total: 0, avisos: [] });

    const cupons = visaoDosCupons({ stores: [], items: [], requests: [], create_in_regem: true } as unknown as Parameters<typeof visaoDosCupons>[0]);
    expect(chaves(leituraPadrao(caso(), 'cupons_campanha'))).toEqual(chaves(cupons));

    const links = visaoDosLinks(
      { items: [] } as unknown as Parameters<typeof visaoDosLinks>[0],
      { summary: { active_ads: 2, with_tracking: 2, without_tracking: 0, not_verifiable: 0, not_applicable: 0 }, items: [] } as unknown as Parameters<typeof visaoDosLinks>[1],
    );
    // Um anúncio ativo por campanha dos resultados do caso, todos com rastreio.
    expect(leituraPadrao(caso({ resultados_ciclo_fechado: resultados([]) }), 'links_rastreio')).toEqual(links);
    expect(leituraPadrao(caso(), 'links_rastreio')).toMatchObject({ rastreio_dos_anuncios: { anuncios_ativos: '0', com_rastreio: '0' } });
  });

  it('a entrega dos anúncios, a equipe e o que não é leitura não têm visão neutra: seguem falhando sem gravação', () => {
    expect(['midia_entrega', 'equipe_trabalho', 'resultados_ciclo_fechado', 'abrir_demanda', 'qualquer_coisa'].map((n) => leituraPadrao(caso(), n))).toEqual([undefined, undefined, undefined, undefined, undefined]);
  });
});
