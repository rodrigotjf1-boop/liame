import type { MyTermsResponse, TermsAcceptanceVia, TermsVersionInfo } from '@liame/contracts';
import { type Database, type Tx, withSystem } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config.js';
import { aparelhoDaRequisicao, auditDetail, type AuthContext, currentTx } from '../../context/request-context.js';
import { DATABASE } from '../../database/database.module.js';
import { AppProblem } from '../../errors/problems.js';
import { FlagService } from '../../flags/flag.service.js';
import { descreverAparelho } from '../aparelho.js';
import { enderecosVigentes, escolher, type LinhaDaVersao, paraContrato } from './versoes.js';

/** A função dos Termos novos (W14; D-A7-97): desligada, o servidor ignora as versões declaradas. */
export const FLAG_TERMOS = 'termos_novos';

const termosMudaram = () =>
  new AppProblem(409, 'termos-desatualizados', 'Os termos mudaram', 'Recarregue a página e confira a versão nova dos termos.');

/** Quem pergunta: a pessoa (e a empresa ativa), ou ninguém (o cadastro, a rota pública), que só olha o ambiente. */
type Quem = { userId?: string | null; tenantId?: string | null };

/** A versão que vale e os endereços dos textos. */
export interface Vigente {
  version: string;
  termsUrl: string;
  privacyUrl: string;
  /** Veio de uma versão declarada (e não da do ambiente). */
  declarada: boolean;
}

/**
 * Os Termos novos (A7, W14, parte 14a; P35; D-A7-88 a D-A7-95, D-A7-97 a D-A7-100). A distribuição declara cada versão
 * pelo comando `termos-novos`; aqui ficam o que vale, o que vem, o estado da pessoa e o aceite. As versões são da
 * distribuição (sem empresa) e lidas no escopo de sistema; o aceite é da pessoa (RLS dela).
 */
@Injectable()
export class TermosService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(DATABASE) private readonly database: Database | null,
    private readonly modulos: ModuleRef,
  ) {}

  private get db() {
    if (!this.database) throw new Error('termos sem banco');
    return this.database.db;
  }

  /** A função para a pessoa, ou só para o ambiente. O FlagService mora no módulo da aplicação (pelo ModuleRef). */
  async ligada(quem: Quem = {}): Promise<boolean> {
    const flags = this.modulos.get(FlagService, { strict: false });
    return flags.isEnabled(FLAG_TERMOS, flags.context(quem));
  }

  private base(): Vigente {
    const t = this.config.terms;
    return { version: t.version, termsUrl: t.termsUrl, privacyUrl: t.privacyUrl, declarada: false };
  }

  /** As versões declaradas, retiradas também (o histórico). */
  private async linhas(): Promise<LinhaDaVersao[]> {
    return withSystem(this.db, async (tx) =>
      (
        await tx.execute<LinhaDaVersao>(sql`
          select version, kind, notice_at, effective_at, documents, changes, reason, withdrawn_at
            from liame.terms_version order by effective_at desc, version desc`)
      ).rows,
    );
  }

  private vigenteDe(linhas: readonly LinhaDaVersao[], agora: Date): Vigente {
    const base = this.base();
    const { vigente } = escolher(linhas, agora);
    if (!vigente) return base;
    const urls = enderecosVigentes(linhas, agora, { termos: base.termsUrl, privacidade: base.privacyUrl });
    return { version: vigente.version, termsUrl: urls.termos, privacyUrl: urls.privacidade, declarada: true };
  }

  /** A versão que vale para quem pergunta (D-A7-99). Desligada a função, a do ambiente. */
  async vigente(quem: Quem = {}): Promise<Vigente> {
    if (!(await this.ligada(quem))) return this.base();
    return this.vigenteDe(await this.linhas(), new Date());
  }

  /** A rota pública: a versão que vale e a relevante que vem (D-A7-90, D-A7-94). */
  async publico(): Promise<{ vigente: Vigente; aVir: TermsVersionInfo | null }> {
    if (!(await this.ligada())) return { vigente: this.base(), aVir: null };
    const linhas = await this.linhas();
    const agora = new Date();
    const { aVir } = escolher(linhas, agora);
    return { vigente: this.vigenteDe(linhas, agora), aVir: aVir ? paraContrato(aVir) : null };
  }

  /**
   * Confere o aceite do cadastro e do convite (D-A7-94): `terms_version` é a que vale; `next_terms_version`, se vier, é a
   * que vem. Devolve as versões declaradas a gravar como aceitas (a do ambiente fica no `app_user`, como sempre).
   */
  async conferirNoCadastro(versao: string, proxima: string | undefined): Promise<string[]> {
    if (!(await this.ligada())) {
      if (versao !== this.config.terms.version) throw termosMudaram();
      return [];
    }
    const linhas = await this.linhas();
    const agora = new Date();
    const vigente = this.vigenteDe(linhas, agora);
    if (versao !== vigente.version) throw termosMudaram();
    const { aVir } = escolher(linhas, agora);
    if (proxima !== undefined && proxima !== aVir?.version) throw termosMudaram();
    return [...(vigente.declarada ? [vigente.version] : []), ...(proxima !== undefined ? [proxima] : [])];
  }

  /** Grava os aceites do cadastro ou do convite, na transação que cria a pessoa (escopo de sistema). */
  async gravarAceites(tx: Tx, userId: string, versoes: readonly string[], via: 'cadastro' | 'convite'): Promise<void> {
    const aparelho = descreverAparelho(aparelhoDaRequisicao()).slice(0, 80);
    for (const v of versoes) {
      await tx.execute(sql`
        insert into liame.terms_acceptance (user_id, version, via, device) values (${userId}, ${v}, ${via}, ${aparelho})
        on conflict (user_id, version) do nothing`);
    }
  }

  /** Os aceites da pessoa (a RLS dela), da versão mais nova para a mais antiga. */
  private async aceitesDa(userId: string): Promise<Map<string, { accepted_at: string; via: TermsAcceptanceVia }>> {
    const r = await currentTx().execute<{ version: string; accepted_at: Date | string; via: TermsAcceptanceVia }>(sql`
      select version, accepted_at, via from liame.terms_acceptance where user_id = ${userId} order by accepted_at desc`);
    return new Map(r.rows.map((a) => [a.version, { accepted_at: new Date(a.accepted_at).toISOString(), via: a.via }]));
  }

  /** O que a pessoa vê de si (D-A7-95): o que vale, o que aceitou, o que vem e o que falta no dia. */
  async estado(auth: AuthContext): Promise<MyTermsResponse> {
    const quem = { userId: auth.userId, tenantId: auth.tenantId };
    const base = this.base();
    if (!(await this.ligada(quem))) {
      return {
        enabled: false,
        current: { version: base.version, terms_url: base.termsUrl, privacy_url: base.privacyUrl },
        base_version: base.version,
        accepted: null,
        next: null,
        next_accepted_at: null,
        required: null,
        history: [],
      };
    }
    const linhas = await this.linhas();
    const agora = new Date();
    const vigente = this.vigenteDe(linhas, agora);
    const { relevanteVigente, aVir } = escolher(linhas, agora);
    const aceites = await this.aceitesDa(auth.userId);
    const [ultimo] = [...aceites.entries()];
    return {
      enabled: true,
      current: { version: vigente.version, terms_url: vigente.termsUrl, privacy_url: vigente.privacyUrl },
      base_version: base.version,
      accepted: ultimo ? { version: ultimo[0], accepted_at: ultimo[1].accepted_at, via: ultimo[1].via } : null,
      next: aVir ? paraContrato(aVir) : null,
      next_accepted_at: aVir ? (aceites.get(aVir.version)?.accepted_at ?? null) : null,
      required: relevanteVigente && !aceites.has(relevanteVigente.version) ? paraContrato(relevanteVigente) : null,
      history: linhas.map(paraContrato),
    };
  }

  /**
   * Aceitar (D-A7-92): a relevante que vem (antes do dia, pelo aviso) ou a relevante que vale (no dia, pela tela do aceite).
   * Um clique, sem o código do app; repetir não grava de novo. Na auditoria da pessoa, com a versão e onde.
   */
  async aceitar(auth: AuthContext, versao: string): Promise<MyTermsResponse> {
    const quem = { userId: auth.userId, tenantId: auth.tenantId };
    if (!(await this.ligada(quem))) {
      throw new AppProblem(409, 'funcao-desligada', 'Os Termos novos ainda não estão ligados', 'Não há versão nova dos Termos para aceitar.');
    }
    const { relevanteVigente, aVir } = escolher(await this.linhas(), new Date());
    const via: 'aviso' | 'tela_do_dia' | null =
      aVir?.version === versao ? 'aviso' : relevanteVigente?.version === versao ? 'tela_do_dia' : null;
    if (!via) {
      throw new AppProblem(409, 'versao-sem-aceite', 'Esta versão não pede aceite', 'A versão dos Termos mudou. Recarregue a página.');
    }
    const aparelho = descreverAparelho(aparelhoDaRequisicao()).slice(0, 80);
    const r = await currentTx().execute(sql`
      insert into liame.terms_acceptance (user_id, version, via, device) values (${auth.userId}, ${versao}, ${via}, ${aparelho})
      on conflict (user_id, version) do nothing`);
    auditDetail({ resourceId: versao, after: { versao, onde: via, ...(r.rowCount === 0 ? { ja_aceita: true } : {}) } });
    return this.estado(auth);
  }
}
