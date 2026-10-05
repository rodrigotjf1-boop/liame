import { type ClosedLoopResponse, PlanContent } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { indiceDasOrigens } from '../src/ai/conversa/fontes.js';
import { contextoDoPlano, type DadosDoPlano, fontesDaVerba, mensagemDoPlano, mesesDoPlano, origensDoPlano, permitidoNoContexto } from '../src/ai/estrategista/contexto.js';
import { contasDaVerba, cuponsAtivos, dinheiroDoPlano, hashDoConteudo, marcarPlano, propostaDoPlano, textosDoPlano, verbaDeHoje } from '../src/ai/estrategista/plano.js';
import { ESTRATEGISTA, PROMPT_ESTRATEGISTA, TAREFA_ESTRATEGISTA } from '../src/ai/estrategista/prompt.js';
import { conferirEdicao, conferirPlano, conteudoDaResposta, type PermitidosNoPlano, respostaDoConteudo } from '../src/ai/estrategista/resposta.js';
import { conferirRegistro, registroAtual } from '../src/ai/registro/definicoes.js';

// O Estrategista (A3, I11): o que o código decide sem banco nem modelo. O formato da resposta e o mapeamento para o
// contrato, a verba de hoje (calculada aqui), a conferência do plano (dias, calendário, cupom, Compliance, números),
// a fonte de cada número, o hash que a aprovação assina e o contexto que vai ao modelo.

const HOJE = '2026-10-03';
const CICLO = {
  periodo: { de: '26/09/2026', ate: '02/10/2026' },
  totais: { investimento: 'R$ 200,00', com_origem_provada: { pedidos: '8', receita: 'R$ 640,00', roas: '3,20' } },
  campanhas: [{ plataforma: 'Meta', campanha: 'Combo sexta', caixa_confirma: { pedidos: '8', receita: 'R$ 640,00', roas: '3,20' } }],
  fontes: [{ plataforma: 'Meta', conta: 'Conta da Hamburgueria', frescor: 'em dia', ultima_leitura: '03/10/2026 06:10' }],
};
const CALENDARIO = [
  { day: '2026-10-12', name: 'Dia das Crianças', kind: 'varejo' },
  { day: '2026-10-12', name: 'Nossa Senhora Aparecida', kind: 'feriado_nacional' },
  { day: '2026-11-27', name: 'Black Friday', kind: 'varejo' },
];
const VERBA = { meta: 860, google: 0 };

const oferta = (extra: Record<string, unknown> = {}) => ({
  resumo: 'Combo sexta em destaque na sexta, 09/10/2026, das 18:00 às 23:00.',
  porques: ['A Combo sexta trouxe 8 pedidos e R$ 640,00 no caixa: ROAS confirmado de 3,20.'],
  risco: 'baixo',
  risco_motivo: 'não pede verba nova nem cupom novo.',
  fazer: ['Na Meta, troque o texto do anúncio da Combo sexta pelo do plano.'],
  depois: 'A revisão de segunda mostra o que a oferta trouxe no caixa.',
  oferta: 'Combo sexta em destaque',
  dia: '2026-10-09',
  inicio: '18:00',
  fim: '23:00',
  onde: 'No anúncio da Combo sexta, no cardápio e no balcão.',
  texto_do_anuncio: 'Sexta é dia de combo: smash, batata e refri.',
  cupom: null,
  como_medir: 'Pedidos pelo link da campanha, confirmados no caixa.',
  ...extra,
});
const noventa = (extra: Record<string, unknown> = {}) => ({
  resumo: 'Em três meses: provar de onde vêm os pedidos e chegar preparado à Black Friday.',
  porques: ['A Meta investiu R$ 200,00 e o caixa confirmou R$ 640,00.'],
  risco: 'medio',
  risco_motivo: 'pede verba nova na Meta com lucro confirmado.',
  fazer: ['Na Meta, deixe a verba do mês em R$ 1.000,00.'],
  depois: 'A pauta de cada semana sai deste plano.',
  objetivos: [{ objetivo: 'Provar a origem dos pedidos', como_saber: 'Os pedidos sem origem caindo na revisão de cada segunda.' }],
  meses: [
    { mes: 'Outubro', plano: 'Rastreio nos anúncios e a Combo sexta também no sábado.' },
    { mes: 'Novembro', plano: 'Black Friday em 27/11/2026 com um combo para dividir.' },
    { mes: 'Dezembro', plano: 'Natal e Réveillon com os horários avisados antes.' },
  ],
  verba_proposta: { meta: 1000, google: 0 },
  datas: [{ dia: '2026-11-27', nome: 'Black Friday', o_que_fazer: 'Um combo para dividir, com cupom próprio.' }],
  ...extra,
});
const pauta = (dias: Array<{ dia: string; item: string }>) => ({
  resumo: 'O que fazer em cada dia até sexta.',
  porques: ['A Combo sexta trouxe 8 pedidos.'],
  risco: 'baixo',
  risco_motivo: 'nenhuma verba nova.',
  fazer: [],
  depois: 'A revisão de segunda mostra o que foi feito.',
  dias,
});

const conteudo = (kind: 'oferta' | 'pauta' | 'noventa_dias', bruto: unknown): PlanContent => {
  const r = conteudoDaResposta(kind, bruto, VERBA);
  if (!r.ok) throw new Error(`fora do formato: ${r.detalhe.join(' | ')}`);
  return r.content;
};
const permitidos = (extra: Partial<PermitidosNoPlano> = {}): PermitidosNoPlano => ({
  hoje: HOJE,
  calendario: CALENDARIO,
  cupons: ['SEXTA10'],
  emDia: [CICLO],
  velhas: [],
  nomes: ['Combo sexta', 'Conta da Hamburgueria'],
  ...extra,
});

describe('a resposta do Estrategista no formato do contrato (A3, I11)', () => {
  it('cada tipo vira o conteúdo do contrato; a verba de hoje é a do código, e o cupom vazio é nulo', () => {
    const o = conteudo('oferta', oferta({ cupom: ' sexta10 ' }));
    expect(o).toMatchObject({ kind: 'oferta', day: '2026-10-09', starts_at: '18:00', ends_at: '23:00', coupon_code: 'SEXTA10' });
    expect(conteudo('oferta', oferta({ cupom: '  ' }))).toMatchObject({ coupon_code: null });
    const n = conteudo('noventa_dias', noventa());
    expect(n.kind === 'noventa_dias' && n.budget).toEqual({ today: VERBA, proposal: { meta: 1000, google: 0 } });
    const p = conteudo('pauta', pauta([{ dia: '2026-10-05', item: 'Pôr o rastreio nos anúncios.' }]));
    expect(p).toMatchObject({ kind: 'pauta', days: [{ day: '2026-10-05', item: 'Pôr o rastreio nos anúncios.' }] });
    // A volta para o modelo (nova análise) tem as chaves dele.
    expect(respostaDoConteudo(o)).toMatchObject({ oferta: 'Combo sexta em destaque', cupom: 'SEXTA10', inicio: '18:00' });
    expect(PlanContent.parse(o)).toEqual(o);
  });

  it('fora do formato (schema ou limites do contrato) não vira plano', () => {
    expect(conteudoDaResposta('oferta', { resumo: 'só isso' }, VERBA).ok).toBe(false);
    expect(conteudoDaResposta('oferta', oferta({ texto_do_anuncio: 'x'.repeat(221) }), VERBA)).toMatchObject({ ok: false });
    expect(conteudoDaResposta('oferta', oferta({ inicio: '25:00' }), VERBA).ok).toBe(false);
    expect(conteudoDaResposta('noventa_dias', noventa({ verba_proposta: { meta: 1000.5, google: 0 } }), VERBA).ok).toBe(false);
    expect(conteudoDaResposta('noventa_dias', noventa({ verba_proposta: { meta: -10, google: 0 } }), VERBA).ok).toBe(false);
    expect(conteudoDaResposta('pauta', pauta([]), VERBA).ok).toBe(false);
    expect(conteudoDaResposta('oferta', noventa(), VERBA).ok).toBe(false);
  });
});

describe('a verba de hoje, o dinheiro do plano e o hash', () => {
  const ciclo = (meta: string, google: string) =>
    ({
      platforms: [
        { provider: 'meta_ads', platform: { spend_micros: meta } },
        { provider: 'google_ads', platform: { spend_micros: google } },
      ],
    }) as unknown as ClosedLoopResponse;

  it('o gasto dos 7 dias levado a 30 (× 30 ÷ 7), em reais inteiros na dezena', () => {
    // R$ 200,00 × 30 ÷ 7 = R$ 857,14 → R$ 860; R$ 99,00 → R$ 424,28 → R$ 420; nada → 0.
    expect(verbaDeHoje(ciclo('200000000', '99000000'))).toEqual({ meta: 860, google: 420 });
    expect(verbaDeHoje(ciclo('0', '0'))).toEqual({ meta: 0, google: 0 });
    expect(verbaDeHoje({ platforms: [] } as unknown as ClosedLoopResponse)).toEqual({ meta: 0, google: 0 });
  });

  it('o dinheiro é a proposta menos hoje, por mês, em micros; a oferta e a pauta não mexem em verba', () => {
    expect(dinheiroDoPlano(conteudo('noventa_dias', noventa()))).toBe('140000000');
    expect(dinheiroDoPlano(conteudo('noventa_dias', noventa({ verba_proposta: { meta: 500, google: 0 } })))).toBe('-360000000');
    expect(dinheiroDoPlano(conteudo('oferta', oferta()))).toBeNull();
  });

  it('o hash não depende da ordem das chaves (o jsonb reordena) e muda com qualquer vírgula', () => {
    const o = conteudo('oferta', oferta());
    const embaralhado = Object.fromEntries(Object.entries(o).reverse()) as PlanContent;
    expect(hashDoConteudo(embaralhado)).toBe(hashDoConteudo(o));
    expect(hashDoConteudo({ ...o, ad_text: `${o.kind === 'oferta' ? o.ad_text : ''}!` } as PlanContent)).not.toBe(hashDoConteudo(o));
  });
});

describe('conferência do plano (A3-5, A3-10, I9)', () => {
  it('o plano com os números lidos, a proposta dos campos e as contas da verba passa', () => {
    expect(conferirPlano(conteudo('oferta', oferta()), permitidos())).toBeNull();
    // A proposta (R$ 1.000,00) e quanto ela muda (R$ 140,00 a mais) podem aparecer: o código faz a conta.
    const n = conteudo('noventa_dias', noventa({ fazer: ['Deixe a verba da Meta em R$ 1.000,00: R$ 140,00 a mais que hoje (R$ 860,00).'] }));
    expect(conferirPlano(n, permitidos({ emDia: [CICLO, permitidoNoContexto(dados('noventa_dias'))] }))).toBeNull();
  });

  it('número que não está no que ele leu derruba o plano; o da fonte atrasada é dado velho', () => {
    const inventado = conteudo('oferta', oferta({ porques: ['A Combo sexta trouxe 11 pedidos.'] }));
    expect(conferirPlano(inventado, permitidos())).toEqual({ recusa: 'numero_fora', detalhe: ['11'] });
    const velho = conteudo('oferta', oferta({ porques: ['A Combo sexta gastou R$ 777,00.'] }));
    expect(conferirPlano(velho, permitidos({ velhas: [{ totais: { investimento: 'R$ 777,00' } }] }))).toEqual({ recusa: 'dado_velho', detalhe: ['777,00'] });
  });

  it('a oferta começa amanhã, a pauta pode começar hoje, e as duas ficam no prazo do tipo; a pauta vai em ordem', () => {
    expect(conferirPlano(conteudo('oferta', oferta({ dia: HOJE })), permitidos())).toMatchObject({ recusa: 'fora_da_janela' });
    expect(conferirPlano(conteudo('pauta', pauta([{ dia: HOJE, item: 'Nada novo.' }])), permitidos())).toBeNull();
    expect(conferirPlano(conteudo('pauta', pauta([{ dia: '2026-10-02', item: 'Nada novo.' }])), permitidos())).toMatchObject({ recusa: 'fora_da_janela' });
    expect(conferirPlano(conteudo('oferta', oferta({ dia: '2026-12-31' })), permitidos())).toMatchObject({ recusa: 'fora_da_janela' });
    expect(conferirPlano(conteudo('oferta', oferta({ inicio: '23:00', fim: '18:00' })), permitidos())).toMatchObject({ recusa: 'formato' });
    const foraDeOrdem = pauta([
      { dia: '2026-10-06', item: 'Rastreio nos anúncios.' },
      { dia: '2026-10-05', item: 'Nada novo.' },
    ]);
    expect(conferirPlano(conteudo('pauta', foraDeOrdem), permitidos())).toMatchObject({ recusa: 'formato' });
    expect(conferirPlano(conteudo('pauta', pauta([{ dia: '2026-10-30', item: 'Nada novo.' }])), permitidos())).toMatchObject({ recusa: 'fora_da_janela' });
  });

  it('data comemorativa só da tabela do Liame, com o nome de lá; cupom só o que existe e está ativo', () => {
    const inventada = conteudo('noventa_dias', noventa({ datas: [{ dia: '2026-11-20', nome: 'Dia do Hambúrguer', o_que_fazer: 'Combo.' }] }));
    expect(conferirPlano(inventada, permitidos())).toEqual({ recusa: 'data_fora_do_calendario', detalhe: ['2026-11-20 Dia do Hambúrguer'] });
    const nomeTrocado = conteudo('noventa_dias', noventa({ datas: [{ dia: '2026-11-27', nome: 'Black Fraude', o_que_fazer: 'Combo.' }] }));
    expect(conferirPlano(nomeTrocado, permitidos())).toMatchObject({ recusa: 'data_fora_do_calendario' });
    // O nome igual ao da tabela, sem diferença de acento ou caixa, passa.
    const igual = conteudo('noventa_dias', noventa({ datas: [{ dia: '2026-10-12', nome: 'dia das criancas', o_que_fazer: 'Combo kids.' }] }));
    expect(conferirPlano(igual, permitidos({ emDia: [CICLO, permitidoNoContexto(dados('noventa_dias'))] }))).toBeNull();
    expect(conferirPlano(conteudo('oferta', oferta({ cupom: 'SMASH10' })), permitidos())).toEqual({ recusa: 'cupom_desconhecido', detalhe: ['SMASH10'] });
    expect(conferirPlano(conteudo('oferta', oferta({ cupom: 'SEXTA10' })), permitidos())).toBeNull();
    expect(cuponsAtivos([{ ferramenta: 'cupons_campanha', valor: { cupons: [{ codigo: 'sexta10', situacao: 'ativo' }, { codigo: 'VELHO5', situacao: 'vencido' }], pedidos_de_criacao: [{ codigo: 'NOVO20' }] } }])).toEqual(['SEXTA10']);
  });

  it('link, "a IA decidiu", promessa de resultado, política e o que a marca não diz derrubam o plano', () => {
    expect(conferirPlano(conteudo('oferta', oferta({ onde: 'No site https://exemplo.com.br' })), permitidos())).toMatchObject({ recusa: 'trecho_proibido' });
    expect(conferirPlano(conteudo('oferta', oferta({ resumo: 'A IA decidiu pela Combo sexta.' })), permitidos())).toMatchObject({ recusa: 'trecho_proibido' });
    expect(conferirPlano(conteudo('oferta', oferta({ texto_do_anuncio: 'Combo com resultado garantido.' })), permitidos())).toMatchObject({ recusa: 'compliance' });
    expect(conferirPlano(conteudo('oferta', oferta({ texto_do_anuncio: 'Vote em quem faz o melhor combo da eleição.' })), permitidos())).toMatchObject({ recusa: 'compliance' });
    expect(conferirPlano(conteudo('oferta', oferta({ texto_do_anuncio: 'O combo gourmet da sexta.' })), permitidos({ daMarca: ['gourmet'] }))).toMatchObject({ recusa: 'compliance' });
  });

  it('a edição de uma pessoa passa pelo Compliance e pela marca, com o problema em palavras; número é dela', () => {
    expect(conferirEdicao(conteudo('oferta', oferta({ porques: ['A Combo sexta trouxe 99 pedidos.'] })), { nomes: [] })).toEqual([]);
    expect(conferirEdicao(conteudo('oferta', oferta({ texto_do_anuncio: 'Lucro certo na sexta.' })), { nomes: [] })).toEqual(['promessa de resultado (regra da Liame)']);
    expect(conferirEdicao(conteudo('oferta', oferta({ texto_do_anuncio: 'O combo gourmet.' })), { nomes: [], daMarca: ['gourmet'] })).toEqual(['"gourmet" (o que a marca não diz, em Minha marca)']);
    expect(conferirEdicao(conteudo('oferta', oferta({ inicio: '23:00', fim: '18:00' })), { nomes: [] })).toEqual(['a oferta termina antes de começar']);
  });
});

function dados(kind: DadosDoPlano['kind'], extra: Partial<DadosDoPlano> = {}): DadosDoPlano {
  return {
    kind,
    hoje: HOJE,
    marca: { id: '0192f1d4-3c1a-7b2e-9a10-5f1e2d3c4b5a', nome: 'Mister Burgers', fuso: 'America/Sao_Paulo' },
    dossie: null,
    fatos: null,
    calendario: CALENDARIO,
    verbaDeHoje: VERBA,
    semana: { from: '2026-09-26', to: '2026-10-02' },
    pedido: { title: 'Promoção de sexta', detail: 'Quero uma promoção de combo para sexta à noite.', notes: null, due_on: '2026-10-09' },
    anterior: null,
    ...extra,
  };
}

describe('a fonte de cada número do plano (P8: "De onde vêm os números")', () => {
  it('os textos com número vão marcados, na ordem da tela, e a verba de hoje leva a fonte do cálculo', () => {
    const c = conteudo('noventa_dias', noventa());
    const d = dados('noventa_dias');
    const origens = origensDoPlano(d, { leituras: [{ rotulo: 'Resultados de 26/09 a 02/10', valor: CICLO }], content: c, atrasadas: [] });
    const { numbers, marked } = marcarPlano(c, indiceDasOrigens(origens), ['Combo sexta'], { semLugar: 'sem lugar', fontesDaVerba: fontesDaVerba(d.semana) });
    const caminhos = marked.map((m) => m.path);
    expect(caminhos).toEqual(['reasons.0', 'months.1.plan', 'budget.today.meta', 'budget.today.google', 'to_do.0']);
    const fonte = (valor: string) => numbers.find((n) => n.value === valor)?.sources;
    expect(fonte('R$ 640,00')).toEqual(['Resultados de 26/09 a 02/10 · totais · com origem provada · receita']);
    expect(fonte('R$ 860,00')).toEqual(['Meta Ads · gasto de 26/09/2026 a 02/10/2026 levado para 30 dias (× 30 ÷ 7, na dezena) · calculado pelo Liame']);
    // A proposta da Meta é também o total proposto (o Google fica em zero): os dois lugares, do mais perto para o mais geral.
    expect(fonte('R$ 1.000,00')).toEqual(['Proposta do Estrategista nesta versão do plano', 'Liame · verba de hoje e a proposta, nas contas do sistema']);
    expect(fonte('27/11/2026')).toEqual(['Liame · calendário comercial (feriados nacionais e datas do varejo)']);
    // Cada trecho aponta para a linha do número.
    const meta = marked.find((m) => m.path === 'budget.today.meta')!;
    expect(meta.text).toEqual([{ text: 'R$ 860,00', number: numbers.findIndex((n) => n.value === 'R$ 860,00') }]);
  });

  it('ERR-105: o que a marca nunca diz não é fonte de número do plano; o que ela afirma de si, sim', () => {
    const fatos = 'MARCA: Mister Burgers\nDESDE: 2019';
    const d = dados('oferta', { dossie: `${fatos}\nNUNCA DIZER: "entrega em 47 minutos"`, fatos });
    const permitido = JSON.stringify(permitidoNoContexto(d));
    expect(permitido).toContain('2019');
    expect(permitido).not.toContain('47 minutos');
    const origens = origensDoPlano(d, { leituras: [], content: conteudo('oferta', oferta()), atrasadas: [] });
    expect(origens.find((o) => o.rotulo === 'Minha marca · dossiê da marca')?.valor).toBe(fatos);
    // O modelo continua lendo o dossiê inteiro, com a proibição, para não dizer.
    expect(contextoDoPlano(d)).toContain('NUNCA DIZER: "entrega em 47 minutos"');
  });

  it('o número que não está em lugar nenhum leva a fonte dada (na edição, quem editou)', () => {
    const c = conteudo('oferta', oferta({ porques: ['A Combo sexta trouxe 99 pedidos.'] }));
    const { numbers } = marcarPlano(c, new Map(), [], { semLugar: 'Escrito por quem editou esta versão do plano' });
    expect(numbers.find((n) => n.value === '99')?.sources).toEqual(['Escrito por quem editou esta versão do plano']);
  });

  it('os textos livres, a proposta dos campos e as contas da verba', () => {
    const o = conteudo('oferta', oferta({ cupom: 'SEXTA10' }));
    expect(textosDoPlano(o).map((t) => t.caminho)).toEqual(['summary', 'reasons.0', 'offer', 'where', 'ad_text', 'how_to_measure', 'risk_reason', 'to_do.0', 'after']);
    expect(propostaDoPlano(o)).toEqual(['09/10/2026', '18:00', '23:00', 'SEXTA10']);
    const n = conteudo('noventa_dias', noventa());
    expect(propostaDoPlano(n)).toEqual(['R$ 1.000,00', 'R$ 0,00']);
    expect(n.kind === 'noventa_dias' && contasDaVerba(n.budget)).toEqual(['R$ 860,00', 'R$ 0,00', 'R$ 860,00', 'R$ 1.000,00', 'R$ 140,00', 'R$ 0,00', 'R$ 140,00']);
  });
});

describe('o contexto que vai ao Estrategista', () => {
  it('traz o tipo, os dias que ele pode usar, a verba de hoje e o calendário da tabela; o pedido vai como a mensagem', () => {
    const texto = contextoDoPlano(dados('oferta'));
    expect(texto).toContain('Tipo de plano pedido: a oferta (uma promoção).');
    expect(texto).toContain('Hoje é sábado, 03/10/2026');
    expect(texto).toContain('A oferta acontece num dia de 04/10/2026 a 02/12/2026.');
    expect(texto).toContain('Meta R$ 860,00; Google R$ 0,00');
    expect(texto).toContain('12/10/2026, segunda-feira (2026-10-12): Dia das Crianças (data do varejo)');
    expect(texto).toContain('27/11/2026, sexta-feira (2026-11-27): Black Friday (data do varejo)');
    expect(texto).toContain('A marca ainda não preencheu o dossiê');
    expect(mensagemDoPlano(dados('oferta'))).toBe(
      'Pedido registrado pela LIA para o Estrategista:\n- Título: Promoção de sexta\n- Pedido: Quero uma promoção de combo para sexta à noite.\n- Para quando: 09/10/2026',
    );
    expect(contextoDoPlano(dados('pauta'))).toContain('Os dias que a pauta pode usar, de hoje em diante: sábado 03/10/2026 (2026-10-03); domingo 04/10/2026 (2026-10-04);');
    expect(contextoDoPlano(dados('noventa_dias'))).toContain(
      'Os três meses, com estes nomes: Outubro (de 03/10/2026 a 31/10/2026); Novembro (de 01/11/2026 a 30/11/2026); Dezembro (de 01/12/2026 a 31/12/2026).',
    );
    // Na virada do ano e em fevereiro, os dias de cada mês certos.
    expect(mesesDoPlano('2027-12-15').map((m) => [m.nome, m.de, m.ate])).toEqual([
      ['Dezembro', '2027-12-15', '2027-12-31'],
      ['Janeiro', '2028-01-01', '2028-01-31'],
      ['Fevereiro', '2028-02-01', '2028-02-29'],
    ]);
  });

  it('na nova análise, a versão anterior vai com as chaves do modelo, e o pedido da pessoa junto', () => {
    const anterior = { version: 2, content: conteudo('oferta', oferta()), pedido: 'Quero sem refrigerante.', numbers: [] };
    const d = dados('oferta', { anterior });
    expect(contextoDoPlano(d)).toContain('Versão anterior deste plano (versão 2):\n{"resumo":"Combo sexta em destaque');
    expect(contextoDoPlano(d)).toContain('O que a pessoa pediu na nova análise: "Quero sem refrigerante."');
    expect(mensagemDoPlano(d)).toContain('Nova análise pedida pela pessoa: Quero sem refrigerante.');
  });
});

describe('o Estrategista no registro (A3, I2)', () => {
  it('é um funcionário com as leituras, o prompt da tarefa e nenhuma ferramenta de escrita', () => {
    expect(conferirRegistro(registroAtual())).toEqual([]);
    expect(ESTRATEGISTA.tarefas).toEqual([{ task: TAREFA_ESTRATEGISTA, prompt: PROMPT_ESTRATEGISTA.key }]);
    const escrita = registroAtual().ferramentas.filter((f) => f.risk !== 'R0').map((f) => f.name);
    expect(ESTRATEGISTA.ferramentas.filter((f) => escrita.includes(f))).toEqual([]);
    expect(PROMPT_ESTRATEGISTA.content).toContain('Nunca use data da sua memória');
  });
});
