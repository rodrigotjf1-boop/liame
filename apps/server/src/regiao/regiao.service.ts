import {
  type AddressLookupRequest,
  type AddressLookupResponse,
  type CreateStoreRequest,
  type GoogleProfileAddressRequest,
  type GoogleProfileAddressResponse,
  type RegionOverviewResponse,
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
import { type Coordenada, nomeComparavel, ProcuraDeCoordenada } from './coordenada.js';
import { acimaDe, densidade, FONTES_DO_RETRATO, type LeituraGuardada, type NumeroGuardado, numeroMaisNovo, por10Mil, situacaoDaFonte, situacaoDoRetrato } from './raio-x.js';
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
  private readonly procura = new ProcuraDeCoordenada();

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
      delivery_area: { matched: 0, total: 0, population: null },
      city: null,
      generated_at: agora.toISOString(),
    };
    if (!(await this.ligada(auth, brandId))) {
      return { ...vazio, availability: { status: 'desligado_pela_liame' }, status: 'sem_endereco', district_status: 'sem_bairro', sources: [] };
    }
    const loja = (
      await tx.execute<{ address_district: string | null; address_city: string | null; address_state: string | null; ibge_city_code: string | null; delivery_areas: unknown }>(sql`
        select address_district, address_city, address_state, ibge_city_code, delivery_areas from liame.unit where id = ${unitId} and brand_id = ${brandId}`)
    ).rows[0];
    if (!loja) throw new AppProblem(404, 'loja-nao-encontrada', 'Não encontramos', 'Loja não encontrada nesta marca.');
    const cidade = loja.ibge_city_code;
    if (!cidade) return { ...vazio, availability: { status: 'disponivel' }, status: 'sem_endereco', district_status: 'sem_bairro', sources: [] };

    const leituras = (
      await tx.execute<LeituraGuardada>(sql`
        select source, geo_code, last_ok_at, last_error, next_try_at from liame.region_source_read
         where (source = ${FONTE_CENSO_BAIRRO} and geo_code = '0') or geo_code = ${cidade}`)
    ).rows;
    const fontes = FONTES_DO_RETRATO.map((f) => situacaoDaFonte(f, leituras.find((l) => l.source === f && l.geo_code === (f === FONTE_CENSO_BAIRRO ? '0' : cidade))));
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
    const chaves = [...new Set(areas.map((a) => nomeComparavel(a)))];
    const entrega = chaves.length
      ? (
          await tx.execute<{ casaram: number; pessoas: number | null }>(sql`
            select count(*)::int as casaram, sum(population)::int as pessoas from (
              select distinct on (name_key) name_key, population from liame.region_district
               where city_code = ${cidade} and name_key = any(array(select jsonb_array_elements_text(${JSON.stringify(chaves)}::jsonb)))
               order by name_key, population desc nulls last) b`)
        ).rows[0]
      : { casaram: 0, pessoas: null };

    const numeros = (
      await tx.execute<NumeroGuardado>(sql`
        select indicator, period, value::float8 as value, source from liame.region_fact where geo_level = 'municipio' and geo_code = ${cidade}`)
    ).rows;
    const populacao = numeroMaisNovo(numeros, 'populacao');
    const estimada = numeroMaisNovo(numeros, 'populacao_estimada');
    const restaurantes = numeroMaisNovo(numeros, 'restaurantes');
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
            head_income_mean: bairro.head_income_mean === null ? null : Number(bairro.head_income_mean),
            income_rank: posicao && posicao.total > 0 && posicao.tipica !== null ? { above_pct: acimaDe(posicao.abaixo, posicao.total), districts: posicao.total, typical_median: posicao.tipica } : null,
          }
        : null,
      delivery_area: { matched: entrega?.casaram ?? 0, total: chaves.length, population: entrega?.casaram ? (entrega.pessoas ?? null) : null },
      city: {
        code: cidade,
        name: loja.address_city ?? '',
        state: loja.address_state ?? '',
        population: populacao,
        density: numeroMaisNovo(numeros, 'densidade'),
        population_estimate: estimada,
        income_pc_median: numeroMaisNovo(numeros, 'renda_pc_mediana'),
        income_pc_mean: numeroMaisNovo(numeros, 'renda_pc_media'),
        restaurants: restaurantes,
        restaurants_per_10k: por10Mil(restaurantes?.value ?? null, (estimada ?? populacao)?.value ?? null),
      },
      sources: fontes,
      generated_at: agora.toISOString(),
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
