import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ZodError } from "zod";
import { parseConditionals } from "../conditionals.js";
import { listEntryFiles } from "../entry-files.js";
import { OpenScaffoldError } from "../errors.js";
import { parseFrontmatter } from "../frontmatter.js";
import { unknownTemplateVars } from "../render.js";
import { AGENTS, FragmentMetaSchema, SCHEMA_VERSION, StackMetaSchema } from "../schema/index.js";
import type { Entry, Origin } from "../types.js";

export type EntryKind = "stack" | "fragment";

export const KIND_DIR: Record<EntryKind, string> = { stack: "stacks", fragment: "fragments" };
export const KIND_FILE: Record<EntryKind, string> = { stack: "STACK.md", fragment: "FRAGMENT.md" };

/** Why an entry on disk could not be loaded. */
export interface ScanProblem {
  kind: EntryKind;
  /** Directory name (the id the entry was supposed to have). */
  id: string;
  /** Absolute path of the offending file or directory. */
  file: string;
  reason: "missing_file" | "invalid" | "newer_schema" | "id_mismatch";
  message: string;
  /** For newer_schema: the version found. */
  schemaVersion?: number;
}

export interface ScanResult {
  entries: Entry[];
  problems: ScanProblem[];
}

export function formatZodIssues(err: ZodError): string {
  return err.issues
    .map((i) => `${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Read and validate one entry directory. Returns the entry or the reason it was rejected. */
export function readEntry(
  dir: string,
  kind: EntryKind,
  origin: Origin,
): { entry: Entry } | { problem: ScanProblem } {
  const dirName = basename(dir);
  const file = join(dir, KIND_FILE[kind]);
  const problem = (reason: ScanProblem["reason"], message: string, extra = {}) => ({
    problem: { kind, id: dirName, file, reason, message, ...extra },
  });

  if (!existsSync(file)) {
    return problem("missing_file", `${dir} has no ${KIND_FILE[kind]}`);
  }

  let data: unknown;
  let body: string;
  try {
    ({ data, body } = parseFrontmatter(readFileSync(file, "utf8"), file));
  } catch (err) {
    if (err instanceof OpenScaffoldError) return problem("invalid", err.message);
    throw err;
  }

  // Gate on schema_version before the strict schema: a newer schema may add fields we'd reject.
  const version = (data as { schema_version?: unknown } | null)?.schema_version;
  if (typeof version === "number" && version > SCHEMA_VERSION) {
    return problem(
      "newer_schema",
      `${file} uses schema_version ${version}, newer than this openscaffold supports (${SCHEMA_VERSION})`,
      { schemaVersion: version },
    );
  }

  const schema = kind === "stack" ? StackMetaSchema : FragmentMetaSchema;
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return problem("invalid", `${file} is invalid: ${formatZodIssues(parsed.error)}`);
  }
  const meta = parsed.data;
  if (meta.id !== dirName) {
    return problem(
      "id_mismatch",
      `${file} has id "${meta.id}" but lives in a directory named "${dirName}"; they must match`,
    );
  }

  return {
    entry: { kind, id: meta.id, meta, body, dir, origin, trusted: true, shadows: [] } as Entry,
  };
}

/** Why an entry's files can't be rendered (symlinks, unknown template vars), or undefined. */
function checkEntryFiles(dir: string): string | undefined {
  let files: ReturnType<typeof listEntryFiles>;
  try {
    files = listEntryFiles(dir, AGENTS);
  } catch (err) {
    if (err instanceof OpenScaffoldError) return err.message;
    throw err;
  }
  for (const f of files) {
    if (!f.template) continue;
    const [unknown] = unknownTemplateVars(readFileSync(f.src, "utf8"));
    if (unknown !== undefined) return `${f.src} uses unknown template variable {{${unknown}}}`;
  }
  return undefined;
}

/** Why an entry body's conditional markers can't be applied, or undefined. */
function checkConditionals(entry: Entry): string | undefined {
  const { errors } = parseConditionals(entry.body);
  if (errors.length === 0) return undefined;
  return `${join(entry.dir, KIND_FILE[entry.kind])} has malformed conditional markers: ${errors.join("; ")}`;
}

/** List entry directories of one kind under a registry root (sorted, hidden dirs skipped). */
export function entryDirs(root: string, kind: EntryKind): string[] {
  const base = join(root, KIND_DIR[kind]);
  if (!isDir(base)) return [];
  return readdirSync(base)
    .filter((name) => !name.startsWith(".") && isDir(join(base, name)))
    .sort()
    .map((name) => join(base, name));
}

/** Load every stack and fragment under a registry root (a dir with stacks/ and/or fragments/). */
export function scanRoot(root: string, origin: Origin): ScanResult {
  const result: ScanResult = { entries: [], problems: [] };
  for (const kind of ["stack", "fragment"] as const) {
    for (const dir of entryDirs(root, kind)) {
      const r = readEntry(dir, kind, origin);
      if (!("entry" in r)) {
        result.problems.push(r.problem);
        continue;
      }
      // Registry entries are fetched over the network and may target a newer CLI: check their
      // files and conditional markers now so a bad one is skipped in favor of the bundled copy
      // instead of failing later.
      const fileProblem =
        origin === "registry" ? (checkEntryFiles(dir) ?? checkConditionals(r.entry)) : undefined;
      if (fileProblem) {
        result.problems.push({
          kind,
          id: r.entry.id,
          file: join(dir, KIND_FILE[kind]),
          reason: "invalid",
          message: fileProblem,
        });
      } else {
        result.entries.push(r.entry);
      }
    }
  }
  return result;
}
