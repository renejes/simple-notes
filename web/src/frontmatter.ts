// YAML frontmatter handling. The on-disk MD format is:
//
//   ---
//   created: 2026-05-11T14:30:00Z
//   modified: 2026-05-11T15:00:00Z
//   ---
//   # Note Title
//   ...body...
//
// We strip the frontmatter before passing MD to BlockNote's parser, and we
// inject/update it on save. This keeps the editor surface clean while
// preserving Obsidian-compatible metadata in the file.

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
    // Malformed frontmatter — treat as no frontmatter, keep body intact.
    return { frontmatter: {}, body: md };
  }
  return { frontmatter, body: md.slice(m[0].length) };
}

export function joinFrontmatter(fm: Frontmatter, body: string): string {
  if (Object.keys(fm).length === 0) return body;
  const yaml = stringify(fm).trimEnd();
  return `---\n${yaml}\n---\n\n${body.replace(/^\n+/, "")}`;
}

// Stamp the modified date and (if not already present) created date.
// Pass through any other frontmatter keys unchanged.
export function stampDates(fm: Frontmatter): Frontmatter {
  const now = new Date().toISOString();
  return {
    ...fm,
    created: fm.created ?? now,
    modified: now,
  };
}
