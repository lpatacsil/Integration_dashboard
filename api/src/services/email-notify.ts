/**
 * Email notification service.
 *
 * Tries Microsoft Graph API first (works when SMTP AUTH is disabled on the tenant),
 * falls back to SMTP via nodemailer.
 *
 * Graph API env vars:
 *   AZURE_TENANT_ID   — Azure AD tenant ID
 *   AZURE_CLIENT_ID   — App registration client ID
 *   AZURE_CLIENT_SECRET — App registration client secret
 *
 * SMTP env vars (fallback):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM
 */

import https from 'https';
import nodemailer, { type Transporter } from 'nodemailer';
import { getContacts, getNotificationChannels } from './settings-store';

// ── helpers: https with forced IPv4 (Docker doesn't route IPv6) ──

function httpsPost(url: string, headers: Record<string, string>, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        family: 4,
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Request timed out')));
    req.write(body);
    req.end();
  });
}

// ── Graph API token cache ──
let graphToken: string | null = null;
let graphTokenExpiry = 0;

function getGraphConfig() {
  return {
    tenantId: process.env.AZURE_TENANT_ID || '',
    clientId: process.env.AZURE_CLIENT_ID || '',
    clientSecret: process.env.AZURE_CLIENT_SECRET || '',
    from: process.env.GRAPH_FROM || process.env.SMTP_FROM || process.env.SMTP_USER || '',
  };
}

function isGraphConfigured(): boolean {
  const cfg = getGraphConfig();
  return !!(cfg.tenantId && cfg.clientId && cfg.clientSecret && cfg.from);
}

async function getGraphToken(): Promise<string | null> {
  const cfg = getGraphConfig();
  if (!cfg.tenantId || !cfg.clientId || !cfg.clientSecret) return null;

  if (graphToken && Date.now() < graphTokenExpiry - 60_000) return graphToken;

  try {
    const tokenUrl = `https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }).toString();

    const res = await httpsPost(tokenUrl, { 'Content-Type': 'application/x-www-form-urlencoded' }, body);

    if (res.status !== 200) {
      console.error('Graph token error:', res.body);
      return null;
    }

    const data = JSON.parse(res.body) as { access_token: string; expires_in: number };
    graphToken = data.access_token;
    graphTokenExpiry = Date.now() + (data.expires_in * 1000);
    return graphToken;
  } catch (err) {
    console.error('Graph token fetch failed:', err);
    return null;
  }
}

async function sendViaGraph(
  from: string,
  toEmails: string[],
  ccEmails: string[],
  subject: string,
  body: string,
  html?: string,
): Promise<boolean> {
  const token = await getGraphToken();
  if (!token) {
    console.error('Graph sendMail: no token obtained');
    return false;
  }
  console.log(`Graph sendMail: sending from ${from} to ${toEmails.join(', ')}`);

  const message = JSON.stringify({
    message: {
      subject,
      body: html
        ? { contentType: 'HTML', content: html }
        : { contentType: 'Text', content: body },
      toRecipients: toEmails.map(e => ({ emailAddress: { address: e } })),
      ccRecipients: ccEmails.map(e => ({ emailAddress: { address: e } })),
    },
    saveToSentItems: false,
  });

  try {
    const sendUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`;
    const res = await httpsPost(sendUrl, {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }, message);

    if (res.status !== 202 && res.status !== 200) {
      console.error(`Graph sendMail failed (${res.status}):`, res.body);
      return false;
    }
    console.log(`Email sent via Graph API to ${toEmails.join(', ')}`);
    return true;
  } catch (err) {
    console.error('Graph sendMail error:', err);
    return false;
  }
}

// ── SMTP fallback ──
let transporter: Transporter | null = null;
let lastSmtpKey = '';

function getSmtpConfig() {
  const channels = getNotificationChannels();
  const smtp = channels.email.smtp;
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

// ── HTML email templates ──

interface AlertFact { label: string; value: string }

function factRow(f: AlertFact): string {
  return `<tr>
    <td style="padding:8px 16px;color:#6b7280;font-size:14px;white-space:nowrap;vertical-align:top">${f.label}</td>
    <td style="padding:8px 16px;font-size:14px;font-weight:600;color:#111827">${f.value}</td>
  </tr>`;
}

export function buildAlertHtml(opts: {
  type: 'unmatched' | 'resolved';
  headline: string;
  description: string;
  facts: AlertFact[];
  footer?: string;
}): string {
  const isResolved = opts.type === 'resolved';
  const accentColor = isResolved ? '#16a34a' : '#dc2626';
  const iconEmoji = isResolved ? '&#9989;' : '&#9888;&#65039;';
  const errorTypeLabel = isResolved ? 'Resolved' : 'Error Details';
  const actionSection = isResolved
    ? `<p style="margin:0 0 8px;font-size:14px;color:#374151">No action needed &mdash; the sync issue has been resolved.</p>`
    : `<p style="margin:0 0 16px;font-weight:700;font-size:15px;color:#111827">Recommended Action</p>
       <p style="margin:0 0 8px;font-size:14px;color:#374151">Please check Team Central and NetSuite to identify the cause of the issue. Verify whether the transaction was created successfully, whether any synchronization errors occurred, and whether manual intervention is required.</p>
       <p style="margin:0;font-size:14px;color:#374151"><em>Please investigate and resolve the issue as needed to prevent further integration delays.</em></p>`;

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
  <!-- Accent top bar -->
  <tr><td style="height:4px;background:${accentColor}"></td></tr>

  <!-- Header -->
  <tr><td style="padding:24px 32px 0">
    <table width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font-size:18px;font-weight:700;color:#111827">&#9993; Integration ${isResolved ? 'Resolution' : 'Error'} Alert</td>
    </tr></table>
  </td></tr>

  <!-- Divider -->
  <tr><td style="padding:16px 32px 0"><hr style="border:none;border-top:1px solid #e5e7eb;margin:0"></td></tr>

  <!-- Body -->
  <tr><td style="padding:24px 32px">
    <p style="margin:0 0 4px;font-weight:700;font-size:16px;color:#111827">Integration Alert</p>
    <p style="margin:0 0 8px;font-size:14px;color:#374151">Hello Team,</p>
    <p style="margin:0 0 20px;font-size:14px;color:#374151">${opts.description}</p>

    <!-- Error Details card -->
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:24px">
      <tr><td style="padding:12px 16px;border-bottom:1px solid #e5e7eb">
        <span style="font-size:14px;font-weight:700;color:#111827">${iconEmoji} ${errorTypeLabel}</span>
      </td></tr>
      <tr><td style="padding:0">
        <table width="100%" cellpadding="0" cellspacing="0">
          ${opts.facts.map(factRow).join('\n          ')}
        </table>
      </td></tr>
    </table>

    ${actionSection}
  </td></tr>

  <!-- Footer divider -->
  <tr><td style="padding:0 32px"><hr style="border:none;border-top:1px solid #e5e7eb;margin:0"></td></tr>

  <!-- Footer -->
  <tr><td style="padding:16px 32px 24px">
    <p style="margin:0;font-size:12px;color:#9ca3af">${opts.footer || 'Automated Notification &bull; NetSuite Integration Monitoring'}</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// ── Public API ──

export function isEmailEnabled(): boolean {
  if (isGraphConfigured()) return true;
  const cfg = getSmtpConfig();
  return !!(cfg.host && cfg.user && cfg.pass);
}

function resolveEmails(names: string[]): string[] {
  const CONTACTS = getContacts();
  return names
    .map(name => CONTACTS[name]?.email || '')
    .filter(email => email.length > 0);
}

export async function sendAlertEmail(
  recipients: string[],
  cc: string[],
  subject: string,
  body: string,
  html?: string,
): Promise<boolean> {
  const toEmails = resolveEmails(recipients);
  const ccEmails = resolveEmails(cc);

  if (toEmails.length === 0) {
    console.warn('Email: no valid recipient addresses, skipping');
    return false;
  }

  const from = getGraphConfig().from || getSmtpConfig().from;

  // Try Graph API first (works when SMTP AUTH is disabled)
  if (isGraphConfigured()) {
    const sent = await sendViaGraph(from, toEmails, ccEmails, subject, body, html);
    if (sent) return true;
    console.warn('Graph API failed, trying SMTP fallback...');
  }

  // SMTP fallback
  const t = getTransporter();
  if (!t) return false;

  try {
    await t.sendMail({
      from,
      to: toEmails.join(', '),
      cc: ccEmails.length > 0 ? ccEmails.join(', ') : undefined,
      subject,
      text: body,
      ...(html ? { html } : {}),
    });
    console.log(`Email sent via SMTP to ${toEmails.join(', ')}`);
    return true;
  } catch (err) {
    console.error('Email send error:', err);
    return false;
  }
}
