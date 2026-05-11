// Custom BlockNote block for handwriting. Renders the PNG produced by the
// HandwriteModal but adds an edit button on hover that requests a re-edit
// session (via React context). The block also listens for a global
// "handwrite-updated" event so that, after an edit saves new PNG content
// under the same URL, the <img> is forced to re-fetch (cache bust the
// browser without polluting the on-disk Markdown).
//
// MD round-trip: serializes as `![](url.png)`, parsed back as an image block.
// `rehydrateHandwriteImages` upgrades any image whose URL matches the
// handwrite-<uuid>.png pattern back into a handwrite block.

import { createReactBlockSpec } from "@blocknote/react";
import { useEffect, useState } from "react";

export type RequestHandwriteEdit = (blockId: string, uuid: string) => void;

// Module-level callback registry (instead of React context — avoids JSX
// member-expression parse issues with Vite's oxc transformer).
let handwriteEditCallback: RequestHandwriteEdit | null = null;
export function setHandwriteEditCallback(cb: RequestHandwriteEdit | null) {
  handwriteEditCallback = cb;
}

const HW_URL_RE = /\/_attachments\/handwrite-([a-zA-Z0-9-]+)\.png(\?|$)/;

export function extractHandwriteUuid(url: string): string | null {
  const m = url.match(HW_URL_RE);
  return m ? m[1] : null;
}

export const HandwriteBlock = createReactBlockSpec(
  {
    type: "handwrite",
    propSchema: {
      url: { default: "" as string },
    },
    content: "none",
  },
  {
    render: ({ block }) => {
      const url = block.props.url as string;
      const uuid = extractHandwriteUuid(url);
      const [version, setVersion] = useState(0);

      // Bust the browser's <img> cache when this same UUID is re-saved.
      useEffect(() => {
        if (!uuid) return;
        function onUpdated(e: Event) {
          const detail = (e as CustomEvent<{ uuid: string }>).detail;
          if (detail.uuid === uuid) setVersion((v) => v + 1);
        }
        window.addEventListener("handwrite-updated", onUpdated);
        return () =>
          window.removeEventListener("handwrite-updated", onUpdated);
      }, [uuid]);

      const displaySrc = version > 0 ? `${url}?v=${version}` : url;

      return (
        <div className="hw-block" contentEditable={false}>
          <img src={displaySrc} className="hw-block__img" alt="" />
          {uuid && (
            <button
              type="button"
              className="hw-block__edit"
              onClick={() => handwriteEditCallback?.(block.id, uuid)}
            >
              Bearbeiten
            </button>
          )}
        </div>
      );
    },
    toExternalHTML: ({ block }) => {
      const url = block.props.url as string;
      // Serialize back to a plain image so MD stays standard.
      return <img src={url} alt="" />;
    },
  },
);

// Convert any image block whose URL matches the handwriting pattern into a
// handwrite block, so re-loading MD restores the custom UI.
export function rehydrateHandwriteImages<T extends { type: string }>(
  blocks: T[],
): T[] {
  return blocks.map((block) => {
    const b = block as unknown as {
      type: string;
      props?: { url?: string };
    };
    if (b.type === "image" && b.props?.url && HW_URL_RE.test(b.props.url)) {
      return {
        type: "handwrite",
        props: { url: b.props.url },
      } as unknown as T;
    }
    return block;
  });
}
