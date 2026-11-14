import type { CreateRegionTestRequest, RegionTestResponse } from '@liame/contracts';
import { uuidv7 } from '@liame/database';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ActionService } from '../actions/action.service.js';
import { problemaDaLeitura } from '../actions/leitura-na-plataforma.js';
import { contaConectada } from '../connections/conectada.js';
import { ErroConector } from '../connectors/cliente-http.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { nomeComparavel } from '../regiao/coordenada.js';
import { type BairroDaCampanha, raioDoBairro } from './bairros-da-campanha.js';
import { conflito, contasDaMarca, recusa } from './campanhas-novas.service.js';
import { conjuntosNaMeta } from './conjuntos-na-meta.js';
import { anunciaSoNoBairro, conjuntoAlcancaOBairro, DIAS_DO_TESTE_DE_REGIAO, distanciaKm, oQueImpedeOBairro, type PedidosDoBairro } from './teste-regiao-contas.js';
import { type EstadoDoTesteDeRegiao, FLAG_DO_TESTE_DE_REGIAO, impressaoDoPublico, nomeDoTesteDeRegiao, recursoDoTesteDeRegiao } from './teste-regiao-plano.js';

// O pedido do teste de região (plano da região, R8; protótipo dos testes aprovado pelo dono em 13/11/2026; D-RG-81 e
// D-RG-82). A rota confere o que a D-RG-82 pede antes de o pedido nascer (o bairro com pedidos e bairros para comparar,
// os pedidos por bairro do Regem, um teste por vez, nenhuma campanha de fora do Liame mostrando anúncio no bairro,
// nenhuma campanha do Liame que só anuncia nele, nenhuma do Google alcançando o bairro), guarda o teste com cada
// conjunto do Liame que o bairro vai deixar (o público de antes, para devolver igual) e pede `teste_de_regiao` em
// Aprovações. Aprovar não muda nada na Meta. Só com a função `teste_de_regiao` ligada para a empresa.

const VIVOS = sql`('pedido', 'criando', 'pronto', 'rodando')`;
const FUSO_PADRAO = 'America/Sao_Paulo';

type Linha = {
  id: string;
  brand_id: string;
  unit_id: string;
  name: string;
  status: RegionTestResponse['status'];
  plan: unknown;
  action_id: string | null;
  started_on: string | null;
  ended_on: string | null;
  error: string | null;
  reason: string | null;
  created_at: Date;
};

@Injectable()
export class TestesDeRegiaoService {
  constructor(
    private readonly actions: ActionService,
    private readonly flags: FlagService,
  ) {}

  private quem(auth: AuthContext): { tenantId: string; userId: string } {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa', 'Sem empresa na sessão', 'Escolha uma empresa antes de continuar.');
    return { tenantId: auth.tenantId, userId: auth.userId };
  }

  /** Pedir o teste: confere a D-RG-82, grava o teste e os conjuntos, e pede `teste_de_regiao` em Aprovações. */
  async criar(auth: AuthContext, body: CreateRegionTestRequest): Promise<RegionTestResponse> {
    const tx = currentTx();
    const quem = this.quem(auth);
    const marca = await tx.execute(sql`select 1 from liame.brand where id = ${body.brand_id} and tenant_id = ${quem.tenantId} and archived_at is null`);
    if (!marca.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
    if (!(await this.flags.isEnabled(FLAG_DO_TESTE_DE_REGIAO, this.flags.context({ tenantId: quem.tenantId, userId: quem.userId, brandId: body.brand_id })))) {
      throw conflito('funcao-desligada', 'Função desligada', 'O teste de região não está ligado para esta empresa.');
    }
    // Um teste por vez na marca (D-RG-81: nunca junto com um teste de criativo).
    const vivo = await tx.execute(sql`select 1 from liame.campaign_test where tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id} and status in ${VIVOS} limit 1`);
    if (vivo.rows[0]) throw conflito('outro-teste', 'Já há um teste nesta marca', 'Um teste por vez: já há um teste de criativo ou de região esperando ou rodando nesta marca. Encerre ou espere o fim dele.');

    // A conta de anúncios da Meta: uma só.
    const { anuncios } = await contasDaMarca(tx, quem.tenantId, body.brand_id);
    if (anuncios.length === 0) throw conflito('sem-conta-de-anuncios', 'Sem conta de anúncios', 'Conecte a conta de anúncios da Meta da marca em Contas conectadas.');
    if (anuncios.length > 1) throw conflito('varias-contas-de-anuncios', 'Mais de uma conta de anúncios', 'A marca tem mais de uma conta de anúncios da Meta: deixe uma só em Contas conectadas.');
    const conta = anuncios[0]!;

    // A loja e o bairro do município dela, com o centro no mapa.
    const loja = (
      await tx.execute<{ name: string; ibge_city_code: string | null; address_city: string | null; timezone: string | null }>(sql`
        select name, ibge_city_code, address_city, timezone from liame.unit where id = ${body.unit_id} and tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id}`)
    ).rows[0];
    if (!loja) throw recusa('loja-nao-encontrada', 'Loja não encontrada', 'A loja não é desta marca.', 'unit_id');
    if (!loja.ibge_city_code) throw recusa('loja-sem-municipio', 'Falta o município da loja', 'O endereço da loja ainda não tem o município: ajuste o endereço em Minha marca antes.', 'unit_id');
    const b = (
      await tx.execute<{ district_code: string; name: string; area: string | null; located: string | null; latitude: string | null; longitude: string | null; meta_location: string | null }>(sql`
        select d.district_code, d.name, d.area_km2::text as area, p.located, p.latitude::text as latitude, p.longitude::text as longitude, p.meta_location
          from liame.region_district d
          left join liame.region_district_point p on p.district_code = d.district_code
         where d.district_code = ${body.district_code} and d.city_code = ${loja.ibge_city_code}`)
    ).rows[0];
    if (!b) throw recusa('bairro-fora-do-municipio', 'Bairro de outro município', 'O bairro precisa ser do município da loja.', 'district_code');
    if (b.located !== 'achado' || b.latitude === null || b.longitude === null) {
      throw recusa('bairro-sem-centro', 'O bairro não está no mapa', 'O Liame não achou o centro deste bairro no mapa; sem ele, não dá para saber quais campanhas mostram anúncio lá.', 'district_code');
    }
    const bairro: BairroDaCampanha = { codigo: b.district_code, nome: b.name, meta: b.meta_location, latitude: Number(b.latitude), longitude: Number(b.longitude), raio_km: raioDoBairro(b.area === null ? null : Number(b.area)) };

    // Os pedidos de entrega por bairro nas 4 semanas completas até ontem (a leitura de Sua região, do Regem da loja).
    const linhas = (
      await tx.execute<{ district: string | null; city: string | null; orders: number; day_from: string; day_to: string }>(sql`
        select district, city, orders, day_from::text as day_from, day_to::text as day_to
          from liame.region_order_district where tenant_id = ${quem.tenantId} and brand_id = ${body.brand_id} and unit_id = ${body.unit_id} and kind = 'bairro'
         order by position`)
    ).rows;
    if (!linhas.length) {
      throw conflito('sem-pedidos-por-bairro', 'Os pedidos por bairro ainda não chegaram', 'O teste compara os pedidos de entrega de cada bairro, que vêm do Regem da loja. Eles ainda não chegaram: confira a ligação com o Regem em Contas conectadas, ou espere a leitura de amanhã.');
    }
    const doMunicipio = (c: string | null) => !c || !loja.address_city || nomeComparavel(c) === nomeComparavel(loja.address_city);
    const porNome = new Map<string, PedidosDoBairro>();
    for (const l of linhas) {
      if (!l.district || !doMunicipio(l.city)) continue;
      const k = nomeComparavel(l.district);
      porNome.set(k, { nome: porNome.get(k)?.nome ?? l.district, pedidos: (porNome.get(k)?.pedidos ?? 0) + l.orders });
    }
    const lista = [...porNome.values()].sort((x, y) => y.pedidos - x.pedidos);
    const alvo = porNome.get(nomeComparavel(bairro.nome))?.nome ?? bairro.nome;
    const impede = oQueImpedeOBairro(alvo, lista);
    if (impede) throw conflito('bairro-nao-testavel', `Não dá para testar ${bairro.nome}`, impede);

    // Os conjuntos ativos da conta, com o público: quais mostram anúncio no bairro, do Liame e de fora dele.
    let lido: Awaited<ReturnType<typeof conjuntosNaMeta.lerAtivos>>;
    try {
      lido = await conjuntosNaMeta.lerAtivos(tx, { externalId: conta.external_id, segredo: conta.credential_secret_id });
    } catch (err) {
      if (err instanceof ErroConector) throw problemaDaLeitura('meta_ads', err) ?? err;
      throw err;
    }
    if (!lido) throw conflito('meta-indisponivel', 'A Meta não está ligada', 'O Liame não conseguiu ler as campanhas na Meta agora. Tente de novo em alguns minutos.');
    if (!lido.completo) {
      throw conflito('conjuntos-demais', 'Conjuntos demais para conferir', 'A conta de anúncios tem mais de 1.000 conjuntos ativos: o Liame não consegue conferir se algum de fora mostra anúncio no bairro, e por isso o teste não é pedido.');
    }
    const doLiame = new Set(
      (
        await tx.execute<{ id: string }>(sql`
          select meta_campaign_id as id from liame.ad_campaign_new where tenant_id = ${quem.tenantId} and ad_account_id = ${conta.id} and meta_campaign_id is not null
          union
          select meta_campaign_id from liame.campaign_test where tenant_id = ${quem.tenantId} and ad_account_id = ${conta.id} and meta_campaign_id is not null`)
      ).rows.map((r) => r.id),
    );
    const alvos: typeof lido.conjuntos = [];
    for (const c of lido.conjuntos) {
      if (!conjuntoAlcancaOBairro(c.targeting, bairro).alcanca) continue;
      if (!c.campaignId || !doLiame.has(c.campaignId)) {
        throw conflito(
          'campanha-de-fora-no-bairro',
          `Não dá para testar ${bairro.nome} agora`,
          `O conjunto “${c.name.slice(0, 120)}” é de uma campanha criada fora do Liame e mostra anúncio no bairro. O Liame não muda campanha que não criou: com ela no ar, ${bairro.nome} não ficaria sem anúncio e o teste não mediria nada. Pause essa campanha na Meta durante o teste, ou escolha um bairro que ela não alcança.`,
        );
      }
      if (anunciaSoNoBairro(c.targeting, bairro)) {
        throw conflito('campanha-so-no-bairro', `Não dá para testar ${bairro.nome}`, `O conjunto “${c.name.slice(0, 120)}” anuncia só em ${bairro.nome}: tirar o bairro o deixaria sem lugar nenhum. Escolha outro bairro.`);
      }
      alvos.push(c);
    }
    if (!alvos.length) {
      throw conflito('nenhuma-campanha-no-bairro', 'Nenhuma campanha do Liame no bairro', `Nenhuma campanha ativa que o Liame criou mostra anúncio em ${bairro.nome}: não há o que tirar, e o teste não mediria nada.`);
    }
    if (alvos.length > 50) throw conflito('conjuntos-demais', 'Conjuntos demais no bairro', 'Mais de 50 conjuntos do Liame mostram anúncio no bairro: o teste fica para depois do piloto nesse tamanho.');

    // O Google não deixa tirar um bairro de um raio, e o Liame não lê os lugares das campanhas do Google: a campanha do
    // Google do Liame (com o raio conhecido) que alcança o bairro segura o teste, e QUALQUER outra campanha ativa do
    // Google da marca conta como "alcança" (o lado seguro, como o formato desconhecido na Meta), com o nome dela.
    const google = (
      await tx.execute<{ nome: string; raio: string | null; latitude: string | null; longitude: string | null }>(sql`
        select c.name as nome, g.radius_km::text as raio, u.latitude::text as latitude, u.longitude::text as longitude
          from liame.campaign c
          join liame.connected_account a on a.id = c.connected_account_id and a.tenant_id = c.tenant_id
          left join liame.google_campaign_new g on g.tenant_id = c.tenant_id and g.brand_id = a.brand_id and g.google_campaign_id = c.external_id and g.status = 'criada'
          left join liame.unit u on u.id = g.unit_id and u.tenant_id = g.tenant_id
         where c.tenant_id = ${quem.tenantId} and a.brand_id = ${body.brand_id} and a.provider = 'google_ads' and ${contaConectada('a')} and c.status = 'ativa'
        union all
        select g.name, g.radius_km::text, u.latitude::text, u.longitude::text
          from liame.google_campaign_new g
          join liame.unit u on u.id = g.unit_id and u.tenant_id = g.tenant_id
         where g.tenant_id = ${quem.tenantId} and g.brand_id = ${body.brand_id} and g.active and g.status = 'criada'
         order by 1`)
    ).rows;
    for (const g of google) {
      if (g.raio === null || g.latitude === null || g.longitude === null) {
        throw conflito(
          'google-no-bairro',
          `Não dá para testar ${bairro.nome} agora`,
          `A campanha do Google “${g.nome.slice(0, 120)}” está ativa e não foi criada pelo Liame com um raio: o Liame não lê os lugares dela, e ela pode mostrar anúncio em ${bairro.nome}. Pause essa campanha no Google durante o teste.`,
        );
      }
      if (distanciaKm({ latitude: Number(g.latitude), longitude: Number(g.longitude) }, bairro) <= Number(g.raio) + bairro.raio_km) {
        throw conflito(
          'google-no-bairro',
          `Não dá para testar ${bairro.nome} agora`,
          `A campanha do Google “${g.nome.slice(0, 120)}”, que o Liame criou, mostra anúncio em ${bairro.nome}, e o Google não deixa tirar um bairro de um raio. Pause essa campanha durante o teste, ou escolha um bairro fora do raio dela.`,
        );
      }
    }

    // Grava o teste, com cada conjunto que o bairro vai deixar e o público de antes, e pede em Aprovações.
    const id = uuidv7();
    const estado: Omit<EstadoDoTesteDeRegiao, 'situacao'> = {
      teste: id,
      marca: body.brand_id,
      loja: { id: body.unit_id, nome: loja.name },
      fuso: loja.timezone ?? FUSO_PADRAO,
      bairro,
      dias: DIAS_DO_TESTE_DE_REGIAO,
      semanas: { de: linhas[0]!.day_from, ate: linhas[0]!.day_to, bairros: lista.slice(0, 200) },
      conjuntos: alvos.map((c) => ({ campanha: c.campaignId!, conjunto: c.id, nome: c.name.slice(0, 400), impressao: impressaoDoPublico(c.targeting) })),
    };
    try {
      await tx.execute(sql`
        insert into liame.campaign_test (id, tenant_id, brand_id, unit_id, ad_account_id, kind, name, min_days, max_days, plan, created_by)
        values (${id}, ${quem.tenantId}, ${body.brand_id}, ${body.unit_id}, ${conta.id}, 'regiao', ${nomeDoTesteDeRegiao(bairro.nome)}, ${DIAS_DO_TESTE_DE_REGIAO}, ${DIAS_DO_TESTE_DE_REGIAO},
                ${JSON.stringify(estado)}::jsonb, ${quem.userId})`);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflito('outro-teste', 'Já há um teste nesta marca', 'Um teste por vez: outro pedido de teste entrou agora nesta marca.');
      throw err;
    }
    for (const c of alvos) {
      await tx.execute(sql`
        insert into liame.campaign_test_target (id, tenant_id, test_id, ad_account_id, meta_campaign_id, meta_adset_id, name, targeting_before, fingerprint_before)
        values (${uuidv7()}, ${quem.tenantId}, ${id}, ${conta.id}, ${c.campaignId}, ${c.id}, ${c.name.slice(0, 400)}, ${JSON.stringify(c.targeting ?? {})}::jsonb, ${impressaoDoPublico(c.targeting)})`);
    }
    const pedido = await this.actions.pedirPelaRota(auth, { tool: 'teste_de_regiao', brand_id: body.brand_id, provider: 'meta_ads', account_id: conta.id, resource_id: recursoDoTesteDeRegiao(id), params: {} });
    await tx.execute(sql`update liame.campaign_test set action_id = ${pedido}, updated_at = now() where id = ${id} and tenant_id = ${quem.tenantId}`);
    auditDetail({ resourceId: id, before: null, after: { bairro: bairro.codigo, conjuntos: alvos.length, action_id: pedido } });
    return this.obter(auth, id);
  }

  async obter(auth: AuthContext, id: string): Promise<RegionTestResponse> {
    const quem = this.quem(auth);
    const tx = currentTx();
    const t = (
      await tx.execute<Linha>(sql`
        select id, brand_id, unit_id, name, status, plan, action_id, started_on::text as started_on, ended_on::text as ended_on, error, reason, created_at
          from liame.campaign_test where id = ${id} and tenant_id = ${quem.tenantId} and kind = 'regiao'`)
    ).rows[0];
    if (!t) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Teste não encontrado nesta empresa.');
    const conjuntos = (
      await tx.execute<{ meta_campaign_id: string; meta_adset_id: string; name: string; status: RegionTestResponse['ad_sets'][number]['status'] }>(sql`
        select meta_campaign_id, meta_adset_id, name, status from liame.campaign_test_target where test_id = ${id} and tenant_id = ${quem.tenantId} order by name, meta_adset_id`)
    ).rows;
    const plano = t.plan as Omit<EstadoDoTesteDeRegiao, 'situacao'>;
    const alvo = nomeComparavel(plano.bairro.nome);
    return {
      id: t.id,
      brand_id: t.brand_id,
      unit_id: t.unit_id,
      name: t.name,
      status: t.status,
      district: { code: plano.bairro.codigo, name: plano.bairro.nome, meta: plano.bairro.meta !== null, radius_km: plano.bairro.raio_km },
      days: plano.dias,
      weeks: { from: plano.semanas.de, to: plano.semanas.ate, districts: plano.semanas.bairros.map((x) => ({ name: x.nome, orders: x.pedidos, target: nomeComparavel(x.nome) === alvo })) },
      ad_sets: conjuntos.map((c) => ({ campaign_id: c.meta_campaign_id, ad_set_id: c.meta_adset_id, name: c.name, status: c.status })),
      action_id: t.action_id,
      started_on: t.started_on,
      ended_on: t.ended_on,
      error: t.error,
      reason: t.reason,
      created_at: new Date(t.created_at).toISOString(),
    };
  }
}
