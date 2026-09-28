/**
 * Settings store backed by Azure Blob Storage.
 *
 * Loads from `settings/config.json` on startup, falls back to hardcoded
 * defaults from config.ts, and caches in memory for fast reads.
 */

import { readJson, writeJson } from '../store/blob-client';
import {
  CONTACTS as DEFAULT_CONTACTS,
  CATEGORY_RULES as DEFAULT_CATEGORY_RULES,
  RULES as DEFAULT_RULES,
} from '../config';

export interface SettingsData {
  contacts: Record<string, { name: string; email: string }>;
  categoryRules: Array<{ code: string; group: string; label: string; match: string }>;
  rules: {
    severity: {
      blockingGroups: string[];
      sev4: { enabled: boolean; heartbeatMaxMinutes: number; zeroTrafficWindowMinutes: number; useBaseline: boolean };
      sev3: { minBlocked: number; olderThan: string };
      sev2: { minBlocked: number };
      sev1: { minBlocked: number };
    };
    thresholds: Record<string, number>;
    escalation: Record<number, { notify: string[]; cc: string[]; renotifyMinutes: number }>;
  };
  notificationChannels: {
    email: {
      enabled: boolean;
      smtp: { host: string; port: number; user: string; password: string; from: string };
    };
    teams: {
      enabled: boolean;
      webhookUrl: string;
    };
  };
}

const BLOB_PATH = 'settings/config.json';

function buildDefaults(): SettingsData {
  return {
    contacts: { ...DEFAULT_CONTACTS },
    categoryRules: DEFAULT_CATEGORY_RULES.map(r => ({ ...r })),
    rules: JSON.parse(JSON.stringify(DEFAULT_RULES)),
    notificationChannels: {
      email: {
        enabled: !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS),
        smtp: {
          host: process.env.SMTP_HOST || '',
          port: parseInt(process.env.SMTP_PORT || '587', 10),
          user: process.env.SMTP_USER || '',
          password: process.env.SMTP_PASS || '',
          from: process.env.SMTP_FROM || process.env.SMTP_USER || '',
        },
      },
      teams: {
        enabled: !!(process.env.TEAMS_WEBHOOK_URL),
        webhookUrl: process.env.TEAMS_WEBHOOK_URL || '',
      },
    },
  };
}

let cache: SettingsData | null = null;

/** Load settings from blob storage at startup. Falls back to hardcoded defaults. */
export async function loadSettings(): Promise<void> {
  try {
    const { data } = await readJson<SettingsData>(BLOB_PATH);
    if (data) {
      // Merge with defaults to fill any missing keys from older saved configs
      const defaults = buildDefaults();
      cache = {
        contacts: data.contacts ?? defaults.contacts,
        categoryRules: data.categoryRules ?? defaults.categoryRules,
        rules: data.rules ?? defaults.rules,
        notificationChannels: data.notificationChannels ?? defaults.notificationChannels,
      };
      console.log('Settings loaded from blob storage');
      return;
    }
  } catch (err) {
    console.warn('Could not load settings from blob, using defaults:', err);
  }
  cache = buildDefaults();
  console.log('Settings initialized from defaults');
}

function getCache(): SettingsData {
  if (!cache) cache = buildDefaults();
  return cache;
}

/** Save a full or partial settings update to blob storage + update cache. */
export async function saveSettings(patch: Partial<SettingsData>): Promise<SettingsData> {
  const current = getCache();
  const next: SettingsData = {
    contacts: patch.contacts ?? current.contacts,
    categoryRules: patch.categoryRules ?? current.categoryRules,
    rules: patch.rules ?? current.rules,
    notificationChannels: patch.notificationChannels ?? current.notificationChannels,
  };
  await writeJson(BLOB_PATH, next);
  cache = next;
  return next;
}

// ── Getter functions used by the rest of the codebase ────────────────────────

export function getContacts(): Record<string, { name: string; email: string }> {
  return getCache().contacts;
}

export function getCategoryRules(): Array<{ code: string; group: string; label: string; match: string }> {
  return getCache().categoryRules;
}

export function getRules(): SettingsData['rules'] {
  return getCache().rules;
}

export function getNotificationChannels(): SettingsData['notificationChannels'] {
  return getCache().notificationChannels;
}

export function getFullSettings(): SettingsData {
  return getCache();
}
