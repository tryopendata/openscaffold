import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OpenScaffoldError } from "./errors.js";
import { TEMPLATE_VARS } from "./schema/index.js";
import type { FileOp } from "./types.js";

const TEMPLATE_TOKEN = /\{\{\s*([^}]*?)\s*\}\}/g;

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

function writeOut(path: string, data: Buffer | string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  if (mode !== undefined) chmodSync(path, mode);
}

/**
 * Write a plan's files into `projectDir`. Non-template files are copied byte for byte with
 * their permission bits (hooks stay executable); `.tmpl` sources are rendered; merge groups are
 * rendered, parsed as JSON, and deep-merged in plan order. Existing files are never overwritten.
 */
export function renderFiles(
  files: FileOp[],
  projectDir: string,
  vars: Record<string, string>,
  opts: RenderOptions = {},
): RenderResult {
  const written: string[] = [];
  const skipped: string[] = [];
  const groups = new Map<string, FileOp[]>();
  for (const op of files) groups.set(op.dest, [...(groups.get(op.dest) ?? []), op]);

  for (const [dest, ops] of groups) {
    let data: Buffer | string;
    let mode: number | undefined;
    const first = ops[0] as FileOp;
    if (ops.length > 1 || first.merge) {
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
      data = `${JSON.stringify(merged, null, 2)}\n`;
    } else {
      data = contents(first, vars);
      mode = statSync(first.src).mode & 0o777;
    }

    const target = join(projectDir, dest);
    if (existsSync(target)) {
      skipped.push(dest);
      if (opts.incomingDir) writeOut(join(opts.incomingDir, dest), data, mode);
      continue;
    }
    writeOut(target, data, mode);
    written.push(dest);
  }
  return { written, skipped };
}
