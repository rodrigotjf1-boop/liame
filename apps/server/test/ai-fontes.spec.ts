import type { ClosedLoopResponse } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { AVISOS_EXPLICAVEIS, avisoNoContexto, explicacaoDoAvisoSemIa } from '../src/ai/explicar/aviso.js';
import { type ContextoDoAviso, contextoDosResultados, nomesDoContexto } from '../src/ai/explicar/contexto.js';
import { indiceDasFontes, marcarNumeros } from '../src/ai/explicar/fontes.js';
import { conferirExplicacao, type Explicacao } from '../src/ai/explicar/resposta.js';
import { explicacaoSemIa } from '../src/ai/explicar/sem-ia.js';
import { numerosDe, trechosDe } from '../src/ai/verificador-numeros.js';

// A3 · I4, sem banco: de onde vem cada número da explicação (quem diz é o código, olhando o contexto que
// ele montou) e a explicação de um aviso da Atenção, com e sem IA.

const U = (n: number) => `0199a300-0000-7000-8000-${n.toString().padStart(12, '0')}`;
/** Os avisos escrevem o dinheiro com o espaço que não quebra (o do `Intl`); o contexto da IA, com o espaço comum. */
const nbsp = (s: string) => s.replaceAll('R$ ', `R$${String.fromCharCode(160)}`);

function resultado(extra: { from?: string; to?: string; spend?: string; orders?: number; revenue?: string; roas?: string } = {}): ClosedLoopResponse {
  const spend = extra.spend ?? '960000000';
  const caixa = { orders: extra.orders ?? 38, revenue_micros: extra.revenue ?? '2496000000', roas: extra.roas ?? '2.60', cost_per_order_micros: '25263158', margin_known_micros: '1100000000', margin_coverage_pct: '83.4', verdict: 'lucro' };
  const informa = { spend_micros: spend, value_micros: '12060000000', roas: '12.56', window: '7d_click', conversions: '41', conversations: null, cost_per_conversation_micros: null };
  const campanha = { orders: 30, revenue_micros: '1980000000', roas: '2.83', cost_per_order_micros: '23333333', margin_known_micros: null, margin_coverage_pct: null, verdict: null };
  return {
    period: { from: extra.from ?? '2026-09-25', to: extra.to ?? '2026-10-01', timezone: 'America/Sao_Paulo', account_timezones: ['America/Sao_Paulo'] },
    model: { id: U(1), key: 'ultimo_toque', version: 1, window_days: 7, counts_views: false },
    currency: 'BRL',
    totals: {
      spend_micros: spend,
      orders_confirmed: 1250,
      revenue_micros: '81250000000',
      confirmed: caixa,
      without_origin: { orders: 410, revenue_micros: '26650000000', share_pct: '61.2' },
      no_click_channels: [{ channel_group: 'marketplace', orders: 580, revenue_micros: '37700000000' }],
      cancelled: { orders: 3, revenue_micros: '195000000' },
    },
    platforms: [{ provider: 'meta_ads', platform: informa, confirmed: caixa, platform_only_orders: 2 }],
    campaigns: [{ campaign_id: U(2), provider: 'meta_ads', name: 'Smash em dobro', status: 'ativa', platform: { ...informa, spend_micros: '700000000', value_micros: null, roas: null, conversions: null }, confirmed: campanha }],
    sources: [
      { connected_account_id: U(8), provider: 'meta_ads', name: 'CA - Hamburgueria', dataset: 'metricas', freshness: 'fresh', last_success_at: '2026-10-02T09:12:16.000Z', status: 'ativa', timezone: 'America/Sao_Paulo' },
      { connected_account_id: U(9), provider: 'regem', name: 'Loja Centro', dataset: 'pedidos', freshness: 'fresh', last_success_at: '2026-10-02T17:05:19.000Z', status: 'ativa', timezone: 'America/Sao_Paulo' },
    ],
    generated_at: '2026-10-02T17:20:00.000Z',
  };
}
const anterior = () => resultado({ from: '2026-09-18', to: '2026-09-24', spend: '784000000', orders: 31, revenue: '2015000000', roas: '2.57' });
const contexto = () => contextoDosResultados(resultado(), anterior());

describe('o texto em trechos: cada número e cada data no lugar (A3, I4)', () => {
  it('na ordem da leitura, com a data inteira; os números são os mesmos da conferência', () => {
    const texto = 'De 25/09/2026 a 01/10/2026 o ROAS foi 2,60, com R$ 960,00 e +22,4%, lido em 02/10/2026 06:12.';
    const t = trechosDe(texto);
    expect(t.map((x) => x.texto).join('')).toBe(texto);
    expect(t.filter((x) => x.forma).map((x) => [x.texto, x.forma])).toEqual([
      ['25/09/2026', 'data:25/09/2026'],
      ['01/10/2026', 'data:01/10/2026'],
      ['2,60', '2.6'],
      ['960,00', '960'],
      ['22,4', '22.4'],
      ['02/10/2026 06:12', 'data:02/10/2026 06:12'],
    ]);
    expect(new Set(t.map((x) => x.forma).filter(Boolean))).toEqual(new Set(numerosDe(texto)));
    expect(trechosDe('sem número nenhum')).toEqual([{ texto: 'sem número nenhum', forma: null }]);
    expect(trechosDe('')).toEqual([]);
  });
});

describe('de onde vem cada número: quem diz é o código', () => {
  it('cada número do contexto tem o lugar dele, com a origem, o período e a hora da leitura', () => {
    const i = indiceDasFontes(contexto());
    // O mesmo valor em dois lugares do contexto leva os dois, do mais específico (a plataforma) para o mais
    // geral (o total). O "agora" da comparação é o próprio total: não vira uma segunda linha do mesmo fato.
    expect(i.get('dinheiro|960')).toEqual(['Meta · investimento da Meta · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 06:12', 'Meta · investimento em anúncios · 25/09/2026 a 01/10/2026']);
    expect(i.get('numero|38')).toEqual([
      'Regem · pedidos confirmados com origem na Meta · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 14:05',
      'Regem · pedidos confirmados com origem provada em campanha · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 14:05',
    ]);
    expect(i.get('decimal|2.6')?.[1]).toBe('Liame · ROAS confirmado no caixa com origem provada em campanha (receita confirmada ÷ investimento) · calculado pelo sistema');
    expect(i.get('decimal|12.56')).toEqual(['Meta · ROAS que a plataforma informa da Meta, na janela de 7 dias depois do clique · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 06:12']);
    expect(i.get('numero|30')).toEqual(['Regem · pedidos confirmados da campanha "Smash em dobro" · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 14:05']);
    expect(i.get('dinheiro|700')).toEqual(['Meta · investimento da campanha "Smash em dobro" · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 06:12']);
    // A comparação: o valor de antes, e a variação calculada pelo código.
    expect(i.get('dinheiro|784')).toEqual(['Meta · investimento em anúncios no período anterior · 18/09/2026 a 24/09/2026']);
    expect(i.get('porcento|22.4')).toEqual(['Liame · variação de investimento em anúncios sobre o período anterior (18/09/2026 a 24/09/2026) · calculado pelo sistema']);
    expect(i.get('data|data:25/09/2026')).toEqual(['Período desta explicação']);
    expect(i.get('data|data:18/09/2026')).toEqual(['Período anterior, usado na comparação']);
    // A leitura com a hora responde também pela data sozinha.
    expect(i.get('data|data:02/10/2026 06:12')).toEqual(['Meta · última leitura da conta "CA - Hamburgueria"']);
    expect(i.get('data|data:02/10/2026')).toEqual(['Meta · última leitura da conta "CA - Hamburgueria"', 'Regem · última leitura da conta "Loja Centro"']);
    // O que o número mede entra na chave: "7 dias" é a janela, e nenhum "7" de contagem ou de dinheiro.
    expect(i.get('dias|7')).toEqual(['Liame · janela do modelo de atribuição, em dias', 'Meta · janela de atribuição da plataforma']);
    expect(i.get('numero|7')).toBeUndefined();
    expect(i.get('numero|960')).toBeUndefined();
    // O número com casas (ROAS) não é contagem: "2,60" não responde por "2,6 pedidos", e a contagem não responde por um ROAS.
    expect(i.get('numero|2.6')).toBeUndefined();
    expect(i.get('decimal|38')).toBeUndefined();
  });

  it('o nome da plataforma entra na frase com o artigo certo, e a janela não se repete', () => {
    const base = resultado();
    const google = { ...base.platforms[0]!, provider: 'google_ads', platform: { ...base.platforms[0]!.platform, roas: '3.40', window: 'padrao' } };
    const i = indiceDasFontes(contextoDosResultados({ ...base, platforms: [google] }, null));
    expect(i.get('decimal|3.4')).toEqual(['Google Ads · ROAS que a plataforma informa do Google Ads, na janela de cada conversão (padrão da plataforma) · 25/09/2026 a 01/10/2026']);
    expect(i.get('numero|38')?.[0]).toBe('Regem · pedidos confirmados com origem no Google Ads · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 14:05');
    expect(i.get('dinheiro|960')?.[0]).toBe('Google Ads · investimento do Google Ads · 25/09/2026 a 01/10/2026');
    // E a explicação do sistema fala "O Google Ads", não "A Google Ads".
    expect(explicacaoSemIa(contextoDosResultados({ ...base, platforms: [google] }, null)).motivos).toContain('O Google Ads informa ROAS de 3,40; o caixa confirma 2,60. Para decidir, vale o do caixa.');
  });

  it('a frase que cita uma campanha ganha a fonte dela; a que não cita, a do total, mesmo com o valor igual', () => {
    // Duas campanhas com 7 pedidos cada, e uma terceira com ROAS de 7,00: três "7" que não se misturam.
    const base = resultado();
    const campanha = base.campaigns[0]!;
    const sete = { ...campanha.confirmed, orders: 7 };
    const c = contextoDosResultados(
      {
        ...base,
        totals: { ...base.totals, confirmed: { ...base.totals.confirmed, orders: 7 } },
        platforms: [],
        campaigns: [
          { ...campanha, campaign_id: U(11), name: 'Busca perto', confirmed: sete },
          { ...campanha, campaign_id: U(12), name: 'Smash em dobro', confirmed: sete },
          { ...campanha, campaign_id: U(13), name: 'Delivery noite', confirmed: { ...campanha.confirmed, orders: 2, roas: '7.00' } },
        ],
      },
      null,
    );
    const m = marcarNumeros(
      {
        o_que_aconteceu: 'O caixa confirmou 7 pedidos com origem em campanha.',
        motivos: ['A campanha "Smash em dobro" teve 7 pedidos confirmados.', 'A "Busca perto" também teve 7 pedidos.', 'Na "Delivery noite", o ROAS confirmado foi de 7,00.'],
        risco: 'medio',
        risco_motivo: 'foram 7 pedidos no total.',
        o_que_fazer: ['Acompanhe a campanha "Smash em dobro".'],
      },
      c,
    );
    expect(m.numeros).toEqual([
      { valor: '7', fontes: ['Regem · pedidos confirmados com origem provada em campanha · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 14:05'] },
      { valor: '7', fontes: ['Regem · pedidos confirmados da campanha "Smash em dobro" · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 14:05'] },
      { valor: '7', fontes: ['Regem · pedidos confirmados da campanha "Busca perto" · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 14:05'] },
      { valor: '7,00', fontes: ['Liame · ROAS confirmado no caixa da campanha "Delivery noite" (receita confirmada ÷ investimento) · calculado pelo sistema'] },
    ]);
    // O "7 pedidos no total" do risco volta para a linha do total: o mesmo valor, com as mesmas fontes.
    expect(m.risco_motivo.find((t) => t.numero !== null)).toEqual({ texto: '7', numero: 0 });
  });

  it('o que o número mede decide a fonte: dinheiro, porcentagem, dias e contagem não se misturam', () => {
    // 7 pedidos cancelados, R$ 7,00 de receita cancelada e a janela de 7 dias: três "7" diferentes.
    const base = resultado();
    const c = contextoDosResultados({ ...base, totals: { ...base.totals, cancelled: { orders: 7, revenue_micros: '7000000' } } }, anterior());
    const m = marcarNumeros(
      { o_que_aconteceu: 'Foram 7 pedidos cancelados, com R$ 7,00, na janela de 7 dias.', motivos: ['A receita foi de 2.496 reais.'], risco: 'baixo', risco_motivo: 'o caixa confirma lucro.', o_que_fazer: ['Nada a fazer.'] },
      c,
    );
    expect(m.numeros).toEqual([
      { valor: '7', fontes: ['Regem · pedidos cancelados depois de confirmados · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 14:05'] },
      { valor: 'R$ 7,00', fontes: ['Regem · receita dos pedidos cancelados depois · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 14:05'] },
      { valor: '7', fontes: ['Liame · janela do modelo de atribuição, em dias', 'Meta · janela de atribuição da plataforma'] },
      // Escrito sem o "R$": não há contagem com este valor, e a fonte é a do dinheiro.
      {
        valor: '2.496',
        fontes: [
          'Regem · receita confirmada com origem na Meta · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 14:05',
          'Regem · receita confirmada com origem provada em campanha · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 14:05',
        ],
      },
    ]);
    // Os dois "7" soltos são linhas diferentes da lista: cada um aponta para a sua.
    expect(m.o_que_aconteceu.filter((t) => t.numero !== null).map((t) => [t.texto, t.numero])).toEqual([['7', 0], ['R$ 7,00', 1], ['7', 2]]);
  });

  it('o "agora" da comparação é o total do período: tem a fonte do total, e não uma segunda linha do mesmo fato', () => {
    const c = contexto();
    const cmp = c.comparacao!;
    const agora = [cmp.investimento, cmp.pedidos_confirmados, cmp.receita_confirmada, cmp.pedidos_com_origem, cmp.receita_com_origem, cmp.roas_confirmado].map((x) => x.agora);
    expect(agora).toEqual(['R$ 960,00', '1.250', 'R$ 81.250,00', '38', 'R$ 2.496,00', '2,60']);
    const m = marcarNumeros(
      { o_que_aconteceu: `Agora: ${agora[0]}, ${agora[1]} pedidos, ${agora[2]}, ${agora[3]} pedidos, ${agora[4]} e ROAS de ${agora[5]}.`, motivos: ['Sem número.'], risco: 'baixo', risco_motivo: 'sem número.', o_que_fazer: ['Nada.'] },
      c,
    );
    // Nenhum fica sem lugar: quem responde por cada um é o total (e a plataforma, quando o valor é o mesmo).
    expect(m.numeros.map((n) => n.valor)).toEqual(agora);
    expect(m.numeros.flatMap((n) => n.fontes)).not.toContain('Liame · dado do período desta tela');
    expect(m.numeros[3]!.fontes).toEqual([
      'Regem · pedidos confirmados com origem na Meta · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 14:05',
      'Regem · pedidos confirmados com origem provada em campanha · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 14:05',
    ]);
    // O total de pedidos foi o mesmo nos dois períodos: aí sim são dois lugares, o de agora e o de antes.
    expect(m.numeros[1]!.fontes).toEqual([
      'Regem · todos os pedidos confirmados no caixa · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 14:05',
      'Regem · todos os pedidos confirmados no período anterior · 18/09/2026 a 24/09/2026',
    ]);
    // A comparação responde pelo que só ela tem: o valor de antes e a variação.
    const descricoes = [...indiceDasFontes(c).values()].flat();
    expect(descricoes.filter((d) => d.includes('no período anterior ·'))).toHaveLength(6);
    expect(descricoes.filter((d) => d.startsWith('Regem · pedidos com origem provada ·') || d.startsWith('Regem · receita com origem provada ·'))).toEqual([]);
  });

  it('marca cada número do texto, puxa o "R$" e o "%" para dentro do valor e não repete a linha', () => {
    const e: Explicacao = {
      o_que_aconteceu: nbsp('De 25/09/2026 a 01/10/2026 o investimento foi de R$ 960,00 e o caixa confirmou 38 pedidos, com ROAS de 2,60.'),
      motivos: ['O investimento subiu 22,4% e a campanha "Smash em dobro" teve 30 pedidos com R$ 700,00.', 'Foram 38 pedidos com origem provada.'],
      risco: 'baixo',
      risco_motivo: 'a margem conhecida cobre o investimento de R$ 960,00.',
      o_que_fazer: ['Mantenha a campanha como está.'],
    };
    const m = marcarNumeros(e, contexto());
    expect(m.numeros.map((n) => n.valor)).toEqual(['25/09/2026', '01/10/2026', nbsp('R$ 960,00'), '38', '2,60', '22,4%', '30', 'R$ 700,00']);
    // O texto continua o mesmo, só partido.
    expect(m.o_que_aconteceu.map((t) => t.texto).join('')).toBe(e.o_que_aconteceu);
    expect(m.motivos[0]!.map((t) => t.texto).join('')).toBe(e.motivos[0]);
    expect(m.o_que_aconteceu.filter((t) => t.numero !== null).map((t) => [t.texto, t.numero])).toEqual([['25/09/2026', 0], ['01/10/2026', 1], [nbsp('R$ 960,00'), 2], ['38', 3], ['2,60', 4]]);
    // O "38" do segundo motivo aponta para a mesma linha do primeiro.
    expect(m.motivos[1]!.find((t) => t.numero !== null)).toEqual({ texto: '38', numero: 3 });
    expect(m.o_que_fazer).toEqual([[{ texto: 'Mantenha a campanha como está.', numero: null }]]);
    expect(m.risco).toBe('baixo');
    // O porquê do risco também sai marcado: o mesmo valor, escrito com o espaço comum, aponta para a mesma linha.
    expect(m.risco_motivo).toEqual([{ texto: 'a margem conhecida cobre o investimento de ', numero: null }, { texto: 'R$ 960,00', numero: 2 }, { texto: '.', numero: null }]);
    // Cada linha tem pelo menos uma fonte, e no máximo três.
    expect(m.numeros.every((n) => n.fontes.length >= 1 && n.fontes.length <= 3)).toBe(true);
    expect(m.numeros[5]!.fontes).toEqual(['Liame · variação de investimento em anúncios sobre o período anterior (18/09/2026 a 24/09/2026) · calculado pelo sistema']);
  });

  it('a explicação do sistema passa pela mesma marcação, e nenhum número fica sem fonte', () => {
    const c = contexto();
    const m = marcarNumeros(explicacaoSemIa(c), c);
    expect(m.numeros.length).toBeGreaterThan(4);
    expect(m.numeros.flatMap((n) => n.fontes)).not.toContain('Liame · dado do período desta tela');
  });

  it('número que é parte de um nome da empresa, ou colado numa letra, fica como texto: não é valor', () => {
    const base = resultado();
    const c = contextoDosResultados({ ...base, campaigns: base.campaigns.map((k) => ({ ...k, name: 'Combo 3 | Black Friday 2026' })) }, anterior());
    const e: Explicacao = {
      o_que_aconteceu: 'A campanha "Combo 3 | Black Friday 2026" teve 30 pedidos, e o cupom SMASH10 não foi usado.',
      motivos: ['Foram 3 pedidos cancelados depois, e a oferta 2x1 segue no ar.'],
      risco: 'medio',
      risco_motivo: 'o cupom não foi usado.',
      o_que_fazer: ['Confira o cupom.'],
    };
    const m = marcarNumeros(e, c);
    // Só o "30" e o "3" solto são valores; o "3" e o "2026" do nome, o "10" do cupom e o "2x1" não.
    expect(m.numeros.map((n) => n.valor)).toEqual(['30', '3']);
    expect(m.o_que_aconteceu).toEqual([
      { texto: 'A campanha "Combo 3 | Black Friday 2026" teve ', numero: null },
      { texto: '30', numero: 0 },
      { texto: ' pedidos, e o cupom SMASH10 não foi usado.', numero: null },
    ]);
    expect(m.motivos[0]).toEqual([{ texto: 'Foram ', numero: null }, { texto: '3', numero: 1 }, { texto: ' pedidos cancelados depois, e a oferta 2x1 segue no ar.', numero: null }]);
    expect(m.numeros[1]!.fontes).toEqual(['Regem · pedidos cancelados depois de confirmados · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 14:05']);
  });

  it('número que passou na conferência e não tem lugar no índice ganha a fonte geral, nunca fica sem nenhuma', () => {
    const c = contexto();
    const m = marcarNumeros({ o_que_aconteceu: 'Foram 999 coisas.', motivos: ['Sem número.'], risco: 'baixo', risco_motivo: 'sem número.', o_que_fazer: ['Nada.'] }, c);
    expect(m.numeros).toEqual([{ valor: '999', fontes: ['Liame · dado do período desta tela'] }]);
  });
});

describe('explicar um aviso da Atenção', () => {
  const item = { kind: 'cupom_sem_uso', severity: 'atencao', title: 'O cupom SMASH10 não teve nenhum uso em 7 dias', detail: nbsp('Ele é o cupom exclusivo da campanha "Smash em dobro", que gastou R$ 279,80 no período (Meta).'), action: 'Confira se o código aparece no anúncio e na conversa do WhatsApp.', provider: 'meta_ads' };
  const doAviso = (campanha: string | null = 'Smash em dobro'): ContextoDoAviso => ({ aviso: avisoNoContexto(item, campanha), ...contexto() });

  it('o aviso vai na frente do contexto, com a plataforma por extenso e a campanha', () => {
    const c = doAviso();
    expect(Object.keys(c)[0]).toBe('aviso');
    // O contexto diz de quando são os resultados que acompanham o aviso: a IA não precisa supor.
    const resultados_de = 'últimos 7 dias completos';
    expect(c.aviso).toEqual({ gravidade: 'atencao', tipo: 'cupom_sem_uso', plataforma: 'Meta', campanha: 'Smash em dobro', titulo: item.title, detalhe: item.detail, o_que_fazer: item.action, resultados_de });
    expect(avisoNoContexto({ ...item, provider: null }, null)).toEqual({ gravidade: 'atencao', tipo: 'cupom_sem_uso', titulo: item.title, detalhe: item.detail, o_que_fazer: item.action, resultados_de });
    expect(nomesDoContexto(doAviso('Campanha sem gasto'))).toContain('Campanha sem gasto');
  });

  it('só os avisos de campanha, de medição e os fora do normal têm explicação', () => {
    for (const tipo of ['campanha_parou', 'cupom_sem_uso', 'anuncio_sem_rastreio', 'vendas_fora_do_normal', 'custo_por_pedido_fora_do_normal', 'plataforma_x_caixa']) expect(AVISOS_EXPLICAVEIS.has(tipo), tipo).toBe(true);
    for (const tipo of ['conta_desconectada', 'dado_atrasado', 'reconectar_em_breve', 'versao_api', 'conta_com_erro', 'vendas_nao_conectadas', 'plataforma_nao_informada']) expect(AVISOS_EXPLICAVEIS.has(tipo), tipo).toBe(false);
  });

  it('sem IA: o que o aviso diz, o número da campanha no período e o que fazer; passa na mesma conferência', () => {
    const c = doAviso();
    const e = explicacaoDoAvisoSemIa(c);
    expect(e).toEqual({
      o_que_aconteceu: `${item.title}. ${item.detail}`,
      motivos: ['De 25/09/2026 a 01/10/2026, a campanha "Smash em dobro" teve investimento de R$ 700,00 e 30 pedido(s) confirmado(s) no caixa, com receita de R$ 1.980,00.'],
      risco: 'medio',
      risco_motivo: 'pela regra do sistema, este aviso pede atenção: vale conferir antes que custe mais.',
      o_que_fazer: [item.action],
    });
    expect(conferirExplicacao(e, c)).toBeNull();
    // O número que está no texto do aviso tem a fonte "Aviso da Atenção"; o código do cupom não é número.
    const m = marcarNumeros(e, c);
    expect(m.numeros.map((n) => n.valor)).toEqual(['7', nbsp('R$ 279,80'), '25/09/2026', '01/10/2026', 'R$ 700,00', '30', 'R$ 1.980,00']);
    expect(m.numeros[1]!.fontes).toEqual(['Aviso da Atenção · o número está no texto do aviso']);
    // O "7 dias" do aviso é do aviso: a janela de 7 dias do modelo de atribuição e a das plataformas têm o
    // mesmo valor por coincidência, e não entram como fonte dele.
    expect(m.numeros[0]!.fontes).toEqual(['Aviso da Atenção · o número está no texto do aviso']);
    expect(m.o_que_aconteceu[0]).toEqual({ texto: 'O cupom SMASH10 não teve nenhum uso em ', numero: null });
  });

  it('o "7 dias" que não está no texto do aviso é parâmetro geral: os resultados do aviso e as janelas de atribuição', () => {
    // O aviso da plataforma × caixa fala em dinheiro; quem escreve "7 dias" é a explicação.
    const semDias = { ...item, kind: 'plataforma_x_caixa', severity: 'info', title: nbsp('A Meta informa R$ 12.060,00 em vendas; no caixa, o Liame confirmou R$ 2.496,00'), detail: 'A plataforma conta pela janela dela; o Liame conta só o pedido com prova.', action: 'Use o número confirmado para decidir.' };
    const c: ContextoDoAviso = { aviso: avisoNoContexto(semDias, null), ...contexto() };
    const m = marcarNumeros(
      { o_que_aconteceu: nbsp('Nos últimos 7 dias completos, a Meta informa R$ 12.060,00 em vendas.'), motivos: ['Sem número.'], risco: 'baixo', risco_motivo: 'sem número.', o_que_fazer: ['Nada.'] },
      c,
    );
    expect(m.numeros).toEqual([
      { valor: '7', fontes: ['Liame · os resultados que acompanham o aviso são dos últimos 7 dias completos', 'Liame · janela do modelo de atribuição, em dias', 'Meta · janela de atribuição da plataforma'] },
      // O dinheiro do aviso é o mesmo fato que a plataforma informa: o aviso primeiro, e a leitura de onde ele saiu.
      {
        valor: nbsp('R$ 12.060,00'),
        fontes: ['Aviso da Atenção · o número está no texto do aviso', 'Meta · valor de venda que a plataforma informa da Meta, na janela de 7 dias depois do clique · 25/09/2026 a 01/10/2026 · lido em 02/10/2026 06:12'],
      },
    ]);
  });

  it('a hora solta do texto do aviso fica como texto: não é um valor com fonte', () => {
    const vendas = {
      kind: 'vendas_fora_do_normal',
      severity: 'critica',
      title: 'As vendas de ontem na Loja Centro ficaram abaixo do normal',
      detail: nbsp('12 pedidos e R$ 780,00 ontem (quinta-feira); no mesmo dia das últimas 4 semanas, o normal foi de 88 pedidos e R$ 5.720,00. São R$ 4.940,00 a menos. Pedidos lidos hoje, às 06:12.'),
      action: 'Confira se a loja abriu no horário.',
      provider: 'regem',
    };
    const c: ContextoDoAviso = { aviso: avisoNoContexto(vendas, null), ...contexto() };
    const e = explicacaoDoAvisoSemIa(c);
    expect(e.risco).toBe('alto');
    expect(conferirExplicacao(e, c)).toBeNull();
    const m = marcarNumeros(e, c);
    expect(m.numeros.slice(0, 6).map((n) => n.valor)).toEqual(['12', nbsp('R$ 780,00'), '4', '88', nbsp('R$ 5.720,00'), nbsp('R$ 4.940,00')]);
    expect(m.numeros.slice(0, 6).every((n) => n.fontes[0] === 'Aviso da Atenção · o número está no texto do aviso')).toBe(true);
    expect(m.o_que_aconteceu.at(-1)).toEqual({ texto: ' a menos. Pedidos lidos hoje, às 06:12.', numero: null });
    expect(m.numeros.map((n) => n.valor)).not.toContain('06');
  });

  it('sem a campanha nos resultados, ou sem campanha no aviso, o motivo diz o que há; a gravidade vira o risco', () => {
    const semGasto = explicacaoDoAvisoSemIa(doAviso('Campanha nova'));
    expect(semGasto.motivos).toEqual(['De 25/09/2026 a 01/10/2026, a campanha "Campanha nova" não teve investimento lido pelo Liame nem pedido confirmado no caixa.']);
    const geral = explicacaoDoAvisoSemIa(doAviso(null));
    expect(geral.motivos).toEqual(['De 25/09/2026 a 01/10/2026, o investimento em anúncios foi de R$ 960,00 e o caixa confirmou 38 pedido(s) com origem provada em campanha.']);
    const critico: ContextoDoAviso = { ...doAviso(), aviso: { ...doAviso().aviso, gravidade: 'critica' } };
    expect(explicacaoDoAvisoSemIa(critico)).toMatchObject({ risco: 'alto', risco_motivo: 'pela regra do sistema, este aviso é crítico: precisa de alguém agora.' });
    expect(explicacaoDoAvisoSemIa({ ...critico, aviso: { ...critico.aviso, gravidade: 'info' } })).toMatchObject({ risco: 'baixo', risco_motivo: 'pela regra do sistema, este aviso é só informativo.' });
    expect(conferirExplicacao(semGasto, doAviso('Campanha nova'))).toBeNull();
    expect(conferirExplicacao(geral, doAviso(null))).toBeNull();
  });

  it('a IA pode citar o número do aviso; número de fora continua derrubando a resposta', () => {
    const c = doAviso();
    const boa: Explicacao = {
      o_que_aconteceu: nbsp('O cupom SMASH10 não foi usado em 7 dias, e a campanha "Smash em dobro" gastou R$ 279,80 no período.'),
      motivos: [nbsp('A campanha teve 30 pedidos confirmados no caixa, com R$ 700,00 de investimento na semana.')],
      risco: 'medio',
      risco_motivo: 'sem o cupom em uso, as vendas da campanha ficam sem origem provada.',
      o_que_fazer: ['Confira se o código aparece no anúncio.'],
    };
    expect(conferirExplicacao(boa, c)).toBeNull();
    expect(conferirExplicacao({ ...boa, motivos: ['Cada pedido custou R$ 23,34.'] }, c)).toEqual({ recusa: 'numero_fora', detalhe: ['23,34'] });
    // A IA diz "nos últimos 7 dias": o número está no contexto, com o que ele quer dizer.
    expect(conferirExplicacao({ ...boa, motivos: ['Nos últimos 7 dias completos, a campanha teve 30 pedidos confirmados no caixa.'] }, c)).toBeNull();
  });

  it('aviso crítico nunca vira risco baixo: a resposta da IA que o rebaixa é recusada', () => {
    const c = doAviso();
    const critico: ContextoDoAviso = { ...c, aviso: { ...c.aviso, gravidade: 'critica' } };
    const boa: Explicacao = { o_que_aconteceu: 'O cupom SMASH10 não foi usado em 7 dias.', motivos: ['A campanha "Smash em dobro" seguiu no ar.'], risco: 'baixo', risco_motivo: 'a campanha segue vendendo.', o_que_fazer: ['Confira se o código aparece no anúncio.'] };
    expect(conferirExplicacao(boa, critico)).toEqual({ recusa: 'risco', detalhe: ['aviso crítico com risco baixo'] });
    expect(conferirExplicacao({ ...boa, risco: 'medio' }, critico)).toBeNull();
    // Em aviso que não é crítico, e na explicação dos resultados, o risco é o que a IA concluiu.
    expect(conferirExplicacao(boa, c)).toBeNull();
    expect(conferirExplicacao({ ...boa, o_que_aconteceu: 'O caixa confirmou 38 pedidos.' }, contexto())).toBeNull();
  });
});
