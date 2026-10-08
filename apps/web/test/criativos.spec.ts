import type { AdPieceOptionsResponse, AdPieceRequestResponse, AdPieceResponse, AdPieceReview, AdPieceVersion } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CriativosLista } from '@/components/criativos/lista';
import { PecaAberta } from '@/components/criativos/peca';
import { DialogoPedirPeca } from '@/components/criativos/pedir-peca';
import {
  anuncioNoPedido,
  avisoDaVersaoNova,
  avisoDoPedidoPronto,
  avisosDaTela,
  botaoEscrito,
  cabecalhoDaPeca,
  contagem,
  custoDaPeca,
  custoDeOutraVersao,
  ehBarrada,
  erroDaPeca,
  estimativaDoPedido,
  itensDaConferencia,
  motivoDeNaoPedir,
  motivoDeNaoRefazer,
  nomeDoCartao,
  ofertaNoPedido,
  origemDaPeca,
  paraDecidir,
  pecasFaladas,
  pedidoEmAndamento,
  pedidoQueNaoDeuCerto,
  podeAprovar,
  resultadoDaPeca,
  resumoDaConferencia,
  rotuloDaVersao,
  situacaoDaPeca,
  textoMarcado,
  usoDeIa,
  variacoesDoPedido,
} from '@/components/criativos/textos';
import { Fontes, textoCorrido } from '@/components/resumo/textos';
import { itensVisiveis, NAVEGACAO, temModos, tituloDa } from '@/components/shell/navegacao';

// Criativos (A4 · X8, parte 6; mockups/prototipo-criativos.html, P10 aprovado em 05/10/2026), na entrega do texto: o
// que `/v1/ad-pieces` e `/v1/ad-pieces/options` mandam vira o que a pessoa lê. Quem confere a peça é o servidor.

// Os instantes saem do relógio local: a tela escreve a hora no fuso de quem lê (ERR-116).
const AGORA = new Date(2026, 9, 8, 15, 0);
const local = (h: number, m = 0, d = 8) => new Date(2026, 9, d, h, m).toISOString();
const nbsp = (s: string) => s.replaceAll('R$ ', `R$${String.fromCharCode(160)}`).replaceAll('US$ ', `US$${String.fromCharCode(160)}`);
const uuid = (n: number) => `a0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const hash = (n: number) => String(n).padStart(64, '0');
const texto = (f: Array<{ t: string }>) => f.map((x) => x.t).join('');
const semTags = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const RODRIGO = { id: uuid(9), name: 'Rodrigo' };
const PTAX = { rate: '5.0000', date: '2026-10-07', source: 'bcb_ptax_venda' };
const OFERTA = 'Combo sexta: smash, batata e refri por R$ 34,90';

const conferencia = (over: Partial<AdPieceReview> = {}): AdPieceReview => ({
  status: 'passou',
  items: [
    { item: 'oferta', status: 'passou', findings: [] },
    { item: 'regras_da_liame', status: 'passou', findings: [] },
    { item: 'regras_da_marca', status: 'passou', findings: [] },
    { item: 'tamanho', status: 'passou', findings: [] },
  ],
  cites_value: true,
  characters: { title: 20, body: 96 },
  recommended: { title: 27, body: 125 },
  ...over,
});
const BARRADA = conferencia({
  status: 'barrou',
  items: [
    { item: 'oferta', status: 'passou', findings: [] },
    { item: 'regras_da_liame', status: 'passou', findings: [] },
    { item: 'regras_da_marca', status: 'barrou', findings: [{ kind: 'regra_da_marca', field: 'texto', excerpt: 'entrega em 20 minutos' }] },
    { item: 'tamanho', status: 'passou', findings: [] },
  ],
});
const COM_AVISO = conferencia({
  status: 'aviso',
  items: [
    { item: 'oferta', status: 'passou', findings: [] },
    { item: 'regras_da_liame', status: 'passou', findings: [] },
    { item: 'regras_da_marca', status: 'passou', findings: [] },
    { item: 'tamanho', status: 'aviso', findings: [{ kind: 'acima_do_recomendado', field: 'titulo', excerpt: '' }] },
  ],
  characters: { title: 34, body: 171 },
});
const versao = (over: Partial<AdPieceVersion> = {}): AdPieceVersion => ({
  version: 1,
  title: 'Sexta é dia de combo',
  body: 'Smash, batata e refri por R$ 34,90. Peça pelo cardápio e receba em casa ou retire na Loja Centro.',
  button: 'pedir_agora',
  review: conferencia(),
  content_hash: hash(1),
  author: 'criativo',
  cost_usd_micros: '4000',
  created_by: null,
  created_at: local(14, 10),
  ...over,
});
const peca = (n: number, over: Partial<AdPieceResponse> = {}): AdPieceResponse => ({
  id: uuid(100 + n),
  brand_id: uuid(1),
  request_id: uuid(50),
  status: 'decidir',
  offer: OFERTA,
  destination: 'cardapio',
  ai_generated: true,
  redoing: false,
  current: versao({ content_hash: hash(n) }),
  decided_by: null,
  decided_at: null,
  created_at: local(14, 10),
  updated_at: local(14, 10),
  ...over,
});
const passou = peca(1);
const comAviso = peca(2, { current: versao({ title: 'Combo sexta: smash, batata e refri', review: COM_AVISO, content_hash: hash(2) }) });
const barrada = peca(3, { current: versao({ title: 'Seu combo em casa hoje', body: 'Combo sexta por R$ 34,90, com entrega em 20 minutos. Peça agora pelo cardápio.', review: BARRADA, content_hash: hash(3) }) });
const aprovada = peca(4, { status: 'aprovada', decided_by: RODRIGO, decided_at: local(14, 40) });
const recusada = peca(5, {
  status: 'recusada',
  decided_by: RODRIGO,
  decided_at: local(14, 41),
  decisions: [{ decision: 'recusada', version: 1, reason: 'nao_parece_a_marca', comment: null, decided_by: RODRIGO, created_at: local(14, 41) }],
});
const refazendo = peca(6, { redoing: true });

const pedido = (over: Partial<AdPieceRequestResponse> = {}): AdPieceRequestResponse => ({
  id: uuid(50),
  brand_id: uuid(1),
  kind: 'texto',
  offer: OFERTA,
  dossier_version: 3,
  destination: 'cardapio',
  variations: 3,
  instruction: null,
  reference: { ad_id: uuid(70), name: 'Combo sexta · carrossel' },
  piece_id: null,
  status: 'concluido',
  reason: null,
  pieces: 3,
  requested_by: RODRIGO,
  created_at: local(14, 9),
  finished_at: local(14, 10),
  ...over,
});
const IA: NonNullable<AdPieceOptionsResponse['ai']> = {
  band: 'livre',
  day: { spent_usd_micros: '1498000', ceiling_usd_micros: '4000000' },
  month: { spent_usd_micros: '9000000', ceiling_usd_micros: '60000000' },
  remaining_usd_micros: '2502000',
  binding: 'dia',
  pieces_today_usd_micros: '258000',
  request_estimate: { usd_micros: '10000', basis: 'historico', sample: 6 },
  fits: true,
};
const opcoes = (over: Partial<AdPieceOptionsResponse> = {}): AdPieceOptionsResponse => ({
  brand_id: uuid(1),
  available: true,
  reason: null,
  ai: IA,
  usd_brl: PTAX,
  dossier_version: 3,
  offers: [
    { text: OFERTA, has_value: true, problems: [] },
    { text: 'Milk-shake da casa, 400 ml', has_value: false, problems: [] },
    { text: 'Chope em dobro às quintas', has_value: false, problems: [{ reason: 'bebida_alcoolica', excerpt: 'Chope' }] },
  ],
  reference_ads: [
    { ad_id: uuid(70), name: 'Combo sexta · carrossel', campaign: 'Combo sexta', orders: 27 },
    { ad_id: uuid(71), name: 'Smash em dobro · vídeo', campaign: 'Smash em dobro', orders: 1 },
  ],
  reference_period: { from: '2026-10-01', to: '2026-10-07' },
  limits: { variations_min: 1, variations_max: 4, instruction_max: 300 },
  in_progress: null,
  ...over,
});

describe('a conferência de cada peça', () => {
  it('o resumo: passou em todas, passou com aviso ou foi barrada', () => {
    expect(resumoDaConferencia(conferencia())).toEqual({ situacao: 'ok', classe: 'st st--concluido', icone: 'check', texto: 'Passou nas 4 conferências', curto: 'Passou na conferência' });
    expect(resumoDaConferencia(COM_AVISO)).toMatchObject({ situacao: 'aviso', texto: 'Passou em 3 conferências e tem 1 aviso', curto: 'Passou, com aviso' });
    expect(resumoDaConferencia(BARRADA)).toMatchObject({ situacao: 'falha', classe: 'st st--perigo', texto: 'Barrada em 1 de 4 conferências', curto: 'Barrada pelo Compliance' });
    expect([ehBarrada(barrada), ehBarrada(passou), podeAprovar(passou), podeAprovar(comAviso), podeAprovar(barrada), podeAprovar(refazendo), podeAprovar(aprovada)]).toEqual([true, false, true, true, false, false, false]);
  });

  it('item por item, com o motivo: o preço da oferta, as regras da Liame, as da marca e o tamanho', () => {
    expect(itensDaConferencia(conferencia(), OFERTA, 'Mister Burgers')).toEqual([
      { chave: 'oferta', situacao: 'ok', titulo: 'O preço é o da oferta', texto: 'O valor que o texto cita é o da oferta, como está em Minha marca.' },
      { chave: 'regras_da_liame', situacao: 'ok', titulo: 'Segue as regras da Liame e das plataformas', texto: 'Sem promessa de resultado, sem política e sem categoria que as plataformas proíbem.' },
      { chave: 'regras_da_marca', situacao: 'ok', titulo: 'Segue as regras da Mister Burgers', texto: 'Nada do que Minha marca manda não dizer.' },
      { chave: 'tamanho', situacao: 'ok', titulo: 'Cabe no tamanho que a Meta recomenda', texto: 'Título com 20 de 27 caracteres e texto principal com 96 de 125.' },
    ]);
    expect(itensDaConferencia(conferencia({ cites_value: false }), OFERTA, 'Mister Burgers')[0]!.texto).toBe('O texto não cita preço.');
    expect(itensDaConferencia(BARRADA, OFERTA, 'Mister Burgers')[2]).toEqual({ chave: 'regras_da_marca', situacao: 'falha', titulo: 'Diz o que a Mister Burgers não diz', texto: 'O texto traz “entrega em 20 minutos”.' });
    expect(itensDaConferencia(COM_AVISO, OFERTA, 'Mister Burgers')[3]).toEqual({
      chave: 'tamanho',
      situacao: 'aviso',
      titulo: 'Passa do tamanho que a Meta recomenda',
      texto: 'O título tem 34 caracteres, e a Meta recomenda até 27; o texto principal tem 171, e a Meta recomenda até 125. É recomendação, não regra: dá para aprovar assim, editar ou pedir outra.',
    });
    const preco = conferencia({ status: 'barrou', items: [{ item: 'oferta', status: 'barrou', findings: [{ kind: 'preco_fora', field: 'texto', excerpt: 'R$ 29,90' }] }, { item: 'regras_da_liame', status: 'barrou', findings: [{ kind: 'promessa_de_resultado', field: 'titulo', excerpt: 'o melhor da cidade' }] }] });
    expect(itensDaConferencia(preco, OFERTA, 'Mister Burgers')).toEqual([
      { chave: 'oferta', situacao: 'falha', titulo: 'O texto diz o que a oferta não diz', texto: `O texto traz o preço “R$ 29,90”, que não está na oferta. Em Minha marca, ela é “${OFERTA}”.` },
      { chave: 'regras_da_liame', situacao: 'falha', titulo: 'Bate numa regra da Liame para anúncios', texto: 'O texto tem promessa de resultado (“o melhor da cidade”).' },
    ]);
    // O item que a tela ainda não conhece aparece pelo nome, sem inventar frase.
    expect(itensDaConferencia(conferencia({ items: [{ item: 'item_novo', status: 'aviso', findings: [] }] }), OFERTA, 'X')[0]).toMatchObject({ situacao: 'aviso', titulo: 'Item novo' });
  });

  it('o trecho que barrou fica em destaque no campo certo; a contagem avisa quando passa do recomendado', () => {
    expect(textoMarcado(barrada.current.body, 'texto', BARRADA)).toEqual([
      { t: 'Combo sexta por R$ 34,90, com ', marcado: false },
      { t: 'entrega em 20 minutos', marcado: true },
      { t: '. Peça agora pelo cardápio.', marcado: false },
    ]);
    expect(textoMarcado(barrada.current.title, 'titulo', BARRADA)).toEqual([{ t: 'Seu combo em casa hoje', marcado: false }]);
    expect(textoMarcado('Sem regra', 'texto', conferencia())).toEqual([{ t: 'Sem regra', marcado: false }]);
    expect(contagem(20, 27)).toEqual({ texto: '20 de 27 caracteres', acima: false });
    expect(contagem(34, 27)).toEqual({ texto: '34 de 27 caracteres (acima do recomendado)', acima: true });
    expect([botaoEscrito('pedir_agora'), botaoEscrito('enviar_mensagem'), botaoEscrito('botao_novo')]).toEqual(['Pedir agora', 'Enviar mensagem', 'botao novo']);
  });
});

describe('a lista: o que espera decisão e a biblioteca', () => {
  it('a situação de cada peça e o nome do cartão', () => {
    expect([passou, barrada, refazendo, aprovada, recusada].map((p) => situacaoDaPeca(p))).toEqual([
      { classe: 'st st--aguardando', rotulo: 'Para decidir' },
      { classe: 'st st--perigo', rotulo: 'Barrada' },
      { classe: 'st st--ia', rotulo: 'Fazendo a versão 2' },
      { classe: 'st st--concluido', rotulo: 'Aprovada' },
      { classe: 'st st--espera', rotulo: 'Recusada' },
    ]);
    expect(nomeDoCartao(barrada)).toBe(`Abrir a peça “Seu combo em casa hoje”, de ${OFERTA}: barrada`);
  });

  it('"Para decidir": quantas passaram, quantas foram barradas e o que fazer', () => {
    const d = paraDecidir([passou, comAviso, barrada, aprovada], true)!;
    expect(texto(d.frase)).toBe('2 peças passaram na conferência e 1 foi barrada. Abra cada uma e decida. Aprovar guarda a peça na biblioteca; nada vai para a Meta agora.');
    expect([d.passam.map((p) => p.id), d.barradas]).toEqual([[passou.id, comAviso.id], 1]);
    expect(d.confirmacao).toBe('Aprovar as 2 peças que passaram na conferência? Elas vão para a biblioteca. A que tem aviso de tamanho entra junto. Nada vai para a Meta.');
    expect(texto(paraDecidir([passou], false)!.frase)).toBe('1 peça passou na conferência. Quem opera campanhas decide cada uma.');
    expect(texto(paraDecidir([barrada], true)!.frase)).toBe('A peça que resta foi barrada na conferência. Abra, veja o motivo e edite o texto, peça outra versão ou recuse.');
    expect(texto(paraDecidir([refazendo], true)!.frase)).toBe('O Criativo está fazendo uma versão nova. Ela aparece aqui quando passar pelo Compliance.');
    expect(paraDecidir([aprovada, recusada], true)).toBeNull();
    expect(avisoDoPedidoPronto([passou, comAviso, barrada])).toBe('As peças estão prontas: 2 passaram na conferência e 1 foi barrada.');
    expect(avisoDoPedidoPronto([passou])).toBe('As peças estão prontas: 1 passou na conferência.');
  });
});

describe('o uso de IA e o custo, à vista', () => {
  it('o uso do dia (ou do mês, quando é ele que aperta), com a fonte de cada número', () => {
    const fontes = new Fontes();
    const u = usoDeIa(IA, PTAX, fontes);
    expect(textoCorrido(u.texto)).toBe(nbsp('Uso de IA hoje: R$ 7,49 de R$ 20,00. As peças de hoje custaram R$ 1,29.'));
    expect([u.porcento, u.cheio, fontes.lista.length]).toEqual([37, false, 2]);
    expect(fontes.lista[0]!.fonte).toContain('uso de IA da empresa hoje');
    const doMes = usoDeIa({ ...IA, binding: 'mes', month: { spent_usd_micros: '60000000', ceiling_usd_micros: '60000000' }, remaining_usd_micros: '0', pieces_today_usd_micros: '0' }, PTAX, new Fontes());
    expect(textoCorrido(doMes.texto)).toBe(nbsp('Uso de IA no mês: R$ 300,00 de R$ 300,00.'));
    expect([doMes.porcento, doMes.cheio]).toEqual([100, true]);
    // Sem cotação, o valor aparece em dólar, que é como ele é medido.
    expect(textoCorrido(usoDeIa({ ...IA, pieces_today_usd_micros: '0' }, null, new Fontes()).texto)).toBe(nbsp('Uso de IA hoje: US$ 1,50 de US$ 4,00.'));
  });

  it('a estimativa do pedido, o custo de pedir outra e o custo de cada versão', () => {
    expect(estimativaDoPedido(IA, PTAX, 3)).toBe(nbsp('Estimativa: cerca de R$ 0,05 (3 textos e a conferência de cada peça). Hoje a empresa usou R$ 7,49 de R$ 20,00 do limite de IA.'));
    expect(estimativaDoPedido({ ...IA, request_estimate: { usd_micros: '30000', basis: 'teto_da_rota', sample: 0 } }, PTAX, 1)).toContain(nbsp('até R$ 0,15 (1 texto e a conferência de cada peça)'));
    expect(estimativaDoPedido({ ...IA, request_estimate: null }, PTAX, 3)).toBeNull();
    expect(estimativaDoPedido(null, PTAX, 3)).toBeNull();
    expect(custoDeOutraVersao(IA, PTAX)).toBe(nbsp('Custa cerca de R$ 0,05 e entra no limite de IA da empresa. A versão nova passa pelo Compliance antes de aparecer.'));
    expect(custoDeOutraVersao(null, null)).toBe('Entra no limite de IA da empresa. A versão nova passa pelo Compliance antes de aparecer.');
    const editada = versao({ version: 2, author: 'pessoa', cost_usd_micros: null, created_by: RODRIGO, created_at: local(14, 30) });
    const comDuas = peca(7, { current: editada, versions: [editada, versao()] });
    expect(custoDaPeca(comDuas, editada, PTAX)).toMatchObject({ linhas: [{ rotulo: 'Esta versão (texto escrito por uma pessoa)', valor: 'sem custo de IA' }], total: nbsp('As 2 versões desta peça custaram R$ 0,02 em IA.') });
    expect(custoDaPeca(passou, passou.current, PTAX)).toMatchObject({ linhas: [{ rotulo: 'Esta versão (texto do Criativo)', valor: nbsp('R$ 0,02') }], total: null });
  });
});

describe('o que impede de pedir, e o pedido', () => {
  it('o motivo de o botão não pedir, e as faixas do topo', () => {
    expect(motivoDeNaoPedir(opcoes())).toBeNull();
    const motivo = (reason: string) => motivoDeNaoPedir(opcoes({ available: false, reason }));
    expect(motivo('criativo_desligado')).toBe('O Criativo não está ligado para esta empresa: quem liga é a Liame, a pedido do dono.');
    expect(motivo('lote_em_andamento')).toBe('O Criativo ainda está fazendo o pedido anterior. Espere ele terminar para pedir outro.');
    expect(motivo('sem_oferta')).toContain('Minha marca ainda não tem oferta');
    expect(motivo('motivo_novo')).toBe('Não dá para pedir uma peça agora.');
    expect(avisosDaTela(opcoes(), true)).toEqual([]);
    expect(avisosDaTela(opcoes({ available: false, reason: 'criativo_desligado', ai: null, usd_brl: null }), true).map((a) => a.titulo)).toEqual(['O Criativo não está ligado nesta empresa']);
    const limite = avisosDaTela(opcoes({ available: false, reason: 'limite_de_ia', ai: { ...IA, fits: false, remaining_usd_micros: '0' } }), true)[0]!;
    expect([limite.titulo, limite.texto]).toEqual([nbsp('O limite de uso de IA de hoje foi atingido (R$ 20,00)'), 'Dá para aprovar, editar e recusar as peças que já existem. Pedir peça nova volta amanhã, ou quando o limite da empresa for revisto.']);
    expect(avisosDaTela(opcoes({ available: false, reason: 'sem_dossie' }), true)[0]).toMatchObject({ titulo: 'Minha marca ainda não foi preenchida', link: { href: '/marca', rotulo: 'Abrir Minha marca' } });
    // Quem só acompanha vê a faixa dele, junto com as outras.
    expect(avisosDaTela(opcoes(), false).map((a) => a.chave)).toEqual(['leitor']);
    // Pedir outra versão: um pedido novo na fila não impede; o Criativo desligado e o limite, sim.
    expect(motivoDeNaoRefazer(opcoes({ available: false, reason: 'lote_em_andamento' }))).toBeNull();
    expect(motivoDeNaoRefazer(opcoes({ available: false, reason: 'criativo_desligado' }))).toContain('O Criativo não está ligado');
    expect(motivoDeNaoRefazer(opcoes({ ai: { ...IA, fits: false } }))).toContain('O limite de uso de IA');
  });

  it('as ofertas, os anúncios de referência e as quantidades do pedido', () => {
    const o = opcoes();
    expect(o.offers.map(ofertaNoPedido)).toEqual([
      { texto: OFERTA, impedida: null, semPreco: false },
      { texto: 'Milk-shake da casa, 400 ml', impedida: null, semPreco: true },
      { texto: 'Chope em dobro às quintas', impedida: 'Esta oferta não vai ao Criativo: bebida alcoólica (o Criativo não escreve anúncio de bebida alcoólica nesta fase).', semPreco: true },
    ]);
    expect(o.reference_ads.map(anuncioNoPedido)).toEqual(['Combo sexta · carrossel · 27 pedidos em 7 dias', 'Smash em dobro · vídeo · 1 pedido em 7 dias']);
    expect(variacoesDoPedido(o.limits)).toEqual([2, 3, 4]);
    expect(variacoesDoPedido({ variations_min: 1, variations_max: 2, instruction_max: 300 })).toEqual([2]);
  });

  it('o pedido que o Criativo está fazendo, e o que não deu certo', () => {
    const naFila = pedidoEmAndamento(pedido({ status: 'pendente', pieces: 0, finished_at: null, instruction: 'fale da retirada' }), AGORA);
    expect([naFila.titulo, naFila.sub]).toEqual([`O Criativo está fazendo 3 peças para “${OFERTA}”`, 'Pedido por Rodrigo hoje, 14:09 · “fale da retirada”']);
    expect(naFila.passos.map((s) => [s.situacao, s.titulo, s.sub])).toEqual([
      ['agora', 'Ler o anúncio de referência e Minha marca', 'na fila · “Combo sexta · carrossel” e a versão 3 de Minha marca'],
      ['depois', 'Escrever 3 textos', 'título, texto principal e botão'],
      ['depois', 'Compliance: conferir cada peça', 'só então elas aparecem para você'],
    ]);
    const gerando = pedidoEmAndamento(pedido({ status: 'gerando', variations: 1, reference: null, pieces: 0, finished_at: null }), AGORA);
    expect(gerando.passos.map((s) => [s.situacao, s.titulo, s.sub])).toEqual([
      ['ok', 'Ler Minha marca', 'feito'],
      ['agora', 'Escrever 1 texto', 'agora · título, texto principal e botão'],
      ['depois', 'Compliance: conferir cada peça', 'só então elas aparecem para você'],
    ]);
    expect(pedidoQueNaoDeuCerto(pedido({ status: 'falhou', reason: 'ia_fora_do_ar', pieces: 0 }), AGORA)).toMatchObject({ tipo: 'perigo', aviso: 'O pedido falhou: a IA não respondeu', texto: 'Nenhuma peça foi feita. Peça de novo em alguns minutos.' });
    expect(pedidoQueNaoDeuCerto(pedido({ status: 'recusado', reason: 'bebida_alcoolica', pieces: 0 }), AGORA)).toMatchObject({
      tipo: 'atencao',
      aviso: 'O Criativo não fez este pedido: a oferta ou a instrução cita bebida alcoólica, e o Criativo não escreve anúncio de bebida alcoólica nesta fase',
    });
    // O pedido que deu certo, e o "pedir outra" de uma peça (que aparece na própria peça), não viram cartão.
    expect(pedidoQueNaoDeuCerto(pedido(), AGORA)).toBeNull();
    expect(pedidoQueNaoDeuCerto(pedido({ status: 'falhou', piece_id: uuid(101) }), AGORA)).toBeNull();
  });
});

describe('a peça aberta', () => {
  it('o cabeçalho, o resultado e os avisos de cada situação', () => {
    expect(cabecalhoDaPeca(comAviso, comAviso.current, AGORA)).toEqual({
      quem: 'Criativo',
      quando: `hoje, 14:10 · para “${OFERTA}”`,
      chips: [
        { classe: 'st st--aguardando', rotulo: 'Passou, com aviso' },
        { classe: 'st st--aguardando', rotulo: 'Para decidir' },
      ],
      versao: 'versão 1',
    });
    expect(cabecalhoDaPeca(barrada, barrada.current, AGORA).chips).toEqual([{ classe: 'st st--perigo', rotulo: 'Barrada pelo Compliance' }]);
    expect(resultadoDaPeca(passou, passou.current, AGORA, true, 'Mister Burgers')).toBeNull();
    expect(resultadoDaPeca(refazendo, refazendo.current, AGORA, true, 'Mister Burgers')).toMatchObject({ tom: 'espera', forte: 'O Criativo está fazendo a versão 2.' });
    expect(resultadoDaPeca(aprovada, aprovada.current, AGORA, true, 'Mister Burgers')).toEqual({
      tom: 'ok',
      icone: 'check',
      forte: 'Aprovada por Rodrigo hoje, 14:40 (versão 1).',
      texto: ' Está na biblioteca. Nada foi para a Meta: criar a campanha com a peça chega numa próxima fase.',
    });
    expect(resultadoDaPeca(recusada, recusada.current, AGORA, true, 'Mister Burgers')).toEqual({
      tom: 'neutro',
      icone: 'x',
      forte: 'Recusada por Rodrigo hoje, 14:41:',
      texto: ' “Não parece a minha marca”. O motivo fica guardado com a peça. Nada foi para a Meta.',
    });
    expect(resultadoDaPeca(barrada, barrada.current, AGORA, true, 'Mister Burgers')).toEqual({
      tom: 'falha',
      icone: 'ban',
      forte: 'Barrada pelo Compliance: diz o que a Mister Burgers não diz.',
      texto: ' Esta versão não pode ser aprovada nem ir para a Meta. Edite o texto, peça outra versão ou recuse a peça.',
    });
    expect(resultadoDaPeca(barrada, barrada.current, AGORA, false, 'Mister Burgers')!.texto).toBe(' Esta versão não pode ser aprovada nem ir para a Meta.');
    expect(avisoDaVersaoNova(passou, true)).toEqual({ texto: 'Versão 1 salva. A conferência foi feita de novo e ela passou.', tipo: 'ok' });
    expect(avisoDaVersaoNova(barrada, true)).toEqual({ texto: 'Versão 1 salva. A conferência foi feita de novo: ela foi barrada.', tipo: 'perigo' });
    expect(avisoDaVersaoNova(passou, false)).toEqual({ texto: 'A versão 1 de “Sexta é dia de combo” está pronta e passou na conferência.', tipo: 'ok' });
  });

  it('de onde veio, as versões e o que a tela diz quando o servidor recusa', () => {
    const fontes = new Fontes();
    const o = opcoes();
    const origem = origemDaPeca(passou, passou.current, pedido({ instruction: 'fale da retirada' }), o.reference_ads, o.reference_period, fontes);
    expect(origem.map((x) => `${x.forte}${textoCorrido(x.texto)}`)).toEqual([
      'O que já vendeu: o anúncio “Combo sexta · carrossel”, com 27 pedidos confirmados no caixa em 7 dias.',
      `Minha marca (versão 3): a voz da casa, a oferta (“${OFERTA}”) e o que a marca não diz.`,
      'O que foi pedido: “fale da retirada”.',
      'Feito com IA: o texto, pelo Criativo. Nenhum dado de cliente foi para o fornecedor de IA.',
      'A imagem: por enquanto o Criativo faz só o texto. A imagem a partir da foto do seu produto chega numa próxima fase.',
      'Uso: a peça é sua para anunciar. Como foi feita por IA, outra empresa pode receber uma parecida, e a lei de direito autoral protege o que é criado por uma pessoa.',
    ]);
    expect(fontes.lista).toEqual([{ valor: '27', fonte: 'Regem · pedidos confirmados no caixa com origem no anúncio “Combo sexta · carrossel” · 01/10 a 07/10' }]);
    // Sem o pedido à mão (lista que não veio), a peça diz o que sabe.
    const semPedido = origemDaPeca(passou, versao({ author: 'pessoa' }), null, [], null, new Fontes());
    expect(semPedido.map((x) => x.forte)).toEqual(['Sem anúncio de referência:', 'Minha marca:', 'Feito com IA:', 'A imagem:', 'Uso:']);
    expect(textoCorrido(semPedido[2]!.texto)).toBe(' o texto desta versão foi escrito por uma pessoa, a partir do que o Criativo fez.');
    expect(rotuloDaVersao(versao(), AGORA)).toBe('Versão 1 · Criativo · hoje, 14:10');
    expect(rotuloDaVersao(versao({ version: 2, author: 'pessoa', created_by: RODRIGO, created_at: local(14, 30) }), AGORA)).toBe('Versão 2 · editada por Rodrigo · hoje, 14:30');
    expect(erroDaPeca({ code: 'peca-mudou', title: 'A peça mudou depois que você abriu', detail: 'Há uma versão mais nova desta peça. Atualize a tela e confira de novo antes de decidir.' })).toEqual({
      texto: 'Há uma versão mais nova desta peça. Atualize a tela e confira de novo antes de decidir.',
      recarregar: true,
    });
    expect(erroDaPeca({ code: 'texto-barrado', title: 'Este texto não passa na conferência', detail: 'O texto bate numa regra de anúncio e não foi salvo.', errors: [{ message: 'O texto traz “entrega em 20 minutos”.' }] })).toEqual({
      texto: 'O texto bate numa regra de anúncio e não foi salvo. O texto traz “entrega em 20 minutos”.',
      recarregar: false,
    });
  });
});

describe('a tela desenhada', () => {
  const nada = () => {};
  const semProblema = async () => null;
  function lista(over: { opcoes?: AdPieceOptionsResponse; pecas?: AdPieceResponse[]; pedidos?: AdPieceRequestResponse[]; pode?: boolean; pro?: boolean; filtro?: 'aprovadas' | 'recusadas'; confirmandoLote?: boolean } = {}): string {
    return renderToStaticMarkup(
      createElement(CriativosLista, {
        opcoes: over.opcoes ?? opcoes(),
        pecas: over.pecas ?? [passou, comAviso, barrada, aprovada, recusada],
        pedidos: over.pedidos ?? [pedido()],
        pode: over.pode ?? true,
        pro: over.pro ?? false,
        agora: AGORA,
        filtro: over.filtro ?? 'aprovadas',
        confirmandoLote: over.confirmandoLote ?? false,
        ocupado: null,
        botaoDoVazio: createElement('button', { type: 'button' }, 'Pedir a primeira peça'),
        aoFiltrar: nada,
        aoAbrir: nada,
        aoPedir: nada,
        aoPedirLote: nada,
        aoAprovarLote: nada,
      }),
    );
  }
  function aberta(p: AdPieceResponse, over: { pode?: boolean; pro?: boolean; opcoes?: AdPieceOptionsResponse } = {}): string {
    return renderToStaticMarkup(
      createElement(PecaAberta, {
        detalhe: { id: p.id, estado: 'ok', peca: p },
        naLista: p,
        irmas: [passou.id, comAviso.id, barrada.id],
        pedido: pedido(),
        opcoes: over.opcoes ?? opcoes(),
        nomeDaMarca: 'Mister Burgers',
        pro: over.pro ?? false,
        pode: over.pode ?? true,
        agora: AGORA,
        ocupado: null,
        aoVoltar: nada,
        aoAbrir: nada,
        aoTentarDeNovo: nada,
        aoAprovar: nada,
        aoRecusar: nada,
        aoSalvar: semProblema,
        aoPedirOutra: semProblema,
        aoContestar: semProblema,
        aoAvisar: nada,
      }),
    );
  }

  it('a lista: o uso de IA, o que espera decisão, a biblioteca e o que já vende', () => {
    const html = lista();
    const t = semTags(html);
    // (Ao tirar as marcas, o espaço que não quebra do valor em reais vira espaço comum.)
    expect(t).toContain('Uso de IA hoje: R$ 7,49 , fonte:');
    expect(t).toContain('2 peças passaram na conferência e 1 foi barrada.');
    expect(t).toContain('Aprovar as 2 que passaram');
    expect(html.match(/class="peca-card"/g)).toHaveLength(4);
    expect(html).toContain(`id="cri-peca-${barrada.id}" data-barrada=""`);
    expect(t).toContain('Aprovadas 1');
    expect(t).toContain('Recusadas 1');
    expect(t).toContain('O que já vende');
    expect(t).toContain('Fazer variações');
    expect(t).toContain('De onde vêm os números (4)');
    // No Lite não há a versão no cartão nem a nota do limite da empresa.
    expect(html).not.toContain('st--neutro');
    expect(lista({ pro: true })).toContain('O limite é da empresa inteira');
    // A confirmação de aprovar as que passaram.
    expect(semTags(lista({ confirmandoLote: true }))).toContain('Aprovar as 2 peças que passaram na conferência? Elas vão para a biblioteca. A que tem aviso de tamanho entra junto. Nada vai para a Meta.');
    // As recusadas, pelo filtro.
    expect(lista({ filtro: 'recusadas' })).toContain(`id="cri-peca-${recusada.id}"`);
  });

  it('a lista: primeiro uso, pedido em andamento, pedido que falhou, o Criativo desligado e quem só acompanha', () => {
    const vazio = semTags(lista({ pecas: [], pedidos: [] }));
    expect(vazio).toContain('Nenhuma peça ainda');
    expect(vazio).toContain('Pedir a primeira peça');
    const andando = semTags(lista({ pecas: [], opcoes: opcoes({ available: false, reason: 'lote_em_andamento', in_progress: pedido({ status: 'gerando', pieces: 0, finished_at: null }) }) }));
    expect(andando).toContain(`O Criativo está fazendo 3 peças para “${OFERTA}”`);
    expect(andando).toContain('Leva cerca de um minuto.');
    const falhou = semTags(lista({ pecas: [aprovada], pedidos: [pedido({ status: 'falhou', reason: 'ia_fora_do_ar', pieces: 0 })] }));
    expect(falhou).toContain('O pedido falhou: a IA não respondeu');
    expect(falhou).toContain('Pedir de novo');
    const desligado = lista({ pecas: [], pedidos: [], opcoes: opcoes({ available: false, reason: 'criativo_desligado', ai: null, usd_brl: null, reference_ads: [] }) });
    expect(semTags(desligado)).toContain('O Criativo não está ligado nesta empresa');
    expect(desligado).not.toContain('cri-uso');
    const leitor = lista({ pode: false });
    expect(semTags(leitor)).toContain('Você acompanha as peças por aqui');
    expect(leitor).not.toContain('Aprovar as 2 que passaram');
    expect(leitor).not.toContain('Fazer variações');
  });

  it('a peça que espera decisão: a prévia, o texto com a contagem, a conferência e a decisão sem o código do app', () => {
    const html = aberta(passou);
    const t = semTags(html);
    expect(t).toContain('Peça 1 de 3');
    expect(t).toContain('Prévia do anúncio');
    expect(t).toContain('Mister Burgers Patrocinado');
    expect(t).toContain('Texto feito com IA');
    expect(t).toContain('20 de 27 caracteres');
    expect(t).toContain('Passou nas 4 conferências.');
    expect(t).toContain('Aprovar a peça');
    expect(t).toContain('Pedir outra');
    expect(t).toContain('Aprovar guarda a peça na biblioteca. Nada vai para a Meta agora.');
    expect(html).not.toContain('Código do app');
    // A peça que passou sem aviso não oferece "A conferência errou?".
    expect(t).not.toContain('A conferência errou?');
    // No Lite, os detalhes ficam recolhidos; no Pro, à vista.
    expect(html).toMatch(/id="[^"]+-detalhes" hidden=""/);
    expect(aberta(passou, { pro: true })).not.toMatch(/id="[^"]+-detalhes" hidden=""/);
  });

  it('a barrada não pode ser aprovada e mostra o trecho; a decidida não tem decisão; quem só acompanha não decide', () => {
    const html = aberta(barrada);
    const t = semTags(html);
    expect(t).toContain('Barrada pelo Compliance: diz o que a Mister Burgers não diz.');
    expect(html).toContain('<mark>entrega em 20 minutos</mark>');
    expect(t).not.toContain('Aprovar a peça');
    expect(t).toContain('A peça barrada não pode ser aprovada.');
    expect(t).toContain('A conferência errou?');
    const decidida = semTags(aberta(aprovada));
    expect(decidida).toContain('Aprovada por Rodrigo hoje, 14:40 (versão 1).');
    expect(decidida).not.toContain('Aprovar a peça');
    expect(decidida).not.toContain('Editar o texto');
    const leitor = semTags(aberta(passou, { pode: false }));
    expect(leitor).toContain('Só quem opera campanhas (Dono, Administrador e Gestor) aprova, pede outra e recusa.');
    expect(leitor).not.toContain('Aprovar a peça');
    // Com o limite de IA atingido, "Pedir outra" segue à vista, e a dica diz quando volta.
    const semLimite = aberta(passou, { opcoes: opcoes({ available: false, reason: 'limite_de_ia', ai: { ...IA, fits: false } }) });
    expect(semLimite).toMatch(/aria-disabled="true"[^>]*>[^<]*<svg[^>]*>.*?<\/svg>Pedir outra/);
    expect(semTags(semLimite)).toContain('Pedir outra volta quando o Criativo puder escrever.');
  });

  it('o pedido de peça: as ofertas de Minha marca, o destino, as variações, de onde parte e a estimativa', () => {
    const html = renderToStaticMarkup(createElement(DialogoPedirPeca, { opcoes: opcoes(), anuncioInicial: uuid(70), reserva: { current: null }, aoFechar: nada, aoPedir: semProblema }));
    const t = semTags(html);
    expect(t).toContain('Pedir uma peça');
    expect(t).toContain('Chope em dobro às quintas · não vai ao Criativo');
    expect(t).toContain('Por enquanto o Criativo faz só o texto.');
    expect(t).toContain('O cardápio da loja');
    expect(t).toContain('Uma conversa no WhatsApp');
    expect(html.match(/name="pp-n"/g)).toHaveLength(3);
    expect(t).toContain('O anúncio “Combo sexta · carrossel” , com 27 pedidos confirmados no caixa em 7 dias.');
    expect(t).toContain('Estimativa: cerca de R$ 0,05 (3 textos e a conferência de cada peça).');
    expect(t).toContain('Nada vai para a Meta por aqui.');
  });
});

describe('menu: "Criativos" depois da Verba do mês, para quem acompanha as campanhas, com Lite e Pro', () => {
  it('o item, a permissão e o título', () => {
    const agencia = NAVEGACAO.find((g) => g.id === 'agencia')!;
    const i = agencia.itens.findIndex((x) => x.href === '/criativos');
    expect(agencia.itens[i]).toEqual({ href: '/criativos', rotulo: 'Criativos', icone: 'image', permissao: 'campanhas.ver', contador: 'criativos', modos: true });
    expect(agencia.itens[i - 1]!.href).toBe('/verba');
    expect(itensVisiveis(agencia, (p) => p !== 'campanhas.ver').map((x) => x.href)).not.toContain('/criativos');
    expect(tituloDa('/criativos')).toBe('Criativos');
    expect(temModos('/criativos', () => true)).toBe(true);
  });

  it('o número ao lado do item, para quem ouve o menu', () => {
    expect(pecasFaladas(1)).toBe(', 1 peça para decidir');
    expect(pecasFaladas(3)).toBe(', 3 peças para decidir');
  });
});
