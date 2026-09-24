import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_REGISTRY_SOURCE = "gh:tryopendata/openscaffold/registry#main";
export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed fetch, don't retry for this long (keeps offline machines fast). */
export const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
/** After a 404 (the source doesn't exist, or isn't published yet), wait much longer. */
export const NOT_FOUND_BACKOFF_MS = 24 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 15_000;

export type FetchRemote = (source: string, destDir: string) => Promise<void>;

interface Stamp {
  source: string;
  fetchedAt?: number;
  failedAt?: number;
  /** The last failure was a 404: the source doesn't exist. */
  notFound?: boolean;
}

export interface RemoteOptions {
  home: string;
  source: string;
  offline: boolean;
  fetchRemote?: FetchRemote;
  now: () => number;
}

export interface RemoteResult {
  /** Registry root to scan, or undefined when there's nothing usable. */
  root?: string;
  warnings: string[];
}

export function registryCacheDir(home: string): string {
  return join(home, ".openscaffold", "cache", "registry");
}

function stampPath(home: string): string {
  return join(home, ".openscaffold", "cache", "registry.stamp.json");
}

function readStamp(home: string): Stamp | undefined {
  try {
    return JSON.parse(readFileSync(stampPath(home), "utf8")) as Stamp;
  } catch {
    return undefined;
  }
}

function writeStamp(home: string, stamp: Stamp): void {
  mkdirSync(dirname(stampPath(home)), { recursive: true });
  writeFileSync(stampPath(home), `${JSON.stringify(stamp)}\n`);
}

const gigetFetch: FetchRemote = async (source, destDir) => {
  // Imported lazily so offline and cached runs don't pay for loading giget.
  const { downloadTemplate } = await import("giget");
  await downloadTemplate(source, { dir: destDir, force: true, silent: true });
};

/**
 * Race `promise` against a timer. giget takes no AbortSignal, so a timed-out download keeps
 * running in the background; the timer is unref'd so it never holds the process open itself.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** giget reports HTTP failures as "Failed to download <url>: 404 Not Found". */
function isNotFound(err: unknown): boolean {
  return /:\s*404\b/.test((err as Error)?.message ?? "");
}

const TMP_PREFIX = "registry.tmp-";

/**
 * Remove download dirs left behind by earlier runs (a timed-out download can't be aborted, so it
 * may still be writing when we give up on it). Only dirs older than the fetch timeout are removed,
 * so a concurrent run's download in progress is left alone.
 */
function sweepStaleDownloads(parent: string, now: number): void {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(TMP_PREFIX)) continue;
    const path = join(parent, name);
    try {
      if (now - statSync(path).mtimeMs > 2 * FETCH_TIMEOUT_MS) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Raced with another run's cleanup; nothing to do.
    }
  }
}

function age(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 48) return `${Math.floor(hours / 24)} days old`;
  if (hours >= 1) return `${hours}h old`;
  return "less than an hour old";
}

/**
 * Make sure the main registry cache is present and fresh enough. Never throws: failures turn
 * into warnings and fall back to a stale cache or to nothing (bundled entries still apply).
 */
export async function ensureRemoteRegistry(opts: RemoteOptions): Promise<RemoteResult> {
  const cache = registryCacheDir(opts.home);
  const stamp = readStamp(opts.home);
  const sameSource = stamp?.source === opts.source;
  // The cache only counts when it was fetched from the configured source.
  const hasCache = existsSync(cache) && sameSource && stamp?.fetchedAt !== undefined;
  const staleSourceWarning =
    existsSync(cache) && !hasCache
      ? [
          `the cached registry wasn't fetched from the configured source ${opts.source}, so it isn't used. Using bundled entries only until ${opts.source} can be fetched.`,
        ]
      : [];
  const now = opts.now();

  const fresh = hasCache && now - (stamp?.fetchedAt ?? 0) < REGISTRY_TTL_MS;
  if (fresh) return { root: cache, warnings: [] };
  if (opts.offline) return { root: hasCache ? cache : undefined, warnings: staleSourceWarning };

  const backoff = stamp?.notFound ? NOT_FOUND_BACKOFF_MS : FAILURE_BACKOFF_MS;
  const backingOff = sameSource && stamp?.failedAt !== undefined && now - stamp.failedAt < backoff;
  if (backingOff) return { root: hasCache ? cache : undefined, warnings: [] };

  const parent = dirname(cache);
  let tmp: string | undefined;
  try {
    mkdirSync(parent, { recursive: true });
    sweepStaleDownloads(parent, Date.now());
    tmp = mkdtempSync(join(parent, TMP_PREFIX));
    await withTimeout((opts.fetchRemote ?? gigetFetch)(opts.source, tmp), FETCH_TIMEOUT_MS);
    if (!existsSync(join(tmp, "stacks")) && !existsSync(join(tmp, "fragments"))) {
      throw new Error("the download has no stacks/ or fragments/ directory");
    }
    rmSync(cache, { recursive: true, force: true });
    renameSync(tmp, cache);
    writeStamp(opts.home, { source: opts.source, fetchedAt: now });
    return { root: cache, warnings: [] };
  } catch (err) {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    const notFound = isNotFound(err);
    writeStamp(opts.home, {
      source: opts.source,
      // Keep the record of a good cache from this source; a cache from another source stays unusable.
      fetchedAt: hasCache ? stamp?.fetchedAt : undefined,
      failedAt: now,
      ...(notFound ? { notFound: true } : {}),
    });
    const reason = notFound
      ? `${opts.source} doesn't exist or the registry isn't published there yet (HTTP 404); openscaffold won't retry for 24h`
      : (err as Error).message;
    const offlineHint = "Set OPENSCAFFOLD_OFFLINE=1 to skip the fetch.";
    if (hasCache) {
      const when = stamp?.fetchedAt ? ` (${age(now - stamp.fetchedAt)})` : "";
      return {
        root: cache,
        warnings: [
          `couldn't refresh the registry from ${opts.source}: ${reason}. Using the cached copy${when}. ${offlineHint}`,
        ],
      };
    }
    return {
      warnings: [
        `couldn't fetch the registry from ${opts.source}: ${reason}. Using bundled entries only. ${offlineHint}`,
      ],
    };
  }
}
