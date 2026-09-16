export const FLOWS: Record<string, { name: string; dir: string }> = {
  S2N: { name: 'Shopify → NetSuite', dir: 'Orders · customers · payments' },
  N2S: { name: 'NetSuite → Shopify', dir: 'Draft orders · fulfillments · inventory' },
  IDX: { name: 'Indexing', dir: 'Customer · item · ship-to · location' },
  NS:  { name: 'NetSuite internal', dir: 'Vertex · inventory · validation' },
};

export const CATEGORY_RULES = [
  { code: 'MAP-CUST',   group: 'MAPPING',   label: 'Customer not mapped / indexed',           match: 'customer.*(not (found|mapped)|missing)|enter a value for.*entity|Entity Id.*invalid' },
  { code: 'MAP-ITEM',   group: 'MAPPING',   label: 'Item / SKU not mapped',                   match: '(item|sku).*(not (found|mapped)|invalid)|choose an item|at least one line item|Invalid Field Value.*item|sub-resource field \'item\'' },
  { code: 'MAP-SHIP',   group: 'MAPPING',   label: 'Ship-to address not mapped',              match: '(ship.?to|address).*(not (found|mapped)|invalid)|Ship To Select' },
  { code: 'MAP-LOC',    group: 'MAPPING',   label: 'Location / store not mapped',             match: '(location|store|shop).*(not (found|mapped))' },
  { code: 'IDX-SKIP',   group: 'INDEXING',  label: 'Record skipped by indexing',              match: 'skipped|no index|not indexed' },
  { code: 'TAX-VERTEX', group: 'NETSUITE',  label: 'Vertex tax calculation failed',           match: 'vertex|tax (calc|service)' },
  { code: 'INV-ITEM',   group: 'NETSUITE',  label: 'Inventory item not recognized / short',   match: 'inventory|insufficient|not recognized' },
  { code: 'NS-PERM',    group: 'NETSUITE',  label: 'Permission / role error',                 match: 'permission|role|insufficient privilege' },
  { code: 'VAL-DATA',   group: 'NETSUITE',  label: 'Validation / missing required field',     match: 'INVALID_VALUE|FIELD_PARAM_REQD|unable to parse|Integer field|fulfilled.*delete|otherrefnum|maximum number|required|validation' },
  { code: 'API-RATE',   group: 'TRANSIENT', label: 'Rate limit / timeout (auto-retry)',       match: 'rate limit|429|timeout|timed out|Request Failed|UNEXPECTED_ERROR|Record has been changed|someone.*saving|Primary.?Key|NONEXISTENT_ID' },
  { code: 'DUP',        group: 'TRANSIENT', label: 'Duplicate record suppressed',             match: 'duplicate|already exists' },
  { code: 'CONN-DOWN',  group: 'OUTAGE',    label: 'Connector heartbeat missing',             match: 'heartbeat|connector offline' },
];

export const CONTACTS: Record<string, { name: string; email: string }> = {
  Larry:    { name: 'Larry Patacsil',    email: 'lpatacsil@bulkequip.com' },
  Quennie:  { name: 'Quennie Barrameda', email: 'qbarrameda@bulkequip.com' },
  Olga:     { name: 'Olga Corbett',      email: 'ocorbett@bulkequip.com' },
  Estevan:  { name: 'Estevan Lima',      email: 'elima@bulkequip.com' },
  Matt:     { name: 'Matthew Ispas',     email: 'mispas@bulkequip.com' },
};

export const RULES = {
  severity: {
    blockingGroups: ['MAPPING', 'INDEXING'],
    sev4: { heartbeatMaxMinutes: 30, zeroTrafficWindowMinutes: 60, useBaseline: true },
    sev3: { minBlocked: 2, olderThan: 'startOfToday' },
    sev2: { minBlocked: 2 },
    sev1: { minBlocked: 1 },
  },
  thresholds: {
    'S2N.errors': 5, 'N2S.errors': 5, 'S2N.rerun': 10, 'IDX.failed': 3,
    'NS.TAX-VERTEX': 3, 'NS.INV-ITEM': 5, 'NS.VAL-DATA': 10,
    'pending.unresolvedHours': 4,
  } as Record<string, number>,
  escalation: {
    1: { notify: ['Larry', 'Quennie'], cc: ['Estevan'], renotifyMinutes: 240 },
    2: { notify: ['Larry', 'Quennie'], cc: ['Estevan'], renotifyMinutes: 240 },
    3: { notify: ['Larry', 'Quennie', 'Estevan'], cc: ['Matt', 'Olga'], renotifyMinutes: 120 },
    4: { notify: ['Larry', 'Quennie', 'Estevan', 'Matt', 'Olga'], cc: ['TeamCentral support'], renotifyMinutes: 30 },
  } as Record<number, { notify: string[]; cc: string[]; renotifyMinutes: number }>,
};
