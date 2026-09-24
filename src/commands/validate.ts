import { existsSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { Command } from "commander";
import { compose } from "../compose.js";
import { parseConditionals } from "../conditionals.js";
import { entrySymlinks, listEntryFiles } from "../entry-files.js";
import { OpenScaffoldError } from "../errors.js";
import { printJson, println } from "../output.js";
import {
  buildRegistry,
  type EntryKind,
  entryDirs,
  isDir,
  KIND_FILE,
  Registry,
  readEntry,
  type ScanProblem,
} from "../registry/index.js";
import { TEMPLATE_TOKEN, unknownTemplateVars } from "../render.js";
import { AGENTS, TEMPLATE_VARS } from "../schema/index.js";
import type { Entry, FragmentEntry, StackEntry } from "../types.js";
import { BUNDLED_REGISTRY } from "../version.js";

export interface Finding {
  /** Path relative to the validated directory (or absolute when outside it). */
  file: string;
  message: string;
}

export interface ValidationReport {
  ok: boolean;
  path: string;
  stacks: number;
  fragments: number;
  errors: Finding[];
  warnings: Finding[];
}

/** Filenames whose schema changes between tool releases; they belong in prose, not files/. */
const VERSION_SENSITIVE: RegExp[] = [
  /^\.golangci\.ya?ml$/,
  /^tsconfig.*\.json$/,
  /^vitest\.config\./,
  /^vite\.config\./,
  /^pyproject\.toml$/,
  /^astro\.config\./,
  /^package\.json$/,
  /^Dockerfile/,
  /^playwright\.config\./,
  /^orval\.config\./,
  /^biome\.jsonc?$/,
  /^eslint\.config\./,
  /^\.goreleaser\.ya?ml$/,
  /^go\.mod$/,
  /^Cargo\.toml$/,
  /^docker-compose.*\.ya?ml$/,
  /^compose.*\.ya?ml$/,
];

export function isVersionSensitive(dest: string): boolean {
  if (/(^|\/)\.github\/workflows\//.test(dest)) return true;
  const name = dest.split("/").pop() ?? dest;
  return VERSION_SENSITIVE.some((re) => re.test(name));
}

/**
 * Stand-in values for rendering templates before the merge JSON check, shaped like real values
 * (so `{{year}}` outside quotes is still valid JSON).
 */
const SAMPLE_VARS: Record<string, string> = {
  project_name: "example",
  project_slug: "example",
  package_scope: "example",
  author: "example",
  year: "2026",
};

interface Target {
  /** Registry root containing the entries (for single-entry validation, the entry dirs' grandparent). */
  entries: { dir: string; kind: EntryKind }[];
  label: string;
}

function resolveTarget(path: string): Target {
  if (!isDir(path)) {
    throw new OpenScaffoldError(
      "validate_path",
      `${path} is not a directory`,
      "Pass a registry root (containing stacks/ or fragments/) or a single stack/fragment directory.",
    );
  }
  for (const kind of ["stack", "fragment"] as const) {
    if (existsSync(resolve(path, KIND_FILE[kind]))) {
      return { entries: [{ dir: path, kind }], label: path };
    }
  }
  if (isDir(resolve(path, "stacks")) || isDir(resolve(path, "fragments"))) {
    return {
      entries: (["stack", "fragment"] as const).flatMap((kind) =>
        entryDirs(path, kind).map((dir) => ({ dir, kind })),
      ),
      label: path,
    };
  }
  throw new OpenScaffoldError(
    "validate_path",
    `${path} has no STACK.md, FRAGMENT.md, stacks/, or fragments/`,
    "Pass a registry root (containing stacks/ or fragments/) or a single stack/fragment directory.",
  );
}

/** Validate a registry root or single entry directory. Never throws for content problems. */
export function validatePath(path: string, opts: { bundledDir?: string } = {}): ValidationReport {
  const root = resolve(path);
  const target = resolveTarget(root);
  const bundledDir = resolve(opts.bundledDir ?? BUNDLED_REGISTRY);
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const rel = (file: string) => {
    const r = relative(root, file);
    return r === "" ? basename(file) : r.startsWith("..") ? file : r.split(sep).join("/");
  };
  const error = (file: string, message: string) => errors.push({ file: rel(file), message });
  const warning = (file: string, message: string) => warnings.push({ file: rel(file), message });

  // 1. Schema, id == dir name, schema_version.
  const valid: Entry[] = [];
  for (const { dir, kind } of target.entries) {
    const r = readEntry(dir, kind, "registry");
    if ("entry" in r) valid.push(r.entry);
    else error(r.problem.file, problemMessage(r.problem));
  }
  const stacks = valid.filter((e): e is StackEntry => e.kind === "stack");
  const fragments = valid.filter((e): e is FragmentEntry => e.kind === "fragment");

  // 2. Stack/fragment id collisions (within the validated set).
  const fragmentIds = new Set(fragments.map((f) => f.id));
  for (const s of stacks) {
    if (fragmentIds.has(s.id)) {
      error(
        entryFile(s),
        `"${s.id}" is both a stack and a fragment; ids must be unique across kinds`,
      );
    }
  }

  // Registry for reference checks and dry runs: validated entries, falling back to bundled.
  const bundled =
    bundledDir === root ? [] : buildRegistry([{ origin: "bundled", root: bundledDir }]).list();
  const registry = new Registry([...bundled, ...valid]);
  const knownFragment = (id: string) => registry.get("fragment", id) !== undefined;

  // 3. References resolve.
  const checkRefs = (entry: Entry, field: string, ids: string[]) => {
    for (const id of ids) {
      if (knownFragment(id)) continue;
      const hint = registry.get("stack", id) ? ` ("${id}" is a stack, not a fragment)` : "";
      error(entryFile(entry), `${field} references unknown fragment "${id}"${hint}`);
    }
  };
  for (const s of stacks) {
    checkRefs(s, "fragments.default", s.meta.fragments.default);
    checkRefs(s, "fragments.optional", s.meta.fragments.optional);
  }
  for (const f of fragments) {
    checkRefs(f, "requires", f.meta.requires);
    checkRefs(f, "conflicts", f.meta.conflicts);
  }

  // 4. Body conditionals, then files: symlinks, templates, merge JSON, version-sensitive names.
  const withSymlinks = new Set<string>();
  for (const entry of valid) {
    for (const message of parseConditionals(entry.body).errors) {
      error(entryFile(entry), `conditional block: ${message}`);
    }
    const symlinks = entrySymlinks(entry.dir);
    for (const link of symlinks) {
      error(link, "is a symlink; entries can't ship symlinks, use a regular file or directory");
    }
    if (symlinks.length) {
      withSymlinks.add(entry.id);
      continue;
    }
    const files = listEntryFiles(entry.dir, AGENTS);
    for (const f of files) {
      if (f.template) {
        for (const name of unknownTemplateVars(readFileSync(f.src, "utf8"))) {
          error(
            f.src,
            `unknown template variable {{${name}}}; available: ${TEMPLATE_VARS.join(", ")}`,
          );
        }
      }
      if (isVersionSensitive(f.dest)) {
        warning(
          f.src,
          `${f.dest} is version-sensitive tool config; describe what it should enforce in the ${KIND_FILE[entry.kind]} prose and let the agent write it for the current version`,
        );
      }
    }
    for (const dest of entry.meta.merge) {
      const contributions = files.filter((f) => f.dest === dest);
      if (contributions.length === 0) {
        warning(entryFile(entry), `merge lists ${dest}, but this entry ships no such file`);
      }
      for (const f of contributions) {
        let text = readFileSync(f.src, "utf8");
        if (f.template) {
          text = text.replace(TEMPLATE_TOKEN, (_whole, name: string) => SAMPLE_VARS[name] ?? "x");
        }
        try {
          JSON.parse(text);
        } catch (err) {
          error(f.src, `declared under merge, so it must be valid JSON: ${(err as Error).message}`);
        }
      }
    }
  }

  // 5. Composition dry runs.
  const dryRun = (file: string, label: string, stackId: string | undefined, withIds: string[]) => {
    try {
      compose(
        registry,
        { stackId, with: withIds, without: [], sandbox: false, agents: [...AGENTS], always: [] },
        { hasTool: () => true },
      );
    } catch (err) {
      if (!(err instanceof OpenScaffoldError)) throw err;
      error(file, `${label}: ${err.message}`);
    }
  };
  const brokenRefs = new Set(errors.map((e) => e.file));
  for (const s of stacks) {
    if (brokenRefs.has(rel(entryFile(s))) || withSymlinks.has(s.id)) continue;
    dryRun(entryFile(s), `composing ${s.id} with its defaults`, s.id, []);
    for (const opt of s.meta.fragments.optional) {
      dryRun(entryFile(s), `composing ${s.id} with ${opt}`, s.id, [opt]);
    }
  }
  for (const f of fragments) {
    if (brokenRefs.has(rel(entryFile(f))) || withSymlinks.has(f.id)) continue;
    dryRun(entryFile(f), `composing ${f.id} on its own`, undefined, [f.id]);
  }

  return {
    ok: errors.length === 0,
    path: target.label,
    stacks: stacks.length,
    fragments: fragments.length,
    errors,
    warnings,
  };
}

function entryFile(entry: Entry): string {
  return join(entry.dir, KIND_FILE[entry.kind]);
}

function problemMessage(p: ScanProblem): string {
  if (p.reason === "newer_schema") {
    return `schema_version ${p.schemaVersion} is newer than this openscaffold supports; update openscaffold or lower schema_version`;
  }
  if (p.reason === "missing_file") return `missing: every ${p.kind} directory needs one`;
  const msg = p.message.replace(`${p.file} `, "");
  return msg.startsWith("is invalid: ") ? `invalid frontmatter: ${msg.slice(12)}` : msg;
}

function printReport(report: ValidationReport): void {
  for (const e of report.errors) println(`error: ${e.file}: ${e.message}`);
  for (const w of report.warnings) println(`warning: ${w.file}: ${w.message}`);
  if (report.errors.length || report.warnings.length) println();
  const counts = `${report.stacks} stack${report.stacks === 1 ? "" : "s"}, ${report.fragments} fragment${report.fragments === 1 ? "" : "s"}`;
  const tally = `${report.errors.length} error${report.errors.length === 1 ? "" : "s"}, ${report.warnings.length} warning${report.warnings.length === 1 ? "" : "s"}`;
  println(
    report.ok
      ? `ok: validated ${counts} in ${report.path} (${tally})`
      : `failed: validated ${counts} in ${report.path} (${tally}). Fix the errors above and rerun openscaffold validate.`,
  );
}

export function register(program: Command): void {
  program
    .command("validate")
    .description("Check a registry root or a single stack/fragment directory")
    .argument("<path>", "registry root (with stacks/ or fragments/) or one entry directory")
    .option("--json", "print the report as JSON")
    .action((path: string, options: { json?: boolean }) => {
      const report = validatePath(path);
      report.path = path;
      if (options.json) printJson(report);
      else printReport(report);
      if (!report.ok) process.exitCode = 1;
    });
}
