import {
  type AccountFreshness,
  type ConnectedAccountResponse,
  type ConnectionResponse,
  type DiscoveredAccount,
  META_INSTAGRAM_PUBLISH_SCOPE,
  META_PAGE_PUBLISH_SCOPE,
} from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  avisoCanalDesligado,
  avisoDosCanaisLigados,
  canaisNaAutorizacao,
  canalSemPermissao,
  confirmaDesligarCanal,
  conviteDosPosts,
  faixaDoCanalSemPermissao,
  oQueAAutorizacaoPublica,
  publicaNo,
  QUANDO_DO_CANAL,
  situacaoDoCanal,
  subDaEscolhaDoCanal,
  subDoCanal,
} from '@/components/contas/canais-da-meta';
import { CartaoAutorizacao } from '@/components/contas/cartao-autorizacao';
import { DialogoConectar } from '@/components/contas/dialogo-conectar';
import { DialogoEscolher } from '@/components/contas/dialogo-escolher';
import { DialogoRevogar } from '@/components/contas/dialogo-revogar';
import { contasELojas, ligadasDaAutorizacao } from '@/components/contas/perfil-google';
import {
  autorizadorDa,
  botaoLigar,
  contasExistentes,
  escolhiveis,
  faixaDaVolta,
  gruposDaEscolha,
  notaDeConectar,
  plataforma,
  resumoDaDescoberta,
} from '@/components/contas/textos';

// A Página do Facebook e o Instagram em "Contas conectadas" (P19, parte B, aprovado em 01/11/2026;
// mockups/prototipo-contas-posts.html). Datas no fuso local, nunca o relógio real (V113).

const local = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString();
const agora = new Date(2026, 10, 1, 21, 0, 0);
const ID = '01a0e1a1-ea5a-7822-a16c-376c2c942666';
const ANTIGA = '01a0e1a1-ea5a-7822-a16c-376c2c942600';
const MARCA = '01a0e1a1-ea64-71ed-8775-f13002fd25f0';
const PUBLICA = ['ads_read', 'pages_show_list', META_PAGE_PUBLISH_SCOPE, META_INSTAGRAM_PUBLISH_SCOPE];

const descoberta = (provider: string, external_id: string, name: string, extra: Partial<DiscoveredAccount> = {}): DiscoveredAccount => ({
  provider,
  external_id,
  name,
  currency: provider === 'meta_ads' ? 'BRL' : null,
  timezone: provider === 'meta_ads' ? 'America/Sao_Paulo' : null,
  linked: false,
  via: null,
  ...extra,
});
const PAGINA = descoberta('facebook_page', '102030405060708', 'Mister Burgers', { has_instagram: true, instagram_name: '@misterburgers' });
const EVENTOS = descoberta('facebook_page', '102030405060709', 'Mister Burgers Eventos', { has_instagram: false, instagram_name: null });
const INSTAGRAM = descoberta('instagram', '17841400000000001', '@misterburgers', { page_name: 'Mister Burgers' });
const ANUNCIO = descoberta('meta_ads', 'act_1234567890', 'Mister Burgers', { linked: true });

const conta = (provider: string, external_id: string, extra: Partial<ConnectedAccountResponse> = {}): ConnectedAccountResponse => ({
  id: `${provider}-${external_id}`,
  brand_id: MARCA,
  connection_id: ID,
  provider,
  external_id,
  name: external_id,
  currency: null,
  timezone: null,
  status: 'ativa',
  status_reason: null,
  unit_id: null,
  unit_name: null,
  scopes: [],
  connected_at: local(1, 9),
  disconnected_at: null,
  ...extra,
});
const conexao = (extra: Partial<ConnectionResponse> = {}): ConnectionResponse => ({
  id: ID,
  brand_id: MARCA,
  provider: 'meta',
  origin: 'oauth',
  status: 'ativa',
  error_code: null,
  authorized_by: 'Rodrigo de Oliveira',
  created_at: local(1, 9),
  completed_at: local(1, 9, 1),
  refresh_expires_at: null,
  scopes: PUBLICA,
  requested_access: 'escrita',
  discovered: [],
  accounts: [],
  channel_search: { result: 'ok', searched_at: local(1, 9, 1), pages: 2, instagrams: 1 },
  ...extra,
});
const canal = (provider: string, extra: Partial<AccountFreshness> = {}): AccountFreshness => ({
  connected_account_id: `${provider}-1`,
  brand_id: MARCA,
  provider,
  name: provider === 'instagram' ? '@misterburgers' : 'Mister Burgers',
  status: 'ativa',
  status_reason: null,
  datasets: [],
  ...extra,
});

describe('a Página e o Instagram na lista de contas', () => {
  it('as etiquetas, quem autoriza (a Meta) e a linha de baixo sem o código da Meta', () => {
    expect(plataforma('facebook_page')).toEqual({ nome: 'Página do Facebook', classe: 'fb' });
    expect(plataforma('instagram')).toEqual({ nome: 'Instagram', classe: 'ig' });
    expect(autorizadorDa('facebook_page')).toBe('meta');
    expect(autorizadorDa('instagram')).toBe('meta');
    expect(subDoCanal('facebook_page', { has_instagram: true, instagram_name: '@misterburgers' })).toBe('Página do Facebook · com o Instagram @misterburgers');
    expect(subDoCanal('facebook_page', { has_instagram: false, instagram_name: null })).toBe('Página do Facebook · sem Instagram profissional ligado');
    // Tem Instagram, mas o Liame não sabe qual (a autorização não tem a permissão dele).
    expect(subDoCanal('facebook_page', { has_instagram: true, instagram_name: null })).toBe('Página do Facebook · com um Instagram profissional');
    expect(subDoCanal('instagram', { page_name: 'Mister Burgers' })).toBe('Instagram profissional · ligado à Página Mister Burgers');
    expect(subDoCanal('instagram', null)).toBe('Instagram profissional');
    expect(QUANDO_DO_CANAL).toBe('só publica');
    expect(confirmaDesligarCanal('facebook_page')).toBe('Os posts deixam de sair nesta Página; os já marcados para ela não saem nela.');
    expect(confirmaDesligarCanal('instagram')).toBe('Os posts deixam de sair neste Instagram; os já marcados para ele não saem nele.');
    expect(avisoCanalDesligado('facebook_page')).toBe('Página desligada. Os posts já publicados nela continuam lá.');
    expect(avisoCanalDesligado('instagram')).toBe('Instagram desligado. Os posts já publicados nele continuam lá.');
  });

  it('a situação: pronta para publicar, sem a permissão tirada na Meta, a permissão que não se sabe e a função desligada', () => {
    expect(situacaoDoCanal(canal('facebook_page'), PUBLICA, true)).toMatchObject({ rotulo: 'Pronta para publicar', tom: 'ok', motivo: 'Os posts aprovados da marca saem aqui.', precisaDeVoce: false });
    expect(situacaoDoCanal(canal('instagram'), PUBLICA, true).rotulo).toBe('Pronto para publicar');
    // A permissão da Página tirada na Meta: a linha vira problema e oferece conectar de novo; o Instagram segue.
    const semPagina = ['ads_read', META_INSTAGRAM_PUBLISH_SCOPE];
    expect(situacaoDoCanal(canal('facebook_page'), semPagina, true)).toMatchObject({
      rotulo: 'Sem permissão',
      tom: 'perigo',
      motivo: 'A permissão de publicar nesta Página foi tirada na Meta. Os posts marcados para ela não saem nela até você autorizar a Meta de novo.',
      precisaDeVoce: true,
      reconectar: true,
    });
    expect(situacaoDoCanal(canal('instagram'), semPagina, true).rotulo).toBe('Pronto para publicar');
    // As permissões não lidas (a autorização anterior a 29/10/2026, ERR-179) não viram "sem permissão".
    expect(situacaoDoCanal(canal('facebook_page'), [], true).rotulo).toBe('Pronta para publicar');
    expect(situacaoDoCanal(canal('facebook_page'), null, true).rotulo).toBe('Pronta para publicar');
    expect(situacaoDoCanal(canal('instagram', { status: 'desconectada' }), PUBLICA, true)).toMatchObject({ rotulo: 'Desconectada', tom: 'perigo', reconectar: true });
    expect(situacaoDoCanal(canal('instagram'), PUBLICA, false)).toMatchObject({ rotulo: 'Posts parados', tom: 'espera', precisaDeVoce: false });
    expect(publicaNo('facebook_page', PUBLICA)).toBe('sim');
    expect(publicaNo('facebook_page', semPagina)).toBe('nao');
    expect(publicaNo('instagram', [])).toBe('nao_sei');
  });

  it('o aviso do topo quando um canal perdeu a permissão: o que parou e o que segue', () => {
    const linha = (provider: string, nome: string, situacao: ReturnType<typeof situacaoDoCanal>) => ({ provider, nome, brandId: MARCA, situacao });
    const semPagina = ['ads_read', META_INSTAGRAM_PUBLISH_SCOPE];
    const linhas = [
      linha('facebook_page', 'Mister Burgers', situacaoDoCanal(canal('facebook_page'), semPagina, true)),
      linha('instagram', '@misterburgers', situacaoDoCanal(canal('instagram'), semPagina, true)),
    ];
    const c = canalSemPermissao(linhas)!;
    expect(c).toEqual({ nome: 'Mister Burgers', provider: 'facebook_page', brandId: MARCA });
    expect(faixaDoCanalSemPermissao(c, true)).toEqual({
      titulo: 'A Página Mister Burgers não aceita mais posts do Liame',
      texto: 'A permissão de publicar nela foi tirada na Meta. Os posts marcados para a Página não saem nela; os do Instagram seguem. Autorize a Meta de novo para voltar.',
    });
    expect(faixaDoCanalSemPermissao({ nome: '@misterburgers', provider: 'instagram' }, false).texto).toBe(
      'A permissão de publicar nele foi tirada na Meta. Os posts marcados para o Instagram não saem nele. Autorize a Meta de novo para voltar.',
    );
    expect(canalSemPermissao([linha('instagram', '@misterburgers', situacaoDoCanal(canal('instagram'), PUBLICA, true))])).toBeNull();
  });
});

describe('a autorização da Meta com os posts', () => {
  it('sem a função, nada muda; o que ela inclui de publicar', () => {
    expect(canaisNaAutorizacao(conexao(), false)).toBeNull();
    expect(oQueAAutorizacaoPublica(PUBLICA)).toBe('os_dois');
    expect(oQueAAutorizacaoPublica(['ads_read', META_PAGE_PUBLISH_SCOPE])).toBe('pagina');
    expect(oQueAAutorizacaoPublica(['ads_read'])).toBe('nenhum');
    expect(oQueAAutorizacaoPublica([])).toBe('nao_sei');
  });

  it('o que o cartão diz em cada situação do desenho', () => {
    const s = (extra: Partial<ConnectionResponse>) => canaisNaAutorizacao(conexao(extra), true);
    // A Meta conectada sem a permissão de publicar.
    expect(s({ scopes: ['ads_read'], channel_search: null })).toEqual({
      inclui: null,
      nota: { icone: 'lock', destaque: null, texto: 'Esta autorização não inclui publicar na Página e no Instagram. As contas de anúncio são lidas normalmente.' },
      acao: null,
    });
    // As permissões não lidas: manda procurar de novo, sem afirmar nada.
    expect(s({ scopes: [], channel_search: null })).toMatchObject({ inclui: null, nota: { texto: 'Para saber se esta autorização inclui publicar na Página e no Instagram, procure as contas de novo.' }, acao: null });
    // Encontrou e nada está ligado.
    expect(s({ discovered: [ANUNCIO, PAGINA, EVENTOS, INSTAGRAM] })).toEqual({
      inclui: 'Inclui publicar na Página e no Instagram, sempre com a aprovação de uma pessoa.',
      nota: { icone: 'info', destaque: 'Esta autorização alcança 2 Páginas e 1 Instagram que ainda não estão ligados.', texto: 'Ligue a Página e o Instagram da marca para os posts aprovados saírem neles.' },
      acao: 'escolher',
    });
    expect(s({ discovered: [ANUNCIO, { ...PAGINA, linked: true }, EVENTOS, { ...INSTAGRAM, linked: true }] })?.nota?.destaque).toBe(
      'Esta autorização alcança 1 Página que ainda não está ligado.',
    );
    // A Página sem Instagram profissional ligado na Meta.
    expect(s({ discovered: [ANUNCIO, { ...PAGINA, has_instagram: false, instagram_name: null }], channel_search: { result: 'ok', searched_at: local(1, 9), pages: 1, instagrams: 0 } })).toEqual({
      inclui: 'Inclui publicar na Página e no Instagram, sempre com a aprovação de uma pessoa.',
      nota: {
        icone: 'info',
        destaque: 'A Página Mister Burgers não tem um Instagram profissional ligado a ela na Meta.',
        texto: 'O Liame só alcança o Instagram pela Página: ligue o Instagram profissional à Página na Meta e procure as contas de novo. A Página pode ser ligada sem ele.',
      },
      acao: 'escolher',
    });
    // A procura que falhou não se repete sozinha.
    expect(s({ channel_search: { result: 'falhou', searched_at: local(1, 9), pages: 0, instagrams: 0 } })?.nota).toEqual({
      icone: 'alert',
      destaque: 'Não deu para procurar as Páginas agora.',
      texto: 'A Meta não respondeu. As contas de anúncio não foram afetadas. Procure de novo em alguns minutos.',
    });
    expect(s({ channel_search: { result: 'limite', searched_at: local(1, 9), pages: 0, instagrams: 0 } })?.nota?.texto).toMatch(/^A Meta pediu para esperar\./);
    // A permissão da Página tirada na Meta, com a Página e o Instagram ligados.
    const ligadas = [conta('facebook_page', '102030405060708', { name: 'Mister Burgers' }), conta('instagram', '17841400000000001', { name: '@misterburgers' })];
    expect(s({ scopes: ['ads_read', META_INSTAGRAM_PUBLISH_SCOPE], accounts: ligadas })).toEqual({
      inclui: 'Inclui publicar no Instagram, sempre com a aprovação de uma pessoa.',
      nota: {
        icone: 'alert-circle',
        perigo: true,
        destaque: 'A permissão de publicar na Página Mister Burgers foi tirada na Meta.',
        texto: 'Os posts marcados para a Página não saem nela; os do Instagram seguem. Autorize a Meta de novo para voltar.',
      },
      acao: 'autorizar',
    });
    // Tudo ligado: só o que inclui, sem aviso.
    expect(s({ discovered: [ANUNCIO, { ...PAGINA, linked: true }, { ...INSTAGRAM, linked: true }], accounts: ligadas })).toEqual({
      inclui: 'Inclui publicar na Página e no Instagram, sempre com a aprovação de uma pessoa.',
      nota: null,
      acao: null,
    });
  });

  it('o convite do topo: os posts ligados, a Meta conectada e nenhuma autorização que se saiba publicar', () => {
    const sem = conexao({ scopes: ['ads_read'] });
    expect(conviteDosPosts([sem], true)).toEqual({ brandId: MARCA });
    expect(conviteDosPosts([sem], false)).toBeNull();
    expect(conviteDosPosts([], true)).toBeNull();
    expect(conviteDosPosts([sem, conexao({ id: 'nova' })], true)).toBeNull();
    // A que não se sabe não chama o convite: o cartão dela manda procurar de novo.
    expect(conviteDosPosts([conexao({ scopes: [] })], true)).toBeNull();
    expect(conviteDosPosts([{ ...sem, status: 'revogada' }], true)).toBeNull();
    expect(conviteDosPosts([conexao({ provider: 'google', scopes: ['x'] })], true)).toBeNull();
  });

  it('as contas, a Página e o Instagram contam à parte: no cartão e no diálogo de revogar', () => {
    const c = conexao({ accounts: [conta('meta_ads', 'act_1'), conta('meta_ads', 'act_2'), conta('facebook_page', 'p1'), conta('instagram', 'i1'), conta('instagram', 'i2', { disconnected_at: local(1, 8) })] });
    expect(ligadasDaAutorizacao(c)).toEqual({ contas: 2, lojas: 0, sites: 0, paginas: 1, instagrams: 1 });
    expect(contasELojas(ligadasDaAutorizacao(c))).toBe('2 contas, 1 Página e 1 Instagram');
    expect(contasELojas({ contas: 0, lojas: 0, paginas: 1, instagrams: 0 })).toBe('1 Página');
    const revogar = renderToStaticMarkup(createElement(DialogoRevogar, { conexao: c, reserva: { current: null }, aoRevogar: () => {}, aoFechar: () => {} }));
    expect(revogar).toContain('A leitura das <b>2 contas</b> para agora, e os posts deixam de sair <b>na Página e no Instagram</b> desta autorização. O histórico fica, e o que');
    expect(revogar).toContain('já foi publicado continua nas redes.');
  });

  it('o cartão desenhado: o que inclui de publicar, o aviso e "Autorizar a Meta de novo"', () => {
    const base = { agora, podeConectar: true, procurando: false, aoEscolher: null, aoReconectar: () => {}, aoAutorizar: () => {}, aoProcurar: () => {}, aoRevogar: () => {} };
    const ligadas = [conta('meta_ads', 'act_1'), conta('facebook_page', 'p1', { name: 'Mister Burgers' }), conta('instagram', 'i1', { name: '@misterburgers' })];
    const ok = conexao({ accounts: ligadas });
    const html = renderToStaticMarkup(createElement(CartaoAutorizacao, { ...base, conexao: ok, canais: canaisNaAutorizacao(ok, true) }));
    expect(html).toContain('1 conta, 1 Página e 1 Instagram');
    expect(html).toContain('Autorização da empresa, sem prazo de validade. Inclui publicar na Página e no Instagram, sempre com a aprovação de uma pessoa.');
    expect(html).not.toContain('Autorizar a Meta de novo');
    const tirada = conexao({ scopes: ['ads_read', META_INSTAGRAM_PUBLISH_SCOPE], accounts: ligadas });
    const r = renderToStaticMarkup(createElement(CartaoAutorizacao, { ...base, conexao: tirada, canais: canaisNaAutorizacao(tirada, true) }));
    expect(r).toContain('<b>A permissão de publicar na Página Mister Burgers foi tirada na Meta.</b>');
    // O aviso do que parou vem em vermelho, como no desenho.
    expect(r).toContain('class="aut-txt aut-txt--perigo"');
    expect(r).toContain('>Autorizar a Meta de novo</button>');
    expect(r).not.toContain('Autorizar o Google de novo');
    // Sem a função: o cartão de sempre.
    const semFuncao = renderToStaticMarkup(createElement(CartaoAutorizacao, { ...base, conexao: conexao({ accounts: [conta('meta_ads', 'act_1')] }), canais: null }));
    expect(semFuncao).not.toContain('publicar');
  });
});

describe('conectar e escolher com os posts', () => {
  const marcas = [{ id: MARCA, name: 'Mister Burgers', archived_at: null, purge_after: null }];
  const dialogo = { marcas, marcaInicial: null, reserva: { current: null }, aoFechar: () => {}, aoIr: () => {} };

  it('a opção da Meta vale para os anúncios e os posts, com o aviso das permissões de publicar logo abaixo', () => {
    const com = renderToStaticMarkup(createElement(DialogoConectar, { ...dialogo, comPosts: true }));
    expect(com).toContain('<b>Meta Ads, Página e Instagram</b>');
    expect(com).toContain('Os anúncios e os posts numa autorização só. Você escolhe as contas, a Página e o Instagram na tela da Meta.');
    expect(com).toContain('<b>A Meta vai pedir permissões a mais: publicar na Página e no Instagram.</b> O Liame só publica o post que uma pessoa aprova com o código do app');
    expect(com).toContain('nunca publica sozinho');
    expect(com).toContain('os anúncios conectam do mesmo jeito, sem os posts.');
    expect(com).toContain('Na Meta, o Liame lê os anúncios e só publica o post que uma pessoa aprova; no Google, só lê.');
    const id = com.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(com).toContain(`<p class="dialogo-nota" id="${id}">`);
    const sem = renderToStaticMarkup(createElement(DialogoConectar, dialogo));
    expect(sem).toContain('<b>Meta Ads</b>');
    expect(sem).not.toContain('publicar');
    // Com a escrita da Meta, a nota diz as duas coisas.
    expect(notaDeConectar(false, false, ['meta_ads'], true)).toContain('campanhas, conjuntos e anúncios. Publica só o post que uma pessoa aprova.');
  });

  it('a volta da Meta conta a Página e o Instagram à parte, e os grupos vêm depois da Meta Ads', () => {
    const d = [ANUNCIO, { ...ANUNCIO, external_id: 'act_2', name: 'Loja 2' }, PAGINA, EVENTOS, INSTAGRAM];
    expect(resumoDaDescoberta(d)).toBe('2 contas de anúncio, 2 Páginas do Facebook e 1 Instagram');
    expect(faixaDaVolta({ conexao: ID, erro: null }, conexao({ status: 'aguardando_escolha', discovered: d }), 'Mister Burgers')).toEqual({
      tipo: 'escolher',
      titulo: 'A Meta autorizou. Encontramos 2 contas, 2 Páginas e 1 Instagram.',
      texto: '2 contas de anúncio, 2 Páginas do Facebook e 1 Instagram. Escolha quais ligar à marca Mister Burgers: os posts aprovados da marca saem na Página e no Instagram que você ligar.',
    });
    expect(gruposDaEscolha(d).map((g) => g.titulo)).toEqual(['Meta Ads', 'Páginas do Facebook', 'Instagram']);
    expect(botaoLigar(2, 0, 0, 1, 1)).toBe('Ligar 1 Página e 1 Instagram');
    expect(botaoLigar(3, 0, 0, 2, 0)).toBe('Ligar 1 conta e 2 Páginas');
    expect(subDaEscolhaDoCanal(PAGINA)).toBe('com o Instagram @misterburgers');
    expect(subDaEscolhaDoCanal(EVENTOS)).toBe('sem Instagram profissional ligado');
    expect(subDaEscolhaDoCanal(INSTAGRAM)).toBe('ligado à Página Mister Burgers');
    expect(avisoDosCanaisLigados(1, 1)).toBe('Página e Instagram ligados. Os posts aprovados da marca saem neles.');
    expect(avisoDosCanaisLigados(0, 1)).toBe('Instagram ligado. Os posts aprovados da marca saem nele.');
    expect(avisoDosCanaisLigados(1, 0)).toBe('Página ligada. Os posts aprovados da marca saem nela.');
  });

  it('o diálogo de escolher desenhado: os grupos, a linha de baixo, o Instagram e a Página dele marcados e a nota', () => {
    const base = { existentes: [], marca: 'Mister Burgers', reserva: { current: null }, aoLigar: () => {}, aoFechar: () => {} };
    const html = renderToStaticMarkup(createElement(DialogoEscolher, { ...base, conexao: conexao({ status: 'aguardando_escolha', discovered: [ANUNCIO, PAGINA, EVENTOS, INSTAGRAM] }) }));
    expect(html).toContain('<legend>Páginas do Facebook</legend>');
    expect(html).toContain('<legend>Instagram</legend>');
    expect(html).toContain('<span class="escolha-sub">com o Instagram @misterburgers</span>');
    expect(html).toContain('<span class="escolha-sub">sem Instagram profissional ligado</span>');
    expect(html).toContain('<span class="escolha-sub">ligado à Página Mister Burgers</span>');
    expect(html).not.toContain('102030405060708');
    expect(html).toContain('Ligar 1 Página e 1 Instagram');
    expect(html).toContain('A Página e o Instagram não são lidos agora: é neles que os posts aprovados da marca saem, um por vez, depois da aprovação com o código do app. As contas de anúncio seguem como estão.');
    // A Página dos Eventos (sem Instagram) não vem marcada; a Mister Burgers e o Instagram, sim.
    const marcadas = [...html.matchAll(/<input[^>]*checked=""[^>]*\/?>\s*<span><b>([^<]+)<\/b>/g)].map((m) => m[1]);
    expect(marcadas).toEqual(['Mister Burgers', 'Mister Burgers', '@misterburgers']);
    expect(html).not.toMatch(/NaN|undefined|\[object Object\]/);
  });

  it('a Página que a autorização de hoje não deixa mais publicar entra na escolha da autorização nova (V50)', () => {
    const antiga = conexao({ id: ANTIGA, scopes: ['ads_read', META_INSTAGRAM_PUBLISH_SCOPE], accounts: [conta('facebook_page', PAGINA.external_id, { connection_id: ANTIGA })] });
    const nova = conexao({ status: 'aguardando_escolha', discovered: [{ ...PAGINA, linked: true }, INSTAGRAM] });
    const existentes = contasExistentes([antiga]);
    expect(existentes[0]).toMatchObject({ provider: 'facebook_page', publica: false });
    const opcoes = escolhiveis(nova, existentes);
    expect(opcoes).toEqual([expect.objectContaining({ conta: expect.objectContaining({ provider: 'facebook_page' }), reconectar: true, publicar: true }), { conta: INSTAGRAM, reconectar: false }]);
    // A autorização que não se sabe não oferece a Página de novo (nada de "volta a publicar" sem saber).
    expect(escolhiveis(nova, contasExistentes([{ ...antiga, scopes: [] }]))).toEqual([{ conta: INSTAGRAM, reconectar: false }]);
    // Só a Página voltando a publicar: a faixa da volta pede para confirmar.
    expect(faixaDaVolta({ conexao: ID, erro: null }, conexao({ status: 'aguardando_escolha', discovered: [{ ...PAGINA, linked: true }] }), 'Mister Burgers', { existentes })).toEqual({
      tipo: 'escolher',
      titulo: 'A Meta autorizou o Liame a publicar de novo.',
      texto: 'Confirme a Página para os posts aprovados da marca voltarem a sair nela.',
    });
    const html = renderToStaticMarkup(
      createElement(DialogoEscolher, { existentes, marca: 'Mister Burgers', reserva: { current: null }, aoLigar: () => {}, aoFechar: () => {}, conexao: nova }),
    );
    expect(html).toContain('<span class="lite-chip">volta a publicar</span>');
  });

  it('a Página ou o Instagram que a autorização não deixa publicar fica fora da escolha; o que não se sabe, não', () => {
    const semPagina = conexao({ status: 'aguardando_escolha', scopes: ['ads_read', META_INSTAGRAM_PUBLISH_SCOPE], discovered: [PAGINA, EVENTOS, INSTAGRAM] });
    expect(escolhiveis(semPagina, []).map((o) => o.conta.provider)).toEqual(['instagram']);
    expect(escolhiveis(conexao({ status: 'aguardando_escolha', scopes: [], discovered: [PAGINA, INSTAGRAM] }), []).map((o) => o.conta.provider)).toEqual(['facebook_page', 'instagram']);
  });

  it('sem mudar campanhas na Meta, a autorização de escrita dos posts não oferece a conta de anúncio só por ser de escrita (D-A6-63)', () => {
    const leitura = conexao({ id: ANTIGA, requested_access: 'leitura', scopes: ['ads_read'], accounts: [conta('meta_ads', 'act_1234567890', { connection_id: ANTIGA })] });
    const nova = conexao({ status: 'aguardando_escolha', discovered: [ANUNCIO, INSTAGRAM] });
    expect(escolhiveis(nova, contasExistentes([leitura]))).toEqual([expect.objectContaining({ conta: ANUNCIO, escrita: true }), { conta: INSTAGRAM, reconectar: false }]);
    expect(escolhiveis(nova, contasExistentes([leitura], { escritaNaMeta: false }))).toEqual([{ conta: INSTAGRAM, reconectar: false }]);
  });
});
