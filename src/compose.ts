import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { listEntryFiles } from "./entry-files.js";
import { OpenScaffoldError } from "./errors.js";
import type { Registry } from "./registry/index.js";
import { SANDBOX_EXCLUDED_CATEGORIES } from "./schema/index.js";
import type {
  ComposedPlan,
  ComposeInput,
  Entry,
  FileOp,
  FragmentEntry,
  OwnedVerifyStep,
  StackEntry,
} from "./types.js";

export { type EntryFile, listEntryFiles } from "./entry-files.js";

/** True when an executable named `tool` is on PATH. Never spawns a process. */
export function toolOnPath(tool: string): boolean {
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        const path = join(dir, tool + ext);
        if (!statSync(path).isFile()) continue;
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

function appliesTo(fragment: FragmentEntry, stack: StackEntry | undefined): boolean {
  const targets = fragment.meta.applies_to;
  if (!stack || targets.length === 0) return true;
  return targets.includes(stack.id) || stack.meta.tags.some((t) => targets.includes(t));
}

function composeError(message: string, hint?: string): OpenScaffoldError {
  return new OpenScaffoldError("compose_error", message, hint);
}

/** Topological by requires (dependencies first), ties broken alphabetically. */
function orderFragments(selected: Map<string, FragmentEntry>): FragmentEntry[] {
  const pending = new Map(
    [...selected.values()].map((f) => [f.id, f.meta.requires.filter((r) => selected.has(r))]),
  );
  const done = new Set<string>();
  const ordered: FragmentEntry[] = [];
  while (pending.size) {
    const ready = [...pending.entries()]
      .filter(([, deps]) => deps.every((d) => done.has(d)))
      .map(([id]) => id)
      .sort();
    const next = ready[0];
    if (next === undefined) {
      throw composeError(
        `fragments have a requires cycle: ${[...pending.keys()].sort().join(", ")}`,
        "Remove one of the requires edges between these fragments.",
      );
    }
    pending.delete(next);
    done.add(next);
    ordered.push(selected.get(next) as FragmentEntry);
  }
  return ordered;
}

/** Resolve a stack plus fragment toggles into the list of files, verify steps, env, and warnings. */
export function compose(
  registry: Registry,
  input: ComposeInput,
  opts: { hasTool?: (tool: string) => boolean } = {},
): ComposedPlan {
  const warnings: string[] = [];
  const stack = input.stackId ? registry.stack(input.stackId) : undefined;
  const existing = new Set(input.existing ?? []);
  const without = new Set(input.without);
  const explicitWith = new Set(input.with);
  const addMode = input.mode === "add";

  for (const id of explicitWith) {
    if (without.has(id)) {
      throw composeError(`"${id}" is in both --with and --without`, "Pick one.");
    }
  }
  for (const id of without) {
    if (!registry.get("fragment", id)) {
      warnings.push(`--without ${id}: no fragment named "${id}", ignoring it`);
    }
  }

  const selected = new Map<string, FragmentEntry>();
  const select = (fragment: FragmentEntry) => {
    if (existing.has(fragment.id)) return;
    selected.set(fragment.id, fragment);
  };
  const stackLabel = stack ? `stack ${stack.id}` : "";
  /** Sandbox-dropped fragments, with the index of their "dropped" warning. */
  const dropped = new Map<string, number>();
  const dropForSandbox = (fragment: FragmentEntry, explicit: boolean): boolean => {
    if (!input.sandbox || !SANDBOX_EXCLUDED_CATEGORIES.includes(fragment.meta.category)) {
      return false;
    }
    if (explicit) {
      warnings.push(
        `${fragment.id} is a ${fragment.meta.category} fragment, which --sandbox normally drops; keeping it because you asked for it with --with`,
      );
      return false;
    }
    dropped.set(fragment.id, warnings.length);
    warnings.push(
      `dropped ${fragment.id}: --sandbox skips ${fragment.meta.category} fragments (add --with ${fragment.id} to keep it)`,
    );
    return true;
  };

  // `add` applies only what was asked for; the stack's defaults were decided at `new` time.
  for (const id of addMode ? [] : (stack?.meta.fragments.default ?? [])) {
    if (without.has(id) || explicitWith.has(id)) continue;
    const fragment = registry.fragment(id);
    if (!dropForSandbox(fragment, false)) select(fragment);
  }
  for (const id of addMode ? [] : input.always) {
    if (without.has(id) || explicitWith.has(id)) continue;
    const fragment = registry.fragment(id);
    if (!appliesTo(fragment, stack)) {
      warnings.push(
        `skipped ${id} from your config's \`always\`: it applies to ${fragment.meta.applies_to.join(", ")}, not ${stackLabel}`,
      );
      continue;
    }
    if (!dropForSandbox(fragment, false)) select(fragment);
  }
  for (const id of explicitWith) {
    const fragment = registry.fragment(id);
    if (existing.has(id)) {
      warnings.push(`${id} is already applied to this project; not applying it again`);
      continue;
    }
    if (!appliesTo(fragment, stack)) {
      warnings.push(
        `${id} applies to ${fragment.meta.applies_to.join(", ")}, not ${stackLabel}; keeping it because you asked for it, but check it fits`,
      );
    }
    dropForSandbox(fragment, true);
    select(fragment);
  }

  // Pull in requires transitively.
  const queue = [...selected.values()];
  while (queue.length) {
    const fragment = queue.shift() as FragmentEntry;
    for (const req of fragment.meta.requires) {
      if (existing.has(req) || selected.has(req)) continue;
      if (without.has(req)) {
        throw composeError(
          `${fragment.id} requires ${req}, but ${req} was excluded with --without`,
          `Drop --without ${req}, or also exclude ${fragment.id} with --without ${fragment.id}.`,
        );
      }
      const required = registry.fragment(req);
      if (input.sandbox && SANDBOX_EXCLUDED_CATEGORIES.includes(required.meta.category)) {
        const at = dropped.get(req);
        if (at !== undefined) warnings.splice(at, 1, "");
        warnings.push(
          `kept ${req} because ${fragment.id} requires it (--sandbox normally drops ${required.meta.category} fragments)`,
        );
      }
      selected.set(req, required);
      queue.push(required);
    }
  }

  // Conflicts, in either direction, including already-applied fragments.
  const present = new Set([...selected.keys(), ...existing]);
  for (const fragment of selected.values()) {
    for (const other of present) {
      const otherMeta = registry.get("fragment", other)?.meta;
      if (fragment.meta.conflicts.includes(other) || otherMeta?.conflicts.includes(fragment.id)) {
        const pair = [fragment.id, other].sort();
        throw composeError(
          `${pair[0]} conflicts with ${pair[1]}; they can't be combined`,
          `Rerun with --without ${pair[0]} or --without ${pair[1]}.`,
        );
      }
    }
  }

  const fragments = orderFragments(selected);
  // In add mode the stack's parts are already in the project, so only new fragments contribute
  // (and only they can collide with each other; a path the stack wrote exists and gets parked).
  const entries: Entry[] = [...(stack && !addMode ? [stack] : []), ...fragments];

  // Files and ownership.
  const byDest = new Map<string, FileOp[]>();
  for (const entry of entries) {
    for (const f of listEntryFiles(entry.dir, input.agents)) {
      const op: FileOp = {
        src: f.src,
        dest: f.dest,
        template: f.template,
        owner: entry.id,
        merge: false,
      };
      byDest.set(f.dest, [...(byDest.get(f.dest) ?? []), op]);
    }
  }
  const files: FileOp[] = [];
  for (const [dest, ops] of byDest) {
    if (ops.length > 1) {
      const owners = [...new Set(ops.map((o) => o.owner))];
      const mergeable = ops.every((o) =>
        entries.find((e) => e.id === o.owner)?.meta.merge.includes(dest),
      );
      if (!mergeable) {
        throw composeError(
          `${dest} is written by more than one entry (${owners.join(", ")})`,
          `Each path needs one owner. If it's JSON that should be deep-merged, every contributor must list "${dest}" under merge.`,
        );
      }
      for (const o of ops) o.merge = true;
    }
    files.push(...ops);
  }

  // Verify steps.
  const verify: OwnedVerifyStep[] = [];
  const stepOwner = new Map<string, string>();
  for (const entry of entries) {
    for (const step of entry.meta.verify) {
      const prior = stepOwner.get(step.name);
      if (prior !== undefined) {
        throw composeError(
          `verify step "${step.name}" is defined by both ${prior} and ${entry.id}`,
          "Step names must be unique across the composed project; rename one of them.",
        );
      }
      stepOwner.set(step.name, entry.id);
      verify.push({ ...step, owner: entry.id });
    }
  }

  // Env.
  const env: Record<string, string> = {};
  const envOwner = new Map<string, string>();
  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry.meta.env)) {
      const prior = envOwner.get(key);
      if (prior !== undefined && env[key] !== value) {
        throw composeError(
          `env ${key} is "${env[key]}" in ${prior} but "${value}" in ${entry.id}`,
          "Entries that share an env var must agree on its default.",
        );
      }
      env[key] = value;
      envOwner.set(key, entry.id);
    }
  }

  // Decisions.
  const decisions = [
    ...(stack && !addMode ? stack.meta.decisions : []),
    ...fragments.flatMap((f) => f.meta.decisions.map((d) => `${f.id}: ${d}`)),
  ];

  // Tools: one warning per missing tool, naming every entry that needs it.
  const hasTool = opts.hasTool ?? toolOnPath;
  const missingTools: ComposedPlan["missingTools"] = [];
  const checked = new Map<string, boolean>();
  const check = (tool: string) => {
    if (!checked.has(tool)) checked.set(tool, hasTool(tool));
    return checked.get(tool) as boolean;
  };
  for (const entry of entries) {
    const tools =
      entry.kind === "fragment"
        ? [...(entry as FragmentEntry).meta.requires_tools, ...entry.meta.tools]
        : entry.meta.tools;
    for (const tool of new Set(tools)) {
      if (!check(tool)) missingTools.push({ owner: entry.id, tool });
    }
  }
  for (const tool of new Set(missingTools.map((t) => t.tool))) {
    const owners = missingTools.filter((t) => t.tool === tool).map((t) => t.owner);
    const droppable = owners.filter((o) => o !== stack?.id);
    const fix = !droppable.length
      ? "install it before running verify"
      : addMode
        ? `install it, or don't add ${droppable.join(", ")}`
        : `install it or rerun with ${droppable.map((o) => `--without ${o}`).join(" ")}`;
    warnings.push(
      `${owners.join(", ")} ${owners.length === 1 ? "needs" : "need"} ${tool}, which isn't on PATH; ${fix}`,
    );
  }

  return {
    stack,
    fragments,
    agents: [...input.agents],
    preset: input.sandbox ? "sandbox" : "default",
    files,
    verify,
    env,
    decisions,
    warnings: warnings.filter(Boolean),
    missingTools,
  };
}
