import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';
import { FONTE_CENSO_BAIRRO } from '../regiao/censo.js';
import {
  baixarMunicipiosDaReceita,
  type BairroDe,
  ContagemDoCnpj,
  ENDERECO_DOS_MUNICIPIOS_DO_IBGE,
  enderecoDoArquivo,
  equivalenciaDeMunicipios,
  FONTE_DO_CNPJ,
  inicioDaJanela,
  type LinhaDeContagem,
  lerArquivoDoCnpj,
  PARTES_DO_CNPJ,
  ultimoMesCompleto,
} from '../regiao/cnpj.js';
import { buscarJson, HOST_DO_IBGE } from '../regiao/ibge.js';

// Os restaurantes ativos pelo CNPJ da Receita (plano da região, R2, parte 4; migration 0141): a rotina da distribuição
// que lê o retrato do mês (10 arquivos, ≈ 5,4 GB zipados) e guarda só contagens. Uma leitura por vez em toda a
// distribuição: a linha (`receita_cnpj`, `0`) da `region_source_read` é a reserva, estendida enquanto o arquivo desce
// (o worker que cai deixa a reserva vencer em 20 minutos). Cada volta lê UM arquivo e guarda a contagem dele na
// `region_food_part`; quando os 10 do mês entraram, somam-se na `region_food_count` numa transação (o retrato troca
// inteiro) e a próxima conferência fica para 12 horas depois. Só lê com loja no mapa e com os bairros do Censo já lidos
// (o bairro da contagem é o código do bairro do Censo).

const LEITURA = '0';
const RESERVA_MIN = 20;
const NOVA_TENTATIVA_MIN = 60;
const CONFERE_DE_NOVO_MIN = 12 * 60;
const ESTENDE_A_CADA_MS = 2 * 60_000;
const LINHAS_POR_LOTE = 2000;
/** O mês novo com menos ativos que isto do anterior não troca o retrato (arquivo da Receita com defeito). */
const MINIMO_DO_ANTERIOR = 0.8;

const minutos = (agora: Date, m: number) => new Date(agora.getTime() + m * 60_000).toISOString();

export interface VoltaDoCnpj {
  situacao: 'nada' | 'em_dia' | 'arquivo_lido' | 'retrato_trocado' | 'falhou';
  mes?: string;
  parte?: number;
  motivo?: string;
}

@Injectable()
export class RegiaoCnpjService {
  private readonly logger = new Logger('regiao-cnpj');

  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  /** Uma volta. `buscar` troca a rede nos testes; o relógio injetado vale para a volta inteira (V34). */
  async executar(agora: Date = new Date(), buscar: typeof fetch = fetch): Promise<VoltaDoCnpj> {
    if (!this.database) return { situacao: 'nada' };
    const pronto = await withSystem(this.database.db, async (tx) => (
      await tx.execute<{ lojas: boolean; censo: boolean }>(sql`
        select exists (select 1 from liame.unit where ibge_city_code is not null) as lojas,
               exists (select 1 from liame.region_source_read where source = ${FONTE_CENSO_BAIRRO} and last_ok_at is not null) as censo`)
    ).rows[0]);
    if (!pronto?.lojas || !pronto.censo) return { situacao: 'nada' };
    if (!(await this.reservar(agora))) return { situacao: 'nada' };

    let mes: string;
    try {
      mes = await ultimoMesCompleto(buscar);
    } catch (err) {
      return this.falhou(agora, motivoDa(err));
    }
    const atual = await withSystem(this.database.db, async (tx) => (await tx.execute<{ mes: string | null }>(sql`select max(period) as mes from liame.region_food_count`)).rows[0]?.mes ?? null);
    if (atual === mes) {
      await this.registrarOk(agora);
      return { situacao: 'em_dia', mes };
    }

    // O mês em leitura é sempre o mais novo: o que sobrou de um mês anterior sai.
    const feitas = await withSystem(this.database.db, async (tx) => {
      await tx.execute(sql`delete from liame.region_food_part where period <> ${mes}`);
      return (await tx.execute<{ part: number }>(sql`select distinct part from liame.region_food_part where period = ${mes}`)).rows.map((r) => Number(r.part));
    });
    const parte = [...Array(PARTES_DO_CNPJ).keys()].find((p) => !feitas.includes(p));
    if (parte !== undefined) {
      try {
        await this.lerParte(mes, parte, agora, buscar);
      } catch (err) {
        return this.falhou(agora, `arquivo ${parte + 1} de ${PARTES_DO_CNPJ}: ${motivoDa(err)}`);
      }
      if (feitas.length + 1 < PARTES_DO_CNPJ) {
        await this.liberar(agora);
        return { situacao: 'arquivo_lido', mes, parte };
      }
    }
    try {
      await this.juntar(mes, agora);
    } catch (err) {
      return this.falhou(agora, motivoDa(err), CONFERE_DE_NOVO_MIN);
    }
    await this.registrarOk(agora);
    this.logger.log(`região: os restaurantes do CNPJ de ${mes} entraram`);
    return { situacao: 'retrato_trocado', mes };
  }

  private async lerParte(mes: string, parte: number, agora: Date, buscar: typeof fetch): Promise<void> {
    const municipioDe = equivalenciaDeMunicipios(await baixarMunicipiosDaReceita(mes, buscar), await buscarJson(ENDERECO_DOS_MUNICIPIOS_DO_IBGE, [HOST_DO_IBGE], 60_000, buscar));
    const contagem = new ContagemDoCnpj(inicioDaJanela(mes), municipioDe, await this.bairros());
    const inicio = Date.now();
    let estendida = inicio;
    await lerArquivoDoCnpj(enderecoDoArquivo(mes, parte), contagem, {
      buscar,
      aoAvancar: async () => {
        if (Date.now() - estendida < ESTENDE_A_CADA_MS) return;
        estendida = Date.now();
        await this.estender(new Date(agora.getTime() + (estendida - inicio)));
      },
    });
    const e = contagem.estatistica;
    if (e.linhas > 0 && e.foraDoFormato > e.linhas * 0.01) throw new Error(`${e.foraDoFormato} linhas fora do formato`);
    await this.gravarParte(mes, parte, contagem.linhas());
    this.logger.log(
      `região: CNPJ ${mes}, arquivo ${parte + 1} de ${PARTES_DO_CNPJ}: ${e.linhas} estabelecimentos de comida, ${e.ativos} ativos, ${e.ativosComBairro} com bairro do Censo, ${e.semMunicipio} sem município no IBGE, ${e.foraDoFormato} fora do formato (${Math.round((Date.now() - inicio) / 1000)} s)`,
    );
  }

  /** Os bairros do Censo de todo o Brasil: município → nome comparável → código (o mais populoso, se o nome repete). */
  private async bairros(): Promise<BairroDe> {
    const linhas = await withSystem(this.database!.db, async (tx) =>
      (
        await tx.execute<{ city_code: string; name_key: string; district_code: string }>(sql`
          select distinct on (city_code, name_key) city_code, name_key, district_code from liame.region_district
           order by city_code, name_key, population desc nulls last, district_code`)
      ).rows,
    );
    const porMunicipio = new Map<string, Map<string, string>>();
    for (const l of linhas) {
      let m = porMunicipio.get(l.city_code);
      if (!m) porMunicipio.set(l.city_code, (m = new Map()));
      m.set(l.name_key, l.district_code);
    }
    return (municipio, chave) => porMunicipio.get(municipio)?.get(chave) ?? null;
  }

  /** A contagem de um arquivo: troca a que houver dele no mês, em lotes, numa transação. */
  private async gravarParte(mes: string, parte: number, linhas: LinhaDeContagem[]): Promise<void> {
    // Cada arquivo da Receita tem dezenas de milhares de estabelecimentos de comida: nenhum é defeito, não "arquivo lido".
    if (!linhas.length) throw new Error('o arquivo não trouxe nenhum estabelecimento de comida');
    await withSystem(this.database!.db, async (tx) => {
      await tx.execute(sql`delete from liame.region_food_part where period = ${mes} and part = ${parte}`);
      for (let i = 0; i < linhas.length; i += LINHAS_POR_LOTE) {
        const lote = linhas.slice(i, i + LINHAS_POR_LOTE).map((l) => ({ m: l.municipio, t: l.tipo, k: l.chave, v: l.contagem }));
        await tx.execute(sql`
          insert into liame.region_food_part (period, part, geo_code, area_kind, area_key, active, active_restaurant, active_snack, active_bar, active_home, opened_12m, closed_12m)
          select ${mes}, ${parte}, x.m, x.t, x.k, (x.v->>0)::int, (x.v->>1)::int, (x.v->>2)::int, (x.v->>3)::int, (x.v->>4)::int, (x.v->>5)::int, (x.v->>6)::int
            from jsonb_to_recordset(${JSON.stringify(lote)}::jsonb) as x (m text, t text, k text, v jsonb)`);
      }
    });
  }

  /** Os 10 arquivos do mês somados viram o retrato (troca inteiro), na mesma transação que limpa os arquivos. */
  private async juntar(mes: string, agora: Date): Promise<void> {
    await withSystem(this.database!.db, async (tx) => {
      await tx.execute(sql`select 1 from liame.region_source_read where source = ${FONTE_DO_CNPJ} and geo_code = ${LEITURA} for update`);
      const novo = (
        await tx.execute<{ partes: number; ativos: number }>(sql`
          select count(distinct part)::int as partes, coalesce(sum(active) filter (where area_kind = 'municipio'), 0)::int as ativos
            from liame.region_food_part where period = ${mes}`)
      ).rows[0]!;
      if (novo.partes < PARTES_DO_CNPJ) throw new Error(`o mês ${mes} tem ${novo.partes} de ${PARTES_DO_CNPJ} arquivos`);
      const anterior = (await tx.execute<{ ativos: number }>(sql`select coalesce(sum(active), 0)::int as ativos from liame.region_food_count where area_kind = 'municipio'`)).rows[0]!.ativos;
      if (anterior > 0 && novo.ativos < anterior * MINIMO_DO_ANTERIOR) {
        throw new Error(`o mês ${mes} veio com ${novo.ativos} ativos, menos de ${MINIMO_DO_ANTERIOR * 100}% dos ${anterior} do retrato atual`);
      }
      await tx.execute(sql`delete from liame.region_food_count`);
      await tx.execute(sql`
        insert into liame.region_food_count (geo_code, area_kind, area_key, period, active, active_restaurant, active_snack, active_bar, active_home, opened_12m, closed_12m, loaded_at)
        select geo_code, area_kind, area_key, period, sum(active), sum(active_restaurant), sum(active_snack), sum(active_bar), sum(active_home), sum(opened_12m), sum(closed_12m), ${agora.toISOString()}::timestamptz
          from liame.region_food_part where period = ${mes}
         group by geo_code, area_kind, area_key, period`);
      await tx.execute(sql`delete from liame.region_food_part where period = ${mes}`);
    });
  }

  /** Fica com a leitura se ela estiver devida (uma por vez em toda a distribuição). */
  private async reservar(agora: Date): Promise<boolean> {
    return withSystem(this.database!.db, async (tx) => {
      const r = await tx.execute(sql`
        insert into liame.region_source_read (source, geo_code, last_try_at, next_try_at)
        values (${FONTE_DO_CNPJ}, ${LEITURA}, ${agora.toISOString()}::timestamptz, ${minutos(agora, RESERVA_MIN)}::timestamptz)
        on conflict (source, geo_code) do update
           set last_try_at = excluded.last_try_at, next_try_at = excluded.next_try_at
         where liame.region_source_read.next_try_at <= ${agora.toISOString()}::timestamptz
        returning source`);
      return (r.rowCount ?? 0) > 0;
    });
  }

  /** Empurra a reserva enquanto o arquivo desce. */
  private async estender(agora: Date): Promise<void> {
    await withSystem(this.database!.db, async (tx) => {
      await tx.execute(sql`update liame.region_source_read set next_try_at = ${minutos(agora, RESERVA_MIN)}::timestamptz where source = ${FONTE_DO_CNPJ} and geo_code = ${LEITURA}`);
    });
  }

  /** Arquivo lido e o mês ainda não acabou: a próxima volta já pode ler o seguinte. */
  private async liberar(agora: Date): Promise<void> {
    await withSystem(this.database!.db, async (tx) => {
      await tx.execute(sql`update liame.region_source_read set next_try_at = ${agora.toISOString()}::timestamptz, last_error = null where source = ${FONTE_DO_CNPJ} and geo_code = ${LEITURA}`);
    });
  }

  private async registrarOk(agora: Date): Promise<void> {
    await withSystem(this.database!.db, async (tx) => {
      await tx.execute(sql`
        update liame.region_source_read
           set last_ok_at = ${agora.toISOString()}::timestamptz, last_error = null, next_try_at = ${minutos(agora, CONFERE_DE_NOVO_MIN)}::timestamptz
         where source = ${FONTE_DO_CNPJ} and geo_code = ${LEITURA}`);
    });
  }

  private async falhou(agora: Date, motivo: string, proximaMin = NOVA_TENTATIVA_MIN): Promise<VoltaDoCnpj> {
    await withSystem(this.database!.db, async (tx) => {
      await tx.execute(sql`
        update liame.region_source_read set last_error = ${motivo.slice(0, 300)}, next_try_at = ${minutos(agora, proximaMin)}::timestamptz
         where source = ${FONTE_DO_CNPJ} and geo_code = ${LEITURA}`);
    });
    this.logger.warn(`região: a leitura do CNPJ da Receita falhou (tenta de novo em ${proximaMin} min): ${motivo}`);
    return { situacao: 'falhou', motivo };
  }
}

function motivoDa(err: unknown): string {
  const m = err instanceof Error ? err.message : 'erro desconhecido';
  return (err instanceof Error && err.name === 'TimeoutError' ? 'a Receita não respondeu a tempo' : m).slice(0, 300);
}
