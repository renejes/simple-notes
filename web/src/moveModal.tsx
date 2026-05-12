// Folder-picker modal for moving notes or folders. Lists every folder in
// the tree (plus a synthetic "Root" entry); invalid targets (the item
// itself, its current parent, and descendants for folders) are filtered out.

type Entry =
  | { type: "file"; name: string; path: string; mtime?: number }
  | { type: "dir"; name: string; path: string; children: Entry[] };

type DirOption = { path: string; depth: number; label: string };

function collectDirs(entries: Entry[], depth = 0): DirOption[] {
  const out: DirOption[] = [];
  for (const e of entries) {
    if (e.type === "dir") {
      out.push({ path: e.path, depth, label: e.name });
      out.push(...collectDirs(e.children, depth + 1));
    }
  }
  return out;
}

export function MoveModal({
  open,
  source,
  tree,
  onClose,
  onMove,
}: {
  open: boolean;
  source: { path: string; isDir: boolean } | null;
  tree: Entry[];
  onClose: () => void;
  onMove: (toFolder: string) => void;
}) {
  if (!open || !source) return null;

  const all = collectDirs(tree);
  const currentParent = source.path.includes("/")
    ? source.path.slice(0, source.path.lastIndexOf("/"))
    : "";
  const valid = all.filter((d) => {
    // Can't drop into self
    if (d.path === source.path) return false;
    // Can't drop folder into its descendants
    if (source.isDir && d.path.startsWith(source.path + "/")) return false;
    // Already in this folder (no-op)
    if (d.path === currentParent) return false;
    return true;
  });
  const rootValid = currentParent !== "";

  return (
    <div
      className="move-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="move-modal" role="dialog" aria-modal="true">
        <header className="move-header">
          <span className="move-title">
            Verschieben: <code>{source.path}</code>
          </span>
          <button type="button" className="move-cancel" onClick={onClose}>
            Abbrechen
          </button>
        </header>
        <ul className="move-list">
          {rootValid && (
            <li>
              <button
                type="button"
                className="move-option move-option--root"
                onClick={() => onMove("")}
              >
                ↑ Root (oberste Ebene)
              </button>
            </li>
          )}
          {valid.length === 0 && !rootValid && (
            <li className="move-empty">
              Keine gültigen Zielordner verfügbar.
            </li>
          )}
          {valid.map((d) => (
            <li key={d.path}>
              <button
                type="button"
                className="move-option"
                style={{ paddingLeft: 12 + d.depth * 14 }}
                onClick={() => onMove(d.path)}
                title={d.path}
              >
                📁 {d.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
