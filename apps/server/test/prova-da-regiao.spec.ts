import { describe, expect, it } from 'vitest';
import { type EstadoDaCampanhaNovaNoGoogle, type ImagensDoGoogle, operacoesDaCriacao } from '../src/campanhas/campanha-google-plano.js';
import {
  comTrava,
  type ContextoDaProva,
  criacaoComARegiao,
  EscritaSemValidacao,
  exigirSoValidacao,
  ProvaInterrompida,
  provaDaRegiao,
  publicoSemOBairro,
  temaDeTamanho,
  temasDeTeste,
} from '../src/campanhas/prova-da-regiao.js';
import { ErroConector, type PedidoConector } from '../src/connectors/cliente-http.js';
import { categoriaDoPerfil, nomeDaCategoria } from '../src/connectors/google-business/conector-perfil-google.js';
import { consultaDeLugares, type LugarNoGoogle, lugarDoTipo, lugaresDaResposta } from '../src/connectors/google-ads/lugares-no-google.js';

// A prova na conta real da D-RG-89 (plano da região, R9 e o teste de região), sem rede: a trava na saída única (o GET, a
// `suggest` e a escrita que a plataforma valida sem aplicar, pelo corpo montado; ajustes 1 e 3 da LIAME), os lugares
// pela constante e pelo pai (ajuste 2), a categoria do perfil e o nome dela pelo `categories:batchGet`, a criação do
// jeito do desenho (os temas no grupo de recursos novo e os bairros no lugar do raio, sobre a `operacoesDaCriacao` de
// verdade), e a prova inteira contra um Google e uma Meta de mentira que anotam cada chamada: nenhuma escrita sem a
// validação, a recusa da plataforma vira um passo, e a prova que para no meio leva os passos que já saíram.

const GOOGLE = 'https://googleads.googleapis.com';
const META = 'https://graph.facebook.com';
const pedidoGoogle = (corpo: unknown, caminho = 'customers/123/googleAds:mutate'): PedidoConector => ({
  provider: 'google_ads',
  conta: 'escrita:x',
  url: `${GOOGLE}/v22/${caminho}`,
  metodo: 'POST',
  corpo,
  endpoint: 'x',
  apiVersion: 'v22',
});
const pedidoMeta = (params: Record<string, string>, corpo?: unknown): PedidoConector => ({
  provider: 'meta_ads',
  conta: 'act_1',
  url: `${META}/v26.0/2381?${new URLSearchParams(params).toString()}`,
  metodo: 'POST',
  ...(corpo === undefined ? {} : { corpo }),
  endpoint: 'x',
  apiVersion: 'v26.0',
});
const OK = { status: 200, corpo: { ok: true }, cabecalhos: new Headers(), uso: null };

describe('a trava da prova: só sai a escrita que a plataforma valida sem aplicar', () => {
  it('Google: só o googleAds:mutate com validateOnly: true no corpo', () => {
    expect(() => exigirSoValidacao('google_ads', pedidoGoogle({ mutateOperations: [], validateOnly: true }))).not.toThrow();
    for (const corpo of [{ mutateOperations: [] }, { mutateOperations: [], validateOnly: false }, { mutateOperations: [], validateOnly: 'true' }, null, undefined]) {
      expect(() => exigirSoValidacao('google_ads', pedidoGoogle(corpo))).toThrow(EscritaSemValidacao);
    }
    expect(() => exigirSoValidacao('google_ads', pedidoGoogle({ operations: [], validateOnly: true }, 'customers/123/campaigns:mutate'))).toThrow(EscritaSemValidacao);
    expect(() => exigirSoValidacao('google_ads', { ...pedidoGoogle({ validateOnly: true }), metodo: 'GET' })).toThrow(EscritaSemValidacao);
  });

  it('Meta: só o POST sem corpo cujo execution_options é exatamente ["validate_only"]', () => {
    expect(() => exigirSoValidacao('meta_ads', pedidoMeta({ targeting: '{}', execution_options: '["validate_only"]' }))).not.toThrow();
    expect(() => exigirSoValidacao('meta_ads', pedidoMeta({ targeting: '{}' }))).toThrow(EscritaSemValidacao);
    expect(() => exigirSoValidacao('meta_ads', pedidoMeta({ targeting: '{}', execution_options: '["include_recommendations"]' }))).toThrow(EscritaSemValidacao);
    expect(() => exigirSoValidacao('meta_ads', pedidoMeta({ targeting: '{}', execution_options: '["validate_only","include_recommendations"]' }))).toThrow(EscritaSemValidacao);
    // Dois execution_options (um deles sem a validação) e o corpo que levaria a escrita por fora dos parâmetros.
    const dois = pedidoMeta({ targeting: '{}', execution_options: '["validate_only"]' });
    expect(() => exigirSoValidacao('meta_ads', { ...dois, url: `${dois.url}&execution_options=%5B%5D` })).toThrow(EscritaSemValidacao);
    expect(() => exigirSoValidacao('meta_ads', pedidoMeta({ execution_options: '["validate_only"]' }, { status: 'PAUSED' }))).toThrow(EscritaSemValidacao);
    // Lista fechada (refino da LIAME): o lote na raiz da Graph e um parâmetro a mais (status) não saem, mesmo validando.
    const lote = {
      ...pedidoMeta({}),
      url: `${META}/v26.0/?${new URLSearchParams({ batch: JSON.stringify([{ method: 'POST', relative_url: '2381?status=ACTIVE' }]), execution_options: '["validate_only"]' }).toString()}`,
    };
    expect(() => exigirSoValidacao('meta_ads', lote)).toThrow(EscritaSemValidacao);
    expect(() => exigirSoValidacao('meta_ads', { ...lote, url: lote.url.replace('/v26.0/?', '/v26.0/2381?') })).toThrow(EscritaSemValidacao);
    expect(() => exigirSoValidacao('meta_ads', pedidoMeta({ targeting: '{}', execution_options: '["validate_only"]', status: 'PAUSED' }))).toThrow(EscritaSemValidacao);
    expect(() => exigirSoValidacao('meta_ads', pedidoMeta({ targeting: '{}', execution_options: '["validate_only"]', access_token: 'x' }))).toThrow(EscritaSemValidacao);
    expect(() => exigirSoValidacao('meta_ads', { ...dois, url: dois.url.replace('/v26.0/2381?', '/v26.0/act_1/adsets?') })).toThrow(EscritaSemValidacao);
    expect(() => exigirSoValidacao('meta_ads', pedidoMeta({ targeting: '{}', execution_options: '["validate_only"]', appsecret_proof: 'abc' }))).not.toThrow();
  });

  it('a saída única: passa o GET, a suggest e a escrita só validando; um passo que esquecesse a trava não escreve', async () => {
    const saiu: string[] = [];
    const http = comTrava(async (p) => {
      saiu.push(`${p.metodo ?? 'GET'} ${p.url}`);
      return OK;
    });
    await http({ ...pedidoGoogle(undefined, 'customers/123/googleAds:searchStream'), metodo: 'GET' });
    await http(pedidoGoogle({ locale: 'pt' }, 'geoTargetConstants:suggest'));
    await http(pedidoGoogle({ mutateOperations: [], validateOnly: true }));
    await http(pedidoMeta({ targeting: '{}', execution_options: '["validate_only"]' }));
    expect(saiu).toHaveLength(4);
    // O "passo de amanhã" sem a trava: POST sem validateOnly, no endereço errado, outro método, outra plataforma.
    await expect(http(pedidoGoogle({ mutateOperations: [{ campaignOperation: {} }] }))).rejects.toThrow(EscritaSemValidacao);
    await expect(http(pedidoGoogle({ operations: [], validateOnly: true }, 'customers/123/campaigns:mutate'))).rejects.toThrow(EscritaSemValidacao);
    await expect(http(pedidoMeta({ status: 'PAUSED' }))).rejects.toThrow(EscritaSemValidacao);
    await expect(http({ ...pedidoMeta({ execution_options: '["validate_only"]' }), metodo: 'DELETE' })).rejects.toThrow(EscritaSemValidacao);
    await expect(http({ ...pedidoGoogle({ validateOnly: true }), provider: 'regem' })).rejects.toThrow(EscritaSemValidacao);
    await expect(http({ ...pedidoGoogle({ locale: 'pt' }, 'geoTargetConstants:suggest'), provider: 'meta_ads' })).rejects.toThrow(EscritaSemValidacao);
    // O método escondido num parâmetro (refino da LIAME), em qualquer caixa e em qualquer plataforma.
    await expect(http({ ...pedidoMeta({}), url: `${META}/v26.0/2381?method=delete`, metodo: 'GET' })).rejects.toThrow(EscritaSemValidacao);
    await expect(http({ ...pedidoMeta({}), url: `${META}/v26.0/2381?Method=POST&status=PAUSED`, metodo: 'GET' })).rejects.toThrow(EscritaSemValidacao);
    await expect(http({ ...pedidoGoogle(undefined, 'customers/123/campaigns?METHOD=delete'), metodo: 'GET' })).rejects.toThrow(EscritaSemValidacao);
    expect(saiu).toHaveLength(4);
  });
});

describe('os lugares do Google: pela constante e pelo pai, nunca pelo texto', () => {
  const resposta = (lugares: Array<[string, string, string, string | null, string?]>) => ({
    geoTargetConstantSuggestions: lugares.map(([recurso, nome, tipo, pai, situacao]) => ({
      searchTerm: nome,
      geoTargetConstant: { resourceName: recurso, name: nome, canonicalName: `${nome},Brazil`, targetType: tipo, countryCode: 'BR', status: situacao ?? 'ENABLED', ...(pai ? { parentGeoTarget: pai } : {}) },
    })),
  });

  it('o estado, a cidade cujo pai é o estado e o bairro cujo pai é a cidade ("Rio de Janeiro" é cidade e estado)', () => {
    const lugares = lugaresDaResposta(
      resposta([
        ['geoTargetConstants/20106', 'Rio de Janeiro', 'State', 'geoTargetConstants/2076'],
        ['geoTargetConstants/1001773', 'Rio de Janeiro', 'City', 'geoTargetConstants/20106'],
        ['geoTargetConstants/9000001', 'Centro', 'Neighborhood', 'geoTargetConstants/1001773'],
        ['geoTargetConstants/9000002', 'Centro', 'Neighborhood', 'geoTargetConstants/1001500'],
      ]),
    );
    const estado = lugarDoTipo(lugares, 'State', null);
    const cidade = lugarDoTipo(lugares, 'City', estado!.recurso);
    expect(estado?.recurso).toBe('geoTargetConstants/20106');
    expect(cidade?.recurso).toBe('geoTargetConstants/1001773');
    expect(lugarDoTipo(lugares, 'Neighborhood', cidade!.recurso)?.recurso).toBe('geoTargetConstants/9000001');
    // O bairro de outra cidade com o mesmo nome não passa; sem a cidade, nenhum bairro.
    expect(lugarDoTipo(lugares, 'Neighborhood', 'geoTargetConstants/1')).toBeNull();
    expect(lugarDoTipo(lugares, 'Neighborhood', null)).toBeNull();
  });

  it('dois que fecham, o desativado e o que vem fora do formato: na dúvida, nenhum (o bairro vai por círculo)', () => {
    const dois = lugaresDaResposta(
      resposta([
        ['geoTargetConstants/1', 'Lapa', 'Neighborhood', 'geoTargetConstants/10'],
        ['geoTargetConstants/2', 'Lapa', 'Neighborhood', 'geoTargetConstants/10'],
      ]),
    );
    expect(lugarDoTipo(dois, 'Neighborhood', 'geoTargetConstants/10')).toBeNull();
    const desativado = lugaresDaResposta(resposta([['geoTargetConstants/3', 'Glória', 'Neighborhood', 'geoTargetConstants/10', 'REMOVAL_PLANNED']]));
    expect(lugarDoTipo(desativado, 'Neighborhood', 'geoTargetConstants/10')).toBeNull();
    expect(lugaresDaResposta({ geoTargetConstantSuggestions: [{ geoTargetConstant: { resourceName: 'x/1' } }, null] })).toEqual([]);
    expect(lugaresDaResposta(null)).toEqual([]);
    expect(consultaDeLugares(['  Santa   Teresa ', ''])).toEqual({ locale: 'pt', countryCode: 'BR', locationNames: { names: ['Santa Teresa'] } });
  });
});

describe('a categoria do perfil e o nome dela em português', () => {
  it('o id estável e o nome como veio; o nome do batchGet pelo id, em qualquer ordem', () => {
    expect(categoriaDoPerfil({ categories: { primaryCategory: { name: 'categories/gcid:hamburger_restaurant', displayName: 'Hamburger restaurant' } } })).toEqual({
      id: 'categories/gcid:hamburger_restaurant',
      nome: 'Hamburger restaurant',
    });
    expect(categoriaDoPerfil({ categories: { primaryCategory: { name: 'gcid:x' } } })).toBeNull();
    expect(categoriaDoPerfil({})).toBeNull();
    const lista = { categories: [{ name: 'categories/gcid:outra', displayName: 'Outra' }, { name: 'categories/gcid:hamburger_restaurant', displayName: 'Hamburgueria' }] };
    expect(nomeDaCategoria(lista, 'categories/gcid:hamburger_restaurant')).toBe('Hamburgueria');
    expect(nomeDaCategoria(lista, 'categories/gcid:nenhuma')).toBeNull();
    expect(nomeDaCategoria({}, 'categories/gcid:outra')).toBeNull();
  });
});

// A campanha aprovada, como a criação de verdade monta (a mesma forma do `campanha-google-plano.spec.ts`).
const ESTADO: EstadoDaCampanhaNovaNoGoogle = {
  campanha: '01900000-0000-7000-8000-000000000001',
  marca: '01900000-0000-7000-8000-0000000000b1',
  nome: 'Combo sexta · Google · novembro (prova)',
  peca: { id: '01900000-0000-7000-8000-0000000000c1', versao: 2 },
  textos: {
    titulos: ['Combo sexta: R$ 34,90', 'Smash, batata e refri', 'Peça no cardápio online'],
    titulos_longos: ['Sexta é dia de combo: smash, batata e refri por R$ 34,90 na Loja Centro'],
    descricoes: ['Peça o combo de sexta pelo cardápio online e receba em casa.', 'Smash, batata e refrigerante por R$ 34,90. Entrega no Centro.'],
  },
  foto: { id: '01900000-0000-7000-8000-0000000000d1', arquivo: 'a'.repeat(64), largura: 1440, altura: 1800 },
  loja_no_google: { nome: 'Mister Burgers', logo: '01900000-0000-7000-8000-0000000000f1', logo_lado: 512 },
  conta: { id: '123', nome: 'Hamburgueria Ads' },
  loja: { id: '01900000-0000-7000-8000-0000000000e1', nome: 'Loja Centro', latitude: -22.906847, longitude: -43.172897 },
  raio_km: 5,
  verba_diaria_micros: 15_000_000,
  moeda: 'BRL',
  fim: null,
  fuso: 'America/Sao_Paulo',
  link: 'https://cardapio.exemplo.com.br/mister-centro',
  situacao: 'pedida',
  ativa: false,
};
const IMAGENS: ImagensDoGoogle = { recortes: [{ id: 'deitada', tipo: 'MARKETING_IMAGE', base64: 'ZGVpdGFkYQ==' }], logo: 'bG9nbw==' };
const CENTRO: LugarNoGoogle = { recurso: 'geoTargetConstants/9000001', nome: 'Centro', nomeCanonico: 'Centro,Rio de Janeiro,Brazil', tipo: 'Neighborhood', pais: 'BR', pai: 'geoTargetConstants/1001773', situacao: 'ENABLED', buscado: 'Centro' };
const LAPA = { nome: 'Lapa', latitude: -22.913, longitude: -43.18, raioKm: 1 };

describe('as peças da prova', () => {
  it('temas de teste distintos, e o tema de exatamente n caracteres sem espaço na ponta', () => {
    const t = temasDeTeste(51);
    expect(t).toHaveLength(51);
    expect(new Set(t).size).toBe(51);
    for (const n of [80, 81]) {
      const tema = temaDeTamanho(n);
      expect([...tema]).toHaveLength(n);
      expect(tema).toBe(tema.trim());
    }
  });

  it('o público com o bairro de fora soma ao que já estava de fora e mantém o resto', () => {
    const antes = { geo_locations: { custom_locations: [{ latitude: -22.9, longitude: -43.2, radius: 5, distance_unit: 'kilometer' }] }, excluded_geo_locations: { custom_locations: [{ latitude: 1, longitude: 2, radius: 1, distance_unit: 'kilometer' }] }, age_min: 18 };
    const depois = publicoSemOBairro(antes, { nome: 'Lapa', latitude: -22.913, longitude: -43.18, raioKm: 0.4 });
    expect(depois.geo_locations).toEqual(antes.geo_locations);
    expect(depois.age_min).toBe(18);
    expect(depois.excluded_geo_locations).toEqual({
      custom_locations: [antes.excluded_geo_locations.custom_locations[0], { latitude: -22.913, longitude: -43.18, radius: 1, distance_unit: 'kilometer' }],
    });
  });

  it('a criação do jeito do desenho: os bairros no lugar do raio da loja e os temas no grupo de recursos novo', () => {
    const criacao = operacoesDaCriacao(ESTADO, IMAGENS);
    const ops = criacaoComARegiao(criacao, ['hamburgueria perto de mim', 'hambúrguer delivery'], [CENTRO], LAPA) as Array<Record<string, { create?: Record<string, unknown> }>>;
    const campanha = criacao.find((o) => 'campaignOperation' in o)!.campaignOperation!.create!.resourceName as string;
    const grupo = criacao.find((o) => 'assetGroupOperation' in o)!.assetGroupOperation!.create!.resourceName as string;
    expect(campanha).toMatch(/^customers\/123\/campaigns\/-\d+$/);
    expect(grupo).toMatch(/^customers\/123\/assetGroups\/-\d+$/);
    // O raio da loja saiu; no lugar dele (logo depois da campanha), o bairro do Google e o círculo do outro.
    const iCampanha = ops.findIndex((o) => 'campaignOperation' in o);
    expect(ops[iCampanha + 1]).toEqual({ campaignCriterionOperation: { create: { campaign: campanha, location: { geoTargetConstant: 'geoTargetConstants/9000001' } } } });
    expect(ops[iCampanha + 2]).toEqual({
      campaignCriterionOperation: { create: { campaign: campanha, proximity: { geoPoint: { latitudeInMicroDegrees: -22913000, longitudeInMicroDegrees: -43180000 }, radius: 1, radiusUnits: 'KILOMETERS' } } },
    });
    expect(JSON.stringify(ops)).not.toContain('-22906847');
    // O idioma continua, o nome "(prova)" vai na campanha, e os temas entram no fim, no grupo novo.
    expect(ops.filter((o) => (o.campaignCriterionOperation?.create as { language?: unknown } | undefined)?.language)).toHaveLength(1);
    expect(String(ops[iCampanha]!.campaignOperation!.create!.name)).toContain('(prova)');
    expect(ops.slice(-2)).toEqual([
      { assetGroupSignalOperation: { create: { assetGroup: grupo, searchTheme: { text: 'hamburgueria perto de mim' } } } },
      { assetGroupSignalOperation: { create: { assetGroup: grupo, searchTheme: { text: 'hambúrguer delivery' } } } },
    ]);
    expect(ops).toHaveLength(criacao.length - 1 + 2 + 2);
    expect(() => criacaoComARegiao([], [], [], null)).toThrow();
  });
});

describe('a prova inteira contra um Google e uma Meta de mentira', () => {
  type Anotada = { url: URL; metodo: string; corpo: unknown };
  const montar = (opcoes: { limiteDeTemas: number; tamanho: number } = { limiteDeTemas: 25, tamanho: 80 }) => {
    const chamadas: Anotada[] = [];
    const ctx: ContextoDaProva = {
      http: async (p) => {
        const url = new URL(p.url);
        chamadas.push({ url, metodo: p.metodo ?? 'GET', corpo: p.corpo });
        if (url.pathname.endsWith('/geoTargetConstants:suggest')) {
          const nome = (p.corpo as { locationNames: { names: string[] } }).locationNames.names[0];
          const lugares: Record<string, unknown[]> = {
            'Rio de Janeiro': [
              { searchTerm: nome, geoTargetConstant: { resourceName: 'geoTargetConstants/20106', name: 'Rio de Janeiro', targetType: 'State', countryCode: 'BR', status: 'ENABLED', parentGeoTarget: 'geoTargetConstants/2076' } },
              { searchTerm: nome, geoTargetConstant: { resourceName: 'geoTargetConstants/1001773', name: 'Rio de Janeiro', targetType: 'City', countryCode: 'BR', status: 'ENABLED', parentGeoTarget: 'geoTargetConstants/20106' } },
            ],
            Centro: [{ searchTerm: nome, geoTargetConstant: { resourceName: 'geoTargetConstants/9000001', name: 'Centro', targetType: 'Neighborhood', countryCode: 'BR', status: 'ENABLED', parentGeoTarget: 'geoTargetConstants/1001773' } }],
          };
          return { status: 200, corpo: { geoTargetConstantSuggestions: lugares[nome ?? ''] ?? [] }, cabecalhos: new Headers(), uso: null };
        }
        if (url.pathname.endsWith('/googleAds:mutate')) {
          const ops = (p.corpo as { mutateOperations: Array<{ assetGroupSignalOperation?: { create: { searchTheme: { text: string } } } }> }).mutateOperations;
          const temas = ops.filter((o) => o.assetGroupSignalOperation);
          if (temas.length > opcoes.limiteDeTemas) throw new ErroConector('definitivo', 'google_ads', 'too many', 400, null, null, { subcodigo: 'resourceCountLimitExceededError.RESOURCE_LIMIT', mensagemUsuario: 'Limite de temas' });
          if (temas.some((o) => [...o.assetGroupSignalOperation!.create.searchTheme.text].length > opcoes.tamanho)) throw new ErroConector('definitivo', 'google_ads', 'too long', 400, null, null, { subcodigo: 'stringLengthError.TOO_LONG', mensagemUsuario: 'Tema longo' });
          return { status: 200, corpo: { mutateOperationResponses: [] }, cabecalhos: new Headers(), uso: null };
        }
        if (url.host === 'graph.facebook.com') return { status: 200, corpo: { success: true }, cabecalhos: new Headers(), uso: null };
        throw new Error(`chamada inesperada: ${p.url}`);
      },
      google: { base: GOOGLE, versao: 'v22', cliente: '123', chave: 'escrita:x', cabecalhos: { authorization: 'Bearer g' }, campanha: '555', grupo: '777' },
      criacao: { operacoes: operacoesDaCriacao(ESTADO, IMAGENS) },
      perfil: { categoria: async () => ({ id: 'categories/gcid:hamburger_restaurant', nome: 'Hamburger restaurant' }), nome: async () => 'Hamburgueria' },
      meta: { base: META, versao: 'v26.0', token: 'tok', appSecret: 'segredo', conta: 'act_1', conjunto: { id: '2381', name: 'Conjunto', campaignId: '99', targeting: { geo_locations: { countries: ['BR'] } } } },
      loja: {
        cidade: 'Rio de Janeiro',
        uf: 'rj',
        bairros: [
          { nome: 'Centro', latitude: -22.906, longitude: -43.176, raioKm: 1.5 },
          { nome: 'Lapa', latitude: -22.913, longitude: -43.18, raioKm: 1 },
        ],
      },
    };
    return { ctx, chamadas };
  };

  it('cada escrita sai só validando; a recusa da plataforma vira passo; a categoria vem em português', async () => {
    const { ctx, chamadas } = montar();
    const r = await provaDaRegiao(ctx);
    const por = (passo: string) => r.find((x) => x.passo === passo);
    expect(por('google: 25 temas')?.resultado).toBe('aceito');
    expect(por('google: 26 temas')).toMatchObject({ resultado: 'recusado', detalhe: 'Limite de temas (resourceCountLimitExceededError.RESOURCE_LIMIT)' });
    expect(por('google: 51 temas')?.resultado).toBe('recusado');
    expect(por('google: um tema de 80 caracteres')?.resultado).toBe('aceito');
    expect(por('google: um tema de 81 caracteres')?.resultado).toBe('recusado');
    expect(por('google: o estado')?.detalhe).toMatch(/^escolhido geoTargetConstants\/20106/);
    expect(por('google: a cidade')?.detalhe).toMatch(/^escolhida geoTargetConstants\/1001773/);
    expect(por('google: o bairro Centro')?.detalhe).toMatch(/^escolhido geoTargetConstants\/9000001/);
    expect(por('google: o bairro Lapa')?.detalhe).toMatch(/^nenhum: vai por círculo/);
    expect(por('google: 1 bairro(s) pelo lugar + 1 por círculo + PRESENCE')?.resultado).toBe('aceito');
    expect(por('google: a criação inteira com 3 temas e 1 bairro(s) pelo lugar + 1 por círculo (prova)')?.resultado).toBe('aceito');
    expect(por('perfil: a categoria')?.detalhe).toBe('categories/gcid:hamburger_restaurant; como veio: Hamburger restaurant; em pt-BR (batchGet): Hamburgueria');
    expect(por('meta: tirar Centro do conjunto 2381')?.resultado).toBe('aceito');

    // Nenhuma escrita sem a validação: todo mutate com validateOnly: true, e a Meta com ["validate_only"] e sem corpo.
    const mutates = chamadas.filter((c) => c.url.pathname.endsWith('/googleAds:mutate'));
    expect(mutates).toHaveLength(8);
    for (const c of mutates) expect((c.corpo as { validateOnly?: unknown }).validateOnly).toBe(true);
    const daMeta = chamadas.filter((c) => c.url.host === 'graph.facebook.com');
    expect(daMeta).toHaveLength(1);
    expect(daMeta[0]!.url.searchParams.get('execution_options')).toBe('["validate_only"]');
    expect(daMeta[0]!.corpo).toBeUndefined();
    expect(JSON.parse(daMeta[0]!.url.searchParams.get('targeting')!).excluded_geo_locations.custom_locations).toHaveLength(1);
    // Só o que foi pedido: o mutate, a suggest e o POST na Meta (nenhum outro endereço do Google).
    expect(chamadas.every((c) => c.url.pathname.endsWith('/googleAds:mutate') || c.url.pathname.endsWith('/geoTargetConstants:suggest') || c.url.host === 'graph.facebook.com')).toBe(true);
    // Na campanha no ar: o lugar do Google, o círculo e a campanha em "só quem está", na mesma requisição.
    const naCampanha = mutates.find((c) => JSON.stringify(c.corpo).includes('"updateMask"'))!;
    expect((naCampanha.corpo as { mutateOperations: unknown[] }).mutateOperations).toEqual([
      { campaignCriterionOperation: { create: { campaign: 'customers/123/campaigns/555', location: { geoTargetConstant: 'geoTargetConstants/9000001' } } } },
      { campaignCriterionOperation: { create: { campaign: 'customers/123/campaigns/555', proximity: { geoPoint: { latitudeInMicroDegrees: -22913000, longitudeInMicroDegrees: -43180000 }, radius: 1, radiusUnits: 'KILOMETERS' } } } },
      { campaignOperation: { updateMask: 'geo_target_type_setting.positive_geo_target_type', update: { resourceName: 'customers/123/campaigns/555', geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' } } } },
    ]);
    // A criação inteira: a campanha "(prova)" com os temas no grupo novo e sem o raio da loja.
    const criacao = JSON.stringify(mutates.find((c) => JSON.stringify(c.corpo).includes('(prova)'))!.corpo);
    expect(criacao).toContain('"assetGroupSignalOperation"');
    expect(criacao).toContain('geoTargetConstants/9000001');
    expect(criacao).not.toContain('-22906847');
  });

  it('com o limite em 50, 50 temas passam e 51 não; o que não é recusa da plataforma vira "falhou", sem derrubar a prova', async () => {
    const { ctx } = montar({ limiteDeTemas: 50, tamanho: 80 });
    const http = ctx.http;
    ctx.http = async (p) => {
      if (new URL(p.url).host === 'graph.facebook.com') throw new ErroConector('limite', 'meta_ads', 'uso alto', 429);
      return http(p);
    };
    const r = await provaDaRegiao(ctx);
    expect(r.find((x) => x.passo === 'google: 50 temas')?.resultado).toBe('aceito');
    expect(r.find((x) => x.passo === 'google: 51 temas')?.resultado).toBe('recusado');
    expect(r.find((x) => x.passo === 'meta: tirar Centro do conjunto 2381')).toMatchObject({ resultado: 'falhou', detalhe: 'limite: uso alto' });
  });

  it('a criação que não montou (a foto) vira "falhou" com o motivo; o resto da prova segue', async () => {
    const { ctx } = montar();
    const r = await provaDaRegiao({ ...ctx, criacao: { erro: 'a foto da campanha não está mais no Liame' } });
    expect(r.find((x) => x.passo.startsWith('google: a criação inteira'))).toMatchObject({ resultado: 'falhou', detalhe: 'a foto da campanha não está mais no Liame' });
    expect(r.at(-1)?.passo).toBe('meta: tirar Centro do conjunto 2381');
  });

  it('a prova que para no meio (a trava ou um erro inesperado) leva os passos que já saíram, para a auditoria', async () => {
    const { ctx } = montar();
    const parada = await provaDaRegiao({
      ...ctx,
      perfil: {
        categoria: async () => {
          throw new EscritaSemValidacao('um passo novo tentou escrever sem validar');
        },
        nome: async () => null,
      },
    }).catch((e: unknown) => e);
    expect(parada).toBeInstanceOf(ProvaInterrompida);
    const p = parada as ProvaInterrompida;
    expect(p.causa).toBeInstanceOf(EscritaSemValidacao);
    expect(p.message).toBe('um passo novo tentou escrever sem validar');
    // Os passos do Google já tinham saído (temas, lugares, bairros e a criação); o perfil e a Meta, não.
    expect(p.passos.map((x) => x.passo)).toContain('google: 25 temas');
    expect(p.passos.some((x) => x.passo.startsWith('google: a criação inteira'))).toBe(true);
    expect(p.passos.some((x) => x.passo.startsWith('perfil') || x.passo.startsWith('meta'))).toBe(false);
  });

  it('sem o Google, o perfil e a Meta, cada passo diz que pulou; nenhuma chamada sai', async () => {
    const { ctx, chamadas } = montar();
    const r = await provaDaRegiao({ ...ctx, google: null, criacao: null, perfil: null, meta: null });
    expect(r.map((x) => x.resultado)).toEqual(['pulado', 'pulado', 'pulado', 'pulado', 'pulado']);
    expect(chamadas).toHaveLength(0);
  });
});
