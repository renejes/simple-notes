import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { filterSuggestionItems } from "@blocknote/core";
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
  unescapeWikilinks,
} from "./wikilinkInline";
import "./App.css";

const SAVE_DEBOUNCE_MS = 800;

type Entry =
  | { type: "file"; name: string; path: string; mtime?: number }
  | { type: "dir"; name: string; path: string; children: Entry[] };

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
  const currentFrontmatterRef = useRef<Frontmatter>({});
  const [tagRefreshTick, setTagRefreshTick] = useState(0);
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
  // natively by the <a> href in the wikilink render.
  useEffect(() => {
    setWikilinkClickCallback(async (target) => {
      await flushPendingSave();
      setCurrentPath(`${target}.md`);
    });
    return () => setWikilinkClickCallback(null);
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
  // openable in new tabs.
  useEffect(() => {
    (async () => {
      const data = await refreshTree();
      const urlPath = new URLSearchParams(window.location.search).get("path");
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

  // Respond to browser Back/Forward.
  useEffect(() => {
    function onPop() {
      const urlPath = new URLSearchParams(window.location.search).get(
        "path",
      );
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
            </div>
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
