import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import nodemailer from 'nodemailer';
import { emailConfig, type SmtpSettings } from '../configs/email.config';
export interface EmailMessage {
  id?: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}
export interface EmailProvider {
  send(message: EmailMessage): Promise<void>;
}
class SmtpEmailProvider implements EmailProvider {
  constructor(private readonly settings: SmtpSettings) {}
  async send(message: EmailMessage) {
    const smtp = this.settings;
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      requireTLS: smtp.requireTLS,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      connectionTimeout: smtp.timeoutMs,
      greetingTimeout: smtp.timeoutMs,
      socketTimeout: smtp.timeoutMs,
      dnsTimeout: smtp.timeoutMs,
      disableFileAccess: true,
      disableUrlAccess: true,
      logger: false,
      debug: false,
    });
    try {
      const result = await transport.sendMail({
        from: smtp.from,
        to: message.to,
        subject: message.subject,
        messageId: message.id ? `<${message.id}@nest-shop.invalid>` : undefined,
        text: message.text,
        html: message.html,
        attachments: message.attachments,
      });
      if (!result.accepted.length)
        throw new BadRequestException('Recipient rejected');
    } catch (error) {
      const failure = error as { code?: string; responseCode?: number };
      if (
        error instanceof BadRequestException ||
        failure.code === 'EAUTH' ||
        (failure.responseCode ?? 0) >= 500
      ) {
        throw new BadRequestException(
          'SMTP provider rejected email delivery. Check the sender, recipient and credentials.',
        );
      }
      // Never expose SMTP credentials, recipients or provider responses to job logs.
      throw new ServiceUnavailableException(
        'SMTP email delivery is temporarily unavailable',
      );
    } finally {
      transport.close();
    }
  }
}
class LogEmailProvider implements EmailProvider {
  private logger = new Logger('EmailDelivery');
  async send(message: EmailMessage) {
    this.logger.log(`Development email handled by LOG adapter: ${message.id}`);
  }
}
@Injectable()
export class EmailProviderFactory {
  readonly mode: string;
  private readonly adapter: EmailProvider;
  constructor() {
    const config = emailConfig();
    this.mode = config.provider;
    this.adapter = config.smtp
      ? new SmtpEmailProvider(config.smtp)
      : new LogEmailProvider();
  }
  create(smtp?: SmtpSettings): EmailProvider {
    // Supports channel settings from a future database-backed configuration source.
    return smtp ? new SmtpEmailProvider(smtp) : this.adapter;
  }
}
