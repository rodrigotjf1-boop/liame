import type { AccountFreshness, ConnectionResponse, DiscoveredAccount } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import {
  autorizacoesVisiveis,
  botaoLigar,
  escolhiveis,
  faixaDaVolta,
  gruposDaEscolha,
  idDaConta,
  lerVolta,
  resumoDaDescoberta,
  situacaoDaConta,
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
});

const conexao = (extra: Partial<ConnectionResponse> = {}): ConnectionResponse => ({
  id: ID,
  brand_id: '01a0e1a1-ea64-71ed-8775-f13002fd25f0',
  provider: 'google',
  status: 'aguardando_escolha',
  error_code: null,
  created_at: local(27, 9, 0),
  completed_at: null,
  refresh_expires_at: null,
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
    const conta = { id: ID, brand_id: ID, connection_id: ID, provider: 'meta_ads', external_id: 'act_1', name: 'a', currency: null, timezone: null, status: 'ativa', status_reason: null, connected_at: local(20, 8), disconnected_at: null };
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
