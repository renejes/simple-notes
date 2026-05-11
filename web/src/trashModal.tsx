// Trash modal: lists every soft-deleted file/folder and lets the user
// restore individual items or empty the trash. Background server scan via
// GET /api/trash, restore via POST /api/trash/restore, empty via DELETE
// /api/trash.

import { useEffect, useState } from "react";

type TrashItem = {
  trashId: string;
  originalPath: string;
  deletedAt: number;
  type: "file" | "dir";
};

function formatWhen(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
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
  return d.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function TrashModal({
  open,
  onClose,
  onRestored,
}: {
  open: boolean;
  onClose: () => void;
  // Called after a restore or empty so the parent can refresh the tree.
  onRestored: () => void | Promise<void>;
}) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [loading, setLoading] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch("/api/trash");
      if (res.ok) setItems((await res.json()) as TrashItem[]);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) refresh();
  }, [open]);

  async function restore(trashId: string) {
    const res = await fetch(
      `/api/trash/restore?id=${encodeURIComponent(trashId)}`,
      { method: "POST" },
    );
    if (!res.ok) {
      alert("Wiederherstellen fehlgeschlagen");
      return;
    }
    await refresh();
    await onRestored();
  }

  async function emptyAll() {
    if (
      !window.confirm(
        "Papierkorb wirklich endgültig leeren? Das kann nicht rückgängig gemacht werden.",
      )
    )
      return;
    const res = await fetch("/api/trash", { method: "DELETE" });
    if (!res.ok) {
      alert("Papierkorb leeren fehlgeschlagen");
      return;
    }
    await refresh();
    await onRestored();
  }

  if (!open) return null;

  return (
    <div
      className="trash-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="trash-modal" role="dialog" aria-modal="true">
        <header className="trash-header">
          <span className="trash-title">
            Papierkorb {items.length > 0 && `(${items.length})`}
          </span>
          <div className="trash-header-actions">
            {items.length > 0 && (
              <button
                type="button"
                className="trash-btn trash-btn--danger"
                onClick={emptyAll}
              >
                Endgültig leeren
              </button>
            )}
            <button
              type="button"
              className="trash-btn"
              onClick={onClose}
            >
              Schließen
            </button>
          </div>
        </header>
        {loading && items.length === 0 ? (
          <div className="trash-empty">Lade…</div>
        ) : items.length === 0 ? (
          <div className="trash-empty">Papierkorb ist leer.</div>
        ) : (
          <ul className="trash-list">
            {items.map((item) => (
              <li key={item.trashId} className="trash-item">
                <div className="trash-item-info">
                  <div className="trash-item-name">
                    <span className="trash-item-type">
                      {item.type === "dir" ? "📁" : "📄"}
                    </span>{" "}
                    {item.originalPath}
                  </div>
                  <div className="trash-item-when">
                    Gelöscht: {formatWhen(item.deletedAt)}
                  </div>
                </div>
                <button
                  type="button"
                  className="trash-btn"
                  onClick={() => restore(item.trashId)}
                >
                  Wiederherstellen
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
