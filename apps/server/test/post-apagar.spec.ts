import type { ActionProposal } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { PlanoRecusado, TOOLS } from '../src/actions/tools.js';
import { chooseMode, PLATFORM_POLICY } from '../src/policy/engine.js';
import { type EstadoDoPost, planoDeApagarOPost, querApagar, recusaNaHoraDeApagar, situacaoDoApagar, situacaoDoPost } from '../src/posts/post-plano.js';

// A6 · Z5d, parte 6: "Apagar das redes" (P19, aprovado em 21/10/2026; D-A6-57), sem banco. O plano da ferramenta
// `post_apagar` (cada canal no ar sai; o que não saiu fica como está), o que o conector entende como "apagar", a situação
// do post com um canal apagado, a do pedido de apagar, e a ferramenta: só como a volta da publicação, sempre com a
// aprovação (a regra `post.*` da política v10).

const estado = (o: Partial<EstadoDoPost> = {}): EstadoDoPost => ({
  post: '00000000-0000-7000-8000-000000000001',
  foto: { id: 'foto', sha256: 'a'.repeat(64) },
  recorte: null,
  hora: '2026-10-29T15:00:00.000Z',
  hora_local: '12:00',
  canais: [
    { canal: 'instagram', conta: 'conta-ig', texto: 'Smash duplo hoje.', situacao: 'publicado' },
    { canal: 'facebook', conta: 'conta-pagina', texto: 'Smash duplo hoje. liame.link/abc', situacao: 'publicado' },
  ],
  ...o,
});

describe('o plano de apagar das redes (a ferramenta post_apagar)', () => {
  it('cada canal no ar sai; sem texto para a política; a hora (fora da janela) e a foto apagada não recusam', () => {
    const plano = planoDeApagarOPost(estado({ hora_local: '23:30', foto: null }));
    expect(plano).toMatchObject({ ok: true, texto: '' });
    if (plano.ok) expect(plano.desejado.canais.map((c) => [c.canal, c.situacao])).toEqual([
      ['instagram', 'apagado'],
      ['facebook', 'apagado'],
    ]);
    // O canal que não saiu (ou já foi apagado) fica como está.
    const emParte = estado();
    emParte.canais[1] = { ...emParte.canais[1]!, situacao: 'falhou' };
    const p2 = planoDeApagarOPost(emParte);
    if (!p2.ok) throw new Error(p2.motivo);
    expect(p2.desejado.canais.map((c) => c.situacao)).toEqual(['apagado', 'falhou']);
    const umJaSaiu = estado();
    umJaSaiu.canais[0] = { ...umJaSaiu.canais[0]!, situacao: 'apagado' };
    const p3 = planoDeApagarOPost(umJaSaiu);
    if (!p3.ok) throw new Error(p3.motivo);
    expect(p3.desejado.canais.map((c) => c.situacao)).toEqual(['apagado', 'apagado']);
  });

  it('recusa: nada no ar, a conta de um canal no ar que saiu da marca, e o que não é um post', () => {
    const nada = estado();
    nada.canais = nada.canais.map((c) => ({ ...c, situacao: 'falhou' as const }));
    expect(planoDeApagarOPost(nada)).toEqual({ ok: false, motivo: 'Apagar das redes vale para o post que o Liame publicou: este post não está no ar em nenhum canal.' });
    const semConta = estado();
    semConta.canais[1] = { ...semConta.canais[1]!, conta: null };
    expect(planoDeApagarOPost(semConta)).toEqual({
      ok: false,
      motivo: 'A conta da Página do Facebook deste post não está conectada à marca agora: o Liame não alcança o post na Página do Facebook. Conecte de novo em Contas conectadas, ou apague direto na rede.',
    });
    // A conta de um canal que não está no ar não importa.
    const contaDoQueNaoSaiu = estado();
    contaDoQueNaoSaiu.canais[1] = { ...contaDoQueNaoSaiu.canais[1]!, conta: null, situacao: 'falhou' };
    expect(recusaNaHoraDeApagar(contaDoQueNaoSaiu)).toBeNull();
    expect(planoDeApagarOPost({ outra: 'coisa' })).toEqual({ ok: false, motivo: 'Esta ferramenta é para um post do Liame.' });
  });

  it('o conector apaga quando o estado desejado tem um canal apagado; publicar nunca deseja isso', () => {
    const plano = planoDeApagarOPost(estado());
    if (!plano.ok) throw new Error(plano.motivo);
    expect(querApagar(plano.desejado)).toBe(true);
    expect(querApagar(estado())).toBe(false);
    expect(querApagar({ outra: 'coisa' })).toBe(false);
  });
});

describe('a situação do post com um canal apagado, e a do pedido de apagar', () => {
  const P = 'recusada por ';
  const s = (status: string, canais: string[]) => situacaoDoPost({ status, status_reason: null }, canais, P);

  it('o post que saiu de todos os canais é apagado; o que continua no ar num canal é publicado', () => {
    expect(s('executada', ['apagado', 'apagado'])).toBe('apagado');
    expect(s('executada', ['publicado', 'apagado'])).toBe('publicado');
    expect(s('executada', ['apagado'])).toBe('apagado');
    // O que saiu num canal (depois apagado) e não no outro: saiu de todos os canais em que estava.
    expect(s('falhou', ['apagado', 'falhou'])).toBe('apagado');
    expect(s('falhou', ['publicado', 'falhou'])).toBe('em_parte');
    expect(s('executada', ['publicado', 'publicado'])).toBe('publicado');
  });

  it('o pedido de apagar: apagando enquanto executa; depois, pelo que os canais dizem', () => {
    for (const p of ['aguardando_aprovacao', 'aprovada', 'executando']) expect(situacaoDoApagar(p, ['publicado', 'publicado'])).toBe('apagando');
    expect(situacaoDoApagar('executada', ['apagado', 'apagado'])).toBe('apagado');
    expect(situacaoDoApagar('executada', ['apagado', 'falhou'])).toBe('apagado');
    expect(situacaoDoApagar('falhou', ['publicado', 'apagado'])).toBe('em_parte');
    expect(situacaoDoApagar('falhou', ['publicado', 'publicado'])).toBe('nao_apagou');
    expect(situacaoDoApagar('cancelada', ['publicado'])).toBe('nao_apagou');
  });
});

describe('a ferramenta post_apagar e a política v10', () => {
  it('só como a volta da publicação, sempre com a aprovação, nos dois provedores do post; o plano recusado vira PlanoRecusado', () => {
    const t = TOOLS.post_apagar!;
    expect(t).toMatchObject({ name: 'post_apagar', version: 1, risk: 'R1', providers: ['instagram', 'facebook_page'], onlyAsUndo: true, alwaysApproval: true });
    expect(t.directByPerson).toBeUndefined();
    expect(t.travaTambem).toBeUndefined();
    expect(t.executeAt).toBeUndefined();
    expect(t.plan(estado(), {})).toMatchObject({ action: 'post.apagar', budgetImpact: 'none', reserveMicros: 0 });
    expect(() => t.plan({ outra: 'coisa' }, {})).toThrow(PlanoRecusado);
    // A publicação não ganha a volta genérica (`POST /v1/actions/{id}/undo`): apagar é só pela rota do post, com o código.
    expect(TOOLS.post_publicar!.undo).toBeUndefined();
    expect(TOOLS.post_tentar_de_novo!.undo).toBeUndefined();
  });

  it('apagar espera a aprovação de uma pessoa, com o código do app (a regra post.*), para quem pedir', () => {
    const proposta = (extra: Partial<ActionProposal> = {}): ActionProposal => ({
      tool: 'post_apagar',
      action: 'post.apagar',
      brand_id: null,
      provider: 'instagram',
      account_id: '00000000-0000-7000-8000-000000000002',
      risk_level: 'R1',
      budget_impact: 'none',
      value_micros: null,
      current_value_micros: null,
      categories: [],
      text: null,
      recent_count: 0,
      actor: 'human',
      ...extra,
    });
    expect(PLATFORM_POLICY.version).toBe(10);
    expect(chooseMode([PLATFORM_POLICY], proposta()).mode).toBe('APPROVAL');
    expect(chooseMode([PLATFORM_POLICY], proposta({ actor: 'agent' })).mode).toBe('APPROVAL');
  });
});
