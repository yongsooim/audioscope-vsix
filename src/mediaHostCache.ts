import * as vscode from 'vscode';
import type {
  DecodeFallbackPayload,
  LoudnessSummaryPayload,
  MediaMetadataPayload,
} from './externalAudioTools';

class WeightedLruCache<T> {
  private readonly entries = new Map<string, { value: T; weight: number }>();
  private totalWeight = 0;

  public constructor(
    private readonly maxEntries: number,
    private readonly maxWeight = Number.POSITIVE_INFINITY,
  ) {}

  public get(key: string): T | undefined {
    const existing = this.entries.get(key);

    if (!existing) {
      return undefined;
    }

    this.entries.delete(key);
    this.entries.set(key, existing);
    return existing.value;
  }

  public set(key: string, value: T, weight = 1): void {
    const existing = this.entries.get(key);

    if (existing) {
      this.totalWeight -= existing.weight;
      this.entries.delete(key);
    }

    this.entries.set(key, {
      value,
      weight,
    });
    this.totalWeight += weight;
    this.prune();
  }

  private prune(): void {
    while (
      this.entries.size > this.maxEntries
      || this.totalWeight > this.maxWeight
    ) {
      const oldestKey = this.entries.keys().next().value;

      if (typeof oldestKey !== 'string') {
        return;
      }

      const oldestEntry = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);

      if (oldestEntry) {
        this.totalWeight = Math.max(0, this.totalWeight - oldestEntry.weight);
      }
    }
  }
}

const sourceBytesCache = new WeightedLruCache<ArrayBuffer>(8, 128 * 1024 * 1024);
const metadataCache = new WeightedLruCache<MediaMetadataPayload>(32);
const loudnessCache = new WeightedLruCache<LoudnessSummaryPayload>(32);
const decodeFallbackCache = new WeightedLruCache<DecodeFallbackPayload>(4, 256 * 1024 * 1024);

const pendingSourceBytesLoads = new Map<string, Promise<ArrayBuffer>>();
const pendingMetadataLoads = new Map<string, Promise<MediaMetadataPayload>>();
const pendingLoudnessLoads = new Map<string, Promise<LoudnessSummaryPayload>>();
const pendingDecodeFallbackLoads = new Map<string, Promise<DecodeFallbackPayload>>();

function getExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function getDecodeFallbackWeight(payload: DecodeFallbackPayload): number {
  if (payload.kind === 'wav') {
    return Math.max(1, payload.byteLength || payload.audioBuffer.byteLength || 0);
  }

  return Math.max(
    1,
    payload.byteLength
      || payload.channelBuffers.reduce((total, buffer) => total + buffer.byteLength, 0),
  );
}

async function getResourceRevisionKey(resource: vscode.Uri): Promise<string> {
  try {
    const stat = await vscode.workspace.fs.stat(resource);
    return `${resource.toString()}::${stat.mtime}::${stat.size}`;
  } catch {
    return `${resource.toString()}::missing`;
  }
}

async function getOrLoadCached<T>(
  key: string,
  cache: WeightedLruCache<T>,
  pendingLoads: Map<string, Promise<T>>,
  load: () => Promise<T>,
  getWeight?: (value: T) => number,
): Promise<T> {
  const cached = cache.get(key);

  if (cached !== undefined) {
    return cached;
  }

  const pending = pendingLoads.get(key);

  if (pending) {
    return pending;
  }

  const nextLoad = load()
    .then((value) => {
      cache.set(key, value, getWeight?.(value) ?? 1);
      pendingLoads.delete(key);
      return value;
    })
    .catch((error) => {
      pendingLoads.delete(key);
      throw error;
    });

  pendingLoads.set(key, nextLoad);
  return nextLoad;
}

export async function getCachedSourceAudioBytes(resource: vscode.Uri): Promise<ArrayBuffer> {
  const cacheKey = await getResourceRevisionKey(resource);

  return getOrLoadCached(
    cacheKey,
    sourceBytesCache,
    pendingSourceBytesLoads,
    async () => {
      const bytes = await vscode.workspace.fs.readFile(resource);
      return getExactArrayBuffer(bytes);
    },
    (buffer) => Math.max(1, buffer.byteLength),
  );
}

export async function getCachedMediaMetadata(
  resource: vscode.Uri,
  load: () => Promise<MediaMetadataPayload>,
): Promise<MediaMetadataPayload> {
  const cacheKey = await getResourceRevisionKey(resource);

  return getOrLoadCached(
    cacheKey,
    metadataCache,
    pendingMetadataLoads,
    load,
  );
}

export async function getCachedLoudnessSummary(
  resource: vscode.Uri,
  load: () => Promise<LoudnessSummaryPayload>,
): Promise<LoudnessSummaryPayload> {
  const cacheKey = await getResourceRevisionKey(resource);

  return getOrLoadCached(
    cacheKey,
    loudnessCache,
    pendingLoudnessLoads,
    load,
  );
}

export async function getCachedDecodeFallback(
  resource: vscode.Uri,
  load: () => Promise<DecodeFallbackPayload>,
): Promise<DecodeFallbackPayload> {
  const cacheKey = await getResourceRevisionKey(resource);

  return getOrLoadCached(
    cacheKey,
    decodeFallbackCache,
    pendingDecodeFallbackLoads,
    load,
    getDecodeFallbackWeight,
  );
}
