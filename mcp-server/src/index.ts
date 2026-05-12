#!/usr/bin/env node
// MCP server for the simple-notes vault. Exposes tools that let Claude
// Desktop (and any other MCP-compatible client) read, search, and write
// against the same on-disk Markdown notes the web app uses.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  appendToNote,
  createNote,
  findBacklinks,
  findByTag,
  getNotesRoot,
  getOrCreateDailyNote,
  listNotes,
  listOpenTasks,
  listTags,
  moveNote,
  readNote,
  searchNotes,
  updateNote,
} from "./notesFs.js";

// Fail loudly at startup if NOTES_ROOT isn't configured — clearer than
// each tool call failing in turn.
const ROOT = getNotesRoot();

const server = new McpServer(
  { name: "simple-notes", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

function text(payload: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [
      {
        type: "text",
        text:
          typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function errorText(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [
      {
        type: "text",
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
    isError: true,
  };
}

server.registerTool(
  "list_notes",
  {
    description:
      "List every Markdown note in the vault (paths relative to the notes root). Optional `folder` narrows to a subdirectory. Returns path, name, modified time, and pinned status. Use this to discover what notes exist before reading them.",
    inputSchema: {
      folder: z
        .string()
        .optional()
        .describe(
          "Optional subdirectory to list, e.g. `Daily` or `Ideen/Music`.",
        ),
      withMetadata: z
        .boolean()
        .optional()
        .describe(
          "If true, also parse each note's YAML frontmatter and include `tags`. Slower on large vaults.",
        ),
    },
  },
  async ({ folder, withMetadata }) => {
    try {
      const notes = await listNotes({
        folder,
        withMetadata: withMetadata === true,
      });
      return text({ count: notes.length, notes });
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "read_note",
  {
    description:
      "Read a single note. Returns parsed YAML frontmatter, the Markdown body (without frontmatter), and the raw file contents. Path is relative to the notes root, with or without the `.md` extension.",
    inputSchema: {
      path: z
        .string()
        .describe(
          "Note path relative to the notes root, e.g. `welcome` or `Ideen/Test 2.md`.",
        ),
    },
  },
  async ({ path }) => {
    try {
      return text(await readNote(path));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "search_notes",
  {
    description:
      "Full-text substring search across all notes (case-insensitive). Returns one snippet per matching file. Useful for finding notes by any keyword in their content.",
    inputSchema: {
      query: z.string().min(1).describe("Substring to search for."),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum number of matches to return (default 50)."),
    },
  },
  async ({ query, limit }) => {
    try {
      return text(await searchNotes(query, { limit }));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "find_by_tag",
  {
    description:
      "Find every note containing a given `#tag`. Tags use `#name`, `#name/nested`, alphanumeric + dashes. The leading `#` is optional.",
    inputSchema: {
      tag: z
        .string()
        .min(1)
        .describe("Tag name, with or without leading `#`."),
    },
  },
  async ({ tag }) => {
    try {
      return text(await findByTag(tag));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "find_backlinks",
  {
    description:
      "Find every note that contains a `[[wikilink]]` pointing at the given target. Use this to discover the incoming links of a note.",
    inputSchema: {
      target: z
        .string()
        .describe(
          "Target path used inside `[[...]]`, with or without `.md`. E.g. `welcome` or `Ideen/Test 2`.",
        ),
    },
  },
  async ({ target }) => {
    try {
      return text(await findBacklinks(target));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "list_tags",
  {
    description:
      "List every `#tag` used across the vault with its usage count. Sorted by frequency desc.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await listTags());
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "list_open_tasks",
  {
    description:
      "List every open Markdown checkbox `- [ ]` across all notes, grouped implicitly by path. Useful for daily task review.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await listOpenTasks());
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "create_note",
  {
    description:
      "Create a new note. Fails if a note already exists at that path. The path is relative to the notes root; `.md` is appended if missing. YAML frontmatter is auto-stamped with `created` and `modified` dates. Pass `frontmatter` to set additional fields like tags.",
    inputSchema: {
      path: z
        .string()
        .min(1)
        .describe("Note path, e.g. `Inbox/2026-05-12 Idea`."),
      body: z
        .string()
        .describe(
          "Markdown body content. Should start with a `# Heading` for readability.",
        ),
      frontmatter: z
        .record(z.unknown())
        .optional()
        .describe(
          "Extra YAML frontmatter fields to merge (besides created/modified).",
        ),
    },
  },
  async ({ path, body, frontmatter }) => {
    try {
      return text(await createNote(path, body, frontmatter));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "update_note",
  {
    description:
      "Replace the body of an existing note. Preserves the original `created` date from frontmatter (or stamps if missing) and refreshes `modified`. Use `append_to_note` instead if you only want to add content.",
    inputSchema: {
      path: z.string().min(1).describe("Note path."),
      body: z.string().describe("New Markdown body (replaces existing)."),
      frontmatter: z
        .record(z.unknown())
        .optional()
        .describe("Optional frontmatter fields to merge in."),
    },
  },
  async ({ path, body, frontmatter }) => {
    try {
      return text(
        await updateNote(path, body, { mergeFrontmatter: frontmatter }),
      );
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "append_to_note",
  {
    description:
      "Append text to the end of a note's body. Preserves all existing content. Useful for adding to a Daily Note or running log.",
    inputSchema: {
      path: z.string().min(1).describe("Note path."),
      text: z
        .string()
        .describe(
          "Markdown text to append. A separator newline is added if needed.",
        ),
    },
  },
  async ({ path, text: t }) => {
    try {
      return text(await appendToNote(path, t));
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "today_note",
  {
    description:
      "Get today's daily note at `Daily/YYYY-MM-DD.md`, creating it with a date heading if it doesn't exist. Returns the parsed note.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await getOrCreateDailyNote());
    } catch (err) {
      return errorText(err);
    }
  },
);

server.registerTool(
  "move_note",
  {
    description:
      "Move or rename a note. Fails if the target already exists (no overwriting). Paths relative to the notes root.",
    inputSchema: {
      from: z.string().min(1).describe("Current note path."),
      to: z.string().min(1).describe("Destination note path."),
    },
  },
  async ({ from, to }) => {
    try {
      return text(await moveNote(from, to));
    } catch (err) {
      return errorText(err);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr (stdout is reserved for MCP protocol)
  console.error(`[simple-notes-mcp] running against ${ROOT}`);
}

main().catch((err) => {
  console.error("[simple-notes-mcp] fatal:", err);
  process.exit(1);
});
