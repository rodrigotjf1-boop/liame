import { Logger } from '@nestjs/common';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  /** A mesma mensagem em HTML (opcional). Vai sempre junto com o texto: quem não mostra HTML lê o texto. */
  html?: string;
}

/** Porta de envio de e-mail. Produção: Amazon SES em São Paulo (plano da A1, D-A1-4). */
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

/** O pedido que o SES v2 recebe (`SendEmailCommand`), só com o que o Liame usa. */
export interface SesSendInput {
  FromEmailAddress: string;
  Destination: { ToAddresses: string[] };
  Content: { Simple: { Subject: { Data: string; Charset: 'UTF-8' }; Body: { Text: { Data: string; Charset: 'UTF-8' }; Html?: { Data: string; Charset: 'UTF-8' } } } };
  ConfigurationSetName?: string;
}

/** Quem de fato chama o SES: o SDK em produção; nos testes, uma função que registra o pedido. */
export type SesSend = (input: SesSendInput) => Promise<{ MessageId?: string }>;

/**
 * Amazon SES v2 em São Paulo. Devoluções permanentes e reclamações ficam de fora sozinhas: a lista de
 * supressão da conta vem ligada para as duas (conta criada depois de 25/11/2019) e o SES aceita a mensagem
 * para um endereço suprimido sem entregar. O SDK repete o que for temporário (limite de envio, rede);
 * o que sobrar vira erro para quem chamou, que registra o motivo sem desfazer a operação (LIC-001).
 */
export class SesMailer extends Mailer {
  private readonly logger = new Logger('email');

  constructor(
    private readonly from: string,
    private readonly sendRaw: SesSend,
    private readonly configurationSet: string | null = null,
  ) {
    super();
  }

  async send(message: MailMessage): Promise<void> {
    const r = await this.sendRaw({
      FromEmailAddress: this.from,
      Destination: { ToAddresses: [message.to] },
      Content: {
        Simple: {
          Subject: { Data: message.subject, Charset: 'UTF-8' },
          // Com as duas versões, o SES monta a mensagem com alternativa: o programa de e-mail escolhe a que sabe mostrar.
          Body: { Text: { Data: message.text, Charset: 'UTF-8' }, ...(message.html ? { Html: { Data: message.html, Charset: 'UTF-8' as const } } : {}) },
        },
      },
      ...(this.configurationSet ? { ConfigurationSetName: this.configurationSet } : {}),
    });
    this.logger.log(`para ${maskEmail(message.to)}: ${message.subject} (SES ${r.MessageId ?? 'sem id'})`);
  }
}

/** Cliente do SES v2, carregado só quando o transporte é `ses` (desenvolvimento e testes não precisam dele). */
async function sesSend(region: string): Promise<SesSend> {
  const { SESv2Client, SendEmailCommand } = await import('@aws-sdk/client-sesv2');
  const client = new SESv2Client({ region });
  return (input) => client.send(new SendEmailCommand(input));
}

type MailConfig = { mailTransport: string; env: string; mail: { from: string; region: string; configurationSet: string | null } };

/** Transporte a partir da configuração (API e worker usam o mesmo). */
export async function createMailer(config: MailConfig): Promise<Mailer> {
  if (config.mailTransport === 'ses') return new SesMailer(config.mail.from, await sesSend(config.mail.region), config.mail.configurationSet);
  if (config.mailTransport !== 'memoria') throw new Error(`transporte de e-mail "${config.mailTransport}" desconhecido`);
  return new MemoryMailer(config.env === 'development');
}
