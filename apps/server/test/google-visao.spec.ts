import { resolve } from 'node:path';
import type { GoogleVisibilityResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { carregarCasosDaConversa } from '../src/ai/evals/conversa.js';
import { carregarCasosDoPlano } from '../src/ai/evals/plano.js';
import { criarMarcador, indiceDasOrigens } from '../src/ai/conversa/fontes.js';
import { foraDoDia, nomesDaLeitura, rotuloDaLeitura, rotuloDoPasso } from '../src/ai/conversa/leituras.js';
import { conferirResposta, type RespostaDaLia } from '../src/ai/conversa/resposta.js';
import { LEITURAS, LEITURAS_DE_DADOS } from '../src/ai/registro/leituras.defs.js';
import { plataforma } from '../src/ai/registro/leituras.visoes.js';
import { diferenca, GOOGLE_INDISPONIVEL, PARTE_INDISPONIVEL, posicaoComUmaCasa, taxaDeClique, visaoDoGoogle } from '../src/ai/registro/visoes/google.js';

// "Como te acham no Google" para a IA (A6 · Z3, parte g): a leitura `como_te_acham`, do mesmo serviço do cartão de
// Resultados (P18). O que o modelo recebe: as partes nos estados da tela, os números como a tela escreve, o frescor de
// cada loja e site, e o caminho de cada número no "De onde vêm os números". Os números do protótipo. Sem banco.

const FUSO = 'America/Sao_Paulo';
const LOJA = '01a40000-0000-7000-8000-0000000000c1';
const SITE = '01a40000-0000-7000-8000-0000000000c2';
const DIAS = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26'];
const CLIQUES = [18, 22, 19, 25, 27, 24, 21];
const conta = (id: string, name: string, freshness = 'fresh') => ({ connected_account_id: id, name, status: 'ativa', last_success_at: '2026-09-29T10:00:00.000Z', freshness });

function resposta(over: { days?: number; profile?: Partial<GoogleVisibilityResponse['profile']>; site?: Partial<GoogleVisibilityResponse['site']> } = {}): GoogleVisibilityResponse {
  const profile = {
    enabled: true,
    waiting_google: false,
    accounts: [conta(LOJA, 'Mister Burgers — Centro')],
    period: { from: DIAS[0]!, to: DIAS[6]! },
    views_search: '1640',
    views_maps: '700',
    previous_views: '2090',
    direction_requests: '128',
    call_clicks: '46',
    website_clicks: '212',
    menu_clicks: '88',
    ...over.profile,
  };
  const site = {
    enabled: true,
    accounts: [conta(SITE, 'misterburgers.com.br')],
    period: { from: DIAS[0]!, to: DIAS[6]! },
    clicks: '156',
    impressions: '1920',
    position: '6.8',
    previous_clicks: '139',
    daily: DIAS.map((day, i) => ({ day, clicks: String(CLIQUES[i]) })),
    queries: {
      week: { from: '2026-09-21', to: '2026-09-27' },
      items: [
        { query: 'mister burgers', clicks: '38', impressions: '120', position: '1.2' },
        { query: 'hamburgueria perto de mim', clicks: '21', impressions: '640', position: '6.8' },
        { query: 'pizza 2 por 1', clicks: '9', impressions: '330', position: '8.95' },
      ],
    },
    ...over.site,
  };
  return { enabled: profile.enabled || site.enabled, days: over.days ?? 7, profile, site };
}
type Visao = Record<string, Record<string, unknown>>;
const ver = (r: GoogleVisibilityResponse) => visaoDoGoogle(r, FUSO) as unknown as Visao;

describe('os números, como a tela escreve', () => {
  it('a posição com uma casa e a taxa de clique pela regra do P23, sem ponto flutuante; a diferença contra os dias anteriores', () => {
    expect(['6.8', '6.75', '6.74', '1', '1234.5', '8.95'].map((p) => posicaoComUmaCasa(p))).toEqual(['6,8', '6,8', '6,7', '1,0', '1.234,5', '9,0']);
    expect(posicaoComUmaCasa(null)).toBeNull();
    expect([taxaDeClique(21n, 640n), taxaDeClique(38n, 120n), taxaDeClique(1n, 1n), taxaDeClique(0n, 50n), taxaDeClique(1n, 0n)]).toEqual(['3,3%', '32%', '100%', '0,0%', null]);
    expect([diferenca(2340n, '2090'), diferenca(1n, '2'), diferenca(5n, '5'), diferenca(1200n, '0'), diferenca(5n, null)]).toEqual(['250 a mais', '1 a menos', 'igual', '1.200 a mais', null]);
  });
});

describe('a leitura `como_te_acham` (A6 · Z3)', () => {
  it('no registro: R0, com a permissão da rota do cartão, entre as leituras do Estrategista e da LIA', () => {
    const def = LEITURAS.find((l) => l.name === 'como_te_acham')!;
    expect(def).toMatchObject({ version: 1, risk: 'R0', permission: 'vendas.ver', owner: 'vendas' });
    expect(LEITURAS_DE_DADOS).toContain('como_te_acham');
    expect(def.input.safeParse({ brand_id: LOJA }).success).toBe(true);
    expect(def.input.safeParse({ brand_id: LOJA, dias: '30' }).success).toBe(true);
    // Só os dias da rota (7 ou 30), e nada além da marca e dos dias.
    expect(def.input.safeParse({ brand_id: LOJA, dias: '14' }).success).toBe(false);
    expect(def.input.safeParse({ brand_id: LOJA, from: '2026-09-01' }).success).toBe(false);
    expect(rotuloDoPasso('como_te_acham', { brand_id: LOJA })).toBe('Lendo como te acham no Google');
    expect(rotuloDaLeitura('como_te_acham', { brand_id: LOJA, dias: '30' })).toBe('Como te acham no Google');
    // A plataforma do site no frescor das fontes (V136): o nome, não a chave.
    expect(plataforma('search_console')).toBe('Search Console');
  });

  it('o perfil e o site lidos: os números da tela, já escritos, cada conta com o frescor, e as buscas da semana', () => {
    expect(ver(resposta())).toEqual({
      perfil_no_google: {
        lojas: [{ loja: 'Mister Burgers — Centro', situacao: 'ativa', frescor: 'em dia', ultima_leitura: '29/09/2026 07:00' }],
        periodo: { de: '20/09/2026', ate: '26/09/2026', dias: '7' },
        vezes_que_o_perfil_apareceu: '2.340',
        na_busca_do_google: '1.640',
        no_google_maps: '700',
        vezes_nos_dias_anteriores: '2.090',
        diferenca_para_os_dias_anteriores: '250 a mais',
        pedidos_de_rota: '128',
        ligacoes: '46',
        cliques_no_site: '212',
        cliques_no_cardapio: '88',
      },
      site_no_search_console: {
        sites: [{ site: 'misterburgers.com.br', situacao: 'ativa', frescor: 'em dia', ultima_leitura: '29/09/2026 07:00' }],
        periodo: { de: '20/09/2026', ate: '26/09/2026', dias: '7' },
        cliques_vindos_das_buscas: '156',
        vezes_que_o_site_apareceu_nas_buscas: '1.920',
        posicao_media: '6,8',
        cliques_nos_dias_anteriores: '139',
        diferenca_para_os_dias_anteriores: '17 a mais',
        cliques_por_dia: DIAS.map((d, i) => ({ dia: `${d.slice(8)}/${d.slice(5, 7)}/2026`, cliques: String(CLIQUES[i]) })),
      },
      buscas_da_ultima_semana: {
        semana: { de: '21/09/2026', ate: '27/09/2026' },
        buscas: [
          { busca: 'mister burgers', cliques: '38', vezes_que_apareceu: '120', taxa_de_clique: '32%', posicao_media: '1,2' },
          { busca: 'hamburgueria perto de mim', cliques: '21', vezes_que_apareceu: '640', taxa_de_clique: '3,3%', posicao_media: '6,8' },
          { busca: 'pizza 2 por 1', cliques: '9', vezes_que_apareceu: '330', taxa_de_clique: '2,7%', posicao_media: '9,0' },
        ],
      },
      notas: [
        // Por extenso: a nota é do Google, não um número da empresa (não libera o 2 e o 3 nem derruba a resposta com a fonte parada).
        'O Google entrega os números com dois a três dias de atraso: o dia de hoje nunca entra.',
        'O perfil e o site são contagens diferentes do Google: não se somam.',
        'Na posição média, 1 é o primeiro lugar.',
        'A busca feita por poucas pessoas o Google não mostra: ela só entra nos cliques do site, e por isso a soma das buscas fica abaixo do total.',
      ],
    });
    // 30 dias: o período diz quantos dias tem.
    expect(ver(resposta({ days: 30 })).perfil_no_google!.periodo).toEqual({ de: '20/09/2026', ate: '26/09/2026', dias: '30' });
  });

  it('antes dos números, cada parte no estado da tela; a parte desligada não manda ligar nada', () => {
    // As duas funções desligadas: nada do Google.
    expect(visaoDoGoogle(resposta({ profile: { enabled: false }, site: { enabled: false } }), FUSO)).toEqual({ situacao: GOOGLE_INDISPONIVEL });
    // Só o site ligado: o perfil diz que não está disponível, sem convite.
    const soSite = ver(resposta({ profile: { enabled: false, accounts: [], period: null } }));
    expect(soSite.perfil_no_google).toEqual({ situacao: PARTE_INDISPONIVEL });
    expect(soSite.site_no_search_console!.cliques_vindos_das_buscas).toBe('156');
    // A função ligada sem loja: o convite (e o Google que ainda não liberou o acesso, sem convite).
    expect(ver(resposta({ profile: { accounts: [], period: null } })).perfil_no_google).toEqual({ situacao: 'nenhuma loja do perfil ligada', o_que_fazer: 'ligar a loja do perfil em Contas conectadas' });
    expect(ver(resposta({ profile: { accounts: [], period: null, waiting_google: true } })).perfil_no_google).toEqual({
      situacao: 'esperando o Google liberar o acesso do Liame ao perfil da empresa; o Liame procura de novo todo dia',
    });
    // Primeira leitura: a conta, que ainda não leu.
    const primeira = ver(resposta({ profile: { accounts: [{ ...conta(LOJA, 'Mister Burgers — Centro', 'unknown'), last_success_at: null }], period: null } }));
    expect(primeira.perfil_no_google).toEqual({ situacao: 'primeira leitura: os números dos últimos 90 dias chegam em até um dia', lojas: [{ loja: 'Mister Burgers — Centro', situacao: 'ativa', frescor: 'nunca leu' }] });
    // O site sem conta e sem número: sem buscas, e as notas só do que existe.
    const semSite = ver(resposta({ site: { accounts: [], period: null, queries: null } }));
    expect(semSite.site_no_search_console).toEqual({ situacao: 'nenhum site ligado', o_que_fazer: 'ligar o site do Search Console em Contas conectadas' });
    expect(semSite.buscas_da_ultima_semana).toBeUndefined();
    expect(semSite.notas).toEqual(['O Google entrega os números com dois a três dias de atraso: o dia de hoje nunca entra.', 'O perfil e o site são contagens diferentes do Google: não se somam.']);
    expect(ver(resposta({ site: { period: null, daily: [], queries: null } })).site_no_search_console).toMatchObject({ situacao: expect.stringMatching(/^primeira leitura/) });
  });

  it('a semana sem busca, os dias sem os números de antes, e o que diminuiu', () => {
    const v = ver(resposta({ profile: { previous_views: null, views_search: '1000', views_maps: '0' }, site: { previous_clicks: '200', queries: { week: { from: '2026-09-21', to: '2026-09-27' }, items: [] } } }));
    expect(v.perfil_no_google).not.toHaveProperty('vezes_nos_dias_anteriores');
    expect(v.perfil_no_google).not.toHaveProperty('diferenca_para_os_dias_anteriores');
    expect(v.perfil_no_google!.no_google_maps).toBe('0');
    expect(v.site_no_search_console!.diferenca_para_os_dias_anteriores).toBe('44 a menos');
    expect(v.buscas_da_ultima_semana).toEqual({ semana: { de: '21/09/2026', ate: '27/09/2026' }, nota: 'Nenhuma busca trouxe cliques ao site nesta semana.' });
    expect(v.notas).not.toContain(expect.stringMatching(/^A busca feita por poucas pessoas/));
    // A posição sem nenhuma vez fica de fora (o site não apareceu).
    expect(ver(resposta({ site: { impressions: '0', clicks: '0', position: null } })).site_no_search_console).not.toHaveProperty('posicao_media');
  });

  it('a loja ou o site fora do dia: a conversa não cita número desta leitura, só diz qual fonte atrasou e desde quando', () => {
    expect(foraDoDia('como_te_acham', ver(resposta()))).toEqual([]);
    const atrasado = ver(resposta({ site: { accounts: [conta(SITE, 'misterburgers.com.br', 'delayed')] } }));
    expect(foraDoDia('como_te_acham', atrasado)).toEqual([{ platform: 'Search Console', name: 'misterburgers.com.br', freshness: 'atrasado', last_read: '29/09/2026 07:00' }]);
    const parado = ver(resposta({ profile: { accounts: [conta(LOJA, 'Mister Burgers — Centro', 'stale')] } }));
    expect(foraDoDia('como_te_acham', parado)).toEqual([{ platform: 'Perfil no Google', name: 'Mister Burgers — Centro', freshness: 'parado', last_read: '29/09/2026 07:00' }]);
    // A resposta que cita o número da leitura atrasada é recusada como dado velho.
    const r: RespostaDaLia = { blocos: [{ tipo: 'paragrafo', texto: 'O site recebeu 156 cliques vindos das buscas.', risco: null }], reuniao: null };
    expect(conferirResposta(r, { emDia: [], velhas: [atrasado], nomes: nomesDaLeitura(atrasado) })).toMatchObject({ recusa: 'dado_velho' });
    // Dizer qual fonte atrasou, desde quando, e o atraso do Google (por extenso, não é número da leitura) passa.
    const certa: RespostaDaLia = {
      blocos: [{ tipo: 'paragrafo', texto: 'A leitura do site no Search Console está atrasada desde 29/09/2026 07:00. O Google também entrega os números com dois a três dias de atraso.', risco: null }],
      reuniao: null,
    };
    expect(conferirResposta(certa, { emDia: [foraDoDia('como_te_acham', atrasado)], velhas: [atrasado], nomes: nomesDaLeitura(atrasado) })).toBeNull();
    // Sem o Google, nada fora do dia.
    expect(foraDoDia('como_te_acham', visaoDoGoogle(resposta({ profile: { enabled: false }, site: { enabled: false } }), FUSO))).toEqual([]);
  });

  it('de onde vem cada número da resposta, e a busca como nome (o número dentro dela não é valor)', () => {
    const v = ver(resposta());
    const nomes = nomesDaLeitura(v);
    expect([...nomes].sort()).toEqual(['Mister Burgers — Centro', 'hamburgueria perto de mim', 'mister burgers', 'misterburgers.com.br', 'pizza 2 por 1']);
    const lugares = indiceDasOrigens([{ rotulo: 'Como te acham no Google', valor: v, comCaminho: true, ordem: 1 }]);
    const { marcar, numbers } = criarMarcador(lugares, nomes);
    marcar('Nos 7 dias até 26/09/2026, o perfil apareceu 2.340 vezes, 250 a mais que nos dias anteriores.');
    marcar('A busca pizza 2 por 1 trouxe 9 cliques, e só 2,7% das pessoas que viram clicaram.');
    marcar('Na média, o site ficou na posição 6,8.');
    expect(numbers).toEqual([
      { value: '7', sources: ['Como te acham no Google · perfil no Google · periodo · dias', 'Como te acham no Google · site no Search Console · periodo · dias'] },
      { value: '26/09/2026', sources: ['Como te acham no Google · perfil no Google · periodo · ate', 'Como te acham no Google · site no Search Console · periodo · ate', 'Como te acham no Google · site no Search Console · cliques por dia 7 · dia'] },
      { value: '2.340', sources: ['Como te acham no Google · perfil no Google · vezes que o perfil apareceu'] },
      { value: '250', sources: ['Como te acham no Google · perfil no Google · diferença para os dias anteriores'] },
      { value: '9', sources: ['Como te acham no Google · buscas da última semana · busca "pizza 2 por 1" · cliques'] },
      { value: '2,7%', sources: ['Como te acham no Google · buscas da última semana · busca "pizza 2 por 1" · taxa de clique'] },
      // A frase não cita busca nenhuma: fica a posição do site, que não é de nenhuma (V58), e não a da busca com o mesmo valor.
      { value: '6,8', sources: ['Como te acham no Google · site no Search Console · posição média'] },
    ]);
    // A resposta inteira passa na conferência de números da produção com esta leitura como fonte.
    const r: RespostaDaLia = {
      blocos: [
        { tipo: 'paragrafo', texto: 'Nos 7 dias até 26/09/2026, o perfil apareceu 2.340 vezes: 1.640 na busca do Google e 700 no Google Maps, 250 a mais que nos dias anteriores (2.090).', risco: null },
        { tipo: 'item', texto: 'A busca "mister burgers" trouxe 38 cliques, com 32% de quem viu clicando.', risco: null },
        { tipo: 'item', texto: 'A busca "pizza 2 por 1" trouxe 9 cliques.', risco: null },
      ],
      reuniao: null,
    };
    expect(conferirResposta(r, { emDia: [v], velhas: [], nomes })).toBeNull();
    // A soma do perfil com o site é conta da IA: recusada.
    const soma: RespostaDaLia = { blocos: [{ tipo: 'paragrafo', texto: 'Somando o perfil e o site, foram 2.496 vezes.', risco: null }], reuniao: null };
    expect(conferirResposta(soma, { emDia: [v], velhas: [], nomes })).toMatchObject({ recusa: 'numero_fora' });
  });

  it('os casos dos evals guardam a leitura no formato que o servidor monta (mudou a visão, gere os casos de novo)', () => {
    /** Os caminhos das chaves de um valor (a lista vira `[]`): o formato, sem os valores. */
    const caminhos = (x: unknown, base = ''): string[] => {
      if (Array.isArray(x)) return x.flatMap((i) => caminhos(i, `${base}[]`));
      if (x && typeof x === 'object') return Object.entries(x).flatMap(([k, i]) => [`${base}.${k}`, ...caminhos(i, `${base}.${k}`)]);
      return [];
    };
    const atual = new Set(caminhos(ver(resposta())));
    const daConversa = carregarCasosDaConversa(resolve(process.cwd(), '../../evals/conversa_lia/casos.jsonl'));
    const doPlano = carregarCasosDoPlano(resolve(process.cwd(), '../../evals/estrategista_plano/casos.jsonl'));
    const gravadas = [...daConversa, ...doPlano].filter((c) => 'como_te_acham' in c.leituras).map((c) => ({ id: c.id, leitura: c.leituras.como_te_acham }));
    expect(gravadas.map((g) => g.id).sort()).toEqual(['google-busca-injecao', 'google-como-te-acham', 'google-dado-velho', 'google-somar-perfil-e-site', 'ref-pauta-buscas']);
    for (const g of gravadas) expect({ id: g.id, fora_do_formato: caminhos(g.leitura).filter((p) => !atual.has(p)) }).toEqual({ id: g.id, fora_do_formato: [] });
  });
});
