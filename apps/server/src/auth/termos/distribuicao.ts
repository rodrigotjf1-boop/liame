import { createHash } from 'node:crypto';
import { type Db, withSystem } from '@liame/database';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { writeAudit } from '../../audit/audit.js';
import { diaEmBrasilia } from './versoes.js';

// O lado da distribuição nos Termos novos (A7, W14, parte 14a; D-A7-88, D-A7-89; D-A7-100): o comando
// (`scripts/termos-novos.ts`) declara a versão nova, lista as versões e retira a que ainda não vale. Só a distribuição
// muda os Termos: a empresa e as telas nunca. Roda no escopo de sistema, com o papel dono do banco informado só na hora.
// Os e-mails do aviso, do lembrete e da retirada saem pelo worker (parte 14c): o comando não manda e-mail.

/** O aviso mínimo da versão relevante, em dias do calendário de Brasília (Termos 15). */
export const DIAS_DE_AVISO = 30;

const Documento = z.enum(['termos', 'privacidade', 'operador']);

/** O arquivo que a distribuição escreve para declarar uma versão (o comando lê com `--arquivo`). */
export const DeclaracaoDeVersao = z
  .strictObject({
    versao: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]{1,10})?$/),
    tipo: z.enum(['relevante', 'redacao']),
    /** O dia em que vale (AAAA-MM-DD, em Brasília). Na de redação, é hoje: vale na hora. */
    vale_em: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).optional(),
    documentos: z
      .array(z.strictObject({ documento: Documento, url: z.url().refine((u) => u.startsWith('https://'), 'o endereço é https') }))
      .min(1)
      .max(3)
      .refine((d) => new Set(d.map((x) => x.documento)).size === d.length, 'um endereço por documento'),
    mudancas: z
      .array(
        z.strictObject({
          documento: Documento,
          secao: z.string().trim().min(1).max(40),
          titulo: z.string().trim().min(3).max(120),
          hoje: z.string().trim().min(3).max(400),
          fica: z.string().trim().min(3).max(600),
        }),
      )
      .max(30)
      .default([]),
    motivo: z.string().trim().min(3).max(300).nullable().default(null),
  })
  .superRefine((d, ctx) => {
    if (d.tipo === 'relevante' && !d.vale_em) ctx.addIssue({ code: 'custom', message: 'a versão relevante diz o dia em que vale (vale_em)' });
    if (d.tipo === 'relevante' && d.mudancas.length === 0) ctx.addIssue({ code: 'custom', message: 'a versão relevante lista o que muda (mudancas)' });
    if (d.tipo === 'redacao' && !d.motivo) ctx.addIssue({ code: 'custom', message: 'o ajuste de redação diz o motivo' });
    if (d.tipo === 'redacao' && d.vale_em) ctx.addIssue({ code: 'custom', message: 'o ajuste de redação vale na hora: sem vale_em' });
  });
export type DeclaracaoDeVersao = z.infer<typeof DeclaracaoDeVersao>;

/** Baixa o texto publicado (o comando usa o `fetch`; os testes, um texto de mentira). */
export type Baixar = (url: string) => Promise<string>;

function exigirQuem(por: string): string {
  const quem = por.trim();
  if (quem.length < 2 || quem.length > 80) throw new Error('diga quem decidiu (--por), de 2 a 80 letras');
  return quem;
}

const somarDias = (dia: string, dias: number): string => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

/**
 * Declara a versão (D-A7-88): baixa cada texto publicado e guarda a impressão digital (SHA-256), confere o aviso de 30 dias
 * da relevante e que não há outra relevante esperando. A de redação vale na hora (D-A7-89). Na auditoria do sistema.
 */
export async function declararVersao(db: Db, d: DeclaracaoDeVersao, p: { por: string; baixar: Baixar }): Promise<{ effectiveOn: string }> {
  const por = exigirQuem(p.por);
  const hoje = diaEmBrasilia(new Date());
  if (d.tipo === 'relevante' && d.vale_em! < somarDias(hoje, DIAS_DE_AVISO)) {
    throw new Error(`a versão relevante vale no mínimo ${DIAS_DE_AVISO} dias depois do aviso: a partir de ${somarDias(hoje, DIAS_DE_AVISO)}`);
  }
  // Os textos têm de estar publicados antes do aviso: a impressão digital prova qual texto cada pessoa aceitou.
  const documentos: { document: string; url: string; sha256: string }[] = [];
  for (const doc of d.documentos) {
    const texto = await p.baixar(doc.url);
    if (texto.trim().length < 200) throw new Error(`o texto de ${doc.url} veio vazio ou curto demais: publique antes de declarar`);
    documentos.push({ document: doc.documento, url: doc.url, sha256: createHash('sha256').update(texto, 'utf8').digest('hex') });
  }
  const mudancas = d.mudancas.map((m) => ({ document: m.documento, section: m.secao, title: m.titulo, today: m.hoje, becomes: m.fica }));
  return withSystem(db, async (tx) => {
    // Uma declaração por vez: a conferência de "uma relevante esperando" não passa em dobro.
    await tx.execute(sql`lock table liame.terms_version in share row exclusive mode`);
    if (d.tipo === 'relevante') {
      const esperando = await tx.execute<{ version: string }>(sql`
        select version from liame.terms_version
         where kind = 'relevante' and withdrawn_at is null and effective_at > now()`);
      if (esperando.rows[0]) throw new Error(`a versão ${esperando.rows[0].version} ainda espera o dia dela: retire-a antes de declarar outra`);
    }
    const existe = await tx.execute(sql`select 1 from liame.terms_version where version = ${d.versao}`);
    if (existe.rows[0]) throw new Error(`a versão ${d.versao} já existe`);
    const vale = d.tipo === 'relevante' ? sql`(${d.vale_em!}::date)::timestamp at time zone 'America/Sao_Paulo'` : sql`now()`;
    const r = await tx.execute<{ effective_at: Date | string }>(sql`
      insert into liame.terms_version (version, kind, effective_at, documents, changes, reason, created_by)
      values (${d.versao}, ${d.tipo}, ${vale}, ${JSON.stringify(documentos)}::jsonb, ${JSON.stringify(mudancas)}::jsonb, ${d.motivo}, ${por})
      returning effective_at`);
    const effectiveOn = diaEmBrasilia(r.rows[0]!.effective_at);
    await writeAudit(tx, {
      tenantId: null,
      actorType: 'system',
      actorId: null,
      actorLabel: `Distribuição DMS (${por})`,
      action: 'termos.declarar',
      resourceType: 'terms_version',
      resourceId: d.versao,
      after: { versao: d.versao, tipo: d.tipo, vale_em: effectiveOn, documentos: documentos.map((x) => ({ documento: x.document, sha256: x.sha256 })), mudancas: mudancas.length },
      reason: d.motivo,
      origin: 'console',
    });
    return { effectiveOn };
  });
}

/** Retira a versão relevante que ainda não vale (D-A7-88): nada muda, e o aceite dado fica sem efeito. */
export async function retirarVersao(db: Db, p: { versao: string; por: string; motivo: string }): Promise<void> {
  const por = exigirQuem(p.por);
  const motivo = p.motivo.trim();
  if (motivo.length < 3 || motivo.length > 300) throw new Error('diga o motivo (--motivo), de 3 a 300 letras');
  await withSystem(db, async (tx) => {
    const r = await tx.execute<{ version: string }>(sql`
      update liame.terms_version set withdrawn_at = now(), withdrawn_by = ${por}, withdrawn_reason = ${motivo}
       where version = ${p.versao} and kind = 'relevante' and withdrawn_at is null and effective_at > now()
       returning version`);
    if (!r.rows[0]) throw new Error(`a versão ${p.versao} não existe, já vale, já foi retirada ou é de redação`);
    await writeAudit(tx, {
      tenantId: null,
      actorType: 'system',
      actorId: null,
      actorLabel: `Distribuição DMS (${por})`,
      action: 'termos.retirar',
      resourceType: 'terms_version',
      resourceId: p.versao,
      after: { versao: p.versao },
      reason: motivo,
      origin: 'console',
    });
  });
}

export type VersaoNaDistribuicao = {
  version: string;
  kind: 'relevante' | 'redacao';
  notice_at: Date;
  effective_at: Date;
  withdrawn_at: Date | null;
  aceites: number;
};

/** As versões, da mais nova para a mais antiga, com quantas pessoas aceitaram cada uma. */
export async function listarVersoes(db: Db): Promise<VersaoNaDistribuicao[]> {
  return withSystem(db, async (tx) =>
    (
      await tx.execute<VersaoNaDistribuicao>(sql`
        select v.version, v.kind, v.notice_at, v.effective_at, v.withdrawn_at,
               (select count(*)::int from liame.terms_acceptance a where a.version = v.version) as aceites
          from liame.terms_version v order by v.effective_at desc, v.version desc`)
    ).rows,
  );
}
