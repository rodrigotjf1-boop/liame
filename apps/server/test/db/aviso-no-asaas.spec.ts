import { createDatabase, type Database } from '@liame/database';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { enderecoDoAviso, EVENTOS_DO_AVISO, NOME_DO_AVISO } from '../../src/cobranca/aviso-no-asaas.js';
import { MeioAsaas } from '../../src/cobranca/meio-asaas.js';
import { APP_CONFIG, type AppConfig } from '../../src/config.js';
import { PROVIDER_ASAAS } from '../../src/connectors/asaas/api-asaas.js';
import { chaveDe } from '../../src/connectors/cota.js';
import type { HubDms } from '../../src/connectors/dms/hub.js';
import type { ErroDoProduto } from '../../src/connectors/dms/integracao-dms.js';
import { ATENDIMENTO } from '../../src/suporte.js';
import { AvisoNoAsaasLoop, CONFERENCIA_DO_AVISO_MS, ESPERA_DEPOIS_DA_FALHA_MS } from '../../src/worker/aviso-no-asaas-loop.js';
import { AsaasDeMentira, MARCA_DO_AVISO_DE_TESTE } from '../helpers/asaas-de-mentira.js';
import { ownerQuery, startApi, type TestApi } from '../helpers/api.js';
import { APP_URL, hasDb } from './env.js';

// A7 · W2a, parte 3a: o aviso do Liame no Asaas (D-A7-28 e D-A7-33; `base-conhecimento.md` §18.5), contra um Asaas local.
// O próprio Liame cria o webhook dele pela API (ligado, com o envio em sequência, o token da configuração e os eventos que
// a releitura usa) e o confere uma vez por dia: a fila que parou volta a andar e chama a distribuição; o que mudaram no
// painel volta ao certo; o repetido sai; o aviso de outro sistema na mesma conta fica como está. Sem a chave ou sem o
// token, nada. O banco entra pela cota e pelo disjuntor do cliente HTTP do Asaas.

/** O token de antes, que a distribuição trocou, num nome neutro (V101, V123). */
const MARCA_DE_ANTES = 'a-marca-de-antes-que-a-distribuicao-trocou-0001';

describe.skipIf(!hasDb)('O aviso do Liame no Asaas: criado pela API e conferido todo dia (A7 · W2a, parte 3a)', () => {
  let asaas: AsaasDeMentira;
  let api: TestApi;
  let database: Database;
  let config: AppConfig;
  let url: string;
  const chamados: ErroDoProduto[] = [];
  const hub = { erro: (e: ErroDoProduto) => chamados.push(e) } as unknown as HubDms;
  const laco = (cfg: AppConfig = config) => new AvisoNoAsaasLoop(new MeioAsaas(database, cfg), cfg, hub);

  beforeAll(async () => {
    // O Asaas sobe antes da API: a configuração lê o endereço, a chave e o token do aviso dele do ambiente.
    asaas = new AsaasDeMentira();
    await asaas.subir();
    api = await startApi();
    database = createDatabase({ connectionString: APP_URL, max: 2, applicationName: 'liame-test' });
    config = api.app.get<AppConfig>(APP_CONFIG);
    url = enderecoDoAviso(config.apiUrl);
  }, 120_000);
  beforeEach(async () => {
    // As falhas de propósito de um caso não abrem o disjuntor nem gastam a cota dos seguintes.
    const chave = chaveDe(PROVIDER_ASAAS, 'liame');
    await ownerQuery(`delete from liame.circuit_state where circuit_key = $1`, [chave]);
    await ownerQuery(`delete from liame.quota_bucket where bucket_key = $1`, [chave]);
    asaas.avisosDaConta.splice(0);
    asaas.vistos.splice(0);
    asaas.listarAvisos = 'ok';
    chamados.splice(0);
  });
  afterAll(async () => {
    await api?.close();
    await database?.close();
    await asaas?.fechar();
  });

  const pedidos = (metodo: string) => asaas.vistos.filter((v) => v.metodo === metodo && v.caminho.startsWith('/webhooks'));

  it('a conta sem o aviso do Liame: ele nasce pela API, ligado, em sequência, com o token e os eventos da releitura; no dia seguinte, em dia', async () => {
    const l = laco();
    const r = await l.conferir();
    expect(r).toMatchObject({ situacao: 'criado', removidos: 0 });
    expect(asaas.avisosDaConta).toHaveLength(1);
    const [aviso] = asaas.avisosDaConta;
    expect(aviso).toMatchObject({
      name: NOME_DO_AVISO,
      url,
      email: ATENDIMENTO.email,
      enabled: true,
      interrupted: false,
      apiVersion: 3,
      sendType: 'SEQUENTIALLY',
      segredo: MARCA_DO_AVISO_DE_TESTE,
    });
    expect(new Set(aviso!.events)).toEqual(new Set(EVENTOS_DO_AVISO));
    expect(url.endsWith('/v1/billing/asaas/webhook')).toBe(true);
    // Uma leitura da lista e uma criação; a lista nunca devolve o token, só se ele existe.
    expect(pedidos('GET')).toHaveLength(1);
    expect(pedidos('POST')).toHaveLength(1);

    expect(await l.conferir()).toEqual({ situacao: 'em_dia', id: aviso!.id, removidos: 0 });
    expect(pedidos('POST')).toHaveLength(1);
    expect(pedidos('PUT')).toHaveLength(0);
    expect(chamados).toEqual([]);
  });

  it('a subida do worker leva o token da configuração ao aviso que já estava em dia (a distribuição pode ter trocado a variável); depois, não', async () => {
    const existente = asaas.porAviso({ url, events: [...EVENTOS_DO_AVISO], segredo: MARCA_DE_ANTES });
    const l = laco();
    expect(await l.conferir()).toEqual({ situacao: 'em_dia', id: existente.id, removidos: 0 });
    expect(pedidos('PUT').map((v) => v.corpo)).toEqual([{ authToken: MARCA_DO_AVISO_DE_TESTE }]);
    expect(existente.segredo).toBe(MARCA_DO_AVISO_DE_TESTE);
    expect(await l.conferir()).toMatchObject({ situacao: 'em_dia' });
    expect(pedidos('PUT')).toHaveLength(1);
    expect(chamados).toEqual([]);
  });

  it('a fila que parou (15 falhas seguidas) volta a andar, com o token da configuração, e chama a distribuição uma vez', async () => {
    const l = laco();
    await l.conferir();
    const aviso = asaas.avisosDaConta[0]!;
    asaas.pararFila(aviso.id);
    asaas.avisosDaConta[0]!.segredo = MARCA_DE_ANTES;

    const r = await l.conferir();
    expect(r).toEqual({ situacao: 'corrigido', id: aviso.id, motivos: ['fila_parada'], removidos: 0 });
    expect(asaas.avisosDaConta[0]).toMatchObject({ interrupted: false, segredo: MARCA_DO_AVISO_DE_TESTE });
    // O `PUT` leva só o que muda e o token; o e-mail e a versão da API não entram (o Asaas de mentira recusaria).
    const [put] = pedidos('PUT');
    expect(put!.corpo).toEqual({ interrupted: false, authToken: MARCA_DO_AVISO_DE_TESTE });
    expect(chamados).toHaveLength(1);
    expect(chamados[0]).toMatchObject({ origem: 'rotina', tipo: 'FilaDoAvisoParada', lugar: 'laço aviso-no-asaas' });
    expect(chamados[0]!.mensagem).toContain(url);

    // Com a fila andando, a conferência seguinte não chama ninguém.
    expect(await l.conferir()).toMatchObject({ situacao: 'em_dia' });
    expect(chamados).toHaveLength(1);
  });

  it('o que mudaram no painel volta ao certo: desligado, outro endereço (reconhecido pelo nome), o envio em paralelo, outros eventos e sem token', async () => {
    const mexido = asaas.porAviso({
      url: 'https://api-antiga.agencialiame.com/v1/billing/asaas/webhook',
      enabled: false,
      sendType: 'NON_SEQUENTIALLY',
      events: ['PAYMENT_RECEIVED', 'PAYMENT_CREATED'],
      segredo: null,
    });

    const r = await laco().conferir();
    expect(r).toMatchObject({ situacao: 'corrigido', id: mexido.id });
    if (r.situacao !== 'corrigido') throw new Error('esperava corrigido');
    expect(new Set(r.motivos)).toEqual(new Set(['desligado', 'sem_token', 'endereco', 'envio', 'eventos']));
    expect(asaas.avisosDaConta).toHaveLength(1);
    expect(asaas.avisosDaConta[0]).toMatchObject({ url, enabled: true, sendType: 'SEQUENTIALLY', segredo: MARCA_DO_AVISO_DE_TESTE });
    expect(new Set(asaas.avisosDaConta[0]!.events)).toEqual(new Set(EVENTOS_DO_AVISO));
    // Corrigir não é a fila parada: sem chamado à distribuição.
    expect(chamados).toEqual([]);
  });

  it('o aviso no endereço do Liame com outro nome (dado no painel) é reconhecido pelo endereço e volta ao nome do Liame', async () => {
    const renomeado = asaas.porAviso({ name: 'Webhook de pagamentos', url, events: [...EVENTOS_DO_AVISO] });
    expect(await laco().conferir()).toEqual({ situacao: 'corrigido', id: renomeado.id, motivos: ['nome'], removidos: 0 });
    expect(pedidos('PUT')[0]!.corpo).toEqual({ name: NOME_DO_AVISO, authToken: MARCA_DO_AVISO_DE_TESTE });
    expect(asaas.avisosDaConta).toHaveLength(1);
  });

  it('o aviso repetido (dois workers criando juntos) sai, e fica o do endereço certo, ligado; o de outro sistema na conta fica como está', async () => {
    const certo = asaas.porAviso({ url, events: [...EVENTOS_DO_AVISO] });
    const repetido = asaas.porAviso({ url, events: [...EVENTOS_DO_AVISO], interrupted: true });
    const antigo = asaas.porAviso({ url: 'https://api-antiga.agencialiame.com/v1/billing/asaas/webhook', events: [...EVENTOS_DO_AVISO] });
    const outro = asaas.porAviso({ name: 'ERP da contabilidade', url: 'https://erp.exemplo.com/asaas', events: ['PAYMENT_RECEIVED'], enabled: false });

    const r = await laco().conferir();
    expect(r).toEqual({ situacao: 'em_dia', id: certo.id, removidos: 2 });
    expect(asaas.avisosDaConta.map((a) => a.id).sort()).toEqual([certo.id, outro.id].sort());
    expect(pedidos('DELETE').map((v) => v.caminho).sort()).toEqual([`/webhooks/${repetido.id}`, `/webhooks/${antigo.id}`].sort());
    expect(asaas.avisosDaConta.find((a) => a.id === outro.id)).toMatchObject({ enabled: false, events: ['PAYMENT_RECEIVED'] });
  });

  it('sem a chave ou sem o token do aviso na configuração, nada: nenhum pedido ao Asaas', async () => {
    expect(await laco({ ...config, asaas: null }).conferir()).toEqual({ situacao: 'sem_asaas' });
    expect(await laco({ ...config, asaas: { ...config.asaas!, webhookToken: null } }).conferir()).toEqual({ situacao: 'sem_asaas' });
    expect(asaas.vistos).toEqual([]);
  });

  it('o Asaas fora do ar ou a chave recusada: falha com o tipo, e a próxima vez é em uma hora; com sucesso, no dia seguinte', async () => {
    const l = laco();
    const agora = new Date('2026-10-25T12:00:00Z');
    const depois = (ms: number) => new Date(agora.getTime() + ms);

    asaas.listarAvisos = 'fora';
    expect(await l.executar(agora)).toEqual({ situacao: 'falhou', falha: 'transitorio' });
    expect(await l.executar(depois(ESPERA_DEPOIS_DA_FALHA_MS - 60_000))).toBeNull();
    asaas.listarAvisos = 'chave-recusada';
    expect(await l.executar(depois(ESPERA_DEPOIS_DA_FALHA_MS))).toEqual({ situacao: 'falhou', falha: 'autenticacao' });
    expect(asaas.avisosDaConta).toEqual([]);

    asaas.listarAvisos = 'ok';
    const ok = depois(2 * ESPERA_DEPOIS_DA_FALHA_MS);
    expect(await l.executar(ok)).toMatchObject({ situacao: 'criado' });
    expect(await l.executar(new Date(ok.getTime() + CONFERENCIA_DO_AVISO_MS - 60_000))).toBeNull();
    expect(await l.executar(new Date(ok.getTime() + CONFERENCIA_DO_AVISO_MS))).toMatchObject({ situacao: 'em_dia' });
  });
});
