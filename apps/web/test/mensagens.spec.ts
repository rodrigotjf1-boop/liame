import type { MessagingAccount, MessagingCampaign, MessagingCampaignDetailResponse, MessagingResponse } from '@liame/contracts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MensagensConteudo } from '@/components/mensagens/mensagens-conteudo';
import { centavos, contaDaTela, dadosDa, detalheDaMensagem, fraseDasEnviadas, jaSaiu, numerosDa, porCento, seloDaCampanha, telaDasMensagens } from '@/components/mensagens/textos';
import { itensVisiveis, NAVEGACAO, temModos, tituloDa } from '@/components/shell/navegacao';
import { Icone } from '@/components/ui/icone';
import { quandoComHora } from '@/lib/formato';

// "Mensagens" (A5 · Y4; mockups/prototipo-mensagens.html, P15 aprovado em 09/10/2026): o que foi enviado pelo
// RegemCast, se a conta do WhatsApp pode enviar, o teto de gasto e o que há pronto. As frases e os números saem do
// que a API manda (`GET /v1/messaging` e `GET /v1/messaging/campaigns/:id`); a tela é desenhada pelo mesmo
// componente do navegador. O cenário é o do protótipo: outubro, com o teto de R$ 300,00.

const AGORA = new Date('2026-10-09T15:00:00Z');
const CONTA = '11111111-1111-4111-8111-111111111111';
const MARCA = '22222222-2222-4222-8222-222222222222';
// O espaço fixo que o `Intl` põe depois de "R$".
const RS = 'R$ ';

function campanha(parcial: Partial<MessagingCampaign> = {}): MessagingCampaign {
  return {
    id: 'c1',
    name: 'Combo família de domingo',
    status: 'concluida',
    pause_reason: null,
    template: 'combo_domingo_v2',
    category: 'marketing',
    audience: 'Clientes de domingo',
    recipients: 412,
    queued: 0,
    sent: 405,
    delivered: 398,
    read: 311,
    failed: 7,
    replied: 23,
    created_at: '2026-10-08T13:00:00.000Z',
    started_at: '2026-10-08T14:00:00.000Z',
    finished_at: '2026-10-08T14:19:00.000Z',
    ...parcial,
  };
}

function conta(parcial: Partial<MessagingAccount> = {}): MessagingAccount {
  return {
    connected_account_id: CONTA,
    name: 'Smash da Vila',
    status: 'ok',
    whatsapp: { status: 'ok', connected: true, signal: 'pode_enviar', title: 'Tudo certo para enviar', summary: 'A conta do WhatsApp está saudável na Meta.', checked_at: '2026-10-09T12:00:00.000Z', problems: [] },
    budget: { status: 'ok', currency: 'BRL', periods: [{ period: 'mes', label: 'Outubro', limit_cents: 30_000, spent_cents: 12_736, percent: 42.45, signal: 'ok' }], notices: [] },
    ready: { templates_status: 'ok', approved_templates: 3, templates: 4, audiences_status: 'ok', audiences: 4, largest_audience: 450 },
    campaigns: { status: 'ok', total: 3, items: [campanha(), campanha({ id: 'c2', name: 'Voltou a chover', status: 'enviando', sent: 180, delivered: 0, read: 0, failed: 0, replied: 0, queued: 232, finished_at: null }), campanha({ id: 'c3', name: 'Rascunho de sexta', status: 'rascunho', sent: 0, delivered: 0, read: 0, failed: 0, replied: 0, started_at: null, finished_at: null })] },
    ...parcial,
  };
}

function resposta(parcial: Partial<MessagingResponse> = {}): MessagingResponse {
  return { brand_id: MARCA, enabled: true, read_at: '2026-10-09T14:40:00.000Z', accounts: [conta()], ...parcial };
}

const SEM_LEITURA = {
  whatsapp: { status: 'sem_permissao', connected: null, signal: null, title: null, summary: null, checked_at: null, problems: [] },
  budget: { status: 'sem_permissao', currency: null, periods: [], notices: [] },
  ready: { templates_status: 'sem_permissao', approved_templates: null, templates: null, audiences_status: 'sem_permissao', audiences: null, largest_audience: null },
  campaigns: { status: 'sem_permissao', total: null, items: [] },
} satisfies Partial<MessagingAccount>;

const trocar = (partes: typeof SEM_LEITURA, status: string): typeof SEM_LEITURA => ({
  whatsapp: { ...partes.whatsapp, status },
  budget: { ...partes.budget, status },
  ready: { ...partes.ready, templates_status: status, audiences_status: status },
  campaigns: { ...partes.campaigns, status },
});

function pronta(c: MessagingAccount) {
  const t = contaDaTela(c, AGORA);
  if (t.tipo !== 'ok') throw new Error(`a conta não abriu: ${t.tipo}`);
  return t;
}

function desenho(c: MessagingAccount, modo: 'lite' | 'pro' = 'lite', podeVerContas = true) {
  return renderToStaticMarkup(createElement(MensagensConteudo, { conta: contaDaTela(c, AGORA), modo, podeVerContas, aoVer: () => {}, aoTentarDeNovo: () => {} }));
}

describe('formatos da tela', () => {
  it('centavos viram reais com os centavos, e o por cento não divide por zero', () => {
    expect(centavos(12_736)).toBe(`${RS}127,36`);
    expect(centavos(0)).toBe(`${RS}0,00`);
    expect(porCento(311, 398)).toBe(78);
    expect(porCento(5, 0)).toBe(0);
  });

  it('o selo de cada situação da campanha, e a situação que a tela não conhece', () => {
    expect(seloDaCampanha('concluida')).toMatchObject({ rotulo: 'Enviada', classe: 'concluido' });
    expect(seloDaCampanha('enviando').rotulo).toBe('Enviando');
    expect(seloDaCampanha('pausada')).toMatchObject({ rotulo: 'Pausada', classe: 'aguardando' });
    expect(seloDaCampanha('cancelada').rotulo).toBe('Cancelada');
    expect(seloDaCampanha('outra_coisa').rotulo).toBe('Situação não informada');
  });

  it('entra em "O que foi enviado" o que começou a sair; rascunho e agendada, não', () => {
    expect(jaSaiu(campanha())).toBe(true);
    expect(jaSaiu(campanha({ status: 'enviando', sent: 0 }))).toBe(true);
    expect(jaSaiu(campanha({ status: 'cancelada', sent: 12 }))).toBe(true);
    expect(jaSaiu(campanha({ status: 'cancelada', sent: 0 }))).toBe(false);
    expect(jaSaiu(campanha({ status: 'rascunho', sent: 0 }))).toBe(false);
    expect(jaSaiu(campanha({ status: 'agendada', sent: 0 }))).toBe(false);
  });
});

describe('o que a tela mostra para a resposta do servidor', () => {
  it('a função desligada e o RegemCast sem conexão', () => {
    expect(telaDasMensagens(resposta({ enabled: false, accounts: [] }), AGORA)).toEqual({ tipo: 'desligada' });
    expect(telaDasMensagens(resposta({ accounts: [] }), AGORA)).toEqual({ tipo: 'sem_regemcast' });
  });

  it('com conta, diz quando leu e lista as contas', () => {
    expect(telaDasMensagens(resposta(), AGORA)).toEqual({ tipo: 'contas', lido: `Lido do RegemCast ${quandoComHora('2026-10-09T14:40:00.000Z', AGORA)}`, contas: [{ id: CONTA, nome: 'Smash da Vila' }] });
  });

  it('a conta que o RegemCast recusou, a que não deixa ler nada e a que não respondeu', () => {
    expect(contaDaTela(conta({ status: 'sem_autorizacao', ...trocar(SEM_LEITURA, 'indisponivel') }), AGORA)).toEqual({ tipo: 'sem_autorizacao' });
    expect(contaDaTela(conta(SEM_LEITURA), AGORA)).toEqual({ tipo: 'sem_permissao' });
    expect(contaDaTela(conta(trocar(SEM_LEITURA, 'indisponivel')), AGORA)).toEqual({ tipo: 'fora_do_ar' });
    // O Liame sem o endereço do RegemCast: nada foi lido.
    expect(contaDaTela(conta({ status: 'indisponivel', ...trocar(SEM_LEITURA, 'indisponivel') }), AGORA)).toEqual({ tipo: 'fora_do_ar' });
    // Uma parte lida já abre a tela: as outras dizem, cada uma, por que não vieram.
    expect(contaDaTela(conta({ ...SEM_LEITURA, campaigns: conta().campaigns }), AGORA).tipo).toBe('ok');
  });
});

describe('as três caixas do topo', () => {
  it('a conta que pode enviar, o teto de outubro e o que há pronto', () => {
    const t = pronta(conta());
    expect(t.avisos).toEqual([]);
    expect(t.conta).toEqual({ selo: { classe: 'concluido', rotulo: 'Pode enviar', ponto: true }, titulo: null, sub: `lido da Meta ${quandoComHora('2026-10-09T12:00:00.000Z', AGORA)}` });
    expect(t.teto).toEqual({
      tipo: 'periodos',
      periodos: [{ chave: 'mes', rotulo: 'Teto de gasto de outubro', valor: `${RS}127,36 de ${RS}300,00`, largura: 42, cheio: false, descricao: '42% do teto de gasto de mensagens de outubro usado' }],
      sub: 'definido por você no RegemCast',
      notas: [],
    });
    expect(t.pronto).toEqual({ titulo: '3 modelos aprovados · 4 públicos', sub: 'o maior público tem 450 pessoas que podem receber' });
  });

  it('a conta sem número, sem leitura da Meta e sem permissão', () => {
    const base = conta().whatsapp;
    const semNumero = pronta(conta({ whatsapp: { ...base, connected: false, signal: null, checked_at: null } }));
    expect(semNumero.conta.selo?.rotulo).toBe('Sem número conectado');
    expect(semNumero.avisos.map((a) => a.chave)).toEqual(['sem-numero']);
    expect(semNumero.avisos[0]!.texto).toContain('nenhuma mensagem sai');
    const semSinal = pronta(conta({ whatsapp: { ...base, signal: 'desconhecido', checked_at: null } }));
    expect(semSinal.conta).toMatchObject({ selo: { rotulo: 'Sem leitura da Meta' }, sub: 'o RegemCast ainda não leu a situação na Meta' });
    expect(semSinal.avisos).toEqual([]);
    const semPermissao = pronta(conta({ whatsapp: SEM_LEITURA.whatsapp }));
    expect(semPermissao.conta).toEqual({ selo: null, titulo: 'Sem permissão para ler', sub: 'a conexão com o RegemCast não inclui esta leitura' });
    expect(pronta(conta({ whatsapp: { ...SEM_LEITURA.whatsapp, status: 'indisponivel' } })).conta.titulo).toBe('Não foi possível ler agora');
  });

  it('a conta com restrição: a faixa escreve o que o RegemCast informa, e só a bloqueada diz que nada sai', () => {
    const base = conta().whatsapp;
    const restrita = pronta(
      conta({ whatsapp: { ...base, signal: 'com_restricao', title: 'A Meta limitou o envio', summary: 'A qualidade do número caiu', problems: [{ where: 'Número da loja', title: 'Qualidade baixa', explanation: 'Muitas pessoas bloquearam as mensagens.', action: 'Reduza o envio por alguns dias' }] } }),
    );
    expect(restrita.conta.selo).toMatchObject({ rotulo: 'Com restrição', classe: 'perigo' });
    expect(restrita.avisos).toEqual([
      {
        chave: 'conta',
        tipo: 'perigo',
        icone: 'alert',
        titulo: 'A conta do WhatsApp está com restrição na Meta',
        texto: 'O que o RegemCast informa: A qualidade do número caiu. O que a Meta aponta: Qualidade baixa. O que fazer: Reduza o envio por alguns dias. O que resolve fica no RegemCast.',
      },
    ]);
    const bloqueada = pronta(conta({ whatsapp: { ...base, signal: 'bloqueado', title: null, summary: null } }));
    expect(bloqueada.conta.selo?.rotulo).toBe('Bloqueada');
    expect(bloqueada.avisos[0]).toMatchObject({ titulo: 'A conta do WhatsApp está bloqueada na Meta: nenhuma mensagem sai agora', texto: 'O que resolve fica no RegemCast.' });
  });

  it('o teto cheio: a faixa com o aviso do RegemCast, ou a frase do período quando ele não avisa', () => {
    const cheio = { period: 'mes', label: 'Outubro', limit_cents: 30_000, spent_cents: 30_000, percent: 100, signal: 'cheio' };
    const comAviso = pronta(conta({ budget: { status: 'ok', currency: 'BRL', periods: [cheio], notices: ['O teto do mês foi atingido: os envios estão pausados até a virada do mês'] } }));
    expect(comAviso.avisos).toEqual([
      {
        chave: 'teto',
        tipo: 'atencao',
        icone: 'wallet',
        titulo: 'O teto de gasto de mensagens de outubro foi atingido',
        texto: `Já saíram ${RS}300,00 de ${RS}300,00. O teto do mês foi atingido: os envios estão pausados até a virada do mês. Quem muda o teto é você, no RegemCast.`,
      },
    ]);
    // O que o RegemCast avisou já está na faixa: a caixa não repete.
    expect(comAviso.teto).toMatchObject({ tipo: 'periodos', notas: [], periodos: [{ cheio: true, largura: 100 }] });
    const doDia = pronta(conta({ budget: { status: 'ok', currency: 'BRL', periods: [{ ...cheio, period: 'dia', label: 'Hoje', percent: 130 }], notices: [] } }));
    expect(doDia.avisos[0]).toMatchObject({ titulo: 'O teto de gasto de mensagens de hoje foi atingido' });
    expect(doDia.avisos[0]!.texto).toContain('O RegemCast pausa os envios e volta sozinho amanhã.');
    // A barra não passa da largura, mas quem lê sabe que passou.
    expect(doDia.teto).toMatchObject({ periodos: [{ rotulo: 'Teto de gasto de hoje', largura: 100, descricao: '130% do teto de gasto de mensagens de hoje usado' }] });
  });

  it('sem teto definido, sem permissão, e os avisos do RegemCast quando o teto não está cheio', () => {
    expect(pronta(conta({ budget: { status: 'ok', currency: 'BRL', periods: [], notices: [] } })).teto).toEqual({ tipo: 'texto', titulo: 'Sem teto definido', sub: 'o teto de gasto de mensagens é definido por você no RegemCast' });
    expect(pronta(conta({ budget: SEM_LEITURA.budget })).teto).toMatchObject({ tipo: 'texto', titulo: 'Sem permissão para ler' });
    const perto = pronta(conta({ budget: { status: 'ok', currency: 'BRL', periods: [{ period: 'semana', label: 'Esta semana', limit_cents: 10_000, spent_cents: 8_500, percent: 85, signal: 'atencao' }], notices: ['Faltam R$ 15,00 para o teto da semana.'] } }));
    expect(perto.avisos).toEqual([]);
    expect(perto.teto).toMatchObject({ tipo: 'periodos', notas: ['Faltam R$ 15,00 para o teto da semana.'], periodos: [{ rotulo: 'Teto de gasto da semana', largura: 85, cheio: false }] });
  });

  it('o que há pronto quando falta modelo, falta público ou uma das leituras', () => {
    const r = conta().ready;
    expect(pronta(conta({ ready: { ...r, approved_templates: 0 } })).pronto).toEqual({ titulo: '0 modelos aprovados · 4 públicos', sub: 'sem modelo aprovado pela Meta, nenhuma mensagem pode sair' });
    expect(pronta(conta({ ready: { ...r, approved_templates: 1, audiences: 0, largest_audience: null } })).pronto).toEqual({ titulo: '1 modelo aprovado · 0 públicos', sub: 'nenhum público ainda: eles são montados no RegemCast' });
    expect(pronta(conta({ ready: { ...r, audiences: 1, largest_audience: 1 } })).pronto.sub).toBe('o maior público tem 1 pessoa que pode receber');
    expect(pronta(conta({ ready: { ...r, templates_status: 'sem_permissao', approved_templates: null, templates: null } })).pronto).toEqual({ titulo: '4 públicos', sub: 'a conexão com o RegemCast não inclui os modelos' });
    expect(pronta(conta({ ready: { ...r, audiences_status: 'indisponivel', audiences: null, largest_audience: null } })).pronto).toEqual({ titulo: '3 modelos aprovados', sub: 'os públicos não foram lidos agora' });
    expect(pronta(conta({ ready: SEM_LEITURA.ready })).pronto).toEqual({ titulo: 'Sem permissão para ler', sub: 'a conexão com o RegemCast não inclui os modelos nem os públicos' });
  });
});

describe('o que foi enviado', () => {
  it('a lista só com o que saiu, a frase do modo simples e o aviso do que ficou de fora', () => {
    const e = pronta(conta()).enviadas;
    if (e.tipo !== 'lista') throw new Error(e.tipo);
    expect(e.itens.map((m) => m.id)).toEqual(['c1', 'c2']);
    expect(e.itens[0]).toEqual({
      id: 'c1',
      nome: 'Combo família de domingo',
      selo: { classe: 'concluido', rotulo: 'Enviada', ponto: true },
      sob: `${quandoComHora('2026-10-08T14:00:00.000Z', AGORA)} · Clientes de domingo`,
      receberam: 398,
      leram: 311,
      leramPct: 78,
      responderam: 23,
      falharam: 7,
    });
    expect(textoCorrido(e.frase)).toBe('As 2 mensagens foram entregues 398 vezes, foram lidas 311 vezes e tiveram 23 respostas.');
    expect(e.fora).toBe('Mais 1 campanha não aparece aqui porque nada saiu dela (rascunho, agendada ou cancelada antes do envio). O RegemCast mostra todas.');
    // O total do RegemCast é o do que veio: não há mais campanhas do que a leitura trouxe.
    expect(e.mais).toBeNull();
  });

  it('quando o RegemCast tem mais campanhas do que a leitura trouxe, a tela diz', () => {
    const e = pronta(conta({ campaigns: { status: 'ok', total: 57, items: [campanha()] } })).enviadas;
    expect(e).toMatchObject({ tipo: 'lista', mais: 'A leitura traz só as campanhas mais novas: 1 de 57 que estão no RegemCast.', fora: null });
  });

  it('a frase com uma mensagem só, no singular, e quando ninguém recebeu ainda', () => {
    const uma = pronta(conta({ campaigns: { status: 'ok', total: 1, items: [campanha({ delivered: 1, read: 1, replied: 1 })] } })).enviadas;
    if (uma.tipo !== 'lista') throw new Error(uma.tipo);
    expect(textoCorrido(uma.frase)).toBe('A mensagem foi entregue 1 vez, foi lida 1 vez e teve 1 resposta.');
    expect(textoCorrido(fraseDasEnviadas([{ ...uma.itens[0]!, receberam: 0, leram: 0, responderam: 0 }]))).toBe('A mensagem ainda não chegou a ninguém.');
  });

  it('sem nada enviado, sem permissão e sem resposta', () => {
    expect(pronta(conta({ campaigns: { status: 'ok', total: 0, items: [] } })).enviadas).toEqual({ tipo: 'vazia', fora: null });
    expect(pronta(conta({ campaigns: { status: 'ok', total: 2, items: [campanha({ status: 'rascunho', sent: 0 }), campanha({ id: 'c9', status: 'agendada', sent: 0 })] } })).enviadas).toMatchObject({ tipo: 'vazia', fora: expect.stringContaining('Mais 2 campanhas não aparecem aqui') });
    expect(pronta(conta({ campaigns: SEM_LEITURA.campaigns })).enviadas).toEqual({ tipo: 'sem_permissao' });
    expect(pronta(conta({ campaigns: { status: 'indisponivel', total: null, items: [] } })).enviadas).toEqual({ tipo: 'indisponivel' });
  });
});

describe('uma mensagem de perto', () => {
  const detalhe = (parcial: Partial<MessagingCampaignDetailResponse> = {}): MessagingCampaignDetailResponse => ({
    connected_account_id: CONTA,
    campaign: campanha(),
    pause: null,
    waiting: null,
    failures: [{ messages: 5, title: 'Número sem WhatsApp', explanation: 'O número não tem conta no WhatsApp', action: 'Confira o número no cadastro' }, { messages: 2, title: 'A Meta limitou o envio para este número', explanation: 'A pessoa já recebeu marketing demais.', action: null }],
    cost: { currency: 'BRL', spent_cents: 12_736, to_spend_cents: 0, lines: [{ label: 'Gasto na Meta', value: 'R$ 127,36', detail: '398 mensagens entregues' }], notices: [] },
    rest_days: 7,
    ...parcial,
  });

  it('os números na ordem em que a mensagem anda, com a fila só quando há fila', () => {
    expect(numerosDa(campanha()).map((n) => `${n.valor} ${n.rotulo}`)).toEqual(['405 enviadas', '398 entregues', '311 lidas', '23 responderam', '7 falharam']);
    expect(numerosDa(campanha({ queued: 232 })).at(-1)).toEqual({ chave: 'fila', valor: '232', rotulo: 'na fila' });
  });

  it('o que a lista já sabe: a situação, para quantas pessoas, o modelo, o público e os horários', () => {
    expect(dadosDa(campanha(), AGORA)).toEqual([
      { rotulo: 'Situação', valor: 'Enviada' },
      { rotulo: 'Para quantas pessoas', valor: '412' },
      { rotulo: 'Modelo', valor: 'combo_domingo_v2 (marketing)' },
      { rotulo: 'Público', valor: 'Clientes de domingo' },
      { rotulo: 'Começou', valor: quandoComHora('2026-10-08T14:00:00.000Z', AGORA) },
      { rotulo: 'Terminou', valor: quandoComHora('2026-10-08T14:19:00.000Z', AGORA) },
    ]);
    expect(dadosDa(campanha({ category: null, audience: null, started_at: null, finished_at: null }), AGORA).map((d) => d.valor)).toEqual(['Enviada', '412', 'combo_domingo_v2', 'Não informado']);
  });

  it('as falhas por motivo, com o que fazer, e o custo com as linhas do RegemCast', () => {
    const d = detalheDaMensagem(detalhe(), AGORA);
    expect(d.pausa).toBeNull();
    expect(d.espera).toBeNull();
    expect(d.falhas).toEqual({
      titulo: 'Por que 7 falharam',
      semMotivo: false,
      itens: [
        { chave: '0-Número sem WhatsApp', quantas: '5', titulo: 'Número sem WhatsApp', explicacao: 'O número não tem conta no WhatsApp.', acao: 'Confira o número no cadastro.' },
        { chave: '1-A Meta limitou o envio para este número', quantas: '2', titulo: 'A Meta limitou o envio para este número', explicacao: 'A pessoa já recebeu marketing demais.', acao: null },
      ],
    });
    expect(d.custo).toEqual({ linhas: [{ rotulo: 'Gasto na Meta', valor: 'R$ 127,36', detalhe: '398 mensagens entregues' }], avisos: [] });
    expect(d.descanso).toBe('No RegemCast, quem recebe uma mensagem de marketing só recebe outra depois de 7 dias.');
  });

  it('sem falha não há bloco; com falha sem motivo, a tela diz que o RegemCast não informou', () => {
    expect(detalheDaMensagem(detalhe({ campaign: campanha({ failed: 0 }), failures: [] }), AGORA).falhas).toBeNull();
    expect(detalheDaMensagem(detalhe({ campaign: campanha({ failed: 1 }), failures: [] }), AGORA).falhas).toEqual({ titulo: 'Por que 1 falhou', itens: [], semMotivo: true });
  });

  it('o custo sem as linhas do RegemCast sai dos números, e sem preço a tela diz que não há', () => {
    const semLinhas = detalheDaMensagem(detalhe({ cost: { currency: 'BRL', spent_cents: 5_760, to_spend_cents: 7_424, lines: [], notices: ['Estimativa pelo preço de hoje'] } }), AGORA);
    expect(semLinhas.custo).toEqual({ linhas: [{ rotulo: 'Já gasto na Meta', valor: `${RS}57,60`, detalhe: null }, { rotulo: 'Ainda pode sair', valor: `até ${RS}74,24`, detalhe: null }], avisos: ['Estimativa pelo preço de hoje.'] });
    expect(detalheDaMensagem(detalhe({ cost: null, rest_days: null }), AGORA)).toMatchObject({ custo: null, descanso: null });
    expect(detalheDaMensagem(detalhe({ rest_days: 0 }), AGORA).descanso).toBe('Esta conta não tem descanso entre mensagens de marketing no RegemCast.');
    expect(detalheDaMensagem(detalhe({ rest_days: 1 }), AGORA).descanso).toContain('depois de 1 dia.');
  });

  it('por que está pausada e por que está esperando, com a volta', () => {
    const volta = '2026-11-01T03:00:00.000Z';
    const pausada = detalheDaMensagem(detalhe({ campaign: campanha({ status: 'pausada', pause_reason: 'orcamento' }), pause: { reason: 'orcamento', explanation: 'O teto de gasto do mês foi atingido', resumes_at: volta } }), AGORA);
    expect(pausada.pausa).toEqual({ titulo: 'Pausada: o teto de gasto de mensagens foi atingido', texto: 'O teto de gasto do mês foi atingido.', volta: `Volta ${quandoComHora(volta, AGORA)}.` });
    expect(detalheDaMensagem(detalhe({ pause: { reason: 'manual', explanation: null, resumes_at: null } }), AGORA).pausa).toEqual({ titulo: 'Pausada por uma pessoa', texto: null, volta: null });
    // O motivo que a tela não conhece não vira frase inventada: fica o que o RegemCast explicou.
    expect(detalheDaMensagem(detalhe({ pause: { reason: 'motivo_novo', explanation: 'Explicação do RegemCast.', resumes_at: null } }), AGORA).pausa).toEqual({ titulo: 'Pausada', texto: 'Explicação do RegemCast.', volta: null });
    const ate = '2026-10-09T17:00:00.000Z';
    expect(detalheDaMensagem(detalhe({ waiting: { reason: 'limite_meta', until: ate } }), AGORA).espera).toEqual({ titulo: 'Esperando: o limite de envios que a Meta dá ao número foi atingido', texto: null, volta: `Continua ${quandoComHora(ate, AGORA)}.` });
    expect(detalheDaMensagem(detalhe({ waiting: { reason: 'outro', until: null } }), AGORA).espera).toEqual({ titulo: 'Esperando para continuar', texto: null, volta: null });
  });
});

describe('a tela desenhada', () => {
  it('modo simples: as faixas, as três caixas, a frase, a lista com o botão Ver e a nota de quem recebeu', () => {
    const html = desenho(conta());
    const t = textoDe(html);
    expect(html).toContain('id="mens-conta"');
    expect(t).toContain('Conta do WhatsApp');
    expect(t).toContain('Pode enviar');
    expect(t).toContain('Teto de gasto de outubro');
    expect(html).toContain('aria-label="42% do teto de gasto de mensagens de outubro usado"');
    expect(html).toContain('style="width:42%"');
    expect(t).toContain('3 modelos aprovados · 4 públicos');
    expect(t).toContain('O que foi enviado');
    expect(t).toContain('As 2 mensagens foram entregues 398 vezes, foram lidas 311 vezes e tiveram 23 respostas.');
    expect(html).toContain('class="mens-lista"');
    expect(html).not.toContain('<table');
    expect(t).toContain('311 leram (78%)');
    expect(t).toContain('23 responderam · 7 falharam');
    // A que ainda está saindo mostra a situação e não finge leitura.
    expect(t).toContain('Enviando');
    expect(t).toContain('Ninguém recebeu ainda');
    expect(html).toContain('data-mens-ver="c1"');
    expect(html).toContain('aria-label="Ver a mensagem Combo família de domingo"');
    expect(t).toContain('“Receberam” é a mensagem entregue, que é a que a Meta cobra. O Liame não vê o nome nem o telefone de ninguém.');
    expect(t).toContain('Mais 1 campanha não aparece aqui');
    // O que depende do cupom da mensagem entra com o pedido de mensagem (Y5).
    expect(t).not.toContain('cupom');
    expect(html).not.toContain('role="alert"');
  });

  it('modo completo: a tabela com as quatro colunas de número e o rótulo de cada célula para a pilha', () => {
    const html = desenho(conta(), 'pro');
    const t = textoDe(html);
    expect(html).toContain('class="tabela tabela--pilha"');
    expect(html).not.toContain('class="mens-lista"');
    for (const coluna of ['Receberam', 'Leram', 'Responderam', 'Falharam']) expect(html).toContain(`data-rot="${coluna}"`);
    expect(t).toContain('78% de quem recebeu');
    expect(html).toContain('Mensagens enviadas, com o resultado de cada uma');
    expect(html).toContain('data-mens-ver="c2"');
  });

  it('a conta com restrição e o teto cheio viram faixas no topo, a de perigo anunciada na hora', () => {
    const c = conta({
      whatsapp: { ...conta().whatsapp, signal: 'com_restricao', summary: 'A qualidade do número caiu.' },
      budget: { status: 'ok', currency: 'BRL', periods: [{ period: 'mes', label: 'Outubro', limit_cents: 30_000, spent_cents: 30_000, percent: 100, signal: 'cheio' }], notices: [] },
    });
    const html = desenho(c);
    const t = textoDe(html);
    expect(html).toContain('class="faixa faixa--perigo" role="alert"');
    expect(t).toContain('A conta do WhatsApp está com restrição na Meta');
    expect(html).toContain('class="faixa faixa--atencao" role="status"');
    expect(t).toContain('O teto de gasto de mensagens de outubro foi atingido');
    expect(html).toContain('mens-teto mens-teto--cheio');
    expect(t).toContain('Com restrição');
  });

  it('nada enviado ainda, e a leitura das campanhas que não veio', () => {
    expect(textoDe(desenho(conta({ campaigns: { status: 'ok', total: 0, items: [] } })))).toContain('Nenhuma mensagem enviada ainda');
    expect(textoDe(desenho(conta({ campaigns: SEM_LEITURA.campaigns })))).toContain('A conexão com o RegemCast não deixa ler as campanhas');
    const fora = desenho(conta({ campaigns: { status: 'indisponivel', total: null, items: [] } }));
    expect(textoDe(fora)).toContain('Não foi possível ler as campanhas agora');
    expect(textoDe(fora)).toContain('Tentar de novo');
    // As caixas do topo seguem na tela.
    expect(fora).toContain('id="mens-teto"');
  });

  it('a conta recusada, a sem permissão e a que não respondeu: o caminho para Contas conectadas só para quem pode', () => {
    const recusada = desenho(conta({ status: 'sem_autorizacao', ...trocar(SEM_LEITURA, 'indisponivel') }));
    expect(textoDe(recusada)).toContain('Conecte o RegemCast de novo');
    expect(recusada).toContain('href="/contas"');
    const semPoder = desenho(conta({ status: 'sem_autorizacao', ...trocar(SEM_LEITURA, 'indisponivel') }), 'lite', false);
    expect(semPoder).not.toContain('href="/contas"');
    expect(textoDe(semPoder)).toContain('Quem conecta é quem cuida das contas da empresa.');
    const semPermissao = desenho(conta(SEM_LEITURA));
    expect(textoDe(semPermissao)).toContain('A conexão com o RegemCast não deixa ler as mensagens');
    expect(textoDe(semPermissao)).toContain('Quem dá a permissão é o dono da conta, no RegemCast.');
    const foraDoAr = desenho(conta(trocar(SEM_LEITURA, 'indisponivel')));
    expect(foraDoAr).toContain('vazio-ic--perigo');
    expect(textoDe(foraDoAr)).toContain('O RegemCast não respondeu agora. Nada mudou; tente de novo em instantes.');
    expect(foraDoAr).not.toContain('id="mens-conta"');
  });
});

describe('menu: "Mensagens" depois da Verba do mês, para quem acompanha as campanhas, com Lite e Pro', () => {
  const agencia = NAVEGACAO.find((g) => g.id === 'agencia')!;

  it('o item, a permissão e o ícone', () => {
    const i = agencia.itens.findIndex((x) => x.href === '/mensagens');
    expect(agencia.itens[i]).toEqual({ href: '/mensagens', rotulo: 'Mensagens', icone: 'send', permissao: 'campanhas.ver', modos: true });
    expect(agencia.itens[i - 1]!.href).toBe('/verba');
    expect(agencia.itens[i + 1]!.href).toBe('/criativos');
    expect(itensVisiveis(agencia, (p) => p !== 'campanhas.ver').map((x) => x.href)).not.toContain('/mensagens');
    expect(renderToStaticMarkup(createElement(Icone, { nome: 'send' }))).toContain('<svg class="ic"');
  });

  it('o título da tela e o seletor Lite e Pro', () => {
    expect(tituloDa('/mensagens')).toBe('Mensagens');
    expect(temModos('/mensagens', () => true)).toBe(true);
    expect(temModos('/mensagens', (p) => p !== 'campanhas.ver')).toBe(false);
  });
});

/** O texto do HTML desenhado, sem as marcas (e sem os comentários que o React põe entre dois textos vizinhos). */
function textoDe(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function textoCorrido(trechos: { t: string }[]): string {
  return trechos.map((x) => x.t).join('');
}
