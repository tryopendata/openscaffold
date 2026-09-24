import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommonRunOptions } from "../../src/scaffold.js";

export const SCAFFOLD_FIXTURE = join(import.meta.dirname, "..", "fixtures", "registry-scaffold");

export interface Sandbox {
  root: string;
  home: string;
  cwd: string;
  bundled: string;
  out: string[];
  errs: string[];
  /** Options for runNew/runAdd: no network, no real home, no agent, no TTY. */
  opts: CommonRunOptions & { cli: string };
  cleanup: () => void;
}

export function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "os-scaffold-"));
  const home = join(root, "home");
  const cwd = join(root, "cwd");
  const bundled = join(root, "bundled");
  mkdirSync(home);
  mkdirSync(cwd);
  cpSync(SCAFFOLD_FIXTURE, bundled, { recursive: true });
  // Exec bits don't always survive checkouts; make the fixture hooks executable explicitly.
  chmodSync(join(bundled, "stacks/app/files/scripts/hook.sh"), 0o755);
  chmodSync(join(bundled, "fragments/agent-ops/adapters/claude/.claude/hooks/check.sh"), 0o755);
  const out: string[] = [];
  const errs: string[] = [];
  return {
    root,
    home,
    cwd,
    bundled,
    out,
    errs,
    opts: {
      cwd,
      home,
      bundledDir: bundled,
      offline: true,
      env: {},
      isTTY: false,
      hasTool: (tool) => tool !== "frobnicate",
      gitUserName: () => "Git User",
      now: new Date("2026-09-23T12:00:00Z"),
      print: (l) => out.push(l),
      warn: (l) => errs.push(l),
      spawn: () => {
        throw new Error("tests must not launch a real agent");
      },
      cli: "npx openscaffold",
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
