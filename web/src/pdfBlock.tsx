// Custom BlockNote block for inline PDF embedding with native browser viewer
// (page navigation, scroll, zoom are provided by the browser's PDF plugin).
//
// MD round-trip: this block serializes as a standard link
// `[filename](url.pdf)`. The rehydratePdfLinks function below converts such
// links back into pdf blocks when loading MD, so the source-of-truth MD stays
// portable and AI-readable.

import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
} from "@blocknote/core";
import { createReactBlockSpec } from "@blocknote/react";
import { HandwriteBlock } from "./handwriteBlock";
import { WikilinkInline } from "./wikilinkInline";
import { TagInline } from "./tagInline";

type PdfSize = "" | "narrow" | "wide";
const SIZE_PRESETS: Array<{ value: PdfSize; label: string }> = [
  { value: "narrow", label: "Schmal" },
  { value: "", label: "Breit" },
  { value: "wide", label: "Sehr breit" },
];

function PdfRender({
  block,
  editor,
}: {
  block: { id: string; props: Record<string, unknown> };
  editor: { updateBlock: (id: string, patch: unknown) => void };
}) {
  const url = block.props.url as string;
  const filename = (block.props.filename as string) || "PDF";
  const size = ((block.props.size as string) || "") as PdfSize;

  if (!url) {
    return <div className="pdf-embed pdf-embed--empty">Kein PDF</div>;
  }

  function setSize(next: PdfSize) {
    editor.updateBlock(block.id, { props: { size: next } });
  }

  return (
    <div
      className="pdf-embed"
      data-size={size || undefined}
      contentEditable={false}
    >
      <div className="pdf-embed__header">
        <span className="pdf-embed__filename">{filename}</span>
        <div className="pdf-embed__actions">
          <div className="pdf-embed__sizes" role="group" aria-label="Breite">
            {SIZE_PRESETS.map((p) => (
              <button
                key={p.value || "default"}
                type="button"
                className={
                  "pdf-embed__size" + (p.value === size ? " active" : "")
                }
                onClick={() => setSize(p.value)}
                title={p.label}
              >
                {p.label}
              </button>
            ))}
          </div>
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="pdf-embed__open"
          >
            In neuem Tab öffnen ↗
          </a>
        </div>
      </div>
      <iframe
        src={url}
        title={filename}
        className="pdf-embed__frame"
        // Browser's native PDF viewer; provides page nav + scroll + zoom.
      />
    </div>
  );
}

export const PDFBlock = createReactBlockSpec(
  {
    type: "pdf",
    propSchema: {
      url: { default: "" as string },
      filename: { default: "" as string },
      size: { default: "" as string },
    },
    content: "none",
  },
  {
    render: ({ block, editor }) =>
      (
        <PdfRender
          block={block as unknown as { id: string; props: Record<string, unknown> }}
          editor={editor as unknown as { updateBlock: (id: string, patch: unknown) => void }}
        />
      ),
    toExternalHTML: ({ block }) => {
      const url = block.props.url as string;
      const filename = (block.props.filename as string) || "PDF";
      const size = (block.props.size as string) || "";
      // Encode the size preset as a URL query so MD round-trip is lossless.
      // The /_attachments/ middleware ignores query strings on file lookup.
      const fullUrl = size ? `${url}?size=${size}` : url;
      return <a href={fullUrl}>{filename}</a>;
    },
  },
);

export const schema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    pdf: PDFBlock(),
    handwrite: HandwriteBlock(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    wikilink: WikilinkInline,
    tag: TagInline,
  },
});

// Look at blocks after MD parsing and rewrite any paragraph whose sole
// content is a link to a *.pdf URL into a pdf block. This is what gives us
// the "save as plain MD link, reload as inline preview" round-trip.
//
// We accept a wide block type to avoid wrestling with BlockNote's generic
// types here — the runtime shape is what matters.
export function rehydratePdfLinks<T extends { type: string }>(
  blocks: T[],
): T[] {
  return blocks.map((block) => {
    // Inspect paragraphs whose only inline content is a single link.
    const b = block as unknown as {
      type: string;
      content?: Array<{
        type: string;
        href?: string;
        content?: Array<{ type: string; text?: string }>;
      }>;
    };
    if (
      b.type === "paragraph" &&
      b.content &&
      b.content.length === 1 &&
      b.content[0]?.type === "link"
    ) {
      const link = b.content[0];
      const href = link.href ?? "";
      if (/\.pdf(\?.*)?$/i.test(href)) {
        const [cleanUrl, search] = href.split("?");
        const params = new URLSearchParams(search ?? "");
        const sizeParam = params.get("size") ?? "";
        const size =
          sizeParam === "narrow" || sizeParam === "wide" ? sizeParam : "";
        const filenamePart =
          link.content?.find((c) => c.type === "text")?.text ??
          decodeURIComponent(cleanUrl.split("/").pop() ?? "PDF");
        return {
          type: "pdf",
          props: { url: cleanUrl, filename: filenamePart, size },
        } as unknown as T;
      }
    }
    return block;
  });
}

// Build a slash-menu item that prompts the user for a PDF file, uploads it
// via the provided upload function, and inserts a pdf block at the cursor.
export function makePdfSlashItem(
  editor: {
    getTextCursorPosition: () => { block: { id: string } };
    insertBlocks: (
      blocks: Array<{ type: string; props: Record<string, string> }>,
      reference: { id: string },
      placement: "after" | "before" | "nested",
    ) => void;
  },
  uploadFile: (file: File) => Promise<string>,
) {
  return {
    title: "PDF",
    onItemClick: () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "application/pdf";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return;
        const url = await uploadFile(file);
        editor.insertBlocks(
          [{ type: "pdf", props: { url, filename: file.name } }],
          editor.getTextCursorPosition().block,
          "after",
        );
      };
      input.click();
    },
    aliases: ["pdf", "embed", "document"],
    group: "Datei",
    subtext: "PDF inline einbetten (Seitenwechsel + Scroll)",
  };
}
