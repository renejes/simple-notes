import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  stat,
  rm,
  rename,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const NOTES_ROOT = path.resolve(__dirname, "../notes");
const ATTACHMENTS_DIR = "_attachments";
const TRASH_DIR = ".trash";
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  txt: "text/plain",
  json: "application/json",
};

function resolveSafe(rel: string): string {
  const abs = path.resolve(NOTES_ROOT, rel);
  if (!abs.startsWith(NOTES_ROOT + path.sep) && abs !== NOTES_ROOT) {
    throw new Error("path escapes notes root");
  }
  return abs;
}

async function readBody(req: import("http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function readBinaryBody(
  req: import("http").IncomingMessage,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// Collect every /_attachments/... URL referenced from any .md file in the
// vault. Used by garbageCollect() to delete unreferenced sidecar files.
const ATTACHMENT_URL_RE = /\/_attachments\/[^\s)\]'"]+/g;

async function collectReferencedAttachments(): Promise<Set<string>> {
  const referenced = new Set<string>();
  async function walk(dir: string) {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      // Skip hidden dirs but include .trash so trashed notes keep their
      // attachments alive (so restore can recover them whole).
      if (e.name.startsWith(".") && e.name !== TRASH_DIR) continue;
      if (dir === NOTES_ROOT && e.name === ATTACHMENTS_DIR) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        try {
          const content = await readFile(full, "utf8");
          const matches = content.match(ATTACHMENT_URL_RE);
          if (matches) {
            for (const m of matches) {
              // Strip the /_attachments/ prefix AND any query string (we
              // attach `?size=wide` etc. to PDFs for round-trip state).
              const filename = m
                .replace(/^\/_attachments\//, "")
                .split("?")[0];
              referenced.add(decodeURIComponent(filename));
            }
          }
        } catch {
          /* skip unreadable */
        }
      }
    }
  }
  await walk(NOTES_ROOT);
  return referenced;
}

// Run-locked: a save burst should collapse into a single GC pass.
let gcRunning = false;
let gcScheduled = false;
async function scheduleGarbageCollect() {
  if (gcRunning) {
    gcScheduled = true;
    return;
  }
  gcRunning = true;
  try {
    await garbageCollect();
  } catch (err) {
    console.error("[notes-api] garbage collect failed", err);
  } finally {
    gcRunning = false;
    if (gcScheduled) {
      gcScheduled = false;
      scheduleGarbageCollect();
    }
  }
}

async function garbageCollect() {
  const attachmentsDir = path.join(NOTES_ROOT, ATTACHMENTS_DIR);
  let files: string[];
  try {
    files = await readdir(attachmentsDir);
  } catch {
    return; // no attachments dir yet
  }
  if (files.length === 0) return;

  const referenced = await collectReferencedAttachments();

  // If a handwrite-<uuid>.png is referenced, keep its .svg and .json
  // sidecars too — they aren't mentioned in MD but the editor needs them
  // for re-editing.
  const keep = new Set<string>(referenced);
  for (const r of referenced) {
    const m = r.match(/^(handwrite-[a-zA-Z0-9-]+)\.[a-z0-9]+$/i);
    if (m) {
      const stem = m[1];
      keep.add(`${stem}.png`);
      keep.add(`${stem}.svg`);
      keep.add(`${stem}.json`);
    }
  }

  let deleted = 0;
  for (const file of files) {
    if (keep.has(file)) continue;
    try {
      await rm(path.join(attachmentsDir, file), { force: true });
      deleted++;
    } catch {
      /* ignore */
    }
  }
  if (deleted > 0) {
    console.log(`[notes-api] GC: removed ${deleted} orphan attachment(s)`);
  }
}

// Cheap "is this MD file pinned" check: read the first ~512 bytes, look for
// `pinned: true` inside the YAML frontmatter. Avoids parsing every file's
// YAML on each tree fetch.
const PINNED_RE = /^---[\s\S]*?\n\s*pinned\s*:\s*true\b/;
async function isPinned(absPath: string): Promise<boolean> {
  try {
    const fh = await readFile(absPath, { encoding: "utf8" });
    return PINNED_RE.test(fh.slice(0, 1024));
  } catch {
    return false;
  }
}

async function listTree(dir: string, rel = ""): Promise<unknown> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (rel === "" && e.name === ATTACHMENTS_DIR) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push({
        type: "dir",
        name: e.name,
        path: childRel,
        children: await listTree(full, childRel),
      });
    } else if (e.isFile() && e.name.endsWith(".md")) {
      let mtime = 0;
      try {
        const s = await stat(full);
        mtime = s.mtimeMs;
      } catch {
        /* ignore */
      }
      const pinned = await isPinned(full);
      out.push({
        type: "file",
        name: e.name,
        path: childRel,
        mtime,
        ...(pinned ? { pinned: true } : {}),
      });
    }
  }
  return out;
}

function notesApi(): Plugin {
  return {
    name: "notes-api",
    configureServer(server) {
      server.middlewares.use("/api/tree", async (_req, res) => {
        try {
          await mkdir(NOTES_ROOT, { recursive: true });
          const tree = await listTree(NOTES_ROOT);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(tree));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      server.middlewares.use("/api/file", async (req, res) => {
        try {
          const url = new URL(req.url ?? "", "http://x");
          const rel = url.searchParams.get("path");
          if (!rel) {
            res.statusCode = 400;
            res.end("missing path");
            return;
          }
          const abs = resolveSafe(rel);

          if (req.method === "GET") {
            try {
              const content = await readFile(abs, "utf8");
              res.setHeader("Content-Type", "text/markdown");
              res.end(content);
            } catch (err: unknown) {
              if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                res.statusCode = 404;
                res.end("not found");
              } else throw err;
            }
            return;
          }

          if (req.method === "PUT") {
            await mkdir(path.dirname(abs), { recursive: true });
            const body = await readBody(req);
            await writeFile(abs, body, "utf8");
            const s = await stat(abs);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, mtime: s.mtimeMs }));
            scheduleGarbageCollect();
            return;
          }

          res.statusCode = 405;
          res.end("method not allowed");
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // Create directory (mkdir -p)
      server.middlewares.use("/api/dir", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          const url = new URL(req.url ?? "", "http://x");
          const rel = url.searchParams.get("path");
          if (!rel) {
            res.statusCode = 400;
            res.end("missing path");
            return;
          }
          const abs = resolveSafe(rel);
          await mkdir(abs, { recursive: true });
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // Soft-delete: move file or folder into .trash/<timestamp>__<encodedPath>
      // instead of removing it. Restore later via /api/trash/restore.
      server.middlewares.use("/api/path", async (req, res) => {
        try {
          if (req.method !== "DELETE") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          const url = new URL(req.url ?? "", "http://x");
          const rel = url.searchParams.get("path");
          if (!rel) {
            res.statusCode = 400;
            res.end("missing path");
            return;
          }
          const abs = resolveSafe(rel);
          if (abs === NOTES_ROOT) {
            res.statusCode = 400;
            res.end("refusing to delete notes root");
            return;
          }
          const trashAbs = path.join(NOTES_ROOT, TRASH_DIR);
          await mkdir(trashAbs, { recursive: true });
          const trashId = `${Date.now()}__${encodeURIComponent(rel)}`;
          const trashTarget = path.join(trashAbs, trashId);
          await rename(abs, trashTarget);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, trashId }));
          scheduleGarbageCollect();
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // List trash entries — decoded original path, deletion timestamp.
      // NOTE: Vite middleware matches by path prefix in registration order,
      // so we must hand off subpaths like `/restore` to later handlers.
      server.middlewares.use("/api/trash", async (req, res, next) => {
        try {
          // req.url is path-relative to the mount point; subpath = real path
          // after `/api/trash`. Anything other than "/" or "/?..." should be
          // routed by a later, more specific handler.
          const subpath = (req.url ?? "/").split("?")[0];
          if (subpath !== "/" && subpath !== "") {
            next();
            return;
          }
          if (req.method === "GET") {
            const trashAbs = path.join(NOTES_ROOT, TRASH_DIR);
            let entries: import("node:fs").Dirent[];
            try {
              entries = await readdir(trashAbs, { withFileTypes: true });
            } catch {
              entries = [];
            }
            const items = entries
              .filter((e) => !e.name.startsWith("."))
              .map((e) => {
                const i = e.name.indexOf("__");
                const tsRaw =
                  i > 0 ? parseInt(e.name.slice(0, i), 10) : NaN;
                const origRaw = i > 0 ? e.name.slice(i + 2) : e.name;
                let original = origRaw;
                try {
                  original = decodeURIComponent(origRaw);
                } catch {
                  /* ignore */
                }
                return {
                  trashId: e.name,
                  originalPath: original,
                  deletedAt: isNaN(tsRaw) ? 0 : tsRaw,
                  type: e.isDirectory() ? "dir" : "file",
                };
              })
              .sort((a, b) => b.deletedAt - a.deletedAt);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify(items));
            return;
          }
          // DELETE = empty trash (purge everything)
          if (req.method === "DELETE") {
            const trashAbs = path.join(NOTES_ROOT, TRASH_DIR);
            await rm(trashAbs, { recursive: true, force: true });
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
            scheduleGarbageCollect();
            return;
          }
          res.statusCode = 405;
          res.end("method not allowed");
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // Restore one trashed entry to its original path. If something already
      // exists at the original path, we append `-restored` to avoid clobber.
      server.middlewares.use("/api/trash/restore", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          const url = new URL(req.url ?? "", "http://x");
          const trashId = url.searchParams.get("id");
          if (!trashId || trashId.includes("/") || trashId.includes("..")) {
            res.statusCode = 400;
            res.end("bad id");
            return;
          }
          const trashAbs = path.join(NOTES_ROOT, TRASH_DIR, trashId);
          const i = trashId.indexOf("__");
          const origRaw = i > 0 ? trashId.slice(i + 2) : trashId;
          let originalRel: string;
          try {
            originalRel = decodeURIComponent(origRaw);
          } catch {
            res.statusCode = 400;
            res.end("bad id");
            return;
          }
          let targetAbs = resolveSafe(originalRel);
          // If target already exists, append -restored to disambiguate.
          try {
            await stat(targetAbs);
            const ext = path.extname(originalRel);
            const stem = originalRel.slice(0, originalRel.length - ext.length);
            originalRel = `${stem}-restored${ext}`;
            targetAbs = resolveSafe(originalRel);
          } catch {
            /* doesn't exist — original path is free */
          }
          await mkdir(path.dirname(targetAbs), { recursive: true });
          await rename(trashAbs, targetAbs);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, restoredTo: originalRel }));
          scheduleGarbageCollect();
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // Upload an attachment (raw bytes in body, ?ext=png in query).
      // Optional ?name=foo gives a predictable filename (used by the handwrite
      // flow to share one UUID across PNG + SVG sidecars).
      server.middlewares.use("/api/upload", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          const url = new URL(req.url ?? "", "http://x");
          const ext = (url.searchParams.get("ext") ?? "bin")
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "")
            .slice(0, 8) || "bin";
          const requestedName = url.searchParams.get("name");
          const safeName = requestedName
            ? requestedName.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64)
            : "";
          const stem = safeName || randomUUID();
          const filename = `${stem}.${ext}`;
          const absDir = path.join(NOTES_ROOT, ATTACHMENTS_DIR);
          await mkdir(absDir, { recursive: true });
          const abs = path.join(absDir, filename);
          const body = await readBinaryBody(req);
          await writeFile(abs, body);
          const publicUrl = `/${ATTACHMENTS_DIR}/${filename}`;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ url: publicUrl }));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // Serve attachments from disk
      server.middlewares.use(`/${ATTACHMENTS_DIR}`, async (req, res) => {
        try {
          if (req.method !== "GET" && req.method !== "HEAD") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          const url = new URL(req.url ?? "", "http://x");
          // url.pathname looks like "/<filename>" because middleware strips the prefix
          const name = decodeURIComponent(
            url.pathname.replace(/^\/+/, ""),
          );
          if (!name || name.includes("/") || name.includes("..")) {
            res.statusCode = 400;
            res.end("bad name");
            return;
          }
          const abs = path.join(NOTES_ROOT, ATTACHMENTS_DIR, name);
          try {
            const s = await stat(abs);
            const ext = path.extname(name).slice(1).toLowerCase();
            const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
            res.setHeader("Content-Type", mime);
            res.setHeader("Content-Length", String(s.size));
            // no-cache so re-edits of handwriting (same URL, new content)
            // show fresh content after browser revalidates.
            res.setHeader("Cache-Control", "no-cache");
            if (req.method === "HEAD") {
              res.end();
              return;
            }
            createReadStream(abs).pipe(res);
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              res.statusCode = 404;
              res.end("not found");
            } else throw err;
          }
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // Tags: collect all #tag occurrences across .md files with usage counts.
      server.middlewares.use("/api/tags", async (req, res) => {
        try {
          if (req.method !== "GET") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          const counts = new Map<string, number>();
          const TAG_RE = /(?<![\w])#([\w][\w\-/]*)/g;

          async function walk(dir: string) {
            let entries: import("node:fs").Dirent[];
            try {
              entries = await readdir(dir, { withFileTypes: true });
            } catch {
              return;
            }
            for (const e of entries) {
              if (e.name.startsWith(".")) continue;
              if (dir === NOTES_ROOT && e.name === ATTACHMENTS_DIR) continue;
              const full = path.join(dir, e.name);
              if (e.isDirectory()) {
                await walk(full);
              } else if (e.isFile() && e.name.endsWith(".md")) {
                try {
                  const content = await readFile(full, "utf8");
                  // Strip headings so `# Heading` is never read as a tag.
                  const cleaned = content
                    .split("\n")
                    .filter((l) => !/^\s{0,3}#{1,6}\s/.test(l))
                    .join("\n");
                  TAG_RE.lastIndex = 0;
                  let m: RegExpExecArray | null;
                  while ((m = TAG_RE.exec(cleaned)) !== null) {
                    const name = m[1];
                    counts.set(name, (counts.get(name) ?? 0) + 1);
                  }
                } catch {
                  /* skip */
                }
              }
            }
          }
          await walk(NOTES_ROOT);

          const list = Array.from(counts.entries())
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) =>
              b.count - a.count || a.tag.localeCompare(b.tag),
            );
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(list));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // Flat list of every Markdown heading across all notes. Used by the
      // slash menu to offer `[[Note#Heading]]` anchor links.
      // Returns [{ path, heading, level }].
      server.middlewares.use("/api/headings", async (req, res) => {
        try {
          if (req.method !== "GET") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          const results: { path: string; heading: string; level: number }[] =
            [];
          const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

          async function walk(dir: string) {
            let entries: import("node:fs").Dirent[];
            try {
              entries = await readdir(dir, { withFileTypes: true });
            } catch {
              return;
            }
            for (const e of entries) {
              if (e.name.startsWith(".")) continue;
              if (dir === NOTES_ROOT && e.name === ATTACHMENTS_DIR) continue;
              const full = path.join(dir, e.name);
              if (e.isDirectory()) {
                await walk(full);
              } else if (e.isFile() && e.name.endsWith(".md")) {
                const rel = path
                  .relative(NOTES_ROOT, full)
                  .split(path.sep)
                  .join("/");
                try {
                  const content = await readFile(full, "utf8");
                  // Skip frontmatter if present so we don't treat YAML keys
                  // (which start with no `#`) or stray markers as headings.
                  const body = content.replace(/^---[\s\S]*?\n---\n?/, "");
                  const lines = body.split("\n");
                  let inFence = false;
                  for (const line of lines) {
                    if (/^\s*```/.test(line)) {
                      inFence = !inFence;
                      continue;
                    }
                    if (inFence) continue;
                    const m = line.match(HEADING_RE);
                    if (m) {
                      results.push({
                        path: rel,
                        heading: m[2].trim(),
                        level: m[1].length,
                      });
                    }
                  }
                } catch {
                  /* skip */
                }
              }
            }
          }
          await walk(NOTES_ROOT);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(results));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // Aggregate every open `- [ ]` task across all notes. Returns
      // [{ path, line, text }] — `line` is 1-indexed for deep-link display.
      server.middlewares.use("/api/tasks", async (req, res) => {
        try {
          if (req.method !== "GET") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          const results: { path: string; line: number; text: string }[] = [];
          // Markdown checkbox at start of a list item: `- [ ]` (or `* [ ]`).
          // Skip checked items (`- [x]`).
          const TASK_RE = /^\s*[-*]\s+\[\s\]\s+(.*)$/;

          async function walk(dir: string) {
            let entries: import("node:fs").Dirent[];
            try {
              entries = await readdir(dir, { withFileTypes: true });
            } catch {
              return;
            }
            for (const e of entries) {
              if (e.name.startsWith(".")) continue;
              if (dir === NOTES_ROOT && e.name === ATTACHMENTS_DIR) continue;
              const full = path.join(dir, e.name);
              if (e.isDirectory()) {
                await walk(full);
              } else if (e.isFile() && e.name.endsWith(".md")) {
                const rel = path
                  .relative(NOTES_ROOT, full)
                  .split(path.sep)
                  .join("/");
                try {
                  const content = await readFile(full, "utf8");
                  const lines = content.split("\n");
                  for (let i = 0; i < lines.length; i++) {
                    const m = lines[i].match(TASK_RE);
                    if (m) {
                      results.push({
                        path: rel,
                        line: i + 1,
                        text: m[1].trim(),
                      });
                    }
                  }
                } catch {
                  /* skip */
                }
              }
            }
          }
          await walk(NOTES_ROOT);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(results));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // Full-text search: case-insensitive substring match across all .md
      // files. Returns one snippet per matching file (the first match).
      server.middlewares.use("/api/search", async (req, res) => {
        try {
          if (req.method !== "GET") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          const url = new URL(req.url ?? "", "http://x");
          const q = (url.searchParams.get("q") || "").trim();
          if (!q) {
            res.setHeader("Content-Type", "application/json");
            res.end("[]");
            return;
          }
          const qLower = q.toLowerCase();
          const results: { path: string; snippet: string }[] = [];

          async function walk(dir: string) {
            let entries: import("node:fs").Dirent[];
            try {
              entries = await readdir(dir, { withFileTypes: true });
            } catch {
              return;
            }
            for (const e of entries) {
              if (e.name.startsWith(".")) continue;
              if (dir === NOTES_ROOT && e.name === ATTACHMENTS_DIR) continue;
              const full = path.join(dir, e.name);
              if (e.isDirectory()) {
                await walk(full);
              } else if (e.isFile() && e.name.endsWith(".md")) {
                const rel = path
                  .relative(NOTES_ROOT, full)
                  .split(path.sep)
                  .join("/");
                try {
                  const content = await readFile(full, "utf8");
                  const lines = content.split("\n");
                  for (const line of lines) {
                    const idx = line.toLowerCase().indexOf(qLower);
                    if (idx >= 0) {
                      const start = Math.max(0, idx - 40);
                      const end = Math.min(line.length, idx + q.length + 80);
                      let snippet = line.slice(start, end).trim();
                      if (start > 0) snippet = "…" + snippet;
                      if (end < line.length) snippet = snippet + "…";
                      results.push({ path: rel, snippet });
                      break;
                    }
                  }
                } catch {
                  /* skip */
                }
              }
            }
          }

          await walk(NOTES_ROOT);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(results));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // Backlinks: list every note containing [[<target>]] wikilink syntax.
      // target is the path-without-.md (e.g. "Ideen/Test 2").
      server.middlewares.use("/api/backlinks", async (req, res) => {
        try {
          if (req.method !== "GET") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          const url = new URL(req.url ?? "", "http://x");
          const target = url.searchParams.get("target");
          if (!target) {
            res.statusCode = 400;
            res.end("missing target");
            return;
          }
          const selfMdPath = `${target}.md`;
          const results: { path: string; snippet: string }[] = [];

          async function walk(dir: string) {
            let entries: import("node:fs").Dirent[];
            try {
              entries = await readdir(dir, { withFileTypes: true });
            } catch {
              return;
            }
            for (const e of entries) {
              if (e.name.startsWith(".")) continue;
              if (dir === NOTES_ROOT && e.name === ATTACHMENTS_DIR) continue;
              const full = path.join(dir, e.name);
              if (e.isDirectory()) {
                await walk(full);
              } else if (e.isFile() && e.name.endsWith(".md")) {
                const rel = path
                  .relative(NOTES_ROOT, full)
                  .split(path.sep)
                  .join("/");
                if (rel === selfMdPath) continue; // skip self
                try {
                  const content = await readFile(full, "utf8");
                  const lines = content.split("\n");
                  for (const line of lines) {
                    const re = /\[\[([^\]]+)\]\]/g;
                    let m: RegExpExecArray | null;
                    let matched = false;
                    while ((m = re.exec(line)) !== null) {
                      if (m[1] === target) {
                        results.push({
                          path: rel,
                          snippet: line.trim().slice(0, 240),
                        });
                        matched = true;
                        break;
                      }
                    }
                    if (matched) break; // one snippet per file is enough
                  }
                } catch {
                  /* skip unreadable */
                }
              }
            }
          }

          await walk(NOTES_ROOT);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(results));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });

      // Rename / move file or folder
      server.middlewares.use("/api/rename", async (req, res) => {
        try {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          const body = await readBody(req);
          const { from, to } = JSON.parse(body) as {
            from?: string;
            to?: string;
          };
          if (!from || !to) {
            res.statusCode = 400;
            res.end("missing from/to");
            return;
          }
          const absFrom = resolveSafe(from);
          const absTo = resolveSafe(to);
          if (absFrom === absTo) {
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, noop: true }));
            return;
          }
          // Refuse overwrite — moving onto an existing path is almost always
          // an accident (drag-drop, rename collision).
          try {
            await stat(absTo);
            res.statusCode = 409;
            res.end("target already exists");
            return;
          } catch {
            /* good — target doesn't exist */
          }
          await mkdir(path.dirname(absTo), { recursive: true });
          await rename(absFrom, absTo);
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), notesApi()],
});
