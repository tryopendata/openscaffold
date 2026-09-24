import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { UserConfig } from "./schema/index.js";

/** "My Cool App" -> "my-cool-app". Falls back to "project" when nothing usable is left. */
export function slugify(name: string): string {
  const slug = name
    .replace(/^@[^/]+\//, "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

/** `git config user.name`, or undefined when git is missing or the name isn't set. */
export function gitUserName(): string | undefined {
  try {
    const name = execFileSync("git", ["config", "user.name"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return name || undefined;
  } catch {
    return undefined;
  }
}

function readText(path: string): string | undefined {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Best guess at an existing repo's project name: package.json name (scope stripped),
 * pyproject.toml [project].name, the last segment of go.mod's module path, else the dir name.
 */
export function inferProjectName(dir: string): string {
  const pkg = readText(join(dir, "package.json"));
  if (pkg) {
    try {
      const name = (JSON.parse(pkg) as { name?: unknown }).name;
      if (typeof name === "string" && name) return name.replace(/^@[^/]+\//, "");
    } catch {
      // not JSON; fall through
    }
  }
  const pyproject = readText(join(dir, "pyproject.toml"));
  if (pyproject) {
    const section = /^\[project\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(pyproject)?.[1] ?? "";
    const name = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(section)?.[1];
    if (name) return name;
  }
  const gomod = readText(join(dir, "go.mod"));
  if (gomod) {
    const module = /^\s*module\s+(\S+)/m.exec(gomod)?.[1];
    // A major-version suffix (`.../widget/v2`) isn't the name; take the segment before it.
    const last = module
      ?.replace(/\/v\d+\/?$/, "")
      .split("/")
      .filter(Boolean)
      .pop();
    if (last) return last;
  }
  return basename(dir);
}

export interface VarsInput {
  /** Project directory (absolute). */
  dir: string;
  name?: string;
  scope?: string;
  author?: string;
  config: Pick<UserConfig, "author" | "package_scope">;
  /** Injected for tests; defaults to `git config user.name`. */
  gitUserName?: () => string | undefined;
  now?: Date;
}

/** Template variables (see TEMPLATE_VARS). */
export function buildVars(input: VarsInput): Record<string, string> {
  const projectName = input.name?.trim() || basename(input.dir);
  const slug = slugify(projectName);
  return {
    project_name: projectName,
    project_slug: slug,
    package_scope: input.scope ?? input.config.package_scope ?? slug,
    author: input.author ?? input.config.author ?? (input.gitUserName ?? gitUserName)() ?? "",
    year: String((input.now ?? new Date()).getFullYear()),
  };
}
