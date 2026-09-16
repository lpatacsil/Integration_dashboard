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

import nodemailer from 'nodemailer';
import { CONTACTS } from '../config';

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER;

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transporter;
}

/**
 * Returns true if email is configured.
 */
export function isEmailEnabled(): boolean {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS);
}

/**
 * Resolve contact names to email addresses using CONTACTS config.
 */
function resolveEmails(names: string[]): string[] {
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
      from: SMTP_FROM,
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
