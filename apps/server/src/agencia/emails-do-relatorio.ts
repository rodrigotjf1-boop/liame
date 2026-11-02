import type { Logger } from '@nestjs/common';
import type { AppConfig } from '../config.js';
import { type Mailer, maskEmail } from '../mail/mailer.js';
import { emailDoRelatorio } from '../results/relatorio-email.js';
import type { ConteudoDoRelatorio } from '../results/relatorio-mensal.js';
import { enderecoPublicoDoLogo } from './logo-publico.controller.js';

// Os e-mails do relatório que a agência manda (A7, W7, partes 4a e 4b; D-A7-82): os mesmos para o envio pela tela e o
// envio sozinho do dia 2. Um e-mail por pessoa, sem transação aberta; o resultado de cada um vai para quem chamou gravar
// (o tipo do erro, nunca o endereço).

/** A marca da agência como sai no e-mail. */
export type MarcaNoEnvio = {
  agencyId: string;
  name: string;
  logo: boolean;
  logo_width: number | null;
  logo_height: number | null;
  reply_to: string | null;
};

/** O envio já gravado: a versão, o comentário, quem assina e o relatório. */
export interface EnvioGravado {
  id: string;
  versao: number;
  comentario: string | null;
  /** Quem mandou; nulo no envio sozinho do dia 2. */
  assinatura: string | null;
  conteudo: ConteudoDoRelatorio;
  marca: string;
  empresa: string;
  brandId: string;
}

export type PessoaQueRecebe = {
  id: string;
  name: string;
  email: string;
  role_key: string;
};

/** Manda os e-mails e devolve quantos falharam. `gravar` grava o resultado de cada pessoa. */
export async function mandarOsEmails(
  deps: { mailer: Mailer; config: Pick<AppConfig, 'appUrl' | 'apiUrl'>; logger: Logger },
  envio: EnvioGravado,
  agencia: MarcaNoEnvio,
  para: PessoaQueRecebe[],
  gravar: (userId: string, falha: string | null) => Promise<void>,
): Promise<number> {
  const { mailer, config, logger } = deps;
  const link = `${config.appUrl}/resultados/relatorio?marca=${envio.brandId}&mes=${envio.conteudo.month.from.slice(0, 7)}`;
  const imagens = { logo: `${config.appUrl}/email/liame-logo.png`, lia: `${config.appUrl}/email/lia.png` };
  let falhas = 0;
  for (const p of para) {
    const email = emailDoRelatorio(
      envio.conteudo,
      { marca: envio.marca, empresa: envio.empresa, nivel: p.role_key, link, imagens },
      {
        nome: agencia.name,
        logoUrl: agencia.logo ? enderecoPublicoDoLogo(config.apiUrl, agencia.agencyId) : null,
        logoLargura: agencia.logo_width,
        logoAltura: agencia.logo_height,
        comentario: envio.comentario,
        assinatura: envio.assinatura,
        versao: envio.versao,
        responde: Boolean(agencia.reply_to),
        primeiroNome: p.name.split(/\s+/)[0] || p.name,
      },
    );
    let falha: string | null = null;
    try {
      await mailer.send({
        to: p.email,
        subject: email.subject,
        text: email.text,
        html: email.html,
        fromName: `${agencia.name} pelo Liame`,
        ...(agencia.reply_to ? { replyTo: agencia.reply_to } : {}),
      });
    } catch (err) {
      falhas += 1;
      falha = (err instanceof Error ? err.name : 'Erro').slice(0, 100) || 'Erro';
      logger.warn(`relatório da agência ${envio.id}: envio para ${maskEmail(p.email)} falhou (${err instanceof Error ? err.message : String(err)})`);
    }
    await gravar(p.id, falha).catch((err: unknown) =>
      logger.error(`relatório da agência ${envio.id}: não gravou a entrega (${err instanceof Error ? err.message : String(err)})`),
    );
  }
  return falhas;
}
