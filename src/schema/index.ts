import { z } from "zod";

/** Highest STACK.md / FRAGMENT.md schema major this CLI understands. */
export const SCHEMA_VERSION = 1;

export const AGENTS = ["claude", "codex", "opencode", "cursor"] as const;
export type AgentId = (typeof AGENTS)[number];

export const CATEGORIES = [
  "agent-ops",
  "ci",
  "deploy",
  "release",
  "service",
  "vendor",
  "tooling",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Fragment categories dropped by the --sandbox preset. */
export const SANDBOX_EXCLUDED_CATEGORIES: readonly Category[] = ["deploy", "release"];
/** Verify tags skipped by the --sandbox preset. */
export const SANDBOX_SKIPPED_TAGS: readonly string[] = ["prod"];

const id = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "ids are lowercase kebab-case (e.g. python-react)");

const duration = z
  .string()
  .regex(/^\d+(ms|s|m)$/, "durations look like 500ms, 90s, or 2m")
  .describe("How long to wait, e.g. 90s");

export const VerifyStepSchema = z
  .object({
    name: id.describe("Unique step name within the composed project"),
    run: z.string().min(1).describe("Shell command, run from the project root (or cwd)"),
    cwd: z.string().optional().describe("Directory relative to the project root"),
    phase: z
      .enum(["setup", "check", "serve", "teardown"])
      .default("check")
      .describe("setup -> check -> serve -> teardown"),
    tags: z.array(z.string()).default([]).describe("e.g. [prod]; --sandbox skips prod"),
    expect: z
      .object({
        http: z.string().describe("URL to probe; ${VAR} is expanded from the verify env"),
        within: duration.default("60s"),
      })
      .optional()
      .describe("Required for serve steps: the probe that proves the server is up"),
  })
  .strict()
  .refine((s) => s.phase !== "serve" || s.expect !== undefined, {
    message: "serve steps need an expect.http probe",
    path: ["expect"],
  });
export type VerifyStep = z.infer<typeof VerifyStepSchema>;

const common = {
  schema_version: z.number().int().positive(),
  id,
  name: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()).default([]),
  /** Dependency names grouped by role. Names only, never versions. */
  deps: z.record(z.string(), z.array(z.string())).default({}),
  /** CLIs the agent needs on PATH (uv, bun, go, docker...). */
  tools: z.array(z.string()).default([]),
  decisions: z.array(z.string()).default([]),
  /** Environment defaults written into the manifest and passed to verify (e.g. PORT_API: "8000"). */
  env: z.record(z.string(), z.string()).default({}),
  verify: z.array(VerifyStepSchema).default([]),
  /** Output paths (relative) that are JSON and may be deep-merged with other contributors. */
  merge: z.array(z.string()).default([]),
};

export const StackMetaSchema = z
  .object({
    ...common,
    kind: z.literal("stack"),
    fragments: z
      .object({
        default: z.array(id).default([]),
        optional: z.array(id).default([]),
      })
      .strict()
      .default({ default: [], optional: [] }),
  })
  .strict();
export type StackMeta = z.infer<typeof StackMetaSchema>;

export const FragmentMetaSchema = z
  .object({
    ...common,
    kind: z.literal("fragment"),
    category: z.enum(CATEGORIES),
    /** Stack ids or tags this fragment fits. Empty = applies anywhere. */
    applies_to: z.array(z.string()).default([]),
    requires: z.array(id).default([]),
    conflicts: z.array(id).default([]),
    /** CLIs that must exist for this fragment to work (e.g. docker for postgres). */
    requires_tools: z.array(z.string()).default([]),
  })
  .strict();
export type FragmentMeta = z.infer<typeof FragmentMetaSchema>;

export const UserConfigSchema = z
  .object({
    /** Fragments added to every `new` unless --without'd or incompatible. */
    always: z.array(id).default([]),
    agents: z.array(z.enum(AGENTS)).default([]),
    author: z.string().optional(),
    package_scope: z.string().optional(),
    /** Default preset for `new`. */
    preset: z.enum(["default", "sandbox"]).default("default"),
    /** Registry override (GitHub "owner/repo/subdir#ref" in giget syntax), mostly for testing. */
    registry: z.string().optional(),
  })
  .strict();
export type UserConfig = z.infer<typeof UserConfigSchema>;

export const ManifestSchema = z
  .object({
    openscaffold: z.string().describe("CLI version that wrote this manifest"),
    schema_version: z.number().int().positive(),
    stack: id.nullable(),
    preset: z.enum(["default", "sandbox"]),
    agents: z.array(z.enum(AGENTS)),
    fragments: z.array(id),
    vars: z.record(z.string(), z.string()),
    env: z.record(z.string(), z.string()).default({}),
    verify: z.array(VerifyStepSchema),
    /** sha256 of the verify block as generated; verify warns when it no longer matches. */
    verify_hash: z.string(),
    created: z.string(),
    updated: z.string(),
  })
  .strict();
export type Manifest = z.infer<typeof ManifestSchema>;

export const TEMPLATE_VARS = ["project_name", "project_slug", "package_scope", "author", "year"];
