import { type AttentionItem, type ConnectionResponse, type DiscoveredAccount, GOOGLE_SALES_SCOPE, type GoogleConversionAccount, type GoogleConversionsResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ItemAviso } from '@/components/atencao/item-aviso';
import { destinoDasVendasAoGoogle } from '@/components/atencao/textos';
import { CartaoAutorizacao } from '@/components/contas/cartao-autorizacao';
import { CartaoVendasGoogle } from '@/components/contas/cartao-vendas-google';
import { DialogoConectar } from '@/components/contas/dialogo-conectar';
import { DialogoConversao } from '@/components/contas/dialogo-conversao';
import { DialogoEscolher } from '@/components/contas/dialogo-escolher';
import { contasExistentes, descricaoDoGoogle, escolhiveis, faixaDaVolta, notaDeConectar } from '@/components/contas/textos';
import {
  ENVIA_AO_GOOGLE,
  ESCOPO_DE_INFORMAR_VENDAS,
  esperaPorExtenso,
  juntarVendas,
  linhaDasVendas,
  NUNCA_VAI_AO_GOOGLE,
  notaDaConversao,
  notaDaEscolha,
  numerosDasVendas,
  porVoltaDe,
  recusaEmPalavras,
  trocarAMarca,
  vendasDaConta,
  vendasPorAutorizacao,
} from '@/components/contas/vendas-google';
import { LinhaVendasGoogle } from '@/components/resultados/linha-vendas-google';
import { type Modo, ModoProvider } from '@/lib/modo';

// "Vendas informadas ao Google" em Contas conectadas (A5 · Y1; protótipo P14, aprovado em 09/10/2026): as regras e as
// frases do cartão, o cartão desenhado em cada situação, e o caminho de autorizar o Google de novo (a autorização nova,
// com a permissão de informar vendas, assume as contas já ligadas). Datas fixas no fuso local (LIC-006, ERR-023).

const agora = new Date(2026, 9, 9, 10, 40, 0); // 09/10/2026 10:40
const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const ID = '01a0e1a1-ea5a-7822-a16c-376c2c942655';
const MARCA = '01a0e1a1-ea64-71ed-8775-f13002fd25f0';
const RODRIGO = { id: '01a0e1a1-ea5a-7822-a16c-000000000001', name: 'Rodrigo de Oliveira' };
const contexto = { agora, esperaMin: 120, janelaDias: 30 };

type Destino = NonNullable<GoogleConversionAccount['destination']>;
const destino = (extra: Partial<Destino> = {}): Destino => ({
  conversion_action_id: '987654321',
  conversion_action_name: 'Pedido confirmado no caixa',
  starts_at: local(8, 15),
  stopped_at: null,
  stopped_by: null,
  set_by: RODRIGO,
  ...extra,
});

const conta = (extra: Partial<GoogleConversionAccount> = {}): GoogleConversionAccount => ({
  connected_account_id: ID,
  name: 'Mister Burgers Google',
  external_id: '4445556667',
  authorized: true,
  destination: destino(),
  status: 'informando',
  team_stopped_at: null,
  counts: { informed: 31, waiting: 2, corrected: 1, refused: 0 },
  last_run_at: local(9, 10, 5),
  next_run_at: local(9, 11, 5),
  last_failure: null,
  last_refusal: null,
  refusing: null,
  ...extra,
});

const resposta = (extra: Partial<GoogleConversionsResponse> = {}): GoogleConversionsResponse => ({
  brand_id: MARCA,
  enabled: true,
  can_manage: true,
  wait_minutes: 120,
  window_days: 30,
  accounts: [conta()],
  ...extra,
});

describe('vendas informadas ao Google: regras e frases', () => {
  it('a permissão que a tela procura na autorização é a mesma do contrato', () => {
    expect(ESCOPO_DE_INFORMAR_VENDAS).toBe(GOOGLE_SALES_SCOPE);
  });

  it('o prazo por extenso e a hora aproximada da volta', () => {
    expect(esperaPorExtenso(120)).toBe('duas horas');
    expect(esperaPorExtenso(60)).toBe('uma hora');
    expect(esperaPorExtenso(720)).toBe('12 horas');
    expect(esperaPorExtenso(45)).toBe('45 minutos');
    expect(esperaPorExtenso(1)).toBe('um minuto');
    expect(esperaPorExtenso(90)).toBe('1 h 30 min');
    expect(porVoltaDe(local(9, 11, 5), agora)).toBe('por volta das 11:05');
    expect(porVoltaDe(local(10, 9, 0), agora)).toBe('amanhã, por volta das 09:00');
    expect(porVoltaDe(local(10, 1, 15), agora)).toBe('amanhã, por volta da 01:15');
    expect(porVoltaDe(local(12, 9, 0), agora)).toBe('em 12/10, 09:00');
    // Já devia ter passado, ou não há hora marcada: sem prometer uma hora que não vale.
    expect(porVoltaDe(local(9, 10, 0), agora)).toBe('em instantes');
    expect(porVoltaDe(null, agora)).toBe('em instantes');
  });

  it('o que o Liame envia e o que nunca envia: quatro e quatro, sem dado de quem comprou', () => {
    expect(ENVIA_AO_GOOGLE.map((e) => e.rotulo)).toEqual(['O código do clique', 'A hora do pedido', 'O valor do pedido', 'Um número interno do pedido']);
    expect(NUNCA_VAI_AO_GOOGLE).toHaveLength(4);
    expect(NUNCA_VAI_AO_GOOGLE[0]).toBe('Nome, telefone, e-mail ou endereço de quem comprou.');
    expect(ENVIA_AO_GOOGLE.map((e) => `${e.rotulo} ${e.texto}`).join(' ')).not.toMatch(/telefone|e-mail|endere[çc]o|nome d/i);
  });

  it('informando: a conversão, desde quando, quem escolheu, a última passagem e a próxima', () => {
    const v = vendasDaConta(conta(), contexto);
    expect(v.selo).toEqual({ classe: 'st--concluido', rotulo: 'Informando' });
    expect(v.destino).toEqual({ nome: 'Pedido confirmado no caixa', meta: 'desde 08/10/2026 · escolhida por Rodrigo' });
    expect(v.avisos).toEqual([]);
    expect(v.numeros).toBe(true);
    expect(v.passagem).toBe('Últimos 30 dias · última passagem hoje, 10:05 · a próxima por volta das 11:05');
    expect(v.acoes).toEqual(['trocar', 'parar']);
    // Quem escolheu saiu da empresa: a frase não inventa um nome.
    expect(vendasDaConta(conta({ destination: destino({ set_by: null }) }), contexto).destino?.meta).toBe('desde 08/10/2026');
  });

  it('acabou de começar: nada pode ter saído ainda, e o cartão diz desde quando e em quanto tempo', () => {
    const v = vendasDaConta(conta({ destination: destino({ starts_at: local(9, 10, 0) }), last_run_at: null, next_run_at: local(9, 10, 0), counts: { informed: 0, waiting: 0, corrected: 0, refused: 0 } }), contexto);
    expect(v.selo.rotulo).toBe('Informando');
    expect(v.destino?.meta).toBe('desde hoje, 10:00 · escolhida por Rodrigo');
    expect(v.avisos).toEqual([
      { tom: 'atencao', icone: 'clock', texto: 'Começou hoje, 10:00. O primeiro pedido confirmado a partir de então sai duas horas depois da confirmação. Os pedidos de antes não são informados.' },
    ]);
    expect(v.passagem).toBe('A primeira passagem acontece em até uma hora.');
    // Voltou de uma parada: a última passagem é de ANTES do recomeço, e não conta como passagem desta vez.
    expect(vendasDaConta(conta({ destination: destino({ starts_at: local(9, 10, 0) }), last_run_at: local(9, 9, 5) }), contexto).passagem).toBe('A primeira passagem acontece em até uma hora.');
    // Passado o prazo, o aviso de começo sai.
    expect(vendasDaConta(conta({ destination: destino({ starts_at: local(9, 8, 40) }) }), contexto).avisos).toEqual([]);
  });

  it('recusas: quantas, a última, o que acontece com elas; o motivo do Google em palavras só quando ele não deixa dúvida', () => {
    const recusada = conta({ counts: { informed: 28, waiting: 2, corrected: 1, refused: 3 }, last_refusal: { at: local(9, 9, 5), reason: 'PROCESSING_ERROR_REASON_INVALID_GCLID' } });
    expect(vendasDaConta(recusada, contexto).avisos).toEqual([
      {
        tom: 'atencao',
        icone: 'alert',
        forte: 'O Google recusou 3 vendas nos últimos 30 dias.',
        texto: 'A última, hoje, 09:05: ele não reconheceu o clique deste pedido. O Liame não tenta de novo sozinho, e essas vendas seguem contando nos seus Resultados.',
        tecnico: { rotulo: 'Motivo do Google', valor: 'PROCESSING_ERROR_REASON_INVALID_GCLID' },
      },
    ]);
    const outra = vendasDaConta(conta({ counts: { informed: 1, waiting: 0, corrected: 0, refused: 1 }, last_refusal: { at: local(8, 21, 0), reason: '429: Quota exceeded' } }), contexto).avisos[0]!;
    expect(outra.forte).toBe('O Google recusou 1 venda nos últimos 30 dias.');
    expect(outra.texto).toBe('A última, ontem, 21:00. O Liame não tenta de novo sozinho, e essas vendas seguem contando nos seus Resultados.');
    // Sem a última recusa na resposta: a contagem aparece, sem motivo inventado.
    const semUltima = vendasDaConta(conta({ counts: { informed: 1, waiting: 0, corrected: 0, refused: 2 } }), contexto).avisos[0]!;
    expect(semUltima.texto).toBe('O Liame não tenta de novo sozinho, e essas vendas seguem contando nos seus Resultados.');
    expect(semUltima.tecnico).toBeUndefined();
    expect(recusaEmPalavras('INVALID_WBRAID: x')).toBe('ele não reconheceu o clique deste pedido');
    expect(recusaEmPalavras('PROCESSING_ERROR_REASON_OTHER')).toBeNull();
  });

  it('esperando a plataforma: "o Google pediu para esperar" e "a passagem falhou" são frases diferentes; o que espera continua na fila', () => {
    const esperar = vendasDaConta(conta({ status: 'esperando_a_plataforma', last_failure: { at: local(9, 10, 5), reason: '429: Quota exceeded', kind: 'esperar' } }), contexto);
    expect(esperar.selo).toEqual({ classe: 'st--aguardando', rotulo: 'Esperando o Google' });
    expect(esperar.avisos).toEqual([
      {
        tom: 'atencao',
        icone: 'clock',
        texto: 'O Google pediu para esperar ou estava fora do ar. O Liame tenta de novo por volta das 11:05; as vendas que esperam continuam na fila.',
        tecnico: { rotulo: 'Motivo', valor: '429: Quota exceeded' },
      },
    ]);
    expect(esperar.passagem).toBe('Últimos 30 dias · última passagem hoje, 10:05 · a próxima por volta das 11:05');
    expect(esperar.acoes).toEqual(['trocar', 'parar']);
    const outro = vendasDaConta(conta({ status: 'esperando_a_plataforma', last_failure: { at: local(9, 10, 5), reason: 'erro interno', kind: 'outro' } }), contexto);
    expect(outro.selo.rotulo).toBe('Tentando de novo');
    expect(outro.avisos[0]!.texto).toBe('A última passagem falhou antes do fim. O Liame tenta de novo por volta das 11:05; as vendas que esperam continuam na fila.');
    // As recusas da janela continuam aparecendo junto.
    expect(vendasDaConta(conta({ status: 'esperando_a_plataforma', counts: { informed: 1, waiting: 1, corrected: 0, refused: 1 } }), contexto).avisos).toHaveLength(2);
  });

  it('falta a permissão: a autorização não inclui o envio, ou o Google recusou a que o Liame tem; a saída é autorizar de novo', () => {
    const falta = vendasDaConta(conta({ status: 'sem_permissao', authorized: false, destination: null }), contexto);
    expect(falta.selo).toEqual({ classe: 'st--aguardando', rotulo: 'Falta uma permissão' });
    expect(falta.avisos[0]!.texto).toBe(
      'Para informar as vendas, o Liame precisa de uma permissão a mais do Google, além da de leitura. Autorize o Google de novo e, na volta, confirme as contas: nada é desligado.',
    );
    expect(falta.numeros).toBe(false);
    expect(falta.acoes).toEqual(['autorizar']);
    const recusou = vendasDaConta(conta({ status: 'sem_permissao', last_failure: { at: local(9, 10, 5), reason: 'invalid_grant: OAuth recusado', kind: 'permissao' } }), contexto);
    expect(recusou.selo.rotulo).toBe('Autorize de novo');
    expect(recusou.avisos[0]!.texto).toContain('O Google recusou a autorização que o Liame usa para informar as vendas');
    expect(recusou.avisos[0]!.tecnico).toEqual({ rotulo: 'Motivo do Google', valor: 'invalid_grant: OAuth recusado' });
    // Com a conversão escolhida e informando, dá para parar mesmo sem a permissão.
    expect(recusou.acoes).toEqual(['autorizar', 'parar']);
    expect(recusou.numeros).toBe(true);
  });

  it('falta escolher, parado por uma pessoa, equipe parada e situação desconhecida', () => {
    const escolher = vendasDaConta(conta({ status: 'sem_destino', destination: null }), contexto);
    expect(escolher.selo.rotulo).toBe('Falta escolher');
    expect(escolher.avisos[0]!.texto).toBe('Escolha onde o Google conta essas vendas. O Liame só envia para a conversão que você escolher, e nada sai antes disso.');
    expect([escolher.destino, escolher.numeros, escolher.acoes]).toEqual([null, false, ['escolher']]);

    const parado = vendasDaConta(conta({ status: 'parado', destination: destino({ stopped_at: local(8, 14, 20), stopped_by: RODRIGO }), next_run_at: null }), contexto);
    expect(parado.selo).toEqual({ classe: 'st--espera', rotulo: 'Parado' });
    expect(parado.destino?.meta).toBe('escolhida por Rodrigo em 08/10/2026');
    expect(parado.avisos[0]!.texto).toBe('Parado por Rodrigo em 08/10/2026, 14:20. Nenhuma venda nova é informada; as que já foram informadas continuam no Google.');
    expect([parado.numeros, parado.passagem, parado.acoes]).toEqual([true, null, ['voltar']]);
    expect(vendasDaConta(conta({ status: 'parado', destination: destino({ stopped_at: local(8, 14, 20), set_by: null }) }), contexto).avisos[0]!.texto).toMatch(/^Parado em 08\/10\/2026, 14:20\./);

    // A parada da equipe pesa mais que tudo: nada de parar ou trocar por aqui; quem retoma é Sua equipe.
    const equipe = vendasDaConta(conta({ status: 'equipe_parada', team_stopped_at: local(9, 9, 52) }), contexto);
    expect(equipe.selo).toEqual({ classe: 'st--perigo', rotulo: 'Parado' });
    expect(equipe.avisos[0]).toEqual({
      tom: 'perigo',
      icone: 'alert-circle',
      texto: 'A equipe está parada desde hoje, 09:52. Enquanto estiver, nenhuma venda é informada; as que esperam saem quando ela for retomada.',
    });
    expect(equipe.acoes).toEqual(['equipe']);
    expect(vendasDaConta(conta({ status: 'equipe_parada', destination: null, team_stopped_at: null }), contexto).avisos[0]!.texto).toBe('A equipe está parada. Enquanto estiver, nenhuma venda é informada.');

    // A situação vem como texto: uma que esta tela não conhece mostra o que há e não oferece nada.
    const nova = vendasDaConta(conta({ status: 'situacao_nova' }), contexto);
    expect([nova.selo.rotulo, nova.acoes]).toEqual(['Conferindo', []]);
  });

  it('as quatro contagens, a etiqueta da conversão e a nota do diálogo (ao trocar, diz o que acontece com o que esperava)', () => {
    expect(numerosDasVendas({ informed: 31, waiting: 2, corrected: 1, refused: 0 }, 120)).toEqual([
      { valor: 31, rotulo: 'vendas informadas', atencao: false },
      { valor: 2, rotulo: 'esperando as duas horas', atencao: false },
      { valor: 1, rotulo: 'com o valor corrigido', atencao: false },
      { valor: 0, rotulo: 'recusadas pelo Google', atencao: false },
    ]);
    const um = numerosDasVendas({ informed: 1, waiting: 0, corrected: 0, refused: 1 }, 60);
    expect(um.map((n) => n.rotulo)).toEqual(['venda informada', 'esperando a vez', 'com o valor corrigido', 'recusada pelo Google']);
    expect(um[3]!.atencao).toBe(true);
    expect(notaDaConversao({ primary: true })).toBe('usada nos lances');
    expect(notaDaConversao({ primary: false })).toBe('só para acompanhar');
    const nota = notaDaEscolha(120, false);
    expect(nota).toContain('Só entram os pedidos confirmados a partir de agora; os de antes não são informados.');
    expect(nota).toContain('Cada pedido sai duas horas depois de confirmado no caixa.');
    expect(nota).toContain('o valor é corrigido para zero: o Google não deixa retirar uma venda já informada.');
    expect(nota).not.toContain('Ao trocar');
    expect(notaDaEscolha(120, true)).toContain('Ao trocar a conversão, as vendas que esperavam a vez para a antiga não são informadas.');
  });

  it('as respostas por marca: só as marcas com a função ligada contam, e cada cartão entra depois da autorização que lê a conta', () => {
    const outra = '01a0e1a1-ea64-71ed-8775-000000000002';
    const juntas = juntarVendas([resposta(), resposta({ brand_id: outra, enabled: false, accounts: [] })]);
    expect([...juntas.marcas]).toEqual([MARCA]);
    expect(juntas.contas).toEqual([{ conta: conta(), brandId: MARCA, podeGerir: true, esperaMin: 120, janelaDias: 30 }]);
    expect(juntarVendas([]).contas).toEqual([]);

    // A resposta de escolher ou parar troca só a marca dela.
    const parada = resposta({ accounts: [conta({ status: 'parado' })] });
    expect(trocarAMarca([resposta(), resposta({ brand_id: outra })], parada).map((r) => [r.brand_id, r.accounts[0]!.status])).toEqual([
      [MARCA, 'parado'],
      [outra, 'informando'],
    ]);
    expect(trocarAMarca([], parada)).toEqual([parada]);

    const conexoes = [
      { id: 'google', accounts: [{ id: ID }] },
      { id: 'escondida', accounts: [{ id: 'conta-2' }] },
    ];
    const duas = [...juntas.contas, { ...juntas.contas[0]!, conta: conta({ connected_account_id: 'conta-2' }) }, { ...juntas.contas[0]!, conta: conta({ connected_account_id: 'conta-3' }) }];
    const grupos = vendasPorAutorizacao(duas, conexoes, [{ id: 'google' }]);
    expect(grupos.get('google')?.map((v) => v.conta.connected_account_id)).toEqual([ID]);
    // A autorização não está na tela, ou a conta não tem autorização na lista: o cartão vai para o fim.
    expect(grupos.get('')?.map((v) => v.conta.connected_account_id)).toEqual(['conta-2', 'conta-3']);
  });
});

describe('vendas informadas ao Google: o cartão', () => {
  const nada = () => {};
  const cartao = (c: GoogleConversionAccount, over: { modo?: Modo; podeGerir?: boolean; esperaMin?: number } = {}) =>
    renderToStaticMarkup(
      createElement(ModoProvider, {
        inicial: over.modo ?? 'lite',
        children: createElement(CartaoVendasGoogle, {
          conta: c,
          agora,
          esperaMin: over.esperaMin ?? 120,
          janelaDias: 30,
          podeGerir: over.podeGerir ?? true,
          aoAutorizar: async () => true,
          aoEscolher: nada,
          aoParar: async () => true,
          aoVoltar: async () => true,
        }),
      }),
    );

  it('informando: a conta, a conversão, as quatro contagens, o que o Liame envia (fechado) e os dois botões', () => {
    const html = cartao(conta());
    expect(html).toContain('Vendas informadas ao Google</b>');
    expect(html).toContain('Mister Burgers Google · <span class="mono">444-555-6667</span>');
    expect(html).toContain('<span class="st st--concluido"><span class="dot" aria-hidden="true"></span>Informando</span>');
    expect(html).toContain('é informado ao Google, com o valor, duas horas depois da confirmação.');
    expect(html).toContain('Contadas em <b>Pedido confirmado no caixa</b>');
    expect(html.match(/class="conv-num"/g)).toHaveLength(4);
    expect(html).toContain('<b class="num">31</b> <span>vendas informadas</span>');
    expect(html).toContain('aria-label="Vendas dos últimos 30 dias"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('<b>Nunca envia:</b> nome, telefone, e-mail ou endereço de quem comprou; o custo, a margem e os itens do pedido.');
    expect(html).toContain('Trocar a conversão');
    expect(html).toContain('aria-label="Parar de informar: Mister Burgers Google"');
    expect(html).not.toContain('Só quem conecta contas');
    // O prazo vem do servidor: a frase acompanha.
    expect(cartao(conta(), { esperaMin: 60 })).toContain('com o valor, uma hora depois da confirmação.');
  });

  it('o motivo como o Google respondeu só aparece no Pro; a contagem de recusadas chama atenção nos dois', () => {
    const recusada = conta({ counts: { informed: 28, waiting: 2, corrected: 1, refused: 3 }, last_refusal: { at: local(9, 9, 5), reason: 'PROCESSING_ERROR_REASON_INVALID_GCLID' } });
    const lite = cartao(recusada);
    expect(lite).toContain('<b>O Google recusou 3 vendas nos últimos 30 dias. </b>');
    expect(lite).toContain('class="conv-num conv-num--atencao"');
    expect(lite).not.toContain('Motivo do Google');
    expect(lite).not.toContain('INVALID_GCLID');
    const pro = cartao(recusada, { modo: 'pro' });
    expect(pro).toContain('Motivo do Google: <code>PROCESSING_ERROR_REASON_INVALID_GCLID</code>');
  });

  it('quem não conecta contas só vê: nenhum botão de escolher, trocar, parar, voltar ou autorizar', () => {
    for (const c of [conta(), conta({ status: 'sem_destino', destination: null }), conta({ status: 'parado', destination: destino({ stopped_at: local(8, 14, 20) }) }), conta({ status: 'sem_permissao', authorized: false, destination: null })]) {
      const html = cartao(c, { podeGerir: false });
      expect(html).toContain('Só quem conecta contas na empresa muda isto.');
      expect(html).toContain('O que o Liame envia');
      for (const botao of ['Trocar a conversão', 'Parar de informar', 'Escolher a conversão', 'Voltar a informar', 'Autorizar o Google de novo']) expect(html).not.toContain(botao);
    }
  });

  it('cada situação oferece só o que vale nela', () => {
    const semPermissao = cartao(conta({ status: 'sem_permissao', authorized: false, destination: null }));
    expect(semPermissao).toContain('Falta uma permissão');
    expect(semPermissao).toContain('Autorizar o Google de novo');
    expect(semPermissao).not.toContain('Escolher a conversão');
    expect(semPermissao).not.toContain('conv-nums');

    const escolher = cartao(conta({ status: 'sem_destino', destination: null }));
    expect(escolher).toContain('aria-haspopup="dialog"');
    expect(escolher).toContain('Escolher a conversão');
    expect(escolher).not.toContain('conv-nums');
    expect(escolher).not.toContain('Contadas em');

    const parado = cartao(conta({ status: 'parado', destination: destino({ stopped_at: local(8, 14, 20), stopped_by: RODRIGO }), counts: { informed: 31, waiting: 0, corrected: 1, refused: 0 } }));
    expect(parado).toContain('Voltar a informar');
    expect(parado).not.toContain('Parar de informar');
    expect(parado).not.toContain('Trocar a conversão');

    const equipe = cartao(conta({ status: 'equipe_parada', team_stopped_at: local(9, 9, 52) }));
    expect(equipe).toContain('<span class="st st--perigo">');
    expect(equipe).toContain('class="aut-txt aut-txt--perigo"');
    expect(equipe).toContain('href="/equipe"');
    expect(equipe).toContain('Abrir Sua equipe');
    expect(equipe).not.toContain('Parar de informar');
    // Abrir Sua equipe não muda nada aqui: quem só vê também recebe o caminho.
    expect(cartao(conta({ status: 'equipe_parada', team_stopped_at: local(9, 9, 52) }), { podeGerir: false })).toContain('href="/equipe"');

    const esperando = cartao(conta({ status: 'esperando_a_plataforma', last_failure: { at: local(9, 10, 5), reason: '429: Quota exceeded', kind: 'esperar' } }), { modo: 'pro' });
    expect(esperando).toContain('Esperando o Google');
    expect(esperando).toContain('Motivo: <code>429: Quota exceeded</code>');
  });
});

describe('a linha das vendas ao Google em Resultados e o aviso de que o envio parou (P14, parte B)', () => {
  const HREF = `/contas#vendas-${ID}`;
  const daMarca = (contas: GoogleConversionAccount[], extra: Partial<GoogleConversionsResponse> = {}) => juntarVendas([resposta({ accounts: contas, ...extra })]).contas;
  const linha = (c: GoogleConversionAccount) => linhaDasVendas(daMarca([c]), agora);

  it('sem conta com a função ligada não há linha: a tela é a de sempre', () => {
    expect(linhaDasVendas([], agora)).toBeNull();
    expect(linhaDasVendas(juntarVendas([resposta({ enabled: false, accounts: [] })]).contas, agora)).toBeNull();
  });

  it('informando: as vendas dos últimos 30 dias, com o atalho para o cartão da conta', () => {
    expect(linha(conta())).toEqual({
      tom: 'ok',
      icone: 'check-circle',
      antes: 'Nos últimos 30 dias, o Liame informou ',
      forte: '31 vendas',
      depois: ' ao Google, para ele buscar quem compra.',
      atalho: { rotulo: 'Ver em Contas conectadas', href: HREF },
    });
    expect(linha(conta({ counts: { informed: 1, waiting: 0, corrected: 0, refused: 0 } }))!.forte).toBe('1 venda');
    // Esperando o Google (ele volta sozinho) segue como informando.
    expect(linha(conta({ status: 'esperando_a_plataforma' }))!.forte).toBe('31 vendas');
    // Recusas isoladas: o número aparece, sem virar aviso.
    const comRecusas = linha(conta({ counts: { informed: 28, waiting: 2, corrected: 1, refused: 3 } }))!;
    expect([comRecusas.tom, comRecusas.forte, comRecusas.depois, comRecusas.atalho.rotulo]).toEqual(['ok', '28 vendas', ' ao Google; ele recusou 3.', 'Ver o motivo em Contas conectadas']);
  });

  it('acabou de começar e ainda sem nenhuma: a frase não promete número que não existe', () => {
    const comecou = linha(conta({ destination: destino({ starts_at: local(9, 10, 0) }), counts: { informed: 0, waiting: 0, corrected: 0, refused: 0 }, last_run_at: null }))!;
    expect(comecou).toMatchObject({ tom: 'neutro', icone: 'clock', antes: 'O Liame começou a informar as vendas ao Google ', forte: 'hoje, 10:00', depois: '. A primeira sai duas horas depois de confirmada no caixa.' });
    // Passado o prazo e ainda sem venda de anúncio do Google: diz que nenhuma foi informada, e quantas esperam.
    const nenhuma = linha(conta({ counts: { informed: 0, waiting: 2, corrected: 0, refused: 0 } }))!;
    expect([nenhuma.tom, nenhuma.antes, nenhuma.forte]).toEqual(['neutro', 'Nos últimos 30 dias, nenhuma venda foi informada ao Google ainda. 2 esperam a vez.', '']);
    expect(linha(conta({ counts: { informed: 0, waiting: 1, corrected: 0, refused: 0 } }))!.antes).toContain('1 espera a vez.');
    expect(linha(conta({ counts: { informed: 0, waiting: 0, corrected: 0, refused: 0 } }))!.antes).toBe('Nos últimos 30 dias, nenhuma venda foi informada ao Google ainda.');
  });

  it('o envio parou sem ninguém mandar: a linha vira aviso (falta a permissão, ou o Google recusando)', () => {
    const falta = linha(conta({ status: 'sem_permissao', authorized: false }))!;
    expect(falta).toEqual({
      tom: 'atencao',
      icone: 'alert',
      antes: '',
      forte: 'O Liame parou de informar as vendas ao Google:',
      depois: ' falta uma permissão do Google. Os números desta tela não mudam: eles vêm do caixa.',
      atalho: { rotulo: 'Autorizar em Contas conectadas', href: HREF },
    });
    expect(linha(conta({ status: 'sem_permissao' }))!.depois).toBe(' o Google recusou a autorização. Os números desta tela não mudam: eles vêm do caixa.');
    const recusando = linha(conta({ refusing: { days: 7, refused: 9, answered: 12 } }))!;
    expect([recusando.tom, recusando.forte, recusando.depois, recusando.atalho.rotulo]).toEqual([
      'atencao',
      'O Google está recusando as vendas informadas:',
      ' 9 de 12 nos últimos 7 dias. Os números desta tela não mudam: eles vêm do caixa.',
      'Ver o motivo em Contas conectadas',
    ]);
  });

  it('sem envio por escolha, ou antes de configurar: tom neutro, sem aviso', () => {
    // Nunca configurado e sem a permissão: não "parou", falta autorizar.
    const semNada = linha(conta({ status: 'sem_permissao', authorized: false, destination: null }))!;
    expect([semNada.tom, semNada.antes, semNada.atalho.rotulo]).toEqual(['neutro', 'Falta uma permissão do Google para o Liame informar as vendas: nada é informado ainda.', 'Autorizar em Contas conectadas']);
    const escolher = linha(conta({ status: 'sem_destino', destination: null }))!;
    expect([escolher.tom, escolher.antes, escolher.atalho.rotulo]).toEqual(['neutro', 'Falta escolher onde o Google conta as vendas: nada é informado ainda.', 'Escolher em Contas conectadas']);
    const parado = linha(conta({ status: 'parado', destination: destino({ stopped_at: local(8, 14, 20), stopped_by: RODRIGO }) }))!;
    expect([parado.tom, parado.antes]).toEqual(['neutro', 'As vendas não estão sendo informadas ao Google: parado por Rodrigo em 08/10/2026.']);
    expect(linha(conta({ status: 'parado', destination: destino({ stopped_at: local(8, 14, 20) }) }))!.antes).toBe('As vendas não estão sendo informadas ao Google: parado em 08/10/2026.');
    const equipe = linha(conta({ status: 'equipe_parada', team_stopped_at: local(9, 9, 52), refusing: { days: 7, refused: 9, answered: 12 } }))!;
    expect([equipe.tom, equipe.antes]).toEqual(['neutro', 'A equipe está parada: nenhuma venda é informada ao Google enquanto estiver.']);
  });

  it('com mais de uma conta: soma as que informam, e a situação que mais pesa é a que aparece', () => {
    const outra = '01a0e1a1-ea5a-7822-a16c-000000000099';
    const duas = daMarca([conta(), conta({ connected_account_id: outra, name: 'Zona Sul', counts: { informed: 5, waiting: 0, corrected: 0, refused: 0 } })]);
    expect(linhaDasVendas(duas, agora)!.forte).toBe('36 vendas');
    // Uma informando e a outra sem a permissão: o aviso vence, e o atalho leva à conta que parou.
    const mista = daMarca([conta(), conta({ connected_account_id: outra, name: 'Zona Sul', status: 'sem_permissao', authorized: false })]);
    expect(linhaDasVendas(mista, agora)).toMatchObject({ tom: 'atencao', forte: 'O Liame parou de informar as vendas ao Google:', atalho: { href: `/contas#vendas-${outra}` } });
    // Uma parada por uma pessoa e a outra informando: a que falta mexer pesa mais que a que informa.
    const comParada = daMarca([conta(), conta({ connected_account_id: outra, status: 'parado', destination: destino({ stopped_at: local(8, 14, 20), stopped_by: RODRIGO }) })]);
    expect(linhaDasVendas(comParada, agora)!.antes).toContain('parado por Rodrigo');
  });

  it('a linha desenhada: o número em destaque, o atalho como link, e "status" só quando é aviso', () => {
    const html = (c: GoogleConversionAccount) => renderToStaticMarkup(createElement(LinhaVendasGoogle, { linha: linha(c)! }));
    const ok = html(conta());
    expect(ok).toContain('<p class="vg-linha vg-linha--ok">');
    expect(ok).toContain('Nos últimos 30 dias, o Liame informou <b>31 vendas</b> ao Google, para ele buscar quem compra. <a href="/contas#vendas-');
    expect(ok).toContain('>Ver em Contas conectadas</a>');
    expect(ok).not.toContain('role="status"');
    const aviso = html(conta({ status: 'sem_permissao', authorized: false }));
    expect(aviso).toContain('<p class="vg-linha vg-linha--atencao" role="status">');
    expect(aviso).toContain('<b>O Liame parou de informar as vendas ao Google:</b> falta uma permissão do Google.');
    expect(html(conta({ status: 'sem_destino', destination: null }))).toContain('<p class="vg-linha">');
  });

  it('o aviso na Atenção: o botão abre Contas conectadas no cartão da conta, só para quem vê as contas, e sem "Explicar"', () => {
    const item = (kind: string): AttentionItem => ({
      kind,
      severity: 'atencao',
      title: kind === 'vendas_google_sem_permissao' ? 'O Liame parou de informar as vendas ao Google' : 'O Google está recusando as vendas informadas',
      detail: 'Falta uma permissão do Google na conta Mister Burgers Google.',
      action: 'Em Contas conectadas, autorize o Google de novo e, na volta, confirme as contas. Nada é desligado.',
      connected_account_id: ID,
      campaign_id: null,
      provider: 'google_ads',
      brand_id: MARCA,
    });
    expect(destinoDasVendasAoGoogle(item('vendas_google_sem_permissao'))).toEqual({ href: HREF, rotulo: 'Abrir Contas conectadas', curto: 'Autorizar' });
    expect(destinoDasVendasAoGoogle(item('vendas_google_recusadas'))).toEqual({ href: HREF, rotulo: 'Ver o motivo em Contas conectadas', curto: 'Ver o motivo' });
    expect(destinoDasVendasAoGoogle({ kind: 'vendas_google_recusadas', connected_account_id: null })!.href).toBe('/contas#vendas-google');
    expect(destinoDasVendasAoGoogle({ kind: 'conta_desconectada', connected_account_id: ID })).toBeNull();

    const desenhar = (i: AttentionItem, podeVerContas = true) => renderToStaticMarkup(createElement(ItemAviso, { item: i, podeVerContas, podeConectar: true, podeVerVendas: true, aoReconectar: () => {} }));
    const html = desenhar(item('vendas_google_sem_permissao'));
    expect(html).toContain('data-sev="atencao"');
    expect(html).toContain('Google Ads</span>');
    expect(html).toContain('<h2 class="aviso-titulo">O Liame parou de informar as vendas ao Google</h2>');
    expect(html).toContain(`<a class="btn btn--sm" href="${HREF}">Abrir Contas conectadas</a>`);
    expect(html).not.toContain('Explicar');
    expect(desenhar(item('vendas_google_recusadas'))).toContain('>Ver o motivo em Contas conectadas</a>');
    // Quem não vê as contas lê o aviso, sem o atalho.
    expect(desenhar(item('vendas_google_sem_permissao'), false)).not.toContain('Contas conectadas</a>');
  });
});

describe('vendas informadas ao Google: o diálogo de escolher a conversão', () => {
  const dialogo = (c: GoogleConversionAccount) =>
    renderToStaticMarkup(createElement(DialogoConversao, { conta: c, esperaMin: 120, reserva: { current: null }, aoEscolher: () => {}, aoAutorizar: () => {}, aoFechar: () => {} }));

  it('abre lendo a lista no Google, já com o que o Liame envia, o que nunca envia e a nota; sem "Começar a informar" antes de a lista chegar', () => {
    const html = dialogo(conta({ status: 'sem_destino', destination: null }));
    expect(html).toContain('Onde o Google conta essas vendas</h2>');
    expect(html).toContain('Escolha a conversão da conta Mister Burgers Google que vai receber as vendas confirmadas no caixa.');
    expect(html).toContain('role="status"');
    expect(html).toContain('Lendo as conversões da conta no Google…');
    expect(html.match(/class="escopo"/g)).toHaveLength(4);
    expect(html).toContain('O que o Liame nunca envia');
    expect(html).toContain('Pedido que não veio de um clique num anúncio do Google.');
    expect(html).toContain('Cada pedido sai duas horas depois de confirmado no caixa.');
    expect(html).not.toContain('Ao trocar a conversão');
    expect(html).toContain('Agora não');
    expect(html).not.toContain('Começar a informar');
    // Com a conta informando, é uma troca: a nota diz o que acontece com o que esperava a vez.
    expect(dialogo(conta())).toContain('Ao trocar a conversão, as vendas que esperavam a vez para a antiga não são informadas.');
    // Voltando de uma parada não há o que esperasse: a nota não fala de troca.
    expect(dialogo(conta({ status: 'parado', destination: destino({ stopped_at: local(8, 14, 20) }) }))).not.toContain('Ao trocar a conversão');
  });
});

describe('autorizar o Google de novo: a autorização nova, com a permissão de informar vendas, assume as contas', () => {
  const descoberta = (provider: string, external_id: string, name: string, linked = false): DiscoveredAccount => ({ provider, external_id, name, currency: 'BRL', timezone: 'America/Sao_Paulo', linked, via: null });
  const conexao = (extra: Partial<ConnectionResponse> = {}): ConnectionResponse => ({
    id: ID,
    brand_id: MARCA,
    provider: 'google',
    origin: 'oauth',
    status: 'aguardando_escolha',
    error_code: null,
    authorized_by: null,
    created_at: local(9, 9, 0),
    completed_at: null,
    refresh_expires_at: null,
    scopes: [],
    discovered: [],
    accounts: [],
    ...extra,
  });
  const LEITURA = 'https://www.googleapis.com/auth/adwords';
  const d = [descoberta('google_ads', '4445556667', 'Mister Burgers Google', true), descoberta('ga4', '333444555', 'Site', true), descoberta('google_ads', '9990001112', 'Conta nova')];
  const ligadas = [
    { provider: 'google_ads', external_id: '4445556667', status: 'ativa', connection_id: 'antiga', disconnected_at: null },
    { provider: 'ga4', external_id: '333444555', status: 'ativa', connection_id: 'antiga', disconnected_at: null },
  ] as ConnectionResponse['accounts'];

  it('a conta do Google lida por uma autorização SEM a permissão entra na escolha da que a inclui, já marcada como troca', () => {
    const existentes = contasExistentes([conexao({ id: 'antiga', status: 'ativa', scopes: [LEITURA], accounts: ligadas })]);
    expect(existentes.map((e) => e.informa_vendas)).toEqual([false, false]);
    const nova = conexao({ discovered: d, scopes: [LEITURA, ESCOPO_DE_INFORMAR_VENDAS] });
    expect(escolhiveis(nova, existentes)).toEqual([
      { conta: d[0], reconectar: true, permissao: true },
      { conta: d[1], reconectar: true, permissao: true },
      { conta: d[2], reconectar: false },
    ]);
    expect(faixaDaVolta({ conexao: ID, erro: null }, nova, 'Mister Burgers', { existentes })?.tipo).toBe('escolher');

    // A nova não inclui a permissão: as ligadas ficam travadas, como sempre.
    expect(escolhiveis(conexao({ discovered: d, scopes: [LEITURA] }), existentes)).toEqual([{ conta: d[2], reconectar: false }]);
    // A que lê hoje já inclui: não há o que ganhar.
    const jaInforma = contasExistentes([conexao({ id: 'antiga', status: 'ativa', scopes: [LEITURA, ESCOPO_DE_INFORMAR_VENDAS], accounts: ligadas })]);
    expect(escolhiveis(nova, jaInforma)).toEqual([{ conta: d[2], reconectar: false }]);
    // Sem saber o que a autorização de hoje inclui, a tela não oferece a troca.
    expect(escolhiveis(nova, ligadas.map((a) => ({ ...a })))).toEqual([{ conta: d[2], reconectar: false }]);
    // A própria autorização não "assume" as contas dela.
    expect(escolhiveis({ ...nova, id: 'antiga' }, existentes)).toEqual([{ conta: d[2], reconectar: false }]);
    // Conta da Meta nunca entra por este caminho.
    const meta = [descoberta('meta_ads', 'act_1', 'Meta', true)];
    const daMeta = contasExistentes([conexao({ id: 'antiga', provider: 'meta', status: 'ativa', scopes: [], accounts: [{ ...ligadas[0]!, provider: 'meta_ads', external_id: 'act_1' }] })]);
    expect(escolhiveis(conexao({ provider: 'meta', discovered: meta, scopes: [ESCOPO_DE_INFORMAR_VENDAS] }), daMeta)).toEqual([]);
  });

  it('o diálogo de escolher contas marca as que passam para a autorização nova e não promete uma primeira leitura que não vai acontecer', () => {
    const existentes = contasExistentes([conexao({ id: 'antiga', status: 'ativa', scopes: [LEITURA], accounts: ligadas })]);
    const base = { existentes, marca: 'Mister Burgers', reserva: { current: null }, aoLigar: () => {}, aoFechar: () => {} };
    const soTroca = renderToStaticMarkup(createElement(DialogoEscolher, { ...base, conexao: conexao({ discovered: d.slice(0, 2), scopes: [LEITURA, ESCOPO_DE_INFORMAR_VENDAS] }) }));
    expect(soTroca).toContain('<span class="lite-chip">passa a poder informar vendas</span>');
    expect(soTroca).toContain('<span class="lite-chip">passa para esta autorização</span>');
    expect(soTroca).not.toContain('desconectada: ligar de novo');
    expect(soTroca).not.toContain('já ligada');
    expect(soTroca.match(/type="checkbox" checked=""/g)).toHaveLength(2);
    expect(soTroca).toContain('Ligar 2 contas');
    expect(soTroca).toContain('Estas contas já são lidas pelo Liame. Ligar aqui só passa a leitura para a autorização nova: nada é desligado, e os números seguem sem parar.');
    expect(soTroca).not.toContain('A primeira leitura traz os últimos 90 dias');
    // Com uma conta nova junto, a primeira leitura dela existe: a nota de sempre.
    const comNova = renderToStaticMarkup(createElement(DialogoEscolher, { ...base, conexao: conexao({ discovered: d, scopes: [LEITURA, ESCOPO_DE_INFORMAR_VENDAS] }) }));
    expect(comNova).toContain('A primeira leitura traz os últimos 90 dias e leva alguns minutos.');
    // Sem a permissão na autorização nova, as ligadas seguem travadas.
    const semPermissao = renderToStaticMarkup(createElement(DialogoEscolher, { ...base, conexao: conexao({ discovered: d, scopes: [LEITURA] }) }));
    expect(semPermissao.match(/já ligada/g)).toHaveLength(2);
    expect(semPermissao).not.toContain('passa a poder informar vendas');
  });

  it('o cartão da autorização do Google diz que inclui a permissão; o diálogo de conectar não promete "somente leitura" à marca com a função ligada', () => {
    const base = { conexao: conexao({ status: 'ativa', completed_at: local(7, 9), scopes: [LEITURA, ESCOPO_DE_INFORMAR_VENDAS] }), agora, podeConectar: true, procurando: false, aoEscolher: null, aoReconectar: () => {}, aoProcurar: () => {}, aoRevogar: () => {} };
    expect(renderToStaticMarkup(createElement(CartaoAutorizacao, { ...base, informaVendas: true }))).toContain('sem prazo de validade. Inclui a permissão de informar vendas.');
    expect(renderToStaticMarkup(createElement(CartaoAutorizacao, base))).not.toContain('Inclui a permissão de informar vendas.');
    // A Meta nunca ganha a frase.
    expect(renderToStaticMarkup(createElement(CartaoAutorizacao, { ...base, conexao: conexao({ provider: 'meta', status: 'ativa' }), informaVendas: true }))).not.toContain('informar vendas');

    const marcas = [{ id: MARCA, name: 'Mister Burgers', archived_at: null, purge_after: null }];
    const dialogo = { marcas, marcaInicial: null, reserva: { current: null }, aoFechar: () => {}, aoIr: () => {} };
    const sem = renderToStaticMarkup(createElement(DialogoConectar, dialogo));
    expect(sem).toContain('Uma autorização só para os dois. Somente leitura.');
    const com = renderToStaticMarkup(createElement(DialogoConectar, { ...dialogo, vendasAoGoogle: new Set([MARCA]) }));
    expect(com).toContain('Uma autorização só para os dois. Leitura, e a permissão de informar as vendas confirmadas.');
    expect(com).not.toContain('Somente leitura');
    expect(com).toContain('No Google, lê e informa as vendas confirmadas no caixa, para a conversão que você escolher.');
    // Função ligada para OUTRA marca: a frase desta não muda.
    expect(renderToStaticMarkup(createElement(DialogoConectar, { ...dialogo, vendasAoGoogle: new Set(['outra']) }))).toContain('Somente leitura.');

    expect(notaDeConectar(false, false)).toBe('Você vai para a página da plataforma, confirma lá e volta para cá. O Liame só lê: não cria, não muda e não gasta nada.');
    expect(notaDeConectar(true, false)).toContain('Na Meta e no Google, o Liame só lê: não cria, não muda e não gasta nada. No Regem, a única escrita possível é o cupom de campanha, sempre com aprovação.');
    expect(notaDeConectar(true, true)).toBe(
      'Você vai para a página da plataforma, confirma lá e volta para cá. Na Meta, o Liame só lê. No Google, lê e informa as vendas confirmadas no caixa, para a conversão que você escolher. Não cria, não muda e não gasta nada. No Regem, a única escrita possível é o cupom de campanha, sempre com aprovação.',
    );
  });
});

describe('o diálogo de conectar com a escrita ligada (A5 · Y3)', () => {
  const IDA = 'Você vai para a página da plataforma, confirma lá e volta para cá.';
  const REGEM = ' No Regem, a única escrita possível é o cupom de campanha, sempre com aprovação.';
  const NUNCA = ' Não cria nem apaga campanha, e nada muda sem essa aprovação.';

  it('a nota diz o que o Liame faz em cada plataforma: lê, e só muda com a aprovação de uma pessoa', () => {
    expect(notaDeConectar(false, false, ['google_ads'])).toBe(
      `${IDA} Na Meta, o Liame só lê. No Google, lê e, só com a aprovação de uma pessoa, muda a verba diária, pausa e retoma campanhas.${NUNCA}`,
    );
    expect(notaDeConectar(true, false, ['meta_ads'])).toBe(
      `${IDA} Na Meta, o Liame lê e, só com a aprovação de uma pessoa, muda a verba diária, pausa e retoma campanhas, conjuntos e anúncios. No Google, o Liame só lê.${NUNCA}${REGEM}`,
    );
    expect(notaDeConectar(true, true, ['meta_ads', 'google_ads'])).toBe(
      `${IDA} Na Meta, o Liame lê e, só com a aprovação de uma pessoa, muda a verba diária, pausa e retoma campanhas, conjuntos e anúncios. No Google, lê, informa as vendas confirmadas no caixa (para a conversão que você escolher) e, só com a aprovação de uma pessoa, muda a verba diária, pausa e retoma campanhas.${NUNCA}${REGEM}`,
    );
    // A Meta com a escrita e o Google só com as vendas informadas.
    expect(notaDeConectar(false, true, ['meta_ads'])).toContain('No Google, lê e informa as vendas confirmadas no caixa, para a conversão que você escolher.');
    // Com a escrita ligada, a nota não diz mais que o Liame "não muda" nada.
    for (const quais of [['meta_ads'], ['google_ads'], ['meta_ads', 'google_ads']]) expect(notaDeConectar(true, false, quais)).not.toContain('não muda e não gasta nada');
  });

  it('sem a escrita ligada (ou sem o servidor dizer), a nota é a de sempre', () => {
    expect(notaDeConectar(false, false, [])).toBe(notaDeConectar(false, false));
    expect(notaDeConectar(true, true, [])).toBe(notaDeConectar(true, true));
    expect(notaDeConectar(true, false, ['plataforma_nova'])).toBe(notaDeConectar(true, false));
    expect(notaDeConectar(true, false)).toContain('Na Meta e no Google, o Liame só lê: não cria, não muda e não gasta nada.');
  });

  it('a linha do botão do Google: leitura, as vendas informadas e as mudanças que a pessoa aprovar', () => {
    expect(descricaoDoGoogle(false)).toBe('Uma autorização só para os dois. Somente leitura.');
    expect(descricaoDoGoogle(true)).toBe('Uma autorização só para os dois. Leitura, e a permissão de informar as vendas confirmadas.');
    expect(descricaoDoGoogle(false, ['google_ads'])).toBe('Uma autorização só para os dois. Leitura e, no Google Ads, as mudanças que você aprovar.');
    expect(descricaoDoGoogle(true, ['google_ads'])).toBe('Uma autorização só para os dois. Leitura, a permissão de informar as vendas confirmadas e, no Google Ads, as mudanças que você aprovar.');
    // A escrita ligada só na Meta não muda a linha do Google.
    expect(descricaoDoGoogle(false, ['meta_ads'])).toBe('Uma autorização só para os dois. Somente leitura.');
  });

  it('desenhado: com a escrita no Google ligada, o diálogo não promete "somente leitura"', () => {
    const marcas = [{ id: MARCA, name: 'Mister Burgers', archived_at: null, purge_after: null }];
    const dialogo = { marcas, marcaInicial: null, reserva: { current: null }, aoFechar: () => {}, aoIr: () => {} };
    const com = renderToStaticMarkup(createElement(DialogoConectar, { ...dialogo, mudaAnuncios: ['google_ads'] }));
    expect(com).toContain('Uma autorização só para os dois. Leitura e, no Google Ads, as mudanças que você aprovar.');
    expect(com).toContain('No Google, lê e, só com a aprovação de uma pessoa, muda a verba diária, pausa e retoma campanhas.');
    expect(com).not.toContain('Somente leitura');
    expect(com).not.toContain('não muda e não gasta nada');
    const sem = renderToStaticMarkup(createElement(DialogoConectar, dialogo));
    expect(sem).toContain('Uma autorização só para os dois. Somente leitura.');
    expect(sem).toContain('O Liame só lê: não cria, não muda e não gasta nada.');
    expect(`${com}${sem}`).not.toMatch(/NaN|undefined|\[object Object\]/);
  });
});
