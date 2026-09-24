import { BlobServiceClient, ContainerClient, RestError } from '@azure/storage-blob';
import { DefaultAzureCredential } from '@azure/identity';

const CONTAINER_NAME = process.env.AZURE_STORAGE_CONTAINER || 'teamcentral-logs';

function createServiceClient(): BlobServiceClient {
  const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
  if (connectionString) {
    // Local dev (Azurite) or key-based fallback
    return BlobServiceClient.fromConnectionString(connectionString);
  }

  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  if (!accountName) {
    throw new Error('Set AZURE_STORAGE_ACCOUNT_NAME (managed identity) or AZURE_STORAGE_CONNECTION_STRING (local/Azurite)');
  }
  return new BlobServiceClient(
    `https://${accountName}.blob.core.windows.net`,
    new DefaultAzureCredential(),
  );
}

let containerClient: ContainerClient | null = null;
function getContainer(): ContainerClient {
  if (!containerClient) {
    containerClient = createServiceClient().getContainerClient(CONTAINER_NAME);
  }
  return containerClient;
}

export async function ensureContainer(): Promise<void> {
  await getContainer().createIfNotExists();
}

/** Deletes every blob in the container. Used by the seed script to reset local/dev data. */
export async function clearContainer(): Promise<number> {
  const container = getContainer();
  let count = 0;
  for await (const blob of container.listBlobsFlat()) {
    await container.getBlockBlobClient(blob.name).deleteIfExists();
    count++;
  }
  cache.clear();
  return count;
}

async function streamToString(readable: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export interface ReadResult<T> {
  data: T | null;
  etag: string | null;
}

/** Read and parse a JSON blob. Returns { data: null, etag: null } if it doesn't exist. */
export async function readJson<T>(path: string): Promise<ReadResult<T>> {
  const blob = getContainer().getBlockBlobClient(path);
  try {
    const download = await blob.download();
    const text = await streamToString(download.readableStreamBody!);
    return { data: JSON.parse(text) as T, etag: download.etag ?? null };
  } catch (err) {
    if (err instanceof RestError && err.statusCode === 404) {
      return { data: null, etag: null };
    }
    throw err;
  }
}

/**
 * Write a JSON blob. If `expectedEtag` is provided, the write fails (throws with
 * statusCode 412) unless the blob still matches that etag — used for optimistic
 * concurrency on read-modify-write blobs like alert-incidents/open.json.
 */
export async function writeJson(path: string, data: unknown, expectedEtag?: string | null): Promise<void> {
  const blob = getContainer().getBlockBlobClient(path);
  const body = JSON.stringify(data);
  const options = expectedEtag
    ? { conditions: { ifMatch: expectedEtag } }
    : expectedEtag === null
      ? { conditions: { ifNoneMatch: '*' } } // must not already exist
      : {};
  try {
    await blob.upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: 'application/json' },
      ...options,
    });
  } catch (err) {
    // First write to a fresh storage account/container — create it and retry once.
    if (err instanceof RestError && err.code === 'ContainerNotFound') {
      await ensureContainer();
      await blob.upload(body, Buffer.byteLength(body), {
        blobHTTPHeaders: { blobContentType: 'application/json' },
        ...options,
      });
      return;
    }
    throw err;
  }
}

/**
 * Read-modify-write a JSON blob with optimistic concurrency retry.
 * `mutate` receives the current value (or `fallback` if the blob doesn't exist yet)
 * and returns the new value to write.
 */
export async function updateJson<T>(
  path: string,
  fallback: T,
  mutate: (current: T) => T,
  maxRetries = 5,
): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { data, etag } = await readJson<T>(path);
    const current = data ?? fallback;
    const next = mutate(current);
    try {
      await writeJson(path, next, etag ?? null);
      return next;
    } catch (err) {
      if (err instanceof RestError && (err.statusCode === 412 || err.statusCode === 409)) {
        continue; // lost the race, retry
      }
      throw err;
    }
  }
  throw new Error(`updateJson: exceeded ${maxRetries} retries for ${path}`);
}

// ── Day-blob TTL cache ───────────────────────────────────────────────────────
// Past days are immutable once the day rolls over, so caching avoids re-fetching
// the same 14-28 day-files on every dashboard refresh. Today's file is cached
// briefly since it can still be written to.

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: any; expiresAt: number }>();

function isToday(dayKey: string): boolean {
  return dayKey === new Date().toISOString().slice(0, 10);
}

export async function readJsonCached<T>(path: string, dayKey: string): Promise<T | null> {
  const cached = cache.get(path);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value as T;
  }
  const { data } = await readJson<T>(path);
  const ttl = isToday(dayKey) ? 5_000 : CACHE_TTL_MS;
  cache.set(path, { value: data, expiresAt: Date.now() + ttl });
  return data;
}

export function invalidateCache(path: string): void {
  cache.delete(path);
}
