import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpenScaffoldError } from "../src/errors.js";
import { deepMerge, renderFiles, renderTemplate } from "../src/render.js";
import type { FileOp } from "../src/types.js";

const VARS = {
  project_name: "My App",
  project_slug: "my-app",
  package_scope: "acme",
  author: "Ada",
  year: "2026",
};

let tmp: string;
let out: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "os-render-"));
  out = join(tmp, "out");
  mkdirSync(out);
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function src(name: string, text: string, mode?: number): string {
  const path = join(tmp, "src", name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  if (mode !== undefined) chmodSync(path, mode);
  return path;
}

function op(dest: string, text: string, extra: Partial<FileOp> = {}): FileOp {
  return {
    src: src(`${extra.owner ?? "o"}/${dest}${extra.template ? ".tmpl" : ""}`, text),
    dest,
    template: false,
    owner: "o",
    merge: false,
    ...extra,
  };
}

const read = (rel: string) => readFileSync(join(out, rel), "utf8");

describe("renderTemplate", () => {
  it("substitutes known vars, tolerating whitespace", () => {
    expect(renderTemplate("{{project_name}} by {{ author }} ({{  year}})", VARS, "f")).toBe(
      "My App by Ada (2026)",
    );
  });

  it("fails on unknown vars, naming the file and var", () => {
    try {
      renderTemplate("hi {{ nope }}", VARS, "/x/README.md.tmpl");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OpenScaffoldError);
      expect((err as Error).message).toContain("/x/README.md.tmpl");
      expect((err as Error).message).toContain("{{nope}}");
    }
  });
});

describe("deepMerge", () => {
  it("merges objects, concatenates arrays without duplicates, later scalars win", () => {
    expect(
      deepMerge(
        { a: { x: 1, list: [1, { k: 1 }] }, s: "old" },
        { a: { y: 2, list: [{ k: 1 }, 2] }, s: "new" },
      ),
    ).toEqual({ a: { x: 1, y: 2, list: [1, { k: 1 }, 2] }, s: "new" });
  });
});

describe("renderFiles", () => {
  it("renders .tmpl sources and copies everything else byte for byte", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions syntax
    const workflow = "run: echo ${{ secrets.TOKEN }} {{ project_name }}\n";
    const result = renderFiles(
      [
        op("README.md", "# {{project_name}}\n", { template: true }),
        op(".github/workflows/ci.yml", workflow),
      ],
      out,
      VARS,
    );
    expect(result).toEqual({ written: ["README.md", ".github/workflows/ci.yml"], skipped: [] });
    expect(read("README.md")).toBe("# My App\n");
    expect(read(".github/workflows/ci.yml")).toBe(workflow);
  });

  it("surfaces unknown template vars as errors", () => {
    expect(() =>
      renderFiles([op("x.txt", "{{ secrets.X }}", { template: true })], out, VARS),
    ).toThrow(/unknown template variable \{\{secrets\.X\}\}/);
  });

  it("preserves the executable bit", () => {
    const hook = op(".claude/hooks/h.sh", "#!/bin/sh\nexit 0\n");
    chmodSync(hook.src, 0o755);
    const plain = op("notes.txt", "hi");
    chmodSync(plain.src, 0o644);
    renderFiles([hook, plain], out, VARS);
    expect(statSync(join(out, ".claude/hooks/h.sh")).mode & 0o777).toBe(0o755);
    expect(statSync(join(out, "notes.txt")).mode & 0o777).toBe(0o644);
  });

  it("deep-merges merge groups in plan order, rendering templates first", () => {
    const files = [
      op(".claude/settings.json", '{"hooks":{"a":[1]},"name":"first"}', {
        owner: "one",
        merge: true,
      }),
      op(".claude/settings.json", '{"hooks":{"a":[1,2]},"name":"{{project_slug}}"}', {
        owner: "two",
        merge: true,
        template: true,
      }),
    ];
    const result = renderFiles(files, out, VARS);
    expect(result.written).toEqual([".claude/settings.json"]);
    expect(JSON.parse(read(".claude/settings.json"))).toEqual({
      hooks: { a: [1, 2] },
      name: "my-app",
    });
  });

  it("names the contributor when merge JSON is invalid", () => {
    const files = [
      op("s.json", "{}", { owner: "one", merge: true }),
      op("s.json", "{nope", { owner: "two", merge: true }),
    ];
    expect(() => renderFiles(files, out, VARS)).toThrow(/two\/s\.json.*isn't valid JSON/);
  });

  it("never overwrites existing files and can park its version under an incoming dir", () => {
    writeFileSync(join(out, "README.md"), "mine\n");
    mkdirSync(join(out, ".claude"));
    writeFileSync(join(out, ".claude/settings.json"), '{"mine":true}');
    const incoming = join(out, ".openscaffold/incoming");
    const result = renderFiles(
      [
        op("README.md", "# {{project_name}}\n", { template: true }),
        op(".claude/settings.json", '{"a":1}', { owner: "one", merge: true }),
        op(".claude/settings.json", '{"b":2}', { owner: "two", merge: true }),
        op("new.txt", "new"),
      ],
      out,
      VARS,
      { incomingDir: incoming },
    );
    expect(result).toEqual({
      written: ["new.txt"],
      skipped: ["README.md", ".claude/settings.json"],
    });
    expect(read("README.md")).toBe("mine\n");
    expect(read(".claude/settings.json")).toBe('{"mine":true}');
    expect(readFileSync(join(incoming, "README.md"), "utf8")).toBe("# My App\n");
    expect(JSON.parse(readFileSync(join(incoming, ".claude/settings.json"), "utf8"))).toEqual({
      a: 1,
      b: 2,
    });
  });
});
