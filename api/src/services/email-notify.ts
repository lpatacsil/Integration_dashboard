/**
 * Email notification service using nodemailer (SMTP).
 *
 * Required environment variables:
 *   SMTP_HOST       — SMTP server hostname (e.g. smtp.office365.com)
 *   SMTP_PORT       — SMTP port (default: 587)
 *   SMTP_USER       — SMTP username / email
 *   SMTP_PASS       — SMTP password or app password
 *   SMTP_FROM       — Sender address (defaults to SMTP_USER)
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { getContacts, getNotificationChannels } from './settings-store';

let transporter: Transporter | null = null;
let lastSmtpKey = '';

function getSmtpConfig() {
  const channels = getNotificationChannels();
  const smtp = channels.email.smtp;
  // Fall back to env vars if settings are empty
  return {
    host: smtp.host || process.env.SMTP_HOST || '',
    port: smtp.port || parseInt(process.env.SMTP_PORT || '587', 10),
    user: smtp.user || process.env.SMTP_USER || '',
    pass: smtp.password || process.env.SMTP_PASS || '',
    from: smtp.from || process.env.SMTP_FROM || smtp.user || process.env.SMTP_USER || '',
  };
}

function getTransporter(): Transporter | null {
  const cfg = getSmtpConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) return null;
  // Recreate transporter if SMTP config changed
  const key = `${cfg.host}:${cfg.port}:${cfg.user}`;
  if (!transporter || key !== lastSmtpKey) {
    transporter = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465,
      auth: { user: cfg.user, pass: cfg.pass },
    });
    lastSmtpKey = key;
  }
  return transporter;
}

/**
 * Returns true if email is configured.
 */
export function isEmailEnabled(): boolean {
  const cfg = getSmtpConfig();
  return !!(cfg.host && cfg.user && cfg.pass);
}

/**
 * Resolve contact names to email addresses using CONTACTS config.
 */
function resolveEmails(names: string[]): string[] {
  const CONTACTS = getContacts();
  return names
    .map(name => CONTACTS[name]?.email || '')
    .filter(email => email.length > 0);
}

/**
 * Send an alert email to the specified recipients.
 */
export async function sendAlertEmail(
  recipients: string[],
  cc: string[],
  subject: string,
  body: string,
): Promise<boolean> {
  const t = getTransporter();
  if (!t) return false;

  const toEmails = resolveEmails(recipients);
  const ccEmails = resolveEmails(cc);

  if (toEmails.length === 0) {
    console.warn('Email: no valid recipient addresses, skipping');
    return false;
  }

  try {
    await t.sendMail({
      from: getSmtpConfig().from,
      to: toEmails.join(', '),
      cc: ccEmails.length > 0 ? ccEmails.join(', ') : undefined,
      subject,
      text: body,
    });
    return true;
  } catch (err) {
    console.error('Email send error:', err);
    return false;
  }
}
