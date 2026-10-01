/**
 * Microsoft Teams Incoming Webhook notification service.
 *
 * Sends Adaptive Cards to a Teams channel via an incoming webhook URL.
 * Set the TEAMS_WEBHOOK_URL environment variable to enable.
 */

import { getNotificationChannels } from './settings-store';

function getWebhookUrl(): string {
  const channels = getNotificationChannels();
  return channels.teams.webhookUrl || process.env.TEAMS_WEBHOOK_URL || '';
}

const DASHBOARD_URL = 'https://integration-dashboard-erdxhhczasejb4hj.westus3-01.azurewebsites.net';

const SEVERITY_COLORS: Record<number, string> = {
  0: 'Good',      // green
  1: 'Warning',   // yellow
  2: 'Warning',
  3: 'Attention', // red
  4: 'Attention',
};

const SEVERITY_LABELS: Record<number, string> = {
  0: 'Healthy',
  1: 'SEV 1 — One blocked',
  2: 'SEV 2 — Multiple blocked (same day)',
  3: 'SEV 3 — Multiple blocked (overnight)',
  4: 'SEV 4 — System down',
};

const SEVERITY_EMOJI: Record<number, string> = {
  0: '\u2705', // ✅
  1: '\uD83D\uDFE1', // 🟡
  2: '\uD83D\uDFE0', // 🟠
  3: '\uD83D\uDD34', // 🔴
  4: '\uD83D\uDD34', // 🔴
};

export interface TeamsNotification {
  type: 'OPENED' | 'LEVEL_CHANGE' | 'RENOTIFY' | 'RESOLVED';
  incidentKey: string;
  severity: number;
  subject: string;
  body: string;
  recipients: string[];
  cc: string[];
  // Structured fields for professional card layout
  flowName: string;
  categoryCode: string;
  categoryLabel: string;
  count: number;
  entityRefs: string[];
  soNumbers: string[];
  draftIds: string[];
  errorMessages: string[];
  playbookStep: string;
  openedAt: string;
  age: string;
  rule: string;
  renotifyMinutes: number;
}

/**
 * Returns true if the Teams webhook is configured.
 */
export function isTeamsEnabled(): boolean {
  return getWebhookUrl().length > 0;
}

/**
 * Send an alert notification to the Teams channel as an Adaptive Card.
 */
export async function sendTeamsNotification(notification: TeamsNotification): Promise<boolean> {
  const webhookUrl = getWebhookUrl();
  if (!webhookUrl) return false;

  const card = buildAdaptiveCard(notification);

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(card),
    });

    if (!res.ok) {
      console.error(`Teams webhook failed (${res.status}):`, await res.text());
      return false;
    }
    return true;
  } catch (err) {
    console.error('Teams webhook error:', err);
    return false;
  }
}

/**
 * Build an Adaptive Card payload for a Teams incoming webhook.
 */
function buildAdaptiveCard(n: TeamsNotification) {
  if (n.type === 'RESOLVED') return buildResolvedCard(n);
  return buildIncidentCard(n);
}

function buildIncidentCard(n: TeamsNotification) {
  const color = SEVERITY_COLORS[n.severity] ?? 'Default';
  const sevLabel = SEVERITY_LABELS[n.severity] ?? `SEV ${n.severity}`;
  const emoji = SEVERITY_EMOJI[n.severity] ?? '\u26A0\uFE0F';

  const typeLabel: Record<string, string> = {
    OPENED: 'New Incident',
    LEVEL_CHANGE: 'Severity Changed',
    RENOTIFY: 'Reminder',
  };

  const body: any[] = [];

  // ── Header: branding ──
  body.push({
    type: 'TextBlock',
    text: 'Team Central Dashboard',
    weight: 'Bolder',
    size: 'Small',
    color: 'Accent',
    spacing: 'None',
  });
  body.push({
    type: 'ColumnSet',
    separator: true,
    columns: [],
    spacing: 'Small',
  });

  // ── Severity banner ──
  body.push({
    type: 'ColumnSet',
    spacing: 'Medium',
    columns: [
      {
        type: 'Column',
        width: 'stretch',
        items: [
          {
            type: 'TextBlock',
            text: `${emoji} ${sevLabel}`,
            color,
            weight: 'Bolder',
            size: 'Medium',
            wrap: true,
          },
        ],
      },
      {
        type: 'Column',
        width: 'auto',
        verticalContentAlignment: 'Center',
        items: [
          {
            type: 'TextBlock',
            text: typeLabel[n.type] || n.type,
            weight: 'Bolder',
            size: 'Small',
            color: n.type === 'LEVEL_CHANGE' ? 'Warning' : 'Accent',
            horizontalAlignment: 'Right',
          },
        ],
      },
    ],
  });

  // ── Flow + Category section ──
  body.push({
    type: 'TextBlock',
    text: n.flowName,
    weight: 'Bolder',
    size: 'Medium',
    spacing: 'Medium',
    wrap: true,
  });
  body.push({
    type: 'TextBlock',
    text: `${n.categoryLabel} (${n.categoryCode})`,
    size: 'Default',
    wrap: true,
    spacing: 'Small',
  });

  // ── Affected Transactions table ──
  const txRows: any[] = [];
  const maxTx = Math.min(n.entityRefs.length, 5);
  if (maxTx > 0) {
    // Section header
    body.push({
      type: 'TextBlock',
      text: 'Affected Transactions',
      weight: 'Bolder',
      size: 'Small',
      spacing: 'Medium',
      separator: true,
    });

    // Column header row
    txRows.push({
      type: 'ColumnSet',
      spacing: 'Small',
      columns: [
        {
          type: 'Column',
          width: 1,
          items: [{ type: 'TextBlock', text: 'Order', weight: 'Bolder', size: 'Small' }],
        },
        {
          type: 'Column',
          width: 2,
          items: [{ type: 'TextBlock', text: 'Error', weight: 'Bolder', size: 'Small' }],
        },
      ],
    });

    for (let i = 0; i < maxTx; i++) {
      const ref = n.entityRefs[i] || '—';
      const errMsg = (n.errorMessages[i] || '—').slice(0, 80) + ((n.errorMessages[i] || '').length > 80 ? '...' : '');
      txRows.push({
        type: 'ColumnSet',
        spacing: 'None',
        columns: [
          {
            type: 'Column',
            width: 1,
            items: [{ type: 'TextBlock', text: `#${ref}`, size: 'Small', weight: 'Bolder' }],
          },
          {
            type: 'Column',
            width: 2,
            items: [{ type: 'TextBlock', text: errMsg, size: 'Small', wrap: true, isSubtle: true }],
          },
        ],
      });
    }
    if (n.entityRefs.length > 5) {
      txRows.push({
        type: 'TextBlock',
        text: `+${n.entityRefs.length - 5} more`,
        size: 'Small',
        isSubtle: true,
        spacing: 'None',
      });
    }
    body.push(...txRows);
  }

  // ── SO / Draft numbers (if any) ──
  const soDeduped = [...new Set(n.soNumbers)].filter(Boolean);
  const draftDeduped = [...new Set(n.draftIds)].filter(Boolean);
  if (soDeduped.length > 0 || draftDeduped.length > 0) {
    const parts: string[] = [];
    if (soDeduped.length > 0) parts.push(`**SO:** ${soDeduped.slice(0, 5).join(', ')}${soDeduped.length > 5 ? ` +${soDeduped.length - 5}` : ''}`);
    if (draftDeduped.length > 0) parts.push(`**Draft:** ${draftDeduped.slice(0, 5).join(', ')}${draftDeduped.length > 5 ? ` +${draftDeduped.length - 5}` : ''}`);
    body.push({
      type: 'TextBlock',
      text: parts.join('  |  '),
      size: 'Small',
      spacing: 'Small',
      wrap: true,
    });
  }

  // ── Recommended Action ──
  body.push({
    type: 'Container',
    spacing: 'Medium',
    separator: true,
    style: 'emphasis',
    items: [
      {
        type: 'TextBlock',
        text: 'Recommended Action',
        weight: 'Bolder',
        size: 'Small',
        spacing: 'None',
      },
      {
        type: 'TextBlock',
        text: n.playbookStep,
        size: 'Default',
        wrap: true,
        spacing: 'Small',
      },
    ],
  });

  // ── Details FactSet ──
  const openedDate = formatCardDate(n.openedAt);
  const renotifyLabel = n.renotifyMinutes >= 60
    ? `in ${n.renotifyMinutes / 60} h unless resolved`
    : `in ${n.renotifyMinutes} min unless resolved`;

  body.push({
    type: 'TextBlock',
    text: 'Details',
    weight: 'Bolder',
    size: 'Small',
    spacing: 'Medium',
    separator: true,
  });
  body.push({
    type: 'FactSet',
    facts: [
      { title: 'Opened', value: openedDate },
      { title: 'Age', value: n.age },
      { title: 'Threshold', value: n.rule },
      { title: 'Next alert', value: renotifyLabel },
    ],
  });

  // ── Escalation line ──
  const allRecipients = [...n.recipients, ...n.cc.map(c => `${c} (cc)`)].join(', ');
  body.push({
    type: 'TextBlock',
    text: `**Escalated to:** ${allRecipients}`,
    size: 'Small',
    wrap: true,
    spacing: 'Small',
    isSubtle: true,
  });

  // ── Timestamp footer ──
  body.push({
    type: 'TextBlock',
    text: new Date().toUTCString(),
    size: 'Small',
    isSubtle: true,
    spacing: 'Medium',
    horizontalAlignment: 'Left',
  });

  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body,
          actions: [
            {
              type: 'Action.OpenUrl',
              title: 'View in Dashboard',
              url: DASHBOARD_URL,
            },
          ],
        },
      },
    ],
  };
}

function buildResolvedCard(n: TeamsNotification) {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        contentUrl: null,
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard',
          version: '1.4',
          body: [
            {
              type: 'TextBlock',
              text: 'Team Central Dashboard',
              weight: 'Bolder',
              size: 'Small',
              color: 'Accent',
              spacing: 'None',
            },
            {
              type: 'ColumnSet',
              separator: true,
              spacing: 'Small',
              columns: [],
            },
            {
              type: 'TextBlock',
              text: '\u2705 RESOLVED',
              color: 'Good',
              weight: 'Bolder',
              size: 'Large',
              spacing: 'Medium',
            },
            {
              type: 'TextBlock',
              text: n.flowName ? `${n.flowName} — ${n.categoryLabel}` : n.subject,
              weight: 'Bolder',
              size: 'Medium',
              wrap: true,
              spacing: 'Small',
            },
            {
              type: 'FactSet',
              facts: [
                { title: 'Incident', value: n.incidentKey },
                { title: 'Resolved at', value: formatCardDate(new Date().toISOString()) },
              ],
            },
            {
              type: 'TextBlock',
              text: 'No further notifications will be sent for this incident.',
              size: 'Small',
              isSubtle: true,
              wrap: true,
              spacing: 'Small',
            },
            {
              type: 'TextBlock',
              text: new Date().toUTCString(),
              size: 'Small',
              isSubtle: true,
              spacing: 'Medium',
            },
          ],
          actions: [
            {
              type: 'Action.OpenUrl',
              title: 'View in Dashboard',
              url: DASHBOARD_URL,
            },
          ],
        },
      },
    ],
  };
}

function formatCardDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'America/Los_Angeles',
    });
  } catch {
    return iso;
  }
}
