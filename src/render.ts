import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { OpenScaffoldError } from "./errors.js";
import { TEMPLATE_VARS } from "./schema/index.js";
import type { FileOp } from "./types.js";

/** A `{{var}}` / `{{ var }}` placeholder; the capture is the variable name. */
export const TEMPLATE_TOKEN = /\{\{\s*([^}]*?)\s*\}\}/g;

/** Names of placeholders in `text` that aren't template variables, in order of appearance. */
export function unknownTemplateVars(text: string): string[] {
  return [...text.matchAll(TEMPLATE_TOKEN)]
    .map(([, name]) => name ?? "")
    .filter((name) => !TEMPLATE_VARS.includes(name));
}

/** Replace {{var}} / {{ var }} placeholders. Unknown variables are an error naming the file. */
export function renderTemplate(text: string, vars: Record<string, string>, file: string): string {
  return text.replace(TEMPLATE_TOKEN, (_whole, name: string) => {
    const value = TEMPLATE_VARS.includes(name) ? vars[name] : undefined;
    if (value === undefined) {
      throw new OpenScaffoldError(
        "template_unknown_var",
        `${file} uses unknown template variable {{${name}}}`,
        `Available variables: ${TEMPLATE_VARS.join(", ")}. Only files ending in .tmpl are rendered; rename the file to drop .tmpl if the braces are meant literally.`,
      );
    }
    return value;
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Deep-merge `b` into `a`: objects merge recursively, arrays concatenate with duplicates
 * (by JSON equality) removed, anything else takes `b`.
 */
export function deepMerge(a: unknown, b: unknown): unknown {
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = k in out ? deepMerge(out[k], v) : v;
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const seen = new Set<string>();
    const out: unknown[] = [];
    for (const item of [...a, ...b]) {
      const key = JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }
  return b;
}

export interface RenderOptions {
  /**
   * When a destination already exists, write openscaffold's version under this directory
   * (same relative path) instead, so the agent can reconcile the two. Used by `add`.
   */
  incomingDir?: string;
}

export interface RenderResult {
  /** Destinations written, relative to the project root, in plan order. */
  written: string[];
  /** Destinations that already existed and were left untouched. */
  skipped: string[];
}

function contents(op: FileOp, vars: Record<string, string>): Buffer {
  const raw = readFileSync(op.src);
  if (!op.template) return raw;
  return Buffer.from(renderTemplate(raw.toString("utf8"), vars, op.src));
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * Whether `rel` can be written under `root` without touching anything that's already there:
 * false when any path component exists as a symlink (dangling or not) or the final path exists.
 * A component that exists as a non-directory also counts as occupied.
 */
function isFree(root: string, rel: string): boolean {
  const parts = rel.split("/");
  let path = root;
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch {
      return true;
    }
    if (st.isSymbolicLink()) return false;
    if (i === parts.length - 1 || !st.isDirectory()) return false;
  }
  return true;
}

/**
 * Whether `root/rel` can be (re)written as a regular file: no path component is a symlink, every
 * component before the last is a directory (or missing), and the last is missing or a regular
 * file. Used for the incoming dir, where replacing an earlier run's parked file is expected.
 */
function isReplaceable(root: string, rel: string): boolean {
  const parts = rel.split("/");
  let path = root;
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch {
      return true;
    }
    if (st.isSymbolicLink()) return false;
    if (i === parts.length - 1) return st.isFile();
    if (!st.isDirectory()) return false;
  }
  return true;
}

/** realpath of `path`, or of its nearest existing ancestor when it doesn't exist yet. */
function realExisting(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : realExisting(parent);
  }
}

/**
 * Throw unless writing `path` would land inside `projectDir`: its directory must resolve inside
 * the project and `path` itself must not be a symlink. `projectDir` need not exist yet.
 */
export function assertInsideProject(projectDir: string, path: string): void {
  let link = false;
  try {
    link = lstatSync(path).isSymbolicLink();
  } catch {
    // Doesn't exist yet: only its directory matters.
  }
  if (!link && isInside(realExisting(projectDir), realExisting(dirname(path)))) return;
  throw new OpenScaffoldError(
    "render_outside_project",
    `refusing to write ${path}: it resolves outside ${projectDir}`,
    "The file, or a directory on the way, is a symlink to somewhere else. Remove it or rerun in a clean directory.",
  );
}

/** Write `path`, refusing to land anywhere outside `projectDir` (e.g. via a symlink). */
function writeOut(projectDir: string, path: string, data: Buffer | string, mode?: number): void {
  assertInsideProject(projectDir, path);
  mkdirSync(dirname(path), { recursive: true });
  assertInsideProject(projectDir, path);
  writeFileSync(path, data);
  if (mode !== undefined) chmodSync(path, mode);
}

/** Reject destinations that could escape the project: absolute paths and `..` segments. */
function checkDest(dest: string, owner: string): void {
  if (isAbsolute(dest) || /^[a-zA-Z]:/.test(dest) || dest.split(/[\\/]/).includes("..")) {
    throw new OpenScaffoldError(
      "render_bad_dest",
      `${owner} wants to write ${dest}, which is outside the project`,
      "Destinations must be relative paths without .. segments.",
    );
  }
}

interface Rendered {
  dest: string;
  data: Buffer | string;
  mode?: number;
}

export interface RenderPlan extends RenderResult {
  /** Write every planned file. Every check already passed when the plan was made. */
  apply: () => void;
}

/**
 * Work out what writing a plan's files into `projectDir` would do, without touching the disk.
 * Non-template files are copied byte for byte with their permission bits (hooks stay
 * executable); `.tmpl` sources are rendered; merge groups are rendered, parsed as JSON, and
 * deep-merged in plan order. Existing files are never overwritten, and nothing is written
 * through a symlink: a destination with a symlink anywhere on its path counts as existing. With
 * `incomingDir`, an existing destination's version is parked there instead, replacing a file an
 * earlier run parked at the same path. Rendering and every path check happen here, so a
 * template, JSON, or path error leaves the project untouched. `projectDir` need not exist yet.
 */
export function planRender(
  files: FileOp[],
  projectDir: string,
  vars: Record<string, string>,
  opts: RenderOptions = {},
): RenderPlan {
  const groups = new Map<string, FileOp[]>();
  for (const op of files) groups.set(op.dest, [...(groups.get(op.dest) ?? []), op]);

  const rendered: Rendered[] = [];
  for (const [dest, ops] of groups) {
    const first = ops[0] as FileOp;
    checkDest(dest, first.owner);
    if (ops.length > 1) {
      let merged: unknown = {};
      for (const op of ops) {
        const text = contents(op, vars).toString("utf8");
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          throw new OpenScaffoldError(
            "merge_invalid_json",
            `${op.src} is declared under merge for ${dest}, but isn't valid JSON: ${(err as Error).message}`,
            `Fix the JSON in ${op.owner}, or run \`openscaffold validate\` on it.`,
          );
        }
        merged = deepMerge(merged, parsed);
      }
      rendered.push({ dest, data: `${JSON.stringify(merged, null, 2)}\n` });
    } else {
      rendered.push({
        dest,
        data: contents(first, vars),
        mode: statSync(first.src).mode & 0o777,
      });
    }
  }

  const written: string[] = [];
  const skipped: string[] = [];
  const writes: { path: string; data: Buffer | string; mode?: number }[] = [];
  for (const { dest, data, mode } of rendered) {
    if (isFree(projectDir, dest)) {
      written.push(dest);
      writes.push({ path: join(projectDir, dest), data, mode });
      continue;
    }
    skipped.push(dest);
    if (!opts.incomingDir) continue;
    if (!isReplaceable(opts.incomingDir, dest)) {
      throw new OpenScaffoldError(
        "render_incoming_blocked",
        `can't write ${join(opts.incomingDir, dest)}: it isn't a regular file or a directory on the way is a symlink`,
        `Remove ${opts.incomingDir} and rerun.`,
      );
    }
    writes.push({ path: join(opts.incomingDir, dest), data, mode });
  }
  for (const w of writes) assertInsideProject(projectDir, w.path);

  return {
    written,
    skipped,
    apply: () => {
      for (const w of writes) writeOut(projectDir, w.path, w.data, w.mode);
    },
  };
}

/** Plan (see planRender) and write a plan's files into `projectDir`. */
export function renderFiles(
  files: FileOp[],
  projectDir: string,
  vars: Record<string, string>,
  opts: RenderOptions = {},
): RenderResult {
  const { written, skipped, apply } = planRender(files, projectDir, vars, opts);
  apply();
  return { written, skipped };
}
