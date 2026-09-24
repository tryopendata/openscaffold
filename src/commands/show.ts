import { relative, sep } from "node:path";
import type { Command } from "commander";
import { listEntryFiles } from "../compose.js";
import { printJson, println, warn } from "../output.js";
import { loadRegistry } from "../registry/index.js";
import { AGENTS } from "../schema/index.js";
import type { Entry } from "../types.js";

export interface ShowFile {
  /** Destination in the project, .tmpl stripped. */
  dest: string;
  /** Source path relative to the entry directory. */
  source: string;
  template: boolean;
  /** Only written when this agent is a target; null = every agent. */
  agent: string | null;
}

export function entryDetails(entry: Entry) {
  const files: ShowFile[] = listEntryFiles(entry.dir, AGENTS).map((f) => ({
    dest: f.dest,
    source: relative(entry.dir, f.src).split(sep).join("/"),
    template: f.template,
    agent: f.agent ?? null,
  }));
  return {
    id: entry.id,
    kind: entry.kind,
    origin: entry.origin,
    trusted: entry.trusted,
    shadows: entry.shadows,
    dir: entry.dir,
    meta: entry.meta,
    body: entry.body,
    files,
  };
}

function list(label: string, values: string[]): void {
  if (values.length) println(`${label}: ${values.join(", ")}`);
}

function printHuman(entry: Entry, files: ShowFile[]): void {
  const m = entry.meta;
  println(`${m.name} (${entry.kind} ${entry.id}, ${entry.origin})`);
  println(m.description);
  println();
  list("tags", m.tags);
  if (m.kind === "stack") {
    list("default fragments", m.fragments.default);
    list("optional fragments", m.fragments.optional);
  } else {
    println(`category: ${m.category}`);
    list("applies to", m.applies_to);
    list("requires", m.requires);
    list("conflicts", m.conflicts);
    list("requires tools", m.requires_tools);
  }
  list("tools", m.tools);
  for (const [role, names] of Object.entries(m.deps)) list(`deps (${role})`, names);
  list(
    "env",
    Object.entries(m.env).map(([k, v]) => `${k}=${v}`),
  );
  if (m.verify.length) {
    println("verify:");
    for (const s of m.verify) {
      const tags = s.tags.length ? ` [${s.tags.join(", ")}]` : "";
      println(`  ${s.name} (${s.phase})${tags}: ${s.run}`);
    }
  }
  if (m.decisions.length) {
    println("decisions:");
    for (const d of m.decisions) println(`  - ${d}`);
  }
  println("files:");
  if (files.length === 0) println("  (none)");
  for (const f of files) {
    const notes = [f.agent ? `${f.agent} only` : "", f.template ? "template" : ""].filter(Boolean);
    println(`  ${f.dest}${notes.length ? ` (${notes.join(", ")})` : ""}`);
  }
  if (entry.body) {
    println();
    println(entry.body);
  }
  println();
  println(
    entry.kind === "stack"
      ? `Next: \`openscaffold new ${entry.id} [dir]\` to start a project with this stack.`
      : `Next: \`openscaffold add ${entry.id}\` in an existing repo, or \`openscaffold new <stack> --with ${entry.id}\`.`,
  );
}

export function register(program: Command): void {
  program
    .command("show")
    .description("Show a stack or fragment: metadata, guidance, and the files it writes")
    .argument("<id>", "stack or fragment id")
    .option("--json", "print as JSON")
    .option("--offline", "don't fetch the registry; use cached and bundled entries")
    .action(async (id: string, options: { json?: boolean; offline?: boolean }) => {
      const registry = await loadRegistry({ cwd: process.cwd(), offline: options.offline });
      for (const w of registry.warnings) warn(w);
      const entry = registry.find(id);
      const details = entryDetails(entry);
      if (options.json) printJson(details);
      else printHuman(entry, details.files);
    });
}
