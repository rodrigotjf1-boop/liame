import type { AcceptOwnershipTransferRequest, CreateOwnershipTransferRequest, OwnershipResponse, OwnershipTransfer } from '@liame/contracts';
import { type Tx, uuidv7 } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { ConfirmacaoService } from '../auth/confirmacao.service.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { afterCommit, auditDetail, type AuthContext, currentTx } from '../context/request-context.js';
import { AppProblem } from '../errors/problems.js';
import { Mailer } from '../mail/mailer.js';

// A transferência da propriedade da conta (A7, W8, parte 2; ADR-017; P34; D-A7-59 a D-A7-61; D-A7-84). Roda na transação
// da requisição, com a empresa ativa (a RLS limita tudo a ela). O Dono pede, com o código do app, para um Administrador
// que já entra com o app e não vem de uma agência; quem recebe aceita com o código do app dela e os Termos como dona, em
// até 7 dias; até o aceite nada muda. No aceite, numa transação só, o Dono antigo vira Administrador sem a cobrança, ou
// sai, e quem recebeu vira a dona. Quem acabou de receber espera 7 dias para transferir de novo.

/** O pedido vale 7 dias, e quem recebeu a propriedade espera 7 dias para transferir de novo (D-A7-59, D-A7-60). */
export const DIAS_DO_PEDIDO = 7;
export const DIAS_PARA_TRANSFERIR_DE_NOVO = 7;

type LinhaDoPedido = {
  id: string;
  from_user_id: string;
  from_name: string;
  to_user_id: string;
  to_name: string;
  to_email: string;
  old_owner_stays: boolean;
  status: OwnershipTransfer['status'];
  created_at: Date | string;
  expires_at: Date | string;
  decided_at: Date | string | null;
};

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const naoEncontrado = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Este pedido de transferência não existe ou já foi decidido.');
const soODono = () => new AppProblem(403, 'so-o-dono', 'Só o dono', 'Só o dono transfere a propriedade da conta.');

@Injectable()
export class PropriedadeService {
  constructor(
    private readonly confirmacao: ConfirmacaoService,
    private readonly mailer: Mailer,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** A propriedade: o Dono, desde quando, o pedido em aberto (para o Dono e para quem recebe) e quem pode receber. */
  async ler(auth: AuthContext): Promise<OwnershipResponse> {
    const tx = currentTx();
    const tenantId = empresaDe(auth);
    await venceAntigos(tx, tenantId);
    return this.resposta(tx, auth, tenantId);
  }

  /** O Dono pede: para um Administrador com o app, de fora das agências, com o código do app dele. */
  async pedir(auth: AuthContext, body: CreateOwnershipTransferRequest): Promise<OwnershipResponse> {
    const tx = currentTx();
    const tenantId = empresaDe(auth);
    if (auth.roleKey !== 'dono') throw soODono();
    await venceAntigos(tx, tenantId);
    const { recebeuEm } = await donoDesde(tx, tenantId, auth.userId);
    if (podeDeNovoEm(recebeuEm)) {
      throw new AppProblem(409, 'propriedade-recente', 'Ainda não dá para transferir', `Quem acabou de receber a propriedade espera ${DIAS_PARA_TRANSFERIR_DE_NOVO} dias para transferir de novo.`);
    }
    const aberto = await tx.execute(sql`select 1 from liame.ownership_transfer where tenant_id = ${tenantId} and status = 'pedido'`);
    if (aberto.rows.length) throw new AppProblem(409, 'pedido-em-aberto', 'Já há um pedido', 'Cancele o pedido em aberto antes de pedir outro.');
    const quem = (await candidatos(tx, tenantId)).find((c) => c.user_id === body.to_user_id);
    if (!quem) {
      throw new AppProblem(422, 'nao-pode-receber', 'Essa pessoa não pode receber', 'A propriedade só vai para um Administrador da empresa que já entra com o app autenticador e não vem de uma agência.');
    }
    await this.confirmacao.confirmar(tx, auth.userId, body);
    const id = uuidv7();
    await tx.execute(sql`
      insert into liame.ownership_transfer (id, tenant_id, from_user_id, to_user_id, old_owner_stays, expires_at)
      values (${id}, ${tenantId}, ${auth.userId}, ${quem.user_id}, ${body.old_owner_stays},
              now() + make_interval(days => ${DIAS_DO_PEDIDO}::int))`);
    auditDetail({ resourceId: id, after: { to_user_id: quem.user_id, old_owner_stays: body.old_owner_stays } });
    const empresa = await nomeDaEmpresa(tx, tenantId);
    const link = `${this.config.appUrl}/pessoas`;
    afterCommit(async () => {
      await this.mailer.send({
        to: quem.email,
        subject: `Liame: ${auth.name} quer passar para você a propriedade da ${empresa}`,
        text:
          `${auth.name} pediu que você passe a ser a dona da conta da ${empresa} no Liame.\n\n` +
          'Como dona, você passa a cuidar da cobrança, de quem tem acesso, de encerrar a conta e de transferir a propriedade. A assinatura, as contas conectadas, a equipe e o que está em andamento continuam como estão.\n\n' +
          `Para aceitar ou recusar, entre no Liame e abra Pessoas e acessos (vale ${DIAS_DO_PEDIDO} dias):\n${link}\n\n` +
          'Até você aceitar, nada muda. Se você não esperava este pedido, recuse.',
      });
      await this.mailer.send({
        to: auth.email,
        subject: `Liame: o pedido de transferência da ${empresa} foi enviado`,
        text:
          `Você pediu que ${quem.name} passe a ser a dona da conta da ${empresa}. Até o aceite, nada muda, e você pode cancelar em Pessoas e acessos.\n\n` +
          (body.old_owner_stays ? 'Quando ela aceitar, você fica como Administrador, sem a cobrança.' : 'Quando ela aceitar, você sai da conta.'),
      });
    });
    return this.resposta(tx, auth, tenantId);
  }

  /** O Dono cancela o pedido em aberto. */
  async cancelar(auth: AuthContext, id: string): Promise<void> {
    const tx = currentTx();
    const tenantId = empresaDe(auth);
    if (auth.roleKey !== 'dono') throw soODono();
    const r = await tx.execute<{ to_user_id: string }>(sql`
      update liame.ownership_transfer set status = 'cancelado', decided_at = now()
       where id = ${id} and tenant_id = ${tenantId} and from_user_id = ${auth.userId} and status = 'pedido'
      returning to_user_id`);
    const linha = r.rows[0];
    if (!linha) throw naoEncontrado();
    auditDetail({ resourceId: id, before: { status: 'pedido' }, after: { status: 'cancelado' } });
    const para = await emailDe(tx, linha.to_user_id);
    const empresa = await nomeDaEmpresa(tx, tenantId);
    if (para) {
      afterCommit(() =>
        this.mailer.send({
          to: para,
          subject: `Liame: o pedido de transferência da ${empresa} foi cancelado`,
          text: `${auth.name} cancelou o pedido para você passar a ser a dona da conta da ${empresa}. Nada mudou no seu acesso.`,
        }),
      );
    }
  }

  /** Quem recebe recusa: nada muda. */
  async recusar(auth: AuthContext, id: string): Promise<void> {
    const tx = currentTx();
    const tenantId = empresaDe(auth);
    const r = await tx.execute<{ from_user_id: string }>(sql`
      update liame.ownership_transfer set status = 'recusado', decided_at = now()
       where id = ${id} and tenant_id = ${tenantId} and to_user_id = ${auth.userId} and status = 'pedido' and expires_at > now()
      returning from_user_id`);
    const linha = r.rows[0];
    if (!linha) throw naoEncontrado();
    auditDetail({ resourceId: id, before: { status: 'pedido' }, after: { status: 'recusado' } });
    const para = await emailDe(tx, linha.from_user_id);
    const empresa = await nomeDaEmpresa(tx, tenantId);
    if (para) {
      afterCommit(() =>
        this.mailer.send({
          to: para,
          subject: `Liame: ${auth.name} recusou a propriedade da ${empresa}`,
          text: `${auth.name} recusou o pedido para passar a ser a dona da conta da ${empresa}. Nada mudou: você continua o dono.`,
        }),
      );
    }
  }

  /**
   * Quem recebe aceita, com o código do app e os Termos como dona. Numa transação: o Dono antigo vira Administrador sem
   * a cobrança, ou sai; quem recebeu vira a dona. A assinatura, as contas, a equipe e o que está em andamento seguem.
   */
  async aceitar(auth: AuthContext, id: string, body: AcceptOwnershipTransferRequest): Promise<OwnershipResponse> {
    const tx = currentTx();
    const tenantId = empresaDe(auth);
    const r = await tx.execute<{ from_user_id: string; old_owner_stays: boolean }>(sql`
      select from_user_id, old_owner_stays from liame.ownership_transfer
       where id = ${id} and tenant_id = ${tenantId} and to_user_id = ${auth.userId} and status = 'pedido' and expires_at > now()
       for update`);
    const pedido = r.rows[0];
    if (!pedido) throw naoEncontrado();
    if (body.terms_version !== this.config.terms.version) {
      throw new AppProblem(409, 'termos-desatualizados', 'Os termos mudaram', 'Recarregue a página e confira a versão nova dos termos.');
    }
    // Quem recebe ainda é Administrador da empresa, com o app, e não vem de uma agência.
    if (!(await candidatos(tx, tenantId)).some((c) => c.user_id === auth.userId)) {
      throw new AppProblem(409, 'nao-pode-receber', 'Você não pode receber agora', 'A propriedade só vai para um Administrador da empresa que entra com o app autenticador.');
    }
    await this.confirmacao.confirmar(tx, auth.userId, body);
    // Primeiro o Dono antigo deixa de ser dono (um Dono por empresa), depois quem recebeu passa a ser.
    // Quem sai deixa de ser dono também na linha que fica guardada: nada que procure o Dono o acha ali.
    const antigo = await tx.execute<{ user_id: string }>(sql`
      update liame.membership
         set role_key = 'administrador',
             revoked_at = ${pedido.old_owner_stays ? sql`null` : sql`now()`},
             approve_limit_micros = null, dual_approval = true, billing_access = false
       where tenant_id = ${tenantId} and user_id = ${pedido.from_user_id} and role_key = 'dono' and revoked_at is null
      returning user_id`);
    if (!antigo.rows.length) throw new AppProblem(409, 'dono-mudou', 'O dono mudou', 'A conta já não é de quem pediu. O pedido não vale mais.');
    await tx.execute(sql`
      update liame.membership
         set role_key = 'dono', approve_limit_micros = null, dual_approval = true, billing_access = false, expires_at = null
       where tenant_id = ${tenantId} and user_id = ${auth.userId} and revoked_at is null`);
    await tx.execute(sql`
      update liame.ownership_transfer set status = 'aceito', decided_at = now(), terms_version = ${body.terms_version}
       where id = ${id}`);
    auditDetail({ resourceId: id, before: { owner: pedido.from_user_id }, after: { owner: auth.userId, old_owner_stays: pedido.old_owner_stays, terms_version: body.terms_version } });
    const empresa = await nomeDaEmpresa(tx, tenantId);
    const doAntigo = await emailDe(tx, pedido.from_user_id);
    afterCommit(async () => {
      await this.mailer.send({
        to: auth.email,
        subject: `Liame: agora a ${empresa} é sua`,
        text:
          `Você passou a ser a dona da conta da ${empresa} no Liame. Agora cuida da cobrança, de quem tem acesso, de encerrar a conta e de transferir a propriedade.\n\n` +
          `Confira em Pessoas e acessos quem tem acesso, e em Plano e cobrança a forma de pagar: ${this.config.appUrl}/pessoas`,
      });
      if (doAntigo) {
        await this.mailer.send({
          to: doAntigo,
          subject: `Liame: ${auth.name} aceitou a propriedade da ${empresa}`,
          text: `${auth.name} aceitou e agora é a dona da conta da ${empresa}. ${pedido.old_owner_stays ? 'Você continua como Administrador, sem a cobrança.' : 'O seu acesso à conta acabou.'}`,
        });
      }
    });
    return this.resposta(tx, { ...auth, roleKey: 'dono' }, tenantId);
  }

  private async resposta(tx: Tx, auth: AuthContext, tenantId: string): Promise<OwnershipResponse> {
    const dono = await tx.execute<{ user_id: string; name: string }>(sql`
      select m.user_id, u.name from liame.membership m join liame.app_user u on u.id = m.user_id
       where m.tenant_id = ${tenantId} and m.role_key = 'dono' and m.revoked_at is null`);
    const d = dono.rows[0];
    if (!d) throw new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Esta empresa não tem dono.');
    const { desde, recebeuEm } = await donoDesde(tx, tenantId, d.user_id);
    const ehDono = d.user_id === auth.userId;
    const p = await tx.execute<LinhaDoPedido>(sql`
      select t.id, t.from_user_id, f.name as from_name, t.to_user_id, u.name as to_name, u.email as to_email, t.old_owner_stays,
             t.status, t.created_at, t.expires_at, t.decided_at
        from liame.ownership_transfer t
        join liame.app_user f on f.id = t.from_user_id
        join liame.app_user u on u.id = t.to_user_id
       where t.tenant_id = ${tenantId} and t.status = 'pedido'`);
    const linha = p.rows[0];
    const veOPedido = linha && (ehDono || linha.to_user_id === auth.userId);
    const quando = podeDeNovoEm(recebeuEm);
    return {
      owner: { user_id: d.user_id, name: d.name, since: iso(desde) },
      pending: veOPedido ? paraOPedido(linha) : null,
      addressed_to_me: Boolean(linha && linha.to_user_id === auth.userId),
      candidates: ehDono ? (await candidatos(tx, tenantId)).map(({ user_id, name, email }) => ({ user_id, name, email })) : [],
      can_transfer_from: ehDono && quando ? quando.toISOString() : null,
    };
  }
}

function empresaDe(auth: AuthContext): string {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return auth.tenantId;
}

/** O pedido de mais de 7 dias sem resposta vence (antes de ler ou pedir outro). */
async function venceAntigos(tx: Tx, tenantId: string): Promise<void> {
  await tx.execute(sql`
    update liame.ownership_transfer set status = 'vencido', decided_at = expires_at
     where tenant_id = ${tenantId} and status = 'pedido' and expires_at <= now()`);
}

/** Os Administradores vivos da empresa, com o app autenticador e de fora das agências: quem pode receber. */
async function candidatos(tx: Tx, tenantId: string): Promise<Array<{ user_id: string; name: string; email: string }>> {
  const r = await tx.execute<{ user_id: string; name: string; email: string }>(sql`
    select m.user_id, u.name, u.email
      from liame.membership m join liame.app_user u on u.id = m.user_id
     where m.tenant_id = ${tenantId} and m.role_key = 'administrador' and m.revoked_at is null
       and (m.expires_at is null or m.expires_at > now()) and m.partner_link_id is null
       and u.disabled_at is null and u.mfa_enabled_at is not null
     order by u.name, u.id`);
  return r.rows;
}

/**
 * Desde quando a pessoa é a dona (o aceite da última transferência para ela, ou a entrada na empresa) e quando recebeu
 * a propriedade por transferência (nulo para quem criou a empresa).
 */
async function donoDesde(tx: Tx, tenantId: string, userId: string): Promise<{ desde: Date; recebeuEm: Date | null }> {
  const r = await tx.execute<{ recebeu: Date | string | null; entrou: Date | string | null }>(sql`
    select (select max(decided_at) from liame.ownership_transfer where tenant_id = ${tenantId} and to_user_id = ${userId} and status = 'aceito') as recebeu,
           (select created_at from liame.membership where tenant_id = ${tenantId} and user_id = ${userId} and revoked_at is null limit 1) as entrou`);
  const recebeuEm = r.rows[0]?.recebeu ? new Date(r.rows[0].recebeu) : null;
  return { desde: recebeuEm ?? new Date(r.rows[0]?.entrou ?? Date.now()), recebeuEm };
}

/** Quando o Dono pode transferir de novo, se ainda não pode (recebeu a propriedade há menos de 7 dias). */
function podeDeNovoEm(recebeuEm: Date | null): Date | null {
  if (!recebeuEm) return null;
  const quando = new Date(recebeuEm.getTime() + DIAS_PARA_TRANSFERIR_DE_NOVO * 86_400_000);
  return quando.getTime() > Date.now() ? quando : null;
}

async function nomeDaEmpresa(tx: Tx, tenantId: string): Promise<string> {
  const r = await tx.execute<{ name: string }>(sql`select name from liame.organization where id = ${tenantId}`);
  return r.rows[0]?.name ?? 'empresa';
}

async function emailDe(tx: Tx, userId: string): Promise<string | null> {
  const r = await tx.execute<{ email: string }>(sql`select email from liame.app_user where id = ${userId}`);
  return r.rows[0]?.email ?? null;
}

function paraOPedido(l: LinhaDoPedido): OwnershipTransfer {
  return {
    id: l.id,
    from: { user_id: l.from_user_id, name: l.from_name },
    to: { user_id: l.to_user_id, name: l.to_name, email: l.to_email },
    old_owner_stays: l.old_owner_stays,
    status: l.status,
    created_at: iso(l.created_at),
    expires_at: iso(l.expires_at),
    decided_at: l.decided_at ? iso(l.decided_at) : null,
  };
}
