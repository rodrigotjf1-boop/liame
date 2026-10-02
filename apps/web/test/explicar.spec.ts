import { type AttentionItem, EXPLAINABLE_ATTENTION_KINDS, type ExplanationResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ItemAviso } from '@/components/atencao/item-aviso';
import { BlocoExplicacao } from '@/components/explicar/bloco-explicacao';
import { avisoSemIa, avisoTemExplicacao, AVISOS_COM_EXPLICACAO, discordoValido, MOTIVOS_DO_DISCORDO, seloDoRisco, tituloDasFontes } from '@/components/explicar/textos';
import type { EstadoDaExplicacao } from '@/components/explicar/use-explicacao';
import { AvisosProvider } from '@/components/ui/avisos';

// "Explicar" (A3 · I4; mockups/prototipo-explicar.html, P4): as regras da tela (selo do risco, por que a
// explicação é a do sistema, o "Discordo") e o bloco desenhado em cada estado do protótipo, pelo mesmo
// componente do navegador. O texto e as fontes dos números vêm prontos da API.

const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function resposta(over: Partial<ExplanationResponse> = {}): ExplanationResponse {
  return {
    source: 'lia',
    reason: null,
    explanation: {
      what_happened: [
        { text: 'De 22/09/2026 a 28/09/2026, o ROAS confirmado no caixa foi de ', number: null },
        { text: '2,91', number: 0 },
        { text: '. Foram ', number: null },
        { text: '55', number: 1 },
        { text: ' pedidos e ', number: null },
        { text: 'R$ 3.605,00', number: 2 },
        { text: ' de receita.', number: null },
      ],
      reasons: [
        [
          { text: 'A Combo sexta teve ', number: null },
          { text: '26', number: 3 },
          { text: ' pedidos confirmados no caixa.', number: null },
        ],
      ],
      risk: 'baixo',
      risk_reason: [
        { text: 'a margem conhecida cobre o que foi investido, com ROAS de ', number: null },
        { text: '2,91', number: 0 },
        { text: '.', number: null },
      ],
      what_to_do: [[{ text: 'Mantenha a campanha como está.', number: null }]],
    },
    numbers: [
      { value: '2,91', sources: ['Liame · ROAS confirmado no caixa (receita confirmada ÷ investimento) · calculado pelo sistema'] },
      { value: '55', sources: ['Regem · pedidos confirmados com origem provada em campanha · 22/09/2026 a 28/09/2026 · lido em 29/09/2026 14:05'] },
      {
        value: 'R$ 3.605,00',
        sources: ['Regem · receita confirmada com origem provada em campanha · 22/09/2026 a 28/09/2026 · lido em 29/09/2026 14:05', 'Regem · receita com origem provada · 22/09/2026 a 28/09/2026'],
      },
      { value: '26', sources: ['Regem · pedidos confirmados da campanha Combo sexta · 22/09/2026 a 28/09/2026'] },
    ],
    period: { from: '22/09/2026', to: '28/09/2026' },
    compared_to: { from: '15/09/2026', to: '21/09/2026' },
    stale_sources: [],
    usage_id: uuid(1),
    retry_at: null,
    budget_window: null,
    generated_at: '2026-09-29T17:21:00.000Z',
    ...over,
  };
}
const doSistema = (reason: string, over: Partial<ExplanationResponse> = {}) => resposta({ source: 'sistema', reason, usage_id: null, ...over });

type Aberta = Exclude<EstadoDaExplicacao, { tipo: 'fechada' }>;
const bloco = (estado: Aberta, extra: Partial<Parameters<typeof BlocoExplicacao>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(AvisosProvider, {
      children: createElement(BlocoExplicacao, { id: 'resultados', estado, lia: true, sobre: 'tela', podeVerContas: true, aoFechar: () => {}, aoPedirDeNovo: () => {}, ...extra }),
    }),
  );
const pronta = (r: ExplanationResponse): Aberta => ({ tipo: 'pronta', resposta: r });
const semLixo = (html: string) => {
  expect(html).not.toMatch(/NaN|undefined|\[object Object\]/);
  expect(html).not.toMatch(/>null</);
};

describe('"Explicar": regras da tela', () => {
  it('selo do risco: baixo, médio e alto; valor que a tela não conhece vira médio, nunca baixo (V23)', () => {
    expect(seloDoRisco('baixo')).toEqual({ classe: 'st--concluido', rotulo: 'Risco baixo' });
    expect(seloDoRisco('medio')).toEqual({ classe: 'st--aguardando', rotulo: 'Risco médio' });
    expect(seloDoRisco('alto')).toEqual({ classe: 'st--perigo', rotulo: 'Risco alto' });
    expect(seloDoRisco('critico').rotulo).toBe('Risco médio');
  });

  it('a explicação da LIA não tem aviso; a do sistema diz por quê e o que dá para fazer', () => {
    expect(avisoSemIa(resposta())).toBeNull();
    expect(avisoSemIa(doSistema('desligada'))).toEqual({
      tom: 'neutro',
      icone: 'info',
      titulo: 'A LIA está desligada nesta empresa',
      texto: 'As explicações são montadas pelo sistema, por regra, com os mesmos números.',
      acao: null,
    });
    expect(avisoSemIa(doSistema('funcionario_desligado'))?.titulo).toBe('A LIA está desligada nesta empresa');
    expect(avisoSemIa(doSistema('travada'))).toMatchObject({ titulo: 'A LIA está pausada agora', acao: null });
    expect(avisoSemIa(doSistema('sem_rota'))?.titulo).toBe('A LIA está pausada agora');
    expect(avisoSemIa(doSistema('indisponivel'))).toMatchObject({ icone: 'alert-circle', titulo: 'A LIA não respondeu agora', acao: 'de-novo' });
    expect(avisoSemIa(doSistema('entrada_grande'))?.acao).toBe('de-novo');
    // Motivo novo, que a tela ainda não conhece: o mesmo tratamento de "não respondeu".
    expect(avisoSemIa(doSistema('motivo_do_futuro'))).toMatchObject({ titulo: 'A LIA não respondeu agora', acao: 'de-novo' });
    expect(avisoSemIa(doSistema('conteudo_politico'))).toMatchObject({ titulo: 'A LIA não explica campanha de assunto político ou eleitoral', acao: null });
  });

  it('resposta recusada na conferência: a dos números diz que foi um número; as outras, que o texto não seguiu as regras', () => {
    expect(avisoSemIa(doSistema('numero_fora'))).toEqual({
      tom: 'neutro',
      icone: 'shield',
      titulo: 'A resposta da LIA não passou na conferência dos números',
      texto: 'Ela citou um número que não está nos dados desta tela, então o texto não foi mostrado. Este resumo foi montado pelo sistema.',
      acao: 'de-novo',
    });
    for (const motivo of ['trecho_proibido', 'compliance', 'risco', 'vazia', 'longa']) {
      expect(avisoSemIa(doSistema(motivo)), motivo).toMatchObject({ icone: 'shield', titulo: 'A resposta da LIA não passou na conferência', acao: 'de-novo' });
    }
  });

  it('limite por pessoa e limite de custo: dizem quando a LIA volta', () => {
    const limite = avisoSemIa(doSistema('limite_usuario', { retry_at: '2026-09-29T18:20:00.000Z' }))!;
    expect(limite.titulo).toBe('Você chegou ao limite de explicações por hora');
    expect(limite.texto).toMatch(/^A LIA volta a responder às \d{2}:\d{2}\. Até lá, o resumo é montado pelo sistema com os mesmos números\.$/);
    expect(limite.acao).toBeNull();
    expect(avisoSemIa(doSistema('limite_usuario'))!.texto).toBe('A LIA volta a responder em até uma hora. Até lá, o resumo é montado pelo sistema com os mesmos números.');
    expect(avisoSemIa(doSistema('teto', { budget_window: 'dia' }))).toMatchObject({ titulo: 'O limite de uso de IA de hoje foi atingido', texto: 'A LIA volta a responder amanhã. Até lá, o resumo é montado pelo sistema com os mesmos números.' });
    expect(avisoSemIa(doSistema('teto', { budget_window: 'mes' }))).toMatchObject({ titulo: 'O limite de uso de IA deste mês foi atingido', texto: 'A LIA volta a responder no mês que vem. Até lá, o resumo é montado pelo sistema com os mesmos números.' });
    // Sem saber qual teto: o do dia.
    expect(avisoSemIa(doSistema('teto'))?.titulo).toBe('O limite de uso de IA de hoje foi atingido');
  });

  it('dado velho: diz qual fonte parou e desde quando, e leva à conexão', () => {
    const uma = avisoSemIa(doSistema('dado_velho', { stale_sources: [{ platform: 'Regem', name: 'Loja Centro', freshness: 'atrasado', last_read: '29/09/2026 09:42' }] }))!;
    expect(uma).toEqual({
      tom: 'atencao',
      icone: 'clock',
      titulo: 'A LIA não explica com dado velho',
      texto: 'Regem · Loja Centro: última leitura em 29/09/2026 09:42. Este resumo foi montado pelo sistema com os números que já tinham chegado.',
      acao: 'ver-conexao',
    });
    const duas = avisoSemIa(
      doSistema('dado_velho', {
        stale_sources: [
          { platform: 'Meta', name: 'CA - Hamburgueria', freshness: 'parado', last_read: null },
          { platform: null, name: 'Loja Centro', freshness: 'atrasado', last_read: '29/09/2026 09:42' },
        ],
      }),
    )!;
    expect(duas.texto).toBe('Meta · CA - Hamburgueria: ainda não foi lida; Loja Centro: última leitura em 29/09/2026 09:42. Este resumo foi montado pelo sistema com os números que já tinham chegado.');
    expect(avisoSemIa(doSistema('dado_velho'))!.texto).toMatch(/^Alguma fonte desta tela não está em dia\./);
  });

  it('"Discordo" pede um motivo ou um comentário; os motivos são os do protótipo, na ordem', () => {
    expect(MOTIVOS_DO_DISCORDO.map((m) => [m.valor, m.rotulo])).toEqual([
      ['numero', 'Um número está errado'],
      ['motivo', 'O motivo não é esse'],
      ['faltou', 'Faltou algo importante'],
      ['sugestao', 'A sugestão não serve para a minha loja'],
    ]);
    expect(discordoValido([], '')).toBe(false);
    expect(discordoValido([], '   ')).toBe(false);
    expect(discordoValido(['numero'], '')).toBe(true);
    expect(discordoValido([], 'O gasto foi outro.')).toBe(true);
    expect(tituloDasFontes(5)).toBe('De onde vêm os números (5)');
  });

  it('os avisos com "Explicar" são os do contrato da API, e só com a marca do aviso', () => {
    expect([...AVISOS_COM_EXPLICACAO]).toEqual([...EXPLAINABLE_ATTENTION_KINDS]);
    expect(avisoTemExplicacao({ kind: 'cupom_sem_uso', brand_id: uuid(7) })).toBe(true);
    expect(avisoTemExplicacao({ kind: 'cupom_sem_uso', brand_id: null })).toBe(false);
    expect(avisoTemExplicacao({ kind: 'conta_desconectada', brand_id: uuid(7) })).toBe(false);
    expect(avisoTemExplicacao({ kind: 'tipo_novo', brand_id: uuid(7) })).toBe(false);
  });
});

describe('o bloco da explicação desenhado (o mesmo componente do navegador)', () => {
  it('carregando: a LIA lendo os números, com a nota do que ela recebe; sem a LIA, o resumo sendo montado', () => {
    const html = bloco({ tipo: 'carregando' });
    semLixo(html);
    expect(html).toContain('<article class="card explica" id="exp-resultados" aria-labelledby="exp-t-resultados" aria-busy="true">');
    expect(html).toContain('<h2 id="exp-t-resultados" tabindex="-1">A LIA está lendo os números…</h2>');
    expect(html).toContain('Feito com IA');
    expect(html).toContain('leva alguns segundos');
    expect(html).toContain('A LIA recebe só os números desta tela, já calculados pelo sistema, sem dado pessoal de cliente.');
    expect(html).toContain('aria-label="Fechar a explicação"');

    const neutro = bloco({ tipo: 'carregando' }, { lia: false });
    expect(neutro).toContain('class="card explica explica--sistema"');
    expect(neutro).toContain('Montando o resumo do sistema…');
    expect(neutro).toContain('Sem IA');
    expect(neutro).not.toContain('A LIA recebe');
    expect(neutro).not.toContain('Feito com IA');
  });

  it('resposta da LIA: o texto em trechos, cada número um botão com a fonte, a lista das fontes, o risco com o porquê e o retorno', () => {
    const html = bloco(pronta(resposta()), { acoes: createElement('button', { className: 'btn btn--sm', type: 'button' }, 'Ver por campanha') });
    semLixo(html);
    expect(html).toContain('<h2 id="exp-t-resultados" tabindex="-1">Explicação da LIA</h2>');
    expect(html).toMatch(/Feito com IA<\/span><span>com os números desta tela · [^<]*\d{2}:\d{2}<\/span>/);
    // O número é um botão; quem ouve a tela ouve a fonte junto.
    expect(html).toContain(
      '<button type="button" class="nf" title="Liame · ROAS confirmado no caixa (receita confirmada ÷ investimento) · calculado pelo sistema">2,91<span class="sr-only">, fonte: Liame · ROAS confirmado no caixa (receita confirmada ÷ investimento) · calculado pelo sistema</span></button>',
    );
    expect(html.match(/class="nf"/g)).toHaveLength(5);
    // "De onde vêm os números": uma linha por número; mais de um lugar, mais de uma fonte.
    expect(html).toContain('De onde vêm os números (4)');
    expect(html).toContain(
      '<dt>R$ 3.605,00</dt><dd>Regem · receita confirmada com origem provada em campanha · 22/09/2026 a 28/09/2026 · lido em 29/09/2026 14:05</dd><dd>Regem · receita com origem provada · 22/09/2026 a 28/09/2026</dd>',
    );
    expect(html.match(/<dt>/g)).toHaveLength(4);
    // Formato fixo: o que aconteceu, motivos, risco com o porquê, o que fazer e as ações (só de navegação).
    expect(html).toContain('<h3>Motivos</h3>');
    expect(html).toContain('<h3>O que fazer</h3>');
    expect(html).toContain('<span class="st st--concluido"><span class="dot" aria-hidden="true"></span>Risco baixo</span><span>a margem conhecida cobre o que foi investido, com ROAS de <button');
    expect(html).toContain('<div class="explica-acoes"><button class="btn btn--sm" type="button">Ver por campanha</button></div>');
    // Rodapé da LIA: ela é uma IA, o caminho para uma pessoa e o retorno.
    expect(html).toContain('A LIA é uma assistente de IA: ela só escreve. Os números são do sistema, conferidos antes de aparecer, e a decisão é sua.');
    expect(html).toContain('href="mailto:suporte@agencialiame.com?subject=');
    expect(html).toContain('>Falar com uma pessoa</a>');
    expect(html).toContain('role="group" aria-label="Esta explicação fez sentido?"');
    expect(html).toMatch(/aria-pressed="false"[^>]*>.*?Fez sentido<\/button>/);
    expect(html).toMatch(/aria-expanded="false" aria-controls="disc-resultados">.*?Discordo<\/button>/);
    // O formulário do "Discordo" nasce fechado, com os quatro motivos, o campo livre e o erro escondido.
    expect(html).toContain('<form class="discordar" id="disc-resultados" noValidate="" hidden="">');
    expect(html.match(/type="checkbox" name="motivo"/g)).toHaveLength(4);
    expect(html).toContain('maxLength="500"');
    expect(html).toContain('Opcional. Não escreva nome, telefone nem outro dado de cliente.');
    expect(html).toContain('<p class="campo-erro" role="alert" hidden="">Marque pelo menos um motivo ou escreva o que houve.</p>');
    expect(html).not.toContain('explica-aviso');
    expect(html).not.toContain('Nenhuma IA escreveu este texto.');
  });

  it('resumo do sistema: em cinza, com "Sem IA", o motivo e sem o retorno', () => {
    const html = bloco(pronta(doSistema('desligada')), { lia: false });
    semLixo(html);
    expect(html).toContain('<article class="card explica explica--sistema" id="exp-resultados" aria-labelledby="exp-t-resultados">');
    expect(html).toContain('<h2 id="exp-t-resultados" tabindex="-1">Resumo do sistema</h2>');
    expect(html).toContain('<span class="st st--espera">Sem IA</span><span>montado por regra, com os números desta tela</span>');
    expect(html).toContain('<div class="explica-aviso explica-aviso--neutro" role="status">');
    expect(html).toContain('<b>A LIA está desligada nesta empresa</b>As explicações são montadas pelo sistema, por regra, com os mesmos números.');
    expect(html).toContain('Resumo montado pelo sistema, por regra, com os mesmos números. Nenhuma IA escreveu este texto.');
    // Os números continuam com a fonte: quem diz a fonte é o sistema, não a IA.
    expect(html).toContain('De onde vêm os números (4)');
    expect(html).not.toContain('Fez sentido');
    expect(html).not.toContain('Feito com IA');
    expect(html).not.toContain('Falar com uma pessoa');
    expect(html).not.toContain('Tentar de novo com a LIA');
  });

  it('dado velho leva à conexão (só para quem vê as contas); LIA fora do ar e resposta recusada oferecem tentar de novo', () => {
    const velho = doSistema('dado_velho', { stale_sources: [{ platform: 'Regem', name: 'Loja Centro', freshness: 'atrasado', last_read: '29/09/2026 09:42' }] });
    const comContas = bloco(pronta(velho));
    expect(comContas).toContain('<div class="explica-aviso" role="status">');
    expect(comContas).toContain('<b>A LIA não explica com dado velho</b>Regem · Loja Centro: última leitura em 29/09/2026 09:42.');
    expect(comContas).toContain('<a class="btn btn--sm" href="/contas">Ver a conexão</a>');
    expect(bloco(pronta(velho), { podeVerContas: false })).not.toContain('Ver a conexão');

    const foraDoAr = bloco(pronta(doSistema('indisponivel')));
    expect(foraDoAr).toContain('<b>A LIA não respondeu agora</b>');
    expect(foraDoAr).toContain('Tentar de novo com a LIA</button>');
    const recusada = bloco(pronta(doSistema('numero_fora')));
    expect(recusada).toContain('<b>A resposta da LIA não passou na conferência dos números</b>');
    expect(recusada).toContain('Tentar de novo com a LIA</button>');
    // Limite e teto não têm o que tentar: só a hora em que a LIA volta.
    expect(bloco(pronta(doSistema('teto', { budget_window: 'dia' })))).not.toContain('Tentar de novo');
  });

  it('dentro de um aviso: sem moldura de cartão, com os títulos um nível abaixo e o texto "deste aviso"', () => {
    const html = bloco(pronta(resposta()), { id: 'aviso-1', sobre: 'aviso', nivel: 3, solto: true });
    semLixo(html);
    expect(html).toContain('<div class="explica" id="exp-aviso-1" aria-labelledby="exp-t-aviso-1">');
    expect(html).toContain('<h3 id="exp-t-aviso-1" tabindex="-1">Explicação da LIA</h3>');
    expect(html).toContain('<h4>Motivos</h4>');
    expect(html).toContain('com os números deste aviso · ');
    expect(html).toContain('aria-controls="disc-aviso-1"');
    expect(bloco({ tipo: 'carregando' }, { id: 'aviso-1', sobre: 'aviso', nivel: 3, solto: true })).toContain('A LIA recebe só os números deste aviso, já calculados pelo sistema');
  });

  it('a chamada falhou (rede, erro do servidor): o bloco diz o que houve e oferece tentar de novo, sem selo de IA nenhum', () => {
    const html = bloco({ tipo: 'erro', problema: { status: 0, code: 'sem-conexao', title: 'Sem conexão', detail: 'Não conseguimos falar com o Liame. Confira a internet e tente de novo.' } });
    semLixo(html);
    expect(html).toContain('<h2 id="exp-t-resultados" tabindex="-1">Não deu para montar a explicação</h2><p><span>nada foi perdido</span></p>');
    expect(html).toContain('<div class="explica-aviso explica-aviso--neutro" role="alert">');
    expect(html).toContain('Não conseguimos falar com o Liame. Confira a internet e tente de novo.');
    expect(html).toContain('Tentar de novo</button>');
    // Não há explicação nenhuma na tela: nem "Feito com IA", nem "Sem IA".
    expect(html).not.toContain('Feito com IA');
    expect(html).not.toContain('Sem IA');
  });

  it('o aviso saiu da lista com a tela aberta: o bloco diz isso e oferece atualizar os avisos, não tentar de novo', () => {
    const sumiu = { tipo: 'erro', problema: { status: 404, code: 'aviso-nao-encontrado', title: 'Este aviso não está mais ativo', detail: 'Atualize a tela para ver os avisos de agora.' } } as const;
    const html = bloco(sumiu, { id: 'aviso-1', sobre: 'aviso', nivel: 3, solto: true, aoAtualizar: () => {} });
    semLixo(html);
    expect(html).toContain('<h3 id="exp-t-aviso-1" tabindex="-1">Este aviso não está mais ativo</h3><p><span>a lista mudou com a tela aberta</span></p>');
    expect(html).toContain('Atualize a tela para ver os avisos de agora.');
    expect(html).toContain('Atualizar os avisos</button>');
    expect(html).not.toContain('Tentar de novo');
    // Sem ter como atualizar a lista (o bloco fora de um aviso), vale o caminho comum.
    const semLista = bloco(sumiu);
    expect(semLista).toContain('Não deu para montar a explicação');
    expect(semLista).toContain('Tentar de novo</button>');
  });

  it('número sem linha na lista de fontes fica como texto: nenhum botão que não leva a lugar nenhum', () => {
    const r = resposta();
    r.explanation.what_to_do = [[{ text: 'Reveja ', number: null }, { text: '99', number: 7 }, { text: ' anúncios.', number: null }]];
    const html = bloco(pronta(r));
    expect(html).toContain('<li>Reveja 99 anúncios.</li>');
  });
});

describe('"Explicar" em um aviso da Atenção', () => {
  const aviso = (o: Partial<AttentionItem> = {}): AttentionItem => ({
    kind: 'cupom_sem_uso',
    severity: 'atencao',
    title: 'O cupom SMASH10 não teve nenhum uso em 7 dias',
    detail: 'Ele é o cupom exclusivo da campanha "Smash em dobro", que gastou R$ 279,80 no período (Meta).',
    action: 'Confira se o código aparece no anúncio e na conversa do WhatsApp.',
    connected_account_id: uuid(20),
    campaign_id: uuid(21),
    provider: 'meta_ads',
    brand_id: uuid(7),
    ...o,
  });
  const cartao = (item: AttentionItem, explicar: { lia: boolean } | null) =>
    renderToStaticMarkup(createElement(ItemAviso, { item, podeVerContas: true, podeConectar: true, podeVerVendas: true, aoReconectar: () => {}, explicar }));

  it('o botão vem primeiro na linha de ações do aviso, antes do botão da tela; fechado, sem o bloco', () => {
    const html = cartao(aviso(), { lia: true });
    semLixo(html);
    expect(html).toContain('<div class="aviso-acoes"><button class="ia-bt" type="button" aria-expanded="false" aria-label="Explicar: O cupom SMASH10 não teve nenhum uso em 7 dias">');
    expect(html).toMatch(/Explicar<\/button><a class="btn btn--sm" href="\/links#cupons">Abrir os cupons<\/a><\/div>/);
    expect(html).not.toContain('class="explica');
    expect(cartao(aviso(), { lia: false })).toContain('<button class="ia-bt ia-bt--neutro" type="button"');
  });

  it('sem "Explicar" para o aviso que não tem (a tela não manda `explicar`) e para o aviso sem marca', () => {
    expect(cartao(aviso(), null)).not.toContain('ia-bt');
    expect(cartao(aviso({ brand_id: null }), { lia: true })).not.toContain('ia-bt');
    // O aviso continua com a ação dele.
    expect(cartao(aviso(), null)).toContain('<div class="aviso-acoes"><a class="btn btn--sm" href="/links#cupons">Abrir os cupons</a></div>');
    // Aviso sem ação nenhuma não ganha a linha vazia.
    expect(cartao(aviso({ kind: 'gasto_fora_do_normal' }), null)).not.toContain('aviso-acoes');
    expect(cartao(aviso({ kind: 'gasto_fora_do_normal' }), { lia: true })).toMatch(/<div class="aviso-acoes"><button class="ia-bt"[^>]*>.*?Explicar<\/button><\/div>/);
  });
});
