import { readJson, writeJson } from '../store/blob-client';
import { classify } from '../severity';
import { getOrderSyncStats } from './order-sync';
import { getRules, getNotificationChannels } from './settings-store';
import { isEmailEnabled, sendAlertEmail, buildAlertHtml } from './email-notify';

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

function listRefs(refs: string[], max = 10): string {
  if (refs.length === 0) return '—';
  return refs.slice(0, max).join(', ') + (refs.length > max ? ` … (+${refs.length - max} more)` : '');
}

export async function sendSeveritySummary(): Promise<boolean> {
  const end = new Date();
  const start = new Date(end.getTime() - LOOKBACK_DAYS * 86400000);
  const stats = await getOrderSyncStats(start.toISOString().slice(0, 10), end.toISOString().slice(0, 10));
  if (!stats) return false;

  const level = classify(stats.unmatched, 0, 1, 1);
  const window = `${start.toISOString().slice(0, 10)} – ${end.toISOString().slice(0, 10)}`;
  const noSo = stats.unmatched.filter(e => e.flow_code === 'S2N');
  const noOrder = stats.unmatched.filter(e => e.flow_code === 'N2S');
  const escalation = level > 0 ? getRules().escalation[level] : null;
  const wouldEscalate = escalation ? [...escalation.notify, ...escalation.cc].join(', ') + ' (not sent yet)' : '—';

  const subject = level === 0
    ? `✅ Daily order sync: healthy — Shopify ⇄ NetSuite`
    : `🔴 Daily order sync: SEV ${level}, ${stats.unmatched.length} unmatched — Shopify ⇄ NetSuite`;
  const body = [
    `Severity: ${level === 0 ? 'Healthy' : `SEV ${level}`}`,
    `Window: ${window}`,
    `Shopify → NetSuite: ${stats.drafts} drafts, ${stats.so_created} with SO, ${noSo.length} unmatched — ${listRefs(noSo.map(e => e.entity_identifier))}`,
    `NetSuite → Shopify: ${stats.ready} ready, ${stats.resolved} matched, ${noOrder.length} unmatched — ${listRefs(noOrder.map(e => e.entity_identifier))}`,
    `Pending: ${stats.pending}`,
    `Would escalate to: ${wouldEscalate}`,
    '', `Dashboard: ${DASHBOARD_URL}`,
  ].join('\n');
  const html = buildAlertHtml({
    type: level === 0 ? 'resolved' : 'unmatched',
    headline: level === 0 ? 'Daily Order Sync · Healthy' : `Daily Order Sync · SEV ${level}`,
    description: level === 0
      ? `All drafts and integration-ready orders in the last ${LOOKBACK_DAYS} days are matched.`
      : `${stats.unmatched.length} order(s) in the last ${LOOKBACK_DAYS} days are not matched between Shopify and NetSuite.`,
    facts: [
      { label: 'Window', value: window },
      { label: 'Shopify → NetSuite', value: `${stats.drafts} drafts · ${stats.so_created} with SO · ${noSo.length} unmatched` },
      { label: 'Drafts with no SO', value: listRefs(noSo.map(e => e.entity_identifier)) },
      { label: 'NetSuite → Shopify', value: `${stats.ready} ready · ${stats.resolved} matched · ${noOrder.length} unmatched` },
      { label: 'Ready SOs with no Shopify order', value: listRefs(noOrder.map(e => e.entity_identifier)) },
      { label: 'Pending', value: String(stats.pending) },
      { label: 'Would Escalate To', value: wouldEscalate },
      { label: 'Generated At', value: formatCentral(end) },
    ],
  });

  const sent = await sendAlertEmail(RECIPIENTS, [], subject, body, html);
  console.log(`[severity-alert] daily summary (SEV ${level}): email ${sent ? 'sent' : 'failed'}`);
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
