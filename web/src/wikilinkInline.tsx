// Custom BlockNote inline content for wikilinks. Renders [[target]] as a
// clickable in-app navigation link. On save it round-trips as raw [[target]]
// in Markdown (Obsidian-compatible, AI-readable). On load, the rehydration
// helper splits plain-text [[...]] occurrences into wikilink inline content.

import { createReactInlineContentSpec } from "@blocknote/react";

// Module-level callback so wikilink renders (which run outside the App tree)
// can request navigation via the parent App.
let wikilinkClickCallback: ((target: string) => void) | null = null;
export function setWikilinkClickCallback(
  cb: ((target: string) => void) | null,
) {
  wikilinkClickCallback = cb;
}

function basenameOf(target: string): string {
  const i = target.lastIndexOf("/");
  return i >= 0 ? target.slice(i + 1) : target;
}

// Module-level callback now also accepts an optional heading anchor.
// Reassign the typed wrapper so existing callers using setWikilinkClickCallback
// don't need to know about the anchor — they still receive (target) only.
let wikilinkClickCallbackV2:
  | ((target: string, anchor?: string) => void)
  | null = null;

export const WikilinkInline = createReactInlineContentSpec(
  {
    type: "wikilink",
    propSchema: {
      target: { default: "" as string },
      anchor: { default: "" as string },
    },
    content: "none",
  },
  {
    render: ({ inlineContent }) => {
      const target = inlineContent.props.target as string;
      const anchor = (inlineContent.props.anchor as string) || "";
      const href =
        `?path=${encodeURIComponent(target + ".md")}` +
        (anchor ? `#${encodeURIComponent(anchor)}` : "");
      const label = anchor
        ? `${basenameOf(target)} › ${anchor}`
        : basenameOf(target);
      return (
        <a
          className="wikilink"
          href={href}
          contentEditable={false}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)
              return;
            e.preventDefault();
            // Prefer the v2 callback (knows about anchors); fall back to the
            // legacy one for compatibility.
            if (wikilinkClickCallbackV2) {
              wikilinkClickCallbackV2(target, anchor || undefined);
            } else {
              wikilinkClickCallback?.(target);
            }
          }}
          title={anchor ? `${target}#${anchor}` : target}
        >
          {label}
        </a>
      );
    },
    toExternalHTML: ({ inlineContent }) => {
      const target = inlineContent.props.target as string;
      const anchor = (inlineContent.props.anchor as string) || "";
      const full = anchor ? `${target}#${anchor}` : target;
      return <>{`[[${full}]]`}</>;
    },
  },
);

export function setWikilinkClickCallbackV2(
  cb: ((target: string, anchor?: string) => void) | null,
) {
  wikilinkClickCallbackV2 = cb;
}

const WIKILINK_RE = /\[\[([^\]\#]+)(?:#([^\]]+))?\]\]/g;

// Walk parsed blocks and split any text-inline that contains `[[name]]`
// occurrences into a mix of text and wikilink inlines. Pure runtime
// transformation: we deliberately keep the type loose to avoid wrestling
// with BlockNote's generic types.
export function rehydrateWikilinks<T extends { type: string }>(
  blocks: T[],
): T[] {
  return blocks.map((block) => {
    const b = block as unknown as {
      type: string;
      content?: unknown;
      children?: T[];
    };
    if (Array.isArray(b.content)) {
      const newContent: unknown[] = [];
      let anyChange = false;
      for (const inline of b.content as Array<Record<string, unknown>>) {
        if (
          inline?.type === "text" &&
          typeof inline.text === "string" &&
          inline.text.includes("[[")
        ) {
          const pieces = splitTextWithWikilinks(inline);
          // splitTextWithWikilinks returns the same `[inline]` reference when
          // there are no matches. Any other return means we transformed the
          // text — even if length === 1 (the whole text was a single wikilink).
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
    // Recurse into nested children (lists, toggles, etc.)
    if (Array.isArray(b.children) && b.children.length > 0) {
      const recursed = rehydrateWikilinks(b.children);
      if (recursed !== b.children) {
        return { ...b, children: recursed } as unknown as T;
      }
    }
    return block;
  });
}

function splitTextWithWikilinks(
  item: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const text = item.text as string;
  const styles = (item.styles as Record<string, unknown>) ?? {};
  const out: Array<Record<string, unknown>> = [];
  let lastIndex = 0;
  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    if (m.index > lastIndex) {
      out.push({
        type: "text",
        text: text.slice(lastIndex, m.index),
        styles,
      });
    }
    out.push({
      type: "wikilink",
      props: {
        target: m[1],
        anchor: m[2] ?? "",
      },
    });
    lastIndex = m.index + m[0].length;
  }
  if (lastIndex === 0) {
    // No matches — return original
    return [item];
  }
  if (lastIndex < text.length) {
    out.push({
      type: "text",
      text: text.slice(lastIndex),
      styles,
    });
  }
  return out;
}

// Post-process the Markdown produced by blocksToMarkdownLossy: BlockNote may
// escape `[` and `]` in text content (e.g. `\[\[Name\]\]`). Convert those
// back to clean wikilink syntax so the on-disk MD is readable and
// Obsidian-compatible.
export function unescapeWikilinks(md: string): string {
  return md.replace(/\\\[\\\[([^\]]+)\\\]\\\]/g, "[[$1]]");
}
