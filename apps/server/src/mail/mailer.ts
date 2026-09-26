import { Logger } from '@nestjs/common';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

/** Porta de envio de e-mail. Produção: Amazon SES em São Paulo (plano da A1, D-A1-4), quando a conta AWS existir. */
export abstract class Mailer {
  abstract send(message: MailMessage): Promise<void>;
}

/** Guarda as mensagens em memória (testes) e registra só o destinatário mascarado e o assunto. */
export class MemoryMailer extends Mailer {
  readonly sent: MailMessage[] = [];
  private readonly logger = new Logger('email');

  constructor(private readonly logLinks = false) {
    super();
  }

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    this.logger.log(`para ${maskEmail(message.to)}: ${message.subject}`);
    // Em desenvolvimento, o link aparece no log para dar para clicar; nunca em produção (é um segredo).
    if (this.logLinks) this.logger.debug(message.text);
  }

  /** Último e-mail enviado para o endereço (testes). */
  lastTo(email: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === email);
  }
}

export function maskEmail(email: string): string {
  const [user = '', domain = ''] = email.split('@');
  return `${user.slice(0, 1)}***@${domain}`;
}

/** Transporte a partir da configuração (API e worker usam o mesmo). */
export function createMailer(config: { mailTransport: string; env: string }): Mailer {
  if (config.mailTransport !== 'memoria') throw new Error(`transporte de e-mail "${config.mailTransport}" ainda não implementado`);
  return new MemoryMailer(config.env === 'development');
}
