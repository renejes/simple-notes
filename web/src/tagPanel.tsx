// Compact tag panel for the sidebar: lists every #tag found in the vault,
// sorted by usage count, click opens the command palette filtered by that
// tag. Auto-refreshes on a refreshTick prop change so adding tags in the
// editor surfaces in the panel after a save.

import { useEffect, useState } from "react";
import { fetchAllTags, type TagInfo } from "./tagInline";

export function TagPanel({
  refreshTick,
  onTagClick,
}: {
  refreshTick: number;
  onTagClick: (name: string) => void;
}) {
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchAllTags().then((t) => {
      if (!cancelled) setTags(t);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  if (tags.length === 0) return null;

  return (
    <section className="tag-panel">
      <button
        type="button"
        className="tag-panel-header"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="caret">{expanded ? "▾" : "▸"}</span>
        Tags <span className="tag-panel-count">{tags.length}</span>
      </button>
      {expanded && (
        <ul className="tag-panel-list">
          {tags.map((t) => (
            <li key={t.tag}>
              <button
                type="button"
                className="tag-panel-item"
                onClick={() => onTagClick(t.tag)}
              >
                <span className="tag-panel-name">#{t.tag}</span>
                <span className="tag-panel-num">{t.count}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
