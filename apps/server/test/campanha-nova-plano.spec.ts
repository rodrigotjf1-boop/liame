import { describe, expect, it } from 'vitest';
import {
  campanhaNovaDoRecurso,
  type EstadoDaCampanhaNova,
  fimDoDia,
  MELHORIAS_DO_CRIATIVO,
  parametrosDaCampanha,
  parametrosDoAnuncio,
  parametrosDoConjunto,
  parametrosDoCriativo,
  planoDaCampanhaNova,
  rastreioDoAnuncio,
  recursoDaCampanhaNova,
  verbaNaMenorUnidade,
} from '../src/campanhas/campanha-nova-plano.js';

// A4 · X5, parte 1, sem rede e sem banco: o plano da ferramenta `campanha_criar` e os parâmetros de cada objeto na Meta,
// pela referência reconferida em 11/11/2026 (D-A4-40): o objetivo de cada destino, a verba no conjunto sem dividir, o
// raio em quilômetros, o público sem a ampliação da Meta, o fim do dia no fuso da empresa, o criativo com a Página, o
// botão e o rastreio, e as melhorias todas desligadas.

const ID = '01900000-0000-7000-8000-000000000001';
const estado = (o: Partial<EstadoDaCampanhaNova> = {}): EstadoDaCampanhaNova => ({
  campanha: ID,
  marca: '01900000-0000-7000-8000-0000000000b1',
  nome: 'Combo sexta · novembro',
  objetivo: 'cardapio',
  peca: { id: '01900000-0000-7000-8000-0000000000c1', versao: 2, titulo: 'Smash duplo na sexta', texto: 'Peça o combo pelo cardápio.', botao: 'pedir_agora' },
  midia: { id: '01900000-0000-7000-8000-0000000000d1', tipo: 'foto', arquivo: 'a'.repeat(64) },
  pagina: { id: '1234567890', nome: 'Mister Burgers' },
  instagram: { id: '17840000000000001', nome: '@misterburgers' },
  loja: { id: '01900000-0000-7000-8000-0000000000e1', nome: 'Loja Centro', latitude: -22.906847, longitude: -43.172897 },
  raio_km: 5,
  verba_diaria_micros: 30_000_000,
  moeda: 'BRL',
  fim: null,
  fuso: 'America/Sao_Paulo',
  link: 'https://cardapio.exemplo.com.br/mister-centro',
  situacao: 'pedida',
  ...o,
});

describe('a campanha nova (A4 · X5, parte 1)', () => {
  it('o recurso e o plano: pedida vira criada; o que já foi criado, cancelado ou recusado não volta', () => {
    expect(campanhaNovaDoRecurso(recursoDaCampanhaNova(ID))).toBe(ID);
    expect(campanhaNovaDoRecurso('campanha:123')).toBeNull();
    expect(campanhaNovaDoRecurso('campanha_nova:nao-e-uuid')).toBeNull();
    const p = planoDaCampanhaNova(estado());
    expect(p.ok && p.desejado.situacao).toBe('criada');
    expect(planoDaCampanhaNova(estado({ situacao: 'criada' }))).toEqual({ ok: false, motivo: 'Esta campanha nova já foi criada na Meta, pausada.' });
    expect(planoDaCampanhaNova(estado({ situacao: 'cancelada' })).ok).toBe(false);
    expect(planoDaCampanhaNova(estado({ objetivo: 'whatsapp' })).ok).toBe(false);
    expect(planoDaCampanhaNova({ qualquer: 1 }).ok).toBe(false);
  });

  it('a campanha: Tráfego para o cardápio, Engajamento para o WhatsApp; sem categoria especial, sem verba própria, pausada', () => {
    expect(parametrosDaCampanha(estado())).toEqual({
      name: 'Combo sexta · novembro',
      objective: 'OUTCOME_TRAFFIC',
      status: 'PAUSED',
      buying_type: 'AUCTION',
      special_ad_categories: '[]',
      is_adset_budget_sharing_enabled: 'false',
    });
    expect(parametrosDaCampanha(estado({ objetivo: 'whatsapp', link: null })).objective).toBe('OUTCOME_ENGAGEMENT');
  });

  it('o conjunto: a verba em centavos, o raio em km, 18+, sem ampliar o público, o WhatsApp com a Página e o fim no fuso', () => {
    const c = parametrosDoConjunto(estado(), '111');
    expect(c).toMatchObject({ campaign_id: '111', status: 'PAUSED', daily_budget: '3000', bid_strategy: 'LOWEST_COST_WITHOUT_CAP', billing_event: 'IMPRESSIONS', optimization_goal: 'LINK_CLICKS' });
    expect(c.destination_type).toBeUndefined();
    expect(c.end_time).toBeUndefined();
    expect(JSON.parse(c.targeting!)).toEqual({
      geo_locations: { custom_locations: [{ latitude: -22.906847, longitude: -43.172897, radius: 5, distance_unit: 'kilometer' }] },
      age_min: 18,
      targeting_automation: { advantage_audience: 0 },
    });
    const w = parametrosDoConjunto(estado({ objetivo: 'whatsapp', link: null, fim: '2026-11-30', raio_km: 2.5 }), '111');
    expect(w).toMatchObject({ optimization_goal: 'CONVERSATIONS', destination_type: 'WHATSAPP', end_time: '2026-12-01T02:59:59.000Z' });
    expect(JSON.parse(w.promoted_object!)).toEqual({ page_id: '1234567890' });
    expect(w.name).toBe('Combo sexta · novembro · 2,5 km');
    // A verba com fração de centavo não vai à Meta.
    expect(verbaNaMenorUnidade(30_000_000)).toBe(3000);
    expect(verbaNaMenorUnidade(30_005_000)).toBeNull();
    expect(() => parametrosDoConjunto(estado({ verba_diaria_micros: 30_005_000 }), '111')).toThrow();
    // O fim do dia no fuso: 23:59:59 de São Paulo é 02:59:59 em UTC; em Manaus, 03:59:59.
    expect(fimDoDia('2026-11-30', 'America/Manaus')).toBe('2026-12-01T03:59:59.000Z');
  });

  it('o criativo: a Página e o Instagram dela, o texto e o título da peça, o botão com o mesmo link, o rastreio e as melhorias desligadas', () => {
    const c = parametrosDoCriativo(estado(), { tipo: 'foto', imagem: 'https://armazem.exemplo/foto.jpg' });
    const spec = JSON.parse(c.object_story_spec!);
    expect(spec).toEqual({
      page_id: '1234567890',
      instagram_user_id: '17840000000000001',
      link_data: {
        link: 'https://cardapio.exemplo.com.br/mister-centro',
        message: 'Peça o combo pelo cardápio.',
        name: 'Smash duplo na sexta',
        picture: 'https://armazem.exemplo/foto.jpg',
        call_to_action: { type: 'ORDER_NOW', value: { link: 'https://cardapio.exemplo.com.br/mister-centro' } },
      },
    });
    expect(c.url_tags).toBe(rastreioDoAnuncio());
    expect(c.url_tags).toBe('utm_source=meta&utm_medium=paid&utm_campaign={{campaign.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}');
    const melhorias = JSON.parse(c.degrees_of_freedom_spec!).creative_features_spec;
    expect(Object.keys(melhorias)).toHaveLength(MELHORIAS_DO_CRIATIVO.length);
    expect(Object.values(melhorias).every((m) => (m as { enroll_status: string }).enroll_status === 'OPT_OUT')).toBe(true);
    expect(c.degrees_of_freedom_spec).not.toContain('standard_enhancements');

    // O vídeo no WhatsApp: o vídeo e a capa, o botão do WhatsApp, sem o rastreio de site; sem o Instagram ligado, só a Página.
    const v = parametrosDoCriativo(estado({ objetivo: 'whatsapp', link: null, instagram: null }), { tipo: 'video', videoId: '999', capa: 'https://armazem.exemplo/capa.jpg' });
    expect(JSON.parse(v.object_story_spec!)).toEqual({
      page_id: '1234567890',
      video_data: {
        video_id: '999',
        image_url: 'https://armazem.exemplo/capa.jpg',
        message: 'Peça o combo pelo cardápio.',
        title: 'Smash duplo na sexta',
        call_to_action: { type: 'WHATSAPP_MESSAGE', value: { app_destination: 'WHATSAPP', link: 'https://api.whatsapp.com/send' } },
      },
    });
    expect(v.url_tags).toBeUndefined();
    expect(parametrosDoAnuncio(estado(), '222', '333')).toEqual({ name: 'Combo sexta · novembro · anúncio', adset_id: '222', creative: '{"creative_id":"333"}', status: 'PAUSED' });
  });
});
