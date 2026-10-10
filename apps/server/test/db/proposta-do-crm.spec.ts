import { resolve } from 'node:path';
import { createDatabase, type Database, runMigrations, type Tx, withContext } from '@liame/database';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  abrirProposta,
  adiarProposta,
  anotarModelo,
  barrarProposta,
  encerrarProposta,
  guardarEscrita,
  lerProposta,
  type PropostaNova,
  registrarRascunho,
  virarPedido,
} from '../../src/mensageria/proposta-do-crm.js';
import { enableMfa, ownerQuery, resetIpRateLimits, signupAndLogin, startApi, type TestApi } from '../helpers/api.js';
import { contaDoRegemcast, semearMensagemDoCrm } from '../helpers/mensagens-semeadas.js';
import { APP_URL, hasDb, OWNER_URL } from './env.js';

// A5 · Y6: a proposta de mensagem do funcionário de CRM e mensageria no banco (migration 0062). Cada passo do caminho
// é uma gravação condicional, na transação da empresa: só anda a partir da situação certa, uma proposta em andamento
// por marca e por motivo, o texto barrado não fica, e a empresa vizinha não lê nem anda a proposta de ninguém.

const OFERTA = 'Combo sexta: smash, batata e refri por R$ 34,90';
const MODELO = { id: '0199a400-0000-7000-8000-00000000a001', nome: 'sexta_em_dobro_v1', idioma: 'pt_BR', situacao: 'rascunho' };
const ESCRITA = { nome: 'Sexta em dobro', corpo: 'Oi, {{1}}! Nesta sexta o combo sai por R$ 34,90. Use o cupom {{2}} no cardápio.', usoDeIa: null };

describe.skipIf(!hasDb)('a proposta de mensagem do CRM e mensageria no banco (A5, Y6)', () => {
  let api: TestApi;
  let database: Database;

  type Empresa = { cookie: string; tenantId: string; userId: string; brandId: string; conta: string };

  async function empresa(): Promise<Empresa> {
    await resetIpRateLimits();
    const s = await signupAndLogin(api, undefined, 'Hamburgueria das Propostas');
    await enableMfa(api, s.cookie);
    const tenantId = s.me.active_organization_id as string;
    const brandId = (await api.call('GET', '/v1/brands', { cookie: s.cookie })).body.items[0].id as string;
    const conta = await contaDoRegemcast({ tenantId, brandId });
    return { cookie: s.cookie, tenantId, userId: s.me.user.id as string, brandId, conta };
  }

  /** Na transação da empresa, como a rotina dele vai rodar. */
  const naEmpresa = <T>(e: { tenantId: string; userId: string }, fn: (tx: Tx) => Promise<T>): Promise<T> => withContext(database.db, { tenantId: e.tenantId, userId: e.userId }, fn);

  const nova = (e: Empresa, over: Partial<PropostaNova> = {}): PropostaNova => ({
    tenantId: e.tenantId,
    brandId: e.brandId,
    conta: e.conta,
    funcionario: 'crm',
    emNomeDe: e.userId,
    motivo: 'promocao',
    comoPedir: 'cardapio',
    oferta: { texto: OFERTA, versaoDoDossie: 3 },
    publico: { origem: { origem: 'publico', id: 'ativos_30d' }, nome: 'Quem pediu nos últimos 30 dias', regra: 'Pediu pelo menos uma vez em 30 dias', pessoas: 412 },
    cupom: { loja: e.conta, codigo: 'SEXTA10', tipo: 'percentual', percentual: 10, pedido_minimo_centavos: 0, valido_de: '2026-10-09', valido_ate: '2026-10-12' },
    ...over,
  });

  beforeAll(async () => {
    await runMigrations({ connectionString: OWNER_URL, dir: resolve(process.cwd(), '../../packages/database/migrations') });
    api = await startApi();
    await resetIpRateLimits();
    database = createDatabase({ connectionString: APP_URL, max: 3, applicationName: 'liame-test' });
  }, 120_000);
  afterAll(async () => {
    await database?.close();
    await api?.close();
  });

  it('o caminho inteiro: abrir, guardar o texto conferido, o rascunho do modelo, a Meta e o pedido de envio', async () => {
    const e = await empresa();
    const id = (await naEmpresa(e, (tx) => abrirProposta(tx, nova(e))))!;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const alvo = { tenantId: e.tenantId, id };

    // Aberta: o que ele recebeu para escrever está guardado, e mais nada.
    expect(await naEmpresa(e, (tx) => lerProposta(tx, alvo))).toMatchObject({
      status: 'preparando',
      motive: 'promocao',
      destination: 'cardapio',
      offer: OFERTA,
      dossier_version: 3,
      audience: { origem: 'publico', id: 'ativos_30d' },
      audience_name: 'Quem pediu nos últimos 30 dias',
      people: 412,
      coupon: { codigo: 'SEXTA10', tipo: 'percentual', percentual: 10 },
      name: null,
      body: null,
      template_id: null,
      message_request_id: null,
      attempts: 0,
      agent_key: 'crm',
      requested_by: e.userId,
    });

    // Sem o texto conferido não há rascunho; com ele, o rascunho do modelo fica registrado.
    expect(await naEmpresa(e, (tx) => registrarRascunho(tx, alvo, MODELO))).toBe(false);
    expect(await naEmpresa(e, (tx) => guardarEscrita(tx, alvo, ESCRITA))).toBe(true);
    // O RegemCast não respondeu: a tentativa conta, e a proposta segue no preparo, com o texto guardado.
    expect(await naEmpresa(e, (tx) => adiarProposta(tx, alvo, new Date(Date.now() + 10 * 60_000)))).toBe(true);
    expect(await naEmpresa(e, (tx) => lerProposta(tx, alvo))).toMatchObject({ status: 'preparando', attempts: 1, name: ESCRITA.nome, body: ESCRITA.corpo });
    expect(await naEmpresa(e, (tx) => registrarRascunho(tx, alvo, MODELO))).toBe(true);
    expect(await naEmpresa(e, (tx) => lerProposta(tx, alvo))).toMatchObject({ status: 'rascunho', template_id: MODELO.id, template_name: MODELO.nome, template_language: 'pt_BR', template_status: 'rascunho' });
    // A fila do preparo solta a proposta, e a espera pela Meta conta da hora em que o rascunho nasceu.
    const fila = await ownerQuery(`select next_attempt_at, template_checked_at is not null as olhou, drafted_at is not null as nasceu, finished_at from liame.message_proposal where id = $1`, [id]);
    expect(fila[0]).toMatchObject({ next_attempt_at: null, olhou: true, nasceu: true, finished_at: null });

    // No rascunho, os passos do preparo não valem mais.
    expect(await naEmpresa(e, (tx) => guardarEscrita(tx, alvo, { ...ESCRITA, corpo: 'Outro texto' }))).toBe(false);
    expect(await naEmpresa(e, (tx) => barrarProposta(tx, alvo, ['oferta']))).toBe(false);
    expect(await naEmpresa(e, (tx) => adiarProposta(tx, alvo, new Date()))).toBe(false);

    // A rotina olha o modelo: uma pessoa enviou para a Meta, que ainda analisa.
    expect(await naEmpresa(e, (tx) => anotarModelo(tx, alvo, 'em_analise'))).toBe(true);
    expect((await naEmpresa(e, (tx) => lerProposta(tx, alvo)))?.template_status).toBe('em_analise');

    // Aprovado: o pedido de envio é montado e a proposta acaba.
    const acao = await semearMensagemDoCrm({ tenantId: e.tenantId, brandId: e.brandId, userId: e.userId, conta: e.conta }, { situacao: 'aguardando', nome: ESCRITA.nome });
    const pedido = (await ownerQuery<{ id: string }>(`select id from liame.message_request where action_request_id = $1`, [acao]))[0]!.id;
    expect(await naEmpresa(e, (tx) => virarPedido(tx, alvo, pedido))).toBe(true);
    expect(await naEmpresa(e, (tx) => lerProposta(tx, alvo))).toMatchObject({ status: 'pedido', message_request_id: pedido, body: ESCRITA.corpo });
    expect((await ownerQuery<{ acabou: boolean }>(`select finished_at is not null as acabou from liame.message_proposal where id = $1`, [id]))[0]?.acabou).toBe(true);

    // Acabou: nenhum passo anda mais.
    expect(await naEmpresa(e, (tx) => virarPedido(tx, alvo, pedido))).toBe(false);
    expect(await naEmpresa(e, (tx) => anotarModelo(tx, alvo, 'aprovado'))).toBe(false);
    expect(await naEmpresa(e, (tx) => encerrarProposta(tx, alvo, 'descartada', 'prazo'))).toBe(false);
    expect((await naEmpresa(e, (tx) => lerProposta(tx, alvo)))?.status).toBe('pedido');
  });

  it('uma proposta em andamento por marca e por motivo; a que acabou libera a vez', async () => {
    const e = await empresa();
    const primeira = (await naEmpresa(e, (tx) => abrirProposta(tx, nova(e))))!;
    // A mesma marca, o mesmo motivo: a segunda não abre (e não derruba a transação de quem tentou).
    const duas = await naEmpresa(e, async (tx) => {
      const segunda = await abrirProposta(tx, nova(e));
      const continua = await lerProposta(tx, { tenantId: e.tenantId, id: primeira });
      return { segunda, continua: continua?.status };
    });
    expect(duas).toEqual({ segunda: null, continua: 'preparando' });
    // Outro motivo é outra vez: o "volte a pedir" não precisa de oferta.
    const volta = await naEmpresa(e, (tx) => abrirProposta(tx, nova(e, { motivo: 'volte_a_pedir', oferta: null, comoPedir: 'whatsapp' })));
    expect(volta).not.toBeNull();
    expect(await naEmpresa(e, (tx) => lerProposta(tx, { tenantId: e.tenantId, id: volta! }))).toMatchObject({ motive: 'volte_a_pedir', destination: 'whatsapp', offer: null, dossier_version: null });

    // No rascunho ela ainda segura a vez; descartada, libera.
    const alvo = { tenantId: e.tenantId, id: primeira };
    await naEmpresa(e, (tx) => guardarEscrita(tx, alvo, ESCRITA));
    await naEmpresa(e, (tx) => registrarRascunho(tx, alvo, MODELO));
    expect(await naEmpresa(e, (tx) => abrirProposta(tx, nova(e)))).toBeNull();
    expect(await naEmpresa(e, (tx) => encerrarProposta(tx, alvo, 'descartada', 'modelo_recusado'))).toBe(true);
    expect(await naEmpresa(e, (tx) => lerProposta(tx, alvo))).toMatchObject({ status: 'descartada', reason: 'modelo_recusado' });
    expect(await naEmpresa(e, (tx) => abrirProposta(tx, nova(e)))).not.toBeNull();

    // Quatro tentativas juntas de abrir a mesma proposta: só uma abre.
    const outra = await empresa();
    const juntas = await Promise.all([1, 2, 3, 4].map(() => naEmpresa(outra, (tx) => abrirProposta(tx, nova(outra)))));
    expect(juntas.filter((id) => id !== null)).toHaveLength(1);
  });

  it('barrada: ficam os nomes do que barrou, e o texto não fica', async () => {
    const e = await empresa();
    const id = (await naEmpresa(e, (tx) => abrirProposta(tx, nova(e))))!;
    const alvo = { tenantId: e.tenantId, id };
    // Mesmo que o texto já estivesse guardado, a proposta barrada não o mantém.
    await naEmpresa(e, (tx) => guardarEscrita(tx, alvo, ESCRITA));
    expect(await naEmpresa(e, (tx) => barrarProposta(tx, alvo, ['oferta', 'regras_da_liame', 'oferta']))).toBe(true);
    expect(await naEmpresa(e, (tx) => lerProposta(tx, alvo))).toMatchObject({ status: 'barrada', barred_by: ['oferta', 'regras_da_liame'], name: null, body: null });
    // Barrada não vira rascunho nem é encerrada de novo.
    expect(await naEmpresa(e, (tx) => registrarRascunho(tx, alvo, MODELO))).toBe(false);
    expect(await naEmpresa(e, (tx) => encerrarProposta(tx, alvo, 'falhou', 'ia_fora_do_ar'))).toBe(false);

    // Quem barra diz o que barrou, em código: sem item, ou com texto livre, o passo nem chega ao banco.
    const outra = (await naEmpresa(e, (tx) => abrirProposta(tx, nova(e))))!;
    await expect(naEmpresa(e, (tx) => barrarProposta(tx, { tenantId: e.tenantId, id: outra }, []))).rejects.toThrow(/diz o que barrou/);
    await expect(naEmpresa(e, (tx) => barrarProposta(tx, { tenantId: e.tenantId, id: outra }, ['Prometeu 50% de desconto']))).rejects.toThrow(/formato de código/);
    await expect(naEmpresa(e, (tx) => encerrarProposta(tx, { tenantId: e.tenantId, id: outra }, 'falhou', 'O RegemCast caiu às 10h'))).rejects.toThrow(/formato de código/);
    expect((await naEmpresa(e, (tx) => lerProposta(tx, { tenantId: e.tenantId, id: outra })))?.status).toBe('preparando');
    // A falha depois das tentativas encerra com o código.
    expect(await naEmpresa(e, (tx) => encerrarProposta(tx, { tenantId: e.tenantId, id: outra }, 'falhou', 'ia_fora_do_ar'))).toBe(true);
    expect(await naEmpresa(e, (tx) => lerProposta(tx, { tenantId: e.tenantId, id: outra }))).toMatchObject({ status: 'falhou', reason: 'ia_fora_do_ar' });
  });

  it('a promoção sempre parte de uma oferta, no código e no banco; o banco recusa a situação sem o que ela exige', async () => {
    const e = await empresa();
    await expect(naEmpresa(e, (tx) => abrirProposta(tx, nova(e, { oferta: null })))).rejects.toThrow(/parte de uma oferta/);
    const inserir = (colunas: string, valores: string) =>
      ownerQuery(
        `insert into liame.message_proposal (id, tenant_id, brand_id, connected_account_id, destination, audience, audience_name, people, agent_key, ${colunas})
         values (gen_random_uuid(), $1, $2, $3, 'cardapio', '{"origem":"publico","id":"p"}'::jsonb, 'Público', 10, 'crm', ${valores})`,
        [e.tenantId, e.brandId, e.conta],
      );
    // A promoção sem oferta; o rascunho sem o texto e sem o modelo; a barrada sem dizer o que barrou; a que acabou sem a hora.
    await expect(inserir('motive', `'promocao'`)).rejects.toThrow(/message_proposal_oferta/);
    await expect(inserir('motive, status', `'volte_a_pedir', 'rascunho'`)).rejects.toThrow(/message_proposal_escrita/);
    await expect(inserir('motive, status, name, body', `'volte_a_pedir', 'rascunho', 'Volte', 'Oi, {{1}}!'`)).rejects.toThrow(/message_proposal_modelo/);
    await expect(inserir('motive, status, name, body, template_id, template_name', `'volte_a_pedir', 'rascunho', 'Volte', 'Oi, {{1}}!', '${MODELO.id}', 'volte_v1'`)).rejects.toThrow(/message_proposal_modelo/);
    await expect(inserir('motive, status, finished_at', `'volte_a_pedir', 'barrada', now()`)).rejects.toThrow(/message_proposal_barrada/);
    await expect(inserir('motive, status, barred_by, name, body, finished_at', `'volte_a_pedir', 'barrada', '{oferta}', 'Volte', 'Oi!', now()`)).rejects.toThrow(/message_proposal_sem_texto_barrado/);
    await expect(inserir('motive, status, reason', `'volte_a_pedir', 'descartada', 'prazo'`)).rejects.toThrow(/message_proposal_fim/);
    // E o que barrou é sempre código: um texto livre (que poderia ser o trecho barrado) o banco não guarda.
    await expect(inserir('motive, status, barred_by, finished_at', `'volte_a_pedir', 'barrada', '{"Prometeu 50% de desconto"}', now()`)).rejects.toThrow(/message_proposal_barred_by_check/);
    // Vinte códigos de quarenta letras cabem (o tamanho é conferido fora da expressão regular).
    const vinte = Array.from({ length: 20 }, (_, i) => `${'regra_muito_comprida_da_conferencia_abcd'.slice(0, 38)}${String.fromCharCode(97 + i)}x`);
    await inserir('motive, status, barred_by, finished_at', `'volte_a_pedir', 'barrada', '{${vinte.join(',')}}', now()`);
  });

  it('a empresa vizinha não lê nem anda a proposta; dentro da empresa, o id de outra não serve', async () => {
    const a = await empresa();
    const b = await empresa();
    const id = (await naEmpresa(a, (tx) => abrirProposta(tx, nova(a))))!;
    // B, na transação dela, com o id certo e até dizendo que é a empresa A: a RLS não mostra a linha.
    expect(await naEmpresa(b, (tx) => lerProposta(tx, { tenantId: a.tenantId, id }))).toBeNull();
    expect(await naEmpresa(b, (tx) => lerProposta(tx, { tenantId: b.tenantId, id }))).toBeNull();
    expect(await naEmpresa(b, (tx) => guardarEscrita(tx, { tenantId: a.tenantId, id }, ESCRITA))).toBe(false);
    expect(await naEmpresa(b, (tx) => encerrarProposta(tx, { tenantId: a.tenantId, id }, 'descartada', 'prazo'))).toBe(false);
    // B não abre proposta em nome da empresa A.
    await expect(naEmpresa(b, (tx) => abrirProposta(tx, nova(a)))).rejects.toThrow();
    // A segue com a proposta dela, intacta.
    expect(await naEmpresa(a, (tx) => lerProposta(tx, { tenantId: a.tenantId, id }))).toMatchObject({ status: 'preparando', name: null });
  });
});
