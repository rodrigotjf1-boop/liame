import {
  type AddressLookupRequest,
  type AddressLookupResponse,
  type CreateStoreRequest,
  type GoogleProfileAddressRequest,
  type GoogleProfileAddressResponse,
  type RegionOverviewResponse,
  type RegionRhythmResponse,
  type SaveStoreLocationRequest,
  type SaveStoreLocationResponse,
  type StoreAddress,
  type StoreCoordinates,
  type StoreLocation,
  type StoreLocationsResponse,
  STORES_PER_BRAND_MAX,
} from '@liame/contracts';
import { type Database, uuidv7 } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { type BlocoDosAnuncios, horariosDaLoja, LOJAS_NO_PLANO, type LojaDaMidia, RAIO_PADRAO_KM } from '../ai/estrategista/midia.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { contaConectada } from '../connections/conectada.js';
import { acessoGoogle, type CredencialGuardada } from '../connections/oauth.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { BALDE_DO_PERFIL_GOOGLE, criarConectorPerfilGoogle, type EnderecoDoPerfil } from '../connectors/google-business/conector-perfil-google.js';
import { FLAG_PERFIL_GOOGLE, PROVEDOR_PERFIL_GOOGLE } from '../connectors/google-business/perfil-google.js';
import { type AuthContext, auditDetail, currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { VaultService } from '../vault/vault.service.js';
import { buscarCep, cepNormalizado, type EnderecoDoCep } from './cep.js';
import { FONTE_CENSO_BAIRRO } from './censo.js';
import { bairroDaArea, type Coordenada, nomeComparavel, procuraDeCoordenada } from './coordenada.js';
import { MUNICIPIOS_DO_IPCA, RMS_DO_IPCA } from './ibge.js';
import { carregarPoliticas } from '../policy/policy.service.js';
import { tetoDaVerba } from '../policy/teto-da-verba.js';
import { diaNoFuso } from '../results/fora-do-normal.js';
import { BAIRROS_NA_SECAO, type BairroParaComparar, compararBairros } from './bairros.js';
import { type DemandaDaLoja, demandaDaLoja, janelas, type LinhaDaDemanda } from './demanda.js';
import { blocoMaisForte, CIDADES_NA_SECAO, DATASET_DA_MIDIA, janelaDaMidia, porcentoDe, somaDoBloco } from './midia-paga.js';
import { type CliquesPorBairro, cliquesPorBairro, type PapelDoBairro, TIPO_DO_CEP, TIPOS_DE_BAIRRO } from './cliques-por-bairro.js';
import { type LinhaDoPublico, retratoDoPublico } from './publico-nas-redes.js';
import { type DataGuardada, datasDaSemana, diaEmBrasilia, quintoDiaUtil, REFERENCIAS_DO_SETOR } from './semana.js';
import { pesosDaSemana, semanaQueVem, verbaDoRitmo } from './ritmo-da-semana.js';
import { DIAS_DA_PREVISAO } from './tempo.js';
import {
  acimaDe,
  correcaoDoIpca,
  corrigido,
  densidade,
  fontesDoRetrato,
  inflacaoDeComerFora,
  type LeituraGuardada,
  mediaDosTrimestres,
  type NumeroGuardado,
  numeroMaisNovo,
  pixDoMunicipio,
  por10Mil,
  type ContagemGuardada,
  restaurantesDoRetrato,
  situacaoDaFonte,
  situacaoDoRetrato,
} from './raio-x.js';
import { areasDeEntrega, ATRIBUICAO, FLAG_DA_REGIAO, fusoDaUf, type LinhaDaLoja, lojaNoMapa, ruaENumero } from './regiao.js';

// A loja no mapa na API (plano da região, R1). Listar e salvar rodam na transação da requisição; conferir um endereço
// e ler o do Perfil do Google chamam serviços de fora (ViaCEP, OpenStreetMap, Google) e por isso rodam sem transação
// aberta: o banco numa transação curta, os serviços depois. Nenhuma dessas duas grava nada. O endereço da loja nunca
// vai para o modelo de IA (D-A3-4, D-RG-2).

const TEMPO_DO_GOOGLE_MS = 8_000;
/** Teto da lista de lojas de uma marca (as do Regem não passam pelo limite de criar aqui, mas são poucas por marca). */
const LOJAS_NA_LISTA = 200;
const ESPERA_PELA_COTA_MS = 2_000;

// `created_here`: nenhuma conta do Regem (nem a desconectada) apontou para a loja, então ela nasceu no Liame (D-RG-17).
// `google_profile_account_id`: o Perfil do Google conectado que é desta loja (D-RG-16).
const COLUNAS_DA_LOJA = sql`u.id, u.name, u.address_postal_code, u.address_street, u.address_number, u.address_complement,
  u.address_district, u.address_city, u.address_state, u.ibge_city_code, u.latitude, u.longitude, u.location_precision,
  u.location_source, u.delivery_radius_km, u.delivery_areas, u.location_set_at, p.id as user_id, p.name as user_name,
  not exists (select 1 from liame.connected_account r where r.unit_id = u.id and r.provider = 'regem') as created_here,
  (select g.id from liame.connected_account g
    where g.unit_id = u.id and g.provider = ${PROVEDOR_PERFIL_GOOGLE} and ${contaConectada('g')}
    order by g.connected_at, g.id limit 1) as google_profile_account_id`;

function desligada(): AppProblem {
  return new AppProblem(409, 'funcao-desligada', 'Função desligada', 'A região ainda não está ligada para esta empresa.');
}

function marcaNaoEncontrada(): AppProblem {
  return new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');
}

function cepInvalido(): AppProblem {
  return new AppProblem(422, 'cep-invalido', 'CEP fora do formato', 'Informe os 8 números do CEP, com ou sem o hífen.');
}

function cepNaoAchado(): AppProblem {
  return new AppProblem(422, 'cep-nao-encontrado', 'CEP não encontrado', 'Esse CEP não existe nos Correios. Confira os números.');
}

function cepForaDoAr(): AppProblem {
  return new AppProblem(503, 'cep-fora-do-ar', 'Consulta do CEP fora do ar', 'O serviço de CEP não respondeu agora. Tente de novo em instantes.');
}

const paraCoordenadas = (c: Coordenada | null): StoreCoordinates | null => (c ? { latitude: c.latitude, longitude: c.longitude, precision: c.precisao } : null);

function paraEndereco(cep: EnderecoDoCep, rua: string | null, numero: string | null, bairro: string | null): StoreAddress {
  return { postal_code: cep.cep, street: rua, number: numero, complement: null, district: bairro, city: cep.cidade, state: cep.uf, ibge_city_code: cep.codigoIbge };
}

@Injectable()
export class RegiaoService {
  private readonly logger = new Logger('regiao');
  // A fila do Nominatim dividida com o centro dos bairros da campanha (uma consulta por segundo no processo).
  private readonly procura = procuraDeCoordenada;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly flags: FlagService,
    private readonly vault: VaultService,
  ) {}

  private banco(): Database {
    if (!this.database) throw new Error('região: sem banco');
    return this.database;
  }

  private ligada(auth: AuthContext, brandId: string, flag = FLAG_DA_REGIAO): Promise<boolean> {
    return this.flags.isEnabled(flag, this.flags.context({ tenantId: auth.tenantId, userId: auth.userId, brandId }));
  }

  private quem(auth: AuthContext): { tenantId: string; userId: string } {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
    return { tenantId: auth.tenantId, userId: auth.userId };
  }

  private async marca(brandId: string): Promise<void> {
    const r = await currentTx().execute<{ id: string }>(sql`select id from liame.brand where id = ${brandId} and archived_at is null`);
    if (!r.rows[0]) throw marcaNaoEncontrada();
  }

  /** As lojas da marca com o que se sabe de onde cada uma fica, e os Perfis do Google ligados a ela. */
  async lojas(auth: AuthContext, brandId: string, agora = new Date()): Promise<StoreLocationsResponse> {
    const tx = currentTx();
    await this.marca(brandId);
    const base = { brand_id: brandId, attribution: ATRIBUICAO, generated_at: agora.toISOString() };
    if (!(await this.ligada(auth, brandId))) {
      return { ...base, availability: { status: 'desligado_pela_liame' }, stores: [], google_profiles: [], can_edit: false, has_regem: false, can_create_store: false };
    }
    const lojas = await tx.execute<LinhaDaLoja>(sql`
      select ${COLUNAS_DA_LOJA}
        from liame.unit u left join liame.app_user p on p.id = u.location_set_by
       where u.brand_id = ${brandId}
       order by u.created_at, u.id
       limit ${LOJAS_NA_LISTA}`);
    const perfis = (await this.ligada(auth, brandId, FLAG_PERFIL_GOOGLE))
      ? (
          await tx.execute<{ id: string; name: string; unit_id: string | null }>(sql`
            select a.id, a.name, a.unit_id from liame.connected_account a
             where a.provider = ${PROVEDOR_PERFIL_GOOGLE} and a.brand_id = ${brandId} and ${contaConectada('a')}
             order by a.name, a.id limit 20`)
        ).rows
      : [];
    const podeEditar = auth.permissions.has('dossie.editar');
    const temRegem = await this.temRegem(brandId);
    return {
      ...base,
      availability: { status: 'disponivel' },
      stores: lojas.rows.map(lojaNoMapa),
      google_profiles: perfis.map((p) => ({ account_id: p.id, name: p.name, unit_id: p.unit_id })),
      can_edit: podeEditar,
      has_regem: temRegem,
      can_create_store: podeEditar && !temRegem,
    };
  }

  /** A marca tem o Regem conectado: as lojas vêm dele (a conexão cria a loja ou se liga à de mesmo nome). */
  private async temRegem(brandId: string): Promise<boolean> {
    const r = await currentTx().execute<{ tem: boolean }>(sql`
      select exists (
        select 1 from liame.connected_account a where a.provider = 'regem' and a.brand_id = ${brandId} and ${contaConectada('a')}
      ) as tem`);
    return r.rows[0]?.tem === true;
  }

  /**
   * O Perfil do Google escolhido passa a ser desta loja (D-RG-16: cada perfil vale para uma loja). O que já é de outra
   * loja volta 409; o que já é desta não muda. Roda na transação da requisição: um erro depois desfaz a ligação.
   */
  private async ligarPerfil(brandId: string, unitId: string, accountId: string): Promise<void> {
    const tx = currentTx();
    const r = await tx.execute<{ unit_id: string | null; unit_name: string | null }>(sql`
      select a.unit_id, u.name as unit_name
        from liame.connected_account a left join liame.unit u on u.id = a.unit_id
       where a.id = ${accountId} and a.provider = ${PROVEDOR_PERFIL_GOOGLE} and a.brand_id = ${brandId} and ${contaConectada('a')}
       for update of a`);
    const conta = r.rows[0];
    if (!conta) throw perfilNaoEncontrado();
    if (conta.unit_id && conta.unit_id !== unitId) {
      throw new AppProblem(409, 'perfil-de-outra-loja', 'Perfil de outra loja', `Esse Perfil do Google já é da loja ${conta.unit_name ?? 'de outra loja'}. Cada perfil vale para uma loja.`);
    }
    if (!conta.unit_id) await tx.execute(sql`update liame.connected_account set unit_id = ${unitId}, updated_at = now() where id = ${accountId}`);
  }

  /** A marca existe e a função está ligada: a transação curta antes de chamar os serviços de fora. */
  private async conferirAntes(auth: AuthContext, brandId: string): Promise<void> {
    await naTransacaoDaEmpresa(this.banco(), this.quem(auth), async () => {
      await this.marca(brandId);
      if (!(await this.ligada(auth, brandId))) throw desligada();
    });
  }

  /** Confere um endereço pelo CEP (ViaCEP) e acha a coordenada (OpenStreetMap). Não grava nada. */
  async conferirEndereco(auth: AuthContext, body: AddressLookupRequest): Promise<AddressLookupResponse> {
    const cep = cepNormalizado(body.postal_code);
    if (!cep) throw cepInvalido();
    await this.conferirAntes(auth, body.brand_id);
    const lido = await buscarCep(cep);
    if (lido.situacao === 'nao_achado') throw cepNaoAchado();
    if (lido.situacao === 'fora_do_ar') throw cepForaDoAr();
    const e = lido.endereco;
    const rua = e.rua ?? (body.street?.trim() || null);
    const numero = body.number?.trim() || null;
    const coordenada = await this.procura.procurar({ rua, numero, bairro: e.bairro, cidade: e.cidade, uf: e.uf });
    return {
      address: paraEndereco(e, rua, numero, e.bairro),
      coordinates: paraCoordenadas(coordenada),
      coordinates_status: coordenada ? 'achada' : 'nao_achada',
      needs_street: rua === null,
      attribution: ATRIBUICAO,
    };
  }

  /** O endereço e as áreas de entrega de um Perfil do Google da marca, lidos agora; o CEP dele é conferido no ViaCEP. Não grava nada. */
  async enderecoDoPerfil(auth: AuthContext, body: GoogleProfileAddressRequest): Promise<GoogleProfileAddressResponse> {
    const conta = await naTransacaoDaEmpresa(this.banco(), this.quem(auth), async () => {
      const tx = currentTx();
      await this.marca(body.brand_id);
      if (!(await this.ligada(auth, body.brand_id))) throw desligada();
      if (!(await this.ligada(auth, body.brand_id, FLAG_PERFIL_GOOGLE))) throw perfilNaoEncontrado();
      const r = await tx.execute<{ external_id: string; name: string; credential_secret_id: string | null }>(sql`
        select a.external_id, a.name, a.credential_secret_id from liame.connected_account a
         where a.id = ${body.account_id} and a.provider = ${PROVEDOR_PERFIL_GOOGLE} and a.brand_id = ${body.brand_id} and ${contaConectada('a')}`);
      const l = r.rows[0];
      if (!l) throw perfilNaoEncontrado();
      const guardada = l.credential_secret_id ? await this.vault.readSecret(tx, l.credential_secret_id) : null;
      const credencial = guardada ? (JSON.parse(guardada) as CredencialGuardada) : null;
      if (credencial?.tipo !== 'google') throw perfilSemAcesso();
      return { loja: l.external_id, nome: l.name, renovacao: credencial.refresh_token };
    });

    let lido: EnderecoDoPerfil;
    try {
      const cliente = new ClienteConector(this.banco().db, {
        enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos),
        balde: BALDE_DO_PERFIL_GOOGLE,
        tentativas: 1,
        esperaMaximaMs: ESPERA_PELA_COTA_MS,
        tempoLimiteMs: TEMPO_DO_GOOGLE_MS,
      });
      const conector = await criarConectorPerfilGoogle(this.banco().db, cliente, this.config.plataformas);
      const accessToken = await acessoGoogle(this.config, this.config.oauth.google?.tokenUrl ?? '', conta.renovacao);
      lido = await conector.lerEnderecoDaLoja({ accessToken }, { loja: conta.loja }, { tempoLimiteMs: TEMPO_DO_GOOGLE_MS });
    } catch (err) {
      // Só o tipo da falha vai para o registro: nada do que o Google respondeu.
      const tipo = err instanceof ErroConector ? err.tipo : 'erro interno';
      this.logger.warn(`endereço do Perfil do Google: ${tipo}`);
      if (err instanceof ErroConector && err.tipo === 'permissao') throw perfilSemAcesso();
      throw new AppProblem(503, 'perfil-fora-do-ar', 'Perfil do Google fora do ar', 'O Google não respondeu agora. Tente de novo em instantes ou informe pelo CEP.');
    }

    const areas = areasDeEntrega(lido.areas);
    const nome = lido.nome ?? conta.nome;
    const semEndereco = { profile_name: nome, address: null, coordinates: null, coordinates_status: 'nao_achada', delivery_areas: areas, needs_street: false, attribution: ATRIBUICAO };
    if (!lido.cep) return semEndereco;
    const doCep = await buscarCep(lido.cep);
    // O CEP do perfil que o ViaCEP não acha (ou que ele não responde agora) não vira endereço: a pessoa informa pelo CEP.
    if (doCep.situacao !== 'achado') return semEndereco;
    const e = doCep.endereco;
    const { rua: ruaDoPerfil, numero } = ruaENumero(lido.linhas[0]);
    const rua = ruaDoPerfil ?? e.rua;
    const bairro = lido.bairro ?? e.bairro;
    const doGoogle = lido.latitude !== null && lido.longitude !== null && lido.latitude >= -34 && lido.latitude <= 6 && lido.longitude >= -75 && lido.longitude <= -28;
    const coordenada: Coordenada | null = doGoogle
      ? { latitude: Number(lido.latitude!.toFixed(6)), longitude: Number(lido.longitude!.toFixed(6)), precisao: 'endereco' }
      : await this.procura.procurar({ rua, numero, bairro, cidade: e.cidade, uf: e.uf });
    return {
      profile_name: nome,
      address: paraEndereco(e, rua, numero, bairro),
      coordinates: paraCoordenadas(coordenada),
      coordinates_status: coordenada ? 'achada' : 'nao_achada',
      delivery_areas: areas,
      needs_street: rua === null,
      attribution: ATRIBUICAO,
    };
  }

  /** Salva onde a loja fica, o raio e as áreas de entrega (o Dono e o Administrador), com o antes e o depois na auditoria. */
  async salvar(auth: AuthContext, unitId: string, body: SaveStoreLocationRequest): Promise<SaveStoreLocationResponse> {
    const tx = currentTx();
    const antes = (
      await tx.execute<LinhaDaLoja & { brand_id: string }>(sql`
        select ${COLUNAS_DA_LOJA}, u.brand_id
          from liame.unit u join liame.brand b on b.id = u.brand_id and b.archived_at is null
          left join liame.app_user p on p.id = u.location_set_by
         where u.id = ${unitId}
         for update of u`)
    ).rows[0];
    if (!antes) throw new AppProblem(404, 'loja-nao-encontrada', 'Não encontramos', 'Loja não encontrada nesta empresa.');
    if (!(await this.ligada(auth, antes.brand_id))) throw desligada();
    // O perfil só conta com a origem `perfil_google`; com o CEP, a ligação que a loja já tem fica como está.
    if (body.source === 'perfil_google' && body.google_profile_account_id) await this.ligarPerfil(antes.brand_id, unitId, body.google_profile_account_id);
    const a = body.address;
    const c = body.coordinates;
    const areas = areasDeEntrega(body.delivery_areas);
    await tx.execute(sql`
      update liame.unit set
             address_postal_code = ${a.postal_code}, address_street = ${a.street}, address_number = ${a.number},
             address_complement = ${a.complement ?? null}, address_district = ${a.district}, address_city = ${a.city},
             address_state = ${a.state}, ibge_city_code = ${a.ibge_city_code},
             latitude = ${c ? c.latitude : null}, longitude = ${c ? c.longitude : null}, location_precision = ${c ? c.precision : null},
             location_source = ${body.source}, delivery_radius_km = ${body.delivery_radius_km}, delivery_areas = ${JSON.stringify(areas)}::jsonb,
             location_set_at = now(), location_set_by = ${auth.userId}
       where id = ${unitId}`);
    const store = await this.lojaSalva(unitId);
    auditDetail({ resourceId: unitId, before: paraAuditoria(lojaNoMapa(antes)), after: paraAuditoria(store) });
    return { store };
  }

  /**
   * Cria a loja já no mapa (a marca sem o Regem, D-RG-17): o Dono e o Administrador, com a função ligada. A marca fica
   * travada até o fim (duas criações ao mesmo tempo não passam juntas pelo nome nem pelo limite). Quando o Regem for
   * conectado depois, ele se liga à loja de mesmo nome (`connections.service`, sem diferença de caixa).
   */
  async criar(auth: AuthContext, body: CreateStoreRequest): Promise<SaveStoreLocationResponse> {
    const tx = currentTx();
    const marca = (
      await tx.execute<{ tenant_id: string }>(sql`select tenant_id from liame.brand where id = ${body.brand_id} and archived_at is null for update`)
    ).rows[0];
    if (!marca) throw marcaNaoEncontrada();
    if (!(await this.ligada(auth, body.brand_id))) throw desligada();
    if (await this.temRegem(body.brand_id)) {
      throw new AppProblem(409, 'marca-com-regem', 'As lojas vêm do Regem', 'Esta marca tem o Regem conectado: as lojas vêm dele. Ponha no mapa uma loja da lista.');
    }
    const nome = body.name.trim().replace(/\s+/g, ' ');
    const daMarca = (
      await tx.execute<{ total: number; mesmo_nome: boolean }>(sql`
        select count(*)::int as total, coalesce(bool_or(lower(btrim(name)) = lower(${nome})), false) as mesmo_nome
          from liame.unit where brand_id = ${body.brand_id}`)
    ).rows[0]!;
    if (daMarca.mesmo_nome) {
      throw new AppProblem(409, 'loja-com-este-nome', 'Já existe uma loja com esse nome', 'A marca já tem uma loja com esse nome. Escolha outro nome ou ponha no mapa a loja da lista.');
    }
    if (daMarca.total >= STORES_PER_BRAND_MAX) {
      throw new AppProblem(409, 'limite-de-lojas', 'Limite de lojas', `A marca chegou a ${STORES_PER_BRAND_MAX} lojas. Fale com a Liame para pôr mais.`);
    }
    const unitId = uuidv7();
    const a = body.address;
    const c = body.coordinates;
    const areas = areasDeEntrega(body.delivery_areas);
    await tx.execute(sql`
      insert into liame.unit (id, tenant_id, brand_id, name, timezone,
             address_postal_code, address_street, address_number, address_complement, address_district, address_city,
             address_state, ibge_city_code, latitude, longitude, location_precision, location_source, delivery_radius_km,
             delivery_areas, location_set_at, location_set_by)
      values (${unitId}, ${marca.tenant_id}, ${body.brand_id}, ${nome}, ${fusoDaUf(a.state)},
             ${a.postal_code}, ${a.street}, ${a.number}, ${a.complement ?? null}, ${a.district}, ${a.city},
             ${a.state}, ${a.ibge_city_code}, ${c ? c.latitude : null}, ${c ? c.longitude : null}, ${c ? c.precision : null},
             ${body.source}, ${body.delivery_radius_km}, ${JSON.stringify(areas)}::jsonb, now(), ${auth.userId})`);
    if (body.source === 'perfil_google' && body.google_profile_account_id) await this.ligarPerfil(body.brand_id, unitId, body.google_profile_account_id);
    const store = await this.lojaSalva(unitId);
    auditDetail({ resourceId: unitId, before: null, after: { unit_name: store.unit_name, ...paraAuditoria(store) } });
    return { store };
  }

  /**
   * Sua região (R2): o retrato da região de uma loja, pelas tabelas do sistema (os bairros do Censo e os números do
   * município); a rotina do worker lê as fontes. Sem IA e sem dado de pessoa; o endereço da loja não sai daqui.
   */
  async raioX(auth: AuthContext, brandId: string, unitId: string, agora = new Date()): Promise<RegionOverviewResponse> {
    const tx = currentTx();
    await this.marca(brandId);
    const vazio = {
      brand_id: brandId,
      unit_id: unitId,
      district: null,
      ipca: null,
      delivery_area: { matched: 0, total: 0, population: null },
      city: null,
      food_places: null,
      week_ahead: null,
      sector_references: [],
      store_demand_status: 'sem_endereco',
      store_demand: null,
      paid_media_status: 'sem_endereco',
      paid_media: null,
      order_districts_status: 'sem_endereco',
      order_districts: null,
      social_audience_status: 'sem_endereco',
      social_audience: null,
      generated_at: agora.toISOString(),
    };
    if (!(await this.ligada(auth, brandId))) {
      return { ...vazio, availability: { status: 'desligado_pela_liame' }, status: 'sem_endereco', district_status: 'sem_bairro', sources: [] };
    }
    const loja = (
      await tx.execute<{
        address_postal_code: string | null;
        address_district: string | null;
        address_city: string | null;
        address_state: string | null;
        ibge_city_code: string | null;
        delivery_areas: unknown;
      }>(sql`
        select address_postal_code, address_district, address_city, address_state, ibge_city_code, delivery_areas
          from liame.unit where id = ${unitId} and brand_id = ${brandId}`)
    ).rows[0];
    if (!loja) throw new AppProblem(404, 'loja-nao-encontrada', 'Não encontramos', 'Loja não encontrada nesta marca.');
    const cidade = loja.ibge_city_code;
    if (!cidade) return { ...vazio, availability: { status: 'disponivel' }, status: 'sem_endereco', district_status: 'sem_bairro', sources: [] };

    // Os números do município, da UF, da RM e do Brasil; a RM do município (a rotina a resolve, "0" fora de RM da PNAD).
    const uf = cidade.slice(0, 2);
    const doMunicipio = (
      await tx.execute<{ rm: string | null }>(sql`
        select value::bigint::text as rm from liame.region_fact
         where geo_level = 'municipio' and geo_code = ${cidade} and indicator = 'rm_pnad' order by period desc limit 1`)
    ).rows[0];
    const rm = doMunicipio?.rm && doMunicipio.rm !== '0' ? doMunicipio.rm : null;
    const numeros = (
      await tx.execute<NumeroGuardado>(sql`
        select geo_level, geo_code, indicator, period, value::float8 as value, source from liame.region_fact
         where (geo_level = 'municipio' and geo_code = ${cidade}) or (geo_level = 'uf' and geo_code = ${uf})
            or (geo_level = 'rm' and geo_code = ${rm ?? '-'}) or (geo_level = 'brasil' and geo_code = '1')`)
    ).rows;

    // A cidade do CPTEC (a rotina a resolve pelo nome; 0 é "o CPTEC não tem"): sem ela, a previsão não é fonte do retrato.
    const cidadeNoCptec = numeros.some((n) => n.geo_level === 'municipio' && n.indicator === 'cptec_cidade' && Number(n.value) > 0);
    const pares = fontesDoRetrato(cidade, rm, cidadeNoCptec);
    const leituras = (
      await tx.execute<LeituraGuardada>(sql`
        select r.source, r.geo_code, r.last_ok_at, r.last_error, r.next_try_at
          from liame.region_source_read r
          join jsonb_to_recordset(${JSON.stringify(pares)}::jsonb) as p (fonte text, lugar text) on p.fonte = r.source and p.lugar = r.geo_code`)
    ).rows;
    const fontes = pares.map((p) => situacaoDaFonte(p.fonte, leituras.find((l) => l.source === p.fonte && l.geo_code === p.lugar)));
    const censoLido = fontes[0]!.status === 'em_dia';

    // O bairro da loja no Censo, pelo nome sem acento no mesmo município (o maior, se dois tiverem o mesmo nome).
    type Bairro = { district_code: string; name: string; population: number | null; area_km2: string | null; head_income_mean: string | null; head_income_median: string | null };
    const bairro = loja.address_district
      ? ((
          await tx.execute<Bairro>(sql`
            select district_code, name, population, area_km2, head_income_mean, head_income_median from liame.region_district
             where city_code = ${cidade} and name_key = ${nomeComparavel(loja.address_district)}
             order by population desc nulls last, district_code limit 1`)
        ).rows[0] ?? null)
      : null;
    const mediana = bairro?.head_income_median === null || bairro?.head_income_median === undefined ? null : Number(bairro.head_income_median);
    const posicao =
      mediana === null
        ? null
        : (
            await tx.execute<{ abaixo: number; total: number; tipica: number | null }>(sql`
              select count(*) filter (where head_income_median < ${mediana})::int as abaixo, count(*)::int as total,
                     percentile_cont(0.5) within group (order by head_income_median)::float8 as tipica
                from liame.region_district where city_code = ${cidade} and head_income_median is not null`)
          ).rows[0];
    const pessoas = bairro?.population ?? null;
    const area = bairro?.area_km2 === null || bairro?.area_km2 === undefined ? null : Number(bairro.area_km2);

    // A gente das áreas de entrega: as que casam com bairros do Censo do município.
    const areas = Array.isArray(loja.delivery_areas) ? loja.delivery_areas.filter((a): a is string => typeof a === 'string') : [];
    const chaves = [...new Set(areas.map((a) => nomeComparavel(bairroDaArea(a))))];
    const entrega = chaves.length
      ? (
          await tx.execute<{ casaram: number; pessoas: number | null; codigos: string[] | null }>(sql`
            select count(*)::int as casaram, sum(population)::int as pessoas, array_agg(district_code) as codigos from (
              select distinct on (name_key) name_key, district_code, population from liame.region_district
               where city_code = ${cidade} and name_key = any(array(select jsonb_array_elements_text(${JSON.stringify(chaves)}::jsonb)))
               order by name_key, population desc nulls last, district_code) b`)
        ).rows[0]
      : { casaram: 0, pessoas: null, codigos: null };

    // Os restaurantes pelo CNPJ da Receita: as linhas do município que a loja usa (o município, o bairro dela, a área do
    // CEP e os bairros das áreas de entrega) e a soma dos ativos de todos os bairros (para a cobertura).
    const prefixoDoCep = loja.address_postal_code ? loja.address_postal_code.slice(0, 5) : null;
    const bairrosDaEntrega = entrega?.codigos ?? [];
    const bairrosDaConta = [...new Set([...(bairro ? [bairro.district_code] : []), ...bairrosDaEntrega])];
    const contagens = (
      await tx.execute<ContagemGuardada>(sql`
        select area_kind, area_key, period, active, active_restaurant, active_snack, active_bar, active_home, opened_12m, closed_12m
          from liame.region_food_count
         where geo_code = ${cidade}
           and (area_kind = 'municipio'
                or (area_kind = 'cep' and area_key = ${prefixoDoCep ?? '-'})
                or (area_kind = 'bairro' and area_key = any(array(select jsonb_array_elements_text(${JSON.stringify(bairrosDaConta)}::jsonb)))))`)
    ).rows;
    const ativosComBairro = contagens.length
      ? ((
          await tx.execute<{ ativos: number }>(sql`
            select coalesce(sum(active), 0)::int as ativos from liame.region_food_count where geo_code = ${cidade} and area_kind = 'bairro'`)
        ).rows[0]?.ativos ?? 0)
      : 0;

    // A semana que vem: a previsão dos próximos dias do município (de hoje em diante, em Brasília) e as datas do
    // calendário do Liame do começo deste mês até 60 dias à frente: os feriados que já passaram no mês e os do mês
    // seguinte entram na conta do prazo do salário (a lista mostra só de hoje em diante).
    const hoje = diaEmBrasilia(agora);
    const previsao = (
      await tx.execute<{ day: string; condition: string; condition_desc: string; min_c: number; max_c: number; fetched_at: Date | string }>(sql`
        select to_char(day, 'YYYY-MM-DD') as day, condition, condition_desc, min_c, max_c, fetched_at from liame.region_weather
         where geo_code = ${cidade} and day >= ${hoje}::date order by day limit ${DIAS_DA_PREVISAO}`)
    ).rows;
    const datas = (
      await tx.execute<DataGuardada>(sql`
        select to_char(day, 'YYYY-MM-DD') as day, name, kind, source from liame.commercial_date
         where day between date_trunc('month', ${hoje}::date)::date and ${hoje}::date + 60 order by day, name`)
    ).rows;

    // A demanda da loja (R3, parte 1): os pedidos do Regem, só para quem vê Resultados.
    const demanda = await this.demandaDaLoja(auth.permissions.has('vendas.ver'), brandId, unitId, agora);
    // Os pedidos por bairro (R3, parte 2): o que o Regem manda somado, com a gente do Censo; a mesma régua da demanda.
    const bairrosDosPedidos = await this.bairrosDosPedidos(auth.permissions.has('vendas.ver'), brandId, unitId, cidade, loja.address_city, areas);
    // A mídia na região (R4): os anúncios da marca por hora e, do Google, por cidade e por bairro (com o papel de cada
    // bairro nos pedidos e a área de entrega); a mesma régua da demanda.
    const papeis = new Map<string, PapelDoBairro>();
    for (const b of bairrosDosPedidos.bairros?.districts ?? []) if (b.role === 'atacar' || b.role === 'defender' || b.role === 'manter') papeis.set(nomeComparavel(b.name), b.role);
    const midia = await this.midiaNaRegiao(auth, brandId, unitId, agora, demanda.demanda, { cidade, municipio: loja.address_city ?? '', areas, papeis });
    // O público nas redes (R4, parte 3): os números da conta do Instagram e da Página; não são de venda (D-RG-42).
    const publico = await this.publicoNasRedes(brandId, loja.address_city);

    const noMunicipio = (indicador: string) => numeroMaisNovo(numeros, indicador, 'municipio', cidade);
    const populacao = noMunicipio('populacao');
    const estimada = noMunicipio('populacao_estimada');
    const restaurantes = noMunicipio('restaurantes');
    const ipca = correcaoDoIpca(numeros);
    const media = bairro?.head_income_mean === null || bairro?.head_income_mean === undefined ? null : Number(bairro.head_income_mean);
    const ipcaLocal = MUNICIPIOS_DO_IPCA.has(cidade) ? inflacaoDeComerFora(numeros, 'municipio', cidade) : rm && RMS_DO_IPCA.has(rm) ? inflacaoDeComerFora(numeros, 'rm', rm) : null;
    const ipcaBrasil = inflacaoDeComerFora(numeros, 'brasil', '1');
    return {
      brand_id: brandId,
      unit_id: unitId,
      availability: { status: 'disponivel' },
      status: situacaoDoRetrato(fontes),
      district_status: !censoLido ? 'lendo' : !loja.address_district ? 'sem_bairro' : bairro ? 'achado' : 'nao_achado',
      district: bairro
        ? {
            code: bairro.district_code,
            name: bairro.name,
            population: pessoas,
            area_km2: area,
            density: densidade(pessoas, area),
            head_income_median: mediana,
            head_income_mean: media,
            head_income_median_today: corrigido(mediana, ipca),
            head_income_mean_today: corrigido(media, ipca),
            income_rank: posicao && posicao.total > 0 && posicao.tipica !== null ? { above_pct: acimaDe(posicao.abaixo, posicao.total), districts: posicao.total, typical_median: posicao.tipica } : null,
          }
        : null,
      ipca,
      delivery_area: { matched: entrega?.casaram ?? 0, total: chaves.length, population: entrega?.casaram ? (entrega.pessoas ?? null) : null },
      city: {
        code: cidade,
        name: loja.address_city ?? '',
        state: loja.address_state ?? '',
        population: populacao,
        density: noMunicipio('densidade'),
        population_estimate: estimada,
        income_pc_median: noMunicipio('renda_pc_mediana'),
        income_pc_mean: noMunicipio('renda_pc_media'),
        restaurants: restaurantes,
        restaurants_per_10k: por10Mil(restaurantes?.value ?? null, (estimada ?? populacao)?.value ?? null),
        rm_code: rm,
        income_pc_uf: numeroMaisNovo(numeros, 'renda_pc_pnad', 'uf', uf),
        income_pc_rm: rm ? numeroMaisNovo(numeros, 'renda_pc_pnad', 'rm', rm) : null,
        work_income_capital: mediaDosTrimestres(numeros, 'renda_trabalho', cidade),
        pix: pixDoMunicipio(numeros, cidade),
        food_away_inflation: ipcaLocal
          ? { ...ipcaLocal, brasil: ipcaLocal.brasil }
          : ipcaBrasil
            ? { scope: 'brasil', period: ipcaBrasil.period, away: ipcaBrasil.away, meal: ipcaBrasil.meal, snack: ipcaBrasil.snack, brasil: null }
            : null,
      },
      food_places: restaurantesDoRetrato({
        linhas: contagens,
        bairro: bairro ? { codigo: bairro.district_code, areaKm2: area } : null,
        prefixoDoCep,
        bairrosDaEntrega,
        ativosComBairro,
        populacao: (estimada ?? populacao)?.value ?? null,
      }),
      week_ahead: { weather: previsao.length ? { read_at: new Date(previsao[0]!.fetched_at).toISOString(), days: previsao.map((d) => ({ day: d.day, condition: d.condition, description: d.condition_desc, min: d.min_c, max: d.max_c })) } : null, dates: datasDaSemana(datas, hoje) },
      sector_references: REFERENCIAS_DO_SETOR.map((r) => ({ ...r })),
      store_demand_status: demanda.status,
      store_demand: demanda.demanda,
      paid_media_status: midia.status,
      paid_media: midia.midia,
      order_districts_status: bairrosDosPedidos.status,
      order_districts: bairrosDosPedidos.bairros,
      social_audience_status: publico.status,
      social_audience: publico.publico,
      sources: fontes,
      generated_at: agora.toISOString(),
    };
  }

  /**
   * A demanda da loja (R3, parte 1): os pedidos confirmados das duas janelas de 4 semanas (a atual termina ontem, no
   * fuso da loja), agrupados por dia da semana e hora em que o cliente pediu. Os números de venda vão só para quem vê
   * Resultados (`vendas.ver`), como lá; sem o Regem ligado na marca, o Liame não tem os pedidos.
   */
  /**
   * O ritmo da semana que vem, em prévia (R7, parte 1; D-RG-58 a D-RG-60): o que o Gestor de tráfego montaria com o que
   * o Liame já lê. Só leitura: nada é pedido nem executado. O peso de cada dia vem dos pedidos da loja por dia da semana
   * (as 4 semanas de Sua região; sem pedidos que bastem, a referência do setor), da chuva prevista e das datas; entram
   * as campanhas ativas da Meta com verba diária própria (na campanha, ou no conjunto quando a campanha não tem), fora
   * as de alcance e de seguidores criadas pelo Liame (o teto de 25% já cuida delas, D-RG-64).
   */
  async ritmoDaSemana(auth: AuthContext, brandId: string, unitId: string, agora = new Date()): Promise<RegionRhythmResponse> {
    const tx = currentTx();
    await this.marca(brandId);
    const vazio = { week: null, source: null, days: [], campaigns: [], out: [], base_micros: 0, base_week_micros: 0, week_micros: 0, hours: null, generated_at: agora.toISOString() };
    if (!(await this.ligada(auth, brandId))) return { status: 'desligado', ...vazio };
    const loja = (
      await tx.execute<{ ibge_city_code: string | null; timezone: string | null }>(sql`
        select ibge_city_code, timezone from liame.unit where id = ${unitId} and brand_id = ${brandId}`)
    ).rows[0];
    if (!loja) throw new AppProblem(404, 'loja-nao-encontrada', 'Não encontramos', 'Loja não encontrada nesta marca.');
    if (!loja.ibge_city_code) return { status: 'sem_endereco', ...vazio };
    if (!auth.permissions.has('vendas.ver')) return { status: 'sem_permissao', ...vazio };

    const semana = semanaQueVem(diaNoFuso(agora, loja.timezone ?? 'America/Sao_Paulo'));
    const { demanda } = await this.demandaDaLoja(true, brandId, unitId, agora);
    const pedidos = demanda?.status === 'pronto' ? Array.from({ length: 7 }, (_, d) => demanda.by_weekday.find((x) => x.weekday === d)?.orders ?? 0) : null;
    const previsao = (
      await tx.execute<{ day: string; condition: string; condition_desc: string; min_c: number; max_c: number }>(sql`
        select to_char(day, 'YYYY-MM-DD') as day, condition, condition_desc, min_c, max_c from liame.region_weather
         where geo_code = ${loja.ibge_city_code} and day between ${semana.de}::date and ${semana.ate}::date order by day`)
    ).rows;
    // As datas da semana e a do dia seguinte ao fim dela (a véspera); os feriados do mês inteiro entram na conta do
    // prazo do salário (o 5º dia útil), que é conta do sistema.
    const guardadas = (
      await tx.execute<DataGuardada>(sql`
        select to_char(day, 'YYYY-MM-DD') as day, name, kind, source from liame.commercial_date
         where day between date_trunc('month', ${semana.de}::date)::date and ${semana.ate}::date + 1 order by day, name`)
    ).rows;
    const feriados = new Set(guardadas.filter((d) => d.kind === 'feriado_nacional').map((d) => d.day));
    const salarios = [...new Set([semana.de.slice(0, 7), semana.ate.slice(0, 7)])].map((mes) => quintoDiaUtil(mes, feriados));
    const datas = [
      ...guardadas.filter((d) => d.day >= semana.de).map((d) => ({ day: d.day, name: d.name, kind: d.kind })),
      ...salarios.filter((d) => d >= semana.de && d <= semana.ate).map((day) => ({ day, name: 'Prazo do salário (5º dia útil)', kind: 'salario' })),
    ];
    const dias = pesosDaSemana({
      dias: semana.dias,
      pedidosPorDiaDaSemana: pedidos,
      previsao: previsao.map((p) => ({ day: p.day, condition: p.condition, description: p.condition_desc, min: p.min_c, max: p.max_c })),
      datas,
    });

    // As campanhas: a verba diária mora na campanha ou, quando ela não tem, no conjunto (nunca nas duas).
    const candidatas = (
      await tx.execute<{ id: string; nivel: string; nome: string; verba: string }>(sql`
        select c.id, 'campanha' as nivel, c.name as nome, c.daily_budget_micros::text as verba
          from liame.campaign c
          join liame.connected_account a on a.id = c.connected_account_id and a.tenant_id = c.tenant_id
         where a.brand_id = ${brandId} and a.provider = 'meta_ads' and ${contaConectada('a')}
           and c.status = 'ativa' and c.daily_budget_micros > 0 and c.lifetime_budget_micros is null
           and not exists (select 1 from liame.ad_campaign_new n
                            where n.tenant_id = c.tenant_id and n.meta_campaign_id = c.external_id and n.objective in ('alcance', 'seguidores'))
        union all
        select g.id, 'conjunto' as nivel, c.name || ' · ' || g.name as nome, g.daily_budget_micros::text as verba
          from liame.ad_group g
          join liame.campaign c on c.id = g.campaign_id
          join liame.connected_account a on a.id = c.connected_account_id and a.tenant_id = c.tenant_id
         where a.brand_id = ${brandId} and a.provider = 'meta_ads' and ${contaConectada('a')}
           and c.status = 'ativa' and g.status = 'ativa' and c.daily_budget_micros is null and c.lifetime_budget_micros is null and g.daily_budget_micros > 0
           and not exists (select 1 from liame.ad_campaign_new n
                            where n.tenant_id = c.tenant_id and n.meta_campaign_id = c.external_id and n.objective in ('alcance', 'seguidores'))
         order by nome, id`)
    ).rows;
    const { policies } = await carregarPoliticas(tx, this.quem(auth).tenantId, brandId);
    const teto = tetoDaVerba(policies, 'meta_ads');
    const pesos = dias.map((d) => d.weight);
    const campaigns: RegionRhythmResponse['campaigns'] = [];
    const out: RegionRhythmResponse['out'] = [];
    for (const c of candidatas) {
      const base = Number(c.verba);
      const v = verbaDoRitmo(base, pesos, teto);
      if (!v.ok) out.push({ name: c.nome, reason: v.motivo });
      else campaigns.push({ id: c.id, level: c.nivel, name: c.nome, base_micros: base, days_micros: v.dias, week_micros: v.dias.reduce((s, x) => s + x, 0) });
    }
    const base = campaigns.reduce((s, c) => s + c.base_micros, 0);
    const horarios = horariosDaLoja(demanda);
    return {
      status: campaigns.length ? 'pronto' : 'sem_campanhas',
      week: { from: semana.de, to: semana.ate },
      source: pedidos ? 'loja' : 'setor',
      days: dias.map((d, i) => ({
        day: d.day,
        weekday: d.weekday,
        weight: d.weight,
        total_micros: campaigns.reduce((s, c) => s + c.days_micros[i]!, 0),
        reasons: d.reasons.map((r) => ({
          kind: r.kind,
          share_pct: r.kind === 'pedidos' ? r.share_pct : null,
          text: r.kind === 'chuva' ? r.description : r.kind === 'data' ? r.name : null,
          min: r.kind === 'chuva' ? r.min : null,
          max: r.kind === 'chuva' ? r.max : null,
          eve: r.kind === 'data' ? r.eve : null,
        })),
      })),
      campaigns,
      out,
      base_micros: base,
      base_week_micros: base * 7,
      week_micros: campaigns.reduce((s, c) => s + c.week_micros, 0),
      hours: { source: horarios.source, from: horarios.from, to: horarios.to, ads_from: horarios.ads_from },
      generated_at: agora.toISOString(),
    };
  }

  private async demandaDaLoja(podeVerVendas: boolean, brandId: string, unitId: string, agora: Date): Promise<{ status: string; demanda: DemandaDaLoja | null }> {
    if (!podeVerVendas) return { status: 'sem_permissao', demanda: null };
    if (!(await this.temRegem(brandId))) return { status: 'sem_regem', demanda: null };
    const tx = currentTx();
    const fuso = (await tx.execute<{ timezone: string }>(sql`select timezone from liame.unit where id = ${unitId}`)).rows[0]?.timezone ?? 'America/Sao_Paulo';
    const hoje = diaNoFuso(agora, fuso);
    const j = janelas(hoje);
    // O índice (tenant_id, brand_id, confirmed_at) recorta pela confirmação, com folga; o dia exato é o do pedido no fuso.
    const linhas = (
      await tx.execute<LinhaDaDemanda>(sql`
        with p as (
          select (coalesce(o.placed_at, o.confirmed_at) at time zone ${fuso}) as local, o.revenue_micros - o.refunded_micros as liquido, o.is_new_customer
            from liame.order_fact o
           where o.brand_id = ${brandId} and o.unit_id = ${unitId} and o.status = 'confirmado'
             and o.confirmed_at >= (${j.deAnterior}::date - 2)::timestamp at time zone ${fuso}
             and o.confirmed_at < (${j.ate}::date + 3)::timestamp at time zone ${fuso}
        )
        select case when local::date >= ${j.de}::date then 'atual' else 'anterior' end as janela,
               extract(dow from local)::int as dow, extract(hour from local)::int as hora,
               count(*)::int as pedidos, coalesce(sum(liquido), 0)::text as receita,
               count(*) filter (where is_new_customer)::int as novos,
               count(*) filter (where is_new_customer = false)::int as de_volta
          from p
         where local::date between ${j.deAnterior}::date and ${j.ate}::date
         group by 1, 2, 3`)
    ).rows;
    return { status: 'disponivel', demanda: demandaDaLoja(linhas, hoje) };
  }

  /**
   * A hora dos anúncios da marca para o plano de mídia do Estrategista (R4 na R5): o bloco de até 4 horas com mais
   * cliques nas 4 semanas completas até ontem (Meta e Google somados, como a rotina `regiao-midia` leu). Rotina do
   * sistema, na transação da empresa já aberta; nulo sem clique lido.
   */
  async blocoDosAnuncios(brandId: string, agora = new Date()): Promise<BlocoDosAnuncios | null> {
    const j = janelaDaMidia(diaNoFuso(agora, 'America/Sao_Paulo'));
    const linhas = (
      await currentTx().execute<{ hour: number; clicks: string }>(sql`
        select hour, sum(clicks)::text as clicks from liame.ad_hour_daily
         where brand_id = ${brandId} and day between ${j.inicio}::date and ${j.fim}::date
         group by hour`)
    ).rows;
    const cliques = Array.from({ length: 24 }, (_, h) => Number(linhas.find((l) => Number(l.hour) === h)?.clicks ?? 0));
    const total = cliques.reduce((t, n) => t + n, 0);
    const bloco = blocoMaisForte(cliques);
    return bloco && total > 0 ? { de: bloco.de, ate: bloco.ate, parte: porcentoDe(bloco.soma, total) } : null;
  }

  /**
   * As lojas no mapa para o plano de mídia do Estrategista (R5): rotina do sistema, sem sessão de pessoa, dentro da
   * transação da empresa que a rotina já abriu. Nulo com a função `regiao` desligada na marca; vazio sem loja no mapa.
   * Só o nome, o bairro, o município, o raio e a demanda (D-RG-2: nada do endereço vai ao modelo). A demanda entra
   * inteira porque o plano só abre para quem vê Resultados (`planos.ver` e `vendas.ver`, D-RG-24).
   */
  async lojasParaOPlano(tenantId: string, brandId: string, agora = new Date()): Promise<LojaDaMidia[] | null> {
    if (!(await this.flags.isEnabled(FLAG_DA_REGIAO, this.flags.context({ tenantId, userId: null, brandId })))) return null;
    const lojas = (
      await currentTx().execute<{ id: string; name: string; address_district: string | null; address_city: string; delivery_radius_km: string | number | null }>(sql`
        select id, name, address_district, address_city, delivery_radius_km from liame.unit
         where brand_id = ${brandId} and address_postal_code is not null and address_city is not null
           and address_state is not null and ibge_city_code is not null
         order by created_at, id
         limit ${LOJAS_NO_PLANO + 1}`)
    ).rows;
    const saida: LojaDaMidia[] = [];
    for (const [i, l] of lojas.entries()) {
      // A 6ª loja só avisa o modelo de que há mais lojas: a demanda dela não é lida.
      const demanda = i < LOJAS_NO_PLANO ? (await this.demandaDaLoja(true, brandId, l.id, agora)).demanda : null;
      saida.push({
        unitId: l.id,
        nome: l.name,
        bairro: l.address_district,
        municipio: l.address_city,
        raioKm: l.delivery_radius_km === null ? RAIO_PADRAO_KM : Number(l.delivery_radius_km),
        demanda,
      });
    }
    return saida;
  }

  /**
   * A mídia na região (R4; D-RG-32 a D-RG-35): os cliques e as impressões das contas de anúncio da marca nas 4 semanas
   * completas até ontem, por hora (Meta e Google) e, do Google, por cidade, lidos pela rotina `regiao-midia`. Sem
   * dinheiro (D-RG-33). Só para quem vê Resultados (D-RG-34), como a demanda.
   */
  private async midiaNaRegiao(
    auth: AuthContext,
    brandId: string,
    unitId: string,
    agora: Date,
    demanda: DemandaDaLoja | null,
    loja: { cidade: string; municipio: string; areas: readonly string[]; papeis: ReadonlyMap<string, PapelDoBairro> },
  ): Promise<{ status: string; midia: RegionOverviewResponse['paid_media'] }> {
    if (!auth.permissions.has('vendas.ver')) return { status: 'sem_permissao', midia: null };
    const tx = currentTx();
    const contas = (
      await tx.execute<{ id: string; provider: string; name: string; read_at: Date | string | null }>(sql`
        select a.id, a.provider, a.name, s.last_success_at as read_at
          from liame.connected_account a
          left join liame.sync_state s on s.connected_account_id = a.id and s.dataset = ${DATASET_DA_MIDIA}
         where a.brand_id = ${brandId} and a.provider in ('meta_ads', 'google_ads') and ${contaConectada('a')}
         order by a.provider, a.name, a.id`)
    ).rows;
    if (!contas.length) return { status: 'sem_conta', midia: null };
    const fuso = (await tx.execute<{ timezone: string }>(sql`select timezone from liame.unit where id = ${unitId}`)).rows[0]?.timezone ?? 'America/Sao_Paulo';
    const j = janelaDaMidia(diaNoFuso(agora, fuso));
    const ids = contas.map((c) => c.id);
    const porHora = (
      await tx.execute<{ hour: number; clicks: string; impressions: string }>(sql`
        select hour, sum(clicks)::text as clicks, sum(impressions)::text as impressions
          from liame.ad_hour_daily
         where brand_id = ${brandId} and connected_account_id in ${ids} and day between ${j.inicio}::date and ${j.fim}::date
         group by hour`)
    ).rows;
    const horas = Array.from({ length: 24 }, (_, hour) => {
      const l = porHora.find((x) => Number(x.hour) === hour);
      return { hour, clicks: Number(l?.clicks ?? 0), impressions: Number(l?.impressions ?? 0) };
    });
    const cliques = horas.map((h) => h.clicks);
    const total = cliques.reduce((t, n) => t + n, 0);
    const bloco = blocoMaisForte(cliques);
    const pedidos = demanda?.status === 'pronto' && demanda.by_hour.length === 24 ? blocoMaisForte(demanda.by_hour.map((h) => h.orders)) : null;
    const google = contas.filter((c) => c.provider === 'google_ads');
    const cidades = google.length
      ? (
          // O Google tem mais de um lugar "City" para o mesmo município (o antigo, "Duque de Caxias,State of Rio de
          // Janeiro,Brazil", e o novo, "Duque de Caxias,Duque de Caxias,State of…"): a cidade da tela é o nome com o
          // estado (o penúltimo pedaço do nome completo), somada; o lugar ainda sem nome fica sozinho, pelo id.
          await tx.execute<{ id: string; name: string | null; full_name: string | null; clicks: string; impressions: string; total: string }>(sql`
            with por_lugar as (
              select c.geo_target_id, g.name, g.canonical_name, sum(c.clicks) as clicks, sum(c.impressions) as impressions,
                     string_to_array(g.canonical_name, ',') as partes
                from liame.ad_city_daily c
                left join liame.region_geo_target g on g.id = c.geo_target_id
               where c.brand_id = ${brandId} and c.connected_account_id in ${google.map((c) => c.id)} and c.day between ${j.inicio}::date and ${j.fim}::date
               group by c.geo_target_id, g.name, g.canonical_name
            ), por_cidade as (
              select min(geo_target_id) as geo_target_id, min(name) as name,
                     (array_agg(canonical_name order by length(canonical_name), geo_target_id))[1] as full_name,
                     sum(clicks) as clicks, sum(impressions) as impressions
                from por_lugar
               group by coalesce(name || '|' || coalesce(partes[greatest(cardinality(partes) - 1, 1)], ''), 'id:' || geo_target_id::text)
            )
            select geo_target_id::text as id, name, full_name, clicks::text as clicks, impressions::text as impressions, sum(clicks) over ()::text as total
              from por_cidade
             order by clicks desc, geo_target_id`)
        ).rows
      : [];
    // Os cliques por bairro e de fora da área (R4, os bairros; D-RG-44 a D-RG-47): todas as cidades contam para achar
    // o município da loja e os outros; a lista da tela mostra as 8 maiores.
    const totalDoGoogle = cidades.length ? Number(cidades[0]!.total) : 0;
    const chaveDoMunicipio = nomeComparavel(loja.municipio);
    const doMunicipio = cidades.filter((c) => c.name !== null && nomeComparavel(c.name) === chaveDoMunicipio).reduce((t, c) => t + Number(c.clicks), 0);
    const porBairro = google.length ? await this.cliquesPorBairroDaLoja(brandId, google.map((c) => c.id), j, loja, totalDoGoogle, doMunicipio) : null;
    const quando = (v: Date | string | null) => (v === null ? null : (v instanceof Date ? v : new Date(v)).toISOString());
    return {
      status: 'disponivel',
      midia: {
        from: j.inicio,
        to: j.fim,
        accounts: contas.map((c) => ({ provider: c.provider, name: c.name, read_at: quando(c.read_at) })),
        clicks: total,
        impressions: horas.reduce((t, h) => t + h.impressions, 0),
        by_hour: horas,
        ad_block: bloco ? { from_hour: bloco.de, to_hour: bloco.ate, clicks_pct: porcentoDe(bloco.soma, total) } : null,
        orders_block: pedidos && total > 0 ? { from_hour: pedidos.de, to_hour: pedidos.ate, clicks_pct: porcentoDe(somaDoBloco(cliques, pedidos.de, pedidos.ate), total) } : null,
        cities_status: !google.length ? 'sem_google' : google.every((c) => c.read_at === null) ? 'lendo' : 'disponivel',
        cities: cidades.slice(0, CIDADES_NA_SECAO).map((c) => ({
          id: c.id,
          name: c.name ?? `Lugar ${c.id}`,
          full_name: c.full_name ?? c.name ?? `Lugar ${c.id}`,
          clicks: Number(c.clicks),
          impressions: Number(c.impressions),
          clicks_pct: porcentoDe(Number(c.clicks), Number(c.total)),
        })),
        districts: porBairro?.districts ?? null,
        outside_area: porBairro?.outside_area ?? null,
      },
    };
  }

  /**
   * O local mais específico dos cliques do Google (`ad_local_daily`) com o tipo do lugar, os bairros do Censo do
   * município da loja que casam pelo nome, os CEPs do município (pelas contagens da Receita, que são por CEP) e a conta
   * de `cliques-por-bairro.ts`.
   */
  private async cliquesPorBairroDaLoja(
    brandId: string,
    contasDoGoogle: readonly string[],
    j: { inicio: string; fim: string },
    loja: { cidade: string; municipio: string; areas: readonly string[]; papeis: ReadonlyMap<string, PapelDoBairro> },
    cliquesDoGoogle: number,
    cliquesDoMunicipio: number,
  ): Promise<CliquesPorBairro> {
    const tx = currentTx();
    const locais = (
      await tx.execute<{ tipo: string | null; nome: string | null; cliques: string }>(sql`
        select g.target_type as tipo, g.name as nome, sum(l.clicks)::text as cliques
          from liame.ad_local_daily l
          left join liame.region_geo_target g on g.id = l.geo_target_id
         where l.brand_id = ${brandId} and l.connected_account_id in ${contasDoGoogle} and l.day between ${j.inicio}::date and ${j.fim}::date
         group by l.geo_target_id, g.target_type, g.name`)
    ).rows.map((l) => ({ tipo: l.tipo, nome: l.nome, cliques: Number(l.cliques) }));
    const chaves = [...new Set(locais.filter((l) => l.tipo && l.nome && TIPOS_DE_BAIRRO.has(l.tipo)).map((l) => nomeComparavel(l.nome!)))];
    const ceps = [...new Set(locais.filter((l) => l.tipo === TIPO_DO_CEP && l.nome).map((l) => l.nome!.trim()))];
    const bairros = chaves.length
      ? (
          await tx.execute<{ name_key: string; name: string }>(sql`
            select distinct on (name_key) name_key, name from liame.region_district
             where city_code = ${loja.cidade} and name_key = any(array(select jsonb_array_elements_text(${JSON.stringify(chaves)}::jsonb)))
             order by name_key, population desc nulls last, district_code`)
        ).rows
      : [];
    const cepsDoMunicipio = ceps.length
      ? (
          await tx.execute<{ area_key: string }>(sql`
            select area_key from liame.region_food_count
             where geo_code = ${loja.cidade} and area_kind = 'cep' and area_key = any(array(select jsonb_array_elements_text(${JSON.stringify(ceps)}::jsonb)))`)
        ).rows.map((r) => r.area_key)
      : [];
    return cliquesPorBairro({
      locais,
      bairrosDoMunicipio: new Map(bairros.map((b) => [b.name_key, b.name])),
      cepsDoMunicipio: new Set(cepsDoMunicipio),
      areas: loja.areas,
      papeis: loja.papeis,
      cliquesDoGoogle,
      cliquesDoMunicipio,
      municipio: loja.municipio,
    });
  }

  /**
   * O público nas redes (R4, parte 3; D-RG-40 a D-RG-43): a última leitura de cada Instagram e Página conectados à marca
   * (a rotina `regiao-publico`), com os seguidores da série do Liame no começo da janela. Quem vê Sua região vê: são
   * números públicos de perfil, somados, não de venda (D-RG-42).
   */
  private async publicoNasRedes(brandId: string, municipio: string | null): Promise<{ status: string; publico: RegionOverviewResponse['social_audience'] }> {
    const linhas = (
      await currentTx().execute<LinhaDoPublico>(sql`
        select a.provider, a.name, p.day_from::text as day_from, p.day_to::text as day_to, p.followers::text as followers,
               p.follows::text as follows, p.unfollows::text as unfollows, p.taps, p.page_views::text as page_views, p.cities,
               p.cities_read_at, p.read_at,
               (select f.followers::text from liame.social_follower_daily f
                 where f.connected_account_id = a.id and f.day <= p.day_from order by f.day desc limit 1) as base
          from liame.connected_account a
          left join liame.social_audience p on p.connected_account_id = a.id
         where a.brand_id = ${brandId} and a.provider in ('instagram', 'facebook_page') and ${contaConectada('a')}
         order by a.provider, p.read_at desc nulls last, a.created_at, a.id`)
    ).rows;
    return retratoDoPublico(linhas, municipio);
  }

  /**
   * Os pedidos por bairro (R3, parte 2; D-RG-36 a D-RG-39): o que a leitura das vendas gravou do Regem para esta loja, os
   * bairros do mesmo município casados com o Censo pelo nome (a gente e os pedidos por mil moradores) e os bairros da
   * área de entrega que não chegaram ao mínimo de pedidos; a conta de atacar e defender é a de `bairros.ts`. Só para quem
   * vê Resultados, como a demanda.
   */
  private async bairrosDosPedidos(
    podeVerVendas: boolean,
    brandId: string,
    unitId: string,
    cidade: string,
    municipio: string | null,
    areas: readonly string[],
  ): Promise<{ status: string; bairros: RegionOverviewResponse['order_districts'] }> {
    if (!podeVerVendas) return { status: 'sem_permissao', bairros: null };
    if (!(await this.temRegem(brandId))) return { status: 'sem_regem', bairros: null };
    const tx = currentTx();
    const linhas = (
      await tx.execute<{ kind: string; district: string | null; city: string | null; districts: number | null; orders: number; day_from: string; day_to: string; minimum: number; read_at: Date | string }>(sql`
        select kind, district, city, districts, orders, day_from::text as day_from, day_to::text as day_to, minimum, read_at
          from liame.region_order_district
         where brand_id = ${brandId} and unit_id = ${unitId}
         order by position`)
    ).rows;
    if (!linhas.length) return { status: 'lendo', bairros: null };
    const doMunicipio = (c: string | null) => !c || !municipio || nomeComparavel(c) === nomeComparavel(municipio);
    const lidos = linhas.filter((l) => l.kind === 'bairro' && l.district && doMunicipio(l.city));
    const daEntrega = new Map<string, string>();
    for (const a of areas.map(bairroDaArea)) if (!daEntrega.has(nomeComparavel(a))) daEntrega.set(nomeComparavel(a), a);
    const chaves = [...new Set([...lidos.map((l) => nomeComparavel(l.district!)), ...daEntrega.keys()])];
    const gente = chaves.length
      ? (
          await tx.execute<{ name_key: string; name: string; population: number | null }>(sql`
            select distinct on (name_key) name_key, name, population from liame.region_district
             where city_code = ${cidade} and name_key = any(array(select jsonb_array_elements_text(${JSON.stringify(chaves)}::jsonb)))
             order by name_key, population desc nulls last, district_code`)
        ).rows
      : [];
    const doCenso = new Map(gente.map((g) => [g.name_key, g]));
    const lista = new Map<string, BairroParaComparar>();
    for (const l of lidos) {
      const k = nomeComparavel(l.district!);
      const antes = lista.get(k);
      lista.set(k, { nome: antes?.nome ?? l.district!, pedidos: (antes?.pedidos ?? 0) + l.orders, populacao: doCenso.get(k)?.population ?? null, naEntrega: daEntrega.has(k) });
    }
    for (const [k, nome] of daEntrega) {
      if (!lista.has(k)) lista.set(k, { nome: doCenso.get(k)?.name ?? nome, pedidos: null, populacao: doCenso.get(k)?.population ?? null, naEntrega: true });
    }
    const comparados = compararBairros([...lista.values()]);
    const de = (tipo: string) => linhas.find((l) => l.kind === tipo);
    const primeira = linhas[0]!;
    return {
      status: 'disponivel',
      bairros: {
        from: primeira.day_from,
        to: primeira.day_to,
        minimum: primeira.minimum,
        read_at: (primeira.read_at instanceof Date ? primeira.read_at : new Date(primeira.read_at)).toISOString(),
        comparable: comparados.some((b) => b.papel !== null),
        districts: comparados.slice(0, BAIRROS_NA_SECAO).map((b) => ({
          name: b.nome,
          orders: b.pedidos,
          population: b.populacao,
          per_1000: b.porMil === null ? null : Math.round(b.porMil * 10) / 10,
          role: b.papel,
          in_delivery_area: b.naEntrega,
        })),
        others: { districts: de('outros')?.districts ?? 0, orders: de('outros')?.orders ?? 0 },
        without_district: de('sem_bairro')?.orders ?? 0,
        pickup: de('retirada')?.orders ?? 0,
        delivery_orders: linhas.filter((l) => l.kind !== 'retirada').reduce((t, l) => t + l.orders, 0),
      },
    };
  }

  private async lojaSalva(unitId: string): Promise<StoreLocation> {
    const r = await currentTx().execute<LinhaDaLoja>(sql`
      select ${COLUNAS_DA_LOJA} from liame.unit u left join liame.app_user p on p.id = u.location_set_by where u.id = ${unitId}`);
    return lojaNoMapa(r.rows[0]!);
  }
}

/** O que vai para a auditoria: onde a loja fica, o raio, as áreas e o perfil (quem e quando a auditoria já guarda). */
function paraAuditoria(l: StoreLocation): Record<string, unknown> {
  return {
    address: l.address,
    coordinates: l.coordinates,
    source: l.source,
    delivery_radius_km: l.delivery_radius_km,
    delivery_areas: l.delivery_areas,
    google_profile_account_id: l.google_profile_account_id,
  };
}

function perfilNaoEncontrado(): AppProblem {
  return new AppProblem(404, 'perfil-nao-encontrado', 'Não encontramos', 'Esse Perfil do Google não está ligado a esta marca.');
}

function perfilSemAcesso(): AppProblem {
  return new AppProblem(409, 'perfil-sem-acesso', 'Sem acesso ao perfil', 'O Liame não tem mais acesso a esse Perfil do Google. Conecte de novo em Contas conectadas ou informe pelo CEP.');
}
