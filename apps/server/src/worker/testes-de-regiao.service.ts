import { type Database, withSystem, withTenant } from '@liame/database';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { janelaDoTesteDeRegiao, type LeituraDoTesteDeRegiao, leituraVencida, medidaDoTesteDeRegiao, pedidosPorBairro } from '../campanhas/teste-regiao-medida.js';
import { EstadoDoTesteDeRegiao, FLAG_DO_TESTE_DE_REGIAO, ResultadoDoTesteDeRegiao } from '../campanhas/teste-regiao-plano.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { contaConectada } from '../connections/conectada.js';
import type { CredencialGuardada } from '../connections/oauth.js';
import { ClienteConector, ErroConector } from '../connectors/cliente-http.js';
import { enderecosDasPlataformas } from '../connectors/enderecos.js';
import { AcessoDaExecucao, credencialDaLoja, PERMISSOES_DA_LEITURA } from '../connectors/regem/acesso-da-loja.js';
import { lerBairros } from '../connectors/regem/conector-regem.js';
import { DATABASE } from '../database/database.module.js';
import { FlagService } from '../flags/flag.service.js';
import { linhasDosBairros } from '../regiao/bairros.js';
import { VaultService } from '../vault/vault.service.js';
import { type JobScope, tenantFilter } from './outbox-publisher.js';

// A medida do teste de região (plano da região, R8; D-RG-81, D-RG-82 e D-RG-102). Depois do fim do teste, esta rotina lê
// no Regem da loja os pedidos de entrega por bairro dos 14 dias e grava o resultado (`campaign_test.result`) uma vez:
//   - só o teste de região `terminado` (o passo que devolve o bairro na Meta marca, com o `ended_on`), ainda sem resultado,
//     com o dia de hoje no fuso do teste depois do fim. A medida NÃO encerra o teste nem mexe na Meta: nunca deixa um
//     bairro sem anúncio. Teste interrompido, encerrado ou cancelado não é medido;
//   - o teste que parou antes dos 14 dias fica com o motivo `incompleto`, sem ler o Regem;
//   - a leitura que falha (rede, sem acesso, sem a permissão) não grava resultado: o teste volta numa rodada seguinte, e
//     passados 7 dias do fim fica com o motivo `sem_leitura`. O log diz a causa;
//   - cada volta reserva o lote marcando a hora da tentativa (`updated_at`): o teste que não pôde ser medido vai para o fim
//     da fila e espera uma hora, e nenhum teste parado segura os outros. A gravação é condicional (só sem resultado).
// Só com a função `teste_de_regiao` ligada. Uma empresa que falha não para as outras.

/** Quanto um teste espera entre uma tentativa e outra (e depois de marcado como terminado, antes da primeira). */
const ESPERA_ENTRE_TENTATIVAS = '1 hour';
const FUSO_PADRAO = 'America/Sao_Paulo';

export type ResultadoDaMedida = { tenantId: string; teste: string; situacao: 'medido' | 'esperando'; motivo: string | null };

type TesteAMedir = { id: string; tenant_id: string; brand_id: string; unit_id: string };
type LinhaDoTeste = { status: string; aberto: boolean; started_on: string | null; ended_on: string | null; plan: unknown; hoje: string; cidade: string | null };
type ContaDoRegem = { id: string; external_id: string; credential_secret_id: string | null; ligacao_secret_id: string | null };
type Lido = LinhaDoTeste & { started_on: string; ended_on: string; conta: ContaDoRegem | null; segredo: string | null; ligacao: string | null };

/** O que a medida precisa do plano guardado: o bairro e os pedidos das 4 semanas de antes (o fuso, a consulta lê). */
const PlanoDaMedida = EstadoDoTesteDeRegiao.pick({ bairro: true, semanas: true });

/** A leitura do Regem não serviu: a causa vai ao log, e o teste espera a rodada seguinte. */
class LeituraFalhou extends Error {}

const causaDe = (err: unknown): string =>
  err instanceof LeituraFalhou
    ? err.message
    : err instanceof ErroConector
      ? `${err.tipo}${err.codigoProvider ? `:${err.codigoProvider}` : ''}: ${err.message}`
      : err instanceof Error
        ? `erro interno (${err.name})`
        : 'erro interno';

@Injectable()
export class TestesDeRegiaoRotina {
  private readonly logger = new Logger('testes-de-regiao');

  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly vault: VaultService,
    private readonly flags: FlagService,
  ) {}

  /** Uma volta: reserva até `limite` testes terminados sem resultado e mede cada um. */
  async executarLote(limite = 5, scope: JobScope = {}, agora: Date = new Date()): Promise<ResultadoDaMedida[]> {
    const database = this.database;
    if (!database) return [];
    const instante = agora.toISOString();
    // A reserva marca a hora da tentativa na MESMA linha da condição "devido" (V35): quem não pôde ser medido vai para o
    // fim da fila e só volta depois da espera, sem segurar o lote.
    const devidos = await withSystem(database.db, async (tx) =>
      (
        await tx.execute<TesteAMedir>(sql`
          with devidos as materialized (
            select t.id
              from liame.campaign_test t
             where t.kind = 'regiao' and t.status = 'terminado' and t.result is null
               and t.started_on is not null and t.ended_on is not null
               and (${instante}::timestamptz at time zone coalesce(t.plan->>'fuso', ${FUSO_PADRAO}))::date > t.ended_on
               and t.updated_at <= ${instante}::timestamptz - ${ESPERA_ENTRE_TENTATIVAS}::interval
               ${tenantFilter(scope, sql`t.tenant_id`)}
             order by t.updated_at, t.id
             limit ${limite}
               for update of t skip locked
          )
          update liame.campaign_test t
             set updated_at = ${instante}::timestamptz
            from devidos d
           where t.id = d.id
          returning t.id, t.tenant_id, t.brand_id, t.unit_id`)
      ).rows,
    );
    const resultados: ResultadoDaMedida[] = [];
    for (const t of devidos) {
      try {
        resultados.push(await this.medir(database, t, agora));
      } catch (err) {
        this.logger.warn(`a medida do teste de região ${t.id} não andou: ${causaDe(err)}`);
        resultados.push({ tenantId: t.tenant_id, teste: t.id, situacao: 'esperando', motivo: 'erro' });
      }
    }
    return resultados;
  }

  /** A medida de um teste: lê o teste e a credencial (transação curta), o Regem (fora dela) e grava o resultado (outra). */
  private async medir(database: Database, t: TesteAMedir, agora: Date): Promise<ResultadoDaMedida> {
    const base = { tenantId: t.tenant_id, teste: t.id };
    if (!(await this.flags.isEnabled(FLAG_DO_TESTE_DE_REGIAO, this.flags.context({ tenantId: t.tenant_id, brandId: t.brand_id })))) {
      return { ...base, situacao: 'esperando', motivo: 'funcao_desligada' };
    }
    const lido = await this.ler(database, t, agora);
    if (!lido) return { ...base, situacao: 'esperando', motivo: 'fora_da_medida' };
    const janela = janelaDoTesteDeRegiao(lido.started_on, lido.ended_on);
    const plano = PlanoDaMedida.safeParse(lido.plan);
    if (!plano.success) {
      // O plano é gravado pelo pedido do teste; um plano que não se lê não tem os pedidos de antes: não há conta.
      this.logger.warn(`teste de região ${t.id}: o plano guardado não pôde ser lido; o resultado fica sem conta`);
      const vazio = medidaDoTesteDeRegiao({ bairro: '', antes: [], janela, leitura: null, medidoEm: agora });
      return this.gravar(database, t, { ...vazio, motivo: 'sem_conta' });
    }
    const entrada = { bairro: plano.data.bairro.nome, antes: plano.data.semanas.bairros, janela, medidoEm: agora };
    // O teste que parou antes dos 14 dias não tem conta: o Regem nem é lido.
    if (!janela.completa) return this.gravar(database, t, medidaDoTesteDeRegiao({ ...entrada, leitura: null }));

    let leitura: LeituraDoTesteDeRegiao;
    try {
      leitura = await this.lerOsBairros(database, t, lido, janela);
    } catch (err) {
      const causa = causaDe(err);
      if (!leituraVencida(lido.ended_on, lido.hoje)) {
        this.logger.warn(`teste de região ${t.id}: os pedidos por bairro dos dias do teste não vieram do Regem (${causa}); nova tentativa em 1 hora`);
        return { ...base, situacao: 'esperando', motivo: 'leitura_falhou' };
      }
      this.logger.warn(`teste de região ${t.id}: os pedidos por bairro não vieram do Regem (${causa}) e já passaram 7 dias do fim; o resultado fica sem leitura`);
      return this.gravar(database, t, medidaDoTesteDeRegiao({ ...entrada, leitura: null }));
    }
    return this.gravar(database, t, medidaDoTesteDeRegiao({ ...entrada, leitura }));
  }

  /** O teste (de novo, com as condições da medida), a cidade da loja e a credencial do Regem dela, na transação da empresa. */
  private ler(database: Database, t: TesteAMedir, agora: Date): Promise<Lido | null> {
    const pelaLigacao = this.config.produtos.regemPelaLigacao;
    return withTenant(database.db, t.tenant_id, async (tx) => {
      const l = (
        await tx.execute<LinhaDoTeste>(sql`
          select t.status, t.result is null as aberto, t.started_on::text as started_on, t.ended_on::text as ended_on, t.plan,
                 ((${agora.toISOString()}::timestamptz at time zone coalesce(t.plan->>'fuso', ${FUSO_PADRAO}))::date)::text as hoje,
                 u.address_city as cidade
            from liame.campaign_test t
            left join liame.unit u on u.id = t.unit_id and u.tenant_id = t.tenant_id
           where t.id = ${t.id} and t.tenant_id = ${t.tenant_id} and t.kind = 'regiao'`)
      ).rows[0];
      // Outra volta mediu antes, ou o teste mudou de situação: nada a fazer.
      if (!l || l.status !== 'terminado' || !l.aberto || !l.started_on || !l.ended_on || l.hoje <= l.ended_on) return null;
      const conta =
        (
          await tx.execute<ContaDoRegem>(sql`
            select a.id, a.external_id, a.credential_secret_id, a.ligacao_secret_id
              from liame.connected_account a
             where a.tenant_id = ${t.tenant_id} and a.brand_id = ${t.brand_id} and a.provider = 'regem' and a.unit_id = ${t.unit_id} and ${contaConectada('a')}
             order by a.id
             limit 1`)
        ).rows[0] ?? null;
      const segredo = conta?.credential_secret_id ? await this.vault.readSecret(tx, conta.credential_secret_id) : null;
      // A ligação do Hub DMS só sai do cofre com a leitura pela ligação ligada.
      const ligacao = pelaLigacao && conta?.ligacao_secret_id ? await this.vault.readSecret(tx, conta.ligacao_secret_id) : null;
      return { ...l, started_on: l.started_on, ended_on: l.ended_on, conta, segredo, ligacao };
    });
  }

  /**
   * Os pedidos de entrega por bairro dos dias do teste, no Regem da loja (fora de transação), somados como no pedido do
   * teste. Qualquer coisa que não sirva (sem a loja conectada, sem a permissão, a resposta de outra loja ou de outra
   * janela) é uma leitura que falhou.
   */
  private async lerOsBairros(database: Database, t: TesteAMedir, lido: Lido, janela: { de: string; ate: string }): Promise<LeituraDoTesteDeRegiao> {
    const conta = lido.conta;
    if (!conta) throw new LeituraFalhou('a loja do teste não está conectada ao Regem');
    const guardada = lido.segredo ? (JSON.parse(lido.segredo) as CredencialGuardada) : null;
    const credencial = credencialDaLoja(guardada, conta.external_id, lido.ligacao, this.config.produtos.regemPelaLigacao);
    if (!credencial) throw new LeituraFalhou('o cofre não tem a credencial desta loja do Regem');
    if (!credencial.escopos.includes('pedidos.ler')) throw new LeituraFalhou('a loja não liberou a leitura dos pedidos (pedidos.ler)');
    const acesso = new AcessoDaExecucao(credencial, this.config, conta.external_id, PERMISSOES_DA_LEITURA, async (err) => {
      // A ligação recusada fica no cofre: quem a tira é a leitura das vendas ou a comparação.
      this.logger.warn(`teste de região ${t.id}: o Regem recusou a ligação do Hub DMS (${err.tipo}${err.codigoProvider ? `:${err.codigoProvider}` : ''}); repetida pelo token`);
    });
    const cliente = new ClienteConector(database.db, { enderecos: enderecosDasPlataformas(this.config.plataformas, this.config.produtos) });
    const r = await acesso.chamar((a) => lerBairros({ cliente, apiUrl: this.config.produtos.regemApiUrl }, a, { de: janela.de, ate: janela.ate }));
    if (r.loja_id !== conta.external_id) throw new LeituraFalhou('a resposta do Regem é de outra loja');
    if (r.de !== janela.de || r.ate !== janela.ate) throw new LeituraFalhou(`a leitura veio de ${r.de} a ${r.ate}, e não dos dias do teste`);
    // As linhas como a leitura de Sua região guarda (o nome aparado), para os dois lados da conta serem contados igual.
    const linhas = linhasDosBairros(r).filter((l) => l.tipo === 'bairro');
    return { minimo: r.minimo, bairros: pedidosPorBairro(linhas, lido.cidade) };
  }

  /** Grava o resultado, só se o teste ainda está terminado e sem resultado (outra volta pode ter medido antes). */
  private async gravar(database: Database, t: TesteAMedir, resultado: ResultadoDoTesteDeRegiao): Promise<ResultadoDaMedida> {
    const conferido = ResultadoDoTesteDeRegiao.parse(resultado);
    const r = await withTenant(database.db, t.tenant_id, (tx) =>
      tx.execute(sql`
        update liame.campaign_test
           set result = ${JSON.stringify(conferido)}::jsonb, updated_at = now()
         where id = ${t.id} and tenant_id = ${t.tenant_id} and kind = 'regiao' and status = 'terminado' and result is null
        returning id`),
    );
    if (!r.rows.length) return { tenantId: t.tenant_id, teste: t.id, situacao: 'esperando', motivo: 'ja_medido' };
    return { tenantId: t.tenant_id, teste: t.id, situacao: 'medido', motivo: conferido.motivo };
  }
}
