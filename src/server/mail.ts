import nodemailer from 'nodemailer';
import { config } from './config';

export const mailConfigured = () => !!config.smtp.host;

/** System mail (digests, reports, subscriptions) through the SMTP server configured in the environment. */
export async function sendSystemMail(opts: { to: string | string[]; subject: string; text: string; html?: string; attachments?: { filename: string; content: Buffer | string; contentType?: string }[] }): Promise<void> {
  if (!config.smtp.host) throw new Error('SMTP is not configured (PW_SMTP_HOST)');
  const t = nodemailer.createTransport({
    host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined, connectionTimeout: 15000, socketTimeout: 30000,
  });
  try { await t.sendMail({ from: config.smtp.from, to: opts.to, subject: opts.subject, text: opts.text, html: opts.html, attachments: opts.attachments }); } finally { t.close(); }
}
