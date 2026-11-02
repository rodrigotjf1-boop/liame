import {
  ACCOUNT_RECOVERY_DOCUMENT_LIMITS,
  type AccountRecovery,
  type AccountRecoveryCompany,
  type AccountRecoveryReason,
  type MyAccountRecoveryResponse,
} from '@liame/contracts';
import { type Tx, uuidv7 } from '@liame/database';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { APP_CONFIG, type AppConfig } from '../../config.js';
import { afterCommit, auditDetail, type AuthContext, currentTx } from '../../context/request-context.js';
import { AppProblem } from '../../errors/problems.js';
import { Mailer } from '../../mail/mailer.js';
import { ATENDIMENTO } from '../../suporte.js';
import { RateLimitService } from '../rate-limit.service.js';
import { lacrar } from './lacre.js';

// A recuperação da conta do Dono (A7, W8, parte 4a; ADR-013; P34; D-A7-62, D-A7-64; D-A7-85). Quem perdeu o celular e
// os códigos pede na própria entrada, depois da senha: a sessão provou o e-mail e a senha (o canal já cadastrado), e
// ainda não passou pelo app. O pedido vale para a pessoa (o app autenticador é dela, não da empresa) e lista as empresas
// de que ela é a dona, para a DMS conferir o quadro de sócios. O documento com foto vai lacrado com a chave pública da
// DMS (`lacre.ts`): o servidor guarda e apaga, mas não abre. Roda na transação da requisição, no contexto da pessoa (a
// RLS limita aos pedidos dela).

/** A espera de segurança depois da conferência da DMS (D-A7-62). */
export const DIAS_DE_ESPERA = 7;
/** Os documentos saem 30 dias depois da decisão (D-A7-64). */
export const DIAS_DOS_DOCUMENTOS = 30;
/** O último pedido que terminou aparece para a pessoa por 30 dias. */
const DIAS_DO_ULTIMO = 30;
/** Até 3 pedidos por dia por pessoa (cada um leva um documento de até 10 MB). */
const PEDIDOS_POR_DIA = 3;

/** As situações em que o pedido anda (e um só por pessoa). */
export const EM_ANDAMENTO = ['pedido', 'conferido', 'parado'] as const;

type LinhaDoPedido = {
  id: string;
  protocol: string;
  status: AccountRecovery['status'];
  reason: AccountRecoveryReason;
  companies: AccountRecoveryCompany[] | string;
  created_at: Date | string;
  checked_at: Date | string | null;
  applies_at: Date | string | null;
  refusal_reason: string | null;
  cancelled_by: 'voce' | 'entrou' | null;
  closed_at: Date | string | null;
};

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const isoOuNulo = (v: Date | string | null): string | null => (v == null ? null : iso(v));

const naoEncontrado = () => new AppProblem(404, 'nao-encontrado', 'Não encontramos', 'Este pedido de recuperação não existe ou já terminou.');

/** O pedido como a pessoa vê. */
export function paraResposta(r: LinhaDoPedido): AccountRecovery {
  const companies = typeof r.companies === 'string' ? (JSON.parse(r.companies) as AccountRecoveryCompany[]) : r.companies;
  return {
    id: r.id,
    protocol: r.protocol,
    status: r.status,
    reason: r.reason,
    companies: semId(companies),
    created_at: iso(r.created_at),
    checked_at: isoOuNulo(r.checked_at),
    applies_at: r.status === 'conferido' ? isoOuNulo(r.applies_at) : null,
    refusal_reason: r.status === 'recusado' ? r.refusal_reason : null,
    cancelled_by: r.status === 'cancelado' ? r.cancelled_by : null,
    closed_at: isoOuNulo(r.closed_at),
  };
}

/** O tipo do documento, lido do começo do arquivo (nunca do nome ou do cabeçalho): JPG, PNG ou PDF. */
export function tipoDoDocumento(bytes: Buffer): (typeof ACCOUNT_RECOVERY_DOCUMENT_LIMITS.types)[number] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  return null;
}

/** Uma empresa no retrato do pedido: o id fica guardado (a auditoria da DMS vai para cada uma), a pessoa vê nome e CNPJ. */
export type EmpresaDoPedido = AccountRecoveryCompany & { tenant_id: string };

/** As empresas vivas de que a pessoa é a dona (a RLS deixa a pessoa ler os próprios vínculos e as empresas deles). */
export async function empresasDoDono(tx: Tx, userId: string): Promise<EmpresaDoPedido[]> {
  const r = await tx.execute<{ tenant_id: string; name: string; cnpj: string | null }>(sql`
    select o.id as tenant_id, o.name, o.cnpj
      from liame.membership m join liame.organization o on o.id = m.tenant_id
     where m.user_id = ${userId} and m.role_key = 'dono' and m.revoked_at is null and o.status <> 'encerrada'
     order by o.name`);
  return r.rows.map((c) => ({ tenant_id: c.tenant_id, name: c.name, cnpj: c.cnpj }));
}

const semId = (empresas: readonly AccountRecoveryCompany[]): AccountRecoveryCompany[] => empresas.map((c) => ({ name: c.name, cnpj: c.cnpj ?? null }));

/**
 * O Dono entrou com o app ou com um código de recuperação: o pedido em andamento cai sozinho (D-A7-62). Roda na
 * transação de quem entrou (o contexto dele). Devolve o protocolo do pedido que caiu, para o aviso.
 */
export async function cairPorqueEntrou(tx: Tx, userId: string): Promise<string | null> {
  const r = await tx.execute<{ protocol: string }>(sql`
    update liame.account_recovery
       set status = 'cancelado', cancelled_by = 'entrou', closed_at = now(), notified_status = 'cancelado',
           documents_expire_at = now() + make_interval(days => ${DIAS_DOS_DOCUMENTOS})
     where user_id = ${userId} and status in ('pedido', 'conferido', 'parado')
     returning protocol`);
  return r.rows[0]?.protocol ?? null;
}

@Injectable()
export class RecuperacaoDaContaService {
  constructor(
    private readonly mailer: Mailer,
    private readonly rateLimit: RateLimitService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** O pedido mais recente, as empresas de que a pessoa é a dona e se dá para pedir agora. */
  async minha(auth: AuthContext): Promise<MyAccountRecoveryResponse> {
    const tx = currentTx();
    const [donoDe, recovery] = await Promise.all([empresasDoDono(tx, auth.userId), this.ultimo(tx, auth.userId)]);
    const ownerOf = semId(donoDe);
    return { recovery, owner_of: ownerOf, cannot_request: this.porQueNao(auth, ownerOf, recovery) };
  }

  /** O pedido, com o documento com foto cru no corpo. */
  async pedir(auth: AuthContext, reason: AccountRecoveryReason, corpo: unknown): Promise<MyAccountRecoveryResponse> {
    const tx = currentTx();
    const chave = this.config.recuperacaoChavePublica;
    if (!chave) {
      throw new AppProblem(
        503,
        'recuperacao-indisponivel',
        'Recuperação indisponível',
        `A recuperação pela entrada ainda não está ligada. Fale com o suporte: ${ATENDIMENTO.email}.`,
      );
    }
    if (!auth.mfaConfigured) throw new AppProblem(409, 'sem-segundo-fator', 'Nada a recuperar', 'A sua conta não tem app autenticador: entre só com a senha.');
    if (auth.mfaVerifiedAt) {
      throw new AppProblem(409, 'ja-entrou', 'Você já entrou', 'Você já passou pelo app nesta sessão: troque o app em Segurança da conta.');
    }
    // Uma trava por pessoa: dois pedidos ao mesmo tempo não passam juntos pela conferência de "um em andamento".
    await tx.execute(sql`select id from liame.app_user where id = ${auth.userId} for update`);
    const empresas = await empresasDoDono(tx, auth.userId);
    if (!empresas.length) {
      throw new AppProblem(403, 'nao-e-dono', 'Só o Dono pede', 'A recuperação pela DMS é só para o Dono. Peça ao Dono da empresa para ajudar você a entrar.');
    }
    const aberto = await tx.execute(sql`select 1 from liame.account_recovery where user_id = ${auth.userId} and status in ('pedido', 'conferido', 'parado')`);
    if (aberto.rows.length) throw new AppProblem(409, 'pedido-em-andamento', 'Já há um pedido', 'Você já tem um pedido de recuperação em andamento.');
    const bytes = Buffer.isBuffer(corpo) ? corpo : null;
    if (!bytes?.length) throw new AppProblem(400, 'falta-o-documento', 'Falta o documento', 'Mande o seu documento com foto.');
    const tipo = tipoDoDocumento(bytes);
    if (!tipo) throw new AppProblem(422, 'documento-formato', 'Formato não aceito', 'Mande o documento em JPG, PNG ou PDF.');
    await this.rateLimit.consume(`recuperacao:${auth.userId}`, PEDIDOS_POR_DIA, 86_400);

    const id = uuidv7();
    const numero = await tx.execute<{ protocol: string }>(sql`
      select 'REC-' || to_char(now() at time zone 'America/Sao_Paulo', 'YYYY') || '-'
             || lpad(nextval('liame.account_recovery_numero')::text, 4, '0') as protocol`);
    const protocol = numero.rows[0]!.protocol;
    await tx.execute(sql`
      insert into liame.account_recovery (id, user_id, protocol, reason, companies, notified_status)
      values (${id}, ${auth.userId}, ${protocol}, ${reason}, ${JSON.stringify(empresas)}::jsonb, 'pedido')`);
    const lacrado = lacrar(chave, bytes);
    await tx.execute(sql`
      insert into liame.account_recovery_document (id, recovery_id, media_type, size_bytes, key_id, wrapped_key, iv, tag, ciphertext)
      values (${uuidv7()}, ${id}, ${tipo}, ${bytes.length}, ${lacrado.keyId}, ${lacrado.wrappedKey}, ${lacrado.iv}, ${lacrado.tag}, ${lacrado.ciphertext})`);
    auditDetail({ after: { protocolo: protocol, motivo: reason, empresas: empresas.length, documento: tipo, bytes: bytes.length } });

    afterCommit(async () => {
      await this.mailer.send({
        to: auth.email,
        subject: `Liame: recebemos o seu pedido de recuperação (${protocol})`,
        text: [
          `Recebemos o seu pedido para recuperar a entrada na conta, protocolo ${protocol}.`,
          'A DMS confere o seu documento e o seu nome no quadro de sócios na Receita, e marca uma videochamada curta por este e-mail, em até 2 dias úteis.',
          `Depois, ${DIAS_DE_ESPERA} dias de espera, com aviso a você e aos Administradores. Se você entrar com o app ou com um código de recuperação nesse tempo, o pedido cai sozinho.`,
          'A DMS nunca pede documento por e-mail, por WhatsApp ou pela LIA. Se não foi você, entre com a senha e cancele o pedido, e troque a senha.',
        ].join('\n\n') + `\n\n${this.config.appUrl}`,
      });
      await this.mailer.send({
        to: ATENDIMENTO.email,
        subject: `Liame: pedido de recuperação da conta ${protocol}`,
        text: `Um Dono pediu a recuperação da conta, protocolo ${protocol}. Confira pelo comando da distribuição (recuperacao-da-conta --ver ${protocol}).`,
      });
    });
    return this.minha(auth);
  }

  /** O Dono cancela o pedido em andamento: o app antigo continua valendo. */
  async cancelar(auth: AuthContext, id: string): Promise<MyAccountRecoveryResponse> {
    const tx = currentTx();
    const r = await tx.execute<{ protocol: string; status: AccountRecovery['status'] }>(sql`
      select protocol, status from liame.account_recovery
       where id = ${id} and user_id = ${auth.userId} and status in ('pedido', 'conferido', 'parado')
       for update`);
    const linha = r.rows[0];
    if (!linha) throw naoEncontrado();
    await tx.execute(sql`
      update liame.account_recovery
         set status = 'cancelado', cancelled_by = 'voce', closed_at = now(), notified_status = 'cancelado',
             documents_expire_at = now() + make_interval(days => ${DIAS_DOS_DOCUMENTOS})
       where id = ${id}`);
    auditDetail({ before: { protocolo: linha.protocol, situacao: linha.status } });
    afterCommit(() =>
      this.mailer.send({
        to: auth.email,
        subject: `Liame: pedido de recuperação cancelado (${linha.protocol})`,
        text: `O pedido de recuperação ${linha.protocol} foi cancelado por você. Nada mudou na sua conta: o app autenticador de antes continua valendo.\n\n${this.config.appUrl}`,
      }),
    );
    return this.minha(auth);
  }

  /** O pedido em andamento, ou o último que terminou há até 30 dias. */
  private async ultimo(tx: Tx, userId: string): Promise<AccountRecovery | null> {
    const r = await tx.execute<LinhaDoPedido>(sql`
      select id, protocol, status, reason, companies, created_at, checked_at, applies_at, refusal_reason, cancelled_by, closed_at
        from liame.account_recovery
       where user_id = ${userId}
         and (status in ('pedido', 'conferido', 'parado') or closed_at > now() - make_interval(days => ${DIAS_DO_ULTIMO}))
       order by (status in ('pedido', 'conferido', 'parado')) desc, created_at desc
       limit 1`);
    return r.rows[0] ? paraResposta(r.rows[0]) : null;
  }

  private porQueNao(auth: AuthContext, ownerOf: AccountRecoveryCompany[], recovery: AccountRecovery | null): MyAccountRecoveryResponse['cannot_request'] {
    if (!this.config.recuperacaoChavePublica) return 'indisponivel';
    if (!auth.mfaConfigured) return 'sem-segundo-fator';
    if (auth.mfaVerifiedAt) return 'ja-entrou';
    if (!ownerOf.length) return 'nao-e-dono';
    if (recovery && (EM_ANDAMENTO as readonly string[]).includes(recovery.status)) return 'pedido-em-andamento';
    return null;
  }
}
