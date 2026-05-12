// YAML frontmatter helpers. Mirror of web/src/frontmatter.ts so both the
// browser app and the MCP server use the exact same format.

import { parse, stringify } from "yaml";

export type Frontmatter = Record<string, unknown>;

export type SplitMd = {
  frontmatter: Frontmatter;
  body: string;
};

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function splitFrontmatter(md: string): SplitMd {
  const m = md.match(FRONTMATTER_RE);
  if (!m) return { frontmatter: {}, body: md };
  let frontmatter: Frontmatter = {};
  try {
    const parsed = parse(m[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      frontmatter = parsed as Frontmatter;
    }
  } catch {
    return { frontmatter: {}, body: md };
  }
  return { frontmatter, body: md.slice(m[0].length) };
}

export function joinFrontmatter(fm: Frontmatter, body: string): string {
  if (Object.keys(fm).length === 0) return body;
  const yaml = stringify(fm).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, "")}`;
}

export function stampDates(fm: Frontmatter): Frontmatter {
  const now = new Date().toISOString();
  return {
    ...fm,
    created: fm.created ?? now,
    modified: now,
  };
}
