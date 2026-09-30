import { ulid } from 'ulid';
import { getStore, AlertIncident } from '../store';
import { FLOWS } from '../config';
import { getRules, getCategoryRules } from './settings-store';
import { classify } from '../severity';
import {
  indexById, toOpenBlockingErrors, computeTxLast60, computeBaselineLast60,
  computeThresholdFlowCounts, computeNsCategoryCounts, errorsForFlow,
} from '../store/aggregate';
import { sendTeamsNotification, isTeamsEnabled } from './teams-notify';
import { sendAlertEmail, isEmailEnabled } from './email-notify';

// ─── Email template rendering ───────────────────────────────────────────────

interface AlertContext {
  level: number;
  levelName: string;
  flow: string;
  categoryCode: string;
  categoryLabel: string;
  count: number;
  rule: string;
  openedAt: string;
  age: string;
  entityRefs: string;
  soNumbers: string;
  draftIds: string;
  rawMessage: string;
  playbookStep: string;
  notify: string[];
  cc: string[];
  renotifyMinutes: number;
}

const SEVERITY_NAMES: Record<number, string> = {
  0: 'Healthy',
  1: 'Sev 1 – One blocked',
  2: 'Sev 2 – Multiple blocked (same day)',
  3: 'Sev 3 – Multiple blocked (overnight)',
  4: 'Sev 4 – Tool down',
};

const PLAYBOOK: Record<string, string> = {
  'MAP-CUST': 'Map customer in TeamCentral index, then re-run SO',
  'MAP-ITEM': 'Map SKU in TeamCentral index, then re-run SO',
  'MAP-SHIP': 'Map ship-to address in TeamCentral index, then re-run SO',
  'MAP-LOC': 'Map location/store in TeamCentral index, then re-run SO',
  'IDX-SKIP': 'Check indexing config, re-index the skipped record, then re-run SO',
  'TAX-VERTEX': 'Check Vertex tax setup for the address/product; fix in NetSuite',
  'INV-ITEM': 'Verify item exists and has sufficient inventory in NetSuite',
  'NS-PERM': 'Check integration role permissions in NetSuite',
  'VAL-DATA': 'Fix missing/invalid field data on the NetSuite record',
  'API-RATE': 'Transient — will auto-retry. Investigate if persistent',
  'DUP': 'Check if duplicate is valid; suppress or merge records',
  'CONN-DOWN': 'Check connector service health; restart if needed',
};

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

function formatAge(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function renderSubject(ctx: AlertContext): string {
  return `[SEV ${ctx.level}] ${ctx.flow} – ${ctx.categoryCode}: ${ctx.count} transaction(s) blocked`;
}

function renderBody(ctx: AlertContext): string {
  let body = `Severity:        ${ctx.level}  (${ctx.levelName})
Flow / process:  ${ctx.flow}
Category:        ${ctx.categoryCode} – ${ctx.categoryLabel}
Current count:   ${ctx.count}   Threshold / rule: ${ctx.rule}
First seen:      ${ctx.openedAt}    Age: ${ctx.age}
Transactions:    ${ctx.entityRefs}`;
  if (ctx.soNumbers) body += `\nSO number(s):    ${ctx.soNumbers}`;
  if (ctx.draftIds) body += `\nDraft ID(s):     ${ctx.draftIds}`;
  body += `
Error text:      ${ctx.rawMessage}
Recommended:     ${ctx.playbookStep}
Escalated to:    ${ctx.notify.join(', ')}   Cc: ${ctx.cc.join(', ') || '—'}
Next reminder:   in ${ctx.renotifyMinutes >= 60 ? ctx.renotifyMinutes / 60 + ' h' : ctx.renotifyMinutes + ' min'} unless resolved or level changes`;
  return body;
}

function renderResolvedSubject(flow: string, categoryCode: string): string {
  return `[RESOLVED] ${flow} – ${categoryCode}: incident resolved`;
}

function renderResolvedBody(incidentKey: string, resolvedAt: string): string {
  return `Incident ${incidentKey} has been resolved.
Resolved at: ${resolvedAt}

No further notifications will be sent for this incident.`;
}

// ─── Incident key generation ────────────────────────────────────────────────

function makeIncidentKey(flowCode: string, errorCode: string, entityRef: string): string {
  return `${flowCode}::${errorCode}::${entityRef}`;
}

// ─── Core evaluation engine ─────────────────────────────────────────────────

interface EvaluationResult {
  incidentsOpened: number;
  incidentsResolved: number;
  incidentsRenotified: number;
  levelChanges: number;
  notifications: Array<{
    type: string;
    incidentKey: string;
    subject: string;
    recipients: string[];
    cc: string[];
    sent: boolean;
  }>;
}

/**
 * Evaluate all current conditions, open/update/resolve incidents,
 * and generate notification records. Does NOT send emails.
 */
export async function evaluate(): Promise<EvaluationResult> {
  const RULES = getRules();
  const CATEGORY_RULES = getCategoryRules();
  const store = getStore();
  const result: EvaluationResult = {
    incidentsOpened: 0,
    incidentsResolved: 0,
    incidentsRenotified: 0,
    levelChanges: 0,
    notifications: [],
  };

  const now = new Date();

  // ── 1. Gather current state ────────────────────────────────────────────

  const [openErrors, hb, last28d] = await Promise.all([
    store.getOpenErrors(),
    store.getLatestHeartbeat(),
    store.queryTransactions({ start: new Date(now.getTime() - 28 * 86400000), end: new Date(now.getTime() + 1000) }),
  ]);
  const openTxMap = await store.getTransactionsByIds([...new Set(openErrors.map(e => e.transaction_id))]);
  const openTxById = indexById([...openTxMap.values()]);
  const openBlocking = toOpenBlockingErrors(openErrors, openTxById);

  const heartbeatAgeMin = hb ? (Date.now() - new Date(hb.heartbeat_at).getTime()) / 60000 : 999;
  const txLast60 = computeTxLast60(last28d, now);
  const baselineLast60 = computeBaselineLast60(last28d, now);

  const overallSeverity = classify(openBlocking, heartbeatAgeMin, txLast60, baselineLast60);

  // ── 2. Build current incident set from open blocking errors ─────────

  const currentIncidents = new Map<string, {
    flowCode: string;
    errorCode: string;
    entityRefs: string[];
    soNumbers: string[];
    draftIds: string[];
    errorMessages: string[];
    oldestAt: Date;
    count: number;
  }>();

  for (const err of openBlocking) {
    const key = makeIncidentKey(err.flow_code, err.error_code, err.entity_identifier);
    const existing = currentIncidents.get(key);
    if (existing) {
      existing.count++;
      existing.entityRefs.push(err.entity_identifier);
      existing.errorMessages.push(err.error_message);
      if (err.sales_order_id) existing.soNumbers.push(err.sales_order_id);
      if (err.transaction_type === 'Draft Order') existing.draftIds.push(err.entity_identifier);
      if (new Date(err.occurred_at) < existing.oldestAt) {
        existing.oldestAt = new Date(err.occurred_at);
      }
    } else {
      const soNumbers: string[] = [];
      const draftIds: string[] = [];
      if (err.sales_order_id) soNumbers.push(err.sales_order_id);
      if (err.transaction_type === 'Draft Order') draftIds.push(err.entity_identifier);
      currentIncidents.set(key, {
        flowCode: err.flow_code,
        errorCode: err.error_code,
        entityRefs: [err.entity_identifier],
        soNumbers,
        draftIds,
        errorMessages: [err.error_message],
        oldestAt: new Date(err.occurred_at),
        count: 1,
      });
    }
  }

  // Also check threshold breaches (today's range)
  const todayStart = new Date(now); todayStart.setUTCHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart.getTime() + 86400000);
  const todayTransactions = await store.queryTransactions({ start: todayStart, end: tomorrowStart });
  const todayErrors = await store.queryErrors({ start: todayStart, end: tomorrowStart });
  const todayTxById = indexById(todayTransactions);

  const flowCounts = computeThresholdFlowCounts(todayTransactions);

  const thresholdChecks: Array<{ key: string; flowCode: string; code: string; count: number; threshold: number; label: string }> = [
    { key: 'S2N::THRESHOLD::errors', flowCode: 'S2N', code: 'S2N.errors', count: flowCounts['S2N']?.errors || 0, threshold: RULES.thresholds['S2N.errors'], label: 'Shopify → NetSuite order errors' },
    { key: 'N2S::THRESHOLD::errors', flowCode: 'N2S', code: 'N2S.errors', count: flowCounts['N2S']?.errors || 0, threshold: RULES.thresholds['N2S.errors'], label: 'NetSuite → Shopify errors' },
    { key: 'ALL::THRESHOLD::rerun', flowCode: 'S2N', code: 'S2N.rerun', count: (flowCounts['S2N']?.reruns || 0) + (flowCounts['N2S']?.reruns || 0) + (flowCounts['IDX']?.reruns || 0), threshold: RULES.thresholds['S2N.rerun'], label: 'SO re-run messages' },
    { key: 'IDX::THRESHOLD::failed', flowCode: 'IDX', code: 'IDX.failed', count: flowCounts['IDX']?.errors || 0, threshold: RULES.thresholds['IDX.failed'], label: 'Indexing failures' },
  ];

  // NS category thresholds
  const nsErrors = errorsForFlow(todayErrors, todayTxById, 'NS');
  const nsCounts = computeNsCategoryCounts(nsErrors);
  for (const [code, cnt] of Object.entries(nsCounts)) {
    const thresholdKey = `NS.${code}`;
    if (RULES.thresholds[thresholdKey]) {
      thresholdChecks.push({
        key: `NS::THRESHOLD::${code}`,
        flowCode: 'NS',
        code: thresholdKey,
        count: cnt,
        threshold: RULES.thresholds[thresholdKey],
        label: `NetSuite: ${CATEGORY_RULES.find(c => c.code === code)?.label || code}`,
      });
    }
  }

  for (const check of thresholdChecks) {
    if (check.count > check.threshold) {
      currentIncidents.set(check.key, {
        flowCode: check.flowCode,
        errorCode: check.code,
        entityRefs: [],
        soNumbers: [],
        draftIds: [],
        errorMessages: [`${check.label}: ${check.count} in range vs threshold ${check.threshold}`],
        oldestAt: now,
        count: check.count,
      });
    }
  }

  // Sev 4 (tool down) as its own incident
  if (overallSeverity === 4) {
    currentIncidents.set('SYSTEM::SEV4::tooldown', {
      flowCode: 'ALL',
      errorCode: 'CONN-DOWN',
      entityRefs: [],
      soNumbers: [],
      draftIds: [],
      errorMessages: [`Connector heartbeat missing (${Math.round(heartbeatAgeMin)} min ago) / zero throughput`],
      oldestAt: now,
      count: 1,
    });
  }

  // ── 3. Load existing open incidents ─────────────────────────────────

  const existingIncidents = await store.getOpenIncidents();
  const existingByKey = new Map<string, AlertIncident>();
  for (const incident of existingIncidents) {
    existingByKey.set(incident.incident_key, incident);
  }

  // ── 4. Open new incidents / update existing ones ───────────────────

  for (const [key, incident] of currentIncidents) {
    const esc = RULES.escalation[overallSeverity] || RULES.escalation[1];
    const catRule = CATEGORY_RULES.find(c => c.code === incident.errorCode);
    const flowName = FLOWS[incident.flowCode]?.name || incident.flowCode;
    const ageMin = (now.getTime() - incident.oldestAt.getTime()) / 60000;

    const ctx: AlertContext = {
      level: overallSeverity,
      levelName: SEVERITY_NAMES[overallSeverity] || `Sev ${overallSeverity}`,
      flow: flowName,
      categoryCode: incident.errorCode,
      categoryLabel: catRule?.label || incident.errorCode,
      count: incident.count,
      rule: key.includes('THRESHOLD') ? `threshold ${RULES.thresholds[incident.errorCode] || '—'}/day` : `severity ${overallSeverity}`,
      openedAt: incident.oldestAt.toISOString(),
      age: formatAge(ageMin),
      entityRefs: incident.entityRefs.slice(0, 5).join(', ') + (incident.entityRefs.length > 5 ? ` +${incident.entityRefs.length - 5}` : ''),
      soNumbers: dedupe(incident.soNumbers).slice(0, 5).join(', ') + (dedupe(incident.soNumbers).length > 5 ? ` +${dedupe(incident.soNumbers).length - 5}` : ''),
      draftIds: dedupe(incident.draftIds).slice(0, 5).join(', ') + (dedupe(incident.draftIds).length > 5 ? ` +${dedupe(incident.draftIds).length - 5}` : ''),
      rawMessage: incident.errorMessages[0] || '—',
      playbookStep: PLAYBOOK[incident.errorCode] || 'Investigate and resolve',
      notify: esc.notify,
      cc: esc.cc,
      renotifyMinutes: esc.renotifyMinutes,
    };

    const existing = existingByKey.get(key);

    if (!existing) {
      // ── New incident ──
      const title = `${flowName} – ${ctx.categoryLabel}`;
      const nowIso = now.toISOString();
      const newIncident: AlertIncident = {
        id: ulid(),
        incident_key: key,
        flow_code: incident.flowCode,
        error_code: incident.errorCode,
        entity_identifier: incident.entityRefs[0] || null,
        severity_level: overallSeverity,
        title,
        detail: ctx.rawMessage,
        notify: esc.notify,
        cc: esc.cc,
        renotify_minutes: esc.renotifyMinutes,
        transaction_ids: incident.entityRefs.slice(0, 20),
        status: 'OPEN',
        opened_at: nowIso,
        last_notified_at: nowIso,
        last_level_change: nowIso,
        resolved_at: null,
        notification_count: 1,
        created_at: nowIso,
        updated_at: nowIso,
      };
      await store.upsertIncident(newIncident);

      const subject = renderSubject(ctx);
      const body = renderBody(ctx);
      const openedNotification = await store.insertNotification({
        incident_id: newIncident.id, incident_key: key, flow_code: newIncident.flow_code,
        error_code: newIncident.error_code, entity_identifier: newIncident.entity_identifier,
        notification_type: 'OPENED', severity_level: overallSeverity,
        recipients: esc.notify, cc: esc.cc, subject, body, sent: false, sent_at: null,
      });

      result.incidentsOpened++;
      result.notifications.push({ type: 'OPENED', incidentKey: key, subject, recipients: esc.notify, cc: esc.cc, sent: false });

      if (isTeamsEnabled()) {
        sendTeamsNotification({ type: 'OPENED', incidentKey: key, severity: overallSeverity, subject, body, recipients: esc.notify, cc: esc.cc })
          .catch(err => console.error('Teams notify error (OPENED):', err));
      }
      if (isEmailEnabled()) {
        sendAlertEmail(esc.notify, esc.cc, subject, body)
          .then(sent => { if (sent) markNotificationsSent([openedNotification.id]); })
          .catch(err => console.error('Email notify error (OPENED):', err));
      }

    } else {
      // ── Existing incident: check for level change or renotify ──
      existingByKey.delete(key); // mark as still active

      const levelChanged = existing.severity_level !== overallSeverity;
      const lastNotified = new Date(existing.last_notified_at || existing.opened_at);
      const minutesSinceNotify = (now.getTime() - lastNotified.getTime()) / 60000;
      const dueForRenotify = minutesSinceNotify >= existing.renotify_minutes;

      if (levelChanged) {
        const updated: AlertIncident = {
          ...existing,
          severity_level: overallSeverity,
          last_level_change: now.toISOString(),
          last_notified_at: now.toISOString(),
          notify: esc.notify,
          cc: esc.cc,
          renotify_minutes: esc.renotifyMinutes,
          notification_count: existing.notification_count + 1,
          updated_at: now.toISOString(),
        };
        await store.upsertIncident(updated);

        const subject = renderSubject(ctx);
        const body = renderBody(ctx);
        const levelChangeNotification = await store.insertNotification({
          incident_id: existing.id, incident_key: key, flow_code: existing.flow_code,
          error_code: existing.error_code, entity_identifier: existing.entity_identifier,
          notification_type: 'LEVEL_CHANGE', severity_level: overallSeverity,
          recipients: esc.notify, cc: esc.cc, subject, body, sent: false, sent_at: null,
        });

        result.levelChanges++;
        result.notifications.push({ type: 'LEVEL_CHANGE', incidentKey: key, subject, recipients: esc.notify, cc: esc.cc, sent: false });

        if (isTeamsEnabled()) {
          sendTeamsNotification({ type: 'LEVEL_CHANGE', incidentKey: key, severity: overallSeverity, subject, body, recipients: esc.notify, cc: esc.cc })
            .catch(err => console.error('Teams notify error (LEVEL_CHANGE):', err));
        }
        if (isEmailEnabled()) {
          sendAlertEmail(esc.notify, esc.cc, subject, body)
            .then(sent => { if (sent) markNotificationsSent([levelChangeNotification.id]); })
            .catch(err => console.error('Email notify error (LEVEL_CHANGE):', err));
        }

      } else if (dueForRenotify) {
        const updated: AlertIncident = {
          ...existing,
          last_notified_at: now.toISOString(),
          notification_count: existing.notification_count + 1,
          updated_at: now.toISOString(),
        };
        await store.upsertIncident(updated);

        const subject = `[REMINDER] ${renderSubject(ctx)}`;
        const body = renderBody(ctx);
        const renotifyNotification = await store.insertNotification({
          incident_id: existing.id, incident_key: key, flow_code: existing.flow_code,
          error_code: existing.error_code, entity_identifier: existing.entity_identifier,
          notification_type: 'RENOTIFY', severity_level: overallSeverity,
          recipients: esc.notify, cc: esc.cc, subject, body, sent: false, sent_at: null,
        });

        result.incidentsRenotified++;
        result.notifications.push({ type: 'RENOTIFY', incidentKey: key, subject, recipients: esc.notify, cc: esc.cc, sent: false });

        if (isTeamsEnabled()) {
          sendTeamsNotification({ type: 'RENOTIFY', incidentKey: key, severity: overallSeverity, subject, body, recipients: esc.notify, cc: esc.cc })
            .catch(err => console.error('Teams notify error (RENOTIFY):', err));
        }
        if (isEmailEnabled()) {
          sendAlertEmail(esc.notify, esc.cc, subject, body)
            .then(sent => { if (sent) markNotificationsSent([renotifyNotification.id]); })
            .catch(err => console.error('Email notify error (RENOTIFY):', err));
        }
      }
    }
  }

  // ── 5. Resolve incidents that are no longer active ─────────────────

  for (const [key, existing] of existingByKey) {
    await store.resolveIncident(existing.id);

    const subject = renderResolvedSubject(FLOWS[existing.flow_code]?.name || existing.flow_code, existing.error_code || 'UNKNOWN');
    const body = renderResolvedBody(key, now.toISOString());
    const resolvedNotification = await store.insertNotification({
      incident_id: existing.id, incident_key: key, flow_code: existing.flow_code,
      error_code: existing.error_code, entity_identifier: existing.entity_identifier,
      notification_type: 'RESOLVED', severity_level: 0,
      recipients: existing.notify, cc: existing.cc, subject, body, sent: false, sent_at: null,
    });

    result.incidentsResolved++;
    result.notifications.push({ type: 'RESOLVED', incidentKey: key, subject, recipients: existing.notify, cc: existing.cc, sent: false });

    if (isTeamsEnabled()) {
      sendTeamsNotification({ type: 'RESOLVED', incidentKey: key, severity: 0, subject, body, recipients: existing.notify, cc: existing.cc })
        .catch(err => console.error('Teams notify error (RESOLVED):', err));
    }
    if (isEmailEnabled()) {
      sendAlertEmail(existing.notify, existing.cc, subject, body)
        .then(sent => { if (sent) markNotificationsSent([resolvedNotification.id]); })
        .catch(err => console.error('Email notify error (RESOLVED):', err));
    }
  }

  // ── 6. Save severity snapshot ──────────────────────────────────────

  await store.insertSeveritySnapshot({
    evaluated_at: now.toISOString(),
    overall_severity: `SEV_${overallSeverity}`,
    flow_severities: {},
    open_blocking_count: openBlocking.length,
    heartbeat_age_min: Math.round(heartbeatAgeMin),
    tx_last_60: txLast60,
    baseline_last_60: baselineLast60,
    details: { evaluatedAt: now.toISOString(), incidentCount: currentIncidents.size },
  });

  return result;
}

// ─── Query helpers for the API ──────────────────────────────────────────────

export async function getOpenIncidents(): Promise<AlertIncident[]> {
  const store = getStore();
  const incidents = await store.getOpenIncidents();
  const notifications = await store.getRecentNotifications(1000);
  return incidents
    .map(i => ({
      ...i,
      total_notifications: notifications.filter(n => n.incident_id === i.id).length,
      sent_notifications: notifications.filter(n => n.incident_id === i.id && n.sent).length,
    }))
    .sort((a, b) => b.severity_level - a.severity_level || new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime());
}

export async function getRecentNotifications(limit: number = 50) {
  return getStore().getRecentNotifications(limit);
}

export async function getIncidentHistory(limit: number = 100) {
  return getStore().getIncidentHistory(limit);
}

export async function getUnsentNotifications() {
  return getStore().getUnsentNotifications();
}

export async function markNotificationsSent(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await getStore().markNotificationsSent(ids);
}
