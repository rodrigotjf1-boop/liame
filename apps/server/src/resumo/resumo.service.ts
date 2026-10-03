import type { SummaryResponse } from '@liame/contracts';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DIAS_DO_AVISO } from '../ai/explicar/aviso.js';
import { periodoAnterior } from '../ai/explicar/contexto.js';
import { type AuthContext, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { MediaService } from '../media/media.service.js';
import { AtencaoCicloService } from '../results/atencao-ciclo.service.js';
import { diaNoFuso, menosDias } from '../results/fora-do-normal.js';
import { ResultsService } from '../results/results.service.js';
import { avisosQuePrecisam, campanhasDoVeredito, dinheiroDoResumo, pedidosDoResumo, plataformasDoResumo } from './resumo.js';

// O Resumo (A3, I13c; protótipo P8, aguardando aprovação; sem tela ainda): a página inicial do Lite, numa chamada. Na
// requisição, sob a RLS da empresa, com os mesmos serviços das rotas de Resultados e da Atenção (os mesmos números
// e os mesmos avisos). Nada é calculado pela IA.

@Injectable()
export class ResumoService {
  constructor(
    private readonly resultados: ResultsService,
    private readonly media: MediaService,
    private readonly ciclo: AtencaoCicloService,
  ) {}

  async ver(auth: AuthContext, brandId: string, agora = new Date()): Promise<SummaryResponse> {
    if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
    const tx = currentTx();
    const marca = await tx.execute(sql`select 1 from liame.brand where id = ${brandId} and archived_at is null`);
    if (!marca.rows[0]) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Marca não encontrada nesta empresa.');

    // Os últimos 7 dias completos no fuso da loja, como o Explicar de um aviso, e os 7 antes.
    const fuso = await this.resultados.fusoDaMarca(brandId);
    const hoje = diaNoFuso(agora, fuso);
    const periodo = { from: menosDias(hoje, DIAS_DO_AVISO), to: menosDias(hoje, 1) };
    const antes = periodoAnterior(periodo.from, periodo.to);
    const atual = await this.resultados.closedLoop({ brand_id: brandId, ...periodo }, agora);
    const anterior = await this.resultados.closedLoop({ brand_id: brandId, ...antes }, agora);

    // A situação: sem loja do Regem não há vendas; com as contas conectadas depois do começo do período, é a primeira semana.
    const contas = (
      await tx.execute<{ regem: number; primeira: Date | string | null; inicio: Date | string }>(sql`
        select (count(*) filter (where provider = 'regem'))::int as regem, min(created_at) as primeira,
               (${periodo.from}::date::timestamp at time zone ${fuso}) as inicio
          from liame.connected_account
         where brand_id = ${brandId} and disconnected_at is null and provider in ('regem', 'meta_ads', 'google_ads')`)
    ).rows[0]!;
    const state =
      Number(contas.regem) === 0 ? 'sem_regem' : contas.primeira !== null && new Date(contas.primeira) > new Date(contas.inicio) ? 'primeira_semana' : 'ok';

    // O que precisa da pessoa: os avisos (os de mídia só para quem acompanha as campanhas) e o que espera decisão.
    const midia = auth.permissions.has('campanhas.ver') ? (await this.media.atencao(brandId, agora)).items : [];
    const doCiclo = (await this.ciclo.atencao(brandId, agora)).items;
    const pendentes = (
      await tx.execute<{ acoes: number; planos: number; autonomia: number }>(sql`
        select (select count(*) from liame.action_request
                 where brand_id = ${brandId} and status = 'aguardando_aprovacao' and expires_at > ${agora.toISOString()}::timestamptz)::int as acoes,
               (select count(*) from liame.plan
                 where brand_id = ${brandId} and status = 'pendente' and expires_at > ${agora.toISOString()}::timestamptz)::int as planos,
               (select count(*) from liame.autonomy_proposal where brand_id = ${brandId} and status = 'pendente')::int as autonomia`)
    ).rows[0]!;

    return {
      brand_id: brandId,
      state,
      period: { ...periodo, timezone: fuso },
      previous: antes,
      money: dinheiroDoResumo(atual, anterior),
      campaigns: campanhasDoVeredito(atual),
      orders: pedidosDoResumo(atual),
      platforms: plataformasDoResumo(atual),
      needs_you: {
        ...avisosQuePrecisam(midia, doCiclo),
        approvals: { actions: Number(pendentes.acoes), plans: Number(pendentes.planos), autonomy: Number(pendentes.autonomia) },
      },
      sources: atual.sources,
      generated_at: agora.toISOString(),
    };
  }
}
