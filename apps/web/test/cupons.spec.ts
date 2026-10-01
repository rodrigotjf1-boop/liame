import type { CouponCampaign, CouponItem, CouponListResponse, CouponStore } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  avisoDesligado,
  avisoLigado,
  campanhasSemCupom,
  erroEnderecoPlataforma,
  errosExterno,
  errosLigar,
  filtrarCupons,
  fonteDosCupons,
  hojeNoFuso,
  infoPlataforma,
  linhaPlataforma,
  notaSugestao,
  plataformaDaLoja,
  regraDoCupom,
  semUsoComGasto,
  situacaoDoCupom,
  textoVinculo,
  validadeDoCupom,
} from '@/components/links/cupons-textos';
import { FaixaSemCupom } from '@/components/links/faixa-sem-cupom';
import { LinhaPlataforma } from '@/components/links/linha-plataforma';
import { TabelaCupons } from '@/components/links/tabela-cupons';

// Aba Cupons e plataforma de pedidos da loja (P3 com a plataforma de pedidos, aprovado em 30/09/2026): a
// plataforma informada ou sugerida, as frases de como o Liame mede, a regra e a validade de cada cupom no
// fuso da loja, os avisos, os formulários de ligar e informar e a tabela. Validade no fuso da loja (fixo);
// "hoje" e "informado em" no horário local da máquina, como as outras specs.

const uuid = (n: number) => `c0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const local = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString();
const agora = new Date(2026, 8, 30, 15, 0);
const FUSO = 'America/Sao_Paulo';

const loja = (o: Partial<CouponStore> = {}): CouponStore => ({
  connected_account_id: uuid(1),
  unit: { id: uuid(2), name: 'Loja Centro' },
  store_name: 'Mister Burgers Centro (Regem)',
  timezone: FUSO,
  order_platform: null,
  order_platform_url: null,
  order_platform_set_at: null,
  coupons_read_at: local(30, 10, 5),
  coupons_freshness: 'fresh',
  coupons_error: null,
  can_create: false,
  ...o,
});

const campanha = (n: number, o: Partial<CouponCampaign> = {}): CouponCampaign => ({ id: uuid(100 + n), name: `Campanha ${n}`, provider: 'meta_ads', status: 'ativa', ...o });

const cupom = (codigo: string, o: Partial<CouponItem> = {}): CouponItem => ({
  id: uuid(codigo.length * 7 + codigo.charCodeAt(0)),
  code: codigo,
  origin: 'regem',
  platform: null,
  connected_account_id: uuid(1),
  kind: 'percentual',
  percent: 15,
  value_micros: null,
  min_order_micros: '50000000',
  max_discount_micros: null,
  valid_from: null,
  valid_until: null,
  active: true,
  expired: false,
  first_seen_at: local(28, 9),
  uses_7d: 0,
  revenue_7d_micros: '0',
  link: null,
  ...o,
});

const ligado = (c: CouponCampaign, o: Partial<NonNullable<CouponItem['link']>> = {}): NonNullable<CouponItem['link']> => ({
  id: uuid(900),
  campaign: c,
  exclusive: true,
  starts_at: local(29, 0),
  ends_at: null,
  campaign_spend_7d_micros: null,
  ...o,
});

const anota: CouponListResponse['detected_platform'] = { platform: 'anotaai', host: 'pedido.anota.ai', provider: 'meta_ads', ads: 14 };

describe('plataforma de pedidos da loja', () => {
  it('a informada vale; sem ela, a sugerida pelos anúncios; sem sugestão, o cardápio do Regem', () => {
    expect(plataformaDaLoja(loja({ order_platform: 'cardapioweb' }), anota)).toMatchObject({ plataforma: 'cardapioweb', informada: true });
    expect(plataformaDaLoja(loja(), anota)).toMatchObject({ plataforma: 'anotaai', informada: false });
    expect(plataformaDaLoja(loja(), null)).toMatchObject({ plataforma: 'regem', informada: false });
    expect(plataformaDaLoja(null, null).plataforma).toBe('regem');
  });

  it('a linha diz como o Liame mede em cada caso e pede confirmação da sugestão', () => {
    const sugerida = linhaPlataforma(loja(), plataformaDaLoja(loja(), anota), anota);
    expect(sugerida.titulo).toBe('Pedidos online da Loja Centro: Anota AI');
    expect(sugerida.texto).toBe(
      'Os pedidos do Anota AI chegam ao Regem, mas sem o clique do anúncio: o Liame mede cada campanha pelo cupom exclusivo dela. Sugerido pelos anúncios ativos da Meta (pedido.anota.ai): confirme.',
    );
    const regem = loja({ order_platform: 'regem' });
    expect(linhaPlataforma(regem, plataformaDaLoja(regem, anota), anota)).toEqual({ titulo: 'Pedidos online da Loja Centro: Cardápio do Regem', texto: 'O Liame mede pelo link com rastreio e pelo cupom exclusivo.' });
    const brendi = loja({ order_platform: 'brendi' });
    expect(linhaPlataforma(brendi, plataformaDaLoja(brendi, null), null).texto).toBe('Os pedidos da Brendi ainda não chegam ao Regem: por enquanto, o Liame não consegue medir essas vendas.');
    const outra = loja({ order_platform: 'outra', order_platform_url: 'https://pedidos.misterburgers.com.br/cardapio' });
    expect(linhaPlataforma(outra, plataformaDaLoja(outra, null), null).titulo).toBe('Pedidos online da Loja Centro: pedidos.misterburgers.com.br');
    expect(linhaPlataforma(loja(), plataformaDaLoja(loja(), null), null).texto).toContain('Confirme onde a loja recebe os pedidos.');
  });

  it('a nota do diálogo mostra de onde veio a sugestão; o endereço de outra plataforma é só https com domínio', () => {
    expect(notaSugestao(anota)).toBe('Detectado nos anúncios ativos da Meta: pedido.anota.ai. Confirme ou troque.');
    expect(notaSugestao(null)).toBeNull();
    expect(erroEnderecoPlataforma('https://pedidos.misterburgers.com.br')).toBeNull();
    expect(erroEnderecoPlataforma('http://pedidos.misterburgers.com.br')).toBe('Informe o endereço do cardápio, começando com https://.');
    expect(erroEnderecoPlataforma('https://localhost')).not.toBeNull();
    expect(infoPlataforma('anotaai')).toMatchObject({ de: 'do Anota AI', a: 'ao Anota AI', integrado: true, cupomExterno: true });
    expect(infoPlataforma('brendi')).toMatchObject({ de: 'da Brendi', a: 'à Brendi', integrado: false, cupomExterno: false });
  });
});

describe('cupons: regra, validade e situação', () => {
  it('regra do Regem com o mínimo; o informado diz de qual plataforma e quando', () => {
    expect(regraDoCupom(cupom('SEXTA15'), agora)).toBe('15% · mín. R$ 50');
    expect(regraDoCupom(cupom('TETO', { max_discount_micros: '20000000', min_order_micros: null }), agora)).toBe('15% até R$ 20 · sem mínimo');
    expect(regraDoCupom(cupom('COPA5', { kind: 'valor', percent: null, value_micros: '5000000', min_order_micros: '0' }), agora)).toBe('R$ 5 de desconto · sem mínimo');
    expect(regraDoCupom(cupom('MEIO', { kind: 'valor', percent: null, value_micros: '12900000' }), agora)).toBe('R$ 12,90 de desconto · mín. R$ 50');
    expect(regraDoCupom(cupom('FRETE', { kind: 'frete_gratis', percent: null }), agora)).toBe('Entrega grátis · mín. R$ 50');
    expect(regraDoCupom(cupom('TESTELIAME', { origin: 'externo', platform: 'anotaai', kind: 'outro', percent: null, first_seen_at: local(30, 11) }), agora)).toBe('Cupom do Anota AI · informado hoje');
    expect(regraDoCupom(cupom('SEXTA10', { origin: 'externo', platform: 'cardapioweb', kind: 'outro', percent: null, first_seen_at: local(28, 11) }), agora)).toBe('Cupom do CardápioWeb · informado em 28/09');
  });

  it('validade em dias do fuso da loja (o fim é exclusivo), vencida e a do informado', () => {
    // Fim exclusivo 11/10 00:00 em São Paulo = válido até 10/10.
    expect(validadeDoCupom(cupom('A', { valid_until: '2026-10-11T03:00:00.000Z' }), loja(), agora)).toBe('até 10/10');
    expect(validadeDoCupom(cupom('B', { valid_from: '2026-10-02T03:00:00.000Z', valid_until: '2026-11-01T03:00:00.000Z' }), loja(), agora)).toBe('02/10 a 31/10');
    expect(validadeDoCupom(cupom('C', { valid_until: '2026-09-21T03:00:00.000Z', expired: true }), loja(), agora)).toBe('venceu em 20/09');
    expect(validadeDoCupom(cupom('D'), loja(), agora)).toBe('sem validade');
    expect(validadeDoCupom(cupom('E', { origin: 'externo', platform: 'anotaai' }), loja(), agora)).toBe('regra e validade ficam no Anota AI');
    expect(situacaoDoCupom(cupom('F', { expired: true }))).toBe('vencido');
    expect(situacaoDoCupom(cupom('G', { active: false }))).toBe('desativado');
    expect(situacaoDoCupom(cupom('H'))).toBeNull();
  });

  it('vínculo: exclusivo ou só acompanhando, com o período quando começa adiante ou tem fim', () => {
    const c = campanha(1);
    expect(textoVinculo(cupom('A', { link: ligado(c) }), loja(), agora)).toBe('exclusivo · prova a origem');
    expect(textoVinculo(cupom('B', { link: ligado(c, { exclusive: false }) }), loja(), agora)).toBe('não exclusivo · só acompanha');
    expect(textoVinculo(cupom('C', { link: ligado(c, { starts_at: '2026-10-05T03:00:00.000Z', ends_at: '2026-11-01T03:00:00.000Z' }) }), loja(), agora)).toBe(
      'exclusivo · prova a origem · a partir de 05/10 · até 31/10',
    );
  });

  it('aviso de exclusivo sem uso só quando a campanha gastou; filtros', () => {
    const c = campanha(1);
    expect(semUsoComGasto(cupom('A', { link: ligado(c, { campaign_spend_7d_micros: '152600000' }) }))).toBe(true);
    expect(semUsoComGasto(cupom('B', { link: ligado(c, { campaign_spend_7d_micros: '0' }) }))).toBe(false);
    expect(semUsoComGasto(cupom('C', { uses_7d: 2, link: ligado(c, { campaign_spend_7d_micros: '152600000' }) }))).toBe(false);
    expect(semUsoComGasto(cupom('D', { link: ligado(c, { exclusive: false, campaign_spend_7d_micros: '152600000' }) }))).toBe(false);
    const itens = [cupom('A', { link: ligado(c) }), cupom('B')];
    expect(filtrarCupons(itens, 'ligados').map((i) => i.code)).toEqual(['A']);
    expect(filtrarCupons(itens, 'sem').map((i) => i.code)).toEqual(['B']);
    expect(filtrarCupons(itens, 'todos')).toHaveLength(2);
  });

  it('de onde vêm os cupons, pela plataforma e pela leitura', () => {
    const p = (o: Partial<CouponStore>) => plataformaDaLoja(loja(o), null);
    expect(fonteDosCupons(loja({ order_platform: 'regem' }), p({ order_platform: 'regem' }), agora)).toEqual({
      ponto: 'ok',
      texto: 'Cupons do Regem · Loja Centro · lidos hoje, 10:05. Os cupons vivem no Regem; aqui você liga cada um a uma campanha.',
    });
    expect(fonteDosCupons(loja({ order_platform: 'anotaai' }), p({ order_platform: 'anotaai' }), agora).texto).toBe(
      'Cupons do Regem e os informados do Anota AI · Loja Centro · lidos hoje, 10:05. O cupom do Anota AI vive lá; aqui você informa o código e liga a uma campanha.',
    );
    expect(fonteDosCupons(loja({ order_platform: 'brendi' }), p({ order_platform: 'brendi' }), agora).texto).toContain('Cupom da Brendi ainda não conta');
    expect(fonteDosCupons(loja({ coupons_error: 'falhou' }), p({}), agora)).toEqual({ ponto: 'atraso', texto: 'Cupons do Regem · Loja Centro · a última leitura falhou.' });
    expect(fonteDosCupons(loja({ coupons_error: 'sem_permissao' }), p({}), agora).ponto).toBe('off');
  });
});

describe('formulários de ligar e informar', () => {
  it('ligar: campanha e exclusivo obrigatórios; o vínculo começa hoje ou depois e o fim não vem antes do início', () => {
    expect(errosLigar({ campanha: '', exclusivo: '', inicio: '2026-09-30', fim: '', hoje: '2026-09-30' })).toEqual({
      campanha: 'Escolha a campanha.',
      exclusivo: 'Escolha se o cupom é exclusivo desta campanha.',
    });
    expect(errosLigar({ campanha: 'x', exclusivo: 'sim', inicio: '2026-09-29', fim: '', hoje: '2026-09-30' }).data).toBe('O vínculo começa hoje ou depois.');
    expect(errosLigar({ campanha: 'x', exclusivo: 'nao', inicio: '2026-10-02', fim: '2026-10-01', hoje: '2026-09-30' }).data).toBe('O fim do vínculo não pode ser antes do início.');
    expect(errosLigar({ campanha: 'x', exclusivo: 'sim', inicio: '2026-09-30', fim: '2026-10-31', hoje: '2026-09-30' })).toEqual({});
  });

  it('informar: formato do código, código repetido (sem diferenciar maiúsculas), campanha e exclusivo', () => {
    const base = { campanha: 'x', exclusivo: 'sim' as const, existentes: ['SEXTA10'] };
    expect(errosExterno({ ...base, codigo: 'TESTELIAME' })).toEqual({});
    expect(errosExterno({ ...base, codigo: 'sexta10' }).codigo).toBe('Esse código já está na lista.');
    expect(errosExterno({ ...base, codigo: 'ab' }).codigo).toBe('Use de 3 a 60 letras, números, ponto, hífen ou sublinhado, sem espaço.');
    expect(errosExterno({ ...base, codigo: '-SEXTA' }).codigo).toBeDefined();
    expect(errosExterno({ codigo: 'OK10', campanha: '', exclusivo: '', existentes: [] })).toEqual({
      campanha: 'Escolha a campanha do cupom.',
      exclusivo: 'Escolha se o cupom é exclusivo desta campanha.',
    });
  });

  it('hoje no fuso da loja e os avisos depois de ligar e desligar', () => {
    expect(hojeNoFuso(FUSO, new Date('2026-10-01T02:30:00Z'))).toBe('2026-09-30');
    expect(avisoLigado('TESTELIAME', 'Combo sexta', true, 'do Anota AI')).toBe(
      'TESTELIAME ligado à campanha Combo sexta como exclusivo: os pedidos do Anota AI com ele passam a contar para a campanha.',
    );
    expect(avisoLigado('SEXTA10', 'Combo sexta', false)).toBe('SEXTA10 ligado à campanha Combo sexta para acompanhar. Como não é exclusivo, não conta como evidência.');
    expect(avisoDesligado(cupom('SEXTA10'), 'Combo sexta')).toBe('SEXTA10 desligado da campanha Combo sexta. O cupom continua valendo no Regem.');
    expect(avisoDesligado(cupom('TESTELIAME', { origin: 'externo', platform: 'anotaai' }), 'Combo sexta')).toBe(
      'TESTELIAME desligado da campanha Combo sexta. O cupom continua valendo no Anota AI.',
    );
  });
});

describe('telas', () => {
  it('campanhas ativas sem cupom exclusivo (o agendado conta; o não exclusivo, não)', () => {
    const [c1, c2, c3, c4] = [campanha(1), campanha(2), campanha(3), campanha(4, { status: 'pausada' })];
    const itens = [cupom('A', { link: ligado(c1) }), cupom('B', { link: ligado(c2, { exclusive: false }) })];
    expect(campanhasSemCupom([c1!, c2!, c3!, c4!], itens).map((c) => c.name)).toEqual(['Campanha 2', 'Campanha 3']);
  });

  it('faixa da aba Links na loja do Anota AI: as campanhas sem cupom, com "Informar cupom"; na Brendi, só o aviso', () => {
    const anotaAi = plataformaDaLoja(loja({ order_platform: 'anotaai' }), null);
    const html = renderToStaticMarkup(
      createElement(FaixaSemCupom, { plataforma: anotaAi, campanhas: [campanha(1), campanha(2)], itens: [cupom('A', { link: ligado(campanha(1)) })], podeInformar: true, aoInformar: () => {} }),
    );
    expect(html).toContain('1 campanha ativa sem cupom exclusivo — as vendas dela ficam sem origem.');
    expect(html).toContain('Os anúncios levam ao Anota AI, a plataforma de pedidos da loja.');
    expect(html).toContain('Ver a campanha');
    expect(html).toContain('Campanha 2');
    expect(html).toContain('Informar cupom');
    const tudo = renderToStaticMarkup(createElement(FaixaSemCupom, { plataforma: anotaAi, campanhas: [campanha(1)], itens: [cupom('A', { link: ligado(campanha(1)) })], podeInformar: true, aoInformar: () => {} }));
    expect(tudo).toContain('Todas as campanhas ativas têm cupom exclusivo');
    const brendi = renderToStaticMarkup(
      createElement(FaixaSemCupom, { plataforma: plataformaDaLoja(loja({ order_platform: 'brendi' }), null), campanhas: [campanha(1)], itens: [], podeInformar: true, aoInformar: () => {} }),
    );
    expect(brendi).toContain('Os anúncios levam à Brendi, que ainda não está integrada ao Regem');
    expect(brendi).not.toContain('Informar cupom');
  });

  it('linha da plataforma: "Confirmar" enquanto não informada, "Alterar" depois; sem loja do Liame, explica o que falta', () => {
    const linha = (l: CouponStore, podeAlterar = true) =>
      renderToStaticMarkup(createElement(LinhaPlataforma, { loja: l, plataforma: plataformaDaLoja(l, anota), sugerida: anota, podeAlterar, aoAlterar: () => {} }));
    expect(linha(loja())).toContain('>Confirmar<');
    expect(linha(loja({ order_platform: 'anotaai' }))).toContain('>Alterar<');
    expect(linha(loja(), false)).not.toContain('<button');
    const solta = linha(loja({ unit: null }));
    expect(solta).not.toContain('<button');
    expect(solta).toContain('ligue esta loja do Regem a uma loja do Liame em Contas conectadas');
  });

  it('tabela: código e plataforma do informado, regra e validade, usos com o valor, campanha e a ação de cada situação', () => {
    const c1 = campanha(1, { name: 'Combo sexta' });
    const itens = [
      cupom('TESTELIAME', { origin: 'externo', platform: 'anotaai', kind: 'outro', percent: null, uses_7d: 6, revenue_7d_micros: '412300000', link: ligado(c1), first_seen_at: local(30, 11) }),
      cupom('NOITE15', { link: ligado(campanha(2, { name: 'Delivery noite' }), { campaign_spend_7d_micros: '152600000' }) }),
      cupom('SEXTA15'),
      cupom('COPA5', { expired: true, valid_until: '2026-09-21T03:00:00.000Z' }),
      cupom('OFF', { active: false }),
    ];
    const html = renderToStaticMarkup(createElement(TabelaCupons, { itens, loja: loja(), agora, podeGerenciar: true, aoLigar: () => {}, aoDesligar: async () => true }));
    expect(html).toContain('<caption class="sr-only">Cupons da Loja Centro</caption>');
    expect(html).toContain('TESTELIAME</span> <span class="plat">Anota AI</span>');
    expect(html).toContain('Cupom do Anota AI · informado hoje');
    expect(html).toContain('R$ 412,30 em pedidos');
    expect(html).toContain('sem uso, com R$ 152,60 gastos');
    expect(html).toContain('aria-label="Desligar TESTELIAME da campanha Combo sexta"');
    expect(html).toContain('aria-label="Ligar SEXTA15 a uma campanha"');
    expect(html).toContain('Vencido no Regem');
    expect(html).toContain('Desativado no Regem');
    expect(html).toContain('class="cupom-vencido"');
    expect(html).toMatch(/Todos <span class="num">5<\/span>.*Ligados a campanha <span class="num">2<\/span>.*Sem campanha <span class="num">3<\/span>/s);
    // Sem permissão de mudar: nenhuma ação de ligar ou desligar.
    const leitura = renderToStaticMarkup(createElement(TabelaCupons, { itens, loja: loja(), agora, podeGerenciar: false, aoLigar: () => {}, aoDesligar: async () => true }));
    expect(leitura).not.toContain('Desligar');
    expect(leitura).not.toContain('Ligar a campanha');
  });
});
