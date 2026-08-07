import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type {
  DecodeLoudnessPipelinePayload,
  DecodeFallbackPayload,
  LoudnessSummaryPayload,
  MediaMetadataPayload,
} from './externalAudioTools';

// Below this size we hash the file contents into the cache key so a rewrite that
// keeps the same mtime + size (coarse-mtime filesystems, `touch -d`, some
// virtual FS) still invalidates the cache. Larger files fall back to mtime+size:
// reading them just to hash would defeat the purpose of the cache.
const CONTENT_HASH_MAX_BYTES = 8 * 1024 * 1024;

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

    this.entries.set(key, { value, weight });
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

interface ResourceCacheOptions<T> {
  maxEntries: number;
  maxWeight?: number;
  getWeight?: (value: T) => number;
}

class ResourceCache<T> {
  private readonly cache: WeightedLruCache<T>;
  private readonly pending = new Map<string, Promise<T>>();
  private readonly getWeight: ((value: T) => number) | undefined;

  public constructor(options: ResourceCacheOptions<T>) {
    this.cache = new WeightedLruCache<T>(options.maxEntries, options.maxWeight);
    this.getWeight = options.getWeight;
  }

  public async get(
    resource: vscode.Uri,
    load: () => Promise<T>,
    revisionKeyPromise?: Promise<string>,
  ): Promise<T> {
    const key = await (revisionKeyPromise ?? createResourceRevision(resource).getKey());
    const cached = this.cache.get(key);

    if (cached !== undefined) {
      return cached;
    }

    const inflight = this.pending.get(key);

    if (inflight) {
      return inflight;
    }

    const next = load()
      .then((value) => {
        this.cache.set(key, value, this.getWeight?.(value) ?? 1);
        this.pending.delete(key);
        return value;
      })
      .catch((error) => {
        this.pending.delete(key);
        throw error;
      });

    this.pending.set(key, next);
    return next;
  }
}

export interface ResourceRevision {
  getFileSize(): Promise<number | null>;
  getKey(): Promise<string>;
}

export function createResourceRevision(resource: vscode.Uri): ResourceRevision {
  let statPromise: Promise<vscode.FileStat | null> | null = null;
  let keyPromise: Promise<string> | null = null;

  const getStat = (): Promise<vscode.FileStat | null> => {
    if (!statPromise) {
      statPromise = Promise.resolve(vscode.workspace.fs.stat(resource)).catch(() => null);
    }
    return statPromise;
  };

  return {
    async getFileSize(): Promise<number | null> {
      return (await getStat())?.size ?? null;
    },
    getKey(): Promise<string> {
      keyPromise ??= getResourceRevisionKey(resource, getStat());
      return keyPromise;
    },
  };
}

async function getResourceRevisionKey(
  resource: vscode.Uri,
  statPromise: Promise<vscode.FileStat | null>,
): Promise<string> {
  const stat = await statPromise;

  if (stat) {
    const base = `${resource.toString()}::${stat.mtime}::${stat.size}`;

    if (stat.size > 0 && stat.size <= CONTENT_HASH_MAX_BYTES) {
      try {
        const bytes = await vscode.workspace.fs.readFile(resource);
        const hash = createHash('sha1').update(bytes).digest('hex');
        return `${base}::${hash}`;
      } catch {
        return base;
      }
    }

    return base;
  }

  return `${resource.toString()}::missing`;
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

function getDecodeLoudnessPipelineWeight(payload: DecodeLoudnessPipelinePayload): number {
  return getDecodeFallbackWeight(payload.decode);
}

const metadataCache = new ResourceCache<MediaMetadataPayload>({ maxEntries: 32 });
const loudnessCache = new ResourceCache<LoudnessSummaryPayload>({ maxEntries: 32 });
const decodeLoudnessPipelineCache = new ResourceCache<DecodeLoudnessPipelinePayload>({
  maxEntries: 4,
  maxWeight: 256 * 1024 * 1024,
  getWeight: getDecodeLoudnessPipelineWeight,
});

export async function getCachedMediaMetadata(
  resource: vscode.Uri,
  load: () => Promise<MediaMetadataPayload>,
  revisionKeyPromise?: Promise<string>,
): Promise<MediaMetadataPayload> {
  return metadataCache.get(resource, load, revisionKeyPromise);
}

export async function getCachedLoudnessSummary(
  resource: vscode.Uri,
  load: () => Promise<LoudnessSummaryPayload>,
  revisionKeyPromise?: Promise<string>,
): Promise<LoudnessSummaryPayload> {
  return loudnessCache.get(resource, load, revisionKeyPromise);
}

export async function getCachedDecodeLoudnessPipeline(
  resource: vscode.Uri,
  load: () => Promise<DecodeLoudnessPipelinePayload>,
  revisionKeyPromise?: Promise<string>,
): Promise<DecodeLoudnessPipelinePayload> {
  return decodeLoudnessPipelineCache.get(resource, load, revisionKeyPromise);
}
