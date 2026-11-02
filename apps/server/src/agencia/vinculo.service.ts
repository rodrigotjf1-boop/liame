import type {
  AcceptPartnerRequest,
  AgencyClientAttention,
  AgencyClientResponse,
  AgencyClientsResponse,
  AgencyClientTeamResponse,
  AgencyRequestResponse,
  AgencyRole,
  SetAgencyClientTeamRequest,
  CreatePartnerRequestRequest,
  PartnerRequestResponse,
  PartnerResponse,
  PartnerRole,
  PartnersResponse,
  UpdatePartnerRequest,
} from '@liame/contracts';
import { type Database, type Tx, uuidv7 } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { MfaService } from '../auth/mfa.service.js';
import { ROLE_RANK } from '../auth/permissions.js';
import { RateLimitService } from '../auth/rate-limit.service.js';
import { donoDoEmail, quemAvisarNaAgencia, quemAvisarNaEmpresa } from '../auth/vinculo-de-parceiro.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { afterCommit, auditDetail, type AuthContext, currentTx } from '../context/request-context.js';
import { DATABASE } from '../database/database.module.js';
import { AppProblem, ValidationProblem } from '../errors/problems.js';
import { FlagService } from '../flags/flag.service.js';
import { Mailer } from '../mail/mailer.js';
import { APPROVER_ROLES, ROLE_LABEL } from '../people/grant-rules.js';
import { atencaoDoCliente, CLIENTES_POR_VEZ } from './atencao-dos-clientes.js';

/** A função dos parceiros: sem ela, a empresa não recebe pedido e o Dono não aceita (D-A7-76). */
export const FLAG_PARCEIROS = 'parceiros';
/** O pedido vale 7 dias, como o convite (D-A7-46). */
export const DIAS_DO_PEDIDO = 7;
/** Pedidos por agência por dia (D-A7-46). */
export const PEDIDOS_POR_DIA = 20;

type Termos = { maxRole: PartnerRole; limite: number | null; dupla: boolean; fim: string | null };

type PedidoDaAgencia = {
  id: string;
  owner_email: string;
  requested_role: PartnerRole;
  message: string | null;
  status: 'pedido' | 'recusado';
  requested_by_name: string;
  created_at: Date | string;
  request_expires_at: Date | string;
  decided_at: Date | string | null;
};

type ClienteDaAgencia = {
  id: string;
  client_id: string;
  client_name: string;
  max_role: PartnerRole;
  approve_limit_micros: string | null;
  dual_approval: boolean;
  ends_at: Date | string | null;
  decided_at: Date | string;
  status: 'ativo' | 'desfeito' | 'vencido';
  ended_at: Date | string | null;
  ended_side: 'empresa' | 'agencia' | null;
};

type PedidoAoDono = {
  id: string;
  agency_id: string;
  agency_name: string;
  agency_cnpj: string | null;
  requested_by_name: string;
  requested_role: PartnerRole;
  message: string | null;
  created_at: Date | string;
  request_expires_at: Date | string;
};

type Parceiro = {
  id: string;
  agency_id: string;
  agency_name: string;
  agency_cnpj: string | null;
  max_role: PartnerRole;
  approve_limit_micros: string | null;
  dual_approval: boolean;
  ends_at: Date | string | null;
  decided_at: Date | string;
  accepted_by_name: string | null;
};

const iso = (v: Date | string) => new Date(v).toISOString();
const isoOrNull = (v: Date | string | null) => (v === null ? null : iso(v));
const micros = (v: string | null) => (v === null ? null : Number(v));
const naoEncontrado = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Pedido ou vínculo não encontrado.');
const desligada = () => new AppProblem(409, 'funcao-desligada', 'Função desligada', 'Os parceiros não estão ligados para esta empresa.');
const soODono = () => new AppProblem(403, 'so-o-dono', 'Só o Dono', 'Só o Dono aceita, recusa ou muda o que uma agência pode na conta.');

/**
 * O vínculo de parceiro (A7, W6, parte 2; ADR-017; D-A7-46 a D-A7-50 e D-A7-77). Roda na transação da requisição, com a
 * RLS dos dois lados: a agência vê os pedidos e os clientes dela; a empresa, os vínculos dela; o Dono, o pedido em
 * aberto ao e-mail dele. O que atravessa as organizações (quem é o Dono do e-mail, quem avisar do outro lado) vem das
 * leituras de sistema de `auth/vinculo-de-parceiro.ts`. O time da agência dentro da empresa vem na parte 3: até lá, o
 * vínculo aceito não dá acesso a ninguém.
 */
@Injectable()
export class VinculoService {
  constructor(
    @Inject(DATABASE) private readonly database: Database | null,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly rateLimit: RateLimitService,
    private readonly mailer: Mailer,
    private readonly flags: FlagService,
    private readonly mfa: MfaService,
  ) {}

  private get db(): Database {
    if (!this.database) throw new AppProblem(503, 'indisponivel', 'Serviço indisponível', 'Tente de novo em instantes.');
    return this.database;
  }

  // ================================================================== o lado da agência

  /**
   * Pedir acesso a um cliente (D-A7-46). A resposta é a mesma exista ou não a conta do e-mail: o pedido fica guardado
   * e vence em 7 dias. Só o Dono com a função ligada em alguma empresa recebe o e-mail; pedir de novo ao mesmo e-mail
   * troca o pedido anterior.
   */
  async pedir(auth: AuthContext, input: CreatePartnerRequestRequest): Promise<AgencyRequestResponse> {
    const tx = currentTx();
    const agencyId = await agenciaDe(tx, auth);
    await this.rateLimit.consume(`pedidos:agencia:${agencyId}`, PEDIDOS_POR_DIA, 86400);
    const dono = await donoDoEmail(this.db, input.owner_email);
    await tx.execute(sql`
      update liame.partner_link set status = 'substituido'
       where partner_org_id = ${agencyId} and owner_email = ${input.owner_email} and status = 'pedido'`);
    const id = uuidv7();
    const r = await tx.execute<PedidoDaAgencia>(sql`
      insert into liame.partner_link (id, partner_org_id, owner_email, owner_user_id, requested_role, message, request_expires_at, requested_by)
      values (${id}, ${agencyId}, ${input.owner_email}, ${dono?.userId ?? null}, ${input.requested_role}, ${input.message || null},
              now() + make_interval(days => ${DIAS_DO_PEDIDO}), ${auth.userId})
      returning id, owner_email, requested_role, message, status, ${auth.name}::text as requested_by_name, created_at,
                request_expires_at, decided_at`);
    // Sem o e-mail na auditoria: o pedido ainda não é de ninguém (como o convite).
    auditDetail({ resourceId: id, after: { requested_role: input.requested_role } });

    if (dono && (await this.ligadaEmAlguma(dono.empresas, dono.userId))) {
      const agencia = await nomeDaOrganizacao(tx, agencyId);
      const pedido = r.rows[0]!;
      const cnpj = agencia.cnpj ? ` (CNPJ informado pela agência: ${formatarCnpj(agencia.cnpj)})` : '';
      afterCommit(() =>
        this.mailer.send({
          to: input.owner_email,
          subject: `Liame: ${agencia.name} pede para cuidar da conta da sua empresa`,
          text:
            `${auth.name}, de ${agencia.name}${cnpj}, pede acesso à conta da sua empresa no Liame para o time da agência ` +
            `trabalhar como ${ROLE_LABEL[input.requested_role]}.\n\n` +
            (input.message ? `Mensagem da agência: "${input.message}"\n\n` : '') +
            `Para aceitar ou recusar, entre no Liame e abra Pessoas e acessos: ${this.config.appUrl}/pessoas\n` +
            `O pedido vale até ${dataCurta(pedido.request_expires_at)}. Ao aceitar, você escolhe até onde o time vai, o limite ` +
            'de gasto e quando o acesso termina, e desfaz o vínculo quando quiser. A cobrança fica sempre com você.\n\n' +
            'Se você não conhece a agência, recuse o pedido ou ignore este e-mail.',
        }),
      );
    }
    return toPedidoDaAgencia(r.rows[0]!);
  }

  /** Cancelar um pedido em aberto da própria agência. */
  async cancelarPedido(auth: AuthContext, id: string): Promise<void> {
    const tx = currentTx();
    const agencyId = await agenciaDe(tx, auth);
    const r = await tx.execute(sql`
      update liame.partner_link set status = 'cancelado'
       where id = ${id} and partner_org_id = ${agencyId} and status = 'pedido'`);
    if (r.rowCount !== 1) throw naoEncontrado();
  }

  /**
   * Os clientes da agência (os vínculos aceitos, vivos ou que acabaram) e os pedidos dela, com o acesso de quem pede e o
   * que pede atenção em cada empresa (A7, W7, parte 1; D-A7-52). O membro (sem `agencia.clientes`) vê só os clientes em
   * que está, sem os pedidos e sem o time.
   */
  async clientes(auth: AuthContext): Promise<AgencyClientsResponse> {
    const tx = currentTx();
    const agencyId = await agenciaDe(tx, auth);
    const cuidaDosClientes = auth.permissions.has('agencia.clientes');
    const clientes = await tx.execute<ClienteDaAgencia>(sql`
      select l.id, o.id as client_id, o.name as client_name, l.max_role, l.approve_limit_micros, l.dual_approval, l.ends_at,
             l.decided_at,
             case when l.status = 'ativo' and l.ends_at is not null and l.ends_at <= now() then 'vencido' else l.status end as status,
             coalesce(l.ended_at, case when l.status = 'ativo' and l.ends_at <= now() then l.ends_at end) as ended_at, l.ended_side
        from liame.partner_link l join liame.organization o on o.id = l.client_org_id
       where l.partner_org_id = ${agencyId} and l.status in ('ativo', 'desfeito', 'vencido')
         ${cuidaDosClientes ? sql`` : sql`and l.status = 'ativo' and exists (
           select 1 from liame.membership m where m.partner_link_id = l.id and m.user_id = ${auth.userId} and m.revoked_at is null
              and (m.expires_at is null or m.expires_at > now()))`}
       order by (l.status = 'ativo') desc, o.name, l.decided_at desc
       limit 500`);
    const pedidos = !cuidaDosClientes ? { rows: [] as PedidoDaAgencia[] } : await tx.execute<PedidoDaAgencia>(sql`
      select l.id, l.owner_email, l.requested_role, l.message, l.status, u.name as requested_by_name, l.created_at,
             l.request_expires_at, l.decided_at
        from liame.partner_link l join liame.app_user u on u.id = l.requested_by
       where l.partner_org_id = ${agencyId} and l.status in ('pedido', 'recusado')
       order by l.created_at desc
       limit 500`);
    // Quem do time está em cada empresa: uma consulta para todas (o vínculo vivo de cada pessoa).
    const ids = clientes.rows.filter((c) => c.status === 'ativo').map((c) => c.id);
    const times = ids.length
      ? await tx.execute<{ partner_link_id: string; user_id: string; name: string; role_key: PartnerRole; approve_limit_micros: string | null }>(sql`
          select m.partner_link_id, m.user_id, u.name, m.role_key, m.approve_limit_micros
            from liame.membership m join liame.app_user u on u.id = m.user_id
           where m.partner_link_id in (${sql.join(ids.map((x) => sql`${x}::uuid`), sql`, `)}) and m.revoked_at is null
             and (m.expires_at is null or m.expires_at > now())
           order by u.name`)
      : { rows: [] };
    const porVinculo = new Map<string, Array<{ user_id: string; name: string; role: PartnerRole }>>();
    const meu = new Map<string, { role: PartnerRole; approve_limit_micros: number | null }>();
    for (const t of times.rows) {
      porVinculo.set(t.partner_link_id, [...(porVinculo.get(t.partner_link_id) ?? []), { user_id: t.user_id, name: t.name, role: t.role_key }]);
      if (t.user_id === auth.userId) meu.set(t.partner_link_id, { role: t.role_key, approve_limit_micros: micros(t.approve_limit_micros) });
    }
    // O que pede atenção, lido em cada empresa em que a pessoa está, no contexto dela (poucas por vez).
    const atencao = new Map<string, AgencyClientAttention[]>();
    const vivos = clientes.rows.filter((c) => c.status === 'ativo');
    for (let i = 0; i < vivos.length; i += CLIENTES_POR_VEZ) {
      await Promise.all(
        vivos.slice(i, i + CLIENTES_POR_VEZ).map(async (c) => {
          const itens = meu.has(c.id)
            ? await atencaoDoCliente(this.db, this.flags, { tenantId: c.client_id, userId: auth.userId })
            : [{ kind: 'fora_do_time', count: null, since: null, owner_name: null }];
          atencao.set(c.id, itens);
        }),
      );
    }
    return {
      clients: clientes.rows.map((c) => ({
        ...toClienteDaAgencia(c),
        team: cuidaDosClientes ? (porVinculo.get(c.id) ?? []) : [],
        my_access: meu.get(c.id) ?? null,
        ...(atencao.has(c.id) ? { attention: atencao.get(c.id)! } : {}),
      })),
      requests: pedidos.rows.map(toPedidoDaAgencia),
    };
  }

  /** A agência deixa de cuidar de uma empresa (D-A7-50): corta na hora, sem o código, e avisa o Dono. */
  async deixar(auth: AuthContext, id: string): Promise<void> {
    const tx = currentTx();
    const agencyId = await agenciaDe(tx, auth);
    // O time sai antes do vínculo: a RLS só deixa a agência mexer no vínculo das pessoas enquanto o dela está vivo.
    await tx.execute(sql`
      update liame.membership set revoked_at = now()
       where partner_link_id = ${id} and revoked_at is null
         and exists (select 1 from liame.partner_link l where l.id = ${id} and l.partner_org_id = ${agencyId} and l.status = 'ativo')`);
    const r = await tx.execute<{ client_org_id: string }>(sql`
      update liame.partner_link
         set status = 'desfeito', ended_at = now(), ended_by = ${auth.userId}, ended_side = 'agencia'
       where id = ${id} and partner_org_id = ${agencyId} and status = 'ativo'
       returning client_org_id`);
    const clientId = r.rows[0]?.client_org_id;
    if (!clientId) throw naoEncontrado();
    auditDetail({ resourceId: id, before: { client_org_id: clientId } });
    const agencia = await nomeDaOrganizacao(tx, agencyId);
    const empresa = await nomeDaOrganizacao(tx, clientId);
    const avisar = await quemAvisarNaEmpresa(this.db, clientId);
    for (const email of avisar) {
      afterCommit(() =>
        this.mailer.send({
          to: email,
          subject: `Liame: ${agencia.name} deixou de cuidar da conta de ${empresa.name}`,
          text:
            `${auth.name}, de ${agencia.name}, desfez o vínculo da agência com ${empresa.name} no Liame. O time da agência ` +
            'não entra mais na conta. O que ele fez continua no registro de atividades.\n\n' +
            `Veja quem tem acesso: ${this.config.appUrl}/pessoas`,
        }),
      );
    }
  }

  /** Quem do time da agência entra neste cliente, e até onde (A7, W6, parte 3; D-A7-48). */
  async timeNoCliente(auth: AuthContext, id: string): Promise<AgencyClientTeamResponse> {
    const tx = currentTx();
    const agencyId = await agenciaDe(tx, auth);
    const cliente = await this.clienteVivo(tx, agencyId, id, false);
    const time = await tx.execute<{
      user_id: string;
      name: string;
      email: string;
      agency_role: AgencyRole;
      mfa_enabled: boolean;
      member_id: string | null;
      role_key: PartnerRole | null;
      approve_limit_micros: string | null;
      dual_approval: boolean | null;
    }>(sql`
      select u.id as user_id, u.name, u.email, ma.role_key as agency_role, u.mfa_enabled_at is not null as mfa_enabled,
             mc.id as member_id, mc.role_key, mc.approve_limit_micros, mc.dual_approval
        from liame.membership ma
        join liame.app_user u on u.id = ma.user_id
        left join liame.membership mc on mc.user_id = ma.user_id and mc.partner_link_id = ${id} and mc.revoked_at is null
       where ma.tenant_id = ${agencyId} and ma.revoked_at is null and (ma.expires_at is null or ma.expires_at > now())
       order by u.name`);
    return {
      client: toClienteDaAgencia(cliente),
      team: time.rows.map((t) => ({
        user_id: t.user_id,
        name: t.name,
        email: t.email,
        agency_role: t.agency_role,
        mfa_enabled: t.mfa_enabled,
        in_client:
          t.member_id && t.role_key
            ? { member_id: t.member_id, role: t.role_key, approve_limit_micros: micros(t.approve_limit_micros), dual_approval: t.dual_approval ?? true }
            : null,
      })),
    };
  }

  /**
   * Salvar quem entra no cliente (D-A7-48): a dona ou um administrador da agência escolhe quem do time entra, com o
   * nível e o limite até o máximo do Dono; a pessoa entra só com o app autenticador ativo. Quem sai da lista perde o
   * acesso a este cliente na hora. O Dono recebe um aviso de cada pessoa nova.
   */
  async escolherTime(auth: AuthContext, id: string, input: SetAgencyClientTeamRequest): Promise<AgencyClientTeamResponse> {
    const tx = currentTx();
    const agencyId = await agenciaDe(tx, auth);
    const cliente = await this.clienteVivo(tx, agencyId, id, true);
    const termos: Termos = {
      maxRole: cliente.max_role,
      limite: micros(cliente.approve_limit_micros),
      dupla: cliente.dual_approval,
      fim: isoOrNull(cliente.ends_at),
    };
    const doTime = await tx.execute<{ user_id: string; name: string; mfa_enabled: boolean }>(sql`
      select u.id as user_id, u.name, u.mfa_enabled_at is not null as mfa_enabled
        from liame.membership ma join liame.app_user u on u.id = ma.user_id
       where ma.tenant_id = ${agencyId} and ma.revoked_at is null and (ma.expires_at is null or ma.expires_at > now())`);
    const pessoas = new Map(doTime.rows.map((p) => [p.user_id, p]));
    const pedidos = input.members.map((m) => {
      const pessoa = pessoas.get(m.user_id);
      if (!pessoa) throw new AppProblem(404, 'fora-do-time', 'Não está no time', 'Só quem está no time da agência entra num cliente.');
      if (!pessoa.mfa_enabled) {
        throw new AppProblem(409, 'sem-app-autenticador', 'Falta o app autenticador', `${pessoa.name} só entra num cliente com o app autenticador ativo.`);
      }
      return { ...m, nome: pessoa.name, acesso: dentroDoMaximo(m, termos, pessoa.name) };
    });

    const atuais = await tx.execute<{ id: string; user_id: string; role_key: PartnerRole }>(sql`
      select id, user_id, role_key from liame.membership where partner_link_id = ${id} and revoked_at is null for update`);
    const ficam = new Set(pedidos.map((p) => p.user_id));
    const saem = atuais.rows.filter((a) => !ficam.has(a.user_id)).map((a) => a.id);
    if (saem.length) {
      await tx.execute(sql`
        update liame.membership set revoked_at = now()
         where partner_link_id = ${id} and revoked_at is null and id in (${sql.join(saem.map((x) => sql`${x}::uuid`), sql`, `)})`);
    }
    const jaEstao = new Map(atuais.rows.map((a) => [a.user_id, a.id]));
    const novos: Array<{ nome: string; role: PartnerRole }> = [];
    for (const p of pedidos) {
      const existente = jaEstao.get(p.user_id);
      if (existente) {
        await tx.execute(sql`
          update liame.membership
             set role_key = ${p.acesso.role}, approve_limit_micros = ${p.acesso.limite}, dual_approval = ${p.acesso.dupla}, expires_at = ${termos.fim}
           where id = ${existente}`);
        continue;
      }
      try {
        // Num ponto de salvamento: a pessoa que já tem acesso direto à empresa (pelo convite do Dono) não entra duas vezes.
        await tx.transaction(async (sp) => {
          await sp.execute(sql`
            insert into liame.membership (id, tenant_id, user_id, role_key, approve_limit_micros, dual_approval, billing_access,
                                          expires_at, invited_by, partner_link_id)
            values (${uuidv7()}, ${cliente.client_id}, ${p.user_id}, ${p.acesso.role}, ${p.acesso.limite}, ${p.acesso.dupla}, false,
                    ${termos.fim}, ${auth.userId}, ${id})`);
        });
      } catch (err) {
        if ((err as { code?: string; cause?: { code?: string } }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505') {
          throw new AppProblem(409, 'ja-tem-acesso', 'Já tem acesso', `${p.nome} já tem acesso a ${cliente.client_name} por convite do Dono.`);
        }
        throw err;
      }
      novos.push({ nome: p.nome, role: p.acesso.role });
    }
    auditDetail({
      resourceId: id,
      after: { client_org_id: cliente.client_id, members: pedidos.map((p) => ({ user_id: p.user_id, role: p.acesso.role })), removed: saem.length },
    });
    if (novos.length) {
      const agencia = await nomeDaOrganizacao(tx, agencyId);
      const lista = novos.map((n) => `- ${n.nome}, como ${ROLE_LABEL[n.role]}`).join('\n');
      for (const email of await quemAvisarNaEmpresa(this.db, cliente.client_id)) {
        afterCommit(() =>
          this.mailer.send({
            to: email,
            subject: `Liame: ${agencia.name} colocou ${novos.length === 1 ? 'uma pessoa' : `${novos.length} pessoas`} na conta de ${cliente.client_name}`,
            text:
              `${auth.name}, de ${agencia.name}, colocou na conta de ${cliente.client_name} no Liame:\n\n${lista}\n\n` +
              `Cada pessoa entra com o próprio login e o app autenticador, até o máximo que você deu à agência.\n` +
              `Veja quem tem acesso: ${this.config.appUrl}/pessoas\n` +
              'Se você não reconhece alguém, tire a pessoa ou desfaça o vínculo com a agência.',
          }),
        );
      }
    }
    return this.timeNoCliente(auth, id);
  }

  // ================================================================== o lado da empresa

  /** As agências com vínculo nesta empresa e, para o Dono, os pedidos em aberto ao e-mail dele. */
  async parceiros(auth: AuthContext): Promise<PartnersResponse> {
    const tx = currentTx();
    const tenantId = empresaDe(auth);
    const enabled = await this.ligada(tenantId, auth.userId);
    const pedidos =
      enabled && auth.roleKey === 'dono'
        ? await tx.execute<PedidoAoDono>(sql`
            select l.id, a.id as agency_id, a.name as agency_name, a.cnpj as agency_cnpj, u.name as requested_by_name,
                   l.requested_role, l.message, l.created_at, l.request_expires_at
              from liame.partner_link l
              join liame.organization a on a.id = l.partner_org_id and a.status = 'ativa'
              join liame.app_user u on u.id = l.requested_by
             where l.status = 'pedido' and l.owner_user_id = ${auth.userId} and l.request_expires_at > now()
             order by l.created_at desc
             limit 100`)
        : { rows: [] as PedidoAoDono[] };
    // Com a função desligada, o vínculo que já existe continua na lista, para o Dono poder desfazer.
    const parceiros = await tx.execute<Parceiro>(sql`
      select l.id, a.id as agency_id, a.name as agency_name, a.cnpj as agency_cnpj, l.max_role, l.approve_limit_micros,
             l.dual_approval, l.ends_at, l.decided_at, d.name as accepted_by_name
        from liame.partner_link l
        join liame.organization a on a.id = l.partner_org_id
        left join liame.app_user d on d.id = l.decided_by
       where l.client_org_id = ${tenantId} and l.status = 'ativo' and (l.ends_at is null or l.ends_at > now())
       order by a.name
       limit 100`);
    return { enabled, requests: pedidos.rows.map(toPedidoAoDono), partners: parceiros.rows.map(toParceiro) };
  }

  /**
   * Aceitar o pedido (D-A7-47): só o Dono, com o código do app, para a empresa ativa (o Dono com mais de uma empresa
   * escolhe ao abrir Pessoas e acessos dela; D-A7-77). O máximo nunca é o Dono, e o limite segue a regra dos convites.
   */
  async aceitar(auth: AuthContext, id: string, input: AcceptPartnerRequest): Promise<PartnerResponse> {
    const tx = currentTx();
    const tenantId = empresaDe(auth);
    if (auth.roleKey !== 'dono') throw soODono();
    if (!(await this.ligada(tenantId, auth.userId))) throw desligada();
    const pedido = await this.pedidoAoDono(tx, auth, id);
    const termos = conferirTermos({ maxRole: input.max_role, limite: input.approve_limit_micros, dupla: input.dual_approval, fim: input.ends_at ?? null });
    await this.mfa.verifyStepUp(tx, auth.userId, input.code);
    // O vínculo que venceu pela data de fim sai do caminho; o vivo impede um segundo.
    await tx.execute(sql`
      update liame.partner_link set status = 'vencido', ended_at = ends_at
       where partner_org_id = ${pedido.agency_id} and client_org_id = ${tenantId} and status = 'ativo' and ends_at <= now()`);
    const vivo = await tx.execute(sql`
      select 1 from liame.partner_link where partner_org_id = ${pedido.agency_id} and client_org_id = ${tenantId} and status = 'ativo'`);
    if (vivo.rows[0]) {
      throw new AppProblem(409, 'ja-tem-vinculo', 'A agência já tem acesso', 'Esta agência já tem um vínculo com esta empresa: mude o que ela pode na lista.');
    }
    await tx.execute(sql`
      update liame.partner_link
         set status = 'ativo', client_org_id = ${tenantId}, max_role = ${termos.maxRole}, approve_limit_micros = ${termos.limite},
             dual_approval = ${termos.dupla}, ends_at = ${termos.fim}, decided_by = ${auth.userId}, decided_at = now()
       where id = ${id}`);
    auditDetail({ resourceId: id, after: { agency_id: pedido.agency_id, ...detalhe(termos) } });
    const empresa = await nomeDaOrganizacao(tx, tenantId);
    await this.avisarAgencia(pedido.agency_id, `Liame: ${empresa.name} aceitou o pedido de ${pedido.agency_name}`, [
      `${auth.name} aceitou o pedido de ${pedido.agency_name} para cuidar da conta de ${empresa.name} no Liame.`,
      descreverTermos(termos),
      `Agora escolha quem do time entra nesse cliente, em Clientes: ${this.config.appUrl}/agencia/clientes`,
    ]);
    return {
      id,
      agency: { id: pedido.agency_id, name: pedido.agency_name, cnpj: pedido.agency_cnpj },
      max_role: termos.maxRole,
      approve_limit_micros: termos.limite,
      dual_approval: termos.dupla,
      ends_at: termos.fim,
      since: new Date().toISOString(),
      accepted_by_name: auth.name,
    };
  }

  /** Recusar (D-A7-47): só o Dono, sem o código; a agência é avisada sem o motivo e sem saber qual empresa recusou. */
  async recusar(auth: AuthContext, id: string): Promise<void> {
    const tx = currentTx();
    const tenantId = empresaDe(auth);
    if (auth.roleKey !== 'dono') throw soODono();
    if (!(await this.ligada(tenantId, auth.userId))) throw desligada();
    const pedido = await this.pedidoAoDono(tx, auth, id);
    await tx.execute(sql`
      update liame.partner_link set status = 'recusado', client_org_id = ${tenantId}, decided_by = ${auth.userId}, decided_at = now()
       where id = ${id}`);
    auditDetail({ resourceId: id, after: { agency_id: pedido.agency_id } });
    await this.avisarAgencia(pedido.agency_id, 'Liame: o pedido de acesso foi recusado', [
      `O pedido de ${pedido.agency_name} para ${pedido.owner_email} foi recusado. O Liame não informa o motivo.`,
      `Veja os pedidos em Clientes: ${this.config.appUrl}/agencia/clientes`,
    ]);
  }

  /**
   * Mudar o que a agência pode (D-A7-49): só o Dono. Baixar vale na hora, sem o código; subir (o nível, o limite, tirar
   * o "eu também aprovo" ou estender a data de fim) pede o código do app. A agência é avisada.
   */
  async mudar(auth: AuthContext, id: string, input: UpdatePartnerRequest): Promise<PartnerResponse> {
    const tx = currentTx();
    const tenantId = empresaDe(auth);
    if (auth.roleKey !== 'dono') throw soODono();
    if (!(await this.ligada(tenantId, auth.userId))) throw desligada();
    const atual = await this.vinculoDaEmpresa(tx, tenantId, id);
    const antes: Termos = {
      maxRole: atual.max_role,
      limite: micros(atual.approve_limit_micros),
      dupla: atual.dual_approval,
      fim: isoOrNull(atual.ends_at),
    };
    const maxRole = input.max_role ?? antes.maxRole;
    // Quem passa a aprovar precisa de um limite informado; quem já aprovava mantém o dele.
    const limiteDeAntes = APPROVER_ROLES.has(antes.maxRole) ? antes.limite : undefined;
    const depois = conferirTermos({
      maxRole,
      limite: input.approve_limit_micros !== undefined ? input.approve_limit_micros : limiteDeAntes,
      dupla: input.dual_approval ?? antes.dupla,
      fim: input.ends_at !== undefined ? input.ends_at : antes.fim,
    });
    if (sobe(antes, depois)) {
      if (!input.code) {
        throw new ValidationProblem([{ path: 'code', message: 'Subir o nível ou o limite pede os 6 números do app.' }]);
      }
      await this.mfa.verifyStepUp(tx, auth.userId, input.code);
    }
    await tx.execute(sql`
      update liame.partner_link
         set max_role = ${depois.maxRole}, approve_limit_micros = ${depois.limite}, dual_approval = ${depois.dupla}, ends_at = ${depois.fim}
       where id = ${id} and client_org_id = ${tenantId} and status = 'ativo'`);
    // Quem do time estava acima do máximo novo desce para ele, na hora (D-A7-49), e o acesso de todos acaba na data nova.
    const desceram = await this.ajustarTime(tx, tenantId, id, depois);
    auditDetail({ resourceId: id, before: detalhe(antes), after: { ...detalhe(depois), team_lowered: desceram } });
    const empresa = await nomeDaOrganizacao(tx, tenantId);
    await this.avisarAgencia(atual.agency_id, `Liame: ${empresa.name} mudou o que ${atual.agency_name} pode`, [
      `${auth.name} mudou o que ${atual.agency_name} pode fazer na conta de ${empresa.name} no Liame.`,
      descreverTermos(depois),
      ...(desceram ? [`${desceram === 1 ? 'Uma pessoa do time estava acima e desceu' : `${desceram} pessoas do time estavam acima e desceram`} para o novo máximo.`] : []),
    ]);
    return toParceiro({ ...atual, max_role: depois.maxRole, approve_limit_micros: depois.limite === null ? null : String(depois.limite), dual_approval: depois.dupla, ends_at: depois.fim });
  }

  /**
   * Desfazer o vínculo pela empresa (D-A7-50): quem remove pessoas (o Dono, o Administrador) corta na hora, sem o código,
   * mesmo com a função desligada (tirar acesso nunca espera). A agência é avisada.
   */
  async desfazer(auth: AuthContext, id: string): Promise<void> {
    const tx = currentTx();
    const tenantId = empresaDe(auth);
    const atual = await this.vinculoDaEmpresa(tx, tenantId, id);
    await tx.execute(sql`
      update liame.partner_link set status = 'desfeito', ended_at = now(), ended_by = ${auth.userId}, ended_side = 'empresa'
       where id = ${id} and client_org_id = ${tenantId} and status = 'ativo'`);
    // O time inteiro da agência sai desta empresa na hora (D-A7-50).
    await tx.execute(sql`
      update liame.membership set revoked_at = now() where tenant_id = ${tenantId} and partner_link_id = ${id} and revoked_at is null`);
    auditDetail({ resourceId: id, before: { agency_id: atual.agency_id, max_role: atual.max_role } });
    const empresa = await nomeDaOrganizacao(tx, tenantId);
    await this.avisarAgencia(atual.agency_id, `Liame: ${empresa.name} desfez o vínculo com ${atual.agency_name}`, [
      `${auth.name} desfez o vínculo de ${atual.agency_name} com ${empresa.name} no Liame. O time da agência não entra mais na conta.`,
      'A agência pode pedir acesso de novo.',
    ]);
  }

  // ================================================================== apoio

  private async ligada(tenantId: string, userId: string): Promise<boolean> {
    return this.flags.isEnabled(FLAG_PARCEIROS, this.flags.context({ tenantId, userId }));
  }

  private async ligadaEmAlguma(empresas: string[], userId: string): Promise<boolean> {
    for (const tenantId of empresas) if (await this.ligada(tenantId, userId)) return true;
    return false;
  }

  /** O pedido em aberto ao e-mail do Dono, preso para a decisão (dois cliques ao mesmo tempo: um vale). */
  private async pedidoAoDono(tx: Tx, auth: AuthContext, id: string): Promise<PedidoAoDono & { owner_email: string }> {
    const r = await tx.execute<PedidoAoDono & { owner_email: string }>(sql`
      select l.id, a.id as agency_id, a.name as agency_name, a.cnpj as agency_cnpj, u.name as requested_by_name,
             l.requested_role, l.message, l.created_at, l.request_expires_at, l.owner_email
        from liame.partner_link l
        join liame.organization a on a.id = l.partner_org_id and a.status = 'ativa'
        join liame.app_user u on u.id = l.requested_by
       where l.id = ${id} and l.status = 'pedido' and l.owner_user_id = ${auth.userId} and l.request_expires_at > now()
       for update of l`);
    const pedido = r.rows[0];
    if (!pedido) throw naoEncontrado();
    return pedido;
  }

  private async vinculoDaEmpresa(tx: Tx, tenantId: string, id: string): Promise<Parceiro> {
    const r = await tx.execute<Parceiro>(sql`
      select l.id, a.id as agency_id, a.name as agency_name, a.cnpj as agency_cnpj, l.max_role, l.approve_limit_micros,
             l.dual_approval, l.ends_at, l.decided_at, d.name as accepted_by_name
        from liame.partner_link l
        join liame.organization a on a.id = l.partner_org_id
        left join liame.app_user d on d.id = l.decided_by
       where l.id = ${id} and l.client_org_id = ${tenantId} and l.status = 'ativo'
       for update of l`);
    const vinculo = r.rows[0];
    if (!vinculo) throw naoEncontrado();
    return vinculo;
  }

  /** O vínculo vivo da agência com um cliente (a data de fim ainda não passou), preso quando vai mudar o time. */
  private async clienteVivo(tx: Tx, agencyId: string, id: string, prender: boolean): Promise<ClienteDaAgencia> {
    const r = await tx.execute<ClienteDaAgencia>(sql`
      select l.id, o.id as client_id, o.name as client_name, l.max_role, l.approve_limit_micros, l.dual_approval, l.ends_at,
             l.decided_at, l.status, l.ended_at, l.ended_side
        from liame.partner_link l join liame.organization o on o.id = l.client_org_id
       where l.id = ${id} and l.partner_org_id = ${agencyId} and l.status = 'ativo' and (l.ends_at is null or l.ends_at > now())
       ${prender ? sql`for update of l` : sql``}`);
    const cliente = r.rows[0];
    if (!cliente) throw naoEncontrado();
    return cliente;
  }

  /**
   * O time da agência no novo máximo (D-A7-49): quem estava acima desce, o limite acima do novo vira o novo, e o acesso
   * de todos acaba na data de fim nova. Uma consulta para o time inteiro. Devolve quantos desceram.
   */
  private async ajustarTime(tx: Tx, tenantId: string, id: string, termos: Termos): Promise<number> {
    const r = await tx.execute<{ id: string; role_key: PartnerRole; approve_limit_micros: string | null; dual_approval: boolean }>(sql`
      select id, role_key, approve_limit_micros, dual_approval from liame.membership
       where tenant_id = ${tenantId} and partner_link_id = ${id} and revoked_at is null
       for update`);
    if (!r.rows.length) return 0;
    const ajustes = r.rows.map((m) => ({
      id: m.id,
      ...ajustarAoMaximo({ role: m.role_key, limite: micros(m.approve_limit_micros), dupla: m.dual_approval }, termos),
    }));
    await tx.execute(sql`
      update liame.membership m
         set role_key = v.role_key, approve_limit_micros = v.limite, dual_approval = v.dupla, expires_at = ${termos.fim}::timestamptz
        from (values ${sql.join(
          ajustes.map((a) => sql`(${a.id}::uuid, ${a.role}::text, ${a.limite}::bigint, ${a.dupla}::boolean)`),
          sql`, `,
        )}) as v (id, role_key, limite, dupla)
       where m.id = v.id and m.tenant_id = ${tenantId}`);
    return ajustes.filter((a) => a.mudou).length;
  }

  /** O aviso à dona e aos administradores da agência, depois do commit. */
  private async avisarAgencia(agencyId: string, subject: string, linhas: string[]): Promise<void> {
    const text = linhas.join('\n\n');
    for (const email of await quemAvisarNaAgencia(this.db, agencyId)) afterCommit(() => this.mailer.send({ to: email, subject, text }));
  }
}

// ------------------------------------------------------------------ regras puras

/**
 * Confere os termos do vínculo como os do convite (ninguém dá mais do que o Dono tem; ADR-017): o nível que aprova
 * precisa de limite informado (nulo = sem limite); o que não aprova fica sem limite e com o "eu também aprovo".
 */
export function conferirTermos(t: { maxRole: PartnerRole; limite: number | null | undefined; dupla: boolean; fim: string | null }): Termos {
  if (!APPROVER_ROLES.has(t.maxRole)) return { maxRole: t.maxRole, limite: null, dupla: true, fim: t.fim };
  if (t.limite === undefined) throw new ValidationProblem([{ path: 'approve_limit_micros', message: 'Informe o limite de aprovação por ação.' }]);
  return { maxRole: t.maxRole, limite: t.limite, dupla: t.dupla, fim: t.fim };
}

/** Subir é dar mais poder à agência: o nível, o limite (ou tirar o limite), tirar o "eu também aprovo" ou dar mais tempo. */
export function sobe(antes: Termos, depois: Termos): boolean {
  if (ROLE_RANK[depois.maxRole] > ROLE_RANK[antes.maxRole]) return true;
  const aprovaAntes = APPROVER_ROLES.has(antes.maxRole);
  if (APPROVER_ROLES.has(depois.maxRole)) {
    if (!aprovaAntes) return true;
    if (antes.limite !== null && (depois.limite === null || depois.limite > antes.limite)) return true;
    if (antes.dupla && !depois.dupla) return true;
  }
  if (antes.fim !== null && (depois.fim === null || Date.parse(depois.fim) > Date.parse(antes.fim))) return true;
  return false;
}

/**
 * O acesso de uma pessoa do time no novo máximo do Dono (D-A7-49): o nível acima desce para o máximo; quem não aprova
 * fica sem limite; o limite acima do máximo vira o máximo; com o "eu também aprovo" do Dono, ele vale para todos.
 * `mudou` diz se a pessoa desceu ou perdeu limite.
 */
export function ajustarAoMaximo(
  m: { role: PartnerRole; limite: number | null; dupla: boolean },
  t: Termos,
): { role: PartnerRole; limite: number | null; dupla: boolean; mudou: boolean } {
  const role = ROLE_RANK[m.role] > ROLE_RANK[t.maxRole] ? t.maxRole : m.role;
  if (!APPROVER_ROLES.has(role)) return { role, limite: null, dupla: true, mudou: role !== m.role || m.limite !== null };
  const limite = t.limite !== null && (m.limite === null || m.limite > t.limite) ? t.limite : m.limite;
  const dupla = t.dupla ? true : m.dupla;
  return { role, limite, dupla, mudou: role !== m.role || limite !== m.limite || dupla !== m.dupla };
}

/**
 * O acesso que a agência pede para uma pessoa, conferido contra o máximo do Dono (D-A7-48): nunca acima do nível, nunca
 * acima do limite (sem limite, só se o Dono deu sem limite), e com o "eu também aprovo" quando o Dono o quis. Sem o
 * limite, quem aprova fica com o do Dono.
 */
export function dentroDoMaximo(
  m: { role: PartnerRole; approve_limit_micros?: number | null; dual_approval?: boolean },
  t: Termos,
  nome: string,
): { role: PartnerRole; limite: number | null; dupla: boolean } {
  if (ROLE_RANK[m.role] > ROLE_RANK[t.maxRole]) {
    throw new AppProblem(403, 'acima-do-maximo', 'Acima do que o Dono deu', `${nome} não pode entrar como ${ROLE_LABEL[m.role]}: o máximo da agência neste cliente é ${ROLE_LABEL[t.maxRole]}.`);
  }
  if (!APPROVER_ROLES.has(m.role)) return { role: m.role, limite: null, dupla: true };
  const limite = m.approve_limit_micros === undefined ? t.limite : m.approve_limit_micros;
  if (t.limite !== null && (limite === null || limite > t.limite)) {
    throw new AppProblem(403, 'limite-acima-do-maximo', 'Limite acima do que o Dono deu', `O limite de ${nome} não pode passar do limite que o Dono deu à agência.`);
  }
  if (t.dupla && m.dual_approval === false) {
    throw new AppProblem(403, 'aprovacao-dupla-do-dono', 'O Dono também aprova', 'Acima do limite, o Dono também aprova: isso vale para todo o time da agência.');
  }
  return { role: m.role, limite, dupla: t.dupla ? true : (m.dual_approval ?? true) };
}

function detalhe(t: Termos): Record<string, unknown> {
  return { max_role: t.maxRole, approve_limit_micros: t.limite, dual_approval: t.dupla, ends_at: t.fim };
}

function descreverTermos(t: Termos): string {
  const nivel = `Até onde o time pode ir: ${ROLE_LABEL[t.maxRole]}.`;
  const limite = !APPROVER_ROLES.has(t.maxRole)
    ? ' Sem aprovação de gastos.'
    : ` Aprova sozinho até ${t.limite === null ? 'qualquer valor' : (t.limite / 1_000_000).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} por ação${t.dupla ? '; acima disso, o Dono também aprova' : ''}.`;
  const fim = t.fim ? ` O acesso vale até ${dataCurta(t.fim)}.` : ' O acesso vale até o Dono desfazer.';
  return `${nivel}${limite}${fim}`;
}

/** Uma data como o Brasil lê (o pedido ainda não tem empresa: o horário de Brasília). */
function dataCurta(v: Date | string): string {
  return new Date(v).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

function formatarCnpj(c: string): string {
  return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

// ------------------------------------------------------------------ quem pede

/** A agência ativa: as permissões `agencia.*` só existem nos papéis da agência, e o tipo é conferido de novo aqui. */
async function agenciaDe(tx: Tx, auth: AuthContext): Promise<string> {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma organização', 'Selecione a agência para continuar.');
  const r = await tx.execute<{ kind: string }>(sql`select kind from liame.organization where id = ${auth.tenantId}`);
  if (r.rows[0]?.kind !== 'agencia') {
    throw new AppProblem(403, 'nao-e-agencia', 'Não é uma agência', 'Esta tela é da agência: troque para ela no seletor do alto do menu.');
  }
  return auth.tenantId;
}

function empresaDe(auth: AuthContext): string {
  if (!auth.tenantId) throw new AppProblem(403, 'sem-empresa-ativa', 'Escolha uma empresa', 'Selecione uma empresa com acesso ativo.');
  return auth.tenantId;
}

async function nomeDaOrganizacao(tx: Tx, id: string): Promise<{ name: string; cnpj: string | null }> {
  const r = await tx.execute<{ name: string; cnpj: string | null }>(sql`select name, cnpj from liame.organization where id = ${id}`);
  return r.rows[0] ?? { name: 'a organização', cnpj: null };
}

// ------------------------------------------------------------------ respostas

function toPedidoDaAgencia(r: PedidoDaAgencia): AgencyRequestResponse {
  const vencido = r.status === 'pedido' && new Date(r.request_expires_at).getTime() <= Date.now();
  return {
    id: r.id,
    owner_email: r.owner_email,
    requested_role: r.requested_role,
    message: r.message,
    status: r.status === 'recusado' ? 'recusado' : vencido ? 'vencido' : 'esperando',
    requested_by_name: r.requested_by_name,
    created_at: iso(r.created_at),
    expires_at: iso(r.request_expires_at),
    decided_at: isoOrNull(r.decided_at),
  };
}

function toClienteDaAgencia(r: ClienteDaAgencia): AgencyClientResponse {
  return {
    id: r.id,
    organization: { id: r.client_id, name: r.client_name },
    max_role: r.max_role,
    approve_limit_micros: micros(r.approve_limit_micros),
    dual_approval: r.dual_approval,
    ends_at: isoOrNull(r.ends_at),
    since: iso(r.decided_at),
    status: r.status,
    ended_at: isoOrNull(r.ended_at),
    ended_side: r.ended_side,
  };
}

function toPedidoAoDono(r: PedidoAoDono): PartnerRequestResponse {
  return {
    id: r.id,
    agency: { id: r.agency_id, name: r.agency_name, cnpj: r.agency_cnpj },
    requested_by_name: r.requested_by_name,
    requested_role: r.requested_role,
    message: r.message,
    created_at: iso(r.created_at),
    expires_at: iso(r.request_expires_at),
  };
}

function toParceiro(r: Parceiro): PartnerResponse {
  return {
    id: r.id,
    agency: { id: r.agency_id, name: r.agency_name, cnpj: r.agency_cnpj },
    max_role: r.max_role,
    approve_limit_micros: micros(r.approve_limit_micros),
    dual_approval: r.dual_approval,
    ends_at: isoOrNull(r.ends_at),
    since: iso(r.decided_at),
    accepted_by_name: r.accepted_by_name,
  };
}
