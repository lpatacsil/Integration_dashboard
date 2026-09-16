import pool from '../db';
import { RULES, CATEGORY_RULES, FLOWS } from '../config';
import { classify, OpenBlockingError, startOfToday } from '../severity';
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
  return `Severity:        ${ctx.level}  (${ctx.levelName})
Flow / process:  ${ctx.flow}
Category:        ${ctx.categoryCode} – ${ctx.categoryLabel}
Current count:   ${ctx.count}   Threshold / rule: ${ctx.rule}
First seen:      ${ctx.openedAt}    Age: ${ctx.age}
Transactions:    ${ctx.entityRefs}
Error text:      ${ctx.rawMessage}
Recommended:     ${ctx.playbookStep}
Escalated to:    ${ctx.notify.join(', ')}   Cc: ${ctx.cc.join(', ') || '—'}
Next reminder:   in ${ctx.renotifyMinutes >= 60 ? ctx.renotifyMinutes / 60 + ' h' : ctx.renotifyMinutes + ' min'} unless resolved or level changes`;
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
  const result: EvaluationResult = {
    incidentsOpened: 0,
    incidentsResolved: 0,
    incidentsRenotified: 0,
    levelChanges: 0,
    notifications: [],
  };

  const now = new Date();

  // ── 1. Gather current state ────────────────────────────────────────────

  const blockingRes = await pool.query<OpenBlockingError>(`
    SELECT error_id, transaction_id, flow_code, entity_identifier,
           error_code, error_message, occurred_at
    FROM v_open_blocking_errors
  `);
  const openBlocking = blockingRes.rows;

  const hbRes = await pool.query(`
    SELECT heartbeat_at FROM connector_heartbeats
    ORDER BY heartbeat_at DESC LIMIT 1
  `);
  const heartbeatAgeMin = hbRes.rows.length
    ? (Date.now() - new Date(hbRes.rows[0].heartbeat_at).getTime()) / 60000
    : 999;

  const tx60Res = await pool.query(`
    SELECT COUNT(*)::int AS cnt FROM integration_transactions
    WHERE flow_code != 'NS' AND created_at > NOW() - INTERVAL '60 minutes'
  `);
  const baseRes = await pool.query(`
    SELECT COUNT(*)::int AS cnt FROM integration_transactions
    WHERE flow_code != 'NS' AND created_at > NOW() - INTERVAL '28 days'
      AND EXTRACT(DOW FROM created_at) = EXTRACT(DOW FROM NOW())
      AND EXTRACT(HOUR FROM created_at) = EXTRACT(HOUR FROM NOW())
  `);

  const overallSeverity = classify(
    openBlocking, heartbeatAgeMin,
    tx60Res.rows[0].cnt, Math.round(baseRes.rows[0].cnt / 4),
  );

  // ── 2. Build current incident set from open blocking errors ─────────

  // Group blocking errors by flow + category + entity
  const currentIncidents = new Map<string, {
    flowCode: string;
    errorCode: string;
    entityRefs: string[];
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
      if (new Date(err.occurred_at) < existing.oldestAt) {
        existing.oldestAt = new Date(err.occurred_at);
      }
    } else {
      currentIncidents.set(key, {
        flowCode: err.flow_code,
        errorCode: err.error_code,
        entityRefs: [err.entity_identifier],
        errorMessages: [err.error_message],
        oldestAt: new Date(err.occurred_at),
        count: 1,
      });
    }
  }

  // Also check threshold breaches
  const todayStr = now.toISOString().slice(0, 10);
  const tomorrowDate = new Date(now);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);

  const flowCountsRes = await pool.query(`
    SELECT flow_code,
      COUNT(*) FILTER (WHERE normalized_status = 'FAILED')::int AS errors,
      COUNT(*) FILTER (WHERE is_rerun = TRUE)::int AS reruns
    FROM integration_transactions
    WHERE created_at >= $1 AND created_at < $2
    GROUP BY flow_code
  `, [todayStr, tomorrowStr]);

  const flowCounts: Record<string, { errors: number; reruns: number }> = {};
  for (const r of flowCountsRes.rows) {
    flowCounts[r.flow_code] = { errors: r.errors, reruns: r.reruns };
  }

  const thresholdChecks: Array<{ key: string; flowCode: string; code: string; count: number; threshold: number; label: string }> = [
    { key: 'S2N::THRESHOLD::errors', flowCode: 'S2N', code: 'S2N.errors', count: flowCounts['S2N']?.errors || 0, threshold: RULES.thresholds['S2N.errors'], label: 'Shopify → NetSuite order errors' },
    { key: 'N2S::THRESHOLD::errors', flowCode: 'N2S', code: 'N2S.errors', count: flowCounts['N2S']?.errors || 0, threshold: RULES.thresholds['N2S.errors'], label: 'NetSuite → Shopify errors' },
    { key: 'ALL::THRESHOLD::rerun', flowCode: 'S2N', code: 'S2N.rerun', count: (flowCounts['S2N']?.reruns || 0) + (flowCounts['N2S']?.reruns || 0) + (flowCounts['IDX']?.reruns || 0), threshold: RULES.thresholds['S2N.rerun'], label: 'SO re-run messages' },
    { key: 'IDX::THRESHOLD::failed', flowCode: 'IDX', code: 'IDX.failed', count: flowCounts['IDX']?.errors || 0, threshold: RULES.thresholds['IDX.failed'], label: 'Indexing failures' },
  ];

  // NS category thresholds
  const nsCatRes = await pool.query(`
    SELECT e.error_code, COUNT(*)::int AS cnt
    FROM integration_errors e
    JOIN integration_transactions t ON t.id = e.transaction_id
    WHERE t.flow_code = 'NS' AND e.occurred_at >= $1 AND e.occurred_at < $2
    GROUP BY e.error_code
  `, [todayStr, tomorrowStr]);

  for (const r of nsCatRes.rows) {
    const thresholdKey = `NS.${r.error_code}`;
    if (RULES.thresholds[thresholdKey]) {
      thresholdChecks.push({
        key: `NS::THRESHOLD::${r.error_code}`,
        flowCode: 'NS',
        code: thresholdKey,
        count: r.cnt,
        threshold: RULES.thresholds[thresholdKey],
        label: `NetSuite: ${CATEGORY_RULES.find(c => c.code === r.error_code)?.label || r.error_code}`,
      });
    }
  }

  for (const check of thresholdChecks) {
    if (check.count > check.threshold) {
      currentIncidents.set(check.key, {
        flowCode: check.flowCode,
        errorCode: check.code,
        entityRefs: [],
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
      errorMessages: [`Connector heartbeat missing (${Math.round(heartbeatAgeMin)} min ago) / zero throughput`],
      oldestAt: now,
      count: 1,
    });
  }

  // ── 3. Load existing open incidents from DB ────────────────────────

  const existingRes = await pool.query(`
    SELECT * FROM alert_incidents WHERE status = 'OPEN'
  `);
  const existingByKey = new Map<string, any>();
  for (const row of existingRes.rows) {
    existingByKey.set(row.incident_key, row);
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
      rawMessage: incident.errorMessages[0] || '—',
      playbookStep: PLAYBOOK[incident.errorCode] || 'Investigate and resolve',
      notify: esc.notify,
      cc: esc.cc,
      renotifyMinutes: esc.renotifyMinutes,
    };

    const existing = existingByKey.get(key);

    if (!existing) {
      // ── New incident: INSERT + create OPENED notification ──
      const title = `${flowName} – ${ctx.categoryLabel}`;
      const insertRes = await pool.query(`
        INSERT INTO alert_incidents
          (incident_key, flow_code, error_code, entity_identifier, severity_level,
           title, detail, notify, cc, renotify_minutes, transaction_ids,
           status, opened_at, last_notified_at, last_level_change, notification_count)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'OPEN', NOW(), NOW(), NOW(), 1)
        RETURNING id
      `, [
        key, incident.flowCode, incident.errorCode,
        incident.entityRefs[0] || null, overallSeverity,
        title, ctx.rawMessage, esc.notify, esc.cc,
        esc.renotifyMinutes, incident.entityRefs.slice(0, 20),
      ]);

      const incidentId = insertRes.rows[0].id;
      const subject = renderSubject(ctx);
      const body = renderBody(ctx);

      await pool.query(`
        INSERT INTO alert_notifications
          (incident_id, notification_type, severity_level, recipients, cc, subject, body, sent)
        VALUES ($1, 'OPENED', $2, $3, $4, $5, $6, FALSE)
      `, [incidentId, overallSeverity, esc.notify, esc.cc, subject, body]);

      result.incidentsOpened++;
      result.notifications.push({
        type: 'OPENED', incidentKey: key, subject, recipients: esc.notify, cc: esc.cc, sent: false,
      });

      // Send Teams notification
      if (isTeamsEnabled()) {
        sendTeamsNotification({
          type: 'OPENED', incidentKey: key, severity: overallSeverity,
          subject, body, recipients: esc.notify, cc: esc.cc,
        }).catch(err => console.error('Teams notify error (OPENED):', err));
      }

      // Send email notification
      if (isEmailEnabled()) {
        sendAlertEmail(esc.notify, esc.cc, subject, body)
          .then(sent => { if (sent) markNotificationsSent([incidentId]); })
          .catch(err => console.error('Email notify error (OPENED):', err));
      }

    } else {
      // ── Existing incident: check for level change or renotify ──
      existingByKey.delete(key); // mark as still active

      const levelChanged = existing.severity_level !== overallSeverity;
      const lastNotified = new Date(existing.last_notified_at);
      const minutesSinceNotify = (now.getTime() - lastNotified.getTime()) / 60000;
      const dueForRenotify = minutesSinceNotify >= existing.renotify_minutes;

      if (levelChanged) {
        // Level change notification
        await pool.query(`
          UPDATE alert_incidents
          SET severity_level = $1, last_level_change = NOW(), last_notified_at = NOW(),
              notify = $2, cc = $3, renotify_minutes = $4,
              notification_count = notification_count + 1, updated_at = NOW()
          WHERE id = $5
        `, [overallSeverity, esc.notify, esc.cc, esc.renotifyMinutes, existing.id]);

        const subject = renderSubject(ctx);
        const body = renderBody(ctx);

        await pool.query(`
          INSERT INTO alert_notifications
            (incident_id, notification_type, severity_level, recipients, cc, subject, body, sent)
          VALUES ($1, 'LEVEL_CHANGE', $2, $3, $4, $5, $6, FALSE)
        `, [existing.id, overallSeverity, esc.notify, esc.cc, subject, body]);

        result.levelChanges++;
        result.notifications.push({
          type: 'LEVEL_CHANGE', incidentKey: key, subject, recipients: esc.notify, cc: esc.cc, sent: false,
        });

        // Send Teams notification
        if (isTeamsEnabled()) {
          sendTeamsNotification({
            type: 'LEVEL_CHANGE', incidentKey: key, severity: overallSeverity,
            subject, body, recipients: esc.notify, cc: esc.cc,
          }).catch(err => console.error('Teams notify error (LEVEL_CHANGE):', err));
        }

        // Send email notification
        if (isEmailEnabled()) {
          sendAlertEmail(esc.notify, esc.cc, subject, body)
            .then(sent => { if (sent) markNotificationsSent([existing.id]); })
            .catch(err => console.error('Email notify error (LEVEL_CHANGE):', err));
        }

      } else if (dueForRenotify) {
        // Renotify
        await pool.query(`
          UPDATE alert_incidents
          SET last_notified_at = NOW(), notification_count = notification_count + 1, updated_at = NOW()
          WHERE id = $1
        `, [existing.id]);

        const subject = `[REMINDER] ${renderSubject(ctx)}`;
        const body = renderBody(ctx);

        await pool.query(`
          INSERT INTO alert_notifications
            (incident_id, notification_type, severity_level, recipients, cc, subject, body, sent)
          VALUES ($1, 'RENOTIFY', $2, $3, $4, $5, $6, FALSE)
        `, [existing.id, overallSeverity, esc.notify, esc.cc, subject, body]);

        result.incidentsRenotified++;
        result.notifications.push({
          type: 'RENOTIFY', incidentKey: key, subject, recipients: esc.notify, cc: esc.cc, sent: false,
        });

        // Send Teams notification
        if (isTeamsEnabled()) {
          sendTeamsNotification({
            type: 'RENOTIFY', incidentKey: key, severity: overallSeverity,
            subject, body, recipients: esc.notify, cc: esc.cc,
          }).catch(err => console.error('Teams notify error (RENOTIFY):', err));
        }

        // Send email notification
        if (isEmailEnabled()) {
          sendAlertEmail(esc.notify, esc.cc, subject, body)
            .then(sent => { if (sent) markNotificationsSent([existing.id]); })
            .catch(err => console.error('Email notify error (RENOTIFY):', err));
        }
      }
    }
  }

  // ── 5. Resolve incidents that are no longer active ─────────────────

  for (const [key, existing] of existingByKey) {
    // This incident is no longer in the current set — resolve it
    await pool.query(`
      UPDATE alert_incidents
      SET status = 'RESOLVED', resolved_at = NOW(), updated_at = NOW()
      WHERE id = $1
    `, [existing.id]);

    const subject = renderResolvedSubject(
      FLOWS[existing.flow_code]?.name || existing.flow_code,
      existing.error_code || 'UNKNOWN',
    );
    const body = renderResolvedBody(key, now.toISOString());

    await pool.query(`
      INSERT INTO alert_notifications
        (incident_id, notification_type, severity_level, recipients, cc, subject, body, sent)
      VALUES ($1, 'RESOLVED', $2, $3, $4, $5, $6, FALSE)
    `, [existing.id, 0, existing.notify, existing.cc, subject, body]);

    result.incidentsResolved++;
    result.notifications.push({
      type: 'RESOLVED', incidentKey: key, subject, recipients: existing.notify, cc: existing.cc, sent: false,
    });

    // Send Teams notification
    if (isTeamsEnabled()) {
      sendTeamsNotification({
        type: 'RESOLVED', incidentKey: key, severity: 0,
        subject, body, recipients: existing.notify, cc: existing.cc,
      }).catch(err => console.error('Teams notify error (RESOLVED):', err));
    }

    // Send email notification
    if (isEmailEnabled()) {
      sendAlertEmail(existing.notify, existing.cc, subject, body)
        .then(sent => { if (sent) markNotificationsSent([existing.id]); })
        .catch(err => console.error('Email notify error (RESOLVED):', err));
    }
  }

  // ── 6. Save severity snapshot ──────────────────────────────────────

  await pool.query(`
    INSERT INTO severity_snapshots
      (overall_severity, flow_severities, open_blocking_count,
       heartbeat_age_min, tx_last_60, baseline_last_60, details)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
  `, [
    `SEV_${overallSeverity}`,
    JSON.stringify({}),
    openBlocking.length,
    Math.round(heartbeatAgeMin),
    tx60Res.rows[0].cnt,
    Math.round(baseRes.rows[0].cnt / 4),
    JSON.stringify({ evaluatedAt: now.toISOString(), incidentCount: currentIncidents.size }),
  ]);

  return result;
}

// ─── Query helpers for the API ──────────────────────────────────────────────

/**
 * Get all open incidents with their notification history.
 */
export async function getOpenIncidents(): Promise<any[]> {
  const res = await pool.query(`
    SELECT ai.*,
      (SELECT COUNT(*) FROM alert_notifications WHERE incident_id = ai.id) AS total_notifications,
      (SELECT COUNT(*) FROM alert_notifications WHERE incident_id = ai.id AND sent = TRUE) AS sent_notifications
    FROM alert_incidents ai
    WHERE ai.status = 'OPEN'
    ORDER BY ai.severity_level DESC, ai.opened_at ASC
  `);
  return res.rows;
}

/**
 * Get recent notifications (sent and unsent).
 */
export async function getRecentNotifications(limit: number = 50): Promise<any[]> {
  const res = await pool.query(`
    SELECT an.*, ai.incident_key, ai.flow_code, ai.error_code, ai.entity_identifier
    FROM alert_notifications an
    JOIN alert_incidents ai ON ai.id = an.incident_id
    ORDER BY an.created_at DESC
    LIMIT $1
  `, [limit]);
  return res.rows;
}

/**
 * Get incident history (all incidents, including resolved).
 */
export async function getIncidentHistory(limit: number = 100): Promise<any[]> {
  const res = await pool.query(`
    SELECT *
    FROM alert_incidents
    ORDER BY opened_at DESC
    LIMIT $1
  `, [limit]);
  return res.rows;
}

/**
 * Get unsent notifications (for when email transport is enabled).
 */
export async function getUnsentNotifications(): Promise<any[]> {
  const res = await pool.query(`
    SELECT an.*, ai.incident_key, ai.flow_code, ai.error_code
    FROM alert_notifications an
    JOIN alert_incidents ai ON ai.id = an.incident_id
    WHERE an.sent = FALSE
    ORDER BY an.created_at ASC
  `);
  return res.rows;
}

/**
 * Mark notifications as sent (called after email transport sends them).
 */
export async function markNotificationsSent(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(`
    UPDATE alert_notifications
    SET sent = TRUE, sent_at = NOW()
    WHERE id = ANY($1)
  `, [ids]);
}
