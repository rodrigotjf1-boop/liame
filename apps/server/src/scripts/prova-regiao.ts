import 'reflect-metadata';
import { parseArgs } from 'node:util';
import { type Database, withTenant } from '@liame/database';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { lerCampanhaGoogle } from '../actions/campanha-google-no-google.js';
import { writeAudit } from '../audit/audit.js';
import { raioDoBairro } from '../campanhas/bairros-da-campanha.js';
import { operacoesDaCriacao, recursoDaCampanhaGoogle } from '../campanhas/campanha-google-plano.js';
import { imagensDoGoogle } from '../campanhas/imagens-do-google.js';
import { type BairroDaProva, type ContextoDaProva, comTrava, ProvaInterrompida, provaDaRegiao, type ResultadoDoPasso } from '../campanhas/prova-da-regiao.js';
import { APP_CONFIG, type AppConfig, loadConfig } from '../config.js';
import { contaConectada } from '../connections/conectada.js';
import { acessoGoogle } from '../connections/oauth.js';
import { ClienteConector, type PedidoConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { criarConectorPerfilGoogle } from '../connectors/google-business/conector-perfil-google.js';
import { ConectorMeta } from '../connectors/meta/conector-meta.js';
import { versaoRegistrada } from '../connectors/tipos.js';
import { DATABASE, DatabaseModule } from '../database/database.module.js';
import { ARMAZEM_DE_IMAGENS, type ArmazemDeImagens } from '../imagens/armazem.js';
import { ArmazemModule } from '../imagens/armazem.module.js';
import { chaveDaLogoDaMarca } from '../marca/logo-da-marca.service.js';
import { VaultModule } from '../vault/vault.module.js';
import { VaultService } from '../vault/vault.service.js';

// A prova na conta real da D-RG-89 (plano da região, R9 e o teste de região), antes do código: o que o Google aceita de
// temas e de bairros com "só quem está" (na campanha no ar e na criação inteira do jeito do desenho), o lugar dos
// bairros, a categoria do perfil em português e a Meta com um bairro de fora do público. NADA é criado nem mudado: toda
// escrita vai só validando, e a trava fica na saída única — o cliente HTTP desta execução inteira (as leituras dos
// conectores também) passa por `comTrava` (`campanhas/prova-da-regiao.ts`). Só com a ordem do dono; quem pediu, o porquê
// e os passos que saíram ficam na auditoria da empresa, também quando a prova para no meio. Roda no contêiner da API (as
// mesmas variáveis: o banco, o cofre, o armazenamento das imagens e os apps do Google e da Meta):
//
//   node dist/scripts/prova-regiao.js --empresa <uuid> --por "Nome" --motivo "prova da D-RG-89, autorizada pelo dono em <data>"
//
// Saída 0: a prova rodou (cada passo com o resultado na tela). Saída 1: não rodou, ou parou no meio (o porquê na tela).

const USO = 'uso: prova-regiao --empresa <uuid da empresa no Liame> --por "<quem pediu>" --motivo "<por quê>"';

@Module({ imports: [DatabaseModule, VaultModule, ArmazemModule], providers: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }] })
class ProvaDaRegiaoModule {}

type Credencial = { tipo?: string; refresh_token?: string; access_token?: string };
const ler = (texto: string | null): Credencial | null => {
  if (!texto) return null;
  try {
    return JSON.parse(texto) as Credencial;
  } catch {
    return null;
  }
};

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { empresa: { type: 'string' }, por: { type: 'string' }, motivo: { type: 'string' } } });
  const empresa = z.uuid().safeParse(values.empresa);
  if (!empresa.success || !values.por?.trim() || !values.motivo?.trim()) throw new Error(USO);
  const tenantId = empresa.data;
  const por = values.por.trim().slice(0, 80);
  const motivo = values.motivo.trim().slice(0, 300);

  const app = await NestFactory.createApplicationContext(ProvaDaRegiaoModule, { logger: ['error', 'warn'] });
  try {
    const database = app.get<Database | null>(DATABASE);
    if (!database) throw new Error('DATABASE_URL não definida');
    const db = database.db;
    const config = app.get<AppConfig>(APP_CONFIG);
    const vault = app.get(VaultService);
    const armazem = app.get<ArmazemDeImagens>(ARMAZEM_DE_IMAGENS);
    // A saída única: todo pedido desta execução (o Perfil, a leitura da Meta e a prova) passa pela trava.
    const cliente = new ClienteConector(db, { enderecos: enderecosDasPlataformas(config.plataformas), tentativas: 1 });
    const requisitarCru = cliente.requisitar.bind(cliente);
    const comAtrava = comTrava((p) => requisitarCru(p));
    cliente.requisitar = ((p: PedidoConector) => comAtrava(p)) as ClienteConector['requisitar'];

    // O que a prova usa, lido sob a RLS da empresa: a campanha do Google no ar (e o estado aprovado dela), a loja, os
    // bairros, o perfil e a Meta.
    const lido = await withTenant(db, tenantId, async (tx) => {
      const g = (
        await tx.execute<{ id: string; ad_account_id: string; google_campaign_id: string; google_asset_group_id: string; unit_id: string; brand_id: string; cliente: string; login: string | null; segredo: string | null }>(sql`
          select c.id, c.ad_account_id, c.google_campaign_id, c.google_asset_group_id, c.unit_id, c.brand_id, a.external_id as cliente,
                 a.provider_attributes->>'login_customer_id' as login, a.credential_secret_id as segredo
            from liame.google_campaign_new c
            join liame.connected_account a on a.id = c.ad_account_id and a.tenant_id = c.tenant_id and a.provider = 'google_ads' and ${contaConectada('a')}
           where c.tenant_id = ${tenantId} and c.status = 'criada' and c.active and c.google_asset_group_id is not null
           order by c.updated_at desc limit 1`)
      ).rows[0];
      if (!g) return null;
      const aprovada = await lerCampanhaGoogle(tx, { tenantId, accountId: g.ad_account_id, resourceId: recursoDaCampanhaGoogle(g.id) });
      const loja = (
        await tx.execute<{ address_city: string | null; address_state: string | null; ibge_city_code: string | null }>(sql`
          select address_city, address_state, ibge_city_code from liame.unit where id = ${g.unit_id} and tenant_id = ${tenantId}`)
      ).rows[0];
      // Os 3 bairros com mais pedidos, com o centro no mapa (os mesmos dados do teste de região).
      const bairros = loja?.ibge_city_code
        ? (
            await tx.execute<{ name: string; latitude: string; longitude: string; area: string | null }>(sql`
              select d.name, p.latitude::text as latitude, p.longitude::text as longitude, d.area_km2::text as area
                from liame.region_district d
                join liame.region_district_point p on p.district_code = d.district_code and p.located = 'achado'
                left join (
                  select lower(district) as k, sum(orders) as pedidos from liame.region_order_district
                   where tenant_id = ${tenantId} and unit_id = ${g.unit_id} and kind = 'bairro' group by lower(district)
                ) o on o.k = lower(d.name)
               where d.city_code = ${loja.ibge_city_code}
               order by coalesce(o.pedidos, 0) desc, d.name limit 3`)
          ).rows
        : [];
      const perfil = (
        await tx.execute<{ external_id: string; segredo: string | null }>(sql`
          select a.external_id, a.credential_secret_id as segredo from liame.connected_account a
           where a.tenant_id = ${tenantId} and a.provider = 'google_business' and a.unit_id = ${g.unit_id} and ${contaConectada('a')} limit 1`)
      ).rows[0];
      const meta = (
        await tx.execute<{ id: string; external_id: string; segredo: string | null }>(sql`
          select a.id, a.external_id, a.credential_secret_id as segredo from liame.connected_account a
           where a.tenant_id = ${tenantId} and a.provider = 'meta_ads' and a.brand_id = ${g.brand_id} and ${contaConectada('a')}
           order by a.created_at limit 1`)
      ).rows[0];
      const doLiame = meta
        ? (
            await tx.execute<{ id: string }>(sql`
              select meta_campaign_id as id from liame.ad_campaign_new where tenant_id = ${tenantId} and ad_account_id = ${meta.id} and meta_campaign_id is not null`)
          ).rows.map((r) => r.id)
        : [];
      return {
        g,
        aprovada,
        loja,
        bairros,
        credGoogle: ler(g.segredo ? await vault.readSecret(tx, g.segredo) : null),
        perfil: perfil ? { loja: perfil.external_id, cred: ler(perfil.segredo ? await vault.readSecret(tx, perfil.segredo) : null) } : null,
        meta: meta ? { externalId: meta.external_id, cred: ler(meta.segredo ? await vault.readSecret(tx, meta.segredo) : null), doLiame } : null,
      };
    });
    if (!lido) throw new Error('Nenhuma campanha do Google criada e ativa nesta empresa: a prova precisa do grupo de recursos dela.');
    if (!lido.loja?.address_city || !lido.loja.address_state) throw new Error('A loja da campanha não tem a cidade e a UF no endereço.');
    if (lido.credGoogle?.tipo !== 'google' || !lido.credGoogle.refresh_token) throw new Error('A conta do Google Ads não tem a autorização guardada.');

    const tokenGoogle = await acessoGoogle(config, config.oauth.google?.tokenUrl ?? '', lido.credGoogle.refresh_token);
    const login = lido.g.login && /^\d+$/.test(lido.g.login) ? lido.g.login : null;
    const versaoGoogle = await versaoRegistrada(db, 'google_ads', 'campanha_criar');
    const bairros: BairroDaProva[] = lido.bairros.map((b) => ({ nome: b.name, latitude: Number(b.latitude), longitude: Number(b.longitude), raioKm: raioDoBairro(b.area === null ? null : Number(b.area)) }));

    // A criação inteira (passo 3b): a campanha aprovada com o nome "(prova)" (nome repetido é recusado e esconderia o resto).
    let criacao: ContextoDaProva['criacao'] = null;
    if (lido.aprovada) {
      const { linha, estado } = lido.aprovada;
      try {
        const foto = await armazem.ler(linha.foto_chave);
        const logo = await armazem.ler(chaveDaLogoDaMarca(tenantId, estado.marca, estado.loja_no_google.logo));
        criacao = { operacoes: operacoesDaCriacao({ ...estado, nome: `${estado.nome} (prova)` }, await imagensDoGoogle(foto, logo)) };
      } catch (err) {
        criacao = { erro: `a foto ou a logo da campanha não montou: ${err instanceof Error ? err.message.slice(0, 200) : 'erro'}` };
      }
    }

    let perfil: ContextoDaProva['perfil'] = null;
    if (lido.perfil?.cred?.tipo === 'google' && lido.perfil.cred.refresh_token) {
      const conector = await criarConectorPerfilGoogle(db, cliente, config.plataformas);
      const token = await acessoGoogle(config, config.oauth.google?.tokenUrl ?? '', lido.perfil.cred.refresh_token);
      const loja = lido.perfil.loja;
      perfil = { categoria: () => conector.lerCategoriaDaLoja({ accessToken: token }, { loja }), nome: (id) => conector.lerNomeDaCategoria({ accessToken: token }, id) };
    }

    let meta: ContextoDaProva['meta'] = null;
    if (lido.meta?.cred?.tipo === 'meta' && lido.meta.cred.access_token) {
      const versao = await versaoRegistrada(db, 'meta_ads', 'entity_update');
      const leitura = await versaoRegistrada(db, 'meta_ads', 'entities');
      const conta = lido.meta.externalId.startsWith('act_') ? lido.meta.externalId : `act_${lido.meta.externalId}`;
      const conjuntos = await new ConectorMeta(cliente, config.plataformas.metaGraphUrl, leitura, config.plataformas.metaAppSecret).lerPublicoDosConjuntosAtivos(
        { externalId: conta, credencial: { accessToken: lido.meta.cred.access_token } },
        5,
      );
      const doLiame = new Set(lido.meta.doLiame);
      const conjunto = conjuntos.conjuntos.find((c) => c.campaignId !== null && doLiame.has(c.campaignId)) ?? null;
      if (conjunto) meta = { base: config.plataformas.metaGraphUrl, versao, token: lido.meta.cred.access_token, appSecret: config.plataformas.metaAppSecret, conta, conjunto };
    }

    // Daqui em diante, o que sai para fora fica na auditoria sempre: com a prova inteira, ou com o que saiu até parar.
    let passos: ResultadoDoPasso[] = [];
    let parada: string | null = null;
    try {
      passos = await provaDaRegiao({
        http: (p) => cliente.requisitar(p),
        google: {
          base: config.plataformas.googleAdsUrl,
          versao: versaoGoogle,
          cliente: lido.g.cliente,
          chave: `escrita:${tenantId}`,
          cabecalhos: { authorization: `Bearer ${tokenGoogle}`, ...(login ? { 'login-customer-id': login } : {}) },
          campanha: lido.g.google_campaign_id,
          grupo: lido.g.google_asset_group_id,
        },
        criacao,
        perfil,
        meta,
        loja: { cidade: lido.loja.address_city, uf: lido.loja.address_state, bairros },
      });
    } catch (err) {
      if (err instanceof ProvaInterrompida) passos = err.passos;
      parada = err instanceof Error ? err.message.slice(0, 300) : 'erro desconhecido';
      throw err;
    } finally {
      for (const r of passos) console.log(`[${r.resultado.toUpperCase()}] ${r.passo}: ${r.detalhe}`);
      if (parada) console.log(`PAROU NO MEIO: ${parada}`);
      // A falha da auditoria aparece na tela e não esconde o erro de antes (que segue para a saída 1).
      try {
        await withTenant(db, tenantId, (tx) =>
          writeAudit(tx, {
            tenantId,
            actorType: 'system',
            actorId: null,
            actorLabel: `Distribuição DMS (${por})`,
            action: 'regiao.prova_na_conta_real',
            resourceType: 'google_campaign',
            resourceId: lido.g.google_campaign_id,
            after: { passos: passos.map((r) => ({ passo: r.passo, resultado: r.resultado })), so_validacao: true, ...(parada ? { parada } : {}) },
            reason: motivo,
            origin: 'console',
          }),
        );
      } catch (err) {
        console.error(`a auditoria não gravou: ${err instanceof Error ? err.message.slice(0, 200) : 'erro desconhecido'}`);
        process.exitCode = 1;
      }
    }
    console.log('FIM: nada foi criado nem mudado (só validação e leitura).');
  } finally {
    await app.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : 'a prova não rodou');
  process.exitCode = 1;
});
