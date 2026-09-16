<script setup lang="ts">
import type { Rules, CategoryRule } from '../types'

defineProps<{
  rules: Rules | null
  categoryRules: CategoryRule[]
}>()

function catTagClass(c: CategoryRule): string {
  if (c.group === 'MAPPING' || c.group === 'INDEXING') return 'block'
  if (c.group === 'OUTAGE') return 'down'
  return ''
}
</script>

<template>
  <section class="panel on">
    <div class="rulegrid">
      <div>
        <div class="section-title">Severity ladder <span class="hint">evaluated every refresh, per flow and overall</span></div>
        <div class="card prose">
          <p>Severity is driven by <strong>integration-blocking</strong> errors only — the ones where a data object is not mapped or was skipped by indexing (customer, item / SKU, ship-to, location / store). Other NetSuite errors (Vertex, inventory, validation) are tracked on the NetSuite internal log tab with their own thresholds and do not move the severity ladder unless a threshold is crossed.</p>
          <div class="steps">
            <div class="step"><span class="k">SEV 0</span><span>No open blocking errors. Connector heartbeat fresh, transactions flowing both ways.</span></div>
            <div class="step"><span class="k">SEV 1</span><span><strong>Exactly one</strong> transaction blocked by a mapping / indexing gap.</span></div>
            <div class="step"><span class="k">SEV 2</span><span><strong>More than one</strong> transaction blocked by mapping / indexing, all opened today.</span></div>
            <div class="step"><span class="k">SEV 3</span><span>More than one blocked <strong>and</strong> the oldest one has crossed into the next business day (opened before 00:00 today, still unresolved).</span></div>
            <div class="step"><span class="k">SEV 4</span><span><strong>Tool down.</strong> Connector heartbeat older than 30 min, <em>or</em> zero transactions in the last 60 min during hours when the 4-week baseline says we normally see traffic.</span></div>
          </div>
          <p style="margin-top:12px">Severity is <strong>never lowered automatically</strong> while an incident is open — it only steps down when the blocking errors are resolved or re-run successfully.</p>
        </div>

        <div class="section-title" style="margin-top:18px">Escalation matrix</div>
        <div class="card tablewrap">
          <table class="matrix">
            <thead><tr><th>Level</th><th>Hotline (act)</th><th>Copied</th><th>Re-notify while open</th></tr></thead>
            <tbody>
              <tr><td>Sev 1</td><td class="who">Larry, Quennie</td><td class="who">Estevan (manager)</td><td>Every 4 h</td></tr>
              <tr><td>Sev 2</td><td class="who">Larry, Quennie</td><td class="who">Estevan (manager)</td><td>Every 4 h</td></tr>
              <tr><td>Sev 3</td><td class="who">Larry, Quennie, Estevan</td><td class="who">Matt, Olga</td><td>Every 2 h</td></tr>
              <tr><td>Sev 4</td><td class="who">Larry, Quennie, Estevan, Matt, Olga</td><td class="who">TeamCentral support</td><td>Every 30 min</td></tr>
            </tbody>
          </table>
        </div>

        <div class="section-title" style="margin-top:18px">Alert de-duplication</div>
        <div class="card prose">
          <p>One incident = one open alert keyed on <code>flow + category + entityRef</code>. An email goes out when the incident is first opened, again only when its severity level <strong>changes</strong>, on the re-notify cadence above while it stays open, and once when it resolves. A dashboard refresh never re-sends.</p>
        </div>
      </div>

      <div>
        <div class="section-title">Error category codes</div>
        <div class="card tablewrap">
          <table>
            <thead><tr><th>Code</th><th>Meaning</th><th>Group</th><th>Detected when message matches</th></tr></thead>
            <tbody>
              <tr v-for="c in categoryRules" :key="c.code">
                <td><span class="cat" :class="catTagClass(c)">{{ c.code }}</span></td>
                <td>{{ c.label }}</td>
                <td class="muted">{{ c.group }}</td>
                <td><code>/{{ c.match }}/i</code></td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="section-title" style="margin-top:18px">Rule syntax <span class="hint">what Larry implements — JSON config the dashboard reads</span></div>
        <pre>{{ rules ? JSON.stringify(rules, null, 2) : '' }}</pre>

        <div class="section-title">Classifier pseudo-code</div>
        <pre>function classify(openBlocking, heartbeatAgeMin, txLast60, baselineLast60) {
  if (heartbeatAgeMin > 30 || (txLast60 === 0 &amp;&amp; baselineLast60 > 0)) return 4;
  const n = openBlocking.length;
  if (n === 0) return 0;
  const crossedDay = openBlocking.some(e => e.openedAt &lt; startOfToday());
  if (n > 1 &amp;&amp; crossedDay) return 3;
  if (n > 1) return 2;
  return 1;
}

// category = first CATEGORY_RULES entry whose regex matches the raw error text
// blocking  = category.group === "MAPPING" || category.group === "INDEXING"</pre>

        <div class="section-title">NetSuite saved-search formula <span class="hint">same logic, if built in NetSuite</span></div>
        <pre>-- Formula (Text) on the integration log custom record
CASE
  WHEN REGEXP_LIKE({custrecord_tc_error}, 'customer.*(not (found|mapped)|missing)', 'i') THEN 'MAP-CUST'
  WHEN REGEXP_LIKE({custrecord_tc_error}, '(item|sku).*(not (found|mapped)|invalid)', 'i')  THEN 'MAP-ITEM'
  WHEN REGEXP_LIKE({custrecord_tc_error}, '(ship.?to|address).*(not (found|mapped)|invalid)', 'i') THEN 'MAP-SHIP'
  WHEN REGEXP_LIKE({custrecord_tc_error}, '(location|store|shop).*(not (found|mapped))', 'i') THEN 'MAP-LOC'
  WHEN REGEXP_LIKE({custrecord_tc_error}, 'skipped|no index|not indexed', 'i')             THEN 'IDX-SKIP'
  WHEN REGEXP_LIKE({custrecord_tc_error}, 'vertex|tax (calc|service)', 'i')                THEN 'TAX-VERTEX'
  WHEN REGEXP_LIKE({custrecord_tc_error}, 'inventory|insufficient|not recognized', 'i')    THEN 'INV-ITEM'
  WHEN REGEXP_LIKE({custrecord_tc_error}, 'permission|role|insufficient privilege', 'i')  THEN 'NS-PERM'
  WHEN REGEXP_LIKE({custrecord_tc_error}, 'rate limit|429|timeout|timed out', 'i')         THEN 'API-RATE'
  WHEN REGEXP_LIKE({custrecord_tc_error}, 'duplicate|already exists', 'i')                 THEN 'DUP'
  ELSE 'VAL-DATA'
END</pre>
      </div>
    </div>
  </section>
</template>
