import { homedir } from "node:os";
import { relative, resolve } from "node:path";
import { loadUserConfig } from "../config.js";
import { OpenScaffoldError } from "../errors.js";
import type { Entry, FragmentEntry, Origin, StackEntry } from "../types.js";
import { BUNDLED_REGISTRY } from "../version.js";
import { DEFAULT_REGISTRY_SOURCE, ensureRemoteRegistry, type FetchRemote } from "./remote.js";
import { type EntryKind, type ScanProblem, scanRoot } from "./scan.js";

export { DEFAULT_REGISTRY_SOURCE, type FetchRemote, registryCacheDir } from "./remote.js";
export {
  type EntryKind,
  entryDirs,
  formatZodIssues,
  isDir,
  KIND_DIR,
  KIND_FILE,
  readEntry,
  type ScanProblem,
  scanRoot,
} from "./scan.js";

export interface OriginRoot {
  origin: Origin;
  root: string;
}

const UPDATE_HINT = "Update openscaffold (npx openscaffold@latest, or npm i -g openscaffold).";

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j] ?? 0;
      row[j] = Math.min(
        (row[j] ?? 0) + 1,
        (row[j - 1] ?? 0) + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return row[b.length] ?? 0;
}

/** Ids that look like `id`: substring matches or within a small edit distance. */
export function closeMatches(id: string, candidates: string[]): string[] {
  return candidates
    .map((c) => ({ c, d: c.includes(id) || id.includes(c) ? 0 : levenshtein(id, c) }))
    .filter(({ d }) => d <= Math.max(2, Math.floor(id.length / 3)))
    .sort((x, y) => x.d - y.d || x.c.localeCompare(y.c))
    .slice(0, 3)
    .map(({ c }) => c);
}

export class Registry {
  private readonly byKind: Record<EntryKind, Map<string, Entry>> = {
    stack: new Map(),
    fragment: new Map(),
  };

  constructor(
    entries: Entry[],
    public readonly warnings: string[] = [],
  ) {
    for (const e of entries) this.byKind[e.kind].set(e.id, e);
  }

  get(kind: "stack", id: string): StackEntry | undefined;
  get(kind: "fragment", id: string): FragmentEntry | undefined;
  get(kind: EntryKind, id: string): Entry | undefined;
  get(kind: EntryKind, id: string): Entry | undefined {
    return this.byKind[kind].get(id);
  }

  /** Every winning entry, stacks first, then by id. */
  list(kind?: EntryKind): Entry[] {
    const kinds: EntryKind[] = kind ? [kind] : ["stack", "fragment"];
    return kinds.flatMap((k) =>
      [...this.byKind[k].values()].sort((a, b) => a.id.localeCompare(b.id)),
    );
  }

  stack(id: string): StackEntry {
    return this.require("stack", id) as StackEntry;
  }

  fragment(id: string): FragmentEntry {
    return this.require("fragment", id) as FragmentEntry;
  }

  /** Look up an id of either kind (show). */
  find(id: string): Entry {
    const found = this.get("stack", id) ?? this.get("fragment", id);
    if (found) return found;
    throw this.notFound("stack or fragment", id, [
      ...this.byKind.stack.keys(),
      ...this.byKind.fragment.keys(),
    ]);
  }

  private require(kind: EntryKind, id: string): Entry {
    const found = this.get(kind, id);
    if (found) return found;
    const other: EntryKind = kind === "stack" ? "fragment" : "stack";
    if (this.get(other, id)) {
      throw new OpenScaffoldError(
        `${kind}_not_found`,
        `"${id}" is a ${other}, not a ${kind}`,
        kind === "stack"
          ? `Pick a stack from \`openscaffold list --kind stack\`, and add "${id}" with --with ${id}.`
          : `Run \`openscaffold new ${id}\` to use it as a stack.`,
      );
    }
    throw this.notFound(kind, id, [...this.byKind[kind].keys()]);
  }

  private notFound(what: string, id: string, candidates: string[]): OpenScaffoldError {
    const close = closeMatches(id, candidates);
    const suggestion = close.length
      ? `Did you mean ${close.map((c) => `"${c}"`).join(", ")}? `
      : "";
    return new OpenScaffoldError(
      "not_found",
      `no ${what} named "${id}"`,
      `${suggestion}Run \`openscaffold list\` to see what's available.`,
    );
  }
}

function displayPath(dir: string, origin: Origin, cwd: string): string {
  if (origin === "project") return `./${relative(cwd, dir)}`;
  return dir;
}

/**
 * Merge origin roots (highest precedence first) into a Registry. Invalid entries are skipped
 * with a warning, or thrown when `strict` is set.
 */
export function buildRegistry(
  roots: OriginRoot[],
  opts: { cwd?: string; strict?: boolean; warnings?: string[] } = {},
): Registry {
  const cwd = opts.cwd ?? process.cwd();
  const warnings = [...(opts.warnings ?? [])];
  const winners: Record<EntryKind, Map<string, Entry>> = { stack: new Map(), fragment: new Map() };
  const problems: ScanProblem[] = [];

  for (const { origin, root } of roots) {
    const scanned = scanRoot(root, origin);
    problems.push(...scanned.problems);
    for (const entry of scanned.entries) {
      const existing = winners[entry.kind].get(entry.id);
      if (existing) existing.shadows.push(origin);
      else winners[entry.kind].set(entry.id, entry);
    }
  }

  if (opts.strict && problems.length) {
    throw new OpenScaffoldError(
      "registry_invalid",
      problems.map((p) => p.message).join("\n"),
      "Fix the listed entries; `openscaffold validate <path>` gives details.",
    );
  }

  for (const p of problems) {
    const fallback = winners[p.kind].get(p.id);
    const using = fallback
      ? `using the ${fallback.origin} copy instead`
      : `no other copy of ${p.kind} "${p.id}" is available`;
    if (p.reason === "newer_schema") warnings.push(`${p.message}; ${using}. ${UPDATE_HINT}`);
    else warnings.push(`skipped ${p.kind} "${p.id}": ${p.message}; ${using}`);
  }

  for (const kind of ["stack", "fragment"] as const) {
    for (const entry of winners[kind].values()) {
      if (entry.origin !== "project") continue;
      const shadowed = entry.shadows.find((o) => o === "registry" || o === "bundled");
      if (!shadowed) continue;
      // A cloned repo can ship ./.openscaffold overrides of well-known ids, so they don't get
      // the trust (e.g. agent auto-launch) the reviewed copy would.
      entry.trusted = false;
      warnings.push(
        `${displayPath(entry.dir, entry.origin, cwd)} shadows the ${shadowed} ${entry.id}; a cloned repo can ship this, so check it's yours. It's treated as untrusted, so no agent is auto-launched`,
      );
    }
  }

  return new Registry([...winners.stack.values(), ...winners.fragment.values()], warnings);
}

export interface LoadRegistryOptions {
  cwd: string;
  home?: string;
  offline?: boolean;
  bundledDir?: string;
  registrySource?: string;
  fetchRemote?: FetchRemote;
  now?: () => number;
  /** Throw on invalid entries instead of skipping them with a warning. */
  strict?: boolean;
}

/** Resolve stacks and fragments from project, user, main registry, and bundled origins. */
export async function loadRegistry(opts: LoadRegistryOptions): Promise<Registry> {
  const home = opts.home ?? homedir();
  const offline = opts.offline ?? process.env.OPENSCAFFOLD_OFFLINE === "1";
  const source = opts.registrySource ?? loadUserConfig(home).registry ?? DEFAULT_REGISTRY_SOURCE;

  const remote = await ensureRemoteRegistry({
    home,
    source,
    offline,
    fetchRemote: opts.fetchRemote,
    now: opts.now ?? Date.now,
  });

  const projectRoot = resolve(opts.cwd, ".openscaffold");
  const userRoot = resolve(home, ".openscaffold");
  const roots: OriginRoot[] = [];
  if (projectRoot !== userRoot) roots.push({ origin: "project", root: projectRoot });
  roots.push({ origin: "user", root: userRoot });
  if (remote.root) roots.push({ origin: "registry", root: remote.root });
  roots.push({ origin: "bundled", root: opts.bundledDir ?? BUNDLED_REGISTRY });

  return buildRegistry(roots, { cwd: opts.cwd, strict: opts.strict, warnings: remote.warnings });
}
