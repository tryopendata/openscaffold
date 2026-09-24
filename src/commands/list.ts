import type { Command } from "commander";
import { OpenScaffoldError } from "../errors.js";
import { printJson, println, warn } from "../output.js";
import { type EntryKind, loadRegistry } from "../registry/index.js";
import type { Entry, Origin } from "../types.js";

export interface ListItem {
  id: string;
  kind: EntryKind;
  name: string;
  description: string;
  tags: string[];
  category?: string;
  origin: Origin;
  trusted: boolean;
  shadows: Origin[];
}

export function toListItem(entry: Entry): ListItem {
  return {
    id: entry.id,
    kind: entry.kind,
    name: entry.meta.name,
    description: entry.meta.description,
    tags: entry.meta.tags,
    ...(entry.meta.kind === "fragment" ? { category: entry.meta.category } : {}),
    origin: entry.origin,
    trusted: entry.trusted,
    shadows: entry.shadows,
  };
}

function table(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length))) ?? [];
  return rows.map((r) =>
    r
      .map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

function printHuman(items: ListItem[]): void {
  if (items.length === 0) {
    println("No stacks or fragments found.");
    return;
  }
  const stacks = items.filter((i) => i.kind === "stack");
  const fragments = items.filter((i) => i.kind === "fragment");
  // Only show where entries came from when something isn't bundled.
  const showOrigin = items.some((i) => i.origin !== "bundled");
  const origin = (i: ListItem) => (showOrigin ? [i.origin] : []);
  if (stacks.length) {
    println("Stacks:");
    for (const line of table(stacks.map((s) => [s.id, ...origin(s), s.description]))) {
      println(`  ${line}`);
    }
  }
  if (fragments.length) {
    if (stacks.length) println();
    println("Fragments:");
    const rows = fragments.map((f) => [f.id, f.category ?? "", ...origin(f), f.description]);
    for (const line of table(rows)) println(`  ${line}`);
  }
  println();
  println(
    stacks.length
      ? "Next: `openscaffold show <id>` for details, or `openscaffold new <stack> [dir]` to start a project."
      : "Next: `openscaffold show <id>` for details, or `openscaffold add <fragment>` to apply one.",
  );
}

export function register(program: Command): void {
  program
    .command("list")
    .description("List available stacks and fragments")
    .option("--kind <kind>", "only stack or fragment")
    .option("--json", "print as JSON")
    .action(async (options: { kind?: string; json?: boolean }) => {
      if (options.kind !== undefined && options.kind !== "stack" && options.kind !== "fragment") {
        throw new OpenScaffoldError(
          "bad_option",
          `--kind must be "stack" or "fragment", not "${options.kind}"`,
        );
      }
      const registry = await loadRegistry({ cwd: process.cwd() });
      for (const w of registry.warnings) warn(w);
      const items = registry.list(options.kind as EntryKind | undefined).map(toListItem);
      if (options.json) printJson(items);
      else printHuman(items);
    });
}
