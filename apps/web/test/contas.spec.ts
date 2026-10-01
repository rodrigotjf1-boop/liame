import type { AccountFreshness, ConnectedAccountResponse, ConnectionResponse, DiscoveredAccount } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CartaoAutorizacaoRegem } from '@/components/contas/cartao-autorizacao-regem';
import {
  autorizacoesVisiveis,
  botaoLigar,
  escolhiveis,
  escoposDoRegem,
  faixaDaVolta,
  faixaDoRegem,
  gruposDaEscolha,
  idDaConta,
  lerVolta,
  plataforma,
  quemAutorizou,
  regemRevogado,
  resumoDaDescoberta,
  situacaoDaConta,
  situacaoDaLoja,
  subDaLoja,
  ultimaLeitura,
  vencimentoDaAutorizacao,
} from '@/components/contas/textos';

// Regras puras de "Contas conectadas": volta do OAuth, frescor, descobertas e autorizações.
// Datas fixas no fuso local, nunca o relógio real (LIC-006, ERR-023).

const agora = new Date(2026, 8, 27, 9, 30, 0); // 27/09/2026 09:30
const local = (d: number, h: number, m = 0) => new Date(2026, 8, d, h, m).toISOString();
const ID = '01a0e1a1-ea5a-7822-a16c-376c2c942655';
const params = (q: string) => new URLSearchParams(q);

const descoberta = (provider: string, external_id: string, name: string, linked = false): DiscoveredAccount => ({
  provider,
  external_id,
  name,
  currency: 'BRL',
  timezone: 'America/Sao_Paulo',
  linked,
  via: null,
});

const conexao = (extra: Partial<ConnectionResponse> = {}): ConnectionResponse => ({
  id: ID,
  brand_id: '01a0e1a1-ea64-71ed-8775-f13002fd25f0',
  provider: 'google',
  origin: 'oauth',
  status: 'aguardando_escolha',
  error_code: null,
  authorized_by: null,
  created_at: local(27, 9, 0),
  completed_at: null,
  refresh_expires_at: null,
  scopes: [],
  discovered: [],
  accounts: [],
  ...extra,
});

describe('volta da autorização', () => {
  it('lê a conexão e o erro da URL; id fora do formato e erro desconhecido não passam como estão', () => {
    expect(lerVolta(params(`conexao=${ID}`))).toEqual({ conexao: ID, erro: null });
    expect(lerVolta(params(`conexao=${ID.toUpperCase()}&erro=recusada_na_plataforma`))).toEqual({ conexao: ID, erro: 'recusada_na_plataforma' });
    expect(lerVolta(params('erro=autorizacao_expirada'))).toEqual({ conexao: null, erro: 'autorizacao_expirada' });
    expect(lerVolta(params('conexao=../../v1/me&erro=<script>'))).toEqual({ conexao: null, erro: 'outro' });
    expect(lerVolta(params(''))).toEqual({ conexao: null, erro: null });
  });

  it('faixa de cada situação, com o artigo certo da plataforma', () => {
    const volta = { conexao: ID, erro: null };
    const d = [descoberta('google_ads', '4445556667', 'Casa Brasa Google', true), descoberta('google_ads', '5556667778', 'Loja 2'), descoberta('ga4', '333444555', 'Site'), descoberta('ga4', '999888777', 'Cardápio')];
    expect(faixaDaVolta(volta, conexao({ discovered: d }), 'Casa Brasa')).toEqual({
      tipo: 'escolher',
      titulo: 'O Google autorizou. Encontramos 4 contas.',
      texto: '2 do Google Ads e 2 propriedades do GA4. Escolha quais ligar à marca Casa Brasa.',
    });
    expect(faixaDaVolta(volta, conexao({ provider: 'meta', status: 'recebida' }), 'Casa Brasa')?.titulo).toBe('Conferindo a autorização com a Meta…');
    expect(faixaDaVolta(volta, conexao({ provider: 'meta', status: 'processando' }), 'X', { esgotou: true })?.tipo).toBe('demorando');
    expect(faixaDaVolta({ conexao: ID, erro: 'recusada_na_plataforma' }, conexao({ provider: 'meta', status: 'erro' }), 'X')).toMatchObject({
      tipo: 'erro',
      titulo: 'A Meta não autorizou a conexão.',
    });
    expect(faixaDaVolta({ conexao: null, erro: 'autorizacao_expirada' }, null, 'X')?.titulo).toBe('A autorização demorou demais.');
    expect(faixaDaVolta(volta, conexao({ status: 'erro', error_code: 'sem_permissao' }), 'X')?.titulo).toBe('Faltou permissão no Google.');
    expect(faixaDaVolta(volta, conexao({ status: 'expirada' }), 'X')?.tipo).toBe('erro');
    // Tudo já ligado e nada para reconectar: sem faixa.
    expect(faixaDaVolta(volta, conexao({ status: 'ativa', discovered: [d[0]!] }), 'X')).toBeNull();
    expect(faixaDaVolta(volta, null, 'X')).toBeNull();
  });

  it('reconectar: a conta desconectada por outra autorização volta a ser escolhível; as outras ligadas não', () => {
    const d = [descoberta('meta_ads', 'act_2233445566', 'Loja 2', true), descoberta('meta_ads', 'act_1234567890', 'Casa Brasa', true)];
    const existentes = [
      { provider: 'meta_ads', external_id: 'act_2233445566', status: 'desconectada', connection_id: 'outra', disconnected_at: null },
      { provider: 'meta_ads', external_id: 'act_1234567890', status: 'ativa', connection_id: 'outra', disconnected_at: null },
    ];
    expect(escolhiveis(conexao({ provider: 'meta', discovered: d }), existentes)).toEqual([{ conta: d[0], reconectar: true }]);
    expect(faixaDaVolta({ conexao: ID, erro: null }, conexao({ provider: 'meta', discovered: d }), 'Casa Brasa', { existentes })?.tipo).toBe('escolher');
    // A conta já é desta autorização: nada a reconectar.
    expect(escolhiveis(conexao({ discovered: d }), [{ ...existentes[0]!, connection_id: ID }])).toEqual([]);
  });

  it('descobertas agrupadas na ordem Meta, Google Ads, GA4, e o botão de ligar', () => {
    const grupos = gruposDaEscolha([descoberta('ga4', '1', 'Site'), descoberta('google_ads', '2', 'B'), descoberta('google_ads', '3', 'A'), descoberta('meta_ads', 'act_4', 'M')]);
    expect(grupos.map((g) => [g.titulo, g.contas.map((c) => c.name)])).toEqual([
      ['Meta Ads', ['M']],
      ['Google Ads', ['A', 'B']],
      ['Google Analytics (GA4)', ['Site']],
    ]);
    expect(resumoDaDescoberta([descoberta('meta_ads', 'act_1', 'a')])).toBe('1 conta de anúncio da Meta');
    expect(resumoDaDescoberta([descoberta('meta_ads', 'act_1', 'a'), descoberta('meta_ads', 'act_2', 'b'), descoberta('ga4', '3', 'c')])).toBe(
      '2 contas de anúncio da Meta e 1 propriedade do GA4',
    );
    expect(botaoLigar(0)).toBe('Escolha ao menos uma');
    expect(botaoLigar(1)).toBe('Ligar 1 conta');
    expect(botaoLigar(2)).toBe('Ligar 2 contas');
  });
});

describe('contas ligadas', () => {
  const conta = (extra: Partial<AccountFreshness>, freshness = 'fresh', ultima: string | null = local(27, 6, 12)): AccountFreshness => ({
    connected_account_id: ID,
    brand_id: ID,
    provider: 'meta_ads',
    name: 'Casa Brasa',
    status: 'ativa',
    status_reason: null,
    datasets: [{ dataset: 'metricas', freshness, last_success_at: ultima, last_attempt_at: ultima, last_error: null, next_at: null }],
    ...extra,
  });

  it('situação: status da conta primeiro, depois o frescor', () => {
    expect(situacaoDaConta(conta({}))).toMatchObject({ rotulo: 'Em dia', tom: 'ok', precisaDeVoce: false });
    expect(situacaoDaConta(conta({}, 'delayed'))).toMatchObject({ rotulo: 'Atrasado', tom: 'atencao', precisaDeVoce: false });
    expect(situacaoDaConta(conta({}, 'stale')).rotulo).toBe('Atrasado');
    expect(situacaoDaConta(conta({ status: 'desconectada', status_reason: 'A Meta recusou a autorização.' }))).toMatchObject({
      rotulo: 'Desconectada',
      motivo: 'A Meta recusou a autorização.',
      precisaDeVoce: true,
      reconectar: true,
    });
    expect(situacaoDaConta(conta({ status: 'sem_permissao' }, 'unknown', null))).toMatchObject({ rotulo: 'Sem permissão', precisaDeVoce: true, reconectar: false });
    expect(situacaoDaConta(conta({ status: 'erro' })).precisaDeVoce).toBe(false);
    expect(situacaoDaConta(conta({ datasets: [] })).rotulo).toBe('Primeira leitura');
  });

  it('última leitura como no protótipo', () => {
    expect(ultimaLeitura(local(27, 6, 12), agora)).toBe('hoje, 06:12');
    expect(ultimaLeitura(local(26, 6, 20), agora)).toBe('ontem, 06:20');
    expect(ultimaLeitura(local(25, 6, 14), agora)).toBe('há 2 dias');
    expect(ultimaLeitura(new Date(2026, 7, 1, 10).toISOString(), agora)).toBe('01/08');
    expect(ultimaLeitura(null, agora)).toBe('nunca');
  });

  it('id como a plataforma mostra', () => {
    expect(idDaConta('google_ads', '4445556667')).toBe('444-555-6667');
    expect(idDaConta('meta_ads', 'act_1234567890')).toBe('act_1234567890');
    expect(idDaConta('ga4', '333444555')).toBe('333444555');
  });
});

describe('autorizações', () => {
  it('lista as que valem e as que falharam depois de valer; tentativa que não chegou a valer fica de fora', () => {
    const conta = { id: ID, brand_id: ID, connection_id: ID, provider: 'meta_ads', external_id: 'act_1', name: 'a', currency: null, timezone: null, status: 'ativa', status_reason: null, unit_id: null, unit_name: null, scopes: [], connected_at: local(20, 8), disconnected_at: null };
    const lista = [
      conexao({ id: 'a', status: 'ativa' }),
      conexao({ id: 'b', status: 'aguardando_escolha' }),
      conexao({ id: 'c', status: 'recebida' }),
      conexao({ id: 'd', status: 'recebida', completed_at: local(20, 8) }),
      conexao({ id: 'e', status: 'erro', accounts: [conta] }),
      conexao({ id: 'f', status: 'erro' }),
      conexao({ id: 'g', status: 'revogada', completed_at: local(20, 8) }),
    ];
    expect(autorizacoesVisiveis(lista).map((c) => c.id)).toEqual(['a', 'b', 'd', 'e']);
  });

  it('Google em modo de teste: quando vence', () => {
    expect(vencimentoDaAutorizacao({ refresh_expires_at: null }, agora)).toBeNull();
    const vence = new Date(2026, 8, 29, 10, 40).toISOString();
    expect(vencimentoDaAutorizacao({ refresh_expires_at: vence }, agora)).toEqual({
      venceu: false,
      texto: 'Vence em 29/09/2026 (app do Google em fase de teste). Conecte de novo antes para a leitura não parar.',
    });
    expect(vencimentoDaAutorizacao({ refresh_expires_at: local(26, 10) }, agora)?.venceu).toBe(true);
  });
});

describe('quem autorizou', () => {
  it('primeiro nome, como no cartão do protótipo; sem nome (pessoa sem vínculo visível), nada', () => {
    expect(quemAutorizou({ authorized_by: 'Rodrigo de Oliveira' })).toBe('Rodrigo');
    expect(quemAutorizou({ authorized_by: '  Ana  ' })).toBe('Ana');
    expect(quemAutorizou({ authorized_by: null })).toBeNull();
    expect(quemAutorizou({ authorized_by: '   ' })).toBeNull();
  });
});

// Lojas do Regem (protótipo P2, aprovado em 29/09/2026): a leitura dos pedidos, o que a loja libera e a autorização.
describe('lojas do Regem', () => {
  const COMPLETO = ['pedidos.ler', 'custos.ler', 'clientes.anonimizacao.ler', 'cupons.ler', 'cupons.uso.ler'];
  const SEM_CUSTO = COMPLETO.filter((e) => e !== 'custos.ler');
  const loja = (extra: Partial<AccountFreshness> = {}, pedidosEm: string | null = local(27, 9, 20)): AccountFreshness => ({
    connected_account_id: ID,
    brand_id: ID,
    provider: 'regem',
    name: 'Mister Burguer Steakhouse',
    status: 'ativa',
    status_reason: null,
    datasets: [
      { dataset: 'cupons', freshness: 'fresh', last_success_at: local(27, 9, 20), last_attempt_at: local(27, 9, 20), last_error: null, next_at: null },
      { dataset: 'pedidos', freshness: 'fresh', last_success_at: pedidosEm, last_attempt_at: pedidosEm, last_error: null, next_at: null },
    ],
    ...extra,
  });
  const contaRegem = (extra: Partial<ConnectedAccountResponse> = {}): ConnectedAccountResponse => ({
    id: ID,
    brand_id: ID,
    connection_id: ID,
    provider: 'regem',
    external_id: 'loja-1',
    name: 'Mister Burguer Steakhouse',
    currency: 'BRL',
    timezone: 'America/Sao_Paulo',
    status: 'ativa',
    status_reason: null,
    unit_id: ID,
    unit_name: 'Mister Burguer Steakhouse',
    scopes: SEM_CUSTO,
    connected_at: local(20, 8),
    disconnected_at: null,
    ...extra,
  });

  it('situação da loja: pedidos em dia, primeira leitura, atrasados só depois de 2 horas, sem custos e desconectada', () => {
    const completa = { scopes: COMPLETO, origem: 'oauth' };
    expect(situacaoDaLoja(loja(), completa, agora)).toMatchObject({ rotulo: 'Pedidos em dia', tom: 'ok', precisaDeVoce: false, ultimaLeituraEm: local(27, 9, 20) });
    expect(situacaoDaLoja(loja({}, null), completa, agora)).toMatchObject({ rotulo: 'Primeira leitura', tom: 'lendo', motivo: 'Trazendo os pedidos dos últimos 90 dias. Leva alguns minutos.' });
    // 09:30 menos 1h59 ainda está em dia; 2h01, atrasado.
    expect(situacaoDaLoja(loja({}, local(27, 7, 31)), completa, agora).rotulo).toBe('Pedidos em dia');
    expect(situacaoDaLoja(loja({}, local(27, 7, 29)), completa, agora)).toMatchObject({ rotulo: 'Pedidos atrasados', tom: 'atencao' });
    expect(situacaoDaLoja(loja(), { scopes: SEM_CUSTO, origem: 'oauth' }, agora)).toMatchObject({
      rotulo: 'Sem custos',
      tom: 'atencao',
      precisaDeVoce: true,
      motivo: 'Quem autorizou não tem permissão financeira no Regem: a margem desta loja fica desconhecida.',
    });
    expect(situacaoDaLoja(loja(), { scopes: SEM_CUSTO, origem: 'distribuicao' }, agora).motivo).toBe('O token desta loja foi emitido sem o custo dos itens: a margem desta loja fica desconhecida.');
    expect(situacaoDaLoja(loja({ status: 'desconectada' }), completa, agora)).toMatchObject({
      rotulo: 'Desconectada',
      tom: 'perigo',
      precisaDeVoce: true,
      reconectar: false,
      motivo: 'A autorização foi revogada no Regem — conecte de novo.',
    });
    expect(subDaLoja('Centro')).toBe('Loja no Liame: Centro · token próprio da loja');
    expect(subDaLoja(null)).toBe('Sem loja no Liame · token próprio da loja');
    expect(plataforma('regem')).toEqual({ nome: 'Regem', classe: 'regem' });
  });

  it('o que o Liame recebe: liberado, não liberado (com o porquê do custo) e o cupom desligado no Liame', () => {
    const lista = escoposDoRegem([...SEM_CUSTO, 'cupons.criar', 'clientes.telefone.ler'], 'distribuicao');
    expect(lista.map((e) => [e.cod, e.estado])).toEqual([
      ['pedidos.ler', 'liberado'],
      ['custos.ler', 'nao_liberado'],
      ['clientes.anonimizacao.ler', 'liberado'],
      ['cupons.ler', 'liberado'],
      ['cupons.uso.ler', 'liberado'],
      ['cupons.criar', 'desligado'],
      ['clientes.telefone.ler', 'liberado'],
    ]);
    expect(lista[1]!.texto).toBe('O token desta loja foi emitido sem o custo dos itens.');
    expect(escoposDoRegem(SEM_CUSTO, 'oauth')[1]!.texto).toContain('permissão financeira no Regem');
    expect(lista[6]!.rotulo).toBe('Telefone do cliente, pseudonimizado');
    expect(escoposDoRegem(['escopo.novo'], 'oauth').at(-1)).toMatchObject({ cod: 'escopo.novo', rotulo: 'escopo.novo', estado: 'liberado' });
  });

  it('faixa do topo: a revogada vem antes da sem custo; tudo certo, nenhuma', () => {
    const l = { nome: 'Loja Centro', desconectada: false, semCusto: false, origem: 'oauth' };
    expect(faixaDoRegem([l])).toBeNull();
    expect(faixaDoRegem([{ ...l, semCusto: true }])).toEqual({
      tipo: 'atencao',
      titulo: 'O Regem liberou os pedidos, mas não o custo dos itens',
      texto: 'Quem autorizou não tem permissão financeira no Regem. Sem o custo, a margem fica desconhecida e os Resultados não dizem se deu lucro. Para liberar, um presidente autoriza de novo.',
    });
    expect(faixaDoRegem([{ ...l, semCusto: true, origem: 'distribuicao' }])!.texto).toBe(
      'O token da loja foi emitido sem o custo dos itens. Sem o custo, a margem fica desconhecida e os Resultados não dizem se deu lucro.',
    );
    expect(faixaDoRegem([{ ...l, semCusto: true }, { ...l, nome: 'Loja Barra', desconectada: true }])).toMatchObject({
      tipo: 'perigo',
      titulo: 'A autorização foi revogada no Regem — conecte de novo',
      texto: 'Os pedidos da Loja Barra pararam de chegar. Até conectar de novo, os Resultados mostram o caixa só até a última leitura.',
    });
  });

  it('cartão da autorização: quem autorizou e quantas lojas, o aviso de sem custo, a lista do que o Liame recebe e a revogada', () => {
    const cartao = (c: ConnectionResponse, podeConectar = true) =>
      renderToStaticMarkup(createElement(CartaoAutorizacaoRegem, { conexao: c, podeConectar, aoEscolher: null, aoRevogar: () => {} }));
    const daDistribuicao = cartao(conexao({ provider: 'regem', origin: 'distribuicao', status: 'ativa', completed_at: local(30, 9), scopes: SEM_CUSTO, accounts: [contaRegem()] }));
    expect(daDistribuicao).toContain('<b>Autorizada em 30/09/2026</b>');
    expect(daDistribuicao).toContain('pela distribuição DMS · 1 loja');
    expect(daDistribuicao).toContain('Um token para cada loja, guardado cifrado no Liame e só em hash no Regem.');
    expect(daDistribuicao).toContain('Sem o custo dos itens: o token desta loja foi emitido sem ele.');
    expect(daDistribuicao).toContain('O que o Liame recebe');
    expect(daDistribuicao).toContain('aria-expanded="false"');
    expect(daDistribuicao).toContain('<code>custos.ler</code><span class="st st--aguardando">Não liberado</span>');
    expect(daDistribuicao).toContain('<code>pedidos.ler</code><span class="st st--concluido">Liberado</span>');
    expect(daDistribuicao).toContain('aria-label="Revogar a autorização do Regem de 30/09/2026"');

    const peloPresidente = cartao(
      conexao({ provider: 'regem', status: 'ativa', authorized_by: 'Rodrigo Silva', completed_at: local(29, 10), scopes: [...COMPLETO, 'cupons.criar'], accounts: [contaRegem({ scopes: COMPLETO }), contaRegem({ id: 'b', external_id: 'loja-2' })] }),
    );
    expect(peloPresidente).toContain('<b>Autorizada por Rodrigo</b>');
    expect(peloPresidente).toContain('presidente no Regem · em 29/09/2026 · 2 lojas');
    expect(peloPresidente).not.toContain('Sem o custo dos itens');
    expect(peloPresidente).toContain('Liberado · desligado no Liame');

    const revogada = conexao({ provider: 'regem', status: 'ativa', scopes: SEM_CUSTO, accounts: [contaRegem({ status: 'desconectada' })] });
    expect(regemRevogado(revogada)).toBe(true);
    expect(regemRevogado(conexao({ provider: 'regem', status: 'ativa', accounts: [contaRegem(), contaRegem({ status: 'desconectada' })] }))).toBe(false);
    const html = cartao(revogada);
    expect(html).toContain('Revogada no Regem. A leitura dos pedidos parou; conecte de novo para voltar.');
    expect(html).not.toContain('Sem o custo dos itens');
    // Quem só vê não revoga, mas pode abrir a lista do que o Liame recebe.
    const soLeitura = cartao(revogada, false);
    expect(soLeitura).not.toContain('Revogar');
    expect(soLeitura).toContain('O que o Liame recebe');
  });
});
