// Cmd+K command palette: combined quick-switcher + full-text search.
// Title matches come from the in-memory tree (instant), content matches come
// from the /api/search endpoint (debounced).

import { useEffect, useMemo, useRef, useState } from "react";

export type Entry =
  | { type: "file"; name: string; path: string }
  | { type: "dir"; name: string; path: string; children: Entry[] };

type ContentMatch = { path: string; snippet: string };

type Combined =
  | { kind: "title"; path: string; display: string }
  | { kind: "content"; path: string; display: string; snippet: string };

export function CommandPalette({
  open,
  tree,
  recent,
  initialQuery,
  onClose,
  onNavigate,
}: {
  open: boolean;
  tree: Entry[];
  // Most recently opened note paths, newest first. Shown when the palette
  // opens with an empty query so the user can jump back without retyping.
  recent?: string[];
  initialQuery?: string;
  onClose: () => void;
  onNavigate: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [contentResults, setContentResults] = useState<ContentMatch[]>([]);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Flatten the tree once per open.
  const allFiles = useMemo(() => {
    const out: { name: string; path: string }[] = [];
    function walk(entries: Entry[]) {
      for (const e of entries) {
        if (e.type === "file") {
          out.push({ name: e.name.replace(/\.md$/, ""), path: e.path });
        } else {
          walk(e.children);
        }
      }
    }
    walk(tree);
    return out;
  }, [tree]);

  // Title matches: client-side substring filter, deprioritize directory matches.
  const titleMatches = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return allFiles
      .filter(
        (f) =>
          f.name.toLowerCase().includes(q) ||
          f.path.toLowerCase().includes(q),
      )
      .slice(0, 12);
  }, [query, allFiles]);

  // Content matches: debounced API.
  useEffect(() => {
    if (!query.trim()) {
      setContentResults([]);
      return;
    }
    const timer = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(query)}`,
        );
        if (res.ok) {
          setContentResults((await res.json()) as ContentMatch[]);
        }
      } catch {
        setContentResults([]);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  // Reset state when modal opens.
  useEffect(() => {
    if (open) {
      setQuery(initialQuery ?? "");
      setContentResults([]);
      setSelected(0);
      // Focus after the next paint so the input is mounted. Select all so the
      // pre-filled query can be cleared with a single keystroke if unwanted.
      window.requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [open, initialQuery]);

  // Combined list — content matches that share a path with a title match
  // are dropped to avoid duplicates. With an empty query we show recently
  // opened notes (still filtered to ones that currently exist in the tree).
  const combined: Combined[] = useMemo(() => {
    if (!query.trim()) {
      const known = new Set(allFiles.map((f) => f.path));
      return (recent ?? [])
        .filter((p) => known.has(p))
        .map<Combined>((p) => ({
          kind: "title",
          path: p,
          display: p.replace(/\.md$/, ""),
        }));
    }
    const titlePaths = new Set(titleMatches.map((t) => t.path));
    return [
      ...titleMatches.map<Combined>((t) => ({
        kind: "title",
        path: t.path,
        display: t.path.replace(/\.md$/, ""),
      })),
      ...contentResults
        .filter((c) => !titlePaths.has(c.path))
        .map<Combined>((c) => ({
          kind: "content",
          path: c.path,
          display: c.path.replace(/\.md$/, ""),
          snippet: c.snippet,
        })),
    ];
  }, [query, titleMatches, contentResults, recent, allFiles]);

  // Clamp selection when the result set changes.
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, combined.length - 1)));
  }, [combined.length]);

  // Scroll selected item into view.
  useEffect(() => {
    if (!listRef.current) return;
    const sel = listRef.current.querySelector<HTMLElement>(
      `[data-idx="${selected}"]`,
    );
    sel?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function pick(path: string, newTab: boolean) {
    if (newTab) {
      window.open(`?path=${encodeURIComponent(path)}`, "_blank");
    } else {
      onNavigate(path);
    }
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(combined.length - 1, s + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(0, s - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = combined[selected];
      if (item) pick(item.path, e.metaKey || e.ctrlKey);
    }
  }

  if (!open) return null;

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true">
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Notiz suchen oder öffnen…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {!query && combined.length === 0 && (
          <div className="palette-hint">
            Tippe einen Notiz-Namen oder einen Begriff aus dem Inhalt.
            <br />↑ ↓ navigieren · Enter öffnet · Cmd+Enter neuer Tab · Esc
            schließt
          </div>
        )}
        {!query && combined.length > 0 && (
          <div className="palette-section-label">Zuletzt geöffnet</div>
        )}
        {query && combined.length === 0 && (
          <div className="palette-hint">Nichts gefunden.</div>
        )}
        {combined.length > 0 && (
          <ul className="palette-list" ref={listRef}>
            {combined.map((item, i) => (
              <li key={`${item.kind}-${item.path}`}>
                <a
                  data-idx={i}
                  className={
                    "palette-item" + (i === selected ? " selected" : "")
                  }
                  href={`?path=${encodeURIComponent(item.path)}`}
                  onMouseEnter={() => setSelected(i)}
                  onClick={(e) => {
                    if (
                      e.metaKey ||
                      e.ctrlKey ||
                      e.shiftKey ||
                      e.button !== 0
                    )
                      return;
                    e.preventDefault();
                    pick(item.path, false);
                  }}
                >
                  <span className="palette-icon">
                    {item.kind === "title" ? "→" : "≡"}
                  </span>
                  <span className="palette-text">
                    <span className="palette-title">{item.display}</span>
                    {item.kind === "content" && (
                      <span className="palette-snippet">{item.snippet}</span>
                    )}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
