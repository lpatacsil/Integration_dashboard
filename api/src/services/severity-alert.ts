import { readJson, writeJson } from '../store/blob-client';
import { classify } from '../severity';
import { getOrderSyncStats, UnmatchedOrder } from './order-sync';
import { getNotificationChannels } from './settings-store';
import { isEmailEnabled, sendAlertEmail } from './email-notify';

// Daily order-sync severity summary, emailed at 8 AM and 5 PM Central.
// No reminders or level-change emails. Only Larry receives it for now —
// add the escalation contacts once the team is ready.
const RECIPIENTS = ['Larry'];
const SEND_HOURS_CENTRAL = [8, 17];
const TIME_ZONE = 'America/Chicago';

const BLOB_PATH = 'alerts/order-severity-state.json';
const CHECK_INTERVAL_MS = 60 * 1000;
const LOOKBACK_DAYS = 7;   // same window the recon sync watches
const DASHBOARD_URL = 'https://integration-dashboard-erdxhhczasejb4hj.westus3-01.azurewebsites.net';

interface SeverityAlertState {
  last_slot: string | null;   // e.g. "2026-10-22@8" — the last summary sent
}

let state: SeverityAlertState = { last_slot: null };

function centralNow(): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t: string) => parts.find(p => p.type === t)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

function formatCentral(d: Date): string {
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: TIME_ZONE,
  }) + ' CT';
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SEV_COLORS: Record<number, string> = { 0: '#16a34a', 1: '#ca8a04', 2: '#ca8a04', 3: '#ea580c', 4: '#dc2626' };
const SEV_LABELS: Record<number, string> = {
  0: 'Healthy',
  1: 'SEV 1 — one order unmatched',
  2: 'SEV 2 — more than one unmatched, opened today',
  3: 'SEV 3 — more than one unmatched, unresolved into day 2',
  4: 'SEV 4 — tool down',
};

function issueText(e: UnmatchedOrder): string {
  return e.flow_code === 'S2N' ? 'No NetSuite sales order' : `${e.sales_order_id}: no matching Shopify order`;
}

function formatAmount(v: string | null): string {
  return v ? `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
}

export async function sendSeveritySummary(): Promise<boolean> {
  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_DAYS * 86400000);
  const stats = await getOrderSyncStats(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
  if (!stats) return false;

  const level = classify(stats.unmatched, 0, 1, 1);
  const rows = [...stats.unmatched].sort((x, y) => y.occurred_at.localeCompare(x.occurred_at));
  const window = `${start.toISOString().slice(0, 10)} – ${end.toISOString().slice(0, 10)}`;

  const subject = level === 0
    ? `✅ Daily order sync: Healthy — no drafts with possible errors`
    : `🔴 Daily order sync: SEV ${level} — ${rows.length} draft(s) with possible errors`;

  const body = [
    `Severity: ${SEV_LABELS[level]}`,
    `Drafts with possible errors (${window}): ${rows.length}`,
    '',
    ...rows.map(e => `${e.draft_number}\t${e.customer || '—'}\t${formatAmount(e.amount)}\t${formatCentral(new Date(e.occurred_at))}\t${issueText(e)}`),
    '', `Dashboard: ${DASHBOARD_URL}`,
  ].join('\n');

  const cell = 'padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#111827;vertical-align:top';
  const head = 'padding:8px 10px;border-bottom:2px solid #d1d5db;font-size:12px;color:#6b7280;text-align:left;text-transform:uppercase;letter-spacing:.04em';
  const table = rows.length === 0
    ? `<p style="margin:0;font-size:14px;color:#374151">No drafts with possible errors in the last ${LOOKBACK_DAYS} days.</p>`
    : `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
        <tr><th style="${head}">Draft #</th><th style="${head}">Customer</th><th style="${head};text-align:right">Amount</th><th style="${head}">Created</th><th style="${head}">Possible error</th></tr>
        ${rows.map(e => `<tr>
          <td style="${cell};font-family:Consolas,monospace;white-space:nowrap">${escapeHtml(e.draft_number)}</td>
          <td style="${cell}">${escapeHtml(e.customer || '—')}</td>
          <td style="${cell};text-align:right;white-space:nowrap">${formatAmount(e.amount)}</td>
          <td style="${cell};white-space:nowrap">${formatCentral(new Date(e.occurred_at))}</td>
          <td style="${cell}">${escapeHtml(issueText(e))}</td>
        </tr>`).join('')}
      </table>`;

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:24px 12px;background:#f3f4f6;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table width="760" cellpadding="0" cellspacing="0" style="max-width:760px;background:#ffffff;border-radius:8px;overflow:hidden">
  <tr><td style="height:4px;background:${SEV_COLORS[level]}"></td></tr>
  <tr><td style="padding:20px 24px 8px">
    <p style="margin:0 0 4px;font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.06em">Daily order sync · Shopify ⇄ NetSuite</p>
    <p style="margin:0;font-size:22px;font-weight:700;color:${SEV_COLORS[level]}">${SEV_LABELS[level]}</p>
    <p style="margin:6px 0 0;font-size:13px;color:#6b7280">${rows.length} draft(s) with possible errors · ${window} · generated ${formatCentral(end)}</p>
  </td></tr>
  <tr><td style="padding:12px 24px 20px">${table}</td></tr>
  <tr><td style="padding:12px 24px;background:#f9fafb;font-size:12px;color:#6b7280"><a href="${DASHBOARD_URL}" style="color:#2563eb">Open the dashboard</a></td></tr>
</table>
</td></tr></table>
</body></html>`;

  const sent = await sendAlertEmail(RECIPIENTS, [], subject, body, html);
  console.log(`[severity-alert] daily summary (SEV ${level}, ${rows.length} drafts): email ${sent ? 'sent' : 'failed'}`);
  return sent;
}

async function checkSchedule(): Promise<void> {
  const { date, hour } = centralNow();
  // Only send during the scheduled hour itself, so a restart later in the day doesn't send a stale summary
  if (!SEND_HOURS_CENTRAL.includes(hour)) return;
  const slot = `${date}@${hour}`;
  if (state.last_slot === slot) return;

  const channels = getNotificationChannels();
  if (!channels.email.enabled || !isEmailEnabled()) return;

  // Only mark the slot done once the email is out, so a failed send retries next minute
  if (await sendSeveritySummary()) {
    state = { last_slot: slot };
    await writeJson(BLOB_PATH, state);
  }
}

export async function startSeverityAlerts(): Promise<void> {
  try {
    const prev = await readJson<SeverityAlertState>(BLOB_PATH);
    if (prev.data) state = { ...state, ...prev.data };
  } catch {
    // Start fresh
  }

  setInterval(() => {
    checkSchedule().catch(err => console.error('[severity-alert] check failed:', err.message));
  }, CHECK_INTERVAL_MS);
  console.log(`[severity-alert] daily summary at ${SEND_HOURS_CENTRAL.join(':00, ')}:00 ${TIME_ZONE}, recipients: ${RECIPIENTS.join(', ')}`);
}
