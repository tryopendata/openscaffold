import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_REGISTRY_SOURCE = "gh:tryopendata/openscaffold/registry#main";
export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed fetch, don't retry for this long (keeps offline machines fast). */
export const FAILURE_BACKOFF_MS = 10 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 15_000;

export type FetchRemote = (source: string, destDir: string) => Promise<void>;

interface Stamp {
  source: string;
  fetchedAt?: number;
  failedAt?: number;
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

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  const hasCache = existsSync(cache);
  const stamp = readStamp(opts.home);
  const sameSource = stamp?.source === opts.source;
  const now = opts.now();

  const fresh =
    hasCache &&
    sameSource &&
    stamp?.fetchedAt !== undefined &&
    now - stamp.fetchedAt < REGISTRY_TTL_MS;
  if (fresh || opts.offline) return { root: hasCache ? cache : undefined, warnings: [] };

  const backingOff =
    sameSource && stamp?.failedAt !== undefined && now - stamp.failedAt < FAILURE_BACKOFF_MS;
  if (backingOff) return { root: hasCache ? cache : undefined, warnings: [] };

  const tmp = `${cache}.tmp-${process.pid}-${now}`;
  try {
    mkdirSync(dirname(cache), { recursive: true });
    await withTimeout((opts.fetchRemote ?? gigetFetch)(opts.source, tmp), FETCH_TIMEOUT_MS);
    if (!existsSync(join(tmp, "stacks")) && !existsSync(join(tmp, "fragments"))) {
      throw new Error("the download has no stacks/ or fragments/ directory");
    }
    rmSync(cache, { recursive: true, force: true });
    renameSync(tmp, cache);
    writeStamp(opts.home, { source: opts.source, fetchedAt: now });
    return { root: cache, warnings: [] };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    writeStamp(opts.home, {
      source: opts.source,
      fetchedAt: sameSource ? stamp?.fetchedAt : undefined,
      failedAt: now,
    });
    const reason = (err as Error).message;
    const offlineHint = "Set OPENSCAFFOLD_OFFLINE=1 to skip the fetch.";
    if (hasCache) {
      const when = sameSource && stamp?.fetchedAt ? ` (${age(now - stamp.fetchedAt)})` : "";
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
