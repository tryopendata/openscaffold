/**
 * Conditional prose in stack and fragment bodies. A block is kept only when its condition matches
 * the project being scaffolded:
 *
 *   <!-- openscaffold:when stack=go-cli,python-react -->
 *   ...
 *   <!-- openscaffold:end -->
 *
 * Commas are OR within a key; several keys on one marker are ANDed. Blocks don't nest.
 */
import { OpenScaffoldError } from "./errors.js";

export const CONDITION_KEYS = ["stack", "tag", "mode", "preset", "with"] as const;
export type ConditionKey = (typeof CONDITION_KEYS)[number];

const ALLOWED_VALUES: Partial<Record<ConditionKey, readonly string[]>> = {
  mode: ["new", "add"],
  preset: ["default", "sandbox"],
};

export interface ConditionalBlock {
  /** 1-based line numbers of the `when` and `end` markers. */
  start: number;
  end: number;
  conditions: Partial<Record<ConditionKey, string[]>>;
}

export interface ConditionalParse {
  blocks: ConditionalBlock[];
  /** "line N: ..." messages; empty when the body is well formed. */
  errors: string[];
}

/** What a condition is matched against. */
export interface ConditionContext {
  /** Stack id; undefined for `add` on a repo with no recorded stack. */
  stack?: string;
  /** The stack's tags. */
  tags: string[];
  mode: "new" | "add";
  preset: "default" | "sandbox";
  /** Every fragment id in the composed project (for `add`: existing plus new). */
  with: string[];
}

const MARKER = /^\s*<!--\s*openscaffold:(.*?)\s*-->\s*$/;

function parseCondition(
  spec: string,
  line: number,
  errors: string[],
): Partial<Record<ConditionKey, string[]>> {
  const conditions: Partial<Record<ConditionKey, string[]>> = {};
  const parts = spec.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    errors.push(`line ${line}: openscaffold:when needs at least one condition, e.g. stack=go-cli`);
  }
  for (const part of parts) {
    const m = /^([\w-]+)=(.*)$/.exec(part);
    if (!m) {
      errors.push(`line ${line}: expected key=value[,value], got "${part}"`);
      continue;
    }
    const key = m[1] as string;
    const values = (m[2] ?? "").split(",").filter(Boolean);
    if (!(CONDITION_KEYS as readonly string[]).includes(key)) {
      errors.push(
        `line ${line}: unknown condition key "${key}" (use ${CONDITION_KEYS.join(", ")})`,
      );
      continue;
    }
    const k = key as ConditionKey;
    if (values.length === 0) errors.push(`line ${line}: ${k}= needs at least one value`);
    if (conditions[k]) errors.push(`line ${line}: ${k} appears twice; use ${k}=a,b for OR`);
    const allowed = ALLOWED_VALUES[k];
    for (const v of values) {
      if (allowed && !allowed.includes(v)) {
        errors.push(`line ${line}: ${k} must be one of ${allowed.join(", ")}, not "${v}"`);
      }
    }
    conditions[k] = values;
  }
  return conditions;
}

/** Find conditional blocks and report malformed markers. Exported for `validate`. */
export function parseConditionals(body: string): ConditionalParse {
  const blocks: ConditionalBlock[] = [];
  const errors: string[] = [];
  let open: { start: number; conditions: ConditionalBlock["conditions"] } | undefined;
  body.split("\n").forEach((text, i) => {
    const line = i + 1;
    const m = MARKER.exec(text);
    if (!m) return;
    const directive = m[1] ?? "";
    const when = /^when(?:\s+(.*))?$/.exec(directive);
    if (when) {
      if (open) {
        errors.push(
          `line ${line}: openscaffold:when inside the block opened on line ${open.start}; blocks don't nest`,
        );
        return;
      }
      open = { start: line, conditions: parseCondition(when[1] ?? "", line, errors) };
    } else if (directive === "end") {
      if (!open) {
        errors.push(`line ${line}: openscaffold:end without a matching openscaffold:when`);
        return;
      }
      blocks.push({ start: open.start, end: line, conditions: open.conditions });
      open = undefined;
    } else {
      errors.push(
        `line ${line}: unknown marker "openscaffold:${directive}" (use openscaffold:when or openscaffold:end)`,
      );
    }
  });
  if (open) errors.push(`line ${open.start}: openscaffold:when block is never closed`);
  return { blocks, errors };
}

export function conditionMatches(
  conditions: ConditionalBlock["conditions"],
  ctx: ConditionContext,
): boolean {
  const has: Record<ConditionKey, (v: string) => boolean> = {
    stack: (v) => v === ctx.stack,
    tag: (v) => ctx.tags.includes(v),
    mode: (v) => v === ctx.mode,
    preset: (v) => v === ctx.preset,
    with: (v) => ctx.with.includes(v),
  };
  return Object.entries(conditions).every(([key, values]) =>
    (values ?? []).some(has[key as ConditionKey]),
  );
}

/**
 * Remove blocks whose condition doesn't match and the marker lines of those that do. A blank
 * line left doubled by a removal is dropped. Throws on malformed markers (`validate` reports them).
 */
export function applyConditionals(body: string, ctx: ConditionContext, source = "body"): string {
  const { blocks, errors } = parseConditionals(body);
  if (errors.length) {
    throw new OpenScaffoldError(
      "bad_conditional",
      `malformed openscaffold:when markers in ${source}:\n  ${errors.join("\n  ")}`,
      "run `openscaffold validate` on the entry and fix the markers",
    );
  }
  if (blocks.length === 0) return body;
  const drop = new Set<number>();
  for (const b of blocks) {
    if (conditionMatches(b.conditions, ctx)) {
      drop.add(b.start);
      drop.add(b.end);
    } else {
      for (let l = b.start; l <= b.end; l++) drop.add(l);
    }
  }
  const out: string[] = [];
  let removedSinceKept = false;
  body.split("\n").forEach((text, i) => {
    if (drop.has(i + 1)) {
      removedSinceKept = true;
      return;
    }
    const prev = out[out.length - 1];
    if (removedSinceKept && text.trim() === "" && (prev === undefined || prev.trim() === "")) {
      return;
    }
    removedSinceKept = false;
    out.push(text);
  });
  return out.join("\n");
}
