import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cliInvocation, nestHeadings } from "../src/brief.js";
import { runAdd } from "../src/commands/add.js";
import { runNew } from "../src/commands/new.js";
import { makeSandbox, type Sandbox } from "./helpers/scaffold.js";

let sb: Sandbox;
beforeEach(() => {
  sb = makeSandbox();
});
afterEach(() => sb.cleanup());

describe("cliInvocation", () => {
  it.each([
    [{ script: "/home/u/.npm/_npx/abc/node_modules/openscaffold/dist/cli.js" }, "npx openscaffold"],
    [{ script: "/proj/node_modules/.bin/openscaffold" }, "npx openscaffold"],
    [{ script: "C:\\p\\node_modules\\openscaffold\\dist\\cli.js" }, "npx openscaffold"],
    [{ script: "/src/openscaffold/dist/cli.js" }, "node /src/openscaffold/dist/cli.js"],
    [{ script: "/src/openscaffold/dist/cli.js", bun: true }, "bun /src/openscaffold/dist/cli.js"],
    [{ script: "/src/openscaffold/src/cli.ts", bun: true }, "bun /src/openscaffold/src/cli.ts"],
    [{ script: "/my code/os/src/cli.ts" }, "bun '/my code/os/src/cli.ts'"],
    [{}, "npx openscaffold"],
  ])("%o -> %s", (ctx, expected) => {
    expect(cliInvocation(ctx)).toBe(expected);
  });
});

describe("nestHeadings", () => {
  it("shifts headings outside code fences so the shallowest lands at the given level", () => {
    const md = "# A\n\n## B\n\n```\n# comment\n```\n";
    expect(nestHeadings(md, 3)).toBe("### A\n\n#### B\n\n```\n# comment\n```\n");
    expect(nestHeadings("## Only\n", 3)).toBe("### Only\n");
    expect(nestHeadings("no headings", 3)).toBe("no headings");
  });
});

describe("BRIEF.md", () => {
  it("new (default preset)", async () => {
    const r = await runNew({ ...sb.opts, stack: "app", dir: "demo", with: ["extra"] });
    const brief = readFileSync(r.brief, "utf8");
    expect(brief).toContain("Confirm these with the user before you start building");
    expect(brief).not.toContain("## Sandbox");
    expect(brief).toMatchSnapshot();
  });

  it("new --sandbox", async () => {
    const r = await runNew({ ...sb.opts, stack: "app", dir: "demo", sandbox: true });
    const brief = readFileSync(r.brief, "utf8");
    expect(brief).toContain("Use the stated defaults");
    expect(brief).toContain("## Sandbox");
    expect(brief).toContain("build (skipped: sandbox)");
    expect(brief).toMatchSnapshot();
  });

  it("add with merge-needed files", async () => {
    const repo = join(sb.cwd, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
    writeFileSync(join(repo, "README.md"), "# existing\n");
    const r = await runAdd({ ...sb.opts, dir: "repo", fragments: ["lonely"], yes: true });
    const brief = readFileSync(r.brief, "utf8");
    expect(brief).toContain("## Merge needed");
    expect(brief).toMatchSnapshot();
  });
});
