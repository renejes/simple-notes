// Filesystem operations against the notes vault. Mirrors the Vite middleware
// in web/vite.config.ts so both the web app and the MCP server work against
// the same on-disk conventions.

import {
  readdir,
  readFile,
  writeFile,
  mkdir,
  stat,
  rename,
} from "node:fs/promises";
import path from "node:path";
import {
  type Frontmatter,
  joinFrontmatter,
  splitFrontmatter,
  stampDates,
} from "./frontmatter.js";

const ATTACHMENTS_DIR = "_attachments";
const TRASH_DIR = ".trash";

export function getNotesRoot(): string {
  const root = process.env.NOTES_ROOT;
  if (!root) {
    throw new Error(
      "NOTES_ROOT environment variable is required (absolute path to the notes folder).",
    );
  }
  return path.resolve(root);
}

function resolveSafe(rel: string): string {
  const root = getNotesRoot();
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    throw new Error(`Path escapes notes root: ${rel}`);
  }
  return abs;
}

function relFromRoot(abs: string): string {
  const root = getNotesRoot();
  return path.relative(root, abs).split(path.sep).join("/");
}

export type NoteEntry = {
  path: string;
  name: string;
  mtime: number;
  pinned?: boolean;
  tags?: string[];
};

async function isPinned(abs: string): Promise<boolean> {
  try {
    const head = (await readFile(abs, "utf8")).slice(0, 1024);
    return /^---[\s\S]*?\n\s*pinned\s*:\s*true\b/.test(head);
  } catch {
    return false;
  }
}

// Walk every `.md` file under the vault (excluding _attachments and dotfiles
// like .trash). Yields paths relative to the root.
export async function* walkNotes(
  subdir = "",
  options: { includeTrash?: boolean } = {},
): AsyncGenerator<string> {
  const root = getNotesRoot();
  async function* walk(dir: string): AsyncGenerator<string> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && !(options.includeTrash && e.name === TRASH_DIR))
        continue;
      if (dir === root && e.name === ATTACHMENTS_DIR) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        yield* walk(full);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        yield relFromRoot(full);
      }
    }
  }
  yield* walk(subdir ? path.join(root, subdir) : root);
}

export async function listNotes(opts: {
  folder?: string;
  withMetadata?: boolean;
}): Promise<NoteEntry[]> {
  const out: NoteEntry[] = [];
  for await (const rel of walkNotes(opts.folder ?? "")) {
    const abs = resolveSafe(rel);
    const s = await stat(abs);
    const entry: NoteEntry = {
      path: rel,
      name: path.basename(rel).replace(/\.md$/, ""),
      mtime: s.mtimeMs,
    };
    if (opts.withMetadata) {
      try {
        const content = await readFile(abs, "utf8");
        const { frontmatter } = splitFrontmatter(content);
        if (frontmatter.pinned === true) entry.pinned = true;
        if (Array.isArray(frontmatter.tags)) {
          entry.tags = (frontmatter.tags as unknown[]).filter(
            (t): t is string => typeof t === "string",
          );
        }
      } catch {
        /* skip */
      }
    } else {
      if (await isPinned(abs)) entry.pinned = true;
    }
    out.push(entry);
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

export async function readNote(rel: string): Promise<{
  path: string;
  frontmatter: Frontmatter;
  body: string;
  raw: string;
}> {
  const cleaned = rel.endsWith(".md") ? rel : `${rel}.md`;
  const abs = resolveSafe(cleaned);
  const raw = await readFile(abs, "utf8");
  const { frontmatter, body } = splitFrontmatter(raw);
  return { path: cleaned, frontmatter, body, raw };
}

export async function createNote(
  rel: string,
  body: string,
  extraFrontmatter?: Frontmatter,
): Promise<{ path: string }> {
  const cleaned = rel.endsWith(".md") ? rel : `${rel}.md`;
  const abs = resolveSafe(cleaned);
  try {
    await stat(abs);
    throw new Error(`Note already exists: ${cleaned}`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await mkdir(path.dirname(abs), { recursive: true });
  const fm = stampDates({ ...(extraFrontmatter ?? {}) });
  await writeFile(abs, joinFrontmatter(fm, body), "utf8");
  return { path: cleaned };
}

export async function updateNote(
  rel: string,
  body: string,
  options: { mergeFrontmatter?: Frontmatter } = {},
): Promise<{ path: string }> {
  const cleaned = rel.endsWith(".md") ? rel : `${rel}.md`;
  const abs = resolveSafe(cleaned);
  let existingFm: Frontmatter = {};
  try {
    const raw = await readFile(abs, "utf8");
    existingFm = splitFrontmatter(raw).frontmatter;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const fm = stampDates({ ...existingFm, ...(options.mergeFrontmatter ?? {}) });
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, joinFrontmatter(fm, body), "utf8");
  return { path: cleaned };
}

export async function appendToNote(
  rel: string,
  appended: string,
): Promise<{ path: string }> {
  const cleaned = rel.endsWith(".md") ? rel : `${rel}.md`;
  const abs = resolveSafe(cleaned);
  let body = "";
  let fm: Frontmatter = {};
  try {
    const raw = await readFile(abs, "utf8");
    const split = splitFrontmatter(raw);
    body = split.body;
    fm = split.frontmatter;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const sep = body.endsWith("\n") || body === "" ? "" : "\n";
  const next = body + sep + (body && !body.endsWith("\n\n") ? "\n" : "") + appended;
  const stamped = stampDates(fm);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, joinFrontmatter(stamped, next), "utf8");
  return { path: cleaned };
}

export async function moveNote(
  from: string,
  to: string,
): Promise<{ from: string; to: string }> {
  const absFrom = resolveSafe(from.endsWith(".md") ? from : `${from}.md`);
  const absTo = resolveSafe(to.endsWith(".md") ? to : `${to}.md`);
  if (absFrom === absTo) return { from, to };
  try {
    await stat(absTo);
    throw new Error(`Target already exists: ${to}`);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await mkdir(path.dirname(absTo), { recursive: true });
  await rename(absFrom, absTo);
  return { from, to };
}

export async function searchNotes(
  query: string,
  options: { limit?: number } = {},
): Promise<Array<{ path: string; snippet: string }>> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const limit = options.limit ?? 50;
  const out: Array<{ path: string; snippet: string }> = [];
  for await (const rel of walkNotes("")) {
    if (out.length >= limit) break;
    try {
      const content = await readFile(resolveSafe(rel), "utf8");
      const lines = content.split("\n");
      for (const line of lines) {
        const idx = line.toLowerCase().indexOf(q);
        if (idx >= 0) {
          const start = Math.max(0, idx - 40);
          const end = Math.min(line.length, idx + q.length + 80);
          let snippet = line.slice(start, end).trim();
          if (start > 0) snippet = "…" + snippet;
          if (end < line.length) snippet = snippet + "…";
          out.push({ path: rel, snippet });
          break;
        }
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function findByTag(
  tag: string,
): Promise<Array<{ path: string; snippet: string }>> {
  const t = tag.replace(/^#/, "");
  const tagLower = t.toLowerCase();
  const re = /(?<![\w])#([\w][\w\-/]*)/g;
  const out: Array<{ path: string; snippet: string }> = [];
  for await (const rel of walkNotes("")) {
    try {
      const content = await readFile(resolveSafe(rel), "utf8");
      const stripped = content
        .split("\n")
        .filter((l) => !/^\s{0,3}#{1,6}\s/.test(l))
        .join("\n");
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      let found = false;
      while ((match = re.exec(stripped)) !== null) {
        if (match[1].toLowerCase() === tagLower) {
          // Find the original line for snippet
          const allLines = content.split("\n");
          let snippet = match[0];
          for (const ln of allLines) {
            if (ln.includes(match[0])) {
              snippet = ln.trim().slice(0, 200);
              break;
            }
          }
          out.push({ path: rel, snippet });
          found = true;
          break;
        }
      }
      if (!found) {
        // try next file
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function findBacklinks(
  target: string,
): Promise<Array<{ path: string; snippet: string }>> {
  const t = target.replace(/\.md$/, "");
  const re = /\[\[([^\]]+)\]\]/g;
  const out: Array<{ path: string; snippet: string }> = [];
  for await (const rel of walkNotes("")) {
    if (rel === `${t}.md`) continue;
    try {
      const content = await readFile(resolveSafe(rel), "utf8");
      const lines = content.split("\n");
      let found: string | null = null;
      for (const line of lines) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          const target = m[1].split("#")[0];
          if (target === t) {
            found = line.trim().slice(0, 240);
            break;
          }
        }
        if (found) break;
      }
      if (found) out.push({ path: rel, snippet: found });
    } catch {
      /* skip */
    }
  }
  return out;
}

export async function listTags(): Promise<Array<{ tag: string; count: number }>> {
  const counts = new Map<string, number>();
  const re = /(?<![\w])#([\w][\w\-/]*)/g;
  for await (const rel of walkNotes("")) {
    try {
      const content = await readFile(resolveSafe(rel), "utf8");
      const stripped = content
        .split("\n")
        .filter((l) => !/^\s{0,3}#{1,6}\s/.test(l))
        .join("\n");
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(stripped)) !== null) {
        counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
      }
    } catch {
      /* skip */
    }
  }
  return Array.from(counts.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export async function listOpenTasks(): Promise<
  Array<{ path: string; line: number; text: string }>
> {
  const out: Array<{ path: string; line: number; text: string }> = [];
  const re = /^\s*[-*]\s+\[\s\]\s+(.*)$/;
  for await (const rel of walkNotes("")) {
    try {
      const content = await readFile(resolveSafe(rel), "utf8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (m) {
          out.push({ path: rel, line: i + 1, text: m[1].trim() });
        }
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

export function dailyNotePath(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `Daily/${y}-${m}-${d}.md`;
}

export async function getOrCreateDailyNote(): Promise<{
  path: string;
  frontmatter: Frontmatter;
  body: string;
  created: boolean;
}> {
  const rel = dailyNotePath();
  const abs = resolveSafe(rel);
  try {
    await stat(abs);
    const note = await readNote(rel);
    return { ...note, created: false };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const today = new Date().toLocaleDateString("de-DE", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
  await createNote(rel, `# ${today}\n\n`);
  const note = await readNote(rel);
  return { ...note, created: true };
}
