import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenScaffoldError } from "../src/errors.js";
import { type FetchRemote, loadRegistry } from "../src/registry/index.js";

const DAY = 24 * 60 * 60 * 1000;

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fragment(
  root: string,
  id: string,
  extra = "",
  opts: { name?: string; version?: number } = {},
) {
  write(
    join(root, "fragments", id, "FRAGMENT.md"),
    `---\nschema_version: ${opts.version ?? 1}\nid: ${id}\nkind: fragment\nname: ${opts.name ?? id}\ndescription: test\ncategory: tooling\n${extra}---\n\nbody of ${opts.name ?? id}\n`,
  );
}

function stack(root: string, id: string) {
  write(
    join(root, "stacks", id, "STACK.md"),
    `---\nschema_version: 1\nid: ${id}\nkind: stack\nname: ${id}\ndescription: test\n---\n`,
  );
}

let tmp: string;
let home: string;
let cwd: string;
let bundled: string;
const noFetch: FetchRemote = async () => {
  throw new Error("network disabled in tests");
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "os-registry-"));
  home = join(tmp, "home");
  cwd = join(tmp, "project");
  bundled = join(tmp, "bundled");
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  fragment(bundled, "x", "", { name: "bundled x" });
  stack(bundled, "web-app");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const load = (extra: Partial<Parameters<typeof loadRegistry>[0]> = {}) =>
  loadRegistry({ cwd, home, bundledDir: bundled, offline: true, ...extra });

describe("precedence", () => {
  it("project beats user beats bundled, recording shadows", async () => {
    fragment(join(home, ".openscaffold"), "x", "", { name: "user x" });
    fragment(join(cwd, ".openscaffold"), "x", "", { name: "project x" });
    const reg = await load();
    const x = reg.fragment("x");
    expect(x.meta.name).toBe("project x");
    expect(x.origin).toBe("project");
    expect(x.trusted).toBe(true);
    expect(x.shadows).toEqual(["user", "bundled"]);
    expect(reg.warnings).toContainEqual(
      expect.stringContaining("./.openscaffold/fragments/x shadows the bundled x"),
    );
  });

  it("does not warn when a user entry shadows bundled", async () => {
    fragment(join(home, ".openscaffold"), "x", "", { name: "user x" });
    const reg = await load();
    expect(reg.fragment("x").origin).toBe("user");
    expect(reg.warnings).toEqual([]);
  });

  it("warns when a project entry shadows the main registry", async () => {
    fragment(join(cwd, ".openscaffold"), "y");
    const reg = await load({
      offline: false,
      fetchRemote: async (_s, dest) => fragment(dest, "y"),
    });
    expect(reg.fragment("y").shadows).toEqual(["registry"]);
    expect(reg.warnings.join("\n")).toContain("shadows the registry y");
  });

  it("lists winners, stacks first", async () => {
    fragment(join(home, ".openscaffold"), "a");
    const reg = await load();
    expect(reg.list().map((e) => `${e.kind}:${e.id}`)).toEqual([
      "stack:web-app",
      "fragment:a",
      "fragment:x",
    ]);
    expect(reg.list("stack").map((e) => e.id)).toEqual(["web-app"]);
  });
});

describe("lookup errors", () => {
  it("suggests close matches and the list command", async () => {
    const reg = await load();
    try {
      reg.stack("web-ap");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OpenScaffoldError);
      expect((err as OpenScaffoldError).hint).toContain('"web-app"');
      expect((err as OpenScaffoldError).hint).toContain("openscaffold list");
    }
  });

  it("explains when the id is the other kind", async () => {
    const reg = await load();
    expect(() => reg.stack("x")).toThrow(/is a fragment, not a stack/);
    expect(reg.find("x").id).toBe("x");
  });
});

describe("entry validation", () => {
  it("falls back to bundled when the registry copy has a newer schema_version", async () => {
    const reg = await load({
      offline: false,
      fetchRemote: async (_s, dest) =>
        fragment(dest, "x", "brand_new_field: 1\n", { version: 2, name: "future x" }),
    });
    expect(reg.fragment("x").meta.name).toBe("bundled x");
    const w = reg.warnings.join("\n");
    expect(w).toContain("schema_version 2");
    expect(w).toContain("using the bundled copy instead");
    expect(w).toMatch(/Update openscaffold/);
  });

  it("falls back to bundled when a registry entry is invalid, naming file and field", async () => {
    const reg = await load({
      offline: false,
      fetchRemote: async (_s, dest) => fragment(dest, "x", "category_typo: 1\n"),
    });
    expect(reg.fragment("x").meta.name).toBe("bundled x");
    const w = reg.warnings.join("\n");
    expect(w).toContain(join("cache", "registry", "fragments", "x", "FRAGMENT.md"));
    expect(w).toContain("category_typo");
  });

  it("rejects entries whose id doesn't match the directory", async () => {
    write(
      join(home, ".openscaffold", "fragments", "dir-name", "FRAGMENT.md"),
      "---\nschema_version: 1\nid: other\nkind: fragment\nname: n\ndescription: d\ncategory: ci\n---\n",
    );
    const reg = await load();
    expect(reg.get("fragment", "other")).toBeUndefined();
    expect(reg.get("fragment", "dir-name")).toBeUndefined();
    expect(reg.warnings.join("\n")).toContain("must match");
  });

  it("throws on invalid entries in strict mode", async () => {
    write(join(home, ".openscaffold", "fragments", "bad", "FRAGMENT.md"), "no frontmatter");
    await expect(load({ strict: true })).rejects.toThrow(/no YAML frontmatter/);
  });
});

describe("remote registry cache", () => {
  it("fetches once and reuses the cache within the TTL, refetching after it", async () => {
    let calls = 0;
    const fetchRemote: FetchRemote = async (_s, dest) => {
      calls++;
      fragment(dest, "remote-only", "", { name: `remote v${calls}` });
    };
    let now = 1_000_000;
    const opts = { offline: false, fetchRemote, now: () => now };
    expect((await load(opts)).fragment("remote-only").meta.name).toBe("remote v1");
    now += DAY - 1;
    expect((await load(opts)).fragment("remote-only").meta.name).toBe("remote v1");
    expect(calls).toBe(1);
    now += 2;
    expect((await load(opts)).fragment("remote-only").meta.name).toBe("remote v2");
    expect(calls).toBe(2);
  });

  it("uses the stale cache with a warning when a refresh fails", async () => {
    let now = 0;
    await load({ offline: false, now: () => now, fetchRemote: async (_s, d) => fragment(d, "r") });
    now += 2 * DAY;
    const reg = await load({ offline: false, now: () => now, fetchRemote: noFetch });
    expect(reg.fragment("r").origin).toBe("registry");
    expect(reg.warnings.join("\n")).toMatch(/couldn't refresh the registry.*Using the cached copy/);
  });

  it("skips the origin with a warning when the first fetch fails", async () => {
    const reg = await load({ offline: false, fetchRemote: noFetch });
    expect(reg.fragment("x").origin).toBe("bundled");
    expect(reg.warnings.join("\n")).toMatch(/couldn't fetch the registry.*bundled entries only/);
    expect(reg.warnings.join("\n")).toContain("OPENSCAFFOLD_OFFLINE=1");
  });

  it("backs off after a failure instead of retrying on every command", async () => {
    let calls = 0;
    const failing: FetchRemote = async () => {
      calls++;
      throw new Error("offline");
    };
    let now = 0;
    await load({ offline: false, fetchRemote: failing, now: () => now });
    now += 60_000;
    const reg = await load({ offline: false, fetchRemote: failing, now: () => now });
    expect(calls).toBe(1);
    expect(reg.warnings).toEqual([]);
  });

  it("treats a download without stacks/ or fragments/ as a failure", async () => {
    const reg = await load({
      offline: false,
      fetchRemote: async (_s, d) => write(join(d, "README"), ""),
    });
    expect(reg.warnings.join("\n")).toContain("no stacks/ or fragments/");
  });

  it("OPENSCAFFOLD_OFFLINE=1 skips fetching but still uses the cache", async () => {
    await load({ offline: false, fetchRemote: async (_s, d) => fragment(d, "cached") });
    vi.stubEnv("OPENSCAFFOLD_OFFLINE", "1");
    let called = false;
    const reg = await loadRegistry({
      cwd,
      home,
      bundledDir: bundled,
      now: () => 10 * DAY,
      fetchRemote: async () => {
        called = true;
      },
    });
    expect(called).toBe(false);
    expect(reg.fragment("cached").origin).toBe("registry");
    expect(reg.warnings).toEqual([]);
  });

  it("reads the registry source from user config, with registrySource taking priority", async () => {
    write(join(home, ".openscaffold", "config.yaml"), "registry: gh:me/fork/registry#dev\n");
    const seen: string[] = [];
    const fetchRemote: FetchRemote = async (source, dest) => {
      seen.push(source);
      fragment(dest, "z");
    };
    await load({ offline: false, fetchRemote });
    await load({ offline: false, fetchRemote, registrySource: "gh:other/repo/registry" });
    expect(seen).toEqual(["gh:me/fork/registry#dev", "gh:other/repo/registry"]);
  });
});
