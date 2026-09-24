import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { OpenScaffoldError } from "./errors.js";
import { formatZodIssues } from "./registry/scan.js";
import { assertInsideProject } from "./render.js";
import {
  type Manifest,
  ManifestSchema,
  type VerifyStep,
  VerifyStepSchema,
} from "./schema/index.js";

export const MANIFEST_PATH = ".openscaffold/manifest.yaml";
export const BRIEF_PATH = ".openscaffold/BRIEF.md";

const HEADER = `# Written by openscaffold. Records how this project was scaffolded.
# The verify block is this project's definition of done: \`openscaffold verify\` runs
# every step and all of them must pass. Fix the code, not the steps. verify_hash
# records the steps as generated, and verify warns when they've been edited.
`;

/** Recursively sort object keys so JSON.stringify output is canonical. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

/**
 * sha256 (hex) of the verify steps with schema defaults applied and keys sorted.
 * Extra properties (e.g. `owner` on composed steps) are ignored.
 */
export function hashVerify(steps: VerifyStep[]): string {
  const normalized = steps.map((s) =>
    VerifyStepSchema.parse({
      name: s.name,
      run: s.run,
      cwd: s.cwd,
      phase: s.phase,
      tags: s.tags,
      expect: s.expect,
    }),
  );
  return createHash("sha256")
    .update(JSON.stringify(canonical(normalized)))
    .digest("hex");
}

/** Read `.openscaffold/manifest.yaml`. Returns undefined when it doesn't exist. */
export function readManifest(projectDir: string): Manifest | undefined {
  const path = join(projectDir, MANIFEST_PATH);
  if (!existsSync(path)) return undefined;
  const hint = `fix ${MANIFEST_PATH} by hand, or re-run \`openscaffold add\` to regenerate it`;
  let raw: unknown;
  try {
    raw = YAML.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new OpenScaffoldError(
      "manifest_invalid",
      `${path} is not valid YAML: ${(err as Error).message}`,
      hint,
    );
  }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OpenScaffoldError(
      "manifest_invalid",
      `${path} is invalid: ${formatZodIssues(parsed.error)}`,
      hint,
    );
  }
  return parsed.data;
}

/**
 * Validate and write `.openscaffold/manifest.yaml` with an explanatory header. Refuses to write
 * through a symlink that leads outside the project.
 */
export function writeManifest(projectDir: string, manifest: Manifest): void {
  const data = ManifestSchema.parse(manifest);
  const path = join(projectDir, MANIFEST_PATH);
  assertInsideProject(projectDir, path);
  mkdirSync(dirname(path), { recursive: true });
  assertInsideProject(projectDir, path);
  writeFileSync(path, `${HEADER}${YAML.stringify(data, { lineWidth: 0 })}`);
}
