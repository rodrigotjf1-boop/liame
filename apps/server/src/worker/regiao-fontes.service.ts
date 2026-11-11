import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DATABASE } from '../database/database.module.js';
import { ARQUIVO_BASICO, ARQUIVO_RENDA, type BairroDoCenso, baixarDoCenso, bairrosDoBasico, csvDoZip, FONTE_CENSO_BAIRRO, juntarRenda } from '../regiao/censo.js';
import {
  buscarAgregado,
  buscarJson,
  ENDERECO_DAS_RMS,
  enderecoDoAgregado,
  enderecoDoPix,
  FONTE_DA_RM,
  FONTE_DO_PIX,
  HOST_DO_BCB,
  HOST_DO_IBGE,
  LEITURAS_DO_MUNICIPIO,
  lugarDaLeitura,
  type NumeroDoIbge,
  numerosDaResposta,
  numerosDoPix,
  rmDoMunicipio,
} from '../regiao/ibge.js';

// Os números da região (plano da região, R2, parte 1; migration 0137): a rotina da distribuição que lê as fontes
// públicas e guarda nas tabelas do sistema (padrão da PTAX, D-RG-1). Duas coisas:
//   - os bairros do Censo 2022 (dois arquivos do IBGE), uma vez: entram e não mudam até o próximo Censo;
//   - os números de cada município com loja no mapa (as tabelas da API de agregados), cada fonte no seu prazo.
// Cada leitura é reservada antes (a linha da `region_source_read` com a próxima vez adiante), numa transação curta; o
// IBGE é chamado fora de transação; e o resultado é gravado numa transação curta. Falha guarda o motivo e tenta de novo
// em 1 hora (os arquivos do Censo, em 6 horas). Nenhum dado de empresa sai daqui: o IBGE recebe só o código do município.

/** A reserva de uma leitura: se o worker cair no meio, ela volta para a fila depois disto. */
const RESERVA_MIN = 30;
const NOVA_TENTATIVA_MIN = 60;
const NOVA_TENTATIVA_DO_CENSO_MIN = 6 * 60;
/** O Censo não muda: a leitura feita fica valendo até o próximo (a linha some se a tabela for limpa). */
const CENSO_VALE_DIAS = 3650;
/** Quantos bairros por instrução ao gravar (17,5 mil no Brasil: 9 instruções). */
const BAIRROS_POR_LOTE = 2000;

export interface LeituraFeita {
  fonte: string;
  lugar: string;
  situacao: 'lida' | 'falhou';
  motivo?: string;
}

const minutos = (agora: Date, m: number) => new Date(agora.getTime() + m * 60_000).toISOString();

function motivoDa(err: unknown): string {
  const m = err instanceof Error ? err.message : 'erro desconhecido';
  return (err instanceof Error && err.name === 'TimeoutError' ? 'o IBGE não respondeu a tempo' : m).slice(0, 300);
}

@Injectable()
export class RegiaoFontesService {
  private readonly logger = new Logger('regiao-fontes');

  constructor(@Inject(DATABASE) private readonly database: Database | null) {}

  /**
   * Uma volta: os bairros do Censo (se ainda não entraram) e até `n` leituras de município devidas. `buscar` troca a
   * rede nos testes; o relógio injetado vale para a volta inteira (V34).
   */
  async executarLote(n: number, agora: Date = new Date(), buscar: typeof fetch = fetch): Promise<LeituraFeita[]> {
    if (!this.database) return [];
    const feitas: LeituraFeita[] = [];
    const censo = await this.lerCensoSeDevido(agora, buscar);
    if (censo) feitas.push(censo);
    feitas.push(...(await this.lerMunicipios(n, agora, buscar)));
    if (feitas.length) {
      const falhas = feitas.filter((f) => f.situacao === 'falhou');
      this.logger.log(`região: ${feitas.length - falhas.length} leitura(s) feita(s)${falhas.length ? `, ${falhas.length} falharam (${falhas.map((f) => `${f.fonte}/${f.lugar}: ${f.motivo}`).join('; ')})` : ''}`);
    }
    return feitas;
  }

  /** Reserva a leitura (fonte, lugar) se ela estiver devida; devolve se ficou com ela. */
  private async reservar(fonte: string, lugar: string, agora: Date, soSemSucesso = false): Promise<boolean> {
    return withSystem(this.database!.db, async (tx) => {
      const r = await tx.execute(sql`
        insert into liame.region_source_read (source, geo_code, last_try_at, next_try_at)
        values (${fonte}, ${lugar}, ${agora.toISOString()}::timestamptz, ${minutos(agora, RESERVA_MIN)}::timestamptz)
        on conflict (source, geo_code) do update
           set last_try_at = excluded.last_try_at, next_try_at = excluded.next_try_at
         where liame.region_source_read.next_try_at <= ${agora.toISOString()}::timestamptz
           ${soSemSucesso ? sql`and liame.region_source_read.last_ok_at is null` : sql``}
        returning source`);
      return (r.rowCount ?? 0) > 0;
    });
  }

  private async registrar(fonte: string, lugar: string, agora: Date, resultado: { ok: true; validaAte: string } | { ok: false; motivo: string; proxima: string }): Promise<void> {
    await withSystem(this.database!.db, async (tx) => {
      if (resultado.ok) {
        await tx.execute(sql`
          update liame.region_source_read
             set last_ok_at = ${agora.toISOString()}::timestamptz, last_error = null, next_try_at = ${resultado.validaAte}::timestamptz
           where source = ${fonte} and geo_code = ${lugar}`);
      } else {
        await tx.execute(sql`
          update liame.region_source_read set last_error = ${resultado.motivo}, next_try_at = ${resultado.proxima}::timestamptz
           where source = ${fonte} and geo_code = ${lugar}`);
      }
    });
  }

  /** Os bairros do Censo: uma vez (a reserva só pega a fonte que nunca deu certo). */
  private async lerCensoSeDevido(agora: Date, buscar: typeof fetch): Promise<LeituraFeita | null> {
    if (!(await this.reservar(FONTE_CENSO_BAIRRO, '0', agora, true))) return null;
    try {
      const bairros = bairrosDoBasico(csvDoZip(await baixarDoCenso(ARQUIVO_BASICO, 60_000, buscar)));
      juntarRenda(bairros, csvDoZip(await baixarDoCenso(ARQUIVO_RENDA, 60_000, buscar)));
      if (bairros.size < 1000) throw new Error(`o arquivo do Censo veio com ${bairros.size} bairros`);
      await this.gravarBairros([...bairros.values()], agora);
      await this.registrar(FONTE_CENSO_BAIRRO, '0', agora, { ok: true, validaAte: minutos(agora, CENSO_VALE_DIAS * 24 * 60) });
      return { fonte: FONTE_CENSO_BAIRRO, lugar: '0', situacao: 'lida' };
    } catch (err) {
      const motivo = motivoDa(err);
      await this.registrar(FONTE_CENSO_BAIRRO, '0', agora, { ok: false, motivo, proxima: minutos(agora, NOVA_TENTATIVA_DO_CENSO_MIN) });
      return { fonte: FONTE_CENSO_BAIRRO, lugar: '0', situacao: 'falhou', motivo };
    }
  }

  /** Grava os bairros em lotes, numa transação (uma instrução por lote, set-based). */
  private async gravarBairros(bairros: BairroDoCenso[], agora: Date): Promise<void> {
    await withSystem(this.database!.db, async (tx) => {
      for (let i = 0; i < bairros.length; i += BAIRROS_POR_LOTE) {
        const lote = bairros.slice(i, i + BAIRROS_POR_LOTE).map((b) => ({
          codigo: b.codigo,
          municipio: b.municipio,
          nome: b.nome,
          chave: b.chave,
          area: b.areaKm2,
          pessoas: b.pessoas,
          domicilios: b.domicilios,
          media: b.rendaMedia,
          mediana: b.rendaMediana,
        }));
        await tx.execute(sql`
          insert into liame.region_district (district_code, city_code, name, name_key, area_km2, population, households, head_income_mean, head_income_median, loaded_at)
          select x.codigo, x.municipio, x.nome, x.chave, x.area, x.pessoas, x.domicilios, x.media, x.mediana, ${agora.toISOString()}::timestamptz
            from jsonb_to_recordset(${JSON.stringify(lote)}::jsonb)
                 as x (codigo text, municipio text, nome text, chave text, area numeric, pessoas integer, domicilios integer, media numeric, mediana numeric)
          on conflict (district_code) do update
             set city_code = excluded.city_code, name = excluded.name, name_key = excluded.name_key, area_km2 = excluded.area_km2,
                 population = excluded.population, households = excluded.households, head_income_mean = excluded.head_income_mean,
                 head_income_median = excluded.head_income_median, loaded_at = excluded.loaded_at`);
      }
    });
  }

  /** As leituras devidas entre os pares (fonte, lugar) pedidos, a mais atrasada primeiro, até `n` (uma consulta só). */
  private async devidas(pares: Array<{ fonte: string; lugar: string }>, n: number, agora: Date): Promise<Array<{ fonte: string; lugar: string }>> {
    if (!pares.length || n <= 0) return [];
    return withSystem(this.database!.db, async (tx) =>
      (
        await tx.execute<{ fonte: string; lugar: string }>(sql`
          select p.fonte, p.lugar
            from jsonb_to_recordset(${JSON.stringify(pares)}::jsonb) as p (fonte text, lugar text)
            left join liame.region_source_read r on r.source = p.fonte and r.geo_code = p.lugar
           where r.source is null or r.next_try_at <= ${agora.toISOString()}::timestamptz
           order by r.next_try_at nulls first, p.lugar, p.fonte
           limit ${n}`)
      ).rows,
    );
  }

  private async gravarNumeros(nivel: string, lugar: string, fonte: string, numeros: NumeroDoIbge[], agora: Date): Promise<void> {
    await withSystem(this.database!.db, async (tx) => {
      await tx.execute(sql`
        insert into liame.region_fact (geo_level, geo_code, indicator, period, value, source, fetched_at)
        select ${nivel}, ${lugar}, x.indicador, x.periodo, x.valor, ${fonte}, ${agora.toISOString()}::timestamptz
          from jsonb_to_recordset(${JSON.stringify(numeros)}::jsonb) as x (indicador text, periodo text, valor numeric)
        on conflict (geo_level, geo_code, indicator, period) do update
           set value = excluded.value, source = excluded.source, fetched_at = excluded.fetched_at`);
    });
  }

  /** Lê uma fonte já reservada: grava os números e registra a leitura (a falha guarda o motivo e tenta de novo em 1 hora). */
  private async lerUma(fonte: string, lugar: string, nivel: string, renovaDias: number, agora: Date, ler: () => Promise<NumeroDoIbge[]>): Promise<LeituraFeita> {
    try {
      const numeros = await ler();
      if (!numeros.length) throw new Error('a fonte não trouxe o número deste lugar');
      await this.gravarNumeros(nivel, lugar, fonte, numeros, agora);
      await this.registrar(fonte, lugar, agora, { ok: true, validaAte: minutos(agora, renovaDias * 24 * 60) });
      return { fonte, lugar, situacao: 'lida' };
    } catch (err) {
      const motivo = motivoDa(err);
      await this.registrar(fonte, lugar, agora, { ok: false, motivo, proxima: minutos(agora, NOVA_TENTATIVA_MIN) });
      return { fonte, lugar, situacao: 'falhou', motivo };
    }
  }

  /**
   * As leituras devidas dos municípios com loja no mapa, até `n`: (1) a região metropolitana de cada município (a lista
   * das RMs do IBGE, uma vez por volta); (2) as tabelas de cada recorte (município, UF, capital, RM e Brasil, cada par
   * fonte × lugar uma vez só, mesmo com várias lojas) e o Pix do município.
   */
  private async lerMunicipios(n: number, agora: Date, buscar: typeof fetch): Promise<LeituraFeita[]> {
    const municipios = await withSystem(this.database!.db, async (tx) =>
      (
        await tx.execute<{ municipio: string; rm: string | null }>(sql`
          select m.municipio,
                 (select f.value::bigint::text from liame.region_fact f
                   where f.geo_level = 'municipio' and f.geo_code = m.municipio and f.indicator = 'rm_pnad'
                   order by f.period desc limit 1) as rm
            from (select distinct u.ibge_city_code as municipio from liame.unit u where u.ibge_city_code is not null) m`)
      ).rows,
    );
    if (!municipios.length) return [];
    const feitas: LeituraFeita[] = [];
    let resta = n;

    // (1) A RM de cada município (o valor 0 é "fora de RM da PNAD", para não ler de novo antes do prazo).
    const rmsDevidas = await this.devidas(
      municipios.map((m) => ({ fonte: FONTE_DA_RM, lugar: m.municipio })),
      resta,
      agora,
    );
    let listaDasRms: unknown = null;
    for (const d of rmsDevidas) {
      if (!(await this.reservar(d.fonte, d.lugar, agora))) continue;
      const ano = agora.toISOString().slice(0, 4);
      feitas.push(
        await this.lerUma(FONTE_DA_RM, d.lugar, 'municipio', 180, agora, async () => {
          listaDasRms ??= await buscarJson(ENDERECO_DAS_RMS, [HOST_DO_IBGE], 20_000, buscar);
          const rm = rmDoMunicipio(listaDasRms, d.lugar);
          const m = municipios.find((x) => x.municipio === d.lugar);
          if (m) m.rm = rm;
          return [{ indicador: 'rm_pnad', periodo: ano, valor: rm ? Number(rm) : 0 }];
        }),
      );
      resta--;
    }

    // (2) As tabelas de cada recorte e o Pix, sem repetir o mesmo par (a UF e o Brasil valem para vários municípios).
    type Par = { fonte: string; lugar: string; nivel: string; ler: () => Promise<NumeroDoIbge[]>; renovaDias: number };
    const pares = new Map<string, Par>();
    const mesCorrente = mesEmBrasilia(agora);
    for (const m of municipios) {
      const rm = m.rm && m.rm !== '0' ? m.rm : null;
      for (const l of LEITURAS_DO_MUNICIPIO) {
        const lugar = lugarDaLeitura(l, m.municipio, rm);
        if (!lugar) continue;
        const chave = `${l.fonte}:${lugar.codigo}`;
        if (pares.has(chave)) continue;
        pares.set(chave, {
          fonte: l.fonte,
          lugar: lugar.codigo,
          nivel: lugar.nivel,
          renovaDias: l.renovaDias,
          ler: async () => numerosDaResposta(await buscarAgregado(enderecoDoAgregado(l, lugar), 15_000, buscar), l, lugar.codigo),
        });
      }
      pares.set(`${FONTE_DO_PIX}:${m.municipio}`, {
        fonte: FONTE_DO_PIX,
        lugar: m.municipio,
        nivel: 'municipio',
        renovaDias: 7,
        ler: async () => numerosDoPix(await buscarJson(enderecoDoPix(m.municipio, mesesAntes(mesCorrente, 13)), [HOST_DO_BCB], 20_000, buscar), m.municipio, mesCorrente),
      });
    }
    for (const d of await this.devidas([...pares.values()].map((p) => ({ fonte: p.fonte, lugar: p.lugar })), resta, agora)) {
      const par = pares.get(`${d.fonte}:${d.lugar}`);
      if (!par || !(await this.reservar(d.fonte, d.lugar, agora))) continue;
      feitas.push(await this.lerUma(par.fonte, par.lugar, par.nivel, par.renovaDias, agora, par.ler));
    }
    return feitas;
  }
}

/** O mês corrente em Brasília, "AAAAMM". */
export function mesEmBrasilia(agora: Date): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(agora);
  return `${p.find((x) => x.type === 'year')!.value}${p.find((x) => x.type === 'month')!.value}`;
}

/** O mês "AAAAMM" `k` meses antes. */
export function mesesAntes(anoMes: string, k: number): string {
  const total = Number(anoMes.slice(0, 4)) * 12 + Number(anoMes.slice(4)) - 1 - k;
  return `${Math.floor(total / 12)}${String((total % 12) + 1).padStart(2, '0')}`;
}
