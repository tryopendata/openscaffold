import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Executes the real agent-ops Claude Code hooks with JSON payloads on stdin, the
// way Claude Code calls them (`bash "<hooks>/<name>.sh"`).

const HOOKS = fileURLToPath(
  new URL("../registry/fragments/agent-ops/adapters/claude/.claude/hooks/", import.meta.url),
);
const FRAGMENTS = fileURLToPath(new URL("../registry/fragments/", import.meta.url));

const has = (cmd: string, args: string[] = ["--version"]) =>
  spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
// The bash on PATH, plus /bin/bash when it is a different binary: on macOS that
// is the stock bash 3.2 Claude Code users actually run the hooks with.
function bashes(): string[] {
  const found: string[] = [];
  const onPath = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
  for (const b of [onPath, "/bin/bash"]) {
    if (!b || !existsSync(b)) continue;
    if (found.some((f) => realpathSync(f) === realpathSync(b))) continue;
    found.push(b);
  }
  return found;
}
const BASHES = bashes();
const hasJq = has("jq");
const hasGit = has("git");
const hasShellcheck = has("shellcheck");

interface HookResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runHookWith(
  bash: string,
  name: string,
  payload: unknown,
  opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): HookResult {
  const r = spawnSync(bash, [join(HOOKS, name)], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    cwd: opts.cwd,
    env: { ...process.env, CLAUDE_PROJECT_DIR: undefined, ...opts.env },
    timeout: 25_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function decision(stdout: string): string | undefined {
  if (!stdout.trim()) return undefined;
  return JSON.parse(stdout).hookSpecificOutput?.permissionDecision;
}

const bashPayload = (command: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});

const writePayload = (file_path: string, content: string, cwd?: string) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  cwd,
  tool_input: { file_path, content },
});

// A PATH that has every executable from the current PATH except `excluded`,
// built as a directory of symlinks. Lets a test run a hook on a machine where
// jq or a linter "isn't installed" without touching the real install.
const pathDirs: string[] = [];
function pathWithout(excluded: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "hooks-path-"));
  pathDirs.push(dir);
  const seen = new Set(excluded);
  for (const p of (process.env.PATH ?? "").split(delimiter)) {
    let entries: string[];
    try {
      entries = readdirSync(p);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (seen.has(name)) continue;
      try {
        if (!statSync(join(p, name)).isFile()) continue;
        symlinkSync(join(p, name), join(dir, name));
        seen.add(name);
      } catch {
        // unreadable entry or duplicate name: first one on PATH wins
      }
    }
  }
  return dir;
}

const LINTERS = ["ruff", "biome", "eslint", "golangci-lint", "gofmt", "shellcheck", "prettier"];

let project: string;

beforeAll(() => {
  project = mkdtempSync(join(tmpdir(), "hooks-project-"));
  if (hasGit) spawnSync("git", ["init", "-q"], { cwd: project });
  // Files every linter would complain about, if it were installed.
  writeFileSync(join(project, "bad.py"), "import os\n");
  writeFileSync(join(project, "bad.sh"), "#!/bin/bash\necho $1\n");
  writeFileSync(join(project, "go.mod"), "module example.com/x\n");
  writeFileSync(join(project, "bad.go"), "package main\nfunc main( {\n}\n");
  mkdirSync(join(project, "web"));
  writeFileSync(join(project, "web", "package.json"), "{}\n");
  writeFileSync(join(project, "web", "biome.json"), "{}\n");
  writeFileSync(join(project, "web", "bad.ts"), "var x = 1;;\n");
});

afterAll(() => {
  rmSync(project, { recursive: true, force: true });
  for (const d of pathDirs) rmSync(d, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );

describe("agent-ops settings", () => {
  const settingsOf = (fragment: string) =>
    join(FRAGMENTS, fragment, "adapters/claude/.claude/settings.json");

  it("has no wildcard rm deny rule that would block every absolute or home path", () => {
    const s = JSON.parse(readFileSync(settingsOf("agent-ops"), "utf8"));
    const deny: string[] = s.permissions.deny;
    expect(deny).toContain("Bash(rm -rf /)");
    expect(deny).toContain("Bash(rm -rf ~)");
    for (const rule of deny) expect(rule).not.toMatch(/^Bash\(rm .*\*\)$/);
  });

  // Claude Code validates settings; an unrecognized key is at best ignored.
  it.each(["agent-ops", "ce-plugin", "rr"])("%s settings.json has no private _keys", (fragment) => {
    const s = JSON.parse(readFileSync(settingsOf(fragment), "utf8"));
    expect(Object.keys(s).filter((k) => k.startsWith("_"))).toEqual([]);
  });
});

describe.skipIf(BASHES.length === 0).each(BASHES)("agent-ops hooks under %s", (bash) => {
  const runHook = (
    name: string,
    payload: unknown,
    opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
  ) => runHookWith(bash, name, payload, opts);

  describe.skipIf(!hasJq)("block-destructive.sh", () => {
    it.each([
      "rm -rf /",
      "rm -rf ~",
      "rm -r -f .",
      "git reset --hard HEAD~1",
      "git clean -fd",
      "git checkout .",
      "git push --force origin main",
      "git push -f",
      "find . -name '*.log' -delete",
      "psql -c 'DROP TABLE users'",
      "docker compose down -v",
      "npm publish",
      "cd /tmp && rm -rf ~/",
      'rm -rf "$HOME"',
      'rm -rf "/"',
      'bash -c "rm -rf /"',
      "sh -c 'cd /tmp; rm -rf ~'",
      'echo "DROP TABLE users;" | psql',
      "sudo -u root rm -rf /",
      "env rm -rf /",
      "exec rm -rf ~",
      "eval rm -rf /",
      "timeout 5 rm -rf /",
      "nice rm -rf ~",
      "nice -n 10 rm -rf ~",
      "rm -rf ./",
      "rm -rf ../",
      "rm -rf ../*",
      'rm -rf "$PWD"',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell ${PWD}
      "rm -rf ${PWD}/",
      "bash -c 'rm -rf /'",
    ])("denies %s", (command) => {
      const r = runHook("block-destructive.sh", bashPayload(command));
      expect(r.code).toBe(0);
      expect(decision(r.stdout)).toBe("deny");
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason).toMatch(/BLOCKED/);
    });

    it.each([
      "ls -la",
      "git status",
      "rm -rf node_modules",
      "rm -rf ./dist",
      "git push --force-with-lease",
      "git push -u origin feature",
      "git clean -n",
      "git checkout -- src/app.ts",
      "npm publish --dry-run",
      "docker compose down",
      "find . -name '*.log'",
      "rm -f out.txt && cd ..",
      "rm build.log; ls /",
      'git commit -m "drop table migration"',
      "rm -rf /tmp/build-cache",
      "rm -rf ~/scratch/old",
      "echo 'a;rm -rf ~'",
      'rm -rf "a b" && echo "x | rm -rf ~"',
      "git rm -r --cached src/old",
      "npm run rm-cache",
      "grep -r rm .",
      "rm -rf ../sibling-build",
    ])("allows %s", (command) => {
      const r = runHook("block-destructive.sh", bashPayload(command));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    });

    it("ignores payloads that aren't JSON", () => {
      const r = runHook("block-destructive.sh", "not json");
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    });
  });

  describe.skipIf(!hasJq)("detect-secrets.sh", () => {
    // Assembled at runtime so this file doesn't itself look like it holds a key.
    const awsKey = `AKIA${"Z7Q4".repeat(4)}`;

    it("flags an AWS-style access key", () => {
      const r = runHook(
        "detect-secrets.sh",
        writePayload("/repo/src/config.py", `AWS_KEY = "${awsKey}"\n`),
      );
      expect(r.code).toBe(0);
      expect(decision(r.stdout)).toBe("deny");
      expect(r.stdout).toMatch(/AWS access key/);
    });

    it("flags a key in an Edit's new_string", () => {
      const r = runHook("detect-secrets.sh", {
        tool_name: "Edit",
        tool_input: { file_path: "/repo/app.ts", old_string: "a", new_string: `k = "${awsKey}"` },
      });
      expect(decision(r.stdout)).toBe("deny");
    });

    it("ignores ordinary code and text", () => {
      const r = runHook(
        "detect-secrets.sh",
        writePayload(
          "/repo/src/app.ts",
          'export const apiKey = process.env.API_KEY;\nconst greeting = "hello world";\n',
        ),
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    });

    it("ignores placeholders and allowlisted lines", () => {
      const r = runHook(
        "detect-secrets.sh",
        writePayload(
          "/repo/src/app.py",
          `api_key = "your-api-key-goes-here-0123456789abcdef"\nk = "${awsKey}"  # pragma: allowlist secret\n`,
        ),
      );
      expect(r.stdout).toBe("");
    });

    it("skips docs and example files", () => {
      for (const path of ["/repo/README.md", "/repo/.env.example"]) {
        const r = runHook("detect-secrets.sh", writePayload(path, awsKey));
        expect(r.stdout).toBe("");
      }
    });
  });

  describe.skipIf(!hasJq)("lint-on-write.sh", () => {
    it("exits 0 silently when no linter is installed", () => {
      const PATH = pathWithout(LINTERS);
      for (const file of ["bad.py", "bad.sh", "bad.go", "web/bad.ts"]) {
        const r = runHook(
          "lint-on-write.sh",
          {
            hook_event_name: "PostToolUse",
            tool_name: "Write",
            cwd: project,
            tool_input: { file_path: join(project, file) },
          },
          { env: { PATH, CLAUDE_PROJECT_DIR: project } },
        );
        expect(r.code, file).toBe(0);
        expect(r.stdout, file).toBe("");
      }
    });

    it("ignores files outside the project", () => {
      const r = runHook(
        "lint-on-write.sh",
        { tool_name: "Write", tool_input: { file_path: "/etc/hosts" } },
        { env: { CLAUDE_PROJECT_DIR: project } },
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    });

    it.skipIf(!hasShellcheck)("follows sourced files next to the script it lints", () => {
      const dir = mkdtempSync(join(tmpdir(), "hooks-source-"));
      pathDirs.push(dir);
      writeFileSync(join(dir, "lib.sh"), "#!/usr/bin/env bash\ngreet() { echo hi; }\n");
      writeFileSync(
        join(dir, "main.sh"),
        '#!/usr/bin/env bash\n# shellcheck source=lib.sh\n. "$(dirname "$0")/lib.sh"\ngreet\n',
      );
      const r = runHook(
        "lint-on-write.sh",
        { tool_name: "Write", tool_input: { file_path: join(dir, "main.sh") } },
        { env: { CLAUDE_PROJECT_DIR: dir } },
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    });

    it.skipIf(!hasShellcheck)("reports linter findings as PostToolUse additionalContext", () => {
      const r = runHook(
        "lint-on-write.sh",
        { tool_name: "Write", tool_input: { file_path: join(project, "bad.sh") } },
        { env: { CLAUDE_PROJECT_DIR: project } },
      );
      expect(r.code).toBe(0);
      const out = JSON.parse(r.stdout).hookSpecificOutput;
      expect(out.hookEventName).toBe("PostToolUse");
      expect(out.additionalContext).toMatch(/shellcheck found issues in bad\.sh/);
      expect(out.additionalContext).toMatch(/SC2086/);
      // Every diagnostic line starts with the project-relative path.
      const body = (out.additionalContext as string).split("\n").slice(1).filter(Boolean);
      expect(body.length).toBeGreaterThan(0);
      for (const line of body) expect(line).toMatch(/^bad\.sh:\d+:\d+: /);
    });

    it.skipIf(!hasShellcheck)(
      "relativizes paths when the project dir and file path differ by a symlink",
      () => {
        const linkParent = mkdtempSync(join(tmpdir(), "hooks-link-"));
        pathDirs.push(linkParent);
        const link = join(linkParent, "proj");
        symlinkSync(realpathSync(project), link);
        for (const [dir, file] of [
          [link, join(realpathSync(project), "bad.sh")],
          [realpathSync(project), join(link, "bad.sh")],
        ] as const) {
          const r = runHook(
            "lint-on-write.sh",
            { tool_name: "Write", tool_input: { file_path: file } },
            { env: { CLAUDE_PROJECT_DIR: dir } },
          );
          expect(r.code).toBe(0);
          const ctx: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
          expect(ctx).toMatch(/^shellcheck found issues in bad\.sh\./);
          for (const line of ctx.split("\n").slice(1).filter(Boolean)) {
            expect(line).toMatch(/^bad\.sh:\d+:\d+: /);
          }
        }
      },
    );
  });

  describe("without jq on PATH", () => {
    let PATH: string;
    beforeAll(() => {
      PATH = pathWithout(["jq"]);
    });

    it.each([
      ["block-destructive.sh", bashPayload("rm -rf /")],
      ["detect-secrets.sh", writePayload("/repo/a.py", `k = "AKIA${"Q".repeat(16)}"`)],
      ["lint-on-write.sh", { tool_name: "Write", tool_input: { file_path: "/repo/bad.sh" } }],
      ["format-changed.sh", { hook_event_name: "Stop", stop_hook_active: false }],
    ])("%s exits 0 with no output", (name, payload) => {
      const r = runHook(name as string, payload, { env: { PATH, CLAUDE_PROJECT_DIR: project } });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    });

    it("session-start.sh exits 0 and says the hooks are inactive", () => {
      const r = runHook(
        "session-start.sh",
        { hook_event_name: "SessionStart", source: "startup" },
        { env: { PATH, CLAUDE_PROJECT_DIR: project } },
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/jq is not installed/);
    });
  });

  describe.skipIf(!hasGit)("session-start.sh", () => {
    it("reports the branch and dirty state as plain text", () => {
      const r = runHook(
        "session-start.sh",
        { hook_event_name: "SessionStart", source: "startup" },
        { env: { CLAUDE_PROJECT_DIR: project } },
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/Repo state: branch `.+`, \d+ changed file\(s\)\./);
    });

    it("doesn't ask for a branch before the first commit, but does after it", () => {
      const repo = mkdtempSync(join(tmpdir(), "hooks-fresh-"));
      pathDirs.push(repo);
      git(repo, "init", "-q", "-b", "main");
      const start = () =>
        runHook(
          "session-start.sh",
          { hook_event_name: "SessionStart", source: "startup" },
          { env: { CLAUDE_PROJECT_DIR: repo } },
        ).stdout;
      expect(start()).not.toMatch(/create a branch/);
      git(repo, "commit", "-q", "--allow-empty", "-m", "init");
      expect(start()).toMatch(/create a branch/);
      git(repo, "config", "openscaffold.allowMain", "true");
      expect(start()).not.toMatch(/create a branch/);
    });
  });

  describe.skipIf(!hasGit)("format-changed.sh", () => {
    it("exits 0 silently, whatever formatters are present", () => {
      const r = runHook(
        "format-changed.sh",
        { hook_event_name: "Stop", stop_hook_active: false },
        { env: { PATH: pathWithout(LINTERS), CLAUDE_PROJECT_DIR: project } },
      );
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toBe("");
    });

    it("passes paths with spaces and non-ASCII characters to the formatter", () => {
      const repo = mkdtempSync(join(tmpdir(), "hooks-fmt-"));
      pathDirs.push(repo);
      git(repo, "init", "-q");
      const names = ["héllo.go", "with space.go", "plain.go"];
      for (const n of names) writeFileSync(join(repo, n), "package main\n");
      // A fake gofmt that records the files it was asked to format.
      const bin = mkdtempSync(join(tmpdir(), "hooks-bin-"));
      pathDirs.push(bin);
      const log = join(bin, "gofmt.log");
      writeFileSync(
        join(bin, "gofmt"),
        `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\n`,
        { mode: 0o755 },
      );
      const PATH = `${bin}${delimiter}${pathWithout(LINTERS)}`;
      const r = runHook(
        "format-changed.sh",
        { hook_event_name: "Stop", stop_hook_active: false },
        { env: { PATH, CLAUDE_PROJECT_DIR: repo } },
      );
      expect(r.code).toBe(0);
      const formatted = readFileSync(log, "utf8").split("\n").filter(Boolean);
      for (const n of names) expect(formatted).toContain(join(repo, n));
    });
  });
});
