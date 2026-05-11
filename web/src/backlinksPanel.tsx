// Backlinks panel: lists every note containing a [[<target>]] wikilink to the
// currently open note. Rendered below the editor. Server-side scan via
// /api/backlinks?target=<path-without-.md>.

import { useEffect, useState } from "react";

type Backlink = { path: string; snippet: string };

function basename(path: string): string {
  const noExt = path.replace(/\.md$/, "");
  const i = noExt.lastIndexOf("/");
  return i >= 0 ? noExt.slice(i + 1) : noExt;
}

export function BacklinksPanel({
  target,
  onNavigate,
}: {
  target: string;
  onNavigate: (path: string) => void;
}) {
  const [items, setItems] = useState<Backlink[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setItems(null);
    fetch(`/api/backlinks?target=${encodeURIComponent(target)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data: Backlink[]) => {
        if (!cancelled) setItems(data);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  if (items === null || items.length === 0) {
    // Don't show an empty section while loading or when there are no
    // backlinks — keeps the editor focus clean.
    return null;
  }

  return (
    <section className="backlinks">
      <header className="backlinks-header">
        Backlinks{" "}
        <span className="backlinks-count">({items.length})</span>
      </header>
      <ul className="backlinks-list">
        {items.map((item) => (
          <li key={item.path}>
            <a
              className="backlinks-item"
              href={`?path=${encodeURIComponent(item.path)}`}
              onClick={(e) => {
                if (
                  e.metaKey ||
                  e.ctrlKey ||
                  e.shiftKey ||
                  e.button !== 0
                )
                  return;
                e.preventDefault();
                onNavigate(item.path);
              }}
            >
              <div className="backlinks-title">{basename(item.path)}</div>
              <div className="backlinks-snippet">{item.snippet}</div>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
