/**
 * Microsoft Teams Incoming Webhook notification service.
 *
 * Sends Adaptive Cards to a Teams channel via an incoming webhook URL.
 * Set the TEAMS_WEBHOOK_URL environment variable to enable.
 */

const WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL || '';

const SEVERITY_COLORS: Record<number, string> = {
  0: 'Good',      // green
  1: 'Warning',   // yellow
  2: 'Warning',
  3: 'Attention', // red
  4: 'Attention',
};

const SEVERITY_LABELS: Record<number, string> = {
  0: 'Healthy',
  1: 'SEV 1 - One blocked',
  2: 'SEV 2 - Multiple blocked (same day)',
  3: 'SEV 3 - Multiple blocked (overnight)',
  4: 'SEV 4 - System down',
};

interface TeamsNotification {
  type: 'OPENED' | 'LEVEL_CHANGE' | 'RENOTIFY' | 'RESOLVED';
  incidentKey: string;
  severity: number;
  subject: string;
  body: string;
  recipients: string[];
  cc: string[];
}

/**
 * Returns true if the Teams webhook is configured.
 */
export function isTeamsEnabled(): boolean {
  return WEBHOOK_URL.length > 0;
}

/**
 * Send an alert notification to the Teams channel as an Adaptive Card.
 */
export async function sendTeamsNotification(notification: TeamsNotification): Promise<boolean> {
  if (!isTeamsEnabled()) return false;

  const card = buildAdaptiveCard(notification);

  try {
    const res = await fetch(WEBHOOK_URL, {
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
  const color = SEVERITY_COLORS[n.severity] ?? 'Default';
  const sevLabel = SEVERITY_LABELS[n.severity] ?? `SEV ${n.severity}`;
  const isResolved = n.type === 'RESOLVED';

  const typeLabel: Record<string, string> = {
    OPENED: 'New Incident',
    LEVEL_CHANGE: 'Severity Changed',
    RENOTIFY: 'Reminder',
    RESOLVED: 'Resolved',
  };

  // Parse body lines into key-value facts
  const facts = n.body
    .split('\n')
    .filter((line) => line.includes(':'))
    .map((line) => {
      const idx = line.indexOf(':');
      return {
        title: line.slice(0, idx).trim(),
        value: line.slice(idx + 1).trim(),
      };
    })
    .filter((f) => f.title && f.value);

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
            // Header with badge
            {
              type: 'ColumnSet',
              columns: [
                {
                  type: 'Column',
                  width: 'auto',
                  items: [
                    {
                      type: 'TextBlock',
                      text: isResolved ? 'RESOLVED' : sevLabel,
                      color: isResolved ? 'Good' : color,
                      weight: 'Bolder',
                      size: 'Medium',
                    },
                  ],
                },
                {
                  type: 'Column',
                  width: 'stretch',
                  items: [
                    {
                      type: 'TextBlock',
                      text: typeLabel[n.type] || n.type,
                      weight: 'Lighter',
                      size: 'Small',
                      horizontalAlignment: 'Right',
                    },
                  ],
                },
              ],
            },
            // Subject
            {
              type: 'TextBlock',
              text: n.subject,
              weight: 'Bolder',
              size: 'Medium',
              wrap: true,
            },
            // Fact set (parsed from body)
            {
              type: 'FactSet',
              facts: facts.slice(0, 10),
            },
            // Notified contacts
            {
              type: 'TextBlock',
              text: `**Notify:** ${n.recipients.join(', ')}${n.cc.length ? `  |  **Cc:** ${n.cc.join(', ')}` : ''}`,
              size: 'Small',
              wrap: true,
              isSubtle: true,
            },
          ],
        },
      },
    ],
  };
}
