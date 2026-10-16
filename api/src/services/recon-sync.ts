import { readJson, writeJson } from '../store/blob-client';
import { fetchSalesOrders } from './netsuite-sync';
import { fetchDraftsByDateRange, lookupDraftsByName, isConfigured as shopifyConfigured } from './shopify-client';
import { isConfigured as netsuiteConfigured } from './netsuite-auth';
import { isTeamsEnabled } from './teams-notify';
import { isEmailEnabled, sendAlertEmail, buildAlertHtml } from './email-notify';
import { getNotificationChannels } from './settings-store';

const DASHBOARD_URL = 'https://integration-dashboard-erdxhhczasejb4hj.westus3-01.azurewebsites.net';

function getTeamsWebhookUrl(): string {
  const channels = getNotificationChannels();
  return channels.teams.webhookUrl || process.env.TEAMS_WEBHOOK_URL || '';
}

async function sendReconTeamsCard(card: object): Promise<boolean> {
  const url = getTeamsWebhookUrl();
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
    });
    if (!res.ok) {
      console.error(`[recon-sync] Teams webhook failed (${res.status}):`, await res.text());
      return false;
    }
    return true;
  } catch (err: any) {
    console.error('[recon-sync] Teams webhook error:', err.message);
    return false;
  }
}

export interface UnmatchedDraft {
  draft_number: string;
  shopify_customer: string | null;
  shopify_amount: string | null;
  shopify_created: string | null;
  first_seen: string;
  age_minutes: number;
  notified_at: string | null;
}

export interface ResolvedDraft {
  draft_number: string;
  shopify_customer: string | null;
  shopify_amount: string | null;
  shopify_created: string | null;
  netsuite_so: string | null;
  first_seen: string;
  resolved_at: string;
  time_to_resolve_minutes: number;
  was_alerted: boolean;
}

export interface ReconSyncState {
  last_sync_at: string | null;
  last_sync_duration_ms: number;
  sync_count: number;
  unmatched_drafts: UnmatchedDraft[];
  resolved_drafts: ResolvedDraft[];
  matched_count: number;
  netsuite_sos: number;
  shopify_drafts: number;
  error: string | null;
  last_notification_at: string | null;
  notifications_sent: number;
}

const BLOB_PATH = 'recon/sync-state.json';
const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const LOOKBACK_DAYS = 7;
const ALERT_THRESHOLD_MINUTES = 15;
const RESOLVED_KEEP_DAYS = 7;

let state: ReconSyncState = {
  last_sync_at: null,
  last_sync_duration_ms: 0,
  sync_count: 0,
  unmatched_drafts: [],
  resolved_drafts: [],
  matched_count: 0,
  netsuite_sos: 0,
  shopify_drafts: 0,
  error: null,
  last_notification_at: null,
  notifications_sent: 0,
};

let running = false;
let syncTimeout: ReturnType<typeof setTimeout> | null = null;

function daysAgoStr(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

function todayStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
}

async function sendUnmatchedNotifications(alertDrafts: UnmatchedDraft[]): Promise<void> {
  if (alertDrafts.length === 0) return;

  const channels = getNotificationChannels();

  // Teams — one card per draft, clean design with mentions
  if (channels.teams.enabled && isTeamsEnabled()) {
    for (const d of alertDrafts) {
      const card = {
        type: 'message',
        attachments: [{
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              {
                type: 'TextBlock',
                text: 'NS ↔ Shopify Reconciliation',
                weight: 'Bolder',
                size: 'Small',
                color: 'Accent',
                spacing: 'None',
              },
              {
                type: 'TextBlock',
                text: '🔴 Unmatched Draft Order',
                weight: 'Bolder',
                size: 'Large',
                color: 'Attention',
                spacing: 'Medium',
              },
              {
                type: 'TextBlock',
                text: `**${d.draft_number}** has no match in NetSuite Sales Order. Please check in Team Central if there is an error.`,
                wrap: true,
                size: 'Default',
                spacing: 'Medium',
              },
              {
                type: 'FactSet',
                spacing: 'Medium',
                facts: [
                  { title: 'Draft #', value: d.draft_number },
                  { title: 'Customer', value: d.shopify_customer || 'Unknown' },
                  { title: 'Amount', value: d.shopify_amount ? `$${Number(d.shopify_amount).toLocaleString()}` : '—' },
                  { title: 'Created', value: d.shopify_created ? new Date(d.shopify_created).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila' }) + ' PHT' : '—' },
                  { title: 'Unmatched For', value: `${d.age_minutes} minutes` },
                ],
              },
              {
                type: 'TextBlock',
                text: '<at>Larry Patacsil</at>',
                wrap: true,
                spacing: 'Medium',
              },
              {
                type: 'TextBlock',
                text: new Date().toUTCString(),
                size: 'Small',
                isSubtle: true,
                spacing: 'Medium',
              },
            ],
            msteams: {
              entities: [
                {
                  type: 'mention',
                  text: '<at>Larry Patacsil</at>',
                  mentioned: { id: 'lpatacsil@bulkequip.com', name: 'Larry Patacsil' },
                },
              ],
            },
          },
        }],
      };
      try {
        await sendReconTeamsCard(card);
        console.log(`[recon-sync] Teams alert sent for ${d.draft_number}`);
      } catch (err: any) {
        console.error(`[recon-sync] Teams alert failed for ${d.draft_number}:`, err.message);
      }
    }
  }

  // Email fallback
  if (channels.email.enabled && isEmailEnabled()) {
    for (const d of alertDrafts) {
      const nowPht = new Date().toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZone: 'Asia/Manila',
      }) + ' PHT';
      const subject = `🔴 ${d.draft_number} has no match in NetSuite Sales Order`;
      const plainBody = [
        `${d.draft_number} has no match in NetSuite Sales Order.`,
        `Please check in Team Central if there is an error.`,
        '', `Draft #: ${d.draft_number}`, `Customer: ${d.shopify_customer || 'Unknown'}`,
        `Amount: $${d.shopify_amount || '?'}`, `Detected At: ${nowPht}`,
        `Unmatched for: ${d.age_minutes} minutes`, '', `Dashboard: ${DASHBOARD_URL}`,
      ].join('\n');
      const html = buildAlertHtml({
        type: 'unmatched',
        headline: 'Unmatched Draft Order',
        description: 'An integration issue has been detected that may require investigation.',
        facts: [
          { label: 'Error Type', value: 'Unmatched NetSuite Sales Order' },
          { label: 'Reference', value: d.draft_number },
          { label: 'Customer', value: d.shopify_customer || 'Unknown' },
          { label: 'Amount', value: `$${d.shopify_amount ? Number(d.shopify_amount).toLocaleString('en-US', { minimumFractionDigits: 2 }) : '?'}` },
          { label: 'Detected At', value: nowPht },
          { label: 'Unresolved For', value: `${d.age_minutes} minutes` },
        ],
      });
      try {
        await sendAlertEmail(['Larry'], [], subject, plainBody, html);
      } catch (err: any) {
        console.error(`[recon-sync] Email alert failed for ${d.draft_number}:`, err.message);
      }
    }
  }
}

async function sendResolvedNotifications(resolved: ResolvedDraft[]): Promise<void> {
  if (resolved.length === 0) return;

  const channels = getNotificationChannels();

  if (channels.teams.enabled && isTeamsEnabled()) {
    for (const d of resolved) {
      const card = {
        type: 'message',
        attachments: [{
          contentType: 'application/vnd.microsoft.card.adaptive',
          contentUrl: null,
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              {
                type: 'TextBlock',
                text: 'NS ↔ Shopify Reconciliation',
                weight: 'Bolder',
                size: 'Small',
                color: 'Accent',
                spacing: 'None',
              },
              {
                type: 'TextBlock',
                text: '✅ Draft Now Matched',
                weight: 'Bolder',
                size: 'Large',
                color: 'Good',
                spacing: 'Medium',
              },
              {
                type: 'TextBlock',
                text: `**${d.draft_number}** is now matched to NetSuite SO **${d.netsuite_so || '—'}**. No action needed.`,
                wrap: true,
                size: 'Default',
                spacing: 'Medium',
              },
              {
                type: 'FactSet',
                spacing: 'Medium',
                facts: [
                  { title: 'Draft #', value: d.draft_number },
                  { title: 'NetSuite SO', value: d.netsuite_so || '—' },
                  { title: 'Customer', value: d.shopify_customer || 'Unknown' },
                  { title: 'Amount', value: d.shopify_amount ? `$${Number(d.shopify_amount).toLocaleString()}` : '—' },
                  { title: 'Time to Resolve', value: `${d.time_to_resolve_minutes} minutes` },
                ],
              },
              {
                type: 'TextBlock',
                text: '<at>Larry Patacsil</at>',
                wrap: true,
                spacing: 'Medium',
              },
              {
                type: 'TextBlock',
                text: new Date().toUTCString(),
                size: 'Small',
                isSubtle: true,
                spacing: 'Medium',
              },
            ],
            msteams: {
              entities: [
                {
                  type: 'mention',
                  text: '<at>Larry Patacsil</at>',
                  mentioned: { id: 'lpatacsil@bulkequip.com', name: 'Larry Patacsil' },
                },
              ],
            },
          },
        }],
      };
      try {
        await sendReconTeamsCard(card);
        console.log(`[recon-sync] Teams resolved notification sent for ${d.draft_number}`);
      } catch (err: any) {
        console.error(`[recon-sync] Teams resolved notification failed for ${d.draft_number}:`, err.message);
      }
    }
  }

  if (channels.email.enabled && isEmailEnabled()) {
    for (const d of resolved) {
      const nowPht = new Date().toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: 'numeric', minute: '2-digit', hour12: true,
        timeZone: 'Asia/Manila',
      }) + ' PHT';
      const subject = `✅ ${d.draft_number} now matched to ${d.netsuite_so || 'NetSuite SO'}`;
      const plainBody = [
        `${d.draft_number} is now matched to NetSuite SO ${d.netsuite_so || '—'}.`,
        `No action needed — the sync issue has been resolved.`,
        '', `Customer: ${d.shopify_customer || 'Unknown'}`,
        `Time to resolve: ${d.time_to_resolve_minutes} minutes`,
      ].join('\n');
      const html = buildAlertHtml({
        type: 'resolved',
        headline: 'Draft Now Matched',
        description: `<strong>${d.draft_number}</strong> is now matched to NetSuite SO <strong>${d.netsuite_so || '—'}</strong>.`,
        facts: [
          { label: 'Status', value: 'Resolved' },
          { label: 'Reference', value: d.draft_number },
          { label: 'NetSuite SO', value: d.netsuite_so || '—' },
          { label: 'Customer', value: d.shopify_customer || 'Unknown' },
          { label: 'Amount', value: `$${d.shopify_amount ? Number(d.shopify_amount).toLocaleString('en-US', { minimumFractionDigits: 2 }) : '—'}` },
          { label: 'Resolved At', value: nowPht },
          { label: 'Time to Resolve', value: `${d.time_to_resolve_minutes} minutes` },
        ],
      });
      try {
        await sendAlertEmail(['Larry'], [], subject, plainBody, html);
      } catch (err: any) {
        console.error(`[recon-sync] Email resolved notification failed for ${d.draft_number}:`, err.message);
      }
    }
  }
}

export async function runReconSync(): Promise<ReconSyncState> {
  if (running) return state;
  if (!shopifyConfigured() || !netsuiteConfigured()) {
    state.error = 'Shopify or NetSuite not configured';
    return state;
  }

  running = true;
  const t0 = Date.now();

  try {
    const startDate = daysAgoStr(LOOKBACK_DAYS);
    const endDate = todayStr();

    const [netsuiteSOs, shopifyDraftsMap] = await Promise.all([
      fetchSalesOrders(startDate, endDate),
      fetchDraftsByDateRange(startDate, endDate),
    ]);

    // Build map of draft number → NS SO number
    const draftToSO = new Map<string, string>();
    for (const so of netsuiteSOs.orders) {
      const memo = so.memo?.trim();
      if (memo && /^#D\d+$/.test(memo)) {
        draftToSO.set(memo, so.so_number);
      }
    }

    const matchedDraftNumbers = new Set(draftToSO.keys());

    // Also look up any Shopify drafts by name that NS SOs reference
    const nsMemoDrafts = [...matchedDraftNumbers];
    const byName = await lookupDraftsByName(nsMemoDrafts);
    for (const [name] of byName) {
      if (!shopifyDraftsMap.has(name)) shopifyDraftsMap.set(name, byName.get(name)!);
    }

    // Load previous state to preserve first_seen + notified_at timestamps
    const prev = await readJson<ReconSyncState>(BLOB_PATH);
    const prevDrafts = new Map<string, UnmatchedDraft>();
    if (prev.data?.unmatched_drafts) {
      for (const d of prev.data.unmatched_drafts) {
        prevDrafts.set(d.draft_number, d);
      }
    }
    const prevResolved = prev.data?.resolved_drafts || [];

    // Find unmatched: Shopify drafts with no NS SO
    const now = new Date();
    const unmatched: UnmatchedDraft[] = [];
    const newlyResolved: ResolvedDraft[] = [];

    for (const [draftName, draft] of shopifyDraftsMap) {
      if (matchedDraftNumbers.has(draftName)) {
        // This draft now has a matching SO — check if it was previously unmatched
        const prevDraft = prevDrafts.get(draftName);
        if (prevDraft) {
          const resolveMs = now.getTime() - new Date(prevDraft.first_seen).getTime();
          newlyResolved.push({
            draft_number: draftName,
            shopify_customer: draft.customer || null,
            shopify_amount: draft.total_price || null,
            shopify_created: draft.created_at || null,
            netsuite_so: draftToSO.get(draftName) || null,
            first_seen: prevDraft.first_seen,
            resolved_at: now.toISOString(),
            time_to_resolve_minutes: Math.floor(resolveMs / 60000),
            was_alerted: !!prevDraft.notified_at,
          });
        }
        continue;
      }

      const prevDraft = prevDrafts.get(draftName);
      const firstSeen = prevDraft?.first_seen || now.toISOString();
      const ageMs = now.getTime() - new Date(firstSeen).getTime();

      unmatched.push({
        draft_number: draftName,
        shopify_customer: draft.customer || null,
        shopify_amount: draft.total_price || null,
        shopify_created: draft.created_at || null,
        first_seen: firstSeen,
        age_minutes: Math.floor(ageMs / 60000),
        notified_at: prevDraft?.notified_at || null,
      });
    }

    // Sort unmatched by age (oldest first)
    unmatched.sort((a, b) => b.age_minutes - a.age_minutes);

    // Merge resolved: keep previous + new, prune older than RESOLVED_KEEP_DAYS
    const cutoff = now.getTime() - RESOLVED_KEEP_DAYS * 24 * 60 * 60 * 1000;
    const allResolved = [...prevResolved, ...newlyResolved]
      .filter(d => new Date(d.resolved_at).getTime() > cutoff);
    allResolved.sort((a, b) => new Date(b.resolved_at).getTime() - new Date(a.resolved_at).getTime());

    // Send notifications for newly alerted drafts
    const needsAlert = unmatched.filter(
      d => d.age_minutes >= ALERT_THRESHOLD_MINUTES && !d.notified_at
    );
    if (needsAlert.length > 0) {
      await sendUnmatchedNotifications(needsAlert);
      const notifiedAt = now.toISOString();
      for (const d of needsAlert) {
        d.notified_at = notifiedAt;
      }
    }

    // Send resolved notifications (only for ones that had been alerted)
    const alertedResolved = newlyResolved.filter(d => d.was_alerted);
    if (alertedResolved.length > 0) {
      await sendResolvedNotifications(alertedResolved);
    }

    state = {
      last_sync_at: now.toISOString(),
      last_sync_duration_ms: Date.now() - t0,
      sync_count: state.sync_count + 1,
      unmatched_drafts: unmatched,
      resolved_drafts: allResolved,
      matched_count: matchedDraftNumbers.size,
      netsuite_sos: netsuiteSOs.orders.length,
      shopify_drafts: shopifyDraftsMap.size,
      error: null,
      last_notification_at: needsAlert.length > 0 || alertedResolved.length > 0 ? now.toISOString() : state.last_notification_at,
      notifications_sent: state.notifications_sent + (needsAlert.length > 0 ? 1 : 0) + (alertedResolved.length > 0 ? 1 : 0),
    };

    await writeJson(BLOB_PATH, state);

    const resolvedLog = newlyResolved.length > 0 ? `, ${newlyResolved.length} resolved` : '';
    console.log(`[recon-sync] #${state.sync_count}: ${state.shopify_drafts} drafts, ${state.netsuite_sos} SOs, ${state.matched_count} matched, ${unmatched.length} unmatched${resolvedLog}, ${needsAlert.length} alerted (${state.last_sync_duration_ms}ms)`);
  } catch (err: any) {
    state.error = err.message;
    console.error('[recon-sync] error:', err.message);
  } finally {
    running = false;
  }

  return state;
}

export function getReconSyncState(): ReconSyncState {
  return state;
}

function scheduleNext(): void {
  if (syncTimeout) clearTimeout(syncTimeout);
  syncTimeout = setTimeout(async () => {
    await runReconSync();
    scheduleNext();
  }, SYNC_INTERVAL_MS);
}

export async function startReconSync(): Promise<void> {
  try {
    const prev = await readJson<ReconSyncState>(BLOB_PATH);
    if (prev.data) {
      state = {
        ...state,
        ...prev.data,
        resolved_drafts: prev.data.resolved_drafts ?? [],
        last_notification_at: prev.data.last_notification_at ?? null,
        notifications_sent: prev.data.notifications_sent ?? 0,
      };
      const now = new Date();
      for (const d of state.unmatched_drafts) {
        d.age_minutes = Math.floor((now.getTime() - new Date(d.first_seen).getTime()) / 60000);
      }
    }
  } catch {
    // Start fresh
  }

  // First sync after 10s
  setTimeout(async () => {
    await runReconSync();
    scheduleNext();
  }, 10_000);

  // Watchdog: if no sync for 10 min (2x interval), restart the chain
  setInterval(() => {
    if (state.last_sync_at) {
      const staleSec = (Date.now() - new Date(state.last_sync_at).getTime()) / 1000;
      if (staleSec > SYNC_INTERVAL_MS / 1000 * 2) {
        console.log(`[recon-sync] watchdog: sync stale (${Math.round(staleSec)}s), restarting`);
        scheduleNext();
      }
    }
  }, 60_000);

  console.log(`[recon-sync] scheduled every ${SYNC_INTERVAL_MS / 1000}s, alert threshold: ${ALERT_THRESHOLD_MINUTES}min, watchdog: 60s`);
}

export function stopReconSync(): void {
  if (syncTimeout) {
    clearTimeout(syncTimeout);
    syncTimeout = null;
  }
}
