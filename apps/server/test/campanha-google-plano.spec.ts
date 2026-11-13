import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import {
  AUTOMACOES_DESLIGADAS,
  areasDosRecortes,
  campanhaGoogleDoRecurso,
  consultaDaCampanhaCriada,
  type EstadoDaCampanhaNovaNoGoogle,
  type ImagensDoGoogle,
  idsDaCriacao,
  idsDaProcura,
  marcaDoLiame,
  motivoDaFotoPequena,
  motivoDosTextos,
  nomeNoGoogle,
  type OperacaoDoGoogle,
  operacaoDeAtivarOuPausar,
  operacoesDaCriacao,
  planoDaCampanhaGoogle,
  planoDeAtivarNoGoogle,
  planoDePausarNoGoogle,
  recortesDaFoto,
  recursoDaCampanhaGoogle,
} from '../src/campanhas/campanha-google-plano.js';
import { FotoNaoServe, imagensDoGoogle } from '../src/campanhas/imagens-do-google.js';

// A5 · Y9, partes 2 e 3, sem rede e sem banco: o recurso, os recortes da foto (os mesmos números do P45), a conferência
// dos textos nos tamanhos do Google (base §3.1, lida em 12/11/2026), o plano da ferramenta `campanha_google_criar` e a
// criação: o nome único, as áreas dos recortes, as operações da requisição única, os ids da resposta e as imagens.

const ID = '01900000-0000-7000-8000-000000000001';
const TEXTOS = {
  titulos: ['Combo sexta: R$ 34,90', 'Smash, batata e refri', 'Peça no cardápio online'],
  titulos_longos: ['Sexta é dia de combo: smash, batata e refri por R$ 34,90 na Loja Centro'],
  descricoes: ['Peça o combo de sexta pelo cardápio online e receba em casa.', 'Smash, batata e refrigerante por R$ 34,90. Entrega no Centro ou retirada no balcão.'],
};
const estado = (o: Partial<EstadoDaCampanhaNovaNoGoogle> = {}): EstadoDaCampanhaNovaNoGoogle => ({
  campanha: ID,
  marca: '01900000-0000-7000-8000-0000000000b1',
  nome: 'Combo sexta · Google · novembro',
  peca: { id: '01900000-0000-7000-8000-0000000000c1', versao: 2 },
  textos: TEXTOS,
  foto: { id: '01900000-0000-7000-8000-0000000000d1', arquivo: 'a'.repeat(64), largura: 1440, altura: 1800 },
  loja_no_google: { nome: 'Mister Burgers', logo: '01900000-0000-7000-8000-0000000000f1', logo_lado: 512 },
  conta: { id: '4445556667', nome: 'Hamburgueria Ads' },
  loja: { id: '01900000-0000-7000-8000-0000000000e1', nome: 'Loja Centro', latitude: -22.906847, longitude: -43.172897 },
  raio_km: 5,
  verba_diaria_micros: 30_000_000,
  moeda: 'BRL',
  fim: null,
  fuso: 'America/Sao_Paulo',
  link: 'https://cardapio.exemplo.com.br/mister-centro',
  situacao: 'pedida',
  ativa: false,
  ...o,
});

describe('a campanha nova no Google (A5 · Y9, parte 2)', () => {
  it('o recurso: campanha_google:<uuid>, e nada mais', () => {
    expect(campanhaGoogleDoRecurso(recursoDaCampanhaGoogle(ID))).toBe(ID);
    expect(campanhaGoogleDoRecurso(`campanha_nova:${ID}`)).toBeNull();
    expect(campanhaGoogleDoRecurso('campanha_google:nao-e-uuid')).toBeNull();
  });

  it('os recortes pelo centro: os números do P45; a foto pequena recusada com as medidas', () => {
    expect(recortesDaFoto(1440, 1800).map((r) => `${r.id}:${r.largura}x${r.altura}:${r.ok}`)).toEqual(['deitada:1440x754:true', 'quadrada:1440x1440:true', 'em_pe:1440x1800:true']);
    expect(recortesDaFoto(1600, 1200).map((r) => `${r.largura}x${r.altura}`)).toEqual(['1600x838', '1200x1200', '960x1200']);
    // 520 × 520: a quadrada serve; a deitada, não (o mínimo é 600 × 314); a em pé é opcional e fica de fora.
    expect(recortesDaFoto(520, 520).map((r) => r.ok)).toEqual([false, true, false]);
    expect(motivoDaFotoPequena(520, 520)).toBe('A foto é pequena para o recorte deitado: o Google pede pelo menos 600 × 314, e o maior recorte desta foto dá 520 × 272. Use outra foto.');
    expect(motivoDaFotoPequena(1440, 1800)).toBeNull();
    // A em pé pequena não impede: ela é opcional (1600 × 500: a em pé dá 400 × 500, abaixo de 480 × 600).
    expect(recortesDaFoto(1600, 500).map((r) => r.ok)).toEqual([true, true, false]);
    expect(motivoDaFotoPequena(1600, 500)).toBeNull();
  });

  it('os textos: as quantidades, os tamanhos, os vazios e os repetidos, no campo de cada um', () => {
    const t = (o: Partial<{ titulos: string[]; titulosLongos: string[]; descricoes: string[] }> = {}) => ({ titulos: TEXTOS.titulos, titulosLongos: TEXTOS.titulos_longos, descricoes: TEXTOS.descricoes, ...o });
    expect(motivoDosTextos(t())).toBeNull();
    expect(motivoDosTextos(t({ titulos: TEXTOS.titulos.slice(0, 2) }))).toEqual({ campo: 'headlines', motivo: 'O Google pede pelo menos 3 títulos.' });
    expect(motivoDosTextos(t({ titulos: ['Combo de sexta com smash, batata e refrigerante', ...TEXTOS.titulos.slice(1)] }))).toEqual({
      campo: 'headlines',
      motivo: '“Combo de sexta com smash, batata e refrigerante” tem 47 caracteres: o título vai até 30.',
    });
    expect(motivoDosTextos(t({ titulos: [...TEXTOS.titulos, 'combo SEXTA: R$ 34,90'] }))?.motivo).toBe('Há títulos repetidos: o Google recusa o mesmo texto duas vezes.');
    expect(motivoDosTextos(t({ titulos: [...TEXTOS.titulos, '  '] }))?.motivo).toBe('Há título vazio: escreva ou tire.');
    expect(motivoDosTextos(t({ titulos: Array.from({ length: 16 }, (_, i) => `Título ${i}`) }))?.motivo).toBe('O Google aceita até 15 títulos.');
    expect(motivoDosTextos(t({ titulosLongos: [] }))).toEqual({ campo: 'long_headlines', motivo: 'O Google pede pelo menos 1 título longo.' });
    expect(motivoDosTextos(t({ descricoes: [TEXTOS.descricoes[0]!] }))).toEqual({ campo: 'descriptions', motivo: 'O Google pede pelo menos 2 descrições.' });
    expect(motivoDosTextos(t({ descricoes: [TEXTOS.descricoes[0]!, 'x'.repeat(91)] }))?.motivo).toMatch(/tem 91 caracteres: a descrição vai até 90\.$/);
    // O tamanho conta caracteres, não bytes: o acento não pesa mais.
    expect(motivoDosTextos(t({ titulos: ['Ç'.repeat(30), ...TEXTOS.titulos.slice(1)] }))).toBeNull();
  });

  it('o plano: pedida vira criada; o que já foi criado, cancelado ou não criado não volta; os textos e a foto são conferidos de novo', () => {
    const p = planoDaCampanhaGoogle(estado());
    expect(p.ok && p.desejado.situacao).toBe('criada');
    expect(planoDaCampanhaGoogle(estado({ situacao: 'criada' }))).toEqual({ ok: false, motivo: 'Esta campanha nova já foi criada no Google, pausada.' });
    expect(planoDaCampanhaGoogle(estado({ situacao: 'cancelada' })).ok).toBe(false);
    expect(planoDaCampanhaGoogle(estado({ situacao: 'nao_criada' })).ok).toBe(false);
    expect(planoDaCampanhaGoogle(estado({ foto: { ...estado().foto, largura: 520, altura: 520 } }))).toMatchObject({ ok: false, motivo: expect.stringMatching(/^A foto é pequena para o recorte deitado/) });
    expect(planoDaCampanhaGoogle(estado({ textos: { ...TEXTOS, titulos: [...TEXTOS.titulos, 'Smash, batata e refri'] } }))).toMatchObject({ ok: false, motivo: expect.stringMatching(/repetidos/) });
    // O estado fora do formato (a logo pequena, a conta fora do formato, outra coisa qualquer) não vira plano.
    expect(planoDaCampanhaGoogle(estado({ loja_no_google: { nome: 'Mister Burgers', logo: 'x', logo_lado: 96 } })).ok).toBe(false);
    expect(planoDaCampanhaGoogle(estado({ conta: { id: 'act_123', nome: 'x' } })).ok).toBe(false);
    expect(planoDaCampanhaGoogle({ qualquer: 1 }).ok).toBe(false);
  });

  it('ativar e pausar (parte 5a): só a criada; a ativa não ativa de novo; só a ativa pausa', () => {
    const criada = estado({ situacao: 'criada' });
    const a = planoDeAtivarNoGoogle(criada);
    expect(a.ok && a.desejado.ativa).toBe(true);
    expect(planoDeAtivarNoGoogle(estado()).ok).toBe(false);
    expect(planoDeAtivarNoGoogle(estado({ situacao: 'criada', ativa: true }))).toEqual({ ok: false, motivo: 'Esta campanha nova já está ativa.' });
    const p = planoDePausarNoGoogle(estado({ situacao: 'criada', ativa: true }));
    expect(p.ok && p.desejado.ativa).toBe(false);
    expect(planoDePausarNoGoogle(criada).ok).toBe(false);
    expect(planoDeAtivarNoGoogle({ qualquer: 1 }).ok).toBe(false);
  });
});

describe('a criação no Google, sem rede (A5 · Y9, parte 3; D-A5-27, D-A5-28)', () => {
  const imagens: ImagensDoGoogle = {
    recortes: [
      { id: 'deitada', tipo: 'MARKETING_IMAGE', base64: 'ZGVpdGFkYQ==' },
      { id: 'quadrada', tipo: 'SQUARE_MARKETING_IMAGE', base64: 'cXVhZHJhZGE=' },
    ],
    logo: 'bG9nbw==',
  };
  const tipo = (op: OperacaoDoGoogle) => Object.keys(op)[0]!;
  const corpo = (op: OperacaoDoGoogle) => Object.values(op)[0]!.create;

  it('o nome único: o da pessoa com a marca do Liame (os 12 últimos dígitos do id), e a procura por ela', () => {
    expect(marcaDoLiame(ID)).toBe('(Liame 000000000001)');
    expect(nomeNoGoogle(estado())).toBe('Combo sexta · Google · novembro (Liame 000000000001)');
    // Dois ids do mesmo minuto (uuidv7: o começo é a hora) não se confundem.
    expect(marcaDoLiame('01900000-0000-7000-8000-000000000002')).not.toBe(marcaDoLiame(ID));
    expect(consultaDaCampanhaCriada(ID)).toBe(
      "SELECT campaign.id, campaign.campaign_budget, asset_group.id FROM asset_group WHERE campaign.name LIKE '%(Liame 000000000001)' AND campaign.status != 'REMOVED'",
    );
  });

  it('as áreas dos recortes: pelo centro, no tamanho recomendado; o em pé só quando cabe', () => {
    expect(areasDosRecortes(1440, 1800)).toEqual([
      { id: 'deitada', tipo: 'MARKETING_IMAGE', left: 0, top: 523, width: 1440, height: 754, saida: { largura: 1200, altura: 628 } },
      { id: 'quadrada', tipo: 'SQUARE_MARKETING_IMAGE', left: 0, top: 180, width: 1440, height: 1440, saida: { largura: 1200, altura: 1200 } },
      { id: 'em_pe', tipo: 'PORTRAIT_MARKETING_IMAGE', left: 0, top: 0, width: 1440, height: 1800, saida: { largura: 960, altura: 1200 } },
    ]);
    // Deitada e menor que o recomendado: vai como está; o em pé não alcança 480 × 600.
    expect(areasDosRecortes(900, 500).map((a) => [a.id, a.left, a.top, a.width, a.height, a.saida.largura, a.saida.altura])).toEqual([
      ['deitada', 0, 14, 900, 471, 900, 471],
      ['quadrada', 200, 0, 500, 500, 500, 500],
    ]);
  });

  it('as operações: uma requisição, na ordem em que o Google resolve os ids provisórios, com a campanha pausada e a marca', () => {
    const ops = operacoesDaCriacao(estado({ fim: '2026-12-31' }), imagens);
    const cliente = 'customers/4445556667';
    expect(ops.map(tipo)).toEqual([
      'campaignBudgetOperation',
      'campaignOperation',
      'campaignCriterionOperation',
      'campaignCriterionOperation',
      ...Array(6).fill('assetOperation'), // 3 títulos, 1 longo, 2 descrições
      'assetOperation', // deitada
      'assetOperation', // quadrada
      'assetOperation', // o nome da loja
      'assetOperation', // a logo
      'campaignAssetOperation',
      'campaignAssetOperation',
      'assetGroupOperation',
      ...Array(8).fill('assetGroupAssetOperation'),
    ]);
    expect(corpo(ops[0]!)).toEqual({
      resourceName: `${cliente}/campaignBudgets/-1`,
      name: 'Verba · Combo sexta · Google · novembro (Liame 000000000001)',
      amountMicros: '30000000',
      deliveryMethod: 'STANDARD',
      explicitlyShared: false,
    });
    expect(corpo(ops[1]!)).toEqual({
      resourceName: `${cliente}/campaigns/-2`,
      name: 'Combo sexta · Google · novembro (Liame 000000000001)',
      advertisingChannelType: 'PERFORMANCE_MAX',
      status: 'PAUSED',
      // Só quem está ou costuma estar no raio (D-A5-34): o padrão do Google soma quem só mostrou interesse pelo lugar.
      geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' },
      campaignBudget: `${cliente}/campaignBudgets/-1`,
      maximizeConversions: {},
      brandGuidelinesEnabled: true,
      containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      assetAutomationSettings: AUTOMACOES_DESLIGADAS.map((t) => ({ assetAutomationType: t, assetAutomationStatus: 'OPTED_OUT' })),
      finalUrlSuffix: 'utm_source=google&utm_medium=cpc&campaign_id={campaignid}',
      endDateTime: '2026-12-31 23:59:59',
    });
    expect(corpo(ops[2]!)).toEqual({
      campaign: `${cliente}/campaigns/-2`,
      proximity: { geoPoint: { latitudeInMicroDegrees: -22906847, longitudeInMicroDegrees: -43172897 }, radius: 5, radiusUnits: 'KILOMETERS' },
    });
    expect(corpo(ops[3]!)).toEqual({ campaign: `${cliente}/campaigns/-2`, language: { languageConstant: 'languageConstants/1014' } });
    // Sem fim: a campanha roda até alguém pausar (nada de data no pedido).
    expect(corpo(operacoesDaCriacao(estado(), imagens)[1]!)).not.toHaveProperty('endDateTime');

    const recursos = ops.filter((o) => tipo(o) === 'assetOperation').map(corpo);
    const porNome = new Map(recursos.map((r) => [r.resourceName as string, r]));
    expect(recursos.filter((r) => r.imageAsset).map((r) => r.name)).toEqual(['Foto deitado (Liame 000000000001)', 'Foto quadrado (Liame 000000000001)', 'Logo (Liame 000000000001)']);
    const daCampanha = ops.filter((o) => tipo(o) === 'campaignAssetOperation').map(corpo);
    expect(daCampanha.map((c) => [c.fieldType, porNome.get(c.asset as string)?.textAsset ?? (porNome.get(c.asset as string)?.imageAsset as { data: string }).data])).toEqual([
      ['BUSINESS_NAME', { text: 'Mister Burgers' }],
      ['LOGO', 'bG9nbw=='],
    ]);
    expect(corpo(ops.find((o) => tipo(o) === 'assetGroupOperation')!)).toEqual({
      resourceName: `${cliente}/assetGroups/-3`,
      name: 'Combo sexta · Google · novembro',
      campaign: `${cliente}/campaigns/-2`,
      finalUrls: ['https://cardapio.exemplo.com.br/mister-centro'],
      status: 'ENABLED',
    });
    const doGrupo = ops.filter((o) => tipo(o) === 'assetGroupAssetOperation').map(corpo);
    expect(doGrupo.every((d) => d.assetGroup === `${cliente}/assetGroups/-3`)).toBe(true);
    expect(doGrupo.map((d) => [d.fieldType, (porNome.get(d.asset as string)?.textAsset as { text: string } | undefined)?.text ?? 'imagem'])).toEqual([
      ...TEXTOS.titulos.map((t) => ['HEADLINE', t]),
      ...TEXTOS.titulos_longos.map((t) => ['LONG_HEADLINE', t]),
      ...TEXTOS.descricoes.map((t) => ['DESCRIPTION', t]),
      ['MARKETING_IMAGE', 'imagem'],
      ['SQUARE_MARKETING_IMAGE', 'imagem'],
    ]);
    // Cada id provisório é criado uma vez só.
    const nomes = ops.map((o) => corpo(o).resourceName).filter(Boolean);
    expect(new Set(nomes).size).toBe(nomes.length);
  });

  it('o mesmo texto em dois papéis usa um recurso só (o nome da loja igual a um título)', () => {
    const ops = operacoesDaCriacao(estado({ loja_no_google: { ...estado().loja_no_google, nome: 'Smash, batata e refri' } }), imagens);
    const textos = ops.filter((o) => tipo(o) === 'assetOperation' && corpo(o).textAsset).map((o) => (corpo(o).textAsset as { text: string }).text);
    expect(textos.filter((t) => t === 'Smash, batata e refri')).toHaveLength(1);
    const titulo = ops.filter((o) => tipo(o) === 'assetGroupAssetOperation').map(corpo)[1]!.asset;
    expect(ops.filter((o) => tipo(o) === 'campaignAssetOperation').map(corpo)[0]!.asset).toBe(titulo);
  });

  it('os ids da resposta da criação e da procura; o que falta não vira id', () => {
    const c = 'customers/4445556667';
    expect(
      idsDaCriacao({
        mutateOperationResponses: [
          { campaignBudgetResult: { resourceName: `${c}/campaignBudgets/111` } },
          { campaignResult: { resourceName: `${c}/campaigns/222` } },
          { assetResult: { resourceName: `${c}/assets/9` } },
          { assetGroupResult: { resourceName: `${c}/assetGroups/333` } },
        ],
      }),
    ).toEqual({ orcamento: '111', campanha: '222', grupo: '333' });
    expect(idsDaCriacao({ mutateOperationResponses: [{ campaignResult: { resourceName: `${c}/campaigns/222` } }] })).toBeNull();
    expect(idsDaCriacao({})).toBeNull();
    expect(idsDaProcura([{ results: [{ campaign: { id: '222', campaignBudget: `${c}/campaignBudgets/111` }, assetGroup: { id: '333' } }] }])).toEqual({ orcamento: '111', campanha: '222', grupo: '333' });
    expect(idsDaProcura([])).toBeNull();
    expect(idsDaProcura([{ results: [{ campaign: { id: '222' }, assetGroup: { id: '333' } }] }])).toBeNull();
  });

  it('ativar acerta o local para "só quem está" (a campanha criada antes nasceu com o padrão do Google); pausar muda só a situação', () => {
    const recurso = 'customers/1234567890/campaigns/777';
    // A máscara vai em snake_case e o campo em camelCase, como na página oficial de segmentação por local.
    expect(operacaoDeAtivarOuPausar(recurso, true)).toEqual({
      updateMask: 'status,geo_target_type_setting.positive_geo_target_type',
      update: { resourceName: recurso, status: 'ENABLED', geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE' } },
    });
    expect(operacaoDeAtivarOuPausar(recurso, false)).toEqual({ updateMask: 'status', update: { resourceName: recurso, status: 'PAUSED' } });
  });

  it('as imagens de verdade: os recortes nas medidas do Google e a logo deitada inteira num quadrado; a foto pequena recusada', async () => {
    const jpeg = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } }).jpeg().toBuffer();
    const r = await imagensDoGoogle(await jpeg(1440, 1800), await jpeg(600, 300));
    const medir = async (b64: string) => {
      const m = await sharp(Buffer.from(b64, 'base64')).metadata();
      return [m.format, m.width, m.height];
    };
    expect(await Promise.all(r.recortes.map(async (x) => [x.tipo, ...(await medir(x.base64))]))).toEqual([
      ['MARKETING_IMAGE', 'jpeg', 1200, 628],
      ['SQUARE_MARKETING_IMAGE', 'jpeg', 1200, 1200],
      ['PORTRAIT_MARKETING_IMAGE', 'jpeg', 960, 1200],
    ]);
    expect(await medir(r.logo)).toEqual(['jpeg', 600, 600]);
    // A logo maior que o recomendado desce a 1200.
    expect(await medir((await imagensDoGoogle(await jpeg(1440, 1800), await jpeg(2000, 1000))).logo)).toEqual(['jpeg', 1200, 1200]);
    await expect(imagensDoGoogle(await jpeg(520, 520), await jpeg(300, 300))).rejects.toBeInstanceOf(FotoNaoServe);
  });
});
