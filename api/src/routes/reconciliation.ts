import { Router, Request, Response } from 'express';
import { lookupDraftsByName, fetchDraftsByDateRange, isConfigured as shopifyConfigured } from '../services/shopify-client';
import { fetchSalesOrders } from '../services/netsuite-sync';
import { isConfigured as netsuiteConfigured } from '../services/netsuite-auth';
import { getReconSyncState, runReconSync } from '../services/recon-sync';
import { isEmailEnabled, sendAlertEmail, buildAlertHtml } from '../services/email-notify';
import { isTeamsEnabled } from '../services/teams-notify';
import { getNotificationChannels } from '../services/settings-store';

const router = Router();

interface ReconRecord {
  netsuite_so: string | null;
  netsuite_memo: string | null;
  netsuite_customer: string | null;
  netsuite_amount: string | null;
  netsuite_date: string | null;
  netsuite_location: string | null;
  netsuite_shopify_so: string | null;
  shopify_draft: string | null;
  shopify_customer: string | null;
  shopify_amount: string | null;
  shopify_order: string | null;
  shopify_created: string | null;
  status: 'matched' | 'missing_in_netsuite' | 'missing_in_shopify' | 'no_memo';
}

// GET /api/reconciliation?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get('/', async (req: Request, res: Response) => {
  try {
    const startDate = req.query.startDate as string;
    const endDate = req.query.endDate as string;
    if (!startDate || !endDate) {
      res.status(400).json({ error: 'startDate and endDate are required' });
      return;
    }

    // Fetch both sides in parallel
    const [netsuiteSOs, shopifyDraftsMap] = await Promise.all([
      netsuiteConfigured()
        ? fetchSalesOrders(startDate, endDate)
        : { orders: [], source: 'not_configured' },
      shopifyConfigured()
        ? fetchDraftsByDateRange(startDate, endDate)
        : new Map<string, Record<string, any>>(),
    ]);

    // Build a map of draft number → NetSuite SO for quick lookup
    const memoToSO = new Map<string, any>();
    for (const so of netsuiteSOs.orders) {
      const memo = so.memo?.trim();
      if (memo && /^#D\d+$/.test(memo)) {
        memoToSO.set(memo, so);
      }
    }

    // Also look up NetSuite memo drafts in Shopify (for ones not in the date-range fetch)
    const nsMemoDrafts = netsuiteSOs.orders
      .map((so: any) => so.memo?.trim())
      .filter((m: string) => m && /^#D\d+$/.test(m));
    const shopifyByName = shopifyConfigured()
      ? await lookupDraftsByName(nsMemoDrafts)
      : new Map<string, Record<string, any>>();

    // Merge: shopifyDraftsMap has date-range drafts, shopifyByName has name-lookups
    for (const [name, data] of shopifyByName) {
      if (!shopifyDraftsMap.has(name)) {
        shopifyDraftsMap.set(name, data);
      }
    }

    const records: ReconRecord[] = [];
    const matchedDrafts = new Set<string>();

    // 1) From NetSuite SOs: match to Shopify drafts
    for (const so of netsuiteSOs.orders) {
      const memo = so.memo?.trim() || null;
      const isDraftMemo = memo && /^#D\d+$/.test(memo);
      const draft = isDraftMemo ? shopifyDraftsMap.get(memo!) : undefined;

      if (isDraftMemo && draft) matchedDrafts.add(memo!);

      records.push({
        netsuite_so: so.so_number,
        netsuite_memo: memo,
        netsuite_customer: so.customer || null,
        netsuite_amount: so.total_amount || null,
        netsuite_date: so.trandate || null,
        netsuite_location: so.location || null,
        netsuite_shopify_so: so.shopify_so || null,
        shopify_draft: draft?.draft_number || null,
        shopify_customer: draft?.customer || null,
        shopify_amount: draft?.total_price || null,
        shopify_order: draft?.shopify_order || null,
        shopify_created: draft?.created_at || null,
        status: !isDraftMemo ? 'no_memo' : draft ? 'matched' : 'missing_in_shopify',
      });
    }

    // 2) From Shopify drafts: find ones with NO matching NetSuite SO
    for (const [draftName, draft] of shopifyDraftsMap) {
      if (matchedDrafts.has(draftName)) continue;
      if (memoToSO.has(draftName)) continue;

      records.push({
        netsuite_so: null,
        netsuite_memo: null,
        netsuite_customer: null,
        netsuite_amount: null,
        netsuite_date: null,
        netsuite_location: null,
        netsuite_shopify_so: null,
        shopify_draft: draft.draft_number,
        shopify_customer: draft.customer || null,
        shopify_amount: draft.total_price || null,
        shopify_order: draft.shopify_order || null,
        shopify_created: draft.created_at || null,
        status: 'missing_in_netsuite',
      });
    }

    // Sort: missing_in_netsuite first (alerts), then missing_in_shopify, no_memo, matched
    const order: Record<string, number> = { missing_in_netsuite: 0, missing_in_shopify: 1, no_memo: 2, matched: 3 };
    records.sort((a, b) => order[a.status] - order[b.status]);

    const matched = records.filter(r => r.status === 'matched').length;
    const missingInNetsuite = records.filter(r => r.status === 'missing_in_netsuite').length;
    const missingInShopify = records.filter(r => r.status === 'missing_in_shopify').length;
    const noMemo = records.filter(r => r.status === 'no_memo').length;

    res.json({
      records,
      summary: {
        total: records.length,
        matched,
        missing_in_netsuite: missingInNetsuite,
        missing_in_shopify: missingInShopify,
        no_memo: noMemo,
        netsuite_sos: netsuiteSOs.orders.length,
        shopify_drafts: shopifyDraftsMap.size,
      },
    });
  } catch (err: any) {
    console.error('reconciliation error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reconciliation/sync-status — background sync state (unmatched drafts, last sync, etc.)
router.get('/sync-status', async (_req: Request, res: Response) => {
  try {
    const state = getReconSyncState();
    res.json(state);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reconciliation/sync — manually trigger a sync
router.post('/sync', async (_req: Request, res: Response) => {
  try {
    const state = await runReconSync();
    res.json(state);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/reconciliation/test-alert — send a test recon notification
router.post('/test-alert', async (req: Request, res: Response) => {
  try {
    const results: Record<string, any> = {};
    const DASHBOARD_URL = 'https://integration-dashboard-erdxhhczasejb4hj.westus3-01.azurewebsites.net';

    // Use a sample draft for the test (or override via query params)
    const testDraft = (req.query.draft as string) || '#D99999';
    const testCustomer = (req.query.customer as string) || 'Test Customer';
    const testAmount = (req.query.amount as string) || '1,250';

    // Teams — same card format as real alerts
    if (isTeamsEnabled()) {
      const channels = getNotificationChannels();
      const webhookUrl = channels.teams.webhookUrl || process.env.TEAMS_WEBHOOK_URL || '';
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
                text: `**${testDraft}** has no match in NetSuite Sales Order. Please check in Team Central if there is an error.`,
                wrap: true,
                size: 'Default',
                spacing: 'Medium',
              },
              {
                type: 'FactSet',
                spacing: 'Medium',
                facts: [
                  { title: 'Draft #', value: testDraft },
                  { title: 'Customer', value: testCustomer },
                  { title: 'Amount', value: `$${testAmount}` },
                  { title: 'Created', value: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Manila' }) + ' PHT' },
                  { title: 'Unmatched For', value: '15 minutes' },
                ],
              },
              {
                type: 'TextBlock',
                text: '⚠️ This is a TEST alert',
                color: 'Warning',
                weight: 'Bolder',
                spacing: 'Medium',
              },
              {
                type: 'TextBlock',
                text: '<at>Larry Patacsil</at>',
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
        const teamsRes = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(card),
        });
        results.teams = teamsRes.ok ? 'sent' : `failed (${teamsRes.status})`;
      } catch (err: any) {
        results.teams = `error: ${err.message}`;
      }
    } else {
      results.teams = 'not configured';
    }

    // Email
    if (isEmailEnabled()) {
      try {
        const nowPht = new Date().toLocaleString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric',
          hour: 'numeric', minute: '2-digit', hour12: true,
          timeZone: 'Asia/Manila',
        }) + ' PHT';
        const subject = `🔴 ${testDraft} has no match in NetSuite Sales Order (TEST)`;
        const plainBody = `${testDraft} has no match in NetSuite Sales Order.\nPlease check in Team Central if there is an error.\n\nDraft #: ${testDraft}\nCustomer: ${testCustomer}\nAmount: $${testAmount}\nDetected At: ${nowPht}\nUnmatched For: 15 minutes\n\nThis is a TEST alert.`;
        const html = buildAlertHtml({
          type: 'unmatched',
          headline: 'Unmatched Draft Order',
          description: 'An integration issue has been detected that may require investigation.',
          facts: [
            { label: 'Error Type', value: 'Unmatched NetSuite Sales Order' },
            { label: 'Reference', value: testDraft },
            { label: 'Customer', value: testCustomer },
            { label: 'Amount', value: `$${testAmount}.00` },
            { label: 'Detected At', value: nowPht },
            { label: 'Unresolved For', value: '15 minutes' },
          ],
          footer: '⚠️ This is a TEST alert &bull; Automated Notification &bull; NetSuite Integration Monitoring',
        });
        const sent = await sendAlertEmail(['Larry'], [], subject, plainBody, html);
        results.email = sent ? 'sent' : 'failed';
      } catch (err: any) {
        results.email = `error: ${err.message}`;
      }
    } else {
      results.email = 'not configured';
    }

    res.json({ message: 'Test alert sent', results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
