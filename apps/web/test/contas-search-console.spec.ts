import {
  type AccountFreshness,
  type ConnectedAccountResponse,
  type ConnectionResponse,
  type DiscoveredAccount,
  GOOGLE_ANALYTICS_SCOPE,
  GOOGLE_BUSINESS_SCOPE,
  SEARCH_CONSOLE_SCOPE,
} from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CartaoAutorizacao } from '@/components/contas/cartao-autorizacao';
import { DialogoConectar } from '@/components/contas/dialogo-conectar';
import { DialogoEscolher } from '@/components/contas/dialogo-escolher';
import { DialogoRevogar } from '@/components/contas/dialogo-revogar';
import { contasELojas, ligadasDaAutorizacao, oQueParaDeLer, perfilNaAutorizacao } from '@/components/contas/perfil-google';
import {
  AVISO_SITE_DESLIGADO,
  avisoDeLigar,
  CONFIRMA_DESLIGAR_SITE,
  conviteDoSearchConsole,
  notaDaPrimeiraLeitura,
  searchConsoleNaAutorizacao,
  situacaoDoSite,
  subDaEscolhaDoSite,
  subDoSite,
} from '@/components/contas/search-console';
import { autorizadorDa, botaoLigar, descricaoDoGoogle, faixaDaVolta, gruposDaEscolha, plataforma, resumoDaDescoberta, tituloDoGoogle } from '@/components/contas/textos';

// O site do Search Console em "Contas conectadas" (P18, parte B; mockups/prototipo-contas-search-console.html).
// Datas no fuso local, nunca o relógio real (V113): rodar com TZ=UTC também.

const agora = new Date(2026, 9, 20, 10, 30, 0); // 20/10/2026 10:30
const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const ID = '01a0e1a1-ea5a-7822-a16c-376c2c942655';
const MARCA = '01a0e1a1-ea64-71ed-8775-f13002fd25f0';
const LEITURA = 'https://www.googleapis.com/auth/adwords';
const DOMINIO = 'sc-domain:misterburgers.com.br';
const ENDERECO = 'https://cardapio.misterburgers.com.br/';

const descoberta = (provider: string, external_id: string, name: string, extra: Partial<DiscoveredAccount> = {}): DiscoveredAccount => ({
  provider,
  external_id,
  name,
  currency: provider === 'search_console' || provider === 'google_business' ? null : 'BRL',
  timezone: provider === 'search_console' || provider === 'google_business' ? null : 'America/Sao_Paulo',
  linked: false,
  via: null,
  ...(provider === 'search_console' ? { site_access: 'dono' } : {}),
  ...extra,
});
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
  connected_at: local(14, 9),
  disconnected_at: null,
  ...extra,
});
const conexao = (extra: Partial<ConnectionResponse> = {}): ConnectionResponse => ({
  id: ID,
  brand_id: MARCA,
  provider: 'google',
  origin: 'oauth',
  status: 'ativa',
  error_code: null,
  authorized_by: 'Rodrigo de Oliveira',
  created_at: local(14, 9),
  completed_at: local(14, 9, 1),
  refresh_expires_at: null,
  scopes: [LEITURA, GOOGLE_ANALYTICS_SCOPE, SEARCH_CONSOLE_SCOPE],
  discovered: [],
  accounts: [],
  site_search: { result: 'ok', searched_at: local(14, 9, 1), sites: 1 },
  ...extra,
});
const site = (extra: Partial<AccountFreshness> = {}, conjunto: Partial<AccountFreshness['datasets'][number]> = {}): AccountFreshness => ({
  connected_account_id: 'site-1',
  brand_id: MARCA,
  provider: 'search_console',
  name: 'misterburgers.com.br',
  status: 'ativa',
  status_reason: null,
  datasets: [
    { dataset: 'buscas_dias', freshness: 'fresh', last_success_at: local(20, 10, 5), last_attempt_at: local(20, 10, 5), last_error: null, next_at: local(21, 10, 5), ...conjunto },
    { dataset: 'buscas_semanas', freshness: 'fresh', last_success_at: local(20, 10, 6), last_attempt_at: local(20, 10, 6), last_error: null, next_at: local(21, 10, 6) },
  ],
  ...extra,
});

describe('o site na lista de contas', () => {
  it('a etiqueta "Search Console", a linha de baixo sem o código do Google, e quem autoriza é o Google', () => {
    expect(plataforma('search_console')).toEqual({ nome: 'Search Console', classe: 'sc' });
    expect(autorizadorDa('search_console')).toBe('google');
    expect(subDoSite(DOMINIO)).toBe('Site no Search Console · o domínio inteiro');
    expect(subDoSite(ENDERECO)).toBe('Site no Search Console · um endereço');
    expect(subDoSite(null)).toBe('Site no Search Console · um endereço');
    expect(CONFIRMA_DESLIGAR_SITE).toBe('O Liame para de ler os cliques e as buscas deste site.');
    expect(AVISO_SITE_DESLIGADO).toBe('Site desligado. As buscas já lidas ficam guardadas por até 12 meses; para voltar a ler, ligue o site de novo.');
  });

  it('a situação pela leitura dos números por dia: em dia, primeira leitura, esperando o Google, atrasada', () => {
    expect(situacaoDoSite(site(), true, agora)).toMatchObject({ rotulo: 'Buscas em dia', tom: 'ok', motivo: null, ultimaLeituraEm: local(20, 10, 5) });
    expect(situacaoDoSite(site({}, { freshness: 'unknown', last_success_at: null }), true, agora)).toMatchObject({
      rotulo: 'Primeira leitura',
      tom: 'lendo',
      motivo: 'Trazendo os cliques dos últimos 90 dias e as buscas das últimas 12 semanas. Leva alguns minutos.',
    });
    // A conta que ainda não tem nenhum conjunto (o frescor manda "metricas" desconhecido) também é primeira leitura.
    expect(situacaoDoSite(site({ datasets: [{ dataset: 'metricas', freshness: 'unknown', last_success_at: null, last_attempt_at: null, last_error: null, next_at: null }] }), true, agora).rotulo).toBe('Primeira leitura');
    const espera = (next_at: string) => situacaoDoSite(site({}, { last_error: 'limite: quota exceeded', next_at }), true, agora);
    expect(espera(local(20, 10, 20))).toMatchObject({ rotulo: 'Esperando o Google', tom: 'atencao', motivo: 'O Google pediu para esperar. O Liame tenta de novo às 10:20; nenhuma busca se perde.' });
    expect(espera(local(21, 7)).motivo).toContain('tenta de novo amanhã, às 07:00;');
    // Outra falha não é "esperando o Google".
    expect(situacaoDoSite(site({}, { freshness: 'stale', last_error: 'falhou: 503' }), true, agora)).toMatchObject({ rotulo: 'Buscas atrasadas', tom: 'atencao' });
  });

  it('a conta primeiro (como qualquer conta), e com a função desligada a leitura fica parada', () => {
    expect(situacaoDoSite(site({ status: 'desconectada' }), true, agora)).toMatchObject({ rotulo: 'Desconectada', tom: 'perigo', precisaDeVoce: true, reconectar: true, motivo: 'O Google recusou a autorização deste site.' });
    expect(situacaoDoSite(site({ status: 'sem_permissao' }), true, agora)).toMatchObject({ rotulo: 'Sem permissão', precisaDeVoce: true });
    expect(situacaoDoSite(site({ status: 'erro' }), true, agora)).toMatchObject({ rotulo: 'Leitura falhando', precisaDeVoce: false });
    expect(situacaoDoSite(site(), false, agora)).toMatchObject({
      rotulo: 'Leitura parada',
      tom: 'espera',
      motivo: 'O Search Console não está ligado para a empresa: o Liame não lê este site agora.',
    });
    expect(situacaoDoSite(site({ status: 'desconectada' }), false, agora).rotulo).toBe('Desconectada');
  });
});

describe('a autorização do Google com o Search Console', () => {
  const SITE = descoberta('search_console', DOMINIO, 'misterburgers.com.br');
  const CARDAPIO = descoberta('search_console', ENDERECO, 'cardapio.misterburgers.com.br', { site_access: 'completo' });

  it('sem a função, nada muda', () => {
    expect(searchConsoleNaAutorizacao(conexao(), false)).toBeNull();
  });

  it('o que a autorização diz do Search Console, em cada situação do desenho', () => {
    const s = (extra: Partial<ConnectionResponse>) => searchConsoleNaAutorizacao(conexao(extra), true);
    expect(s({ scopes: [LEITURA], site_search: null })).toEqual({
      inclui: false,
      nota: { icone: 'lock', destaque: null, texto: 'Esta autorização não inclui o Search Console. As contas de anúncio são lidas normalmente.' },
      acao: null,
    });
    expect(s({ discovered: [SITE, CARDAPIO], site_search: { result: 'ok', searched_at: local(20, 9), sites: 2 } })).toEqual({
      inclui: true,
      nota: { icone: 'info', destaque: 'Esta autorização alcança 2 sites do Search Console que ainda não estão ligados.', texto: 'Ligue o site para o Liame ler os cliques e as buscas que levam a ele.' },
      acao: 'escolher',
    });
    expect(s({ discovered: [{ ...SITE, linked: true }, CARDAPIO] })?.nota?.destaque).toBe('Esta autorização alcança 1 site do Search Console que ainda não está ligado.');
    expect(s({ site_search: { result: 'ok', searched_at: local(20, 9), sites: 0 } })).toMatchObject({
      nota: { icone: 'info', destaque: 'Esta conta do Google não tem site no Search Console.' },
      acao: 'autorizar',
    });
    expect(s({ site_search: { result: 'sem_permissao', searched_at: local(20, 9), sites: 0 } })).toMatchObject({ nota: { icone: 'alert', destaque: 'O Google recusou a leitura do Search Console.' }, acao: 'autorizar' });
    // A procura que falhou não se repete sozinha: o aviso manda procurar de novo, e não oferece autorizar.
    expect(s({ site_search: { result: 'falhou', searched_at: local(20, 9), sites: 0 } })).toEqual({
      inclui: true,
      nota: { icone: 'alert', destaque: 'Não deu para procurar os sites agora.', texto: 'O Google não respondeu. As contas de anúncio não foram afetadas. Procure de novo em alguns minutos.' },
      acao: null,
    });
    expect(s({ site_search: { result: 'limite', searched_at: local(20, 9), sites: 0 } })?.nota?.texto).toBe('O Google pediu para esperar. As contas de anúncio não foram afetadas. Procure de novo em alguns minutos.');
    // Tudo ligado, ou a resposta antiga sem a procura: só "inclui a permissão", sem aviso.
    expect(s({ discovered: [{ ...SITE, linked: true }] })).toEqual({ inclui: true, nota: null, acao: null });
    expect(s({ site_search: undefined })).toEqual({ inclui: true, nota: null, acao: null });
  });

  it('o convite do topo: a função ligada, o Google conectado e nenhuma autorização com a permissão do Search Console', () => {
    const sem = conexao({ scopes: [LEITURA] });
    expect(conviteDoSearchConsole([sem], true)).toEqual({ brandId: MARCA });
    expect(conviteDoSearchConsole([sem], false)).toBeNull();
    expect(conviteDoSearchConsole([], true)).toBeNull();
    expect(conviteDoSearchConsole([sem, conexao({ id: 'nova' })], true)).toBeNull();
    expect(conviteDoSearchConsole([{ ...sem, status: 'revogada' }], true)).toBeNull();
    expect(conviteDoSearchConsole([conexao({ provider: 'meta', scopes: [] })], true)).toBeNull();
    // A permissão do perfil não é a do Search Console.
    expect(conviteDoSearchConsole([conexao({ scopes: [LEITURA, GOOGLE_BUSINESS_SCOPE] })], true)).toEqual({ brandId: MARCA });
  });

  it('contas, lojas e sites contam à parte: no cabeçalho do cartão e no diálogo de revogar', () => {
    const c = conexao({ accounts: [conta('google_ads', '1'), conta('google_ads', '2'), conta('ga4', '3'), conta('search_console', DOMINIO), conta('search_console', ENDERECO, { disconnected_at: local(15, 9) })] });
    expect(ligadasDaAutorizacao(c)).toEqual({ contas: 3, lojas: 0, sites: 1 });
    expect(contasELojas({ contas: 3, lojas: 0, sites: 1 })).toBe('3 contas e 1 site');
    expect(contasELojas({ contas: 3, lojas: 1, sites: 2 })).toBe('3 contas, 1 loja e 2 sites');
    expect(contasELojas({ contas: 0, lojas: 0, sites: 1 })).toBe('1 site');
    expect(contasELojas({ contas: 0, lojas: 0, sites: 0 })).toBe('0 contas');
    expect(oQueParaDeLer({ contas: 3, lojas: 0, sites: 1 })).toBe('das 3 contas e do site');
    expect(oQueParaDeLer({ contas: 1, lojas: 1, sites: 2 })).toBe('da conta, da loja do perfil e dos 2 sites');
    expect(oQueParaDeLer({ contas: 0, lojas: 0, sites: 1 })).toBe('do site');
  });

  it('o cartão desenhado: "3 contas e 1 site", a permissão só de leitura, o aviso e "Autorizar o Google de novo"', () => {
    const base = { agora, podeConectar: true, procurando: false, aoEscolher: null, aoReconectar: () => {}, aoAutorizar: () => {}, aoProcurar: () => {}, aoRevogar: () => {} };
    const ligada = conexao({ discovered: [{ ...SITE, linked: true }], accounts: [conta('google_ads', '1'), conta('google_ads', '2'), conta('ga4', '3'), conta('search_console', DOMINIO)] });
    const html = renderToStaticMarkup(createElement(CartaoAutorizacao, { ...base, conexao: ligada, site: searchConsoleNaAutorizacao(ligada, true) }));
    expect(html).toContain('3 contas e 1 site');
    expect(html).toContain('sem prazo de validade. Inclui a permissão do Search Console, só de leitura.');
    expect(html).not.toContain('aut-txt--atencao');
    expect(html).not.toContain('Autorizar o Google de novo');

    const semSite = conexao({ site_search: { result: 'ok', searched_at: local(20, 9), sites: 0 } });
    const r = renderToStaticMarkup(createElement(CartaoAutorizacao, { ...base, conexao: semSite, site: searchConsoleNaAutorizacao(semSite, true) }));
    expect(r).toContain('<b>Esta conta do Google não tem site no Search Console.</b> Se o site da sua empresa está no Search Console de outra conta do Google');
    expect(r).toContain('>Autorizar o Google de novo</button>');

    // As duas funções ligadas: um aviso para cada, e uma ação de autorizar só.
    const ambas = conexao({ scopes: [LEITURA, GOOGLE_BUSINESS_SCOPE, SEARCH_CONSOLE_SCOPE], profile_search: { result: 'sem_permissao', searched_at: local(20, 9), stores: 0 }, site_search: { result: 'falhou', searched_at: local(20, 9), sites: 0 } });
    const a = renderToStaticMarkup(createElement(CartaoAutorizacao, { ...base, conexao: ambas, perfil: perfilNaAutorizacao(ambas, true), site: searchConsoleNaAutorizacao(ambas, true) }));
    expect(a).toContain('Inclui a permissão do perfil da empresa. Inclui a permissão do Search Console, só de leitura.');
    expect(a).toContain('<b>O Google recusou a leitura do perfil da empresa.</b>');
    expect(a).toContain('<b>Não deu para procurar os sites agora.</b>');
    expect(a.match(/>Autorizar o Google de novo<\/button>/g)).toHaveLength(1);

    // Sem a função: o cartão de sempre.
    const semFuncao = renderToStaticMarkup(createElement(CartaoAutorizacao, { ...base, conexao: conexao({ accounts: [conta('google_ads', '1')] }), site: null }));
    expect(semFuncao).toContain('1 conta');
    expect(semFuncao).not.toContain('Search Console');
  });

  it('o diálogo de revogar diz que para a leitura das contas e do site', () => {
    const c = conexao({ accounts: [conta('google_ads', '1'), conta('ga4', '3'), conta('search_console', DOMINIO)] });
    const html = renderToStaticMarkup(createElement(DialogoRevogar, { conexao: c, reserva: { current: null }, aoRevogar: () => {}, aoFechar: () => {} }));
    expect(html).toContain('A leitura <b>das 2 contas e do site</b> desta autorização para agora. O histórico de números fica.');
  });
});

describe('conectar e escolher com o Search Console', () => {
  const marcas = [{ id: MARCA, name: 'Mister Burgers', archived_at: null, purge_after: null }];
  const dialogo = { marcas, marcaInicial: null, reserva: { current: null }, aoFechar: () => {}, aoIr: () => {} };

  it('o botão do Google vale para os três (ou os quatro), com o aviso da permissão só de leitura logo abaixo', () => {
    expect(tituloDoGoogle(false, true)).toBe('Google Ads, Google Analytics e Search Console');
    expect(tituloDoGoogle(true, true)).toBe('Google Ads, Google Analytics, Perfil da empresa e Search Console');
    expect(tituloDoGoogle(true)).toBe('Google Ads, Google Analytics e Perfil da empresa');
    expect(descricaoDoGoogle(false, [], false, true)).toBe('Uma autorização só para os três. O Liame só lê.');
    expect(descricaoDoGoogle(false, [], true, true)).toBe('Uma autorização só para os quatro. O Liame só lê.');
    expect(descricaoDoGoogle(false, [], true)).toBe('Uma autorização só para os três. O Liame só lê.');
    expect(descricaoDoGoogle(false)).toBe('Uma autorização só para os dois. Somente leitura.');

    const com = renderToStaticMarkup(createElement(DialogoConectar, { ...dialogo, comSearchConsole: true }));
    expect(com).toContain('<b>Google Ads, Google Analytics e Search Console</b>');
    expect(com).toContain('<b>O Google vai pedir uma permissão a mais: a do Search Console, só de leitura.</b> É a ferramenta do Google que mostra as buscas que levam ao site da empresa.');
    expect(com).toContain('O Liame lê os sites e as buscas, e não muda nada no Search Console.');
    const id = com.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(com).toContain(`<p class="dialogo-nota" id="${id}">`);
    // As duas funções: os dois avisos descrevem o botão.
    const ambas = renderToStaticMarkup(createElement(DialogoConectar, { ...dialogo, comPerfil: true, comSearchConsole: true }));
    const ids = ambas.match(/aria-describedby="([^"]+)"/)?.[1]?.split(' ') ?? [];
    expect(ids).toHaveLength(2);
    for (const i of ids) expect(ambas).toContain(`<p class="dialogo-nota" id="${i}">`);
    const sem = renderToStaticMarkup(createElement(DialogoConectar, dialogo));
    expect(sem).not.toContain('Search Console');
    expect(sem).not.toContain('aria-describedby');
  });

  it('a volta do Google conta os sites à parte, e o grupo deles vem por último', () => {
    const d = [
      descoberta('google_ads', '4445556667', 'Mister Burgers Google'),
      descoberta('ga4', '333444555', 'Site'),
      descoberta('search_console', ENDERECO, 'cardapio.misterburgers.com.br', { site_access: 'completo' }),
      descoberta('search_console', DOMINIO, 'misterburgers.com.br'),
    ];
    expect(resumoDaDescoberta(d)).toBe('1 do Google Ads, 1 propriedade do GA4 e 2 sites do Search Console');
    const volta = faixaDaVolta({ conexao: ID, erro: null }, conexao({ status: 'aguardando_escolha', discovered: d }), 'Mister Burgers');
    expect(volta).toMatchObject({ tipo: 'escolher', titulo: 'O Google autorizou. Encontramos 2 contas e 2 sites no Search Console.' });
    const comLoja = [...d, descoberta('google_business', 'locations/1', 'Mister Burgers — Centro')];
    expect(faixaDaVolta({ conexao: ID, erro: null }, conexao({ status: 'aguardando_escolha', discovered: comLoja }), 'Mister Burgers')?.titulo).toBe(
      'O Google autorizou. Encontramos 2 contas, 1 loja do perfil e 2 sites no Search Console.',
    );
    expect(faixaDaVolta({ conexao: ID, erro: null }, conexao({ status: 'aguardando_escolha', discovered: d.slice(2) }), 'Mister Burgers')?.titulo).toBe('O Google autorizou. Encontramos 2 sites no Search Console.');
    const grupos = gruposDaEscolha(comLoja);
    expect(grupos.map((g) => g.titulo)).toEqual(['Google Ads', 'Google Analytics (GA4)', 'Perfil da empresa no Google', 'Sites no Search Console']);
    expect(grupos[3]!.contas.map((c) => c.name)).toEqual(['cardapio.misterburgers.com.br', 'misterburgers.com.br']);
  });

  it('o botão, a linha de baixo de cada site, a nota e o aviso depois de ligar', () => {
    expect(botaoLigar(3, 0, 1)).toBe('Ligar 2 contas e 1 site');
    expect(botaoLigar(4, 1, 1)).toBe('Ligar 2 contas, 1 loja e 1 site');
    expect(botaoLigar(2, 0, 2)).toBe('Ligar 2 sites');
    expect(botaoLigar(3, 1)).toBe('Ligar 2 contas e 1 loja');
    expect(subDaEscolhaDoSite({ external_id: DOMINIO, site_access: 'dono' })).toBe('o domínio inteiro · você é dono');
    expect(subDaEscolhaDoSite({ external_id: ENDERECO, site_access: 'completo' })).toBe('um endereço · acesso completo');
    expect(subDaEscolhaDoSite({ external_id: ENDERECO, site_access: 'restrito' })).toBe('um endereço · acesso restrito');
    expect(subDaEscolhaDoSite({ external_id: ENDERECO, site_access: null })).toBe('um endereço');
    expect(subDaEscolhaDoSite({ external_id: ENDERECO })).toBe('um endereço');
    expect(notaDaPrimeiraLeitura({ contas: true, lojas: false, sites: true })).toBe(
      'Das contas de anúncio, a primeira leitura traz os últimos 90 dias. Do site, os cliques dos últimos 90 dias e as buscas das últimas 12 semanas. Leva alguns minutos.',
    );
    expect(notaDaPrimeiraLeitura({ contas: false, lojas: false, sites: true })).toBe('A primeira leitura do site traz os cliques dos últimos 90 dias e as buscas das últimas 12 semanas. Leva alguns minutos.');
    expect(notaDaPrimeiraLeitura({ contas: true, lojas: true, sites: true })).toContain('Da loja do perfil, as avaliações dos últimos 12 meses e os números do perfil; o Liame não guarda o nome nem a foto de quem avaliou. Do site,');
    expect(notaDaPrimeiraLeitura({ contas: false, lojas: true, sites: true })).toMatch(/^A primeira leitura traz, da loja do perfil, .* e, do site, os cliques/);
    expect(avisoDeLigar({ contas: 2, lojas: 0, sites: 1 }, { lojas: false, sites: true })).toBe('Contas e site ligados. A primeira leitura começou e leva alguns minutos.');
    expect(avisoDeLigar({ contas: 0, lojas: 0, sites: 1 }, { lojas: false, sites: true })).toBe('Site ligado. A primeira leitura começou e leva alguns minutos.');
    expect(avisoDeLigar({ contas: 0, lojas: 0, sites: 2 }, { lojas: false, sites: true })).toBe('Sites ligados. A primeira leitura começou e leva alguns minutos.');
    expect(avisoDeLigar({ contas: 2, lojas: 0, sites: 0 }, { lojas: false, sites: true })).toBe('Contas ligadas. Os sites do Search Console seguem sem ligar.');
    expect(avisoDeLigar({ contas: 1, lojas: 1, sites: 1 }, { lojas: true, sites: true })).toBe('Conta, loja e site ligados. A primeira leitura começou e leva alguns minutos.');
    expect(avisoDeLigar({ contas: 1, lojas: 1, sites: 0 }, { lojas: true, sites: true })).toBe(
      'Conta e loja ligadas. A primeira leitura começou e leva alguns minutos. Os sites do Search Console seguem sem ligar.',
    );
    expect(avisoDeLigar({ contas: 2, lojas: 0, sites: 0 }, { lojas: true, sites: true })).toBe('Contas ligadas. As lojas do perfil e os sites do Search Console seguem sem ligar.');
  });

  it('o diálogo de escolher desenhado: o grupo dos sites com o tipo e o acesso, e a nota da primeira leitura deles', () => {
    const base = { existentes: [], marca: 'Mister Burgers', reserva: { current: null }, aoLigar: () => {}, aoFechar: () => {} };
    const d = [
      descoberta('google_ads', '4445556667', 'Mister Burgers Google'),
      descoberta('search_console', DOMINIO, 'misterburgers.com.br'),
      descoberta('search_console', ENDERECO, 'cardapio.misterburgers.com.br', { site_access: 'completo' }),
    ];
    const html = renderToStaticMarkup(createElement(DialogoEscolher, { ...base, conexao: conexao({ status: 'aguardando_escolha', discovered: d }) }));
    expect(html).toContain('<legend>Sites no Search Console</legend>');
    expect(html).toContain('<span class="escolha-sub">o domínio inteiro · você é dono</span>');
    expect(html).toContain('<span class="escolha-sub">um endereço · acesso completo</span>');
    expect(html).not.toContain('sc-domain:');
    expect(html).toContain('Do site, os cliques dos últimos 90 dias e as buscas das últimas 12 semanas.');
    expect(html).toContain('Escolha ao menos uma');
    // Um site só: já vem marcado, e o botão diz "site".
    const um = renderToStaticMarkup(createElement(DialogoEscolher, { ...base, conexao: conexao({ status: 'aguardando_escolha', discovered: [d[1]!] }) }));
    expect(um).toContain('Ligar 1 site');
    expect(um).toContain('A primeira leitura do site traz os cliques dos últimos 90 dias');
    expect(`${html}${um}`).not.toMatch(/NaN|undefined|\[object Object\]/);
  });
});
