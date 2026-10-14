import { createDatabase, type Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { procuraGuardada } from '../../src/connectors/google-business/perfil-google.js';
import { FlagService } from '../../src/flags/flag.service.js';
import { VaultService } from '../../src/vault/vault.service.js';
import { ConexaoProcessor, HORAS_ENTRE_PROCURAS_DO_PERFIL } from '../../src/worker/conexao-processor.js';
import { PerfilLoop } from '../../src/worker/perfil-loop.js';
import { ownerQuery, resetIpRateLimits, startApi, type TestApi } from '../helpers/api.js';
import { ligarFlagDaEmpresa } from '../helpers/meta-de-mentira.js';
import { type AvaliacaoNoGoogle, type EmpresaAutorizada, empresaComPerfilAutorizado, GoogleComPerfil, ligarLojaDoPerfil, LOJA_DO_PERFIL } from '../helpers/perfil-google-de-mentira.js';
import { APP_URL, hasDb } from './env.js';

// A6 · Z1 (parte d): a procura diária das lojas do Perfil enquanto o Google não libera o acesso, e os avisos do Perfil
// na Atenção, de ponta a ponta contra um Google local. O que se prova aqui:
//   - a autorização em que a procura parou no limite é procurada de novo uma vez por dia, com uma chamada só (A6-2), e
//     as lojas aparecem quando o Google libera; a função desligada tira a autorização da fila;
//   - a Atenção avisa das lojas por ligar, da avaliação de 1 ou 2 estrelas sem resposta e da loja que parou de ser
//     lida, só para a empresa com a função ligada, e sem o texto da avaliação nem nada de quem avaliou.

const MIN_MS = 60_000;
const HORA_MS = 60 * MIN_MS;
const DIA_MS = 24 * HORA_MS;

type Aviso = { kind: string; severity: string; title: string; detail: string; action: string; connected_account_id: string | null; campaign_id: string | null; provider: string | null; brand_id: string | null };
type Descoberta = { provider: string; external_id: string };

describe.skipIf(!hasDb)('a procura diária das lojas e os avisos do Perfil na Atenção (A6 · Z1)', () => {
  let api: TestApi;
  let database: Database;
  let processador: ConexaoProcessor;
  let loop: PerfilLoop;
  const google = new GoogleComPerfil();
  const AGORA = new Date();
  const ha = (dias: number) => new Date(AGORA.getTime() - dias * DIA_MS).toISOString();
  const diaDaLoja = (iso: string) => new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });

  beforeAll(async () => {
    await google.subir();
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 6, applicationName: 'liame-test' });
    const vault = api.app.get(VaultService);
    const flags = api.app.get(FlagService);
    processador = new ConexaoProcessor(database, loadConfig(), vault, flags);
    loop = new PerfilLoop(database, loadConfig(), vault, flags);
  }, 120_000);
  beforeEach(async () => {
    google.limpar();
    await resetIpRateLimits();
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await google.fechar();
  });

  const empresa = (nome: string) => empresaComPerfilAutorizado(api, google, processador, nome);
  const conexao = async (e: EmpresaAutorizada) =>
    (await ownerQuery<{ status: string; discovered: Descoberta[]; discovery_notes: Record<string, unknown> }>(`select status, discovered, discovery_notes from liame.oauth_connection where id = $1`, [e.conexaoId]))[0]!;
  const procurar = (e: EmpresaAutorizada, quando: Date) => processador.procurarLojasDeNovo(5, { tenantIds: [e.tenantId] }, quando);
  const lojasDescobertas = (c: { discovered: Descoberta[] }) => c.discovered.filter((d) => d.provider === 'google_business').map((d) => d.external_id);
  /** Os avisos do Perfil que a tela Atenção recebe (os outros avisos da empresa ficam de fora da comparação). */
  const avisosDoPerfil = async (e: EmpresaAutorizada): Promise<Aviso[]> => {
    const r = await api.call('GET', '/v1/media/attention', { cookie: e.cookie });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (r.body.items as Aviso[]).filter((i) => ['perfil_lojas_por_ligar', 'avaliacao_sem_resposta', 'resposta_recusada', 'conta_desconectada', 'conta_sem_permissao', 'conta_com_erro'].includes(i.kind));
  };
  const avaliacao = (id: string, estrelas: AvaliacaoNoGoogle['starRating'], feitaHaDias: number, extra: Partial<AvaliacaoNoGoogle> = {}): AvaliacaoNoGoogle => ({
    reviewId: id,
    starRating: estrelas,
    comment: `Texto que a Atenção não pode mostrar: ${id}`,
    createTime: ha(feitaHaDias),
    updateTime: ha(Math.min(feitaHaDias, 1)),
    ...extra,
  });

  it('a procura que parou no limite é refeita uma vez por dia, com uma chamada só; quando o Google libera, as lojas aparecem e a procura para', async () => {
    google.lojas = 'sem-cota';
    const e = await empresa('Mister Burgers Espera o Google');
    const inicio = await conexao(e);
    expect(lojasDescobertas(inicio)).toEqual([]);
    const primeira = procuraGuardada(inicio.discovery_notes)!;
    expect(primeira).toMatchObject({ resultado: 'limite', lojas: 0 });
    const t0 = new Date(primeira.em);

    // Antes de um dia, nada é devido.
    google.vistos.length = 0;
    expect(HORAS_ENTRE_PROCURAS_DO_PERFIL).toBe(24);
    expect(await procurar(e, new Date(t0.getTime() + 23 * HORA_MS))).toBe(0);
    expect(google.vistos).toEqual([]);

    // Um dia depois, com o Google ainda sem liberar: uma chamada só, e a anotação segue "limite", com o instante novo.
    const d1 = new Date(t0.getTime() + DIA_MS + MIN_MS);
    expect(await procurar(e, d1)).toBe(1);
    expect(google.de('contas').length + google.de('lojas').length).toBe(1);
    const aindaNao = await conexao(e);
    expect(procuraGuardada(aindaNao.discovery_notes)).toEqual({ resultado: 'limite', em: d1.toISOString(), lojas: 0 });
    expect(aindaNao.status).toBe(inicio.status);
    expect(await avisosDoPerfil(e)).toEqual([]);
    // No mesmo dia, não procura de novo.
    google.vistos.length = 0;
    expect(await procurar(e, new Date(d1.getTime() + 5 * HORA_MS))).toBe(0);
    expect(google.vistos).toEqual([]);

    // O Google liberou: na procura do dia seguinte as lojas aparecem, e a auditoria registra.
    google.lojas = 'ok';
    const d2 = new Date(d1.getTime() + DIA_MS + MIN_MS);
    expect(await procurar(e, d2)).toBe(1);
    const liberou = await conexao(e);
    expect(lojasDescobertas(liberou)).toEqual([LOJA_DO_PERFIL]);
    expect(procuraGuardada(liberou.discovery_notes)).toEqual({ resultado: 'ok', em: d2.toISOString(), lojas: 1 });
    expect(liberou.status).toBe(inicio.status);
    const [auditoria] = await ownerQuery<{ after: Record<string, unknown> }>(`select after from liame.audit_event where tenant_id = $1 and resource_id = $2 and action = 'conexao.procurar_lojas'`, [e.tenantId, e.conexaoId]);
    expect(auditoria!.after).toEqual({ perfil_no_google: 'ok', lojas: 1 });
    // E a Atenção passa a avisar que há loja para ligar.
    expect((await avisosDoPerfil(e)).map((a) => a.kind)).toEqual(['perfil_lojas_por_ligar']);

    // Achou: a autorização sai da fila da procura.
    google.vistos.length = 0;
    expect(await procurar(e, new Date(d2.getTime() + 5 * DIA_MS))).toBe(0);
    expect(google.vistos).toEqual([]);
  });

  it('a função desligada tira a autorização da fila sem chamar o Google; a renovação recusada vira falha e volta no dia seguinte', async () => {
    google.lojas = 'sem-cota';
    const e = await empresa('Casa Brasa Desligou a Procura');
    const t0 = new Date(procuraGuardada((await conexao(e)).discovery_notes)!.em);

    // A renovação do acesso é recusada: fica como falha, sem chamar o Perfil.
    google.renovacaoRecusada = true;
    google.vistos.length = 0;
    const d1 = new Date(t0.getTime() + DIA_MS + MIN_MS);
    expect(await procurar(e, d1)).toBe(1);
    expect(google.de('contas').length + google.de('lojas').length).toBe(0);
    expect(procuraGuardada((await conexao(e)).discovery_notes)).toEqual({ resultado: 'falhou', em: d1.toISOString(), lojas: 0 });

    // A função desligada para a empresa: a autorização é olhada mais uma vez, perde a anotação e sai da fila.
    google.renovacaoRecusada = false;
    await ligarFlagDaEmpresa(api, 'perfil_google', e.tenantId, false);
    google.vistos.length = 0;
    const d2 = new Date(d1.getTime() + DIA_MS + MIN_MS);
    expect(await procurar(e, d2)).toBe(1);
    expect(google.de('contas').length + google.de('lojas').length).toBe(0);
    expect((await conexao(e)).discovery_notes).toEqual({});
    expect(await procurar(e, new Date(d2.getTime() + 3 * DIA_MS))).toBe(0);
  });

  it('quatro voltas da procura ao mesmo tempo procuram cada autorização uma vez só', async () => {
    google.lojas = 'sem-cota';
    const e = await empresa('Mister Burgers Procura Junta');
    const t0 = new Date(procuraGuardada((await conexao(e)).discovery_notes)!.em);
    google.lojas = 'ok';
    google.vistos.length = 0;
    const quando = new Date(t0.getTime() + DIA_MS + MIN_MS);
    const voltas = await Promise.all([procurar(e, quando), procurar(e, quando), procurar(e, quando), procurar(e, quando)]);
    expect(voltas.reduce((s, n) => s + n, 0)).toBe(1);
    expect([google.de('contas').length, google.de('lojas').length]).toEqual([1, 1]);
    expect(lojasDescobertas(await conexao(e))).toEqual([LOJA_DO_PERFIL]);
  });

  it('as lojas por ligar: o aviso aparece com a função ligada, some com ela desligada e some quando a loja é ligada', async () => {
    const e = await empresa('Mister Burgers Por Ligar');
    expect(lojasDescobertas(await conexao(e))).toEqual([LOJA_DO_PERFIL]);
    expect(await avisosDoPerfil(e)).toEqual([
      {
        kind: 'perfil_lojas_por_ligar',
        severity: 'atencao',
        title: 'O perfil da empresa no Google está pronto para ligar',
        detail: 'A autorização do Google alcança 1 loja do perfil que ainda não está ligada.',
        action: 'Escolha a loja em Contas conectadas para o Liame ler as avaliações.',
        connected_account_id: null,
        campaign_id: null,
        provider: 'google',
        brand_id: e.brandId,
      },
    ]);
    // Pedindo só os avisos da marca, o mesmo aviso.
    const daMarca = await api.call('GET', `/v1/media/attention?brand_id=${e.brandId}`, { cookie: e.cookie });
    expect((daMarca.body.items as Aviso[]).map((a) => a.kind)).toContain('perfil_lojas_por_ligar');

    await ligarFlagDaEmpresa(api, 'perfil_google', e.tenantId, false);
    expect(await avisosDoPerfil(e)).toEqual([]);
    await ligarFlagDaEmpresa(api, 'perfil_google', e.tenantId, true);
    expect((await avisosDoPerfil(e)).map((a) => a.kind)).toEqual(['perfil_lojas_por_ligar']);

    await ligarLojaDoPerfil(api, e);
    expect(await avisosDoPerfil(e)).toEqual([]);
  });

  it('a avaliação de 1 ou 2 estrelas sem resposta vira aviso: só as dos últimos 30 dias, sem o texto e sem quem avaliou; respondida, sai', async () => {
    const e = await empresa('Mister Burgers Nota Baixa');
    const contaId = await ligarLojaDoPerfil(api, e);
    google.lista = [
      avaliacao('uma-estrela', 'ONE', 2),
      avaliacao('duas-estrelas', 'TWO', 5),
      avaliacao('respondida', 'ONE', 3, { reviewReply: { comment: 'Sentimos muito.', reviewReplyState: 'APPROVED' } }),
      avaliacao('tres-estrelas', 'THREE', 1),
      // Feita há mais de 30 dias (mudou ontem, por isso foi lida): já não vira aviso.
      avaliacao('antiga', 'ONE', 40),
    ];
    expect((await loop.executarLote(10, { tenantIds: [e.tenantId] }, AGORA)).map((r) => r.status)).toEqual(['ok', 'ok']);

    const [aviso, ...outros] = await avisosDoPerfil(e);
    expect(outros).toEqual([]);
    expect(aviso).toEqual({
      kind: 'avaliacao_sem_resposta',
      severity: 'atencao',
      title: '2 avaliações de 1 ou 2 estrelas sem resposta',
      detail: `Em Mister Burgers — Centro, no Google. A mais recente é de ${diaDaLoja(ha(2))}.`,
      action: 'Responda no perfil da empresa no Google.',
      connected_account_id: contaId,
      campaign_id: null,
      provider: null,
      brand_id: e.brandId,
    });
    // Nada do que a pessoa escreveu, nem de quem ela é, chega à Atenção.
    const tudo = JSON.stringify((await api.call('GET', '/v1/media/attention', { cookie: e.cookie })).body);
    expect(tudo).not.toContain('Texto que a Atenção não pode mostrar');
    expect(tudo).not.toContain('Pessoa Número');
    expect(tudo).not.toContain('google_business');
    expect(tudo).not.toContain('locations/');

    // Com a função desligada, nem o que já foi lido vira aviso.
    await ligarFlagDaEmpresa(api, 'perfil_google', e.tenantId, false);
    expect(await avisosDoPerfil(e)).toEqual([]);
    await ligarFlagDaEmpresa(api, 'perfil_google', e.tenantId, true);

    // A de 2 estrelas ganhou resposta no Google. A resposta tem a data dela, e a data da AVALIAÇÃO não muda (a
    // referência do Google não diz que mudaria): a leitura de hora em hora não a vê, e o aviso segue igual.
    const mudou = new Date(AGORA.getTime() + 10 * MIN_MS).toISOString();
    google.lista = google.lista.map((a) => (a.reviewId === 'duas-estrelas' ? { ...a, reviewReply: { comment: 'Obrigado por avisar.', updateTime: mudou, reviewReplyState: 'PENDING' } } : a));
    const depois = new Date(AGORA.getTime() + 61 * MIN_MS);
    expect((await loop.executarLote(10, { tenantIds: [e.tenantId] }, depois)).map((r) => r.status)).toEqual(['ok']);
    expect((await avisosDoPerfil(e)).map((a) => a.title)).toEqual(['2 avaliações de 1 ou 2 estrelas sem resposta']);

    // No dia seguinte, a reconferência dos últimos 45 dias traz a resposta: sobra uma, e o aviso diz a nota dela.
    const d1 = new Date(AGORA.getTime() + (24 * 60 + 1) * MIN_MS);
    expect((await loop.executarLote(10, { tenantIds: [e.tenantId] }, d1)).map((r) => r.status)).toEqual(['ok', 'ok']);
    const [sobrou] = await avisosDoPerfil(e);
    expect([sobrou!.title, sobrou!.detail]).toEqual(['Avaliação de 1 estrela sem resposta', `Em Mister Burgers — Centro, no Google, feita em ${diaDaLoja(ha(2))}.`]);

    // A última também foi respondida no Google: na reconferência seguinte, o aviso sai.
    const mudou2 = new Date(d1.getTime() + 10 * MIN_MS).toISOString();
    google.lista = google.lista.map((a) => (a.reviewId === 'uma-estrela' ? { ...a, reviewReply: { comment: 'Vamos rever a entrega.', updateTime: mudou2, reviewReplyState: 'APPROVED' } } : a));
    const d2 = new Date(d1.getTime() + (24 * 60 + 1) * MIN_MS);
    expect((await loop.executarLote(10, { tenantIds: [e.tenantId] }, d2)).map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(await avisosDoPerfil(e)).toEqual([]);
  });

  it('Z2: a resposta que o Google recusou vira aviso, sem o texto dela nem o código do motivo; a que ele recusa depois chega pela conferência; fora dos 30 dias, sai', async () => {
    const e = await empresa('Mister Burgers Resposta Recusada');
    const contaId = await ligarLojaDoPerfil(api, e);
    const resposta = (situacao: string, haDias: number, extra: Record<string, string> = {}) => ({ comment: 'Resposta que a Atenção não pode mostrar.', updateTime: ha(haDias), reviewReplyState: situacao, ...extra });
    google.lista = [
      avaliacao('recusada', 'FOUR', 3, { reviewReply: resposta('REJECTED', 1, { policyViolation: 'CODIGO_DE_EXEMPLO' }) }),
      avaliacao('em-conferencia', 'FIVE', 4, { reviewReply: resposta('PENDING', 1) }),
      avaliacao('no-ar', 'FIVE', 5, { reviewReply: resposta('APPROVED', 2) }),
    ];
    expect((await loop.executarLote(10, { tenantIds: [e.tenantId] }, AGORA)).map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(await avisosDoPerfil(e)).toEqual([
      {
        kind: 'resposta_recusada',
        severity: 'atencao',
        title: 'O Google recusou a resposta a uma avaliação',
        detail: 'Em Mister Burgers — Centro. A resposta não aparece no perfil.',
        action: 'Veja em Avaliações qual é, e escreva outra resposta.',
        connected_account_id: contaId,
        campaign_id: null,
        provider: null,
        brand_id: e.brandId,
      },
    ]);
    const tudo = JSON.stringify((await api.call('GET', '/v1/media/attention', { cookie: e.cookie })).body);
    for (const proibido of ['Resposta que a Atenção não pode mostrar', 'CODIGO_DE_EXEMPLO', 'Texto que a Atenção não pode mostrar', 'Pessoa Número']) expect(tudo, proibido).not.toContain(proibido);

    // O Google recusa também a que conferia, sem mexer na data da avaliação: a leitura de hora em hora a relê pela
    // conferência das respostas, e o aviso passa a contar duas.
    google.lista = google.lista.map((a) => (a.reviewId === 'em-conferencia' ? { ...a, reviewReply: resposta('REJECTED', 1) } : a));
    expect((await loop.executarLote(10, { tenantIds: [e.tenantId] }, new Date(AGORA.getTime() + 61 * MIN_MS))).map((r) => [r.status, r.respostas])).toEqual([['ok', 1]]);
    const duas = await avisosDoPerfil(e);
    expect(duas.map((a) => [a.kind, a.title, a.detail, a.action])).toEqual([
      ['resposta_recusada', 'O Google recusou 2 respostas a avaliações', 'Em Mister Burgers — Centro. Essas respostas não aparecem no perfil.', 'Veja em Avaliações quais são, e escreva outras respostas.'],
    ]);

    // Com a função desligada, nada vira aviso.
    await ligarFlagDaEmpresa(api, 'perfil_google', e.tenantId, false);
    expect(await avisosDoPerfil(e)).toEqual([]);
    await ligarFlagDaEmpresa(api, 'perfil_google', e.tenantId, true);

    // Uma ganha outra resposta (o Google confere a nova) e a outra foi recusada há mais de 30 dias: na reconferência
    // do dia seguinte, o aviso sai.
    google.lista = google.lista.map((a) => (a.reviewId === 'recusada' ? { ...a, reviewReply: resposta('PENDING', 0) } : a.reviewId === 'em-conferencia' ? { ...a, reviewReply: resposta('REJECTED', 31) } : a));
    const d1 = new Date(AGORA.getTime() + (24 * 60 + 1) * MIN_MS);
    expect((await loop.executarLote(10, { tenantIds: [e.tenantId] }, d1)).map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(await avisosDoPerfil(e)).toEqual([]);
  });

  it('a loja que parou de ser lida vira aviso com o nome dela, e as avaliações dela deixam de avisar', async () => {
    const e = await empresa('Mister Burgers Loja Parou');
    const contaId = await ligarLojaDoPerfil(api, e);
    google.lista = [avaliacao('uma-estrela', 'ONE', 2)];
    expect((await loop.executarLote(10, { tenantIds: [e.tenantId] }, AGORA)).map((r) => r.status)).toEqual(['ok', 'ok']);
    expect((await avisosDoPerfil(e)).map((a) => a.kind)).toEqual(['avaliacao_sem_resposta']);

    // O Google recusa a leitura das avaliações: a loja fica sem permissão, e o aviso diz o que fazer.
    google.avaliacoes = 'recusa';
    await loop.executarLote(10, { tenantIds: [e.tenantId] }, new Date(AGORA.getTime() + 61 * MIN_MS));
    const semPermissao = await avisosDoPerfil(e);
    expect(semPermissao.map((a) => a.kind)).toEqual(['avaliacao_sem_resposta', 'conta_sem_permissao']);
    expect(semPermissao[1]).toMatchObject({
      severity: 'atencao',
      title: 'Sem permissão para ler Mister Burgers — Centro',
      action: 'Autorize o Google de novo em Contas conectadas, com a conta que cuida do perfil.',
      connected_account_id: contaId,
      provider: null,
      brand_id: e.brandId,
    });
    expect(semPermissao[1]!.detail).toContain('O Google recusou a leitura do perfil desta loja');

    // A autorização é revogada no Google: a loja é desconectada, o aviso é o mais grave, e o das avaliações sai.
    google.avaliacoes = 'ok';
    google.renovacaoRecusada = true;
    await loop.executarLote(10, { tenantIds: [e.tenantId] }, new Date(AGORA.getTime() + 3 * DIA_MS));
    const desconectada = await avisosDoPerfil(e);
    expect(desconectada).toEqual([
      {
        kind: 'conta_desconectada',
        severity: 'critica',
        title: 'Mister Burgers — Centro está desconectada',
        detail: 'O Google recusou a autorização desta loja: conecte de novo.',
        action: 'Conecte o Google de novo em Contas conectadas: as avaliações voltam a ser lidas.',
        connected_account_id: contaId,
        campaign_id: null,
        provider: null,
        brand_id: e.brandId,
      },
    ]);
  });
});
