import type { MonthlyReportWeek } from '@liame/contracts';
import { type Database, uuidv7, withSystem } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ExplicarService } from '../ai/explicar/explicar.service.js';
import { respostaDaExplicacao } from '../ai/explicar/saida.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import { desligadoPelaEmpresa } from '../ai/registro/ativacao.js';
import type { ContextoDaLeitura } from '../ai/registro/leituras.js';
import { currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { RELATORIOS } from '../equipe/membros.js';
import { FlagService } from '../flags/flag.service.js';
import { proibidasDaMarca } from '../marca/marca.service.js';
import { MediaService } from '../media/media.service.js';
import { AtencaoCicloService } from '../results/atencao-ciclo.service.js';
import { diaNoFuso } from '../results/fora-do-normal.js';
import {
  comAtrasoMarcadoNoMes,
  type ConteudoDoRelatorio,
  diaDoRelatorio,
  HORA_DE_GERAR,
  HORA_DO_EMAIL,
  HORA_LIMITE,
  mesAnterior,
  mesCurto,
  mesEmDia,
  mesFechado,
  noPrazo,
  paraOMesQueVem,
  RELATORIO_VERSAO,
  semanaComNumeros,
  semanaNoContexto,
  semanasDoMes,
} from '../results/relatorio-mensal.js';
import { campanhasDaSemana, horaNoFuso, oQueMudou, soNaPlataforma, temAsFontes, temMovimento, totaisDaSemana } from '../results/revisao-semanal.js';
import { ResultsService } from '../results/results.service.js';

// O relatório do mês de uma marca (A3, I7; protótipo P24, decisões D-A3-18 a D-A3-22). Fica na pasta do worker
// porque grava em escopo de sistema, e só os jobs do worker podem (regra `liame-escopo-sistema`). No dia 1º de
// manhã, no fuso da loja:
//   1. lê, como a empresa, os resultados do mês que fechou na véspera, os do mês anterior e os de cada semana do
//      mês (cortada no mês), com os mesmos números da tela Resultados, e os avisos ativos;
//   2. pede a leitura do mês ao Explicar, sem transação aberta: a LIA, quando está ligada e os dados estão em dia;
//      senão, o resumo do sistema, com o motivo;
//   3. guarda o relatório como foi gerado, um por marca e mês.
// O envio por e-mail é outra rotina, que nasce desligada (`relatorio_email`). Nada é executado em plataforma nenhuma.

export type ResultadoDoRelatorio = {
  status: 'gerado' | 'ja_tem' | 'fora_do_prazo' | 'cedo' | 'aguardando_leitura' | 'sem_fontes' | 'sem_movimento' | 'desligado_pela_empresa';
  fuso: string;
  /** O dia 1º do mês olhado. */
  mes: string;
  /** No relatório gerado: o id e quem escreveu a leitura. */
  id?: string;
  leitura?: 'lia' | 'sistema';
};

@Injectable()
export class RelatorioMensalService {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly results: ResultsService,
    private readonly media: MediaService,
    private readonly ciclo: AtencaoCicloService,
    private readonly explicar: ExplicarService,
    private readonly flags: FlagService,
  ) {}

  /**
   * Gera o relatório do último mês fechado da marca, se ele ainda não existe, já é hora e o prazo não passou. O
   * relógio injetado vale para a operação inteira (V34).
   */
  async gerar(alvo: { tenantId: string; brandId: string }, agora = new Date()): Promise<ResultadoDoRelatorio> {
    if (!this.database) throw new Error('relatório do mês: sem banco');
    const { tenantId, brandId } = alvo;
    const ctx: ContextoDaLeitura = { tenantId, userId: null, permissions: 'sistema', agora };

    // ---- 1. leitura, como a empresa
    const lido = await naTransacaoDaEmpresa(this.database, { tenantId, userId: null }, async () => {
      const fuso = await this.results.fusoDaMarca(brandId);
      const hoje = diaNoFuso(agora, fuso);
      const mes = mesFechado(hoje);
      const base = { fuso, mes };
      const existe = await currentTx().execute(sql`select 1 from liame.monthly_report where brand_id = ${brandId} and month_from = ${mes.from}::date`);
      if (existe.rows.length) return { ...base, situacao: 'ja_tem' as const };
      // Passou do dia 7: o mês que fechou já não é notícia, e o próximo relatório é o do mês que está correndo.
      if (!noPrazo(hoje, mes)) return { ...base, situacao: 'fora_do_prazo' as const };
      // A empresa desligou o Relatórios nesta marca (I13b): o relatório não é gerado enquanto ele estiver desligado.
      if (await desligadoPelaEmpresa(currentTx(), { tenantId, brandId, agentKey: RELATORIOS })) return { ...base, situacao: 'desligado_pela_empresa' as const };
      // No dia 1º, ele espera a hora de gerar e, até a hora limite, a leitura que traz o último dia do mês inteiro.
      const ehODia = hoje === diaDoRelatorio(mes);
      const hora = horaNoFuso(agora, fuso);
      if (ehODia && hora < HORA_DE_GERAR) return { ...base, situacao: 'cedo' as const };
      const atual = await this.results.closedLoop({ brand_id: brandId, ...mes }, agora);
      if (!temAsFontes(atual.sources)) return { ...base, situacao: 'sem_fontes' as const };
      const mesAntes = await this.results.closedLoop({ brand_id: brandId, ...mesAnterior(mes) }, agora);
      if (!temMovimento(atual, mesAntes)) return { ...base, situacao: 'sem_movimento' as const };
      const emDia = mesEmDia(atual.sources, mes, fuso);
      if (!emDia && ehODia && hora < HORA_LIMITE) return { ...base, situacao: 'aguardando_leitura' as const };
      // Sem nada no mês anterior não há com o que comparar.
      const anterior = temMovimento(mesAntes, null) ? mesAntes : null;
      // Cada semana do mês, cortada no mês, com os números dos dias dela; e se a revisão da semana inteira existe.
      const doMes = semanasDoMes(mes);
      const r = await currentTx().execute<{ week_from: string }>(sql`
        select week_from::text as week_from from liame.weekly_review
         where brand_id = ${brandId} and week_from between ${doMes[0]!.week.from}::date and ${doMes.at(-1)!.week.from}::date`);
      const comRevisao = new Set(r.rows.map((l) => l.week_from));
      const semanas: MonthlyReportWeek[] = [];
      for (const s of doMes) semanas.push(semanaComNumeros(s, await this.results.closedLoop({ brand_id: brandId, from: s.from, to: s.to }, agora), comRevisao.has(s.week.from)));
      const avisos = [...(await this.media.atencao(brandId, agora)).items, ...(await this.ciclo.atencao(brandId, agora)).items];
      const ativo = await this.explicar.analistaLigado(ctx, brandId);
      // O que a marca nunca diz (dossiê, I8): a leitura da LIA passa pela mesma conferência do Explicar.
      const daMarca = await proibidasDaMarca(brandId);
      return { ...base, situacao: 'gerar' as const, atual, anterior, emDia, semanas, avisos, ativo, daMarca };
    });
    if (lido.situacao !== 'gerar') return { status: lido.situacao, fuso: lido.fuso, mes: lido.mes.from };
    const { fuso, mes, atual, anterior, semanas } = lido;

    // ---- 2. a leitura do mês, sem transação aberta (é a chamada ao modelo, quando a LIA está ligada)
    const leitura = await this.explicar.doMes(ctx, brandId, {
      atual: lido.emDia ? atual : comAtrasoMarcadoNoMes(atual, mes, fuso),
      anterior,
      semanas: semanas.map((s) => semanaNoContexto(s, atual.currency)),
      mesAnterior: mesCurto(mesAnterior(mes)),
      ativo: lido.ativo,
      daMarca: lido.daMarca,
    });

    // ---- 3. o relatório, como a tela e o e-mail vão mostrar
    const { improved, worsened } = oQueMudou(atual, anterior);
    const conteudo: ConteudoDoRelatorio = {
      brand_id: brandId,
      month: mes,
      previous_month: mesAnterior(mes),
      timezone: fuso,
      currency: atual.currency,
      generated_at: agora.toISOString(),
      totals: totaisDaSemana(atual, anterior),
      verdict: atual.totals.confirmed.verdict,
      weeks: semanas,
      campaigns: campanhasDaSemana(atual),
      platform_only: soNaPlataforma(atual),
      improved,
      worsened,
      decisions: paraOMesQueVem(atual, lido.avisos, brandId, mes),
      reading: respostaDaExplicacao(leitura),
    };

    // ---- 4. gravação, em escopo de sistema: um relatório por marca e mês
    const comEmail = await this.flags.isEnabled('relatorio_email', this.flags.context({ tenantId, brandId }));
    const id = uuidv7();
    const instante = agora.toISOString();
    const gravado = await withSystem(this.database.db, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into liame.monthly_report
          (id, tenant_id, brand_id, month_from, month_to, timezone, generated_at, reading_source, reading_reason, usage_id, content, content_version, email_status, email_next_at)
        values (${id}, ${tenantId}, ${brandId}, ${mes.from}::date, ${mes.to}::date, ${fuso}, ${instante}::timestamptz,
                ${conteudo.reading.source}, ${conteudo.reading.reason}, ${conteudo.reading.usage_id}, ${JSON.stringify(conteudo)}::jsonb, ${RELATORIO_VERSAO},
                ${comEmail ? 'pendente' : 'desligado'},
                ${comEmail ? sql`greatest(${instante}::timestamptz, ((${diaDoRelatorio(mes)}::date + make_interval(hours => ${HORA_DO_EMAIL})) at time zone ${fuso}))` : sql`null`})
        on conflict (brand_id, month_from) do nothing
        returning id`),
    );
    // Outro worker gravou o mesmo mês no meio do caminho: vale o dele.
    if (!gravado.rows.length) return { status: 'ja_tem', fuso, mes: mes.from };
    return { status: 'gerado', fuso, mes: mes.from, id, leitura: conteudo.reading.source === 'lia' ? 'lia' : 'sistema' };
  }
}
