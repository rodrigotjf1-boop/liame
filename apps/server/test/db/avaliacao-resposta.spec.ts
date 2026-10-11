import { createDatabase, type Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetService } from '../../src/actions/budget.service.js';
import { currentStep, totpCode } from '../../src/auth/totp.js';
import { loadConfig } from '../../src/config.js';
import { DATABASE } from '../../src/database/database.module.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { KillSwitchService } from '../../src/kill-switch/kill-switch.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ActionExecutor } from '../../src/worker/action-executor.js';
import { ConexaoProcessor } from '../../src/worker/conexao-processor.js';
import { PerfilLoop } from '../../src/worker/perfil-loop.js';
import { enableMfa, ownerQuery, PASSWORD, resetIpRateLimits, startApi, TERMOS, type TestApi, tokenFrom, uniqueEmail } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { ACESSO_RENOVADO, type AvaliacaoNoGoogle, CONTA_DO_PERFIL, type EmpresaComLoja, empresaComLojaDoPerfil, GoogleComPerfil, LOJA_DO_PERFIL, nomeDeQuemAvaliou } from '../helpers/perfil-google-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A6 · Z2 (parte b): a resposta da empresa a uma avaliação do Google, do pedido à publicação, pela API e contra um
// Google local que segue a referência (a resposta tem a data dela; a data da avaliação não muda). A loja nasce pelo
// caminho do produto, e as avaliações entram no Liame pela leitura. O que se prova aqui:
//   - A6-3: nenhuma resposta sai sem a aprovação de uma pessoa com o código do app; a de 1 ou 2 estrelas, só do dono;
//   - A6-4: o que sai é exatamente o texto aprovado, uma vez; a avaliação que mudou depois do pedido não é respondida;
//   - A6-5: o texto passa pelo Compliance antes de o pedido existir;
//   - o nome de quem avaliou é conferido contra o texto e não fica no pedido, na auditoria nem no e-mail (D-A6-5).
// Parte c: o que a tela do pedido lê (`review`, `pending_replies`) e apagar a resposta pelo desfazer (direto para a
// pessoa, só a que o Liame publicou). Nestes, o Google local é ligado no pior caso do que a referência não diz: mexe
// na data da avaliação ao responder e devolve o texto da resposta com os espaços acertados.

const DIA_MS = 86_400_000;
const TEXTO = 'Que bom ler isso! Ficamos felizes com a visita, e até o próximo smash.';
const PEDIR_DESCULPAS = 'Pedimos desculpas pela demora: não é o que queremos entregar. Fale com a gente pelo WhatsApp da loja para entendermos o seu pedido.';

type Quem = { cookie: string; userId: string; segredoDoApp: string };
type Resposta = Awaited<ReturnType<TestApi['call']>>;

describe.skipIf(!hasDb)('responder a uma avaliação do Google pelo trilho (A6 · Z2)', () => {
  let api: TestApi;
  let database: Database;
  let processador: ConexaoProcessor;
  let loop: PerfilLoop;
  let executor: ActionExecutor;
  const google = new GoogleComPerfil();

  beforeAll(async () => {
    await google.subir();
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 6, applicationName: 'liame-test' });
    const vault = api.app.get(VaultService);
    const flags = api.app.get(FlagService);
    processador = new ConexaoProcessor(database, loadConfig(), vault, flags);
    loop = new PerfilLoop(database, loadConfig(), vault, flags);
    executor = new ActionExecutor(api.app.get(DATABASE), api.app.get(BudgetService), api.app.get(KillSwitchService), flags);
  }, 120_000);
  beforeEach(async () => {
    google.limpar();
    // Cada teste cadastra a empresa dele: o limite de cadastros por IP é zerado entre um e outro.
    await resetIpRateLimits();
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await google.fechar();
  });

  const avaliacao = (id: string, estrelas: AvaliacaoNoGoogle['starRating'], haDias: number, extra: Partial<AvaliacaoNoGoogle> = {}): AvaliacaoNoGoogle => ({
    reviewId: id,
    starRating: estrelas,
    comment: `Comentário da avaliação ${id}`,
    createTime: new Date(Date.now() - haDias * DIA_MS).toISOString(),
    updateTime: new Date(Date.now() - haDias * DIA_MS).toISOString(),
    ...extra,
  });

  /** A empresa com a loja ligada, as avaliações do Google local lidas para o Liame e a escrita ligada (ou não). */
  async function empresa(nome: string, lista: AvaliacaoNoGoogle[], escrita = true): Promise<{ e: EmpresaComLoja; ids: Map<string, string> }> {
    const e = await empresaComLojaDoPerfil(api, google, processador, nome);
    google.lista = lista;
    expect((await loop.executarLote(10, { tenantIds: [e.tenantId] }, new Date())).map((r) => r.status)).toEqual(['ok', 'ok']);
    const linhas = await ownerQuery<{ id: string; external_id: string }>(`select id, external_id from liame.profile_review where connected_account_id = $1`, [e.contaId]);
    if (escrita) await ligarFlagDaEmpresa(api, 'perfil_google_write', e.tenantId, true);
    google.vistos.length = 0;
    return { e, ids: new Map(linhas.map((l) => [l.external_id, l.id])) };
  }
  const dono = (e: EmpresaComLoja): Quem => ({ cookie: e.cookie, userId: e.userId, segredoDoApp: e.segredoDoApp });
  /** Outra pessoa da empresa, pelo convite (o caminho do produto), com o app autenticador dela. */
  async function membro(e: EmpresaComLoja, papel: string): Promise<Quem> {
    const email = uniqueEmail(papel);
    expect((await api.call('POST', '/v1/invitations', { cookie: e.cookie, body: { email, role: papel, approve_limit_micros: null } })).status).toBe(201);
    const s = await api.call('POST', '/v1/invitations/signup', { body: { token: tokenFrom(api.mailer, email), name: `Pessoa ${papel}`, password: PASSWORD, terms_version: TERMOS } });
    const { secret } = await enableMfa(api, s.cookie!);
    return { cookie: s.cookie!, userId: s.body.user.id as string, segredoDoApp: secret };
  }
  const pedir = (quem: Quem, e: EmpresaComLoja, avaliacaoId: string, texto: string): Promise<Resposta> =>
    api.call('POST', '/v1/actions', { cookie: quem.cookie, body: { tool: 'avaliacao_responder', provider: 'google_business', account_id: e.contaId, resource_id: `avaliacao:${avaliacaoId}`, params: { texto } } });
  /** O código do app de agora (o passo usado e o limite de tentativas são zerados: o teste aprova mais de uma vez). */
  async function codigo(quem: Quem): Promise<string> {
    await ownerQuery(`update liame.app_user set totp_last_step = null where id = $1`, [quem.userId]);
    await ownerQuery(`delete from liame.rate_limit where key = $1`, [`segundo-fator:${quem.userId}`]);
    return totpCode(quem.segredoDoApp, currentStep());
  }
  const aprovar = async (quem: Quem, pedido: { id: string; plan_hash: string }): Promise<Resposta> =>
    api.call('POST', `/v1/actions/${pedido.id}/approve`, { cookie: quem.cookie, body: { plan_hash: pedido.plan_hash, code: await codigo(quem) } });
  const ciclo = (e: EmpresaComLoja) => executor.runCycle(20, { tenantIds: [e.tenantId] });
  const ver = async (e: EmpresaComLoja, id: string) => (await api.call('GET', `/v1/actions/${id}`, { cookie: e.cookie })).body;
  const guardada = async (id: string) => (await ownerQuery<{ reply_text: string | null; reply_state: string | null }>(`select reply_text, reply_state from liame.profile_review where id = $1`, [id]))[0]!;
  const leiturasDe = (id: string) => google.de('avaliacoes').filter((v) => v.metodo === 'GET' && v.caminho.endsWith(`/reviews/${id}`));
  const pedidosDaEmpresa = async (e: EmpresaComLoja) => Number((await ownerQuery<{ n: string }>(`select count(*)::text as n from liame.action_request where tenant_id = $1`, [e.tenantId]))[0]!.n);

  it('sem a flag de escrita, o pedido é recusado antes de qualquer chamada ao Google; e a loja de outra empresa não existe', async () => {
    const { e, ids } = await empresa('Mister Burgers Resposta Desligada', [avaliacao('rev-5', 'FIVE', 2)], false);
    const desligada = await pedir(dono(e), e, ids.get('rev-5')!, TEXTO);
    expect([desligada.status, desligada.body.code]).toEqual([403, 'escrita-desligada']);
    expect(google.vistos).toEqual([]);
    expect(await pedidosDaEmpresa(e)).toBe(0);

    // Outra empresa, com a escrita ligada, aponta para a loja e a avaliação desta: para ela, não existem.
    const outra = await empresa('Casa Brasa Resposta', [avaliacao('rev-9', 'FIVE', 2)]);
    const alheia = await api.call('POST', '/v1/actions', {
      cookie: outra.e.cookie,
      body: { tool: 'avaliacao_responder', provider: 'google_business', account_id: e.contaId, resource_id: `avaliacao:${ids.get('rev-5')!}`, params: { texto: TEXTO } },
    });
    expect([alheia.status, alheia.body.code]).toEqual([404, 'recurso-nao-encontrado']);
    // A avaliação de outra loja, com a loja certa: também não.
    const trocada = await pedir(dono(outra.e), outra.e, ids.get('rev-5')!, TEXTO);
    expect([trocada.status, trocada.body.code]).toEqual([404, 'recurso-nao-encontrado']);
    expect(google.vistos).toEqual([]);
  });

  it('A6-3 e A6-4: a pessoa pede, aprova com o código do app, e o Liame publica uma vez o texto aprovado; nada de quem avaliou fica no pedido', async () => {
    const { e, ids } = await empresa('Mister Burgers Resposta', [avaliacao('rev-5', 'FIVE', 2), avaliacao('rev-4', 'FOUR', 6)]);
    const id = ids.get('rev-5')!;
    const p = await pedir(dono(e), e, id, `  ${TEXTO}  `);
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body).toMatchObject({
      tool: 'avaliacao_responder',
      action: 'avaliacao.responder',
      provider: 'google_business',
      account_id: e.contaId,
      resource_id: `avaliacao:${id}`,
      brand_id: e.brandId,
      params: { texto: `  ${TEXTO}  ` },
      budget_impact: 'none',
      reserved_micros: 0,
      mode: 'APPROVAL',
      status: 'aguardando_aprovacao',
      policy: { allowed: true, mode: 'APPROVAL', violations: [] },
    });
    expect(p.body.policy.versions[0]).toBe('plataforma@8');
    // O pedido leu a avaliação no Google, com o acesso renovado, e mais nada. Sem a aprovação, o executor nem olha para ele.
    expect(google.de('avaliacoes').map((v) => [v.metodo, v.caminho, v.autorizacao])).toEqual([['GET', `/avaliacoes/v4/${CONTA_DO_PERFIL}/${LOJA_DO_PERFIL}/reviews/rev-5`, `Bearer ${ACESSO_RENOVADO}`]]);
    await ciclo(e);
    expect(google.respostasGravadas()).toEqual([]);
    expect(await guardada(id)).toEqual({ reply_text: null, reply_state: null });

    // D-A6-5: o Google local mandou o nome de quem avaliou; ele não está no pedido, na resposta da API nem na auditoria.
    // O texto da avaliação também não vai para o pedido (fica em `profile_review`).
    const [linha] = await ownerQuery<{ tudo: string }>(
      `select before_state::text || desired_state::text || params::text || policy_decision::text || coalesce(status_reason, '') as tudo from liame.action_request where id = $1`,
      [p.body.id],
    );
    const auditoria = await ownerQuery<{ tudo: string }>(`select coalesce(before::text, '') || coalesce(after::text, '') || coalesce(actor_label, '') as tudo from liame.audit_event where chain_key = $1`, [e.tenantId]);
    // Na resposta da API, o texto da avaliação aparece num lugar só (`review.current`, lido de `profile_review` para a
    // tela); o resto do pedido não o leva.
    for (const onde of [linha!.tudo, JSON.stringify({ ...p.body, review: null }), auditoria.map((a) => a.tudo).join(' ')]) {
      expect(onde).not.toContain('Pessoa Número');
      expect(onde).not.toContain(nomeDeQuemAvaliou('rev-5'));
      expect(onde).not.toContain('Comentário da avaliação rev-5');
    }
    expect(p.body.review.current.text).toBe('Comentário da avaliação rev-5');
    expect(JSON.stringify(p.body.review)).not.toContain('Pessoa Número');

    expect((await aprovar(dono(e), p.body)).body).toMatchObject({ status: 'aprovada' });
    await ciclo(e);
    expect(await ver(e, p.body.id)).toMatchObject({ status: 'executada', status_reason: null, execution: { status: 'executada', no_write: false } });
    // O que saiu é exatamente o texto aprovado, aparado, uma vez; antes de escrever, a avaliação foi lida de novo (duas
    // vezes: na validação e na hora).
    expect(google.respostasGravadas().map((v) => [v.caminho, v.corpo, v.autorizacao])).toEqual([[`/avaliacoes/v4/${CONTA_DO_PERFIL}/${LOJA_DO_PERFIL}/reviews/rev-5/reply`, { comment: TEXTO }, `Bearer ${ACESSO_RENOVADO}`]]);
    expect(leiturasDe('rev-5')).toHaveLength(3);
    expect(google.lista.find((a) => a.reviewId === 'rev-5')!.reviewReply).toMatchObject({ comment: TEXTO, reviewReplyState: 'PENDING' });
    // O Liame já mostra a resposta, com a situação que o Google devolveu (ele ainda confere).
    expect(await guardada(id)).toEqual({ reply_text: TEXTO, reply_state: 'pendente' });
    const tela = await api.call('GET', `/v1/reviews?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect(tela.body.reviews.find((r: { id: string }) => r.id === id).reply).toMatchObject({ text: TEXTO, state: 'pendente' });
    expect(tela.body.summary.unanswered).toBe(1);

    // A avaliação já tem resposta em conferência: outro pedido para ela nem nasce.
    const deNovo = await pedir(dono(e), e, id, 'Outra resposta, por engano.');
    expect([deNovo.status, deNovo.body.code, deNovo.body.detail]).toEqual([422, 'plano-recusado', 'Esta avaliação já tem uma resposta, que o Google está conferindo.']);
  });

  it('A6-4: a avaliação que mudou, ganhou resposta por outro caminho ou sumiu depois do pedido não é respondida', async () => {
    const { e, ids } = await empresa('Mister Burgers Mudou', [avaliacao('editada', 'FOUR', 3), avaliacao('respondida', 'FIVE', 4), avaliacao('apagada', 'THREE', 5)]);
    const pedidos: Record<string, { id: string }> = {};
    for (const qual of ['editada', 'respondida', 'apagada']) {
      const p = await pedir(dono(e), e, ids.get(qual)!, TEXTO);
      expect(p.status, JSON.stringify(p.body)).toBe(201);
      expect((await aprovar(dono(e), p.body)).body.status).toBe('aprovada');
      pedidos[qual] = p.body;
    }
    // Depois da aprovação: uma pessoa edita o que escreveu, a empresa responde outra direto no Google, e a terceira some.
    google.lista = [
      avaliacao('editada', 'TWO', 3, { comment: 'Editei: o lanche chegou frio.', updateTime: new Date().toISOString() }),
      avaliacao('respondida', 'FIVE', 4, { reviewReply: { comment: 'Respondido direto no Google.', updateTime: new Date().toISOString(), reviewReplyState: 'APPROVED' } }),
    ];
    await ciclo(e);
    for (const qual of ['editada', 'respondida', 'apagada']) {
      expect(await ver(e, pedidos[qual]!.id), qual).toMatchObject({ status: 'falhou', status_reason: 'o recurso mudou desde o pedido; nada foi sobrescrito', execution: { status: 'estado_mudou' } });
    }
    // Nada foi publicado: a resposta dada direto no Google ficou como estava.
    expect(google.respostasGravadas()).toEqual([]);
    expect(google.lista.find((a) => a.reviewId === 'respondida')!.reviewReply!.comment).toBe('Respondido direto no Google.');
    expect(google.lista.find((a) => a.reviewId === 'editada')!.reviewReply).toBeUndefined();
  });

  it('A6-3: a resposta a 1 ou 2 estrelas só o dono decide; os outros leem, e o dono é avisado', async () => {
    const { e, ids } = await empresa('Mister Burgers Nota Baixa na Resposta', [avaliacao('uma', 'ONE', 4), avaliacao('duas', 'TWO', 5)]);
    const adm = await membro(e, 'administrador');
    const p = await pedir(adm, e, ids.get('uma')!, PEDIR_DESCULPAS);
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body).toMatchObject({ action: 'avaliacao.responder_nota_baixa', mode: 'ESCALATE', status: 'aguardando_aprovacao', status_reason: 'precisa do dono' });
    // O dono é avisado por e-mail, com o endereço do pedido e sem o texto da avaliação, o da resposta ou o nome de ninguém.
    const aviso = api.mailer.lastTo(e.email);
    expect(aviso?.subject).toBe('Liame: uma resposta a avaliação espera a sua decisão');
    expect(aviso?.text).toContain(`/aprovacoes?pedido=${p.body.id}`);
    for (const fora of ['Pessoa Número', 'Comentário da avaliação', 'Pedimos desculpas']) expect(aviso?.text).not.toContain(fora);

    // Quem não é o dono não aprova, não recusa e não altera, mesmo podendo aprovar outros pedidos.
    const naoAprova = await aprovar(adm, p.body);
    expect([naoAprova.status, naoAprova.body.code, naoAprova.body.detail]).toEqual([403, 'so-o-dono', 'Só o dono da empresa pode aprovar este pedido. Ele espera o dono em Aprovações.']);
    const naoRecusa = await api.call('POST', `/v1/actions/${p.body.id}/reject`, { cookie: adm.cookie, body: { plan_hash: p.body.plan_hash, reason: 'Prefiro não responder' } });
    expect([naoRecusa.status, naoRecusa.body.code]).toEqual([403, 'so-o-dono']);
    const naoAltera = await api.call('PATCH', `/v1/actions/${p.body.id}`, { cookie: adm.cookie, body: { params: { texto: 'Outro texto, de quem não é o dono.' } } });
    expect([naoAltera.status, naoAltera.body.code]).toEqual([403, 'so-o-dono']);
    expect(await ver(e, p.body.id)).toMatchObject({ status: 'aguardando_aprovacao', plan_hash: p.body.plan_hash, approvals: [] });
    await ciclo(e);
    expect(google.respostasGravadas()).toEqual([]);

    // O dono muda o texto: o plano é outro, e a aprovação vale só para o texto novo.
    const novo = `${PEDIR_DESCULPAS} Já revimos o que aconteceu naquela noite.`;
    const alterado = await api.call('PATCH', `/v1/actions/${p.body.id}`, { cookie: e.cookie, body: { params: { texto: novo } } });
    expect(alterado.status, JSON.stringify(alterado.body)).toBe(200);
    expect(alterado.body.plan_hash).not.toBe(p.body.plan_hash);
    expect((await aprovar(dono(e), p.body)).body.code).toBe('plano-mudou');
    expect((await aprovar(dono(e), alterado.body)).body).toMatchObject({ status: 'aprovada', approvals: [{ approver_role: 'dono', sufficient: true }] });
    await ciclo(e);
    expect(await ver(e, p.body.id)).toMatchObject({ status: 'executada' });
    expect(google.respostasGravadas().map((v) => v.corpo)).toEqual([{ comment: novo }]);

    // Quando é o próprio dono que pede, ninguém precisa avisá-lo; e ele também recusa.
    const antes = api.mailer.lastTo(e.email);
    const doDono = await pedir(dono(e), e, ids.get('duas')!, PEDIR_DESCULPAS);
    expect(doDono.body).toMatchObject({ mode: 'ESCALATE', status_reason: 'precisa do dono' });
    expect(api.mailer.lastTo(e.email)).toBe(antes);
    const recusada = await api.call('POST', `/v1/actions/${doDono.body.id}/reject`, { cookie: e.cookie, body: { plan_hash: doDono.body.plan_hash, reason: 'Prefiro não responder' } });
    expect(recusada.body).toMatchObject({ status: 'cancelada' });
  });

  it('A6-5: o texto que o Compliance barra, o que cita quem avaliou e o que a política da empresa proíbe não viram pedido', async () => {
    const { e, ids } = await empresa('Mister Burgers Texto da Resposta', [avaliacao('rev-5', 'FIVE', 2), avaliacao('sem-nome', 'FOUR', 3, { anonima: true })]);
    const id = ids.get('rev-5')!;
    const recusa = async (texto: string) => {
      const r = await pedir(dono(e), e, id, texto);
      return [r.status, r.body.code, r.body.detail as string] as const;
    };
    // O Google local chama quem avaliou de "Pessoa Número rev-5": o primeiro nome é "Pessoa".
    const comNome = await recusa('Que bom, Pessoa! Volte sempre.');
    expect(comNome.slice(0, 2)).toEqual([422, 'plano-recusado']);
    expect(comNome[2]).toBe('O texto da resposta não passa assim. Ajuste e salve de novo: o nome de quem avaliou: o Liame não guarda esse nome, e a resposta fica guardada no pedido.');
    expect((await recusa('Volte sempre: na próxima, a sobremesa fica de cortesia.'))[2]).toContain('promessa de compensação em público (cortesia)');
    expect((await recusa('Ligue para (21) 99999-0000 e resolvemos.'))[2]).toContain('dado pessoal no texto');
    expect((await recusa('   '))[2]).toContain('com até 1.500 caracteres');
    // O que a empresa proíbe na política dela vale para a resposta.
    expect((await api.call('POST', '/v1/policies', { cookie: e.cookie, body: { document: { rules: [{ type: 'forbidden_words', words: ['gourmet'] }] } } })).status).toBe(201);
    const daEmpresa = await pedir(dono(e), e, id, 'O nosso hambúrguer gourmet agradece a visita.');
    expect([daEmpresa.status, daEmpresa.body.code]).toEqual([422, 'politica-negou']);
    expect(await pedidosDaEmpresa(e)).toBe(0);
    expect(google.respostasGravadas()).toEqual([]);

    // A avaliação anônima não tem nome para conferir: o mesmo texto passa.
    const anonima = await pedir(dono(e), e, ids.get('sem-nome')!, 'Que bom, pessoa querida! Volte sempre.');
    expect([anonima.status, anonima.body.status], JSON.stringify(anonima.body)).toEqual([201, 'aguardando_aprovacao']);
  });

  it('a resposta que o Google gravou sem conseguir responder não é mandada de novo; e no limite de cota a ação espera', async () => {
    const { e, ids } = await empresa('Mister Burgers Queda na Resposta', [avaliacao('rev-5', 'FIVE', 2), avaliacao('rev-4', 'FOUR', 3)]);
    const p = await pedir(dono(e), e, ids.get('rev-5')!, TEXTO);
    expect((await aprovar(dono(e), p.body)).body.status).toBe('aprovada');
    // O Google grava a resposta, e a conexão cai antes de ele responder.
    google.respostaCaiDepoisDeGravar = true;
    await ciclo(e);
    expect(await ver(e, p.body.id)).toMatchObject({ status: 'aprovada', status_reason: 'o Google não respondeu' });
    expect(google.respostasGravadas()).toHaveLength(1);
    // Na hora da nova tentativa, o Liame lê a avaliação antes: a resposta já está lá, com o texto aprovado.
    google.respostaCaiDepoisDeGravar = false;
    await ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 minute' where id = $1`, [p.body.id]);
    await ciclo(e);
    expect(await ver(e, p.body.id)).toMatchObject({ status: 'executada', status_reason: null });
    expect(google.respostasGravadas()).toHaveLength(1);
    expect(await guardada(ids.get('rev-5')!)).toEqual({ reply_text: TEXTO, reply_state: 'pendente' });

    // A cota do Google esgotada na hora de gravar: a ação espera, e nada é dado como feito.
    const q = await pedir(dono(e), e, ids.get('rev-4')!, TEXTO);
    expect((await aprovar(dono(e), q.body)).body.status).toBe('aprovada');
    google.resposta = 'sem-cota';
    await ciclo(e);
    expect(await ver(e, q.body.id)).toMatchObject({ status: 'aprovada', status_reason: 'o Google pediu para esperar (limite de uso do Google)' });
    expect(google.lista.find((a) => a.reviewId === 'rev-4')!.reviewReply).toBeUndefined();
    expect(await guardada(ids.get('rev-4')!)).toEqual({ reply_text: null, reply_state: null });
    // A pessoa desiste: o pedido cancelado não executa quando a cota volta.
    expect((await api.call('POST', `/v1/actions/${q.body.id}/cancel`, { cookie: e.cookie })).body.status).toBe('cancelada');
    google.resposta = 'ok';
    await ciclo(e);
    expect(google.lista.find((a) => a.reviewId === 'rev-4')!.reviewReply).toBeUndefined();
  });

  it('a escrita desligada depois da aprovação segura a execução: nada é publicado', async () => {
    const { e, ids } = await empresa('Mister Burgers Desligou Depois', [avaliacao('rev-5', 'FIVE', 2)]);
    const p = await pedir(dono(e), e, ids.get('rev-5')!, TEXTO);
    expect((await aprovar(dono(e), p.body)).body.status).toBe('aprovada');
    await ligarFlagDaEmpresa(api, 'perfil_google_write', e.tenantId, false);
    await ciclo(e);
    expect(await ver(e, p.body.id)).toMatchObject({ status: 'falhou', status_reason: 'escrita em google_business desligada' });
    expect(google.respostasGravadas()).toEqual([]);
  });

  it('parte c: o pedido leva a avaliação para a tela (o texto vem do que o Liame guarda), e a tela Avaliações sabe da resposta que espera', async () => {
    const { e, ids } = await empresa('Mister Burgers Resposta na Tela', [avaliacao('rev-5', 'FIVE', 2), avaliacao('rev-1', 'ONE', 3), avaliacao('rev-4', 'FOUR', 4)]);
    const [id5, id1] = [ids.get('rev-5')!, ids.get('rev-1')!];
    const telaDasAvaliacoes = async () => (await api.call('GET', `/v1/reviews?brand_id=${e.brandId}`, { cookie: e.cookie })).body;
    expect((await telaDasAvaliacoes()).pending_replies).toEqual([]);

    const p = await pedir(dono(e), e, id5, `  ${TEXTO}  `);
    expect(p.status, JSON.stringify(p.body)).toBe(201);
    expect(p.body.review).toEqual({
      id: id5,
      stars: 5,
      owner_only: false,
      reply_text: TEXTO,
      current: { id: id5, store_id: e.contaId, stars: 5, text: 'Comentário da avaliação rev-5', reviewed_at: expect.any(String), changed_at: expect.any(String), reply: null },
      changed: false,
    });
    const baixa = await pedir(dono(e), e, id1, PEDIR_DESCULPAS);
    expect(baixa.body.review).toMatchObject({ id: id1, stars: 1, owner_only: true, reply_text: PEDIR_DESCULPAS, changed: false });
    // A tela Avaliações: as duas respostas que esperam, na ordem em que foram pedidas, com o pedido de cada uma.
    expect((await telaDasAvaliacoes()).pending_replies).toEqual([
      { review_id: id5, action_id: p.body.id, owner_only: false },
      { review_id: id1, action_id: baixa.body.id, owner_only: true },
    ]);
    // Na lista de pedidos, o mesmo objeto; e o pedido de outra coisa não tem avaliação.
    const lista = (await api.call('GET', '/v1/actions', { cookie: e.cookie })).body.items as Array<{ id: string; review: { id: string } | null }>;
    expect(lista.find((a) => a.id === p.body.id)!.review).toMatchObject({ id: id5, reply_text: TEXTO });

    // Quem avaliou edita o que escreveu, e a leitura de hora em hora traz a avaliação nova: o pedido que espera diz que
    // ela mudou (a resposta foi escrita para a de antes), com a nota da hora do pedido e a avaliação de agora.
    google.lista = [avaliacao('rev-5', 'FOUR', 2, { comment: 'Editei: a batata veio fria.', updateTime: new Date().toISOString() }), avaliacao('rev-1', 'ONE', 3), avaliacao('rev-4', 'FOUR', 4)];
    await loop.executarLote(10, { tenantIds: [e.tenantId] }, new Date(Date.now() + 2 * 3_600_000));
    expect((await ver(e, p.body.id)).review).toMatchObject({ stars: 5, reply_text: TEXTO, changed: true, current: { stars: 4, text: 'Editei: a batata veio fria.' } });
    expect((await ver(e, baixa.body.id)).review).toMatchObject({ changed: false });
    // Aprovada assim, ela não é publicada (A6-4), e deixa de esperar.
    expect((await aprovar(dono(e), p.body)).body.status).toBe('aprovada');
    await ciclo(e);
    expect(await ver(e, p.body.id)).toMatchObject({ status: 'falhou', execution: { status: 'estado_mudou' } });
    expect(google.respostasGravadas()).toEqual([]);

    // A de 1 estrela, aprovada pelo dono: publicada, o pedido mostra a resposta que está no Google, e ninguém mais espera.
    expect((await aprovar(dono(e), baixa.body)).body.status).toBe('aprovada');
    await ciclo(e);
    const feita = await ver(e, baixa.body.id);
    expect(feita).toMatchObject({ status: 'executada', review: { owner_only: true, reply_text: PEDIR_DESCULPAS, changed: false, current: { reply: { text: PEDIR_DESCULPAS, state: 'pendente', violation: null } } } });
    expect((await telaDasAvaliacoes()).pending_replies).toEqual([]);
    // D-A6-5: o objeto da tela não leva nada de quem avaliou.
    expect(JSON.stringify([p.body.review, feita.review])).not.toContain('Pessoa Número');
  });

  it('parte c: apagar a resposta é direto para a pessoa, só a que o Liame publicou e só enquanto ela é a mesma', async () => {
    const { e, ids } = await empresa('Mister Burgers Apagar a Resposta', [avaliacao('rev-5', 'FIVE', 2), avaliacao('rev-4', 'FOUR', 3), avaliacao('rev-3', 'THREE', 4)]);
    const adm = await membro(e, 'administrador');
    const [id5, id4, id3] = [ids.get('rev-5')!, ids.get('rev-4')!, ids.get('rev-3')!];
    const desfazer = (quem: Quem, pedido: string) => api.call('POST', `/v1/actions/${pedido}/undo`, { cookie: quem.cookie });
    const noGoogle = (reviewId: string) => google.lista.find((a) => a.reviewId === reviewId)!;
    async function publicar(avaliacaoId: string, texto: string): Promise<{ id: string }> {
      const p = await pedir(dono(e), e, avaliacaoId, texto);
      expect(p.status, JSON.stringify(p.body)).toBe(201);
      expect((await aprovar(dono(e), p.body)).body.status).toBe('aprovada');
      await ciclo(e);
      return p.body;
    }

    // O pior caso do que a referência do Google não diz: responder mexe na data da avaliação, e o Google guarda o texto
    // com os espaços acertados. E a volta da gravação se perde: a tentativa seguinte reconhece a resposta e não manda de novo.
    google.responderMexeNaData = true;
    google.acertaOsEspacos = true;
    google.respostaCaiDepoisDeGravar = true;
    const COM_ESPACOS = 'Que bom ler isso!  Ficamos felizes com a visita,\n\naté o próximo smash.';
    const ACERTADO = 'Que bom ler isso! Ficamos felizes com a visita, até o próximo smash.';
    const p = await publicar(id5, COM_ESPACOS);
    expect(await ver(e, p.id)).toMatchObject({ status: 'aprovada', status_reason: 'o Google não respondeu' });
    google.respostaCaiDepoisDeGravar = false;
    await ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 minute' where id = $1`, [p.id]);
    await ciclo(e);
    expect(await ver(e, p.id)).toMatchObject({ status: 'executada', undone_by: null });
    expect(google.respostasGravadas().map((v) => v.corpo)).toEqual([{ comment: COM_ESPACOS }]);
    expect(await guardada(id5)).toEqual({ reply_text: ACERTADO, reply_state: 'pendente' });
    // O Google termina de conferir e libera a resposta: quem mexeu foi ele, e a resposta continua sendo a do Liame.
    noGoogle('rev-5').reviewReply!.reviewReplyState = 'APPROVED';

    // Não se pede direto: a ferramenta só existe como a volta. E a resposta dada direto no Google não é do Liame.
    noGoogle('rev-3').reviewReply = { comment: 'Respondido direto no Google.', updateTime: new Date().toISOString(), reviewReplyState: 'APPROVED' };
    google.vistos.length = 0;
    const direto = await api.call('POST', '/v1/actions', { cookie: e.cookie, body: { tool: 'avaliacao_apagar_resposta', provider: 'google_business', account_id: e.contaId, resource_id: `avaliacao:${id3}`, params: {} } });
    expect([direto.status, direto.body.code]).toEqual([422, 'acao-so-como-volta']);
    expect(google.vistos).toEqual([]);

    // Quem opera as campanhas apaga, sem o código do app: o pedido nasce aprovado, com o nome de quem pediu.
    const volta = await desfazer(adm, p.id);
    expect(volta.body, JSON.stringify(volta.body)).toMatchObject({
      tool: 'avaliacao_apagar_resposta',
      action: 'avaliacao.apagar_resposta',
      provider: 'google_business',
      resource_id: `avaliacao:${id5}`,
      mode: 'AUTO',
      status: 'aprovada',
      status_reason: 'pedida por uma pessoa: esta ação não espera aprovação',
      undoes: p.id,
      approvals: [],
      requested_by: { id: adm.userId },
      review: { id: id5, stars: 5, owner_only: false, reply_text: ACERTADO },
    });
    expect(volta.body.policy.versions[0]).toBe('plataforma@8');
    expect((await desfazer(adm, p.id)).body.code).toBe('volta-ja-pedida');
    // O Google apaga, e a conexão cai antes de ele responder: a tentativa seguinte vê a resposta fora e não apaga de novo.
    google.apagarCaiDepoisDeApagar = true;
    await ciclo(e);
    expect(await ver(e, volta.body.id)).toMatchObject({ status: 'aprovada', status_reason: 'o Google não respondeu' });
    expect(noGoogle('rev-5').reviewReply).toBeUndefined();
    google.apagarCaiDepoisDeApagar = false;
    await ownerQuery(`update liame.action_request set next_attempt_at = now() - interval '1 minute' where id = $1`, [volta.body.id]);
    await ciclo(e);
    expect(await ver(e, volta.body.id)).toMatchObject({ status: 'executada', status_reason: null });
    expect(google.respostasApagadas().map((v) => v.caminho)).toEqual([`/avaliacoes/v4/${CONTA_DO_PERFIL}/${LOJA_DO_PERFIL}/reviews/rev-5/reply`]);
    // O Liame já mostra a avaliação sem resposta, e o pedido da resposta diz quem a desfez.
    expect(await guardada(id5)).toEqual({ reply_text: null, reply_state: null });
    expect(await ver(e, p.id)).toMatchObject({ status: 'executada', undone_by: { id: volta.body.id, status: 'executada' }, review: { current: { reply: null } } });
    // Sem resposta, a avaliação pode ganhar outra.
    expect((await pedir(dono(e), e, id5, TEXTO)).status).toBe(201);

    // A resposta que alguém editou direto no Google depois de publicada não é mais a do Liame: ele não apaga. (A
    // publicação desta saiu de primeira, e o Google segue mexendo na data da avaliação ao responder.)
    google.acertaOsEspacos = false;
    const q = await publicar(id4, TEXTO);
    expect(await ver(e, q.id)).toMatchObject({ status: 'executada' });
    noGoogle('rev-4').reviewReply!.comment = 'Editada direto no Google.';
    const mexida = await desfazer(dono(e), q.id);
    expect([mexida.status, mexida.body.code]).toEqual([409, 'estado-mudou']);
    // A resposta que o Google recusou também não: ela não aparece no perfil, e o que cabe é responder de novo.
    Object.assign(noGoogle('rev-4').reviewReply!, { comment: TEXTO, reviewReplyState: 'REJECTED', policyViolation: 'CODIGO_DE_EXEMPLO' });
    expect((await desfazer(dono(e), q.id)).body.code).toBe('estado-mudou');
    // Com a escrita desligada, nem o apagar passa.
    Object.assign(noGoogle('rev-4').reviewReply!, { reviewReplyState: 'APPROVED' });
    await ligarFlagDaEmpresa(api, 'perfil_google_write', e.tenantId, false);
    expect((await desfazer(dono(e), q.id)).body.code).toBe('escrita-desligada');
    expect(google.respostasApagadas()).toHaveLength(1);
    expect(noGoogle('rev-4').reviewReply!.comment).toBe(TEXTO);
    // Ligada de novo, e com a resposta como o Liame a publicou (o Google só a liberou e mexeu na data): apaga.
    await ligarFlagDaEmpresa(api, 'perfil_google_write', e.tenantId, true);
    const outraVolta = await desfazer(dono(e), q.id);
    expect(outraVolta.body, JSON.stringify(outraVolta.body)).toMatchObject({ tool: 'avaliacao_apagar_resposta', status: 'aprovada', undoes: q.id });
    await ciclo(e);
    expect(await ver(e, outraVolta.body.id)).toMatchObject({ status: 'executada' });
    expect(google.respostasApagadas()).toHaveLength(2);
    expect(noGoogle('rev-4').reviewReply).toBeUndefined();
  });

  it('parte c: a resposta a 1 ou 2 estrelas, que só o dono aprovou, só o dono apaga', async () => {
    const { e, ids } = await empresa('Mister Burgers Apagar Nota Baixa', [avaliacao('duas', 'TWO', 3)]);
    const adm = await membro(e, 'administrador');
    const p = await pedir(dono(e), e, ids.get('duas')!, PEDIR_DESCULPAS);
    expect((await aprovar(dono(e), p.body)).body.status).toBe('aprovada');
    await ciclo(e);
    expect(await ver(e, p.body.id)).toMatchObject({ status: 'executada', review: { owner_only: true } });

    const doAdm = await api.call('POST', `/v1/actions/${p.body.id}/undo`, { cookie: adm.cookie });
    expect([doAdm.status, doAdm.body.code, doAdm.body.detail]).toEqual([403, 'so-o-dono', 'Só o dono da empresa pode desfazer este pedido.']);
    expect(google.respostasApagadas()).toEqual([]);
    const doDono = await api.call('POST', `/v1/actions/${p.body.id}/undo`, { cookie: e.cookie });
    expect(doDono.body, JSON.stringify(doDono.body)).toMatchObject({ tool: 'avaliacao_apagar_resposta', status: 'aprovada', review: { stars: 2, owner_only: false, reply_text: PEDIR_DESCULPAS } });
    await ciclo(e);
    expect(await ver(e, doDono.body.id)).toMatchObject({ status: 'executada' });
    expect(google.lista.find((a) => a.reviewId === 'duas')!.reviewReply).toBeUndefined();
    expect(await guardada(ids.get('duas')!)).toEqual({ reply_text: null, reply_state: null });
  });
});
