import { type Database, withSystem } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ActionService } from '../actions/action.service.js';
import { FERRAMENTA_DO_CUPOM_DO_TESTE } from '../actions/regem-cupom.js';
import { naTransacaoDaEmpresa } from '../ai/na-empresa.js';
import type { LetraDoTeste } from '../campanhas/teste-contas.js';
import { type DescontoDoTeste, EstadoDoTesteDeCriativo, FLAG_DO_TESTE_DE_CRIATIVO } from '../campanhas/teste-de-criativo-plano.js';
import { parametrosDoCupomDoTeste } from '../campanhas/teste-portao.js';
import { contaConectada } from '../connections/conectada.js';
import { currentTx } from '../context/request-context.js';
import { ligacaoEmVigor, ligarCupom, travarCupom } from '../coupons/vinculo.js';
import { DATABASE } from '../database/database.module.js';
import { GESTOR_DE_TRAFEGO } from '../equipe/membros.js';
import { AppProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// A rotina dos testes de criativo (plano da região, R8; D-RG-77 e D-RG-78). Com a campanha de teste criada na Meta
// (pausada), o teste fica `criando` até os dois cupons existirem no Regem. Esta rotina:
//   1. pede o cupom de cada criativo pelo trilho de ações (`cupom_do_teste`), em nome de quem pediu o teste, pelo teste
//      que a pessoa aprovou com o código do app (o portão do teste confere no pedido e de novo na execução);
//   2. lê como cada pedido terminou: criado, o cupom do criativo fica `criado`; recusado (o Regem, a política, o portão),
//      o teste fica `interrompido`, com o motivo, e a campanha de teste continua pausada;
//   3. com os dois cupons criados, o teste fica `pronto`: aí a pessoa pode pedir para ativar;
//   4. liga cada cupom à campanha de teste quando ela aparece na lista do Liame (a leitura seguinte da Meta), para os
//      pedidos com o cupom contarem para a campanha em Resultados.
// Só com a função `teste_de_criativo` ligada. Uma empresa que falha não para as outras.

const ROTULO_DO_GESTOR = 'Gestor de tráfego';
/** As situações de um pedido de cupom que não vão mais criar nada. */
const SEM_SAIDA = ['falhou', 'cancelada', 'expirada'];

export type ResultadoDoTeste = { tenantId: string; teste: string; situacao: 'cupom_pedido' | 'pronto' | 'interrompido' | 'esperando' | 'ligado' | 'nao_pediu'; motivo: string | null };

type TesteEmCriacao = { id: string; tenant_id: string; brand_id: string; unit_id: string; created_by: string | null };
type Braco = { letter: LetraDoTeste; coupon_code: string; coupon_status: string; pedido_status: string | null; pedido_motivo: string | null };
type CupomSemLigacao = { tenant_id: string; teste: string; cupom: string; campanha: string };

@Injectable()
export class TestesDeCriativoRotina {
  private readonly logger = new Logger('testes-de-criativo');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly actions: ActionService,
    private readonly flags: FlagService,
  ) {}

  /** Uma volta: os cupons dos testes em criação e as ligações que faltam. `limite`: quantos testes a volta olha. */
  async executarLote(limite = 10, scope: JobScope = {}): Promise<ResultadoDoTeste[]> {
    const database = this.database;
    if (!database) return [];
    const resultados: ResultadoDoTeste[] = [];
    // Os testes aprovados cuja campanha de teste já existe inteira na Meta: a campanha e os dois anúncios guardados (só a
    // criação aprovada, pelo trilho, guarda esses ids).
    const emCriacao = await withSystem(database.db, async (tx) =>
      (
        await tx.execute<TesteEmCriacao>(sql`
          select t.id, t.tenant_id, t.brand_id, t.unit_id, t.created_by
            from liame.campaign_test t
           where t.kind = 'criativo' and t.status = 'criando' and t.meta_campaign_id is not null
             and (select count(*) from liame.campaign_test_arm b where b.test_id = t.id and b.meta_ad_id is not null) = 2
             ${tenantFilter(scope, sql`t.tenant_id`)}
           order by t.updated_at, t.id
           limit ${limite}`)
      ).rows,
    );
    for (const t of emCriacao) {
      try {
        resultados.push(await this.cuidarDosCupons(database, t));
      } catch (err) {
        const motivo = err instanceof AppProblem ? `${err.code}: ${err.detail}` : err instanceof Error ? err.message : String(err);
        this.logger.warn(`os cupons do teste ${t.id} não andaram: ${motivo}`);
        resultados.push({ tenantId: t.tenant_id, teste: t.id, situacao: 'nao_pediu', motivo: motivo.slice(0, 300) });
      }
    }
    // Os cupons criados que ainda não estão ligados à campanha de teste, quando ela já apareceu na lista do Liame.
    const semLigacao = await withSystem(database.db, async (tx) =>
      (
        await tx.execute<CupomSemLigacao>(sql`
          select t.tenant_id, t.id as teste, cp.id as cupom, c.id as campanha
            from liame.campaign_test t
            join liame.campaign_test_arm b on b.test_id = t.id and b.tenant_id = t.tenant_id and b.coupon_status = 'criado'
            join liame.campaign c on c.tenant_id = t.tenant_id and c.connected_account_id = t.ad_account_id and c.external_id = t.meta_campaign_id
            join liame.connected_account a on a.tenant_id = t.tenant_id and a.provider = 'regem' and a.unit_id = t.unit_id and ${contaConectada('a')}
            join liame.coupon cp on cp.tenant_id = t.tenant_id and cp.connected_account_id = a.id and cp.code = b.coupon_code and cp.removed_at is null
           where t.kind = 'criativo' and t.status in ('criando', 'pronto', 'rodando')
             and not exists (select 1 from liame.campaign_coupon l where l.coupon_id = cp.id and (l.unlinked_at is null or l.unlinked_at > now()))
             ${tenantFilter(scope, sql`t.tenant_id`)}
           order by t.id, b.letter
           limit ${limite * 2}`)
      ).rows,
    );
    for (const l of semLigacao) {
      try {
        resultados.push(await this.ligar(database, l));
      } catch (err) {
        const motivo = err instanceof AppProblem ? `${err.code}: ${err.detail}` : err instanceof Error ? err.message : String(err);
        this.logger.warn(`o cupom ${l.cupom} do teste ${l.teste} não foi ligado à campanha de teste: ${motivo}`);
        resultados.push({ tenantId: l.tenant_id, teste: l.teste, situacao: 'nao_pediu', motivo: motivo.slice(0, 300) });
      }
    }
    return resultados;
  }

  /** Os cupons de um teste em criação, na transação da empresa: lê os pedidos que terminaram, pede os que faltam e, com os dois criados, deixa o teste pronto. */
  private async cuidarDosCupons(database: Database, t: TesteEmCriacao): Promise<ResultadoDoTeste> {
    const base = { tenantId: t.tenant_id, teste: t.id };
    if (!(await this.flags.isEnabled(FLAG_DO_TESTE_DE_CRIATIVO, this.flags.context({ tenantId: t.tenant_id, brandId: t.brand_id })))) {
      return { ...base, situacao: 'esperando', motivo: 'funcao_desligada' };
    }
    return naTransacaoDaEmpresa(database, { tenantId: t.tenant_id, userId: null }, async () => {
      const tx = currentTx();
      const teste = (await tx.execute<{ status: string; plan: unknown }>(sql`select status, plan from liame.campaign_test where id = ${t.id} and tenant_id = ${t.tenant_id} for update`)).rows[0];
      // Outra volta chegou antes, ou alguém encerrou: nada a fazer.
      if (!teste || teste.status !== 'criando') return { ...base, situacao: 'esperando' as const, motivo: 'fora_da_criacao' };
      const plano = EstadoDoTesteDeCriativo.omit({ situacao: true, ativa: true }).safeParse(teste.plan);
      if (!plano.success) return this.interromper(t, 'O plano guardado deste teste não pôde ser lido: os cupons não foram criados.');
      const bracos = (
        await tx.execute<Braco>(sql`
          select b.letter, b.coupon_code, b.coupon_status, r.status as pedido_status, r.status_reason as pedido_motivo
            from liame.campaign_test_arm b
            left join liame.action_request r on r.id = b.coupon_action_id and r.tenant_id = b.tenant_id
           where b.test_id = ${t.id} and b.tenant_id = ${t.tenant_id}
           order by b.letter
             for update of b`)
      ).rows;

      // (2) Os pedidos de cupom que terminaram.
      for (const b of bracos) {
        if (b.coupon_status !== 'pedido') continue;
        if (b.pedido_status === 'executada') {
          await tx.execute(sql`update liame.campaign_test_arm set coupon_status = 'criado', updated_at = now() where test_id = ${t.id} and letter = ${b.letter}`);
          b.coupon_status = 'criado';
        } else if (b.pedido_status === null || SEM_SAIDA.includes(b.pedido_status)) {
          await tx.execute(sql`update liame.campaign_test_arm set coupon_status = 'falhou', updated_at = now() where test_id = ${t.id} and letter = ${b.letter}`);
          const porque = b.pedido_motivo ? ` (${b.pedido_motivo.slice(0, 300)})` : '';
          return this.interromper(t, `O cupom ${b.coupon_code}, do criativo ${b.letter}, não foi criado no Regem${porque}. A campanha de teste ficou pausada: peça o teste de novo.`);
        }
      }

      // (1) Os cupons que ainda não foram pedidos.
      const aCriar = bracos.filter((b) => b.coupon_status === 'a_criar');
      if (aCriar.length) {
        const loja = (
          await tx.execute<{ id: string }>(sql`
            select a.id from liame.connected_account a
             where a.tenant_id = ${t.tenant_id} and a.brand_id = ${t.brand_id} and a.provider = 'regem' and a.unit_id = ${t.unit_id} and ${contaConectada('a')}
             order by a.id limit 1`)
        ).rows[0];
        if (!loja) return this.interromper(t, 'A loja do teste foi desligada do Regem antes de os cupons serem criados. A campanha de teste ficou pausada.');
        const emNomeDe =
          t.created_by ??
          (await tx.execute<{ user_id: string }>(sql`select user_id from liame.membership where tenant_id = ${t.tenant_id} and role_key = 'dono' and revoked_at is null limit 1`)).rows[0]?.user_id;
        if (!emNomeDe) return { ...base, situacao: 'esperando' as const, motivo: 'sem_dono' };
        for (const b of aCriar) {
          let pedido: string;
          try {
            pedido = await this.pedirOCupom(t, emNomeDe, loja.id, plano.data, b);
          } catch (err) {
            // A política da empresa pede outra coisa para o cupom do teste, ou o plano não pode ser montado (o código já
            // existe na loja, a loja tirou a permissão): não adianta repetir, e o teste para aqui, com o motivo. O portão
            // fechado por ora (a função desligada no meio) e o que é passageiro sobem: a volta seguinte tenta de novo.
            if (err instanceof AppProblem && (err.code === 'automatico-segurado' || err.getStatus() === 422)) {
              return this.interromper(t, `O cupom ${b.coupon_code}, do criativo ${b.letter}, não pôde ser pedido: ${err.detail} A campanha de teste ficou pausada.`);
            }
            throw err;
          }
          await tx.execute(sql`update liame.campaign_test_arm set coupon_status = 'pedido', coupon_action_id = ${pedido}, updated_at = now() where test_id = ${t.id} and letter = ${b.letter}`);
        }
        return { ...base, situacao: 'cupom_pedido' as const, motivo: null };
      }
      // (3) Os dois criados: o teste fica pronto para ativar.
      if (bracos.length === 2 && bracos.every((b) => b.coupon_status === 'criado')) {
        await tx.execute(sql`update liame.campaign_test set status = 'pronto', version = version + 1, updated_at = now() where id = ${t.id} and tenant_id = ${t.tenant_id}`);
        return { ...base, situacao: 'pronto' as const, motivo: null };
      }
      return { ...base, situacao: 'esperando' as const, motivo: 'cupons_em_criacao' };
    });
  }

  /** O pedido do cupom de um criativo, pelo trilho de ações, em nome de quem pediu o teste. Devolve o id do pedido. */
  private pedirOCupom(t: TesteEmCriacao, emNomeDe: string, loja: string, plano: { nome: string; desconto: DescontoDoTeste }, b: Braco): Promise<string> {
    return this.actions.criarCupomDoTeste(
      { tenantId: t.tenant_id, agentKey: GESTOR_DE_TRAFEGO, agentLabel: ROTULO_DO_GESTOR, emNomeDe },
      {
        tool: FERRAMENTA_DO_CUPOM_DO_TESTE,
        brand_id: t.brand_id,
        provider: 'regem',
        account_id: loja,
        resource_id: `cupom:${b.coupon_code}`,
        params: parametrosDoCupomDoTeste({ id: t.id, nome: plano.nome, desconto: plano.desconto }, b.letter, b.coupon_code),
      },
    );
  }

  /** O teste que não vai adiante: `interrompido`, com o motivo. A campanha de teste continua pausada na Meta. */
  private async interromper(t: TesteEmCriacao, motivo: string): Promise<ResultadoDoTeste> {
    await currentTx().execute(sql`
      update liame.campaign_test set status = 'interrompido', reason = ${motivo.slice(0, 500)}, version = version + 1, updated_at = now()
       where id = ${t.id} and tenant_id = ${t.tenant_id}`);
    this.logger.warn(`teste de criativo ${t.id}: interrompido (${motivo.slice(0, 200)})`);
    return { tenantId: t.tenant_id, teste: t.id, situacao: 'interrompido', motivo };
  }

  /** Liga o cupom do teste à campanha de teste, exclusivo dela, na transação da empresa (sem escrita fora do Liame). */
  private async ligar(database: Database, l: CupomSemLigacao): Promise<ResultadoDoTeste> {
    return naTransacaoDaEmpresa(database, { tenantId: l.tenant_id, userId: null }, async () => {
      const tx = currentTx();
      const cupom = await travarCupom(tx, l.cupom);
      if (await ligacaoEmVigor(tx, l.cupom)) return { tenantId: l.tenant_id, teste: l.teste, situacao: 'esperando' as const, motivo: 'ja_ligado' };
      await ligarCupom(tx, { userId: null, cupom, body: { campaign_id: l.campanha, exclusive: true }, agora: new Date() });
      return { tenantId: l.tenant_id, teste: l.teste, situacao: 'ligado' as const, motivo: null };
    });
  }
}
