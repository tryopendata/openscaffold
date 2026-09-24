import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compose } from "../src/compose.js";
import { loadRegistry, type Registry } from "../src/registry/index.js";
import type { ComposeInput } from "../src/types.js";

const FIXTURE = join(import.meta.dirname, "fixtures", "registry-compose");

let tmp: string;
let registry: Registry;

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "os-compose-"));
  const bundled = join(tmp, "bundled");
  cpSync(FIXTURE, bundled, { recursive: true });
  writeFileSync(join(bundled, "stacks", "web", "files", ".DS_Store"), "junk");
  mkdirSync(join(tmp, "home"));
  mkdirSync(join(tmp, "cwd"));
  registry = await loadRegistry({
    cwd: join(tmp, "cwd"),
    home: join(tmp, "home"),
    bundledDir: bundled,
    offline: true,
  });
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const allTools = { hasTool: () => true };

function run(input: Partial<ComposeInput>, opts: Parameters<typeof compose>[2] = allTools) {
  return compose(
    registry,
    { with: [], without: [], sandbox: false, agents: ["claude"], always: [], ...input },
    opts,
  );
}

const ids = (plan: ReturnType<typeof run>) => plan.fragments.map((f) => f.id);

describe("fragment selection", () => {
  it("applies stack defaults plus requires, dependencies first", () => {
    const plan = run({ stackId: "web" });
    expect(plan.stack?.id).toBe("web");
    expect(ids(plan)).toEqual(["agent-ops", "ci", "docker-build", "fly"]);
    expect(plan.preset).toBe("default");
    expect(plan.warnings).toEqual([]);
  });

  it("adds --with and removes --without", () => {
    const plan = run({ stackId: "web", with: ["postgres"], without: ["ci", "fly"] });
    expect(ids(plan)).toEqual(["agent-ops", "postgres"]);
  });

  it("pulls requires in transitively and orders by requires then alphabetically", () => {
    const plan = run({ stackId: "cli", with: ["chain-a", "ci"] });
    expect(ids(plan)).toEqual(["agent-ops", "chain-c", "chain-b", "chain-a", "ci"]);
  });

  it("errors when a required fragment was excluded, naming the requirer", () => {
    expect(() => run({ stackId: "cli", with: ["rr"], without: ["agent-ops"] })).toThrow(
      "rr requires agent-ops, but agent-ops was excluded with --without",
    );
  });

  it("existing fragments satisfy requires and are not re-emitted", () => {
    const plan = run({ with: ["rr"], existing: ["agent-ops"] });
    expect(ids(plan)).toEqual(["rr"]);
    expect(plan.stack).toBeUndefined();
  });

  it("adds `always` fragments that fit and skips ones that don't, with a warning", () => {
    const fits = run({ stackId: "web", always: ["web-only"] });
    expect(ids(fits)).toContain("web-only");
    const skipped = run({ stackId: "cli", always: ["web-only"] });
    expect(ids(skipped)).not.toContain("web-only");
    expect(skipped.warnings.join("\n")).toMatch(
      /skipped web-only.*applies to typescript, not stack cli/,
    );
  });

  it("keeps an explicit --with that doesn't fit the stack, with a warning", () => {
    const plan = run({ stackId: "cli", with: ["web-only"] });
    expect(ids(plan)).toContain("web-only");
    expect(plan.warnings.join("\n")).toContain("keeping it because you asked for it");
  });

  it("does not check applies_to without a stack", () => {
    const plan = run({ with: ["web-only"] });
    expect(ids(plan)).toEqual(["web-only"]);
    expect(plan.warnings).toEqual([]);
  });

  it("errors on conflicts in either direction", () => {
    expect(() => run({ stackId: "web", with: ["conflicts-ci"] })).toThrow(
      "ci conflicts with conflicts-ci",
    );
    expect(() => run({ with: ["ci"], existing: ["conflicts-ci"] })).toThrow(/conflicts/);
  });

  it("errors when the same fragment is in both --with and --without", () => {
    expect(() => run({ stackId: "web", with: ["ci"], without: ["ci"] })).toThrow(
      '"ci" is in both --with and --without',
    );
  });

  it("warns about, but ignores, an unknown --without id", () => {
    const plan = run({ stackId: "web", without: ["nope"] });
    expect(ids(plan)).toEqual(["agent-ops", "ci", "docker-build", "fly"]);
    expect(plan.warnings).toEqual(['--without nope: no fragment named "nope", ignoring it']);
  });

  it("errors on an unknown fragment with a list hint", () => {
    expect(() => run({ stackId: "web", with: ["postgress"] })).toThrow(
      /no fragment named "postgress"/,
    );
  });
});

describe("sandbox", () => {
  it("drops deploy and release fragments with a warning", () => {
    const plan = run({ stackId: "web", sandbox: true });
    expect(plan.preset).toBe("sandbox");
    expect(ids(plan)).toEqual(["agent-ops", "ci"]);
    expect(plan.warnings.join("\n")).toContain("dropped fly: --sandbox skips deploy fragments");
  });

  it("keeps an explicitly requested deploy fragment and warns", () => {
    const plan = run({ stackId: "web", sandbox: true, with: ["fly"] });
    expect(ids(plan)).toContain("fly");
    expect(plan.warnings.join("\n")).toContain("fly is a deploy fragment");
  });

  it("keeps a deploy fragment another fragment requires, and says why", () => {
    const plan = run({ stackId: "cli", sandbox: true, with: ["needs-fly"] });
    expect(ids(plan)).toContain("fly");
    expect(plan.warnings.join("\n")).toContain("kept fly because needs-fly requires it");

    // A default dropped for sandbox but required elsewhere isn't reported as dropped.
    const web = run({ stackId: "web", sandbox: true, with: ["needs-fly"] });
    expect(ids(web)).toContain("fly");
    const w = web.warnings.join("\n");
    expect(w).toContain("kept fly because needs-fly requires it");
    expect(w).not.toContain("dropped fly");
  });
});

describe("add mode", () => {
  it("selects only the requested fragments plus requires, ignoring stack defaults", () => {
    const plan = run({ stackId: "web", mode: "add", with: ["postgres"] });
    expect(ids(plan)).toEqual(["postgres"]);
    expect(plan.stack?.id).toBe("web");
  });

  it("still uses the stack for applies_to matching", () => {
    const plan = run({ stackId: "cli", mode: "add", with: ["web-only"] });
    expect(plan.warnings.join("\n")).toContain("applies to typescript, not stack cli");
  });

  it("leaves the stack's files, steps, env, and tools out of the plan", () => {
    const plan = run({ stackId: "web", mode: "add", with: ["postgres"] }, { hasTool: () => false });
    expect(plan.files.map((f) => f.owner)).not.toContain("web");
    expect(plan.verify.map((s) => s.name)).toEqual(["db-up"]);
    expect(plan.decisions).toEqual([]);
    expect(plan.missingTools).toEqual([{ owner: "postgres", tool: "docker" }]);
  });

  it("suggests not adding a fragment whose tool is missing, since add has no --without", () => {
    const plan = run({ stackId: "web", mode: "add", with: ["postgres"] }, { hasTool: () => false });
    expect(plan.warnings).toContain(
      "postgres needs docker, which isn't on PATH; install it, or don't add postgres",
    );
    expect(plan.warnings.join("\n")).not.toContain("--without");
  });

  it("doesn't treat a path the stack owns as an ownership collision", () => {
    const plan = run({ stackId: "web", mode: "add", with: ["owns-gitignore"] });
    expect(plan.files.map((f) => `${f.owner}:${f.dest}`)).toEqual(["owns-gitignore:.gitignore"]);
  });
});

describe("files", () => {
  it("strips .tmpl, skips .DS_Store, and includes adapters only for targeted agents", () => {
    const plan = run({ stackId: "web", without: ["ci", "fly"] });
    const dests = plan.files.map((f) => f.dest).sort();
    expect(dests).toEqual([".claude/settings.json", ".gitignore", "AGENTS.md", "README.md"]);
    const readme = plan.files.find((f) => f.dest === "README.md");
    expect(readme?.template).toBe(true);
    expect(readme?.owner).toBe("web");
    expect(readme?.src.endsWith("README.md.tmpl")).toBe(true);
    expect(plan.files.find((f) => f.dest === ".gitignore")?.template).toBe(false);

    const cursor = run({ stackId: "web", without: ["ci", "fly"], agents: ["cursor"] });
    expect(cursor.files.map((f) => f.dest)).toContain(".cursor/rules/base.mdc");
    expect(cursor.files.map((f) => f.dest)).not.toContain(".claude/settings.json");
  });

  it("errors when two entries write the same path", () => {
    expect(() => run({ stackId: "web", with: ["owns-gitignore"] })).toThrow(
      ".gitignore is written by more than one entry (web, owns-gitignore)",
    );
  });

  it("marks shared JSON as merge when every contributor declares it", () => {
    const plan = run({ stackId: "cli", with: ["rr"] });
    const settings = plan.files.filter((f) => f.dest === ".claude/settings.json");
    expect(settings.map((f) => f.owner)).toEqual(["agent-ops", "rr"]);
    expect(settings.every((f) => f.merge)).toBe(true);
    expect(plan.files.find((f) => f.dest === "AGENTS.md")?.merge).toBe(false);
  });

  it("errors when only some contributors declare merge", () => {
    expect(() => run({ stackId: "cli", with: ["half-merge"] })).toThrow(
      /\.claude\/settings\.json is written by more than one entry \(agent-ops, half-merge\)/,
    );
  });
});

describe("verify, env, decisions, tools", () => {
  it("orders verify steps stack first, tagged with owners", () => {
    const plan = run({ stackId: "web", with: ["postgres"] });
    expect(plan.verify.map((s) => `${s.owner}:${s.name}`)).toEqual([
      "web:install",
      "web:test",
      "ci:ci-lint",
      "postgres:db-up",
    ]);
  });

  it("errors on duplicate verify step names", () => {
    expect(() => run({ stackId: "web", with: ["dup-verify"] })).toThrow(
      'verify step "test" is defined by both web and dup-verify',
    );
  });

  it("merges env and allows agreeing values", () => {
    const plan = run({ stackId: "web", with: ["postgres"] });
    expect(plan.env).toEqual({ PORT_WEB: "3000", PORT_DB: "5432" });
  });

  it("errors on conflicting env values", () => {
    expect(() => run({ stackId: "web", with: ["env-clash"] })).toThrow(
      'env PORT_WEB is "3000" in web but "4000" in env-clash',
    );
  });

  it("prefixes fragment decisions with their owner", () => {
    const plan = run({ stackId: "web" });
    expect(plan.decisions).toEqual([
      "Project name (default: the directory name)",
      "agent-ops: Which hooks to enable (default all)",
    ]);
  });

  it("warns once per missing tool, naming every owner", () => {
    const plan = run({ stackId: "web", with: ["postgres", "needs-fly"] }, { hasTool: () => false });
    expect(plan.missingTools).toEqual([
      { owner: "web", tool: "bun" },
      { owner: "needs-fly", tool: "docker" },
      { owner: "postgres", tool: "docker" },
    ]);
    const docker = plan.warnings.filter((w) => w.includes("docker"));
    expect(docker).toEqual([
      "needs-fly, postgres need docker, which isn't on PATH; install it or rerun with --without needs-fly --without postgres",
    ]);
  });

  it("reports missing tools and suggests --without for fragments", () => {
    const plan = run({ stackId: "web", with: ["postgres", "rr"] }, { hasTool: (t) => t === "rr" });
    expect(plan.missingTools).toEqual([
      { owner: "web", tool: "bun" },
      { owner: "postgres", tool: "docker" },
    ]);
    const w = plan.warnings.join("\n");
    expect(w).toContain("postgres needs docker");
    expect(w).toContain("--without postgres");
    expect(w).toContain("web needs bun");
  });
});
