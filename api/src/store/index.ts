import { createBlobStore } from './blob-store';
import type { Store } from './types';

let instance: Store | null = null;

/**
 * Backend is chosen here so a future postgres-store.ts (wrapping the dormant
 * SQL in ../db.ts) can be swapped in via STORE_BACKEND without touching routes.
 */
export function getStore(): Store {
  if (!instance) {
    const backend = process.env.STORE_BACKEND || 'blob';
    if (backend !== 'blob') {
      throw new Error(`Unknown STORE_BACKEND "${backend}" (only "blob" is implemented)`);
    }
    instance = createBlobStore();
  }
  return instance;
}

export * from './types';
