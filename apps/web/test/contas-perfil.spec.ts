import { type AccountFreshness, type ConnectedAccountResponse, type ConnectionResponse, type DiscoveredAccount, GOOGLE_BUSINESS_SCOPE } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CartaoAutorizacao } from '@/components/contas/cartao-autorizacao';
import { DialogoConectar } from '@/components/contas/dialogo-conectar';
import { DialogoEscolher } from '@/components/contas/dialogo-escolher';
import { DialogoRevogar } from '@/components/contas/dialogo-revogar';
import {
  AVISO_LOJA_DESLIGADA,
  avisoDeLigarComLoja,
  contasELojas,
  conviteDoPerfil,
  ligadasDaAutorizacao,
  notaDaEscolhaComLoja,
  oQueParaDeLer,
  perfilNaAutorizacao,
  siteDaLoja,
  situacaoDaLojaDoPerfil,
} from '@/components/contas/perfil-google';
import {
  autorizadorDa,
  botaoLigar,
  descricaoDoGoogle,
  faixaDaVolta,
  gruposDaEscolha,
  plataforma,
  resumoDaDescoberta,
  tituloDoGoogle,
} from '@/components/contas/textos';

// A loja do Perfil da Empresa no Google em "Contas conectadas" (P17, parte B; mockups/prototipo-contas-perfil.html).
// Datas no fuso local, nunca o relógio real (V113): rodar com TZ=UTC também.

const agora = new Date(2026, 9, 14, 10, 30, 0); // 14/10/2026 10:30
const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const ID = '01a0e1a1-ea5a-7822-a16c-376c2c942655';
const MARCA = '01a0e1a1-ea64-71ed-8775-f13002fd25f0';
const LEITURA = 'https://www.googleapis.com/auth/adwords';

const descoberta = (provider: string, external_id: string, name: string, extra: Partial<DiscoveredAccount> = {}): DiscoveredAccount => ({
  provider,
  external_id,
  name,
  currency: provider === 'google_business' ? null : 'BRL',
  timezone: provider === 'google_business' ? null : 'America/Sao_Paulo',
  linked: false,
  via: null,
  ...(provider === 'google_business' ? { site: null } : {}),
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
  connected_at: local(11, 9),
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
  created_at: local(11, 9),
  completed_at: local(11, 9, 1),
  refresh_expires_at: null,
  scopes: [LEITURA, GOOGLE_BUSINESS_SCOPE],
  discovered: [],
  accounts: [],
  profile_search: { result: 'ok', searched_at: local(11, 9, 1), stores: 1 },
  ...extra,
});
const loja = (extra: Partial<AccountFreshness> = {}, conjunto: Partial<AccountFreshness['datasets'][number]> = {}): AccountFreshness => ({
  connected_account_id: 'loja-1',
  brand_id: MARCA,
  provider: 'google_business',
  name: 'Mister Burgers — Centro',
  status: 'ativa',
  status_reason: null,
  datasets: [
    { dataset: 'avaliacoes_perfil', freshness: 'fresh', last_success_at: local(14, 10, 5), last_attempt_at: local(14, 10, 5), last_error: null, next_at: local(14, 11, 5), ...conjunto },
    { dataset: 'numeros_perfil', freshness: 'fresh', last_success_at: local(14, 7), last_attempt_at: local(14, 7), last_error: null, next_at: local(15, 7) },
  ],
  ...extra,
});

describe('a loja do perfil na lista de contas', () => {
  it('a etiqueta "Perfil no Google", sem o código, e quem autoriza é o Google', () => {
    expect(plataforma('google_business')).toEqual({ nome: 'Perfil no Google', classe: 'perfil' });
    expect(autorizadorDa('google_business')).toBe('google');
  });

  it('a situação pela leitura das avaliações: em dia, primeira leitura, esperando o Google, atrasada', () => {
    expect(situacaoDaLojaDoPerfil(loja(), true, agora)).toMatchObject({ rotulo: 'Avaliações em dia', tom: 'ok', motivo: null, ultimaLeituraEm: local(14, 10, 5) });
    expect(situacaoDaLojaDoPerfil(loja({}, { freshness: 'unknown', last_success_at: null }), true, agora)).toMatchObject({
      rotulo: 'Primeira leitura',
      tom: 'lendo',
      motivo: 'Trazendo as avaliações dos últimos 12 meses e os números do perfil. Leva alguns minutos.',
    });
    // A conta que ainda não tem nenhum conjunto (o frescor manda "metricas" desconhecido) também é primeira leitura.
    expect(situacaoDaLojaDoPerfil(loja({ datasets: [{ dataset: 'metricas', freshness: 'unknown', last_success_at: null, last_attempt_at: null, last_error: null, next_at: null }] }), true, agora).rotulo).toBe('Primeira leitura');
    // O Google pediu para esperar: quando o Liame tenta de novo, no mesmo dia, amanhã ou depois.
    const espera = (next_at: string) => situacaoDaLojaDoPerfil(loja({}, { last_error: 'limite: o Google pediu para esperar', next_at }), true, agora);
    expect(espera(local(14, 11, 5))).toMatchObject({ rotulo: 'Esperando o Google', tom: 'atencao', motivo: 'O Google pediu para esperar. O Liame tenta de novo às 11:05; nenhuma avaliação se perde.' });
    expect(espera(local(15, 7)).motivo).toContain('tenta de novo amanhã, às 07:00;');
    expect(espera(local(16, 7)).motivo).toContain('tenta de novo em 16/10, às 07:00;');
    // Outra falha não é "esperando o Google".
    expect(situacaoDaLojaDoPerfil(loja({}, { freshness: 'stale', last_error: 'falhou: 503' }), true, agora)).toMatchObject({ rotulo: 'Avaliações atrasadas', tom: 'atencao' });
  });

  it('a conta primeiro (como qualquer conta), e com a função desligada a leitura fica parada', () => {
    expect(situacaoDaLojaDoPerfil(loja({ status: 'desconectada' }), true, agora)).toMatchObject({ rotulo: 'Desconectada', tom: 'perigo', precisaDeVoce: true, reconectar: true, motivo: 'O Google recusou a autorização desta loja.' });
    expect(situacaoDaLojaDoPerfil(loja({ status: 'sem_permissao', status_reason: 'Sem acesso a esta loja.' }), true, agora)).toMatchObject({ rotulo: 'Sem permissão', motivo: 'Sem acesso a esta loja.' });
    expect(situacaoDaLojaDoPerfil(loja({ status: 'erro' }), true, agora)).toMatchObject({ rotulo: 'Leitura falhando', precisaDeVoce: false });
    expect(situacaoDaLojaDoPerfil(loja(), false, agora)).toMatchObject({
      rotulo: 'Leitura parada',
      tom: 'espera',
      motivo: 'O perfil da empresa no Google não está ligado para a empresa: o Liame não lê esta loja agora.',
    });
    // Desconectada vale mesmo com a função desligada: o que a pessoa precisa fazer vem antes.
    expect(situacaoDaLojaDoPerfil(loja({ status: 'desconectada' }), false, agora).rotulo).toBe('Desconectada');
    expect(AVISO_LOJA_DESLIGADA).toBe('Loja desligada. As avaliações já lidas ficam guardadas por até 12 meses; para voltar a ler, ligue a loja de novo.');
  });
});

describe('a autorização do Google com o perfil', () => {
  const LOJA = descoberta('google_business', 'locations/1', 'Mister Burgers — Centro', { site: 'https://misterburgers.com.br/' });
  const OUTRA = descoberta('google_business', 'locations/2', 'Mister Burgers — Praia');

  it('sem a função, nada muda', () => {
    expect(perfilNaAutorizacao(conexao(), false)).toBeNull();
  });

  it('o que a autorização diz do perfil, em cada situação do desenho', () => {
    const p = (extra: Partial<ConnectionResponse>) => perfilNaAutorizacao(conexao(extra), true);
    expect(p({ scopes: [LEITURA], profile_search: null })).toEqual({
      inclui: false,
      nota: { icone: 'lock', destaque: null, texto: 'Esta autorização não inclui o perfil da empresa no Google. As contas de anúncio são lidas normalmente.' },
      acao: null,
    });
    expect(p({ discovered: [LOJA, OUTRA], profile_search: { result: 'ok', searched_at: local(14, 9), stores: 2 } })).toMatchObject({
      inclui: true,
      nota: { icone: 'info', destaque: 'Esta autorização alcança 2 lojas do perfil da empresa que ainda não estão ligadas.', texto: 'Ligue a loja para o Liame ler as avaliações e os números do perfil.' },
      acao: 'escolher',
    });
    expect(p({ discovered: [{ ...LOJA, linked: true }, OUTRA] })?.nota?.destaque).toBe('Esta autorização alcança 1 loja do perfil da empresa que ainda não está ligada.');
    expect(p({ profile_search: { result: 'limite', searched_at: local(14, 9), stores: 0 } })).toMatchObject({ nota: { icone: 'clock', destaque: 'O Google ainda não liberou o acesso do Liame ao perfil da empresa.' }, acao: null });
    expect(p({ profile_search: { result: 'sem_permissao', searched_at: local(14, 9), stores: 0 } })).toMatchObject({ nota: { destaque: 'O Google recusou a leitura do perfil da empresa.' }, acao: 'autorizar' });
    expect(p({ profile_search: { result: 'falhou', searched_at: local(14, 9), stores: 0 } })).toMatchObject({ nota: { destaque: 'Não deu para procurar as lojas do perfil agora.' }, acao: null });
    expect(p({ profile_search: { result: 'ok', searched_at: local(14, 9), stores: 0 } })).toMatchObject({ nota: { destaque: 'Esta conta do Google não tem perfil de empresa.' }, acao: 'autorizar' });
    // Tudo ligado: só "inclui a permissão", sem aviso.
    expect(p({ discovered: [{ ...LOJA, linked: true }] })).toEqual({ inclui: true, nota: null, acao: null });
    // A resposta antiga, sem a procura: sem aviso.
    expect(p({ profile_search: undefined })).toEqual({ inclui: true, nota: null, acao: null });
  });

  it('o convite do topo: a função ligada, o Google conectado e nenhuma autorização com a permissão do perfil', () => {
    const sem = conexao({ scopes: [LEITURA] });
    expect(conviteDoPerfil([sem], true)).toEqual({ brandId: MARCA });
    expect(conviteDoPerfil([sem], false)).toBeNull();
    expect(conviteDoPerfil([], true)).toBeNull();
    expect(conviteDoPerfil([sem, conexao({ id: 'nova' })], true)).toBeNull();
    // Só valem as autorizações que estão valendo; a da Meta não conta.
    expect(conviteDoPerfil([{ ...sem, status: 'revogada' }], true)).toBeNull();
    expect(conviteDoPerfil([conexao({ provider: 'meta', scopes: [] })], true)).toBeNull();
    // A marca é a da autorização mais nova.
    expect(conviteDoPerfil([sem, { ...sem, brand_id: 'outra-marca', created_at: local(13, 9) }], true)).toEqual({ brandId: 'outra-marca' });
  });

  it('contas e lojas contam à parte: no cabeçalho do cartão e no diálogo de revogar', () => {
    const c = conexao({ accounts: [conta('google_ads', '1'), conta('google_ads', '2'), conta('ga4', '3'), conta('google_business', 'locations/1'), conta('google_ads', '9', { disconnected_at: local(12, 9) })] });
    expect(ligadasDaAutorizacao(c)).toEqual({ contas: 3, lojas: 1, sites: 0 });
    expect(contasELojas({ contas: 3, lojas: 1 })).toBe('3 contas e 1 loja');
    expect(contasELojas({ contas: 1, lojas: 2 })).toBe('1 conta e 2 lojas');
    expect(contasELojas({ contas: 0, lojas: 1 })).toBe('1 loja');
    expect(contasELojas({ contas: 2, lojas: 0 })).toBe('2 contas');
    expect(oQueParaDeLer({ contas: 3, lojas: 1 })).toBe('das 3 contas e da loja do perfil');
    expect(oQueParaDeLer({ contas: 1, lojas: 2 })).toBe('da conta e das 2 lojas do perfil');
    expect(oQueParaDeLer({ contas: 0, lojas: 1 })).toBe('da loja do perfil');
  });

  it('o cartão desenhado: "3 contas e 1 loja", a permissão do perfil, o aviso e "Autorizar o Google de novo"', () => {
    const base = { agora, podeConectar: true, procurando: false, aoEscolher: null, aoReconectar: () => {}, aoAutorizar: () => {}, aoProcurar: () => {}, aoRevogar: () => {} };
    const ligada = conexao({ discovered: [{ ...LOJA, linked: true }], accounts: [conta('google_ads', '1'), conta('google_ads', '2'), conta('ga4', '3'), conta('google_business', 'locations/1')] });
    const html = renderToStaticMarkup(createElement(CartaoAutorizacao, { ...base, conexao: ligada, perfil: perfilNaAutorizacao(ligada, true) }));
    expect(html).toContain('<b>Autorizada por Rodrigo</b>');
    expect(html).toContain('3 contas e 1 loja');
    expect(html).toContain('sem prazo de validade. Inclui a permissão do perfil da empresa.');
    expect(html).not.toContain('aut-txt--atencao');
    expect(html).not.toContain('Autorizar o Google de novo');

    const recusou = conexao({ profile_search: { result: 'sem_permissao', searched_at: local(14, 9), stores: 0 } });
    const r = renderToStaticMarkup(createElement(CartaoAutorizacao, { ...base, conexao: recusou, perfil: perfilNaAutorizacao(recusou, true) }));
    expect(r).toContain('<b>O Google recusou a leitura do perfil da empresa.</b> A conta do Google que autorizou precisa ter acesso ao perfil.');
    expect(r).toContain('>Autorizar o Google de novo</button>');
    expect(r).toContain('aria-label="Autorizar o Google de novo: autorização do Google de 11/10/2026"');

    // Sem a função: o cartão de sempre (as contas contam como antes, e nada do perfil).
    const semFuncao = renderToStaticMarkup(createElement(CartaoAutorizacao, { ...base, conexao: conexao({ accounts: [conta('google_ads', '1')] }), perfil: null }));
    expect(semFuncao).toContain('1 conta');
    expect(semFuncao).not.toContain('perfil');
  });

  it('o diálogo de revogar diz que para a leitura das contas e da loja', () => {
    const c = conexao({ accounts: [conta('google_ads', '1'), conta('ga4', '3'), conta('google_business', 'locations/1')] });
    const html = renderToStaticMarkup(createElement(DialogoRevogar, { conexao: c, reserva: { current: null }, aoRevogar: () => {}, aoFechar: () => {} }));
    expect(html).toContain('A leitura <b>das 2 contas e da loja do perfil</b> desta autorização para agora. O histórico de números fica.');
    const semLoja = renderToStaticMarkup(createElement(DialogoRevogar, { conexao: conexao({ accounts: [conta('google_ads', '1')] }), reserva: { current: null }, aoRevogar: () => {}, aoFechar: () => {} }));
    expect(semLoja).toContain('A leitura da <b>conta</b> desta autorização para agora.');
  });
});

describe('conectar e escolher com o perfil', () => {
  const marcas = [{ id: MARCA, name: 'Mister Burgers', archived_at: null, purge_after: null }];
  const dialogo = { marcas, marcaInicial: null, reserva: { current: null }, aoFechar: () => {}, aoIr: () => {} };

  it('o botão do Google vale para os três, com o aviso da permissão a mais logo abaixo', () => {
    expect(tituloDoGoogle(true)).toBe('Google Ads, Google Analytics e Perfil da empresa');
    expect(tituloDoGoogle(false)).toBe('Google Ads e Google Analytics');
    expect(descricaoDoGoogle(false, [], true)).toBe('Uma autorização só para os três. O Liame só lê.');
    expect(descricaoDoGoogle(true, [], true)).toBe('Uma autorização só para os três. Leitura, e a permissão de informar as vendas confirmadas.');
    expect(descricaoDoGoogle(false)).toBe('Uma autorização só para os dois. Somente leitura.');

    const com = renderToStaticMarkup(createElement(DialogoConectar, { ...dialogo, comPerfil: true }));
    expect(com).toContain('<b>Google Ads, Google Analytics e Perfil da empresa</b>');
    expect(com).toContain('<b>O Google vai pedir uma permissão a mais: a do perfil da empresa,</b> o que aparece na busca e no Maps, com as avaliações.');
    expect(com).toContain('O Liame lê as lojas, as avaliações e os números do perfil, e não muda horário, endereço nem cardápio.');
    // O aviso descreve o botão do Google para quem usa leitor de tela.
    const id = com.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(id).toBeTruthy();
    expect(com).toContain(`<p class="dialogo-nota" id="${id}">`);
    const sem = renderToStaticMarkup(createElement(DialogoConectar, dialogo));
    expect(sem).not.toContain('perfil da empresa');
    expect(sem).not.toContain('aria-describedby');
  });

  it('a volta do Google conta as lojas à parte, e o grupo delas vem por último', () => {
    const d = [descoberta('google_ads', '4445556667', 'Mister Burgers Google'), descoberta('ga4', '333444555', 'Site'), descoberta('google_business', 'locations/2', 'Mister Burgers — Praia'), descoberta('google_business', 'locations/1', 'Mister Burgers — Centro')];
    expect(resumoDaDescoberta(d)).toBe('1 do Google Ads, 1 propriedade do GA4 e 2 lojas do perfil da empresa');
    const volta = faixaDaVolta({ conexao: ID, erro: null }, conexao({ status: 'aguardando_escolha', discovered: d }), 'Mister Burgers');
    expect(volta).toMatchObject({ tipo: 'escolher', titulo: 'O Google autorizou. Encontramos 2 contas e 2 lojas do perfil.' });
    expect(faixaDaVolta({ conexao: ID, erro: null }, conexao({ status: 'aguardando_escolha', discovered: d.slice(2) }), 'Mister Burgers')?.titulo).toBe('O Google autorizou. Encontramos 2 lojas do perfil.');
    expect(faixaDaVolta({ conexao: ID, erro: null }, conexao({ status: 'aguardando_escolha', discovered: d.slice(0, 2) }), 'Mister Burgers')?.titulo).toBe('O Google autorizou. Encontramos 2 contas.');
    const grupos = gruposDaEscolha(d);
    expect(grupos.map((g) => g.titulo)).toEqual(['Google Ads', 'Google Analytics (GA4)', 'Perfil da empresa no Google']);
    expect(grupos[2]!.contas.map((c) => c.name)).toEqual(['Mister Burgers — Centro', 'Mister Burgers — Praia']);
  });

  it('o botão, o site, a nota e o aviso depois de ligar', () => {
    expect(botaoLigar(3, 1)).toBe('Ligar 2 contas e 1 loja');
    expect(botaoLigar(1, 1)).toBe('Ligar 1 loja');
    expect(botaoLigar(2, 0)).toBe('Ligar 2 contas');
    expect(botaoLigar(0, 0)).toBe('Escolha ao menos uma');
    expect(siteDaLoja('https://misterburgers.com.br/')).toBe('misterburgers.com.br');
    expect(siteDaLoja('http://www.casa.com.br/loja')).toBe('www.casa.com.br/loja');
    expect(siteDaLoja(null)).toBe('sem site no perfil');
    expect(siteDaLoja(undefined)).toBe('sem site no perfil');
    expect(notaDaEscolhaComLoja(true)).toBe(
      'Das contas de anúncio, a primeira leitura traz os últimos 90 dias. Da loja do perfil, as avaliações dos últimos 12 meses e os números do perfil; o Liame não guarda o nome nem a foto de quem avaliou. Leva alguns minutos.',
    );
    expect(notaDaEscolhaComLoja(false)).toContain('A primeira leitura da loja do perfil traz as avaliações dos últimos 12 meses');
    expect(avisoDeLigarComLoja(2, 1)).toBe('Contas e loja ligadas. A primeira leitura começou e leva alguns minutos.');
    expect(avisoDeLigarComLoja(1, 2)).toBe('Conta e lojas ligadas. A primeira leitura começou e leva alguns minutos.');
    expect(avisoDeLigarComLoja(0, 1)).toBe('Loja ligada. A primeira leitura começou e leva alguns minutos.');
    expect(avisoDeLigarComLoja(2, 0)).toBe('Contas ligadas. As lojas do perfil seguem sem ligar.');
  });

  it('o diálogo de escolher desenhado: o grupo das lojas com o site e a nota da primeira leitura delas', () => {
    const base = { existentes: [], marca: 'Mister Burgers', reserva: { current: null }, aoLigar: () => {}, aoFechar: () => {} };
    const d = [
      descoberta('google_ads', '4445556667', 'Mister Burgers Google'),
      descoberta('google_business', 'locations/1', 'Mister Burgers — Centro', { site: 'https://misterburgers.com.br' }),
      descoberta('google_business', 'locations/2', 'Mister Burgers — Praia'),
    ];
    const html = renderToStaticMarkup(createElement(DialogoEscolher, { ...base, conexao: conexao({ status: 'aguardando_escolha', discovered: d }) }));
    expect(html).toContain('<legend>Perfil da empresa no Google</legend>');
    expect(html).toContain('<span class="escolha-sub">misterburgers.com.br</span>');
    expect(html).toContain('<span class="escolha-sub">sem site no perfil</span>');
    expect(html).not.toContain('locations/');
    expect(html).toContain('Da loja do perfil, as avaliações dos últimos 12 meses e os números do perfil');
    // Várias novas: a pessoa escolhe (nada ligado sem querer).
    expect(html).toContain('Escolha ao menos uma');
    // Uma loja só: já vem marcada, e o botão diz "loja".
    const uma = renderToStaticMarkup(createElement(DialogoEscolher, { ...base, conexao: conexao({ status: 'aguardando_escolha', discovered: [d[1]!] }) }));
    expect(uma).toContain('Ligar 1 loja');
    expect(uma).toContain('A primeira leitura da loja do perfil traz as avaliações dos últimos 12 meses');
    // Sem loja, a nota de sempre.
    const semLoja = renderToStaticMarkup(createElement(DialogoEscolher, { ...base, conexao: conexao({ status: 'aguardando_escolha', discovered: [d[0]!] }) }));
    expect(semLoja).toContain('A primeira leitura traz os últimos 90 dias e leva alguns minutos.');
    expect(`${html}${uma}${semLoja}`).not.toMatch(/NaN|undefined|\[object Object\]/);
  });
});
