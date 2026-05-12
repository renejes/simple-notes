import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import {
  filterSuggestionItems,
  insertOrUpdateBlockForSlashMenu,
} from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import {
  getDefaultReactSlashMenuItems,
  SuggestionMenuController,
  useCreateBlockNote,
} from "@blocknote/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { makePdfSlashItem, rehydratePdfLinks, schema } from "./pdfBlock";
import {
  rehydrateHandwriteImages,
  setHandwriteEditCallback,
} from "./handwriteBlock";
import { HandwriteModal, type Stroke } from "./handwriteModal";
import { BacklinksPanel } from "./backlinksPanel";
import { CommandPalette } from "./commandPalette";
import {
  fetchAllTags,
  rehydrateTags,
  setTagClickCallback,
} from "./tagInline";
import { TagPanel } from "./tagPanel";
import { TrashModal } from "./trashModal";
import { MoveModal } from "./moveModal";
import { TasksModal } from "./tasksModal";
import { uploadBlockNoteFile } from "./upload";
import {
  type Frontmatter,
  joinFrontmatter,
  splitFrontmatter,
  stampDates,
} from "./frontmatter";
import {
  rehydrateWikilinks,
  setWikilinkClickCallback,
  setWikilinkClickCallbackV2,
  unescapeWikilinks,
} from "./wikilinkInline";
import "./App.css";

const SAVE_DEBOUNCE_MS = 800;

type Entry =
  | {
      type: "file";
      name: string;
      path: string;
      mtime?: number;
      pinned?: boolean;
    }
  | { type: "dir"; name: string; path: string; children: Entry[] };

function collectPinnedFiles(entries: Entry[]): Entry[] {
  const out: Entry[] = [];
  for (const e of entries) {
    if (e.type === "file" && e.pinned) out.push(e);
    else if (e.type === "dir") out.push(...collectPinnedFiles(e.children));
  }
  return out;
}

type SortOption = "name-asc" | "name-desc" | "modified-desc" | "modified-asc";
const SORT_OPTIONS: Array<{ value: SortOption; label: string }> = [
  { value: "name-asc", label: "Name A→Z" },
  { value: "name-desc", label: "Name Z→A" },
  { value: "modified-desc", label: "Zuletzt geändert" },
  { value: "modified-asc", label: "Älteste zuerst" },
];

function sortTree(entries: Entry[], sortBy: SortOption): Entry[] {
  const dirs: Entry[] = [];
  const files: Entry[] = [];
  for (const e of entries) {
    if (e.type === "dir") dirs.push(e);
    else files.push(e);
  }
  // Folders always alphabetical, files by chosen sort.
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => {
    switch (sortBy) {
      case "name-desc":
        return b.name.localeCompare(a.name);
      case "modified-desc":
        return (b.mtime ?? 0) - (a.mtime ?? 0);
      case "modified-asc":
        return (a.mtime ?? 0) - (b.mtime ?? 0);
      default:
        return a.name.localeCompare(b.name);
    }
  });
  return [
    ...dirs.map((d) =>
      d.type === "dir"
        ? { ...d, children: sortTree(d.children, sortBy) }
        : d,
    ),
    ...files,
  ];
}

const RECENT_KEY = "notes-app:recent";
const SORT_KEY = "notes-app:sort";
const RECENT_LIMIT = 10;

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
function saveRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* ignore quota issues */
  }
}
function loadSort(): SortOption {
  try {
    const raw = localStorage.getItem(SORT_KEY);
    if (
      raw === "name-asc" ||
      raw === "name-desc" ||
      raw === "modified-desc" ||
      raw === "modified-asc"
    )
      return raw;
  } catch {
    /* ignore */
  }
  return "name-asc";
}

function dailyNotePath(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `Daily/${y}-${m}-${d}.md`;
}

// Recursively count words across BlockNote's block tree. Skips inline
// content that isn't user-visible text (wikilinks/tags surface as metadata).
function countWordsInBlocks(blocks: unknown[]): number {
  let n = 0;
  function add(text: unknown) {
    if (typeof text !== "string") return;
    const m = text.match(/\S+/g);
    if (m) n += m.length;
  }
  function walkInline(arr: unknown[]) {
    for (const c of arr) {
      const inline = c as { type?: string; text?: unknown; content?: unknown };
      if (inline?.type === "text") add(inline.text);
      else if (inline?.type === "link" && Array.isArray(inline.content)) {
        walkInline(inline.content);
      }
    }
  }
  for (const b of blocks) {
    const block = b as { content?: unknown; children?: unknown };
    if (Array.isArray(block.content)) walkInline(block.content);
    if (Array.isArray(block.children)) {
      n += countWordsInBlocks(block.children);
    }
  }
  return n;
}

function extractBlockText(block: unknown): string {
  const b = block as { content?: unknown };
  if (!Array.isArray(b.content)) return "";
  let t = "";
  for (const c of b.content) {
    const inline = c as { type?: string; text?: unknown; content?: unknown };
    if (inline?.type === "text" && typeof inline.text === "string") {
      t += inline.text;
    } else if (inline?.type === "link" && Array.isArray(inline.content)) {
      for (const sub of inline.content) {
        const s = sub as { type?: string; text?: unknown };
        if (s?.type === "text" && typeof s.text === "string") t += s.text;
      }
    }
  }
  return t;
}

type Heading = { id: string; level: number; text: string };

function extractHeadings(blocks: unknown[]): Heading[] {
  const out: Heading[] = [];
  for (const b of blocks) {
    const block = b as {
      id?: string;
      type?: string;
      props?: { level?: unknown };
      children?: unknown;
    };
    if (
      block.type === "heading" &&
      typeof block.id === "string"
    ) {
      const lvl =
        typeof block.props?.level === "number" ? block.props.level : 1;
      const text = extractBlockText(block).trim();
      if (text) out.push({ id: block.id, level: lvl, text });
    }
    if (Array.isArray(block.children)) {
      out.push(...extractHeadings(block.children));
    }
  }
  return out;
}

function findHeadingBlockId(
  blocks: unknown[],
  anchor: string,
): string | null {
  const target = anchor.toLowerCase().trim();
  for (const b of blocks) {
    const block = b as { type?: string; id?: string; children?: unknown };
    if (block.type === "heading") {
      const text = extractBlockText(block).toLowerCase().trim();
      if (text === target && typeof block.id === "string") return block.id;
    }
    if (Array.isArray(block.children) && block.children.length > 0) {
      const nested = findHeadingBlockId(block.children, anchor);
      if (nested) return nested;
    }
  }
  return null;
}

function scrollToHeading(blockId: string) {
  // Wait one paint so the DOM reflects the just-replaced blocks.
  window.requestAnimationFrame(() => {
    const el = document.querySelector(`[data-id="${blockId}"]`);
    if (el && "scrollIntoView" in el) {
      (el as HTMLElement).scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  });
}

function formatDate(iso: string | undefined): string {
  if (!iso || typeof iso !== "string") return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return `heute ${d.toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }
  return d.toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

type SaveState = "idle" | "loading" | "saving" | "saved" | "error";

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function findFirstFile(entries: Entry[]): string | null {
  for (const e of entries) {
    if (e.type === "file") return e.path;
    const nested = findFirstFile(e.children);
    if (nested) return nested;
  }
  return null;
}

function ancestorPaths(p: string): string[] {
  const parts = p.split("/").slice(0, -1);
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i++) {
    out.push(parts.slice(0, i).join("/"));
  }
  return out;
}

export default function App() {
  const editor = useCreateBlockNote({
    schema,
    uploadFile: uploadBlockNoteFile,
  });
  const [handwriteOpen, setHandwriteOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteInitialQuery, setPaletteInitialQuery] = useState<
    string | undefined
  >(undefined);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [currentFrontmatter, setCurrentFrontmatter] = useState<Frontmatter>(
    {},
  );
  const [sortBy, setSortBy] = useState<SortOption>(loadSort);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const [trashOpen, setTrashOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const [moveSource, setMoveSource] = useState<
    { path: string; isDir: boolean } | null
  >(null);
  const currentFrontmatterRef = useRef<Frontmatter>({});
  const pendingAnchorRef = useRef<string | null>(null);
  const [tagRefreshTick, setTagRefreshTick] = useState(0);
  const [wordCount, setWordCount] = useState(0);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [editingStrokes, setEditingStrokes] = useState<Stroke[] | undefined>(
    undefined,
  );
  const [editingUuid, setEditingUuid] = useState<string | undefined>(undefined);
  const pendingHandwriteAfterRef = useRef<string | null>(null);
  const editingBlockIdRef = useRef<string | null>(null);

  // Fetch the strokes JSON for an existing handwriting and open the modal in
  // edit mode. Called from inside a handwrite block via a module-level
  // callback set in a useEffect below.
  const requestHandwriteEdit = useCallback(
    async (blockId: string, uuid: string) => {
      try {
        const res = await fetch(
          `/_attachments/handwrite-${encodeURIComponent(uuid)}.json`,
        );
        if (!res.ok) {
          alert("Strokes-Daten nicht gefunden — bearbeiten nicht möglich.");
          return;
        }
        const data = (await res.json()) as { strokes?: Stroke[] };
        editingBlockIdRef.current = blockId;
        setEditingUuid(uuid);
        setEditingStrokes(data.strokes ?? []);
        pendingHandwriteAfterRef.current = null;
        setHandwriteOpen(true);
      } catch (err) {
        console.error("could not load handwriting for edit", err);
        alert("Konnte Handschrift nicht laden");
      }
    },
    [],
  );

  // Register the edit callback so handwrite blocks (rendered outside this
  // component tree) can call back into App when the user clicks "Bearbeiten".
  useEffect(() => {
    setHandwriteEditCallback(requestHandwriteEdit);
    return () => setHandwriteEditCallback(null);
  }, [requestHandwriteEdit]);

  // Wikilink click → navigate in the same tab. Cmd/Ctrl+click is handled
  // natively by the <a> href in the wikilink render. If the link includes a
  // heading anchor (`[[Note#Heading]]`), the load flow scrolls to that
  // heading after the content arrives.
  useEffect(() => {
    setWikilinkClickCallbackV2(async (target, anchor) => {
      await flushPendingSave();
      pendingAnchorRef.current = anchor ?? null;
      setCurrentPath(`${target}.md`);
    });
    // Keep the v1 callback registered as a no-op fallback so any leftover
    // wikilinks rendered before V2 was wired still work.
    setWikilinkClickCallback(async (target) => {
      await flushPendingSave();
      setCurrentPath(`${target}.md`);
    });
    return () => {
      setWikilinkClickCallbackV2(null);
      setWikilinkClickCallback(null);
    };
  }, []);

  // Tag click → open the command palette pre-filled with #tagname so the
  // user immediately sees every note containing that tag.
  useEffect(() => {
    setTagClickCallback((name) => {
      setPaletteInitialQuery(`#${name}`);
      setPaletteOpen(true);
    });
    return () => setTagClickCallback(null);
  }, []);
  const [tree, setTree] = useState<Entry[]>([]);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [menuPath, setMenuPath] = useState<string | null>(null);

  const saveTimer = useRef<number | null>(null);
  const loadedRef = useRef(false);
  const currentPathRef = useRef<string | null>(null);

  const saveNow = useCallback(
    async (path: string) => {
      const rawMd = await editor.blocksToMarkdownLossy(editor.document);
      // BlockNote escapes `[` and `]` in plain text — undo that for our
      // wikilinks so the on-disk MD stays Obsidian-compatible.
      const body = unescapeWikilinks(rawMd);
      // Stamp created (if missing) + modified, then re-attach frontmatter.
      const fm = stampDates(currentFrontmatterRef.current ?? {});
      currentFrontmatterRef.current = fm;
      const md = joinFrontmatter(fm, body);
      const res = await fetch(
        `/api/file?path=${encodeURIComponent(path)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "text/markdown" },
          body: md,
        },
      );
      return res.ok;
    },
    [editor],
  );

  async function flushPendingSave() {
    if (saveTimer.current !== null && currentPathRef.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = null;
      await saveNow(currentPathRef.current);
    }
  }

  async function refreshTree(): Promise<Entry[]> {
    const res = await fetch("/api/tree");
    const data = (await res.json()) as Entry[];
    setTree(data);
    setTagRefreshTick((t) => t + 1);
    return data;
  }

  // Apply user's sort preference to the tree.
  const sortedTree = useMemo(() => sortTree(tree, sortBy), [tree, sortBy]);

  // Initial load — honor ?path= in the URL so notes are deep-linkable and
  // openable in new tabs. URL hash (`#heading`) is a heading anchor.
  useEffect(() => {
    (async () => {
      const data = await refreshTree();
      const urlPath = new URLSearchParams(window.location.search).get("path");
      const hash = window.location.hash
        ? decodeURIComponent(window.location.hash.slice(1))
        : "";
      if (hash) pendingAnchorRef.current = hash;
      if (urlPath) {
        setCurrentPath(urlPath);
      } else {
        const first = findFirstFile(data);
        setCurrentPath(first ?? "welcome.md");
      }
    })();
  }, []);

  // Keep the URL in sync with currentPath so the address bar reflects the
  // open note and Back/Forward navigates between viewed notes. Skip while
  // currentPath is still null on initial mount — otherwise we clobber the
  // `?path=...` from a deep-link before the init effect gets to read it.
  useEffect(() => {
    if (!currentPath) return;
    const target = `?path=${encodeURIComponent(currentPath)}`;
    if (target !== window.location.search) {
      window.history.pushState(null, "", target);
    }
  }, [currentPath]);

  // Respond to browser Back/Forward (including any heading anchor).
  useEffect(() => {
    function onPop() {
      const urlPath = new URLSearchParams(window.location.search).get(
        "path",
      );
      const hash = window.location.hash
        ? decodeURIComponent(window.location.hash.slice(1))
        : "";
      if (hash) pendingAnchorRef.current = hash;
      setCurrentPath(urlPath || null);
    }
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Cmd+K opens the palette, Cmd+Shift+D opens today's daily note.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "d"
      ) {
        e.preventDefault();
        openDailyNote();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // openDailyNote is stable-ish; we don't need to re-bind on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist sort preference.
  useEffect(() => {
    try {
      localStorage.setItem(SORT_KEY, sortBy);
    } catch {
      /* ignore */
    }
  }, [sortBy]);

  // Track the recently-opened list as the user navigates between notes.
  useEffect(() => {
    if (!currentPath) return;
    setRecent((prev) => {
      const next = [
        currentPath,
        ...prev.filter((p) => p !== currentPath),
      ].slice(0, RECENT_LIMIT);
      saveRecent(next);
      return next;
    });
  }, [currentPath]);

  function noteTitleForExport(): string {
    if (!currentPath) return "note";
    const base = currentPath.split("/").pop() ?? currentPath;
    return base.replace(/\.md$/, "");
  }

  async function exportAsHtml() {
    const title = noteTitleForExport();
    // BlockNote produces lossy HTML for export; close enough for a self-
    // contained read-only file. We embed a small print-friendly stylesheet.
    const body = await editor.blocksToHTMLLossy(editor.document);
    const css = `
      body { font-family: "IBM Plex Mono", ui-monospace, Menlo, monospace;
             max-width: 760px; margin: 40px auto; padding: 0 20px;
             color: #1a1a1a; line-height: 1.6; }
      h1,h2,h3,h4,h5,h6 { font-weight: 700; letter-spacing: -0.005em; }
      h1 { font-size: 1.7em; } h2 { font-size: 1.35em; } h3 { font-size: 1.15em; }
      a { color: #3a5a8a; }
      img { max-width: 100%; height: auto; }
      code { background: rgba(80,70,50,0.07); padding: 1px 4px; border-radius: 3px; }
      pre { background: rgba(80,70,50,0.07); padding: 12px; border-radius: 6px;
            overflow-x: auto; }
      blockquote { border-left: 3px solid #d4cfc1; padding-left: 12px;
                   color: #555; margin-left: 0; }
      table { border-collapse: collapse; }
      th, td { border: 1px solid #ddd; padding: 6px 10px; }
    `.trim();
    const doc = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
<h1>${title}</h1>
${body}
</body>
</html>`;
    const blob = new Blob([doc], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title}.html`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportAsPdf() {
    // Browser's built-in print dialog — user picks "Save as PDF" there.
    // Print CSS in App.css hides chrome (sidebar, save indicator, etc).
    window.print();
  }

  // Open (or create) today's daily note under Daily/YYYY-MM-DD.md
  async function openDailyNote() {
    const targetPath = dailyNotePath();
    await flushPendingSave();
    // If the file doesn't exist yet, create it with a heading.
    const existing = await fetch(
      `/api/file?path=${encodeURIComponent(targetPath)}`,
    ).catch(() => null);
    if (!existing || !existing.ok) {
      const today = new Date().toLocaleDateString("de-DE", {
        weekday: "long",
        day: "2-digit",
        month: "long",
        year: "numeric",
      });
      await fetch(`/api/file?path=${encodeURIComponent(targetPath)}`, {
        method: "PUT",
        headers: { "Content-Type": "text/markdown" },
        body: `# ${today}\n\n`,
      });
      await refreshTree();
    }
    setCurrentPath(targetPath);
  }

  // Load content whenever currentPath changes
  useEffect(() => {
    if (!currentPath) return;
    currentPathRef.current = currentPath;
    let cancelled = false;
    setSaveState("loading");
    loadedRef.current = false;
    (async () => {
      const res = await fetch(
        `/api/file?path=${encodeURIComponent(currentPath)}`,
      );
      if (cancelled) return;
      const md = res.ok ? await res.text() : "";
      const { frontmatter, body } = splitFrontmatter(md);
      currentFrontmatterRef.current = frontmatter;
      setCurrentFrontmatter(frontmatter);
      const parsed = await editor.tryParseMarkdownToBlocks(body);
      const blocks = rehydrateTags(
        rehydrateWikilinks(
          rehydrateHandwriteImages(rehydratePdfLinks(parsed)),
        ),
      );
      editor.replaceBlocks(editor.document, blocks);
      loadedRef.current = true;
      setSaveState("saved");
      // After load: if a heading anchor was requested (wikilink click or URL
      // hash), scroll the matching heading into view.
      const anchor = pendingAnchorRef.current;
      pendingAnchorRef.current = null;
      if (anchor) {
        const id = findHeadingBlockId(editor.document, anchor);
        if (id) scrollToHeading(id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentPath, editor]);

  // Click-outside closes the action menu
  useEffect(() => {
    if (!menuPath) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest(".row-menu") && !target.closest(".row-more")) {
        setMenuPath(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuPath]);

  function onEditorChange() {
    setWordCount(countWordsInBlocks(editor.document));
    setHeadings(extractHeadings(editor.document));
    if (!loadedRef.current) return;
    const path = currentPathRef.current;
    if (!path) return;
    setSaveState("saving");
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(async () => {
      const ok = await saveNow(path);
      setSaveState(ok ? "saved" : "error");
    }, SAVE_DEBOUNCE_MS);
  }

  // Recompute word count + outline once whenever a fresh note finishes
  // loading (the load flow uses replaceBlocks but loadedRef gating means
  // onEditorChange won't compute these during the load).
  useEffect(() => {
    if (currentPath) {
      window.setTimeout(() => {
        setWordCount(countWordsInBlocks(editor.document));
        setHeadings(extractHeadings(editor.document));
      }, 0);
    } else {
      setWordCount(0);
      setHeadings([]);
    }
  }, [currentPath, editor]);

  async function switchTo(path: string) {
    // Always close the mobile sidebar on navigation. On desktop the state is
    // ignored (the sidebar is always visible).
    setSidebarOpen(false);
    if (path === currentPath) return;
    await flushPendingSave();
    setCurrentPath(path);
  }

  function toggleFolder(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function ensureExpanded(paths: string[]) {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const p of paths) if (p) next.add(p);
      return next;
    });
  }

  async function createNote(parent: string) {
    setMenuPath(null);
    const raw = window.prompt("Name der neuen Notiz");
    if (!raw) return;
    const name = raw.trim().replace(/\.md$/, "");
    if (!name) return;
    const path = joinPath(parent, `${name}.md`);
    await flushPendingSave();
    const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "Content-Type": "text/markdown" },
      body: `# ${name}\n\n`,
    });
    if (!res.ok) {
      alert("Konnte Notiz nicht anlegen");
      return;
    }
    await refreshTree();
    ensureExpanded(parent ? [...ancestorPaths(path), parent] : []);
    setCurrentPath(path);
  }

  async function createFolder(parent: string) {
    setMenuPath(null);
    const raw = window.prompt("Name des neuen Ordners");
    if (!raw) return;
    const name = raw.trim();
    if (!name) return;
    const path = joinPath(parent, name);
    const res = await fetch(`/api/dir?path=${encodeURIComponent(path)}`, {
      method: "POST",
    });
    if (!res.ok) {
      alert("Konnte Ordner nicht anlegen");
      return;
    }
    await refreshTree();
    ensureExpanded(parent ? [...ancestorPaths(path), parent, path] : [path]);
  }

  async function renameItem(oldPath: string, isDir: boolean) {
    setMenuPath(null);
    const parts = oldPath.split("/");
    const oldName = parts[parts.length - 1];
    const oldBase = isDir ? oldName : oldName.replace(/\.md$/, "");
    const raw = window.prompt("Neuer Name", oldBase);
    if (!raw) return;
    const newBase = raw.trim();
    if (!newBase || newBase === oldBase) return;
    const newName = isDir ? newBase : `${newBase.replace(/\.md$/, "")}.md`;
    const newPath = [...parts.slice(0, -1), newName].join("/");
    await flushPendingSave();
    const res = await fetch("/api/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: oldPath, to: newPath }),
    });
    if (!res.ok) {
      alert("Umbenennen fehlgeschlagen");
      return;
    }
    await refreshTree();
    // If we renamed the currently-open file or one of its ancestor folders, update currentPath
    if (currentPathRef.current) {
      const cp = currentPathRef.current;
      if (cp === oldPath) {
        setCurrentPath(newPath);
      } else if (isDir && cp.startsWith(oldPath + "/")) {
        setCurrentPath(newPath + cp.slice(oldPath.length));
      }
    }
  }

  // Returns true if `from` can be dropped into `toFolder` (path-without-trailing-slash,
  // or "" for the root). Refuses self-drop, descendant drop, and no-op
  // (already in the target folder).
  function canMove(from: string, toFolder: string): boolean {
    if (!from) return false;
    if (from === toFolder) return false;
    if (toFolder && (toFolder === from || toFolder.startsWith(from + "/")))
      return false;
    const parent = from.includes("/")
      ? from.slice(0, from.lastIndexOf("/"))
      : "";
    if (parent === toFolder) return false;
    return true;
  }

  async function moveItem(from: string, toFolder: string) {
    if (!canMove(from, toFolder)) return;
    const name = from.split("/").pop() ?? from;
    const newPath = toFolder ? `${toFolder}/${name}` : name;
    await flushPendingSave();
    const res = await fetch("/api/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: newPath }),
    });
    if (!res.ok) {
      if (res.status === 409) {
        alert(
          `Es existiert bereits ein Eintrag "${name}" am Zielort — Verschieben abgebrochen.`,
        );
      } else {
        alert("Verschieben fehlgeschlagen");
      }
      return;
    }
    await refreshTree();
    if (toFolder) ensureExpanded([toFolder]);
    const cp = currentPathRef.current;
    if (cp) {
      if (cp === from) {
        setCurrentPath(newPath);
      } else if (cp.startsWith(from + "/")) {
        setCurrentPath(newPath + cp.slice(from.length));
      }
    }
  }

  async function togglePinned(filePath: string) {
    setMenuPath(null);
    await flushPendingSave();
    try {
      const res = await fetch(
        `/api/file?path=${encodeURIComponent(filePath)}`,
      );
      const md = res.ok ? await res.text() : "";
      const { frontmatter, body } = splitFrontmatter(md);
      const isPinned = frontmatter.pinned === true;
      const nextFm: Frontmatter = { ...frontmatter };
      if (isPinned) {
        delete nextFm.pinned;
      } else {
        nextFm.pinned = true;
      }
      const next = joinFrontmatter(nextFm, body);
      await fetch(`/api/file?path=${encodeURIComponent(filePath)}`, {
        method: "PUT",
        headers: { "Content-Type": "text/markdown" },
        body: next,
      });
      // If we just toggled the OPEN note, keep its in-memory frontmatter
      // state in sync so subsequent saves don't undo our change.
      if (filePath === currentPathRef.current) {
        currentFrontmatterRef.current = nextFm;
        setCurrentFrontmatter(nextFm);
      }
      await refreshTree();
    } catch (err) {
      console.error("toggle pinned failed", err);
      alert("Pinnen fehlgeschlagen");
    }
  }

  async function deleteItem(path: string, isDir: boolean) {
    setMenuPath(null);
    const label = isDir ? "Ordner inkl. Inhalt" : "Notiz";
    if (!window.confirm(`${label} "${path}" wirklich löschen?`)) return;
    await flushPendingSave();
    const res = await fetch(`/api/path?path=${encodeURIComponent(path)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      alert("Löschen fehlgeschlagen");
      return;
    }
    const data = await refreshTree();
    // If the deleted item is or contains the currently-open file, switch
    const cp = currentPathRef.current;
    if (cp && (cp === path || (isDir && cp.startsWith(path + "/")))) {
      setCurrentPath(findFirstFile(data));
    }
  }

  return (
    <div className={"app-shell" + (sidebarOpen ? " sidebar-open" : "")}>
      <button
        type="button"
        className="hamburger-btn"
        onClick={() => setSidebarOpen((s) => !s)}
        aria-label={sidebarOpen ? "Sidebar schließen" : "Sidebar öffnen"}
      >
        {sidebarOpen ? "✕" : "☰"}
      </button>
      <div
        className="sidebar-backdrop"
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-title-row">
            <span className="sidebar-title">Notes</span>
            <div className="sort-wrapper">
              <button
                type="button"
                className="sort-btn"
                onClick={() => setSortMenuOpen((v) => !v)}
                title="Sortierung"
              >
                ↕
              </button>
              {sortMenuOpen && (
                <div
                  className="sort-menu"
                  onMouseLeave={() => setSortMenuOpen(false)}
                >
                  {SORT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      className={
                        "sort-menu-item" +
                        (opt.value === sortBy ? " active" : "")
                      }
                      onClick={() => {
                        setSortBy(opt.value);
                        setSortMenuOpen(false);
                      }}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="sidebar-actions">
            <button
              type="button"
              className="header-btn"
              onClick={() => setPaletteOpen(true)}
              title="Notiz suchen oder öffnen (⌘K)"
            >
              Suche
            </button>
            <button
              type="button"
              className="header-btn"
              onClick={() => openDailyNote()}
              title="Heutige Daily-Note öffnen (⌘⇧D)"
            >
              Heute
            </button>
            <button
              type="button"
              className="header-btn"
              onClick={() => createNote("")}
              title="Neue Notiz im Root"
            >
              + Notiz
            </button>
            <button
              type="button"
              className="header-btn"
              onClick={() => createFolder("")}
              title="Neuer Ordner im Root"
            >
              + Ordner
            </button>
          </div>
        </div>
        {(() => {
          const pinned = collectPinnedFiles(tree);
          if (pinned.length === 0) return null;
          return (
            <section className="pinned-panel">
              <div className="pinned-header">Pinned</div>
              <ul className="pinned-list">
                {pinned.map((p) => (
                  <li key={p.path}>
                    <a
                      className={
                        "pinned-item" +
                        (p.path === currentPath ? " active" : "")
                      }
                      href={`?path=${encodeURIComponent(p.path)}`}
                      onClick={(ev) => {
                        if (
                          ev.metaKey ||
                          ev.ctrlKey ||
                          ev.shiftKey ||
                          ev.button !== 0
                        )
                          return;
                        ev.preventDefault();
                        switchTo(p.path);
                      }}
                      title={p.path}
                    >
                      <span className="pinned-icon">📌</span>
                      <span className="pinned-text">
                        {p.name.replace(/\.md$/, "")}
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          );
        })()}
        <TreeView
          entries={sortedTree}
          depth={0}
          currentPath={currentPath}
          expanded={expanded}
          menuPath={menuPath}
          onSelect={switchTo}
          onToggle={toggleFolder}
          onOpenMenu={setMenuPath}
          onCreateNote={createNote}
          onCreateFolder={createFolder}
          onRename={renameItem}
          onDelete={deleteItem}
          onTogglePin={togglePinned}
          onRequestMove={(path, isDir) => {
            setMenuPath(null);
            setMoveSource({ path, isDir });
          }}
        />
        <TagPanel
          refreshTick={tagRefreshTick}
          onTagClick={(name) => {
            setPaletteInitialQuery(`#${name}`);
            setPaletteOpen(true);
          }}
        />
        <div className="sidebar-footer">
          <button
            type="button"
            className="sidebar-footer-btn"
            onClick={() => setTasksOpen(true)}
          >
            ☐ Aufgaben
          </button>
          <button
            type="button"
            className="sidebar-footer-btn"
            onClick={() => setTrashOpen(true)}
          >
            🗑 Papierkorb
          </button>
        </div>
      </aside>

      <div className="main-area">
        <div className="save-indicator" data-state={saveState}>
          {saveState === "loading" && "Lade…"}
          {saveState === "saving" && "Speichere…"}
          {saveState === "saved" && "Gespeichert"}
          {saveState === "error" && "Fehler beim Speichern"}
        </div>
        <main className="editor-column">
          {currentPath && (
            <div className="note-meta">
              <span className="note-meta-path">{currentPath}</span>
              {currentFrontmatter.modified && (
                <span className="note-meta-date">
                  Geändert {formatDate(currentFrontmatter.modified as string)}
                </span>
              )}
              {currentFrontmatter.created && (
                <span className="note-meta-date">
                  Erstellt {formatDate(currentFrontmatter.created as string)}
                </span>
              )}
              {wordCount > 0 && (
                <span className="note-meta-date">
                  {wordCount.toLocaleString("de-DE")} Wörter ·{" "}
                  {Math.max(1, Math.ceil(wordCount / 200))} Min
                </span>
              )}
              <div className="note-meta-actions">
                {headings.length > 0 && (
                  <button
                    type="button"
                    className={
                      "note-meta-btn" + (outlineOpen ? " active" : "")
                    }
                    onClick={() => setOutlineOpen((v) => !v)}
                    title="Inhaltsverzeichnis der Notiz"
                  >
                    Outline ({headings.length})
                  </button>
                )}
                <button
                  type="button"
                  className="note-meta-btn"
                  onClick={exportAsPdf}
                  title="Browser-Druck-Dialog → ‚Als PDF speichern'"
                >
                  Drucken
                </button>
                <button
                  type="button"
                  className="note-meta-btn"
                  onClick={exportAsHtml}
                  title="Notiz als eigenständige HTML-Datei herunterladen"
                >
                  HTML
                </button>
              </div>
            </div>
          )}
          {currentPath && outlineOpen && headings.length > 0 && (
            <nav className="outline">
              <ul>
                {headings.map((h) => (
                  <li
                    key={h.id}
                    style={{ paddingLeft: (h.level - 1) * 12 }}
                  >
                    <button
                      type="button"
                      className="outline-item"
                      data-level={h.level}
                      onClick={() => scrollToHeading(h.id)}
                    >
                      {h.text}
                    </button>
                  </li>
                ))}
              </ul>
            </nav>
          )}
          {currentPath ? (
            <BlockNoteView
              editor={editor}
              theme="light"
              slashMenu={false}
              onChange={onEditorChange}
            >
              <SuggestionMenuController
                triggerCharacter="#"
                getItems={async (query) => {
                  const tags = await fetchAllTags();
                  const queryLower = query.toLowerCase();
                  const matches = tags.filter((t) =>
                    t.tag.toLowerCase().includes(queryLower),
                  );
                  const items: Array<{
                    title: string;
                    aliases?: string[];
                    group?: string;
                    subtext?: string;
                    onItemClick: () => void;
                  }> = matches.map((t) => ({
                    title: t.tag,
                    group: "Tags",
                    subtext: `${t.count}× verwendet`,
                    onItemClick: () =>
                      editor.insertInlineContent([
                        { type: "tag", props: { name: t.tag } },
                        " ",
                      ]),
                  }));
                  // Allow creating a new tag when the query doesn't exactly
                  // match an existing one.
                  const trimmed = query.trim();
                  const validNew = /^[\w][\w\-/]*$/.test(trimmed);
                  const exactExists = tags.some(
                    (t) => t.tag.toLowerCase() === queryLower,
                  );
                  if (trimmed && validNew && !exactExists) {
                    items.push({
                      title: `Neuer Tag: #${trimmed}`,
                      group: "Tags",
                      onItemClick: () =>
                        editor.insertInlineContent([
                          { type: "tag", props: { name: trimmed } },
                          " ",
                        ]),
                    });
                  }
                  return items;
                }}
              />
              <SuggestionMenuController
                triggerCharacter="/"
                getItems={async (query) => {
                  // Dynamic wikilink items: one per existing note. Typing in
                  // the slash menu filters them naturally.
                  const allFiles: { name: string; target: string }[] = [];
                  function walkTree(entries: Entry[]) {
                    for (const e of entries) {
                      if (e.type === "file") {
                        allFiles.push({
                          name: e.name.replace(/\.md$/, ""),
                          target: e.path.replace(/\.md$/, ""),
                        });
                      } else {
                        walkTree(e.children);
                      }
                    }
                  }
                  walkTree(tree);
                  const wikilinkItems = allFiles.map((f) => ({
                    title: `→ ${f.name}`,
                    aliases: [
                      "wikilink",
                      "verlinkung",
                      "link",
                      f.name.toLowerCase(),
                    ],
                    group: "Verlinkungen",
                    subtext: f.target.includes("/") ? f.target : undefined,
                    onItemClick: () => {
                      editor.insertInlineContent([
                        {
                          type: "wikilink",
                          props: { target: f.target },
                        },
                        // Insert a trailing space so the cursor lands on
                        // editable text rather than inside the wikilink.
                        " ",
                      ]);
                    },
                  }));

                  // Anchor links — one item per (note × heading) combo.
                  // Fetched fresh on each menu open; small vaults make this
                  // cheap. Filtered by query downstream.
                  let anchorItems: typeof wikilinkItems = [];
                  try {
                    const res = await fetch("/api/headings");
                    if (res.ok) {
                      const headings = (await res.json()) as Array<{
                        path: string;
                        heading: string;
                        level: number;
                      }>;
                      anchorItems = headings.map((h) => {
                        const target = h.path.replace(/\.md$/, "");
                        const noteName =
                          target.split("/").pop() ?? target;
                        return {
                          title: `↳ ${noteName} › ${h.heading}`,
                          aliases: [
                            "anchor",
                            "heading",
                            "abschnitt",
                            noteName.toLowerCase(),
                            h.heading.toLowerCase(),
                          ],
                          group: "Anchor-Links",
                          subtext: target.includes("/") ? target : undefined,
                          onItemClick: () => {
                            editor.insertInlineContent([
                              {
                                type: "wikilink",
                                props: { target, anchor: h.heading },
                              },
                              " ",
                            ]);
                          },
                        };
                      });
                    }
                  } catch {
                    /* offline / endpoint unreachable — skip anchors */
                  }
                  return filterSuggestionItems(
                    [
                      ...getDefaultReactSlashMenuItems(editor),
                      makePdfSlashItem(editor, uploadBlockNoteFile),
                      {
                        title: "Suchen",
                        aliases: [
                          "search",
                          "suche",
                          "find",
                          "palette",
                          "switcher",
                        ],
                        group: "Aktionen",
                        subtext: "Notiz finden (⌘K)",
                        onItemClick: () => setPaletteOpen(true),
                      },
                      {
                        title: "Aufgabe",
                        aliases: [
                          "aufgabe",
                          "task",
                          "todo",
                          "checklist",
                          "checkbox",
                          "checkliste",
                          "kasten",
                        ],
                        group: "Aktionen",
                        subtext: "Checkbox-Aufgabe einfügen ( - [ ] )",
                        onItemClick: () => {
                          insertOrUpdateBlockForSlashMenu(editor, {
                            type: "checkListItem",
                          });
                        },
                      },
                      {
                        title: "Handschrift",
                        aliases: [
                          "handwrite",
                          "handschrift",
                          "pencil",
                          "zeichnen",
                          "draw",
                        ],
                        group: "Stift",
                        subtext: "Mit Apple Pencil zeichnen",
                        onItemClick: () => {
                          pendingHandwriteAfterRef.current =
                            editor.getTextCursorPosition().block.id;
                          setHandwriteOpen(true);
                        },
                      },
                      ...wikilinkItems,
                      ...anchorItems,
                    ],
                    query,
                  );
                }}
              />
            </BlockNoteView>
          ) : (
            <div className="empty-state">
              Keine Notiz ausgewählt. Lege eine neue über „+ Notiz" an.
            </div>
          )}
          {currentPath && (
            <BacklinksPanel
              target={currentPath.replace(/\.md$/, "")}
              onNavigate={switchTo}
            />
          )}
        </main>
      </div>

      <TrashModal
        open={trashOpen}
        onClose={() => setTrashOpen(false)}
        onRestored={async () => {
          await refreshTree();
        }}
      />

      <TasksModal
        open={tasksOpen}
        onClose={() => setTasksOpen(false)}
        onNavigate={switchTo}
      />

      <MoveModal
        open={moveSource !== null}
        source={moveSource}
        tree={tree}
        onClose={() => setMoveSource(null)}
        onMove={async (toFolder) => {
          const src = moveSource;
          setMoveSource(null);
          if (src) await moveItem(src.path, toFolder);
        }}
      />

      <CommandPalette
        open={paletteOpen}
        tree={tree}
        recent={recent}
        initialQuery={paletteInitialQuery}
        onClose={() => {
          setPaletteOpen(false);
          setPaletteInitialQuery(undefined);
        }}
        onNavigate={switchTo}
      />

      <HandwriteModal
        open={handwriteOpen}
        initialStrokes={editingStrokes}
        initialUuid={editingUuid}
        onClose={() => {
          setHandwriteOpen(false);
          setEditingStrokes(undefined);
          setEditingUuid(undefined);
          editingBlockIdRef.current = null;
        }}
        onSaved={(pngUrl, uuid) => {
          if (editingBlockIdRef.current) {
            // Edit mode: same URL, different file content. Tell the rendered
            // <img> to cache-bust by listening for this event.
            window.dispatchEvent(
              new CustomEvent("handwrite-updated", { detail: { uuid } }),
            );
          } else {
            const afterId = pendingHandwriteAfterRef.current;
            pendingHandwriteAfterRef.current = null;
            if (!afterId) return;
            editor.insertBlocks(
              [{ type: "handwrite", props: { url: pngUrl } }],
              afterId,
              "after",
            );
          }
        }}
      />
    </div>
  );
}

type TreeViewProps = {
  entries: Entry[];
  depth: number;
  currentPath: string | null;
  expanded: Set<string>;
  menuPath: string | null;
  onSelect: (path: string) => void;
  onToggle: (path: string) => void;
  onOpenMenu: (path: string | null) => void;
  onCreateNote: (parent: string) => void;
  onCreateFolder: (parent: string) => void;
  onRename: (path: string, isDir: boolean) => void;
  onDelete: (path: string, isDir: boolean) => void;
  onRequestMove: (path: string, isDir: boolean) => void;
  onTogglePin: (path: string) => void;
};

function TreeView(props: TreeViewProps) {
  const {
    entries,
    depth,
    currentPath,
    expanded,
    menuPath,
    onSelect,
    onToggle,
    onOpenMenu,
    onCreateNote,
    onCreateFolder,
    onRename,
    onDelete,
    onRequestMove,
    onTogglePin,
  } = props;

  return (
    <ul className="tree">
      {entries.map((e) => {
        const indent = { paddingLeft: 8 + depth * 12 } as const;
        if (e.type === "dir") {
          const isOpen = expanded.has(e.path);
          return (
            <li key={e.path} className="tree-item">
              <div className="tree-row" style={indent}>
                <button
                  type="button"
                  className="tree-dir-label"
                  onClick={() => onToggle(e.path)}
                >
                  <span className="caret">{isOpen ? "▾" : "▸"}</span>
                  <span className="name">{e.name}</span>
                </button>
                <button
                  type="button"
                  className="row-more"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onOpenMenu(menuPath === e.path ? null : e.path);
                  }}
                  title="Aktionen"
                >
                  ⋯
                </button>
                {menuPath === e.path && (
                  <div className="row-menu">
                    <button onClick={() => onCreateNote(e.path)}>
                      Neue Notiz hier
                    </button>
                    <button onClick={() => onCreateFolder(e.path)}>
                      Neuer Unterordner
                    </button>
                    <button onClick={() => onRequestMove(e.path, true)}>
                      Verschieben…
                    </button>
                    <button onClick={() => onRename(e.path, true)}>
                      Umbenennen
                    </button>
                    <button
                      className="danger"
                      onClick={() => onDelete(e.path, true)}
                    >
                      Löschen
                    </button>
                  </div>
                )}
              </div>
              {isOpen && (
                <TreeView
                  entries={e.children}
                  depth={depth + 1}
                  currentPath={currentPath}
                  expanded={expanded}
                  menuPath={menuPath}
                  onSelect={onSelect}
                  onToggle={onToggle}
                  onOpenMenu={onOpenMenu}
                  onCreateNote={onCreateNote}
                  onCreateFolder={onCreateFolder}
                  onRename={onRename}
                  onDelete={onDelete}
                  onRequestMove={onRequestMove}
                  onTogglePin={onTogglePin}
                />
              )}
            </li>
          );
        }
        return (
          <li key={e.path} className="tree-item">
            <div className="tree-row" style={indent}>
              <a
                className={
                  "tree-file" + (e.path === currentPath ? " active" : "")
                }
                href={`?path=${encodeURIComponent(e.path)}`}
                onClick={(ev) => {
                  // Let Cmd/Ctrl/Shift/middle-click pass through so the browser
                  // opens the link in a new tab/window natively.
                  if (
                    ev.metaKey ||
                    ev.ctrlKey ||
                    ev.shiftKey ||
                    ev.button !== 0
                  )
                    return;
                  ev.preventDefault();
                  onSelect(e.path);
                }}
              >
                {e.name.replace(/\.md$/, "")}
              </a>
              <button
                type="button"
                className="row-more"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onOpenMenu(menuPath === e.path ? null : e.path);
                }}
                title="Aktionen"
              >
                ⋯
              </button>
              {menuPath === e.path && (
                <div className="row-menu">
                  <button
                    onClick={() => {
                      onOpenMenu(null);
                      window.open(
                        `?path=${encodeURIComponent(e.path)}`,
                        "_blank",
                      );
                    }}
                  >
                    In neuem Tab öffnen
                  </button>
                  <button onClick={() => onTogglePin(e.path)}>
                    {e.pinned ? "Pin entfernen" : "Anpinnen"}
                  </button>
                  <button onClick={() => onRequestMove(e.path, false)}>
                    Verschieben…
                  </button>
                  <button onClick={() => onRename(e.path, false)}>
                    Umbenennen
                  </button>
                  <button
                    className="danger"
                    onClick={() => onDelete(e.path, false)}
                  >
                    Löschen
                  </button>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
