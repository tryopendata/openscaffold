import { parse } from "yaml";
import { OpenScaffoldError } from "./errors.js";

export interface ParsedDoc {
  data: unknown;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Split a markdown file into YAML frontmatter and body. */
export function parseFrontmatter(source: string, file: string): ParsedDoc {
  const match = FENCE.exec(source);
  if (!match) {
    throw new OpenScaffoldError(
      "frontmatter_missing",
      `${file} has no YAML frontmatter`,
      "Start the file with a --- fenced YAML block (see docs/format.md).",
    );
  }
  try {
    return { data: parse(match[1] ?? ""), body: (match[2] ?? "").trim() };
  } catch (err) {
    throw new OpenScaffoldError(
      "frontmatter_invalid",
      `${file} frontmatter is not valid YAML: ${(err as Error).message}`,
    );
  }
}
