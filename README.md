# Simple Notes

A self-hosted, **local-first notes app** that keeps every note as a plain
Markdown file on disk, plus an **MCP server** that exposes the same vault to
Claude Desktop. Designed to slot into a personal Nextcloud / VPS stack
without locking your data into a proprietary format.

Built because none of the existing notes apps quite fit a workflow that
combines: typed notes, **Apple Pencil handwriting** in the browser, embedded
PDFs you can actually read at full size, wikilinks between notes, tags, AI
access via MCP, and mirroring everything 1:1 into a Nextcloud folder.

## Why another notes app?

Most editors are either great for code (Obsidian, VS Code with extensions,
SilverBullet) but feel technical, or great as polished consumer apps (Notion,
Apple Notes) but lock your data inside their cloud. This app aims for the
middle ground: **the on-disk format stays plain Markdown** so AI tools can
read your notes directly, while the editor feels like a modern block-based
notes app rather than a code editor.

## Features

**Editor** — built on [BlockNote] (a TipTap/ProseMirror block editor)

- Block-based WYSIWYG editor — `/` for slash commands
- Inline `[[wikilinks]]`, including heading anchors `[[Note#Heading]]`, with
  autocomplete from a slash menu and click-to-navigate (`Cmd+Click` for new tab)
- Inline `#tags` with autocomplete (`#` trigger), grouped tag panel in
  sidebar
- `/aufgabe` slash command inserts a `- [ ]` checkbox
- Inline images, PDFs (with browser-native page nav + zoom; three width
  presets: schmal / breit / sehr breit), and a handwriting block
- **Handwriting mode** — full-screen canvas with Apple Pencil pressure
  support. Strokes saved as PNG + SVG + JSON sidecar; existing handwriting
  can be re-opened and edited
- **Outline panel** — collapsible list of all headings in the current note
- **Word count + reading-time** estimate in the meta bar (live)
- **Export per note** — "Drucken" (browser print → save as PDF) or
  download as a standalone HTML file with embedded CSS

**Navigation**

- `Cmd+K` command palette: title fuzzy-match + full-text search across all
  notes, with recently opened pinned to top
- `Cmd+Shift+D` opens today's Daily Note (`Daily/YYYY-MM-DD.md`, auto-created)
- Folder tree in the sidebar with unlimited nesting
- "Verschieben…" in the row menu opens a folder picker (touch-friendly
  alternative to drag-drop)
- **Pinned notes** appear in a dedicated sidebar section (toggle from the
  row menu; persisted via `pinned: true` frontmatter)
- **Tasks modal** — aggregates every open `- [ ]` checkbox across all
  notes, grouped by note, click to jump to source
- Backlinks panel under every note (which notes link here?)
- Sort folders/files by name or modified date

**File management**

- Folder tree mirrors the on-disk structure 1:1
- Create / rename / soft-delete / move notes and folders from the sidebar
- Soft-deleted items live in `.trash/` — restore or empty from a dedicated
  modal
- Automatic garbage collection for attachments no longer referenced anywhere

**Storage model — boring on purpose**

- Notes live as `*.md` files under `notes/`
- YAML frontmatter (`created`, `modified`, `pinned`) is auto-managed on save
- Attachments live in `notes/_attachments/` and are referenced from MD via
  standard `![](/_attachments/<uuid>.png)` URLs — readable by Obsidian,
  Claude Desktop, and any other Markdown tool
- Handwriting triples: `handwrite-<uuid>.png` (displayed inline + AI-vision
  friendly) + `handwrite-<uuid>.svg` (vector source) + `handwrite-<uuid>.json`
  (raw stroke data for lossless re-edit)
- Trash: `notes/.trash/<timestamp>__<encoded-path>` — restore moves back

**AI integration via MCP**

A separate Node process in `mcp-server/` exposes 12 tools to Claude Desktop
(or any MCP-compatible client) via stdio. Both processes share the same
on-disk vault — you can run the web app and have Claude Desktop call tools
against the exact same notes at the same time.

Tools include: `list_notes`, `read_note`, `search_notes`, `find_by_tag`,
`find_backlinks`, `list_tags`, `list_open_tasks`, `create_note`,
`update_note`, `append_to_note`, `today_note`, `move_note`. See
[`mcp-server/README.md`](mcp-server/README.md) for Claude Desktop config.

**PWA**

- Installable as a standalone app on desktop and iPad / iPhone home screen
- Custom icon, themed status bar
- Apple Pencil works because PointerEvents expose pressure to the browser

## Screenshots

_(coming soon — open the app locally to see it in action)_

## Stack

| Layer          | Choice                                                  |
| -------------- | ------------------------------------------------------- |
| Editor         | [BlockNote] 0.50 (React + ProseMirror)                  |
| Frontend       | React 19 + TypeScript + Vite 8                          |
| Editor font    | IBM Plex Mono (bundled via `@fontsource`)               |
| Drawing        | [perfect-freehand] (pressure-aware stroke outlines)     |
| Backend (dev)  | Vite middleware — no separate process for local dev     |
| Backend (prod) | Planned: pure frontend talking WebDAV to Nextcloud      |
| MCP            | `@modelcontextprotocol/sdk` 1.x (stdio transport)       |
| Format         | Plain Markdown with YAML frontmatter, Obsidian-friendly |

[BlockNote]: https://www.blocknotejs.org/
[perfect-freehand]: https://github.com/steveruizok/perfect-freehand

## Quick start

Requirements: **Node.js 24+** and **pnpm 10+** (the Vite middleware is the
backend, so there's no separate server to install).

### Web app

```sh
git clone https://github.com/renejes/simple-notes.git
cd simple-notes/web
pnpm install
pnpm dev
```

Open <http://localhost:5173>. Your notes will appear in / be read from the
`notes/` folder at the repo root (auto-created on first save).

To expose to your iPad on the same Wi-Fi network:

```sh
pnpm dev --host
```

…then open the printed `http://192.168.x.x:5173` on the iPad and tap **Share
→ Add to Home Screen**.

### MCP server (optional, for Claude Desktop)

```sh
cd ../mcp-server
pnpm install
pnpm build
```

Then add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "notes": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/notes-app/mcp-server/dist/index.js"],
      "env": {
        "NOTES_ROOT": "/ABSOLUTE/PATH/TO/notes-app/notes"
      }
    }
  }
}
```

Restart Claude Desktop. Full instructions: [`mcp-server/README.md`](mcp-server/README.md).

## File layout

```
notes-app/
├── web/                    # Vite + React app (interactive editing)
│   ├── src/
│   │   ├── App.tsx              # main shell (sidebar, editor, modals)
│   │   ├── pdfBlock.tsx         # PDF block + combined schema export
│   │   ├── handwriteBlock.tsx   # handwriting block (display + re-edit)
│   │   ├── handwriteModal.tsx   # full-screen canvas editor
│   │   ├── wikilinkInline.tsx   # [[wikilink]] (with #anchor support)
│   │   ├── tagInline.tsx        # #tag inline content
│   │   ├── tagPanel.tsx         # sidebar tag panel
│   │   ├── commandPalette.tsx   # Cmd+K search + quick switch
│   │   ├── backlinksPanel.tsx   # under-editor backlinks list
│   │   ├── trashModal.tsx       # soft-delete restore UI
│   │   ├── tasksModal.tsx       # aggregated open tasks
│   │   ├── moveModal.tsx        # folder picker for "Verschieben…"
│   │   ├── frontmatter.ts       # YAML parse/serialize
│   │   └── upload.ts            # attachment upload helper
│   ├── public/
│   │   ├── icon.svg             # source SVG icon — re-render PNGs via
│   │   │                        # `node scripts/build-icons.mjs`
│   │   └── manifest.webmanifest
│   └── vite.config.ts           # Vite middleware = file I/O backend
│
├── mcp-server/             # MCP server for Claude Desktop (optional)
│   ├── src/
│   │   ├── index.ts             # tool registrations
│   │   ├── notesFs.ts           # filesystem ops (mirrors web/)
│   │   └── frontmatter.ts       # copy of web/src/frontmatter.ts
│   └── README.md                # Claude Desktop setup guide
│
├── Documentation/          # architectural notes for handoff
│   ├── project-status.md
│   └── next-steps.md
│
└── notes/                  # your notes (gitignored, created on first run)
    ├── *.md
    ├── <folders>/
    ├── _attachments/            # images / PDFs / handwriting sidecars
    └── .trash/                  # soft-deleted entries
```

## What's intentionally NOT in here

- **Realtime collaboration / multi-user** — this is a single-user app
- **Cloud sync** as a service — bring your own Nextcloud / Syncthing /
  iCloud Drive / Dropbox; the `notes/` folder is just files
- **Mobile-native iOS app** — the PWA on iPad is the iOS story

## Roadmap

- [ ] Deployment guide for Hetzner VPS + Nextcloud WebDAV (replaces the
      Vite middleware with a browser-side WebDAV client in production)
- [ ] Optional Service Worker for offline editing of recently-opened notes
- [ ] Code-block syntax highlighting (Shiki or similar)
- [ ] Note templates with placeholder substitution
- [ ] Manual dark-mode toggle (currently follows system preference)
- [ ] Tag rename (global find/replace across notes)

See [`Documentation/next-steps.md`](Documentation/next-steps.md) for the
full plan and trade-offs.

## Contributing

This is a personal project that started for one specific workflow, but PRs
are welcome if you have related itches to scratch. Open an issue first for
larger ideas.

## License

[MIT](LICENSE)
