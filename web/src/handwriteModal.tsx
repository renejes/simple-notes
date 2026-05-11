// Full-screen modal for handwriting input. Uses PointerEvents (Apple Pencil
// pressure + tilt) and perfect-freehand for pressure-sensitive stroke
// outlines. On save, exports both PNG (for display + AI vision) and SVG
// (vector source for potential re-edit later), sharing one UUID across the
// pair via the /api/upload `name` parameter.

import { useEffect, useRef, useState } from "react";
import { getStroke } from "perfect-freehand";
import { uploadFile } from "./upload";

export type StrokePoint = readonly [number, number, number]; // x, y, pressure

export type Stroke = {
  points: StrokePoint[];
  color: string;
  size: number;
};

type Props = {
  open: boolean;
  // Edit mode: pre-load strokes and reuse the existing UUID so save overwrites
  // the same sidecar trio (.png, .svg, .json) instead of creating new files.
  initialStrokes?: Stroke[];
  initialUuid?: string;
  onSaved: (pngUrl: string, uuid: string) => void;
  onClose: () => void;
};

const COLORS = ["#111111", "#666666", "#c0392b", "#2980b9", "#27ae60"];
const SIZE_PRESETS = [2, 4, 6, 10];

const STROKE_OPTIONS = {
  thinning: 0.55,
  smoothing: 0.5,
  streamline: 0.5,
  start: { taper: 0, cap: true },
  end: { taper: 0, cap: true },
} as const;

export function HandwriteModal({
  open,
  initialStrokes,
  initialUuid,
  onSaved,
  onClose,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState<number>(4);
  const [saving, setSaving] = useState(false);
  const currentRef = useRef<StrokePoint[] | null>(null);
  const dprRef = useRef<number>(1);
  const dimsRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });

  // Initialize canvas size and DPR scaling on open (and on resize while open)
  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (!canvas || !wrapper) return;
    const sync = () => {
      const rect = wrapper.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      dimsRef.current = { w: rect.width, h: rect.height };
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      redraw(canvas, strokes, null);
    };
    sync();
    window.addEventListener("resize", sync);
    return () => window.removeEventListener("resize", sync);
    // Only need to sync on open transitions; strokes redraw is handled below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // On open: seed with initialStrokes (edit mode) or start blank. On close:
  // clear so the next open starts fresh.
  useEffect(() => {
    if (open) {
      setStrokes(initialStrokes ?? []);
      currentRef.current = null;
    } else {
      setStrokes([]);
      currentRef.current = null;
    }
    // We intentionally seed only on open transitions; subsequent prop changes
    // to initialStrokes are ignored to avoid clobbering user edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Redraw full canvas when strokes change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    redraw(canvas, strokes, null);
  }, [strokes]);

  function onPointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const { x, y } = clientToCanvas(e);
    const p = pressureFor(e);
    currentRef.current = [[x, y, p]];
  }

  function onPointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!currentRef.current) return;
    const { x, y } = clientToCanvas(e);
    const p = pressureFor(e);
    currentRef.current.push([x, y, p]);
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Live render: previous strokes + current in-progress one
    redraw(canvas, strokes, {
      points: currentRef.current,
      color,
      size,
    });
  }

  function onPointerUpOrCancel(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!currentRef.current) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const stroke: Stroke = {
      points: currentRef.current,
      color,
      size,
    };
    currentRef.current = null;
    // Discard trivial dots (single point with no motion) to avoid junk
    if (stroke.points.length > 1 || hasMotion(stroke.points)) {
      setStrokes((s) => [...s, stroke]);
    }
  }

  function clientToCanvas(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };
  }

  function undo() {
    setStrokes((s) => s.slice(0, -1));
  }

  function clearAll() {
    setStrokes([]);
  }

  async function save() {
    if (!strokes.length || saving) {
      if (!strokes.length) onClose();
      return;
    }
    setSaving(true);
    try {
      const canvas = canvasRef.current!;
      const { w, h } = dimsRef.current;

      const pngBlob = await new Promise<Blob | null>((res) =>
        canvas.toBlob((b) => res(b), "image/png"),
      );
      if (!pngBlob) throw new Error("PNG export failed");

      const svgStr = buildSvg(strokes, w, h);
      const svgBlob = new Blob([svgStr], { type: "image/svg+xml" });

      const uuid =
        initialUuid ??
        (typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2));
      const stem = `handwrite-${uuid}`;

      // Raw strokes as JSON sidecar so re-edits are lossless. perfect-freehand
      // produces outline polygons we cannot reliably parse back to the
      // original pressure-aware centerline points.
      const strokesJson = JSON.stringify({ width: w, height: h, strokes });
      const jsonBlob = new Blob([strokesJson], { type: "application/json" });

      const [pngUrl] = await Promise.all([
        uploadFile(pngBlob, "png", stem),
        uploadFile(svgBlob, "svg", stem),
        uploadFile(jsonBlob, "json", stem),
      ]);

      onSaved(pngUrl, uuid);
      onClose();
    } catch (err) {
      console.error("handwrite save failed", err);
      alert("Speichern fehlgeschlagen");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="hw-modal" role="dialog" aria-modal="true">
      <div className="hw-header">
        <span className="hw-title">Handschrift</span>
        <div className="hw-actions">
          <button
            type="button"
            className="hw-btn hw-btn--ghost"
            onClick={onClose}
            disabled={saving}
          >
            Abbrechen
          </button>
          <button
            type="button"
            className="hw-btn hw-btn--primary"
            onClick={save}
            disabled={saving || strokes.length === 0}
          >
            {saving ? "Speichere…" : "Einfügen"}
          </button>
        </div>
      </div>

      <div className="hw-canvas-wrap" ref={wrapperRef}>
        <canvas
          ref={canvasRef}
          className="hw-canvas"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUpOrCancel}
          onPointerCancel={onPointerUpOrCancel}
          onPointerLeave={onPointerUpOrCancel}
        />
      </div>

      <div className="hw-toolbar">
        <div className="hw-tool-group">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={"hw-swatch" + (color === c ? " active" : "")}
              style={{ background: c }}
              onClick={() => setColor(c)}
              aria-label={`Farbe ${c}`}
            />
          ))}
        </div>
        <div className="hw-tool-group">
          {SIZE_PRESETS.map((s) => (
            <button
              key={s}
              type="button"
              className={"hw-size" + (size === s ? " active" : "")}
              onClick={() => setSize(s)}
              aria-label={`Strichgröße ${s}`}
            >
              <span
                style={{
                  width: s + 2,
                  height: s + 2,
                  background: color,
                  borderRadius: "50%",
                  display: "block",
                }}
              />
            </button>
          ))}
        </div>
        <div className="hw-tool-group">
          <button
            type="button"
            className="hw-btn hw-btn--ghost"
            onClick={undo}
            disabled={strokes.length === 0}
          >
            Rückgängig
          </button>
          <button
            type="button"
            className="hw-btn hw-btn--ghost"
            onClick={clearAll}
            disabled={strokes.length === 0}
          >
            Leeren
          </button>
        </div>
      </div>
    </div>
  );
}

function pressureFor(e: React.PointerEvent): number {
  // Pencil/stylus reports real pressure; mouse reports 0.5 default while
  // pressed but 0 if no pressure mechanism. Clamp to a sensible range.
  const p = e.pressure;
  if (e.pointerType === "mouse") return 0.5;
  if (!p || p < 0.02) return 0.5;
  return p;
}

function hasMotion(pts: StrokePoint[]): boolean {
  if (pts.length < 2) return false;
  const [x0, y0] = pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (Math.hypot(pts[i][0] - x0, pts[i][1] - y0) > 2) return true;
  }
  return false;
}

function strokeToPath(stroke: Stroke): string {
  const out = getStroke(stroke.points as unknown as number[][], {
    size: stroke.size * 2.5,
    ...STROKE_OPTIONS,
  });
  if (!out.length) return "";
  return outlineToSvgPath(out);
}

function outlineToSvgPath(points: number[][]): string {
  if (!points.length) return "";
  let d = `M ${points[0][0].toFixed(2)} ${points[0][1].toFixed(2)}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${points[i][0].toFixed(2)} ${points[i][1].toFixed(2)}`;
  }
  d += " Z";
  return d;
}

function redraw(
  canvas: HTMLCanvasElement,
  done: Stroke[],
  inProgress: Stroke | null,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.scale(dpr, dpr);
  // White background — match note paper / makes the PNG sensible
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width / dpr, canvas.height / dpr);
  for (const s of done) drawStroke(ctx, s);
  if (inProgress) drawStroke(ctx, inProgress);
}

function drawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  const d = strokeToPath(stroke);
  if (!d) return;
  const path = new Path2D(d);
  ctx.fillStyle = stroke.color;
  ctx.fill(path);
}

function buildSvg(strokes: Stroke[], width: number, height: number): string {
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
  );
  parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
  for (const s of strokes) {
    const d = strokeToPath(s);
    if (!d) continue;
    parts.push(`<path d="${d}" fill="${s.color}"/>`);
  }
  parts.push("</svg>");
  return parts.join("");
}
