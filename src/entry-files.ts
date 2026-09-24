import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";
import { OpenScaffoldError } from "./errors.js";
import type { AgentId } from "./schema/index.js";

const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db"]);

/** One file an entry ships, before ownership resolution. */
export interface EntryFile {
  /** Absolute source path. */
  src: string;
  /** Destination relative to the project root, .tmpl stripped, always "/"-separated. */
  dest: string;
  template: boolean;
  /** Set when the file comes from adapters/<agent>/. */
  agent?: AgentId;
}

function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Regular files under `dir`, sorted. Symlinks are never followed (a registry entry could point
 * one at ~/.ssh or at `..`); each one found, including `dir` itself, is pushed to `symlinks`.
 */
function walk(dir: string, symlinks: string[]): string[] {
  const st = lstatOrUndefined(dir);
  if (!st) return [];
  if (st.isSymbolicLink()) {
    symlinks.push(dir);
    return [];
  }
  if (!st.isDirectory()) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (IGNORED_FILES.has(name)) continue;
    const path = join(dir, name);
    const child = lstatSync(path);
    if (child.isSymbolicLink()) symlinks.push(path);
    else if (child.isDirectory()) out.push(...walk(path, symlinks));
    else out.push(path);
  }
  return out;
}

function toEntryFile(base: string, src: string, agent?: AgentId): EntryFile {
  const rel = relative(base, src).split(sep).join("/");
  const template = rel.endsWith(".tmpl");
  return { src, dest: template ? rel.slice(0, -".tmpl".length) : rel, template, agent };
}

/** Every symlink under an entry's files/ and adapters/ (including those directories themselves). */
export function entrySymlinks(entryDir: string): string[] {
  const symlinks: string[] = [];
  walk(join(entryDir, "files"), symlinks);
  walk(join(entryDir, "adapters"), symlinks);
  return symlinks;
}

/**
 * Files an entry would write: files/ for everyone plus adapters/<agent>/ for each target agent.
 * Throws when the entry ships a symlink.
 */
export function listEntryFiles(entryDir: string, agents: readonly AgentId[]): EntryFile[] {
  const symlinks = entrySymlinks(entryDir);
  if (symlinks.length) {
    throw new OpenScaffoldError(
      "entry_symlink",
      `${symlinks[0]} is a symlink; stacks and fragments can't ship symlinks`,
      "Replace it with a regular file or directory. openscaffold never follows symlinks in an entry, so it can't copy files from outside it.",
    );
  }
  const filesDir = join(entryDir, "files");
  const out = walk(filesDir, symlinks).map((src) => toEntryFile(filesDir, src));
  for (const agent of agents) {
    const adapterDir = join(entryDir, "adapters", agent);
    out.push(...walk(adapterDir, symlinks).map((src) => toEntryFile(adapterDir, src, agent)));
  }
  return out;
}
