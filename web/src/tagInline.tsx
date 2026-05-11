// Custom inline content for #tag references. Renders #tag as a styled
// clickable pill. On save it round-trips as plain `#tag` text. Rehydration
// converts `#tag` text patterns back into tag inline content on load.

import { createReactInlineContentSpec } from "@blocknote/react";

// Module-level callback so tag pills (rendered outside the App tree) can
// request a tag-search session in the parent App.
let tagClickCallback: ((name: string) => void) | null = null;
export function setTagClickCallback(cb: ((name: string) => void) | null) {
  tagClickCallback = cb;
}

export const TagInline = createReactInlineContentSpec(
  {
    type: "tag",
    propSchema: {
      name: { default: "" as string },
    },
    content: "none",
  },
  {
    render: ({ inlineContent }) => {
      const name = inlineContent.props.name as string;
      return (
        <button
          type="button"
          className="tag"
          contentEditable={false}
          onClick={(e) => {
            e.preventDefault();
            tagClickCallback?.(name);
          }}
          title={`Tag: #${name}`}
        >
          #{name}
        </button>
      );
    },
    // Serialize back to plain text `#tag` so the on-disk MD stays clean.
    toExternalHTML: ({ inlineContent }) => {
      const name = inlineContent.props.name as string;
      return <>{`#${name}`}</>;
    },
  },
);

// Same definition as on the server: # not preceded by a word char, then a
// word char + word chars / dashes / slashes.
const TAG_RE = /(?<![\w])#([\w][\w\-/]*)/g;

// Walk parsed blocks and split text inlines that contain `#tag` patterns
// into a mix of text and tag inlines. Headings are NOT processed — `# `
// at line start is markdown heading syntax, not a tag.
export function rehydrateTags<T extends { type: string }>(blocks: T[]): T[] {
  return blocks.map((block) => {
    const b = block as unknown as {
      type: string;
      content?: unknown;
      children?: T[];
    };
    // Skip headings — never apply tag detection inside a heading's text
    // (defensive: server already strips headings before counting).
    const isHeading = b.type === "heading";
    if (!isHeading && Array.isArray(b.content)) {
      const newContent: unknown[] = [];
      let anyChange = false;
      for (const inline of b.content as Array<Record<string, unknown>>) {
        if (
          inline?.type === "text" &&
          typeof inline.text === "string" &&
          inline.text.includes("#")
        ) {
          const pieces = splitTextWithTags(inline);
          if (pieces[0] !== inline) anyChange = true;
          newContent.push(...pieces);
        } else {
          newContent.push(inline);
        }
      }
      if (anyChange) {
        return { ...b, content: newContent } as unknown as T;
      }
    }
    if (Array.isArray(b.children) && b.children.length > 0) {
      const recursed = rehydrateTags(b.children);
      if (recursed !== b.children) {
        return { ...b, children: recursed } as unknown as T;
      }
    }
    return block;
  });
}

function splitTextWithTags(
  item: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const text = item.text as string;
  const styles = (item.styles as Record<string, unknown>) ?? {};
  const out: Array<Record<string, unknown>> = [];
  let lastIndex = 0;
  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text)) !== null) {
    if (m.index > lastIndex) {
      out.push({
        type: "text",
        text: text.slice(lastIndex, m.index),
        styles,
      });
    }
    out.push({
      type: "tag",
      props: { name: m[1] },
    });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex === 0) return [item];
  if (lastIndex < text.length) {
    out.push({
      type: "text",
      text: text.slice(lastIndex),
      styles,
    });
  }
  return out;
}

export type TagInfo = { tag: string; count: number };

export async function fetchAllTags(): Promise<TagInfo[]> {
  try {
    const res = await fetch("/api/tags");
    if (!res.ok) return [];
    return (await res.json()) as TagInfo[];
  } catch {
    return [];
  }
}
