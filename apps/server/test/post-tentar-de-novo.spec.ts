import type { ActionProposal } from '@liame/contracts';
import { describe, expect, it } from 'vitest';
import { pedeUmPostNovo } from '../src/actions/post-publicacao.js';
import { PlanoRecusado, TOOLS } from '../src/actions/tools.js';
import { chooseMode, PLATFORM_POLICY } from '../src/policy/engine.js';
import { type CanalParaTentar, type EstadoDoPost, HORAS_PARA_TENTAR_DE_NOVO, novaTentativa, planoDeTentarDeNovo } from '../src/posts/post-plano.js';

// A6 · Z5d, parte 1: "Tentar de novo" no canal que não saiu (P19, aprovado em 21/10/2026; D-A6-54), sem banco. A regra de
// quando dá (o pedido terminou sem sair, um canal saiu e o outro não, o motivo pode passar, até 24 horas depois de sair no
// outro canal), o plano da ferramenta `post_tentar_de_novo`, a política da distribuição v10 (direta só para uma pessoa)
// e a ferramenta que só existe pela rota do post, com a trava do `post_publicar`.

const SAIU_EM = new Date('2026-10-29T15:00:00Z');
const depois = (horas: number) => new Date(SAIU_EM.getTime() + horas * 3_600_000);
const ig = (o: Partial<CanalParaTentar> = {}): CanalParaTentar => ({ canal: 'instagram', situacao: 'publicado', publicadoEm: SAIU_EM, pedePostNovo: false, ...o });
const pagina = (o: Partial<CanalParaTentar> = {}): CanalParaTentar => ({ canal: 'facebook', situacao: 'falhou', publicadoEm: null, pedePostNovo: false, ...o });

describe('quando dá para tentar de novo (D-A6-54)', () => {
  it('o post que saiu num canal e não no outro: o canal que falta, até 24 horas depois de sair no outro', () => {
    expect(novaTentativa('falhou', [ig(), pagina()], depois(1))).toEqual({ ok: true, canal: 'facebook', ate: depois(HORAS_PARA_TENTAR_DE_NOVO) });
    // O canal que ficou esperando ou publicando quando o pedido terminou também falta (a execução barrada por uma trava fica "falhou").
    expect(novaTentativa('falhou', [ig(), pagina({ situacao: 'aguardando' })], depois(1))).toMatchObject({ ok: true, canal: 'facebook' });
    expect(novaTentativa('falhou', [ig({ situacao: 'publicando', publicadoEm: null }), pagina({ situacao: 'publicado', publicadoEm: SAIU_EM })], depois(1))).toMatchObject({ ok: true, canal: 'instagram' });
  });

  it('o prazo conta de quando o post saiu no outro canal: 24 horas depois, não dá mais', () => {
    expect(novaTentativa('falhou', [ig(), pagina()], depois(23.99))).toMatchObject({ ok: true });
    expect(novaTentativa('falhou', [ig(), pagina()], depois(24))).toEqual({ ok: false, motivo: 'passou_o_prazo' });
    expect(novaTentativa('falhou', [ig(), pagina()], depois(30))).toEqual({ ok: false, motivo: 'passou_o_prazo' });
  });

  it('não dá: o pedido que ainda sai, o que alguém parou, o post que não saiu em nenhum, o que já saiu, o motivo que pede post novo', () => {
    for (const p of ['aguardando_aprovacao', 'aprovada', 'executando', 'sombra']) expect(novaTentativa(p, [ig(), pagina()], depois(1))).toEqual({ ok: false, motivo: 'ainda_sai' });
    for (const p of ['cancelada', 'expirada', 'estado_mudou', null]) expect(novaTentativa(p, [ig(), pagina()], depois(1))).toEqual({ ok: false, motivo: 'nao_tenta' });
    expect(novaTentativa('falhou', [ig({ situacao: 'falhou', publicadoEm: null }), pagina()], depois(1))).toEqual({ ok: false, motivo: 'nao_saiu_em_nenhum' });
    expect(novaTentativa('falhou', [ig(), pagina({ situacao: 'publicado', publicadoEm: SAIU_EM })], depois(1))).toEqual({ ok: false, motivo: 'ja_saiu' });
    expect(novaTentativa('falhou', [ig(), pagina({ pedePostNovo: true })], depois(1))).toEqual({ ok: false, motivo: 'pede_post_novo' });
    // Cancelado ou apagado não é "não saiu": nada a tentar.
    expect(novaTentativa('falhou', [ig(), pagina({ situacao: 'apagado' })], depois(1))).toEqual({ ok: false, motivo: 'ja_saiu' });
  });

  it('os motivos que pedem um post novo: a foto recusada, o arquivo que sumiu, a foto grande, a tentativa sem conferir; os outros podem passar', () => {
    expect(pedeUmPostNovo('O Instagram não aceitou a foto deste post. O post não saiu no Instagram. Faça um post novo com outra foto.')).toBe(true);
    expect(pedeUmPostNovo('O arquivo da foto deste post não está mais guardado no Liame. O post não saiu na Página do Facebook. Faça um post novo.')).toBe(true);
    expect(pedeUmPostNovo('A foto deste post passa de 4 MB, o limite da Página do Facebook. O post não saiu na Página do Facebook.')).toBe(true);
    expect(pedeUmPostNovo(null)).toBe(false);
    expect(pedeUmPostNovo('A Meta recusou o acesso desta conta (a autorização foi revogada ou venceu). Conecte a Meta de novo em Contas conectadas. O post não saiu no Instagram.')).toBe(false);
    expect(pedeUmPostNovo('Uma trava está ligada (account: manutenção). O post não saiu na Página do Facebook.')).toBe(false);
  });
});

describe('o plano da nova tentativa (a ferramenta post_tentar_de_novo)', () => {
  const estado = (o: Partial<EstadoDoPost> = {}): EstadoDoPost => ({
    post: '00000000-0000-7000-8000-000000000001',
    foto: { id: 'foto', sha256: 'a'.repeat(64) },
    recorte: null,
    hora: '2026-10-29T15:00:00.000Z',
    hora_local: '12:00',
    canais: [
      { canal: 'instagram', conta: 'conta-ig', texto: 'Smash duplo hoje.', situacao: 'publicado' },
      { canal: 'facebook', conta: 'conta-pagina', texto: 'Smash duplo hoje. liame.link/abc', situacao: 'aguardando' },
    ],
    ...o,
  });

  it('publica só o canal que falta, com o texto dele para a política; a hora marcada que passou não recusa', () => {
    const plano = planoDeTentarDeNovo(estado({ hora_local: '23:30' }));
    expect(plano).toMatchObject({ ok: true, texto: 'Smash duplo hoje. liame.link/abc' });
    if (plano.ok) expect(plano.desejado.canais.map((c) => c.situacao)).toEqual(['publicado', 'publicado']);
  });

  it('recusa: a foto apagada, a conta que saiu da marca, o texto vazio, e sem um canal no ar e um esperando', () => {
    expect(planoDeTentarDeNovo(estado({ foto: null }))).toMatchObject({ ok: false, motivo: expect.stringMatching(/^A foto deste post foi apagada/) });
    const semConta = estado();
    semConta.canais[1] = { ...semConta.canais[1]!, conta: null };
    expect(planoDeTentarDeNovo(semConta)).toMatchObject({ ok: false, motivo: expect.stringMatching(/não está conectada à marca agora/) });
    const vazio = estado();
    vazio.canais[1] = { ...vazio.canais[1]!, texto: '  ' };
    expect(planoDeTentarDeNovo(vazio)).toMatchObject({ ok: false, motivo: 'O texto na Página do Facebook está vazio.' });
    // A rota põe o canal na espera antes do pedido: o canal ainda "falhou" (o pedido direto) não tem o que tentar.
    const falhou = estado();
    falhou.canais[1] = { ...falhou.canais[1]!, situacao: 'falhou' };
    expect(planoDeTentarDeNovo(falhou)).toMatchObject({ ok: false, motivo: expect.stringMatching(/^Tentar de novo vale para o post que saiu num canal/) });
    const nenhum = estado();
    nenhum.canais[0] = { ...nenhum.canais[0]!, situacao: 'aguardando' };
    expect(planoDeTentarDeNovo(nenhum)).toMatchObject({ ok: false });
    expect(planoDeTentarDeNovo({ outra: 'coisa' })).toEqual({ ok: false, motivo: 'Esta ferramenta é para um post do Liame.' });
  });

  it('a ferramenta: direta para uma pessoa, só pela rota do post, com a trava do post_publicar; o plano recusado vira PlanoRecusado', () => {
    const t = TOOLS.post_tentar_de_novo!;
    expect(t).toMatchObject({ name: 'post_tentar_de_novo', risk: 'R2', providers: ['instagram', 'facebook_page'], directByPerson: true, onlyAsRetry: true, travaTambem: 'post_publicar' });
    expect(t.alwaysApproval).toBeUndefined();
    expect(() => t.plan({ outra: 'coisa' }, {})).toThrow(PlanoRecusado);
  });
});

describe('a política da distribuição v10', () => {
  const proposta = (action: string, extra: Partial<ActionProposal> = {}): ActionProposal => ({
    tool: 'post_tentar_de_novo',
    action,
    brand_id: null,
    provider: 'facebook_page',
    account_id: '00000000-0000-7000-8000-000000000002',
    risk_level: 'R2',
    budget_impact: 'none',
    value_micros: null,
    current_value_micros: null,
    categories: [],
    text: 'Smash duplo hoje.',
    recent_count: 0,
    actor: 'human',
    ...extra,
  });

  it('tentar de novo é direto para uma pessoa; o funcionário de IA e o post novo seguem esperando a aprovação', () => {
    expect(PLATFORM_POLICY.version).toBe(10);
    expect(chooseMode([PLATFORM_POLICY], proposta('post.tentar_de_novo'))).toEqual({ mode: 'AUTO', source: 'platform', version: 10 });
    expect(chooseMode([PLATFORM_POLICY], proposta('post.tentar_de_novo', { actor: 'agent' })).mode).toBe('APPROVAL');
    expect(chooseMode([PLATFORM_POLICY], proposta('post.publicar', { tool: 'post_publicar' })).mode).toBe('APPROVAL');
  });
});
