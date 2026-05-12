// Aggregated view of every open `- [ ]` task across all notes. Click a task
// to jump to the source note. Refreshes whenever the modal opens so it
// reflects edits made since last visit.

import { useEffect, useState } from "react";

type Task = { path: string; line: number; text: string };

function noteName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/, "");
}

export function TasksModal({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (path: string) => void;
}) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetch("/api/tasks")
      .then((r) => (r.ok ? r.json() : []))
      .then((data: Task[]) => setTasks(data))
      .catch(() => setTasks([]))
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  // Group by note path for readability.
  const grouped = new Map<string, Task[]>();
  for (const t of tasks) {
    const list = grouped.get(t.path) ?? [];
    list.push(t);
    grouped.set(t.path, list);
  }

  return (
    <div
      className="tasks-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="tasks-modal" role="dialog" aria-modal="true">
        <header className="tasks-header">
          <span className="tasks-title">
            Offene Aufgaben{" "}
            {tasks.length > 0 && (
              <span className="tasks-count">({tasks.length})</span>
            )}
          </span>
          <button type="button" className="tasks-close" onClick={onClose}>
            Schließen
          </button>
        </header>
        {loading && tasks.length === 0 ? (
          <div className="tasks-empty">Lade…</div>
        ) : tasks.length === 0 ? (
          <div className="tasks-empty">
            Keine offenen <code>- [ ]</code>-Aufgaben gefunden.
          </div>
        ) : (
          <ul className="tasks-list">
            {Array.from(grouped.entries()).map(([path, items]) => (
              <li key={path} className="tasks-group">
                <button
                  type="button"
                  className="tasks-group-header"
                  onClick={() => {
                    onClose();
                    onNavigate(path);
                  }}
                >
                  {noteName(path)}
                  <span className="tasks-group-path">{path}</span>
                </button>
                <ul className="tasks-group-list">
                  {items.map((t) => (
                    <li key={`${t.path}:${t.line}`}>
                      <button
                        type="button"
                        className="tasks-item"
                        onClick={() => {
                          onClose();
                          onNavigate(t.path);
                        }}
                      >
                        <span className="tasks-checkbox">☐</span>
                        <span className="tasks-text">{t.text}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
