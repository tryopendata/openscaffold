import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root: works from src/ (dev, tests) and dist/ (published). */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export const VERSION: string = (
  JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }
).version;

/** Registry bundled in the npm package. */
export const BUNDLED_REGISTRY = join(PACKAGE_ROOT, "registry");
