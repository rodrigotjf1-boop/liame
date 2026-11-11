import { ActionProposal } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { comentarioDoRecurso, recursoDoComentario } from '../src/actions/comentario-na-rede.js';
import {
  ACAO_DE_APAGAR_A_RESPOSTA,
  ACAO_DE_MOSTRAR,
  ACAO_DE_OCULTAR,
  ACAO_DE_RESPONDER,
  ACAO_DE_RESPONDER_SOZINHO,
  type EstadoDoComentario,
  FLAG_DE_RESPONDER_COMENTARIOS,
  foraDoLote,
  jaComoOPedidoQueria,
  planoDaRespostaAoComentario,
  planoDeApagarARespostaAoComentario,
  planoDeMostrar,
  planoDeOcultar,
  resumoDoComentario,
  TAMANHO_DA_RESPOSTA_AO_COMENTARIO,
  versaoDoComentario,
} from '../src/actions/comentario-plano.js';
import { CONNECTORS, ConectorPorRecurso } from '../src/actions/connectors.js';
import { TOOLS } from '../src/actions/tools.js';
import { chooseMode, PLATFORM_POLICY } from '../src/policy/engine.js';

// A6 · Z11, parte 2: as regras puras de responder, apagar a resposta, ocultar e mostrar um comentário (P38, D-A6-88 e
// D-A6-89): o plano de cada operação e o que ele recusa, a conferência do texto (compensação prometida, o nome de quem
// comentou, dado pessoal), a versão do estado, o "já está como o pedido queria" de cada operação, as ferramentas no
// registro (a flag delas, a aprovação, a volta), a política v11 e o conector da conta que escolhe pelo recurso; parte
// 2c-2: quem entra no lote de uma confirmação só (D-A6-93).

const base: EstadoDoComentario = {
  tipo: 'comentario',
  canal: 'instagram',
  id: '17900000000000001',
  post_id: '17800000000000001',
  existe: true,
  oculto: false,
  primeiro_nivel: true,
  da_marca: false,
  feito_em: '2026-11-07T15:00:00.000Z',
  texto_resumo: resumoDoComentario('Quanto custa o combo?'),
  resposta: null,
};
const RESPOSTA = 'O combo duplo sai por R$ 39,90 no cardápio. Peça pelo link da bio!';

describe('o plano da resposta a um comentário (D-A6-88)', () => {
  it('responde ao comentário de outra pessoa, de primeiro nível, à vista e sem resposta da marca; o desejado leva a operação', () => {
    const p = planoDaRespostaAoComentario(base, { texto: `  ${RESPOSTA}  ` }, { quem: 'ana_paula' });
    expect(p).toEqual({ ok: true, acao: ACAO_DE_RESPONDER, texto: RESPOSTA, desejado: { ...base, resposta: { id: 'nova', texto: RESPOSTA }, operacao: 'responder' } });
  });

  it('recusa o que a rede não deixa ou não faz sentido: sumiu, da marca, resposta, oculto, já respondido', () => {
    const motivo = (e: Partial<EstadoDoComentario>) => {
      const p = planoDaRespostaAoComentario({ ...base, ...e }, { texto: RESPOSTA });
      return p.ok ? null : p.motivo;
    };
    expect(motivo({ existe: false })).toContain('não está mais na rede');
    expect(motivo({ da_marca: true })).toContain('da própria marca');
    expect(motivo({ primeiro_nivel: false })).toContain('primeiro nível');
    expect(motivo({ oculto: true })).toContain('oculto');
    expect(motivo({ resposta: { id: '1', texto: 'Obrigado!' } })).toContain('já respondeu');
    const errado = planoDaRespostaAoComentario({ tipo: 'avaliacao' }, { texto: RESPOSTA });
    expect(errado.ok).toBe(false);
  });

  it('o texto: vazio e longo demais não passam; a compensação prometida, o nome de quem comentou e o dado pessoal também não', () => {
    const motivo = (texto: string, quem: string | null = null) => {
      const p = planoDaRespostaAoComentario(base, { texto }, { quem });
      return p.ok ? null : p.motivo;
    };
    expect(motivo('   ')).toContain('precisa de um texto');
    expect(motivo('a'.repeat(TAMANHO_DA_RESPOSTA_AO_COMENTARIO + 1))).toContain('precisa de um texto');
    expect(motivo('a'.repeat(TAMANHO_DA_RESPOSTA_AO_COMENTARIO))).toBeNull();
    expect(motivo('Pedimos desculpas! Vamos te dar um desconto no próximo pedido.')).toContain('compensação');
    expect(motivo('Fazemos o reembolso, sim.')).toContain('compensação');
    expect(motivo('Obrigado, Ana! Volte sempre.', 'Ana Paula')).toContain('o nome de quem comentou');
    expect(motivo('Obrigado pela banana!', 'Ana Paula')).toBeNull();
    expect(motivo('Mande um e-mail para contato@casabrasa.com.br')).toContain('dado pessoal');
  });
});

describe('apagar a resposta, ocultar e mostrar (D-A6-89)', () => {
  it('apagar: só com a resposta da marca lá; o desejado sem a resposta', () => {
    const comResposta = { ...base, resposta: { id: '1790', texto: RESPOSTA } };
    expect(planoDeApagarARespostaAoComentario(comResposta)).toEqual({ ok: true, acao: ACAO_DE_APAGAR_A_RESPOSTA, desejado: { ...comResposta, resposta: null, operacao: 'apagar_resposta' } });
    expect(planoDeApagarARespostaAoComentario(base)).toMatchObject({ ok: false });
    expect(planoDeApagarARespostaAoComentario({ ...comResposta, existe: false })).toMatchObject({ ok: false });
  });

  it('ocultar: o comentário de outra pessoa, à vista; mostrar: o oculto', () => {
    expect(planoDeOcultar(base)).toEqual({ ok: true, acao: ACAO_DE_OCULTAR, desejado: { ...base, oculto: true, operacao: 'ocultar' } });
    expect(planoDeOcultar({ ...base, oculto: true })).toMatchObject({ ok: false });
    // A rede sempre mostra o comentário do dono da mídia.
    expect(planoDeOcultar({ ...base, da_marca: true })).toMatchObject({ ok: false });
    expect(planoDeOcultar({ ...base, existe: false })).toMatchObject({ ok: false });
    expect(planoDeMostrar({ ...base, oculto: true })).toEqual({ ok: true, acao: ACAO_DE_MOSTRAR, desejado: { ...base, oculto: false, operacao: 'mostrar' } });
    expect(planoDeMostrar(base)).toMatchObject({ ok: false });
  });

  it('a versão muda com o que a pessoa leu para decidir (o texto, sumir, ocultar, a resposta) e não com a operação', () => {
    const v = versaoDoComentario(base);
    expect(v).toBeGreaterThan(0);
    expect(versaoDoComentario({ ...base })).toBe(v);
    expect(versaoDoComentario({ ...base, oculto: true })).not.toBe(v);
    expect(versaoDoComentario({ ...base, existe: false })).not.toBe(v);
    expect(versaoDoComentario({ ...base, texto_resumo: resumoDoComentario('Outro texto') })).not.toBe(v);
    expect(versaoDoComentario({ ...base, resposta: { id: '1', texto: RESPOSTA } })).not.toBe(v);
    // A rede pode acertar os espaços da resposta: a versão é a mesma.
    expect(versaoDoComentario({ ...base, resposta: { id: '1', texto: `${RESPOSTA}  ` } })).toBe(versaoDoComentario({ ...base, resposta: { id: '1', texto: RESPOSTA } }));
    expect(versaoDoComentario({ ...base, operacao: 'ocultar' } as EstadoDoComentario)).toBe(v);
  });

  it('"já está como o pedido queria", pela operação: responder à vista não conta como ocultar feito, e vice-versa', () => {
    const responder = { ...base, resposta: { id: 'nova', texto: RESPOSTA }, operacao: 'responder' as const };
    expect(jaComoOPedidoQueria(base, responder)).toBe(false);
    expect(jaComoOPedidoQueria({ ...base, resposta: { id: '1790', texto: `${RESPOSTA} ` } }, responder)).toBe(true);
    expect(jaComoOPedidoQueria({ ...base, resposta: { id: '1790', texto: 'Outra' } }, responder)).toBe(false);
    expect(jaComoOPedidoQueria(base, { ...base, oculto: true, operacao: 'ocultar' })).toBe(false);
    expect(jaComoOPedidoQueria({ ...base, oculto: true }, { ...base, oculto: true, operacao: 'ocultar' })).toBe(true);
    expect(jaComoOPedidoQueria(base, { ...base, oculto: false, operacao: 'mostrar' })).toBe(true);
    expect(jaComoOPedidoQueria(base, { ...base, resposta: null, operacao: 'apagar_resposta' })).toBe(true);
    expect(jaComoOPedidoQueria({ ...base, existe: false }, { ...base, oculto: true, operacao: 'ocultar' })).toBe(false);
    // Sem a operação, nunca: o desejado antigo não decide sozinho.
    expect(jaComoOPedidoQueria(base, base)).toBe(false);
  });
});

describe('o lote de uma confirmação só (D-A6-93, parte 2c-2)', () => {
  it('entram a resposta a elogio, marcação e pergunta e ocultar; ficam fora a reclamação, o tipo não decidido, o comentário que saiu e as outras ferramentas', () => {
    for (const tipo of ['elogio', 'marcacao', 'pergunta']) expect(foraDoLote('comentario_responder', tipo), tipo).toBeNull();
    for (const tipo of ['elogio', 'marcacao', 'pergunta', 'ofensivo', 'golpe']) expect(foraDoLote('comentario_ocultar', tipo), tipo).toBeNull();
    expect(foraDoLote('comentario_responder', 'reclamacao')).toBe('a reclamação é decidida uma por vez');
    expect(foraDoLote('comentario_ocultar', 'reclamacao')).toBe('a reclamação é decidida uma por vez');
    expect(foraDoLote('comentario_responder', 'ofensivo')).toBe('no lote, só a resposta a um elogio, a uma marcação ou a uma pergunta');
    expect(foraDoLote('comentario_responder', 'golpe')).toBe('no lote, só a resposta a um elogio, a uma marcação ou a uma pergunta');
    expect(foraDoLote('comentario_responder', null)).toMatch(/^o tipo do comentário ainda não foi decidido/);
    expect(foraDoLote('comentario_ocultar', null)).toMatch(/^o tipo do comentário ainda não foi decidido/);
    expect(foraDoLote('comentario_responder', undefined)).toMatch(/^o comentário não está mais no Liame/);
    // Mostrar de novo e apagar a resposta são a volta de um pedido (uma por vez); as outras ferramentas, também fora.
    for (const tool of ['comentario_mostrar', 'comentario_apagar_resposta', 'avaliacao_responder', 'post_publicar', 'orcamento_mudar']) {
      expect(foraDoLote(tool, 'elogio'), tool).toBe('só a resposta a um comentário e ocultar um comentário entram no lote');
    }
  });
});

describe('as ferramentas, a política e o conector da conta', () => {
  it('as cinco ferramentas: a flag delas, a aprovação, a volta, quem só existe como volta e a resposta automática (2e-1)', () => {
    const doComentario = Object.values(TOOLS).filter((t) => t.name.startsWith('comentario_'));
    expect(
      doComentario.map((t) => [t.name, t.flag, Boolean(t.alwaysApproval), Boolean(t.directByPerson), Boolean(t.onlyAsUndo), t.undo?.({}).tool ?? null, Boolean(t.atendimentoAutomatico)]),
    ).toEqual([
      ['comentario_responder', FLAG_DE_RESPONDER_COMENTARIOS, true, false, false, 'comentario_apagar_resposta', false],
      // A resposta automática não tem a trava da aprovação: só sai pelo atendimento automático, com o portão dele.
      ['comentario_responder_auto', FLAG_DE_RESPONDER_COMENTARIOS, false, false, false, 'comentario_apagar_resposta', true],
      ['comentario_apagar_resposta', FLAG_DE_RESPONDER_COMENTARIOS, false, true, true, null, false],
      ['comentario_ocultar', FLAG_DE_RESPONDER_COMENTARIOS, true, false, false, 'comentario_mostrar', false],
      ['comentario_mostrar', FLAG_DE_RESPONDER_COMENTARIOS, true, false, true, null, false],
    ]);
    // Só ela é do atendimento automático.
    // E a do Direct (A6, Z12, parte 5a).
    expect(Object.values(TOOLS).filter((t) => t.atendimentoAutomatico).map((t) => t.name)).toEqual(['comentario_responder_auto', 'direct_responder_auto']);
    for (const t of doComentario) expect(t.providers, t.name).toEqual(['instagram', 'facebook_page']);
    // Só elas, a resposta no Direct (A6, Z12, parte 2) e a campanha nova na Meta (A4, X5) têm flag própria.
    expect(Object.values(TOOLS).filter((t) => t.flag).map((t) => t.name).sort()).toEqual(
      [...doComentario.map((t) => t.name), 'direct_responder', 'direct_responder_auto', 'campanha_criar'].sort(),
    );
    // A sugestão do Social media só o funcionário preenche.
    expect(TOOLS.comentario_responder!.agentParams).toEqual(['sugestoes']);
  });

  it('a política v12: responder, ocultar e mostrar com aprovação, peça quem pedir; apagar a resposta, direto para a pessoa; a resposta automática, só para o funcionário', () => {
    const proposta = (action: string, actor: 'human' | 'agent' = 'human') =>
      ActionProposal.parse({
        tool: action === ACAO_DE_RESPONDER ? 'comentario_responder' : 'comentario_ocultar',
        action,
        provider: 'instagram',
        account_id: 'a',
        risk_level: action === ACAO_DE_RESPONDER ? 'R2' : 'R1',
        budget_impact: 'none',
        value_micros: null,
        current_value_micros: null,
        actor,
      });
    expect(PLATFORM_POLICY.version).toBe(14);
    for (const acao of [ACAO_DE_RESPONDER, ACAO_DE_OCULTAR, ACAO_DE_MOSTRAR]) {
      for (const actor of ['human', 'agent'] as const) expect(chooseMode([PLATFORM_POLICY], proposta(acao, actor)), `${acao} ${actor}`).toEqual({ mode: 'APPROVAL', source: 'platform', version: 14 });
    }
    expect(chooseMode([PLATFORM_POLICY], proposta(ACAO_DE_APAGAR_A_RESPOSTA))).toEqual({ mode: 'AUTO', source: 'platform', version: 14 });
    expect(chooseMode([PLATFORM_POLICY], proposta(ACAO_DE_APAGAR_A_RESPOSTA, 'agent'))).toEqual({ mode: 'APPROVAL', source: 'platform', version: 14 });
    // v12 (parte 2e-1): a resposta automática sai sozinha só para o funcionário de IA; uma pessoa cai na Aprovação.
    expect(chooseMode([PLATFORM_POLICY], proposta(ACAO_DE_RESPONDER_SOZINHO, 'agent'))).toEqual({ mode: 'AUTO', source: 'platform', version: 14 });
    expect(chooseMode([PLATFORM_POLICY], proposta(ACAO_DE_RESPONDER_SOZINHO, 'human'))).toEqual({ mode: 'APPROVAL', source: 'platform', version: 14 });
  });

  it('o recurso do comentário, e o conector da conta escolhe pelo recurso, com a flag e a trava do conector do post', () => {
    expect(recursoDoComentario('17900000000000001')).toBe('comentario:17900000000000001');
    expect(comentarioDoRecurso('comentario:17900000000000001')).toBe('17900000000000001');
    expect(comentarioDoRecurso('comentario:123_456')).toBe('123_456');
    expect(comentarioDoRecurso('comentario:../x')).toBeNull();
    expect(comentarioDoRecurso('comentario:')).toBeNull();
    expect(comentarioDoRecurso('0190a1b2-0000-7000-8000-000000000001')).toBeNull();
    for (const provider of ['instagram', 'facebook_page']) {
      const c = CONNECTORS[provider];
      expect(c, provider).toBeInstanceOf(ConectorPorRecurso);
      expect([c!.provider, c!.writeFlag, c!.requiresSpendLimits]).toEqual([provider, 'social_write', false]);
      const porRecurso = c as ConectorPorRecurso;
      expect(porRecurso.de('comentario:1').constructor.name).toBe('ComentarioNaRedeConnector');
      expect(porRecurso.de('0190a1b2-0000-7000-8000-000000000001').constructor.name).toBe('PostPublicacaoConnector');
    }
  });
});
