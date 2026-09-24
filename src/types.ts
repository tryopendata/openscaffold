import type { AgentId, FragmentMeta, StackMeta, VerifyStep } from "./schema/index.js";

/** Where an entry was resolved from, highest precedence first. */
export type Origin = "project" | "user" | "registry" | "bundled";

export interface Entry<M extends StackMeta | FragmentMeta = StackMeta | FragmentMeta> {
  kind: M["kind"];
  id: string;
  meta: M;
  /** Markdown body: agent guidance prose. */
  body: string;
  /** Absolute path of the entry directory (contains STACK.md or FRAGMENT.md). */
  dir: string;
  origin: Origin;
  trusted: boolean;
  /** Lower-precedence origins that also define this id. */
  shadows: Origin[];
}
export type StackEntry = Entry<StackMeta>;
export type FragmentEntry = Entry<FragmentMeta>;

/** One file the CLI will write. */
export interface FileOp {
  /** Absolute source path. */
  src: string;
  /** Destination relative to the project root, with any .tmpl suffix already stripped. */
  dest: string;
  /** Render {{var}} placeholders (source ended in .tmpl). */
  template: boolean;
  /** Entry id that contributed the file. */
  owner: string;
  /** Deep-merge JSON with other contributors to the same dest (declared via `merge`). */
  merge: boolean;
}

export interface OwnedVerifyStep extends VerifyStep {
  owner: string;
}

export interface ComposeInput {
  /** Omitted for `add` on a repo with no stack. */
  stackId?: string;
  with: string[];
  without: string[];
  sandbox: boolean;
  agents: AgentId[];
  /** Fragments from ~/.openscaffold/config.yaml `always`. */
  always: string[];
  /** Fragments already applied (from an existing manifest); not re-emitted but satisfy requires. */
  existing?: string[];
  /**
   * "add": select only `with` plus their requires (no stack defaults, no `always`). The stack is
   * used only for applies_to matching and contributes no files, steps, env, decisions, or tools.
   * Default "new".
   */
  mode?: "new" | "add";
}

export interface ComposedPlan {
  stack?: StackEntry;
  /** In application order: topological by requires, then alphabetical. */
  fragments: FragmentEntry[];
  agents: AgentId[];
  preset: "default" | "sandbox";
  files: FileOp[];
  verify: OwnedVerifyStep[];
  env: Record<string, string>;
  decisions: string[];
  /** Human/agent-readable warnings (shadowing, dropped fragments, missing tools, ...). */
  warnings: string[];
  missingTools: { owner: string; tool: string }[];
}
